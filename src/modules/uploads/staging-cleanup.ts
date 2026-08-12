import { rm, unlink } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import type { Pool } from "pg";

const UPLOAD_FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

async function ignoreMissing(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function removeUploadStagingArtifacts(input: {
  readonly fileId: string;
  readonly tempPath: string;
}): Promise<void> {
  if (input.tempPath === "") return;
  if (!UPLOAD_FILE_ID.test(input.fileId)) throw new Error("UPLOAD_STAGING_CLEANUP_FILE_ID_INVALID");

  const tempPath = resolve(input.tempPath);
  const archiveBase = resolve(dirname(tempPath), "archive");
  const archiveRoot = resolve(archiveBase, input.fileId);
  const chunkBase = resolve(dirname(tempPath), "chunks");
  const chunkRoot = resolve(chunkBase, input.fileId);
  if (!archiveRoot.startsWith(`${archiveBase}${sep}`) || !chunkRoot.startsWith(`${chunkBase}${sep}`)) {
    throw new Error("UPLOAD_STAGING_CLEANUP_PATH_INVALID");
  }

  await Promise.all([
    ignoreMissing(async () => unlink(tempPath)),
    ignoreMissing(async () => rm(archiveRoot, { recursive: true })),
    ignoreMissing(async () => rm(chunkRoot, { recursive: true })),
  ]);
}

export async function cleanupUploadStagingArtifacts(
  pool: Pool,
  input: { readonly fileId: string; readonly tempPath: string },
): Promise<void> {
  if (input.tempPath === "") return;
  await removeUploadStagingArtifacts(input);
  const cleaned = await pool.query<{ cleaned: boolean }>(
    `WITH updated AS (
       UPDATE upload_file SET temp_path='',updated_at=clock_timestamp()
        WHERE id=$1 AND temp_path=$2
       RETURNING id
     )
     SELECT EXISTS(SELECT 1 FROM updated)
         OR EXISTS(SELECT 1 FROM upload_file WHERE id=$1 AND temp_path='') AS cleaned`,
    [input.fileId, input.tempPath],
  );
  if (cleaned.rows[0]?.cleaned !== true) throw new Error("UPLOAD_STAGING_CLEANUP_STATE_CHANGED");
}
