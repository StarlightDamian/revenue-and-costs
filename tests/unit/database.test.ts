import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresDatabase } from "../../src/db/database.js";
import { createPool } from "../../src/db/pool.js";
import { REQUIRED_USABLE_CONNECTIONS, STEADY_STATE_CONNECTION_BUDGET } from "../../src/db/connection-budget.js";

function transactionFixture() {
  const release = vi.fn();
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith("SELECT") ? [{ value: "ok" }] : [],
    rowCount: sql.startsWith("SELECT") ? 1 : null,
  }));
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { database: new PostgresDatabase(pool), query, release };
}

describe("PostgresDatabase transaction", () => {
  it("uses purpose-specific bounded pools with observable application names", async () => {
    const api = createPool("postgresql://example.invalid/test", "api");
    const worker = createPool("postgresql://example.invalid/test", "worker");
    const cli = createPool("postgresql://example.invalid/test", "cli");

    expect(api.options).toMatchObject({ max: 2, application_name: "revenue-costs-api" });
    expect(worker.options).toMatchObject({ max: 3, application_name: "revenue-costs-worker" });
    expect(cli.options).toMatchObject({ max: 1, application_name: "revenue-costs-cli" });

    await Promise.all([api.end(), worker.end(), cli.end()]);
    expect(STEADY_STATE_CONNECTION_BUDGET).toBe(6);
    expect(REQUIRED_USABLE_CONNECTIONS).toBe(17);
  });

  it("commits the work result and releases the connection", async () => {
    const fixture = transactionFixture();

    await expect(
      fixture.database.transaction(async (client) => {
        const result = await client.query<{ value: string }>("SELECT $1::text AS value", ["ok"]);
        return result.rows[0]?.value;
      }),
    ).resolves.toBe("ok");

    expect(fixture.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT $1::text AS value",
      "COMMIT",
    ]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });

  it("rolls back failed work and releases the connection", async () => {
    const fixture = transactionFixture();

    await expect(
      fixture.database.transaction(async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");

    expect(fixture.query.mock.calls.map(([sql]) => sql)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(fixture.release).toHaveBeenCalledOnce();
  });
});
