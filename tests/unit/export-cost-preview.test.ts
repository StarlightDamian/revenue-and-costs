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
