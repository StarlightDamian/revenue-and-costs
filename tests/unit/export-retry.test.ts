import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/modules/authorization/index.js";
import type { EncryptedObjectStore } from "../../src/modules/storage/encrypted-object-store";
import { REPORT_EXPORT_FORMAT } from "../../src/modules/exports/export-report";
import { PostgresExportService } from "../../src/modules/exports/postgres";

const exportId = "00000000-0000-4000-8000-000000000001";
const owner: Actor = { accountId: "owner", status: "ACTIVE", roles: new Set(["ACCOUNTANT"]), enterpriseIds: new Set(["enterprise-1"]) };

function transactionalPool(query: (sql: string, parameters?: readonly unknown[]) => Promise<unknown>): Pool {
  const client = {
    query: vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: null };
      return query(sql, parameters);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { query, connect: vi.fn(async () => client) } as unknown as Pool;
}

describe("export retry lifecycle", () => {
  it("normalizes legacy raw database errors before returning list results", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM shop s LEFT JOIN shop_membership")) {
        return { rows: [{ id: "shop", enterprise_id: "enterprise-1", status: "ACTIVE", membership_id: null, membership_status: null, export_allowed: null, authorization_epoch: null }], rowCount: 1 };
      }
      if (sql.includes("FROM shop_membership")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM shop WHERE")) return { rows: [{ id: "shop", enterprise_id: "enterprise-1", status: "ACTIVE" }], rowCount: 1 };
      if (sql.includes("FROM export_request WHERE shop_id=$1")) {
        const base = { published_snapshot_id: "snapshot", output_kind: null, format_version: "revenue-and-costs-export-v1", created_at: new Date("2026-07-28T00:00:00.000Z") };
        return { rows: [
          { ...base, id: "legacy", status: "FAILED", error_code: "SQL failed at D:\\private\\exports\\report.xlsx: SELECT * FROM wallet_account" },
          { ...base, id: "revoked", status: "REVOKED", error_code: "MEMBERSHIP_REVOKED" },
        ], rowCount: 2 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const service = new PostgresExportService({ query } as unknown as Pool, {} as EncryptedObjectStore, "D:/tmp/revenue-export-list-tests");

    const rows = await service.list(owner, "shop");

    expect(rows.map((row) => row.error)).toEqual(["EXPORT_GENERATION_FAILED", "MEMBERSHIP_REVOKED"]);
    expect(rows.every((row) => row.isCurrentFormat === false)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("private");
    expect(JSON.stringify(rows)).not.toContain("wallet_account");
  });

  it("reclaims RUNNING work and leaves retryable failures non-terminal", async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.startsWith("UPDATE export_request SET status='RUNNING'")) {
          return {
            rows: [{
              shop_id: "shop-1",
              published_snapshot_id: "snapshot-1",
              requested_by: "account",
              format_version: REPORT_EXPORT_FORMAT,
              profit_rate: null,
              minimum_sales_cost_rate: null,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("SET stage=$2,processed_rows=$3,total_rows=$4")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("FROM stored_object WHERE id=$1")) {
          return { rows: [{ referenced: false }], rowCount: 1 };
        }
        if (sql.includes("FROM published_snapshot s JOIN published_snapshot_integrity")) {
          throw new Error("TRANSIENT_DATABASE_FAILURE");
        }
        throw new Error(`UNEXPECTED_QUERY:${sql}`);
      },
    } as unknown as Pool;
    const store = { removeUncommitted: vi.fn(async () => undefined) } as unknown as EncryptedObjectStore;
    const service = new PostgresExportService(pool, store, "D:/tmp/revenue-export-retry-tests");

    await expect(service.generate(exportId)).rejects.toThrow("TRANSIENT_DATABASE_FAILURE");
    expect(queries[0]).toContain("status IN ('QUEUED','RUNNING')");
    expect(queries.some((sql) => sql.includes("SET status='FAILED'"))).toBe(false);
    expect(store.removeUncommitted).toHaveBeenCalledWith(exportId);
  });

  it("fails a queued legacy-format export instead of generating a mislabeled current workbook", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      if (sql.startsWith("UPDATE export_request SET status='RUNNING'")) {
        return { rows: [{
          shop_id: "shop-1",
          published_snapshot_id: "snapshot-1",
          requested_by: "account",
          format_version: "revenue-and-costs-export-v1",
        }], rowCount: 1 };
      }
      if (sql.includes("SELECT status,requested_by FROM export_request")) {
        return { rows: [{ status: "RUNNING", requested_by: "account" }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE export_request SET status='FAILED'")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("INSERT INTO audit_event")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM stored_object WHERE id=$1")) return { rows: [{ referenced: false }], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}:${JSON.stringify(parameters ?? [])}`);
    });
    const store = { removeUncommitted: vi.fn(async () => undefined) } as unknown as EncryptedObjectStore;
    const service = new PostgresExportService(transactionalPool(query), store, "D:/tmp/revenue-export-retry-tests");

    await expect(service.generate(exportId)).resolves.toBeUndefined();
    const failure = query.mock.calls.find((call) => String(call[0]).startsWith("UPDATE export_request SET status='FAILED'"));
    expect(failure?.[1]?.[1]).toBe("EXPORT_FORMAT_VERSION_UNSUPPORTED");
    expect(query.mock.calls.some((call) => String(call[0]).includes("FROM published_snapshot s"))).toBe(false);
  });

  it("marks exhausted work terminal and cleans deterministic artifacts", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (sql.includes("SELECT status,requested_by FROM export_request")) return { rows: [{ status: "RUNNING", requested_by: "account" }], rowCount: 1 };
      if (sql.startsWith("UPDATE export_request SET status='FAILED'")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("INSERT INTO audit_event")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM stored_object WHERE id=$1")) return { rows: [{ referenced: false }], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const store = { removeUncommitted: vi.fn(async () => undefined) } as unknown as EncryptedObjectStore;
    const service = new PostgresExportService(transactionalPool(query), store, "D:/tmp/revenue-export-retry-tests");

    const secretFailure = new Error("SQL failed at D:\\private\\exports\\report.xlsx: SELECT * FROM wallet_account");
    await service.fail(exportId, secretFailure);
    expect(query.mock.calls.some((call) => String(call[0]).includes("status='FAILED'"))).toBe(true);
    expect(store.removeUncommitted).toHaveBeenCalledWith(exportId);
    const auditCall = query.mock.calls.find((call) => String(call[0]).startsWith("INSERT INTO audit_event"));
    expect(auditCall?.[1]?.[1]).toBe("EXPORT_GENERATION_FAILED");
    expect(JSON.parse(String(auditCall?.[1]?.[5])).requestId).toBe(`system:export.generate:${exportId}`);
    const updateCall = query.mock.calls.find((call) => String(call[0]).startsWith("UPDATE export_request SET status='FAILED'"));
    expect(updateCall?.[1]?.[1]).toBe("EXPORT_GENERATION_FAILED");
    expect(JSON.stringify(query.mock.calls)).not.toContain("D:\\\\private");
    expect(JSON.stringify(query.mock.calls)).not.toContain("wallet_account");
  });

  it("never removes a committed object when terminal failure observes SUCCEEDED", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT status,requested_by FROM export_request")) return { rows: [{ status: "SUCCEEDED", requested_by: "account" }], rowCount: 1 };
      if (sql.includes("FROM stored_object WHERE id=$1")) return { rows: [{ referenced: true }], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const store = { removeUncommitted: vi.fn(async () => undefined) } as unknown as EncryptedObjectStore;
    const service = new PostgresExportService(transactionalPool(query), store, "D:/tmp/revenue-export-retry-tests");

    await service.fail(exportId, new Error("post-commit cleanup failed"));

    expect(store.removeUncommitted).not.toHaveBeenCalled();
  });

  it("leaks rather than deletes when commit outcome cannot be queried", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT status,requested_by FROM export_request")) return { rows: [{ status: "SUCCEEDED", requested_by: "account" }], rowCount: 1 };
      if (sql.includes("FROM stored_object WHERE id=$1")) throw new Error("COMMIT_OUTCOME_UNKNOWN");
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const store = { removeUncommitted: vi.fn(async () => undefined) } as unknown as EncryptedObjectStore;
    const service = new PostgresExportService(transactionalPool(query), store, "D:/tmp/revenue-export-retry-tests");

    await service.fail(exportId, new Error("commit response lost"));

    expect(store.removeUncommitted).not.toHaveBeenCalled();
  });
});
