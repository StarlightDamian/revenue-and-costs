import { describe, expect, it } from "vitest";
import { assertExportCapacity } from "../../src/modules/exports/postgres.js";
import { estimateExportArtifactBytes, requiredExportFreeBytes } from "../../src/modules/exports/export-report.js";
import { rowsFromArray, type ReportExportInput, type ReportSection } from "../../src/modules/exports/report-types.js";

const section = (count: number): ReportSection => ({
  columns: [
    { key: "marketplace", header: "站点", width: 12, kind: "text", maxBytes: 512 },
    { key: "amount", header: "金额", width: 18, kind: "decimal" },
  ],
  source: rowsFromArray(Array.from({ length: count }, () => ({ marketplace: "US", amount: "1.00000000" }))),
});

function input(): ReportExportInput {
  const rows = section(2);
  return {
    diagnosticId: "P0000000000000000000000",
    snapshotId: "snapshot", publishedAt: "2026-07-28T00:00:00Z", generatedAt: "2026-07-28T00:00:00Z", shopName: "shop",
    policyVersion: "p", formulaVersion: "f", dataVersion: "d", mappingVersion: "m", fxVersion: "x",
    timezoneVersion: "t", codeVersion: "c", priceVersion: "price", manifestSha256: "a".repeat(64), reportPeriods: ["2025-10"],
    costAssumptions: { profitRate: null, minimumSalesCostRate: null },
    monthly: rows, quarterly: section(0), annual: section(0), completeness: section(0), fees: section(0), importAudit: section(0),
  };
}

describe("export volume capacity gate", () => {
  it("requires exactly twice the conservative estimate plus two GiB", async () => {
    const report = input();
    const estimate = estimateExportArtifactBytes(report);
    expect(estimate).toBe(16n * 1024n * 1024n + 2n * (64n + 512n + 64n));
    const required = requiredExportFreeBytes(estimate);

    await expect(assertExportCapacity("volume", report, async () => ({ bavail: required, bsize: 1n }))).resolves.toBeUndefined();
    await expect(assertExportCapacity("volume", report, async () => ({ bavail: required - 1n, bsize: 1n })))
      .rejects.toThrow("EXPORT_CAPACITY_INSUFFICIENT");
  });

  it("stops when free-space evidence is unavailable", async () => {
    await expect(assertExportCapacity("volume", input(), async () => { throw new Error("statfs unavailable"); }))
      .rejects.toThrow("EXPORT_CAPACITY_EVIDENCE_UNAVAILABLE");
  });
});
