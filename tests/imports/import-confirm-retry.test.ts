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
