import { describe, expect, it } from "vitest";
import { projectCommitCoverage } from "../../src/web/imports/commit-coverage.js";

describe("资料准备站点月份投影", () => {
  it("只保留缺失切片，并分别显示缺少的一类或两类报告", () => {
    expect(projectCommitCoverage([
      { marketplace: "US", month: "2025-10", state: "COMPLETE", missingReports: [] },
      { marketplace: "BE", month: "2025-10", state: "MISSING_TRANSACTION", missingReports: ["TRANSACTION"] },
      { marketplace: "AE", month: "2025-11", state: "MISSING_SHIPMENT", missingReports: ["SHIPMENT"] },
      { marketplace: "SA", month: "2025-09", state: "MISSING_SHIPMENT", missingReports: ["TRANSACTION", "SHIPMENT"] },
    ])).toEqual([
      expect.objectContaining({ marketplace: "SA", month: "2025-09", missingContent: "交易报告、配送货件" }),
      expect.objectContaining({ marketplace: "BE", month: "2025-10", missingContent: "交易报告" }),
      expect.objectContaining({ marketplace: "AE", month: "2025-11", missingContent: "配送货件" }),
    ]);
  });

  it("两类报告均齐全时返回空列表", () => {
    expect(projectCommitCoverage([
      { marketplace: "US", month: "2025-10", state: "COMPLETE", missingReports: [] },
    ])).toEqual([]);
  });
});
