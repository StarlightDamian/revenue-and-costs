import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { replicateStoredObject } from '../../src/modules/operations/replication.js';

const sourceDatabaseUrl = process.env.OPERATIONS_TEST_SOURCE_DATABASE_URL;
const restoreDatabaseUrl = process.env.OPERATIONS_TEST_RESTORE_DATABASE_URL;
const pgBin = process.env.OPERATIONS_TEST_PG_BIN ?? 'D:\\Program Files\\PostgreSQL\\17\\bin';
const enabled = Boolean(sourceDatabaseUrl && restoreDatabaseUrl);

describe.skipIf(!enabled)('authenticated encrypted backup and isolated restore', () => {
  const source = new Pool({ connectionString: sourceDatabaseUrl });
  const restore = new Pool({ connectionString: restoreDatabaseUrl });
  let root = '';

  beforeAll(async () => {
    await migrate(source);
    root = await mkdtemp(join(tmpdir(), 'revenue-recovery-'));
  });

  afterAll(async () => {
    await Promise.all([source.end(), restore.end()]);
    if (root) {
      const clearReadonly = async (directory: string): Promise<void> => {
        await chmod(directory, 0o700).catch(() => undefined);
        for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) await clearReadonly(path);
          else await chmod(path, 0o600).catch(() => undefined);
        }
      };
      await clearReadonly(root);
      if (root) {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  function runScript(script: string, args: string[], environment: NodeJS.ProcessEnv) {
    return spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', resolve(script), ...args],
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ...environment }, timeout: 120_000 },
    );
  }

  function outputJson<Result extends object>(output: string): Result {
    const line = output.split(/\r?\n/u).reverse().find((candidate) => candidate.trim().startsWith('{'));
    if (!line) throw new Error(`script did not return JSON: ${output}`);
    return JSON.parse(line) as Result;
  }

  it('authenticates the manifest, encrypts the dump, records failures, and verifies restored invariants', async () => {
    const backupRoot = join(root, 'backup');
    const controlledTemp = join(root, 'controlled-temp');
    const manifestKey = join(root, 'manifest.key');
    const encryptionKey = join(root, 'encryption.key');
    await writeFile(manifestKey, randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600 });
    await writeFile(encryptionKey, randomBytes(32).toString('base64'), { encoding: 'utf8', mode: 0o600 });

    const objectId = randomUUID();
    const objectSource = join(root, 'object-source.esdk');
    const objectReplica = join(root, 'local-replica', 'object.esdk');
    const objectBytes = Buffer.from('authenticated-encrypted-object-fixture');
    const objectSha256 = createHash('sha256').update(objectBytes).digest('hex');
    await writeFile(objectSource, objectBytes);
    await source.query(
      `INSERT INTO stored_object
        (id,object_kind,immutable_key,storage_path,plaintext_size,plaintext_sha256,ciphertext_sha256,
         encryption_format,encryption_context,verification_status)
       VALUES ($1,'SOURCE',$2,$3,$4,$5,$5,'AWS_ESDK_V2_FRAMED',$6::jsonb,'LOCAL_VERIFIED')`,
      [objectId, `test/${objectId}`, objectSource, objectBytes.byteLength.toString(), objectSha256, JSON.stringify({ test: 'operations' })],
    );
    await replicateStoredObject(source, {
      objectId,
      replicaName: 'local-protocol-test',
      destination: objectReplica,
      targetKind: 'LOCAL_VALIDATION',
      targetReference: join(root, 'local-replica'),
    });
    const localReplicaState = await source.query<{ verification_status: string; replica_kind: string; status: string }>(
      `SELECT so.verification_status, replica.replica_kind, replica.status
         FROM stored_object so JOIN stored_object_replica replica ON replica.object_id=so.id
        WHERE so.id=$1`,
      [objectId],
    );
    expect(localReplicaState.rows[0]).toEqual({
      verification_status: 'LOCAL_VERIFIED',
      replica_kind: 'LOCAL_VALIDATION',
      status: 'VERIFIED',
    });

    const backedUp = runScript(
      'scripts/backup.ps1',
      [
        '-OutputDirectory', backupRoot,
        '-TargetName', 'local-protocol-test',
        '-ManifestHmacKeyFile', manifestKey,
        '-BackupEncryptionKeyFile', encryptionKey,
        '-TemporaryDirectory', controlledTemp,
        '-PgBin', pgBin,
      ],
      { DATABASE_URL: sourceDatabaseUrl },
    );
    expect(backedUp.status, backedUp.stderr || backedUp.stdout).toBe(0);
    const backup = outputJson<{
      status: string;
      targetKind: string;
      backup: string;
      manifest: string;
      signature: string;
      businessKey: string;
    }>(backedUp.stdout);
    expect(backup.targetKind).toBe('LOCAL_VALIDATION');
    const encryptedPrefix = Buffer.alloc(5);
    const encryptedBackup = await open(backup.backup, 'r');
    try { await encryptedBackup.read(encryptedPrefix, 0, encryptedPrefix.length, 0); }
    finally { await encryptedBackup.close(); }
    expect(encryptedPrefix.equals(Buffer.from('PGDMP'))).toBe(false);
    expect((await readdir(backupRoot)).some((name) => name.endsWith('.dump'))).toBe(false);
    const run = await source.query<{
      status: string;
      target_kind: string;
      encryption_format: string;
      manifest_hmac_sha256: string;
    }>(
      `SELECT status, target_kind, details->>'encryptionFormat' AS encryption_format, manifest_hmac_sha256
         FROM backup_run WHERE business_key = $1`,
      [backup.businessKey],
    );
    expect(run.rows[0]).toMatchObject({
      status: 'SUCCEEDED',
      target_kind: 'LOCAL_VALIDATION',
      encryption_format: 'AWS_ESDK_V2_FRAMED',
    });
    expect(run.rows[0]?.manifest_hmac_sha256).toMatch(/^[0-9a-f]{64}$/u);

    const tamperedManifest = join(root, 'tampered.manifest.json');
    await writeFile(tamperedManifest, Buffer.concat([await readFile(backup.manifest), Buffer.from(' ')]));
    const rejected = runScript(
      'scripts/restore-check.ps1',
      [
        '-DumpPath', backup.backup,
        '-ManifestPath', tamperedManifest,
        '-SignaturePath', backup.signature,
        '-ManifestHmacKeyFile', manifestKey,
        '-BackupEncryptionKeyFile', encryptionKey,
        '-TemporaryDirectory', controlledTemp,
        '-PgBin', pgBin,
      ],
      { DATABASE_URL: sourceDatabaseUrl, RESTORE_DATABASE_URL: restoreDatabaseUrl },
    );
    expect(rejected.status).not.toBe(0);
    expect(`${rejected.stdout}\n${rejected.stderr}`).toContain('MANIFEST_AUTH_FAILED');
    const untouched = await restore.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')`,
    );
    expect(untouched.rows[0]?.count).toBe('0');

    const restored = runScript(
      'scripts/restore-check.ps1',
      [
        '-DumpPath', backup.backup,
        '-ManifestPath', backup.manifest,
        '-SignaturePath', backup.signature,
        '-ManifestHmacKeyFile', manifestKey,
        '-BackupEncryptionKeyFile', encryptionKey,
        '-TemporaryDirectory', controlledTemp,
        '-PgBin', pgBin,
      ],
      { DATABASE_URL: sourceDatabaseUrl, RESTORE_DATABASE_URL: restoreDatabaseUrl },
    );
    expect(restored.status, restored.stderr || restored.stdout).toBe(0);
    const recovery = outputJson<{ status: string; targetKind: string }>(restored.stdout);
    expect(recovery).toMatchObject({ status: 'ok', targetKind: 'LOCAL_VALIDATION' });
    const checkpoints = await source.query<{ status: string; target_kind: string; error_code: string | null }>(
      `SELECT status, target_kind, error_code FROM recovery_checkpoint
        WHERE checkpoint_kind = 'FULL_RESTORE_TEST' ORDER BY created_at`,
    );
    expect(checkpoints.rows).toEqual([
      expect.objectContaining({ status: 'FAILED', error_code: 'MANIFEST_AUTH_FAILED' }),
      expect.objectContaining({ status: 'VERIFIED', target_kind: 'LOCAL_VALIDATION', error_code: null }),
    ]);
    const restoredMigrationCount = await restore.query<{ count: string }>('SELECT count(*)::text AS count FROM schema_migration');
    expect(Number(restoredMigrationCount.rows[0]?.count ?? '0')).toBeGreaterThanOrEqual(21);
  }, 360_000);
});
