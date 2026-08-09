import { describe, expect, it } from "vitest";
import { normalizeFxConversions, normalizeFxHistory, normalizeFxStatus, normalizeUploadCompletion } from "../../src/web/api/financial-contracts";

describe("financial API contract adapters", () => {
  it("maps the PostgreSQL FX service response into the view contract", () => {
    expect(normalizeFxStatus({ status: "SUCCEEDED", syncEnabled: true, quoteCount: 550, coverageFrom: "2026-01-01", coverageTo: "2026-07-28", lastSucceededAt: "2026-07-28T02:00:00.000Z" })).toEqual({
      source: "ChinaMoney", syncEnabled: true, quoteCount: 550, coverageStart: "2026-01-01", coverageEnd: "2026-07-28", lastSucceededAt: "2026-07-28T02:00:00.000Z", taskStatus: "SUCCEEDED", gaps: [],
    });
    expect(normalizeFxHistory({ rows: [{ id: "quote-1", validDate: "2026-07-28", currency: "USD", cnyPerUnit: "7.16880000", officialPair: "USD/CNY", officialRate: "7.16880000" }] })).toEqual([
      { date: "2026-07-28", currency: "USD", cnyPerUnit: "7.16880000", officialPair: "USD/CNY", officialRate: "7.16880000", quoteId: "quote-1", source: "OFFICIAL" },
    ]);
  });

  it("keeps batch order and maps service statuses without touching decimal strings", () => {
    expect(normalizeFxConversions({ rows: [
      { input: "2026-07-28", requestedDate: "2026-07-28", hitDate: "2026-07-25", fromCurrency: "USD", toCurrency: "CNY", rate: "7.16880000", fallbackDays: "3", status: "OK", quoteIds: ["q1"], overrideIds: [] },
      { input: "bad", requestedDate: "bad", fromCurrency: "USD", toCurrency: "CNY", status: "INVALID_DATE", quoteIds: [], overrideIds: [], reason: "日期无效" },
    ] })).toEqual([
      { input: "2026-07-28", inputDate: "2026-07-28", quoteDate: "2026-07-25", from: "USD", to: "CNY", rate: "7.16880000", fallbackDays: 3, status: "OK" },
      { input: "bad", inputDate: "bad", from: "USD", to: "CNY", status: "INVALID_DATE", reason: "日期无效" },
    ]);
  });

  it("uses the import batch id returned after upload completion", () => {
    expect(normalizeUploadCompletion({ id: "import-batch-1", status: "ANALYZING" })).toEqual({ id: "import-batch-1", status: "ANALYZING" });
  });

  it("fails visibly for malformed finance responses", () => {
    expect(() => normalizeFxHistory([])).toThrow("历史汇率接口返回格式无效");
    expect(() => normalizeUploadCompletion({ status: "ANALYZING" })).toThrow("上传完成接口返回格式无效");
  });
});
