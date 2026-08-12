const VISIBLE_EDGE_LENGTH = 4;

/** Presentation-only abbreviation; the underlying diagnostic reference stays intact. */
export function compactDiagnosticId(value: string): string {
  const characters = [...value];
  if (characters.length <= VISIBLE_EDGE_LENGTH * 2 + 1) return value;
  return `${characters.slice(0, VISIBLE_EDGE_LENGTH).join("")}…${characters.slice(-VISIBLE_EDGE_LENGTH).join("")}`;
}

export function diagnosticClipboardText(value: string): string {
  return `诊断ID: ${value}`;
}
