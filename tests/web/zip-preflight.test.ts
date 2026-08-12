import { describe, expect, it } from "vitest";
import { preflightZipForPdf, ZIP_PDF_PREFLIGHT_LIMITS } from "../../src/web/uploads/zip-preflight";

const encoder = new TextEncoder();

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function zipBlob(bytes: Uint8Array): Blob {
  return new Blob([toArrayBuffer(bytes)]);
}

function localHeader(name: Uint8Array, contentBytes: number): Uint8Array {
  return concat([
    uint32(0x04034b50), uint16(20), uint16(0x0800), uint16(0),
    uint16(0), uint16(0), uint32(0), uint32(contentBytes), uint32(contentBytes),
    uint16(name.byteLength), uint16(0), name, new Uint8Array(contentBytes),
  ]);
}

function centralHeader(name: Uint8Array, localOffset: number, contentBytes: number): Uint8Array {
  return concat([
    uint32(0x02014b50), uint16(20), uint16(20), uint16(0x0800), uint16(0),
    uint16(0), uint16(0), uint32(0), uint32(contentBytes), uint32(contentBytes),
    uint16(name.byteLength), uint16(0), uint16(0), uint16(0), uint16(0),
    uint32(0), uint32(localOffset), name,
  ]);
}

function makeZip(entries: readonly { name: string; contentBytes?: number }[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const contentBytes = entry.contentBytes ?? 0;
    const local = localHeader(name, contentBytes);
    localParts.push(local);
    centralParts.push(centralHeader(name, localOffset, contentBytes));
    localOffset += local.byteLength;
  }
  const central = concat(centralParts);
  return concat([
    ...localParts,
    central,
    uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length),
    uint32(central.byteLength), uint32(localOffset), uint16(0),
  ]);
}

function overwriteUint16(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint16(offset, value, true);
  return copy;
}

function overwriteUint32(bytes: Uint8Array, offset: number, value: number): Uint8Array {
  const copy = bytes.slice();
  new DataView(copy.buffer).setUint32(offset, value, true);
  return copy;
}

describe("browser ZIP PDF preflight", () => {
  it("allows an ordinary ZIP whose central directory has no PDF path", async () => {
    const source = zipBlob(makeZip([{ name: "US/transaction.csv" }, { name: "notes/readme.txt" }]));

    await expect(preflightZipForPdf(source)).resolves.toEqual({ allowed: true, entryCount: 2 });
  });

  it("rejects the whole ZIP when an entry path ends in .pdf", async () => {
    const source = zipBlob(makeZip([{ name: "US/transaction.csv" }, { name: "docs/invoice.pdf" }]));

    await expect(preflightZipForPdf(source)).resolves.toMatchObject({
      allowed: false,
      reason: "PDF_ENTRY",
      entryName: "docs/invoice.pdf",
    });
  });

  it("matches the PDF suffix case-insensitively", async () => {
    const source = zipBlob(makeZip([{ name: "Docs/INVOICE.PdF" }]));

    await expect(preflightZipForPdf(source)).resolves.toMatchObject({ allowed: false, reason: "PDF_ENTRY" });
  });

  it("does not treat a pseudo-suffix or directory name as a PDF file", async () => {
    const source = zipBlob(makeZip([
      { name: "docs/invoice.pdf.txt" },
      { name: "docs/pdf" },
      { name: "docs/archive.pdf/" },
    ]));

    await expect(preflightZipForPdf(source)).resolves.toEqual({ allowed: true, entryCount: 3 });
  });

  it("fails closed when the EOCD is missing", async () => {
    const damaged = makeZip([{ name: "safe.csv" }]).slice(0, -22);

    await expect(preflightZipForPdf(zipBlob(damaged))).resolves.toMatchObject({
      allowed: false,
      reason: "EOCD_MISSING",
    });
  });

  it("fails closed for ZIP64 and multi-disk markers", async () => {
    const ordinary = makeZip([{ name: "safe.csv" }]);
    const eocdOffset = ordinary.byteLength - 22;
    const zip64 = overwriteUint16(ordinary, eocdOffset + 10, 0xffff);
    const multiDisk = overwriteUint16(ordinary, eocdOffset + 4, 1);

    await expect(preflightZipForPdf(zipBlob(zip64))).resolves.toMatchObject({
      allowed: false,
      reason: "ZIP64_UNSUPPORTED",
    });
    await expect(preflightZipForPdf(zipBlob(multiDisk))).resolves.toMatchObject({
      allowed: false,
      reason: "MULTI_DISK_UNSUPPORTED",
    });
  });

  it("fails closed for an out-of-bounds or truncated central directory", async () => {
    const ordinary = makeZip([{ name: "safe.csv" }]);
    const eocdOffset = ordinary.byteLength - 22;
    const wrongOffset = overwriteUint32(ordinary, eocdOffset + 16, eocdOffset + 1);
    const centralSignatureOffset = 30 + encoder.encode("safe.csv").byteLength;
    const truncatedHeader = overwriteUint16(ordinary, centralSignatureOffset + 28, 100);

    await expect(preflightZipForPdf(zipBlob(wrongOffset))).resolves.toMatchObject({
      allowed: false,
      reason: "CENTRAL_DIRECTORY_OUT_OF_BOUNDS",
    });
    await expect(preflightZipForPdf(zipBlob(truncatedHeader))).resolves.toMatchObject({
      allowed: false,
      reason: "CENTRAL_DIRECTORY_TRUNCATED",
    });
  });

  it("enforces the entry-count and central-directory byte limits before parsing", async () => {
    const ordinary = makeZip([{ name: "safe.csv" }]);
    const eocdOffset = ordinary.byteLength - 22;
    const tooManyOnDisk = overwriteUint16(ordinary, eocdOffset + 8, ZIP_PDF_PREFLIGHT_LIMITS.maxEntries + 1);
    const tooMany = overwriteUint16(tooManyOnDisk, eocdOffset + 10, ZIP_PDF_PREFLIGHT_LIMITS.maxEntries + 1);
    const tooLarge = overwriteUint32(
      ordinary,
      eocdOffset + 12,
      ZIP_PDF_PREFLIGHT_LIMITS.maxCentralDirectoryBytes + 1,
    );

    await expect(preflightZipForPdf(zipBlob(tooMany))).resolves.toMatchObject({
      allowed: false,
      reason: "TOO_MANY_ENTRIES",
    });
    await expect(preflightZipForPdf(zipBlob(tooLarge))).resolves.toMatchObject({
      allowed: false,
      reason: "CENTRAL_DIRECTORY_TOO_LARGE",
    });
  });

  it("reads bounded Blob slices and never materializes the whole source", async () => {
    class TrackingBlob extends Blob {
      readonly slices: { start: number; end: number }[] = [];

      override slice(start = 0, end = this.size, contentType?: string): Blob {
        this.slices.push({ start, end });
        return super.slice(start, end, contentType);
      }

      override arrayBuffer(): Promise<ArrayBuffer> {
        throw new Error("source.arrayBuffer() must not be called");
      }
    }

    const source = new TrackingBlob([toArrayBuffer(makeZip([{ name: "large.csv", contentBytes: 1024 * 1024 }]))]);
    await expect(preflightZipForPdf(source)).resolves.toEqual({ allowed: true, entryCount: 1 });

    expect(source.slices.length).toBeGreaterThan(0);
    expect(source.slices.every(({ start, end }) => end - start <= ZIP_PDF_PREFLIGHT_LIMITS.maxCentralDirectoryBytes)).toBe(true);
    expect(source.slices.reduce((total, { start, end }) => total + end - start, 0)).toBeLessThan(source.size);
    const firstSlice = source.slices[0];
    if (!firstSlice) throw new Error("expected a bounded ZIP tail read");
    expect(firstSlice.end - firstSlice.start).toBeLessThanOrEqual(ZIP_PDF_PREFLIGHT_LIMITS.maxTailBytes);
  });
});
