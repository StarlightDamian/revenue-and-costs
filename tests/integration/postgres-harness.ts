import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { Pool } from "pg";
import { migrate as runMigrations } from "../../src/db/migrate.js";

const TEST_SCHEMA_PREFIX = "rc_test_";

function readLocalTestDatabaseUrl(): string | undefined {
  const configured = process.env.TEST_DATABASE_URL?.trim();
  if (configured) return configured;

  const path = resolve(".env.local");
  if (!existsSync(path)) return undefined;
  return parseEnv(readFileSync(path, "utf8")).TEST_DATABASE_URL?.trim() || undefined;
}

function validateTestDatabaseUrl(value: string | undefined, variableName: string): string {
  if (!value) throw new Error(`${variableName}_REQUIRED`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName}_INVALID`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${variableName}_INVALID`);
  }
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  if (!databaseName || !/test/iu.test(databaseName) || databaseName === "revenue_and_costs") {
    throw new Error(`${variableName}_UNSAFE_DATABASE`);
  }
  return value;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]+$/u.test(identifier)) throw new Error("UNSAFE_TEST_SCHEMA_NAME");
  return `"${identifier}"`;
}

function scopedConnectionString(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-c search_path=${schema},public`);
  return url.toString();
}

export function requireDedicatedTestDatabaseUrl(variableName: string): string {
  return validateTestDatabaseUrl(process.env[variableName]?.trim(), variableName);
}

export interface PostgresTestSchema {
  readonly schema: string;
  readonly connectionString: string;
  readonly pool: Pool;
  createPool(): Pool;
  cleanup(): Promise<void>;
}

export async function createPostgresTestSchema(
  options: { readonly migrate?: boolean } = {},
): Promise<PostgresTestSchema> {
  const baseConnectionString = validateTestDatabaseUrl(readLocalTestDatabaseUrl(), "TEST_DATABASE_URL");
  const schema = `${TEST_SCHEMA_PREFIX}${process.pid}_${randomBytes(8).toString("hex")}`;
  const quotedSchema = quoteIdentifier(schema);
  const connectionString = scopedConnectionString(baseConnectionString, schema);
  const control = new Pool({ connectionString: baseConnectionString, max: 1 });
  const pools = new Set<Pool>();
  let cleaned = false;

  const createPool = (): Pool => {
    if (cleaned) throw new Error("POSTGRES_TEST_SCHEMA_ALREADY_CLEANED");
    const pool = new Pool({ connectionString });
    pools.add(pool);
    return pool;
  };

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    const failures: unknown[] = [];
    const endings = await Promise.allSettled([...pools].map((pool) => pool.end()));
    failures.push(...endings.filter((result) => result.status === "rejected").map((result) => result.reason));
    try {
      await control.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
      const remaining = await control.query<{ exists: boolean }>(
        "SELECT to_regnamespace($1) IS NOT NULL AS exists",
        [schema],
      );
      if (remaining.rows[0]?.exists) failures.push(new Error("POSTGRES_TEST_SCHEMA_CLEANUP_FAILED"));
    } catch (error) {
      failures.push(error);
    }
    try {
      await control.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, "POSTGRES_TEST_SCHEMA_CLEANUP_FAILED");
  };

  try {
    await control.query(`CREATE SCHEMA ${quotedSchema}`);
    const pool = createPool();
    const selected = await pool.query<{ schema: string }>("SELECT current_schema() AS schema");
    if (selected.rows[0]?.schema !== schema) throw new Error("POSTGRES_TEST_SCHEMA_NOT_SELECTED");
    if (options.migrate !== false) await runMigrations(pool);
    return { schema, connectionString, pool, createPool, cleanup };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "POSTGRES_TEST_SCHEMA_SETUP_FAILED");
    }
    throw error;
  }
}
