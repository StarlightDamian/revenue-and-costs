import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { withJobExecutionLock } from "../../src/worker/job-execution-lock.js";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

describe("worker connection budget runtime", () => {
  let testSchema: PostgresTestSchema | undefined;

  afterEach(async () => {
    await testSchema?.cleanup();
    testSchema = undefined;
  });

  it("reuses the job lock for its transaction and leaves one maintenance connection", async () => {
    testSchema = await createPostgresTestSchema({ migrate: false });
    const pool = new pg.Pool({
      connectionString: testSchema.connectionString,
      max: 3,
      connectionTimeoutMillis: 1_000,
    });
    try {
      const results = await Promise.all([
        withJobExecutionLock(pool, "calculation.run", "first", async (transaction) => {
          try {
            await transaction.query("BEGIN");
            const reader = await pool.connect();
            try {
              const [result, maintenance] = await Promise.all([
                reader.query<{ value: number }>("SELECT 1::integer AS value FROM pg_sleep(0.1)"),
                pool.query<{ value: number }>("SELECT 3::integer AS value"),
              ]);
              expect(maintenance.rows[0]?.value).toBe(3);
              await transaction.query("COMMIT");
              return result.rows[0]?.value;
            } finally {
              reader.release();
            }
          } catch (error) {
            await transaction.query("ROLLBACK");
            throw error;
          }
        }),
        withJobExecutionLock(pool, "calculation.run", "second", async () => {
          const result = await pool.query<{ value: number }>("SELECT 2::integer AS value");
          return result.rows[0]?.value;
        }),
      ]);

      expect(results).toEqual([1, 2]);
      expect(pool.totalCount).toBeLessThanOrEqual(3);
    } finally {
      await pool.end();
    }
  });
});
