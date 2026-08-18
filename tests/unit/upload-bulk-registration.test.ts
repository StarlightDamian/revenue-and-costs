import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadService } from "../../src/modules/uploads/service.js";

const roots: string[] = [];

async function storageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "revenue-upload-bulk-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("upload bulk registration", () => {
  it("rejects file-count, total-size, safe-path and metadata-only violations before opening a transaction", async () => {
    const connect = vi.fn();
    const service = new UploadService({ connect } as unknown as Pool, await storageRoot());

    await expect(service.createBatchWithFiles("shop-id", "account-id", "registration-key",
      Array.from({ length: 20_001 }, (_, index) => ({ relativePath: `part-${index}.csv`, declaredSize: 0n }))))
      .rejects.toThrow("UPLOAD_BATCH_LIMIT");
    await expect(service.createBatchWithFiles("shop-id", "account-id", "registration-key", [
      { relativePath: "one.csv", declaredSize: 1024n * 1024n * 1024n + 1n },
      { relativePath: "two.csv", declaredSize: 1024n * 1024n * 1024n },
    ])).rejects.toThrow("UPLOAD_BATCH_LIMIT");
    await expect(service.createBatchWithFiles("shop-id", "account-id", "registration-key", [
      { relativePath: "../escape.csv", declaredSize: 1n },
    ])).rejects.toThrow("UNSAFE_RELATIVE_PATH");
    await expect(service.createBatchWithFiles("shop-id", "account-id", "registration-key", [
      { relativePath: "summary.csv", declaredSize: 0n, metadataOnly: true },
    ])).rejects.toThrow("UPLOAD_METADATA_ONLY_PDF_REQUIRED");
    expect(connect).not.toHaveBeenCalled();
  });

  it("creates batch, files, PDF metadata and zero-byte outbox in one transaction with one batch lock", async () => {
    const calls: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, parameters?: readonly unknown[]) {
        calls.push({ sql, ...(parameters ? { parameters } : {}) });
        if (sql.includes("FROM import_batch WHERE shop_id")) return { rows: [], rowCount: 0 };
        if (sql.includes("SELECT declared_bytes, file_count FROM upload_batch")) {
          return { rows: [{ declared_bytes: "0", file_count: 0 }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO upload_file")) {
          const ids = parameters?.[1] as string[];
          return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
        }
        if (sql.includes("INSERT INTO import_file")) return { rows: [], rowCount: 1 };
        if (sql.includes("INSERT INTO outbox_event")) return { rows: [{ id: "outbox-id" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    const service = new UploadService(pool, await storageRoot());

    const result = await service.createBatchWithFiles("shop-id", "account-id", "registration-key", [
      { relativePath: "zero.csv", declaredSize: 0n, contentType: "text/csv" },
      { relativePath: "docs/summary.bin", declaredSize: 0n, contentType: "application/pdf", metadataOnly: true },
    ], { periodStart: "2026-04", periodEnd: "2026-06" });

    expect(result.files.map((file) => file.relativePath)).toEqual(["zero.csv", "docs/summary.bin"]);
    expect(result.files.every((file) => file.offset === "0")).toBe(true);
    expect(calls.filter((call) => call.sql.includes("SELECT declared_bytes, file_count FROM upload_batch"))).toHaveLength(1);
    expect(calls.filter((call) => call.sql.includes("INSERT INTO upload_file"))).toHaveLength(1);
    expect(calls.some((call) => call.sql.includes("INSERT INTO import_file") && call.sql.includes("file.metadata_only"))).toBe(true);
    expect(calls.find((call) => call.sql.includes("INSERT INTO import_batch"))?.parameters?.slice(-2)).toEqual(["2026-04-01", "2026-06-01"]);
    expect(calls.some((call) => call.sql.includes("INSERT INTO outbox_event") && call.sql.includes("upload.finalize"))).toBe(true);
    expect(calls[0]?.sql).toBe("BEGIN");
    const existingIndex = calls.findIndex((call) => call.sql.includes("idempotency_key=$2"));
    const shopLockIndex = calls.findIndex((call) => call.sql.includes("FROM shop") && call.sql.includes("FOR UPDATE"));
    const replayCheckIndex = calls.findIndex((call) => call.sql.includes("idempotency_key LIKE 'admin-source-replay:%'"));
    const batchInsertIndex = calls.findIndex((call) => call.sql.includes("INSERT INTO upload_batch"));
    expect(shopLockIndex).toBeGreaterThan(existingIndex);
    expect(replayCheckIndex).toBeGreaterThan(shopLockIndex);
    expect(batchInsertIndex).toBeGreaterThan(replayCheckIndex);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("fails closed before creating an ordinary batch while a source replay owns the shop workflow", async () => {
    const calls: string[] = [];
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (sql.includes("idempotency_key=$2")) return { rows: [], rowCount: 0 };
        if (sql.includes("idempotency_key LIKE 'admin-source-replay:%'")) {
          return { rows: [{ id: "active-replay" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    const service = new UploadService(pool, await storageRoot());

    await expect(service.createBatch("shop-id", "account-id", "ordinary-upload"))
      .rejects.toMatchObject({ code: "UPLOAD_SOURCE_REPLAY_IN_PROGRESS", statusCode: 409 });

    expect(calls.some((sql) => sql.includes("FROM shop") && sql.includes("FOR UPDATE"))).toBe(true);
    expect(calls.some((sql) => sql.includes("INSERT INTO upload_batch"))).toBe(false);
    expect(calls.at(-1)).toBe("ROLLBACK");
  });

  it("replays the committed file list in request order with current offsets", async () => {
    const calls: string[] = [];
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (sql.includes("FROM import_batch WHERE shop_id")) {
          return { rows: [{ upload_batch_id: "batch-id" }], rowCount: 1 };
        }
        if (sql.includes("FROM upload_file WHERE batch_id")) {
          return {
            rows: [
              { id: "pdf-id", relative_path: "docs/summary.pdf", declared_size: "0", received_size: "0", content_type: "application/pdf", metadata_only: true },
              { id: "csv-id", relative_path: "part.csv", declared_size: "12", received_size: "8", content_type: "text/csv", metadata_only: false },
            ],
            rowCount: 2,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    const service = new UploadService(pool, await storageRoot());

    const result = await service.createBatchWithFiles("shop-id", "account-id", "registration-key", [
      { relativePath: "part.csv", declaredSize: 12n, contentType: "text/csv" },
      { relativePath: "docs/summary.pdf", declaredSize: 0n, contentType: "application/pdf", metadataOnly: true },
    ]);

    expect(result).toEqual({
      id: "batch-id",
      files: [
        { id: "csv-id", relativePath: "part.csv", offset: "8" },
        { id: "pdf-id", relativePath: "docs/summary.pdf", offset: "0" },
      ],
    });
    expect(calls.some((sql) => sql.includes("INSERT INTO upload_batch"))).toBe(false);
    expect(calls.at(-1)).toBe("COMMIT");
  });

  it("rejects a fileless replay of an idempotency key that already owns a file manifest", async () => {
    const calls: string[] = [];
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (sql.includes("FROM import_batch WHERE shop_id")) {
          return { rows: [{ upload_batch_id: "batch-id" }], rowCount: 1 };
        }
        if (sql.includes("FROM upload_file WHERE batch_id")) {
          return {
            rows: [{
              id: "csv-id",
              relative_path: "part.csv",
              declared_size: "12",
              received_size: "8",
              content_type: "text/csv",
              metadata_only: false,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    const service = new UploadService(pool, await storageRoot());

    await expect(service.createBatch("shop-id", "account-id", "registration-key"))
      .rejects.toThrow("IDEMPOTENCY_KEY_REUSED");

    expect(calls.some((sql) => sql.includes("FROM upload_file WHERE batch_id"))).toBe(true);
    expect(calls.at(-1)).toBe("ROLLBACK");
  });

  it("rejects an idempotent replay that changes the frozen accounting period", async () => {
    const calls: string[] = [];
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (sql.includes("FROM import_batch WHERE shop_id")) {
          return { rows: [{ upload_batch_id: "batch-id", accounting_period_start: "2026-04", accounting_period_end: "2026-06" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const service = new UploadService({ connect: async () => client as unknown as PoolClient } as unknown as Pool, await storageRoot());

    await expect(service.createBatchWithFiles("shop-id", "account-id", "registration-key", [
      { relativePath: "part.csv", declaredSize: 12n, contentType: "text/csv" },
    ], { periodStart: "2026-05", periodEnd: "2026-06" })).rejects.toMatchObject({
      code: "UPLOAD_IDEMPOTENCY_SCOPE_MISMATCH",
      statusCode: 409,
    });

    expect(calls.some((sql) => sql.includes("FROM upload_file"))).toBe(false);
    expect(calls.at(-1)).toBe("ROLLBACK");
  });

  it("rolls back every metadata row and removes created temp files when registration fails", async () => {
    const calls: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    let tempPath = "";
    const client = {
      async query(sql: string, parameters?: readonly unknown[]) {
        calls.push({ sql, ...(parameters ? { parameters } : {}) });
        if (sql.includes("FROM import_batch WHERE shop_id")) return { rows: [], rowCount: 0 };
        if (sql.includes("SELECT declared_bytes, file_count FROM upload_batch")) {
          return { rows: [{ declared_bytes: "0", file_count: 0 }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO upload_file")) {
          tempPath = String((parameters?.[6] as string[])[0]);
          return { rows: [], rowCount: 2 };
        }
        if (sql.includes("INSERT INTO import_file")) throw new Error("synthetic metadata insert failure");
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    const service = new UploadService(pool, await storageRoot());

    await expect(service.createBatchWithFiles("shop-id", "account-id", "registration-key", [
      { relativePath: "part.csv", declaredSize: 12n, contentType: "text/csv" },
      { relativePath: "docs/summary.pdf", declaredSize: 0n, contentType: "application/pdf", metadataOnly: true },
    ])).rejects.toThrow("synthetic metadata insert failure");

    expect(calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(tempPath).toBeTruthy();
    await expect(access(tempPath)).rejects.toThrow();
  });
});
