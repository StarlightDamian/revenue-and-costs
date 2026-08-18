import { describe, expect, it, vi } from "vitest";
import { PostgresImportService } from "../../src/modules/imports/postgres-service.js";

function row(overrides: Partial<Record<string, unknown>>) {
  return {
    slice_id: "slice-1",
    dataset_version_id: "version-1",
    normalized_marketplace: "US",
    local_month: "2025-10",
    status: "INCOMPLETE",
    shipment_count: "1",
    transaction_count: "1",
    warning: null,
    shipment_quantity: null,
    transaction_quantity: null,
    unmatched_absolute: null,
    unmatched_ratio: null,
    ...overrides,
  };
}

describe("import completeness projection", () => {
  it("reports every missing source independently and leaves complete slices empty", async () => {
    const database = { query: vi.fn(async () => ({ rows: [
      row({ slice_id: "complete", status: "ACTIVE" }),
      row({ slice_id: "shipment-only-active", status: "ACTIVE", transaction_count: "0" }),
      row({ slice_id: "missing-transaction", transaction_count: "0" }),
      row({ slice_id: "missing-shipment", shipment_count: "0" }),
      row({ slice_id: "missing-both", shipment_count: "0", transaction_count: "0" }),
    ] })) };
    const service = new PostgresImportService({ transaction: vi.fn() } as never, database as never);

    await expect(service.getCompleteness("shop-1")).resolves.toEqual([
      expect.objectContaining({ sliceId: "complete", missingReports: [] }),
      expect.objectContaining({ sliceId: "shipment-only-active", state: "COMPLETE", missingReports: [] }),
      expect.objectContaining({ sliceId: "missing-transaction", missingReports: ["TRANSACTION"] }),
      expect.objectContaining({ sliceId: "missing-shipment", missingReports: ["SHIPMENT"] }),
      expect.objectContaining({ sliceId: "missing-both", missingReports: ["TRANSACTION", "SHIPMENT"] }),
    ]);
  });

  it("filters completeness to the inclusive batch accounting period", async () => {
    let capturedSql = "";
    const query = vi.fn(async (sql: string) => {
      capturedSql = sql;
      return { rows: [] };
    });
    const service = new PostgresImportService({ transaction: vi.fn() } as never, { query } as never);

    await service.getCompleteness("shop-1", { periodStart: "2026-04", periodEnd: "2026-06" });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("ds.local_month >= $2::date"),
      ["shop-1", "2026-04-01", "2026-06-01"],
    );
    expect(capturedSql).toContain("ORDER BY ds.normalized_marketplace,ds.local_month");
  });
});
