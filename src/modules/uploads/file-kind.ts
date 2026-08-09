import { open } from "node:fs/promises";
import yauzl from "yauzl";

export type UploadedFileKind = "ZIP" | "PDF" | "TEXT" | "OTHER";

function isOoxmlSpreadsheetContainer(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    yauzl.open(path, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (openError, zip) => {
      if (openError || !zip) {
        resolve(false);
        return;
      }
      const required = new Set(["[content_types].xml", "_rels/.rels", "xl/workbook.xml"]);
      let entries = 0;
      let settled = false;
      const finish = (result: boolean): void => {
        if (settled) return;
        settled = true;
        zip.close();
        resolve(result);
      };
      zip.once("error", () => finish(false));
      zip.once("end", () => finish(required.size === 0));
      zip.on("entry", (entry) => {
        entries += 1;
        if (entries > 20_000) {
          finish(false);
          return;
        }
        required.delete(entry.fileName.replaceAll("\\", "/").toLocaleLowerCase("en-US"));
        if (required.size === 0) finish(true);
        else zip.readEntry();
      });
      zip.readEntry();
    });
  });
}

export async function detectFileKind(path: string): Promise<UploadedFileKind> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(8_192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    const prefix = buffer.subarray(0, bytesRead);
    if (prefix.length >= 4 && prefix[0] === 0x50 && prefix[1] === 0x4b && [0x03, 0x05, 0x07].includes(prefix[2] ?? -1)) {
      return await isOoxmlSpreadsheetContainer(path) ? "OTHER" : "ZIP";
    }
    if (prefix.subarray(0, 5).toString("ascii") === "%PDF-") return "PDF";
    if (!prefix.includes(0) || (prefix[0] === 0xff && prefix[1] === 0xfe) || (prefix[0] === 0xfe && prefix[1] === 0xff)) return "TEXT";
    return "OTHER";
  } finally {
    await handle.close();
  }
}
