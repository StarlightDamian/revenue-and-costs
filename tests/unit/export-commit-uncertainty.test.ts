import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/modules/exports/export-report.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as Record<string, unknown>),
    exportReport: vi.fn(async (_input: unknown, path: string) => ({
      kind: "XLSX" as const,
      path,
      files: [{
        name: "report.xlsx",
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        bytes: "10",
        sha256: "a".repeat(64),
      }],
    })),
  };
});

import { REPORT_EXPORT_FORMAT } from "../../src/modules/exports/export-report.js";
import { PostgresExportService } from "../../src/modules/exports/postgres.js";
import type { EncryptedObjectStore } from "../../src/modules/storage/encrypted-object-store.js";

describe("export object commit uncertainty", () => {
  it("keeps ciphertext when COMMIT succeeds but its response is lost", async () => {
    let objectReferenced = false;
    const clientQuery = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: null };
      if (sql === "COMMIT") throw new Error("COMMIT_RESPONSE_LOST");
      if (sql.includes("FROM export_request WHERE id=$1 FOR UPDATE")) return { rows: [{ status: "RUNNING" }], rowCount: 1 };
      if (sql.startsWith("INSERT INTO stored_object")) {
        objectReferenced = true;
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE export_request SET status='SUCCEEDED'")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("INSERT INTO export_file_manifest")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("INSERT INTO audit_event")) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_TRANSACTION_QUERY:${sql}`);
    });
    const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
    const poolQuery = vi.fn(async (sql: string) => {
      if (sql.startsWith("UPDATE export_request SET status='RUNNING'")) {
        return {
          rows: [{
            shop_id: "shop",
            published_snapshot_id: "snapshot",
            requested_by: "account",
            format_version: REPORT_EXPORT_FORMAT,
            profit_rate: null,
            minimum_sales_cost_rate: null,
            continent_prefixes: ["EU"],
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("SET stage=$2,processed_rows=$3,total_rows=$4")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("FROM stored_object WHERE id=$1")) {
        return { rows: [{ referenced: objectReferenced }], rowCount: 1 };
      }
      if (sql.includes("FROM published_snapshot s JOIN published_snapshot_integrity")) {
        return { rows: [{
          shop_name: "shop",
          manifest: { slices: [] },
          manifest_sha256: "b".repeat(64),
          calculation_run_id: "run",
          published_at: new Date("2026-07-28T00:00:00Z"),
        }], rowCount: 1 };
      }
      if (sql.includes("WITH component_amount AS")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM published_snapshot_slice ps JOIN dataset_slice")) {
        return { rows: [{
          period: "2026-04", month: "2026-04", marketplace: "US", currency: "USD",
          disposition: "INCLUDED", datasetVersionId: "version",
        }], rowCount: 1 };
      }
      if (sql.includes("FROM calculation_fact_result r JOIN dataset_version") && sql.includes("r.component NOT IN")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM import_file f WHERE")) return { rows: [], rowCount: 0 };
      throw new Error(`UNEXPECTED_POOL_QUERY:${sql}`);
    });
    const pool = { query: poolQuery, connect: vi.fn(async () => client) } as unknown as Pool;
    const removeUncommitted = vi.fn(async () => undefined);
    const store = {
      removeUncommitted,
      putFile: vi.fn(async () => ({
        path: "D:/objects/export.esdk",
        plaintextSize: 10n,
        plaintextSha256: "c".repeat(64),
        ciphertextSha256: "d".repeat(64),
        encryptionContext: { objectId: "export" },
      })),
    } as unknown as EncryptedObjectStore;
    const service = new PostgresExportService(pool, store, "D:/tmp/revenue-export-commit-tests");

    await expect(service.generate("00000000-0000-4000-8000-000000000001"))
      .rejects.toThrow("COMMIT_RESPONSE_LOST");

    // The first call removes stale pre-generation bytes. The uncertain-commit
    // cleanup observes the committed DB reference and must not call it again.
    expect(removeUncommitted).toHaveBeenCalledTimes(1);
    expect(objectReferenced).toBe(true);
    const auditCall = clientQuery.mock.calls.find((call) => String(call[0]).startsWith("INSERT INTO audit_event"));
    expect(auditCall?.[1]?.[1]).toBe("EXPORT_GENERATED");
    expect(JSON.parse(String(auditCall?.[1]?.[5])).requestId)
      .toBe("system:export.generate:00000000-0000-4000-8000-000000000001");
  });
});
