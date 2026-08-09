import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import ExcelJS from "exceljs";

import type { FieldMappingDefinition } from "../mappings/types.js";
import { matchHeader, normalizeHeader } from "../mappings/validate.js";
import type { MappingCandidate } from "./analyze-prefix.js";
import type { MappedImportRow } from "./stream-parser.js";

const MAX_HEADER_ROWS = 200;
const MAX_COLUMNS = 1_024;
const MAX_SHARED_STRING_COUNT = 250_000;
const MAX_SHARED_STRING_BYTES = 32 * 1024 * 1024;

export const XLSX_IMPORT_ENCODING = "xlsx";

export interface XlsxAnalysis {
  readonly status: "MATCHED" | "AWAITING_MAPPING" | "UNSUPPORTED";
  readonly mappingVersionId?: string;
  readonly headerLineNumber?: string;
  readonly reason?: string;
}

export type XlsxStreamFactory = () => AsyncIterable<Uint8Array>;

function workbookReader(
  chunks: AsyncIterable<Uint8Array>,
  options: { worksheets: "emit" | "ignore"; sharedStrings: "emit" | "ignore" },
): ExcelJS.stream.xlsx.WorkbookReader {
  const source = chunks instanceof Readable ? chunks : Readable.from(chunks);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(source, {
    worksheets: options.worksheets,
    sharedStrings: options.sharedStrings,
    hyperlinks: "ignore",
    styles: "ignore",
  });
  // ExcelJS 4.4 can encounter worksheet entries after relationships but before
  // workbook.xml and dereferences model.sheets while model is still absent.
  // workbook.xml replaces this placeholder as soon as it is parsed.
  (reader as unknown as { model: { sheets: unknown[] } }).model = { sheets: [] };
  return reader;
}

function sharedStringText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "richText" in value && Array.isArray(value.richText)) {
    return value.richText.map((part) => part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "").join("");
  }
  return value === null || value === undefined ? "" : String(value);
}

async function* worksheets(openChunks: XlsxStreamFactory): AsyncGenerator<ExcelJS.stream.xlsx.WorksheetReader> {
  type SharedStringEvent = { index: number; text: unknown };
  type ReaderInternals = {
    sharedStrings: unknown[];
    workbookRels: unknown[];
  };
  // Pass one consumes only the shared-string dictionary under explicit limits.
  // The encrypted immutable object can be reopened, avoiding a plaintext temp
  // workbook and avoiding ExcelJS's order-sensitive deferred worksheet path.
  const dictionaryReader = workbookReader(openChunks(), { worksheets: "ignore", sharedStrings: "emit" });
  const dictionaryInternals = dictionaryReader as unknown as ReaderInternals;
  const sharedStrings: unknown[] = [];
  dictionaryInternals.sharedStrings = sharedStrings;
  dictionaryInternals.workbookRels = [];
  let sharedStringBytes = 0;
  for await (const event of dictionaryReader.parse() as unknown as AsyncIterable<SharedStringEvent | { eventType: string }>) {
    if (!("index" in event)) continue;
    if (!Number.isSafeInteger(event.index) || event.index < 0 || event.index >= MAX_SHARED_STRING_COUNT) {
      throw new Error("XLSX_SHARED_STRINGS_LIMIT");
    }
    sharedStringBytes += Buffer.byteLength(sharedStringText(event.text), "utf8");
    if (sharedStringBytes > MAX_SHARED_STRING_BYTES) throw new Error("XLSX_SHARED_STRINGS_LIMIT");
    sharedStrings[event.index] = event.text;
  }

  const reader = workbookReader(openChunks(), { worksheets: "emit", sharedStrings: "ignore" });
  const internals = reader as unknown as ReaderInternals;
  internals.sharedStrings = sharedStrings;
  internals.workbookRels = [];
  for await (const worksheet of reader) yield worksheet;
}

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "richText" in value) {
    return value.richText.map((part) => part.text).join("");
  }
  if (typeof value === "object" && "formula" in value) {
    const result = value.result;
    return result instanceof Date ? result.toISOString() : result === null || result === undefined ? "" : String(result);
  }
  return cell.text;
}

function rowValues(row: ExcelJS.Row, minimumColumns = 0): string[] {
  const columns = Math.max(row.cellCount, minimumColumns);
  if (columns > MAX_COLUMNS) throw new Error("XLSX_COLUMN_LIMIT");
  return Array.from({ length: columns }, (_, index) => cellText(row.getCell(index + 1)));
}

function nonEmpty(record: readonly string[]): boolean {
  return record.some((value) => value.trim() !== "");
}

function repeatedHeaderMatcher(headers: readonly string[]): (record: readonly string[]) => boolean {
  const expected = headers.map(normalizeHeader);
  return (record) => record.length === expected.length && record.every((value, index) => normalizeHeader(value) === expected[index]);
}

/**
 * Inspects worksheet rows without loading the workbook or a worksheet into
 * memory. Exactly one worksheet must match exactly one confirmed shipment
 * mapping; unrelated spreadsheets remain list-only.
 */
export async function analyzeXlsxStream(
  openChunks: XlsxStreamFactory,
  mappings: readonly MappingCandidate[],
): Promise<XlsxAnalysis> {
  const matches = new Map<string, { mappingVersionId: string; headerLineNumber: string }>();
  try {
    let worksheetOrdinal = 0;
    for await (const worksheet of worksheets(openChunks)) {
      worksheetOrdinal += 1;
      for await (const row of worksheet) {
        if (row.number > MAX_HEADER_ROWS) continue;
        const record = rowValues(row);
        if (!nonEmpty(record) || record.length < 2) continue;
        for (const mapping of mappings) {
          if (!matchHeader(record, mapping.definition)) continue;
          const signature = `${worksheetOrdinal}\0${mapping.id}\0${record.map(normalizeHeader).join("\0")}`;
          if (!matches.has(signature)) {
            matches.set(signature, { mappingVersionId: mapping.id, headerLineNumber: String(row.number) });
          }
        }
      }
    }
  } catch (error) {
    const reason = error instanceof Error && ["XLSX_SHARED_STRINGS_LIMIT", "XLSX_COLUMN_LIMIT"].includes(error.message)
      ? error.message
      : "XLSX_STRUCTURE_UNSUPPORTED";
    return { status: "UNSUPPORTED", reason };
  }

  const unique = [...matches.values()];
  if (unique.length === 1) return { status: "MATCHED", ...unique[0] };
  if (unique.length > 1) return { status: "AWAITING_MAPPING", reason: "XLSX_MAPPING_AMBIGUOUS" };
  return { status: "UNSUPPORTED", reason: "XLSX_SHIPMENT_HEADER_NOT_FOUND" };
}

/** Streams the single confirmed shipment worksheet and projects only mapped fields. */
export async function parseMappedXlsxStream(input: {
  readonly openChunks: XlsxStreamFactory;
  readonly mapping: FieldMappingDefinition;
  readonly expectedHeaderLineNumber: string;
  readonly onRow: (row: MappedImportRow) => Promise<void>;
}): Promise<{ readonly parsedRows: string; readonly repeatedHeaders: string }> {
  let matchedWorksheets = 0;
  let parsedRows = 0n;
  let repeatedHeaders = 0n;
  let worksheetOrdinal = 0;

  for await (const worksheet of worksheets(input.openChunks)) {
    worksheetOrdinal += 1;
    let mappingIndexes: ReadonlyMap<string, number> | undefined;
    let headers: string[] | undefined;
    let isRepeatedHeader: ((record: readonly string[]) => boolean) | undefined;

    for await (const row of worksheet) {
      const record = rowValues(row, headers?.length ?? 0);
      if (!nonEmpty(record)) continue;

      if (!mappingIndexes && row.number <= MAX_HEADER_ROWS) {
        const candidate = matchHeader(record, input.mapping);
        if (candidate) {
          matchedWorksheets += 1;
          if (matchedWorksheets > 1 || String(row.number) !== input.expectedHeaderLineNumber) {
            throw new Error("MAPPING_NO_LONGER_MATCHES_HEADER");
          }
          mappingIndexes = candidate;
          headers = record;
          isRepeatedHeader = repeatedHeaderMatcher(headers);
          continue;
        }
      }
      if (!mappingIndexes || !headers || !isRepeatedHeader) continue;
      if (isRepeatedHeader(record)) {
        repeatedHeaders += 1n;
        continue;
      }

      const values: Record<string, string> = {};
      for (const [canonical, index] of mappingIndexes) values[canonical] = record[index] ?? "";
      const rowHash = createHash("sha256")
        .update(XLSX_IMPORT_ENCODING)
        .update("\0")
        .update(String(worksheetOrdinal))
        .update("\0")
        .update(JSON.stringify(record))
        .digest("hex");
      parsedRows += 1n;
      await input.onRow({ sourceRowNumber: String(row.number), rowHash, values });
    }
  }

  if (matchedWorksheets !== 1) throw new Error("MAPPING_NO_LONGER_MATCHES_HEADER");
  return { parsedRows: parsedRows.toString(), repeatedHeaders: repeatedHeaders.toString() };
}
