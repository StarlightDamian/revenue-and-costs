import {
  AlgorithmSuiteIdentifier,
  buildClient,
  CommitmentPolicy,
  RawAesKeyringNode,
  RawAesWrappingSuiteIdentifier,
} from "@aws-crypto/client-node";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Transform, type Readable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";

const { encryptStream, decryptStream } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT);

class HashTap extends Transform {
  readonly hash = createHash("sha256");
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.hash.update(chunk);
    callback(null, chunk);
  }
}

export interface StoredObjectMetadata {
  objectId: string;
  plaintextSize: bigint;
  plaintextSha256: string;
  ciphertextSha256: string;
  path: string;
  encryptionContext: Record<string, string>;
}

interface DecryptionMessageHeader { encryptionContext: Readonly<Record<string, string>> }

function assertWithin(root: string, candidate: string): string {
  const absoluteRoot = resolve(root);
  const absolute = resolve(candidate);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) throw new Error("STORAGE_PATH_ESCAPE");
  return absolute;
}

export class EncryptedObjectStore {
  private readonly keyring: RawAesKeyringNode;
  private readonly root: string;
  private readonly keyName: string;

  constructor(root: string, rawKey: Uint8Array, keyName = "local-v1") {
    if (rawKey.byteLength !== 32) throw new Error("FILE_KEK_MUST_BE_32_BYTES");
    this.root = resolve(root);
    this.keyName = keyName;
    // Buffer.from(base64) may be backed by Node's shared slab. The AWS raw
    // keyring rejects shared backing stores so key material cannot alias other
    // allocations; always copy into an isolated allocation here.
    const isolatedKey = Buffer.alloc(rawKey.byteLength);
    isolatedKey.set(rawKey);
    this.keyring = new RawAesKeyringNode({
      keyNamespace: "revenue-and-costs",
      keyName,
      unencryptedMasterKey: isolatedKey,
      wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
    });
  }

  objectPath(objectId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(objectId)) throw new Error("INVALID_OBJECT_ID");
    return assertWithin(this.root, join(this.root, objectId.slice(0, 2), `${objectId}.esdk`));
  }

  async removeUncommitted(objectId: string): Promise<void> {
    const target = this.objectPath(objectId);
    for (const candidate of [target, `${target}.partial`]) {
      await unlink(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async putFile(sourcePath: string, objectId: string, context: Record<string, string>): Promise<StoredObjectMetadata> {
    const target = this.objectPath(objectId);
    const partial = `${target}.partial`;
    await mkdir(dirname(target), { recursive: true });
    const sourceInfo = await stat(sourcePath);
    const plainTap = new HashTap();
    const cipherTap = new HashTap();
    const encrypt = encryptStream(this.keyring, {
      suiteId: AlgorithmSuiteIdentifier.ALG_AES256_GCM_IV12_TAG16_HKDF_SHA512_COMMIT_KEY_ECDSA_P384,
      encryptionContext: { ...context, objectId, plaintextSize: String(sourceInfo.size), format: "AWS_ESDK_V2_FRAMED", keyProvider: "AWS_ESDK_RAW_AES", keyId: this.keyName },
      frameLength: 1024 * 1024,
      plaintextLength: sourceInfo.size,
    });
    try {
      await pipeline(createReadStream(sourcePath), plainTap, encrypt, cipherTap, createWriteStream(partial, { flags: "wx" }));
      await rename(partial, target);
    } catch (error) {
      await unlink(partial).catch(() => undefined);
      throw error;
    }
    return {
      objectId,
      plaintextSize: BigInt(sourceInfo.size),
      plaintextSha256: plainTap.hash.digest("hex"),
      ciphertextSha256: cipherTap.hash.digest("hex"),
      path: target,
      encryptionContext: { ...context, objectId, plaintextSize: String(sourceInfo.size), format: "AWS_ESDK_V2_FRAMED", keyProvider: "AWS_ESDK_RAW_AES", keyId: this.keyName },
    };
  }

  private decryptor(expectedContext?: Readonly<Record<string, string>>): ReturnType<typeof decryptStream> {
    const decrypt = decryptStream(this.keyring, { maxBodySize: Number.MAX_SAFE_INTEGER });
    if (expectedContext) {
      decrypt.once("MessageHeader", (header: DecryptionMessageHeader) => {
        for (const [key, expected] of Object.entries(expectedContext)) {
          if (header.encryptionContext[key] !== expected) {
            decrypt.destroy(new Error(`ENCRYPTION_CONTEXT_MISMATCH:${key}`));
            return;
          }
        }
      });
    }
    return decrypt;
  }

  async decryptToFile(objectPath: string, destinationPath: string, expectedContext?: Readonly<Record<string, string>>): Promise<void> {
    const decrypt = this.decryptor(expectedContext);
    await mkdir(dirname(destinationPath), { recursive: true });
    try {
      await pipeline(createReadStream(objectPath), decrypt, createWriteStream(destinationPath, { flags: "wx" }));
    } catch (error) {
      await unlink(destinationPath).catch(() => undefined);
      throw error;
    }
  }

  createDecryptionStream(objectPath: string, expectedContext?: Readonly<Record<string, string>>): Readable {
    const decrypt = this.decryptor(expectedContext);
    return createReadStream(objectPath).pipe(decrypt);
  }
}
