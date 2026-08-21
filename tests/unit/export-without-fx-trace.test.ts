import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { isPermanentExportFailure, PostgresExportService, safeExportFailureCode } from "../../src/modules/exports/postgres.js";
import type { ReportExportInput } from "../../src/modules/exports/report-types.js";
import type { EncryptedObjectStore } from "../../src/modules/storage/encrypted-object-store.js";

describe("export without embedded FX trace", () => {
  it("projects every workbook section from the same frozen report month range", async () => {
    const calls: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      calls.push({ sql, ...(parameters ? { parameters } : {}) });
      if (sql.includes("FROM published_snapshot s JOIN published_snapshot_integrity")) {
        return { rows: [{
          shop_name: "shop", manifest: { slices: [] }, manifest_sha256: "a".repeat(64),
          calculation_run_id: "run", published_at: new Date("2026-07-28T00:00:00Z"),
        }], rowCount: 1 };
      }
      if (sql.includes("FROM published_snapshot_slice ps JOIN dataset_slice")) {
        return { rows: [
          { period: "2026-05", month: "2026-05", marketplace: "US", currency: "USD", disposition: "INCLUDED", datasetVersionId: "version-5" },
          { period: "2026-06", month: "2026-06", marketplace: "US", currency: "USD", disposition: "INCLUDED", datasetVersionId: "version-6" },
        ], rowCount: 2 };
      }
      if (sql.includes("WITH component_amount AS")) {
        return { rows: [
          { period: "2026-05", marketplace: "US", currency: "USD", currencyCount: "1", incomeCny: "5" },
          { period: "2026-06", marketplace: "US", currency: "USD", currencyCount: "1", incomeCny: "6" },
        ], rowCount: 2 };
      }
      if (sql.includes("FROM calculation_fact_result r JOIN dataset_version") && sql.includes("r.component NOT IN")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM import_file f WHERE")) return { rows: [], rowCount: 0 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const service = new PostgresExportService(
      { query } as unknown as Pool,
      {} as EncryptedObjectStore,
      "D:/tmp/export-period-projection",
    );
    const input = await (service as unknown as {
      buildInput(
        shopId: string,
        snapshotId: string,
        preferences: { profitRate: null; minimumSalesCostRate: null; continentPrefixes: readonly string[] },
        exportId: string | undefined,
        reportPeriod: { periodStart: string; periodEnd: string },
      ): Promise<ReportExportInput>;
    }).buildInput(
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      { profitRate: null, minimumSalesCostRate: null, continentPrefixes: ["EU"] },
      undefined,
      { periodStart: "2026-05", periodEnd: "2026-06" },
    );

    const monthly = [];
    for await (const row of input.monthly.source.rows()) monthly.push(row);
    expect(input.reportPeriods).toEqual(["2026-05", "2026-06"]);
    expect(monthly.map((row) => row.period)).toEqual(["2026-05", "2026-06"]);
    const scopedCalls = calls.filter((call) => call.sql.includes("$2::date"));
    expect(scopedCalls).toHaveLength(4);
    for (const call of scopedCalls) {
      expect(call.parameters?.slice(-2)).toEqual(["2026-05-01", "2026-06-01"]);
    }
  });

  it("fails closed with a safe permanent error when included slices span natural years", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM published_snapshot s JOIN published_snapshot_integrity")) {
        return { rows: [{
          shop_name: "shop", manifest: { slices: [] }, manifest_sha256: "a".repeat(64),
          calculation_run_id: "run", published_at: new Date("2026-07-28T00:00:00Z"),
        }], rowCount: 1 };
      }
      if (sql.includes("FROM published_snapshot_slice ps JOIN dataset_slice")) {
        return { rows: [
          { period: "2025-12", month: "2025-12", marketplace: "US", currency: "USD", disposition: "INCLUDED", datasetVersionId: "version-2025" },
          { period: "2026-01", month: "2026-01", marketplace: "US", currency: "USD", disposition: "INCLUDED_WITH_WARNING", datasetVersionId: "version-2026" },
        ], rowCount: 2 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const service = new PostgresExportService(
      { query } as unknown as Pool,
      {} as EncryptedObjectStore,
      "D:/tmp/export-cross-year",
    );

    const result = (service as unknown as {
      buildInput(shopId: string, snapshotId: string): Promise<ReportExportInput>;
    }).buildInput("10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002");
    await expect(result).rejects.toThrow("EXPORT_ACCOUNTING_PERIOD_CROSS_YEAR");

    const error = new Error("EXPORT_ACCOUNTING_PERIOD_CROSS_YEAR");
    expect(safeExportFailureCode(error)).toBe("EXPORT_ACCOUNTING_PERIOD_CROSS_YEAR");
    expect(isPermanentExportFailure(error)).toBe(true);
  });

  it("builds the report input without querying per-cell FX usage", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("calculation_fx_usage")) throw new Error("FX_TRACE_QUERY_MUST_NOT_RUN");
      if (sql.includes("FROM published_snapshot s JOIN published_snapshot_integrity")) {
        return { rows: [{
          shop_name: "shop",
          manifest: { slices: [], fxSyncRunId: "fx-run" },
          manifest_sha256: "a".repeat(64),
          calculation_run_id: "run",
          published_at: new Date("2026-07-28T00:00:00Z"),
        }], rowCount: 1 };
      }
      if (sql.includes("WITH component_amount AS")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM published_snapshot_slice ps JOIN dataset_slice")) {
        return { rows: [{
          period: "2026-04", month: "2026-04", marketplace: "US", currency: "USD",
          disposition: "INCLUDED", datasetVersionId: "included-version",
        }], rowCount: 1 };
      }
      if (sql.includes("FROM calculation_fact_result r JOIN dataset_version") && sql.includes("r.component NOT IN")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM import_file f WHERE")) return { rows: [], rowCount: 0 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const service = new PostgresExportService(
      { query } as unknown as Pool,
      {} as EncryptedObjectStore,
      "D:/tmp/export-without-fx-trace",
    );
    const input = await (service as unknown as {
      buildInput(shopId: string, snapshotId: string): Promise<ReportExportInput>;
    }).buildInput("10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002");

    expect("fxTrace" in input).toBe(false);
    expect(input.fxVersion).toBe("fx-run");
    expect(queries.some((sql) => sql.includes("calculation_fx_usage"))).toBe(false);
    const rollupQueries = queries.filter((sql) => sql.includes("WITH component_amount AS"));
    expect(rollupQueries).toHaveLength(1);
    for (const sql of rollupQueries) {
      expect(sql).toContain("ds.normalized_marketplace marketplace");
      expect(sql).toContain("FROM component_amount GROUP BY period,marketplace");
      expect(sql).not.toContain("'全部' marketplace");
    }
  });

  it("omits hard-excluded slices while retaining explicitly included zero-amount slices", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM published_snapshot s JOIN published_snapshot_integrity")) {
        return { rows: [{
          shop_name: "shop", manifest: { slices: [] }, manifest_sha256: "a".repeat(64),
          calculation_run_id: "run", published_at: new Date("2026-07-28T00:00:00Z"),
        }], rowCount: 1 };
      }
      if (sql.includes("WITH component_amount AS")) {
        return { rows: [{ period: "2026-04", marketplace: "US", currency: "USD", currencyCount: "1" }], rowCount: 1 };
      }
      if (sql.includes("FROM published_snapshot_slice ps JOIN dataset_slice")) {
        return { rows: [
          { period: "2026-04", month: "2026-04", marketplace: "US", currency: "USD", disposition: "INCLUDED", datasetVersionId: "included-version" },
          { period: "2026-04", month: "2026-04", marketplace: "DE", currency: "EUR", disposition: "HARD_EXCLUDED", datasetVersionId: "excluded-version" },
        ], rowCount: 2 };
      }
      if (sql.includes("FROM calculation_fact_result r JOIN dataset_version") && sql.includes("r.component NOT IN")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM import_file f WHERE")) return { rows: [], rowCount: 0 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const service = new PostgresExportService(
      { query } as unknown as Pool,
      {} as EncryptedObjectStore,
      "D:/tmp/export-completeness",
    );
    const input = await (service as unknown as {
      buildInput(shopId: string, snapshotId: string): Promise<ReportExportInput>;
    }).buildInput("10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002");
    const monthly = [];
    for await (const row of input.monthly.source.rows()) monthly.push(row);
    expect(monthly.map((row) => `${row.marketplace}:${row.period}`)).toEqual(["US:2026-04"]);
    expect(input.reportPeriods).toEqual(["2026-04"]);
  });

  it("derives exact quarterly and annual totals from one monthly aggregate scan", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM published_snapshot s JOIN published_snapshot_integrity")) {
        return { rows: [{
          shop_name: "shop", manifest: { slices: [] }, manifest_sha256: "a".repeat(64),
          calculation_run_id: "run", published_at: new Date("2026-07-28T00:00:00Z"),
        }], rowCount: 1 };
      }
      if (sql.includes("WITH component_amount AS")) {
        return { rows: [
          {
            period: "2026-04", marketplace: "US", currency: "USD", currencyCount: "1",
            incomeOriginal: "10.1", incomeCny: "70.7", refundOriginal: "1.1", refundCny: "7.7",
          },
          {
            period: "2026-05", marketplace: "US", currency: "USD", currencyCount: "1",
            incomeOriginal: "20.2", incomeCny: "141.4", refundOriginal: "2.2", refundCny: "15.4",
          },
        ], rowCount: 2 };
      }
      if (sql.includes("FROM published_snapshot_slice ps JOIN dataset_slice")) {
        return { rows: [
          { period: "2026-04", month: "2026-04", marketplace: "US", currency: "USD", disposition: "INCLUDED", datasetVersionId: "version-1" },
          { period: "2026-05", month: "2026-05", marketplace: "US", currency: "USD", disposition: "INCLUDED", datasetVersionId: "version-2" },
        ], rowCount: 2 };
      }
      if (sql.includes("FROM calculation_fact_result r JOIN dataset_version") && sql.includes("r.component NOT IN")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM import_file f WHERE")) return { rows: [], rowCount: 0 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const service = new PostgresExportService(
      { query } as unknown as Pool,
      {} as EncryptedObjectStore,
      "D:/tmp/export-rollup",
    );
    const input = await (service as unknown as {
      buildInput(shopId: string, snapshotId: string): Promise<ReportExportInput>;
    }).buildInput("10000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002");
    const quarterly = [];
    const annual = [];
    for await (const row of input.quarterly.source.rows()) quarterly.push(row);
    for await (const row of input.annual.source.rows()) annual.push(row);

    expect(quarterly).toHaveLength(1);
    expect(annual).toHaveLength(1);
    for (const row of [quarterly[0], annual[0]]) {
      expect(row).toMatchObject({
        incomeOriginal: "30.30000000", incomeCny: "212.10000000",
        refundOriginal: "3.30000000", refundCny: "23.10000000",
        netOriginal: "27.00000000", netCny: "189.00000000",
        expenseOriginal: "0.00000000", expenseCny: "0.00000000",
        profitOriginal: "27.00000000", profitCny: "189.00000000",
        platformFeeRate: "0.00000000", profitRate: "1.00000000",
      });
    }
  });
});
