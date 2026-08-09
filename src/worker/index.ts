import { PgBoss } from "pg-boss";
import { createPool } from "../db/pool";
import { loadConfig } from "../shared/config";
import {
  createOutboxDispatchScheduler,
  dispatchOutbox,
  listenForOutboxNotifications,
} from "./outbox-dispatcher";
import { EncryptedObjectStore } from "../modules/storage/encrypted-object-store";
import { pgBossRuntimeOptions, registerHandlers } from "./register-handlers";
import { exportOutputRoot, PostgresExportService } from "../modules/exports/postgres.js";
import { ChinaMoneyXlsxSource, FixtureChinaMoneySource, HttpChinaMoneySource, curlFetch } from "../modules/fx/index.js";
import { safeErrorDiagnostic } from "../shared/diagnostics.js";

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const boss = new PgBoss(pgBossRuntimeOptions(config.databaseUrl));
await boss.start();
const rawKey = Buffer.from(config.fileKekBase64, "base64");
const objectStore = new EncryptedObjectStore(config.storageRoot, rawKey);
const exportsService = new PostgresExportService(pool, objectStore, exportOutputRoot(process.cwd()));
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
});
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
let stopOutboxNotifications = async () => {};
try {
  stopOutboxNotifications = await listenForOutboxNotifications(pool, dispatcher.wake, reportOutboxError);
} catch (error) {
  reportOutboxError(error);
}
const timer = setInterval(dispatcher.wake, 1_000);
timer.unref();
dispatcher.wake();

let closing = false;
const close = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await stopOutboxNotifications();
  await dispatcher.stop();
  await boss.stop({ graceful: true, timeout: 10_000 });
  await pool.end();
  process.stdout.write(`${JSON.stringify({ level: "info", time: Date.now(), event: "worker_stopped", service: "worker", pid: process.pid })}\n`);
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
