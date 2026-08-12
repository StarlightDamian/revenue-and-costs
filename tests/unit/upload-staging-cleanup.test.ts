import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupUploadStagingArtifacts, removeUploadStagingArtifacts } from "../../src/modules/uploads/staging-cleanup.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("upload staging cleanup", () => {
  it("idempotently removes only the trusted parent part and its own archive staging tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-staging-cleanup-"));
    temporaryRoots.push(root);
    const fileId = "00000000-0000-4000-8000-000000000001";
    const siblingId = "00000000-0000-4000-8000-000000000002";
    const tempPath = join(root, `${fileId}.part`);
    const archiveRoot = join(root, "archive", fileId);
    const siblingRoot = join(root, "archive", siblingId);
    const chunkRoot = join(root, "chunks", fileId);
    const siblingChunkRoot = join(root, "chunks", siblingId);
    await mkdir(archiveRoot, { recursive: true });
    await mkdir(siblingRoot, { recursive: true });
    await mkdir(chunkRoot, { recursive: true });
    await mkdir(siblingChunkRoot, { recursive: true });
    await writeFile(tempPath, "parent plaintext", "utf8");
    await writeFile(join(archiveRoot, "child.part"), "child plaintext", "utf8");
    await writeFile(join(siblingRoot, "keep.part"), "unrelated plaintext", "utf8");
    await writeFile(join(chunkRoot, "staged.part"), "staged plaintext", "utf8");
    await writeFile(join(siblingChunkRoot, "keep.part"), "unrelated plaintext", "utf8");

    await removeUploadStagingArtifacts({ fileId, tempPath });
    await removeUploadStagingArtifacts({ fileId, tempPath });

    await expect(access(tempPath)).rejects.toThrow();
    await expect(access(archiveRoot)).rejects.toThrow();
    await expect(access(chunkRoot)).rejects.toThrow();
    await expect(access(join(siblingRoot, "keep.part"))).resolves.toBeUndefined();
    await expect(access(join(siblingChunkRoot, "keep.part"))).resolves.toBeUndefined();
  });

  it("reports non-missing filesystem failures instead of claiming cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-staging-cleanup-error-"));
    temporaryRoots.push(root);
    const fileId = "00000000-0000-4000-8000-000000000001";
    const tempPath = join(root, `${fileId}.part`);
    await mkdir(tempPath);

    await expect(removeUploadStagingArtifacts({ fileId, tempPath })).rejects.toMatchObject({
      code: expect.stringMatching(/^(?:EISDIR|EPERM)$/u),
    });
  });

  it("replays after a crash between physical deletion and the durable cleaned marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "upload-staging-cleanup-replay-"));
    temporaryRoots.push(root);
    const fileId = "00000000-0000-4000-8000-000000000001";
    const tempPath = join(root, `${fileId}.part`);
    const archiveRoot = join(root, "archive", fileId);
    await mkdir(archiveRoot, { recursive: true });
    await writeFile(tempPath, "parent plaintext", "utf8");
    await writeFile(join(archiveRoot, "child.part"), "child plaintext", "utf8");
    let attempts = 0;
    const pool = {
      async query() {
        attempts += 1;
        if (attempts === 1) throw new Error("DATABASE_CONNECTION_LOST");
        return { rows: [{ cleaned: true }], rowCount: 1 };
      },
    } as unknown as Pool;

    await expect(cleanupUploadStagingArtifacts(pool, { fileId, tempPath }))
      .rejects.toThrow("DATABASE_CONNECTION_LOST");
    await expect(access(tempPath)).rejects.toThrow();
    await expect(access(archiveRoot)).rejects.toThrow();

    await expect(cleanupUploadStagingArtifacts(pool, { fileId, tempPath })).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
