import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

describe("release upload drain gate", () => {
  let database: PostgresTestSchema | undefined;

  beforeAll(async () => { database = await createPostgresTestSchema(); });
  afterAll(async () => { await database?.cleanup(); });

  it("ignores metadata-only PDFs but counts ordinary staging files in terminal batches", async () => {
    const script = await readFile("bin/push-remote.sh", "utf8");
    const query = script.match(/-c "(SELECT count\(\*\) FROM upload_file WHERE [^"]+)"/u)?.[1];
    expect(query, "active upload SQL must remain extractable and executable").toBeDefined();

    const metadataBatchId = randomUUID();
    const ordinaryBatchId = randomUUID();
    await database!.pool.query(
      `INSERT INTO upload_batch(id,shop_id,created_by,status,expires_at)
       VALUES($1,$2,$3,'READY',clock_timestamp()+interval '1 day'),
             ($4,$5,$6,'CANCELLED',clock_timestamp()+interval '1 day')`,
      [metadataBatchId, randomUUID(), randomUUID(), ordinaryBatchId, randomUUID(), randomUUID()],
    );
    await database!.pool.query(
      `INSERT INTO upload_file
        (batch_id,relative_path,declared_size,received_size,status,temp_path,metadata_only)
       VALUES($1,'listing.pdf',0,0,'COMPLETE','metadata-only',true),
             ($2,'complete.csv',1,1,'COMPLETE','complete.part',false),
             ($2,'encrypting.csv',1,1,'ENCRYPTING','encrypting.part',false)`,
      [metadataBatchId, ordinaryBatchId],
    );

    const fixture = await database!.pool.query<{ metadata_only: boolean; status: string }>(
      "SELECT metadata_only,status FROM upload_file ORDER BY relative_path",
    );
    expect(fixture.rows).toEqual([
      { metadata_only: false, status: "COMPLETE" },
      { metadata_only: false, status: "ENCRYPTING" },
      { metadata_only: true, status: "COMPLETE" },
    ]);

    const result = await database!.pool.query<{ count: string }>(query!);
    expect(result.rows[0]?.count).toBe("2");
  });
});
