import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/modules/authorization/index.js";
import { PostgresExportService } from "../../src/modules/exports/postgres.js";
import type { EncryptedObjectStore } from "../../src/modules/storage/encrypted-object-store.js";

const customer: Actor = { accountId: "customer", status: "ACTIVE", roles: new Set() };
const owner: Actor = { accountId: "owner", status: "ACTIVE", roles: new Set(["ACCOUNTANT"]), enterpriseIds: new Set(["enterprise-1"]) };

function service(clientQuery: ReturnType<typeof vi.fn>, poolQuery = vi.fn(async (sql: string) => {
  if (sql.startsWith("INSERT INTO audit_event")) return { rows: [], rowCount: 1 };
  throw new Error(`UNEXPECTED_POOL_QUERY:${sql}`);
})) {
  const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client), query: poolQuery } as unknown as Pool;
  const createDecryptionStream = vi.fn(() => ({ pipe: vi.fn() }));
  const store = { createDecryptionStream } as unknown as EncryptedObjectStore;
  return { service: new PostgresExportService(pool, store, ".work/test-export-download"), createDecryptionStream, poolQuery };
}

describe("export one-time download authorization", () => {
  it("returns an object-scoped denial after customer revocation", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (["BEGIN", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: null };
      if (sql.includes("FROM export_download_grant WHERE")) return { rows: [{ shop_id: "shop" }], rowCount: 1 };
      if (sql.includes("FROM shop_membership")) {
        return { rows: [{ id: "membership", status: "REVOKED", export_allowed: false, authorization_epoch: "3" }], rowCount: 1 };
      }
      if (sql.includes("FROM shop WHERE")) return { rows: [{ id: "shop", enterprise_id: "enterprise-1", status: "ACTIVE" }], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    await expect(service(query).service.download(customer, "export", "token", "request-download"))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });
  });

  it("consumes a token once, audits in the transaction, and never sends plaintext token to SQL", async () => {
    let consumed = false;
    const token = "plain-download-token";
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (["BEGIN", "COMMIT"].includes(sql)) return { rows: [], rowCount: null };
      if (sql === "ROLLBACK") return { rows: [], rowCount: null };
      if (sql.includes("FROM export_download_grant WHERE")) return { rows: [{ shop_id: "shop" }], rowCount: 1 };
      if (sql.includes("FROM shop_membership")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM shop WHERE")) return { rows: [{ id: "shop", enterprise_id: "enterprise-1", status: "ACTIVE" }], rowCount: 1 };
      if (sql.includes("FROM export_request er LEFT JOIN stored_object")) {
        return { rows: [{ requested_by: "owner", membership_authorization_version: null, status: "SUCCEEDED", storage_path: "object.esdk", output_kind: "XLSX", encryption_context: { objectId: "export" }, shop_name: "示例公司" }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE export_download_grant SET consumed_at")) {
        if (consumed) return { rows: [], rowCount: 0 };
        consumed = true;
        return { rows: [{ id: "grant" }], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO audit_event")) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const runtime = service(query);

    await expect(runtime.service.download(owner, "export", token, "request-download-1"))
      .resolves.toMatchObject({ fileName: "销售成本表-示例公司.xlsx" });
    await expect(runtime.service.download(owner, "export", token, "request-download-2"))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });

    expect(runtime.createDecryptionStream).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some((call) => (call[1] as readonly unknown[] | undefined)?.includes(token))).toBe(false);
    expect(query.mock.calls.some((call) => String(call[0]).startsWith("INSERT INTO audit_event"))).toBe(true);
  });
});
