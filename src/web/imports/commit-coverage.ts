import type { CompletenessSlice } from "../api/types";

type MissingReport = "TRANSACTION" | "SHIPMENT";

export interface CommitCoverageRow extends CompletenessSlice {
  missingReports: MissingReport[];
  missingContent: string;
  summary: string;
  explanation: string;
}

interface CommitCoverageOptions {
  includeNonMissing?: boolean;
}

function missingReportsFor(slice: CompletenessSlice): MissingReport[] {
  if (slice.missingReports) return [...slice.missingReports];
  if (slice.state === "MISSING_TRANSACTION") return ["TRANSACTION"];
  if (slice.state === "MISSING_SHIPMENT") return ["SHIPMENT"];
  return [];
}

function disclosureFor(slice: CompletenessSlice, missingContent: string): Pick<CommitCoverageRow, "summary" | "explanation"> {
  if (missingContent) return {
    summary: `缺少${missingContent}`,
    explanation: "资料不齐全，不能把缺少的部分当作 0 计算。请补充资料，或确认不计算这部分。",
  };
  if (slice.state === "EXCLUDED") return {
    summary: "资料不完整，已确认不计算",
    explanation: "这部分资料没有计入本次结果。补齐资料后，可以重新上传并计算。",
  };
  if (slice.state === "PUBLISHED_WARNING") return {
    summary: "两份资料的数量不一致",
    explanation: "这部分资料已计入结果，但两份资料的数量不一致，请继续核对。",
  };
  if (slice.state === "CONFLICT") return {
    summary: "两份资料的数量不一致",
    explanation: "这部分资料暂时不能发布。请先核对两份资料的数量，确认后再继续。",
  };
  if (slice.state === "MISSING_FX") return {
    summary: "缺少计算人民币金额所需的汇率",
    explanation: "暂时无法换算人民币金额，补齐汇率后才能继续。",
  };
  if (slice.state === "AWAITING_MAPPING") return {
    summary: "还不知道表格每列代表什么",
    explanation: "请联系管理员确认表格内容，然后重新处理。",
  };
  return {
    summary: "当前资料需要重新确认",
    explanation: "请刷新页面查看最新资料，确认后再继续。",
  };
}

export function projectCommitCoverage(
  slices: readonly CompletenessSlice[],
  options: CommitCoverageOptions = {},
): CommitCoverageRow[] {
  return slices.flatMap((slice) => {
    const missingReports = missingReportsFor(slice);
    if (missingReports.length === 0 && (!options.includeNonMissing || slice.state === "COMPLETE")) return [];
    const publicSlice = { ...slice };
    delete publicSlice.note;
    const missingContent = missingReports
      .map((kind) => kind === "TRANSACTION" ? "交易报告" : "配送货件")
      .join("、");
    return [{ ...publicSlice, missingReports, missingContent, ...disclosureFor(slice, missingContent) }];
  }).sort((left, right) => left.marketplace.localeCompare(right.marketplace) || left.month.localeCompare(right.month));
}
