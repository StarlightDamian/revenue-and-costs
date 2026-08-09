/* global process */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import Decimal from "decimal.js";
import ExcelJS from "exceljs";

const [baselinePath, candidatePath, outputPath] = process.argv.slice(2);
if (!baselinePath || !candidatePath || !outputPath) {
  throw new Error("usage: node scripts/compare-performance-workbooks.mjs <baseline.xlsx> <candidate.xlsx> <output.json>");
}

const dynamicInfoCells = new Set(["B2", "B3", "B4", "B5", "B6", "B7", "B9", "B10", "B13", "B14"]);

function normalizeFormula(formula) {
  return formula.replace(/VALUE\("(-?\d+(?:\.\d+)?)"\)/gu, (_match, value) =>
    `VALUE("${new Decimal(value).toFixed()}")`);
}

function normalizeValue(sheetName, address, value) {
  if (sheetName === "口径说明" && dynamicInfoCells.has(address)) return "[dynamic-run-identity]";
  if (typeof value === "string") return value.replace(/性能-(开模师|米克|阿尔金)(?:-[A-Za-z0-9_-]+)?/gu, "性能-$1-[fixture]");
  if (value && typeof value === "object" && typeof value.formula === "string") {
    return { ...value, formula: normalizeFormula(value.formula) };
  }
  return value;
}

function stable(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

const baseline = new ExcelJS.Workbook();
const candidate = new ExcelJS.Workbook();
await Promise.all([baseline.xlsx.readFile(baselinePath), candidate.xlsx.readFile(candidatePath)]);

const differences = [];
const sheetContracts = [];
const sheetCount = Math.max(baseline.worksheets.length, candidate.worksheets.length);
for (let index = 0; index < sheetCount; index += 1) {
  const left = baseline.worksheets[index];
  const right = candidate.worksheets[index];
  if (!left || !right || left.name !== right.name) {
    differences.push({ kind: "sheet", index, baseline: left?.name ?? null, candidate: right?.name ?? null });
    continue;
  }
  const rows = Math.max(left.rowCount, right.rowCount);
  const columns = Math.max(left.columnCount, right.columnCount);
  sheetContracts.push({ name: left.name, baseline: { rows: left.rowCount, columns: left.columnCount }, candidate: { rows: right.rowCount, columns: right.columnCount } });
  for (let row = 1; row <= rows; row += 1) {
    for (let column = 1; column <= columns; column += 1) {
      const leftCell = left.getCell(row, column);
      const rightCell = right.getCell(row, column);
      const leftValue = stable(normalizeValue(left.name, leftCell.address, leftCell.value));
      const rightValue = stable(normalizeValue(right.name, rightCell.address, rightCell.value));
      if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
        differences.push({ kind: "value", sheet: left.name, cell: leftCell.address, baseline: leftValue, candidate: rightValue });
      }
      const leftStyle = stable(leftCell.style);
      const rightStyle = stable(rightCell.style);
      if (JSON.stringify(leftStyle) !== JSON.stringify(rightStyle)) {
        differences.push({ kind: "style", sheet: left.name, cell: leftCell.address, baseline: leftStyle, candidate: rightStyle });
      }
    }
  }
}

const result = {
  comparedAt: new Date().toISOString(),
  baselinePath: resolve(baselinePath),
  candidatePath: resolve(candidatePath),
  sheetContracts,
  ignoredDynamicInfoCells: [...dynamicInfoCells],
  normalizedFixtureShopNames: true,
  normalizedZeroFormulaLiterals: true,
  differenceCount: differences.length,
  equivalent: differences.length === 0,
  differences: differences.slice(0, 100),
};
await mkdir(dirname(resolve(outputPath)), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(result)}\n`);
