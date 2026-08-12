import { describe, expect, it, vi } from "vitest";
import { acquireIntermediateExportLease } from "../../src/api/intermediate-export-capacity.js";

function poolWithLocks(results: boolean[]) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: results.shift() ?? false }], rowCount: 1 };
    return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
  });
  const release = vi.fn();
  return { pool: { connect: vi.fn(async () => ({ query, release })) }, query, release };
}

describe("intermediate export capacity", () => {
  it("holds one account lock and one global slot until release", async () => {
    const runtime = poolWithLocks([true, true]);
    const lease = await acquireIntermediateExportLease(runtime.pool as never, "account-1");
    await lease.release();
    await lease.release();

    expect(runtime.query.mock.calls.filter(([sql]) => String(sql).includes("pg_try_advisory_lock"))).toHaveLength(2);
    expect(runtime.query.mock.calls.filter(([sql]) => String(sql).includes("pg_advisory_unlock"))).toHaveLength(2);
    expect(runtime.release).toHaveBeenCalledTimes(1);
  });

  it("releases the account lock when the single server-sized slot is busy", async () => {
    const runtime = poolWithLocks([true, false]);

    await expect(acquireIntermediateExportLease(runtime.pool as never, "account-1"))
      .rejects.toMatchObject({ code: "INTERMEDIATE_EXPORT_CAPACITY_BUSY", statusCode: 503 });

    expect(runtime.query.mock.calls.filter(([sql]) => String(sql).includes("pg_advisory_unlock"))).toHaveLength(1);
    expect(runtime.release).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the same account already has an export", async () => {
    const runtime = poolWithLocks([false]);
    await expect(acquireIntermediateExportLease(runtime.pool as never, "account-1"))
      .rejects.toMatchObject({ code: "INTERMEDIATE_EXPORT_ACCOUNT_BUSY", statusCode: 429 });
    expect(runtime.release).toHaveBeenCalledTimes(1);
  });
});
