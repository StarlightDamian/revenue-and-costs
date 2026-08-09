import { createHash } from "node:crypto";
import { Pool } from "pg";
import { loadConfig } from "../src/shared/config.js";
import { EncryptedObjectStore } from "../src/modules/storage/encrypted-object-store.js";

const config = loadConfig();
const pool = new Pool({ connectionString: config.databaseUrl });
try {
  const result = await pool.query<{
    id: string; storage_path: string; plaintext_size: string; plaintext_sha256: string;
    encryption_context: Record<string, string>;
  }>(
    `SELECT id,storage_path,plaintext_size,plaintext_sha256,encryption_context
       FROM stored_object WHERE object_kind='SOURCE'
      ORDER BY plaintext_size DESC LIMIT 1`,
  );
  const object = result.rows[0];
  if (!object) throw new Error("SOURCE_OBJECT_NOT_FOUND");
  const store = new EncryptedObjectStore(config.storageRoot, Buffer.from(config.fileKekBase64, "base64"));
  const stream = store.createDecryptionStream(object.storage_path, object.encryption_context);
  const hash = createHash("sha256");
  let bytes = 0n;
  let peakRss = process.memoryUsage().rss;
  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes += BigInt(chunk.byteLength);
    hash.update(chunk);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  const digest = hash.digest("hex");
  if (bytes.toString() !== object.plaintext_size || digest !== object.plaintext_sha256) throw new Error("DECRYPTED_OBJECT_INTEGRITY_MISMATCH");
  process.stdout.write(`${JSON.stringify({ objectId: object.id, bytes: bytes.toString(), sha256: digest, peakRssBytes: peakRss, peakRssMiB: Math.round(peakRss / 1024 / 1024) })}\n`);
} finally {
  await pool.end();
}
