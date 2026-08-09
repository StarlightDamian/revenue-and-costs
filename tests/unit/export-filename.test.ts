import { describe, expect, it } from "vitest";
import { exportDownloadFileName } from "../../src/modules/exports/postgres.js";

describe("export download filename", () => {
  it("uses the requested Chinese business name and sanitizes filesystem separators", () => {
    expect(exportDownloadFileName("阿尔金贸易/上海", "XLSX"))
      .toBe("销售成本表-阿尔金贸易_上海.xlsx");
    expect(exportDownloadFileName("阿尔金贸易", "ZIP"))
      .toBe("销售成本表-阿尔金贸易.zip");
  });
});

