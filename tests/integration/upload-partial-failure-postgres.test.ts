import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordUploadFileFailure } from "../../src/modules/uploads/partial-failure.js";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

describe("upload partial failure PostgreSQL projection", () => {
  let database: PostgresTestSchema | undefined;
  let pool!: PostgresTestSchema["pool"];

  beforeAll(async () => {
    database = await createPostgresTestSchema();
    pool = database.pool;
  });
  afterAll(async () => { await database?.cleanup(); });

  async function createBatch(fileStatuses: readonly ("ENCRYPTING" | "STORED")[]) {
    const accountId = randomUUID();
    const enterpriseId = randomUUID();
    const mappingId = randomUUID();
    const mappingVersionId = randomUUID();
    const shopId = randomUUID();
    const batchId = randomUUID();
    const importBatchId = randomUUID();
    const phoneDigits = randomUUID().replaceAll(/[^0-9]/gu, "").padEnd(8, "0").slice(0, 8);
    await pool.query(
      "INSERT INTO account(id,phone_e164,phone_verified_at) VALUES($1,$2,clock_timestamp())",
      [accountId, `+86139${phoneDigits}`],
    );
    await pool.query(
      `INSERT INTO enterprise(id,name,normalized_name,created_by_account_id)
       VALUES($1,$2,$2,$3)`,
      [enterpriseId, `upload-partial-${enterpriseId}`, accountId],
    );
    await pool.query(
      `INSERT INTO field_mapping(id,report_kind,locale,name) VALUES($1,'TRANSACTION','test',$2)`,
      [mappingId, `upload-partial-${mappingId}`],
    );
    await pool.query(
      `INSERT INTO field_mapping_version
        (id,field_mapping_id,version_no,definition,definition_sha256,created_by,reason)
       VALUES($1,$2,1,'{}'::jsonb,decode($3,'hex'),$4,'upload partial integration fixture')`,
      [mappingVersionId, mappingId, "00".repeat(32), accountId],
    );
    await pool.query(
      `INSERT INTO shop
        (id,application_id,owner_account_id,enterprise_id,created_by_account_id,last_operated_by_account_id,
         name,normalized_name,start_date,close_date)
       SELECT $1,id,$2,$3,$2,$2,$4,$4,'2026-01-01','2027-01-01'
         FROM application WHERE code='amazon-sales-cost'`,
      [shopId, accountId, enterpriseId, `upload-partial-${shopId}`],
    );
    await pool.query(
      `INSERT INTO upload_batch(id,shop_id,created_by,status,declared_bytes,received_bytes,file_count,expires_at)
       VALUES($1,$2,$3,'READY',$4,$4,$5,clock_timestamp()+interval '1 day')`,
      [batchId, shopId, accountId, fileStatuses.length.toString(), fileStatuses.length],
    );
    await pool.query(
      `INSERT INTO import_batch(id,shop_id,upload_batch_id,status,current_stage,idempotency_key,created_by)
       VALUES($1,$2,$3,'ANALYZING','PREFLIGHT',$4,$5)`,
      [importBatchId, shopId, batchId, randomUUID(), accountId],
    );

    const fileIds: string[] = [];
    for (const [index, status] of fileStatuses.entries()) {
      const fileId = randomUUID();
      fileIds.push(fileId);
      let objectId: string | null = null;
      if (status === "STORED") {
        objectId = randomUUID();
        await pool.query(
          `INSERT INTO stored_object
            (id,object_kind,owner_shop_id,immutable_key,storage_path,plaintext_size,plaintext_sha256,ciphertext_sha256,
             encryption_format,encryption_context,verification_status)
           VALUES($1,'SOURCE',$2,$3,$4,1,$5,$5,'AWS_ESDK_V2_FRAMED',$6::jsonb,'LOCAL_VERIFIED')`,
          [objectId, shopId, `test/${objectId}`, `test/${objectId}.esdk`, "0".repeat(63) + index, JSON.stringify({ test: "upload-partial" })],
        );
      }
      await pool.query(
        `INSERT INTO upload_file
          (id,batch_id,relative_path,declared_size,received_size,status,temp_path,stored_object_id)
         VALUES($1,$2,$3,1,1,$4,$5,$6)`,
        [fileId, batchId, `file-${index}.${status === "STORED" ? "csv" : "zip"}`, status, `test/${fileId}.part`, objectId],
      );
      if (objectId) {
        await pool.query(
          `INSERT INTO import_file
            (import_batch_id,stored_object_id,relative_path,classification,parse_status,mapping_version_id,sha256,size_bytes)
           VALUES($1,$2,$3,'TRANSACTION','PARSED',$4,decode($5,'hex'),1)`,
          [importBatchId, objectId, `file-${index}.csv`, mappingVersionId, "00".repeat(32)],
        );
      }
    }
    return { batchId, importBatchId, fileIds };
  }

  it("keeps the batch ready and advances the good sibling after one deterministic file failure", async () => {
    const fixture = await createBatch(["STORED", "ENCRYPTING"]);
    const failedId = fixture.fileIds[1]!;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await recordUploadFileFailure(pool, {
        fileId: failedId,
        errorCode: "ZIP_UNSAFE_PATH",
        allowedStatuses: ["COMPLETE", "ENCRYPTING"],
      });
    }
    const state = await pool.query<{
      upload_status: string;
      import_status: string;
      failure_code: string | null;
      issues: string;
    }>(
      `SELECT ub.status AS upload_status,ib.status AS import_status,ib.failure_code,
              count(ii.id) FILTER (WHERE ii.safe_context->>'uploadFileId'=$3)::text AS issues
         FROM upload_batch ub JOIN import_batch ib ON ib.upload_batch_id=ub.id
         LEFT JOIN import_issue ii ON ii.import_batch_id=ib.id
        WHERE ub.id=$1 AND ib.id=$2
        GROUP BY ub.id,ib.id`,
      [fixture.batchId, fixture.importBatchId, failedId],
    );
    expect(state.rows[0]).toEqual({
      upload_status: "READY",
      import_status: "COMMITTING",
      failure_code: null,
      issues: "1",
    });
    const outbox = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox_event WHERE topic='import.commit' AND business_key=$1",
      [`auto:${fixture.importBatchId}`],
    );
    expect(outbox.rows[0]?.count).toBe("1");
  });

  it("finishes as a queryable preflight failure when every file failed", async () => {
    const fixture = await createBatch(["ENCRYPTING", "ENCRYPTING"]);
    for (const fileId of fixture.fileIds) {
      await recordUploadFileFailure(pool, {
        fileId,
        errorCode: "ZIP_INVALID_ARCHIVE",
        allowedStatuses: ["COMPLETE", "ENCRYPTING"],
      });
    }
    const state = await pool.query<{ status: string; current_stage: string; failure_code: string | null; issues: string }>(
      `SELECT ib.status,ib.current_stage,ib.failure_code,count(ii.id)::text AS issues
         FROM import_batch ib LEFT JOIN import_issue ii ON ii.import_batch_id=ib.id
        WHERE ib.id=$1 GROUP BY ib.id`,
      [fixture.importBatchId],
    );
    expect(state.rows[0]).toEqual({
      status: "FAILED",
      current_stage: "PREFLIGHT_COMPLETE",
      failure_code: "NO_USABLE_UPLOAD_FILES",
      issues: "3",
    });
  });

  it("atomically releases a reserved archive budget when finalization fails", async () => {
    const fixture = await createBatch(["STORED", "ENCRYPTING"]);
    const failedId = fixture.fileIds[1]!;
    await pool.query(
      `UPDATE upload_batch
          SET expanded_bytes=100,file_count=file_count+2
        WHERE id=$1`,
      [fixture.batchId],
    );
    await pool.query(
      `UPDATE upload_file
          SET archive_reservation_state='RESERVED',archive_expanded_bytes=100,archive_file_count=2
        WHERE id=$1`,
      [failedId],
    );

    await recordUploadFileFailure(pool, {
      fileId: failedId,
      errorCode: "UPLOAD_FINALIZE_FAILED",
      allowedStatuses: ["COMPLETE", "ENCRYPTING"],
    });

    const state = await pool.query<{
      expanded_bytes: string;
      file_count: number;
      archive_reservation_state: string;
      archive_expanded_bytes: string;
      archive_file_count: number;
    }>(
      `SELECT ub.expanded_bytes::text,ub.file_count,uf.archive_reservation_state,
              uf.archive_expanded_bytes::text,uf.archive_file_count
         FROM upload_batch ub JOIN upload_file uf ON uf.batch_id=ub.id
        WHERE ub.id=$1 AND uf.id=$2`,
      [fixture.batchId, failedId],
    );
    expect(state.rows[0]).toEqual({
      expanded_bytes: "0",
      file_count: 2,
      archive_reservation_state: "NONE",
      archive_expanded_bytes: "0",
      archive_file_count: 0,
    });
  });
});
