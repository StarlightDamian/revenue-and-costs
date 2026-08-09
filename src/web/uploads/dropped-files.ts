export interface DroppedFile {
  readonly file: File;
  readonly relativePath: string;
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

function pathOf(entry: BrowserEntry, fallback: string): string {
  const normalized = entry.fullPath.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
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

async function flattenEntry(entry: BrowserEntry): Promise<DroppedFile[]> {
  if (entry.isFile) {
    const file = await entryFile(entry);
    return [{ file, relativePath: pathOf(entry, file.name) }];
  }
  const children = await directoryEntries(entry);
  return (await Promise.all(children.map(flattenEntry))).flat();
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
  const nested = (await Promise.all(roots.map(flattenEntry))).flat();
  const fallback = roots.length === 0 ? Array.from(transfer.files) : looseFiles;
  return [
    ...nested,
    ...fallback.map((file) => ({ file, relativePath: file.webkitRelativePath || file.name })),
  ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
