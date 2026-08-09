import ExcelJS from "exceljs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import yauzl from "yauzl";
import { exportReport, FINANCIAL_EXPORT_KEYS, neutralizeSpreadsheetFormula, REPORT_EXPORT_FORMAT, REPORT_SHEETS } from "../../src/modules/exports/export-report";
import { rowsFromArray, type ColumnDefinition, type ReportExportInput, type ReportRow, type ReportSection } from "../../src/modules/exports/report-types";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const EXPECTED_REPORT_SHEETS = ["口径说明", "月度明细账单", "季度明细账单", "年度明细账单", "成本核算表-人民币"];

function readZipText(path: string, fileName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (openError, zip) => {
      if (openError || !zip) { reject(openError ?? new Error("ZIP_OPEN_FAILED")); return; }
      zip.once("error", reject);
      zip.on("entry", (entry) => {
        if (entry.fileName !== fileName) { zip.readEntry(); return; }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { reject(streamError ?? new Error("ZIP_STREAM_FAILED")); return; }
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.once("error", reject);
          stream.once("end", () => { zip.close(); resolve(Buffer.concat(chunks).toString("utf8")); });
        });
      });
      zip.once("end", () => reject(new Error("ZIP_ENTRY_NOT_FOUND")));
      zip.readEntry();
    });
  });
}

const columns: readonly ColumnDefinition[] = [
  { key: "month", header: "月份", width: 14, kind: "date" },
  { key: "site", header: "站点", width: 12, kind: "text" },
  { key: "amount", header: "金额（CNY）", width: 20, kind: "decimal" },
  { key: "note", header: "备注", width: 28, kind: "text" },
];

function section(rows: readonly ReportRow[] = [{ month: "2025-10-01", site: "US", amount: "0.30000000", note: "正常" }]): ReportSection {
  return { columns, source: rowsFromArray(rows) };
}

function input(rows?: Parameters<typeof section>[0]): ReportExportInput {
  const value = section(rows);
  return {
    diagnosticId: "E5YwPcW1JusfK5ZP8ocNjDn",
    snapshotId: "123e4567-e89b-12d3-a456-426614174000", publishedAt: "2026-07-27T23:59:00.000Z", generatedAt: "2026-07-28T00:00:00.000Z", shopName: "脱敏店铺",
    policyVersion: "policy-v1", formulaVersion: "formula-v1", dataVersion: "data-v1", mappingVersion: "mapping-v1", fxVersion: "fx-v1",
    timezoneVersion: "iana-tzdb-2026a", codeVersion: "test-v1", priceVersion: "price-v1", manifestSha256: "a".repeat(64),
    costAssumptions: { profitRate: null, minimumSalesCostRate: null },
    reportPeriods: ["2025-10"],
    monthly: value, quarterly: section(), annual: section(), completeness: section(), fees: section(), importAudit: section(),
  };
}

describe("five-sheet v8 export", () => {
  it("neutralizes control-character formula prefixes used by CSV readers", () => {
    expect(neutralizeSpreadsheetFormula("\t=HYPERLINK(\"x\")")).toBe("'\t=HYPERLINK(\"x\")");
    expect(neutralizeSpreadsheetFormula("\r@SUM(1,1)")).toBe("'\r@SUM(1,1)");
    expect(neutralizeSpreadsheetFormula(" normal text")).toBe(" normal text");
  });

  it("writes exactly five sheets without audit internals and keeps decimal source out of JS arithmetic", async () => {
    const root = await mkdtemp(join(tmpdir(), "revenue-export-")); roots.push(root);
    const path = join(root, "report.xlsx");
    const result = await exportReport(input(), path);
    expect(result.kind).toBe("XLSX");
    expect(result.files).toEqual([
      expect.objectContaining({
        name: "report.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ]);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path);
    expect(REPORT_EXPORT_FORMAT).toBe("revenue-and-costs-export-v8");
    expect(REPORT_SHEETS).toEqual(EXPECTED_REPORT_SHEETS);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(EXPECTED_REPORT_SHEETS);
    expect(workbook.getWorksheet("口径说明")?.state).toBe("hidden");
    expect(workbook.getWorksheet("口径说明")?.getCell("A2").value).toBe("ID");
    expect(workbook.getWorksheet("口径说明")?.getCell("B2").value).toBe("E5YwPcW1JusfK5ZP8ocNjDn");
    expect(workbook.getWorksheet("汇率追溯")).toBeUndefined();
    for (const sheetName of REPORT_SHEETS.filter((sheetName) => sheetName !== "口径说明" && sheetName !== "成本核算表-人民币")) {
      const sheet = workbook.getWorksheet(sheetName)!;
      expect(sheet.getCell("A1").value).toContain(`脱敏店铺 / ${sheetName}`);
      expect(sheet.getCell("B1").value).toBeNull();
      const headerValues = sheet.getRow(2).values;
      expect(Array.isArray(headerValues)).toBe(true);
      expect((headerValues as ExcelJS.CellValue[]).slice(1, columns.length + 1)).toEqual(columns.map((column) => column.header));
      expect(sheet.getCell(2, columns.length + 1).value).toBeNull();
      expect(sheet.getCell("B3").value).toBe("US");
      expect(sheet.autoFilter).toBe("A2:D2");
    }
    expect(workbook.getWorksheet("成本核算表-人民币")?.getCell("A1").value).toBe("脱敏店铺");
    expect(workbook.getWorksheet("月度明细账单")?.getCell("C3").formula).toBe('ROUND(VALUE("0.30000000"),8)');
  });

  it("neutralizes user-controlled formula prefixes", async () => {
    const root = await mkdtemp(join(tmpdir(), "revenue-export-")); roots.push(root);
    const path = join(root, "report.xlsx");
    await exportReport(input([{ month: "2025-10-01", site: "US", amount: "1.00000000", note: "=HYPERLINK(\"x\")" }]), path);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path);
    expect(workbook.getWorksheet("月度明细账单")?.getCell("D3").value).toBe("'=HYPERLINK(\"x\")");
  });

  it("creates CSV partitions and a five-sheet manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "revenue-export-")); roots.push(root);
    const path = join(root, "report.zip");
    const result = await exportReport(input([
      { month: "2025-10", marketplace: "US", site: "US", amount: "1.00000000", note: "=unsafe" },
      { month: "2025-11", marketplace: "US", site: "US", amount: "2.00000000", note: "b" },
    ]), path, { maxRowsPerSheet: 3, csvRowsPerPart: 1, workDirectory: root });
    expect(result.kind).toBe("ZIP");
    expect(result.files.some((file) => file.name === "manifest.json")).toBe(true);
    expect(result.files.some((file) => file.name === "monthly-US-2025-10-part-0001.csv" && file.marketplace === "US" && file.period === "2025-10")).toBe(true);
    expect((await readFile(path)).byteLength).toBeGreaterThan(0);
    expect(result.files.find((file) => file.name === "report.xlsx")?.mediaType)
      .toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(result.files.find((file) => file.name === "manifest.json")?.mediaType).toBe("application/json");
    expect(result.files.find((file) => file.name.endsWith(".csv"))?.mediaType).toBe("text/csv");
    const manifest = JSON.parse(await readZipText(path, "manifest.json")) as { format: string; sheetNames: string[] };
    expect(manifest.format).toBe(REPORT_EXPORT_FORMAT);
    expect(manifest.sheetNames).toEqual(EXPECTED_REPORT_SHEETS);
    expect(manifest.sheetNames).not.toContain("汇率追溯");
    expect(manifest.sheetNames).not.toContain("完整性检查");
    expect(manifest.sheetNames).not.toContain("费用明细");
    expect(manifest.sheetNames).not.toContain("导入审计");
  });

  it("applies the same decimal and integer validation to XLSX and overflow CSV", async () => {
    const root = await mkdtemp(join(tmpdir(), "revenue-export-")); roots.push(root);
    await expect(exportReport(input([
      { month: "2025-10", site: "US", amount: "1.000000000", note: "invalid decimal" },
    ]), join(root, "invalid.xlsx"))).rejects.toThrow("INVALID_EXPORT_DECIMAL");

    const base = input();
    const integerColumns = columns.map((column) => column.key === "amount" ? { ...column, kind: "integer" as const } : column);
    const integerSection: ReportSection = {
      columns: integerColumns,
      source: rowsFromArray([{ month: "2025-10", site: "US", amount: "1.5", note: "invalid integer" }]),
    };
    await expect(exportReport(
      { ...base, monthly: integerSection },
      join(root, "invalid.zip"),
      { maxRowsPerSheet: 3, workDirectory: root },
    )).rejects.toThrow("INVALID_EXPORT_INTEGER");

    const bounded: ReportSection = {
      columns: columns.map((column) => column.key === "note" ? { ...column, maxBytes: 4 } : column),
      source: rowsFromArray([{ month: "2025-10", site: "US", amount: "1.00000000", note: "正常" }]),
    };
    await expect(exportReport({ ...base, monthly: bounded }, join(root, "bounded.xlsx")))
      .rejects.toThrow("EXPORT_CELL_BOUND_EXCEEDED:note");
  });

  it("fails closed beyond Excel precision while preserving the exact value in overflow CSV", async () => {
    const root = await mkdtemp(join(tmpdir(), "revenue-export-")); roots.push(root);
    const safePath = join(root, "safe.xlsx");
    await expect(exportReport(input([
      { month: "2025-10", marketplace: "US", site: "US", amount: "10000000.00000000", note: "trailing scale zeroes are exact" },
    ]), safePath)).resolves.toMatchObject({ kind: "XLSX" });
    const safeWorkbook = new ExcelJS.Workbook(); await safeWorkbook.xlsx.readFile(safePath);
    expect(safeWorkbook.getWorksheet("月度明细账单")?.getCell("C3").formula)
      .toBe('ROUND(VALUE("10000000.00000000"),8)');

    await expect(exportReport(input([
      { month: "2025-10", marketplace: "US", site: "US", amount: "999999999999999.12345678", note: "fraction beyond digit 15" },
    ]), join(root, "unsafe.xlsx"))).rejects.toThrow("EXPORT_EXCEL_NUMERIC_PRECISION_EXCEEDED");

    await expect(exportReport(input([
      { month: "2025-10", marketplace: "US", site: "US", amount: "9999999999999999.00000001", note: "large amount with low-order detail" },
    ]), join(root, "unsafe-low-order.xlsx"))).rejects.toThrow("EXPORT_EXCEL_NUMERIC_PRECISION_EXCEEDED");

    const base = input();
    const integerSection: ReportSection = {
      columns: columns.map((column) => column.key === "amount" ? { ...column, kind: "integer" as const } : column),
      source: rowsFromArray([{ month: "2025-10", marketplace: "US", site: "US", amount: "1234567890123456", note: "large integer" }]),
    };
    await expect(exportReport({ ...base, monthly: integerSection }, join(root, "unsafe-integer.xlsx")))
      .rejects.toThrow("EXPORT_EXCEL_NUMERIC_PRECISION_EXCEEDED");

    const zipPath = join(root, "exact.zip");
    await expect(exportReport(input([
      { month: "2025-10", marketplace: "US", site: "US", amount: "999999999999999.12345678", note: "exact CSV" },
    ]), zipPath, { maxRowsPerSheet: 2, workDirectory: root })).resolves.toMatchObject({ kind: "ZIP" });
    const csv = await readZipText(zipPath, "monthly-US-2025-10-part-0001.csv");
    expect(csv).toContain("999999999999999.12345678");
  });

  it("uses four header rows, borders, two-decimal formats and guarded CNY cost formulas", async () => {
    const financialColumns: readonly ColumnDefinition[] = FINANCIAL_EXPORT_KEYS.map((key, index) => ({
      key,
      header: key,
      width: 16,
      kind: index < 5 ? "text" : "decimal",
    }));
    const financialRow = (period: string, marketplace: string): ReportRow => Object.fromEntries(
      FINANCIAL_EXPORT_KEYS.map((key, index) => [key, index === 0 ? "shop" : index === 1 ? period : index === 2 ? "亚马逊" : index === 3 ? marketplace : index === 4 ? "EUR" : key.includes("Rate") ? "0.25000000" : "10.12345678"]),
    );
    const summary = (rows: readonly ReportRow[]): ReportSection => ({ columns: financialColumns, source: rowsFromArray(rows) });
    const base = input();
    const financial: ReportExportInput = {
      ...base,
      costAssumptions: { profitRate: "0.04370000", minimumSalesCostRate: "0.15000000" },
      monthly: summary([financialRow("2025-10", "EU-BE")]),
      quarterly: summary([financialRow("2025-Q4", "EU-BE")]),
      annual: summary([financialRow("2025", "EU-BE")]),
    };
    const root = await mkdtemp(join(tmpdir(), "revenue-export-")); roots.push(root);
    const path = join(root, "report.xlsx");
    await exportReport(financial, path);
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path);
    const monthly = workbook.getWorksheet("月度明细账单")!;
    expect(monthly.getCell("A2").value).toBe("公司");
    expect(monthly.getCell("F2").value).toBe("收入");
    expect(monthly.getCell("F3").value).toBe("收入总额");
    expect(monthly.getCell("F4").value).toBe("原币金额");
    expect(monthly.getCell("F5").numFmt).toContain("0.00");
    expect(monthly.getCell("F5").border.top?.style).toBe("thin");
    expect(monthly.autoFilter).toBe("A4:AF4");
    const cost = workbook.getWorksheet("成本核算表-人民币")!;
    expect(cost.getCell("A1").value).toBe("脱敏店铺");
    expect(cost.getCell("C3").formula).toContain("SUMIF('月度明细账单'");
    expect(cost.getCell("C9").formula).toContain("IFERROR");
    expect(cost.getCell("B10").value).toBe("利润金额");
    expect(cost.getCell("C10").formula).toContain("$C$15*C5");
    expect(cost.getCell("C10").formula).toContain("C5-C8-C11");
    expect(cost.getCell("C11").formula).toContain("$C$15");
    expect(cost.getCell("C11").formula).toContain("$C$16");
    expect(cost.getCell("C12").formula).toContain("C11/C3");
    expect(cost.getCell("C13").formula).toContain("C3*$C$16");
    expect(cost.getCell("C15").formula).toBe('ROUND(VALUE("0.04370000"),8)');
    expect(cost.getCell("C16").formula).toBe('ROUND(VALUE("0.15000000"),8)');
    expect(cost.getCell("C3").numFmt).toContain("0.00");
    expect(cost.getCell("C3").border.left?.style).toBe("thin");
    expect(cost.getCell("A5").fill).toMatchObject({ fgColor: { argb: "FFF8CBAD" } });
    expect(cost.getCell("A8").fill).toMatchObject({ fgColor: { argb: "FFD9D2E9" } });
    expect(cost.getCell("A11").fill).toMatchObject({ fgColor: { argb: "FFB4C6E7" } });
    expect(cost.getCell("U3").fill).toMatchObject({ fgColor: { argb: "FFF8CBAD" } });
    expect(cost.getCell("U7").fill).toMatchObject({ fgColor: { argb: "FFB4C6E7" } });
    expect(cost.getCell("U8").fill).toMatchObject({ fgColor: { argb: "FFD9D2E9" } });
  });
});
