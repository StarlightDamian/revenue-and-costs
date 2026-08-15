import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  inheritSourceReplayHardAcknowledgements,
  resumeFailedSourceReplay,
} from "../../src/modules/imports/source-replay.js";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

interface ScenarioOptions {
  readonly sourceReplay?: boolean;
  readonly priorAcknowledgement?: boolean;
  readonly factChanged?: boolean;
  readonly mappingChanged?: boolean;
  readonly policyChanged?: boolean;
  readonly priorIssueCode?: "ACCOUNTANT_ACKNOWLEDGED" | "SOURCE_REPLAY_INHERITED_HARD_INCOMPLETE";
  readonly currentShipmentFact?: boolean;
  readonly duplicateReplayAudit?: boolean;
}

interface Scenario {
  readonly shopId: string;
  readonly batchId: string;
  readonly currentVersionId: string;
  readonly predecessorVersionId: string;
  readonly predecessorAcknowledgementId: string | null;
}

describe("source replay hard-incomplete acknowledgement continuity", () => {
  let database: PostgresTestSchema | undefined;
  let pool!: PostgresTestSchema["pool"];
  let actorAccountId = "";
  let enterpriseId = "";

  beforeAll(async () => {
    database = await createPostgresTestSchema();
    pool = database.pool;
    actorAccountId = randomUUID();
    enterpriseId = randomUUID();
    await pool.query(
      "INSERT INTO account(id,phone_e164,phone_verified_at) VALUES($1,'+8613900077777',clock_timestamp())",
      [actorAccountId],
    );
    await pool.query("INSERT INTO account_role(account_id,role) VALUES($1,'ADMIN')", [actorAccountId]);
    await pool.query(
      `INSERT INTO enterprise(id,name,normalized_name,created_by_account_id)
       VALUES($1,'Acknowledgement synthetic enterprise','acknowledgement synthetic enterprise',$2)`,
      [enterpriseId, actorAccountId],
    );
  });

  afterAll(async () => { await database?.cleanup(); });

  async function createMapping(suffix: string): Promise<string> {
    const mappingId = randomUUID();
    const versionId = randomUUID();
    await pool.query(
      "INSERT INTO field_mapping(id,report_kind,locale,name) VALUES($1,'TRANSACTION','synthetic',$2)",
      [mappingId, `ack-source-${suffix}`],
    );
    await pool.query(
      `INSERT INTO field_mapping_version(id,field_mapping_id,version_no,definition,definition_sha256,created_by,reason)
       VALUES($1,$2,1,'{}',digest($3,'sha256'),$4,'synthetic acknowledgement continuity')`,
      [versionId, mappingId, `ack-mapping-${suffix}`, actorAccountId],
    );
    return versionId;
  }

  async function createScenario(options: ScenarioOptions = {}): Promise<Scenario> {
    const suffix = randomUUID();
    const shopId = randomUUID();
    const oldUploadBatchId = randomUUID();
    const oldBatchId = randomUUID();
    const replayUploadBatchId = randomUUID();
    const batchId = randomUUID();
    const sliceId = randomUUID();
    const predecessorVersionId = randomUUID();
    const currentVersionId = randomUUID();
    const storedObjectId = randomUUID();
    const oldFileId = randomUUID();
    const newFileId = randomUUID();
    const oldMappingId = await createMapping(`old-${suffix}`);
    const newMappingId = options.mappingChanged ? await createMapping(`new-${suffix}`) : oldMappingId;
    const marketplace = `ACK-${suffix.slice(0, 8).toUpperCase()}`;
    const oldPolicyId = randomUUID();
    const newPolicyId = options.policyChanged ? randomUUID() : oldPolicyId;
    await pool.query(
      `INSERT INTO shop(id,application_id,owner_account_id,name,normalized_name,status,start_date,close_date,
                        enterprise_id,created_by_account_id,last_operated_by_account_id)
       SELECT $1,id,$2,$3,$4,'ACTIVE','2026-01-01','2099-01-01',$5,$2,$2
         FROM application WHERE code='amazon-sales-cost'`,
      [shopId, actorAccountId, `Ack shop ${suffix}`, `ack shop ${suffix}`, enterpriseId],
    );
    await pool.query(
      `INSERT INTO marketplace_policy_version(
         id,marketplace,normalized_marketplace,iana_timezone,marketplace_size,date_attribution_mode,
         effective_from,effective_to,created_by,reason
       ) VALUES($1,$2,$2,'UTC','SMALL','REPORT_LITERAL_DATE','2020-01-01',$3,$4,'synthetic old policy')`,
      [oldPolicyId, marketplace, options.policyChanged ? "2026-04-15T00:00:00Z" : null, actorAccountId],
    );
    if (options.policyChanged) {
      await pool.query(
        `INSERT INTO marketplace_policy_version(
           id,marketplace,normalized_marketplace,iana_timezone,marketplace_size,date_attribution_mode,
           effective_from,created_by,reason
         ) VALUES($1,$2,$2,'UTC','SMALL','REPORT_LITERAL_DATE','2026-04-15T00:00:00Z',$3,'synthetic changed policy')`,
        [newPolicyId, marketplace, actorAccountId],
      );
    }
    await pool.query(
      `INSERT INTO upload_batch(id,shop_id,created_by,status,expires_at)
       VALUES($1,$3,$4,'READY',clock_timestamp()+interval '1 day'),
             ($2,$3,$4,'READY',clock_timestamp()+interval '1 day')`,
      [oldUploadBatchId, replayUploadBatchId, shopId, actorAccountId],
    );
    await pool.query(
      `INSERT INTO import_batch(id,shop_id,upload_batch_id,status,current_stage,idempotency_key,created_by)
       VALUES($1,$3,$4,'RESULT_PUBLISHED','PUBLISHED',$5,$6),
             ($2,$3,$7,'FAILED','CALCULATION_REQUEST_BLOCKED',$8,$6)`,
      [oldBatchId, batchId, shopId, oldUploadBatchId, `old-${suffix}`, actorAccountId,
        replayUploadBatchId, options.sourceReplay === false ? `ordinary-${suffix}` : `admin-source-replay:${suffix}`],
    );
    await pool.query(
      "UPDATE import_batch SET failure_code='HARD_INCOMPLETE_CONFIRMATION_REQUIRED' WHERE id=$1",
      [batchId],
    );
    await pool.query(
      `INSERT INTO stored_object(id,object_kind,owner_shop_id,immutable_key,storage_path,plaintext_size,
                                 plaintext_sha256,ciphertext_sha256,encryption_format,encryption_context,verification_status)
       VALUES($1,'SOURCE',$2,$3,$4,1,digest($5,'sha256'),digest($6,'sha256'),
              'AWS_ESDK_V2_FRAMED','{}','LOCAL_VERIFIED')`,
      [storedObjectId, shopId, `ack/${storedObjectId}`, `ack/${storedObjectId}.source`,
        `plain-${storedObjectId}`, `cipher-${storedObjectId}`],
    );
    await pool.query(
      `INSERT INTO import_file(
         id,import_batch_id,stored_object_id,relative_path,classification,parse_status,
         detected_encoding,detected_delimiter,header_line_number,mapping_version_id,sha256,size_bytes
       ) VALUES($1,$3,$5,'old.csv','TRANSACTION','PARSED','UTF-8',',',1,$6,digest($7,'sha256'),1),
               ($2,$4,$5,'replay.csv','TRANSACTION','PARSED','UTF-8',',',1,$8,digest($7,'sha256'),1)`,
      [oldFileId, newFileId, oldBatchId, batchId, storedObjectId, oldMappingId,
        `source-${storedObjectId}`, newMappingId],
    );
    await pool.query(
      "INSERT INTO dataset_slice(id,shop_id,normalized_marketplace,local_month) VALUES($1,$2,$3,'2026-04-01')",
      [sliceId, shopId, marketplace],
    );
    await pool.query(
      `INSERT INTO dataset_version(
         id,dataset_slice_id,import_batch_id,version_no,status,manifest_sha256,activated_at,created_by,created_at
       ) VALUES($1,$3,$4,1,'SUPERSEDED',digest($5,'sha256'),'2026-04-10T00:00:00Z',$6,'2026-04-10T00:00:00Z'),
               ($2,$3,$7,2,'INCOMPLETE',digest($8,'sha256'),'2026-04-20T00:00:00Z',$6,'2026-04-20T00:00:00Z')`,
      [predecessorVersionId, currentVersionId, sliceId, oldBatchId, predecessorVersionId,
        actorAccountId, batchId, currentVersionId],
    );
    await pool.query("UPDATE dataset_version SET supersedes_version_id=$2 WHERE id=$1", [currentVersionId, predecessorVersionId]);
    await pool.query("UPDATE dataset_slice SET current_version_id=$2 WHERE id=$1", [sliceId, currentVersionId]);
    await pool.query(
      `INSERT INTO dataset_source_binding(
         dataset_version_id,report_kind,import_file_id,mapping_version_id,coverage_start,coverage_end
       ) VALUES($1,'TRANSACTION',$3,$5,'2026-04-01','2026-04-30'),
               ($2,'TRANSACTION',$4,$6,'2026-04-01','2026-04-30')`,
      [predecessorVersionId, currentVersionId, oldFileId, newFileId, oldMappingId, newMappingId],
    );
    await pool.query(
      `INSERT INTO transaction_fact(
         dataset_version_id,source_file_id,row_number,row_hash,original_datetime_text,parsed_at,source_timezone,
         fx_date,marketplace_local_date,local_month,normalized_marketplace,normalized_type,normalized_description,
         fulfillment_mode,currency,quantity,product_sales
       ) VALUES($1,$3,1,digest($5,'sha256'),'2026-04-10','2026-04-10T00:00:00Z','UTC',
                '2026-04-10','2026-04-10','2026-04-01',$6,'ORDER','synthetic','AMAZON','USD',1,10),
               ($2,$4,1,digest($5,'sha256'),'2026-04-10','2026-04-10T00:00:00Z','UTC',
                '2026-04-10','2026-04-10','2026-04-01',$6,'ORDER',$7,'AMAZON','USD',1,10)`,
      [predecessorVersionId, currentVersionId, oldFileId, newFileId, `row-${storedObjectId}`,
        marketplace, options.factChanged ? "changed" : "synthetic"],
    );
    if (options.currentShipmentFact) {
      await pool.query(
        `INSERT INTO shipment_fact(
           dataset_version_id,source_file_id,row_number,row_hash,original_datetime_text,parsed_at,source_timezone,
           fx_date,marketplace_local_date,local_month,normalized_marketplace,original_sales_channel,currency,shipped_quantity
         ) VALUES($1,$2,2,digest($3,'sha256'),'2026-04-10','2026-04-10T00:00:00Z','UTC',
                  '2026-04-10','2026-04-10','2026-04-01',$4,'amazon.synthetic','USD',1)`,
        [currentVersionId, newFileId, `shipment-${storedObjectId}`, marketplace],
      );
    }
    let predecessorAcknowledgementId: string | null = null;
    if (options.priorAcknowledgement !== false) {
      predecessorAcknowledgementId = randomUUID();
      await pool.query(
        `INSERT INTO quality_acknowledgement(
           id,dataset_version_id,marketplace_policy_version_id,issue_kind,issue_code,
           actor_account_id,reason,confirmation_count
         ) VALUES($1,$2,$3,'HARD_INCOMPLETE',$4,$5,
                  'synthetic confirmed missing shipment',1)`,
        [predecessorAcknowledgementId, predecessorVersionId, oldPolicyId,
          options.priorIssueCode ?? "ACCOUNTANT_ACKNOWLEDGED", actorAccountId],
      );
      if (options.duplicateReplayAudit) {
        await pool.query(
          `INSERT INTO audit_event(actor_account_id,action,object_type,object_id,reason,metadata)
           VALUES($1,'ADMIN_SOURCE_REPLAY_CREATED','import_batch',$2,'duplicate synthetic replay',$3::jsonb)`,
          [actorAccountId, batchId, JSON.stringify({
            shopId,
            sourceMode: "CURRENT_BINDING_CLOSURE",
            completenessRuleVersion: "shipment-only-v1",
          })],
        );
      }
    }
    if (options.sourceReplay !== false) {
      await pool.query(
        `INSERT INTO audit_event(actor_account_id,action,object_type,object_id,reason,metadata)
         VALUES($1,'ADMIN_SOURCE_REPLAY_CREATED','import_batch',$2,'synthetic replay',$3::jsonb)`,
        [actorAccountId, batchId, JSON.stringify({
          shopId,
          sourceMode: "CURRENT_BINDING_CLOSURE",
          completenessRuleVersion: "shipment-only-v1",
        })],
      );
    }
    return { shopId, batchId, currentVersionId, predecessorVersionId, predecessorAcknowledgementId };
  }

  async function addUnacknowledgedIncompleteSlice(scenario: Scenario): Promise<string> {
    const sliceId = randomUUID();
    const versionId = randomUUID();
    await pool.query(
      "INSERT INTO dataset_slice(id,shop_id,normalized_marketplace,local_month) VALUES($1,$2,$3,'2026-05-01')",
      [sliceId, scenario.shopId, `BLOCK-${versionId.slice(0, 8).toUpperCase()}`],
    );
    await pool.query(
      `INSERT INTO dataset_version(
         id,dataset_slice_id,import_batch_id,version_no,status,manifest_sha256,activated_at,created_by
       ) VALUES($1::uuid,$2::uuid,$3::uuid,1,'INCOMPLETE',digest($1::uuid::text,'sha256'),clock_timestamp(),$4::uuid)`,
      [versionId, sliceId, scenario.batchId, actorAccountId],
    );
    await pool.query("UPDATE dataset_slice SET current_version_id=$2 WHERE id=$1", [sliceId, versionId]);
    return versionId;
  }

  it("rejects resume when an ACTIVE shop has reached its Shanghai close date", async () => {
    const scenario = await createScenario();
    await pool.query(
      "UPDATE shop SET close_date=timezone('Asia/Shanghai', clock_timestamp())::date WHERE id=$1",
      [scenario.shopId],
    );

    await expect(resumeFailedSourceReplay(pool, {
      shopId: scenario.shopId,
      batchId: scenario.batchId,
      actorAccountId,
      idempotencyKey: "expired-shop-resume",
      reason: "Prove that an expired shop cannot resume a source replay",
    })).rejects.toThrow("SOURCE_REPLAY_SHOP_NOT_ACTIVE");
  });

  it("adds a new audited acknowledgement and resumes the failed immutable replay exactly once", async () => {
    const scenario = await createScenario();
    const input = {
      shopId: scenario.shopId,
      batchId: scenario.batchId,
      actorAccountId,
      idempotencyKey: "resume-identical-transaction-only",
      reason: "Resume a synthetic replay after exact predecessor acknowledgement continuity checks",
    };

    await expect(resumeFailedSourceReplay(pool, input)).resolves.toEqual({
      importBatchId: scenario.batchId,
      status: "COMMITTED_WITH_EXCLUSIONS",
      inheritedAcknowledgementCount: 1,
      resumed: false,
    });
    const acknowledgement = await pool.query<{
      issue_code: string;
      actor_account_id: string;
      marketplace_policy_version_id: string;
      confirmation_count: number;
    }>(
      `SELECT issue_code,actor_account_id,marketplace_policy_version_id,confirmation_count
         FROM quality_acknowledgement
        WHERE dataset_version_id=$1 AND calculation_run_id IS NULL AND issue_kind='HARD_INCOMPLETE'`,
      [scenario.currentVersionId],
    );
    expect(acknowledgement.rows).toEqual([expect.objectContaining({
      issue_code: "SOURCE_REPLAY_INHERITED_HARD_INCOMPLETE",
      actor_account_id: actorAccountId,
      confirmation_count: 1,
    })]);
    const audits = await pool.query<{ action: string; metadata: Record<string, unknown> }>(
      `SELECT action,metadata FROM audit_event
        WHERE (action='SOURCE_REPLAY_HARD_INCOMPLETE_ACK_INHERITED' AND metadata->>'datasetVersionId'=$1)
           OR (action='ADMIN_SOURCE_REPLAY_RESUMED' AND object_id=$2)
        ORDER BY action`,
      [scenario.currentVersionId, scenario.batchId],
    );
    expect(audits.rows).toEqual([
      expect.objectContaining({ action: "ADMIN_SOURCE_REPLAY_RESUMED" }),
      expect.objectContaining({
        action: "SOURCE_REPLAY_HARD_INCOMPLETE_ACK_INHERITED",
        metadata: expect.objectContaining({
          batchId: scenario.batchId,
          datasetVersionId: scenario.currentVersionId,
          predecessorVersionId: scenario.predecessorVersionId,
          predecessorAcknowledgementId: scenario.predecessorAcknowledgementId,
          factIdentity: "FULL_TRANSACTION_FACT_MULTISET",
        }),
      }),
    ]);
    const outbox = await pool.query<{ count: string }>(
      "SELECT count(*)::text count FROM outbox_event WHERE topic='calculation.requested' AND payload->>'batchId'=$1",
      [scenario.batchId],
    );
    expect(outbox.rows[0]?.count).toBe("1");
    await expect(resumeFailedSourceReplay(pool, input)).resolves.toEqual({
      importBatchId: scenario.batchId,
      status: "COMMITTED_WITH_EXCLUSIONS",
      inheritedAcknowledgementCount: 1,
      resumed: true,
    });
    expect((await pool.query<{ count: string }>(
      "SELECT count(*)::text count FROM quality_acknowledgement WHERE dataset_version_id=$1 AND calculation_run_id IS NULL",
      [scenario.currentVersionId],
    )).rows[0]?.count).toBe("1");
  });

  it.each([
    ["ordinary import", { sourceReplay: false }],
    ["missing predecessor acknowledgement", { priorAcknowledgement: false }],
    ["changed transaction fact", { factChanged: true }],
    ["changed mapping", { mappingChanged: true }],
    ["changed policy", { policyChanged: true }],
    ["an inherited rather than explicit predecessor acknowledgement", { priorIssueCode: "SOURCE_REPLAY_INHERITED_HARD_INCOMPLETE" }],
    ["a new shipment fact", { currentShipmentFact: true }],
  ] as const)("does not inherit for %s", async (_label, options) => {
    const scenario = await createScenario(options);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await inheritSourceReplayHardAcknowledgements(client, scenario.batchId, actorAccountId);
      await client.query("COMMIT");
      expect(result.acknowledgementIds).toEqual([]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    expect((await pool.query<{ count: string }>(
      "SELECT count(*)::text count FROM quality_acknowledgement WHERE dataset_version_id=$1",
      [scenario.currentVersionId],
    )).rows[0]?.count).toBe("0");
  });

  it("does not multiply acknowledgements when duplicate replay audit rows exist", async () => {
    const scenario = await createScenario({ duplicateReplayAudit: true });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const inherited = await inheritSourceReplayHardAcknowledgements(client, scenario.batchId, actorAccountId);
      await client.query("COMMIT");
      expect(inherited.acknowledgementIds).toHaveLength(1);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    expect((await pool.query<{ count: string }>(
      "SELECT count(*)::text count FROM quality_acknowledgement WHERE dataset_version_id=$1",
      [scenario.currentVersionId],
    )).rows[0]?.count).toBe("1");
  });

  it("rolls back inherited acknowledgement, audit and outbox when any current incomplete slice remains unconfirmed", async () => {
    const scenario = await createScenario();
    await addUnacknowledgedIncompleteSlice(scenario);
    await expect(resumeFailedSourceReplay(pool, {
      shopId: scenario.shopId,
      batchId: scenario.batchId,
      actorAccountId,
      idempotencyKey: "resume-must-rollback",
      reason: "Synthetic all-or-nothing acknowledgement proof",
    })).rejects.toThrow("HARD_INCOMPLETE_CONFIRMATION_REQUIRED");

    expect((await pool.query<{ count: string }>(
      "SELECT count(*)::text count FROM quality_acknowledgement WHERE dataset_version_id=$1",
      [scenario.currentVersionId],
    )).rows[0]?.count).toBe("0");
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text count FROM audit_event
        WHERE (action='SOURCE_REPLAY_HARD_INCOMPLETE_ACK_INHERITED' AND metadata->>'batchId'=$1)
           OR (action='ADMIN_SOURCE_REPLAY_RESUMED' AND object_id=$1::uuid)`,
      [scenario.batchId],
    )).rows[0]?.count).toBe("0");
    expect((await pool.query<{ count: string }>(
      "SELECT count(*)::text count FROM outbox_event WHERE topic='calculation.requested' AND payload->>'batchId'=$1",
      [scenario.batchId],
    )).rows[0]?.count).toBe("0");
    expect((await pool.query<{ status: string; failure_code: string }>(
      "SELECT status,failure_code FROM import_batch WHERE id=$1",
      [scenario.batchId],
    )).rows[0]).toEqual({ status: "FAILED", failure_code: "HARD_INCOMPLETE_CONFIRMATION_REQUIRED" });
  });
});
