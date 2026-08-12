import { PgBoss } from "pg-boss";
import { createPool } from "../db/pool";
import { loadConfig } from "../shared/config";
import {
  createOutboxDispatchScheduler,
  dispatchOutbox,
} from "./outbox-dispatcher";
import { EncryptedObjectStore } from "../modules/storage/encrypted-object-store";
import { registerHandlers } from "./register-handlers";
import { exportOutputRoot, PostgresExportService } from "../modules/exports/postgres.js";
import { ChinaMoneyXlsxSource, FixtureChinaMoneySource, HttpChinaMoneySource, curlFetch } from "../modules/fx/index.js";
import { safeErrorDiagnostic } from "../shared/diagnostics.js";
import { recordWorkerHeartbeat, startWorkerHeartbeat } from "./service-heartbeat.js";
import {
  createTerminalFailureProjector,
  reconcileTerminalBusinessFailures,
  startTerminalReconciler,
} from "./terminal-reconciler.js";
import { expireUploadStaging } from "../modules/uploads/service.js";
import { pgBossRuntimeOptions, startPgBoss } from "./pg-boss-runtime.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl, "worker");
const boss = new PgBoss(pgBossRuntimeOptions(config.databaseUrl));
await startPgBoss(boss);
const rawKey = Buffer.from(config.fileKekBase64, "base64");
const objectStore = new EncryptedObjectStore(config.storageRoot, rawKey);
const exportsService = new PostgresExportService(pool, objectStore, config.exportOutputRoot ?? exportOutputRoot(process.cwd()));
const fxSync = config.chinaMoneyEnabled
  ? {
      source: config.chinaMoneyFixturePath
        ? new FixtureChinaMoneySource(config.chinaMoneyFixturePath)
        : config.chinaMoneyEndpointTemplate
          ? new HttpChinaMoneySource(config.chinaMoneyEndpointTemplate)
          : new ChinaMoneyXlsxSource(undefined, curlFetch),
      historyStart: config.chinaMoneyHistoryStart ?? "",
    }
  : undefined;
await registerHandlers(boss, {
  pool,
  objectStore,
  exports: exportsService,
  ...(config.databaseCapacityPath ? { databaseCapacityPath: config.databaseCapacityPath } : {}),
  ...(fxSync ? { fxSync } : {}),
  ...(config.storageReplicaRoot && config.storageReplicaRoot !== config.storageRoot
    ? { replication: { root: config.storageReplicaRoot, targetReference: config.storageReplicaRoot } }
    : {}),
});
const reportWorkerHeartbeatError = (error: unknown) => process.stderr.write(`${JSON.stringify({
  level: "error",
  time: Date.now(),
  event: "worker_heartbeat_failed",
  service: "worker",
  ...safeErrorDiagnostic(error),
})}\n`);
await recordWorkerHeartbeat(pool);
const workerHeartbeat = startWorkerHeartbeat(pool, reportWorkerHeartbeatError);
process.stdout.write(`${JSON.stringify({ level: "info", time: Date.now(), event: "worker_started", service: "worker", pid: process.pid, fxSyncEnabled: Boolean(fxSync) })}\n`);

const OUTBOX_BATCH_LIMIT = 50;
const reportOutboxError = (error: unknown) => process.stderr.write(`${JSON.stringify({
  level: "error",
  time: Date.now(),
  event: "outbox_dispatch_failed",
  service: "worker",
  pid: process.pid,
  ...safeErrorDiagnostic(error),
})}\n`);
const dispatcher = createOutboxDispatchScheduler(
  () => dispatchOutbox(pool, boss, OUTBOX_BATCH_LIMIT),
  OUTBOX_BATCH_LIMIT,
  reportOutboxError,
);
const timer = setInterval(dispatcher.wake, 1_000);
timer.unref();
dispatcher.wake();

const terminalProjector = createTerminalFailureProjector({
  pool,
  objectStore,
  failExport: (exportId, error) => exportsService.fail(exportId, error),
});
const reportTerminalReconciliationError = (error: unknown) => process.stderr.write(`${JSON.stringify({
  level: "error",
  time: Date.now(),
  event: "terminal_reconciliation_cycle_failed",
  service: "worker",
  ...safeErrorDiagnostic(error),
})}\n`);
const terminalReconciler = startTerminalReconciler(
  async () => {
    await expireUploadStaging(pool);
    await reconcileTerminalBusinessFailures(pool, terminalProjector);
  },
  reportTerminalReconciliationError,
);
terminalReconciler.wake();

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await workerHeartbeat.stop();
  await terminalReconciler.stop();
  await dispatcher.stop();
  await boss.stop({ graceful: true, timeout: 10_000 });
  await pool.end();
  process.stdout.write(`${JSON.stringify({ level: "info", time: Date.now(), event: "worker_stopped", service: "worker", pid: process.pid })}\n`);
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
