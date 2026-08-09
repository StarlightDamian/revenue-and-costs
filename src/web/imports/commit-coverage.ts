import type { CompletenessSlice } from "../api/types";

type MissingReport = "TRANSACTION" | "SHIPMENT";

export interface CommitCoverageRow extends CompletenessSlice {
  missingReports: MissingReport[];
  missingContent: string;
}

function missingReportsFor(slice: CompletenessSlice): MissingReport[] {
  if (slice.missingReports) return [...slice.missingReports];
  if (slice.state === "MISSING_TRANSACTION") return ["TRANSACTION"];
  if (slice.state === "MISSING_SHIPMENT") return ["SHIPMENT"];
  return [];
}

export function projectCommitCoverage(slices: readonly CompletenessSlice[]): CommitCoverageRow[] {
  return slices.flatMap((slice) => {
    const missingReports = missingReportsFor(slice);
    if (missingReports.length === 0) return [];
    const missingContent = missingReports
      .map((kind) => kind === "TRANSACTION" ? "交易报告" : "配送货件")
      .join("、");
    return [{ ...slice, missingReports, missingContent }];
  }).sort((left, right) => left.month.localeCompare(right.month) || left.marketplace.localeCompare(right.marketplace));
}
