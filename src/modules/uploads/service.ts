import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, stat, statfs, unlink } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../db/pool";
import { enqueueOutbox } from "../../db/outbox";
import { AppError } from "../../shared/errors";
import { safeErrorDiagnostic } from "../../shared/diagnostics.js";
import { accountingPeriodStartDate, parseAccountingPeriodScope, type AccountingPeriodInput } from "../../shared/accounting-period.js";
import { structuredLog } from "../../shared/structured-logger.js";
import {
  MAX_UPLOAD_BATCH_BYTES,
  MAX_UPLOAD_BATCH_FILES,
  UPLOAD_FILE_IO_CONCURRENCY,
} from "../../shared/upload-limits.js";
import {
  type ClientUploadFailureCode,
  recordUploadFileFailure,
  refreshUploadPreflight,
} from "./partial-failure.js";
import { cleanupUploadStagingArtifacts } from "./staging-cleanup.js";

const MAX_BATCH_BYTES = BigInt(MAX_UPLOAD_BATCH_BYTES);
export const MAX_UPLOAD_FILES = MAX_UPLOAD_BATCH_FILES;
export const MAX_CHUNK_BYTES = 16 * 1024 * 1024;

export interface CreateUploadFile { batchId: string; relativePath: string; declaredSize: bigint; contentType?: string; metadataOnly?: boolean }
export type UploadFileRegistration = Omit<CreateUploadFile, "batchId">;
export interface RegisteredUploadFile { id: string; relativePath: string; offset: string }
export interface AppendChunk { fileId: string; expectedOffset: bigint; length: number; expectedSha256: string; contentEncoding?: "gzip"; body: Readable }

interface NormalizedUploadFile {
  readonly relativePath: string;
  readonly declaredSize: bigint;
  readonly contentType?: string;
  readonly metadataOnly: boolean;
}

interface FailedStagingFile {
  readonly id: string;
  readonly batch_id: string;
  readonly status: "PENDING" | "UPLOADING" | "COMPLETE" | "ENCRYPTING" | "STORED" | "FAILED";
  readonly temp_path: string;
  readonly archive_reservation_state: "NONE" | "RESERVED" | "COMMITTED";
  readonly archive_expanded_bytes: string;
  readonly archive_file_count: number;
}

async function forEachUploadFile<T>(
  values: readonly T[],
  operation: (value: T) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < values.length; offset += UPLOAD_FILE_IO_CONCURRENCY) {
    await Promise.all(values.slice(offset, offset + UPLOAD_FILE_IO_CONCURRENCY).map(operation));
  }
}

async function removeTemporaryUploadPaths(paths: readonly string[]): Promise<void> {
  await forEachUploadFile(paths, async (path) => unlink(path).catch(() => undefined));
}

async function releaseReservedArchiveBudgets(tx: PoolClient, files: readonly FailedStagingFile[]): Promise<void> {
  const totals = new Map<string, { expandedBytes: bigint; fileCount: number }>();
  for (const file of files) {
    if (file.archive_reservation_state !== "RESERVED") continue;
    const current = totals.get(file.batch_id) ?? { expandedBytes: 0n, fileCount: 0 };
    current.expandedBytes += BigInt(file.archive_expanded_bytes);
    current.fileCount += file.archive_file_count;
    totals.set(file.batch_id, current);
  }
  if (totals.size === 0) return;
  const entries = [...totals.entries()];
  const updated = await tx.query<{ id: string }>(
    `UPDATE upload_batch batch
        SET expanded_bytes=batch.expanded_bytes-released.expanded_bytes,
            file_count=batch.file_count-released.file_count,
            updated_at=clock_timestamp()
       FROM unnest($1::uuid[],$2::bigint[],$3::integer[])
            AS released(batch_id,expanded_bytes,file_count)
      WHERE batch.id=released.batch_id
        AND batch.expanded_bytes>=released.expanded_bytes
        AND batch.file_count>=released.file_count
      RETURNING batch.id`,
    [
      entries.map(([batchId]) => batchId),
      entries.map(([, value]) => value.expandedBytes.toString()),
      entries.map(([, value]) => value.fileCount),
    ],
  );
  if ((updated.rowCount ?? 0) !== totals.size) throw new Error("UPLOAD_ARCHIVE_BUDGET_CORRUPTED");
}

export async function expireUploadStaging(pool: Pool): Promise<number> {
  const stagingFiles = await withTransaction(pool, async (tx) => {
    await tx.query<{ id: string }>(
      `WITH candidates AS (
         SELECT batch.id
           FROM upload_batch batch
          WHERE batch.status IN ('OPEN','UPLOADING','FAILED')
            AND batch.expires_at<=clock_timestamp()
          ORDER BY batch.expires_at,batch.id
          LIMIT 100
          FOR UPDATE OF batch SKIP LOCKED
       )
       UPDATE upload_batch batch
          SET status='EXPIRED',updated_at=clock_timestamp()
         FROM candidates
        WHERE batch.id=candidates.id
        RETURNING batch.id`,
    );
    const files = await tx.query<FailedStagingFile>(
      `SELECT file.id,file.batch_id,file.status,file.temp_path,file.archive_reservation_state,
              file.archive_expanded_bytes::text,file.archive_file_count
         FROM upload_file file
         JOIN upload_batch batch ON batch.id=file.batch_id
        WHERE batch.status IN ('EXPIRED','CANCELLED') AND file.temp_path<>''
        ORDER BY file.updated_at,file.id
        LIMIT 100
        FOR UPDATE OF batch,file SKIP LOCKED`,
    );
    await releaseReservedArchiveBudgets(tx, files.rows);
    if (files.rows.length > 0) {
      await tx.query(
        `UPDATE upload_file
            SET status=CASE WHEN status='STORED' THEN status ELSE 'FAILED' END,
                archive_reservation_state=CASE WHEN status='STORED' THEN archive_reservation_state ELSE 'NONE' END,
                archive_expanded_bytes=CASE WHEN status='STORED' THEN archive_expanded_bytes ELSE 0 END,
                archive_file_count=CASE WHEN status='STORED' THEN archive_file_count ELSE 0 END,
                updated_at=clock_timestamp()
          WHERE id=ANY($1::uuid[])`,
        [files.rows.map((row) => row.id)],
      );
    }
    return files.rows;
  });
  let cleaned = 0;
  await forEachUploadFile(stagingFiles, async (file) => {
    try {
      await cleanupUploadStagingArtifacts(pool, { fileId: file.id, tempPath: file.temp_path });
      cleaned += 1;
    } catch (error) {
      structuredLog("error", "worker", "upload_staging_cleanup_failed", {
        fileId: file.id,
        batchId: file.batch_id,
        ...safeErrorDiagnostic(error),
      });
    }
  });
  return cleaned;
}

function safeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  const parts = normalized.split("/");
  const hasControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!normalized || hasControlCharacter || Buffer.byteLength(normalized) > 1024 || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || parts.some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part) > 255)) throw new Error("UNSAFE_RELATIVE_PATH");
  return normalized;
}

function normalizeUploadFiles(inputs: readonly UploadFileRegistration[]): { files: NormalizedUploadFile[]; declaredBytes: bigint } {
  if (inputs.length > MAX_UPLOAD_FILES) throw new Error("UPLOAD_BATCH_LIMIT");
  const paths = new Set<string>();
  let declaredBytes = 0n;
  const files = inputs.map((input): NormalizedUploadFile => {
    if (input.declaredSize < 0n || input.declaredSize > MAX_BATCH_BYTES) throw new Error("UPLOAD_SIZE_LIMIT");
    const relativePath = safeRelativePath(input.relativePath);
    if (paths.has(relativePath)) throw new Error("UPLOAD_DUPLICATE_RELATIVE_PATH");
    paths.add(relativePath);
    if (input.contentType !== undefined && (input.contentType.length === 0 || Buffer.byteLength(input.contentType) > 255)) {
      throw new Error("UPLOAD_CONTENT_TYPE_INVALID");
    }
    const metadataOnly = input.metadataOnly === true;
    const isPdfMetadata = /\.pdf$/iu.test(relativePath) || input.contentType?.toLowerCase() === "application/pdf";
    if (metadataOnly && (input.declaredSize !== 0n || !isPdfMetadata)) {
      throw new Error("UPLOAD_METADATA_ONLY_PDF_REQUIRED");
    }
    declaredBytes += input.declaredSize;
    if (declaredBytes > MAX_BATCH_BYTES) throw new Error("UPLOAD_BATCH_LIMIT");
    return {
      relativePath,
      declaredSize: input.declaredSize,
      ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
      metadataOnly,
    };
  });
  return { files, declaredBytes };
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

  private async registerFilesInTransaction(
    tx: PoolClient,
    batchId: string,
    files: readonly NormalizedUploadFile[],
    availableStorageBytes: bigint,
    createdTempPaths: string[],
  ): Promise<RegisteredUploadFile[]> {
    if (files.length === 0) return [];
    const batch = await tx.query<{ declared_bytes: string; file_count: number }>(
      "SELECT declared_bytes, file_count FROM upload_batch WHERE id=$1 AND status IN ('OPEN','UPLOADING') FOR UPDATE",
      [batchId],
    );
    const current = batch.rows[0];
    if (!current) throw new Error("UPLOAD_BATCH_NOT_OPEN");
    const addedBytes = files.reduce((sum, file) => sum + file.declaredSize, 0n);
    const finalDeclaredBytes = BigInt(current.declared_bytes) + addedBytes;
    const finalFileCount = current.file_count + files.length;
    if (finalDeclaredBytes > MAX_BATCH_BYTES || finalFileCount > MAX_UPLOAD_FILES) throw new Error("UPLOAD_BATCH_LIMIT");
    const requiredFree = 3n * finalDeclaredBytes + 4n * 1024n * 1024n * 1024n;
    if (availableStorageBytes < requiredFree) throw new Error("UPLOAD_STORAGE_CAPACITY_INSUFFICIENT");

    const directory = resolve(this.root, "incoming", batchId);
    if (!directory.startsWith(`${this.root}${sep}`)) throw new Error("UPLOAD_PATH_ESCAPE");
    if (files.some((file) => !file.metadataOnly)) await mkdir(directory, { recursive: true });
    const registrations = files.map((file) => {
      const id = randomUUID();
      const tempPath = resolve(directory, `${id}.part`);
      if (!tempPath.startsWith(`${this.root}${sep}`)) throw new Error("UPLOAD_PATH_ESCAPE");
      return { ...file, id, tempPath };
    });
    for (const file of registrations) {
      if (file.metadataOnly) continue;
      await (await open(file.tempPath, "wx")).close();
      createdTempPaths.push(file.tempPath);
    }

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO upload_file
        (id,batch_id,relative_path,declared_size,content_type,status,temp_path,metadata_only,detected_kind)
       SELECT file.id,$1,file.relative_path,file.declared_size,file.content_type,file.status,
              file.temp_path,file.metadata_only,file.detected_kind
         FROM unnest($2::uuid[],$3::text[],$4::bigint[],$5::text[],$6::text[],$7::text[],$8::boolean[],$9::text[])
              WITH ORDINALITY AS file(id,relative_path,declared_size,content_type,status,temp_path,metadata_only,detected_kind,ordinal)
        ORDER BY file.ordinal
       RETURNING id`,
      [
        batchId,
        registrations.map((file) => file.id),
        registrations.map((file) => file.relativePath),
        registrations.map((file) => file.declaredSize.toString()),
        registrations.map((file) => file.contentType ?? null),
        registrations.map((file) => file.metadataOnly ? "STORED" : file.declaredSize === 0n ? "COMPLETE" : "PENDING"),
        registrations.map((file) => file.tempPath),
        registrations.map((file) => file.metadataOnly),
        registrations.map((file) => file.metadataOnly ? "PDF" : null),
      ],
    );
    if ((inserted.rowCount ?? 0) !== registrations.length) throw new Error("UPLOAD_FILE_CREATE_FAILED");

    const metadataOnlyCount = registrations.filter((file) => file.metadataOnly).length;
    if (metadataOnlyCount > 0) {
      const metadataFiles = await tx.query(
        `INSERT INTO import_file
          (import_batch_id,stored_object_id,relative_path,classification,parse_status,sha256,size_bytes,metadata_only)
         SELECT batch.id,NULL,file.relative_path,'LIST_ONLY','EXCLUDED',
                digest(convert_to(file.relative_path,'UTF8'),'sha256'),0,true
           FROM import_batch batch
           JOIN upload_file file ON file.batch_id=batch.upload_batch_id
          WHERE batch.upload_batch_id=$1 AND file.id=ANY($2::uuid[]) AND file.metadata_only`,
        [batchId, registrations.map((file) => file.id)],
      );
      if ((metadataFiles.rowCount ?? 0) !== metadataOnlyCount) throw new Error("UPLOAD_METADATA_IMPORT_FILE_CREATE_FAILED");
    }

    const zeroByteIds = registrations
      .filter((file) => !file.metadataOnly && file.declaredSize === 0n)
      .map((file) => file.id);
    if (zeroByteIds.length > 0) {
      const outbox = await tx.query<{ id: string }>(
        `INSERT INTO outbox_event (topic,business_key,payload)
         SELECT 'upload.finalize',file_id::text,jsonb_build_object('fileId',file_id::text)
           FROM unnest($1::uuid[]) AS pending(file_id)
         ON CONFLICT (topic,business_key) DO UPDATE SET topic=EXCLUDED.topic
         RETURNING id`,
        [zeroByteIds],
      );
      if ((outbox.rowCount ?? 0) !== zeroByteIds.length) throw new Error("OUTBOX_INSERT_FAILED");
    }

    const updated = await tx.query(
      `UPDATE upload_batch
          SET declared_bytes=declared_bytes+$2,file_count=file_count+$3,status='UPLOADING',updated_at=clock_timestamp()
        WHERE id=$1`,
      [batchId, addedBytes.toString(), registrations.length],
    );
    if (updated.rowCount !== 1) throw new Error("UPLOAD_BATCH_UPDATE_FAILED");
    return registrations.map((file) => ({ id: file.id, relativePath: file.relativePath, offset: "0" }));
  }

  private async existingBatchRegistration(
    tx: PoolClient,
    batchId: string,
    files: readonly NormalizedUploadFile[],
  ): Promise<RegisteredUploadFile[]> {
    const existing = await tx.query<{
      id: string;
      relative_path: string;
      declared_size: string;
      received_size: string;
      content_type: string | null;
      metadata_only: boolean;
    }>(
      `SELECT id,relative_path,declared_size,received_size,content_type,metadata_only
         FROM upload_file WHERE batch_id=$1`,
      [batchId],
    );
    if (existing.rows.length !== files.length) throw new Error("IDEMPOTENCY_KEY_REUSED");
    const byPath = new Map(existing.rows.map((file) => [file.relative_path, file]));
    return files.map((file) => {
      const stored = byPath.get(file.relativePath);
      if (!stored
        || stored.declared_size !== file.declaredSize.toString()
        || (stored.content_type ?? undefined) !== file.contentType
        || stored.metadata_only !== file.metadataOnly) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      return { id: stored.id, relativePath: stored.relative_path, offset: stored.received_size };
    });
  }

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

  async original(fileId: string): Promise<{ shopId: string; relativePath: string; storagePath: string; encryptionContext: Record<string, string>; plaintextSize: string }> {
    const result = await this.pool.query<{ shop_id: string; relative_path: string; storage_path: string; encryption_context: Record<string, string>; plaintext_size: string }>(
      `SELECT b.shop_id, f.relative_path, so.storage_path, so.encryption_context, so.plaintext_size
         FROM upload_file f
        JOIN upload_batch b ON b.id = f.batch_id
        JOIN stored_object so ON so.id = f.stored_object_id
        WHERE f.id = $1 AND f.status = 'STORED' AND NOT f.metadata_only
          AND b.status NOT IN ('CANCELLED','EXPIRED')`,
      [fileId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("UPLOAD_FILE_NOT_FOUND");
    return { shopId: row.shop_id, relativePath: row.relative_path, storagePath: row.storage_path, encryptionContext: row.encryption_context, plaintextSize: row.plaintext_size };
  }

  async issueOriginalDownloadGrant(fileId: string, accountId: string, shopId: string, reason?: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const issued = await this.pool.query(
      `INSERT INTO original_download_grant
        (object_id,account_id,shop_id,authorization_version,reason,token_hash,expires_at)
       SELECT so.id,$2,$3,0,$4,$5,clock_timestamp()+interval '5 minutes'
         FROM upload_file f
         JOIN upload_batch b ON b.id=f.batch_id
         JOIN stored_object so ON so.id=f.stored_object_id
        WHERE f.id=$1 AND NOT f.metadata_only
          AND b.status NOT IN ('CANCELLED','EXPIRED')`,
      [fileId, accountId, shopId, reason?.trim() || null, tokenHash],
    );
    if (issued.rowCount !== 1) throw new Error("UPLOAD_FILE_NOT_FOUND");
    return token;
  }

  async consumeOriginalDownloadGrant(fileId: string, accountId: string, token: string): Promise<{ shopId: string; relativePath: string; storagePath: string; encryptionContext: Record<string, string>; plaintextSize: string; reason?: string }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError("DOWNLOAD_TOKEN_INVALID", "下载授权无效或已过期", 400);
    const tokenHash = createHash("sha256").update(token).digest("hex");
    return withTransaction(this.pool, async (tx) => {
      const result = await tx.query<{ shop_id: string; relative_path: string; storage_path: string; encryption_context: Record<string, string>; plaintext_size: string; reason: string | null }>(
        `UPDATE original_download_grant g
            SET revoked_at=clock_timestamp()
           FROM stored_object so, upload_file f, upload_batch b
          WHERE g.token_hash=$1 AND g.account_id=$2 AND g.object_id=so.id
            AND f.stored_object_id=so.id AND f.id=$3 AND b.id=f.batch_id
            AND b.status NOT IN ('CANCELLED','EXPIRED')
            AND g.revoked_at IS NULL AND g.expires_at>clock_timestamp()
          RETURNING g.shop_id,f.relative_path,so.storage_path,so.encryption_context,so.plaintext_size,g.reason`,
        [tokenHash, accountId, fileId],
      );
      const row = result.rows[0];
      if (!row) throw new AppError("DOWNLOAD_TOKEN_INVALID", "下载授权无效或已过期", 400);
      return { shopId: row.shop_id, relativePath: row.relative_path, storagePath: row.storage_path, encryptionContext: row.encryption_context, plaintextSize: row.plaintext_size, ...(row.reason ? { reason: row.reason } : {}) };
    });
  }

  async createBatch(shopId: string, accountId: string, idempotencyKey: string, period: AccountingPeriodInput = {}): Promise<string> {
    return (await this.createBatchWithFiles(shopId, accountId, idempotencyKey, [], period)).id;
  }

  async createBatchWithFiles(
    shopId: string,
    accountId: string,
    idempotencyKey: string,
    inputs: readonly UploadFileRegistration[],
    period: AccountingPeriodInput = {},
  ): Promise<{ id: string; files: RegisteredUploadFile[] }> {
    const normalized = normalizeUploadFiles(inputs);
    const accountingPeriod = parseAccountingPeriodScope(period);
    const createdTempPaths: string[] = [];
    let created = false;
    try {
      const result = await withTransaction(this.pool, async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([shopId, idempotencyKey])]);
        const existing = await tx.query<{ upload_batch_id: string; accounting_period_start: string | null; accounting_period_end: string | null }>(
          `SELECT upload_batch_id,to_char(accounting_period_start,'YYYY-MM') accounting_period_start,
                  to_char(accounting_period_end,'YYYY-MM') accounting_period_end
             FROM import_batch WHERE shop_id=$1 AND idempotency_key=$2`,
          [shopId, idempotencyKey],
        );
        if (existing.rows[0]) {
          const row = existing.rows[0];
          if ((row.accounting_period_start ?? undefined) !== accountingPeriod?.periodStart
            || (row.accounting_period_end ?? undefined) !== accountingPeriod?.periodEnd) {
            throw new AppError("UPLOAD_IDEMPOTENCY_SCOPE_MISMATCH", "同一上传请求不能更改本次核算日期范围", 409);
          }
          return {
            id: row.upload_batch_id,
            files: await this.existingBatchRegistration(tx, row.upload_batch_id, normalized.files),
          };
        }

        let availableStorageBytes = 0n;
        if (normalized.files.length > 0) {
          await mkdir(this.root, { recursive: true });
          const disk = await statfs(this.root, { bigint: true });
          availableStorageBytes = disk.bavail * disk.bsize;
        }

        // Source replay and normal upload creation share the shop row as their
        // serialization boundary. Keep this and the replay lookup as separate
        // statements so a waiter observes the replay committed before it.
        await tx.query("SELECT id FROM shop WHERE id=$1 FOR UPDATE", [shopId]);
        const activeReplay = await tx.query<{ id: string }>(
          `SELECT id FROM import_batch
            WHERE shop_id=$1 AND idempotency_key LIKE 'admin-source-replay:%'
              AND status NOT IN ('RESULT_PUBLISHED','CANCELLED','FAILED')
            ORDER BY created_at,id LIMIT 1`,
          [shopId],
        );
        if (activeReplay.rows[0]) {
          throw new AppError("UPLOAD_SOURCE_REPLAY_IN_PROGRESS", "当前公司正在安全重算历史资料，请稍后重试", 409);
        }

        const batchId = randomUUID();
        await tx.query(
          `INSERT INTO upload_batch (id,shop_id,created_by,status,expires_at)
           VALUES ($1,$2,$3,'OPEN',clock_timestamp()+interval '7 days')`,
          [batchId, shopId, accountId],
        );
        await tx.query(
          `INSERT INTO import_batch (shop_id,upload_batch_id,status,current_stage,idempotency_key,created_by,
             accounting_period_start,accounting_period_end)
           VALUES ($1,$2,'UPLOADING','UPLOAD',$3,$4,$5::date,$6::date)`,
          [shopId, batchId, idempotencyKey, accountId,
            accountingPeriod ? accountingPeriodStartDate(accountingPeriod.periodStart) : null,
            accountingPeriod ? accountingPeriodStartDate(accountingPeriod.periodEnd) : null],
        );
        await tx.query(
          "UPDATE shop SET last_operated_by_account_id=$2,updated_at=clock_timestamp() WHERE id=$1",
          [shopId, accountId],
        );
        const files = await this.registerFilesInTransaction(
          tx,
          batchId,
          normalized.files,
          availableStorageBytes,
          createdTempPaths,
        );
        created = true;
        return { id: batchId, files };
      });
      const metadataOnlyCount = created ? normalized.files.filter((file) => file.metadataOnly).length : 0;
      if (metadataOnlyCount > 0) {
        structuredLog("info", "api", "upload_pdf_metadata_registered", { batchId: result.id, fileCount: metadataOnlyCount });
      }
      return result;
    } catch (error) {
      await removeTemporaryUploadPaths(createdTempPaths);
      throw error;
    }
  }

  async completeBatch(batchId: string): Promise<{ id: string; status: string }> {
    return withTransaction(this.pool, async (tx) => {
      const pending = await tx.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM upload_file WHERE batch_id = $1 AND status IN ('PENDING','UPLOADING')",
        [batchId],
      );
      if (BigInt(pending.rows[0]?.count ?? "0") !== 0n) throw new Error("UPLOAD_FILES_NOT_COMPLETE");
      await tx.query("UPDATE upload_batch SET status = 'READY', updated_at = clock_timestamp() WHERE id = $1 AND status IN ('OPEN','UPLOADING','READY')", [batchId]);
      await tx.query(
        `INSERT INTO outbox_event (topic,business_key,payload)
         SELECT 'upload.finalize',file.id::text,jsonb_build_object('fileId',file.id::text)
           FROM upload_file file
          WHERE file.batch_id=$1 AND file.status='COMPLETE' AND NOT file.metadata_only
         ON CONFLICT (topic,business_key) DO NOTHING`,
        [batchId],
      );
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
    await cleanupUploadStagingArtifacts(this.pool, { fileId, tempPath: failed.tempPath });
  }

  async cancelBatch(batchId: string): Promise<void> {
    const stagingFiles = await withTransaction(this.pool, async (tx) => {
      await tx.query("SELECT id FROM upload_batch WHERE id=$1 FOR UPDATE", [batchId]);
      const files = await tx.query<FailedStagingFile>(
        `SELECT id,batch_id,status,temp_path,archive_reservation_state,
                archive_expanded_bytes::text,archive_file_count
           FROM upload_file
          WHERE batch_id=$1 AND status IN ('PENDING','UPLOADING','COMPLETE','ENCRYPTING','STORED','FAILED')
            AND temp_path<>''
          ORDER BY id
          FOR UPDATE`,
        [batchId],
      );
      await releaseReservedArchiveBudgets(tx, files.rows);
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
      if (files.rows.length > 0) await tx.query(
        `UPDATE upload_file
            SET status='FAILED',archive_reservation_state='NONE',archive_expanded_bytes=0,
                archive_file_count=0,updated_at=clock_timestamp()
          WHERE id=ANY($1::uuid[]) AND status<>'STORED'`,
        [files.rows.map((row) => row.id)],
      );
      return files.rows;
    });
    await forEachUploadFile(stagingFiles, async (file) => {
      await cleanupUploadStagingArtifacts(this.pool, { fileId: file.id, tempPath: file.temp_path });
    });
  }

  async createFile(input: CreateUploadFile): Promise<string> {
    const [file] = await this.createFiles(input.batchId, [{
      relativePath: input.relativePath,
      declaredSize: input.declaredSize,
      ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
      ...(input.metadataOnly !== undefined ? { metadataOnly: input.metadataOnly } : {}),
    }]);
    if (!file) throw new Error("UPLOAD_FILE_CREATE_FAILED");
    return file.id;
  }

  async createFiles(batchId: string, inputs: readonly UploadFileRegistration[]): Promise<RegisteredUploadFile[]> {
    const normalized = normalizeUploadFiles(inputs);
    if (normalized.files.length === 0) return [];
    await mkdir(this.root, { recursive: true });
    const disk = await statfs(this.root, { bigint: true });
    const createdTempPaths: string[] = [];
    try {
      const result = await withTransaction(this.pool, (tx) => this.registerFilesInTransaction(
        tx,
        batchId,
        normalized.files,
        disk.bavail * disk.bsize,
        createdTempPaths,
      ));
      const metadataOnlyCount = normalized.files.filter((file) => file.metadataOnly).length;
      if (metadataOnlyCount > 0) {
        structuredLog("info", "api", "upload_pdf_metadata_registered", { batchId, fileCount: metadataOnlyCount });
      }
      return result;
    } catch (error) {
      await removeTemporaryUploadPaths(createdTempPaths);
      throw error;
    }
  }

  async appendChunk(input: AppendChunk): Promise<bigint> {
    if (input.length < 0 || input.length > MAX_CHUNK_BYTES) throw new Error("CHUNK_SIZE_LIMIT");
    const candidateResult = await this.pool.query<{
      file_id: string;
      batch_id: string;
      temp_path: string;
      declared_size: string;
      received_size: string;
    }>(
      `SELECT file.id AS file_id,file.batch_id,file.temp_path,file.declared_size,file.received_size
         FROM upload_file file
         JOIN upload_batch batch ON batch.id=file.batch_id
        WHERE file.id=$1 AND file.status IN ('PENDING','UPLOADING')
          AND batch.status IN ('OPEN','UPLOADING')
          AND batch.expires_at>clock_timestamp()`,
      [input.fileId],
    );
    const candidate = candidateResult.rows[0];
    if (!candidate) throw new Error("UPLOAD_FILE_NOT_WRITABLE");
    const candidateOffset = BigInt(candidate.received_size);
    if (candidateOffset !== input.expectedOffset) throw new Error(`UPLOAD_OFFSET_MISMATCH:${candidateOffset}`);
    if (candidateOffset + BigInt(input.length) > BigInt(candidate.declared_size)) throw new Error("UPLOAD_FILE_OVERFLOW");

    const targetPath = resolve(candidate.temp_path);
    if (!targetPath.startsWith(`${this.root}${sep}`)) throw new Error("UPLOAD_PATH_ESCAPE");
    const chunkBase = resolve(targetPath, "..", "chunks");
    const chunkRoot = resolve(chunkBase, candidate.file_id);
    const stagedChunkPath = resolve(chunkRoot, `${randomUUID()}.part`);
    if (!chunkRoot.startsWith(`${chunkBase}${sep}`) || !stagedChunkPath.startsWith(`${chunkRoot}${sep}`)) {
      throw new Error("UPLOAD_PATH_ESCAPE");
    }
    await mkdir(chunkRoot, { recursive: true });
    const verifier = new ChunkVerifier();
    try {
      const decoded = input.contentEncoding === "gzip" ? input.body.pipe(createGunzip()) : input.body;
      await pipeline(decoded, verifier, createWriteStream(stagedChunkPath, { flags: "wx" }));
      const actualDigest = verifier.hash.digest();
      const expected = input.expectedSha256.trim();
      const matches = /^[a-f0-9]{64}$/i.test(expected)
        ? actualDigest.toString("hex") === expected.toLowerCase()
        : actualDigest.toString("base64") === expected;
      if (verifier.bytes !== input.length || !matches) throw new Error("UPLOAD_CHUNK_CHECKSUM_MISMATCH");

      return await withTransaction(this.pool, async (tx) => {
        const writableBatch = await tx.query<{ id: string }>(
          `SELECT batch.id
             FROM upload_file file
             JOIN upload_batch batch ON batch.id=file.batch_id
            WHERE file.id=$1 AND batch.status IN ('OPEN','UPLOADING')
              AND batch.expires_at>clock_timestamp()
            FOR UPDATE OF batch`,
          [input.fileId],
        );
        if (!writableBatch.rows[0]) throw new Error("UPLOAD_FILE_NOT_WRITABLE");
        const result = await tx.query<{ batch_id: string; temp_path: string; declared_size: string; received_size: string }>(
          `SELECT batch_id,temp_path,declared_size,received_size
             FROM upload_file
            WHERE id=$1 AND status IN ('PENDING','UPLOADING')
            FOR UPDATE`,
          [input.fileId],
        );
        const file = result.rows[0];
        if (!file) throw new Error("UPLOAD_FILE_NOT_WRITABLE");
        const current = BigInt(file.received_size);
        if (current !== input.expectedOffset) throw new Error(`UPLOAD_OFFSET_MISMATCH:${current}`);
        if (current + BigInt(input.length) > BigInt(file.declared_size)) throw new Error("UPLOAD_FILE_OVERFLOW");
        if (resolve(file.temp_path) !== targetPath) throw new Error("UPLOAD_FILE_PATH_CHANGED");
        await pipeline(
          createReadStream(stagedChunkPath),
          createWriteStream(targetPath, { flags: "r+", start: Number(current) }),
        );
        const next = current + BigInt(verifier.bytes);
        const complete = next === BigInt(file.declared_size);
        await tx.query("INSERT INTO upload_chunk_receipt (upload_file_id,chunk_offset,chunk_size,sha256) VALUES ($1,$2,$3,$4)", [input.fileId, current.toString(), verifier.bytes, actualDigest.toString("hex")]);
        await tx.query("UPDATE upload_file SET received_size=$2,status=$3,updated_at=clock_timestamp() WHERE id=$1", [input.fileId, next.toString(), complete ? "COMPLETE" : "UPLOADING"]);
        await tx.query("UPDATE upload_batch SET received_bytes=received_bytes+$2,updated_at=clock_timestamp() WHERE id=$1", [file.batch_id, verifier.bytes]);
        if (complete) await enqueueOutbox(tx, { topic: "upload.finalize", businessKey: input.fileId, payload: { fileId: input.fileId } });
        const disk = await stat(targetPath);
        if (BigInt(disk.size) < next) throw new Error("UPLOAD_DURABILITY_CHECK_FAILED");
        return next;
      });
    } finally {
      await unlink(stagedChunkPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") {
          structuredLog("error", "api", "upload_chunk_staging_cleanup_failed", {
            fileId: input.fileId,
            ...safeErrorDiagnostic(error),
          });
        }
      });
    }
  }
}
