import type { Pool } from "pg";
import { withTransaction } from "../../db/pool.js";
import type { EncryptedObjectStore } from "../storage/encrypted-object-store.js";
import { refreshUploadPreflight } from "../uploads/partial-failure.js";
import { analyzeDelimitedPrefix, classifyInput, type MappingCandidate } from "./analyze-prefix.js";
import { analyzeXlsxStream, XLSX_IMPORT_ENCODING } from "./xlsx-stream.js";

const PREFIX_LIMIT = 512 * 1024;

export interface ImportMappingCandidate extends MappingCandidate {
  readonly report_kind: "SHIPMENT" | "TRANSACTION";
}

interface StoredUploadSource {
  readonly import_batch_id: string;
  readonly upload_batch_id: string;
  readonly stored_object_id: string;
  readonly relative_path: string;
  readonly storage_path: string;
  readonly plaintext_sha256: string;
  readonly plaintext_size: string;
  readonly encryption_context: Record<string, string>;
  readonly detected_kind: "ZIP" | "PDF" | "TEXT" | "OTHER" | null;
}

export interface FailedStoredUploadAnalysis {
  readonly importBatchId: string;
  readonly importFileStatus: string;
  readonly batchStatus: "ANALYZING" | "COMMITTING" | "FAILED";
  readonly batchStage: "PREFLIGHT" | "PREFLIGHT_COMPLETE" | "COPY";
  readonly batchFailureCode: "NO_USABLE_UPLOAD_FILES" | null;
}

export async function loadImportMappingCandidates(pool: Pool): Promise<readonly ImportMappingCandidate[]> {
  const result = await pool.query<ImportMappingCandidate>(
    `SELECT DISTINCT ON (mv.field_mapping_id) mv.id, mv.definition, m.report_kind
       FROM field_mapping_version mv
       JOIN field_mapping m ON m.id = mv.field_mapping_id
      ORDER BY mv.field_mapping_id, mv.version_no DESC`,
  );
  return result.rows;
}

async function readPrefix(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = PREFIX_LIMIT - bytes;
      if (remaining <= 0) break;
      chunks.push(chunk.subarray(0, remaining));
      bytes += Math.min(chunk.byteLength, remaining);
      if (bytes >= PREFIX_LIMIT) break;
    }
  } finally {
    if ("destroy" in stream && typeof stream.destroy === "function") stream.destroy();
  }
  return Buffer.concat(chunks, bytes);
}

export async function analyzeStoredUpload(
  pool: Pool,
  store: EncryptedObjectStore,
  fileId: string,
  mappingCandidates?: readonly ImportMappingCandidate[],
): Promise<void> {
  const source = await pool.query<StoredUploadSource>(
    `SELECT ib.id AS import_batch_id, ib.upload_batch_id, so.id AS stored_object_id, uf.relative_path, so.storage_path,
            so.plaintext_sha256, so.plaintext_size, so.encryption_context, uf.detected_kind
       FROM upload_file uf
       JOIN import_batch ib ON ib.upload_batch_id = uf.batch_id
       JOIN stored_object so ON so.id = uf.stored_object_id
      WHERE uf.id = $1`,
    [fileId],
  );
  const file = source.rows[0];
  if (!file) throw new Error("IMPORT_SOURCE_NOT_READY");
  const existing = await pool.query<{ parse_status: string }>(
    "SELECT parse_status FROM import_file WHERE import_batch_id = $1 AND stored_object_id = $2",
    [file.import_batch_id, file.stored_object_id],
  );
  if (existing.rows[0] && existing.rows[0].parse_status !== "PENDING") return;

  const prefix = await readPrefix(store.createDecryptionStream(file.storage_path, file.encryption_context));
  const leaf = file.relative_path.replaceAll("\\", "/").split("/").at(-1) ?? file.relative_path;
  const mappings = mappingCandidates ?? await loadImportMappingCandidates(pool);
  const isXlsx = !leaf.startsWith("~$") && file.detected_kind === "OTHER" &&
    prefix[0] === 0x50 && prefix[1] === 0x4b;
  const xlsxAnalysis = isXlsx
    ? await analyzeXlsxStream(
        () => store.createDecryptionStream(file.storage_path, file.encryption_context),
        mappings
          .filter((row) => row.report_kind === "SHIPMENT" && row.definition.reportKind === "SHIPMENT")
          .map((row) => ({ id: row.id, definition: row.definition })),
      )
    : undefined;
  const classification = leaf.startsWith("~$")
    ? "TEMPORARY"
    : xlsxAnalysis?.status === "MATCHED" || xlsxAnalysis?.status === "AWAITING_MAPPING"
      ? "PARSE"
      : file.detected_kind && file.detected_kind !== "TEXT"
        ? "LIST_ONLY"
        : classifyInput(file.relative_path, prefix);
  let storedClassification: "SHIPMENT" | "TRANSACTION" | "LIST_ONLY" | "TEMPORARY" | "UNKNOWN" =
    classification === "TEMPORARY" ? "TEMPORARY" : classification === "LIST_ONLY" ? "LIST_ONLY" : "UNKNOWN";
  let parseStatus: "PARSED" | "AWAITING_MAPPING" | "EXCLUDED" = classification === "PARSE" ? "AWAITING_MAPPING" : "EXCLUDED";
  const delimitedAnalysis = !xlsxAnalysis && classification === "PARSE"
    ? analyzeDelimitedPrefix(prefix, mappings.map((row) => ({ id: row.id, definition: row.definition })))
    : undefined;
  const analysis = xlsxAnalysis ?? delimitedAnalysis;
  if (analysis?.status === "MATCHED") {
    const mapping = mappings.find((row) => row.id === analysis?.mappingVersionId);
    if (!mapping) throw new Error("MAPPING_VERSION_NOT_FOUND");
    storedClassification = mapping.report_kind;
    parseStatus = "PARSED";
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO import_file
        (import_batch_id, stored_object_id, relative_path, classification, parse_status,
         detected_encoding, detected_delimiter, header_line_number, mapping_version_id,
         sha256, size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,decode($10,'hex'),$11)
       ON CONFLICT (import_batch_id, stored_object_id) WHERE stored_object_id IS NOT NULL DO UPDATE SET
         classification=EXCLUDED.classification, parse_status=EXCLUDED.parse_status,
         detected_encoding=EXCLUDED.detected_encoding, detected_delimiter=EXCLUDED.detected_delimiter,
         header_line_number=EXCLUDED.header_line_number, mapping_version_id=EXCLUDED.mapping_version_id`,
      [file.import_batch_id, file.stored_object_id, file.relative_path, storedClassification, parseStatus,
        xlsxAnalysis?.status === "MATCHED" ? XLSX_IMPORT_ENCODING : delimitedAnalysis?.encoding ?? null,
        delimitedAnalysis?.delimiter ?? null, analysis?.headerLineNumber ?? null,
        analysis?.mappingVersionId ?? null, file.plaintext_sha256, file.plaintext_size],
    );
    if (parseStatus === "AWAITING_MAPPING") {
      await client.query(
        `INSERT INTO import_issue (import_batch_id, severity, issue_code, safe_context)
         VALUES ($1,'WARNING','AWAITING_MAPPING',$2::jsonb)`,
        [file.import_batch_id, JSON.stringify({ relativePath: file.relative_path, reason: analysis?.reason ?? "未识别结构" })],
      );
    }
    await refreshUploadPreflight(client, file.upload_batch_id, file.import_batch_id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function markStoredUploadAnalysisFailed(
  pool: Pool,
  fileId: string,
): Promise<FailedStoredUploadAnalysis> {
  return withTransaction(pool, async (tx) => {
    const source = await tx.query<StoredUploadSource>(
      `SELECT ib.id AS import_batch_id,ib.upload_batch_id,so.id AS stored_object_id,uf.relative_path,so.storage_path,
              so.plaintext_sha256,so.plaintext_size::text,so.encryption_context,uf.detected_kind
         FROM upload_file uf
         JOIN import_batch ib ON ib.upload_batch_id=uf.batch_id
         JOIN stored_object so ON so.id=uf.stored_object_id
        WHERE uf.id=$1
        FOR UPDATE OF uf,ib`,
      [fileId],
    );
    const file = source.rows[0];
    if (!file) throw new Error("IMPORT_SOURCE_NOT_READY");
    const upserted = await tx.query<{ id: string; parse_status: string }>(
      `INSERT INTO import_file(
         import_batch_id,stored_object_id,relative_path,classification,parse_status,sha256,size_bytes
       ) VALUES($1,$2,$3,'UNKNOWN','FAILED',decode($4,'hex'),$5)
       ON CONFLICT (import_batch_id,stored_object_id) WHERE stored_object_id IS NOT NULL DO UPDATE SET
         classification='UNKNOWN',parse_status='FAILED',detected_encoding=NULL,detected_delimiter=NULL,
         header_line_number=NULL,mapping_version_id=NULL
       WHERE import_file.parse_status='PENDING'
       RETURNING id,parse_status`,
      [file.import_batch_id, file.stored_object_id, file.relative_path, file.plaintext_sha256, file.plaintext_size],
    );
    const importFile = upserted.rows[0] ?? (await tx.query<{ id: string; parse_status: string }>(
      `SELECT id,parse_status FROM import_file
        WHERE import_batch_id=$1 AND stored_object_id=$2`,
      [file.import_batch_id, file.stored_object_id],
    )).rows[0];
    if (!importFile) throw new Error("IMPORT_FILE_FAILURE_PROJECTION_MISSING");
    if (importFile.parse_status === "FAILED") {
      await tx.query(
        `INSERT INTO import_issue(import_batch_id,import_file_id,severity,issue_code,safe_context)
         SELECT $1,$2,'ERROR','IMPORT_ANALYZE_FAILED',$3::jsonb
          WHERE NOT EXISTS (
            SELECT 1 FROM import_issue
             WHERE import_batch_id=$1 AND import_file_id=$2
               AND issue_code='IMPORT_ANALYZE_FAILED'
               AND safe_context->>'source'='IMPORT_ANALYZE'
          )`,
        [file.import_batch_id, importFile.id, JSON.stringify({
          source: "IMPORT_ANALYZE",
          uploadFileId: fileId,
          storedObjectId: file.stored_object_id,
        })],
      );
    }
    const projection = await refreshUploadPreflight(tx, file.upload_batch_id, file.import_batch_id);
    return {
      importBatchId: file.import_batch_id,
      importFileStatus: importFile.parse_status,
      batchStatus: projection.status,
      batchStage: projection.stage,
      batchFailureCode: projection.failureCode,
    };
  });
}
