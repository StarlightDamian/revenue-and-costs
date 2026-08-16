import { describe, expect, it } from "vitest";
import { describeImportIssue } from "../../src/modules/imports/postgres-service.js";

describe("import issue presentation", () => {
  it("explains aggregated required financial anchors in Chinese", () => {
    expect(describeImportIssue("IMPORT_FINANCIAL_VALUE_REQUIRED", 472, "total")).toEqual({
      message: "有一行没有填写计算所需的金额或数量（总金额列）",
      action: "请补充空白单元格后重新上传。这一行目前没有用于计算。 共 472 条。",
    });
    expect(JSON.stringify(describeImportIssue("IMPORT_FINANCIAL_VALUE_REQUIRED", 472, "total"))).not.toContain("total");

    expect(describeImportIssue("IMPORT_FINANCIAL_VALUE_INVALID", 1, "selling_fees").message)
      .toContain("销售佣金列");
    expect(describeImportIssue("IMPORT_FINANCIAL_VALUE_INVALID", 1, "private_internal_key").message)
      .toContain("某个金额列");
  });

  it("does not show an unknown internal code to end users", () => {
    expect(describeImportIssue("IMPORT_NEW_SAFE_CODE", 1, null)).toEqual({
      message: "系统发现一个暂时无法自动说明的问题",
      action: "这个文件暂时不会用于计算。请检查文件内容；如果仍不知道怎么处理，请联系管理员。",
    });
  });

  it("explains the single-site requirement when a marketplace still cannot be inferred", () => {
    expect(describeImportIssue("IMPORT_UNKNOWN_MARKETPLACE", 12, "marketplace").action)
      .toBe("请填写明确的 Amazon 站点名称。如果是交易报告，同一个文件内只保留一个站点，然后重新上传。这一行目前没有用于计算。 共 12 条。");
  });

  it("labels legacy capped row issues as examples instead of exact totals", () => {
    expect(describeImportIssue("IMPORT_FINANCIAL_VALUE_REQUIRED", 100, "total", false).action)
      .toContain("已记录 100 条示例");
  });

  it("explains an unknown table without mapping jargon", () => {
    const issue = describeImportIssue("AWAITING_MAPPING", 1, null);
    expect(issue.message).toContain("每一列代表什么");
    expect(`${issue.message}${issue.action}`).not.toMatch(/字段映射|未知结构|入库|诊断/u);
  });
});
