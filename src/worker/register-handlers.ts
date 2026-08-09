import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { unlink } from "node:fs/promises";
import type { EncryptedObjectStore } from "../modules/storage/encrypted-object-store";
import { finalizeUploadFile } from "../modules/uploads/finalize";
import { recordUploadFileFailure } from "../modules/uploads/partial-failure.js";
import { analyzeStoredUpload, loadImportMappingCandidates } from "../modules/imports/postgres-analyzer.js";
import { commitImportBatch, isPersistedImportCommitFailure } from "../modules/imports/postgres-commit.js";
import { calculateRun, markCalculationRunFailed } from "../modules/calculation/postgres-runner.js";
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

interface FxSyncRuntime {
  readonly source: ChinaMoneySource;
  readonly historyStart: string;
}

interface FxSyncJob {
  readonly kind: FxSyncKind;
  readonly from?: string;
  readonly to?: string;
}

function jobLog(level: "info" | "error", event: string, fields: Record<string, unknown>): void {
  const line = `${JSON.stringify({ level, time: Date.now(), event, service: "worker", ...fields })}\n`;
  (level === "error" ? process.stderr : process.stdout).write(line);
}

export async function runRetryableJob(
  attempt: { readonly retryCount: number; readonly retryLimit: number },
  work: () => Promise<void>,
  onTerminalFailure: (error: unknown) => Promise<void>,
  isPermanentFailure: (error: unknown) => boolean = () => false,
): Promise<void> {
  try {
    await work();
  } catch (error) {
    const permanent = isPermanentFailure(error);
    if (permanent || attempt.retryCount >= attempt.retryLimit) await onTerminalFailure(error);
    if (!permanent) throw error;
  }
}

export function isPermanentCalculationFailure(error: unknown): boolean {
  const code = error instanceof Error ? error.message : String(error);
  return /^TRANSACTION_FULFILLMENT_REIMPORT_REQUIRED:\d+$/u.test(code);
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

export function permanentUploadFailure(error: unknown): `ZIP_${string}` | undefined {
  const code = error instanceof Error ? error.message : String(error);
  return /^ZIP_[A-Z0-9_]+$/u.test(code) ? code as `ZIP_${string}` : undefined;
}

export const FILE_JOB_BATCH_SIZE = 32;

export function pgBossRuntimeOptions(connectionString: string) {
  return { connectionString, schema: "pgboss", useListenNotify: true } as const;
}

export async function runImportAnalyzeBatch(
  jobs: readonly { readonly id: string; readonly data: { readonly fileId: string } }[],
  analyze: (fileId: string) => Promise<void>,
  log: typeof jobLog = jobLog,
): Promise<Array<{ readonly id: string; readonly status: "completed" | "failed"; readonly output?: { readonly errorCode: string } }>> {
  const results = [];
  for (const job of jobs) {
    log("info", "import_analysis_started", { jobId: job.id, fileId: job.data.fileId });
    try {
      await analyze(job.data.fileId);
      log("info", "import_analysis_succeeded", { jobId: job.id, fileId: job.data.fileId });
      results.push({ id: job.id, status: "completed" as const });
    } catch (error) {
      log("error", "import_analysis_failed", { jobId: job.id, fileId: job.data.fileId, ...safeErrorDiagnostic(error) });
      results.push({ id: job.id, status: "failed" as const, output: { errorCode: "IMPORT_ANALYZE_RETRYABLE" } });
    }
  }
  return results;
}

export async function registerHandlers(boss: PgBoss, deps: { pool: Pool; objectStore: EncryptedObjectStore; exports: PostgresExportService; databaseCapacityPath?: string; fxSync?: FxSyncRuntime }): Promise<void> {
  const durableQueue = {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    expireInSeconds: 6 * 60 * 60,
    heartbeatSeconds: 30,
    notify: true,
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
  if (deps.fxSync) await ensureQueue("fx.sync", { ...durableQueue, policy: "exclusive" });
  const workOptions = { batchSize: 1, pollingIntervalSeconds: 2, heartbeatRefreshSeconds: 10 } as const;
  const retryAwareWorkOptions = { ...workOptions, includeMetadata: true } as const;
  const exportWorkOptions = { ...retryAwareWorkOptions, perJobResults: true } as const;
  const fileWorkOptions = { ...workOptions, batchSize: FILE_JOB_BATCH_SIZE, perJobResults: true, includeMetadata: true } as const;
  const uploadWorkOptions = fileWorkOptions;
  await boss.work<{ fileId: string }, void, typeof uploadWorkOptions>("upload.finalize", uploadWorkOptions, async (jobs) => {
    const results = [];
    for (const job of jobs) {
      try {
        await finalizeUploadFile(deps.pool, deps.objectStore, job.data.fileId);
        results.push({ id: job.id, status: "completed" as const });
      } catch (error) {
        const permanentCode = permanentUploadFailure(error);
        const exhausted = job.retryCount >= job.retryLimit;
        if (!permanentCode && !exhausted) {
          results.push({ id: job.id, status: "failed" as const, output: { errorCode: "UPLOAD_FINALIZE_RETRYABLE" } });
          continue;
        }
        const errorCode = permanentCode ?? "UPLOAD_FINALIZE_FAILED";
        const failed = await recordUploadFileFailure(deps.pool, {
          fileId: job.data.fileId,
          errorCode,
          allowedStatuses: ["COMPLETE", "ENCRYPTING"],
        });
        await deps.objectStore.removeUncommitted(job.data.fileId).catch(() => undefined);
        await unlink(failed.tempPath).catch(() => undefined);
        results.push({ id: job.id, status: "deadletter" as const, output: { errorCode } });
      }
    }
    return results;
  });
  await boss.work<{ fileId: string }, void, typeof fileWorkOptions>("import.analyze", fileWorkOptions, async (jobs) => {
    const mappingCandidates = await loadImportMappingCandidates(deps.pool);
    return await runImportAnalyzeBatch(
      jobs,
      async (fileId) => await analyzeStoredUpload(deps.pool, deps.objectStore, fileId, mappingCandidates),
    );
  });
  await boss.work<{ batchId: string; actorAccountId: string }>("import.commit", workOptions, async (jobs) => {
    for (const job of jobs) {
      jobLog("info", "import_commit_started", { jobId: job.id, batchId: job.data.batchId });
      try {
        await commitImportBatch(deps.pool, deps.objectStore, job.data.batchId, job.data.actorAccountId, deps.databaseCapacityPath);
        jobLog("info", "import_commit_succeeded", { jobId: job.id, batchId: job.data.batchId });
      } catch (error) {
        jobLog("error", "import_commit_failed", { jobId: job.id, batchId: job.data.batchId, ...safeErrorDiagnostic(error) });
        if (isPersistedImportCommitFailure(error)) continue;
        throw error;
      }
    }
  });
  await boss.work<{ runId: string }, void, typeof retryAwareWorkOptions>("calculation.run", retryAwareWorkOptions, async (jobs) => {
    for (const job of jobs) await runRetryableJob(
      job,
      async () => {
        jobLog("info", "calculation_started", { jobId: job.id, runId: job.data.runId });
        try {
          await calculateRun(deps.pool, job.data.runId);
          jobLog("info", "calculation_succeeded", { jobId: job.id, runId: job.data.runId });
        } catch (error) {
          jobLog("error", "calculation_failed", { jobId: job.id, runId: job.data.runId, retryCount: job.retryCount, retryLimit: job.retryLimit, ...safeErrorDiagnostic(error) });
          throw error;
        }
      },
      async (error) => {
        await markCalculationRunFailed(deps.pool, job.data.runId, error);
      },
      isPermanentCalculationFailure,
    );
  });
  const database = new PostgresDatabase(deps.pool);
  const reports = new PostgresReportService(database, database);
  await boss.work<{ batchId: string; actorAccountId: string }>("calculation.requested", workOptions, async (jobs) => {
    for (const job of jobs) {
      const result = await deps.pool.query<{ shop_id: string }>("SELECT shop_id FROM import_batch WHERE id=$1", [job.data.batchId]);
      const shopId = result.rows[0]?.shop_id;
      if (!shopId) throw new Error("IMPORT_BATCH_NOT_FOUND");
      jobLog("info", "calculation_request_started", { jobId: job.id, batchId: job.data.batchId, shopId });
      let requested;
      try {
        requested = await reports.requestCalculation(shopId, {
          actorAccountId: job.data.actorAccountId,
          idempotencyKey: `import:${job.data.batchId}`,
          sourceImportBatchId: job.data.batchId,
          autoPublish: true,
        });
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "HARD_INCOMPLETE_CONFIRMATION_REQUIRED") throw error;
        await deps.pool.query(
          "UPDATE import_batch SET status='FAILED',current_stage='CALCULATION_BLOCKED',failure_code=$2,updated_at=clock_timestamp() WHERE id=$1",
          [job.data.batchId, error.message],
        );
        jobLog("info", "calculation_confirmation_required", {
          jobId: job.id,
          batchId: job.data.batchId,
          shopId,
          errorCode: error.message,
        });
        continue;
      }
      await deps.pool.query(
        "UPDATE import_batch SET status='CALCULATING',current_stage='CALCULATION',failure_code=NULL,updated_at=clock_timestamp() WHERE id=$1",
        [job.data.batchId],
      );
      jobLog("info", "calculation_request_succeeded", { jobId: job.id, batchId: job.data.batchId, shopId, runId: requested.runId });
    }
  });
  await boss.work<{ runId: string; actorAccountId: string; sourceImportBatchId: string }, void, typeof retryAwareWorkOptions>(
    "report.auto-publish",
    retryAwareWorkOptions,
    async (jobs) => {
      for (const job of jobs) await runRetryableJob(
        job,
        async () => {
          jobLog("info", "report_auto_publish_started", { jobId: job.id, runId: job.data.runId, batchId: job.data.sourceImportBatchId });
          try {
            const result = await reports.autoPublishCalculation(job.data.runId, job.data.actorAccountId, job.data.sourceImportBatchId);
            jobLog("info", "report_auto_publish_succeeded", { jobId: job.id, runId: job.data.runId, batchId: job.data.sourceImportBatchId, snapshotId: result.snapshotId });
          } catch (error) {
            jobLog("error", "report_auto_publish_failed", { jobId: job.id, runId: job.data.runId, batchId: job.data.sourceImportBatchId, retryCount: job.retryCount, retryLimit: job.retryLimit, ...safeErrorDiagnostic(error) });
            throw error;
          }
        },
        async () => {
          await reports.markAutoPublishFailed(job.data.sourceImportBatchId);
        },
      );
    },
  );
  await boss.work<{ exportId: string }, void, typeof exportWorkOptions>("export.generate", exportWorkOptions, async (jobs) => {
    const results = [];
    for (const job of jobs) {
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
  });
  if (deps.fxSync) {
    const runtime = deps.fxSync;
    await boss.work<FxSyncJob>("fx.sync", workOptions, async (jobs) => {
      for (const job of jobs) {
        const range = chinaMoneyRange(job.data, runtime.historyStart);
        process.stdout.write(`${JSON.stringify({ level: "info", time: Date.now(), event: "fx_sync_started", service: "worker", jobId: job.id, kind: job.data.kind, ...range })}\n`);
        try {
          const runId = await syncChinaMoney(deps.pool, runtime.source, job.data.kind, range);
          process.stdout.write(`${JSON.stringify({ level: "info", time: Date.now(), event: "fx_sync_succeeded", service: "worker", jobId: job.id, runId, kind: job.data.kind, ...range })}\n`);
        } catch (error) {
          process.stderr.write(`${JSON.stringify({ level: "error", time: Date.now(), event: "fx_sync_failed", service: "worker", jobId: job.id, kind: job.data.kind, ...range, ...safeErrorDiagnostic(error) })}\n`);
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
