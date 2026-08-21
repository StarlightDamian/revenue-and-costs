import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { MAX_CHUNK_BYTES, UploadService } from "../../src/modules/uploads/service.js";

describe("compressed upload chunks", () => {
  it("streams gzip transport into the exact original bytes and advances the logical offset", async () => {
    const root = await mkdtemp(join(tmpdir(), "rc-upload-gzip-"));
    const tempPath = join(root, "upload.part");
    const raw = Buffer.from("date,amount\n2026-08-10,123.45\n".repeat(5_000));
    const handle = await open(tempPath, "w");
    await handle.truncate(raw.length);
    await handle.close();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("file.id AS file_id")) {
        return {
          rows: [{ file_id: "30000000-0000-4000-8000-000000000003", batch_id: "batch", temp_path: tempPath, declared_size: String(raw.length), received_size: "0" }],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT batch.id")) return { rows: [{ id: "batch" }], rowCount: 1 };
      if (sql.includes("SELECT batch_id,temp_path")) {
        return {
          rows: [{ batch_id: "batch", temp_path: tempPath, declared_size: String(raw.length), received_size: "0" }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO outbox_event")) return { rows: [{ id: "outbox" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { query, connect: async () => client } as unknown as Pool;

    try {
      const next = await new UploadService(pool, root).appendChunk({
        fileId: "30000000-0000-4000-8000-000000000003",
        expectedOffset: 0n,
        length: raw.length,
        expectedSha256: createHash("sha256").update(raw).digest("base64"),
        contentEncoding: "gzip",
        body: Readable.from(gzipSync(raw)),
      });

      expect(next).toBe(BigInt(raw.length));
      expect(await readFile(tempPath)).toEqual(raw);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO upload_chunk_receipt"),
        expect.arrayContaining([raw.length]),
      );
      expect(query.mock.calls.some(([sql]) => String(sql).includes("upload.finalize"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not hold a PostgreSQL client while a network chunk is still arriving", async () => {
    const root = await mkdtemp(join(tmpdir(), "rc-upload-stream-"));
    const tempPath = join(root, "upload.part");
    const raw = Buffer.from("bounded streaming upload");
    const handle = await open(tempPath, "w");
    await handle.truncate(raw.length);
    await handle.close();
    const transactionQuery = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT batch.id")) return { rows: [{ id: "batch" }], rowCount: 1 };
      if (sql.includes("SELECT batch_id,temp_path")) {
        return { rows: [{ batch_id: "batch", temp_path: tempPath, declared_size: String(raw.length), received_size: "0" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO outbox_event")) return { rows: [{ id: "outbox" }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query: transactionQuery, release: vi.fn() } as unknown as PoolClient;
    const connect = vi.fn(async () => client);
    const preflightQuery = vi.fn(async () => ({
      rows: [{ file_id: "30000000-0000-4000-8000-000000000003", batch_id: "batch", temp_path: tempPath, declared_size: String(raw.length), received_size: "0" }],
      rowCount: 1,
    }));
    const body = new PassThrough();
    const pool = { query: preflightQuery, connect } as unknown as Pool;

    try {
      const pending = new UploadService(pool, root).appendChunk({
        fileId: "30000000-0000-4000-8000-000000000003",
        expectedOffset: 0n,
        length: raw.length,
        expectedSha256: createHash("sha256").update(raw).digest("hex"),
        body,
      });
      body.write(raw.subarray(0, 4));
      await vi.waitFor(() => expect(preflightQuery).toHaveBeenCalledOnce());
      expect(connect).not.toHaveBeenCalled();
      body.end(raw.subarray(4));

      await expect(pending).resolves.toBe(BigInt(raw.length));
      expect(connect).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects gzip expansion beyond the logical chunk ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "rc-upload-gzip-limit-"));
    const tempPath = join(root, "upload.part");
    const expanded = Buffer.alloc(MAX_CHUNK_BYTES + 1, 65);
    const handle = await open(tempPath, "w");
    await handle.truncate(MAX_CHUNK_BYTES);
    await handle.close();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("file.id AS file_id")) {
        return {
          rows: [{ file_id: "30000000-0000-4000-8000-000000000003", batch_id: "batch", temp_path: tempPath, declared_size: String(MAX_CHUNK_BYTES), received_size: "0" }],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT batch.id")) return { rows: [{ id: "batch" }], rowCount: 1 };
      if (sql.includes("SELECT batch_id,temp_path")) {
        return {
          rows: [{ batch_id: "batch", temp_path: tempPath, declared_size: String(MAX_CHUNK_BYTES), received_size: "0" }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const connect = vi.fn(async () => client);
    const pool = { query, connect } as unknown as Pool;

    try {
      await expect(new UploadService(pool, root).appendChunk({
        fileId: "30000000-0000-4000-8000-000000000003",
        expectedOffset: 0n,
        length: MAX_CHUNK_BYTES,
        expectedSha256: createHash("sha256").update(expanded.subarray(0, MAX_CHUNK_BYTES)).digest("base64"),
        contentEncoding: "gzip",
        body: Readable.from(gzipSync(expanded)),
      })).rejects.toThrow("CHUNK_TOO_LARGE");
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
