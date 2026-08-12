import { createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZipArchive } from "archiver";
import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EncryptedObjectStore } from "../../src/modules/storage/encrypted-object-store.js";
import { finalizeUploadFile } from "../../src/modules/uploads/finalize.js";

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function makeZip(path: string, name: string, body: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(path, { flags: "wx" });
    const archive = new ZipArchive({ zlib: { level: 1 } });
    output.once("close", resolve);
    output.once("error", reject);
    archive.once("error", reject);
    archive.pipe(output);
    archive.append(body, { name });
    void archive.finalize();
  });
}

describe("upload finalize cancellation boundary", () => {
  it("keeps ZIP child plaintext when the parent COMMIT response is lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-finalize-zip-commit-uncertain-"));
    roots.push(root);
    const source = join(root, "source.part");
    await makeZip(source, "orders.csv", "order,amount\nA,1\n");
    const declaredSize = (await stat(source)).size.toString();
    const objectRoot = join(root, "objects");
    await mkdir(objectRoot);

    let archiveReservationState = "NONE";
    let pendingReservationState = archiveReservationState;
    let transactionContainsObject = false;
    let objectReferenced = false;
    let targetPresent = false;
    let childTempPath: string | undefined;
    const client = {
      async query(sql: string, values?: readonly unknown[]) {
        if (sql.includes("pg_advisory_lock")) return { rows: [{}], rowCount: 1 };
        if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }], rowCount: 1 };
        if (sql === "BEGIN") {
          transactionContainsObject = false;
          pendingReservationState = archiveReservationState;
          return { rows: [], rowCount: null };
        }
        if (sql === "ROLLBACK") return { rows: [], rowCount: null };
        if (sql === "COMMIT") {
          archiveReservationState = pendingReservationState;
          if (transactionContainsObject) {
            objectReferenced = true;
            throw new Error("COMMIT_RESPONSE_LOST");
          }
          return { rows: [], rowCount: null };
        }
        if (sql.includes("SELECT expanded_bytes::text,file_count") && sql.includes("status IN")) {
          return { rows: [{ expanded_bytes: "0", file_count: 1 }], rowCount: 1 };
        }
        if (sql.includes("SELECT status,archive_reservation_state")) {
          return {
            rows: [{
              status: "ENCRYPTING",
              archive_reservation_state: archiveReservationState,
              archive_expanded_bytes: archiveReservationState === "NONE" ? "0" : "17",
              archive_file_count: archiveReservationState === "NONE" ? 0 : 1,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("SET archive_reservation_state='RESERVED'")) {
          pendingReservationState = "RESERVED";
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("UPDATE upload_batch")) return { rows: [], rowCount: 1 };
        if (sql.includes("SELECT id FROM upload_batch")) return { rows: [{ id: "batch" }], rowCount: 1 };
        if (sql.includes("SELECT f.archive_reservation_state")) {
          return {
            rows: [{ archive_reservation_state: "RESERVED", archive_expanded_bytes: "17", archive_file_count: 1 }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM stored_object") && sql.includes("plaintext_sha256")) return { rows: [], rowCount: 0 };
        if (sql.includes("INSERT INTO stored_object")) {
          transactionContainsObject = true;
          return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }], rowCount: 1 };
        }
        if (sql.includes("SET status='STORED'")) {
          pendingReservationState = "COMMITTED";
          return { rows: [{ id: "file" }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO upload_file")) {
          childTempPath = String(values?.[4]);
          return { rows: [{ id: "child" }], rowCount: 1 };
        }
        if (sql.includes("outbox_event")) return { rows: [{ id: "outbox" }], rowCount: 1 };
        if (sql.includes("SELECT expanded_bytes::text,file_count") && sql.includes("FOR UPDATE")) {
          return { rows: [{ expanded_bytes: "17", file_count: 2 }], rowCount: 1 };
        }
        throw new Error(`UNEXPECTED_TRANSACTION_QUERY:${sql}`);
      },
      release: vi.fn(),
    };
    let directCalls = 0;
    const pool = {
      async query(sql: string) {
        if (sql.includes("JOIN stored_object")) {
          directCalls += 1;
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes("SET status='ENCRYPTING'")) {
          return {
            rows: [{
              id: "00000000-0000-4000-8000-000000000001",
              batch_id: "00000000-0000-4000-8000-000000000002",
              temp_path: source,
              relative_path: "archive.zip",
              declared_size: declaredSize,
              shop_id: "00000000-0000-4000-8000-000000000003",
            }],
            rowCount: 1,
          };
        }
        throw new Error(`UNEXPECTED_POOL_QUERY:${sql}`);
      },
      async connect() { return client as unknown as PoolClient; },
    } as unknown as Pool;
    const removeUncommitted = vi.fn(async () => { targetPresent = false; });
    const store = {
      removeUncommitted,
      objectPath(objectId: string) { return join(objectRoot, objectId.slice(0, 2), `${objectId}.esdk`); },
      async putFile() {
        targetPresent = true;
        return {
          objectId: "00000000-0000-4000-8000-000000000001",
          plaintextSize: BigInt(declaredSize),
          plaintextSha256: "a".repeat(64),
          ciphertextSha256: "b".repeat(64),
          path: join(objectRoot, "00", "00000000-0000-4000-8000-000000000001.esdk"),
          encryptionContext: { objectId: "00000000-0000-4000-8000-000000000001" },
        };
      },
    } as unknown as EncryptedObjectStore;

    await expect(finalizeUploadFile(pool, store, "00000000-0000-4000-8000-000000000001"))
      .rejects.toThrow("COMMIT_RESPONSE_LOST");

    expect(directCalls).toBe(1);
    expect(objectReferenced).toBe(true);
    expect(archiveReservationState).toBe("COMMITTED");
    expect(targetPresent).toBe(true);
    expect(childTempPath).toBeDefined();
    await expect(access(childTempPath!)).resolves.toBeUndefined();
  });

  it("keeps a newly committed object when the COMMIT response is lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-finalize-commit-uncertain-"));
    roots.push(root);
    const source = join(root, "source.part");
    await writeFile(source, "order,amount\nA,1\n", "utf8");
    const objectRoot = join(root, "objects");
    await mkdir(objectRoot);

    let objectReferenced = false;
    let fileStored = false;
    let transactionContainsObject = false;
    let targetPresent = true;
    let commitResponses = 0;
    const client = {
      async query(sql: string) {
        if (sql.includes("pg_advisory_lock")) return { rows: [{}], rowCount: 1 };
        if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }], rowCount: 1 };
        if (sql === "BEGIN" || sql === "ROLLBACK") return { rows: [], rowCount: null };
        if (sql === "COMMIT") {
          commitResponses += 1;
          if (commitResponses === 1) {
            objectReferenced = transactionContainsObject;
            fileStored = transactionContainsObject;
            throw new Error("COMMIT_RESPONSE_LOST");
          }
          return { rows: [], rowCount: null };
        }
        if (sql.includes("SELECT id FROM upload_batch")) return { rows: [{ id: "batch" }], rowCount: 1 };
        if (sql.includes("SELECT f.archive_reservation_state")) {
          return { rows: [{ archive_reservation_state: "NONE", archive_expanded_bytes: "0", archive_file_count: 0 }], rowCount: 1 };
        }
        if (sql.includes("FROM stored_object") && sql.includes("plaintext_sha256")) return { rows: [], rowCount: 0 };
        if (sql.includes("INSERT INTO stored_object")) {
          transactionContainsObject = true;
          return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }], rowCount: 1 };
        }
        if (sql.includes("SET status='STORED'")) return { rows: [{ id: "file" }], rowCount: 1 };
        if (sql.includes("SET updated_at=clock_timestamp()")) return { rows: [{ id: "file" }], rowCount: 1 };
        if (sql.includes("outbox_event")) return { rows: [{ id: "outbox" }], rowCount: 1 };
        throw new Error(`UNEXPECTED_TRANSACTION_QUERY:${sql}`);
      },
      release: vi.fn(),
    };
    const pool = {
      async query(sql: string) {
        if (sql.includes("JOIN stored_object")) {
          return fileStored && objectReferenced
            ? {
              rows: [{
                id: "00000000-0000-4000-8000-000000000001",
                batch_id: "00000000-0000-4000-8000-000000000002",
                temp_path: source,
              }],
              rowCount: 1,
            }
            : { rows: [], rowCount: 0 };
        }
        if (sql.includes("SET status='ENCRYPTING'")) {
          return {
            rows: [{
              id: "00000000-0000-4000-8000-000000000001",
              batch_id: "00000000-0000-4000-8000-000000000002",
              temp_path: source,
              relative_path: "orders.csv",
              declared_size: "17",
              shop_id: "00000000-0000-4000-8000-000000000003",
            }],
            rowCount: 1,
          };
        }
        throw new Error(`UNEXPECTED_POOL_QUERY:${sql}`);
      },
      async connect() { return client as unknown as PoolClient; },
    } as unknown as Pool;
    const removeUncommitted = vi.fn(async () => { targetPresent = false; });
    const store = {
      removeUncommitted,
      objectPath(objectId: string) { return join(objectRoot, objectId.slice(0, 2), `${objectId}.esdk`); },
      async putFile() {
        targetPresent = true;
        return {
          objectId: "00000000-0000-4000-8000-000000000001",
          plaintextSize: 17n,
          plaintextSha256: "a".repeat(64),
          ciphertextSha256: "b".repeat(64),
          path: join(objectRoot, "00", "00000000-0000-4000-8000-000000000001.esdk"),
          encryptionContext: { objectId: "00000000-0000-4000-8000-000000000001" },
        };
      },
    } as unknown as EncryptedObjectStore;

    await expect(finalizeUploadFile(pool, store, "00000000-0000-4000-8000-000000000001"))
      .rejects.toThrow("COMMIT_RESPONSE_LOST");
    expect(objectReferenced).toBe(true);
    expect(targetPresent).toBe(true);
    await expect(access(source)).resolves.toBeUndefined();

    await expect(finalizeUploadFile(pool, store, "00000000-0000-4000-8000-000000000001"))
      .resolves.toBe("00000000-0000-4000-8000-000000000001");
    expect(targetPresent).toBe(true);
    await expect(access(source)).rejects.toThrow();
    expect(removeUncommitted).toHaveBeenCalledTimes(1);
  });

  it("retries committed plaintext cleanup without deleting the stored object", async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-finalize-cleanup-"));
    roots.push(root);
    const source = join(root, "source.part");
    await mkdir(source);
    const client = {
      async query(sql: string) {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: null };
        if (sql.includes("UPDATE upload_file")) return { rows: [], rowCount: 0 };
        return { rows: [{ id: "batch" }], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = {
      async query() {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000001",
            batch_id: "00000000-0000-4000-8000-000000000002",
            temp_path: source,
          }],
          rowCount: 1,
        };
      },
      async connect() { return client as unknown as PoolClient; },
    } as unknown as Pool;
    const removeUncommitted = vi.fn(async () => undefined);
    const store = { removeUncommitted } as unknown as EncryptedObjectStore;

    await expect(finalizeUploadFile(pool, store, "00000000-0000-4000-8000-000000000001")).rejects.toThrow();
    await rm(source, { recursive: true });
    await writeFile(source, "plaintext", "utf8");
    await expect(finalizeUploadFile(pool, store, "00000000-0000-4000-8000-000000000001"))
      .resolves.toBe("00000000-0000-4000-8000-000000000001");
    await expect(access(source)).rejects.toThrow();
    expect(removeUncommitted).not.toHaveBeenCalled();
  });

  it("cleans an uncommitted encrypted duplicate when replay observes a reused stored object", async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-finalize-deduplicated-cleanup-"));
    roots.push(root);
    const source = join(root, "source.part");
    await writeFile(source, "plaintext", "utf8");
    const client = {
      async query(sql: string) {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: null };
        if (sql.includes("UPDATE upload_file")) return { rows: [], rowCount: 0 };
        return { rows: [{ id: "batch" }], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = {
      async query() {
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000099",
            batch_id: "00000000-0000-4000-8000-000000000002",
            temp_path: source,
          }],
          rowCount: 1,
        };
      },
      async connect() { return client as unknown as PoolClient; },
    } as unknown as Pool;
    const removeUncommitted = vi.fn(async () => undefined);
    const store = { removeUncommitted } as unknown as EncryptedObjectStore;

    await expect(finalizeUploadFile(pool, store, "00000000-0000-4000-8000-000000000001"))
      .resolves.toBe("00000000-0000-4000-8000-000000000099");

    expect(removeUncommitted).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000001");
    await expect(access(source)).rejects.toThrow();
  });

  it.each([
    { relativePath: "disguised.csv", prepare: async (path: string) => writeFile(path, "%PDF-1.7\nbody", "utf8"), code: "PDF_BODY_UPLOAD_REJECTED" },
    { relativePath: "archive.zip", prepare: async (path: string) => makeZip(path, "documents/disguised.csv", "%PDF-1.7\nbody"), code: "ZIP_PDF_ENTRY_REQUIRES_FOLDER_UPLOAD" },
    { relativePath: "prefixed.csv", prepare: async (path: string) => writeFile(path, "\ufeff\r\n \t%PDF-1.7\nbody", "utf8"), code: "PDF_BODY_UPLOAD_REJECTED" },
    { relativePath: "prefixed.zip", prepare: async (path: string) => makeZip(path, "documents/prefixed.csv", "\ufeff\r\n \t%PDF-1.7\nbody"), code: "ZIP_PDF_ENTRY_REQUIRES_FOLDER_UPLOAD" },
  ])("rejects PDF bytes before object storage for $relativePath", async ({ relativePath, prepare, code }) => {
    const root = await mkdtemp(join(tmpdir(), "upload-finalize-pdf-"));
    roots.push(root);
    const source = join(root, "source.part");
    await prepare(source);
    const objectRoot = join(root, "objects");
    await mkdir(objectRoot);
    let directCalls = 0;
    const client = {
      async query(sql: string) {
        if (sql.includes("pg_advisory_lock")) return { rows: [{}], rowCount: 1 };
        if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }], rowCount: 1 };
        throw new Error(`UNEXPECTED_TRANSACTION_QUERY:${sql}`);
      },
      release: vi.fn(),
    };
    const pool = {
      async query() {
        directCalls += 1;
        if (directCalls === 1) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            id: "00000000-0000-4000-8000-000000000001",
            batch_id: "00000000-0000-4000-8000-000000000002",
            temp_path: source,
            relative_path: relativePath,
            declared_size: "17",
            shop_id: "00000000-0000-4000-8000-000000000003",
          }],
          rowCount: 1,
        };
      },
      async connect() { return client as unknown as PoolClient; },
    } as unknown as Pool;
    const putFile = vi.fn();
    const removeUncommitted = vi.fn(async () => undefined);
    const store = {
      putFile,
      removeUncommitted,
      objectPath(objectId: string) { return join(objectRoot, objectId.slice(0, 2), `${objectId}.esdk`); },
    } as unknown as EncryptedObjectStore;

    await expect(finalizeUploadFile(pool, store, "00000000-0000-4000-8000-000000000001"))
      .rejects.toThrow(code);
    expect(putFile).not.toHaveBeenCalled();
    expect(removeUncommitted).toHaveBeenCalledOnce();
  });

  it("does not store or enqueue when cancellation wins before the final CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-finalize-race-"));
    roots.push(root);
    const source = join(root, "source.part");
    await writeFile(source, "order,amount\nA,1\n", "utf8");
    const objectRoot = join(root, "objects");
    await mkdir(objectRoot);
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("pg_advisory_lock")) return { rows: [{}], rowCount: 1 };
        if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }], rowCount: 1 };
        if (sql === "BEGIN" || sql === "ROLLBACK" || sql === "COMMIT") return { rows: [], rowCount: null };
        if (sql.includes("SELECT id FROM upload_batch")) return { rows: [{ id: "batch" }], rowCount: 1 };
        if (sql.includes("SELECT f.archive_reservation_state")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = {
      async query(sql: string) {
        if (sql.includes("JOIN stored_object")) return { rows: [], rowCount: 0 };
        if (sql.includes("SET status='ENCRYPTING'")) {
          return {
            rows: [{
              id: "00000000-0000-4000-8000-000000000001",
              batch_id: "00000000-0000-4000-8000-000000000002",
              temp_path: source,
              relative_path: "orders.csv",
              declared_size: "17",
              shop_id: "00000000-0000-4000-8000-000000000003",
            }],
            rowCount: 1,
          };
        }
        throw new Error(`UNEXPECTED_POOL_QUERY:${sql}`);
      },
      async connect() { return client as unknown as PoolClient; },
    } as unknown as Pool;
    const removeUncommitted = vi.fn(async () => undefined);
    const store = {
      removeUncommitted,
      objectPath(objectId: string) { return join(objectRoot, objectId.slice(0, 2), `${objectId}.esdk`); },
      async putFile() {
        return {
          objectId: "00000000-0000-4000-8000-000000000001",
          plaintextSize: 17n,
          plaintextSha256: "a".repeat(64),
          ciphertextSha256: "b".repeat(64),
          path: join(root, "object.esdk"),
          encryptionContext: { objectId: "00000000-0000-4000-8000-000000000001" },
        };
      },
    } as unknown as EncryptedObjectStore;

    await expect(finalizeUploadFile(pool, store, "00000000-0000-4000-8000-000000000001"))
      .rejects.toThrow("UPLOAD_FINALIZE_STATE_CHANGED");
    expect(queries.some((sql) => sql.includes("INSERT INTO stored_object"))).toBe(false);
    expect(queries.some((sql) => sql.includes("outbox_event"))).toBe(false);
    expect(queries.at(-1)).toBe("ROLLBACK");
    expect(removeUncommitted).toHaveBeenCalledTimes(1);

    await expect(finalizeUploadFile(pool, store, "00000000-0000-4000-8000-000000000001"))
      .rejects.toThrow("UPLOAD_FINALIZE_STATE_CHANGED");
    expect(removeUncommitted).toHaveBeenCalledTimes(2);
  });
});
