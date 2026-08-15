import { createPool } from "../src/db/pool.js";
import { resumeFailedSourceReplay } from "../src/modules/imports/source-replay.js";
import { safeErrorDiagnostic } from "../src/shared/diagnostics.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requiredArgument(name: string): string {
  const value = argument(name)?.trim();
  if (!value) throw new Error(`SOURCE_REPLAY_ARGUMENT_REQUIRED:${name.slice(2).toUpperCase().replaceAll("-", "_")}`);
  return value;
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL_MISSING");
const shopId = requiredArgument("--shop-id");
if (shopId !== requiredArgument("--confirm-shop-id")) throw new Error("SOURCE_REPLAY_SHOP_CONFIRMATION_MISMATCH");
const batchId = requiredArgument("--batch-id");
if (batchId !== requiredArgument("--confirm-batch-id")) throw new Error("SOURCE_REPLAY_BATCH_CONFIRMATION_MISMATCH");
const pool = createPool(databaseUrl, "cli");
try {
  const result = await resumeFailedSourceReplay(pool, {
    shopId,
    batchId,
    actorAccountId: requiredArgument("--actor-account-id"),
    idempotencyKey: requiredArgument("--idempotency-key"),
    reason: requiredArgument("--reason"),
  });
  process.stdout.write(`${JSON.stringify({ event: "admin_source_replay_resumed", ...result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ event: "admin_source_replay_resume_failed", ...safeErrorDiagnostic(error) })}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
