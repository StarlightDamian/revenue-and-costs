import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { replicateAndVerify, storedObjectReplicaPath } from "../../src/modules/operations/replication";

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

  it("accepts an already copied replica after a worker restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "revenue-replica-")); roots.push(root);
    const source = join(root, "source"); const target = join(root, "replica", "object");
    const data = Buffer.from("encrypted-object"); await writeFile(source, data);
    const hash = createHash("sha256").update(data).digest("hex");
    await replicateAndVerify(source, target, hash);
    await unlink(source);

    await expect(replicateAndVerify(source, target, hash)).resolves.toMatchObject({ sha256: hash });
  });

  it("rejects an existing destination with the wrong ciphertext hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "revenue-replica-")); roots.push(root);
    const source = join(root, "source"); const target = join(root, "replica", "object");
    await writeFile(source, "expected");
    await mkdir(join(root, "replica"));
    await writeFile(target, "unexpected");
    const hash = createHash("sha256").update("expected").digest("hex");

    await expect(replicateAndVerify(source, target, hash)).rejects.toThrow("REPLICA_DESTINATION_CONFLICT");
  });

  it("derives replica paths only from canonical stored-object identifiers", () => {
    const objectId = "11111111-1111-4111-8111-111111111111";
    const replicaRoot = join(tmpdir(), "offsite");
    expect(storedObjectReplicaPath(replicaRoot, objectId)).toBe(
      join(replicaRoot, "11", `${objectId}.esdk`),
    );
    expect(() => storedObjectReplicaPath(replicaRoot, "../escape")).toThrow("INVALID_OBJECT_ID");
  });
});
