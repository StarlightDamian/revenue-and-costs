import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { replicateAndVerify } from "../../src/modules/operations/replication";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("object replica verification", () => {
  it("copies as a stream and verifies before rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "revenue-replica-")); roots.push(root);
    const source = join(root, "source"); const target = join(root, "replica", "object");
    const data = Buffer.from("encrypted-object"); await writeFile(source, data);
    const hash = createHash("sha256").update(data).digest("hex");
    const result = await replicateAndVerify(source, target, hash);
    expect(result.sha256).toBe(hash); expect(await readFile(target)).toEqual(data);
  });

  it("does not expose a corrupt replica", async () => {
    const root = await mkdtemp(join(tmpdir(), "revenue-replica-")); roots.push(root);
    const source = join(root, "source"); const target = join(root, "replica", "object");
    await writeFile(source, "bad");
    await expect(replicateAndVerify(source, target, "0".repeat(64))).rejects.toThrow("REPLICA_HASH_MISMATCH");
    await expect(readFile(target)).rejects.toThrow();
  });
});
