import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { EncryptedObjectStore } from "../../src/modules/storage/encrypted-object-store";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("AWS Encryption SDK object storage", () => {
  it("round trips through a framed committing message", async () => {
    const root = await mkdtemp(join(tmpdir(), "revenue-storage-")); roots.push(root);
    const source = join(root, "source.txt");
    const output = join(root, "output.txt");
    await writeFile(source, "财务源文件\n");
    const store = new EncryptedObjectStore(join(root, "objects"), randomBytes(32));
    const meta = await store.putFile(source, randomUUID(), { shopId: randomUUID(), kind: "SOURCE" });
    await store.decryptToFile(meta.path, output);
    expect(await readFile(output, "utf8")).toBe("财务源文件\n");
    expect(meta.plaintextSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects ciphertext modified after encryption", async () => {
    const root = await mkdtemp(join(tmpdir(), "revenue-storage-")); roots.push(root);
    const source = join(root, "source.txt");
    await writeFile(source, "sensitive");
    const store = new EncryptedObjectStore(join(root, "objects"), randomBytes(32));
    const meta = await store.putFile(source, randomUUID(), { kind: "SOURCE" });
    const ciphertext = await readFile(meta.path);
    const tamperOffset = Math.floor(ciphertext.length / 2);
    ciphertext[tamperOffset] = (ciphertext[tamperOffset] ?? 0) ^ 1;
    await writeFile(meta.path, ciphertext);
    await expect(store.decryptToFile(meta.path, join(root, "tampered.txt"))).rejects.toThrow();
  });

  it("rejects truncation, frame reordering, and the wrong key", async () => {
    const root = await mkdtemp(join(tmpdir(), "revenue-storage-")); roots.push(root);
    const source = join(root, "source.bin");
    await writeFile(source, Buffer.alloc(3 * 1024 * 1024 + 137, 0x5a));
    const key = randomBytes(32);
    const store = new EncryptedObjectStore(join(root, "objects"), key);
    const meta = await store.putFile(source, randomUUID(), { kind: "SOURCE" });
    const original = await readFile(meta.path);

    await writeFile(meta.path, original.subarray(0, original.byteLength - 37));
    await expect(store.decryptToFile(meta.path, join(root, "truncated.bin"))).rejects.toThrow();

    const reordered = Buffer.from(original);
    const frame = 1024 * 1024;
    const first = Buffer.from(reordered.subarray(frame, frame * 2));
    const second = Buffer.from(reordered.subarray(frame * 2, frame * 3));
    second.copy(reordered, frame);
    first.copy(reordered, frame * 2);
    await writeFile(meta.path, reordered);
    await expect(store.decryptToFile(meta.path, join(root, "reordered.bin"))).rejects.toThrow();

    await writeFile(meta.path, original);
    const wrongStore = new EncryptedObjectStore(join(root, "objects"), randomBytes(32));
    await expect(wrongStore.decryptToFile(meta.path, join(root, "wrong-key.bin"))).rejects.toThrow();

    await expect(store.decryptToFile(meta.path, join(root, "wrong-context.bin"), { kind: "EXPORT" })).rejects.toThrow("ENCRYPTION_CONTEXT_MISMATCH");
  });

  it("cleans both final and partial files before an idempotent retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "revenue-storage-")); roots.push(root);
    const store = new EncryptedObjectStore(join(root, "objects"), randomBytes(32));
    const id = randomUUID();
    const path = store.objectPath(id);
    await mkdir(join(path, ".."), { recursive: true });
    await Promise.all([writeFile(path, "final"), writeFile(`${path}.partial`, "partial")]);
    await store.removeUncommitted(id);
    await expect(readFile(path)).rejects.toThrow();
    await expect(readFile(`${path}.partial`)).rejects.toThrow();
  });
});
