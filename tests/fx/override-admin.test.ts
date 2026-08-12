import { describe, expect, it, vi } from "vitest";
import type { Actor, SqlClient } from "../../src/modules/authorization/index.js";
import { PostgresFxService, type FxOverrideRecord } from "../../src/modules/fx/postgres-service.js";

const actor: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(["ADMIN"]),
};

const body = {
  actor,
  currency: "brl",
  validFrom: "2025-12-30",
  validTo: "2025-12-30",
  cnyPerUnit: "1.33",
  sourceReference: "授权来源记录 FX-2025-12-30",
  reason: "补齐小币种缺口",
  idempotencyKey: "fx-create-0001",
  requestId: "request-1",
} as const;

function overrideRow(input: Partial<Record<string, unknown>> = {}) {
  return {
    id: "20000000-0000-4000-8000-000000000002",
    currency: "BRL",
    valid_from: "2025-12-30",
    valid_to: "2025-12-30",
    cny_per_unit: "1.33000000",
    source_reference: "授权来源记录 FX-2025-12-30",
    reason: "补齐小币种缺口",
    created_at: new Date("2026-08-09T00:00:00.000Z"),
    supersedes_override_id: null,
    is_current: true,
    ...input,
  };
}

describe("manual FX override governance", () => {
  it("creates an immutable override with canonical currency/rate, audit, and idempotent replay", async () => {
    let idempotency: { request_hash: string; response_body: { override: FxOverrideRecord } } | undefined;
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT request_hash,response_body")) {
        return { rows: idempotency ? [idempotency] : [], rowCount: idempotency ? 1 : 0 };
      }
      if (sql.includes("INSERT INTO fx_override")) return { rows: [overrideRow()], rowCount: 1 };
      if (sql.includes("INSERT INTO idempotency_record")) {
        idempotency = {
          request_hash: String(values?.[3]),
          response_body: JSON.parse(String(values?.[4])) as { override: FxOverrideRecord },
        };
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query } as unknown as SqlClient;
    const audit = vi.fn(async (auditClient: SqlClient, record: unknown) => {
      void auditClient;
      void record;
    });
    const service = new PostgresFxService(
      client,
      { transaction: async (work) => work(client) },
      { audit, outbox: vi.fn() },
    );

    const first = await service.createOverride(body);
    const replay = await service.createOverride(body);

    expect(first).toEqual(replay);
    expect(first.override).toMatchObject({ currency: "BRL", cnyPerUnit: "1.33000000", isCurrent: true });
    const insert = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO fx_override"));
    expect(insert?.[1]).toEqual([
      "BRL", "2025-12-30", "2025-12-30", "1.33000000", "授权来源记录 FX-2025-12-30",
      "补齐小币种缺口", actor.accountId, null,
    ]);
    expect(query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO fx_override"))).toHaveLength(1);
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]?.[1]).toMatchObject({
      action: "FX_OVERRIDE_CREATED",
      reason: "补齐小币种缺口",
      before: null,
      after: { currency: "BRL", cnyPerUnit: "1.33000000" },
    });
  });

  it("rejects reusing one idempotency key for a different request", async () => {
    let storedHash: string | undefined;
    let storedResponse: { override: FxOverrideRecord } | undefined;
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT request_hash,response_body")) {
        return { rows: storedHash ? [{ request_hash: storedHash, response_body: storedResponse }] : [], rowCount: storedHash ? 1 : 0 };
      }
      if (sql.includes("INSERT INTO fx_override")) return { rows: [overrideRow()], rowCount: 1 };
      if (sql.includes("INSERT INTO idempotency_record")) {
        storedHash = String(values?.[3]);
        storedResponse = JSON.parse(String(values?.[4])) as { override: FxOverrideRecord };
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query } as unknown as SqlClient;
    const service = new PostgresFxService(
      client,
      { transaction: async (work) => work(client) },
      { audit: vi.fn(), outbox: vi.fn() },
    );
    await service.createOverride(body);

    await expect(service.createOverride({ ...body, cnyPerUnit: "1.34" })).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      statusCode: 409,
    });
  });

  it("revises by appending a successor and keeps the predecessor in the audit trail", async () => {
    const predecessorId = "30000000-0000-4000-8000-000000000003";
    const successorId = "40000000-0000-4000-8000-000000000004";
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      void values;
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT request_hash,response_body")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM fx_override entry WHERE entry.id")) {
        return { rows: [overrideRow({ id: predecessorId })], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO fx_override")) {
        return { rows: [overrideRow({ id: successorId, cny_per_unit: "1.34000000", supersedes_override_id: predecessorId })], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO idempotency_record")) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query } as unknown as SqlClient;
    const audit = vi.fn(async (auditClient: SqlClient, record: unknown) => {
      void auditClient;
      void record;
    });
    const service = new PostgresFxService(
      client,
      { transaction: async (work) => work(client) },
      { audit, outbox: vi.fn() },
    );

    const result = await service.reviseOverride(predecessorId, {
      ...body,
      cnyPerUnit: "1.34",
      idempotencyKey: "fx-revise-0001",
    });

    expect(result.override).toMatchObject({ id: successorId, supersedesOverrideId: predecessorId, cnyPerUnit: "1.34000000" });
    const insert = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO fx_override"));
    expect(insert?.[1]?.at(-1)).toBe(predecessorId);
    expect(audit.mock.calls[0]?.[1]).toMatchObject({
      action: "FX_OVERRIDE_REVISED",
      before: { id: predecessorId, cnyPerUnit: "1.33000000" },
      after: { id: successorId, cnyPerUnit: "1.34000000" },
    });
  });

  it("fails closed when a revision changes currency or targets a superseded row", async () => {
    const predecessorId = "30000000-0000-4000-8000-000000000003";
    const currentQuery = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT request_hash,response_body")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM fx_override entry WHERE entry.id")) return { rows: [overrideRow()], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const currentClient = { query: currentQuery } as unknown as SqlClient;
    const service = new PostgresFxService(
      currentClient,
      { transaction: async (work) => work(currentClient) },
      { audit: vi.fn(), outbox: vi.fn() },
    );
    await expect(service.reviseOverride(predecessorId, { ...body, currency: "INR" })).rejects.toMatchObject({
      code: "FX_OVERRIDE_CURRENCY_IMMUTABLE",
      statusCode: 409,
    });

    const staleQuery = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT request_hash,response_body")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM fx_override entry WHERE entry.id")) return { rows: [overrideRow({ is_current: false })], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const staleClient = { query: staleQuery } as unknown as SqlClient;
    const staleService = new PostgresFxService(
      staleClient,
      { transaction: async (work) => work(staleClient) },
      { audit: vi.fn(), outbox: vi.fn() },
    );
    await expect(staleService.reviseOverride(predecessorId, body)).rejects.toMatchObject({
      code: "FX_OVERRIDE_REVISION_CONFLICT",
      statusCode: 409,
    });
  });

  it("rejects invalid date/rate/source inputs before opening a transaction", async () => {
    const transaction = vi.fn();
    const service = new PostgresFxService(
      { query: vi.fn() } as never,
      { transaction } as never,
      { audit: vi.fn(), outbox: vi.fn() },
    );

    await expect(service.createOverride({ ...body, validFrom: "2025-02-30" })).rejects.toMatchObject({ code: "FX_OVERRIDE_DATE_INVALID" });
    await expect(service.createOverride({ ...body, cnyPerUnit: "1.330000001" })).rejects.toMatchObject({ code: "FX_OVERRIDE_RATE_INVALID" });
    await expect(service.createOverride({ ...body, sourceReference: "   " })).rejects.toMatchObject({ code: "FX_OVERRIDE_SOURCE_REQUIRED" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("maps database overlap enforcement to a stable conflict response", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT request_hash,response_body")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO fx_override")) {
        throw Object.assign(new Error("current manual FX validity ranges may not overlap"), {
          constraint: "fx_override_current_range_no_overlap",
        });
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query } as unknown as SqlClient;
    const service = new PostgresFxService(
      client,
      { transaction: async (work) => work(client) },
      { audit: vi.fn(), outbox: vi.fn() },
    );

    await expect(service.createOverride(body)).rejects.toMatchObject({
      code: "FX_OVERRIDE_RANGE_OVERLAP",
      statusCode: 409,
    });
  });

  it("lists current and historical immutable revisions with explicit state", async () => {
    const database = {
      query: vi.fn(async (sql: string) => {
        void sql;
        return { rows: [
          overrideRow({ is_current: false }),
          overrideRow({
            id: "40000000-0000-4000-8000-000000000004",
            cny_per_unit: "1.34000000",
            supersedes_override_id: "20000000-0000-4000-8000-000000000002",
            is_current: true,
          }),
        ], rowCount: 2 };
      }),
    };
    const service = new PostgresFxService(
      database as never,
      { transaction: vi.fn() } as never,
      { audit: vi.fn(), outbox: vi.fn() },
    );

    const result = await service.listOverrides();

    expect(result.rows.map((entry) => entry.isCurrent)).toEqual([false, true]);
    expect(database.query.mock.calls[0]?.[0]).toContain("NOT EXISTS");
  });
});
