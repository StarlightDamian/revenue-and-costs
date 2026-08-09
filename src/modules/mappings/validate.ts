import type { FieldMappingDefinition } from "./types.js";

export function normalizeHeader(header: string): string {
  return header.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("und");
}

export function validateMappingDefinition(definition: FieldMappingDefinition): void {
  if (!definition.locale.trim()) throw new Error("MAPPING_LOCALE_REQUIRED");
  if (definition.fields.length === 0) throw new Error("MAPPING_FIELDS_REQUIRED");

  const canonical = new Set<string>();
  const sources = new Set<string>();
  for (const field of definition.fields) {
    if (!/^[a-z][a-z0-9_]*$/u.test(field.canonical)) {
      throw new Error(`INVALID_CANONICAL_FIELD:${field.canonical}`);
    }
    if (canonical.has(field.canonical)) throw new Error(`DUPLICATE_CANONICAL_FIELD:${field.canonical}`);
    canonical.add(field.canonical);
    if (field.sourceHeaders.length === 0) throw new Error(`SOURCE_HEADER_REQUIRED:${field.canonical}`);
    for (const source of field.sourceHeaders) {
      const normalized = normalizeHeader(source);
      if (!normalized) throw new Error(`EMPTY_SOURCE_HEADER:${field.canonical}`);
      if (sources.has(normalized)) throw new Error(`AMBIGUOUS_SOURCE_HEADER:${source}`);
      sources.add(normalized);
    }
  }
}

export function matchHeader(
  headers: readonly string[],
  definition: FieldMappingDefinition,
): ReadonlyMap<string, number> | undefined {
  validateMappingDefinition(definition);
  const normalizedHeaders = headers.map(normalizeHeader);
  const result = new Map<string, number>();
  for (const field of definition.fields) {
    const aliases = new Set(field.sourceHeaders.map(normalizeHeader));
    const indexes = normalizedHeaders
      .map((header, index) => aliases.has(header) ? index : -1)
      .filter((index) => index >= 0);
    if (indexes.length > 1) throw new Error(`AMBIGUOUS_HEADER_MATCH:${field.canonical}`);
    if (indexes[0] !== undefined) result.set(field.canonical, indexes[0]);
    else if (field.required) return undefined;
  }
  return result;
}
