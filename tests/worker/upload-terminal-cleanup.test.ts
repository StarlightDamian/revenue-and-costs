import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PgBoss } from "pg-boss";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeUploadFile } from "../../src/modules/uploads/finalize.js";
import { recordUploadFileFailure } from "../../src/modules/uploads/partial-failure.js";
import { registerHandlers } from "../../src/worker/register-handlers.js";

vi.mock("../../src/modules/uploads/finalize.js", () => ({
  finalizeUploadFile: vi.fn(),
}));

vi.mock("../../src/modules/uploads/partial-failure.js", () => ({
  recordUploadFileFailure: vi.fn(),
}));

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("upload finalize terminal cleanup", () => {
  it("removes ZIP staging after a definite rollback exhausts retries", async () => {
    const fileId = "00000000-0000-4000-8000-000000000001";
    const jobId = "11111111-1111-4111-8111-111111111111";
    const root = await mkdtemp(join(tmpdir(), "upload-finalize-terminal-"));
    temporaryRoots.push(root);
    const tempPath = join(root, `${fileId}.part`);
    const archiveRoot = join(root, "archive", fileId);
    await mkdir(archiveRoot, { recursive: true });
    await writeFile(tempPath, "parent plaintext", "utf8");
    await writeFile(join(archiveRoot, "child.part"), "child plaintext", "utf8");

    vi.mocked(finalizeUploadFile).mockRejectedValue(new Error("ECONNRESET"));
    vi.mocked(recordUploadFileFailure).mockResolvedValue({
      batchId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      importBatchId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      tempPath,
    });

    type UploadJob = {
      readonly id: string;
      readonly data: { readonly fileId: string };
      readonly retryCount: number;
      readonly retryLimit: number;
    };
    const callbacks = new Map<string, (jobs: readonly UploadJob[]) => Promise<unknown>>();
    const boss = {
      createQueue: vi.fn(async () => undefined),
      updateQueue: vi.fn(async () => undefined),
      work: vi.fn(async (name: string, _options: unknown, callback: unknown) => {
        callbacks.set(name, callback as (jobs: readonly UploadJob[]) => Promise<unknown>);
      }),
    } as unknown as PgBoss;
    const lockQuery = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }], rowCount: 1 };
      throw new Error(`UNEXPECTED_LOCK_QUERY:${sql}`);
    });
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM pgboss.job")) return { rows: [{ id: jobId }], rowCount: 1 };
      if (sql.includes("UPDATE upload_file SET temp_path=''")) {
        return { rows: [{ cleaned: true }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_POOL_QUERY:${sql}`);
    });
    const removeUncommitted = vi.fn(async () => undefined);

    await registerHandlers(boss, {
      pool: {
        query,
        connect: vi.fn(async () => ({ query: lockQuery, release })),
      } as never,
      objectStore: { removeUncommitted } as never,
      exports: {} as never,
    });

    await expect(callbacks.get("upload.finalize")?.([{
      id: jobId,
      data: { fileId },
      retryCount: 5,
      retryLimit: 5,
    }])).resolves.toEqual([{
      id: jobId,
      status: "deadletter",
      output: { errorCode: "UPLOAD_FINALIZE_FAILED" },
    }]);

    expect(recordUploadFileFailure).toHaveBeenCalledWith(expect.anything(), {
      fileId,
      errorCode: "UPLOAD_FINALIZE_FAILED",
      allowedStatuses: ["COMPLETE", "ENCRYPTING"],
    });
    expect(removeUncommitted).toHaveBeenCalledWith(fileId);
    await expect(access(tempPath)).rejects.toThrow();
    await expect(access(archiveRoot)).rejects.toThrow();
  });
});
