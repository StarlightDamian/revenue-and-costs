import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/modules/authorization/index.js";
import { REPORT_EXPORT_FORMAT } from "../../src/modules/exports/export-report.js";
import { PostgresExportService } from "../../src/modules/exports/postgres.js";
import type { EncryptedObjectStore } from "../../src/modules/storage/encrypted-object-store.js";

const customer: Actor = { accountId: "customer", status: "ACTIVE", roles: new Set() };
const owner: Actor = { accountId: "owner", status: "ACTIVE", roles: new Set(["ACCOUNTANT"]), enterpriseIds: new Set(["enterprise-1"]) };
const administrator: Actor = { accountId: "administrator", status: "ACTIVE", roles: new Set(["ADMIN"]) };
const assumptions = { profitRate: null, minimumSalesCostRate: null, continentPrefixes: ["EU"] } as const;

function serviceWithClient(query: ReturnType<typeof vi.fn>) {
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const poolQuery = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
    void parameters;
    if (sql.startsWith("INSERT INTO audit_event")) return { rows: [], rowCount: 1 };
    throw new Error("AUTHORIZATION_ESCAPED_CREATE_TRANSACTION");
  });

  const pool = {
    connect: vi.fn(async () => client),
    query: poolQuery,
  } as unknown as Pool;
  const service = new PostgresExportService(pool, {} as EncryptedObjectStore, "D:/tmp/revenue-export-create-tests");
  return { service, client, pool, poolQuery };
}

describe("export create authorization serialization", () => {
  it("locks shop then membership in the create transaction and stores the locked epoch", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (["BEGIN", "COMMIT"].includes(sql)) return { rows: [], rowCount: null };
      if (sql.includes("FROM shop_membership")) {
        return { rows: [{ id: "membership", status: "ACTIVE", export_allowed: true, authorization_epoch: "7" }], rowCount: 1 };
      }
      if (sql.includes("FROM shop WHERE")) {
        return { rows: [{ id: "shop", enterprise_id: "enterprise-1", status: "ACTIVE" }], rowCount: 1 };
      }
      if (sql.includes("FROM published_snapshot")) return { rows: [{ id: "snapshot" }], rowCount: 1 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("FROM export_request WHERE business_key")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("INSERT INTO export_request")) {
        return { rows: [{ id: "export", shop_id: "shop", published_snapshot_id: "snapshot", status: "QUEUED", output_kind: null, format_version: REPORT_EXPORT_FORMAT, continent_prefixes: ["EU"], created_at: new Date("2026-07-28T00:00:00Z") }], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO outbox_event")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("INSERT INTO audit_event")) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { service, pool } = serviceWithClient(query);

    await expect(service.create(customer, "shop", "snapshot", "idempotency-key", "request-create", assumptions))
      .resolves.toMatchObject({ id: "export", status: "QUEUED" });

    const sql = query.mock.calls.map((call) => String(call[0]));
    const membershipIndex = sql.findIndex((statement) => statement.includes("FROM shop_membership"));
    const shopIndex = sql.findIndex((statement) => statement.includes("FROM shop WHERE"));
    const insertIndex = sql.findIndex((statement) => statement.startsWith("INSERT INTO export_request"));
    expect(shopIndex).toBeGreaterThan(sql.indexOf("BEGIN"));
    expect(sql[membershipIndex]).toContain("FOR SHARE");
    expect(sql[shopIndex]).toContain("FOR SHARE");
    expect(shopIndex).toBeLessThan(membershipIndex);
    expect(membershipIndex).toBeLessThan(insertIndex);
    expect(query.mock.calls[insertIndex]?.[1]?.[3]).toBe("7");
    expect(query.mock.calls[insertIndex]?.[1]?.[4]).toBe(`customer:${REPORT_EXPORT_FORMAT}:idempotency-key`);
    expect(query.mock.calls[insertIndex]?.[1]?.[5]).toBe(REPORT_EXPORT_FORMAT);
    const auditCall = query.mock.calls.find((call) => String(call[0]).startsWith("INSERT INTO audit_event"));
    expect(auditCall?.[1]?.[1]).toBe("EXPORT_CREATED");
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([
    ["enterprise member", owner],
    ["administrator", administrator],
  ] as const)("does not bind an %s export to an incidental customer membership", async (_label, actor) => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (["BEGIN", "COMMIT"].includes(sql)) return { rows: [], rowCount: null };
      if (sql.includes("FROM shop WHERE")) return { rows: [{ id: "shop", enterprise_id: "enterprise-1", status: "ACTIVE" }], rowCount: 1 };
      if (sql.includes("FROM shop_membership")) {
        return { rows: [{ id: "membership", status: "ACTIVE", export_allowed: true, authorization_epoch: "7" }], rowCount: 1 };
      }
      if (sql.includes("FROM published_snapshot")) return { rows: [{ id: "snapshot" }], rowCount: 1 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("FROM export_request WHERE business_key")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("INSERT INTO export_request")) {
        return { rows: [{ id: "export", shop_id: "shop", published_snapshot_id: "snapshot", status: "QUEUED", output_kind: null, format_version: REPORT_EXPORT_FORMAT, continent_prefixes: ["EU"], created_at: new Date("2026-07-28T00:00:00Z") }], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO outbox_event") || sql.startsWith("INSERT INTO audit_event")) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { service } = serviceWithClient(query);

    await expect(service.create(actor, "shop", "snapshot", `idempotency-${actor.accountId}`, "request-create", assumptions))
      .resolves.toMatchObject({ id: "export", status: "QUEUED" });

    const insert = query.mock.calls.find((call) => String(call[0]).startsWith("INSERT INTO export_request"));
    expect(insert?.[1]?.[3]).toBeNull();
  });

  it("names an idempotent replay without claiming that it created a second export", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (["BEGIN", "COMMIT"].includes(sql)) return { rows: [], rowCount: null };
      if (sql.includes("FROM shop_membership")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM shop WHERE")) return { rows: [{ id: "shop", enterprise_id: "enterprise-1", status: "ACTIVE" }], rowCount: 1 };
      if (sql.includes("FROM published_snapshot")) return { rows: [{ id: "snapshot" }], rowCount: 1 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("FROM export_request WHERE business_key")) {
        return { rows: [{ id: "export", shop_id: "shop", published_snapshot_id: "snapshot", status: "SUCCEEDED", output_kind: "ZIP", format_version: REPORT_EXPORT_FORMAT, continent_prefixes: ["EU"], created_at: new Date("2026-07-28T00:00:00Z") }], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO outbox_event") || sql.startsWith("INSERT INTO audit_event")) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { service } = serviceWithClient(query);

    await expect(service.create(owner, "shop", "snapshot", "idempotency-key", "request-replay", assumptions)).resolves.toMatchObject({
      status: "SUCCEEDED",
      progress: "100",
      format: "ZIP",
      isCurrentFormat: true,
    });

    expect(query.mock.calls.some((call) => String(call[0]).startsWith("INSERT INTO export_request"))).toBe(false);
    const auditCall = query.mock.calls.find((call) => String(call[0]).startsWith("INSERT INTO audit_event"));
    expect(auditCall?.[1]?.[1]).toBe("EXPORT_CREATE_REPLAYED");
  });

  it("returns the persisted running progress on an idempotent replay", async () => {
    const query = vi.fn(async (sql: string) => {
      if (["BEGIN", "COMMIT"].includes(sql)) return { rows: [], rowCount: null };
      if (sql.includes("FROM shop_membership")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM shop WHERE")) return { rows: [{ id: "shop", enterprise_id: "enterprise-1", status: "ACTIVE" }], rowCount: 1 };
      if (sql.includes("FROM published_snapshot")) return { rows: [{ id: "snapshot" }], rowCount: 1 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("FROM export_request WHERE business_key")) {
        return { rows: [{
          id: "export-running",
          shop_id: "shop",
          published_snapshot_id: "snapshot",
          status: "RUNNING",
          output_kind: null,
          format_version: REPORT_EXPORT_FORMAT,
          stage: "WRITING_MONTHLY",
          progress_percent: 37,
          processed_rows: "1200",
          total_rows: "3200",
          heartbeat_at: new Date("2026-07-28T00:02:00Z"),
          continent_prefixes: ["EU"],
          created_at: new Date("2026-07-28T00:00:00Z"),
        }], rowCount: 1 };
      }
      if (sql.startsWith("INSERT INTO outbox_event") || sql.startsWith("INSERT INTO audit_event")) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { service } = serviceWithClient(query);

    await expect(service.create(owner, "shop", "snapshot", "running-key", "request-running", assumptions)).resolves.toMatchObject({
      status: "RUNNING",
      progress: "37",
      stage: "WRITING_MONTHLY",
      processedRows: "1200",
      totalRows: "3200",
      heartbeatAt: "2026-07-28T00:02:00.000Z",
      format: "XLSX",
      isCurrentFormat: true,
    });
  });

  it("fails closed when an old-format row still occupies a current-format idempotency key", async () => {
    const query = vi.fn(async (sql: string) => {
      if (["BEGIN", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: null };
      if (sql.includes("FROM shop_membership")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM shop WHERE")) return { rows: [{ id: "shop", enterprise_id: "enterprise-1", status: "ACTIVE" }], rowCount: 1 };
      if (sql.includes("FROM published_snapshot")) return { rows: [{ id: "snapshot" }], rowCount: 1 };
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}], rowCount: 1 };
      if (sql.includes("FROM export_request WHERE business_key")) {
        return { rows: [{
          id: "legacy-export",
          shop_id: "shop",
          published_snapshot_id: "snapshot",
          status: "SUCCEEDED",
          format_version: "revenue-and-costs-export-v1",
          continent_prefixes: ["EU"],
          created_at: new Date("2026-07-28T00:00:00Z"),
        }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { service } = serviceWithClient(query);

    await expect(service.create(owner, "shop", "snapshot", "same-key", "request-conflict", assumptions))
      .rejects.toMatchObject({ code: "EXPORT_FORMAT_IDEMPOTENCY_CONFLICT", statusCode: 409 });
    expect(query.mock.calls.some((call) => String(call[0]).startsWith("INSERT INTO outbox_event"))).toBe(false);
  });

  it("rejects the latest revoked membership before inserting an export", async () => {
    const query = vi.fn(async (sql: string) => {
      if (["BEGIN", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: null };
      if (sql.includes("FROM shop_membership")) {
        return { rows: [{ id: "membership", status: "REVOKED", export_allowed: false, authorization_epoch: "8" }], rowCount: 1 };
      }
      if (sql.includes("FROM shop WHERE")) {
        return { rows: [{ id: "shop", enterprise_id: "enterprise-1", status: "ACTIVE" }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { service, poolQuery } = serviceWithClient(query);

    await expect(service.create(customer, "shop", "snapshot", "idempotency-key", "request-create", assumptions))
      .rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
    expect(query.mock.calls.some((call) => String(call[0]).startsWith("INSERT INTO export_request"))).toBe(false);
    expect(poolQuery.mock.calls[0]?.[1]?.[2]).toBe("published_snapshot");
    expect(poolQuery.mock.calls[0]?.[1]?.[3]).toBe("snapshot");
  });
});
