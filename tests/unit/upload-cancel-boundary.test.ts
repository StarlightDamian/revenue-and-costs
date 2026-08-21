import type { Pool, PoolClient } from "pg";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadService, expireUploadStaging } from "../../src/modules/uploads/service.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("upload cancellation boundary", () => {
  it.each(["cancel", "expire"] as const)("cleans residual STORED plaintext during explicit %s without deleting object records", async (operation) => {
    const root = await mkdtemp(join(tmpdir(), `upload-${operation}-stored-`));
    temporaryRoots.push(root);
    const tempPath = join(root, "stored.part");
    const fileId = "00000000-0000-4000-8000-000000000002";
    const archiveRoot = join(root, "archive", fileId);
    await writeFile(tempPath, "plaintext", "utf8");
    await mkdir(archiveRoot, { recursive: true });
    await writeFile(join(archiveRoot, "child.part"), "expanded plaintext", "utf8");
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("UPDATE upload_batch") && sql.includes("RETURNING id")) {
          return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }], rowCount: 1 };
        }
        if (sql.includes("FROM upload_file") && sql.includes("FOR UPDATE")) {
          return {
            rows: [{
              id: fileId,
              batch_id: "00000000-0000-4000-8000-000000000001",
              status: "STORED",
              temp_path: tempPath,
              archive_reservation_state: "COMMITTED",
              archive_expanded_bytes: "1024",
              archive_file_count: 1,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = {
      connect: async () => client as unknown as PoolClient,
      query: async () => ({ rows: [{ cleaned: true }], rowCount: 1 }),
    } as unknown as Pool;

    if (operation === "cancel") {
      await new UploadService(pool, root).cancelBatch("00000000-0000-4000-8000-000000000001");
    } else {
      await expireUploadStaging(pool);
    }

    await expect(access(tempPath)).rejects.toThrow();
    await expect(access(archiveRoot)).rejects.toThrow();
    const stagingQuery = queries.find((sql) => sql.includes("archive_expanded_bytes::text") && sql.includes("FOR UPDATE"));
    expect(stagingQuery).toContain("temp_path<>''");
    if (operation === "cancel") {
      expect(stagingQuery).toContain("'STORED'");
      expect(stagingQuery).toContain("'FAILED'");
    } else {
      expect(stagingQuery).toContain("'EXPIRED','CANCELLED'");
    }
    expect(queries.some((sql) => /DELETE\s+FROM\s+stored_object/iu.test(sql))).toBe(false);
    const fileUpdate = queries.find((sql) => sql.includes("UPDATE upload_file"));
    expect(fileUpdate).toContain(operation === "cancel"
      ? "status<>'STORED'"
      : "CASE WHEN status='STORED' THEN status ELSE 'FAILED' END");
  });

  it("durably reselects an EXPIRED batch after filesystem cleanup fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-expiry-retry-"));
    temporaryRoots.push(root);
    const batchId = "00000000-0000-4000-8000-000000000001";
    const fileId = "00000000-0000-4000-8000-000000000002";
    const tempPath = join(root, `${fileId}.part`);
    const archiveRoot = join(root, "archive", fileId);
    await mkdir(tempPath);
    await mkdir(archiveRoot, { recursive: true });
    await writeFile(join(archiveRoot, "child.part"), "expanded plaintext", "utf8");
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("UPDATE upload_batch batch") && sql.includes("RETURNING batch.id")) {
          return { rows: [{ id: batchId }], rowCount: 1 };
        }
        if (sql.includes("FROM upload_file file")) {
          return {
            rows: [{
              id: fileId,
              batch_id: batchId,
              status: "FAILED",
              temp_path: tempPath,
              archive_reservation_state: "NONE",
              archive_expanded_bytes: "0",
              archive_file_count: 0,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const markCleaned = vi.fn(async () => ({ rows: [{ cleaned: true }], rowCount: 1 }));
    const pool = {
      connect: async () => client as unknown as PoolClient,
      query: markCleaned,
    } as unknown as Pool;

    await expect(expireUploadStaging(pool)).resolves.toBe(0);
    expect(markCleaned).not.toHaveBeenCalled();

    await rm(tempPath, { recursive: true, force: true });
    await writeFile(tempPath, "parent plaintext", "utf8");
    await mkdir(archiveRoot, { recursive: true });
    await writeFile(join(archiveRoot, "child.part"), "expanded plaintext", "utf8");
    await expect(expireUploadStaging(pool)).resolves.toBe(1);

    const candidateQuery = queries.find((sql) => sql.includes("WITH candidates AS"));
    expect(candidateQuery).toContain("batch.status IN ('OPEN','UPLOADING','FAILED')");
    expect(candidateQuery).toContain("LIMIT 100");
    expect(candidateQuery).toContain("SKIP LOCKED");
    const cleanupQuery = queries.find((sql) => sql.includes("FROM upload_file file"));
    expect(cleanupQuery).toContain("batch.status IN ('EXPIRED','CANCELLED')");
    expect(cleanupQuery).toContain("file.status='FAILED' OR");
    expect(cleanupQuery).toContain("file.temp_path<>''");
    expect(cleanupQuery).toContain("ORDER BY file.updated_at,file.id");
    expect(cleanupQuery).toContain("LIMIT 100");
    expect(markCleaned).toHaveBeenCalledOnce();
    await expect(access(tempPath)).rejects.toThrow();
    await expect(access(archiveRoot)).rejects.toThrow();
  });

  it("recovers staging left by a crash after cancellation commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-cancelled-recovery-"));
    temporaryRoots.push(root);
    const batchId = "00000000-0000-4000-8000-000000000001";
    const fileId = "00000000-0000-4000-8000-000000000002";
    const tempPath = join(root, `${fileId}.part`);
    const archiveRoot = join(root, "archive", fileId);
    await mkdir(archiveRoot, { recursive: true });
    await writeFile(tempPath, "parent plaintext", "utf8");
    await writeFile(join(archiveRoot, "child.part"), "expanded plaintext", "utf8");
    const client = {
      async query(sql: string) {
        if (sql.includes("FROM upload_file file")) {
          return {
            rows: [{
              id: fileId,
              batch_id: batchId,
              status: "FAILED",
              temp_path: tempPath,
              archive_reservation_state: "NONE",
              archive_expanded_bytes: "0",
              archive_file_count: 0,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = {
      connect: async () => client as unknown as PoolClient,
      query: async () => ({ rows: [{ cleaned: true }], rowCount: 1 }),
    } as unknown as Pool;

    await expect(expireUploadStaging(pool)).resolves.toBe(1);
    await expect(access(tempPath)).rejects.toThrow();
    await expect(access(archiveRoot)).rejects.toThrow();
  });

  it("rejects a non-writable parent before consuming a chunk or opening a transaction", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("SELECT batch.id")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const connect = vi.fn(async () => client as unknown as PoolClient);
    const pool = {
      connect,
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;

    await expect(new UploadService(pool, ".").appendChunk({
      fileId: "00000000-0000-4000-8000-000000000001",
      expectedOffset: 0n,
      length: 0,
      expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      body: Readable.from([]),
    })).rejects.toThrow("UPLOAD_FILE_NOT_WRITABLE");

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("file.id AS file_id");
    expect(queries[0]).not.toContain("FOR UPDATE");
    expect(connect).not.toHaveBeenCalled();
  });

  it("does not cancel import states after commit has started", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("FROM upload_file") && sql.includes("FOR UPDATE")) {
          return {
            rows: [{
              id: "00000000-0000-4000-8000-000000000002",
              batch_id: "00000000-0000-4000-8000-000000000001",
              temp_path: "missing.part",
              archive_reservation_state: "NONE",
              archive_expanded_bytes: "0",
              archive_file_count: 0,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = {
      connect: async () => client as unknown as PoolClient,
      query: async () => ({ rows: [{ cleaned: true }], rowCount: 1 }),
    } as unknown as Pool;

    await new UploadService(pool, ".").cancelBatch("00000000-0000-4000-8000-000000000001");

    const importUpdate = queries.find((sql) => sql.includes("UPDATE import_batch"));
    const fileUpdate = queries.find((sql) => sql.includes("UPDATE upload_file"));
    expect(importUpdate).toContain("AWAITING_COMMIT_CONFIRMATION");
    expect(importUpdate).not.toMatch(/COMMITTING|COMMITTED|CALCULATING|RESULT_PUBLISHING|RESULT_PUBLISHED/u);
    expect(fileUpdate).toContain("status='FAILED'");
    expect(queries.at(0)).toBe("BEGIN");
    expect(queries.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects original lookup for cancelled or expired batches", async () => {
    let queryText = "";
    const pool = {
      async query(sql: string) {
        queryText = sql;
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;

    await expect(new UploadService(pool, ".").original("00000000-0000-4000-8000-000000000001"))
      .rejects.toThrow("UPLOAD_FILE_NOT_FOUND");
    expect(queryText).toContain("b.status NOT IN ('CANCELLED','EXPIRED')");
  });

  it("does not issue a download grant after the batch becomes cancelled or expired", async () => {
    let queryText = "";
    const pool = {
      async query(sql: string) {
        queryText = sql;
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;

    await expect(new UploadService(pool, ".").issueOriginalDownloadGrant(
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000003",
    )).rejects.toThrow("UPLOAD_FILE_NOT_FOUND");
    expect(queryText).toContain("b.status NOT IN ('CANCELLED','EXPIRED')");
  });

  it("atomically releases a reserved archive budget while cancelling", async () => {
    const calls: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, parameters?: readonly unknown[]) {
        calls.push({ sql, ...(parameters ? { parameters } : {}) });
        if (sql.includes("FROM upload_file") && sql.includes("FOR UPDATE")) {
          return {
            rows: [{
              id: "00000000-0000-4000-8000-000000000002",
              batch_id: "00000000-0000-4000-8000-000000000001",
              temp_path: "missing.part",
              archive_reservation_state: "RESERVED",
              archive_expanded_bytes: "1024",
              archive_file_count: 2,
            }],
            rowCount: 1,
          };
        }
        return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = {
      connect: async () => client as unknown as PoolClient,
      query: async () => ({ rows: [{ cleaned: true }], rowCount: 1 }),
    } as unknown as Pool;

    await new UploadService(pool, ".").cancelBatch("00000000-0000-4000-8000-000000000001");

    const release = calls.find((call) => call.sql.includes("FROM unnest"));
    expect(release?.parameters).toEqual([
      ["00000000-0000-4000-8000-000000000001"],
      ["1024"],
      [2],
    ]);
    const failed = calls.find((call) => call.sql.includes("UPDATE upload_file"));
    expect(failed?.sql).toContain("archive_reservation_state='NONE'");
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });
});
