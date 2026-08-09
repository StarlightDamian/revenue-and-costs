import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("export format migration safety", () => {
  it("first removes the unsafe v2 database default", async () => {
    const sql = await readFile(resolve("migrations/0029_export_format_default_fail_closed.sql"), "utf8");
    const dropDefault = sql.indexOf("ALTER COLUMN format_version DROP DEFAULT");

    expect(dropDefault).toBeGreaterThanOrEqual(0);
  });

  it("locks out concurrent writers and conservatively reclassifies every pre-cutover v2 row", async () => {
    const sql = await readFile(resolve("migrations/0030_export_format_trusted_cutover.sql"), "utf8");
    const lock = sql.indexOf("LOCK TABLE export_request IN ACCESS EXCLUSIVE MODE");
    const dropDefault = sql.indexOf("ALTER COLUMN format_version DROP DEFAULT");
    const cutover = sql.indexOf("UPDATE export_request");

    expect(lock).toBeGreaterThanOrEqual(0);
    expect(dropDefault).toBeGreaterThan(lock);
    expect(cutover).toBeGreaterThan(dropDefault);
    expect(sql).toContain("WHERE format_version = 'revenue-and-costs-export-v2'");
    expect(sql).not.toContain("business_key");
  });

  it("moves every legacy row out of the current idempotency namespace", async () => {
    const sql = await readFile(resolve("migrations/0031_isolate_legacy_export_business_keys.sql"), "utf8");

    expect(sql).toContain("LOCK TABLE export_request IN ACCESS EXCLUSIVE MODE");
    expect(sql).toContain("SET business_key = 'legacy-export:' || id::text");
    expect(sql).toContain("WHERE format_version = 'revenue-and-costs-export-v1'");
  });
});
