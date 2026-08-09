import pg, { type Pool, type PoolClient } from "pg";

pg.types.setTypeParser(20, (value) => value);
pg.types.setTypeParser(1700, (value) => value);
// Domain dates are ISO strings by contract; letting pg coerce `date` to a
// JavaScript Date silently introduces the process timezone.
pg.types.setTypeParser(1082, (value) => value);

export function createPool(connectionString: string): Pool {
  return new pg.Pool({ connectionString, max: 12, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
}

export type Transaction = PoolClient;

export { withTransaction } from "./database.js";
