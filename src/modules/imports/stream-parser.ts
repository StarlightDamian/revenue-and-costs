import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { parse } from "csv-parse";
import { matchHeader, normalizeHeader } from "../mappings/validate.js";
import type { FieldMappingDefinition } from "../mappings/types.js";
import type { PrefixAnalysis } from "./analyze-prefix.js";

export interface MappedImportRow {
  readonly sourceRowNumber: string;
  readonly rowHash: string;
  readonly values: Readonly<Record<string, string>>;
}

export interface ImportParserProfiling {
  readonly headerCellsExamined: number;
  readonly headerMatchMs: number;
  readonly projectionMs: number;
  readonly rowHashMs: number;
  readonly onRowMs: number;
}

async function* decodeChunks(chunks: AsyncIterable<Uint8Array>, encoding: string): AsyncGenerator<string> {
  const decoder = new TextDecoder(encoding, { fatal: true });
  for await (const chunk of chunks) {
    const decoded = decoder.decode(chunk, { stream: true });
    if (decoded) yield decoded;
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

function compileRepeatedHeaderMatcher(headers: readonly string[]): (
  record: readonly string[],
  profiling?: { headerCellsExamined: number },
) => boolean {
  const expected = headers.map(normalizeHeader);
  return (record, profiling) => {
    if (record.length !== expected.length) return false;
    for (let index = 0; index < expected.length; index += 1) {
      if (profiling) profiling.headerCellsExamined += 1;
      if (normalizeHeader(record[index] ?? "") !== expected[index]) return false;
    }
    return true;
  };
}

/**
 * Parses a newly-opened object stream after bounded prefix analysis. Rows are
 * delivered one at a time and never accumulated, so callers can write them to
 * PostgreSQL COPY with backpressure.
 */
export async function parseMappedDelimitedStream(input: {
  readonly chunks: AsyncIterable<Uint8Array>;
  readonly analysis: PrefixAnalysis;
  readonly mapping: FieldMappingDefinition;
  readonly profile?: boolean;
  readonly onRow: (row: MappedImportRow) => Promise<void>;
}): Promise<{ readonly parsedRows: string; readonly repeatedHeaders: string; readonly profiling?: ImportParserProfiling }> {
  if (
    input.analysis.status !== "MATCHED" ||
    !input.analysis.encoding ||
    !input.analysis.delimiter ||
    !input.analysis.headerLine ||
    !input.analysis.headerLineNumber
  ) throw new Error("CONFIRMED_PREFIX_ANALYSIS_REQUIRED");

  const headerParser = parse(input.analysis.headerLine, {
    delimiter: input.analysis.delimiter,
    bom: true,
    relax_column_count: false,
  });
  const headerRecords: string[][] = [];
  for await (const record of headerParser) headerRecords.push(record as string[]);
  const headers = headerRecords[0];
  if (!headers || headerRecords.length !== 1) throw new Error("INVALID_CONFIRMED_HEADER");
  const mappingIndexes = matchHeader(headers, input.mapping);
  if (!mappingIndexes) throw new Error("MAPPING_NO_LONGER_MATCHES_HEADER");
  const isRepeatedHeader = compileRepeatedHeaderMatcher(headers);

  const parser = parse({
    delimiter: input.analysis.delimiter,
    bom: true,
    from_line: Number(input.analysis.headerLineNumber) + 1,
    skip_empty_lines: true,
    relax_column_count: false,
    info: true,
  });
  Readable.from(decodeChunks(input.chunks, input.analysis.encoding)).pipe(parser);

  let parsedRows = 0n;
  let repeatedHeaders = 0n;
  const profiling = input.profile
    ? { headerCellsExamined: 0, headerMatchMs: 0, projectionMs: 0, rowHashMs: 0, onRowMs: 0 }
    : undefined;
  for await (const rawRecord of parser) {
    const parsed = rawRecord as { record: string[]; info: { lines: number } };
    const record = parsed.record;
    const headerStarted = profiling ? performance.now() : 0;
    const repeatedHeader = isRepeatedHeader(record, profiling);
    if (profiling) profiling.headerMatchMs += performance.now() - headerStarted;
    if (repeatedHeader) {
      repeatedHeaders += 1n;
      continue;
    }
    const projectionStarted = profiling ? performance.now() : 0;
    const values: Record<string, string> = {};
    for (const [canonical, index] of mappingIndexes) values[canonical] = record[index] ?? "";
    if (profiling) profiling.projectionMs += performance.now() - projectionStarted;
    const hashStarted = profiling ? performance.now() : 0;
    const rowHash = createHash("sha256")
      .update(input.analysis.encoding)
      .update("\0")
      // Hash the complete logical row, including columns that are intentionally
      // not persisted (for example buyer PII). Equal financial projections are
      // still legitimate separate source rows.
      .update(JSON.stringify(record))
      .digest("hex");
    if (profiling) profiling.rowHashMs += performance.now() - hashStarted;
    parsedRows += 1n;
    const onRowStarted = profiling ? performance.now() : 0;
    await input.onRow({ sourceRowNumber: String(parsed.info.lines), rowHash, values });
    if (profiling) profiling.onRowMs += performance.now() - onRowStarted;
  }
  return {
    parsedRows: parsedRows.toString(),
    repeatedHeaders: repeatedHeaders.toString(),
    ...(profiling ? { profiling } : {}),
  };
}
