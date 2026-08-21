import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/modules/authorization/index.js";
import { PostgresExportService } from "../../src/modules/exports/postgres.js";

const actor: Actor = {
  accountId: "account-1",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
  enterpriseIds: new Set(["enterprise-1"]),
};

describe("cost accounting export preview", () => {
  it("uses the frozen snapshot monthly facts and the same minimum-rate calculation as the workbook", async () => {
    const query = vi.fn(async (sql: string, _parameters?: readonly unknown[]) => {
      void _parameters;
      if (sql.includes("FROM shop s LEFT JOIN shop_membership")) {
        return { rows: [{
          id: "shop-1",
          enterprise_id: "enterprise-1",
          status: "ACTIVE",
          membership_id: null,
          membership_status: null,
          export_allowed: null,
          authorization_epoch: null,
        }], rowCount: 1 };
      }
      if (sql.includes("FROM account")) {
        return { rows: [{
          profit_rate: "0.10000000",
          minimum_sales_cost_rate: "0.15000000",
          continent_prefixes: ["EU"],
        }], rowCount: 1 };
      }
      if (sql.includes("FROM shop_current_published_snapshot current")) {
        return { rows: [{
          published_snapshot_id: "snapshot-1",
          calculation_run_id: "run-1",
          year: "2026",
          yearCount: "1",
        }], rowCount: 1 };
      }
      if (sql.includes("WITH component_amount AS")) {
        return { rows: [
          { period: "2026-04", incomeCny: "600", netCny: "540", expenseCny: "420", currencyCount: "1" },
          { period: "2026-04", incomeCny: "400", netCny: "360", expenseCny: "280", currencyCount: "1" },
        ], rowCount: 2 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const service = new PostgresExportService(
      { query } as unknown as Pool,
      {} as never,
      "D:/tmp/exports",
    );

    const preview = await service.previewCostAccounting(actor, "shop-1");

    expect(preview).toMatchObject({
      snapshotId: "snapshot-1",
      year: "2026",
      assumptions: { profitRate: "0.10000000", minimumSalesCostRate: "0.15000000", continentPrefixes: ["EU"] },
      total: {
        incomeTotalCny: "1000.00000000",
        netIncomeCny: "900.00000000",
        platformExpensesCny: "700.00000000",
        targetProfitCny: "90.00000000",
        profitCny: "50.00000000",
        procurementCny: "150.00000000",
        salesCostRate: "0.15000000",
        minimumAdjusted: true,
      },
    });
    expect(preview.rows).toHaveLength(12);
    expect(preview.rows[3]).toMatchObject({
      period: "2026-04",
      procurementCny: "150.00000000",
      profitCny: "50.00000000",
      minimumAdjusted: true,
    });
    const pointerSql = String(query.mock.calls.find(([sql]) => sql.includes("FROM shop_current_published_snapshot current"))?.[0]);
    expect(pointerSql).toContain("published_slice.disposition IN ('INCLUDED','INCLUDED_WITH_WARNING')");
    expect(pointerSql).toContain("count(DISTINCT date_trunc('year',slice.local_month))");
  });

  it("limits the preview query and visible rows to the selected report months", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (sql.includes("FROM shop s LEFT JOIN shop_membership")) {
        return { rows: [{
          id: "shop-1", enterprise_id: "enterprise-1", status: "ACTIVE",
          membership_id: null, membership_status: null, export_allowed: null, authorization_epoch: null,
        }], rowCount: 1 };
      }
      if (sql.includes("FROM account")) {
        return { rows: [{ profit_rate: null, minimum_sales_cost_rate: null, continent_prefixes: ["EU"] }], rowCount: 1 };
      }
      if (sql.includes("FROM shop_current_published_snapshot current")) {
        return { rows: [{ published_snapshot_id: "snapshot-1", calculation_run_id: "run-1", year: "2026", yearCount: "1" }], rowCount: 1 };
      }
      if (sql.includes("WITH component_amount AS")) {
        return { rows: [
          { period: "2026-04", incomeCny: "600", netCny: "540", expenseCny: "120", currencyCount: "1" },
          { period: "2026-05", incomeCny: "400", netCny: "360", expenseCny: "80", currencyCount: "1" },
        ], rowCount: 2 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const service = new PostgresExportService(
      { query } as unknown as Pool,
      {} as never,
      "D:/tmp/exports",
    );

    const preview = await service.previewCostAccounting(
      actor,
      "shop-1",
      {},
      { periodStart: "2026-04", periodEnd: "2026-05" },
    );

    expect(preview).toMatchObject({ periodStart: "2026-04", periodEnd: "2026-05" });
    expect(preview.rows.map((row) => row.period)).toEqual(["2026-04", "2026-05"]);
    const scopedCalls = query.mock.calls.filter(([sql]) => String(sql).includes("$2::date"));
    expect(scopedCalls).toHaveLength(2);
    for (const call of scopedCalls) expect(call[1]).toEqual([expect.any(String), "2026-04-01", "2026-05-01"]);
  });

  it("fails closed when the included snapshot scope spans multiple natural years", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM shop s LEFT JOIN shop_membership")) {
        return { rows: [{
          id: "shop-1",
          enterprise_id: "enterprise-1",
          status: "ACTIVE",
          membership_id: null,
          membership_status: null,
          export_allowed: null,
          authorization_epoch: null,
        }], rowCount: 1 };
      }
      if (sql.includes("FROM account")) {
        return { rows: [{
          profit_rate: null,
          minimum_sales_cost_rate: null,
          continent_prefixes: ["EU"],
        }], rowCount: 1 };
      }
      if (sql.includes("FROM shop_current_published_snapshot current")) {
        return { rows: [{
          published_snapshot_id: "snapshot-1",
          calculation_run_id: "run-1",
          year: "2025",
          yearCount: "2",
        }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const service = new PostgresExportService(
      { query } as unknown as Pool,
      {} as never,
      "D:/tmp/exports",
    );

    await expect(service.previewCostAccounting(actor, "shop-1")).rejects.toMatchObject({
      code: "EXPORT_ACCOUNTING_PERIOD_CROSS_YEAR",
      statusCode: 409,
    });
    expect(query.mock.calls.some(([sql]) => sql.includes("WITH component_amount AS"))).toBe(false);
  });

  it("keeps invalid stored defaults behind the export API's stable validation error", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM shop s LEFT JOIN shop_membership")) {
        return { rows: [{
          id: "shop-1",
          enterprise_id: "enterprise-1",
          status: "ACTIVE",
          membership_id: null,
          membership_status: null,
          export_allowed: null,
          authorization_epoch: null,
        }], rowCount: 1 };
      }
      if (sql.includes("FROM account")) {
        return { rows: [{
          profit_rate: "1.00000001",
          minimum_sales_cost_rate: null,
          continent_prefixes: ["EU"],
        }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const service = new PostgresExportService(
      { query } as unknown as Pool,
      {} as never,
      "D:/tmp/exports",
    );

    await expect(service.previewCostAccounting(actor, "shop-1")).rejects.toMatchObject({
      code: "INVALID_ACCOUNTING_RATE",
      statusCode: 400,
    });
  });
});
