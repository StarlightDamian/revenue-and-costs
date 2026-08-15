import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Writable } from "node:stream";
import { from as copyFrom } from "pg-copy-streams";
import type { Pool, PoolClient } from "pg";
import Decimal from "decimal.js";
import { structuredLog } from "../../shared/structured-logger.js";
import type { EncryptedObjectStore } from "../storage/encrypted-object-store.js";
import type { FieldMappingDefinition } from "../mappings/types.js";
import { parseMappedDelimitedStream, type MappedImportRow } from "./stream-parser.js";
import { parseMappedXlsxStream, XLSX_IMPORT_ENCODING } from "./xlsx-stream.js";
import { marketplaceProfile, normalizedDecimal, normalizedSparseDecimal, normalizeFulfillment, normalizeReportDate, normalizeTransactionDescription, normalizeTransactionType, SingleSiteMarketplaceInference, type MarketplaceProfile } from "./normalize-row.js";
import { inheritSourceReplayHardAcknowledgements } from "./source-replay.js";

const STAGE_COLUMNS = [
  "report_kind", "file_id", "row_number", "row_hash", "date_text", "parsed_at", "source_timezone",
  "fx_date", "local_date", "local_month", "marketplace", "raw_marketplace", "order_id", "sku", "currency",
  "quantity", "type", "description", "fulfillment_mode", "product_sales", "product_sales_tax", "shipping_credits",
  "shipping_credits_tax", "gift_wrap_credits", "gift_wrap_credits_tax", "regulatory_fee",
  "tax_on_regulatory_fee", "promotional_rebates", "promotional_rebates_tax", "marketplace_withheld_tax",
  "selling_fees", "fba_fees", "other_transaction_fees", "other_amount", "product_price", "product_tax",
  "shipping_price", "shipping_tax", "gift_wrap_price", "gift_wrap_tax", "product_promotion_discount",
  "shipment_promotion_discount",
] as const;

function copyField(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

interface CopyWriteProfiling {
  writeMs: number;
  backpressureWaitMs: number;
  backpressureEvents: number;
}

async function writeLine(stream: Writable, values: readonly string[], profiling?: CopyWriteProfiling): Promise<void> {
  const writeStarted = profiling ? performance.now() : 0;
  const accepted = stream.write(`${values.map(copyField).join("\t")}\n`);
  if (profiling) profiling.writeMs += performance.now() - writeStarted;
  if (!accepted) {
    const waitStarted = profiling ? performance.now() : 0;
    await once(stream, "drain");
    if (profiling) {
      profiling.backpressureWaitMs += performance.now() - waitStarted;
      profiling.backpressureEvents += 1;
    }
  }
}

interface FileRow {
  id: string; storage_path: string; classification: "SHIPMENT" | "TRANSACTION"; detected_encoding: string;
  detected_delimiter: "," | "\t" | null; header_line_number: string; mapping_version_id: string; definition: FieldMappingDefinition;
  encryption_context: Record<string, string>;
}

export interface ImportFileCommitResult {
  readonly fileId: string;
  readonly read: bigint;
  readonly inserted: bigint;
  readonly excluded: bigint;
  readonly errored: bigint;
  readonly excludedAmount: string;
  readonly errors: readonly {
    readonly code: string;
    readonly rowNumber: string;
    readonly fieldName: string;
    readonly count: bigint;
  }[];
}

const ZERO_AMOUNT = "0.00000000";
const SAFE_NORMALIZATION_CODES = new Set([
  "IMPORT_UNKNOWN_MARKETPLACE",
  "IMPORT_FINANCIAL_VALUE_REQUIRED",
  "IMPORT_FINANCIAL_VALUE_INVALID",
  "IMPORT_REPORT_DATE_INVALID",
]);
const SAFE_COMMIT_CODES = new Set([
  ...SAFE_NORMALIZATION_CODES,
  "IMPORT_DATABASE_CAPACITY_INSUFFICIENT",
  "IMPORT_DATABASE_CAPACITY_UNAVAILABLE",
  "IMPORT_DELIMITED_RECORD_TOO_LARGE",
  "NO_USABLE_IMPORT_ROWS",
  "SOURCE_REPLAY_CURRENT_CLOSURE_CHANGED",
]);
const MAX_RECORDED_ROW_ISSUE_GROUPS_PER_FILE = 100;

class ImportRowValidationError extends Error {
  constructor(
    readonly code: string,
    readonly fileId: string,
    readonly rowNumber: string,
    readonly fieldName: string,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ImportRowValidationError";
  }
}

export interface ImportDatabaseCapacityEstimate {
  readonly stagingBytes: bigint;
  readonly walBytes: bigint;
  readonly safetyBytes: bigint;
  readonly requiredBytes: bigint;
}

export async function assertSourceReplayClosureCurrent(client: PoolClient, batchId: string): Promise<void> {
  const replay = await client.query<{ shop_id: string; source_closure_hash: string }>(
    `SELECT batch.shop_id,event.metadata->>'sourceClosureHash' source_closure_hash
       FROM import_batch batch
       JOIN audit_event event ON event.object_type='import_batch' AND event.object_id=batch.id
        AND event.action='ADMIN_SOURCE_REPLAY_CREATED'
      WHERE batch.id=$1`,
    [batchId],
  );
  const expected = replay.rows[0]?.source_closure_hash;
  if (!expected) return;
  await client.query(
    "SELECT id FROM dataset_slice WHERE shop_id=$1 ORDER BY id FOR UPDATE",
    [replay.rows[0]!.shop_id],
  );
  const current = await client.query<{
    dataset_version_id: string;
    report_kind: string;
    import_file_id: string;
    stored_object_id: string;
    mapping_version_id: string;
  }>(
    `SELECT version.id::text dataset_version_id,binding.report_kind,binding.import_file_id::text,
            file.stored_object_id::text,binding.mapping_version_id::text
       FROM dataset_slice slice
       JOIN dataset_version version ON version.id=slice.current_version_id
       JOIN dataset_source_binding binding ON binding.dataset_version_id=version.id
       JOIN import_file file ON file.id=binding.import_file_id
      WHERE slice.shop_id=$1
      ORDER BY version.id,binding.report_kind,binding.import_file_id`,
    [replay.rows[0]!.shop_id],
  );
  const actual = createHash("sha256").update(JSON.stringify(current.rows.map((row) => ({
    datasetVersionId: row.dataset_version_id,
    reportKind: row.report_kind,
    importFileId: row.import_file_id,
    storedObjectId: row.stored_object_id,
    mappingVersionId: row.mapping_version_id,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))))).digest("hex");
  if (actual !== expected) throw new Error("SOURCE_REPLAY_CURRENT_CLOSURE_CHANGED");
}

export function estimateImportDatabaseCapacity(sourceBytes: bigint): ImportDatabaseCapacityEstimate {
  if (sourceBytes < 0n) throw new Error("IMPORT_SOURCE_SIZE_INVALID");
  // COPY staging rows, permanent facts and their indexes can each be wider than
  // the source text. Reserve two source widths for staging and two for WAL,
  // then apply the design-required 25% safety margin.
  const stagingBytes = sourceBytes * 2n;
  const walBytes = sourceBytes * 2n;
  const baseBytes = stagingBytes + walBytes;
  const safetyBytes = (baseBytes + 3n) / 4n;
  return { stagingBytes, walBytes, safetyBytes, requiredBytes: baseBytes + safetyBytes };
}

async function assertImportDatabaseCapacity(client: PoolClient, batchId: string, configuredPath?: string): Promise<void> {
  const input = await client.query<{ source_bytes: string }>(
    "SELECT COALESCE(sum(size_bytes),0)::text AS source_bytes FROM import_file WHERE import_batch_id=$1 AND parse_status='PARSED'",
    [batchId],
  );
  const estimate = estimateImportDatabaseCapacity(BigInt(input.rows[0]?.source_bytes ?? "0"));
  let dataDirectory = configuredPath;
  if (!dataDirectory) {
    try {
      const directory = await client.query<{ data_directory: string }>("SHOW data_directory");
      dataDirectory = directory.rows[0]?.data_directory;
    } catch (error) {
      throw new Error("IMPORT_DATABASE_CAPACITY_UNAVAILABLE", { cause: error });
    }
  }
  if (!dataDirectory) throw new Error("IMPORT_DATABASE_CAPACITY_UNAVAILABLE");
  const paths = [dataDirectory, join(dataDirectory, "pg_wal")];
  for (const path of paths) {
    let availableBytes: bigint;
    try {
      const disk = await statfs(path, { bigint: true });
      availableBytes = disk.bavail * disk.bsize;
    } catch (error) {
      throw new Error("IMPORT_DATABASE_CAPACITY_UNAVAILABLE", { cause: error });
    }
    // Requiring the complete reservation on both paths is intentionally
    // conservative and remains correct when pg_wal is on a separate volume.
    if (availableBytes < estimate.requiredBytes) throw new Error("IMPORT_DATABASE_CAPACITY_INSUFFICIENT");
  }
}

function financial(
  values: Readonly<Record<string, string>>,
  key: string,
  mappedFields: ReadonlySet<string>,
): string {
  // Mapping validates that required columns exist. Cells inside Amazon's
  // component columns are sparse: blank means that component is not applicable
  // to this row, while a non-empty malformed value remains a hard row error.
  return mappedFields.has(key) ? normalizedSparseDecimal(values[key]) : ZERO_AMOUNT;
}

function rowValidationError(error: unknown, fileId: string, rowNumber: string, fieldName: string): never {
  if (error instanceof Error && SAFE_NORMALIZATION_CODES.has(error.message)) {
    throw new ImportRowValidationError(error.message, fileId, rowNumber, fieldName, { cause: error });
  }
  throw error;
}

function safeFailure(error: unknown): { code: string; fileId: string | null; rowNumber: string | null; fieldName: string | null } | undefined {
  if (error instanceof ImportRowValidationError) {
    return { code: error.code, fileId: error.fileId, rowNumber: error.rowNumber, fieldName: error.fieldName };
  }
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^42[A-Z0-9]{3}$/u.test(error.code)) {
    return { code: "IMPORT_QUERY_INVALID", fileId: null, rowNumber: null, fieldName: null };
  }
  if (error instanceof Error && SAFE_COMMIT_CODES.has(error.message)) {
    return { code: error.message, fileId: null, rowNumber: null, fieldName: null };
  }
  return undefined;
}

export function safeImportCommitFailureCode(error: unknown): string | undefined {
  return safeFailure(error)?.code;
}

export function isPersistedImportCommitFailure(error: unknown): boolean {
  return safeImportCommitFailureCode(error) !== undefined;
}

export interface ImportCommitFailureProjection {
  readonly status: string;
  readonly currentStage: string | null;
  readonly failureCode: string | null;
  readonly transitioned: boolean;
}

export async function markImportCommitFailed(
  pool: Pool,
  batchId: string,
  failureCode = "IMPORT_COMMIT_FAILED",
): Promise<ImportCommitFailureProjection> {
  const result = await pool.query<{
    status: string;
    current_stage: string | null;
    failure_code: string | null;
    transitioned: boolean;
  }>(
    `WITH failed_batch AS (
       UPDATE import_batch
          SET status='FAILED',current_stage='COMMIT_FAILED',failure_code=$2,updated_at=clock_timestamp()
        WHERE id=$1 AND status='COMMITTING'
       RETURNING id,status,current_stage,failure_code
     ), recorded_issue AS (
       INSERT INTO import_issue(import_batch_id,severity,issue_code,safe_context)
       SELECT failed.id,'ERROR',$2,'{"phase":"COMMIT","source":"WORKER_RETRY_EXHAUSTED"}'::jsonb
         FROM failed_batch failed
        WHERE NOT EXISTS (
          SELECT 1 FROM import_issue issue
           WHERE issue.import_batch_id=failed.id AND issue.issue_code=$2
             AND issue.safe_context->>'source'='WORKER_RETRY_EXHAUSTED'
        )
       RETURNING id
     )
     SELECT failed.status,failed.current_stage,failed.failure_code,true AS transitioned,
            (SELECT count(*) FROM recorded_issue) AS recorded_issues
       FROM failed_batch failed
     UNION ALL
     SELECT batch.status,batch.current_stage,batch.failure_code,false AS transitioned,
            (SELECT count(*) FROM recorded_issue) AS recorded_issues
       FROM import_batch batch
      WHERE batch.id=$1 AND NOT EXISTS (SELECT 1 FROM failed_batch)`,
    [batchId, failureCode],
  );
  const row = result.rows[0];
  return row ? {
    status: row.status,
    currentStage: row.current_stage,
    failureCode: row.failure_code,
    transitioned: row.transitioned,
  } : {
    status: "NOT_FOUND",
    currentStage: null,
    failureCode: null,
    transitioned: false,
  };
}

async function persistSafeFailure(
  client: PoolClient,
  batchId: string,
  failure: { code: string; fileId: string | null; rowNumber: string | null; fieldName: string | null },
): Promise<void> {
  await client.query("BEGIN");
  try {
    const failed = await client.query<{ id: string }>(
      "UPDATE import_batch SET status='FAILED',current_stage='COMMIT_FAILED',failure_code=$2,updated_at=clock_timestamp() WHERE id=$1 AND status='COMMITTING' RETURNING id",
      [batchId, failure.code],
    );
    if (failed.rowCount) {
      await client.query(
        `INSERT INTO import_issue(import_batch_id,import_file_id,severity,issue_code,row_number,field_name,safe_context)
         SELECT $1,$2,'ERROR',$3,$4,$5,'{"phase":"COMMIT_PREFLIGHT"}'::jsonb
         WHERE NOT EXISTS (
           SELECT 1 FROM import_issue
            WHERE import_batch_id=$1 AND issue_code=$3
              AND import_file_id IS NOT DISTINCT FROM $2::uuid
              AND row_number IS NOT DISTINCT FROM $4::bigint
              AND field_name IS NOT DISTINCT FROM $5
         )`,
        [batchId, failure.fileId, failure.code, failure.rowNumber, failure.fieldName],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function persistImportFileResults(
  client: PoolClient,
  batchId: string,
  files: readonly ImportFileCommitResult[],
): Promise<bigint> {
  if (!files.length) return 0n;
  const counters = files.map((file) => ({
    file_id: file.fileId,
    read_rows: file.read.toString(),
    inserted_rows: file.inserted.toString(),
    excluded_rows: file.excluded.toString(),
    error_rows: file.errored.toString(),
    excluded_amount: file.excludedAmount,
  }));
  await client.query(
    `UPDATE import_file target
        SET read_row_count=input.read_rows,inserted_row_count=input.inserted_rows,
            excluded_row_count=input.excluded_rows,error_row_count=input.error_rows,
            excluded_amount_original=input.excluded_amount
       FROM jsonb_to_recordset($1::jsonb) AS input(
         file_id uuid,read_rows bigint,inserted_rows bigint,excluded_rows bigint,error_rows bigint,excluded_amount numeric
       )
      WHERE target.id=input.file_id`,
    [JSON.stringify(counters)],
  );
  const issues = files.flatMap((file) => file.errors.map((issue) => ({
    file_id: file.fileId,
    issue_code: issue.code,
    row_number: issue.rowNumber,
    field_name: issue.fieldName,
    safe_context: { phase: "ROW_FILTER", count: issue.count.toString(), exactCount: true },
  })));
  if (issues.length) {
    await client.query(
      `INSERT INTO import_issue(import_batch_id,import_file_id,severity,issue_code,row_number,field_name,safe_context)
       SELECT $1::uuid,input.file_id,'WARNING',input.issue_code,input.row_number,input.field_name,input.safe_context
         FROM jsonb_to_recordset($2::jsonb) AS input(
           file_id uuid,issue_code text,row_number bigint,field_name text,safe_context jsonb
         )`,
      [batchId, JSON.stringify(issues)],
    );
  }
  return files.reduce((total, file) => total + file.excluded + file.errored, 0n);
}

async function copyImportFiles(client: PoolClient, store: EncryptedObjectStore, files: readonly FileRow[]) {
  const counts = new Map<string, Omit<ImportFileCommitResult, "fileId">>();
  let headerPrefixMs = 0;
  let parseMapCopyMs = 0;
  const profilingEnabled = process.env.PERF_IMPORT_BREAKDOWN === "true";
  const breakdown = profilingEnabled ? {
    parserHeaderCellsExamined: 0,
    parserHeaderMatchMs: 0,
    parserProjectionMs: 0,
    rowHashMs: 0,
    onRowMs: 0,
    marketplaceMs: 0,
    dateMs: 0,
    amountMs: 0,
    transactionTextMs: 0,
    copyWriteMs: 0,
    copyBackpressureWaitMs: 0,
    copyBackpressureEvents: 0,
  } : undefined;
  const copyWriteProfiling = breakdown ? {
    writeMs: 0,
    backpressureWaitMs: 0,
    backpressureEvents: 0,
  } : undefined;
  const target = client.query(copyFrom(`COPY import_stage (${STAGE_COLUMNS.join(",")}) FROM STDIN`));
  target.on("error", () => undefined);
  try {
  for (const file of files) {
    let read = 0n;
    let inserted = 0n;
    let excluded = 0n;
    let errored = 0n;
    let excludedAmount = ZERO_AMOUNT;
    const errors: Array<{ code: string; rowNumber: string; fieldName: string; count: bigint }> = [];
    const mappedFields = new Set(file.definition.fields.map((field) => field.canonical));
    let inferredMarketplace: MarketplaceProfile | undefined;
    const onRow = async (row: MappedImportRow): Promise<void> => {
        read += 1n;
        const values = row.values;
        try {
        const rawMarketplace = values.marketplace ?? values.sales_channel ?? "";
        let profile;
        const marketplaceStarted = breakdown ? performance.now() : 0;
        try {
          profile = file.classification === "TRANSACTION" && !rawMarketplace.normalize("NFKC").trim() && inferredMarketplace
            ? inferredMarketplace
            : marketplaceProfile(rawMarketplace);
        } catch (error) {
          rowValidationError(error, file.id, row.sourceRowNumber, values.marketplace !== undefined ? "marketplace" : "sales_channel");
        } finally {
          if (breakdown) breakdown.marketplaceMs += performance.now() - marketplaceStarted;
        }
        const amount = (key: string): string => {
          const started = breakdown ? performance.now() : 0;
          try {
            return financial(values, key, mappedFields);
          } catch (error) {
            rowValidationError(error, file.id, row.sourceRowNumber, key);
          } finally {
            if (breakdown) breakdown.amountMs += performance.now() - started;
          }
        };
        const requiredAmount = (key: string): string => {
          const started = breakdown ? performance.now() : 0;
          try {
            return normalizedDecimal(values[key]);
          } catch (error) {
            rowValidationError(error, file.id, row.sourceRowNumber, key);
          } finally {
            if (breakdown) breakdown.amountMs += performance.now() - started;
          }
        };
        if (profile.nonAmazon) {
          // Resolve the amount before classifying the row. If normalization
          // fails, the catch below must count the row as errored only; counting
          // it as both excluded and errored violates row conservation.
          if (file.classification === "SHIPMENT") requiredAmount("quantity");
          const amountToExclude = file.classification === "TRANSACTION" ? requiredAmount("total") : amount("product_price");
          excludedAmount = new Decimal(excludedAmount).add(amountToExclude).toFixed(8);
          excluded += 1n;
          return;
        }
        const dateText = values.date_time ?? "";
        let date;
        const dateStarted = breakdown ? performance.now() : 0;
        try {
          date = normalizeReportDate(dateText, profile);
        } catch (error) {
          rowValidationError(error, file.id, row.sourceRowNumber, "date_time");
        } finally {
          if (breakdown) breakdown.dateMs += performance.now() - dateStarted;
        }
        const currency = (values.currency || profile.currency).toUpperCase();
        if (file.classification === "TRANSACTION") requiredAmount("total");
        const textStarted = breakdown ? performance.now() : 0;
        const transactionType = normalizeTransactionType(values.type ?? "");
        const transactionDescription = normalizeTransactionDescription(values.description ?? "");
        const fulfillmentMode = normalizeFulfillment(values.fulfillment);
        if (breakdown) breakdown.transactionTextMs += performance.now() - textStarted;
        const fields = [
          file.classification, file.id, row.sourceRowNumber, `\\x${row.rowHash}`, dateText, date.parsedAt, date.sourceTimezone,
          date.fxDate, date.localDate, date.localMonth, profile.code, rawMarketplace, values.order_id ?? "", values.sku ?? "", currency,
          file.classification === "SHIPMENT" ? requiredAmount("quantity") : amount("quantity"),
          transactionType, transactionDescription, fulfillmentMode,
          amount("product_sales"), amount("product_sales_tax"), amount("shipping_credits"),
          amount("shipping_credits_tax"), amount("gift_wrap_credits"), amount("gift_wrap_credits_tax"),
          amount("regulatory_fee"), amount("tax_on_regulatory_fee"), amount("promotional_rebates"),
          amount("promotional_rebates_tax"), amount("marketplace_withheld_tax"), amount("selling_fees"),
          amount("fba_fees"), amount("other_transaction_fees"), amount("other"),
          amount("product_price"), amount("product_tax"), amount("shipping_price"),
          amount("shipping_tax"), amount("gift_wrap_price"), amount("gift_wrap_tax"),
          amount("product_promotion_discount"), amount("shipment_promotion_discount"),
        ];
        await writeLine(target, fields, copyWriteProfiling);
        inserted += 1n;
        } catch (error) {
          if (!(error instanceof ImportRowValidationError)) throw error;
          errored += 1n;
          const existing = errors.find((candidate) => candidate.code === error.code && candidate.fieldName === error.fieldName);
          if (existing) existing.count += 1n;
          else if (errors.length < MAX_RECORDED_ROW_ISSUE_GROUPS_PER_FILE) {
            errors.push({ code: error.code, rowNumber: error.rowNumber, fieldName: error.fieldName, count: 1n });
          }
        }
    };
    const parseStarted = performance.now();
    if (file.detected_encoding === XLSX_IMPORT_ENCODING) {
      if (file.classification !== "SHIPMENT") throw new Error("XLSX_SHIPMENT_MAPPING_REQUIRED");
      await parseMappedXlsxStream({
        openChunks: () => store.createDecryptionStream(file.storage_path, file.encryption_context),
        mapping: file.definition,
        expectedHeaderLineNumber: file.header_line_number,
        onRow,
      });
    } else {
      if (!file.detected_delimiter) throw new Error("CONFIRMED_PREFIX_ANALYSIS_REQUIRED");
      const analysis = {
        status: "MATCHED" as const,
        encoding: file.detected_encoding,
        delimiter: file.detected_delimiter,
        headerLine: "unused",
        headerLineNumber: file.header_line_number,
        mappingVersionId: file.mapping_version_id,
      };
      // The parser validates the exact header from a caller-provided string.
      // Re-read the bounded prefix to provide that immutable preflight header.
      const headerStarted = performance.now();
      const prefixChunks: Buffer[] = [];
      let prefixBytes = 0;
      const prefixStream = store.createDecryptionStream(file.storage_path, file.encryption_context);
      for await (const value of prefixStream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
        const remaining = 512 * 1024 - prefixBytes;
        if (remaining <= 0) break;
        prefixChunks.push(chunk.subarray(0, remaining));
        prefixBytes += Math.min(remaining, chunk.byteLength);
        if (prefixBytes >= 512 * 1024) break;
      }
      prefixStream.destroy();
      const decoded = new TextDecoder(file.detected_encoding).decode(Buffer.concat(prefixChunks));
      const headerLine = decoded.replace(/^\uFEFF/u, "").split(/\r?\n/u)[Number(file.header_line_number) - 1];
      if (!headerLine) throw new Error("CONFIRMED_HEADER_NOT_FOUND");
      headerPrefixMs += performance.now() - headerStarted;
      const confirmedAnalysis = { ...analysis, headerLine };
      if (file.classification === "TRANSACTION") {
        const inference = new SingleSiteMarketplaceInference();
        const inferred = await parseMappedDelimitedStream({
          chunks: store.createDecryptionStream(file.storage_path, file.encryption_context),
          analysis: confirmedAnalysis,
          mapping: file.definition,
          profile: profilingEnabled,
          onRow: async (row) => {
            inference.observe(row.values.marketplace ?? row.values.sales_channel ?? "");
          },
        });
        inferredMarketplace = inference.resolve();
        if (breakdown && inferred.profiling) {
          breakdown.parserHeaderCellsExamined += inferred.profiling.headerCellsExamined;
          breakdown.parserHeaderMatchMs += inferred.profiling.headerMatchMs;
          breakdown.parserProjectionMs += inferred.profiling.projectionMs;
          breakdown.rowHashMs += inferred.profiling.rowHashMs;
          breakdown.onRowMs += inferred.profiling.onRowMs;
        }
      }
      const parsed = await parseMappedDelimitedStream({
        chunks: store.createDecryptionStream(file.storage_path, file.encryption_context),
        analysis: confirmedAnalysis,
        mapping: file.definition,
        profile: profilingEnabled,
        onRow,
      });
      if (breakdown && parsed.profiling) {
        breakdown.parserHeaderCellsExamined += parsed.profiling.headerCellsExamined;
        breakdown.parserHeaderMatchMs += parsed.profiling.headerMatchMs;
        breakdown.parserProjectionMs += parsed.profiling.projectionMs;
        breakdown.rowHashMs += parsed.profiling.rowHashMs;
        breakdown.onRowMs += parsed.profiling.onRowMs;
      }
    }
    parseMapCopyMs += performance.now() - parseStarted;
    counts.set(file.id, { read, inserted, excluded, errored, excludedAmount, errors });
  }
  target.end();
  await once(target, "finish");
  if (breakdown && copyWriteProfiling) {
    breakdown.copyWriteMs = copyWriteProfiling.writeMs;
    breakdown.copyBackpressureWaitMs = copyWriteProfiling.backpressureWaitMs;
    breakdown.copyBackpressureEvents = copyWriteProfiling.backpressureEvents;
  }
  return { counts, headerPrefixMs, parseMapCopyMs, breakdown };
  } catch (error) {
    target.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }
}

export async function materializeImportSlices(
  client: PoolClient,
  batchId: string,
  actorAccountId: string,
): Promise<Array<{ marketplace: string; local_month: string; retired: boolean }>> {
  await client.query(`CREATE TEMP TABLE import_version_stage (
    marketplace text NOT NULL,
    local_month date NOT NULL,
    kinds text[] NOT NULL,
    dataset_slice_id uuid NOT NULL,
    supersedes_version_id uuid,
    version_id uuid NOT NULL,
    version_no integer NOT NULL,
    complete boolean NOT NULL,
    one_sided_complete_reason text,
    retired boolean NOT NULL,
    mapping_version_id uuid,
    PRIMARY KEY(marketplace,local_month)
  ) ON COMMIT DROP`);
  const slices = await client.query<{ marketplace: string; local_month: string; retired: boolean }>(
    `WITH replay_objects AS (
       SELECT DISTINCT stored_object_id
         FROM import_file
        WHERE import_batch_id=$1 AND parse_status='PARSED' AND stored_object_id IS NOT NULL
     ), staged_slice_input AS (
       SELECT marketplace,local_month,array_agg(DISTINCT report_kind ORDER BY report_kind) kinds,
              bool_or(report_kind='TRANSACTION' AND type='ORDER' AND fulfillment_mode='MERCHANT') has_merchant_order,
              bool_or(report_kind='TRANSACTION' AND type='ORDER' AND fulfillment_mode IS DISTINCT FROM 'MERCHANT') has_non_merchant_order
         FROM import_stage GROUP BY marketplace,local_month
     ), replayed_current_slices AS (
       SELECT slice.normalized_marketplace marketplace,slice.local_month
         FROM import_batch batch
         JOIN dataset_slice slice ON slice.shop_id=batch.shop_id
         JOIN dataset_version current_version ON current_version.id=slice.current_version_id
        WHERE batch.id=$1
          AND EXISTS (
            SELECT 1
              FROM dataset_source_binding binding
              JOIN import_file prior_file ON prior_file.id=binding.import_file_id
              JOIN replay_objects replay ON replay.stored_object_id=prior_file.stored_object_id
             WHERE binding.dataset_version_id=current_version.id
          )
          AND NOT EXISTS (
            SELECT 1
              FROM dataset_source_binding binding
              JOIN import_file prior_file ON prior_file.id=binding.import_file_id
             WHERE binding.dataset_version_id=current_version.id
               AND NOT EXISTS (
                 SELECT 1 FROM replay_objects replay
                  WHERE replay.stored_object_id=prior_file.stored_object_id
               )
          )
     ), slice_input AS (
       SELECT marketplace,local_month,kinds,false retired,
              kinds @> ARRAY['SHIPMENT']::text[] OR (
                cardinality(kinds)=1 AND kinds @> ARRAY['TRANSACTION']::text[]
                  AND has_merchant_order AND NOT has_non_merchant_order
              ) complete,
              CASE
                WHEN cardinality(kinds)=1 AND kinds @> ARRAY['SHIPMENT']::text[] THEN 'SHIPMENT_ONLY'
                WHEN cardinality(kinds)=1 AND kinds @> ARRAY['TRANSACTION']::text[]
                  AND has_merchant_order AND NOT has_non_merchant_order THEN 'TRANSACTION_ONLY_FMB'
              END one_sided_complete_reason
         FROM staged_slice_input
       UNION ALL
       SELECT replayed.marketplace,replayed.local_month,ARRAY[]::text[] kinds,true retired,
              false complete,NULL::text one_sided_complete_reason
         FROM replayed_current_slices replayed
        WHERE NOT EXISTS (
          SELECT 1 FROM staged_slice_input staged
           WHERE staged.marketplace=replayed.marketplace AND staged.local_month=replayed.local_month
        )
     ), mapping_input AS (
       SELECT DISTINCT ON (stage.marketplace,stage.local_month)
              stage.marketplace,stage.local_month,file.mapping_version_id
         FROM import_stage stage JOIN import_file file ON file.id=stage.file_id
        ORDER BY stage.marketplace,stage.local_month,(stage.report_kind='TRANSACTION') DESC,file.id
     ), upserted AS (
       INSERT INTO dataset_slice(shop_id,normalized_marketplace,local_month)
       SELECT batch.shop_id,input.marketplace,input.local_month
         FROM slice_input input CROSS JOIN (SELECT shop_id FROM import_batch WHERE id=$1) batch
        ORDER BY input.local_month,input.marketplace
       ON CONFLICT(shop_id,normalized_marketplace,local_month)
       DO UPDATE SET normalized_marketplace=EXCLUDED.normalized_marketplace
       RETURNING id,normalized_marketplace marketplace,local_month,current_version_id
     )
     INSERT INTO import_version_stage(
       marketplace,local_month,kinds,dataset_slice_id,supersedes_version_id,
       version_id,version_no,complete,one_sided_complete_reason,retired,mapping_version_id
     )
     SELECT input.marketplace,input.local_month,input.kinds,upserted.id,upserted.current_version_id,
            gen_random_uuid(),
            (SELECT COALESCE(max(version.version_no),0)+1 FROM dataset_version version WHERE version.dataset_slice_id=upserted.id),
             input.complete,
             input.one_sided_complete_reason,input.retired,mapping.mapping_version_id
       FROM slice_input input
       JOIN upserted USING(marketplace,local_month)
       LEFT JOIN mapping_input mapping USING(marketplace,local_month)
      ORDER BY input.local_month,input.marketplace
     RETURNING marketplace,local_month::text AS local_month,retired`,
    [batchId],
  );
  await client.query(
    `WITH inserted_version AS (
     INSERT INTO dataset_version(
       id,dataset_slice_id,import_batch_id,version_no,status,manifest_sha256,
       supersedes_version_id,activated_at,created_by
     )
     SELECT version_id,dataset_slice_id,$1::uuid,version_no,
            CASE WHEN complete THEN 'ACTIVE' ELSE 'INCOMPLETE' END,
            digest(convert_to(jsonb_build_object(
               'batchId',$1::uuid::text,'sliceId',dataset_slice_id::text,'marketplace',marketplace,
               'localMonth',local_month::text,'kinds',to_jsonb(kinds),
               'oneSidedCompleteReason',one_sided_complete_reason,'retiredBySourceReplay',retired
            )::text,'UTF8'),'sha256'),
            supersedes_version_id,clock_timestamp(),$2::uuid
       FROM import_version_stage ORDER BY local_month,marketplace
     RETURNING id
     )
     INSERT INTO audit_event(actor_account_id,action,object_type,object_id,reason,metadata)
     SELECT $2::uuid,'DATASET_SLICE_RETIRED_BY_SOURCE_REPLAY','dataset_version',stage.version_id,
            '完整重放同一组源文件后，该站点月份不再由当前日期归属规则产生',
            jsonb_build_object('batchId',$1::uuid::text,'sliceId',stage.dataset_slice_id::text,
              'marketplace',stage.marketplace,'localMonth',stage.local_month::text,
              'supersedesVersionId',stage.supersedes_version_id::text)
       FROM import_version_stage stage
       JOIN inserted_version inserted ON inserted.id=stage.version_id
      WHERE stage.retired`,
    [batchId, actorAccountId],
  );
  await client.query(
    `UPDATE dataset_version previous SET status='SUPERSEDED'
       FROM import_version_stage stage
      WHERE previous.id=stage.supersedes_version_id`,
  );
  await client.query(
    `UPDATE dataset_slice slice SET current_version_id=stage.version_id
       FROM import_version_stage stage WHERE slice.id=stage.dataset_slice_id`,
  );
  await client.query(
    `INSERT INTO dataset_source_binding(
       dataset_version_id,report_kind,import_file_id,mapping_version_id,coverage_start,coverage_end
     )
     SELECT DISTINCT version.version_id,stage.report_kind,stage.file_id,file.mapping_version_id,
            stage.local_month,(stage.local_month + interval '1 month' - interval '1 day')::date
       FROM import_stage stage
       JOIN import_version_stage version USING(marketplace,local_month)
       JOIN import_file file ON file.id=stage.file_id`,
  );
  await client.query(
    `INSERT INTO shipment_fact(dataset_version_id,source_file_id,row_number,row_hash,original_datetime_text,parsed_at,source_timezone,
      fx_date,marketplace_local_date,local_month,normalized_marketplace,original_sales_channel,order_id,sku,currency,shipped_quantity,
      product_price,product_tax,shipping_price,shipping_tax,gift_wrap_price,gift_wrap_tax,product_promotion_discount,shipment_promotion_discount)
     SELECT version.version_id,stage.file_id,stage.row_number,stage.row_hash,stage.date_text,stage.parsed_at,stage.source_timezone,
       stage.fx_date,stage.local_date,stage.local_month,stage.marketplace,stage.raw_marketplace,
       nullif(stage.order_id,''),nullif(stage.sku,''),stage.currency,stage.quantity,stage.product_price,stage.product_tax,
       stage.shipping_price,stage.shipping_tax,stage.gift_wrap_price,stage.gift_wrap_tax,
       stage.product_promotion_discount,stage.shipment_promotion_discount
       FROM import_stage stage JOIN import_version_stage version USING(marketplace,local_month)
      WHERE stage.report_kind='SHIPMENT'`,
  );
  await client.query(
    `INSERT INTO transaction_fact(dataset_version_id,source_file_id,row_number,row_hash,original_datetime_text,parsed_at,source_timezone,
      fx_date,marketplace_local_date,local_month,normalized_marketplace,normalized_type,normalized_description,fulfillment_mode,order_id,sku,currency,quantity,
      product_sales,product_sales_tax,shipping_credits,shipping_credits_tax,gift_wrap_credits,gift_wrap_credits_tax,regulatory_fee,
      tax_on_regulatory_fee,promotional_rebates,promotional_rebates_tax,marketplace_withheld_tax,selling_fees,fba_fees,other_transaction_fees,other_amount)
     SELECT version.version_id,stage.file_id,stage.row_number,stage.row_hash,stage.date_text,stage.parsed_at,stage.source_timezone,
        stage.fx_date,stage.local_date,stage.local_month,stage.marketplace,upper(stage.type),stage.description,stage.fulfillment_mode,
       nullif(stage.order_id,''),nullif(stage.sku,''),stage.currency,stage.quantity,stage.product_sales,stage.product_sales_tax,
       stage.shipping_credits,stage.shipping_credits_tax,stage.gift_wrap_credits,stage.gift_wrap_credits_tax,stage.regulatory_fee,
       stage.tax_on_regulatory_fee,stage.promotional_rebates,stage.promotional_rebates_tax,stage.marketplace_withheld_tax,
       stage.selling_fees,stage.fba_fees,stage.other_transaction_fees,stage.other_amount
       FROM import_stage stage JOIN import_version_stage version USING(marketplace,local_month)
      WHERE stage.report_kind='TRANSACTION'`,
  );
  await client.query(
    `WITH shipment_totals AS (
       SELECT dataset_version_id,sum(shipped_quantity) quantity
         FROM shipment_fact fact JOIN import_version_stage version ON version.version_id=fact.dataset_version_id
        GROUP BY dataset_version_id
     ), transaction_totals AS (
       SELECT dataset_version_id,sum(quantity) quantity
         FROM transaction_fact fact JOIN import_version_stage version ON version.version_id=fact.dataset_version_id
         WHERE normalized_type IN ('ORDER','BESTELLUNG','注文','PEDIDO','COMMANDE','ORDINE','SIPARIŞ')
           AND fulfillment_mode IS DISTINCT FROM 'MERCHANT'
        GROUP BY dataset_version_id
     )
     INSERT INTO reconciliation_result(dataset_version_id,mapping_version_id,applicable,shipment_quantity,transaction_quantity,
       intersection_quantity,unmatched_absolute,unmatched_ratio,warning)
     SELECT version.version_id,version.mapping_version_id,
            version.kinds @> ARRAY['SHIPMENT','TRANSACTION']::text[],
            CASE WHEN version.kinds @> ARRAY['SHIPMENT','TRANSACTION']::text[] THEN totals.ship END,
            CASE WHEN version.kinds @> ARRAY['SHIPMENT','TRANSACTION']::text[] THEN totals.trans END,
            CASE WHEN version.kinds @> ARRAY['SHIPMENT','TRANSACTION']::text[] THEN least(totals.ship,totals.trans) END,
            CASE WHEN version.kinds @> ARRAY['SHIPMENT','TRANSACTION']::text[] THEN abs(totals.ship-totals.trans) END,
            CASE WHEN NOT (version.kinds @> ARRAY['SHIPMENT','TRANSACTION']::text[]) THEN NULL
                 WHEN totals.ship+totals.trans=0 THEN 0 ELSE abs(totals.ship-totals.trans)/(totals.ship+totals.trans) END,
            version.kinds @> ARRAY['SHIPMENT','TRANSACTION']::text[] AND totals.ship<>totals.trans
       FROM import_version_stage version
       CROSS JOIN LATERAL (SELECT
         COALESCE((SELECT quantity FROM shipment_totals WHERE dataset_version_id=version.version_id),0) ship,
         COALESCE((SELECT quantity FROM transaction_totals WHERE dataset_version_id=version.version_id),0) trans
       ) totals
      WHERE version.mapping_version_id IS NOT NULL`,
  );
  return slices.rows;
}

export async function commitImportBatch(
  pool: Pool,
  store: EncryptedObjectStore,
  batchId: string,
  actorAccountId: string,
  databaseCapacityPath?: string,
): Promise<void> {
  const totalStarted = performance.now();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const batch = await client.query<{ status: string }>("SELECT status FROM import_batch WHERE id=$1 FOR UPDATE", [batchId]);
    if (["COMMITTED", "COMMITTED_WITH_EXCLUSIONS", "CALCULATING", "READY_FOR_REVIEW"].includes(batch.rows[0]?.status ?? "")) {
      await client.query("COMMIT"); return;
    }
    if (batch.rows[0]?.status !== "COMMITTING") throw new Error("IMPORT_BATCH_NOT_COMMITTING");
    await assertImportDatabaseCapacity(client, batchId, databaseCapacityPath);
    await client.query(`CREATE TEMP TABLE import_stage (
      report_kind text,file_id uuid,row_number bigint,row_hash bytea,date_text text,parsed_at timestamptz,source_timezone text,
      fx_date date,local_date date,local_month date,marketplace text,raw_marketplace text,order_id text,sku text,currency text,
      quantity numeric(30,8),type text,description text,fulfillment_mode text,product_sales numeric(30,8),product_sales_tax numeric(30,8),
      shipping_credits numeric(30,8),shipping_credits_tax numeric(30,8),gift_wrap_credits numeric(30,8),gift_wrap_credits_tax numeric(30,8),
      regulatory_fee numeric(30,8),tax_on_regulatory_fee numeric(30,8),promotional_rebates numeric(30,8),promotional_rebates_tax numeric(30,8),
      marketplace_withheld_tax numeric(30,8),selling_fees numeric(30,8),fba_fees numeric(30,8),other_transaction_fees numeric(30,8),
      other_amount numeric(30,8),product_price numeric(30,8),product_tax numeric(30,8),shipping_price numeric(30,8),shipping_tax numeric(30,8),
      gift_wrap_price numeric(30,8),gift_wrap_tax numeric(30,8),product_promotion_discount numeric(30,8),shipment_promotion_discount numeric(30,8)
    ) ON COMMIT DROP`);
    const fileResult = await client.query<FileRow>(
      `SELECT f.id,o.storage_path,o.encryption_context,f.classification,f.detected_encoding,f.detected_delimiter,f.header_line_number::text,
              f.mapping_version_id,mv.definition
         FROM import_file f JOIN stored_object o ON o.id=f.stored_object_id
         JOIN field_mapping_version mv ON mv.id=f.mapping_version_id
        WHERE f.import_batch_id=$1 AND f.parse_status='PARSED' ORDER BY f.id`,
      [batchId],
    );
    const copyStarted = performance.now();
    const copied = await copyImportFiles(client, store, fileResult.rows);
    const copyMs = performance.now() - copyStarted;
    structuredLog("info", "worker", "import_commit_copy_completed", {
      batchId,
      files: fileResult.rows.length,
      readRows: [...copied.counts.values()].reduce((sum, count) => sum + count.read, 0n).toString(),
      insertedRows: [...copied.counts.values()].reduce((sum, count) => sum + count.inserted, 0n).toString(),
      headerPrefixMs: copied.headerPrefixMs,
      parseMapCopyMs: copied.parseMapCopyMs,
      ...(copied.breakdown ? { breakdown: copied.breakdown } : {}),
      durationMs: copyMs,
    });
    // A source replay can retire current slices that disappear under a new
    // date rule. Lock only for pointer proof/materialization, after streaming
    // parsing, so long imports do not block shop reads and publishing.
    await client.query(
      `SELECT shop.id FROM import_batch batch JOIN shop ON shop.id=batch.shop_id
        WHERE batch.id=$1 FOR UPDATE OF shop`,
      [batchId],
    );
    await assertSourceReplayClosureCurrent(client, batchId);
    const materializeStarted = performance.now();
    const slices = await materializeImportSlices(client, batchId, actorAccountId);
    const inheritedAcknowledgements = await inheritSourceReplayHardAcknowledgements(client, batchId, actorAccountId);
    const materializeMs = performance.now() - materializeStarted;
    if (!slices.some((slice) => !slice.retired)) throw new Error("NO_USABLE_IMPORT_ROWS");
    structuredLog("info", "worker", "import_commit_materialization_completed", {
      batchId,
      slices: slices.length,
      retiredSlices: slices.filter((slice) => slice.retired).length,
      inheritedHardAcknowledgements: inheritedAcknowledgements.acknowledgementIds.length,
      durationMs: materializeMs,
    });
    const finalizeStarted = performance.now();
    const totalExcluded = await persistImportFileResults(client, batchId, [...copied.counts].map(([fileId, count]) => ({ fileId, ...count })));
    const next = totalExcluded > 0n ? "COMMITTED_WITH_EXCLUSIONS" : "COMMITTED";
    await client.query("UPDATE import_batch SET status=$2,current_stage='COMMITTED',updated_at=clock_timestamp() WHERE id=$1", [batchId, next]);
    await client.query(
      `INSERT INTO outbox_event(id,topic,business_key,payload) VALUES($1,'calculation.requested',$2,$3::jsonb)
       ON CONFLICT(topic,business_key) DO NOTHING`,
      [randomUUID(), batchId, JSON.stringify({ batchId, actorAccountId })],
    );
    const finalizeMs = performance.now() - finalizeStarted;
    const commitStarted = performance.now();
    await client.query("COMMIT");
    structuredLog("info", "worker", "import_commit_completed", {
      batchId,
      slices: slices.length,
      copyMs,
      materializeMs,
      finalizeMs,
      commitMs: performance.now() - commitStarted,
      durationMs: performance.now() - totalStarted,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    const failure = safeFailure(error);
    if (failure) await persistSafeFailure(client, batchId, failure);
    throw error;
  } finally { client.release(); }
}
