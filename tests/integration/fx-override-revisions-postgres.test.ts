import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

describe("manual FX override revisions", () => {
  let database: PostgresTestSchema | undefined;
  let pool!: PostgresTestSchema["pool"];

  beforeAll(async () => {
    database = await createPostgresTestSchema();
    pool = database.pool;
  });

  afterAll(async () => database?.cleanup());

  it("keeps immutable history while exposing only the latest revision as current", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const accountId = randomUUID();
      const originalId = randomUUID();
      const revisionId = randomUUID();
      await client.query(
        `INSERT INTO account(id,phone_e164,phone_verified_at)
         VALUES($1,$2,clock_timestamp())`,
        [accountId, `+1999${Date.now().toString().slice(-8)}`],
      );
      await client.query(
        `INSERT INTO fx_override(id,currency,valid_from,valid_to,cny_per_unit,source_reference,reason,created_by)
         VALUES($1,'XTS','2099-01-01','2099-01-31','1.00000000','synthetic migration test','initial test value',$2)`,
        [originalId, accountId],
      );
      await client.query(
        `INSERT INTO fx_override(id,currency,valid_from,valid_to,cny_per_unit,source_reference,reason,created_by,supersedes_override_id)
         VALUES($1,'XTS','2099-01-01','2099-01-31','1.10000000','synthetic migration test revision','revised test value',$2,$3)`,
        [revisionId, accountId, originalId],
      );

      const rows = await client.query<{ id: string; cny_per_unit: string }>(
        `SELECT id,cny_per_unit::text FROM fx_current_override WHERE currency='XTS'`,
      );
      const history = await client.query<{ count: string }>(
        `SELECT count(*)::text count FROM fx_override WHERE id=ANY($1::uuid[])`,
        [[originalId, revisionId]],
      );
      expect(rows.rows).toEqual([{ id: revisionId, cny_per_unit: "1.10000000" }]);
      expect(history.rows[0]?.count).toBe("2");

      await expect(client.query(
        `INSERT INTO fx_override(currency,valid_from,valid_to,cny_per_unit,source_reference,reason,created_by)
         VALUES('XTS','2099-01-15','2099-02-01','1.20000000','synthetic overlap','overlap test',$1)`,
        [accountId],
      )).rejects.toMatchObject({ constraint: "fx_override_current_range_no_overlap" });
      await client.query("ROLLBACK");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });

  it("serializes an override write with the publication set lock", async () => {
    const publisher = await pool.connect();
    const writer = await pool.connect();
    const accountId = randomUUID();
    try {
      await pool.query(
        `INSERT INTO account(id,phone_e164,phone_verified_at)
         VALUES($1,$2,clock_timestamp())`,
        [accountId, `+1998${Date.now().toString().slice(-8)}`],
      );
      await publisher.query("BEGIN");
      await publisher.query("SELECT pg_advisory_xact_lock(hashtextextended('fx-override:set', 0))");
      await writer.query("BEGIN");
      await writer.query("SET LOCAL lock_timeout='100ms'");

      await expect(writer.query(
        `INSERT INTO fx_override(currency,valid_from,valid_to,cny_per_unit,source_reference,reason,created_by)
         VALUES('XTL','2099-02-01','2099-02-01','1.00000000','synthetic lock test','lock test',$1)`,
        [accountId],
      )).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      await publisher.query("ROLLBACK").catch(() => undefined);
      writer.release();
      publisher.release();
      await pool.query("DELETE FROM account WHERE id=$1", [accountId]).catch(() => undefined);
    }
  });
});
