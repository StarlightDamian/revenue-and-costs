import { UPLOAD_FILE_IO_CONCURRENCY } from "../../shared/upload-limits";

export interface DroppedFile {
  readonly file: File;
  readonly relativePath: string;
}

export interface MergedFileSelection {
  readonly files: readonly DroppedFile[];
  readonly added: number;
  readonly replaced: number;
}

interface BrowserFileEntry {
  readonly isFile: true;
  readonly isDirectory: false;
  readonly name: string;
  readonly fullPath: string;
  file(success: (file: File) => void, failure?: (error: DOMException) => void): void;
}

interface BrowserDirectoryReader {
  readEntries(success: (entries: BrowserEntry[]) => void, failure?: (error: DOMException) => void): void;
}

interface BrowserDirectoryEntry {
  readonly isFile: false;
  readonly isDirectory: true;
  readonly name: string;
  readonly fullPath: string;
  createReader(): BrowserDirectoryReader;
}

type BrowserEntry = BrowserFileEntry | BrowserDirectoryEntry;

function normalizedRelativePath(value: string): string {
  return value.replaceAll("\\", "/").normalize("NFC");
}

function compareRelativePath(left: DroppedFile, right: DroppedFile): number {
  return left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0;
}

export function mergeFileSelections(
  existing: readonly DroppedFile[],
  incoming: readonly DroppedFile[],
): MergedFileSelection {
  const files: DroppedFile[] = [];
  const indexByPath = new Map<string, number>();
  for (const item of existing) {
    const relativePath = normalizedRelativePath(item.relativePath);
    const normalized = { file: item.file, relativePath };
    const index = indexByPath.get(relativePath);
    if (index === undefined) {
      indexByPath.set(relativePath, files.length);
      files.push(normalized);
    } else {
      files[index] = normalized;
    }
  }

  let added = 0;
  let replaced = 0;
  for (const item of incoming) {
    const relativePath = normalizedRelativePath(item.relativePath);
    const normalized = { file: item.file, relativePath };
    const index = indexByPath.get(relativePath);
    if (index === undefined) {
      indexByPath.set(relativePath, files.length);
      files.push(normalized);
      added += 1;
    } else {
      files[index] = normalized;
      replaced += 1;
    }
  }
  files.sort(compareRelativePath);
  return { files, added, replaced };
}

function pathOf(entry: BrowserEntry, fallback: string): string {
  const normalized = normalizedRelativePath(entry.fullPath).replace(/^\/+|\/+$/gu, "");
  return normalized || fallback;
}

function entryFile(entry: BrowserFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function directoryEntries(entry: BrowserDirectoryEntry): Promise<BrowserEntry[]> {
  const reader = entry.createReader();
  const result: BrowserEntry[] = [];
  while (true) {
    const chunk = await new Promise<BrowserEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (chunk.length === 0) return result;
    result.push(...chunk);
  }
}

async function flattenEntries(roots: readonly BrowserEntry[]): Promise<DroppedFile[]> {
  const pending = [...roots];
  const files: DroppedFile[] = [];
  while (pending.length > 0) {
    const batch = pending.splice(0, UPLOAD_FILE_IO_CONCURRENCY);
    const expanded = await Promise.all(batch.map(async (entry) => {
      if (entry.isFile) {
        const file = await entryFile(entry);
        return { file, relativePath: pathOf(entry, file.name) } as DroppedFile;
      }
      return directoryEntries(entry);
    }));
    for (const result of expanded) {
      if (Array.isArray(result)) pending.push(...result);
      else files.push(result);
    }
  }
  return files;
}

export async function collectDroppedFiles(transfer: DataTransfer): Promise<DroppedFile[]> {
  const roots: BrowserEntry[] = [];
  const looseFiles: File[] = [];
  for (const item of Array.from(transfer.items)) {
    if (item.kind !== "file") continue;
    const getEntry = (item as unknown as { webkitGetAsEntry?: () => BrowserEntry | null }).webkitGetAsEntry;
    const entry = getEntry?.call(item);
    if (entry) roots.push(entry);
    else {
      const file = item.getAsFile();
      if (file) looseFiles.push(file);
    }
  }
  const nested = await flattenEntries(roots);
  const fallback = roots.length === 0 ? Array.from(transfer.files) : looseFiles;
  return [
    ...nested,
    ...fallback.map((file) => ({ file, relativePath: normalizedRelativePath(file.webkitRelativePath || file.name) })),
  ].sort(compareRelativePath);
}
