import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadService } from "../../src/modules/uploads/service.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "revenue-upload-removal-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("staged upload removal", () => {
  it("atomically excludes selected staged files, audits the action and removes plaintext artifacts", async () => {
    const root = await temporaryRoot();
    const batchId = "10000000-0000-4000-8000-000000000001";
    const fileId = "20000000-0000-4000-8000-000000000002";
    const importBatchId = "30000000-0000-4000-8000-000000000003";
    const actorId = "40000000-0000-4000-8000-000000000004";
    const tempPath = join(root, `${fileId}.part`);
    const archiveRoot = join(root, "archive", fileId);
    const chunkRoot = join(root, "chunks", fileId);
    await writeFile(tempPath, "uploaded plaintext", "utf8");
    await mkdir(archiveRoot, { recursive: true });
    await mkdir(chunkRoot, { recursive: true });
    await writeFile(join(archiveRoot, "expanded.csv"), "expanded plaintext", "utf8");
    await writeFile(join(chunkRoot, "chunk.part"), "chunk plaintext", "utf8");

    const calls: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, parameters?: readonly unknown[]) {
        calls.push({ sql, ...(parameters ? { parameters } : {}) });
        if (sql.includes("JOIN import_batch") && sql.includes("FOR UPDATE OF")) {
          return { rows: [{ upload_status: "UPLOADING", import_batch_id: importBatchId, import_status: "UPLOADING" }], rowCount: 1 };
        }
        if (sql.includes("FROM upload_file") && sql.includes("ORDER BY file.id") && sql.includes("FOR UPDATE")) {
          return { rows: [{
            id: fileId,
            status: "COMPLETE",
            temp_path: tempPath,
            declared_size: "18",
            received_size: "18",
            metadata_only: false,
            stored_object_id: null,
            archive_reservation_state: "NONE",
            removed_before: false,
          }], rowCount: 1 };
        }
        if (sql.includes("count(*)::text AS count")) return { rows: [{ count: "1" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const cleanup = vi.fn(async () => ({ rows: [{ cleaned: true }], rowCount: 1 }));
    const pool = { connect: async () => client as unknown as PoolClient, query: cleanup } as unknown as Pool;

    await expect(new UploadService(pool, root).removeFiles(batchId, [fileId], actorId)).resolves.toEqual({
      removedCount: 1,
      remainingCount: 1,
      cancelled: false,
    });

    expect(calls.at(0)?.sql).toBe("BEGIN");
    expect(calls.at(-1)?.sql).toBe("COMMIT");
    expect(calls.find((call) => call.sql.includes("FOR UPDATE OF upload,batch_import"))).toBeTruthy();
    expect(calls.find((call) => call.sql.includes("FROM upload_file") && call.sql.includes("ORDER BY file.id"))?.parameters)
      .toEqual([batchId, [fileId]]);
    expect(calls.find((call) => call.sql.includes("SET declared_bytes=declared_bytes-$2"))?.parameters)
      .toEqual([batchId, "18", "18", 1]);
    expect(calls.find((call) => call.sql.includes("UPDATE upload_file"))?.sql).toContain("status='FAILED'");
    const audit = calls.find((call) => call.sql.includes("INSERT INTO audit_event") && call.sql.includes("UPLOAD_FILES_REMOVED_BEFORE_IMPORT"));
    expect(audit?.parameters?.slice(0, 2)).toEqual([actorId, batchId]);
    expect(calls.some((call) => call.sql.includes("UPDATE upload_batch SET status='CANCELLED'"))).toBe(false);
    expect(cleanup).toHaveBeenCalledWith(expect.stringContaining("UPDATE upload_file SET temp_path=''"), [fileId, tempPath]);
    await expect(access(tempPath)).rejects.toThrow();
    await expect(access(archiveRoot)).rejects.toThrow();
    await expect(access(chunkRoot)).rejects.toThrow();
  });

  it("cancels an empty batch, sorts a multi-selection and supports an idempotent retry", async () => {
    const root = await temporaryRoot();
    const batchId = "10000000-0000-4000-8000-000000000001";
    const firstId = "20000000-0000-4000-8000-000000000002";
    const secondId = "20000000-0000-4000-8000-000000000003";
    const importBatchId = "30000000-0000-4000-8000-000000000003";
    let attempt = 0;
    const calls: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, parameters?: readonly unknown[]) {
        calls.push({ sql, ...(parameters ? { parameters } : {}) });
        if (sql.includes("JOIN import_batch") && sql.includes("FOR UPDATE OF")) {
          return { rows: [{
            upload_status: attempt === 0 ? "UPLOADING" : "CANCELLED",
            import_batch_id: importBatchId,
            import_status: attempt === 0 ? "UPLOADING" : "CANCELLED",
          }], rowCount: 1 };
        }
        if (sql.includes("FROM upload_file") && sql.includes("ORDER BY file.id") && sql.includes("FOR UPDATE")) {
          return { rows: [firstId, secondId].map((id) => ({
            id,
            status: attempt === 0 ? "COMPLETE" : "FAILED",
            temp_path: "",
            declared_size: id === firstId ? "7" : "11",
            received_size: id === firstId ? "5" : "11",
            metadata_only: false,
            stored_object_id: null,
            archive_reservation_state: "NONE",
            removed_before: attempt > 0,
          })), rowCount: 2 };
        }
        if (sql.includes("count(*)::text AS count")) return { rows: [{ count: "0" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = { connect: async () => client as unknown as PoolClient, query: vi.fn() } as unknown as Pool;
    const service = new UploadService(pool, root);

    await expect(service.removeFiles(batchId, [secondId, firstId], "40000000-0000-4000-8000-000000000004"))
      .resolves.toEqual({ removedCount: 2, remainingCount: 0, cancelled: true });
    attempt += 1;
    const firstAttemptCalls = calls.length;
    await expect(service.removeFiles(batchId, [firstId, secondId], "40000000-0000-4000-8000-000000000004"))
      .resolves.toEqual({ removedCount: 2, remainingCount: 0, cancelled: true });

    const fileLocks = calls.filter((call) => call.sql.includes("FROM upload_file") && call.sql.includes("ORDER BY file.id"));
    expect(fileLocks[0]?.parameters?.[1]).toEqual([firstId, secondId]);
    expect(calls.slice(0, firstAttemptCalls).find((call) => call.sql.includes("SET declared_bytes=declared_bytes-$2"))?.parameters)
      .toEqual([batchId, "18", "16", 2]);
    expect(calls.slice(0, firstAttemptCalls).some((call) => call.sql.includes("UPDATE upload_batch SET status='CANCELLED'"))).toBe(true);
    expect(calls.slice(0, firstAttemptCalls).some((call) => call.sql.includes("UPDATE import_batch SET status='CANCELLED'"))).toBe(true);
    expect(calls.slice(firstAttemptCalls).some((call) => call.sql.includes("UPDATE upload_file"))).toBe(false);
    expect(calls.slice(firstAttemptCalls).some((call) => call.sql.includes("SET declared_bytes=declared_bytes-$2"))).toBe(false);
    expect(calls.slice(firstAttemptCalls).some((call) => call.sql.includes("INSERT INTO audit_event"))).toBe(false);
  });

  it("rolls back instead of making batch usage counters negative", async () => {
    const root = await temporaryRoot();
    const batchId = "10000000-0000-4000-8000-000000000001";
    const fileId = "20000000-0000-4000-8000-000000000002";
    const calls: string[] = [];
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (sql.includes("JOIN import_batch") && sql.includes("FOR UPDATE OF")) {
          return { rows: [{ upload_status: "UPLOADING", import_batch_id: "30000000-0000-4000-8000-000000000003", import_status: "UPLOADING" }], rowCount: 1 };
        }
        if (sql.includes("FROM upload_file") && sql.includes("ORDER BY file.id")) {
          return { rows: [{
            id: fileId,
            status: "COMPLETE",
            temp_path: "",
            declared_size: "8",
            received_size: "8",
            metadata_only: false,
            stored_object_id: null,
            archive_reservation_state: "NONE",
            removed_before: false,
          }], rowCount: 1 };
        }
        if (sql.includes("count(*)::text AS count")) return { rows: [{ count: "0" }], rowCount: 1 };
        if (sql.includes("SET declared_bytes=declared_bytes-$2")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const cleanup = vi.fn();
    const pool = { connect: async () => client as unknown as PoolClient, query: cleanup } as unknown as Pool;

    await expect(new UploadService(pool, root).removeFiles(batchId, [fileId], "40000000-0000-4000-8000-000000000004"))
      .rejects.toThrow("UPLOAD_BATCH_USAGE_CORRUPTED");
    expect(calls.at(-1)).toBe("ROLLBACK");
    expect(calls.some((sql) => sql.includes("UPDATE upload_file") && sql.includes("status='FAILED'"))).toBe(false);
    expect(calls.some((sql) => sql.includes("INSERT INTO audit_event"))).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("fails closed once any selected file has entered immutable archival state", async () => {
    const root = await temporaryRoot();
    const batchId = "10000000-0000-4000-8000-000000000001";
    const fileId = "20000000-0000-4000-8000-000000000002";
    const tempPath = join(root, `${fileId}.part`);
    await writeFile(tempPath, "must remain", "utf8");
    const calls: string[] = [];
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (sql.includes("JOIN import_batch") && sql.includes("FOR UPDATE OF")) {
          return { rows: [{ upload_status: "UPLOADING", import_batch_id: "30000000-0000-4000-8000-000000000003", import_status: "UPLOADING" }], rowCount: 1 };
        }
        if (sql.includes("FROM upload_file") && sql.includes("ORDER BY file.id")) {
          return { rows: [{
            id: fileId,
            status: "ENCRYPTING",
            temp_path: tempPath,
            declared_size: "11",
            received_size: "11",
            metadata_only: false,
            stored_object_id: null,
            archive_reservation_state: "RESERVED",
            removed_before: false,
          }], rowCount: 1 };
        }
        if (sql.includes("count(*)::text AS count")) return { rows: [{ count: "0" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const cleanup = vi.fn();
    const pool = { connect: async () => client as unknown as PoolClient, query: cleanup } as unknown as Pool;

    await expect(new UploadService(pool, root).removeFiles(batchId, [fileId], "40000000-0000-4000-8000-000000000004"))
      .rejects.toMatchObject({ code: "UPLOAD_FILE_REMOVAL_IMMUTABLE", statusCode: 409 });
    expect(calls.at(-1)).toBe("ROLLBACK");
    expect(calls.some((sql) => sql.includes("UPDATE upload_file"))).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    await expect(access(tempPath)).resolves.toBeUndefined();
  });

  it("defers finalization until completeBatch freezes the staged manifest", async () => {
    const root = await temporaryRoot();
    const batchId = "10000000-0000-4000-8000-000000000001";
    const importBatchId = "30000000-0000-4000-8000-000000000003";
    const calls: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, parameters?: readonly unknown[]) {
        calls.push({ sql, ...(parameters ? { parameters } : {}) });
        if (sql === "SELECT status FROM upload_batch WHERE id=$1 FOR UPDATE") return { rows: [{ status: "UPLOADING" }], rowCount: 1 };
        if (sql.includes("AS pending") && sql.includes("AS processable")) return { rows: [{ pending: "0", processable: "2" }], rowCount: 1 };
        if (sql.includes("SELECT id,status FROM import_batch")) return { rows: [{ id: importBatchId, status: "UPLOADING" }], rowCount: 1 };
        if (sql.includes("SELECT status,shop_id,created_by FROM import_batch")) {
          return { rows: [{ status: "UPLOADING", shop_id: "50000000-0000-4000-8000-000000000005", created_by: "40000000-0000-4000-8000-000000000004" }], rowCount: 1 };
        }
        if (sql.includes("count(DISTINCT coalesce")) return { rows: [{ expected: "2", analyzed: "0", parsed: "0", awaiting: "0", failed: "0" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;

    await expect(new UploadService(pool, root).completeBatch(batchId)).resolves.toEqual({
      id: importBatchId,
      status: "ANALYZING",
    });

    const uploadLock = calls.findIndex((call) => call.sql === "SELECT status FROM upload_batch WHERE id=$1 FOR UPDATE");
    const importLock = calls.findIndex((call) => call.sql === "SELECT id,status FROM import_batch WHERE upload_batch_id=$1 FOR UPDATE");
    const stagedCheck = calls.findIndex((call) => call.sql.includes("AS pending") && call.sql.includes("AS processable"));
    const freeze = calls.findIndex((call) => call.sql.includes("UPDATE upload_batch SET status = 'READY'"));
    const enqueue = calls.findIndex((call) => call.sql.includes("'upload.finalize'"));
    expect(uploadLock).toBeGreaterThan(0);
    expect(importLock).toBeGreaterThan(uploadLock);
    expect(stagedCheck).toBeGreaterThan(importLock);
    expect(freeze).toBeGreaterThan(0);
    expect(enqueue).toBeGreaterThan(freeze);
    expect(calls[enqueue]?.sql).toContain("file.status='COMPLETE' AND NOT file.metadata_only");
    expect(calls[enqueue]?.sql).toContain("JOIN upload_batch upload");
    expect(calls[enqueue]?.sql).toContain("JOIN import_batch batch_import");
    expect(calls[enqueue]?.sql).toContain("upload.status='READY'");
    expect(calls[enqueue]?.sql).toContain("batch_import.status=ANY($2::text[])");
    expect(calls[enqueue]?.parameters).toEqual([batchId, [
      "UPLOADING",
      "ANALYZING",
      "AWAITING_MAPPING",
      "AWAITING_COMMIT_CONFIRMATION",
    ]]);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("locks and checks the import before leaving a terminal import/upload pair unchanged", async () => {
    const root = await temporaryRoot();
    const batchId = "10000000-0000-4000-8000-000000000001";
    const importBatchId = "30000000-0000-4000-8000-000000000003";
    const calls: string[] = [];
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (sql === "SELECT status FROM upload_batch WHERE id=$1 FOR UPDATE") {
          return { rows: [{ status: "UPLOADING" }], rowCount: 1 };
        }
        if (sql === "SELECT id,status FROM import_batch WHERE upload_batch_id=$1 FOR UPDATE") {
          return { rows: [{ id: importBatchId, status: "RESULT_PUBLISHED" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;

    await expect(new UploadService(pool, root).completeBatch(batchId)).resolves.toEqual({
      id: importBatchId,
      status: "RESULT_PUBLISHED",
    });

    const uploadLock = calls.indexOf("SELECT status FROM upload_batch WHERE id=$1 FOR UPDATE");
    const importLock = calls.indexOf("SELECT id,status FROM import_batch WHERE upload_batch_id=$1 FOR UPDATE");
    expect(importLock).toBeGreaterThan(uploadLock);
    expect(calls.some((sql) => sql.includes("AS processable"))).toBe(false);
    expect(calls.some((sql) => sql.includes("UPDATE upload_batch SET status = 'READY'"))).toBe(false);
    expect(calls.some((sql) => sql.includes("INSERT INTO outbox_event"))).toBe(false);
    expect(calls.at(-1)).toBe("COMMIT");
  });

  it("does not freeze or enqueue an empty or all-failed staged batch", async () => {
    const root = await temporaryRoot();
    const calls: string[] = [];
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (sql === "SELECT status FROM upload_batch WHERE id=$1 FOR UPDATE") return { rows: [{ status: "UPLOADING" }], rowCount: 1 };
        if (sql === "SELECT id,status FROM import_batch WHERE upload_batch_id=$1 FOR UPDATE") {
          return { rows: [{ id: "30000000-0000-4000-8000-000000000003", status: "UPLOADING" }], rowCount: 1 };
        }
        if (sql.includes("AS pending") && sql.includes("AS processable")) return { rows: [{ pending: "0", processable: "0" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;

    await expect(new UploadService(pool, root).completeBatch("10000000-0000-4000-8000-000000000001"))
      .rejects.toMatchObject({ code: "UPLOAD_BATCH_NO_STAGED_FILES", statusCode: 409 });
    expect(calls.at(-1)).toBe("ROLLBACK");
    expect(calls.some((sql) => sql.includes("UPDATE upload_batch SET status = 'READY'"))).toBe(false);
    expect(calls.some((sql) => sql.includes("INSERT INTO outbox_event"))).toBe(false);
  });
});
