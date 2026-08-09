const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const UUID_HEX = /^[0-9a-f]{32}$/u;

export type DiagnosticReferenceKind = "C" | "I" | "P" | "E";

/**
 * Converts an existing random UUID into a compact, reversible support reference.
 * The value contains no customer text and is not an authorization credential.
 */
export function diagnosticReferenceId(kind: DiagnosticReferenceKind, uuid: string): string {
  const hex = uuid.replaceAll("-", "").toLowerCase();
  if (!UUID_HEX.test(hex)) throw new Error("INVALID_DIAGNOSTIC_REFERENCE_UUID");
  let value = BigInt(`0x${hex}`);
  let encoded = "";
  do {
    encoded = ALPHABET[Number(value % 62n)]! + encoded;
    value /= 62n;
  } while (value > 0n);
  return `${kind}${encoded.padStart(22, "0")}`;
}

export function diagnosticReferenceUuid(reference: string): { kind: DiagnosticReferenceKind; uuid: string } {
  const kind = reference[0] as DiagnosticReferenceKind;
  if (!(["C", "I", "P", "E"] as const).includes(kind) || reference.length !== 23) {
    throw new Error("INVALID_DIAGNOSTIC_REFERENCE");
  }
  let value = 0n;
  for (const character of reference.slice(1)) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0) throw new Error("INVALID_DIAGNOSTIC_REFERENCE");
    value = value * 62n + BigInt(digit);
  }
  const hex = value.toString(16).padStart(32, "0");
  if (hex.length !== 32) throw new Error("INVALID_DIAGNOSTIC_REFERENCE");
  return {
    kind,
    uuid: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
  };
}
