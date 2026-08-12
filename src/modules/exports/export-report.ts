import { ZipArchive } from "archiver";
import ExcelJS from "exceljs";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { once } from "node:events";
import type { ColumnDefinition, ReportCell, ReportExportInput, ReportRow, ReportSection } from "./report-types";

export const REPORT_SHEETS = ["口径说明", "月度明细账单", "季度明细账单", "年度明细账单", "成本核算表-人民币"] as const;
export const REPORT_EXPORT_FORMAT = "revenue-and-costs-export-v8";
const EXCEL_MAX_ROWS = 1_048_576;
const HEADER_FILL = "1F4E78";
const HEADER_LIGHT_FILL = "9DC3E6";
const PROFIT_FILL = "FFF2CC";
const DATA_FILL = "E2F0D9";
const INCOME_FILL = "F8CBAD";
const EXPENSE_FILL = "D9D2E9";
const PROCUREMENT_FILL = "B4C6E7";
const BORDER_COLOR = "7F8C8D";
const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MEDIA_TYPE = "text/csv";
const JSON_MEDIA_TYPE = "application/json";
const DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u;
const INTEGER_PATTERN = /^-?(?:0|[1-9]\d*)$/u;
const GIB = 1024n * 1024n * 1024n;
const EXPORT_BASE_ESTIMATE = 16n * 1024n * 1024n;

export type ReportExportProgressStage =
  | "WRITING_NOTES"
  | "WRITING_MONTHLY"
  | "WRITING_QUARTERLY"
  | "WRITING_ANNUAL"
  | "WRITING_COST"
  | "FINALIZING_XLSX"
  | "HASHING"
  | "PACKAGING";
export interface ReportExportProgress {
  readonly stage: ReportExportProgressStage;
  readonly processedRows: bigint;
  readonly totalRows: bigint;
}
export interface ExportOptions {
  maxRowsPerSheet?: number;
  csvRowsPerPart?: number;
  workDirectory?: string;
  workId?: string;
  onProgress?: (progress: ReportExportProgress) => Promise<void> | void;
}
export interface ExportResult { kind: "XLSX" | "ZIP"; path: string; files: readonly ManifestFile[] }
interface ManifestFile { name: string; mediaType: string; sha256: string; bytes: string; rows?: string; marketplace?: string; period?: string }
type SummaryKind = "monthly" | "quarterly" | "annual";
interface WrittenSheet { readonly lastDataRow: number; readonly totalRow?: number; readonly overflow: boolean }

export const FINANCIAL_SUMMARY_KEYS = [
  "period", "marketplace", "incomeOriginal", "incomeCny", "refundOriginal", "refundCny",
  "netOriginal", "netCny", "withheldTaxOriginal", "withheldTaxCny", "platformFeeOriginal", "platformFeeCny",
  "fbaOriginal", "fbaCny", "storageOriginal", "storageCny", "advertisingOriginal", "advertisingCny",
  "otherOriginal", "otherCny", "expenseOriginal", "expenseCny", "procurementOriginal", "procurementCny",
  "profitOriginal", "profitCny",
] as const;
const SUMMARY_KEYS = FINANCIAL_SUMMARY_KEYS;
export const FINANCIAL_EXPORT_KEYS = [
  "shop", "period", "platform", "marketplace", "currency", ...FINANCIAL_SUMMARY_KEYS.filter((key) => key !== "period" && key !== "marketplace"),
] as const;

export function neutralizeSpreadsheetFormula(value: string): string {
  let firstVisible = 0;
  while (firstVisible < value.length && value.charCodeAt(firstVisible) <= 0x20) firstVisible += 1;
  return firstVisible < value.length && "=+-@".includes(value[firstVisible]!) ? `'${value}` : value;
}

function safeText(value: string): string {
  return neutralizeSpreadsheetFormula(value);
}

function requireNumeric(value: string, kind: "decimal" | "integer"): void {
  const valid = kind === "decimal" ? DECIMAL_PATTERN.test(value) : INTEGER_PATTERN.test(value);
  if (!valid) throw new Error(kind === "decimal" ? "INVALID_EXPORT_DECIMAL" : "INVALID_EXPORT_INTEGER");
}

function requireExcelNumericPrecision(value: string, kind: "decimal" | "integer"): void {
  const unsigned = value.startsWith("-") ? value.slice(1) : value;
  const exactDigits = kind === "decimal" ? unsigned.replace(".", "") : unsigned;
  // Excel preserves at most 15 significant decimal digits. Zeroes after the
  // last non-zero digit add scale/display information but no numeric
  // information, so rejecting them would incorrectly fail exact values such
  // as 10000000.00000000.
  const significant = exactDigits.replace(/^0+/u, "").replace(/0+$/u, "") || "0";
  if (significant.length > 15) throw new Error("EXPORT_EXCEL_NUMERIC_PRECISION_EXCEEDED");
}

function requireCellBound(value: ReportCell, column: ColumnDefinition): void {
  if (column.maxBytes !== undefined && typeof value === "string" && Buffer.byteLength(value, "utf8") > column.maxBytes) {
    throw new Error(`EXPORT_CELL_BOUND_EXCEEDED:${column.key}`);
  }
}

function decimalFormula(value: string): { formula: string } {
  requireNumeric(value, "decimal");
  requireExcelNumericPrecision(value, "decimal");
  return { formula: `ROUND(VALUE("${value}"),8)` };
}

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: `FF${BORDER_COLOR}` } },
  left: { style: "thin", color: { argb: `FF${BORDER_COLOR}` } },
  bottom: { style: "thin", color: { argb: `FF${BORDER_COLOR}` } },
  right: { style: "thin", color: { argb: `FF${BORDER_COLOR}` } },
};

function applyBorders(sheet: ExcelJS.Worksheet, fromRow: number, toRow: number, fromColumn: number, toColumn: number): void {
  for (let row = fromRow; row <= toRow; row += 1) {
    for (let column = fromColumn; column <= toColumn; column += 1) sheet.getCell(row, column).border = THIN_BORDER;
  }
}

function excelValue(value: ReportCell, column: ColumnDefinition): ExcelJS.CellValue {
  if (value === null) return "";
  if (typeof value === "boolean") return value;
  if (column.kind === "decimal") return decimalFormula(value);
  if (column.kind === "integer") {
    requireNumeric(value, "integer");
    requireExcelNumericPrecision(value, "integer");
    return { formula: `VALUE("${value}")` };
  }
  return safeText(value);
}

function csvValue(value: ReportCell, kind: ColumnDefinition["kind"] = "text"): string {
  const text = typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : value ?? "";
  const numeric = kind === "decimal" || kind === "integer";
  if (numeric && typeof value !== "boolean" && value !== null) requireNumeric(text, kind);
  const safe = numeric ? text : neutralizeSpreadsheetFormula(text);
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function styleSheet(sheet: ExcelJS.Worksheet, columns: readonly ColumnDefinition[]): void {
  sheet.columns = columns.map((column) => ({ key: column.key, width: column.width }));
  const header = sheet.getRow(2);
  header.values = columns.map((column) => column.header);
  header.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Microsoft YaHei", size: 10 };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${HEADER_FILL}` } };
  header.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  for (let column = 1; column <= columns.length; column += 1) header.getCell(column).border = THIN_BORDER;
  header.height = 28;
  sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: columns.length } };
}

function isFinancialSummary(section: ReportSection): boolean {
  const keys = new Set(section.columns.map((column) => column.key));
  return SUMMARY_KEYS.every((key) => keys.has(key));
}

function requiredSheetRows(section: ReportSection): bigint {
  return section.source.count + (isFinancialSummary(section) ? 4n : 2n);
}

function estimatedRowBytes(section: ReportSection): bigint {
  return section.columns.reduce((total, column) => {
    if (column.maxBytes !== undefined) {
      if (!Number.isSafeInteger(column.maxBytes) || column.maxBytes <= 0) throw new Error("INVALID_EXPORT_COLUMN_BOUND");
      return total + BigInt(column.maxBytes);
    }
    if (column.kind === "decimal" || column.kind === "integer") return total + 64n;
    if (column.kind === "date") return total + 32n;
    // Generic/custom report columns fall back to eight UTF-8 bytes per display
    // cell with a 256-byte floor. Production projections declare maxBytes.
    return total + BigInt(Math.max(256, column.width * 8));
  }, 64n);
}

export function estimateExportArtifactBytes(input: ReportExportInput): bigint {
  const sections = [input.monthly, input.quarterly, input.annual, input.completeness, input.fees, input.importAudit];
  return sections.reduce(
    (total, section) => total + section.source.count * estimatedRowBytes(section),
    EXPORT_BASE_ESTIMATE,
  );
}

export function requiredExportFreeBytes(estimatedArtifactBytes: bigint): bigint {
  if (estimatedArtifactBytes < 0n) throw new Error("INVALID_EXPORT_SIZE_ESTIMATE");
  return estimatedArtifactBytes * 2n + 2n * GIB;
}

export function assertExportCapacityAvailable(freeBytes: bigint, estimatedArtifactBytes: bigint): void {
  if (freeBytes < requiredExportFreeBytes(estimatedArtifactBytes)) throw new Error("EXPORT_CAPACITY_INSUFFICIENT");
}

function excelColumn(index: number): string {
  let value = index;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function styleDataRow(row: ExcelJS.Row, columns: readonly ColumnDefinition[]): void {
  row.font = { name: "Microsoft YaHei", size: 10, color: { argb: "FF111827" } };
  row.alignment = { vertical: "top" };
  for (const [index, column] of columns.entries()) {
    const cell = row.getCell(index + 1);
    if (column.kind === "decimal") cell.numFmt = '#,##0.00;[Red]-#,##0.00;0.00';
    else if (column.kind === "integer") cell.numFmt = '#,##0;[Red]-#,##0;-';
    else if (column.kind === "date") cell.numFmt = "yyyy-mm-dd";
    if (column.kind === "status") cell.alignment = { vertical: "top", horizontal: "center" };
    cell.border = THIN_BORDER;
  }
}

async function hashFile(path: string, name: string, mediaType: string): Promise<ManifestFile> {
  const hash = createHash("sha256");
  const stream = (await import("node:fs")).createReadStream(path);
  stream.on("data", (chunk: Buffer) => hash.update(chunk));
  await once(stream, "end");
  const info = await stat(path);
  return { name, mediaType, sha256: hash.digest("hex"), bytes: String(info.size) };
}

async function writeRows(
  sheet: ExcelJS.Worksheet,
  section: ReportSection,
  onRows?: (writtenRows: bigint) => Promise<void>,
): Promise<WrittenSheet> {
  let lastDataRow = 2;
  let writtenRows = 0n;
  for await (const source of section.source.rows()) {
    const values: ExcelJS.CellValue[] = section.columns.map((column) => {
      const value = source[column.key] ?? null;
      requireCellBound(value, column);
      return excelValue(value, column);
    });
    const row = sheet.addRow(values);
    lastDataRow = row.number;
    const conservationIndex = section.columns.findIndex((column) => column.key === "conservation");
    if (conservationIndex >= 0) {
      const indexes = Object.fromEntries(["readRows", "insertedRows", "excludedRows", "errorRows"].map((key) => [key, section.columns.findIndex((column) => column.key === key) + 1]));
      if (Object.values(indexes).some((index) => index === 0)) throw new Error("EXPORT_AUDIT_CONSERVATION_COLUMN_MISSING");
      const cell = (key: string) => `${excelColumn(indexes[key]!)}${row.number}`;
      row.getCell(conservationIndex + 1).value = { formula: `IF(${cell("readRows")}=SUM(${cell("insertedRows")}:${cell("errorRows")}),"PASS","FAIL")` };
    }
    styleDataRow(row, section.columns);
    row.commit();
    writtenRows += 1n;
    if (writtenRows % 1_000n === 0n) await onRows?.(writtenRows);
  }
  if (writtenRows % 1_000n !== 0n || writtenRows === 0n) await onRows?.(writtenRows);
  if (writtenRows !== section.source.count) throw new Error("EXPORT_ROW_COUNT_MISMATCH");
  return { lastDataRow, overflow: false };
}

function chinesePeriod(period: string, kind: SummaryKind): string {
  if (kind === "monthly") {
    const match = /^(\d{4})-(\d{2})$/u.exec(period);
    return match ? `${match[1]}年${match[2]}月` : period;
  }
  if (kind === "quarterly") {
    const match = /^(\d{4})-Q([1-4])$/u.exec(period);
    if (!match) return period;
    const start = (Number(match[2]) - 1) * 3 + 1;
    return `${match[1]}年${start}-${start + 2}月`;
  }
  return /^\d{4}$/u.test(period) ? `${period}年` : period;
}

function reportPeriodLabel(periods: readonly string[]): string {
  if (periods.length === 0) return "无可发布期间";
  const label = (period: string) => chinesePeriod(period, "monthly");
  return periods.length === 1 ? label(periods[0]!) : `${label(periods[0]!)}—${label(periods.at(-1)!)}`;
}

function setFinancialHeader(sheet: ExcelJS.Worksheet, periods: readonly string[]): void {
  sheet.getRow(1).values = ["导出日期：", reportPeriodLabel(periods)];
  sheet.mergeCells("B1:AF1");
  sheet.getRow(2).values = ["公司", "日期", "平台", "站点", "原币币种", "收入", "", "", "", "", "", "平台支出", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "采购成本", "", "", "利润", "", ""];
  sheet.getRow(3).values = ["", "", "", "", "", "收入总额", "", "退款金额", "", "收入净额", "", "商品税", "", "平台费", "", "FBA发货费", "", "FBA 仓储费", "", "广告费", "", "其他扣费", "", "费用合计", "", "平台扣费率", "销售成本率", "采购成本", "", "利润率", "利润金额", ""];
  sheet.getRow(4).values = ["", "", "", "", "", "原币金额", "人民币金额", "原币金额", "人民币金额", "原币金额", "人民币金额", "原币金额", "人民币金额", "原币金额", "人民币金额", "原币金额", "人民币金额", "原币金额", "人民币金额", "原币金额", "人民币金额", "原币金额", "人民币金额", "原币金额", "人民币金额", "", "", "原币金额", "人民币金额", "", "原币金额", "人民币金额"];
  for (const range of ["A2:A4", "B2:B4", "C2:C4", "D2:D4", "E2:E4", "F2:K2", "L2:Y2", "Z2:AC2", "AD2:AF2", "F3:G3", "H3:I3", "J3:K3", "L3:M3", "N3:O3", "P3:Q3", "R3:S3", "T3:U3", "V3:W3", "X3:Y3", "Z3:Z4", "AA3:AA4", "AB3:AC3", "AD3:AD4", "AE3:AF3"]) sheet.mergeCells(range);
  sheet.getRow(1).font = { bold: true, name: "Microsoft YaHei", size: 11 };
  for (let row = 2; row <= 4; row += 1) {
    const current = sheet.getRow(row);
    current.font = { bold: true, name: "Microsoft YaHei", size: 10, color: { argb: "FF102A43" } };
    current.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    current.height = row === 2 ? 30 : 26;
    for (let column = 1; column <= 32; column += 1) current.getCell(column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${HEADER_LIGHT_FILL}` } };
  }
  for (let column = 30; column <= 32; column += 1) {
    for (let row = 2; row <= 4; row += 1) sheet.getCell(row, column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${PROFIT_FILL}` } };
  }
  applyBorders(sheet, 1, 4, 1, 32);
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 32 } };
}

async function writeFinancialRows(
  sheet: ExcelJS.Worksheet,
  section: ReportSection,
  kind: SummaryKind,
  periods: readonly string[],
  onRows?: (writtenRows: bigint) => Promise<void>,
): Promise<WrittenSheet> {
  sheet.columns = section.columns.map((column) => ({ key: column.key, width: column.width }));
  setFinancialHeader(sheet, periods);
  let lastDataRow = 4;
  let writtenRows = 0n;
  for await (const source of section.source.rows()) {
    const values = section.columns.map((column) => {
      const raw = source[column.key] ?? null;
      requireCellBound(raw, column);
      if (column.key === "period" && typeof raw === "string") return safeText(chinesePeriod(raw, kind));
      return excelValue(raw, column);
    });
    const row = sheet.addRow(values);
    lastDataRow = row.number;
    row.font = { name: "Microsoft YaHei", size: 10, color: { argb: "FF111827" } };
    row.alignment = { vertical: "middle", horizontal: "center" };
    row.height = 22;
    for (let column = 1; column <= section.columns.length; column += 1) {
      const cell = row.getCell(column);
      cell.border = THIN_BORDER;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${column >= 30 ? PROFIT_FILL : DATA_FILL}` } };
      if (section.columns[column - 1]?.kind === "decimal") cell.numFmt = [26, 27, 30].includes(column) ? "0.00%" : '#,##0.00;[Red]-#,##0.00;0.00';
    }
    row.commit();
    writtenRows += 1n;
    if (writtenRows % 1_000n === 0n) await onRows?.(writtenRows);
  }
  if (writtenRows % 1_000n !== 0n || writtenRows === 0n) await onRows?.(writtenRows);
  if (writtenRows !== section.source.count) throw new Error("EXPORT_ROW_COUNT_MISMATCH");
  return { lastDataRow, overflow: false };
}

async function writeCsvParts(
  section: ReportSection,
  prefix: string,
  directory: string,
  rowsPerPart: number,
  onRows?: (writtenRows: bigint) => Promise<void>,
): Promise<ManifestFile[]> {
  const files: ManifestFile[] = [];
  const partitionParts = new Map<string, number>();
  let rowCount = 0;
  let stream: ReturnType<typeof createWriteStream> | undefined;
  let hash = createHash("sha256");
  let currentPath = "";
  let currentRows = 0;
  let currentPartition = "";
  let currentMarketplace = "all";
  let currentPeriod = "undated";
  const safeFileSegment = (value: string): string => value.normalize("NFKC").replaceAll(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80) || "unknown";
  const partition = (row: ReportRow): { key: string; marketplace: string; period: string } => {
    const marketplace = typeof row.marketplace === "string" && row.marketplace ? row.marketplace : "all";
    const candidate = typeof row.month === "string" ? row.month : typeof row.period === "string" ? row.period : typeof row.requestedDate === "string" ? row.requestedDate.slice(0, 7) : "undated";
    const period = /^\d{4}-(?:\d{2}|Q[1-4])$|^\d{4}$/u.test(candidate) ? candidate : "undated";
    return { key: `${marketplace}\0${period}`, marketplace, period };
  };
  const start = async (target: { key: string; marketplace: string; period: string }): Promise<void> => {
    const part = (partitionParts.get(target.key) ?? 0) + 1;
    partitionParts.set(target.key, part);
    currentRows = 0;
    currentPartition = target.key;
    currentMarketplace = target.marketplace;
    currentPeriod = target.period;
    hash = createHash("sha256");
    currentPath = join(directory, `${prefix}-${safeFileSegment(target.marketplace)}-${safeFileSegment(target.period)}-part-${String(part).padStart(4, "0")}.csv`);
    stream = createWriteStream(currentPath, { flags: "wx" });
    const header = `\uFEFF${section.columns.map((column) => csvValue(column.header, "text")).join(",")}\r\n`;
    hash.update(header); stream.write(header);
  };
  const finish = async (): Promise<void> => {
    if (!stream) return;
    stream.end(); await once(stream, "close");
    const info = await stat(currentPath);
    files.push({ name: basename(currentPath), mediaType: CSV_MEDIA_TYPE, sha256: hash.digest("hex"), bytes: String(info.size), rows: String(currentRows), marketplace: currentMarketplace, period: currentPeriod });
    stream = undefined;
  };
  for await (const row of section.source.rows()) {
    const target = partition(row);
    if (!stream || currentRows >= rowsPerPart || currentPartition !== target.key) { await finish(); await start(target); }
    const line = `${section.columns.map((column) => {
      const value = row[column.key] ?? null;
      requireCellBound(value, column);
      return csvValue(value, column.kind);
    }).join(",")}\r\n`;
    hash.update(line);
    if (!stream?.write(line)) await once(stream!, "drain");
    currentRows += 1; rowCount += 1;
    if (rowCount % 1_000 === 0) await onRows?.(BigInt(rowCount));
  }
  if (!stream && section.source.count === 0n) await start({ key: "all\0undated", marketplace: "all", period: "undated" });
  await finish();
  if (rowCount % 1_000 !== 0 || rowCount === 0) await onRows?.(BigInt(rowCount));
  if (BigInt(rowCount) !== section.source.count) throw new Error("EXPORT_ROW_COUNT_MISMATCH");
  return files;
}

function writeIndexRows(sheet: ExcelJS.Worksheet, files: readonly ManifestFile[]): void {
  for (const file of files) {
    sheet.addRow([safeText(file.name), file.rows ?? "0", file.sha256, "数据量超过 Excel 行限制，请使用同包 CSV 分片。"] as ExcelJS.CellValue[]).commit();
  }
}

function writeCnyCostAccountingSheet(workbook: ExcelJS.stream.xlsx.WorkbookWriter, input: ReportExportInput): void {
  const sheet = workbook.addWorksheet(REPORT_SHEETS[4], { views: [{ state: "frozen", xSplit: 2, ySplit: 2, showGridLines: false }] });
  const leftWidths = [7, 22, ...Array.from({ length: 17 }, () => 14)];
  leftWidths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.getColumn(20).width = 3;
  sheet.getColumn(21).width = 9;
  sheet.getColumn(22).width = 46;
  for (let column = 23; column <= 28; column += 1) sheet.getColumn(column).width = 4;
  sheet.getColumn(29).width = 20;
  sheet.getRow(1).values = [safeText(input.shopName), "", "Q1", "", "", "", "Q2", "", "", "", "Q3", "", "", "", "Q4", "", "", "", "本年累计", "", "企业所得税预缴税款计算"];
  sheet.getRow(2).values = ["序号", "项目", "1月", "2月", "3月", "1-3月合计", "4月", "5月", "6月", "4-6月合计", "7月", "8月", "9月", "7-9月合计", "10月", "11月", "12月", "10-12月合计", "本年累计", "", "行次", "项目", "", "", "", "", "", "", "本年累计金额"];
  for (const range of ["A1:B1", "C1:F1", "G1:J1", "K1:N1", "O1:R1", "S1:S2", "U1:AC1", "V2:AB2"]) sheet.mergeCells(range);

  const leftRows = [
    "收入总额", "退款总额", "收入净额", "商品税", "平台扣费", "平台支出合计",
    "平台扣费率", "利润金额", "采购成本", "销售成本率", "最低成本率调整",
  ];
  const monthColumns = [3, 4, 5, 7, 8, 9, 11, 12, 13, 15, 16, 17];
  const sourceColumn = (row: number): string | undefined => ({ 3: "G", 4: "I", 6: "M" } as Record<number, string>)[row];
  const monthlyLastRow = Number(input.monthly.source.count) + 4;
  const periodMatch = (month: number): string => {
    const year = input.reportPeriods[0]?.slice(0, 4) ?? new Date(input.generatedAt).getUTCFullYear().toString();
    return `${year}年${String(month).padStart(2, "0")}月`;
  };
  for (const [index, label] of leftRows.entries()) {
    const rowNumber = index + 3;
    sheet.getCell(rowNumber, 1).value = index + 1;
    sheet.getCell(rowNumber, 2).value = label;
    for (const [monthIndex, column] of monthColumns.entries()) {
      const month = monthIndex + 1;
      let formula: string;
      if (rowNumber === 5) formula = `${excelColumn(column)}3-${excelColumn(column)}4`;
      else if (rowNumber === 7) {
        const sumColumns = ["O", "Q", "S", "U", "W"].map((source) => `SUMIF('${REPORT_SHEETS[1]}'!$B$5:$B$${monthlyLastRow},"${periodMatch(month)}",'${REPORT_SHEETS[1]}'!$${source}$5:$${source}$${monthlyLastRow})`);
        formula = `ROUND(${sumColumns.join("+")},8)`;
      } else if (rowNumber === 8) formula = `${excelColumn(column)}6+${excelColumn(column)}7`;
      else if (rowNumber === 9) formula = `IFERROR(${excelColumn(column)}8/${excelColumn(column)}5,0)`;
      else if (rowNumber === 10) {
        const baseProcurement = `IF($C$15="",0,${excelColumn(column)}5-${excelColumn(column)}8-$C$15*${excelColumn(column)}5)`;
        const minimumTriggered = `AND($C$16<>"",${excelColumn(column)}3>0,${excelColumn(column)}3*$C$16>${baseProcurement})`;
        const targetProfit = `IF($C$15="",${excelColumn(column)}5-${excelColumn(column)}8,$C$15*${excelColumn(column)}5)`;
        formula = `ROUND(IF(${minimumTriggered},${excelColumn(column)}5-${excelColumn(column)}8-${excelColumn(column)}11,${targetProfit}),8)`;
      }
      else if (rowNumber === 12) formula = `IFERROR(${excelColumn(column)}11/${excelColumn(column)}3,0)`;
      else if (rowNumber === 11) {
        const baseProcurement = `IF($C$15="",0,${excelColumn(column)}5-${excelColumn(column)}8-$C$15*${excelColumn(column)}5)`;
        formula = `ROUND(IF(AND($C$16<>"",${excelColumn(column)}3>0),MAX(${baseProcurement},${excelColumn(column)}3*$C$16),${baseProcurement}),8)`;
      } else if (rowNumber === 13) {
        const baseProcurement = `IF($C$15="",0,${excelColumn(column)}5-${excelColumn(column)}8-$C$15*${excelColumn(column)}5)`;
        formula = `IF(AND($C$16<>"",${excelColumn(column)}3>0,${excelColumn(column)}3*$C$16>${baseProcurement}),"已触发","—")`;
      }
      else {
        const source = sourceColumn(rowNumber);
        formula = source ? `ROUND(SUMIF('${REPORT_SHEETS[1]}'!$B$5:$B$${monthlyLastRow},"${periodMatch(month)}",'${REPORT_SHEETS[1]}'!$${source}$5:$${source}$${monthlyLastRow}),8)` : "ROUND(0,8)";
      }
      sheet.getCell(rowNumber, column).value = { formula };
    }
    for (const [quarterColumn, startColumn] of [[6, 3], [10, 7], [14, 11], [18, 15]] as const) {
      sheet.getCell(rowNumber, quarterColumn).value = { formula: rowNumber === 13
        ? `IF(COUNTIF(${excelColumn(startColumn)}13:${excelColumn(startColumn + 2)}13,"已触发")>0,"已触发","—")`
        : rowNumber === 9 || rowNumber === 12
        ? `IFERROR(${excelColumn(quarterColumn)}${rowNumber === 9 ? 8 : 11}/${excelColumn(quarterColumn)}${rowNumber === 9 ? 5 : 3},0)`
        : `ROUND(SUM(${excelColumn(startColumn)}${rowNumber}:${excelColumn(startColumn + 2)}${rowNumber}),8)` };
    }
    sheet.getCell(rowNumber, 19).value = { formula: rowNumber === 13
      ? `IF(COUNTIF(C13:R13,"已触发")>0,"已触发","—")`
      : rowNumber === 9 || rowNumber === 12
      ? `IFERROR(S${rowNumber === 9 ? 8 : 11}/S${rowNumber === 9 ? 5 : 3},0)`
      : `ROUND(SUM(F${rowNumber},J${rowNumber},N${rowNumber},R${rowNumber}),8)` };
  }

  const taxRows: readonly [string, string][] = [
    ["1", "营业收入"], ["1.1", "  其中：自营出口收入"], ["1.2", "        委托出口收入"], ["1.3", "        出口代理费收入"],
    ["2", "减：营业成本"], ["4", "减：销售费用"], ["5", "减：管理费用"], ["15", "营业利润（亏损以‘－’号填列）"],
    ["16", "加：营业外收入"], ["17", "减：营业外支出"], ["18", "利润总额（15+16-17）"], ["24", "减：弥补以前年度亏损"],
    ["25", "实际利润额（18+19-20-21-22-23-24）/ 按照上一纳税年度应纳税所得额平均额确定的应纳税所得额"],
    ["26", "税率（25%）"], ["27", "应纳所得税额（25×26）"], ["28", "减：减免所得税额（28.1+28.2+……）"],
    ["28.1", "符合条件的小型微利企业减免企业所得税"], ["30", "减：本年累计已预缴所得税额"],
    ["32", "本期应补（退）所得税额（27-28-29-30-31）/ 税务机关确定的本期应纳所得税额"],
  ];
  for (const [index, [lineNo, label]] of taxRows.entries()) {
    const row = index + 3;
    sheet.getCell(row, 21).value = lineNo;
    sheet.getCell(row, 22).value = label;
    sheet.mergeCells(row, 22, row, 28);
    const formula = ({
      3: "S5", 4: "0", 5: "0", 6: "0", 7: "S11", 8: "S8", 9: "0", 10: "AC3-AC7-AC8-AC9",
      11: "0", 12: "0", 13: "AC10+AC11-AC12", 14: "0", 15: "MAX(AC13-AC14,0)", 16: "0.25",
      17: "ROUND(AC15*AC16,8)", 18: "IF(AC17>=750000,0,AC15*0.2)", 19: "AC18", 20: "0", 21: "AC17-AC18-AC20",
    } as Record<number, string>)[row] ?? "0";
    sheet.getCell(row, 29).value = { formula };
  }
  sheet.getCell("A14").value = "说明";
  sheet.getCell("B14").value = "利润率为空时保持采购成本为 0；最低销售成本率触发时优先保证采购成本下限并相应降低利润。采购成本与利润仅用于经营测算。";
  sheet.mergeCells("B14:S14");
  sheet.getCell("A15").value = "本次参数";
  sheet.getCell("B15").value = "利润率";
  sheet.getCell("B16").value = "最低销售成本率";
  sheet.getCell("C15").value = input.costAssumptions.profitRate === null ? null : decimalFormula(input.costAssumptions.profitRate);
  sheet.getCell("C16").value = input.costAssumptions.minimumSalesCostRate === null ? null : decimalFormula(input.costAssumptions.minimumSalesCostRate);
  sheet.getCell("C15").numFmt = "0.000000%";
  sheet.getCell("C16").numFmt = "0.000000%";
  sheet.getCell("C15").font = { name: "Microsoft YaHei", size: 10, color: { argb: "FF0000FF" } };
  sheet.getCell("C16").font = { name: "Microsoft YaHei", size: 10, color: { argb: "FF0000FF" } };
  sheet.getCell("D15").value = input.costAssumptions.profitRate === null ? "未设置：利润沿用平台结余" : "已固定到本次导出";
  sheet.getCell("D16").value = input.costAssumptions.minimumSalesCostRate === null ? "未设置：不启用下限" : "已固定到本次导出";
  sheet.mergeCells("D15:S15");
  sheet.mergeCells("D16:S16");

  for (let row = 1; row <= 21; row += 1) {
    for (const [from, to] of [[1, 19], [21, 29]] as Array<[number, number]>) {
      for (let column = from; column <= to; column += 1) {
        const cell = sheet.getCell(row, column);
        cell.border = THIN_BORDER;
        cell.font = { name: "Microsoft YaHei", size: 10, bold: row <= 2 };
        cell.alignment = { vertical: "middle", horizontal: column === 22 ? "left" : "center", wrapText: true };
        if (row >= 3 && row !== 13 && (column >= 3 && column <= 19 || column === 29)) cell.numFmt = [9, 12, 16].includes(row) ? "0.00%" : '#,##0.00;[Red]-#,##0.00;0.00';
        if (row === 13 && column >= 3 && column <= 19) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF4CC" } };
        if (row <= 2) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${HEADER_LIGHT_FILL}` } };
      }
    }
  }
  for (const address of ["C15", "C16"]) {
    sheet.getCell(address).numFmt = "0.000000%";
    sheet.getCell(address).font = { name: "Microsoft YaHei", size: 10, color: { argb: "FF0000FF" } };
  }
  const fillRange = (row: number, from: number, to: number, color: string): void => {
    for (let column = from; column <= to; column += 1) {
      sheet.getCell(row, column).fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${color}` } };
    }
  };
  fillRange(5, 1, 19, INCOME_FILL);
  fillRange(8, 1, 19, EXPENSE_FILL);
  fillRange(11, 1, 19, PROCUREMENT_FILL);
  fillRange(3, 21, 29, INCOME_FILL);
  fillRange(7, 21, 29, PROCUREMENT_FILL);
  fillRange(8, 21, 29, EXPENSE_FILL);
  sheet.getRow(1).height = 28;
  sheet.getRow(2).height = 32;
  sheet.getRow(14).height = 42;
  sheet.commit();
}

async function createWorkbook(
  input: ReportExportInput,
  path: string,
  overflowDirectory: string | undefined,
  maxRows: number,
  csvRowsPerPart: number,
  onProgress?: (progress: ReportExportProgress) => Promise<void> | void,
): Promise<ManifestFile[]> {
  const totalRows = input.monthly.source.count + input.quarterly.source.count + input.annual.source.count;
  let processedRows = 0n;
  const report = async (stage: ReportExportProgressStage, rows = processedRows): Promise<void> => {
    await onProgress?.({ stage, processedRows: rows, totalRows });
  };
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: path, useStyles: true, useSharedStrings: false });
  workbook.creator = "revenue-and-costs";
  workbook.created = new Date(input.generatedAt);
  workbook.calcProperties = { fullCalcOnLoad: true };
  const notes = workbook.addWorksheet(REPORT_SHEETS[0], { state: "hidden", views: [{ showGridLines: false }] });
  await report("WRITING_NOTES");
  notes.getColumn(1).width = 24; notes.getColumn(2).width = 80;
  notes.addRow(["跨境电商平台收入与平台成本报告"]).font = { bold: true, size: 16, color: { argb: `FF${HEADER_FILL}` }, name: "Microsoft YaHei" };
  notes.mergeCells("A1:B1");
  const metadata: readonly [string, string][] = [
    ["ID", input.diagnosticId], ["公司", input.shopName], ["快照", input.snapshotId], ["发布时间", input.publishedAt], ["导出生成时间", input.generatedAt],
    ["数据版本", input.dataVersion], ["映射版本", input.mappingVersion], ["汇率版本", input.fxVersion],
    ["日期口径版本", input.timezoneVersion], ["口径版本", input.policyVersion], ["公式版本", input.formulaVersion],
    ["代码版本", input.codeVersion], ["应用价格版本", input.priceVersion], ["Manifest SHA-256", input.manifestSha256],
    ["金额精度", "数据库金额与汇率追溯值保留8位小数，工作簿统一显示2位小数。"],
    ["本次利润率", input.costAssumptions.profitRate ?? "未设置"],
    ["本次最低销售成本率", input.costAssumptions.minimumSalesCostRate ?? "未设置"],
    ["导出站点前缀", input.continentPrefixes?.join(",") || "未启用"],
    ["采购成本边界", "采购成本由本次可选参数测算，不写回发布快照或事实明细；最低成本率触发时利润作为勾稽余项降低。利润不含人工、管理费用及所得税。"],
    ["发布边界", "本报告固定到一个不可变已发布快照，不跨快照拼接。"],
    ["隐私边界", "不包含买家姓名、电话、邮箱和详细地址。"],
  ];
  for (const [label, value] of metadata) notes.addRow([label, safeText(value)]).commit();

  const sections: readonly [typeof REPORT_SHEETS[number], ReportSection, string][] = [
    [REPORT_SHEETS[1], input.monthly, "monthly"], [REPORT_SHEETS[2], input.quarterly, "quarterly"],
    [REPORT_SHEETS[3], input.annual, "annual"],
  ];
  const csvFiles: ManifestFile[] = [];
  const written = new Map<string, WrittenSheet>();
  for (const [name, section, prefix] of sections) {
    const stage: ReportExportProgressStage = name === REPORT_SHEETS[1]
      ? "WRITING_MONTHLY"
      : name === REPORT_SHEETS[2]
        ? "WRITING_QUARTERLY"
        : "WRITING_ANNUAL";
    const baseRows = processedRows;
    const onRows = async (sectionRows: bigint): Promise<void> => report(stage, baseRows + sectionRows);
    await report(stage);
    const candidateKind: SummaryKind | undefined = name === REPORT_SHEETS[1] ? "monthly" : name === REPORT_SHEETS[2] ? "quarterly" : name === REPORT_SHEETS[3] ? "annual" : undefined;
    const financialKind = candidateKind && isFinancialSummary(section) ? candidateKind : undefined;
    const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: financialKind ? 4 : 2, xSplit: financialKind ? 5 : 0, showGridLines: false }] });
    if (requiredSheetRows(section) <= BigInt(maxRows)) {
      if (financialKind) written.set(name, await writeFinancialRows(sheet, section, financialKind, input.reportPeriods, onRows));
      else {
        styleSheet(sheet, section.columns);
        sheet.getRow(1).values = [`${input.shopName} / ${name} / 快照 ${input.snapshotId}`];
        sheet.getRow(1).font = { bold: true, name: "Microsoft YaHei", color: { argb: `FF${HEADER_FILL}` } };
        written.set(name, await writeRows(sheet, section, onRows));
      }
    } else {
      if (!overflowDirectory) throw new Error("EXPORT_OVERFLOW_DIRECTORY_REQUIRED");
      const files = await writeCsvParts(section, prefix, overflowDirectory, csvRowsPerPart, onRows);
      csvFiles.push(...files);
      styleSheet(sheet, [
        { key: "file", header: "CSV分片", width: 36, kind: "text" },
        { key: "rows", header: "数据行数", width: 16, kind: "integer" },
        { key: "sha", header: "SHA-256", width: 68, kind: "text" },
        { key: "note", header: "说明", width: 48, kind: "text" },
      ]);
      sheet.getRow(1).values = [`${input.shopName} / ${name} / CSV索引`];
      writeIndexRows(sheet, files);
      written.set(name, { lastDataRow: files.length + 2, overflow: true });
    }
    processedRows += section.source.count;
    sheet.commit();
    await report(stage);
    if (name === REPORT_SHEETS[3]) {
      await report("WRITING_COST");
      writeCnyCostAccountingSheet(workbook, input);
    }
  }
  const monthly = written.get(REPORT_SHEETS[1]);
  const quarterly = written.get(REPORT_SHEETS[2]);
  const annual = written.get(REPORT_SHEETS[3]);
  const addCheck = (label: string, formula: string | undefined): void => {
    notes.addRow([label, formula ? { formula } : "CSV分片模式下由 manifest 行数和 SHA-256 校验"]).commit();
  };
  const summaryConservation = (leftSheet: string, leftLastRow: number, rightSheet: string, rightLastRow: number): string => {
    const differences = [7, 9, 13, 15, 17, 19, 21, 23, 32].map((index) => {
      const column = excelColumn(index);
      return `ABS(SUM('${leftSheet}'!$${column}$5:$${column}$${leftLastRow})-SUM('${rightSheet}'!$${column}$5:$${column}$${rightLastRow}))`;
    });
    return `IF(SUM(${differences.join(",")})<0.00000001,"PASS","FAIL")`;
  };
  addCheck("月度与季度金额守恒", monthly && quarterly && monthly.lastDataRow >= 5 && quarterly.lastDataRow >= 5
    ? summaryConservation(REPORT_SHEETS[1], monthly.lastDataRow, REPORT_SHEETS[2], quarterly.lastDataRow) : undefined);
  addCheck("月度与年度金额守恒", monthly && annual && monthly.lastDataRow >= 5 && annual.lastDataRow >= 5
    ? summaryConservation(REPORT_SHEETS[1], monthly.lastDataRow, REPORT_SHEETS[3], annual.lastDataRow) : undefined);
  notes.addRow(["服务端校验", "完整性、费用守恒与导入行数守恒均已在生成前校验；失败时不生成工作簿。"]).commit();
  notes.commit();
  await report("FINALIZING_XLSX");
  await workbook.commit();
  return csvFiles;
}

async function zipFiles(outputPath: string, directory: string, files: readonly ManifestFile[]): Promise<void> {
  const output = createWriteStream(outputPath, { flags: "wx" });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.pipe(output);
  for (const file of files) archive.file(join(directory, file.name), { name: file.name });
  await archive.finalize();
  await once(output, "close");
}

export async function exportReport(input: ReportExportInput, outputPath: string, options: ExportOptions = {}): Promise<ExportResult> {
  const maxRows = options.maxRowsPerSheet ?? EXCEL_MAX_ROWS;
  const csvRowsPerPart = options.csvRowsPerPart ?? 1_000_000;
  const overflow = [input.monthly, input.quarterly, input.annual].some((section) => requiredSheetRows(section) > BigInt(maxRows));
  await mkdir(dirname(outputPath), { recursive: true });
  if (!overflow) {
    await createWorkbook(input, outputPath, undefined, maxRows, csvRowsPerPart, options.onProgress);
    await options.onProgress?.({ stage: "HASHING", processedRows: input.monthly.source.count + input.quarterly.source.count + input.annual.source.count, totalRows: input.monthly.source.count + input.quarterly.source.count + input.annual.source.count });
    return { kind: "XLSX", path: outputPath, files: [await hashFile(outputPath, "report.xlsx", XLSX_MEDIA_TYPE)] };
  }
  if (options.workId && !/^[0-9a-f-]{36}$/iu.test(options.workId)) throw new Error("INVALID_EXPORT_WORK_ID");
  const work = join(options.workDirectory ?? dirname(outputPath), `.export-${options.workId ?? randomUUID()}`);
  await mkdir(work, { recursive: true });
  try {
    const workbookPath = join(work, "report.xlsx");
    const csvFiles = await createWorkbook(input, workbookPath, work, maxRows, csvRowsPerPart, options.onProgress);
    const totalRows = input.monthly.source.count + input.quarterly.source.count + input.annual.source.count;
    await options.onProgress?.({ stage: "HASHING", processedRows: totalRows, totalRows });
    const workbookManifest = await hashFile(workbookPath, "report.xlsx", XLSX_MEDIA_TYPE);
    const manifest = {
      format: REPORT_EXPORT_FORMAT,
      snapshotId: input.snapshotId,
      publishedAt: input.publishedAt,
      generatedAt: input.generatedAt,
      versions: {
        data: input.dataVersion,
        mapping: input.mappingVersion,
        fx: input.fxVersion,
        timezone: input.timezoneVersion,
        policy: input.policyVersion,
        formula: input.formulaVersion,
        code: input.codeVersion,
        price: input.priceVersion,
        manifestSha256: input.manifestSha256,
      },
      costAssumptions: input.costAssumptions,
      continentPrefixes: input.continentPrefixes ?? [],
      workbook: workbookManifest,
      files: csvFiles,
      sheetNames: REPORT_SHEETS,
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    const manifestPath = join(work, "manifest.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(manifestPath, manifestText, "utf8");
    const manifestFile = await hashFile(manifestPath, "manifest.json", JSON_MEDIA_TYPE);
    await options.onProgress?.({ stage: "PACKAGING", processedRows: totalRows, totalRows });
    await zipFiles(outputPath, work, [workbookManifest, ...csvFiles, manifestFile]);
    return { kind: "ZIP", path: outputPath, files: [workbookManifest, ...csvFiles, manifestFile] };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
