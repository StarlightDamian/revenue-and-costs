import { createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ZipArchive } from "archiver";
import { afterEach, describe, expect, it } from "vitest";
import { detectFileKind } from "../../src/modules/uploads/file-kind";
import { PDF_HEADER_MAX_LEADING_BYTES } from "../../src/shared/pdf-header";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function makeZip(path: string, entries: readonly string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(path);
    const archive = new ZipArchive({ zlib: { level: 1 } });
    output.once("close", resolvePromise);
    output.once("error", reject);
    archive.once("error", reject);
    archive.pipe(output);
    for (const entry of entries) archive.append("fixture", { name: entry });
    void archive.finalize();
  });
}

describe("content based file detection", () => {
  it("does not trust the extension", async () => {
    const root = await mkdtemp(join(tmpdir(), "file-kind-")); roots.push(root);
    const pdfNamedCsv = join(root, "report.csv"); await writeFile(pdfNamedCsv, "%PDF-1.7\n");
    expect(await detectFileKind(pdfNamedCsv)).toBe("PDF");
  });

  it("recognizes a PDF after a bounded preamble but not a marker later in text", async () => {
    const root = await mkdtemp(join(tmpdir(), "file-kind-pdf-prefix-")); roots.push(root);
    const bomPdf = join(root, "bom.csv");
    await writeFile(bomPdf, Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("\r\n \t%PDF-1.7\nbody"),
    ]));
    expect(await detectFileKind(bomPdf)).toBe("PDF");

    const boundaryPdf = join(root, "boundary.csv");
    await writeFile(boundaryPdf, `${"x".repeat(PDF_HEADER_MAX_LEADING_BYTES)}%PDF-1.7\nbody`);
    expect(await detectFileKind(boundaryPdf)).toBe("PDF");

    const laterText = join(root, "later.csv");
    await writeFile(laterText, `${"x".repeat(PDF_HEADER_MAX_LEADING_BYTES + 1)}%PDF- is mentioned as text`);
    expect(await detectFileKind(laterText)).toBe("TEXT");
  });

  it("recognizes an OOXML spreadsheet container without expanding it as a generic ZIP", async () => {
    const root = await mkdtemp(join(tmpdir(), "file-kind-")); roots.push(root);
    const spreadsheetNamedZip = join(root, "spreadsheet.zip");
    await makeZip(spreadsheetNamedZip, ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml"]);
    expect(await detectFileKind(spreadsheetNamedZip)).toBe("OTHER");

    const genericZipNamedSpreadsheet = join(root, "archive.xlsx");
    await makeZip(genericZipNamedSpreadsheet, ["report.csv"]);
    expect(await detectFileKind(genericZipNamedSpreadsheet)).toBe("ZIP");
  });
});
