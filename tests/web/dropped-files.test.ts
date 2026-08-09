import { describe, expect, it } from "vitest";
import { collectDroppedFiles } from "../../src/web/uploads/dropped-files";

describe("collectDroppedFiles", () => {
  it("recursively preserves a dropped folder path", async () => {
    const source = new File(["date,amount\n2026-04-01,1"], "transaction.csv", { type: "text/csv" });
    const fileEntry = {
      isFile: true,
      isDirectory: false,
      name: source.name,
      fullPath: "/US/transaction.csv",
      file: (success: (file: File) => void) => success(source),
    };
    let readCount = 0;
    const directoryEntry = {
      isFile: false,
      isDirectory: true,
      name: "US",
      fullPath: "/US",
      createReader: () => ({
        readEntries: (success: (entries: unknown[]) => void) => {
          readCount += 1;
          success(readCount === 1 ? [fileEntry] : []);
        },
      }),
    };
    const transfer = {
      items: [{ kind: "file", webkitGetAsEntry: () => directoryEntry, getAsFile: () => null }],
      files: [],
    } as unknown as DataTransfer;

    const result = await collectDroppedFiles(transfer);

    expect(result).toEqual([{ file: source, relativePath: "US/transaction.csv" }]);
    expect(readCount).toBe(2);
  });

  it("falls back to ordinary dropped files when directory entries are unavailable", async () => {
    const source = new File(["x"], "report.csv", { type: "text/csv" });
    const transfer = {
      items: [],
      files: [source],
    } as unknown as DataTransfer;

    await expect(collectDroppedFiles(transfer)).resolves.toEqual([{ file: source, relativePath: "report.csv" }]);
  });
});
