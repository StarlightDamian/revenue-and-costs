import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { reportRoutes } from "../../src/api/routes/reports.js";
import type { Actor } from "../../src/modules/authorization/index.js";
import ExcelJS from "exceljs";

const actor: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
};
const shopId = "20000000-0000-4000-8000-000000000002";

describe("intermediate report HTTP contract", () => {
  it("separates transaction and shipment queries behind draft-result authorization", async () => {
    const authorize = vi.fn(async () => undefined);
    const getIntermediate = vi.fn(async (_shopId: string, kind: string) => ({
      items: [{ id: "1", marketplace: "BE", type: kind }],
    }));
    const app = Fastify();
    await app.register(reportRoutes, {
      services: { getIntermediate } as never,
      authenticate: async () => actor,
      authorize,
      auditAdminAccess: async () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reports/shops/${shopId}/intermediate?kind=TRANSACTION&limit=25&after=10`,
    });

    expect(response.statusCode).toBe(200);
    expect(authorize).toHaveBeenCalledWith(actor, shopId, "DRAFT_RESULT_READ");
    expect(getIntermediate).toHaveBeenCalledWith(shopId, "TRANSACTION", 25, "10", {});
    expect(response.json()).toMatchObject({ items: [{ marketplace: "BE", type: "TRANSACTION" }] });
    await app.close();
  });

  it("normalizes multi-select filters, keeps inclusive dates, and rejects reversed ranges", async () => {
    const getIntermediateSummary = vi.fn(async () => ({ matchedRows: "0" }));
    const app = Fastify();
    await app.register(reportRoutes, {
      services: { getIntermediateSummary } as never,
      authenticate: async () => actor,
      authorize: async () => undefined,
      auditAdminAccess: async () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reports/shops/${shopId}/intermediate/summary?kind=SHIPMENT&marketplaces=be%2Cus%2CBE&currencies=eur%2Cusd&start=2026-04-01&end=2026-04-30`,
    });
    expect(response.statusCode).toBe(200);
    expect(getIntermediateSummary).toHaveBeenCalledWith(shopId, "SHIPMENT", {
      marketplaces: ["BE", "US"], currencies: ["EUR", "USD"], start: "2026-04-01", end: "2026-04-30",
    });

    const invalid = await app.inject({
      method: "GET",
      url: `/api/v1/reports/shops/${shopId}/intermediate/summary?kind=TRANSACTION&start=2026-05-01&end=2026-04-30`,
    });
    expect(invalid.statusCode).toBe(400);
    expect(getIntermediateSummary).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it.each([
    ["TRANSACTION", "交易报告"],
    ["SHIPMENT", "配送货件"],
  ] as const)("streams a Chinese-header %s XLSX named after the accounting company", async (kind, label) => {
    const authorize = vi.fn(async () => undefined);
    const getIntermediate = vi.fn()
      .mockResolvedValueOnce({
        items: [{ id: "1", marketplace: "BE", localDate: "2026-04-01", type: "Order", description: "=SUM(A1:A2)", cnyRate: "7.12345678" }],
        nextCursor: "1",
      })
      .mockResolvedValueOnce({ items: [] });
    const frozenRates = new Map([["2026-04-01\0EUR", "7.12345678"]]);
    const release = vi.fn(async () => undefined);
    const app = Fastify();
    await app.register(reportRoutes, {
      services: {
        getIntermediate,
        getIntermediateSummary: async () => ({ matchedRows: "1" }),
        getIntermediateExportContext: async () => ({ shopName: "做账公司", calculationRunId: "run-fixed", frozenRates }),
      } as never,
      acquireIntermediateExport: async () => ({ release }),
      authenticate: async () => actor,
      authorize,
      auditAdminAccess: async () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reports/shops/${shopId}/intermediate/export?kind=${kind}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers["content-disposition"]).toContain(encodeURIComponent(`${label}-做账公司.xlsx`));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(response.rawPayload as never);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.name).toBe(`${label}-做账公司`);
    if (kind === "TRANSACTION") {
      expect(sheet.getCell("E1").value).toBe("交易说明");
      expect(sheet.getCell("E2").value).toBe("'=SUM(A1:A2)");
      expect(sheet.getCell("Y2").formula).toBe('ROUND(VALUE("7.12345678"),8)');
    }
    expect(getIntermediate).toHaveBeenNthCalledWith(1, shopId, kind, 200, undefined, {}, "run-fixed", frozenRates);
    expect(getIntermediate).toHaveBeenNthCalledWith(2, shopId, kind, 200, "1", {}, "run-fixed", frozenRates);
    expect(release).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("rejects oversized intermediate exports before workbook generation and releases capacity", async () => {
    const release = vi.fn(async () => undefined);
    const getIntermediate = vi.fn();
    const app = Fastify();
    await app.register(reportRoutes, {
      services: {
        getIntermediate,
        getIntermediateSummary: async () => ({ matchedRows: "100001" }),
        getIntermediateExportContext: vi.fn(),
      } as never,
      acquireIntermediateExport: async () => ({ release }),
      authenticate: async () => actor,
      authorize: async () => undefined,
      auditAdminAccess: async () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/reports/shops/${shopId}/intermediate/export?kind=TRANSACTION`,
    });

    expect(response.statusCode).toBe(413);
    expect(getIntermediate).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
