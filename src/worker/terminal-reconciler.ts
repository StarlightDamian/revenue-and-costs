import type { Pool } from "pg";
import { markCalculationRunFailed } from "../modules/calculation/postgres-runner.js";
import { markStoredUploadAnalysisFailed } from "../modules/imports/postgres-analyzer.js";
import type { EncryptedObjectStore } from "../modules/storage/encrypted-object-store.js";
import { recordUploadFileFailure } from "../modules/uploads/partial-failure.js";
import { cleanupUploadStagingArtifacts } from "../modules/uploads/staging-cleanup.js";
import { safeErrorDiagnostic } from "../shared/diagnostics.js";
import { tryWithJobExecutionLock } from "./job-execution-lock.js";

const TERMINAL_QUEUES = [
  "upload.finalize",
  "import.analyze",
  "import.commit",
  "calculation.requested",
  "calculation.run",
  "report.auto-publish",
  "export.generate",
] as const;
const UUID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type TerminalQueue = typeof TERMINAL_QUEUES[number];
type ProjectionOutcome = "PROJECTED" | "NOOP";

interface TerminalJob {
  readonly id: string;
  readonly name: TerminalQueue;
  readonly data: Record<string, unknown>;
  readonly created_on: Date;
  readonly completed_on: Date;
}

interface BusinessKey {
  readonly field: "fileId" | "batchId" | "runId" | "sourceImportBatchId" | "exportId";
  readonly value: string;
}

export interface TerminalFailureProjector {
  project(job: TerminalJob, key: BusinessKey): Promise<ProjectionOutcome>;
}

export interface TerminalReconcilerDependencies {
  readonly pool: Pool;
  readonly objectStore: EncryptedObjectStore;
  readonly failExport: (exportId: string, error: unknown) => Promise<void>;
}

type ReconcileLog = (level: "info" | "error", event: string, fields: Record<string, unknown>) => void;

const businessKeyFields: Record<TerminalQueue, BusinessKey["field"]> = {
  "upload.finalize": "fileId",
  "import.analyze": "fileId",
  "import.commit": "batchId",
  "calculation.requested": "batchId",
  "calculation.run": "runId",
  "report.auto-publish": "sourceImportBatchId",
  "export.generate": "exportId",
};

function defaultLog(level: "info" | "error", event: string, fields: Record<string, unknown>): void {
  try {
    const line = `${JSON.stringify({ level, time: Date.now(), event, service: "worker", ...fields })}\n`;
    (level === "error" ? process.stderr : process.stdout).write(line);
  } catch {
    // Recovery diagnostics must never change the recovery result.
  }
}

function businessKey(job: TerminalJob): BusinessKey {
  const field = businessKeyFields[job.name];
  const value = job.data[field];
  if (typeof value !== "string" || !UUID_VALUE.test(value)) {
    throw new Error("TERMINAL_RECONCILIATION_PAYLOAD_INVALID");
  }
  return { field, value };
}

async function isSuperseded(pool: Pool, job: TerminalJob, key: BusinessKey): Promise<boolean> {
  const result = await pool.query<{ superseded: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM pgboss.job newer
        WHERE newer.name=$1
          AND newer.data->>$2=$3
          AND (newer.created_on,newer.id) > ($4::timestamptz,$5::uuid)
     ) OR EXISTS(
       SELECT 1 FROM outbox_event pending
        WHERE pending.topic=$1 AND pending.payload->>$2=$3 AND pending.dispatched_at IS NULL
     ) AS superseded`,
    [job.name, key.field, key.value, job.created_on, job.id],
  );
  return result.rows[0]?.superseded === true;
}

async function recordReconciliation(
  pool: Pool,
  job: TerminalJob,
  outcome: ProjectionOutcome | "SUPERSEDED",
): Promise<void> {
  await pool.query(
    `INSERT INTO job_operation(
       business_key,job_name,status,progress,attempt_count,last_heartbeat_at,updated_at,finished_at
     ) VALUES($1,'worker.terminal-reconcile','SUCCEEDED',$2::jsonb,1,clock_timestamp(),clock_timestamp(),clock_timestamp())
     ON CONFLICT(business_key) DO UPDATE SET
       status='SUCCEEDED',progress=EXCLUDED.progress,attempt_count=job_operation.attempt_count+1,
       last_heartbeat_at=clock_timestamp(),updated_at=clock_timestamp(),finished_at=clock_timestamp(),error_code=NULL`,
    [`terminal-reconcile:${job.id}`, JSON.stringify({ queueName: job.name, outcome })],
  );
}

async function recordReconciliationFailure(
  pool: Pool,
  job: TerminalJob,
  key?: BusinessKey,
): Promise<void> {
  await pool.query(
    `INSERT INTO job_operation(
       business_key,job_name,status,progress,attempt_count,last_heartbeat_at,error_code,updated_at,finished_at
     ) VALUES($1,'worker.terminal-reconcile','FAILED',$2::jsonb,1,clock_timestamp(),'TERMINAL_RECONCILIATION_FAILED',clock_timestamp(),clock_timestamp())
     ON CONFLICT(business_key) DO UPDATE SET
       status='FAILED',progress=EXCLUDED.progress,attempt_count=job_operation.attempt_count+1,
       last_heartbeat_at=clock_timestamp(),error_code='TERMINAL_RECONCILIATION_FAILED',
       updated_at=clock_timestamp(),finished_at=clock_timestamp()
     WHERE job_operation.status<>'SUCCEEDED'`,
    [
      `terminal-reconcile:${job.id}`,
      JSON.stringify({
        queueName: job.name,
        outcome: "RECOVERY_FAILED",
        ...(key ? { businessField: key.field, businessId: key.value } : {}),
      }),
    ],
  );
}

async function recordReconciliationDeferred(
  pool: Pool,
  job: TerminalJob,
  key: BusinessKey,
): Promise<void> {
  await pool.query(
    `INSERT INTO job_operation(
       business_key,job_name,status,progress,attempt_count,last_heartbeat_at,updated_at
     ) VALUES($1,'worker.terminal-reconcile','RUNNING',$2::jsonb,1,clock_timestamp(),clock_timestamp())
     ON CONFLICT(business_key) DO UPDATE SET
       status='RUNNING',progress=EXCLUDED.progress,attempt_count=job_operation.attempt_count+1,
       last_heartbeat_at=clock_timestamp(),error_code=NULL,updated_at=clock_timestamp(),finished_at=NULL
     WHERE job_operation.status<>'SUCCEEDED'`,
    [
      `terminal-reconcile:${job.id}`,
      JSON.stringify({
        queueName: job.name,
        outcome: "ACTIVE_CALLBACK",
        businessField: key.field,
        businessId: key.value,
      }),
    ],
  );
}

async function projectCommitFailure(pool: Pool, batchId: string, completedOn: Date): Promise<ProjectionOutcome> {
  const result = await pool.query<{ transitioned: boolean }>(
    `WITH failed_batch AS (
       UPDATE import_batch
          SET status='FAILED',current_stage='COMMIT_FAILED',failure_code='IMPORT_COMMIT_FAILED',updated_at=clock_timestamp()
        WHERE id=$1 AND status='COMMITTING' AND updated_at <= $2::timestamptz
       RETURNING id
     ), recorded_issue AS (
       INSERT INTO import_issue(import_batch_id,severity,issue_code,safe_context)
       SELECT id,'ERROR','IMPORT_COMMIT_FAILED','{"phase":"COMMIT","source":"TERMINAL_RECONCILIATION"}'::jsonb
         FROM failed_batch
        WHERE NOT EXISTS (
          SELECT 1 FROM import_issue issue
           WHERE issue.import_batch_id=failed_batch.id AND issue.issue_code='IMPORT_COMMIT_FAILED'
             AND issue.safe_context->>'source'='TERMINAL_RECONCILIATION'
        )
       RETURNING id
     )
     SELECT EXISTS(SELECT 1 FROM failed_batch) AS transitioned,
            (SELECT count(*) FROM recorded_issue) AS recorded_issues`,
    [batchId, completedOn],
  );
  return result.rows[0]?.transitioned ? "PROJECTED" : "NOOP";
}

async function projectCalculationRequestFailure(
  pool: Pool,
  batchId: string,
  completedOn: Date,
  failureCode = "CALCULATION_REQUEST_FAILED",
  stage = "CALCULATION_REQUEST_BLOCKED",
): Promise<ProjectionOutcome> {
  const result = await pool.query<{ transitioned: boolean }>(
    `WITH failed_batch AS (
       UPDATE import_batch
          SET status='FAILED',current_stage=$3,failure_code=$4,updated_at=clock_timestamp()
        WHERE id=$1
          AND status IN ('COMMITTED','COMMITTED_WITH_EXCLUSIONS','CALCULATING')
          AND updated_at <= $2::timestamptz
       RETURNING id
     ), recorded_issue AS (
       INSERT INTO import_issue(import_batch_id,severity,issue_code,safe_context)
       SELECT id,'ERROR',$4,'{"phase":"CALCULATION_REQUEST","source":"TERMINAL_RECONCILIATION"}'::jsonb
         FROM failed_batch
        WHERE NOT EXISTS (
          SELECT 1 FROM import_issue issue
           WHERE issue.import_batch_id=failed_batch.id AND issue.issue_code=$4
             AND issue.safe_context->>'source'='TERMINAL_RECONCILIATION'
        )
       RETURNING id
     )
     SELECT EXISTS(SELECT 1 FROM failed_batch) AS transitioned,
            (SELECT count(*) FROM recorded_issue) AS recorded_issues`,
    [batchId, completedOn, stage, failureCode],
  );
  return result.rows[0]?.transitioned ? "PROJECTED" : "NOOP";
}

async function projectCalculationRequest(
  pool: Pool,
  batchId: string,
  completedOn: Date,
): Promise<ProjectionOutcome> {
  const run = await pool.query<{ status: string; failure_code: string | null }>(
    `SELECT status,failure_code FROM calculation_run
      WHERE input_manifest->>'sourceImportBatchId'=$1
      ORDER BY created_at DESC,id DESC LIMIT 1`,
    [batchId],
  );
  const current = run.rows[0];
  if (current && ["QUEUED", "RUNNING", "READY"].includes(current.status)) {
    const advanced = await pool.query(
      `UPDATE import_batch
          SET status='CALCULATING',current_stage='CALCULATION',failure_code=NULL,updated_at=clock_timestamp()
        WHERE id=$1
          AND status IN ('COMMITTED','COMMITTED_WITH_EXCLUSIONS','CALCULATING')
          AND updated_at <= $2::timestamptz`,
      [batchId, completedOn],
    );
    return (advanced.rowCount ?? 0) > 0 ? "PROJECTED" : "NOOP";
  }
  if (current && ["BLOCKED", "FAILED"].includes(current.status)) {
    return projectCalculationRequestFailure(pool, batchId, completedOn, current.failure_code ?? "CALCULATION_BLOCKED", "CALCULATION_BLOCKED");
  }
  return projectCalculationRequestFailure(pool, batchId, completedOn);
}

async function projectAutoPublishFailure(
  pool: Pool,
  batchId: string,
  runId: string,
  completedOn: Date,
): Promise<ProjectionOutcome> {
  const published = await pool.query<{ published: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM published_snapshot WHERE calculation_run_id=$1) AS published",
    [runId],
  );
  const result = published.rows[0]?.published
    ? await pool.query(
      `UPDATE import_batch
          SET status='RESULT_PUBLISHED',current_stage='PUBLISHED',failure_code=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND status<>'RESULT_PUBLISHED' AND updated_at <= $2::timestamptz`,
      [batchId, completedOn],
    )
    : await pool.query(
      `UPDATE import_batch
          SET status='READY_FOR_REVIEW',current_stage='AUTO_PUBLISH_FAILED',failure_code='AUTO_PUBLISH_FAILED',updated_at=clock_timestamp()
        WHERE id=$1
          AND status IN ('COMMITTED','COMMITTED_WITH_EXCLUSIONS','CALCULATING','READY_FOR_REVIEW','RESULT_PUBLISHING')
          AND updated_at <= $2::timestamptz`,
      [batchId, completedOn],
    );
  return (result.rowCount ?? 0) > 0 ? "PROJECTED" : "NOOP";
}

export function createTerminalFailureProjector(deps: TerminalReconcilerDependencies): TerminalFailureProjector {
  return {
    async project(job, key) {
      switch (job.name) {
        case "upload.finalize": {
          const file = await deps.pool.query<{ status: string }>("SELECT status FROM upload_file WHERE id=$1", [key.value]);
          if (!file.rows[0] || !["COMPLETE", "ENCRYPTING", "FAILED"].includes(file.rows[0].status)) return "NOOP";
          const failed = await recordUploadFileFailure(deps.pool, {
            fileId: key.value,
            errorCode: "UPLOAD_FINALIZE_FAILED",
            allowedStatuses: ["COMPLETE", "ENCRYPTING"],
          });
          await Promise.all([
            deps.objectStore.removeUncommitted(key.value),
            cleanupUploadStagingArtifacts(deps.pool, { fileId: key.value, tempPath: failed.tempPath }),
          ]);
          return "PROJECTED";
        }
        case "import.analyze": {
          const file = await deps.pool.query<{ parse_status: string | null }>(
            `SELECT analyzed.parse_status
               FROM upload_file source
               JOIN import_batch batch ON batch.upload_batch_id=source.batch_id
               LEFT JOIN import_file analyzed
                 ON analyzed.import_batch_id=batch.id AND analyzed.stored_object_id=source.stored_object_id
              WHERE source.id=$1`,
            [key.value],
          );
          if (!file.rows[0] || (file.rows[0].parse_status !== null && file.rows[0].parse_status !== "PENDING")) return "NOOP";
          await markStoredUploadAnalysisFailed(deps.pool, key.value);
          return "PROJECTED";
        }
        case "import.commit":
          return projectCommitFailure(deps.pool, key.value, job.completed_on);
        case "calculation.requested":
          return projectCalculationRequest(deps.pool, key.value, job.completed_on);
        case "calculation.run": {
          await markCalculationRunFailed(deps.pool, key.value, new Error("CALCULATION_FAILED"));
          const run = await deps.pool.query<{ status: string }>("SELECT status FROM calculation_run WHERE id=$1", [key.value]);
          return run.rows[0]?.status === "FAILED" ? "PROJECTED" : "NOOP";
        }
        case "report.auto-publish": {
          const runId = job.data.runId;
          if (typeof runId !== "string" || !UUID_VALUE.test(runId)) {
            throw new Error("TERMINAL_RECONCILIATION_PAYLOAD_INVALID");
          }
          return projectAutoPublishFailure(deps.pool, key.value, runId, job.completed_on);
        }
        case "export.generate": {
          const request = await deps.pool.query<{ status: string }>("SELECT status FROM export_request WHERE id=$1", [key.value]);
          if (!request.rows[0] || !["QUEUED", "RUNNING"].includes(request.rows[0].status)) return "NOOP";
          await deps.failExport(key.value, new Error("EXPORT_GENERATION_FAILED"));
          return "PROJECTED";
        }
      }
    },
  };
}

export async function reconcileTerminalBusinessFailures(
  pool: Pool,
  projector: TerminalFailureProjector,
  options: { readonly limit?: number; readonly log?: ReconcileLog } = {},
): Promise<number> {
  const limit = options.limit ?? 100;
  const log = options.log ?? defaultLog;
  const jobs = await pool.query<TerminalJob>(
    `SELECT job.id::text,job.name,job.data,job.created_on,job.completed_on
       FROM pgboss.job job
       LEFT JOIN job_operation operation
         ON operation.business_key='terminal-reconcile:' || job.id::text
      WHERE job.state='failed'
        AND job.name=ANY($1::text[])
        AND job.completed_on IS NOT NULL
        AND operation.status IS DISTINCT FROM 'SUCCEEDED'
        AND (operation.id IS NULL OR operation.updated_at <= clock_timestamp()-interval '30 seconds')
      ORDER BY (operation.id IS NOT NULL),COALESCE(operation.updated_at,job.completed_on),job.id
      LIMIT $2`,
    [TERMINAL_QUEUES, limit],
  );
  for (const job of jobs.rows) {
    let key: BusinessKey | undefined;
    try {
      const resolvedKey = businessKey(job);
      key = resolvedKey;
      const locked = await tryWithJobExecutionLock(pool, job.name, resolvedKey.value, async () => {
        if (await isSuperseded(pool, job, resolvedKey)) {
          await recordReconciliation(pool, job, "SUPERSEDED");
          log("info", "terminal_reconciliation_skipped", {
            queueName: job.name,
            jobId: job.id,
            businessId: resolvedKey.value,
            outcome: "SUPERSEDED",
          });
          return;
        }
        const outcome = await projector.project(job, resolvedKey);
        await recordReconciliation(pool, job, outcome);
        log("info", "terminal_reconciliation_succeeded", {
          queueName: job.name,
          jobId: job.id,
          businessId: resolvedKey.value,
          outcome,
        });
      });
      if (!locked.acquired) {
        await recordReconciliationDeferred(pool, job, resolvedKey);
        log("info", "terminal_reconciliation_deferred", {
          queueName: job.name,
          jobId: job.id,
          businessId: resolvedKey.value,
          outcome: "ACTIVE_CALLBACK",
        });
      }
    } catch (error) {
      await recordReconciliationFailure(pool, job, key).catch(() => undefined);
      log("error", "terminal_reconciliation_failed", {
        queueName: job.name,
        jobId: job.id,
        ...(key ? { businessId: key.value } : {}),
        ...safeErrorDiagnostic(error),
      });
    }
  }
  return jobs.rowCount ?? jobs.rows.length;
}

export const TERMINAL_RECONCILIATION_INTERVAL_MS = 30_000;

export function startTerminalReconciler(
  work: () => Promise<unknown>,
  onFailure: (error: unknown) => void,
): { readonly wake: () => void; stop(): Promise<void> } {
  let stopped = false;
  let inFlight: Promise<unknown> | undefined;
  const wake = () => {
    if (stopped || inFlight) return;
    inFlight = work().catch(onFailure).finally(() => { inFlight = undefined; });
  };
  const timer = setInterval(wake, TERMINAL_RECONCILIATION_INTERVAL_MS);
  timer.unref();
  return {
    wake,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
