import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

interface MigrationRow { filename: string; checksum: string }

export interface MigrationManifestEntry {
  readonly filename: string;
  readonly checksum: string;
}

interface MigrationPlanEntry extends MigrationManifestEntry {
  readonly sql: string;
}

function transactionBody(sql: string): string {
  // Historical SQL files may be independently runnable and therefore wrap
  // themselves in BEGIN/COMMIT. The runner owns one transaction and advisory
  // lock across the complete ordered set, so remove only that outer wrapper.
  return sql.replace(/^\s*BEGIN;\s*/iu, "").replace(/\s*COMMIT;\s*$/iu, "");
}

async function readMigrationPlan(directory: string): Promise<readonly MigrationPlanEntry[]> {
  const files = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  return Promise.all(files.map(async (filename) => {
    const sql = await readFile(join(directory, filename), "utf8");
    return { filename, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  }));
}

export async function readMigrationManifest(
  directory = join(process.cwd(), "migrations"),
): Promise<readonly MigrationManifestEntry[]> {
  return (await readMigrationPlan(directory)).map(({ filename, checksum }) => ({ filename, checksum }));
}

export async function migrate(pool: Pool, directory = join(process.cwd(), "migrations")): Promise<string[]> {
  const plan = await readMigrationPlan(directory);
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('revenue-and-costs:migrate'))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
    await client.query("BEGIN");
    const existing = await client.query<MigrationRow>("SELECT filename, checksum FROM schema_migration");
    const checksums = new Map(existing.rows.map((row) => [row.filename, row.checksum]));
    for (const { filename, sql, checksum } of plan) {
      const prior = checksums.get(filename);
      if (prior && prior !== checksum) throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${filename}`);
      if (prior) continue;
      await client.query(transactionBody(sql));
      await client.query("INSERT INTO schema_migration (filename, checksum) VALUES ($1, $2)", [filename, checksum]);
      applied.push(filename);
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('revenue-and-costs:migrate'))").catch(() => undefined);
    client.release();
  }
}
