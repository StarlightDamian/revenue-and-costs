import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("transaction fee classification migration", () => {
  it("versions new classifications without mutating immutable historical facts", async () => {
    const sql = await readFile(new URL("../../migrations/0051_transaction_fee_classification_audit.sql", import.meta.url), "utf8");

    expect(sql).toContain("ADD COLUMN classification_reason text");
    expect(sql).toContain("transaction_fee_component_fact_source_version_uq");
    expect(sql).toContain("ADD COLUMN fee_classification_version text NOT NULL DEFAULT 'transaction-fee-v1'");
    expect(sql).not.toMatch(/\bUPDATE\s+transaction_(fact|fee_component)\b/iu);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\s+transaction_(fact|fee_component)\b/iu);
  });

  it("freezes calculation input columns in a forward migration", async () => {
    const sql = await readFile(new URL("../../migrations/0052_calculation_run_input_immutability.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TRIGGER calculation_run_inputs_immutable");
    expect(sql).toContain("IMMUTABLE_CALCULATION_RUN_INPUTS");
  });
});
