import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { SqlClient, SqlQueryResult, TransactionRunner } from "../modules/authorization/index.js";

export async function withTransaction<Result>(
  pool: Pool,
  work: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    const result = await work(connection);
    await connection.query("COMMIT");
    return result;
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}

class PgSqlClient implements SqlClient {
  constructor(private readonly client: Pool | PoolClient) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.client.query<QueryResultRow>(sql, parameters ? [...parameters] : undefined);
    return { rows: result.rows as Row[], rowCount: result.rowCount };
  }
}

export class PostgresDatabase implements SqlClient, TransactionRunner {
  private readonly reader: PgSqlClient;

  constructor(private readonly pool: Pool) {
    this.reader = new PgSqlClient(pool);
  }

  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    return this.reader.query<Row>(sql, parameters);
  }

  async transaction<Result>(work: (client: SqlClient) => Promise<Result>): Promise<Result> {
    return withTransaction(this.pool, (connection) => work(new PgSqlClient(connection)));
  }
}
