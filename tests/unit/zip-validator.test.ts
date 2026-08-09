import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipArchive } from "archiver";
import { afterEach, describe, expect, it } from "vitest";
import { extractValidatedZip, validateZip } from "../../src/modules/archive/zip-validator";

const roots: string[] = [];

async function makeZip(root: string, entries: Array<{ name: string; body: string | Buffer }>, fileName = "input.zip"): Promise<string> {
  const outputPath = join(root, fileName);
  const output = createWriteStream(outputPath, { flags: "wx" });
  const archive = new ZipArchive({ zlib: { level: 1 } });
  const finished = new Promise<void>((resolve, reject) => {
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
  });
  archive.pipe(output);
  for (const entry of entries) archive.append(entry.body, { name: entry.name });
  await archive.finalize();
  await finished;
  return outputPath;
}

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("ZIP safety and streaming extraction", () => {
  it("extracts validated entries into caller-selected bounded paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "zip-safe-"));
    roots.push(root);
    const archive = await makeZip(root, [
      { name: "reports/orders.csv", body: "order,amount\nA,1\n" },
      { name: "reports/shipment.txt", body: "sku\tquantity\nS\t1\n" },
    ]);
    const destination = join(root, "out");
    const entries = await extractValidatedZip(archive, destination, (path) => join(destination, path.replaceAll("/", "__")));
    expect(entries.map((entry) => entry.path)).toEqual(["reports/orders.csv", "reports/shipment.txt"]);
    await expect(readFile(entries[0]!.destinationPath, "utf8")).resolves.toContain("A,1");
  });

  it("rejects traversal, nested archives, and ratios over the limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "zip-hostile-"));
    roots.push(root);
    const traversal = await makeZip(root, [{ name: "safe00.csv", body: "x" }], "traversal.zip");
    const bytes = await readFile(traversal);
    const safeName = Buffer.from("safe00.csv");
    const hostileName = Buffer.from("../bad.csv");
    let offset = 0;
    while ((offset = bytes.indexOf(safeName, offset)) !== -1) {
      hostileName.copy(bytes, offset);
      offset += hostileName.byteLength;
    }
    await writeFile(traversal, bytes);
    await expect(validateZip(traversal)).rejects.toThrow(/ZIP_|relative path/i);

    await expect(validateZip(await makeZip(root, [{ name: "nested.zip", body: "PK" }], "nested-case.zip"))).rejects.toThrow("ZIP_NESTED_ARCHIVE_REJECTED");

    const disguisedNestedSource = await makeZip(root, [{ name: "orders.csv", body: "order,amount\nA,1\n" }], "inner-source.zip");
    const disguisedNested = await makeZip(root, [
      { name: "looks-like-a-report.csv", body: await readFile(disguisedNestedSource) },
    ], "disguised-nested-case.zip");
    await expect(validateZip(disguisedNested)).rejects.toThrow("ZIP_NESTED_ARCHIVE_REJECTED");

    const bomb = await makeZip(root, [{ name: "bomb.csv", body: "0".repeat(200_000) }], "bomb-case.zip");
    await expect(validateZip(bomb, {
      maxEntries: 10,
      maxEntryBytes: 1_000_000n,
      maxExpandedBytes: 1_000_000n,
      maxRatio: 2,
      maxPathBytes: 1024,
      maxSegmentBytes: 255,
      maxIdleMs: 1_000,
      maxDurationMs: 10_000,
    })).rejects.toThrow("ZIP_RATIO_OR_SIZE_LIMIT");
  });
});
