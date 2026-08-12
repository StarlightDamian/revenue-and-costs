import { describe, expect, it, vi } from "vitest";
import { PostgresImportService } from "../../src/modules/imports/postgres-service.js";

describe("import confirmation recovery", () => {
  it.each([
    "COMMITTING",
    "COMMITTED",
    "COMMITTED_WITH_EXCLUSIONS",
    "CALCULATING",
    "READY_FOR_REVIEW",
    "RESULT_PUBLISHING",
    "RESULT_PUBLISHED",
  ])("treats %s as an idempotent completed confirmation", async (status) => {
    const client = {
      query: vi.fn(async (sql: string) => sql.includes("SELECT status")
        ? { rows: [{ status, failure_code: null }], rowCount: 1 }
        : { rows: [], rowCount: 1 }),
    };
    const transactions = { transaction: vi.fn(async (work: (tx: typeof client) => Promise<unknown>) => work(client)) };
    const service = new PostgresImportService(transactions as never, { query: vi.fn() } as never);

    await expect(service.confirm("shop-1", "batch-1", {
      actorAccountId: "actor-1",
      idempotencyKey: "stale-page-retry",
    })).resolves.toEqual({ id: "batch-1", status });

    expect(client.query).toHaveBeenCalledOnce();
  });

  it("requeues a capacity-preflight failure without requiring another upload", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("SELECT status")) {
          return { rows: [{ status: "FAILED", failure_code: "IMPORT_DATABASE_CAPACITY_UNAVAILABLE" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const transactions = { transaction: vi.fn(async (work: (tx: typeof client) => Promise<unknown>) => work(client)) };
    const service = new PostgresImportService(transactions as never, { query: vi.fn() } as never);

    await expect(service.confirm("shop-1", "batch-1", {
      actorAccountId: "actor-1",
      idempotencyKey: "retry-1",
    })).resolves.toEqual({ id: "batch-1", status: "COMMITTING" });

    expect(statements.some((sql) => sql.includes("failure_code=NULL"))).toBe(true);
    expect(statements.some((sql) => sql.includes("'import.commit'"))).toBe(true);
  });

  it("resumes calculation only after every hard-incomplete slice has an acknowledgement", async () => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes("SELECT status")) {
          return { rows: [{ status: "FAILED", failure_code: "HARD_INCOMPLETE_CONFIRMATION_REQUIRED" }], rowCount: 1 };
        }
        if (sql.includes("count(*)::text")) return { rows: [{ count: "0" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const transactions = { transaction: vi.fn(async (work: (tx: typeof client) => Promise<unknown>) => work(client)) };
    const service = new PostgresImportService(transactions as never, { query: vi.fn() } as never);

    await expect(service.confirm("shop-1", "batch-1", {
      actorAccountId: "actor-1",
      idempotencyKey: "hard-exclusions-confirmed",
    })).resolves.toEqual({ id: "batch-1", status: "COMMITTED_WITH_EXCLUSIONS" });

    expect(statements.some((sql) => sql.includes("'calculation.requested'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("'import.commit'"))).toBe(false);
  });
});

describe("import quality acknowledgement policy binding", () => {
  it("binds the policy effective for the slice marketplace and dataset creation time", async () => {
    const calls: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
        calls.push({ sql, ...(parameters ? { parameters } : {}) });
        if (sql.includes("CASE WHEN dv.status='INCOMPLETE'")) {
          return { rows: [{ dataset_version_id: "version-ca", issue_kind: "HARD_INCOMPLETE", issue_code: "ACCOUNTANT_ACKNOWLEDGED", policy_id: "policy-ca-literal" }] };
        }
        if (sql.includes("INSERT INTO quality_acknowledgement")) return { rows: [{ id: "ack-1" }] };
        return { rows: [], rowCount: 1 };
      }),
    };
    const transactions = { transaction: vi.fn(async (work: (tx: typeof client) => Promise<unknown>) => work(client)) };
    const service = new PostgresImportService(transactions as never, { query: vi.fn() } as never);

    await expect(service.acknowledge("shop-1", "version-ca", {
      actorAccountId: "actor-1",
      reason: "确认排除报表字面日期重放后缺失的切片",
      confirmations: "2",
      idempotencyKey: "ack-ca-literal",
    })).resolves.toEqual({ id: "ack-1", status: "ACKNOWLEDGED" });

    const policyQuery = calls.find(({ sql }) => sql.includes("CASE WHEN dv.status='INCOMPLETE'"));
    expect(policyQuery?.sql).toContain("candidate.normalized_marketplace=ds.normalized_marketplace");
    expect(policyQuery?.sql).toContain("candidate.effective_from<=dv.created_at");
    const acknowledgement = calls.find(({ sql }) => sql.includes("INSERT INTO quality_acknowledgement"));
    expect(acknowledgement?.parameters?.[1]).toBe("policy-ca-literal");
  });
});
