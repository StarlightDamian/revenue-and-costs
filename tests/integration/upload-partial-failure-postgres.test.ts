import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordUploadFileFailure } from "../../src/modules/uploads/partial-failure.js";
import { UploadService, expireUploadStaging } from "../../src/modules/uploads/service.js";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

describe("upload partial failure PostgreSQL projection", () => {
  let database: PostgresTestSchema | undefined;
  let pool!: PostgresTestSchema["pool"];

  beforeAll(async () => {
    database = await createPostgresTestSchema();
    pool = database.pool;
  });
  afterAll(async () => { await database?.cleanup(); });

  async function createBatch(
    fileStatuses: readonly ("COMPLETE" | "ENCRYPTING" | "STORED")[],
    options: {
      readonly uploadStatus?: "UPLOADING" | "READY" | "CANCELLED" | "FAILED" | "EXPIRED";
      readonly importStatus?: "UPLOADING" | "ANALYZING" | "RESULT_PUBLISHED" | "CANCELLED" | "FAILED";
    } = {},
  ) {
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
       VALUES($1,$2,$3,$4,$5,$5,$6,clock_timestamp()+interval '1 day')`,
      [batchId, shopId, accountId, options.uploadStatus ?? "READY", fileStatuses.length.toString(), fileStatuses.length],
    );
    await pool.query(
      `INSERT INTO import_batch(id,shop_id,upload_batch_id,status,current_stage,idempotency_key,created_by)
       VALUES($1,$2,$3,$4,'PREFLIGHT',$5,$6)`,
      [importBatchId, shopId, batchId, options.importStatus ?? "ANALYZING", randomUUID(), accountId],
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
    return { accountId, batchId, importBatchId, fileIds };
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

  it("backfills one finalize event across repeated completion calls", async () => {
    const fixture = await createBatch(["COMPLETE"], { uploadStatus: "UPLOADING", importStatus: "UPLOADING" });
    const service = new UploadService(pool, ".");

    await expect(service.completeBatch(fixture.batchId)).resolves.toMatchObject({ id: fixture.importBatchId, status: "ANALYZING" });
    await expect(service.completeBatch(fixture.batchId)).resolves.toMatchObject({ id: fixture.importBatchId, status: "ANALYZING" });

    const state = await pool.query<{ upload_status: string; outbox_count: string }>(
      `SELECT batch.status AS upload_status,
              count(event.id) FILTER (WHERE event.topic='upload.finalize' AND event.business_key=$2)::text AS outbox_count
         FROM upload_batch batch
         LEFT JOIN outbox_event event ON true
        WHERE batch.id=$1
        GROUP BY batch.id`,
      [fixture.batchId, fixture.fileIds[0]],
    );
    expect(state.rows[0]).toEqual({ upload_status: "READY", outbox_count: "1" });
  });

  it("preserves an existing finalize event when completion is replayed", async () => {
    const fixture = await createBatch(["COMPLETE"], { uploadStatus: "UPLOADING", importStatus: "UPLOADING" });
    const fileId = fixture.fileIds[0]!;
    await pool.query(
      `INSERT INTO outbox_event(topic,business_key,payload)
       VALUES('upload.finalize',$1,jsonb_build_object('fileId',$1::text))`,
      [fileId],
    );

    await expect(new UploadService(pool, ".").completeBatch(fixture.batchId))
      .resolves.toMatchObject({ id: fixture.importBatchId, status: "ANALYZING" });

    const outbox = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox_event WHERE topic='upload.finalize' AND business_key=$1",
      [fileId],
    );
    expect(outbox.rows[0]?.count).toBe("1");
  });

  it.each([
    { uploadStatus: "CANCELLED", importStatus: "CANCELLED" },
    { uploadStatus: "FAILED", importStatus: "FAILED" },
    { uploadStatus: "EXPIRED", importStatus: "FAILED" },
  ] as const)("does not backfill a terminal $uploadStatus/$importStatus batch", async ({ uploadStatus, importStatus }) => {
    const fixture = await createBatch(["COMPLETE"], { uploadStatus, importStatus });

    await expect(new UploadService(pool, ".").completeBatch(fixture.batchId))
      .rejects.toMatchObject({ code: "UPLOAD_BATCH_NOT_COMPLETABLE", statusCode: 409 });

    const outbox = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox_event WHERE topic='upload.finalize' AND business_key=$1",
      [fixture.fileIds[0]],
    );
    expect(outbox.rows[0]?.count).toBe("0");
  });

  it("removes staged files against the real schema and cancels the batch when the last active file is removed", async () => {
    const fixture = await createBatch(["ENCRYPTING", "ENCRYPTING"]);
    const root = await mkdtemp(join(tmpdir(), "upload-removal-postgres-"));
    const [firstId, secondId] = fixture.fileIds as [string, string];
    const firstPath = join(root, `${firstId}.part`);
    const secondPath = join(root, `${secondId}.part`);
    await writeFile(firstPath, "first", "utf8");
    await writeFile(secondPath, "second", "utf8");
    await pool.query("UPDATE upload_batch SET status='UPLOADING' WHERE id=$1", [fixture.batchId]);
    await pool.query("UPDATE import_batch SET status='UPLOADING',current_stage='UPLOAD' WHERE id=$1", [fixture.importBatchId]);
    await pool.query(
      `UPDATE upload_file
          SET status='COMPLETE',temp_path=CASE id WHEN $2 THEN $3 ELSE $4 END
        WHERE batch_id=$1`,
      [fixture.batchId, firstId, firstPath, secondPath],
    );
    const service = new UploadService(pool, root);

    try {
      await expect(service.removeFiles(fixture.batchId, [firstId], fixture.accountId)).resolves.toEqual({
        removedCount: 1,
        remainingCount: 1,
        cancelled: false,
      });
      const partiallyReleased = await pool.query<{ declared_bytes: string; received_bytes: string; file_count: number }>(
        "SELECT declared_bytes::text,received_bytes::text,file_count FROM upload_batch WHERE id=$1",
        [fixture.batchId],
      );
      expect(partiallyReleased.rows[0]).toEqual({ declared_bytes: "1", received_bytes: "1", file_count: 1 });
      await expect(access(firstPath)).rejects.toThrow();
      await expect(access(secondPath)).resolves.toBeUndefined();

      await expect(service.removeFiles(fixture.batchId, [secondId], fixture.accountId)).resolves.toEqual({
        removedCount: 1,
        remainingCount: 0,
        cancelled: true,
      });
      await expect(service.removeFiles(fixture.batchId, [secondId], fixture.accountId)).resolves.toEqual({
        removedCount: 1,
        remainingCount: 0,
        cancelled: true,
      });
      const state = await pool.query<{
        upload_status: string;
        import_status: string;
        declared_bytes: string;
        received_bytes: string;
        file_count: number;
        failed_files: string;
        audits: string;
      }>(
        `SELECT upload.status AS upload_status,batch_import.status AS import_status,
                upload.declared_bytes::text,upload.received_bytes::text,upload.file_count,
                count(file.id) FILTER (WHERE file.status='FAILED')::text AS failed_files,
                (SELECT count(*)::text FROM audit_event audit
                  WHERE audit.object_id=upload.id AND audit.action='UPLOAD_FILES_REMOVED_BEFORE_IMPORT') AS audits
           FROM upload_batch upload
           JOIN import_batch batch_import ON batch_import.upload_batch_id=upload.id
           JOIN upload_file file ON file.batch_id=upload.id
          WHERE upload.id=$1
          GROUP BY upload.id,batch_import.id`,
        [fixture.batchId],
      );
      expect(state.rows[0]).toEqual({
        upload_status: "CANCELLED",
        import_status: "CANCELLED",
        declared_bytes: "0",
        received_bytes: "0",
        file_count: 0,
        failed_files: "2",
        audits: "2",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("durably cleans a removed file after the first cleanup fails and its batch later becomes READY", async () => {
    const fixture = await createBatch(["ENCRYPTING", "ENCRYPTING"]);
    const root = await mkdtemp(join(tmpdir(), "upload-removal-recovery-postgres-"));
    const [removedId, retainedId] = fixture.fileIds as [string, string];
    const removedPath = join(root, `${removedId}.part`);
    await pool.query("UPDATE upload_file SET temp_path='' WHERE batch_id<>$1", [fixture.batchId]);
    await pool.query("UPDATE upload_batch SET status='UPLOADING' WHERE id=$1", [fixture.batchId]);
    await pool.query("UPDATE import_batch SET status='UPLOADING',current_stage='UPLOAD' WHERE id=$1", [fixture.importBatchId]);
    await pool.query(
      `UPDATE upload_file
          SET status='COMPLETE',temp_path=CASE WHEN id=$2 THEN $3 ELSE temp_path END
        WHERE batch_id=$1`,
      [fixture.batchId, removedId, removedPath],
    );
    await mkdir(removedPath);
    const service = new UploadService(pool, root);

    try {
      await expect(service.removeFiles(fixture.batchId, [removedId], fixture.accountId))
        .rejects.toMatchObject({ code: expect.stringMatching(/^(?:EISDIR|EPERM)$/u) });
      const committedRemoval = await pool.query<{
        batch_status: string;
        declared_bytes: string;
        received_bytes: string;
        file_count: number;
        removed_status: string;
        retained_status: string;
        removed_temp_path: string;
      }>(
        `SELECT batch.status AS batch_status,batch.declared_bytes::text,batch.received_bytes::text,batch.file_count,
                removed.status AS removed_status,retained.status AS retained_status,removed.temp_path AS removed_temp_path
           FROM upload_batch batch
           JOIN upload_file removed ON removed.batch_id=batch.id AND removed.id=$2
           JOIN upload_file retained ON retained.batch_id=batch.id AND retained.id=$3
          WHERE batch.id=$1`,
        [fixture.batchId, removedId, retainedId],
      );
      expect(committedRemoval.rows[0]).toEqual({
        batch_status: "UPLOADING",
        declared_bytes: "1",
        received_bytes: "1",
        file_count: 1,
        removed_status: "FAILED",
        retained_status: "COMPLETE",
        removed_temp_path: removedPath,
      });

      await pool.query("UPDATE upload_batch SET status='READY' WHERE id=$1", [fixture.batchId]);
      await rm(removedPath, { recursive: true, force: true });
      await writeFile(removedPath, "plaintext left after committed removal", "utf8");

      await expect(expireUploadStaging(pool)).resolves.toBe(1);
      const recovered = await pool.query<{
        batch_status: string;
        removed_status: string;
        retained_status: string;
        removed_temp_path: string;
      }>(
        `SELECT batch.status AS batch_status,removed.status AS removed_status,
                retained.status AS retained_status,removed.temp_path AS removed_temp_path
           FROM upload_batch batch
           JOIN upload_file removed ON removed.batch_id=batch.id AND removed.id=$2
           JOIN upload_file retained ON retained.batch_id=batch.id AND retained.id=$3
          WHERE batch.id=$1`,
        [fixture.batchId, removedId, retainedId],
      );
      expect(recovered.rows[0]).toEqual({
        batch_status: "READY",
        removed_status: "FAILED",
        retained_status: "COMPLETE",
        removed_temp_path: "",
      });
      await expect(access(removedPath)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["UPLOADING", "COMMITTING"],
    ["UPLOADING", "RESULT_PUBLISHED"],
    ["UPLOADING", "CANCELLED"],
    ["UPLOADING", "FAILED"],
    ["READY", "COMMITTING"],
    ["READY", "RESULT_PUBLISHED"],
    ["READY", "CANCELLED"],
    ["READY", "FAILED"],
  ] as const)("does not drive a %s upload when its import is terminal %s", async (uploadStatus, importStatus) => {
    const fixture = await createBatch(["ENCRYPTING"]);
    const fileId = fixture.fileIds[0]!;
    await pool.query("UPDATE upload_batch SET status=$2 WHERE id=$1", [fixture.batchId, uploadStatus]);
    await pool.query("UPDATE upload_file SET status='COMPLETE' WHERE id=$1", [fileId]);
    await pool.query("UPDATE import_batch SET status=$2,current_stage=$2 WHERE id=$1", [fixture.importBatchId, importStatus]);

    await expect(new UploadService(pool, ".").completeBatch(fixture.batchId)).resolves.toEqual({
      id: fixture.importBatchId,
      status: importStatus,
    });

    const state = await pool.query<{
      upload_status: string;
      import_status: string;
      file_status: string;
      finalize_events: string;
    }>(
      `SELECT upload.status AS upload_status,batch_import.status AS import_status,file.status AS file_status,
              (SELECT count(*)::text FROM outbox_event event
                WHERE event.topic='upload.finalize' AND event.business_key=file.id::text) AS finalize_events
         FROM upload_batch upload
         JOIN import_batch batch_import ON batch_import.upload_batch_id=upload.id
         JOIN upload_file file ON file.batch_id=upload.id
        WHERE upload.id=$1 AND file.id=$2`,
      [fixture.batchId, fileId],
    );
    expect(state.rows[0]).toEqual({
      upload_status: uploadStatus,
      import_status: importStatus,
      file_status: "COMPLETE",
      finalize_events: "0",
    });
  });
});
