import { mkdtemp, rm } from "node:fs/promises";
import type { PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

const unlinkState = vi.hoisted(() => ({ active: 0, peak: 0, tracking: false }));

interface FsPromisesModule {
  readonly [name: string]: unknown;
  unlink(path: PathLike): Promise<void>;
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<FsPromisesModule>();
  return {
    ...original,
    async unlink(path: PathLike) {
      if (!unlinkState.tracking) return original.unlink(path);
      unlinkState.active += 1;
      unlinkState.peak = Math.max(unlinkState.peak, unlinkState.active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 2));
        return await original.unlink(path);
      } finally {
        unlinkState.active -= 1;
      }
    },
  };
});

import { UploadService } from "../../src/modules/uploads/service.js";

const roots: string[] = [];

afterEach(async () => {
  unlinkState.active = 0;
  unlinkState.peak = 0;
  unlinkState.tracking = false;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("upload temporary path cleanup", () => {
  it("removes rollback artifacts with at most sixteen concurrent filesystem operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-temp-cleanup-concurrency-"));
    roots.push(root);
    const client = {
      async query(sql: string) {
        if (sql.includes("FROM import_batch WHERE shop_id")) return { rows: [], rowCount: 0 };
        if (sql.includes("SELECT declared_bytes, file_count FROM upload_batch")) {
          return { rows: [{ declared_bytes: "0", file_count: 0 }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO upload_file")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;
    const service = new UploadService(pool, root);
    unlinkState.tracking = true;

    await expect(service.createBatchWithFiles(
      "shop-id",
      "account-id",
      "registration-key",
      Array.from({ length: 40 }, (_, index) => ({
        relativePath: `part-${index}.csv`,
        declaredSize: 1n,
      })),
    )).rejects.toThrow("UPLOAD_FILE_CREATE_FAILED");

    expect(unlinkState.peak).toBeGreaterThan(0);
    expect(unlinkState.peak).toBeLessThanOrEqual(16);
  });
});
