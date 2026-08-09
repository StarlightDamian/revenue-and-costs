import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pool } from "pg";

interface MigrationRow { filename: string; checksum: string }

function transactionBody(sql: string): string {
  // Historical SQL files may be independently runnable and therefore wrap
  // themselves in BEGIN/COMMIT. The runner owns one transaction and advisory
  // lock across the complete ordered set, so remove only that outer wrapper.
  return sql.replace(/^\s*BEGIN;\s*/iu, "").replace(/\s*COMMIT;\s*$/iu, "");
}

export async function migrate(pool: Pool, directory = join(process.cwd(), "migrations")): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
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
    for (const filename of files) {
      const sql = await readFile(join(directory, filename), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
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
