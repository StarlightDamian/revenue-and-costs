import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("transaction fulfillment migration", () => {
  it("adds a nullable constrained mode without rewriting immutable historical facts", async () => {
    const sql = await readFile(new URL("../../migrations/0049_transaction_fulfillment_income.sql", import.meta.url), "utf8");

    expect(sql).toContain("ADD COLUMN fulfillment_mode text");
    expect(sql).toContain("transaction_fact_fulfillment_mode_check");
    expect(sql).toContain("fulfillment_mode IN ('AMAZON', 'MERCHANT', 'BLANK')");
    expect(sql).not.toMatch(/\bUPDATE\s+transaction_fact\b/iu);
    expect(sql).not.toContain("NOT NULL");
    expect(sql).toContain("'amazon.com.au','AU','Australia/Sydney'");
  });
});
