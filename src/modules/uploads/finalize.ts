import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { unlink } from "node:fs/promises";
import { withTransaction } from "../../db/pool";
import { enqueueOutbox } from "../../db/outbox";
import { extractValidatedZip, type ExtractedZipEntry } from "../archive/zip-validator";
import type { EncryptedObjectStore } from "../storage/encrypted-object-store";
import { detectFileKind } from "./file-kind";

interface UploadFileRow { id: string; batch_id: string; temp_path: string; relative_path: string; declared_size: string; shop_id: string }

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
  const existing = await pool.query<{ id: string }>(
    "SELECT so.id FROM upload_file f JOIN stored_object so ON so.id=f.stored_object_id WHERE f.id=$1",
    [fileId],
  );
  if (existing.rows[0]) {
    await withTransaction(pool, async (tx) => {
      await tx.query("UPDATE upload_file SET status='STORED',updated_at=clock_timestamp() WHERE id=$1 AND status IN ('COMPLETE','ENCRYPTING','STORED')", [fileId]);
      await enqueueOutbox(tx, { topic: "import.analyze", businessKey: fileId, payload: { fileId, objectId: existing.rows[0]!.id } });
    });
    return existing.rows[0].id;
  }
  const claimed = await pool.query<UploadFileRow>(
    `UPDATE upload_file f SET status='ENCRYPTING',updated_at=clock_timestamp()
     FROM upload_batch b WHERE f.id=$1 AND f.batch_id=b.id AND f.status IN ('COMPLETE','ENCRYPTING')
     RETURNING f.id,f.batch_id,f.temp_path,f.relative_path,f.declared_size,b.shop_id`,
    [fileId],
  );
  const file = claimed.rows[0];
  if (!file) throw new Error("UPLOAD_FILE_NOT_FINALIZABLE");
  const kind = await detectFileKind(file.temp_path);
  let extracted: ExtractedZipEntry[] = [];
  if (kind === "ZIP") {
    const extractionRoot = join(dirname(file.temp_path), "archive", file.id);
    try {
      extracted = await extractValidatedZip(
        file.temp_path,
        extractionRoot,
        (entry) => join(extractionRoot, `${childId(file.id, entry)}.part`),
      );
    } catch (error) {
      const code = error instanceof Error && /^ZIP_[A-Z0-9_]+$/u.test(error.message)
        ? error.message
        : "ZIP_INVALID_ARCHIVE";
      throw new Error(code, { cause: error });
    }
  }
  await store.removeUncommitted(fileId);
  const metadata = await store.putFile(file.temp_path, fileId, { shopId: file.shop_id, batchId: file.batch_id, kind: "SOURCE" });
  let selectedObjectId = fileId;
  let reusedObject = false;
  await withTransaction(pool, async (tx) => {
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
    await tx.query(
      "UPDATE upload_file SET status='STORED',stored_object_id=$2,plaintext_sha256=$3,detected_kind=$4,updated_at=clock_timestamp() WHERE id=$1",
      [fileId, selectedObjectId, metadata.plaintextSha256, kind],
    );
    for (const entry of extracted) {
      const id = childId(file.id, entry.path);
      const relativePath = archiveRelativePath(file.relative_path, entry.path);
      await tx.query(
        `INSERT INTO upload_file
          (id,batch_id,relative_path,declared_size,received_size,content_type,status,temp_path)
         VALUES ($1,$2,$3,$4,$4,NULL,'COMPLETE',$5)
         ON CONFLICT (batch_id,relative_path) DO NOTHING`,
        [id, file.batch_id, relativePath, entry.expandedBytes.toString(), entry.destinationPath],
      );
      await enqueueOutbox(tx, { topic: "upload.finalize", businessKey: id, payload: { fileId: id } });
    }
    if (extracted.length > 0) {
      const expandedCount = await tx.query(
        `UPDATE upload_batch
            SET file_count = file_count + $2, updated_at = clock_timestamp()
          WHERE id = $1 AND file_count + $2 <= 20000
          RETURNING id`,
        [file.batch_id, extracted.length],
      );
      if (expandedCount.rowCount !== 1) throw new Error("ZIP_TOO_MANY_ENTRIES");
    }
    await enqueueOutbox(tx, { topic: "import.analyze", businessKey: fileId, payload: { fileId, objectId: selectedObjectId, detectedKind: kind } });
  });
  if (reusedObject) await store.removeUncommitted(fileId);
  await unlink(file.temp_path).catch(() => undefined);
  return selectedObjectId;
}
