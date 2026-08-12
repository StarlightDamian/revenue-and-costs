import { posix } from "node:path";
import { createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { hasPdfHeaderInLeadingBytes, PDF_HEADER_PROBE_BYTES } from "../../shared/pdf-header";

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: bigint;
  maxExpandedBytes: bigint;
  maxRatio: number;
  maxPathBytes: number;
  maxSegmentBytes: number;
  maxIdleMs: number;
  maxDurationMs: number;
}

export const defaultZipLimits: ZipLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 2n * 1024n * 1024n * 1024n,
  maxExpandedBytes: 8n * 1024n * 1024n * 1024n,
  maxRatio: 100,
  maxPathBytes: 1_024,
  maxSegmentBytes: 255,
  maxIdleMs: 15 * 60 * 1_000,
  maxDurationMs: 6 * 60 * 60 * 1_000,
};

export const ooxmlZipLimits: ZipLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 64n * 1024n * 1024n,
  maxExpandedBytes: 256n * 1024n * 1024n,
  maxRatio: 100,
  maxPathBytes: 1_024,
  maxSegmentBytes: 255,
  maxIdleMs: 60_000,
  maxDurationMs: 15 * 60_000,
};

export interface ZipEntryReport { path: string; compressedBytes: bigint; expandedBytes: bigint; directory: boolean }
export interface ExtractedZipEntry extends ZipEntryReport { destinationPath: string }

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => yauzl.open(path, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => error || !zip ? reject(error ?? new Error("ZIP_OPEN_FAILED")) : resolve(zip)));
}

function validatePath(path: string, limits: ZipLimits): string {
  const normalized = path.replaceAll("\\", "/");
  if (Buffer.byteLength(normalized, "utf8") > limits.maxPathBytes || normalized.includes("\0") || /^[A-Za-z]:/.test(normalized) || normalized.startsWith("/") || normalized.startsWith("//")) throw new Error("ZIP_UNSAFE_PATH");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((part) => part === "." || part === ".." || Buffer.byteLength(part, "utf8") > limits.maxSegmentBytes)) throw new Error("ZIP_UNSAFE_PATH");
  const clean = posix.normalize(normalized);
  if (clean.startsWith("../") || clean === "..") throw new Error("ZIP_UNSAFE_PATH");
  return clean;
}

function validateUnixType(entry: Entry): void {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const kind = mode & 0xf000;
  if ([0xa000, 0x6000, 0x2000, 0x1000, 0xc000].includes(kind)) throw new Error("ZIP_SPECIAL_FILE_REJECTED");
}

function hasZipMagic(prefix: Buffer): boolean {
  return prefix.length >= 4
    && prefix[0] === 0x50
    && prefix[1] === 0x4b
    && ((prefix[2] === 0x03 && prefix[3] === 0x04)
      || (prefix[2] === 0x05 && prefix[3] === 0x06)
      || (prefix[2] === 0x07 && prefix[3] === 0x08));
}

function readEntry(zip: ZipFile, entry: Entry, limits: ZipLimits, startedAt: number): Promise<bigint> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(error ?? new Error("ZIP_ENTRY_STREAM_FAILED"));
      let total = 0n;
      const probe = Buffer.alloc(PDF_HEADER_PROBE_BYTES);
      let probeBytes = 0;
      let idle = setTimeout(() => stream.destroy(new Error("ZIP_NO_PROGRESS_TIMEOUT")), limits.maxIdleMs);
      idle.unref();
      stream.on("data", (chunk: Buffer) => {
        clearTimeout(idle);
        if (Date.now() - startedAt > limits.maxDurationMs) return stream.destroy(new Error("ZIP_DURATION_TIMEOUT"));
        if (probeBytes < probe.byteLength) {
          probeBytes += chunk.copy(probe, probeBytes, 0, probe.byteLength - probeBytes);
          const prefix = probe.subarray(0, probeBytes);
          if (hasZipMagic(prefix)) {
            stream.destroy(new Error("ZIP_NESTED_ARCHIVE_REJECTED"));
            return;
          }
          if (hasPdfHeaderInLeadingBytes(prefix)) {
            stream.destroy(new Error("ZIP_PDF_ENTRY_REQUIRES_FOLDER_UPLOAD"));
            return;
          }
        }
        total += BigInt(chunk.byteLength);
        if (total > limits.maxEntryBytes) return stream.destroy(new Error("ZIP_ENTRY_TOO_LARGE"));
        idle = setTimeout(() => stream.destroy(new Error("ZIP_NO_PROGRESS_TIMEOUT")), limits.maxIdleMs);
        idle.unref();
      });
      stream.once("error", (streamError) => { clearTimeout(idle); reject(streamError); });
      stream.once("end", () => { clearTimeout(idle); resolve(total); });
    });
  });
}

export async function validateZip(path: string, limits = defaultZipLimits): Promise<ZipEntryReport[]> {
  const zip = await openZip(path);
  const startedAt = Date.now();
  const reports: ZipEntryReport[] = [];
  const names = new Set<string>();
  let expandedTotal = 0n;
  return new Promise((resolve, reject) => {
    const duration = setTimeout(() => fail(new Error("ZIP_DURATION_TIMEOUT")), limits.maxDurationMs);
    duration.unref();
    const fail = (error: unknown): void => { clearTimeout(duration); zip.close(); reject(error); };
    zip.once("error", fail);
    zip.once("end", () => { clearTimeout(duration); zip.close(); resolve(reports); });
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        if (reports.length >= limits.maxEntries) throw new Error("ZIP_TOO_MANY_ENTRIES");
        const name = validatePath(entry.fileName, limits);
        const collisionKey = name.normalize("NFC").toLocaleLowerCase("en-US");
        if (names.has(collisionKey)) throw new Error("ZIP_PATH_COLLISION");
        names.add(collisionKey);
        validateUnixType(entry);
        const directory = /\/$/.test(entry.fileName);
        if (!directory && /\.(?:zip|7z|rar|tar|gz|bz2|xz|jar)$/i.test(name)) throw new Error("ZIP_NESTED_ARCHIVE_REJECTED");
        if (!directory && /\.pdf$/iu.test(name)) throw new Error("ZIP_PDF_ENTRY_REQUIRES_FOLDER_UPLOAD");
        const declared = BigInt(entry.uncompressedSize);
        const compressed = BigInt(entry.compressedSize);
        if (declared > limits.maxEntryBytes || (compressed === 0n ? declared > 0n : declared > compressed * BigInt(limits.maxRatio))) throw new Error("ZIP_RATIO_OR_SIZE_LIMIT");
        const actual = directory ? 0n : await readEntry(zip, entry, limits, startedAt);
        expandedTotal += actual;
        if (expandedTotal > limits.maxExpandedBytes) throw new Error("ZIP_EXPANDED_LIMIT");
        reports.push({ path: name, compressedBytes: compressed, expandedBytes: actual, directory });
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => error || !stream
      ? reject(error ?? new Error("ZIP_ENTRY_STREAM_FAILED"))
      : resolve(stream));
  });
}

/**
 * Extract a validated archive without ever materialising an entry in memory.
 * Validation is deliberately repeated while extracting so the output cannot
 * exceed the limits even if the archive changes between the two passes.
 */
export async function extractValidatedZip(
  archivePath: string,
  destinationRoot: string,
  destinationForEntry: (safePath: string) => string,
  limits = defaultZipLimits,
  beforeWrite?: (reports: readonly ZipEntryReport[]) => Promise<void>,
  beforeEntryWrite?: (report: ZipEntryReport) => Promise<void>,
): Promise<ExtractedZipEntry[]> {
  const reports = await validateZip(archivePath, limits);
  await beforeWrite?.(reports);
  const expected = new Map(reports.filter((entry) => !entry.directory).map((entry) => [entry.path, entry]));
  const root = resolve(destinationRoot);
  const zip = await openZip(archivePath);
  const extracted: ExtractedZipEntry[] = [];
  let total = 0n;
  const startedAt = Date.now();

  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const duration = setTimeout(() => fail(new Error("ZIP_DURATION_TIMEOUT")), limits.maxDurationMs);
    duration.unref();
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(duration);
      zip.close();
      void Promise.all(extracted.map((entry) => unlink(entry.destinationPath).catch(() => undefined)))
        .finally(() => reject(error));
    };
    zip.once("error", fail);
    zip.once("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(duration);
      zip.close();
      resolvePromise(extracted);
    });
    zip.on("entry", (entry: Entry) => {
      void (async () => {
        const safePath = validatePath(entry.fileName, limits);
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        const report = expected.get(safePath);
        if (!report) throw new Error("ZIP_VALIDATION_CHANGED");
        const destination = resolve(destinationForEntry(safePath));
        if (!destination.startsWith(`${root}${sep}`)) throw new Error("ZIP_DESTINATION_ESCAPE");
        await beforeEntryWrite?.(report);
        await mkdir(dirname(destination), { recursive: true });
        await unlink(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        const source = await openEntryStream(zip, entry);
        let actual = 0n;
        const probe = Buffer.alloc(PDF_HEADER_PROBE_BYTES);
        let probeBytes = 0;
        let idle = setTimeout(() => {
          if ("destroy" in source && typeof source.destroy === "function") source.destroy(new Error("ZIP_NO_PROGRESS_TIMEOUT"));
        }, limits.maxIdleMs);
        idle.unref();
        source.on("data", (chunk: Buffer) => {
          clearTimeout(idle);
          if (Date.now() - startedAt > limits.maxDurationMs) {
            if ("destroy" in source && typeof source.destroy === "function") source.destroy(new Error("ZIP_DURATION_TIMEOUT"));
            return;
          }
          if (probeBytes < probe.byteLength) {
            probeBytes += chunk.copy(probe, probeBytes, 0, probe.byteLength - probeBytes);
            const prefix = probe.subarray(0, probeBytes);
            if (hasZipMagic(prefix)) {
              if ("destroy" in source && typeof source.destroy === "function") source.destroy(new Error("ZIP_NESTED_ARCHIVE_REJECTED"));
              return;
            }
            if (hasPdfHeaderInLeadingBytes(prefix)) {
              if ("destroy" in source && typeof source.destroy === "function") source.destroy(new Error("ZIP_PDF_ENTRY_REQUIRES_FOLDER_UPLOAD"));
              return;
            }
          }
          actual += BigInt(chunk.byteLength);
          if (actual > limits.maxEntryBytes || total + actual > limits.maxExpandedBytes) {
            if ("destroy" in source && typeof source.destroy === "function") source.destroy(new Error("ZIP_EXPANDED_LIMIT"));
          }
          idle = setTimeout(() => {
            if ("destroy" in source && typeof source.destroy === "function") source.destroy(new Error("ZIP_NO_PROGRESS_TIMEOUT"));
          }, limits.maxIdleMs);
          idle.unref();
        });
        try {
          await pipeline(source, createWriteStream(destination, { flags: "wx" }));
        } catch (error) {
          await unlink(destination).catch(() => undefined);
          throw error;
        } finally {
          clearTimeout(idle);
        }
        if (actual !== report.expandedBytes) throw new Error("ZIP_ENTRY_SIZE_CHANGED");
        total += actual;
        extracted.push({ ...report, destinationPath: destination });
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
}
