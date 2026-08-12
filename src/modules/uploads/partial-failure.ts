import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../db/pool.js";
import { structuredLog } from "../../shared/structured-logger.js";
import { releaseArchiveBudgetInTransaction } from "./archive-budget.js";

export const CLIENT_UPLOAD_FAILURE_CODES = [
  "CLIENT_NETWORK_RETRY_EXHAUSTED",
  "CLIENT_FILE_READ_FAILED",
  "CLIENT_UPLOAD_ABORTED",
] as const;

export type ClientUploadFailureCode = typeof CLIENT_UPLOAD_FAILURE_CODES[number];
export type UploadFileFailureCode = ClientUploadFailureCode | `ZIP_${string}` | "PDF_BODY_UPLOAD_REJECTED" | "UPLOAD_FINALIZE_FAILED";

interface PreflightCounts {
  readonly expected: string;
  readonly analyzed: string;
  readonly parsed: string;
  readonly awaiting: string;
  readonly failed: string;
}

export interface UploadPreflightProjection {
  readonly status: "ANALYZING" | "COMMITTING" | "FAILED";
  readonly stage: "PREFLIGHT" | "PREFLIGHT_COMPLETE" | "COPY";
  readonly failureCode: "NO_USABLE_UPLOAD_FILES" | null;
}

export function isClientUploadFailureCode(value: string): value is ClientUploadFailureCode {
  return (CLIENT_UPLOAD_FAILURE_CODES as readonly string[]).includes(value);
}

export function decideUploadPreflight(counts: PreflightCounts): UploadPreflightProjection {
  const expected = BigInt(counts.expected);
  if (expected === 0n) {
    return { status: "FAILED", stage: "PREFLIGHT_COMPLETE", failureCode: "NO_USABLE_UPLOAD_FILES" };
  }
  if (expected !== BigInt(counts.analyzed)) {
    return { status: "ANALYZING", stage: "PREFLIGHT", failureCode: null };
  }
  if (BigInt(counts.parsed) === 0n) {
    return { status: "FAILED", stage: "PREFLIGHT_COMPLETE", failureCode: "NO_USABLE_UPLOAD_FILES" };
  }
  return { status: "COMMITTING", stage: "COPY", failureCode: null };
}

export async function refreshUploadPreflight(
  tx: PoolClient,
  batchId: string,
  importBatchId: string,
): Promise<UploadPreflightProjection> {
  const batch = await tx.query<{ status: string; shop_id: string; created_by: string }>(
    "SELECT status,shop_id,created_by FROM import_batch WHERE id=$1 FOR UPDATE",
    [importBatchId],
  );
  const current = batch.rows[0];
  if (!current) throw new Error("IMPORT_BATCH_NOT_FOUND");
  const aggregate = await tx.query<PreflightCounts>(
    `SELECT
       count(DISTINCT coalesce(uf.stored_object_id,uf.id)) FILTER (WHERE uf.status <> 'FAILED')::text AS expected,
       (SELECT count(*)::text FROM import_file WHERE import_batch_id=$2) AS analyzed,
       (SELECT count(*) FILTER (WHERE parse_status='PARSED')::text FROM import_file WHERE import_batch_id=$2) AS parsed,
       (SELECT count(*) FILTER (WHERE parse_status='AWAITING_MAPPING')::text FROM import_file WHERE import_batch_id=$2) AS awaiting,
       count(*) FILTER (WHERE uf.status='FAILED')::text AS failed
     FROM upload_file uf WHERE uf.batch_id=$1`,
    [batchId, importBatchId],
  );
  const counts = aggregate.rows[0] ?? { expected: "0", analyzed: "0", parsed: "0", awaiting: "0", failed: "0" };
  const projection = decideUploadPreflight(counts);
  if (projection.failureCode) {
    await tx.query(
      `INSERT INTO import_issue(import_batch_id,severity,issue_code,safe_context)
       SELECT $1,'ERROR',$2,$3::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM import_issue
           WHERE import_batch_id=$1 AND issue_code=$2 AND safe_context->>'source'='UPLOAD_BATCH_PREFLIGHT'
        )`,
      [importBatchId, projection.failureCode, JSON.stringify({ source: "UPLOAD_BATCH_PREFLIGHT" })],
    );
  }
  const mutablePreflightStatuses = ["UPLOADING", "ANALYZING", "AWAITING_FILES", "AWAITING_MAPPING", "AWAITING_COMMIT_CONFIRMATION"];
  if (mutablePreflightStatuses.includes(current.status)) {
    await tx.query(
      `UPDATE import_batch
          SET status=$2,current_stage=$3,failure_code=$4,updated_at=clock_timestamp()
        WHERE id=$1`,
      [importBatchId, projection.status, projection.stage, projection.failureCode],
    );
    if (projection.status === "COMMITTING") {
      const queued = await tx.query(
        `INSERT INTO outbox_event (id,topic,business_key,payload)
         VALUES ($1,'import.commit',$2,$3::jsonb)
         ON CONFLICT (topic,business_key) DO NOTHING`,
        [randomUUID(), `auto:${importBatchId}`, JSON.stringify({
          batchId: importBatchId,
          shopId: current.shop_id,
          actorAccountId: current.created_by,
        })],
      );
      if ((queued.rowCount ?? 0) > 0) {
        structuredLog("info", "worker", "import_preflight_auto_commit_staged", {
          batchId: importBatchId,
          parsedFileCount: counts.parsed,
          filteredFileCount: (BigInt(counts.awaiting) + BigInt(counts.failed)).toString(),
        });
      }
    }
  }
  return projection;
}

interface FailedUploadFile {
  readonly batchId: string;
  readonly importBatchId: string;
  readonly tempPath: string;
}

export async function recordUploadFileFailure(
  pool: Pool,
  input: {
    readonly fileId: string;
    readonly errorCode: UploadFileFailureCode;
    readonly allowedStatuses: readonly string[];
  },
): Promise<FailedUploadFile> {
  return withTransaction(pool, async (tx) => {
    const target = await tx.query<{
      batch_id: string;
      import_batch_id: string;
      relative_path: string;
      temp_path: string;
      file_status: string;
      batch_status: string;
      import_status: string;
      archive_reservation_state: "NONE" | "RESERVED" | "COMMITTED";
    }>(
      `SELECT uf.batch_id,ib.id AS import_batch_id,uf.relative_path,uf.temp_path,
              uf.status AS file_status,ub.status AS batch_status,ib.status AS import_status,
              uf.archive_reservation_state
         FROM upload_file uf
         JOIN upload_batch ub ON ub.id=uf.batch_id
         JOIN import_batch ib ON ib.upload_batch_id=ub.id
        WHERE uf.id=$1
        FOR UPDATE OF uf,ub,ib`,
      [input.fileId],
    );
    const row = target.rows[0];
    if (!row) throw new Error("UPLOAD_FILE_NOT_FOUND");
    if (row.file_status !== "FAILED" && !input.allowedStatuses.includes(row.file_status)) {
      throw new Error("UPLOAD_FILE_NOT_FAILABLE");
    }
    if (row.archive_reservation_state === "RESERVED") {
      await releaseArchiveBudgetInTransaction(tx, { fileId: input.fileId, batchId: row.batch_id });
    }
    if (row.file_status !== "FAILED") {
      await tx.query(
        "UPDATE upload_file SET status='FAILED',updated_at=clock_timestamp() WHERE id=$1",
        [input.fileId],
      );
    }
    await tx.query(
      `INSERT INTO import_issue(import_batch_id,severity,issue_code,safe_context)
       SELECT $1,'ERROR',$2,$3::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM import_issue
           WHERE import_batch_id=$1
             AND safe_context->>'source'='UPLOAD_FILE_FAILURE'
             AND safe_context->>'uploadFileId'=$4
        )`,
      [
        row.import_batch_id,
        input.errorCode,
        JSON.stringify({
          source: "UPLOAD_FILE_FAILURE",
          uploadFileId: input.fileId,
          relativePath: row.relative_path,
        }),
        input.fileId,
      ],
    );
    if (
      row.batch_status === "READY"
      && ["UPLOADING", "ANALYZING", "AWAITING_MAPPING", "AWAITING_COMMIT_CONFIRMATION"].includes(row.import_status)
    ) {
      await refreshUploadPreflight(tx, row.batch_id, row.import_batch_id);
    }
    return { batchId: row.batch_id, importBatchId: row.import_batch_id, tempPath: row.temp_path };
  });
}
