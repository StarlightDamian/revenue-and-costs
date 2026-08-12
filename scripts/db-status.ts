import { createPool } from "../src/db/pool";
import { maintenanceDatabaseUrl } from "./database-url.js";

const pool = createPool(maintenanceDatabaseUrl(), "cli");
try {
  const waitFlagIndex = process.argv.indexOf("--wait-writable-ms");
  const waitWritableMs = waitFlagIndex === -1 ? 0 : Number(process.argv[waitFlagIndex + 1]);
  if (!Number.isInteger(waitWritableMs) || waitWritableMs < 0 || waitWritableMs > 300_000) {
    throw new Error("INVALID_WAIT_WRITABLE_MS");
  }

  const deadline = Date.now() + waitWritableMs;
  while (true) {
    const result = await pool.query<{
      version: string;
      database: string;
      is_in_recovery: boolean;
      transaction_read_only: string;
    }>(
      `SELECT version(),current_database() AS database,pg_is_in_recovery() AS is_in_recovery,
              current_setting('transaction_read_only') AS transaction_read_only`,
    );
    const status = result.rows[0];
    if (status && !status.is_in_recovery && status.transaction_read_only === "off") {
      process.stdout.write(`${JSON.stringify({ ...status, writable: true })}\n`);
      break;
    }
    if (Date.now() >= deadline) throw new Error("POSTGRESQL_NOT_WRITABLE");
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
} finally {
  await pool.end();
}
