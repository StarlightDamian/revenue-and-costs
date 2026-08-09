import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/modules/authorization/index.js";
import { PostgresExportService } from "../../src/modules/exports/postgres.js";
import type { EncryptedObjectStore } from "../../src/modules/storage/encrypted-object-store.js";

const owner: Actor = { accountId: "owner", status: "ACTIVE", roles: new Set(["ACCOUNTANT"]), enterpriseIds: new Set(["enterprise-1"]) };

describe("export download token issuance", () => {
  it("returns 32 random bytes, stores only SHA-256, expires in five minutes, and audits atomically", async () => {
    let grantParameters: readonly unknown[] | undefined;
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      if (["BEGIN", "COMMIT"].includes(sql)) return { rows: [], rowCount: null };
      if (sql === "SELECT shop_id FROM export_request WHERE id=$1") return { rows: [{ shop_id: "shop" }], rowCount: 1 };
      if (sql.includes("FROM shop_membership")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM shop WHERE")) return { rows: [{ id: "shop", enterprise_id: "enterprise-1", status: "ACTIVE" }], rowCount: 1 };
      if (sql.includes("FROM export_request WHERE id=$1 AND shop_id=$2 FOR UPDATE")) {
        return { rows: [{ requested_by: "owner", membership_authorization_version: null, status: "SUCCEEDED" }], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO export_download_grant")) {
        grantParameters = parameters;
        expect(sql).toContain("interval '5 minutes'");
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO audit_event")) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client), query: vi.fn() } as unknown as Pool;
    const service = new PostgresExportService(pool, {} as EncryptedObjectStore, ".work/test-export-token");

    const token = await service.createDownloadToken(owner, "export", "request-token");

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(grantParameters?.[5]).toMatch(/^[0-9a-f]{64}$/u);
    expect(grantParameters).not.toContain(token);
    expect(query.mock.calls.some((call) => String(call[0]).startsWith("INSERT INTO audit_event"))).toBe(true);
  });
});
