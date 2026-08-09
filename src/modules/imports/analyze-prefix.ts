import { matchHeader } from "../mappings/validate.js";
import type { FieldMappingDefinition } from "../mappings/types.js";

const MAX_PREFIX_BYTES = 512 * 1024;
const CANDIDATE_ENCODINGS = ["utf-8", "utf-16le", "utf-16be", "gb18030", "shift_jis", "windows-1252"] as const;

export interface PrefixAnalysis {
  readonly status: "MATCHED" | "AWAITING_MAPPING" | "UNSUPPORTED";
  readonly encoding?: string;
  readonly delimiter?: "," | "\t";
  readonly headerLine?: string;
  readonly headerLineNumber?: string;
  readonly mappingVersionId?: string;
  readonly reason?: string;
}

export interface MappingCandidate {
  readonly id: string;
  readonly definition: FieldMappingDefinition;
}

function parseDelimitedLine(line: string, delimiter: string): string[] | undefined {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) return undefined;
  cells.push(cell);
  return cells;
}

function decode(bytes: Uint8Array, encoding: string): string | undefined {
  try {
    // `stream: true` avoids treating a bounded prefix ending mid-codepoint as an
    // invalid encoding. Invalid sequences before the boundary still fail.
    return new TextDecoder(encoding, { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return undefined;
  }
}

export function analyzeDelimitedPrefix(
  input: Uint8Array,
  mappings: readonly MappingCandidate[],
): PrefixAnalysis {
  const bytes = input.subarray(0, MAX_PREFIX_BYTES);
  const utf8 = decode(bytes, "utf-8");
  // A valid, non-UTF-16 UTF-8 stream is authoritative. Trying permissive
  // single-byte decoders as well can turn optional accented headers into
  // mojibake while the required ASCII headers still match, creating a false
  // ambiguity for one physical file.
  const candidateEncodings = utf8 !== undefined && !utf8.includes("\u0000")
    ? (["utf-8"] as const)
    : CANDIDATE_ENCODINGS;
  const matches: Array<Required<Pick<PrefixAnalysis, "encoding" | "delimiter" | "headerLine" | "headerLineNumber" | "mappingVersionId">>> = [];

  for (const encoding of candidateEncodings) {
    const decoded = decode(bytes, encoding);
    if (decoded === undefined || decoded.includes("\u0000") && !encoding.startsWith("utf-16")) continue;
    const lines = decoded.replace(/^\uFEFF/u, "").split(/\r?\n/u).slice(0, 200);
    for (const [lineIndex, line] of lines.entries()) {
      if (!line.trim()) continue;
      for (const delimiter of [",", "\t"] as const) {
        const headers = parseDelimitedLine(line, delimiter);
        if (!headers || headers.length < 2) continue;
        for (const mapping of mappings) {
          if (matchHeader(headers, mapping.definition)) {
            matches.push({
              encoding,
              delimiter,
              headerLine: line,
              headerLineNumber: String(lineIndex + 1),
              mappingVersionId: mapping.id,
            });
          }
        }
      }
    }
  }

  const unique = matches.filter((match, index) => matches.findIndex((candidate) =>
    candidate.delimiter === match.delimiter &&
    candidate.headerLineNumber === match.headerLineNumber &&
    candidate.headerLine === match.headerLine &&
    candidate.mappingVersionId === match.mappingVersionId,
  ) === index);
  const signatures = new Map<string, typeof unique[number]>();
  for (const match of unique) {
    const signature = `${match.delimiter}\u0000${match.mappingVersionId}\u0000${match.headerLine}`;
    const prior = signatures.get(signature);
    if (!prior || BigInt(match.headerLineNumber) < BigInt(prior.headerLineNumber)) signatures.set(signature, match);
  }
  const representatives = [...signatures.values()];
  if (representatives.length === 1) return { status: "MATCHED", ...representatives[0] };
  if (representatives.length > 1) {
    return { status: "AWAITING_MAPPING", reason: "多个编码、表头或映射同时匹配，需要管理员确认" };
  }
  return { status: "AWAITING_MAPPING", reason: "没有已确认映射能完整匹配必需表头" };
}

export function classifyInput(relativePath: string, prefix: Uint8Array): "PARSE" | "LIST_ONLY" | "TEMPORARY" {
  const leaf = relativePath.replaceAll("\\", "/").split("/").at(-1) ?? relativePath;
  if (leaf.startsWith("~$")) return "TEMPORARY";
  if (prefix[0] === 0x25 && prefix[1] === 0x50 && prefix[2] === 0x44 && prefix[3] === 0x46) return "LIST_ONLY";
  // Names are diagnostics only. A file participates only when its content is
  // decodable text with a structural comma or tab delimiter.
  for (const encoding of CANDIDATE_ENCODINGS) {
    const text = decode(prefix.subarray(0, MAX_PREFIX_BYTES), encoding);
    if (text === undefined) continue;
    if (text.split(/\r?\n/u).slice(0, 200).some((line) => {
      const comma = parseDelimitedLine(line, ",");
      const tab = parseDelimitedLine(line, "\t");
      return (comma?.length ?? 0) >= 2 || (tab?.length ?? 0) >= 2;
    })) return "PARSE";
  }
  return "LIST_ONLY";
}

export function assertRowConservation(input: {
  readonly read: string;
  readonly inserted: string;
  readonly excluded: string;
  readonly errored: string;
}): void {
  const values = Object.values(input).map((value) => BigInt(value));
  if (values.some((value) => value < 0n)) throw new Error("NEGATIVE_ROW_COUNT");
  if (values[0] !== values[1]! + values[2]! + values[3]!) {
    throw new Error("ROW_CONSERVATION_VIOLATION");
  }
}
