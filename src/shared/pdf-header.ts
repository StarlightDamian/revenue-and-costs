const PDF_HEADER = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]);

/**
 * PDF readers commonly tolerate a short preamble before the file header. Keep
 * that compatibility window explicit so a marker later in ordinary text does
 * not make the whole file a PDF.
 */
export const PDF_HEADER_MAX_LEADING_BYTES = 1_024;
export const PDF_HEADER_PROBE_BYTES = PDF_HEADER_MAX_LEADING_BYTES + PDF_HEADER.byteLength;

export function hasPdfHeaderInLeadingBytes(bytes: Uint8Array): boolean {
  const lastStart = Math.min(PDF_HEADER_MAX_LEADING_BYTES, bytes.byteLength - PDF_HEADER.byteLength);
  for (let start = 0; start <= lastStart; start += 1) {
    let matches = true;
    for (let offset = 0; offset < PDF_HEADER.byteLength; offset += 1) {
      if (bytes[start + offset] !== PDF_HEADER[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}
