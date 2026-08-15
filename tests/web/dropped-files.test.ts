import { describe, expect, it } from "vitest";
import { collectDroppedFiles, mergeFileSelections } from "../../src/web/uploads/dropped-files";

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

  it("collects multiple dropped folder roots in one action", async () => {
    const us = new File(["us"], "transaction.csv", { type: "text/csv" });
    const de = new File(["de"], "shipment.csv", { type: "text/csv" });
    const directory = (name: string, file: File) => {
      let readCount = 0;
      return {
        isFile: false,
        isDirectory: true,
        name,
        fullPath: `/${name}`,
        createReader: () => ({
          readEntries: (success: (entries: unknown[]) => void) => {
            readCount += 1;
            success(readCount === 1 ? [{
              isFile: true,
              isDirectory: false,
              name: file.name,
              fullPath: `/${name}/${file.name}`,
              file: (resolve: (selected: File) => void) => resolve(file),
            }] : []);
          },
        }),
      };
    };
    const transfer = {
      items: [directory("US", us), directory("DE", de)].map((entry) => ({
        kind: "file",
        webkitGetAsEntry: () => entry,
        getAsFile: () => null,
      })),
      files: [],
    } as unknown as DataTransfer;

    await expect(collectDroppedFiles(transfer)).resolves.toEqual([
      { file: de, relativePath: "DE/shipment.csv" },
      { file: us, relativePath: "US/transaction.csv" },
    ]);
  });

  it("bounds directory entry expansion to sixteen concurrent file reads", async () => {
    let active = 0;
    let peak = 0;
    const entries = Array.from({ length: 40 }, (_, index) => {
      const file = new File([String(index)], `part-${index}.csv`, { type: "text/csv" });
      return {
        isFile: true as const,
        isDirectory: false as const,
        name: file.name,
        fullPath: `/bulk/${file.name}`,
        file: (success: (selected: File) => void) => {
          active += 1;
          peak = Math.max(peak, active);
          setTimeout(() => {
            active -= 1;
            success(file);
          }, 1);
        },
      };
    });
    let readCount = 0;
    const directoryEntry = {
      isFile: false as const,
      isDirectory: true as const,
      name: "bulk",
      fullPath: "/bulk",
      createReader: () => ({
        readEntries: (success: (selected: typeof entries) => void) => {
          readCount += 1;
          success(readCount === 1 ? entries : []);
        },
      }),
    };
    const transfer = {
      items: [{ kind: "file", webkitGetAsEntry: () => directoryEntry, getAsFile: () => null }],
      files: [],
    } as unknown as DataTransfer;

    const result = await collectDroppedFiles(transfer);

    expect(peak).toBeLessThanOrEqual(16);
    expect(result).toHaveLength(40);
    expect(result.map((item) => item.relativePath))
      .toEqual([...result.map((item) => item.relativePath)].sort((left, right) => left.localeCompare(right)));
  });
});

describe("mergeFileSelections", () => {
  it("appends later selections while preserving prior relative paths", () => {
    const us = new File(["us"], "transaction.csv");
    const de = new File(["de"], "shipment.csv");

    expect(mergeFileSelections(
      [{ file: us, relativePath: "US/transaction.csv" }],
      [{ file: de, relativePath: "DE/shipment.csv" }],
    )).toEqual({
      files: [
        { file: us, relativePath: "US/transaction.csv" },
        { file: de, relativePath: "DE/shipment.csv" },
      ],
      added: 1,
      replaced: 0,
    });
  });

  it("normalizes paths and lets the last selection replace a same-path conflict", () => {
    const first = new File(["old"], "report.csv");
    const replacement = new File(["replacement"], "report.csv");
    const result = mergeFileSelections(
      [{ file: first, relativePath: "A\u030A/report.csv" }],
      [{ file: replacement, relativePath: "Å\\report.csv" }],
    );

    expect(result).toEqual({
      files: [{ file: replacement, relativePath: "Å/report.csv" }],
      added: 0,
      replaced: 1,
    });
  });
});
