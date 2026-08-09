import { Writable } from "node:stream";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  calculateRun,
  insertMonthlySummaries,
  markCalculationRunFailed,
  processRunFacts,
} from "../../src/modules/calculation/postgres-runner";

describe("calculation retry lifecycle", () => {
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

  it("fails closed when a legacy transaction fact has no fulfillment mode", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM shipment_fact")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM transaction_fact")) return { rows: [{
        slice_id: "slice-1", fact_id: "1", dataset_version_id: "version-1", source_file_id: "file-1",
        row_number: "1", row_hash: "hash", normalized_marketplace: "US", local_month: "2026-08-01",
        currency: "USD", fx_date: "2026-08-01", normalized_type: "ORDER", normalized_description: "",
        fulfillment_mode: null,
        product_sales: "0", product_sales_tax: "0", shipping_credits: "0", shipping_credits_tax: "0",
        gift_wrap_credits: "0", gift_wrap_credits_tax: "0", regulatory_fee: "0", tax_on_regulatory_fee: "0",
        promotional_rebates: "0", promotional_rebates_tax: "0", marketplace_withheld_tax: "0",
        selling_fees: "0", fba_fees: "0", other_transaction_fees: "0", other_amount: "0",
      }], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const sink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

    await expect(processRunFacts(
      { query } as unknown as PoolClient,
      "run-1",
      [{ dataset_slice_id: "slice-1", dataset_version_id: "version-1" }],
      { official: [], marketDayStatus: () => "UNKNOWN" },
      sink,
    )).rejects.toThrow("TRANSACTION_FULFILLMENT_REIMPORT_REQUIRED:1");
  });

  it("rolls a transient failure back without making the business run terminal", async () => {
    const connectionQueries: string[] = [];
    const poolQueries: string[] = [];
    const client = {
      async query(sql: string) {
        connectionQueries.push(sql);
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
        if (sql.includes("SELECT status,input_manifest,requested_by FROM calculation_run")) {
          return { rows: [{ status: "QUEUED", input_manifest: {}, requested_by: "actor-1" }], rowCount: 1 };
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
