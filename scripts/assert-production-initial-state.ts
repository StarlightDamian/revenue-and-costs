import { createPool } from "../src/db/pool.js";
import { assertProductionInitialState } from "../src/modules/operations/production-initial-state.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("DATABASE_URL_MISSING");
const expectedDatabase = process.env.PRODUCTION_DATABASE_NAME?.trim() || "revenue_and_costs";
const expectedRole = process.env.PRODUCTION_DATABASE_ROLE?.trim() || "revenue_costs_app";
const pool = createPool(databaseUrl, "cli");
try {
  const evidence = await assertProductionInitialState(pool, {
    database: expectedDatabase,
    role: expectedRole,
  });
  process.stdout.write(`${JSON.stringify({ status: "ok", ...evidence })}\n`);
} finally {
  await pool.end();
}
