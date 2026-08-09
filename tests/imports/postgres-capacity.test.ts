import { statfs } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commitImportBatch, isPersistedImportCommitFailure } from "../../src/modules/imports/postgres-commit.js";
import type { EncryptedObjectStore } from "../../src/modules/storage/encrypted-object-store.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof FsPromises>(),
  statfs: vi.fn(),
}));

const mockedStatfs = vi.mocked(statfs);

describe("PostgreSQL import capacity admission", () => {
  beforeEach(() => mockedStatfs.mockReset());

  it("fails closed before creating the COPY staging table when the database volume is short", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (statement: unknown) => {
      const sql = typeof statement === "string" ? statement : "COPY_STREAM";
      queries.push(sql);
      if (sql.includes("SELECT status FROM import_batch")) return { rows: [{ status: "COMMITTING" }] };
      if (sql.includes("sum(size_bytes)")) return { rows: [{ source_bytes: String(8n * 1024n * 1024n * 1024n) }] };
      if (sql === "SHOW data_directory") return { rows: [{ data_directory: "D:\\postgres-data" }] };
      if (sql.includes("CREATE TEMP TABLE import_stage")) throw new Error("COPY_STARTED_WITHOUT_CAPACITY_CHECK");
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const store = {} as EncryptedObjectStore;
    mockedStatfs.mockResolvedValue({ bavail: 1n, bsize: 1n } as Awaited<ReturnType<typeof statfs>>);

    await expect(commitImportBatch(pool, store, "00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"))
      .rejects.toThrow("IMPORT_DATABASE_CAPACITY_INSUFFICIENT");

    expect(queries.some((sql) => sql.includes("CREATE TEMP TABLE import_stage"))).toBe(false);
    expect(queries.some((sql) => sql.includes("UPDATE import_batch SET status='FAILED'"))).toBe(true);
    expect(queries.some((sql) => sql.includes("INSERT INTO import_issue"))).toBe(true);
  });

  it("uses the configured database volume without requiring PostgreSQL settings privileges", async () => {
    const queries: string[] = [];
    const query = vi.fn(async (statement: unknown) => {
      const sql = typeof statement === "string" ? statement : "COPY_STREAM";
      queries.push(sql);
      if (sql.includes("SELECT status FROM import_batch")) return { rows: [{ status: "COMMITTING" }] };
      if (sql.includes("sum(size_bytes)")) return { rows: [{ source_bytes: "1024" }] };
      if (sql === "SHOW data_directory") {
        const denied = new Error("permission denied to examine data_directory") as Error & { code: string };
        denied.code = "42501";
        throw denied;
      }
      if (sql.includes("CREATE TEMP TABLE import_stage")) throw new Error("COPY_STARTED_AFTER_CAPACITY_CHECK");
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const store = {} as EncryptedObjectStore;
    mockedStatfs.mockResolvedValue({ bavail: 1024n ** 4n, bsize: 1n } as Awaited<ReturnType<typeof statfs>>);

    await expect(commitImportBatch(
      pool,
      store,
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "D:\\PostgreSQL\\data5433",
    )).rejects.toThrow("COPY_STARTED_AFTER_CAPACITY_CHECK");

    expect(queries).not.toContain("SHOW data_directory");
  });

  it("persists a SQL contract failure on its first attempt", async () => {
    const queries: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    const databaseError = Object.assign(new Error("syntax error in import materialization"), { code: "42601" });
    const query = vi.fn(async (statement: unknown, parameters?: readonly unknown[]) => {
      const sql = typeof statement === "string" ? statement : "COPY_STREAM";
      queries.push({ sql, ...(parameters ? { parameters } : {}) });
      if (sql.includes("SELECT status FROM import_batch")) return { rows: [{ status: "COMMITTING" }] };
      if (sql.includes("sum(size_bytes)")) return { rows: [{ source_bytes: "1024" }] };
      if (sql.includes("CREATE TEMP TABLE import_stage")) throw databaseError;
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    mockedStatfs.mockResolvedValue({ bavail: 1024n ** 4n, bsize: 1n } as Awaited<ReturnType<typeof statfs>>);

    await expect(commitImportBatch(
      pool,
      {} as EncryptedObjectStore,
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "D:\\PostgreSQL\\data5433",
    )).rejects.toBe(databaseError);

    expect(isPersistedImportCommitFailure(databaseError)).toBe(true);
    expect(queries.find(({ sql }) => sql.includes("UPDATE import_batch SET status='FAILED'"))?.parameters?.[1])
      .toBe("IMPORT_QUERY_INVALID");
  });
});
