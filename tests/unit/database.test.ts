import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresDatabase } from "../../src/db/database.js";

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
