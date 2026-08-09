import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import { materializeImportSlices, persistImportFileResults } from "../../src/modules/imports/postgres-commit.js";

describe("set-based import materialization", () => {
  it("uses a fixed SQL count for all marketplace-month slices", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (statement: string) => {
      statements.push(statement);
      if (statement.includes("RETURNING marketplace,local_month")) {
        return {
          rows: Array.from({ length: 40 }, (_, index) => ({
            marketplace: `M${index}`,
            local_month: "2026-04-01",
          })),
          rowCount: 40,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const slices = await materializeImportSlices(
      { query } as unknown as PoolClient,
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    );

    expect(slices).toHaveLength(40);
    expect(statements).toHaveLength(10);
    expect(statements.filter((sql) => sql.includes("INSERT INTO shipment_fact"))).toHaveLength(1);
    expect(statements.filter((sql) => sql.includes("INSERT INTO transaction_fact"))).toHaveLength(1);
    expect(statements.find((sql) => sql.includes("INSERT INTO transaction_fact"))).toContain("fulfillment_mode");
    expect(statements.filter((sql) => sql.includes("INSERT INTO transaction_fee_component"))).toHaveLength(1);
    expect(statements.filter((sql) => sql.includes("INSERT INTO reconciliation_result"))).toHaveLength(1);
    expect(statements.filter((sql) => sql.includes("JOIN import_version_stage"))).toHaveLength(5);
  });

  it("persists all file counters and issue groups with two set-based queries", async () => {
    const query = vi.fn(async (...args: [sql: string, parameters?: readonly unknown[]]) => {
      void args;
      return { rows: [], rowCount: 40 };
    });
    const files = Array.from({ length: 40 }, (_, index) => ({
      fileId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      read: 100n,
      inserted: 98n,
      excluded: 1n,
      errored: 1n,
      excludedAmount: "2.00000000",
      errors: [{ code: "IMPORT_FINANCIAL_VALUE_INVALID", rowNumber: "2", fieldName: "amount", count: 1n }],
    }));

    await expect(persistImportFileResults(
      { query } as unknown as PoolClient,
      "10000000-0000-4000-8000-000000000001",
      files,
    )).resolves.toBe(80n);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("UPDATE import_file");
    expect(query.mock.calls[1]?.[0]).toContain("INSERT INTO import_issue");
  });
});
