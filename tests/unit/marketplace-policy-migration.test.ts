import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("marketplace policy correction migration", () => {
  it("adds Brazil and versions Saudi Arabia and Sweden as small marketplaces", async () => {
    const sql = await readFile(resolve("migrations/0042_marketplace_policy_corrections.sql"), "utf8");

    expect(sql).toContain("('amazon.com.br', 'BR', 'America/Sao_Paulo', 'LARGE', '2026-08-07T08:25:00Z'");
    expect(sql).toContain("('amazon.sa', 'SA', 'Asia/Riyadh', 'SMALL', '2026-08-07T08:25:00Z'");
    expect(sql).toContain("('amazon.se', 'SE', 'Europe/Stockholm', 'SMALL', '2026-08-07T08:25:00Z'");
  });

  it("preserves immutable historical policy rows and relies on latest-effective selection", async () => {
    const sql = await readFile(resolve("migrations/0042_marketplace_policy_corrections.sql"), "utf8");

    expect(sql).not.toMatch(/\b(?:UPDATE|DELETE)\s+marketplace_policy_version\b/iu);
    expect(sql).toContain("ON CONFLICT (normalized_marketplace, effective_from) DO NOTHING");
  });
});
