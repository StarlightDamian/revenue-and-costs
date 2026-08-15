import { createPool } from "../src/db/pool.js";
import { replayCurrentShopSources } from "../src/modules/imports/source-replay.js";
import { EncryptedObjectStore } from "../src/modules/storage/encrypted-object-store.js";
import { loadConfig } from "../src/shared/config.js";
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
const config = loadConfig();
const shopId = requiredArgument("--shop-id");
const confirmedShopId = requiredArgument("--confirm-shop-id");
if (shopId !== confirmedShopId) throw new Error("SOURCE_REPLAY_SHOP_CONFIRMATION_MISMATCH");
const input = {
  shopId,
  actorAccountId: requiredArgument("--actor-account-id"),
  idempotencyKey: requiredArgument("--idempotency-key"),
  reason: requiredArgument("--reason"),
};
const pool = createPool(databaseUrl, "cli");
try {
  const objectStore = new EncryptedObjectStore(config.storageRoot, Buffer.from(config.fileKekBase64, "base64"));
  const result = await replayCurrentShopSources(pool, input, { objectStore });
  process.stdout.write(`${JSON.stringify({ event: "admin_source_replay_created", ...result })}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ event: "admin_source_replay_failed", ...safeErrorDiagnostic(error) })}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
