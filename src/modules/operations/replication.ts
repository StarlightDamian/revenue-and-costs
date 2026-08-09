import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Pool } from "pg";

class DigestTap extends Transform {
  readonly hash = createHash("sha256");
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk); callback(null, chunk);
  }
}

export interface ReplicaResult { bytes: bigint; sha256: string; verifiedAt: string }
export type ReplicaKind = "LOCAL_VALIDATION" | "OFFSITE";

export async function replicateAndVerify(source: string, destination: string, expectedSha256: string): Promise<ReplicaResult> {
  const partial = `${destination}.partial`;
  await mkdir(dirname(destination), { recursive: true });
  const digest = new DigestTap();
  try {
    await pipeline(createReadStream(source), digest, createWriteStream(partial, { flags: "wx" }));
    const sha256 = digest.hash.digest("hex");
    if (sha256 !== expectedSha256) throw new Error("REPLICA_HASH_MISMATCH");
    await rename(partial, destination);
    const info = await stat(destination);
    return { bytes: BigInt(info.size), sha256, verifiedAt: new Date().toISOString() };
  } catch (error) {
    await unlink(partial).catch(() => undefined);
    throw error;
  }
}

export async function replicateStoredObject(
  pool: Pool,
  input: {
    readonly objectId: string;
    readonly replicaName: string;
    readonly destination: string;
    readonly targetKind: ReplicaKind;
    readonly targetReference: string;
  },
): Promise<ReplicaResult> {
  if (!input.targetReference.trim()) throw new Error("REPLICA_TARGET_REFERENCE_REQUIRED");
  const targetReferenceSha256 = createHash("sha256").update(input.targetReference, "utf8").digest("hex");
  const start = await pool.connect();
  let sourcePath = "";
  let expectedSha256 = "";
  try {
    await start.query("BEGIN");
    const object = await start.query<{ storage_path: string; ciphertext_sha256: string }>(
      "SELECT storage_path, ciphertext_sha256 FROM stored_object WHERE id = $1 FOR SHARE",
      [input.objectId],
    );
    const row = object.rows[0];
    if (!row) throw new Error("STORED_OBJECT_NOT_FOUND");
    sourcePath = row.storage_path;
    expectedSha256 = row.ciphertext_sha256;
    const inserted = await start.query(
      `INSERT INTO stored_object_replica
        (object_id, replica_name, storage_path, ciphertext_sha256, status, replica_kind, target_reference_sha256)
       VALUES ($1,$2,$3,$4,'COPYING',$5,$6)
       ON CONFLICT (object_id, replica_name) DO UPDATE
         SET storage_path = EXCLUDED.storage_path,
             ciphertext_sha256 = EXCLUDED.ciphertext_sha256,
             status = 'COPYING', verified_at = NULL,
             replica_kind = EXCLUDED.replica_kind,
             target_reference_sha256 = EXCLUDED.target_reference_sha256
       WHERE stored_object_replica.status <> 'VERIFIED'`,
      [input.objectId, input.replicaName, input.destination, expectedSha256, input.targetKind, targetReferenceSha256],
    );
    if (inserted.rowCount !== 1) throw new Error("REPLICA_ALREADY_VERIFIED");
    await start.query("COMMIT");
  } catch (error) {
    await start.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    start.release();
  }

  let copied = false;
  try {
    const result = await replicateAndVerify(sourcePath, input.destination, expectedSha256);
    copied = true;
    const finish = await pool.connect();
    try {
      await finish.query("BEGIN");
      const updated = await finish.query(
        `UPDATE stored_object_replica
            SET status = 'VERIFIED', verified_at = $4
          WHERE object_id = $1 AND replica_name = $2 AND status = 'COPYING'
            AND ciphertext_sha256 = $3 AND replica_kind = $5 AND target_reference_sha256 = $6`,
        [input.objectId, input.replicaName, expectedSha256, result.verifiedAt, input.targetKind, targetReferenceSha256],
      );
      if (updated.rowCount !== 1) throw new Error("REPLICA_STATE_CONFLICT");
      if (input.targetKind === "OFFSITE") {
        await finish.query(
          `UPDATE stored_object SET verification_status = 'REMOTE_VERIFIED'
            WHERE id = $1 AND verification_status = 'LOCAL_VERIFIED'`,
          [input.objectId],
        );
      }
      await finish.query("COMMIT");
      return result;
    } catch (error) {
      await finish.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      finish.release();
    }
  } catch (error) {
    await pool.query(
      `UPDATE stored_object_replica
          SET status = 'FAILED', verified_at = NULL
        WHERE object_id = $1 AND replica_name = $2 AND status = 'COPYING'`,
      [input.objectId, input.replicaName],
    ).catch(() => undefined);
    if (copied) await unlink(input.destination).catch(() => undefined);
    throw error;
  }
}
