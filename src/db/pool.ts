import pg, { type Pool, type PoolClient } from "pg";
import { DATABASE_POOL_LIMITS, type DatabasePoolPurpose } from "./connection-budget.js";

pg.types.setTypeParser(20, (value) => value);
pg.types.setTypeParser(1700, (value) => value);
// Domain dates are ISO strings by contract; letting pg coerce `date` to a
// JavaScript Date silently introduces the process timezone.
pg.types.setTypeParser(1082, (value) => value);

export function createPool(connectionString: string, purpose: DatabasePoolPurpose): Pool {
  return new pg.Pool({
    connectionString,
    application_name: `revenue-costs-${purpose}`,
    max: DATABASE_POOL_LIMITS[purpose],
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export type Transaction = PoolClient;

export { withTransaction } from "./database.js";
