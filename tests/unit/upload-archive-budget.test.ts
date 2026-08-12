import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  ARCHIVE_STORAGE_RESERVE_BYTES,
  MAX_BATCH_EXPANDED_BYTES,
  assertArchiveEntryWriteCapacity,
  assertArchiveExtractionCapacity,
  assertEncryptedObjectWriteCapacity,
  releaseArchiveBudget,
  reserveArchiveBudget,
  withArchiveVolumeLease,
  type ArchiveCapacityReader,
} from "../../src/modules/uploads/archive-budget.js";

const FILE_ID = "00000000-0000-4000-8000-000000000001";
const BATCH_ID = "00000000-0000-4000-8000-000000000002";
const GiB = 1024n * 1024n * 1024n;

function capacityReader(input: {
  readonly stagingAvailable: bigint;
  readonly objectAvailable?: bigint;
  readonly sameVolume?: boolean;
}): ArchiveCapacityReader {
  return {
    async availableBytes(path) {
      return path === "staging.part" ? input.stagingAvailable : (input.objectAvailable ?? input.stagingAvailable);
    },
    async deviceId(path) {
      if (path === "staging.part" || input.sameVolume !== false) return 1n;
      return 2n;
    },
  };
}

function poolWithQuery(query: (sql: string, parameters?: readonly unknown[]) => Promise<unknown>): {
  readonly pool: Pool;
  readonly calls: Array<{ sql: string; parameters?: readonly unknown[] }>;
} {
  const calls: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, parameters?: readonly unknown[]) {
      calls.push({ sql, ...(parameters ? { parameters } : {}) });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: null };
      return query(sql, parameters);
    },
    release: vi.fn(),
  };
  return { pool: { connect: async () => client as unknown as PoolClient } as unknown as Pool, calls };
}

function advisoryLeasePool(): {
  readonly pool: Pool;
  readonly lockOrder: string[];
  readonly unlockOrder: string[];
  readonly releases: ReturnType<typeof vi.fn>[];
} {
  const owners = new Map<string, symbol>();
  const waiters = new Map<string, Array<{ readonly owner: symbol; readonly resolve: () => void }>>();
  const held = new Map<symbol, Set<string>>();
  const lockOrder: string[] = [];
  const unlockOrder: string[] = [];
  const releases: ReturnType<typeof vi.fn>[] = [];

  async function lock(key: string, owner: symbol): Promise<void> {
    if (!owners.has(key)) {
      owners.set(key, owner);
    } else {
      await new Promise<void>((resolve) => {
        const queue = waiters.get(key) ?? [];
        queue.push({ owner, resolve });
        waiters.set(key, queue);
      });
    }
    const ownerLocks = held.get(owner) ?? new Set<string>();
    ownerLocks.add(key);
    held.set(owner, ownerLocks);
    lockOrder.push(key);
  }

  function unlock(key: string, owner: symbol): boolean {
    if (owners.get(key) !== owner) return false;
    held.get(owner)?.delete(key);
    unlockOrder.push(key);
    const queue = waiters.get(key);
    const next = queue?.shift();
    if (next) {
      owners.set(key, next.owner);
      next.resolve();
    } else {
      owners.delete(key);
      waiters.delete(key);
    }
    return true;
  }

  function disconnect(owner: symbol): void {
    for (const key of [...(held.get(owner) ?? [])]) unlock(key, owner);
    held.delete(owner);
  }

  const pool = {
    async connect() {
      const owner = Symbol("archive-volume-session");
      const release = vi.fn((destroy?: boolean) => {
        if (destroy) disconnect(owner);
      });
      releases.push(release);
      return {
        async query(sql: string, parameters?: readonly unknown[]) {
          const key = String(parameters?.[0]);
          if (sql.includes("pg_advisory_lock")) {
            await lock(key, owner);
            return { rows: [{}], rowCount: 1 };
          }
          if (sql.includes("pg_advisory_unlock")) {
            return { rows: [{ unlocked: unlock(key, owner) }], rowCount: 1 };
          }
          throw new Error(`unexpected SQL: ${sql}`);
        },
        release,
      } as unknown as PoolClient;
    },
  } as unknown as Pool;

  return { pool, lockOrder, unlockOrder, releases };
}

describe("persistent upload archive budget", () => {
  it("rejects a valid 8 GiB archive when its actual shared volume has only 5 GiB free", async () => {
    await expect(assertArchiveExtractionCapacity({
      stagingPath: "staging.part",
      objectRoot: "objects",
      expandedBytes: 8n * GiB,
      maxEntryBytes: 2n * GiB,
      parentDeclaredBytes: 84n * 1024n * 1024n,
    }, capacityReader({ stagingAvailable: 5n * GiB })))
      .rejects.toThrow("UPLOAD_STORAGE_CAPACITY_INSUFFICIENT");
  });

  it("combines staging and encrypted-object demand on one volume and separates them across volumes", async () => {
    const input = {
      stagingPath: "staging.part",
      objectRoot: "objects",
      expandedBytes: 2n * GiB,
      maxEntryBytes: 1n * GiB,
      parentDeclaredBytes: 512n * 1024n * 1024n,
    };
    const sharedRequired = input.expandedBytes + input.maxEntryBytes + input.parentDeclaredBytes + ARCHIVE_STORAGE_RESERVE_BYTES;
    await expect(assertArchiveExtractionCapacity(input, capacityReader({ stagingAvailable: sharedRequired })))
      .resolves.toBeUndefined();
    await expect(assertArchiveExtractionCapacity(input, capacityReader({ stagingAvailable: sharedRequired - 1n })))
      .rejects.toThrow("UPLOAD_STORAGE_CAPACITY_INSUFFICIENT");

    await expect(assertArchiveExtractionCapacity(input, capacityReader({
      stagingAvailable: input.expandedBytes + ARCHIVE_STORAGE_RESERVE_BYTES,
      objectAvailable: input.expandedBytes + input.parentDeclaredBytes + ARCHIVE_STORAGE_RESERVE_BYTES,
      sameVolume: false,
    }))).resolves.toBeUndefined();
  });

  it("rechecks each pending entry and every encrypted object against current free space", async () => {
    const entryBytes = 2n * GiB;
    const short = capacityReader({ stagingAvailable: entryBytes + ARCHIVE_STORAGE_RESERVE_BYTES - 1n });
    await expect(assertArchiveEntryWriteCapacity("staging.part", entryBytes, short))
      .rejects.toThrow("UPLOAD_STORAGE_CAPACITY_INSUFFICIENT");
    await expect(assertEncryptedObjectWriteCapacity("objects", entryBytes, short))
      .rejects.toThrow("UPLOAD_STORAGE_CAPACITY_INSUFFICIENT");

    const exact = capacityReader({ stagingAvailable: entryBytes + ARCHIVE_STORAGE_RESERVE_BYTES });
    await expect(assertArchiveEntryWriteCapacity("staging.part", entryBytes, exact)).resolves.toBeUndefined();
    await expect(assertEncryptedObjectWriteCapacity("objects", entryBytes, exact)).resolves.toBeUndefined();
  });

  it("serializes four writers on the same real volume so later writers observe reduced free space", async () => {
    const fixture = advisoryLeasePool();
    const writeBytes = 100n;
    let availableBytes = ARCHIVE_STORAGE_RESERVE_BYTES + writeBytes;
    const observedAvailable: bigint[] = [];
    let activeWriters = 0;
    let maxActiveWriters = 0;
    const reader: ArchiveCapacityReader = {
      async availableBytes() {
        observedAvailable.push(availableBytes);
        return availableBytes;
      },
      async deviceId() {
        return 9n;
      },
    };

    const results = await Promise.allSettled(Array.from({ length: 4 }, async () =>
      withArchiveVolumeLease(fixture.pool, ["objects"], async () => {
        activeWriters += 1;
        maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
        try {
          await assertEncryptedObjectWriteCapacity("objects", writeBytes, reader);
          availableBytes -= writeBytes;
        } finally {
          activeWriters -= 1;
        }
      }, reader)));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(3);
    expect(maxActiveWriters).toBe(1);
    expect(observedAvailable).toEqual([
      ARCHIVE_STORAGE_RESERVE_BYTES + writeBytes,
      ARCHIVE_STORAGE_RESERVE_BYTES,
      ARCHIVE_STORAGE_RESERVE_BYTES,
      ARCHIVE_STORAGE_RESERVE_BYTES,
    ]);
    expect(fixture.releases).toHaveLength(4);
    expect(fixture.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it("sorts and deduplicates device locks and releases them when protected work throws", async () => {
    const fixture = advisoryLeasePool();
    const devices = new Map<string, bigint>([["staging", 10n], ["objects", 2n], ["alias", 10n]]);
    const reader: ArchiveCapacityReader = {
      async availableBytes() {
        return ARCHIVE_STORAGE_RESERVE_BYTES;
      },
      async deviceId(path) {
        return devices.get(path)!;
      },
    };

    await expect(withArchiveVolumeLease(
      fixture.pool,
      ["staging", "objects", "alias"],
      async () => { throw new Error("write failed"); },
      reader,
    )).rejects.toThrow("write failed");
    await expect(withArchiveVolumeLease(
      fixture.pool,
      ["objects", "staging"],
      async () => "next writer acquired",
      reader,
    )).resolves.toBe("next writer acquired");

    expect(fixture.lockOrder.slice(0, 2)).toEqual([
      "revenue-and-costs:upload-volume:2",
      "revenue-and-costs:upload-volume:10",
    ]);
    expect(fixture.unlockOrder.slice(0, 2)).toEqual([
      "revenue-and-costs:upload-volume:10",
      "revenue-and-costs:upload-volume:2",
    ]);
    expect(fixture.releases).toHaveLength(2);
    expect(fixture.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it("atomically persists expanded bytes and child count before extraction", async () => {
    const fixture = poolWithQuery(async (sql) => {
      if (sql.includes("FROM upload_batch") && sql.includes("FOR UPDATE")) {
        return { rows: [{ status: "READY", expires_at: new Date("2099-01-01T00:00:00Z"), expanded_bytes: "10", file_count: 2 }], rowCount: 1 };
      }
      if (sql.includes("FROM upload_file") && sql.includes("FOR UPDATE")) {
        return { rows: [{ status: "ENCRYPTING", archive_reservation_state: "NONE", archive_expanded_bytes: "0", archive_file_count: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await reserveArchiveBudget(fixture.pool, { fileId: FILE_ID, batchId: BATCH_ID, expandedBytes: 100n, fileCount: 3 });

    const batchUpdate = fixture.calls.find((call) => call.sql.includes("UPDATE upload_batch"));
    const fileUpdate = fixture.calls.find((call) => call.sql.includes("archive_reservation_state='RESERVED'"));
    expect(batchUpdate?.parameters).toEqual([BATCH_ID, "110", 5]);
    expect(fileUpdate?.parameters).toEqual([FILE_ID, BATCH_ID, "100", 3]);
    expect(fixture.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("rejects the sum of multiple archives when the persistent batch budget would overflow", async () => {
    const fixture = poolWithQuery(async (sql) => {
      if (sql.includes("FROM upload_batch") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            status: "READY",
            expires_at: new Date("2099-01-01T00:00:00Z"),
            expanded_bytes: (MAX_BATCH_EXPANDED_BYTES - 1n).toString(),
            file_count: 10,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("FROM upload_file") && sql.includes("FOR UPDATE")) {
        return { rows: [{ status: "ENCRYPTING", archive_reservation_state: "NONE", archive_expanded_bytes: "0", archive_file_count: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(reserveArchiveBudget(fixture.pool, {
      fileId: FILE_ID,
      batchId: BATCH_ID,
      expandedBytes: 2n,
      fileCount: 1,
    })).rejects.toThrow("ZIP_BATCH_EXPANDED_LIMIT");
    expect(fixture.calls.some((call) => call.sql.includes("UPDATE upload_batch"))).toBe(false);
    expect(fixture.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("releases a failed reservation from both the batch and file", async () => {
    const fixture = poolWithQuery(async (sql) => {
      if (sql.includes("FROM upload_batch") && sql.includes("FOR UPDATE")) {
        return { rows: [{ expanded_bytes: "100", file_count: 5 }], rowCount: 1 };
      }
      if (sql.includes("FROM upload_file") && sql.includes("FOR UPDATE")) {
        return { rows: [{ status: "ENCRYPTING", archive_reservation_state: "RESERVED", archive_expanded_bytes: "40", archive_file_count: 2 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(releaseArchiveBudget(fixture.pool, { fileId: FILE_ID, batchId: BATCH_ID })).resolves.toBe(true);
    expect(fixture.calls.find((call) => call.sql.includes("expanded_bytes=expanded_bytes-$2"))?.parameters)
      .toEqual([BATCH_ID, "40", 2]);
    expect(fixture.calls.some((call) => call.sql.includes("archive_reservation_state='NONE'"))).toBe(true);
    expect(fixture.calls.at(-1)?.sql).toBe("COMMIT");
  });
});
