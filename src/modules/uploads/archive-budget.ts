import type { Pool, PoolClient } from "pg";
import { stat, statfs } from "node:fs/promises";
import { withTransaction } from "../../db/pool.js";

export const MAX_UPLOAD_FILES = 20_000;
export const MAX_BATCH_EXPANDED_BYTES = 8n * 1024n * 1024n * 1024n;
export const ARCHIVE_STORAGE_RESERVE_BYTES = 4n * 1024n * 1024n * 1024n;

export interface ArchiveCapacityReader {
  availableBytes(path: string): Promise<bigint>;
  deviceId(path: string): Promise<bigint>;
}

const fileSystemCapacityReader: ArchiveCapacityReader = {
  async availableBytes(path) {
    const volume = await statfs(path, { bigint: true });
    return volume.bavail * volume.bsize;
  },
  async deviceId(path) {
    return (await stat(path, { bigint: true })).dev;
  },
};

const ARCHIVE_VOLUME_LOCK_PREFIX = "revenue-and-costs:upload-volume:";

async function resolveArchiveVolumeLockKeys(
  paths: readonly string[],
  reader: Pick<ArchiveCapacityReader, "deviceId">,
): Promise<string[]> {
  if (paths.length === 0) throw new Error("UPLOAD_STORAGE_CAPACITY_EVIDENCE_UNAVAILABLE");
  let deviceIds: bigint[];
  try {
    deviceIds = await Promise.all(paths.map((path) => reader.deviceId(path)));
  } catch (error) {
    throw new Error("UPLOAD_STORAGE_CAPACITY_EVIDENCE_UNAVAILABLE", { cause: error });
  }
  if (deviceIds.some((deviceId) => deviceId < 0n)) {
    throw new Error("UPLOAD_STORAGE_CAPACITY_EVIDENCE_UNAVAILABLE");
  }
  return [...new Set(deviceIds)]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((deviceId) => `${ARCHIVE_VOLUME_LOCK_PREFIX}${deviceId}`);
}

async function releaseArchiveVolumeLock(client: PoolClient, key: string): Promise<boolean> {
  try {
    const result = await client.query<{ unlocked: boolean }>(
      "SELECT pg_advisory_unlock(hashtextextended($1,0)) AS unlocked",
      [key],
    );
    return result.rows[0]?.unlocked === true;
  } catch {
    return false;
  }
}

/**
 * Serializes capacity evidence and object writes per real filesystem volume.
 * Session locks avoid a long database transaction and are also released by
 * PostgreSQL if the dedicated connection is lost.
 */
export async function withArchiveVolumeLease<T>(
  pool: Pool,
  paths: readonly string[],
  work: () => Promise<T>,
  reader: Pick<ArchiveCapacityReader, "deviceId"> = fileSystemCapacityReader,
): Promise<T> {
  const keys = await resolveArchiveVolumeLockKeys(paths, reader);
  const client = await pool.connect();
  const acquired: string[] = [];
  let acquiring = true;
  let destroyClient = false;
  try {
    for (const key of keys) {
      await client.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [key]);
      acquired.push(key);
    }
    acquiring = false;
    return await work();
  } catch (error) {
    // A failed lock response can leave acquisition state uncertain. Closing
    // the session is the PostgreSQL-supported fail-safe for session locks.
    if (acquiring) destroyClient = true;
    throw error;
  } finally {
    for (const key of acquired.reverse()) {
      if (!await releaseArchiveVolumeLock(client, key)) destroyClient = true;
    }
    if (destroyClient) client.release(true);
    else client.release();
  }
}

function assertCapacityInput(...values: readonly bigint[]): void {
  if (values.some((value) => value < 0n)) throw new Error("UPLOAD_STORAGE_CAPACITY_EVIDENCE_UNAVAILABLE");
}

async function assertAvailableCapacity(
  path: string,
  requiredBytes: bigint,
  reader: ArchiveCapacityReader,
): Promise<void> {
  assertCapacityInput(requiredBytes);
  let availableBytes: bigint;
  try {
    availableBytes = await reader.availableBytes(path);
  } catch (error) {
    throw new Error("UPLOAD_STORAGE_CAPACITY_EVIDENCE_UNAVAILABLE", { cause: error });
  }
  if (availableBytes < 0n) throw new Error("UPLOAD_STORAGE_CAPACITY_EVIDENCE_UNAVAILABLE");
  if (availableBytes < requiredBytes) throw new Error("UPLOAD_STORAGE_CAPACITY_INSUFFICIENT");
}

export async function assertArchiveExtractionCapacity(
  input: {
    readonly stagingPath: string;
    readonly objectRoot: string;
    readonly expandedBytes: bigint;
    readonly maxEntryBytes: bigint;
    readonly parentDeclaredBytes: bigint;
  },
  reader: ArchiveCapacityReader = fileSystemCapacityReader,
): Promise<void> {
  assertCapacityInput(input.expandedBytes, input.maxEntryBytes, input.parentDeclaredBytes);
  let sameVolume: boolean;
  try {
    const [stagingDevice, objectDevice] = await Promise.all([
      reader.deviceId(input.stagingPath),
      reader.deviceId(input.objectRoot),
    ]);
    sameVolume = stagingDevice === objectDevice;
  } catch (error) {
    throw new Error("UPLOAD_STORAGE_CAPACITY_EVIDENCE_UNAVAILABLE", { cause: error });
  }

  if (sameVolume) {
    await assertAvailableCapacity(
      input.stagingPath,
      input.expandedBytes + input.maxEntryBytes + input.parentDeclaredBytes + ARCHIVE_STORAGE_RESERVE_BYTES,
      reader,
    );
    return;
  }
  await Promise.all([
    assertAvailableCapacity(
      input.stagingPath,
      input.expandedBytes + ARCHIVE_STORAGE_RESERVE_BYTES,
      reader,
    ),
    assertAvailableCapacity(
      input.objectRoot,
      input.expandedBytes + input.parentDeclaredBytes + ARCHIVE_STORAGE_RESERVE_BYTES,
      reader,
    ),
  ]);
}

export async function assertArchiveEntryWriteCapacity(
  stagingPath: string,
  entryBytes: bigint,
  reader: ArchiveCapacityReader = fileSystemCapacityReader,
): Promise<void> {
  await assertAvailableCapacity(stagingPath, entryBytes + ARCHIVE_STORAGE_RESERVE_BYTES, reader);
}

export async function assertEncryptedObjectWriteCapacity(
  objectRoot: string,
  declaredBytes: bigint,
  reader: ArchiveCapacityReader = fileSystemCapacityReader,
): Promise<void> {
  await assertAvailableCapacity(objectRoot, declaredBytes + ARCHIVE_STORAGE_RESERVE_BYTES, reader);
}

interface BatchBudgetRow {
  readonly expanded_bytes: string;
  readonly file_count: number;
}

interface FileReservationRow {
  readonly status: string;
  readonly archive_reservation_state: "NONE" | "RESERVED" | "COMMITTED";
  readonly archive_expanded_bytes: string;
  readonly archive_file_count: number;
}

export interface ArchiveBudgetReservation {
  readonly fileId: string;
  readonly batchId: string;
  readonly expandedBytes: bigint;
  readonly fileCount: number;
}

function assertBudgetInput(input: ArchiveBudgetReservation): void {
  if (input.expandedBytes < 0n || input.expandedBytes > MAX_BATCH_EXPANDED_BYTES) {
    throw new Error("ZIP_BATCH_EXPANDED_LIMIT");
  }
  if (!Number.isSafeInteger(input.fileCount) || input.fileCount < 0 || input.fileCount > MAX_UPLOAD_FILES) {
    throw new Error("ZIP_TOO_MANY_ENTRIES");
  }
}

export async function reserveArchiveBudget(pool: Pool, input: ArchiveBudgetReservation): Promise<void> {
  assertBudgetInput(input);
  await withTransaction(pool, async (tx) => {
    const batch = await tx.query<BatchBudgetRow>(
      `SELECT expanded_bytes::text,file_count
         FROM upload_batch
        WHERE id=$1 AND status IN ('OPEN','UPLOADING','FINALIZING','READY')
          AND (status NOT IN ('OPEN','UPLOADING') OR expires_at>clock_timestamp())
        FOR UPDATE`,
      [input.batchId],
    );
    const batchRow = batch.rows[0];
    if (!batchRow) throw new Error("UPLOAD_FINALIZE_STATE_CHANGED");

    const file = await tx.query<FileReservationRow>(
      `SELECT status,archive_reservation_state,archive_expanded_bytes::text,archive_file_count
         FROM upload_file WHERE id=$1 AND batch_id=$2 FOR UPDATE`,
      [input.fileId, input.batchId],
    );
    const fileRow = file.rows[0];
    if (!fileRow || fileRow.status !== "ENCRYPTING") throw new Error("UPLOAD_FINALIZE_STATE_CHANGED");
    if (fileRow.archive_reservation_state === "RESERVED") {
      if (BigInt(fileRow.archive_expanded_bytes) !== input.expandedBytes || fileRow.archive_file_count !== input.fileCount) {
        throw new Error("ZIP_RESERVATION_MISMATCH");
      }
      return;
    }
    if (fileRow.archive_reservation_state !== "NONE") throw new Error("ZIP_RESERVATION_STATE_INVALID");

    const nextExpandedBytes = BigInt(batchRow.expanded_bytes) + input.expandedBytes;
    const nextFileCount = batchRow.file_count + input.fileCount;
    if (nextExpandedBytes > MAX_BATCH_EXPANDED_BYTES) throw new Error("ZIP_BATCH_EXPANDED_LIMIT");
    if (nextFileCount > MAX_UPLOAD_FILES) throw new Error("ZIP_TOO_MANY_ENTRIES");

    await tx.query(
      `UPDATE upload_batch
          SET expanded_bytes=$2,file_count=$3,updated_at=clock_timestamp()
        WHERE id=$1`,
      [input.batchId, nextExpandedBytes.toString(), nextFileCount],
    );
    await tx.query(
      `UPDATE upload_file
          SET archive_reservation_state='RESERVED',archive_expanded_bytes=$3,
              archive_file_count=$4,updated_at=clock_timestamp()
        WHERE id=$1 AND batch_id=$2`,
      [input.fileId, input.batchId, input.expandedBytes.toString(), input.fileCount],
    );
  });
}

export async function releaseArchiveBudget(
  pool: Pool,
  input: Pick<ArchiveBudgetReservation, "fileId" | "batchId">,
): Promise<boolean> {
  return withTransaction(pool, async (tx) => releaseArchiveBudgetInTransaction(tx, input));
}

export async function releaseArchiveBudgetInTransaction(
  tx: PoolClient,
  input: Pick<ArchiveBudgetReservation, "fileId" | "batchId">,
): Promise<boolean> {
  const batch = await tx.query<Pick<BatchBudgetRow, "expanded_bytes" | "file_count">>(
    "SELECT expanded_bytes::text,file_count FROM upload_batch WHERE id=$1 FOR UPDATE",
    [input.batchId],
  );
  const batchRow = batch.rows[0];
  if (!batchRow) return false;
  const file = await tx.query<FileReservationRow>(
    `SELECT status,archive_reservation_state,archive_expanded_bytes::text,archive_file_count
       FROM upload_file WHERE id=$1 AND batch_id=$2 FOR UPDATE`,
    [input.fileId, input.batchId],
  );
  const fileRow = file.rows[0];
  if (!fileRow || fileRow.archive_reservation_state !== "RESERVED") return false;
  const reservedBytes = BigInt(fileRow.archive_expanded_bytes);
  if (BigInt(batchRow.expanded_bytes) < reservedBytes || batchRow.file_count < fileRow.archive_file_count) {
    throw new Error("UPLOAD_ARCHIVE_BUDGET_CORRUPTED");
  }
  await tx.query(
    `UPDATE upload_batch
        SET expanded_bytes=expanded_bytes-$2,file_count=file_count-$3,updated_at=clock_timestamp()
      WHERE id=$1`,
    [input.batchId, reservedBytes.toString(), fileRow.archive_file_count],
  );
  await tx.query(
    `UPDATE upload_file
        SET archive_reservation_state='NONE',archive_expanded_bytes=0,
            archive_file_count=0,updated_at=clock_timestamp()
      WHERE id=$1 AND batch_id=$2 AND archive_reservation_state='RESERVED'`,
    [input.fileId, input.batchId],
  );
  return true;
}
