import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replayCurrentShopSources } from "../../src/modules/imports/source-replay.js";
import { EncryptedObjectStore } from "../../src/modules/storage/encrypted-object-store.js";
import { UploadService } from "../../src/modules/uploads/service.js";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

describe("admin current-source replay", () => {
  let database: PostgresTestSchema | undefined;
  let pool!: PostgresTestSchema["pool"];
  let root = "";
  let actorAccountId = "";
  let shopId = "";
  let sourceImportBatchId = "";
  let boundObjectIds: string[] = [];
  let sourcePaths: string[] = [];
  let sourceCiphertexts: Buffer[] = [];
  let objectStore: EncryptedObjectStore;

  beforeAll(async () => {
    database = await createPostgresTestSchema();
    pool = database.pool;
    root = await mkdtemp(join(tmpdir(), "source-replay-"));
    objectStore = new EncryptedObjectStore(root, Buffer.alloc(32, 7));
    actorAccountId = randomUUID();
    shopId = randomUUID();
    sourceImportBatchId = randomUUID();
    const sourceUploadBatchId = randomUUID();
    const enterpriseId = randomUUID();
    await pool.query(
      "INSERT INTO account(id,phone_e164,phone_verified_at) VALUES($1,'+8613900088888',clock_timestamp())",
      [actorAccountId],
    );
    await pool.query("INSERT INTO account_role(account_id,role) VALUES($1,'ADMIN')", [actorAccountId]);
    await pool.query(
      `INSERT INTO enterprise(id,name,normalized_name,created_by_account_id)
       VALUES($1,'Replay synthetic enterprise','replay synthetic enterprise',$2)`,
      [enterpriseId, actorAccountId],
    );
    await pool.query(
      `INSERT INTO shop(id,application_id,owner_account_id,name,normalized_name,status,start_date,close_date,
                        enterprise_id,created_by_account_id,last_operated_by_account_id)
       SELECT $1,id,$2,'Replay synthetic shop','replay synthetic shop','ACTIVE','2026-01-01','2027-01-01',$3,$2,$2
         FROM application WHERE code='amazon-sales-cost'`,
      [shopId, actorAccountId, enterpriseId],
    );
    await pool.query(
      `INSERT INTO upload_batch(id,shop_id,created_by,status,declared_bytes,received_bytes,file_count,expires_at)
       VALUES($1,$2,$3,'READY',23,23,23,clock_timestamp()+interval '1 day')`,
      [sourceUploadBatchId, shopId, actorAccountId],
    );
    await pool.query(
      `INSERT INTO import_batch(id,shop_id,upload_batch_id,status,current_stage,idempotency_key,created_by)
       VALUES($1,$2,$3,'RESULT_PUBLISHED','PUBLISHED',$4,$5)`,
      [sourceImportBatchId, shopId, sourceUploadBatchId, `source-${sourceImportBatchId}`, actorAccountId],
    );

    const mappings = new Map<"SHIPMENT" | "TRANSACTION", string>();
    for (const kind of ["SHIPMENT", "TRANSACTION"] as const) {
      const mappingId = randomUUID();
      const versionId = randomUUID();
      await pool.query(
        "INSERT INTO field_mapping(id,report_kind,locale,name) VALUES($1,$2,'synthetic',$3)",
        [mappingId, kind, `source-replay-${kind.toLowerCase()}`],
      );
      await pool.query(
        `INSERT INTO field_mapping_version(id,field_mapping_id,version_no,definition,definition_sha256,created_by,reason)
         VALUES($1,$2,1,'{}',digest($3,'sha256'),$4,'source replay integration fixture')`,
        [versionId, mappingId, `source-replay-${kind}`, actorAccountId],
      );
      mappings.set(kind, versionId);
    }

    boundObjectIds = [];
    sourcePaths = [];
    sourceCiphertexts = [];
    for (let index = 0; index < 21; index += 1) {
      const kind = index % 2 === 0 ? "SHIPMENT" : "TRANSACTION";
      const objectId = randomUUID();
      const importFileId = randomUUID();
      const uploadFileId = randomUUID();
      const sliceId = randomUUID();
      const versionId = randomUUID();
      const relativePath = `site-${String(index + 1).padStart(2, "0")}/${kind.toLowerCase()}-${index + 1}.csv`;
      const content = Buffer.from(`source-${index + 1}`);
      const plaintextPath = join(root, `${objectId}.plaintext`);
      await writeFile(plaintextPath, content);
      const encrypted = await objectStore.putFile(plaintextPath, objectId, { fixture: "source-replay" });
      await rm(plaintextPath);
      boundObjectIds.push(objectId);
      sourcePaths.push(encrypted.path);
      sourceCiphertexts.push(await readFile(encrypted.path));
      await pool.query(
        `INSERT INTO stored_object(id,object_kind,owner_shop_id,immutable_key,storage_path,plaintext_size,
                                   plaintext_sha256,ciphertext_sha256,encryption_format,encryption_context,verification_status)
         VALUES($1,'SOURCE',$2,$3,$4,$5,$6,$7,'AWS_ESDK_V2_FRAMED',$8::jsonb,'LOCAL_VERIFIED')`,
        [objectId, shopId, `source-replay/${objectId}`, encrypted.path, encrypted.plaintextSize.toString(),
          encrypted.plaintextSha256, encrypted.ciphertextSha256, JSON.stringify(encrypted.encryptionContext)],
      );
      await pool.query(
        `INSERT INTO upload_file(
           id,batch_id,relative_path,declared_size,received_size,content_type,plaintext_sha256,status,temp_path,
           stored_object_id,detected_kind
         ) VALUES($1,$2,$3,$4,$4,'text/csv',$5,'STORED','<fixture>',$6,'TEXT')`,
        [uploadFileId, sourceUploadBatchId, relativePath, content.byteLength, encrypted.plaintextSha256, objectId],
      );
      await pool.query(
        `INSERT INTO import_file(
           id,import_batch_id,stored_object_id,relative_path,classification,parse_status,detected_encoding,
           detected_delimiter,header_line_number,mapping_version_id,sha256,size_bytes,read_row_count,inserted_row_count
         ) VALUES($1,$2,$3,$4,$5,'PARSED','UTF-8',',',1,$6,decode($7,'hex'),$8,1,1)`,
        [importFileId, sourceImportBatchId, objectId, relativePath, kind, mappings.get(kind), encrypted.plaintextSha256, content.byteLength],
      );
      await pool.query(
        `INSERT INTO dataset_slice(id,shop_id,normalized_marketplace,local_month)
         VALUES($1,$2,$3,'2026-04-01')`,
        [sliceId, shopId, `SITE${String(index + 1).padStart(2, "0")}`],
      );
      await pool.query(
        `INSERT INTO dataset_version(
           id,dataset_slice_id,import_batch_id,version_no,status,manifest_sha256,activated_at,created_by
         ) VALUES($1,$2,$3,1,'ACTIVE',digest($4,'sha256'),clock_timestamp(),$5)`,
        [versionId, sliceId, sourceImportBatchId, versionId, actorAccountId],
      );
      await pool.query("UPDATE dataset_slice SET current_version_id=$2 WHERE id=$1", [sliceId, versionId]);
      await pool.query(
        `INSERT INTO dataset_source_binding(
           dataset_version_id,report_kind,import_file_id,mapping_version_id,coverage_start,coverage_end
         ) VALUES($1,$2,$3,$4,'2026-04-01','2026-04-30')`,
        [versionId, kind, importFileId, mappings.get(kind)],
      );
    }

    for (const [classification, parseStatus] of [["LIST_ONLY", "EXCLUDED"], ["UNKNOWN", "AWAITING_MAPPING"]] as const) {
      const objectId = randomUUID();
      const content = Buffer.from(`${classification}-${parseStatus}`);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const storagePath = join(root, `${objectId}.ciphertext`);
      await writeFile(storagePath, content);
      await pool.query(
        `INSERT INTO stored_object(id,object_kind,owner_shop_id,immutable_key,storage_path,plaintext_size,
                                   plaintext_sha256,ciphertext_sha256,encryption_format,encryption_context,verification_status)
         VALUES($1,'SOURCE',$2,$3,$4,$5,$6,$7,'AWS_ESDK_V2_FRAMED','{}','LOCAL_VERIFIED')`,
        [objectId, shopId, `source-replay/${objectId}`, storagePath, content.byteLength, sha256, `cipher-${objectId}`],
      );
      await pool.query(
        `INSERT INTO upload_file(
           id,batch_id,relative_path,declared_size,received_size,plaintext_sha256,status,temp_path,stored_object_id,detected_kind
         ) VALUES($1,$2,$3,$4,$4,$5,'STORED','<fixture>',$6,'TEXT')`,
        [randomUUID(), sourceUploadBatchId, `ignored/${objectId}.txt`, content.byteLength, sha256, objectId],
      );
      await pool.query(
        `INSERT INTO import_file(
           id,import_batch_id,stored_object_id,relative_path,classification,parse_status,sha256,size_bytes
         ) VALUES($1,$2,$3,$4,$5,$6,decode($7,'hex'),$8)`,
        [randomUUID(), sourceImportBatchId, objectId, `ignored/${objectId}.txt`, classification, parseStatus, sha256, content.byteLength],
      );
    }
  });

  afterAll(async () => {
    await database?.cleanup();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("replays the complete current PARSED binding closure once and queues commit", async () => {
    const input = {
      shopId,
      actorAccountId,
      idempotencyKey: "shipment-only-policy-20260813",
      reason: "Rebuild current immutable sources under the shipment-only completeness policy",
    };
    await expect(replayCurrentShopSources(pool, {
      ...input,
      actorAccountId: randomUUID(),
      idempotencyKey: "unauthorized-replay",
    }, { objectStore })).rejects.toThrow("SOURCE_REPLAY_ADMIN_REQUIRED");
    const unavailablePath = sourcePaths[0]!;
    await rm(unavailablePath);
    await expect(replayCurrentShopSources(pool, input, { objectStore })).rejects.toThrow("SOURCE_REPLAY_OBJECT_UNREADABLE");
    expect((await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM import_batch WHERE shop_id=$1", [shopId])).rows[0]?.count).toBe("1");
    await writeFile(unavailablePath, sourceCiphertexts[0]!);

    const created = await replayCurrentShopSources(pool, input, { objectStore });
    expect(created).toMatchObject({ status: "COMMITTING", sourceObjectCount: 21, replayed: false });

    const batch = await pool.query<{
      import_status: string;
      import_stage: string;
      upload_status: string;
      upload_files: string;
      import_files: string;
      parsed_files: string;
      min_object_count: string;
    }>(
      `SELECT batch.status AS import_status,batch.current_stage AS import_stage,upload.status AS upload_status,
              (SELECT count(*)::text FROM upload_file WHERE batch_id=upload.id) AS upload_files,
              (SELECT count(*)::text FROM import_file WHERE import_batch_id=batch.id) AS import_files,
              (SELECT count(*)::text FROM import_file WHERE import_batch_id=batch.id AND parse_status='PARSED'
                 AND classification IN ('SHIPMENT','TRANSACTION')) AS parsed_files,
              (SELECT count(DISTINCT stored_object_id)::text FROM import_file WHERE import_batch_id=batch.id) AS min_object_count
         FROM import_batch batch JOIN upload_batch upload ON upload.id=batch.upload_batch_id
        WHERE batch.id=$1`,
      [created.importBatchId],
    );
    expect(batch.rows[0]).toEqual({
      import_status: "COMMITTING",
      import_stage: "COPY",
      upload_status: "READY",
      upload_files: "21",
      import_files: "21",
      parsed_files: "21",
      min_object_count: "21",
    });
    const replayedObjects = await pool.query<{ stored_object_id: string }>(
      "SELECT stored_object_id FROM import_file WHERE import_batch_id=$1 ORDER BY stored_object_id",
      [created.importBatchId],
    );
    expect(replayedObjects.rows.map((row) => row.stored_object_id)).toEqual([...boundObjectIds].sort());

    const outbox = await pool.query<{ business_key: string; payload: Record<string, string> }>(
      "SELECT business_key,payload FROM outbox_event WHERE topic='import.commit' AND payload->>'batchId'=$1",
      [created.importBatchId],
    );
    expect(outbox.rows).toEqual([{
      business_key: `source-replay:${created.importBatchId}`,
      payload: { batchId: created.importBatchId, shopId, actorAccountId },
    }]);
    const audit = await pool.query<{ actor_account_id: string; reason: string; metadata: Record<string, unknown> }>(
      `SELECT actor_account_id,reason,metadata FROM audit_event
        WHERE action='ADMIN_SOURCE_REPLAY_CREATED' AND object_id=$1`,
      [created.importBatchId],
    );
    expect(audit.rows[0]).toMatchObject({
      actor_account_id: actorAccountId,
      reason: input.reason,
      metadata: {
        shopId,
        uploadBatchId: created.uploadBatchId,
        sourceMode: "CURRENT_BINDING_CLOSURE",
        completenessRuleVersion: "shipment-only-v1",
        sourceDatasetVersionCount: 21,
        sourceObjectCount: 21,
        sourceClosureHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });

    const replayed = await replayCurrentShopSources(pool, input, { objectStore });
    expect(replayed).toEqual({ ...created, replayed: true });
    expect((await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM import_batch WHERE shop_id=$1",
      [shopId],
    )).rows[0]?.count).toBe("2");
    expect((await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox_event WHERE topic='import.commit' AND payload->>'batchId'=$1",
      [created.importBatchId],
    )).rows[0]?.count).toBe("1");

    await expect(replayCurrentShopSources(pool, { ...input, idempotencyKey: "second-replay" }, { objectStore }))
      .rejects.toThrow("SOURCE_REPLAY_IMPORT_IN_PROGRESS");

    await pool.query("UPDATE import_batch SET status='FAILED' WHERE id=$1", [created.importBatchId]);
    const replayClient = await pool.connect();
    const uploadClient = await pool.connect();
    try {
      await replayClient.query("BEGIN");
      await replayClient.query("SELECT id FROM shop WHERE id=$1 FOR UPDATE", [shopId]);
      await replayClient.query("UPDATE import_batch SET status='COMMITTING' WHERE id=$1", [created.importBatchId]);
      const uploadPid = (await uploadClient.query<{ pid: number }>("SELECT pg_backend_pid()::int pid")).rows[0]!.pid;
      const uploadService = new UploadService({ connect: async () => uploadClient } as unknown as Pool, root);
      const uploadAttempt = uploadService.createBatch(shopId, actorAccountId, "ordinary-upload-during-source-replay");

      const deadline = Date.now() + 2_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const state = await pool.query<{ blocked: number }>(
          "SELECT cardinality(pg_blocking_pids($1))::int blocked",
          [uploadPid],
        );
        if ((state.rows[0]?.blocked ?? 0) > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await replayClient.query("COMMIT");
      await expect(uploadAttempt).rejects.toMatchObject({ code: "UPLOAD_SOURCE_REPLAY_IN_PROGRESS", statusCode: 409 });
      expect((await pool.query<{ count: string }>(
        "SELECT count(*)::text count FROM import_batch WHERE shop_id=$1 AND idempotency_key=$2",
        [shopId, "ordinary-upload-during-source-replay"],
      )).rows[0]?.count).toBe("0");
    } catch (error) {
      await replayClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      replayClient.release();
    }
  });
});
