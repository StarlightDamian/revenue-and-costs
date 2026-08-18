import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresDatabase } from "../../src/db/database.js";
import type { Actor, SqlClient, TransactionRunner } from "../../src/modules/authorization/index.js";
import { calculateRun } from "../../src/modules/calculation/postgres-runner.js";
import { PostgresExportService } from "../../src/modules/exports/postgres.js";
import { PostgresReportService } from "../../src/modules/publishing/postgres-service.js";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

const FIXTURE = {
  accountId: "90000000-0000-4000-8000-000000000001",
  enterpriseId: "90000000-0000-4000-8000-000000000002",
  shopId: "90000000-0000-4000-8000-000000000003",
  uploadBatchId: "90000000-0000-4000-8000-000000000004",
  importBatchId: "90000000-0000-4000-8000-000000000005",
  mappingId: "90000000-0000-4000-8000-000000000006",
  mappingVersionId: "90000000-0000-4000-8000-000000000007",
  storedObjectId: "90000000-0000-4000-8000-000000000008",
  importFileId: "90000000-0000-4000-8000-000000000009",
  sliceId: "90000000-0000-4000-8000-000000000010",
  datasetVersionId: "90000000-0000-4000-8000-000000000011",
  policyId: "90000000-0000-4000-8000-000000000012",
  fxRunId: "90000000-0000-4000-8000-000000000013",
  fxSnapshotId: "90000000-0000-4000-8000-000000000014",
  oldSliceId: "90000000-0000-4000-8000-000000000015",
  oldDatasetVersionId: "90000000-0000-4000-8000-000000000016",
} as const;

async function seedPublishedReport(
  pool: PostgresTestSchema["pool"],
  reports: PostgresReportService,
): Promise<{ readonly runId: string; readonly snapshotId: string }> {
  await pool.query(
    "INSERT INTO account(id,phone_e164,phone_verified_at) VALUES($1,'+8613900066666',clock_timestamp())",
    [FIXTURE.accountId],
  );
  await pool.query(
    `INSERT INTO enterprise(id,name,normalized_name,created_by_account_id)
     VALUES($1,'Report acceptance enterprise','report acceptance enterprise',$2)`,
    [FIXTURE.enterpriseId, FIXTURE.accountId],
  );
  await pool.query(
    `INSERT INTO shop(id,application_id,owner_account_id,name,normalized_name,status,start_date,close_date,
                      enterprise_id,created_by_account_id,last_operated_by_account_id)
     SELECT $1,id,$2,'Report acceptance shop','report acceptance shop','ACTIVE','2026-01-01','2099-01-01',$3,$2,$2
       FROM application WHERE code='amazon-sales-cost'`,
    [FIXTURE.shopId, FIXTURE.accountId, FIXTURE.enterpriseId],
  );
  await pool.query(
    `INSERT INTO marketplace_policy_version(
       id,marketplace,normalized_marketplace,iana_timezone,marketplace_size,date_attribution_mode,
       effective_from,created_by,reason
     ) VALUES($1,'QA','QA','UTC','SMALL','REPORT_LITERAL_DATE','2020-01-01',$2,'isolated report acceptance')`,
    [FIXTURE.policyId, FIXTURE.accountId],
  );
  await pool.query(
    `INSERT INTO upload_batch(id,shop_id,created_by,status,expires_at)
     VALUES($1,$2,$3,'READY','2099-01-01')`,
    [FIXTURE.uploadBatchId, FIXTURE.shopId, FIXTURE.accountId],
  );
  await pool.query(
    `INSERT INTO import_batch(id,shop_id,upload_batch_id,status,current_stage,idempotency_key,created_by,
                              accounting_period_start,accounting_period_end)
     VALUES($1,$2,$3,'RESULT_PUBLISHED','PUBLISHED','report-acceptance-fixture',$4,'2026-04-01','2026-06-01')`,
    [FIXTURE.importBatchId, FIXTURE.shopId, FIXTURE.uploadBatchId, FIXTURE.accountId],
  );
  await pool.query(
    "INSERT INTO field_mapping(id,report_kind,locale,name) VALUES($1,'SHIPMENT','synthetic','report acceptance shipment')",
    [FIXTURE.mappingId],
  );
  await pool.query(
    `INSERT INTO field_mapping_version(id,field_mapping_id,version_no,definition,definition_sha256,created_by,reason)
     VALUES($1,$2,1,'{}',digest('report-acceptance-mapping','sha256'),$3,'isolated report acceptance')`,
    [FIXTURE.mappingVersionId, FIXTURE.mappingId, FIXTURE.accountId],
  );
  await pool.query(
    `INSERT INTO stored_object(id,object_kind,owner_shop_id,immutable_key,storage_path,plaintext_size,
                               plaintext_sha256,ciphertext_sha256,encryption_format,encryption_context,verification_status)
     VALUES($1,'SOURCE',$2,'report-acceptance/source','report-acceptance/source.enc',1,
            digest('report-acceptance-plain','sha256'),digest('report-acceptance-cipher','sha256'),
            'AWS_ESDK_V2_FRAMED','{}','LOCAL_VERIFIED')`,
    [FIXTURE.storedObjectId, FIXTURE.shopId],
  );
  await pool.query(
    `INSERT INTO import_file(id,import_batch_id,stored_object_id,relative_path,classification,parse_status,
                             mapping_version_id,sha256,size_bytes,read_row_count,inserted_row_count)
     VALUES($1,$2,$3,'shipment.csv','SHIPMENT','PARSED',$4,digest('report-acceptance-file','sha256'),1,1,1)`,
    [FIXTURE.importFileId, FIXTURE.importBatchId, FIXTURE.storedObjectId, FIXTURE.mappingVersionId],
  );
  await pool.query(
    "INSERT INTO dataset_slice(id,shop_id,normalized_marketplace,local_month) VALUES($1,$2,'QA','2026-04-01')",
    [FIXTURE.sliceId, FIXTURE.shopId],
  );
  await pool.query(
    `INSERT INTO dataset_version(
       id,dataset_slice_id,import_batch_id,version_no,status,manifest_sha256,activated_at,created_by,created_at
     ) VALUES($1,$2,$3,1,'ACTIVE',digest('report-acceptance-version','sha256'),'2026-04-10',$4,'2026-04-10')`,
    [FIXTURE.datasetVersionId, FIXTURE.sliceId, FIXTURE.importBatchId, FIXTURE.accountId],
  );
  await pool.query("UPDATE dataset_slice SET current_version_id=$2 WHERE id=$1", [FIXTURE.sliceId, FIXTURE.datasetVersionId]);
  await pool.query(
    `INSERT INTO dataset_source_binding(
       dataset_version_id,report_kind,import_file_id,mapping_version_id,coverage_start,coverage_end
     ) VALUES($1,'SHIPMENT',$2,$3,'2026-04-01','2026-04-30')`,
    [FIXTURE.datasetVersionId, FIXTURE.importFileId, FIXTURE.mappingVersionId],
  );
  await pool.query(
    `INSERT INTO shipment_fact(
       dataset_version_id,source_file_id,row_number,row_hash,original_datetime_text,parsed_at,source_timezone,
       fx_date,marketplace_local_date,local_month,normalized_marketplace,original_sales_channel,currency,
       shipped_quantity,product_price
     ) VALUES($1,$2,1,digest('report-acceptance-row','sha256'),'2026-04-10','2026-04-10','UTC',
              '2026-04-10','2026-04-10','2026-04-01','QA','synthetic.example','USD',1,123.45)`,
    [FIXTURE.datasetVersionId, FIXTURE.importFileId],
  );
  await pool.query(
    `INSERT INTO reconciliation_result(
       dataset_version_id,mapping_version_id,applicable,warning
     ) VALUES($1,$2,false,false)`,
    [FIXTURE.datasetVersionId, FIXTURE.mappingVersionId],
  );
  await pool.query(
    `INSERT INTO fx_sync_run(id,sync_kind,requested_from,requested_to,status,coverage_from,coverage_to,finished_at)
     VALUES($1,'MANUAL_RETRY','2026-04-10','2026-04-10','SUCCEEDED','2026-04-10','2026-04-10','2026-04-10')`,
    [FIXTURE.fxRunId],
  );
  await pool.query(
    `INSERT INTO fx_raw_snapshot(id,sync_run_id,source_name,request_parameters,response_payload,response_sha256,http_status)
     VALUES($1,$2,'SyntheticChinaMoney','{}','{}',digest('report-acceptance-fx','sha256'),200)`,
    [FIXTURE.fxSnapshotId, FIXTURE.fxRunId],
  );
  await pool.query(
    "INSERT INTO fx_sync_run_snapshot(sync_run_id,snapshot_id,page_number,request_parameters) VALUES($1,$2,1,'{}')",
    [FIXTURE.fxRunId, FIXTURE.fxSnapshotId],
  );
  await pool.query(
    `INSERT INTO fx_quote(snapshot_id,valid_date,base_currency,quote_currency,base_unit,rate,cny_currency,cny_per_unit)
     VALUES($1,'2026-04-10','USD','CNY',1,7,'USD',7)`,
    [FIXTURE.fxSnapshotId],
  );
  await pool.query(
    `INSERT INTO fx_market_day(valid_date,status,evidence_type,snapshot_id,reason)
     VALUES('2026-04-10','OPEN','OFFICIAL_CALENDAR',$1,'isolated report acceptance')`,
    [FIXTURE.fxSnapshotId],
  );

  const requested = await reports.requestCalculation(FIXTURE.shopId, {
    actorAccountId: FIXTURE.accountId,
    idempotencyKey: "report-acceptance-initial-calculation",
  });
  await calculateRun(pool, requested.runId);
  const slices = await pool.query<{
    slice_id: string;
    dataset_version_id: string;
    disposition: "INCLUDED" | "INCLUDED_WITH_WARNING" | "HARD_EXCLUDED";
  }>(
    `SELECT dataset_slice_id::text slice_id,dataset_version_id::text,disposition
       FROM calculation_run_slice WHERE calculation_run_id=$1 ORDER BY dataset_slice_id`,
    [requested.runId],
  );
  const published = await reports.publish({
    calculationRunId: requested.runId,
    shopId: FIXTURE.shopId,
    slices: slices.rows.map((slice) => ({
      sliceId: slice.slice_id,
      datasetVersionId: slice.dataset_version_id,
      disposition: slice.disposition,
    })),
  }, {
    actorAccountId: FIXTURE.accountId,
    idempotencyKey: "report-acceptance-initial-publish",
  }, { snapshotOnly: true });
  if (!published.snapshotId) throw new Error("REPORT_ACCEPTANCE_INITIAL_SNAPSHOT_MISSING");
  return { runId: requested.runId, snapshotId: published.snapshotId };
}

describe("published report acceptance database", () => {
  let testSchema: PostgresTestSchema | undefined;
  let pool!: PostgresTestSchema["pool"];
  let database!: PostgresDatabase;
  let reports!: PostgresReportService;
  let initial!: { readonly runId: string; readonly snapshotId: string };

  beforeAll(async () => {
    testSchema = await createPostgresTestSchema();
    pool = testSchema.pool;
    database = new PostgresDatabase(pool);
    reports = new PostgresReportService(database, database);
    initial = await seedPublishedReport(pool, reports);
  });

  afterAll(async () => { await testSchema?.cleanup(); });

  it("reads the isolated published pointer and proves calculation result keys are unique", async () => {
    const preview = await reports.getPreview(FIXTURE.shopId);
    const current = await reports.getCurrent(FIXTURE.shopId);
    const resultKeys = await pool.query<{ total: string; distinct_total: string }>(
      `SELECT count(*)::text AS total,
              count(DISTINCT (fact_kind,fact_id,source_column,component))::text AS distinct_total
         FROM calculation_fact_result WHERE calculation_run_id=$1`,
      [current.runId],
    );
    const snapshotSlices = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM published_snapshot_slice WHERE published_snapshot_id=$1",
      [current.snapshotId],
    );
    expect(preview).toMatchObject({ mode: "PUBLISHED", snapshotId: initial.snapshotId, canPublish: false });
    expect(current).toMatchObject({ mode: "PUBLISHED", snapshotId: initial.snapshotId, runId: initial.runId });
    expect(current.metrics).toHaveLength(9);
    expect(resultKeys.rows[0]!.total).not.toBe("0");
    expect(resultKeys.rows[0]!.total).toBe(resultKeys.rows[0]!.distinct_total);
    expect(snapshotSlices.rows[0]!.count).toBe(String(current.completeness.length));

    const trace = await pool.query<{ canonical_hash: string; recomputed_hash: string }>(
      `SELECT encode(integrity.canonical_manifest_sha256,'hex') AS canonical_hash,
              encode(digest(snapshot.manifest::text,'sha256'),'hex') AS recomputed_hash
         FROM published_snapshot snapshot
         JOIN published_snapshot_integrity integrity ON integrity.published_snapshot_id=snapshot.id
        WHERE snapshot.id=$1`,
      [current.snapshotId],
    );
    expect(trace.rows[0]?.canonical_hash).toBe(trace.rows[0]?.recomputed_hash);
  });

  it("builds a calculation manifest without mutating the isolated fixture", async () => {
    const rollbackTransactions: TransactionRunner = {
      async transaction<Result>(work: (client: SqlClient) => Promise<Result>): Promise<Result> {
        const connection = await pool.connect();
        try {
          await connection.query("BEGIN");
          const client: SqlClient = {
            async query<Row extends Record<string, unknown>>(sql: string, parameters?: readonly unknown[]) {
              const result = await connection.query(sql, parameters ? [...parameters] : undefined);
              return { rows: result.rows as Row[], rowCount: result.rowCount };
            },
          };
          const result = await work(client);
          await connection.query("ROLLBACK");
          return result;
        } catch (error) {
          await connection.query("ROLLBACK");
          throw error;
        } finally {
          connection.release();
        }
      },
    };
    const rollbackReports = new PostgresReportService(rollbackTransactions, database);
    await expect(rollbackReports.requestCalculation(FIXTURE.shopId, {
      actorAccountId: FIXTURE.accountId,
      idempotencyKey: "report-acceptance-rollback-validation",
    })).resolves.toMatchObject({ status: expect.stringMatching(/^(QUEUED|READY)$/u) });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text count FROM calculation_run WHERE shop_id=$1",
      [FIXTURE.shopId],
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });
  });

  it("recalculates and publishes a canonical snapshot without rewriting the previous snapshot", async () => {
    const before = (await pool.query<{ manifest_text: string; hash: string }>(
      "SELECT manifest::text manifest_text,encode(manifest_sha256,'hex') hash FROM published_snapshot WHERE id=$1",
      [initial.snapshotId],
    )).rows[0]!;
    await pool.query(
      "INSERT INTO dataset_slice(id,shop_id,normalized_marketplace,local_month) VALUES($1,$2,'QA','2025-06-01')",
      [FIXTURE.oldSliceId, FIXTURE.shopId],
    );
    await pool.query(
      `INSERT INTO dataset_version(
         id,dataset_slice_id,import_batch_id,version_no,status,manifest_sha256,activated_at,created_by,created_at
       ) VALUES($1,$2,$3,1,'ACTIVE',digest('report-acceptance-old-version','sha256'),'2025-06-10',$4,'2025-06-10')`,
      [FIXTURE.oldDatasetVersionId, FIXTURE.oldSliceId, FIXTURE.importBatchId, FIXTURE.accountId],
    );
    await pool.query("UPDATE dataset_slice SET current_version_id=$2 WHERE id=$1", [
      FIXTURE.oldSliceId,
      FIXTURE.oldDatasetVersionId,
    ]);
    await pool.query(
      `INSERT INTO shipment_fact(
         dataset_version_id,source_file_id,row_number,row_hash,original_datetime_text,parsed_at,source_timezone,
         fx_date,marketplace_local_date,local_month,normalized_marketplace,original_sales_channel,currency,
         shipped_quantity,product_price
       ) VALUES($1,$2,2,digest('report-acceptance-old-row','sha256'),'2025-06-10','2025-06-10','UTC',
                '2025-06-10','2025-06-10','2025-06-01','QA','synthetic.example','USD',1,999.00)`,
      [FIXTURE.oldDatasetVersionId, FIXTURE.importFileId],
    );
    const requested = await reports.requestCalculation(FIXTURE.shopId, {
      actorAccountId: FIXTURE.accountId,
      idempotencyKey: "report-acceptance-second-calculation",
      sourceImportBatchId: FIXTURE.importBatchId,
    });
    await calculateRun(pool, requested.runId);
    const slices = await pool.query<{
      slice_id: string;
      dataset_version_id: string;
      disposition: "INCLUDED" | "INCLUDED_WITH_WARNING" | "HARD_EXCLUDED" | "OUT_OF_SCOPE";
    }>(
      `SELECT dataset_slice_id::text slice_id,dataset_version_id::text,disposition
         FROM calculation_run_slice WHERE calculation_run_id=$1 ORDER BY dataset_slice_id`,
      [requested.runId],
    );
    const published = await reports.publish({
      calculationRunId: requested.runId,
      shopId: FIXTURE.shopId,
      slices: slices.rows.map((slice) => ({
        sliceId: slice.slice_id,
        datasetVersionId: slice.dataset_version_id,
        disposition: slice.disposition,
      })),
    }, {
      actorAccountId: FIXTURE.accountId,
      idempotencyKey: "report-acceptance-second-publish",
    }, { snapshotOnly: true });
    const trace = (await pool.query<{
      stored_hash: string;
      canonical_hash: string;
      recomputed_hash: string;
      policy_slices: string;
      total_slices: string;
    }>(
      `SELECT encode(snapshot.manifest_sha256,'hex') stored_hash,
              encode(integrity.canonical_manifest_sha256,'hex') canonical_hash,
              encode(digest(snapshot.manifest::text,'sha256'),'hex') recomputed_hash,
              (SELECT count(*)::text FROM jsonb_array_elements(snapshot.manifest->'slices') slice
                JOIN marketplace_policy_version policy
                 ON policy.id=(slice->>'marketplacePolicyVersionId')::uuid
                 AND policy.normalized_marketplace=slice->>'normalizedMarketplace'
                 AND policy.iana_timezone=slice->>'ianaTimezone'
                 AND policy.date_attribution_mode=slice->>'dateAttributionMode') policy_slices,
              jsonb_array_length(snapshot.manifest->'slices')::text total_slices
         FROM published_snapshot snapshot
         JOIN published_snapshot_integrity integrity ON integrity.published_snapshot_id=snapshot.id
        WHERE snapshot.id=$1`,
      [published.snapshotId],
    )).rows[0]!;
    expect(trace.stored_hash).toBe(trace.recomputed_hash);
    expect(trace.canonical_hash).toBe(trace.recomputed_hash);
    expect(trace.policy_slices).toBe(trace.total_slices);
    const current = await reports.getCurrent(FIXTURE.shopId);
    expect(current.snapshotId).toBe(published.snapshotId);
    expect(current.completeness).toEqual([
      expect.objectContaining({ month: "2026-04", disposition: "INCLUDED" }),
    ]);
    const frozenScope = await pool.query<{ local_month: string; disposition: string }>(
      `SELECT to_char(slice.local_month,'YYYY-MM') local_month,published_slice.disposition
         FROM published_snapshot_slice published_slice
         JOIN dataset_slice slice ON slice.id=published_slice.dataset_slice_id
        WHERE published_slice.published_snapshot_id=$1
        ORDER BY slice.local_month`,
      [published.snapshotId],
    );
    expect(frozenScope.rows).toEqual([
      { local_month: "2025-06", disposition: "OUT_OF_SCOPE" },
      { local_month: "2026-04", disposition: "INCLUDED" },
    ]);
    const calculatedMonths = await pool.query<{ local_month: string }>(
      `SELECT DISTINCT to_char(fact.local_month,'YYYY-MM') local_month
         FROM calculation_fact_result result
         JOIN shipment_fact fact ON result.fact_kind='SHIPMENT' AND fact.id=result.fact_id
        WHERE result.calculation_run_id=$1
        ORDER BY local_month`,
      [requested.runId],
    );
    expect(calculatedMonths.rows).toEqual([{ local_month: "2026-04" }]);
    const actor: Actor = {
      accountId: FIXTURE.accountId,
      status: "ACTIVE",
      roles: new Set(["ACCOUNTANT"]),
      enterpriseIds: new Set([FIXTURE.enterpriseId]),
    };
    const costPreview = await new PostgresExportService(
      pool as unknown as Pool,
      {} as never,
      "D:/tmp/report-acceptance-exports",
    ).previewCostAccounting(actor, FIXTURE.shopId);
    expect(costPreview.year).toBe("2026");
    expect(costPreview.rows[3]).toMatchObject({ period: "2026-04", incomeTotalCny: "864.15000000" });
    expect((await pool.query<{ manifest_text: string; hash: string }>(
      "SELECT manifest::text manifest_text,encode(manifest_sha256,'hex') hash FROM published_snapshot WHERE id=$1",
      [initial.snapshotId],
    )).rows[0]).toEqual(before);
  });
});
