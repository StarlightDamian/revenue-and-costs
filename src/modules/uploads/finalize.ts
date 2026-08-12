import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { rm, unlink } from "node:fs/promises";
import { withTransaction } from "../../db/pool";
import { enqueueOutbox } from "../../db/outbox";
import { defaultZipLimits, extractValidatedZip, ooxmlZipLimits, validateZip, type ExtractedZipEntry } from "../archive/zip-validator";
import type { EncryptedObjectStore, StoredObjectMetadata } from "../storage/encrypted-object-store";
import {
  assertArchiveEntryWriteCapacity,
  assertArchiveExtractionCapacity,
  assertEncryptedObjectWriteCapacity,
  releaseArchiveBudget,
  reserveArchiveBudget,
  withArchiveVolumeLease,
} from "./archive-budget.js";
import { detectFileKind, isOoxmlSpreadsheetContainer } from "./file-kind";

interface UploadFileRow { id: string; batch_id: string; temp_path: string; relative_path: string; declared_size: string; shop_id: string }

async function removeStagedPlaintext(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function childId(parentId: string, path: string): string {
  const hex = createHash("sha256").update(parentId).update("\0").update(path).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function archiveRelativePath(parent: string, entry: string): string {
  const prefix = parent.replace(/\.zip$/i, "");
  return `${prefix}/${entry}`;
}

export async function finalizeUploadFile(pool: Pool, store: EncryptedObjectStore, fileId: string): Promise<string> {
  const existing = await pool.query<{ id: string; batch_id: string; temp_path: string }>(
    "SELECT so.id,f.batch_id,f.temp_path FROM upload_file f JOIN stored_object so ON so.id=f.stored_object_id WHERE f.id=$1",
    [fileId],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].id !== fileId) await store.removeUncommitted(fileId);
    await removeStagedPlaintext(existing.rows[0].temp_path);
    await withTransaction(pool, async (tx) => {
      await tx.query("SELECT id FROM upload_batch WHERE id=$1 FOR UPDATE", [existing.rows[0]!.batch_id]);
      const restored = await tx.query(
        `UPDATE upload_file f SET updated_at=clock_timestamp()
          FROM upload_batch b
         WHERE f.id=$1 AND f.batch_id=b.id AND f.status='STORED'
           AND b.status IN ('OPEN','UPLOADING','FINALIZING','READY')
           AND (b.status NOT IN ('OPEN','UPLOADING') OR b.expires_at>clock_timestamp())
         RETURNING f.id`,
        [fileId],
      );
      if (restored.rowCount === 1) {
        await enqueueOutbox(tx, { topic: "import.analyze", businessKey: fileId, payload: { fileId, objectId: existing.rows[0]!.id } });
      }
    });
    return existing.rows[0].id;
  }
  const claimed = await pool.query<UploadFileRow>(
    `UPDATE upload_file f SET status='ENCRYPTING',updated_at=clock_timestamp()
     FROM upload_batch b WHERE f.id=$1 AND f.batch_id=b.id AND f.status IN ('COMPLETE','ENCRYPTING')
       AND b.status IN ('OPEN','UPLOADING','FINALIZING','READY')
       AND (b.status NOT IN ('OPEN','UPLOADING') OR b.expires_at>clock_timestamp())
     RETURNING f.id,f.batch_id,f.temp_path,f.relative_path,f.declared_size,b.shop_id`,
    [fileId],
  );
  const file = claimed.rows[0];
  if (!file) throw new Error("UPLOAD_FILE_NOT_FINALIZABLE");
  let extracted: ExtractedZipEntry[] = [];
  let extractionRoot: string | undefined;
  let archiveBudgetReserved = false;
  let selectedObjectId = fileId;
  let reusedObject = false;
  let encryptedObjectWritten = false;
  try {
    const kind = await detectFileKind(file.temp_path);
    if (kind === "PDF") throw new Error("PDF_BODY_UPLOAD_REJECTED");
    const objectRoot = dirname(dirname(store.objectPath(fileId)));
    let metadata: StoredObjectMetadata;
    if (kind === "ZIP") {
      const root = join(dirname(file.temp_path), "archive", file.id);
      extractionRoot = root;
      metadata = await withArchiveVolumeLease(pool, [file.temp_path, objectRoot], async () => {
        try {
          extracted = await extractValidatedZip(
            file.temp_path,
            root,
            (entry) => join(root, `${childId(file.id, entry)}.part`),
            defaultZipLimits,
            async (reports) => {
              const files = reports.filter((entry) => !entry.directory);
              if (files.some((entry) => /\.pdf$/iu.test(entry.path))) throw new Error("ZIP_PDF_ENTRY_REQUIRES_FOLDER_UPLOAD");
              const expandedBytes = files.reduce((total, entry) => total + entry.expandedBytes, 0n);
              await reserveArchiveBudget(pool, {
                fileId: file.id,
                batchId: file.batch_id,
                expandedBytes,
                fileCount: files.length,
              });
              archiveBudgetReserved = true;
              const maxEntryBytes = files.reduce(
                (largest, entry) => entry.expandedBytes > largest ? entry.expandedBytes : largest,
                0n,
              );
              await assertArchiveExtractionCapacity({
                stagingPath: file.temp_path,
                objectRoot,
                expandedBytes,
                maxEntryBytes,
                parentDeclaredBytes: BigInt(file.declared_size),
              });
            },
            async (entry) => assertArchiveEntryWriteCapacity(file.temp_path, entry.expandedBytes),
          );
        } catch (error) {
          const code = error instanceof Error && /^ZIP_[A-Z0-9_]+$/u.test(error.message)
            ? error.message
            : error instanceof Error && /^(?:UPLOAD_FINALIZE_STATE_CHANGED|UPLOAD_STORAGE_CAPACITY_(?:EVIDENCE_UNAVAILABLE|INSUFFICIENT))$/u.test(error.message)
              ? error.message
              : "ZIP_INVALID_ARCHIVE";
          throw new Error(code, { cause: error });
        }
        await store.removeUncommitted(fileId);
        await assertEncryptedObjectWriteCapacity(objectRoot, BigInt(file.declared_size));
        const written = await store.putFile(file.temp_path, fileId, { shopId: file.shop_id, batchId: file.batch_id, kind: "SOURCE" });
        encryptedObjectWritten = true;
        return written;
      });
    } else {
      if (kind === "OTHER" && await isOoxmlSpreadsheetContainer(file.temp_path)) {
        try {
          await validateZip(file.temp_path, ooxmlZipLimits);
        } catch (error) {
          const code = error instanceof Error && /^ZIP_[A-Z0-9_]+$/u.test(error.message)
            ? `XLSX_${error.message.slice(4)}`
            : "XLSX_INVALID_ARCHIVE";
          throw new Error(code, { cause: error });
        }
      }
      metadata = await withArchiveVolumeLease(pool, [objectRoot], async () => {
        await store.removeUncommitted(fileId);
        await assertEncryptedObjectWriteCapacity(objectRoot, BigInt(file.declared_size));
        const written = await store.putFile(file.temp_path, fileId, { shopId: file.shop_id, batchId: file.batch_id, kind: "SOURCE" });
        encryptedObjectWritten = true;
        return written;
      });
    }
    await withTransaction(pool, async (tx) => {
      await tx.query("SELECT id FROM upload_batch WHERE id=$1 FOR UPDATE", [file.batch_id]);
      const finalizable = await tx.query<{
        archive_reservation_state: string;
        archive_expanded_bytes: string;
        archive_file_count: number;
      }>(
        `SELECT f.archive_reservation_state,f.archive_expanded_bytes::text,f.archive_file_count
           FROM upload_file f JOIN upload_batch b ON b.id=f.batch_id
          WHERE f.id=$1 AND f.batch_id=$2 AND f.status='ENCRYPTING'
            AND b.status IN ('OPEN','UPLOADING','FINALIZING','READY')
            AND (b.status NOT IN ('OPEN','UPLOADING') OR b.expires_at>clock_timestamp())
          FOR UPDATE OF f`,
        [fileId, file.batch_id],
      );
      const finalizableRow = finalizable.rows[0];
      if (!finalizableRow) throw new Error("UPLOAD_FINALIZE_STATE_CHANGED");
      if (kind === "ZIP" && finalizableRow.archive_reservation_state !== "RESERVED") {
        throw new Error("ZIP_RESERVATION_STATE_INVALID");
      }

      const duplicate = await tx.query<{ id: string }>(
        `SELECT id FROM stored_object
          WHERE owner_shop_id=$1 AND object_kind='SOURCE' AND plaintext_sha256=$2 AND plaintext_size=$3
          ORDER BY created_at LIMIT 1 FOR SHARE`,
        [file.shop_id, metadata.plaintextSha256, metadata.plaintextSize.toString()],
      );
      selectedObjectId = duplicate.rows[0]?.id ?? fileId;
      if (!duplicate.rows[0]) {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO stored_object (id,object_kind,owner_shop_id,immutable_key,storage_path,plaintext_size,plaintext_sha256,ciphertext_sha256,encryption_format,encryption_context,verification_status)
           VALUES ($1,'SOURCE',$2,$3,$4,$5,$6,$7,'AWS_ESDK_V2_FRAMED',$8::jsonb,'LOCAL_VERIFIED')
           ON CONFLICT DO NOTHING RETURNING id`,
          [fileId, file.shop_id, `source/${fileId}`, metadata.path, metadata.plaintextSize.toString(), metadata.plaintextSha256, metadata.ciphertextSha256, JSON.stringify(metadata.encryptionContext)],
        );
        if (!inserted.rows[0]) {
          const raced = await tx.query<{ id: string }>(
            `SELECT id FROM stored_object
              WHERE owner_shop_id=$1 AND object_kind='SOURCE' AND plaintext_sha256=$2 AND plaintext_size=$3
              ORDER BY created_at LIMIT 1`,
            [file.shop_id, metadata.plaintextSha256, metadata.plaintextSize.toString()],
          );
          if (!raced.rows[0]) throw new Error("SOURCE_DEDUPLICATION_RACE");
          selectedObjectId = raced.rows[0].id;
        }
      }
      if (selectedObjectId !== fileId) {
        reusedObject = true;
        await tx.query(
          `INSERT INTO import_issue (import_batch_id,severity,issue_code,safe_context)
           SELECT ib.id,'INFO','DUPLICATE_SOURCE',$2::jsonb FROM import_batch ib WHERE ib.upload_batch_id=$1`,
          [file.batch_id, JSON.stringify({ relativePath: file.relative_path, reusedObjectId: selectedObjectId })],
        );
      }
      const stored = await tx.query(
        `UPDATE upload_file f
            SET status='STORED',stored_object_id=$2,plaintext_sha256=$3,detected_kind=$4,
                archive_reservation_state=CASE WHEN $5 THEN 'COMMITTED' ELSE f.archive_reservation_state END,
                updated_at=clock_timestamp()
           FROM upload_batch b
          WHERE f.id=$1 AND f.batch_id=b.id AND f.status='ENCRYPTING'
            AND b.status IN ('OPEN','UPLOADING','FINALIZING','READY')
            AND (b.status NOT IN ('OPEN','UPLOADING') OR b.expires_at>clock_timestamp())
            AND (NOT $5 OR f.archive_reservation_state='RESERVED')
          RETURNING f.id`,
        [fileId, selectedObjectId, metadata.plaintextSha256, kind, kind === "ZIP"],
      );
      if (stored.rowCount !== 1) throw new Error("UPLOAD_FINALIZE_STATE_CHANGED");
      for (const entry of extracted) {
        const id = childId(file.id, entry.path);
        const relativePath = archiveRelativePath(file.relative_path, entry.path);
        const inserted = await tx.query(
          `INSERT INTO upload_file
            (id,batch_id,relative_path,declared_size,received_size,content_type,status,temp_path)
           VALUES ($1,$2,$3,$4,$4,NULL,'COMPLETE',$5)
           ON CONFLICT (batch_id,relative_path) DO NOTHING
           RETURNING id`,
          [id, file.batch_id, relativePath, entry.expandedBytes.toString(), entry.destinationPath],
        );
        if (inserted.rowCount !== 1) throw new Error("ZIP_CHILD_INSERT_CONFLICT");
        await enqueueOutbox(tx, { topic: "upload.finalize", businessKey: id, payload: { fileId: id } });
      }
      await enqueueOutbox(tx, { topic: "import.analyze", businessKey: fileId, payload: { fileId, objectId: selectedObjectId, detectedKind: kind } });
    });
    archiveBudgetReserved = false;
  } catch (error) {
    // Once the parent ciphertext exists, a failed COMMIT response also leaves
    // the ZIP child rows/outbox state uncertain. Preserve their staged files
    // with the parent object so an idempotent replay can arbitrate both.
    if (extractionRoot && !encryptedObjectWritten) {
      await rm(extractionRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    // Once the final ciphertext exists, a failed COMMIT response cannot tell us
    // whether PostgreSQL committed its reference. Preserve it for the idempotent
    // replay to arbitrate; an actual rollback is cleaned before the next putFile.
    if (!encryptedObjectWritten) await store.removeUncommitted(fileId).catch(() => undefined);
    if (archiveBudgetReserved) await releaseArchiveBudget(pool, { fileId: file.id, batchId: file.batch_id });
    throw error;
  }
  if (reusedObject) await store.removeUncommitted(fileId);
  await removeStagedPlaintext(file.temp_path);
  return selectedObjectId;
}
