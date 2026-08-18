import { Writable } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  calculateRun,
  insertMonthlySummaries,
  loadFxBook,
  markCalculationRunFailed,
  processRunFacts,
} from "../../src/modules/calculation/postgres-runner";
import { FEE_CLASSIFICATION_POLICY_SHA256, FEE_CLASSIFICATION_VERSION } from "../../src/modules/calculation/fee-classification";

describe("calculation retry lifecycle", () => {
  it("loads the immutable manual FX ids frozen in the calculation manifest", async () => {
    const frozenIds = [
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
    ];
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (sql.includes("FROM fx_override")) return { rows: [{
        id: frozenIds[0], currency: "BRL", valid_from: "2025-01-01", valid_to: "2025-12-31", cny_per_unit: "1.33000000",
      }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });

    const book = await loadFxBook(
      { query } as unknown as PoolClient,
      "2025-01-01",
      "2025-12-31",
      frozenIds,
    );

    const overrideQuery = query.mock.calls.find(([sql]) => String(sql).includes("FROM fx_override"));
    expect(overrideQuery?.[0]).toContain("id=ANY($3::uuid[])");
    expect(overrideQuery?.[1]?.[2]).toEqual(frozenIds);
    expect(book.overrides).toEqual([expect.objectContaining({ id: frozenIds[0], currency: "BRL", cnyPerUnit: "1.33000000" })]);
  });

  it("scans all included slices with query count driven by fact pages, not slice count", async () => {
    const query = vi.fn(async (sql: string) => {
      void sql;
      return { rows: [], rowCount: 0 };
    });
    const slices = Array.from({ length: 40 }, (_, index) => ({
      dataset_slice_id: `slice-${index}`,
      dataset_version_id: `version-${index}`,
    }));
    const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

    const summaries = await processRunFacts(
      { query } as unknown as PoolClient,
      "run-1",
      slices,
      { official: [], marketDayStatus: () => "UNKNOWN" },
      sink,
    );

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.every(([sql]) => String(sql).includes("calculation_run_slice"))).toBe(true);
    expect(query.mock.calls.every(([sql]) => String(sql).includes("disposition IN ('INCLUDED','INCLUDED_WITH_WARNING')"))).toBe(true);
    expect(String(query.mock.calls[1]?.[0])).toContain("COALESCE(tf.fulfillment_mode,'BLANK') fulfillment_mode");
    expect(summaries).toHaveLength(40);
    expect(summaries.every(({ summary }) => Object.values(summary).every((value) => value === "0.00000000"))).toBe(true);
  });

  it("persists every slice summary with one set-based query", async () => {
    const query = vi.fn(async (sql: string) => {
      void sql;
      return { rows: [], rowCount: 40 };
    });
    const summary = {
      income: "0.00000000",
      refund: "0.00000000",
      withheldTax: "0.00000000",
      platformFee: "0.00000000",
      fbaFulfillmentFee: "0.00000000",
      advertisingFee: "0.00000000",
      fbaStorageFee: "0.00000000",
      otherDeduction: "0.00000000",
      platformBalance: "0.00000000",
    };

    await insertMonthlySummaries(
      { query } as unknown as PoolClient,
      "run-1",
      Array.from({ length: 40 }, (_, index) => ({ sliceId: `slice-${index}`, summary })),
    );

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("jsonb_to_recordset");
  });

  it("rolls a transient failure back without making the business run terminal", async () => {
    const connectionQueries: string[] = [];
    const poolQueries: string[] = [];
    const client = {
      async query(sql: string) {
        connectionQueries.push(sql);
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (sql.includes("SELECT status,input_manifest,requested_by,fee_classification_version FROM calculation_run")) {
          return { rows: [{ status: "QUEUED", input_manifest: {
            feeClassificationVersion: FEE_CLASSIFICATION_VERSION,
            feeClassificationPolicySha256: FEE_CLASSIFICATION_POLICY_SHA256,
          }, requested_by: "actor-1", fee_classification_version: FEE_CLASSIFICATION_VERSION }], rowCount: 1 };
        }
        if (sql.includes("UPDATE calculation_run SET status='RUNNING'")) return { rows: [], rowCount: 1 };
        if (sql.includes("SELECT min(fx_date)")) throw new Error("TRANSIENT_DATABASE_FAILURE");
        throw new Error(`UNEXPECTED_QUERY:${sql}`);
      },
      release: vi.fn(),
    };
    const pool = {
      connect: async () => client as unknown as PoolClient,
      async query(sql: string) { poolQueries.push(sql); return { rows: [], rowCount: 0 }; },
    } as unknown as Pool;

    await expect(calculateRun(pool, "00000000-0000-4000-8000-000000000001")).rejects.toThrow("TRANSIENT_DATABASE_FAILURE");
    expect(connectionQueries.at(-1)).toBe("ROLLBACK");
    expect(poolQueries).toEqual([]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("acquires the COPY reader before starting COPY on a borrowed lock client", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (["BEGIN", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
        if (sql.includes("SELECT status,input_manifest,requested_by,fee_classification_version FROM calculation_run")) {
          return { rows: [{ status: "QUEUED", input_manifest: {
            feeClassificationVersion: FEE_CLASSIFICATION_VERSION,
            feeClassificationPolicySha256: FEE_CLASSIFICATION_POLICY_SHA256,
          }, requested_by: "actor-1", fee_classification_version: FEE_CLASSIFICATION_VERSION }], rowCount: 1 };
        }
        if (sql.includes("SELECT min(fx_date)")) return { rows: [{ from_date: null, to_date: null }], rowCount: 1 };
        if (sql.includes("FROM calculation_run_slice")) return { rows: [], rowCount: 0 };
        if (sql.startsWith("COPY ")) throw new Error("COPY_STARTED_BEFORE_READER");
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    } as unknown as PoolClient;
    const pool = {
      connect: vi.fn(async () => { throw new Error("READER_CONNECTION_UNAVAILABLE"); }),
    } as unknown as Pool;

    await expect(calculateRun(pool, "00000000-0000-4000-8000-000000000001", client))
      .rejects.toThrow("READER_CONNECTION_UNAVAILABLE");

    expect(queries).not.toContain(expect.stringContaining("COPY calculation_stage"));
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(client.release).not.toHaveBeenCalled();
  });

  it("marks an exhausted calculation as FAILED exactly once", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void sql; void parameters;
      return { rows: [], rowCount: 1 };
    });
    await markCalculationRunFailed({ query } as unknown as Pool, "00000000-0000-4000-8000-000000000001", new Error("still broken"));
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("status='FAILED'");
  });
});
