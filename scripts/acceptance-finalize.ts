import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Pool } from "pg";
import { PostgresExportService } from "../src/modules/exports/postgres.js";
import { EncryptedObjectStore } from "../src/modules/storage/encrypted-object-store.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

const databaseUrl = required("DATABASE_URL");
const outputPath = resolve(required("ACCEPTANCE_EXPORT_OUTPUT"));
const storageRoot = resolve(required("STORAGE_ROOT"));
const outputRoot = resolve(process.env.ACCEPTANCE_EXPORT_WORK_ROOT ?? ".work/exports");
const key = Buffer.from(required("FILE_KEK_BASE64"), "base64");
if (key.byteLength !== 32) throw new Error("FILE_KEK_BASE64_MUST_DECODE_TO_32_BYTES");

const pool = new Pool({ connectionString: databaseUrl });
try {
  const target = (await pool.query<{
    shop_id: string;
    owner_account_id: string;
    enterprise_id: string;
    published_snapshot_id: string;
  }>(
    `SELECT pointer.shop_id,shop.owner_account_id,shop.enterprise_id,pointer.published_snapshot_id
       FROM shop_current_published_snapshot pointer
       JOIN shop ON shop.id=pointer.shop_id
      ORDER BY pointer.switched_at DESC LIMIT 1`,
  )).rows[0];
  if (!target) throw new Error("PUBLISHED_ACCEPTANCE_SHOP_REQUIRED");

  const store = new EncryptedObjectStore(storageRoot, key);
  const exportsService = new PostgresExportService(pool, store, outputRoot);
  const actor = { accountId: target.owner_account_id, status: "ACTIVE" as const, roles: new Set(["ACCOUNTANT"] as const), enterpriseIds: new Set([target.enterprise_id]) };
  const created = await exportsService.create(
    actor,
    target.shop_id,
    target.published_snapshot_id,
    "final-acceptance-export-v1",
    "acceptance:export:create",
  );
  await exportsService.generate(created.id);
  const downloadToken = await exportsService.createDownloadToken(actor, created.id, "acceptance:export:token");
  const downloadable = await exportsService.download(actor, created.id, downloadToken, "acceptance:export:download");
  await mkdir(dirname(outputPath), { recursive: true });
  await pipeline(downloadable.stream, createWriteStream(outputPath, { flags: "wx" }));

  const evidence = (await pool.query<{
    status: string;
    output_kind: string;
    byte_size: string;
    output_sha256: string;
    file_count: string;
    manifest_sha256: string;
  }>(
    `SELECT request.status,request.output_kind,object.plaintext_size::text byte_size,
            object.plaintext_sha256 output_sha256,
            (SELECT count(*)::text FROM export_file_manifest file WHERE file.export_request_id=request.id) file_count,
            encode(integrity.canonical_manifest_sha256,'hex') manifest_sha256
       FROM export_request request
       JOIN stored_object object ON object.id=request.output_object_id
       JOIN published_snapshot_integrity integrity ON integrity.published_snapshot_id=request.published_snapshot_id
      WHERE request.id=$1`,
    [created.id],
  )).rows[0];
  if (!evidence) throw new Error("EXPORT_EVIDENCE_MISSING");
  const downloadedSha256 = await sha256File(outputPath);
  if (downloadedSha256 !== evidence.output_sha256) throw new Error("DECRYPTED_EXPORT_HASH_MISMATCH");
  process.stdout.write(`${JSON.stringify({
    exportId: created.id,
    shopId: target.shop_id,
    snapshotId: target.published_snapshot_id,
    outputPath,
    downloadedSha256,
    ...evidence,
  })}\n`);
} finally {
  await pool.end();
}
