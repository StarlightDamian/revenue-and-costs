import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { exportOutputRoot } from "../../src/modules/exports/postgres.js";

describe("export output root", () => {
  it("uses the platform path joiner instead of embedding Windows separators", () => {
    expect(exportOutputRoot("/srv/revenue", posix.join)).toBe("/srv/revenue/.work/exports");
    expect(exportOutputRoot("D:\\revenue", win32.join)).toBe("D:\\revenue\\.work\\exports");
    expect(exportOutputRoot("/srv/revenue", posix.join)).not.toContain("\\");
  });
});
