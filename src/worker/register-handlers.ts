import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import type { EncryptedObjectStore } from "../modules/storage/encrypted-object-store";
import { finalizeUploadFile } from "../modules/uploads/finalize";
import { recordUploadFileFailure } from "../modules/uploads/partial-failure.js";
import { cleanupUploadStagingArtifacts } from "../modules/uploads/staging-cleanup.js";
import {
  analyzeStoredUpload,
  loadImportMappingCandidates,
  markStoredUploadAnalysisFailed,
} from "../modules/imports/postgres-analyzer.js";
import {
  commitImportBatch,
  markImportCommitFailed,
  safeImportCommitFailureCode,
} from "../modules/imports/postgres-commit.js";
import {
  calculateRun,
  markCalculationRunFailed,
  permanentCalculationFailureCode,
} from "../modules/calculation/postgres-runner.js";
import {
  isPermanentExportFailure,
  safeExportFailureCode,
  type PostgresExportService,
} from "../modules/exports/postgres.js";
import { PostgresDatabase } from "../db/database.js";
import { PostgresReportService } from "../modules/publishing/postgres-service.js";
import { syncChinaMoney, type ChinaMoneySource, type FxSyncKind } from "../modules/fx/index.js";
import { Temporal } from "@js-temporal/polyfill";
import { safeErrorDiagnostic } from "../shared/diagnostics.js";
import { structuredLog } from "../shared/structured-logger.js";
import { withJobExecutionLocks } from "./job-execution-lock.js";
import { replicateStoredObject, storedObjectReplicaPath } from "../modules/operations/replication.js";

interface FxSyncRuntime {
  readonly source: ChinaMoneySource;
  readonly historyStart: string;
}

interface FxSyncJob {
  readonly kind: FxSyncKind;
  readonly from?: string;
  readonly to?: string;
}

interface StoredObjectReplicationRuntime {
  readonly root: string;
  readonly targetReference: string;
}

const CALCULATION_REQUEST_BLOCKERS = new Set([
  "IMPORT_BATCH_NOT_FOUND",
  "NO_ACTIVE_DATASET",
  "CALCULATION_MARKETPLACE_POLICY_NOT_INITIALIZED",
  "HARD_INCOMPLETE_CONFIRMATION_REQUIRED",
  "CALCULATION_DATE_ATTRIBUTION_MODE_MIXED",
  "CALCULATION_POLICY_NOT_INITIALIZED",
  "CALCULATION_RUN_CREATE_FAILED",
]);

export function calculationRequestBlockCode(error: unknown): string | undefined {
  if (error instanceof Error && CALCULATION_REQUEST_BLOCKERS.has(error.message)) return error.message;
  if (error && typeof error === "object" && "code" in error
    && typeof error.code === "string" && /^42[A-Z0-9]{3}$/u.test(error.code)) {
    return "CALCULATION_REQUEST_QUERY_INVALID";
  }
  return undefined;
}

interface BusinessFailureProjection {
  readonly status: string;
  readonly currentStage: string | null;
  readonly failureCode: string | null;
  readonly transitioned: boolean;
}

export async function markCalculationRequestFailed(
  pool: Pool,
  batchId: string,
  failureCode: string,
): Promise<BusinessFailureProjection> {
  const result = await pool.query<{
    status: string;
    current_stage: string | null;
    failure_code: string | null;
    transitioned: boolean;
  }>(
    `WITH failed_batch AS (
       UPDATE import_batch
          SET status='FAILED',current_stage='CALCULATION_REQUEST_BLOCKED',failure_code=$2,updated_at=clock_timestamp()
        WHERE id=$1 AND status IN ('COMMITTED','COMMITTED_WITH_EXCLUSIONS','CALCULATING')
       RETURNING id,status,current_stage,failure_code
     ), recorded_issue AS (
       INSERT INTO import_issue(import_batch_id,severity,issue_code,safe_context)
       SELECT failed.id,'ERROR',$2,'{"phase":"CALCULATION_REQUEST","source":"WORKER_TERMINAL"}'::jsonb
         FROM failed_batch failed
        WHERE NOT EXISTS (
          SELECT 1 FROM import_issue issue
           WHERE issue.import_batch_id=failed.id AND issue.issue_code=$2
             AND issue.safe_context->>'source'='WORKER_TERMINAL'
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

function jobLog(level: "info" | "error", event: string, fields: Record<string, unknown>): void {
  structuredLog(level, "worker", event, fields);
}

export async function runRetryableJob(
  attempt: { readonly retryCount: number; readonly retryLimit: number },
  work: () => Promise<void>,
  onTerminalFailure: (error: unknown) => Promise<void>,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (attempt.retryCount >= attempt.retryLimit) await onTerminalFailure(error);
    throw error;
  }
}

export async function runImportCommitJob(
  attempt: { readonly retryCount: number; readonly retryLimit: number },
  work: () => Promise<void>,
  onExhaustedFailure: (error: unknown) => Promise<void>,
): Promise<{
  status: "completed" | "failed" | "deadletter";
  output?: { readonly errorCode: string };
}> {
  try {
    await work();
    return { status: "completed" };
  } catch (error) {
    const persistedCode = safeImportCommitFailureCode(error);
    if (persistedCode) return { status: "deadletter", output: { errorCode: persistedCode } };
    if (attempt.retryCount >= attempt.retryLimit) {
      await onExhaustedFailure(error);
      return { status: "failed", output: { errorCode: "IMPORT_COMMIT_FAILED" } };
    }
    return { status: "failed", output: { errorCode: "IMPORT_COMMIT_RETRYABLE" } };
  }
}

export async function runCalculationRequestJob(
  attempt: { readonly retryCount: number; readonly retryLimit: number },
  work: () => Promise<void>,
  onTerminalFailure: (error: unknown, errorCode: string) => Promise<void>,
): Promise<{
  status: "completed" | "failed" | "deadletter";
  output?: { readonly errorCode: string };
}> {
  try {
    await work();
    return { status: "completed" };
  } catch (error) {
    const permanentCode = calculationRequestBlockCode(error);
    if (permanentCode) {
      await onTerminalFailure(error, permanentCode);
      return { status: "deadletter", output: { errorCode: permanentCode } };
    }
    if (attempt.retryCount >= attempt.retryLimit) {
      await onTerminalFailure(error, "CALCULATION_REQUEST_FAILED");
      return { status: "failed", output: { errorCode: "CALCULATION_REQUEST_FAILED" } };
    }
    return { status: "failed", output: { errorCode: "CALCULATION_REQUEST_RETRYABLE" } };
  }
}

export async function runCalculationJob(
  attempt: { readonly retryCount: number; readonly retryLimit: number },
  work: () => Promise<void>,
  onTerminalFailure: (error: unknown) => Promise<void>,
): Promise<{
  status: "completed" | "failed" | "deadletter";
  output?: { readonly errorCode: string };
}> {
  try {
    await work();
    return { status: "completed" };
  } catch (error) {
    const permanentCode = permanentCalculationFailureCode(error);
    const exhausted = attempt.retryCount >= attempt.retryLimit;
    if (permanentCode || exhausted) await onTerminalFailure(error);
    return {
      status: permanentCode ? "deadletter" : "failed",
      output: { errorCode: permanentCode ?? (exhausted ? "CALCULATION_FAILED" : "CALCULATION_RETRYABLE") },
    };
  }
}

export async function runExportJob(
  attempt: { readonly retryCount: number; readonly retryLimit: number },
  work: () => Promise<void>,
  onTerminalFailure: (error: unknown) => Promise<void>,
  isPermanentFailure: (error: unknown) => boolean,
): Promise<{
  status: "completed" | "failed" | "deadletter";
  output?: { readonly errorCode: string };
}> {
  try {
    await work();
    return { status: "completed" };
  } catch (error) {
    const permanent = isPermanentFailure(error);
    if (permanent || attempt.retryCount >= attempt.retryLimit) await onTerminalFailure(error);
    return {
      status: permanent ? "deadletter" : "failed",
      output: { errorCode: safeExportFailureCode(error) },
    };
  }
}

export function chinaMoneyRange(job: FxSyncJob, historyStart: string, now = Temporal.Now.instant()): { from: string; to: string } {
  const today = now.toZonedDateTimeISO("Asia/Shanghai").toPlainDate();
  if (job.kind === "FULL_HISTORY") return { from: historyStart, to: today.toString() };
  if (job.kind === "RECENT_SEVEN_DAYS") return { from: today.subtract({ days: 6 }).toString(), to: today.toString() };
  if (!job.from || !job.to) throw new Error("FX_MANUAL_RANGE_REQUIRED");
  const from = Temporal.PlainDate.from(job.from);
  const to = Temporal.PlainDate.from(job.to);
  if (Temporal.PlainDate.compare(from, to) > 0) throw new Error("FX_MANUAL_RANGE_INVALID");
  return { from: from.toString(), to: to.toString() };
}

export function permanentUploadFailure(error: unknown): `ZIP_${string}` | "PDF_BODY_UPLOAD_REJECTED" | undefined {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "PDF_BODY_UPLOAD_REJECTED") return code;
  return /^ZIP_[A-Z0-9_]+$/u.test(code) ? code as `ZIP_${string}` : undefined;
}

export const FILE_JOB_BATCH_SIZE = 32;

async function loadActiveJobIds(
  pool: Pool,
  jobs: readonly { readonly id: string }[],
): Promise<ReadonlySet<string>> {
  if (jobs.length === 0) return new Set();
  const result = await pool.query<{ id: string }>(
    "SELECT id::text AS id FROM pgboss.job WHERE state='active' AND id::text=ANY($1::text[])",
    [jobs.map((job) => job.id)],
  );
  return new Set(result.rows.map((row) => row.id));
}

export async function runImportAnalyzeBatch(
  jobs: readonly {
    readonly id: string;
    readonly data: { readonly fileId: string };
    readonly retryCount: number;
    readonly retryLimit: number;
  }[],
  analyze: (fileId: string) => Promise<void>,
  options: {
    readonly log?: typeof jobLog;
    readonly onTerminalFailure?: (
      job: { readonly id: string; readonly data: { readonly fileId: string }; readonly retryCount: number; readonly retryLimit: number },
      error: unknown,
    ) => Promise<{
      readonly importBatchId: string;
      readonly importFileStatus: string;
      readonly batchStatus: string;
      readonly batchStage: string;
      readonly batchFailureCode: string | null;
    }>;
  } = {},
): Promise<Array<{ readonly id: string; readonly status: "completed" | "failed"; readonly output?: { readonly errorCode: string } }>> {
  const log = options.log ?? jobLog;
  const results = [];
  for (const job of jobs) {
    log("info", "import_analysis_started", {
      jobId: job.id,
      fileId: job.data.fileId,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    });
    try {
      await analyze(job.data.fileId);
      log("info", "import_analysis_succeeded", {
        jobId: job.id,
        fileId: job.data.fileId,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      });
      results.push({ id: job.id, status: "completed" as const });
    } catch (error) {
      const exhausted = job.retryCount >= job.retryLimit;
      const errorCode = exhausted ? "IMPORT_ANALYZE_FAILED" : "IMPORT_ANALYZE_RETRYABLE";
      log("error", "import_analysis_failed", {
        jobId: job.id,
        fileId: job.data.fileId,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
        errorCode,
        ...safeErrorDiagnostic(error),
      });
      if (exhausted) {
        const projection = await options.onTerminalFailure?.(job, error);
        log("error", "import_analysis_terminal_failed", {
          jobId: job.id,
          fileId: job.data.fileId,
          retryCount: job.retryCount,
          retryLimit: job.retryLimit,
          errorCode,
          importFileStatus: projection?.importFileStatus ?? "UNKNOWN",
          businessId: projection?.importBatchId,
          businessStatus: projection?.batchStatus ?? "UNKNOWN",
          businessStage: projection?.batchStage,
          businessFailureCode: projection?.batchFailureCode,
          queueResult: "failed",
        });
      }
      results.push({ id: job.id, status: "failed" as const, output: { errorCode } });
    }
  }
  return results;
}

export async function registerHandlers(boss: PgBoss, deps: { pool: Pool; objectStore: EncryptedObjectStore; exports: PostgresExportService; databaseCapacityPath?: string; fxSync?: FxSyncRuntime; replication?: StoredObjectReplicationRuntime }): Promise<void> {
  const durableQueue = {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 6 * 60 * 60,
    heartbeatSeconds: 30,
    notify: false,
  } as const;
  const ensureQueue = async (name: string, options: typeof durableQueue & { readonly policy?: "exclusive" }): Promise<void> => {
    await boss.createQueue(name, options);
    // createQueue is intentionally idempotent and does not update a queue that
    // already exists. Apply runtime/retry settings on every boot so forward
    // configuration changes (notably heartbeats) also protect existing installs.
    await boss.updateQueue(name, durableQueue);
  };
  await ensureQueue("upload.finalize", durableQueue);
  await ensureQueue("import.analyze", durableQueue);
  await ensureQueue("import.commit", durableQueue);
  await ensureQueue("calculation.run", durableQueue);
  await ensureQueue("calculation.requested", durableQueue);
  await ensureQueue("report.auto-publish", durableQueue);
  await ensureQueue("export.generate", durableQueue);
  await ensureQueue("storage.replicate", durableQueue);
  if (deps.fxSync) await ensureQueue("fx.sync", { ...durableQueue, policy: "exclusive" });
  const workOptions = { batchSize: 1, pollingIntervalSeconds: 2, heartbeatRefreshSeconds: 10 } as const;
  const retryAwareWorkOptions = { ...workOptions, includeMetadata: true } as const;
  const calculationWorkOptions = { ...retryAwareWorkOptions, perJobResults: true } as const;
  const importCommitWorkOptions = { ...retryAwareWorkOptions, perJobResults: true } as const;
  const calculationRequestWorkOptions = { ...retryAwareWorkOptions, perJobResults: true } as const;
  const exportWorkOptions = { ...retryAwareWorkOptions, perJobResults: true } as const;
  const fileWorkOptions = { ...workOptions, batchSize: FILE_JOB_BATCH_SIZE, perJobResults: true, includeMetadata: true } as const;
  const uploadWorkOptions = fileWorkOptions;
  if (deps.replication) {
    const replication = deps.replication;
    await boss.work<{ objectId: string }, void, typeof fileWorkOptions>("storage.replicate", fileWorkOptions, async (jobs) => await withJobExecutionLocks(
      deps.pool,
      jobs.map((job) => ({ queueName: "storage.replicate" as const, businessId: job.data.objectId })),
      async () => {
        const activeJobIds = await loadActiveJobIds(deps.pool, jobs);
        const results = [];
        for (const job of jobs) {
          if (!activeJobIds.has(job.id)) {
            results.push({ id: job.id, status: "completed" as const });
            continue;
          }
          try {
            await replicateStoredObject(deps.pool, {
              objectId: job.data.objectId,
              replicaName: "offsite-primary",
              destination: storedObjectReplicaPath(replication.root, job.data.objectId),
              targetKind: "OFFSITE",
              targetReference: replication.targetReference,
            });
            jobLog("info", "stored_object_replication_succeeded", { jobId: job.id, objectId: job.data.objectId });
            results.push({ id: job.id, status: "completed" as const });
          } catch (error) {
            const exhausted = job.retryCount >= job.retryLimit;
            const errorCode = exhausted ? "STORED_OBJECT_REPLICATION_FAILED" : "STORED_OBJECT_REPLICATION_RETRYABLE";
            jobLog("error", "stored_object_replication_failed", {
              jobId: job.id,
              objectId: job.data.objectId,
              retryCount: job.retryCount,
              retryLimit: job.retryLimit,
              errorCode,
              ...safeErrorDiagnostic(error),
            });
            results.push({ id: job.id, status: "failed" as const, output: { errorCode } });
          }
        }
        return results;
      },
    ));
  }
  await boss.work<{ fileId: string }, void, typeof uploadWorkOptions>("upload.finalize", uploadWorkOptions, async (jobs) => await withJobExecutionLocks(
    deps.pool,
    jobs.map((job) => ({ queueName: "upload.finalize" as const, businessId: job.data.fileId })),
    async () => {
      const activeJobIds = await loadActiveJobIds(deps.pool, jobs);
      const results = [];
      for (const job of jobs) {
        if (!activeJobIds.has(job.id)) {
          results.push({ id: job.id, status: "completed" as const });
          continue;
        }
        jobLog("info", "upload_finalize_started", {
          jobId: job.id,
          fileId: job.data.fileId,
          retryCount: job.retryCount,
          retryLimit: job.retryLimit,
        });
        try {
          await finalizeUploadFile(deps.pool, deps.objectStore, job.data.fileId);
          jobLog("info", "upload_finalize_succeeded", {
            jobId: job.id,
            fileId: job.data.fileId,
            retryCount: job.retryCount,
            retryLimit: job.retryLimit,
          });
          results.push({ id: job.id, status: "completed" as const });
        } catch (error) {
          const permanentCode = permanentUploadFailure(error);
          const exhausted = job.retryCount >= job.retryLimit;
          const errorCode = permanentCode ?? (exhausted ? "UPLOAD_FINALIZE_FAILED" : "UPLOAD_FINALIZE_RETRYABLE");
          jobLog("error", "upload_finalize_failed", {
            jobId: job.id,
            fileId: job.data.fileId,
            retryCount: job.retryCount,
            retryLimit: job.retryLimit,
            errorCode,
            ...safeErrorDiagnostic(error),
          });
          if (!permanentCode && !exhausted) {
            results.push({ id: job.id, status: "failed" as const, output: { errorCode: "UPLOAD_FINALIZE_RETRYABLE" } });
            continue;
          }
          const terminalErrorCode = permanentCode ?? "UPLOAD_FINALIZE_FAILED";
          const failed = await recordUploadFileFailure(deps.pool, {
            fileId: job.data.fileId,
            errorCode: terminalErrorCode,
            allowedStatuses: ["COMPLETE", "ENCRYPTING"],
          });
          await Promise.all([
            deps.objectStore.removeUncommitted(job.data.fileId),
            cleanupUploadStagingArtifacts(deps.pool, { fileId: job.data.fileId, tempPath: failed.tempPath }),
          ]);
          jobLog("error", "upload_finalize_terminal_failed", {
            jobId: job.id,
            fileId: job.data.fileId,
            uploadBatchId: failed.batchId,
            importBatchId: failed.importBatchId,
            retryCount: job.retryCount,
            retryLimit: job.retryLimit,
            errorCode: terminalErrorCode,
            businessStatus: "FAILED",
            queueResult: "deadletter",
          });
          results.push({ id: job.id, status: "deadletter" as const, output: { errorCode: terminalErrorCode } });
        }
      }
      return results;
    },
  ));
  await boss.work<{ fileId: string }, void, typeof fileWorkOptions>("import.analyze", fileWorkOptions, async (jobs) => await withJobExecutionLocks(
    deps.pool,
    jobs.map((job) => ({ queueName: "import.analyze" as const, businessId: job.data.fileId })),
    async () => {
      const activeJobIds = await loadActiveJobIds(deps.pool, jobs);
      const activeJobs = jobs.filter((job) => activeJobIds.has(job.id));
      const inactiveResults = jobs
        .filter((job) => !activeJobIds.has(job.id))
        .map((job) => ({ id: job.id, status: "completed" as const }));
      if (activeJobs.length === 0) return inactiveResults;
      let mappingCandidates: Awaited<ReturnType<typeof loadImportMappingCandidates>> | undefined;
      let mappingLoadError: unknown;
      let mappingLoadFailed = false;
      try {
        mappingCandidates = await loadImportMappingCandidates(deps.pool);
      } catch (error) {
        mappingLoadError = error;
        mappingLoadFailed = true;
      }
      const activeResults = await runImportAnalyzeBatch(
        activeJobs,
        async (fileId) => {
          if (mappingLoadFailed) throw mappingLoadError;
          await analyzeStoredUpload(deps.pool, deps.objectStore, fileId, mappingCandidates);
        },
        {
          onTerminalFailure: async (job) => await markStoredUploadAnalysisFailed(deps.pool, job.data.fileId),
        },
      );
      return [...inactiveResults, ...activeResults];
    },
  ));
  await boss.work<{ batchId: string; actorAccountId: string }, void, typeof importCommitWorkOptions>("import.commit", importCommitWorkOptions, async (jobs) => await withJobExecutionLocks(
    deps.pool,
    jobs.map((job) => ({ queueName: "import.commit" as const, businessId: job.data.batchId })),
    async () => {
      const activeJobIds = await loadActiveJobIds(deps.pool, jobs);
      const results = [];
      for (const job of jobs) {
        if (!activeJobIds.has(job.id)) {
          results.push({ id: job.id, status: "completed" as const });
          continue;
        }
        let terminalProjection: BusinessFailureProjection | undefined;
        const result = await runImportCommitJob(
          job,
          async () => {
            jobLog("info", "import_commit_started", {
              jobId: job.id,
              batchId: job.data.batchId,
              retryCount: job.retryCount,
              retryLimit: job.retryLimit,
            });
            try {
              await commitImportBatch(deps.pool, deps.objectStore, job.data.batchId, job.data.actorAccountId, deps.databaseCapacityPath);
              jobLog("info", "import_commit_succeeded", {
                jobId: job.id,
                batchId: job.data.batchId,
                retryCount: job.retryCount,
                retryLimit: job.retryLimit,
              });
            } catch (error) {
              const persistedCode = safeImportCommitFailureCode(error);
              jobLog("error", "import_commit_failed", {
                jobId: job.id,
                batchId: job.data.batchId,
                retryCount: job.retryCount,
                retryLimit: job.retryLimit,
                errorCode: persistedCode ?? (job.retryCount >= job.retryLimit ? "IMPORT_COMMIT_FAILED" : "IMPORT_COMMIT_RETRYABLE"),
                ...safeErrorDiagnostic(error),
              });
              throw error;
            }
          },
          async () => {
            terminalProjection = await markImportCommitFailed(deps.pool, job.data.batchId);
          },
        );
        const terminal = result.status === "deadletter" || (result.status === "failed" && job.retryCount >= job.retryLimit);
        if (terminal) {
          if (!terminalProjection) {
            terminalProjection = await markImportCommitFailed(
              deps.pool,
              job.data.batchId,
              result.output?.errorCode ?? "IMPORT_COMMIT_FAILED",
            );
          }
          jobLog("error", "import_commit_terminal_failed", {
            jobId: job.id,
            batchId: job.data.batchId,
            retryCount: job.retryCount,
            retryLimit: job.retryLimit,
            errorCode: result.output?.errorCode ?? "IMPORT_COMMIT_FAILED",
            businessStatus: terminalProjection.status,
            businessStage: terminalProjection.currentStage,
            businessFailureCode: terminalProjection.failureCode,
            transitioned: terminalProjection.transitioned,
            queueResult: result.status,
          });
        }
        results.push({ id: job.id, ...result });
      }
      return results;
    },
  ));
  await boss.work<{ runId: string }, void, typeof calculationWorkOptions>("calculation.run", calculationWorkOptions, async (jobs) => await withJobExecutionLocks(
    deps.pool,
    jobs.map((job) => ({ queueName: "calculation.run" as const, businessId: job.data.runId })),
    async (lockClient) => {
      const activeJobIds = await loadActiveJobIds(deps.pool, jobs);
      const results = [];
      for (const job of jobs) {
        if (!activeJobIds.has(job.id)) {
          results.push({ id: job.id, status: "completed" as const });
          continue;
        }
        const result = await runCalculationJob(
          job,
          async () => {
            jobLog("info", "calculation_started", {
              jobId: job.id,
              runId: job.data.runId,
              retryCount: job.retryCount,
              retryLimit: job.retryLimit,
            });
            try {
              await calculateRun(deps.pool, job.data.runId, lockClient);
              jobLog("info", "calculation_succeeded", {
                jobId: job.id,
                runId: job.data.runId,
                retryCount: job.retryCount,
                retryLimit: job.retryLimit,
              });
            } catch (error) {
              jobLog("error", "calculation_failed", {
                jobId: job.id,
                runId: job.data.runId,
                retryCount: job.retryCount,
                retryLimit: job.retryLimit,
                errorCode: permanentCalculationFailureCode(error) ?? (job.retryCount >= job.retryLimit
                  ? "CALCULATION_FAILED"
                  : "CALCULATION_RETRYABLE"),
                ...safeErrorDiagnostic(error),
              });
              throw error;
            }
          },
          async (error) => {
            await markCalculationRunFailed(deps.pool, job.data.runId, error);
            let row: { status: string; failure_code: string | null } | undefined;
            try {
              row = (await deps.pool.query<{ status: string; failure_code: string | null }>(
                "SELECT status,failure_code FROM calculation_run WHERE id=$1",
                [job.data.runId],
              )).rows[0];
            } catch {
            // The terminal write already succeeded; diagnostics are best-effort.
            }
            const permanentCode = permanentCalculationFailureCode(error);
            jobLog("error", "calculation_terminal_failed", {
              jobId: job.id,
              runId: job.data.runId,
              retryCount: job.retryCount,
              retryLimit: job.retryLimit,
              errorCode: row?.failure_code ?? permanentCode ?? "CALCULATION_FAILED",
              businessStatus: row?.status ?? "NOT_FOUND",
              queueResult: permanentCode ? "deadletter" : "failed",
            });
          },
        );
        results.push({ id: job.id, ...result });
      }
      return results;
    },
  ));
  const database = new PostgresDatabase(deps.pool);
  const reports = new PostgresReportService(database, database);
  await boss.work<{ batchId: string; actorAccountId: string }, void, typeof calculationRequestWorkOptions>("calculation.requested", calculationRequestWorkOptions, async (jobs) => await withJobExecutionLocks(
    deps.pool,
    jobs.map((job) => ({ queueName: "calculation.requested" as const, businessId: job.data.batchId })),
    async () => {
      const activeJobIds = await loadActiveJobIds(deps.pool, jobs);
      const results = [];
      for (const job of jobs) {
        if (!activeJobIds.has(job.id)) {
          results.push({ id: job.id, status: "completed" as const });
          continue;
        }
        let shopId: string | undefined;
        jobLog("info", "calculation_request_started", {
          jobId: job.id,
          batchId: job.data.batchId,
          retryCount: job.retryCount,
          retryLimit: job.retryLimit,
        });
        const jobResult = await runCalculationRequestJob(
          job,
          async () => {
            try {
              const batch = await deps.pool.query<{ shop_id: string }>("SELECT shop_id FROM import_batch WHERE id=$1", [job.data.batchId]);
              shopId = batch.rows[0]?.shop_id;
              if (!shopId) throw new Error("IMPORT_BATCH_NOT_FOUND");
              const requested = await reports.requestCalculation(shopId, {
                actorAccountId: job.data.actorAccountId,
                idempotencyKey: `import:${job.data.batchId}`,
                sourceImportBatchId: job.data.batchId,
                autoPublish: true,
              });
              await deps.pool.query(
                `UPDATE import_batch AS batch
                  SET status=CASE WHEN run.status='BLOCKED' THEN 'FAILED' ELSE 'CALCULATING' END,
                      current_stage=CASE WHEN run.status='BLOCKED' THEN 'CALCULATION_BLOCKED' ELSE 'CALCULATION' END,
                      failure_code=CASE WHEN run.status='BLOCKED' THEN 'CALCULATION_BLOCKED' ELSE NULL END,
                      updated_at=clock_timestamp()
                 FROM calculation_run AS run
                WHERE batch.id=$1
                  AND batch.status IN ('COMMITTED','COMMITTED_WITH_EXCLUSIONS','CALCULATING')
                  AND run.id=$2
                  AND run.shop_id=batch.shop_id
                  AND run.input_manifest->>'sourceImportBatchId'=batch.id::text
                  AND run.status IN ('QUEUED','RUNNING','BLOCKED')`,
                [job.data.batchId, requested.runId],
              );
              if (requested.status === "BLOCKED") {
                jobLog("error", "calculation_request_terminal_failed", {
                  jobId: job.id,
                  batchId: job.data.batchId,
                  shopId,
                  runId: requested.runId,
                  retryCount: job.retryCount,
                  retryLimit: job.retryLimit,
                  errorCode: "CALCULATION_BLOCKED",
                  businessStatus: "FAILED",
                  businessStage: "CALCULATION_BLOCKED",
                  businessFailureCode: "CALCULATION_BLOCKED",
                  queueResult: "completed",
                });
              } else {
                jobLog("info", "calculation_request_succeeded", {
                  jobId: job.id,
                  batchId: job.data.batchId,
                  shopId,
                  runId: requested.runId,
                  retryCount: job.retryCount,
                  retryLimit: job.retryLimit,
                });
              }
            } catch (error) {
              const permanentCode = calculationRequestBlockCode(error);
              jobLog("error", "calculation_request_failed", {
                jobId: job.id,
                batchId: job.data.batchId,
                ...(shopId ? { shopId } : {}),
                retryCount: job.retryCount,
                retryLimit: job.retryLimit,
                errorCode: permanentCode ?? (job.retryCount >= job.retryLimit
                  ? "CALCULATION_REQUEST_FAILED"
                  : "CALCULATION_REQUEST_RETRYABLE"),
                ...safeErrorDiagnostic(error),
              });
              throw error;
            }
          },
          async (_error, errorCode) => {
            const projection = await markCalculationRequestFailed(deps.pool, job.data.batchId, errorCode);
            if (errorCode !== "CALCULATION_REQUEST_FAILED") {
              jobLog("info", "calculation_request_blocked", {
                jobId: job.id,
                batchId: job.data.batchId,
                ...(shopId ? { shopId } : {}),
                errorCode,
              });
            }
            jobLog("error", "calculation_request_terminal_failed", {
              jobId: job.id,
              batchId: job.data.batchId,
              ...(shopId ? { shopId } : {}),
              retryCount: job.retryCount,
              retryLimit: job.retryLimit,
              errorCode,
              businessStatus: projection.status,
              businessStage: projection.currentStage,
              businessFailureCode: projection.failureCode,
              transitioned: projection.transitioned,
              queueResult: errorCode === "CALCULATION_REQUEST_FAILED" ? "failed" : "deadletter",
            });
          },
        );
        results.push({ id: job.id, ...jobResult });
      }
      return results;
    },
  ));
  await boss.work<{ runId: string; actorAccountId: string; sourceImportBatchId: string }, void, typeof retryAwareWorkOptions>(
    "report.auto-publish",
    retryAwareWorkOptions,
    async (jobs) => await withJobExecutionLocks(
      deps.pool,
      jobs.map((job) => ({ queueName: "report.auto-publish" as const, businessId: job.data.sourceImportBatchId })),
      async () => {
        const activeJobIds = await loadActiveJobIds(deps.pool, jobs);
        for (const job of jobs) {
          if (!activeJobIds.has(job.id)) continue;
          await runRetryableJob(
            job,
            async () => {
              jobLog("info", "report_auto_publish_started", {
                jobId: job.id,
                runId: job.data.runId,
                batchId: job.data.sourceImportBatchId,
                retryCount: job.retryCount,
                retryLimit: job.retryLimit,
              });
              try {
                const result = await reports.autoPublishCalculation(job.data.runId, job.data.actorAccountId, job.data.sourceImportBatchId);
                jobLog("info", "report_auto_publish_succeeded", {
                  jobId: job.id,
                  runId: job.data.runId,
                  batchId: job.data.sourceImportBatchId,
                  snapshotId: result.snapshotId,
                  retryCount: job.retryCount,
                  retryLimit: job.retryLimit,
                });
              } catch (error) {
                jobLog("error", "report_auto_publish_failed", {
                  jobId: job.id,
                  runId: job.data.runId,
                  batchId: job.data.sourceImportBatchId,
                  retryCount: job.retryCount,
                  retryLimit: job.retryLimit,
                  errorCode: job.retryCount >= job.retryLimit ? "AUTO_PUBLISH_FAILED" : "AUTO_PUBLISH_RETRYABLE",
                  ...safeErrorDiagnostic(error),
                });
                throw error;
              }
            },
            async () => {
              await reports.markAutoPublishFailed(job.data.sourceImportBatchId);
              let row: { status: string; current_stage: string | null; failure_code: string | null } | undefined;
              try {
                row = (await deps.pool.query<{ status: string; current_stage: string | null; failure_code: string | null }>(
                  "SELECT status,current_stage,failure_code FROM import_batch WHERE id=$1",
                  [job.data.sourceImportBatchId],
                )).rows[0];
              } catch {
                // The terminal write already succeeded; diagnostics are best-effort.
              }
              jobLog("error", "report_auto_publish_terminal_failed", {
                jobId: job.id,
                runId: job.data.runId,
                batchId: job.data.sourceImportBatchId,
                retryCount: job.retryCount,
                retryLimit: job.retryLimit,
                errorCode: row?.failure_code ?? "AUTO_PUBLISH_FAILED",
                businessStatus: row?.status ?? "NOT_FOUND",
                businessStage: row?.current_stage,
                queueResult: "failed",
              });
            },
          );
        }
      },
    ),
  );
  await boss.work<{ exportId: string }, void, typeof exportWorkOptions>("export.generate", exportWorkOptions, async (jobs) => await withJobExecutionLocks(
    deps.pool,
    jobs.map((job) => ({ queueName: "export.generate" as const, businessId: job.data.exportId })),
    async () => {
      const activeJobIds = await loadActiveJobIds(deps.pool, jobs);
      const results = [];
      for (const job of jobs) {
        if (!activeJobIds.has(job.id)) {
          results.push({ id: job.id, status: "completed" as const });
          continue;
        }
        const result = await runExportJob(
          job,
          async () => {
            jobLog("info", "export_generation_started", { jobId: job.id, exportId: job.data.exportId });
            try {
              await deps.exports.generate(job.data.exportId);
              jobLog("info", "export_generation_succeeded", { jobId: job.id, exportId: job.data.exportId });
            } catch (error) {
              jobLog("error", "export_generation_failed", { jobId: job.id, exportId: job.data.exportId, retryCount: job.retryCount, retryLimit: job.retryLimit, ...safeErrorDiagnostic(error) });
              throw error;
            }
          },
          (error) => deps.exports.fail(job.data.exportId, error),
          isPermanentExportFailure,
        );
        results.push({ id: job.id, ...result });
      }
      return results;
    },
  ));
  if (deps.fxSync) {
    const runtime = deps.fxSync;
    await boss.work<FxSyncJob>("fx.sync", workOptions, async (jobs) => {
      for (const job of jobs) {
        const range = chinaMoneyRange(job.data, runtime.historyStart);
        jobLog("info", "fx_sync_started", { jobId: job.id, kind: job.data.kind, ...range });
        try {
          const runId = await syncChinaMoney(deps.pool, runtime.source, job.data.kind, range);
          jobLog("info", "fx_sync_succeeded", { jobId: job.id, runId, kind: job.data.kind, ...range });
        } catch (error) {
          jobLog("error", "fx_sync_failed", { jobId: job.id, kind: job.data.kind, ...range, ...safeErrorDiagnostic(error) });
          throw error;
        }
      }
    });
    await boss.schedule("fx.sync", "0 10 * * *", { kind: "RECENT_SEVEN_DAYS" }, { key: "daily-10-shanghai", tz: "Asia/Shanghai" });
    const history = await deps.pool.query<{ exists: boolean }>(
      "SELECT COALESCE(min(valid_date) <= $1::date,false) AS exists FROM fx_current_quote",
      [runtime.historyStart],
    );
    if (!history.rows[0]?.exists) {
      await boss.send("fx.sync", { kind: "FULL_HISTORY" }, { singletonKey: "initial-full-history" });
    }
  }
}
