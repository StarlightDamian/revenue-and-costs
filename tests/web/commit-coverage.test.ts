import { describe, expect, it } from "vitest";
import { projectCommitCoverage } from "../../src/web/imports/commit-coverage.js";

describe("资料准备站点月份投影", () => {
  it("只保留缺失切片，按站点和月份排列，并分别显示缺少的一类或两类报告", () => {
    expect(projectCommitCoverage([
      { marketplace: "US", month: "2025-10", state: "COMPLETE", missingReports: [] },
      { marketplace: "BE", month: "2025-10", state: "MISSING_TRANSACTION", missingReports: ["TRANSACTION"] },
      { marketplace: "AE", month: "2025-11", state: "MISSING_SHIPMENT", missingReports: ["SHIPMENT"] },
      { marketplace: "SA", month: "2025-09", state: "MISSING_SHIPMENT", missingReports: ["TRANSACTION", "SHIPMENT"] },
      { marketplace: "AE", month: "2025-08", state: "MISSING_TRANSACTION", missingReports: ["TRANSACTION"] },
      { marketplace: "BE", month: "2025-09", state: "MISSING_SHIPMENT", missingReports: ["SHIPMENT"] },
    ])).toEqual([
      expect.objectContaining({ marketplace: "AE", month: "2025-08", missingContent: "交易报告" }),
      expect.objectContaining({ marketplace: "AE", month: "2025-11", missingContent: "配送货件" }),
      expect.objectContaining({ marketplace: "BE", month: "2025-09", missingContent: "配送货件" }),
      expect.objectContaining({ marketplace: "BE", month: "2025-10", missingContent: "交易报告" }),
      expect.objectContaining({ marketplace: "SA", month: "2025-09", missingContent: "交易报告、配送货件" }),
    ]);
  });

  it("两类报告均齐全时返回空列表", () => {
    expect(projectCommitCoverage([
      { marketplace: "US", month: "2025-10", state: "COMPLETE", missingReports: [] },
    ])).toEqual([]);
  });

  it("结果页持续披露已排除、已带提醒纳入和待确认的项目，不显示内部代码", () => {
    const rows = projectCommitCoverage([
      { marketplace: "US", month: "2025-10", state: "COMPLETE", missingReports: [] },
      { marketplace: "BE", month: "2025-10", state: "EXCLUDED", note: "HARD_INCOMPLETE" },
      { marketplace: "AE", month: "2025-11", state: "PUBLISHED_WARNING", note: "SOFT_RECONCILIATION_WARNING" },
      { marketplace: "SA", month: "2025-09", state: "CONFLICT", note: "SOFT_RECONCILIATION_WARNING" },
    ], { includeNonMissing: true });

    expect(rows).toEqual([
      expect.objectContaining({
        marketplace: "AE",
        summary: "两份资料的数量不一致",
        explanation: "这部分资料已计入结果，但两份资料的数量不一致，请继续核对。",
      }),
      expect.objectContaining({
        marketplace: "BE",
        summary: "资料不完整，已确认不计算",
        explanation: "这部分资料没有计入本次结果。补齐资料后，可以重新上传并计算。",
      }),
      expect.objectContaining({
        marketplace: "SA",
        summary: "两份资料的数量不一致",
        explanation: "这部分资料暂时不能发布。请先核对两份资料的数量，确认后再继续。",
      }),
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/HARD_INCOMPLETE|SOFT_RECONCILIATION_WARNING/u);
  });
});
