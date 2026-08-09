import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, stat, statfs, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Pool } from "pg";
import { withTransaction } from "../../db/pool";
import { enqueueOutbox } from "../../db/outbox";
import { AppError } from "../../shared/errors";
import { structuredLog } from "../../shared/structured-logger.js";
import {
  type ClientUploadFailureCode,
  recordUploadFileFailure,
  refreshUploadPreflight,
} from "./partial-failure.js";

const MAX_BATCH_BYTES = 2n * 1024n * 1024n * 1024n;
const MAX_FILES = 20_000;
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

export interface CreateUploadFile { batchId: string; relativePath: string; declaredSize: bigint; contentType?: string; metadataOnly?: boolean }
export interface AppendChunk { fileId: string; expectedOffset: bigint; length: number; expectedSha256: string; body: Readable }

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  const parts = normalized.split("/");
  if (!normalized || Buffer.byteLength(normalized) > 1024 || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || parts.some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part) > 255)) throw new Error("UNSAFE_RELATIVE_PATH");
  return normalized;
}

class ChunkVerifier extends Transform {
  readonly hash = createHash("sha256");
  bytes = 0;
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > MAX_CHUNK_BYTES) return callback(new Error("CHUNK_TOO_LARGE"));
    this.hash.update(chunk);
    callback(null, chunk);
  }
}

export class UploadService {
  private readonly root: string;
  constructor(private readonly pool: Pool, root: string) { this.root = resolve(root); }

  async resolveBatchShop(batchId: string): Promise<string> {
    const result = await this.pool.query<{ shop_id: string }>("SELECT shop_id FROM upload_batch WHERE id = $1", [batchId]);
    const shopId = result.rows[0]?.shop_id;
    if (!shopId) throw new Error("UPLOAD_BATCH_NOT_FOUND");
    return shopId;
  }

  async resolveFileShop(fileId: string): Promise<string> {
    const result = await this.pool.query<{ shop_id: string }>(
      "SELECT b.shop_id FROM upload_file f JOIN upload_batch b ON b.id = f.batch_id WHERE f.id = $1",
      [fileId],
    );
    const shopId = result.rows[0]?.shop_id;
    if (!shopId) throw new Error("UPLOAD_FILE_NOT_FOUND");
    return shopId;
  }

  async fileOffset(fileId: string): Promise<{ offset: string; length: string }> {
    const result = await this.pool.query<{ received_size: string; declared_size: string }>(
      "SELECT received_size,declared_size FROM upload_file WHERE id=$1",
      [fileId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("UPLOAD_FILE_NOT_FOUND");
    return { offset: row.received_size, length: row.declared_size };
  }

  async original(fileId: string): Promise<{ shopId: string; relativePath: string; storagePath: string; encryptionContext: Record<string, string> }> {
    const result = await this.pool.query<{ shop_id: string; relative_path: string; storage_path: string; encryption_context: Record<string, string> }>(
      `SELECT b.shop_id, f.relative_path, so.storage_path, so.encryption_context
         FROM upload_file f
         JOIN upload_batch b ON b.id = f.batch_id
         JOIN stored_object so ON so.id = f.stored_object_id
        WHERE f.id = $1 AND f.status = 'STORED' AND NOT f.metadata_only`,
      [fileId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("UPLOAD_FILE_NOT_FOUND");
    return { shopId: row.shop_id, relativePath: row.relative_path, storagePath: row.storage_path, encryptionContext: row.encryption_context };
  }

  async issueOriginalDownloadGrant(fileId: string, accountId: string, shopId: string, reason?: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await this.pool.query(
      `INSERT INTO original_download_grant
        (object_id,account_id,shop_id,authorization_version,reason,token_hash,expires_at)
       SELECT so.id,$2,$3,0,$4,$5,clock_timestamp()+interval '5 minutes'
         FROM upload_file f JOIN stored_object so ON so.id=f.stored_object_id
        WHERE f.id=$1 AND NOT f.metadata_only`,
      [fileId, accountId, shopId, reason?.trim() || null, tokenHash],
    );
    return token;
  }

  async consumeOriginalDownloadGrant(fileId: string, accountId: string, token: string): Promise<{ shopId: string; relativePath: string; storagePath: string; encryptionContext: Record<string, string>; reason?: string }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError("DOWNLOAD_TOKEN_INVALID", "下载授权无效或已过期", 400);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    return withTransaction(this.pool, async (tx) => {
      const result = await tx.query<{ shop_id: string; relative_path: string; storage_path: string; encryption_context: Record<string, string>; reason: string | null }>(
        `UPDATE original_download_grant g
            SET revoked_at=clock_timestamp()
           FROM stored_object so, upload_file f
          WHERE g.token_hash=$1 AND g.account_id=$2 AND g.object_id=so.id
            AND f.stored_object_id=so.id AND f.id=$3
            AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
          RETURNING g.shop_id,f.relative_path,so.storage_path,so.encryption_context,g.reason`,
        [tokenHash, accountId, fileId],
      );
      const row = result.rows[0];
      if (!row) throw new AppError("DOWNLOAD_TOKEN_INVALID", "下载授权无效或已过期", 400);
      return { shopId: row.shop_id, relativePath: row.relative_path, storagePath: row.storage_path, encryptionContext: row.encryption_context, ...(row.reason ? { reason: row.reason } : {}) };
    });
  }

  async createBatch(shopId: string, accountId: string, idempotencyKey: string): Promise<string> {
    return withTransaction(this.pool, async (tx) => {
      const existing = await tx.query<{ upload_batch_id: string }>(
        "SELECT upload_batch_id FROM import_batch WHERE shop_id = $1 AND idempotency_key = $2",
        [shopId, idempotencyKey],
      );
      if (existing.rows[0]) return existing.rows[0].upload_batch_id;
      const result = await tx.query<{ id: string }>(
        `INSERT INTO upload_batch (shop_id, created_by, status, expires_at)
         VALUES ($1, $2, 'OPEN', clock_timestamp() + interval '7 days') RETURNING id`,
        [shopId, accountId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("UPLOAD_BATCH_CREATE_FAILED");
      await tx.query(
        `INSERT INTO import_batch (shop_id, upload_batch_id, status, current_stage, idempotency_key, created_by)
         VALUES ($1,$2,'UPLOADING','UPLOAD',$3,$4)`,
        [shopId, row.id, idempotencyKey, accountId],
      );
      await tx.query(
        `UPDATE shop SET last_operated_by_account_id=$2,updated_at=clock_timestamp() WHERE id=$1`,
        [shopId, accountId],
      );
      return row.id;
    });
  }

  async completeBatch(batchId: string): Promise<{ id: string; status: string }> {
    return withTransaction(this.pool, async (tx) => {
      const pending = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM upload_file WHERE batch_id = $1 AND status IN ('PENDING','UPLOADING')",
        [batchId],
      );
      if (BigInt(pending.rows[0]?.count ?? "0") !== 0n) throw new Error("UPLOAD_FILES_NOT_COMPLETE");
      await tx.query("UPDATE upload_batch SET status = 'READY', updated_at = clock_timestamp() WHERE id = $1 AND status IN ('OPEN','UPLOADING','READY')", [batchId]);
      const currentImport = await tx.query<{ id: string; status: string }>(
        "SELECT id,status FROM import_batch WHERE upload_batch_id=$1 FOR UPDATE",
        [batchId],
      );
      const importBatchId = currentImport.rows[0]?.id;
      if (!importBatchId) throw new Error("IMPORT_BATCH_NOT_FOUND");
      if (!["UPLOADING", "ANALYZING", "AWAITING_MAPPING", "AWAITING_COMMIT_CONFIRMATION"].includes(currentImport.rows[0]!.status)) {
        return { id: importBatchId, status: currentImport.rows[0]!.status };
      }
      const projection = await refreshUploadPreflight(tx, batchId, importBatchId);
      return { id: importBatchId, status: projection.status };
    });
  }

  async failFile(fileId: string, reasonCode: ClientUploadFailureCode): Promise<void> {
    const failed = await recordUploadFileFailure(this.pool, {
      fileId,
      errorCode: reasonCode,
      allowedStatuses: ["PENDING", "UPLOADING"],
    });
    await unlink(failed.tempPath).catch(() => undefined);
  }

  async cancelBatch(batchId: string): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      await tx.query(
        "UPDATE upload_batch SET status='CANCELLED',updated_at=clock_timestamp() WHERE id=$1 AND status IN ('OPEN','UPLOADING','FINALIZING','FAILED')",
        [batchId],
      );
      await tx.query(
        `UPDATE import_batch SET status='CANCELLED',current_stage='CANCELLED',updated_at=clock_timestamp()
          WHERE upload_batch_id=$1 AND status IN
            ('DRAFT','UPLOADING','ANALYZING','AWAITING_FILES','AWAITING_MAPPING','AWAITING_COMMIT_CONFIRMATION','RETRYING','FAILED')`,
        [batchId],
      );
    });
  }

  async createFile(input: CreateUploadFile): Promise<string> {
    if (input.declaredSize < 0n || input.declaredSize > MAX_BATCH_BYTES) throw new Error("UPLOAD_SIZE_LIMIT");
    const relativePath = safeRelativePath(input.relativePath);
    const metadataOnly = input.metadataOnly === true;
    if (metadataOnly && (input.declaredSize !== 0n || !/\.pdf$/iu.test(relativePath))) throw new Error("UPLOAD_METADATA_ONLY_PDF_REQUIRED");
    return withTransaction(this.pool, async (tx) => {
      const batch = await tx.query<{ declared_bytes: string; file_count: number }>("SELECT declared_bytes, file_count FROM upload_batch WHERE id=$1 AND status IN ('OPEN','UPLOADING') FOR UPDATE", [input.batchId]);
      const current = batch.rows[0];
      if (!current) throw new Error("UPLOAD_BATCH_NOT_OPEN");
      if (BigInt(current.declared_bytes) + input.declaredSize > MAX_BATCH_BYTES || current.file_count >= MAX_FILES) throw new Error("UPLOAD_BATCH_LIMIT");
      await mkdir(this.root, { recursive: true });
      const disk = await statfs(this.root, { bigint: true });
      const requiredFree = 3n * (BigInt(current.declared_bytes) + input.declaredSize) + 4n * 1024n * 1024n * 1024n;
      if (disk.bavail * disk.bsize < requiredFree) throw new Error("UPLOAD_STORAGE_CAPACITY_INSUFFICIENT");
      const fileId = randomUUID();
      const directory = join(this.root, "incoming", input.batchId);
      const tempPath = resolve(directory, `${fileId}.part`);
      if (!tempPath.startsWith(`${resolve(this.root)}${sep}`)) throw new Error("UPLOAD_PATH_ESCAPE");
      if (!metadataOnly) {
        await mkdir(directory, { recursive: true });
        await (await open(tempPath, "wx")).close();
      }
      await tx.query(
        `INSERT INTO upload_file (id,batch_id,relative_path,declared_size,content_type,status,temp_path,metadata_only,detected_kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [fileId, input.batchId, relativePath, input.declaredSize.toString(), input.contentType ?? null,
          metadataOnly ? "STORED" : input.declaredSize === 0n ? "COMPLETE" : "PENDING", tempPath, metadataOnly, metadataOnly ? "PDF" : null],
      );
      if (metadataOnly) {
        await tx.query(
          `INSERT INTO import_file(import_batch_id,stored_object_id,relative_path,classification,parse_status,sha256,size_bytes,metadata_only)
           SELECT ib.id,NULL,$2,'LIST_ONLY','EXCLUDED',digest(convert_to($2,'UTF8'),'sha256'),0,true
             FROM import_batch ib WHERE ib.upload_batch_id=$1`,
          [input.batchId, relativePath],
        );
      }
      await tx.query("UPDATE upload_batch SET declared_bytes=declared_bytes+$2, file_count=file_count+1, status='UPLOADING', updated_at=clock_timestamp() WHERE id=$1", [input.batchId, input.declaredSize.toString()]);
      if (!metadataOnly && input.declaredSize === 0n) await enqueueOutbox(tx, { topic: "upload.finalize", businessKey: fileId, payload: { fileId } });
      if (metadataOnly) structuredLog("info", "api", "upload_pdf_metadata_registered", { batchId: input.batchId, fileCount: 1 });
      return fileId;
    });
  }

  async appendChunk(input: AppendChunk): Promise<bigint> {
    if (input.length < 0 || input.length > MAX_CHUNK_BYTES) throw new Error("CHUNK_SIZE_LIMIT");
    return withTransaction(this.pool, async (tx) => {
      const result = await tx.query<{ batch_id: string; temp_path: string; declared_size: string; received_size: string }>("SELECT batch_id,temp_path,declared_size,received_size FROM upload_file WHERE id=$1 AND status IN ('PENDING','UPLOADING') FOR UPDATE", [input.fileId]);
      const file = result.rows[0];
      if (!file) throw new Error("UPLOAD_FILE_NOT_WRITABLE");
      const current = BigInt(file.received_size);
      if (current !== input.expectedOffset) throw new Error(`UPLOAD_OFFSET_MISMATCH:${current}`);
      if (current + BigInt(input.length) > BigInt(file.declared_size)) throw new Error("UPLOAD_FILE_OVERFLOW");
      const verifier = new ChunkVerifier();
      await pipeline(input.body, verifier, createWriteStream(file.temp_path, { flags: "r+", start: Number(current) }));
      const actualDigest = verifier.hash.digest();
      const expected = input.expectedSha256.trim();
      const matches = /^[a-f0-9]{64}$/i.test(expected)
        ? actualDigest.toString("hex") === expected.toLowerCase()
        : actualDigest.toString("base64") === expected;
      if (verifier.bytes !== input.length || !matches) throw new Error("UPLOAD_CHUNK_CHECKSUM_MISMATCH");
      const next = current + BigInt(verifier.bytes);
      const complete = next === BigInt(file.declared_size);
      await tx.query("INSERT INTO upload_chunk_receipt (upload_file_id,chunk_offset,chunk_size,sha256) VALUES ($1,$2,$3,$4)", [input.fileId, current.toString(), verifier.bytes, actualDigest.toString("hex")]);
      await tx.query("UPDATE upload_file SET received_size=$2,status=$3,updated_at=clock_timestamp() WHERE id=$1", [input.fileId, next.toString(), complete ? "COMPLETE" : "UPLOADING"]);
      await tx.query("UPDATE upload_batch SET received_bytes=received_bytes+$2,updated_at=clock_timestamp() WHERE id=$1", [file.batch_id, verifier.bytes]);
      if (complete) await enqueueOutbox(tx, { topic: "upload.finalize", businessKey: input.fileId, payload: { fileId: input.fileId } });
      const disk = await stat(file.temp_path);
      if (BigInt(disk.size) < next) throw new Error("UPLOAD_DURABILITY_CHECK_FAILED");
      return next;
    });
  }
}
