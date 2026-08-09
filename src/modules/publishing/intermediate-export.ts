import { createHash } from "node:crypto";
import type { Writable } from "node:stream";
import ExcelJS from "exceljs";
import { INTERMEDIATE_REPORT_COLUMNS, type IntermediateReportKind } from "../../shared/intermediate-report.js";

const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u;

function safeText(value: string): string {
  let firstVisible = 0;
  while (firstVisible < value.length && value.charCodeAt(firstVisible) <= 0x20) firstVisible += 1;
  return firstVisible < value.length && "=+-@".includes(value[firstVisible]!) ? `'${value}` : value;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}

export function intermediateLogicalName(kind: IntermediateReportKind, enterpriseName: string): string {
  const base = `${kind === "TRANSACTION" ? "交易报告" : "配送货件"}-${enterpriseName}`.replace(/[\\/*?:[\]]/gu, "_").trim() || "中间结果";
  return [...base].length <= 31 ? base : `${[...base].slice(0, 24).join("")}-${shortHash(base)}`;
}

export function intermediateFileName(kind: IntermediateReportKind, enterpriseName: string): string {
  const raw = `${kind === "TRANSACTION" ? "交易报告" : "配送货件"}-${enterpriseName}`;
  const stem = [...raw].map((character) => character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? "_" : character).join("").trim() || "中间结果";
  return `${stem}.xlsx`;
}

function numericFormula(value: string, scale: 2 | 8): { formula: string } {
  if (!DECIMAL.test(value)) throw new Error("INVALID_INTERMEDIATE_NUMERIC");
  const significant = value.replace(/^-|\./gu, "").replace(/^0+/u, "").replace(/0+$/u, "") || "0";
  if (significant.length > 15) throw new Error("INTERMEDIATE_EXCEL_NUMERIC_PRECISION_EXCEEDED");
  return { formula: `ROUND(VALUE("${value}"),${scale})` };
}

export async function writeIntermediateWorkbook(input: {
  readonly output: Writable;
  readonly kind: IntermediateReportKind;
  readonly enterpriseName: string;
  readonly rows: AsyncIterable<Record<string, string>>;
}): Promise<number> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: input.output as never, useStyles: true, useSharedStrings: false });
  workbook.creator = "revenue-and-costs";
  workbook.calcProperties = { fullCalcOnLoad: true };
  const columns = INTERMEDIATE_REPORT_COLUMNS[input.kind];
  const sheet = workbook.addWorksheet(intermediateLogicalName(input.kind, input.enterpriseName), {
    views: [{ state: "frozen", xSplit: input.kind === "TRANSACTION" ? 3 : 3, ySplit: 1, showGridLines: false }],
  });
  sheet.columns = columns.map((item) => ({ key: item.key, header: item.header, width: item.width }));
  const header = sheet.getRow(1);
  header.height = 28;
  header.font = { name: "Microsoft YaHei", bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
  header.alignment = { vertical: "middle", horizontal: "center" };
  header.commit();
  let count = 0;
  for await (const source of input.rows) {
    const values: Record<string, ExcelJS.CellValue> = {};
    for (const definition of columns) {
      if (definition.key === "originalTotal" || definition.key === "cnyTotal") continue;
      const raw = source[definition.key] ?? "";
      values[definition.key] = definition.kind === "money" || definition.kind === "quantity"
        ? numericFormula(raw || "0", 2)
        : definition.kind === "rate"
          ? raw === "" ? "" : numericFormula(raw, 8)
          : safeText(raw);
    }
    const excelRow = sheet.addRow(values);
    if (input.kind === "SHIPMENT") {
      values.originalTotal = { formula: `ROUND(SUM(H${excelRow.number}:O${excelRow.number}),2)` };
      values.cnyTotal = { formula: `ROUND(Q${excelRow.number}*P${excelRow.number},2)` };
      excelRow.getCell("originalTotal").value = values.originalTotal;
      excelRow.getCell("cnyTotal").value = values.cnyTotal;
    }
    for (const definition of columns) {
      const cell = excelRow.getCell(definition.key);
      cell.font = { name: "Microsoft YaHei", size: 10 };
      cell.alignment = { vertical: "middle", horizontal: definition.kind === "text" ? "left" : "right" };
      if (["money", "quantity", "computed-money"].includes(definition.kind)) cell.numFmt = '#,##0.00;[Red]-#,##0.00;0.00';
      if (definition.kind === "rate") cell.numFmt = "0.00000000";
    }
    excelRow.commit();
    count += 1;
  }
  sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(columns.length).letter}1` };
  sheet.commit();
  await workbook.commit();
  return count;
}
