const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_FILE_HEADER_SIGNATURE = 0x02014b50;
const ARCHIVE_EXTRA_DATA_SIGNATURE = 0x08064b50;
const DIGITAL_SIGNATURE = 0x05054b50;
const ZIP64_EXTRA_FIELD_ID = 0x0001;
const UNICODE_PATH_EXTRA_FIELD_ID = 0x7075;

const EOCD_FIXED_BYTES = 22;
const ZIP64_EOCD_LOCATOR_BYTES = 20;
const CENTRAL_FILE_HEADER_BYTES = 46;
const MAX_ZIP_COMMENT_BYTES = 65_535;

export const ZIP_PDF_PREFLIGHT_LIMITS = Object.freeze({
  maxTailBytes: EOCD_FIXED_BYTES + MAX_ZIP_COMMENT_BYTES,
  maxCentralDirectoryBytes: 8 * 1024 * 1024,
  maxEntries: 20_000,
});

export type ZipPdfPreflightRejectReason =
  | "PDF_ENTRY"
  | "EOCD_MISSING"
  | "ZIP64_UNSUPPORTED"
  | "MULTI_DISK_UNSUPPORTED"
  | "TOO_MANY_ENTRIES"
  | "CENTRAL_DIRECTORY_TOO_LARGE"
  | "CENTRAL_DIRECTORY_OUT_OF_BOUNDS"
  | "CENTRAL_DIRECTORY_TRUNCATED"
  | "CENTRAL_DIRECTORY_INVALID"
  | "READ_FAILED";

export type ZipPdfPreflightResult =
  | { readonly allowed: true; readonly entryCount: number }
  | {
    readonly allowed: false;
    readonly reason: ZipPdfPreflightRejectReason;
    readonly message: string;
    readonly entryName?: string;
  };

const REJECTION_MESSAGES = {
  PDF_ENTRY: "ZIP 中包含 PDF。为避免上传 PDF 原文，请改用文件夹上传；本次 ZIP 已全部拒绝。",
  EOCD_MISSING: "无法读取 ZIP 的结束记录，文件可能已损坏或截断；本次 ZIP 未上传。",
  ZIP64_UNSUPPORTED: "暂不支持 ZIP64；本次 ZIP 未上传。请重新打包为普通单卷 ZIP，或改用文件夹上传。",
  MULTI_DISK_UNSUPPORTED: "暂不支持多卷 ZIP；本次 ZIP 未上传。请重新打包为普通单卷 ZIP，或改用文件夹上传。",
  TOO_MANY_ENTRIES: "ZIP 条目过多，无法安全预检；本次 ZIP 未上传。请拆分后重试，或改用文件夹上传。",
  CENTRAL_DIRECTORY_TOO_LARGE: "ZIP 中央目录过大，无法安全预检；本次 ZIP 未上传。请拆分后重试，或改用文件夹上传。",
  CENTRAL_DIRECTORY_OUT_OF_BOUNDS: "ZIP 中央目录位置无效，文件可能已损坏；本次 ZIP 未上传。",
  CENTRAL_DIRECTORY_TRUNCATED: "ZIP 中央目录不完整，文件可能已截断；本次 ZIP 未上传。",
  CENTRAL_DIRECTORY_INVALID: "ZIP 中央目录格式无效，无法安全判定内容；本次 ZIP 未上传。",
  READ_FAILED: "浏览器无法读取 ZIP 的有界预检数据；本次 ZIP 未上传。请重试或改用文件夹上传。",
} satisfies Record<ZipPdfPreflightRejectReason, string>;

class ZipPreflightFailure extends Error {
  constructor(readonly reason: Exclude<ZipPdfPreflightRejectReason, "PDF_ENTRY">) {
    super(reason);
    this.name = "ZipPreflightFailure";
  }
}

function reject(reason: ZipPdfPreflightRejectReason, entryName?: string): ZipPdfPreflightResult {
  return entryName === undefined
    ? { allowed: false, reason, message: REJECTION_MESSAGES[reason] }
    : { allowed: false, reason, message: REJECTION_MESSAGES[reason], entryName };
}

function fail(reason: Exclude<ZipPdfPreflightRejectReason, "PDF_ENTRY">): never {
  throw new ZipPreflightFailure(reason);
}

function uint16(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
}

function uint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

async function readSlice(source: Blob, start: number, end: number): Promise<Uint8Array> {
  const expectedBytes = end - start;
  const bytes = new Uint8Array(await source.slice(start, end).arrayBuffer());
  if (bytes.byteLength !== expectedBytes) fail("CENTRAL_DIRECTORY_TRUNCATED");
  return bytes;
}

function findEocd(tail: Uint8Array): number {
  const candidates: number[] = [];
  for (let offset = tail.byteLength - EOCD_FIXED_BYTES; offset >= 0; offset -= 1) {
    if (uint32(tail, offset) !== EOCD_SIGNATURE) continue;
    const commentBytes = uint16(tail, offset + 20);
    if (offset + EOCD_FIXED_BYTES + commentBytes === tail.byteLength) candidates.push(offset);
  }
  if (candidates.length === 0) fail("EOCD_MISSING");
  // A second EOCD-shaped record in the comment makes the authoritative directory ambiguous.
  if (candidates.length !== 1) fail("CENTRAL_DIRECTORY_INVALID");
  return candidates[0] as number;
}

function hasPdfSuffix(pathBytes: Uint8Array): boolean {
  const length = pathBytes.byteLength;
  if (length < 4 || pathBytes[length - 4] !== 0x2e) return false;
  const p = (pathBytes[length - 3] ?? 0) | 0x20;
  const d = (pathBytes[length - 2] ?? 0) | 0x20;
  const f = (pathBytes[length - 1] ?? 0) | 0x20;
  return p === 0x70 && d === 0x64 && f === 0x66;
}

function displayEntryName(pathBytes: Uint8Array): string {
  const decoded = new TextDecoder("utf-8", { fatal: false }).decode(pathBytes);
  return decoded.length <= 240 ? decoded : `${decoded.slice(0, 237)}...`;
}

function inspectExtraFields(extra: Uint8Array): Uint8Array | undefined {
  let offset = 0;
  let unicodePdfPath: Uint8Array | undefined;
  while (offset < extra.byteLength) {
    if (offset + 4 > extra.byteLength) fail("CENTRAL_DIRECTORY_TRUNCATED");
    const id = uint16(extra, offset);
    const size = uint16(extra, offset + 2);
    const dataStart = offset + 4;
    const dataEnd = dataStart + size;
    if (dataEnd > extra.byteLength) fail("CENTRAL_DIRECTORY_TRUNCATED");
    if (id === ZIP64_EXTRA_FIELD_ID) fail("ZIP64_UNSUPPORTED");
    if (id === UNICODE_PATH_EXTRA_FIELD_ID) {
      if (size < 5 || extra[dataStart] !== 1) fail("CENTRAL_DIRECTORY_INVALID");
      // The first five bytes are version + CRC-32 of the legacy name. Inspecting the
      // advertised Unicode path even when its CRC is bad is deliberately fail-closed.
      const unicodePath = extra.subarray(dataStart + 5, dataEnd);
      if (hasPdfSuffix(unicodePath)) unicodePdfPath = unicodePath;
    }
    offset = dataEnd;
  }
  return unicodePdfPath;
}

function skipArchiveExtraData(centralDirectory: Uint8Array, offset: number): number {
  if (centralDirectory.byteLength - offset < 4 || uint32(centralDirectory, offset) !== ARCHIVE_EXTRA_DATA_SIGNATURE) return offset;
  if (centralDirectory.byteLength - offset < 8) fail("CENTRAL_DIRECTORY_TRUNCATED");
  const recordEnd = offset + 8 + uint32(centralDirectory, offset + 4);
  if (recordEnd > centralDirectory.byteLength) fail("CENTRAL_DIRECTORY_TRUNCATED");
  return recordEnd;
}

function consumeDigitalSignature(centralDirectory: Uint8Array, offset: number): number {
  if (offset === centralDirectory.byteLength) return offset;
  if (centralDirectory.byteLength - offset < 6 || uint32(centralDirectory, offset) !== DIGITAL_SIGNATURE) {
    fail("CENTRAL_DIRECTORY_INVALID");
  }
  const recordEnd = offset + 6 + uint16(centralDirectory, offset + 4);
  if (recordEnd > centralDirectory.byteLength) fail("CENTRAL_DIRECTORY_TRUNCATED");
  return recordEnd;
}

function inspectCentralDirectory(centralDirectory: Uint8Array, expectedEntries: number): ZipPdfPreflightResult {
  let offset = skipArchiveExtraData(centralDirectory, 0);
  for (let entryIndex = 0; entryIndex < expectedEntries; entryIndex += 1) {
    if (centralDirectory.byteLength - offset < CENTRAL_FILE_HEADER_BYTES) fail("CENTRAL_DIRECTORY_TRUNCATED");
    if (uint32(centralDirectory, offset) !== CENTRAL_FILE_HEADER_SIGNATURE) fail("CENTRAL_DIRECTORY_INVALID");

    const compressedBytes = uint32(centralDirectory, offset + 20);
    const expandedBytes = uint32(centralDirectory, offset + 24);
    const nameBytes = uint16(centralDirectory, offset + 28);
    const extraBytes = uint16(centralDirectory, offset + 30);
    const commentBytes = uint16(centralDirectory, offset + 32);
    const startDisk = uint16(centralDirectory, offset + 34);
    const localHeaderOffset = uint32(centralDirectory, offset + 42);
    if (compressedBytes === 0xffffffff || expandedBytes === 0xffffffff || localHeaderOffset === 0xffffffff) {
      fail("ZIP64_UNSUPPORTED");
    }
    if (startDisk === 0xffff) fail("ZIP64_UNSUPPORTED");
    if (startDisk !== 0) fail("MULTI_DISK_UNSUPPORTED");
    if (nameBytes === 0) fail("CENTRAL_DIRECTORY_INVALID");

    const nameStart = offset + CENTRAL_FILE_HEADER_BYTES;
    const extraStart = nameStart + nameBytes;
    const commentStart = extraStart + extraBytes;
    const recordEnd = commentStart + commentBytes;
    if (recordEnd > centralDirectory.byteLength) fail("CENTRAL_DIRECTORY_TRUNCATED");

    const rawPath = centralDirectory.subarray(nameStart, extraStart);
    const unicodePdfPath = inspectExtraFields(centralDirectory.subarray(extraStart, commentStart));
    const pdfPath = hasPdfSuffix(rawPath) ? rawPath : unicodePdfPath;
    if (pdfPath) return reject("PDF_ENTRY", displayEntryName(pdfPath));
    offset = recordEnd;
  }

  offset = consumeDigitalSignature(centralDirectory, offset);
  if (offset !== centralDirectory.byteLength) fail("CENTRAL_DIRECTORY_INVALID");
  return { allowed: true, entryCount: expectedEntries };
}

async function hasZip64Locator(source: Blob, tail: Uint8Array, tailStart: number, eocdOffset: number): Promise<boolean> {
  const locatorStart = tailStart + eocdOffset - ZIP64_EOCD_LOCATOR_BYTES;
  if (locatorStart < 0) return false;
  const relativeStart = locatorStart - tailStart;
  if (relativeStart >= 0) return uint32(tail, relativeStart) === ZIP64_EOCD_LOCATOR_SIGNATURE;
  const locator = await readSlice(source, locatorStart, locatorStart + ZIP64_EOCD_LOCATOR_BYTES);
  return uint32(locator, 0) === ZIP64_EOCD_LOCATOR_SIGNATURE;
}

async function inspectZip(source: Blob): Promise<ZipPdfPreflightResult> {
  if (!Number.isSafeInteger(source.size) || source.size < EOCD_FIXED_BYTES) fail("EOCD_MISSING");
  const tailStart = Math.max(0, source.size - ZIP_PDF_PREFLIGHT_LIMITS.maxTailBytes);
  const tail = await readSlice(source, tailStart, source.size);
  const eocdOffset = findEocd(tail);
  const absoluteEocdOffset = tailStart + eocdOffset;

  const currentDisk = uint16(tail, eocdOffset + 4);
  const centralDirectoryDisk = uint16(tail, eocdOffset + 6);
  const entriesOnDisk = uint16(tail, eocdOffset + 8);
  const totalEntries = uint16(tail, eocdOffset + 10);
  const centralDirectoryBytes = uint32(tail, eocdOffset + 12);
  const centralDirectoryOffset = uint32(tail, eocdOffset + 16);

  const hasZip64Sentinel = currentDisk === 0xffff
    || centralDirectoryDisk === 0xffff
    || entriesOnDisk === 0xffff
    || totalEntries === 0xffff
    || centralDirectoryBytes === 0xffffffff
    || centralDirectoryOffset === 0xffffffff;
  if (hasZip64Sentinel || await hasZip64Locator(source, tail, tailStart, eocdOffset)) fail("ZIP64_UNSUPPORTED");
  if (currentDisk !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== totalEntries) {
    fail("MULTI_DISK_UNSUPPORTED");
  }
  if (totalEntries > ZIP_PDF_PREFLIGHT_LIMITS.maxEntries) fail("TOO_MANY_ENTRIES");
  if (centralDirectoryBytes > ZIP_PDF_PREFLIGHT_LIMITS.maxCentralDirectoryBytes) {
    fail("CENTRAL_DIRECTORY_TOO_LARGE");
  }

  const centralDirectoryEnd = centralDirectoryOffset + centralDirectoryBytes;
  if (!Number.isSafeInteger(centralDirectoryEnd)
    || centralDirectoryEnd !== absoluteEocdOffset
    || centralDirectoryEnd > source.size) {
    fail("CENTRAL_DIRECTORY_OUT_OF_BOUNDS");
  }
  if ((totalEntries === 0) !== (centralDirectoryBytes === 0)) fail("CENTRAL_DIRECTORY_INVALID");

  const centralStartInTail = centralDirectoryOffset - tailStart;
  const centralDirectory = centralStartInTail >= 0
    ? tail.subarray(centralStartInTail, centralStartInTail + centralDirectoryBytes)
    : await readSlice(source, centralDirectoryOffset, centralDirectoryEnd);
  if (centralDirectory.byteLength !== centralDirectoryBytes) fail("CENTRAL_DIRECTORY_TRUNCATED");
  return inspectCentralDirectory(centralDirectory, totalEntries);
}

/**
 * Reads only the bounded ZIP tail and central directory. It never expands entries
 * and never calls arrayBuffer() on the source Blob itself.
 */
export async function preflightZipForPdf(source: Blob): Promise<ZipPdfPreflightResult> {
  try {
    return await inspectZip(source);
  } catch (error) {
    return error instanceof ZipPreflightFailure ? reject(error.reason) : reject("READ_FAILED");
  }
}
