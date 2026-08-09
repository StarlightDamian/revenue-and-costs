/* global Buffer, process */
import {
  AlgorithmSuiteIdentifier,
  buildClient,
  CommitmentPolicy,
  RawAesKeyringNode,
  RawAesWrappingSuiteIdentifier,
} from '@aws-crypto/client-node';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, readFileSync } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const { encryptStream, decryptStream } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT);

class HashTap extends Transform {
  hash = createHash('sha256');
  bytes = 0n;
  _transform(chunk, _encoding, callback) {
    this.hash.update(chunk);
    this.bytes += BigInt(chunk.length);
    callback(null, chunk);
  }
}

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}

function loadKeyring() {
  const keyFile = process.env.BACKUP_ENCRYPTION_KEY_FILE;
  if (!keyFile) throw new Error('BACKUP_ENCRYPTION_KEY_FILE_MISSING');
  let key;
  try { key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64'); }
  catch { throw new Error('BACKUP_ENCRYPTION_KEY_INVALID'); }
  if (key.byteLength !== 32) throw new Error('BACKUP_ENCRYPTION_KEY_INVALID');
  const isolatedKey = Buffer.alloc(32);
  isolatedKey.set(key);
  key.fill(0);
  return new RawAesKeyringNode({
    keyNamespace: 'revenue-and-costs-backup',
    keyName: process.env.BACKUP_ENCRYPTION_KEY_ID || 'backup-local-v1',
    unencryptedMasterKey: isolatedKey,
    wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
  });
}

function contextFromEnvironment() {
  let context;
  try { context = JSON.parse(process.env.BACKUP_ENCRYPTION_CONTEXT || ''); }
  catch { throw new Error('BACKUP_ENCRYPTION_CONTEXT_INVALID'); }
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('BACKUP_ENCRYPTION_CONTEXT_INVALID');
  for (const [key, value] of Object.entries(context)) {
    if (typeof value !== 'string' || !value || key.length > 100 || value.length > 500) {
      throw new Error('BACKUP_ENCRYPTION_CONTEXT_INVALID');
    }
  }
  return context;
}

async function encrypt(input, output) {
  const inputInfo = await stat(input);
  const context = contextFromEnvironment();
  const plaintext = new HashTap();
  const ciphertext = new HashTap();
  const encryptor = encryptStream(loadKeyring(), {
    suiteId: AlgorithmSuiteIdentifier.ALG_AES256_GCM_IV12_TAG16_HKDF_SHA512_COMMIT_KEY_ECDSA_P384,
    encryptionContext: context,
    frameLength: 1024 * 1024,
    plaintextLength: inputInfo.size,
  });
  try {
    await pipeline(
      createReadStream(input),
      plaintext,
      encryptor,
      ciphertext,
      createWriteStream(output, { flags: 'wx' }),
    );
  } catch (error) {
    await unlink(output).catch(() => undefined);
    throw error;
  }
  return {
    plaintextBytes: plaintext.bytes.toString(),
    plaintextSha256: plaintext.hash.digest('hex'),
    ciphertextBytes: ciphertext.bytes.toString(),
    ciphertextSha256: ciphertext.hash.digest('hex'),
    encryptionFormat: 'AWS_ESDK_V2_FRAMED',
    encryptionContext: context,
  };
}

async function decrypt(input, output) {
  const expectedContext = contextFromEnvironment();
  const ciphertext = new HashTap();
  const plaintext = new HashTap();
  const decryptor = decryptStream(loadKeyring(), { maxBodySize: Number.MAX_SAFE_INTEGER });
  decryptor.once('MessageHeader', (header) => {
    for (const [key, expected] of Object.entries(expectedContext)) {
      if (header.encryptionContext[key] !== expected) {
        decryptor.destroy(new Error(`BACKUP_ENCRYPTION_CONTEXT_MISMATCH:${key}`));
        return;
      }
    }
  });
  try {
    await pipeline(
      createReadStream(input),
      ciphertext,
      decryptor,
      plaintext,
      createWriteStream(output, { flags: 'wx' }),
    );
  } catch (error) {
    await unlink(output).catch(() => undefined);
    throw error;
  }
  return {
    plaintextBytes: plaintext.bytes.toString(),
    plaintextSha256: plaintext.hash.digest('hex'),
    ciphertextBytes: ciphertext.bytes.toString(),
    ciphertextSha256: ciphertext.hash.digest('hex'),
  };
}

const [operation, input, output] = process.argv.slice(2);
if (!['encrypt', 'decrypt'].includes(operation) || !input || !output) {
  fail('BACKUP_CRYPTO_USAGE_INVALID');
} else {
  try {
    const result = operation === 'encrypt' ? await encrypt(input, output) : await decrypt(input, output);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    fail(error instanceof Error && /^[A-Z0-9_:]+$/.test(error.message) ? error.message : 'BACKUP_CRYPTO_FAILED');
  }
}
