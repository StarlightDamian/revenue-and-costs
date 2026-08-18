import { describe, expect, it, vi } from "vitest";
import type { ReportFilter } from "../../src/modules/publishing/publish.js";
import { PostgresReportService } from "../../src/modules/publishing/postgres-service.js";
import type { SqlClient } from "../../src/modules/authorization/index.js";

describe("report filtering", () => {
  function exportContextReports(rows: Array<{ requested_date: string; currency: string; cny_rate: string | null; invalid: boolean }>) {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT cr.id,cr.status,s.name shop_name")) {
        return { rows: [{ id: "run-1", status: "READY", shop_name: "做账公司" }] };
      }
      if (sql.includes("WITH selected_conversion")) return { rows };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    return {
      query,
      reports: new PostgresReportService({ transaction: vi.fn() } as never, { query } as unknown as SqlClient),
    };
  }

  it("allows transaction export when a zero-contribution date and currency has no fact-level FX usage", async () => {
    const { reports } = exportContextReports([
      { requested_date: "2026-08-01", currency: "USD", cny_rate: null, invalid: false },
    ]);

    await expect(reports.getIntermediateExportContext("shop-1", "TRANSACTION")).resolves.toMatchObject({
      calculationRunId: "run-1",
      shopName: "做账公司",
      frozenRates: new Map(),
    });
  });

  it("rejects export until the latest calculation run is ready", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT cr.id,cr.status,s.name shop_name")) {
        return { rows: [{ id: "run-1", status: "RUNNING", shop_name: "做账公司" }] };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const reports = new PostgresReportService(
      { transaction: vi.fn() } as never,
      { query } as unknown as SqlClient,
    );

    await expect(reports.getIntermediateExportContext("shop-1", "TRANSACTION")).rejects.toThrow("INTERMEDIATE_FX_NOT_FIXED");
    expect(query).toHaveBeenCalledOnce();
  });

  it.each([
    ["TRANSACTION", null],
    ["SHIPMENT", null],
  ] as const)("rejects %s export when the selected conversion is invalid", async (kind, cnyRate) => {
    const { reports } = exportContextReports([
      { requested_date: "2026-08-01", currency: "USD", cny_rate: cnyRate, invalid: true },
    ]);

    await expect(reports.getIntermediateExportContext("shop-1", kind)).rejects.toThrow("INTERMEDIATE_FX_NOT_FIXED");
  });

  it("requires a shipment rate only when its rounded eight-field row total is nonzero", async () => {
    const { query, reports } = exportContextReports([
      { requested_date: "2026-08-01", currency: "USD", cny_rate: null, invalid: false },
    ]);

    await expect(reports.getIntermediateExportContext("shop-1", "SHIPMENT")).resolves.toMatchObject({ frozenRates: new Map() });
    const sql = query.mock.calls.find(([statement]) => statement.includes("WITH selected_conversion"))?.[0] ?? "";
    expect(sql).toContain("bool_or(round(sf.product_price,2)");
    expect(sql).toContain("round(sf.shipment_promotion_discount,2)<>0)");
    expect(sql).toContain("LEFT JOIN calculation_fx_usage");
    expect(sql).toContain("bool_or(u.id IS NULL) missing_usage");
  });

  it("loads intermediate FX rates without constructing a PostgreSQL text value containing NUL", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT cr.id,cr.status,s.name shop_name")) {
        return { rows: [{ id: "run-1", status: "READY", shop_name: "做账公司" }] };
      }
      if (sql.includes("FROM transaction_fact tf")) {
        return {
          rows: [{
            id: "1",
            marketplace: "US",
            localDate: "2026-08-01",
            fxDate: "2026-08-01",
            type: "Order",
            description: "Principal",
            orderId: "order-1",
            sku: "sku-1",
            currency: "USD",
            quantity: "1",
            productSales: "10",
          }],
        };
      }
      if (sql.includes("FROM calculation_fact_result")) {
        if (sql.includes("E'\\0'")) {
          throw Object.assign(new Error("invalid byte sequence for encoding UTF8: 0x00"), { code: "22021" });
        }
        return { rows: [{ requested_date: "2026-08-01", currency: "USD", cny_rate: "7.12345678" }] };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const database = { query } as unknown as SqlClient;
    const reports = new PostgresReportService({ transaction: vi.fn() } as never, database);

    const result = await reports.getIntermediate(
      "20000000-0000-4000-8000-000000000002",
      "TRANSACTION",
      100,
    );

    expect(result.items).toEqual([
      expect.objectContaining({ id: "1", currency: "USD", cnyRate: "7.12345678" }),
    ]);
  });

  it("applies date and marketplace filters to financial queries and visible slices", async () => {
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      void values;
      if (sql.includes("FROM calculation_run r")) {
        return {
          rows: [{
            id: "30000000-0000-4000-8000-000000000003",
            status: "READY",
            created_at: new Date("2026-07-28T00:00:00.000Z"),
            finished_at: new Date("2026-07-28T00:01:00.000Z"),
            input_manifest: {},
            published_at: null,
            snapshot_id: null,
          }],
        };
      }
      if (sql.includes("FILTER (WHERE r.component")) {
        return {
          rows: [{
            income: "100.00000000",
            refund: "10.00000000",
            withheld_tax: "5.00000000",
            platform_fee: "4.00000000",
            fba_fulfillment_fee: "3.00000000",
            advertising_fee: "2.00000000",
            fba_storage_fee: "1.00000000",
            other_deduction: "0.00000000",
            platform_balance: "75.00000000",
          }],
        };
      }
      if (sql.includes("FROM calculation_run_slice")) {
        return {
          rows: [
            {
              slice_id: "40000000-0000-4000-8000-000000000004",
              dataset_version_id: "50000000-0000-4000-8000-000000000005",
              disposition: "INCLUDED",
              normalized_marketplace: "amazon.com",
              local_month: "2026-05",
              shipment_quantity: "10",
              transaction_quantity: "10",
              unmatched_absolute: "0",
              unmatched_ratio: "0",
              hard_reason_codes: [],
              warning: false,
            },
            {
              slice_id: "40000000-0000-4000-8000-000000000006",
              dataset_version_id: "50000000-0000-4000-8000-000000000007",
              disposition: "INCLUDED",
              normalized_marketplace: "amazon.co.jp",
              local_month: "2026-06",
              shipment_quantity: "20",
              transaction_quantity: "20",
              unmatched_absolute: "0",
              unmatched_ratio: "0",
              hard_reason_codes: [],
              warning: false,
            },
          ],
        };
      }
      if (sql.includes("GROUP BY r.component")) return { rows: [] };
      if (sql.includes("u.fallback_days>0")) return { rows: [{ count: "0" }] };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const database = { query } as unknown as SqlClient;
    const reports = new PostgresReportService({ transaction: vi.fn() } as never, database);
    const filter = {
      start: "2026-05-15",
      end: "2026-05-31",
      marketplace: "amazon.com",
    };

    const result = await (reports as unknown as {
      getPreview(shopId: string, reportFilter: ReportFilter): Promise<{
        completeness: Array<{ marketplace: string; month: string }>;
        metrics: Array<{ key: string; amountCny: string }>;
        notices: string[];
        canPublish: boolean;
        publishSlices?: Array<{ sliceId: string }>;
      }>;
    }).getPreview("20000000-0000-4000-8000-000000000002", filter);

    expect(result.completeness).toEqual([
      expect.objectContaining({ marketplace: "amazon.com", month: "2026-05" }),
    ]);
    expect(result.metrics.find((metric) => metric.key === "balance")?.amountCny).toBe("75.00000000");
    expect(result.notices).toContain("当前只显示筛选后的部分结果，不能直接发布。请清除筛选后再发布完整结果。");
    expect(result.canPublish).toBe(false);
    expect(result.publishSlices).toBeUndefined();
    const financialCall = query.mock.calls.find(([sql]) => sql.includes("FILTER (WHERE r.component"));
    const feeCall = query.mock.calls.find(([sql]) => sql.includes("GROUP BY r.component"));
    const fallbackCall = query.mock.calls.find(([sql]) => sql.includes("u.fallback_days>0"));
    expect(financialCall?.[1]).toEqual([
      "30000000-0000-4000-8000-000000000003",
      "2026-05-15",
      "2026-05-31",
      "amazon.com",
    ]);
    expect(feeCall?.[1]).toEqual(financialCall?.[1]);
    expect(fallbackCall?.[1]).toEqual(financialCall?.[1]);
  });

  it("returns the full publish manifest only for an unfiltered unpublished publishable draft", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT published_snapshot_id FROM shop_current_published_snapshot")) {
        return { rows: [{ published_snapshot_id: "60000000-0000-4000-8000-000000000006" }] };
      }
      if (sql.includes("FROM published_snapshot s JOIN calculation_run r")) {
        return { rows: [{
          id: "30000000-0000-4000-8000-000000000003",
          status: "READY",
          created_at: new Date("2026-07-28T00:00:00.000Z"),
          finished_at: new Date("2026-07-28T00:01:00.000Z"),
          input_manifest: {},
          published_at: new Date("2026-07-28T00:02:00.000Z"),
          snapshot_id: "60000000-0000-4000-8000-000000000006",
        }] };
      }
      if (sql.includes("FROM calculation_run r")) {
        return { rows: [{
          id: "30000000-0000-4000-8000-000000000003",
          status: "READY",
          created_at: new Date("2026-07-28T00:00:00.000Z"),
          finished_at: new Date("2026-07-28T00:01:00.000Z"),
          input_manifest: {},
          published_at: null,
          snapshot_id: null,
        }] };
      }
      if (sql.includes("FILTER (WHERE r.component")) return { rows: [{}] };
      if (sql.includes("FROM calculation_run_slice")) {
        return { rows: [
          {
            slice_id: "40000000-0000-4000-8000-000000000004",
            dataset_version_id: "50000000-0000-4000-8000-000000000005",
            disposition: "INCLUDED",
            normalized_marketplace: "US",
            local_month: "2026-05",
            shipment_quantity: "10",
            transaction_quantity: "10",
            unmatched_absolute: "0",
            unmatched_ratio: "0",
            hard_reason_codes: [],
            warning: false,
          },
          {
            slice_id: "40000000-0000-4000-8000-000000000006",
            dataset_version_id: "50000000-0000-4000-8000-000000000007",
            disposition: "OUT_OF_SCOPE",
            normalized_marketplace: "CA",
            local_month: "2025-06",
            shipment_quantity: null,
            transaction_quantity: null,
            unmatched_absolute: null,
            unmatched_ratio: null,
            hard_reason_codes: [],
            warning: true,
          },
        ] };
      }
      if (sql.includes("GROUP BY r.component")) return { rows: [] };
      if (sql.includes("u.fallback_days>0")) return { rows: [{ count: "0" }] };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const reports = new PostgresReportService(
      { transaction: vi.fn() } as never,
      { query } as unknown as SqlClient,
    );
    type View = { canPublish: boolean; publishSlices?: Array<{ sliceId: string; disposition: string }> };

    const draft = await reports.getPreview("20000000-0000-4000-8000-000000000002") as View;
    const published = await reports.getCurrent("20000000-0000-4000-8000-000000000002") as View;

    expect(draft.canPublish).toBe(true);
    expect(draft.publishSlices).toEqual([
      expect.objectContaining({ sliceId: "40000000-0000-4000-8000-000000000004", disposition: "INCLUDED" }),
      expect.objectContaining({ sliceId: "40000000-0000-4000-8000-000000000006", disposition: "OUT_OF_SCOPE" }),
    ]);
    expect(published.canPublish).toBe(false);
    expect(published.publishSlices).toBeUndefined();
  });
});
