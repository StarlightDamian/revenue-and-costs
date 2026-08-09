import { describe, expect, it } from "vitest";
import { describeImportIssue } from "../../src/modules/imports/postgres-service.js";

describe("import issue presentation", () => {
  it("explains aggregated required financial anchors in Chinese", () => {
    expect(describeImportIssue("IMPORT_FINANCIAL_VALUE_REQUIRED", 472, "total")).toEqual({
      message: "必需金额为空（字段：total），相关行已过滤",
      action: "请补充该行的总金额或必需数量后重新上传。 共 472 条。",
    });
  });

  it("keeps unknown stable codes diagnosable without rendering row-level noise", () => {
    expect(describeImportIssue("IMPORT_NEW_SAFE_CODE", 1, null)).toEqual({
      message: "检测到 IMPORT_NEW_SAFE_CODE",
      action: "请根据问题代码检查源文件。",
    });
  });

  it("explains the single-site requirement when a marketplace still cannot be inferred", () => {
    expect(describeImportIssue("IMPORT_UNKNOWN_MARKETPLACE", 12, "marketplace").action)
      .toBe("请补充可识别的 Amazon 销售渠道；交易报告还需确保同一文件只有一个可识别站点。 共 12 条。");
  });

  it("labels legacy capped row issues as diagnostic samples instead of exact totals", () => {
    expect(describeImportIssue("IMPORT_FINANCIAL_VALUE_REQUIRED", 100, "total", false).action)
      .toContain("已记录 100 条诊断样例");
  });
});
