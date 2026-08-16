import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDatabase } from "../../src/db/database.js";
import { FinancialAccumulator } from "../../src/modules/calculation/financial.js";
import { calculateRun, insertFeeClassificationAudits } from "../../src/modules/calculation/postgres-runner.js";
import { materializeImportSlices } from "../../src/modules/imports/postgres-commit.js";
import { PostgresReportService } from "../../src/modules/publishing/postgres-service.js";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

describe("one-sided slice materialization", () => {
  let database: PostgresTestSchema | undefined;
  let pool!: PostgresTestSchema["pool"];
  let actorAccountId: string;
  let shopId: string;

  beforeAll(async () => {
    database = await createPostgresTestSchema();
    pool = database.pool;
    actorAccountId = randomUUID();
    const enterpriseId = randomUUID();
    shopId = randomUUID();
    await pool.query(
      "INSERT INTO account(id,phone_e164,phone_verified_at) VALUES($1,'+8613900099999',clock_timestamp())",
      [actorAccountId],
    );
    await pool.query(
      `INSERT INTO enterprise(id,name,normalized_name,created_by_account_id)
       VALUES($1,'FMB synthetic enterprise','fmb synthetic enterprise',$2)`,
      [enterpriseId, actorAccountId],
    );
    await pool.query(
      `INSERT INTO shop(id,application_id,owner_account_id,name,normalized_name,status,start_date,close_date,
                        enterprise_id,created_by_account_id,last_operated_by_account_id)
       SELECT $1,id,$2,'FMB synthetic shop','fmb synthetic shop','ACTIVE','2026-01-01','2027-01-01',$3,$2,$2
         FROM application WHERE code='amazon-sales-cost'`,
      [shopId, actorAccountId, enterpriseId],
    );
  });

  afterAll(async () => { await database?.cleanup(); });

  interface SyntheticImportRow {
    readonly reportKind?: "SHIPMENT" | "TRANSACTION";
    readonly marketplace?: string;
    readonly currency?: string;
    readonly fulfillmentMode?: string;
    readonly type?: string;
    readonly description?: string;
    readonly quantity?: string;
    readonly productPrice?: string;
    readonly sellingFees?: string;
    readonly fbaFees?: string;
    readonly otherTransactionFees?: string;
    readonly other?: string;
  }

  async function materialize(
    modeRows: readonly (string | SyntheticImportRow)[],
    options: { readonly persist?: boolean } = {},
  ): Promise<{
    readonly importBatchId: string;
    readonly sliceId: string;
    readonly datasetVersionId: string;
    readonly status: string;
    readonly oneSidedCompleteReason: string | null;
    readonly manifestReasonRecognized: boolean;
    readonly shipmentQuantity: string | null;
    readonly transactionQuantity: string | null;
    readonly reconciliationApplicable: boolean;
    readonly reconciliationWarning: boolean;
    readonly shipmentIncome: string;
    readonly feeComponents: readonly { source_column: string; category: string; classification_version: string }[];
  }> {
    const client = await pool.connect();
    try {
      const uploadBatchId = randomUUID();
      const importBatchId = randomUUID();
      const normalizedRows = modeRows.map((input) => typeof input === "string" ? { fulfillmentMode: input } : input);
      const reportKinds = [...new Set(normalizedRows.map((row) => row.reportKind ?? "TRANSACTION"))];
      const sourceFileIds = new Map<string, string>();
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO upload_batch(id,shop_id,created_by,status,expires_at)
         VALUES($1,$2,$3,'READY',clock_timestamp()+interval '1 day')`,
        [uploadBatchId, shopId, actorAccountId],
      );
      await client.query(
        `INSERT INTO import_batch(id,shop_id,upload_batch_id,status,current_stage,idempotency_key,created_by)
         VALUES($1,$2,$3,'COMMITTING','COPY',$4,$5)`,
        [importBatchId, shopId, uploadBatchId, `fmb-${importBatchId}`, actorAccountId],
      );
      for (const reportKind of reportKinds) {
        const mappingId = randomUUID();
        const mappingVersionId = randomUUID();
        const storedObjectId = randomUUID();
        const importFileId = randomUUID();
        sourceFileIds.set(reportKind, importFileId);
        await client.query(
          `INSERT INTO field_mapping(id,report_kind,locale,name)
           VALUES($1,$2,'synthetic',$3)`,
          [mappingId, reportKind, `synthetic-${reportKind.toLowerCase()}-${importBatchId}`],
        );
        await client.query(
          `INSERT INTO stored_object(id,object_kind,owner_shop_id,immutable_key,storage_path,plaintext_size,
                                     plaintext_sha256,ciphertext_sha256,encryption_format,encryption_context,verification_status)
           VALUES($1,'SOURCE',$2,$3,$4,1,digest($5,'sha256'),digest($6,'sha256'),
                  'AWS_ESDK_V2_FRAMED','{}','LOCAL_VERIFIED')`,
          [storedObjectId, shopId, `key-${storedObjectId}`, `path-${storedObjectId}`,
            `plaintext-${storedObjectId}`, `ciphertext-${storedObjectId}`],
        );
        await client.query(
          `INSERT INTO field_mapping_version(id,field_mapping_id,version_no,definition,definition_sha256,created_by,reason)
           VALUES($1,$2,1,'{}',digest($3,'sha256'),$4,'synthetic FMB test')`,
          [mappingVersionId, mappingId, `mapping-${reportKind}-${importBatchId}`, actorAccountId],
        );
        await client.query(
          `INSERT INTO import_file(id,import_batch_id,stored_object_id,relative_path,classification,parse_status,mapping_version_id,sha256,size_bytes)
           VALUES($1,$2,$3,$4,$5,'PARSED',$6,digest($7,'sha256'),1)`,
          [importFileId, importBatchId, storedObjectId, `synthetic-${reportKind.toLowerCase()}.csv`, reportKind,
            mappingVersionId, `file-${reportKind}-${importBatchId}`],
        );
      }
      await client.query(
        `CREATE TEMP TABLE import_stage (
           report_kind text,file_id uuid,row_number bigint,row_hash bytea,date_text text,parsed_at timestamptz,source_timezone text,
           fx_date date,local_date date,local_month date,marketplace text,raw_marketplace text,order_id text,sku text,currency text,
           quantity numeric(30,8),type text,description text,fulfillment_mode text,
           product_sales numeric(30,8) DEFAULT 0,product_sales_tax numeric(30,8) DEFAULT 0,
           shipping_credits numeric(30,8) DEFAULT 0,shipping_credits_tax numeric(30,8) DEFAULT 0,
           gift_wrap_credits numeric(30,8) DEFAULT 0,gift_wrap_credits_tax numeric(30,8) DEFAULT 0,
           regulatory_fee numeric(30,8) DEFAULT 0,tax_on_regulatory_fee numeric(30,8) DEFAULT 0,
           promotional_rebates numeric(30,8) DEFAULT 0,promotional_rebates_tax numeric(30,8) DEFAULT 0,
           marketplace_withheld_tax numeric(30,8) DEFAULT 0,selling_fees numeric(30,8) DEFAULT 0,
           fba_fees numeric(30,8) DEFAULT 0,other_transaction_fees numeric(30,8) DEFAULT 0,other_amount numeric(30,8) DEFAULT 0,
           product_price numeric(30,8) DEFAULT 0,product_tax numeric(30,8) DEFAULT 0,shipping_price numeric(30,8) DEFAULT 0,
           shipping_tax numeric(30,8) DEFAULT 0,gift_wrap_price numeric(30,8) DEFAULT 0,gift_wrap_tax numeric(30,8) DEFAULT 0,
           product_promotion_discount numeric(30,8) DEFAULT 0,shipment_promotion_discount numeric(30,8) DEFAULT 0
         ) ON COMMIT DROP`,
      );
      for (const [index, row] of normalizedRows.entries()) {
        const reportKind = row.reportKind ?? "TRANSACTION";
        const sourceFileId = sourceFileIds.get(reportKind);
        if (!sourceFileId) throw new Error("SYNTHETIC_SOURCE_FILE_MISSING");
        await client.query(
          `INSERT INTO import_stage(report_kind,file_id,row_number,row_hash,date_text,parsed_at,source_timezone,fx_date,local_date,
                                    local_month,marketplace,raw_marketplace,currency,quantity,type,description,fulfillment_mode,
                                    selling_fees,fba_fees,other_transaction_fees,other_amount,product_price)
           VALUES($1,$2,$3,digest($4,'sha256'),'2026-04-10',clock_timestamp(),'America/Los_Angeles',
                  '2026-04-10','2026-04-10','2026-04-01',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [reportKind, sourceFileId, index + 1, `${importBatchId}-${index}`, row.marketplace ?? "US",
            row.marketplace === "BR" ? "amazon.com.br" : "amazon.com", row.currency ?? "USD", row.quantity ?? "1",
            row.type ?? "ORDER", row.description ?? "synthetic", row.fulfillmentMode ?? "BLANK",
            row.sellingFees ?? "0", row.fbaFees ?? "0", row.otherTransactionFees ?? "0", row.other ?? "0", row.productPrice ?? "0"],
        );
      }
      await materializeImportSlices(client, importBatchId, actorAccountId);
      const facts = await client.query<Record<string, string>>(
        `SELECT id::text,dataset_version_id::text,source_file_id::text,row_number::text,encode(row_hash,'hex') row_hash,
                normalized_marketplace,local_month::text,currency,fx_date::text,normalized_type,normalized_description,
                fulfillment_mode,selling_fees::text,fba_fees::text,other_transaction_fees::text,other_amount::text
           FROM transaction_fact WHERE source_file_id=ANY($1::uuid[]) ORDER BY row_number`,
        [[...sourceFileIds.values()]],
      );
      const accumulator = new FinancialAccumulator();
      const audits = facts.rows.flatMap((fact) => accumulator.classifyTransactionFees({
        id: fact.id!, type: fact.normalized_type!, description: fact.normalized_description!,
        amounts: {
          sellingFees: fact.selling_fees!, fbaFees: fact.fba_fees!, otherTransactionFees: fact.other_transaction_fees!, other: fact.other_amount!,
        },
      }));
      await insertFeeClassificationAudits(client, audits);
      const result = (await client.query<{
        slice_id: string;
        dataset_version_id: string;
        status: string;
        one_sided_complete_reason: string | null;
        manifest_reason_recognized: boolean;
        shipment_quantity: string | null;
        transaction_quantity: string | null;
        applicable: boolean;
        warning: boolean;
        shipment_income: string;
      }>(
        `SELECT slice.id::text slice_id,version.id::text dataset_version_id,version.status,
                manifest.reason one_sided_complete_reason,COALESCE(manifest.matched,false) manifest_reason_recognized,
                reconciliation.shipment_quantity::text,reconciliation.transaction_quantity::text,
                reconciliation.applicable,reconciliation.warning,
                COALESCE((SELECT sum(product_price)::text FROM shipment_fact WHERE dataset_version_id=version.id),'0.00000000') shipment_income
           FROM dataset_version version
           JOIN dataset_slice slice ON slice.id=version.dataset_slice_id
           JOIN reconciliation_result reconciliation ON reconciliation.dataset_version_id=version.id
           LEFT JOIN LATERAL (
             SELECT array_agg(DISTINCT binding.report_kind ORDER BY binding.report_kind) kinds
               FROM dataset_source_binding binding WHERE binding.dataset_version_id=version.id
           ) sources ON true
           LEFT JOIN LATERAL (
             SELECT candidate.reason,true matched
               FROM (VALUES ('SHIPMENT_ONLY'::text),('TRANSACTION_ONLY_FMB'::text),(NULL::text)) candidate(reason)
              WHERE version.manifest_sha256=digest(convert_to(jsonb_build_object(
                'batchId',version.import_batch_id::text,'sliceId',slice.id::text,
                'marketplace',slice.normalized_marketplace,'localMonth',slice.local_month::text,
                'kinds',to_jsonb(sources.kinds),'oneSidedCompleteReason',candidate.reason,
                'retiredBySourceReplay',false
              )::text,'UTF8'),'sha256')
           ) manifest ON true
          WHERE version.import_batch_id=$1`,
        [importBatchId],
      )).rows[0];
      const feeComponents = (await client.query<{ source_column: string; category: string; classification_version: string }>(
        `SELECT component.source_column,component.category,component.classification_version
           FROM transaction_fee_component component
           JOIN transaction_fact fact ON fact.id=component.transaction_fact_id
          WHERE fact.source_file_id=ANY($1::uuid[])
          ORDER BY fact.row_number,component.source_column`,
        [[...sourceFileIds.values()]],
      )).rows;
      if (!result) throw new Error("FMB_SLICE_STATUS_MISSING");
      await client.query(options.persist ? "COMMIT" : "ROLLBACK");
      return {
        importBatchId,
        sliceId: result.slice_id,
        datasetVersionId: result.dataset_version_id,
        status: result.status,
        oneSidedCompleteReason: result.one_sided_complete_reason,
        manifestReasonRecognized: result.manifest_reason_recognized,
        shipmentQuantity: result.shipment_quantity,
        transactionQuantity: result.transaction_quantity,
        reconciliationApplicable: result.applicable,
        reconciliationWarning: result.warning,
        shipmentIncome: result.shipment_income,
        feeComponents,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  it("activates only a transaction slice whose order rows are all merchant fulfilled", async () => {
    await expect(materialize(["MERCHANT", "MERCHANT"])).resolves.toMatchObject({
      status: "ACTIVE",
      oneSidedCompleteReason: "TRANSACTION_ONLY_FMB",
      manifestReasonRecognized: true,
      shipmentQuantity: null,
      transactionQuantity: null,
      reconciliationApplicable: false,
      reconciliationWarning: false,
      shipmentIncome: "0.00000000",
      feeComponents: [],
    });
    await expect(materialize(["MERCHANT", "AMAZON"])).resolves.toMatchObject({
      status: "INCOMPLETE",
      oneSidedCompleteReason: null,
      manifestReasonRecognized: true,
      shipmentQuantity: null,
      transactionQuantity: null,
      reconciliationApplicable: false,
      reconciliationWarning: false,
      shipmentIncome: "0.00000000",
      feeComponents: [],
    });
    await expect(materialize(["MERCHANT", "BLANK"])).resolves.toMatchObject({
      status: "INCOMPLETE",
      oneSidedCompleteReason: null,
      manifestReasonRecognized: true,
      shipmentQuantity: null,
      transactionQuantity: null,
      reconciliationApplicable: false,
      reconciliationWarning: false,
      shipmentIncome: "0.00000000",
      feeComponents: [],
    });
  });

  it("does not label an ordinary paired slice as one-sided", async () => {
    await expect(materialize([
      {
        reportKind: "SHIPMENT",
        marketplace: "BR",
        currency: "BRL",
        quantity: "2",
        productPrice: "100",
      },
      {
        reportKind: "TRANSACTION",
        marketplace: "BR",
        currency: "BRL",
        quantity: "2",
        fulfillmentMode: "AMAZON",
      },
    ])).resolves.toMatchObject({
      status: "ACTIVE",
      oneSidedCompleteReason: null,
      manifestReasonRecognized: true,
      shipmentQuantity: "2.00000000",
      transactionQuantity: "2.00000000",
      reconciliationApplicable: true,
      reconciliationWarning: false,
    });
  });

  it("keeps reconciliation warnings for unequal paired quantities", async () => {
    await expect(materialize([
      { reportKind: "SHIPMENT", marketplace: "BR", currency: "BRL", quantity: "2", productPrice: "10" },
      { reportKind: "TRANSACTION", marketplace: "BR", currency: "BRL", quantity: "1", fulfillmentMode: "AMAZON" },
    ])).resolves.toMatchObject({
      status: "ACTIVE",
      oneSidedCompleteReason: null,
      manifestReasonRecognized: true,
      shipmentQuantity: "2.00000000",
      transactionQuantity: "1.00000000",
      reconciliationApplicable: true,
      reconciliationWarning: true,
    });
  });

  it("calculates and publishes a shipment-only slice without inventing transaction facts", async () => {
    const materialized = await materialize([{
      reportKind: "SHIPMENT",
      marketplace: "BR",
      currency: "BRL",
      quantity: "2",
      productPrice: "123.45",
    }], { persist: true });
    expect(materialized).toMatchObject({
      status: "ACTIVE",
      oneSidedCompleteReason: "SHIPMENT_ONLY",
      manifestReasonRecognized: true,
      shipmentQuantity: null,
      transactionQuantity: null,
      reconciliationApplicable: false,
      reconciliationWarning: false,
      shipmentIncome: "123.45000000",
      feeComponents: [],
    });

    const transactionCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM transaction_fact WHERE dataset_version_id=$1",
      [materialized.datasetVersionId],
    );
    expect(transactionCount.rows[0]?.count).toBe("0");

    const fxSyncRunId = randomUUID();
    const fxSnapshotId = randomUUID();
    await pool.query(
      `INSERT INTO fx_sync_run(id,sync_kind,requested_from,requested_to,status,coverage_from,coverage_to,finished_at)
       VALUES($1,'MANUAL_RETRY','2026-04-10','2026-04-10','SUCCEEDED','2026-04-10','2026-04-10',clock_timestamp())`,
      [fxSyncRunId],
    );
    await pool.query(
      `INSERT INTO fx_raw_snapshot(id,sync_run_id,source_name,request_parameters,response_payload,response_sha256,http_status)
       VALUES($1,$2,'SyntheticChinaMoney','{}','{}',digest($3,'sha256'),200)`,
      [fxSnapshotId, fxSyncRunId, `shipment-only-${fxSnapshotId}`],
    );
    await pool.query(
      `INSERT INTO fx_sync_run_snapshot(sync_run_id,snapshot_id,page_number,request_parameters)
       VALUES($1,$2,1,'{}')`,
      [fxSyncRunId, fxSnapshotId],
    );
    await pool.query(
      `INSERT INTO fx_quote(snapshot_id,valid_date,base_currency,quote_currency,base_unit,rate,cny_currency,cny_per_unit)
       VALUES($1,'2026-04-10','BRL','CNY',1,1,'BRL',1)`,
      [fxSnapshotId],
    );
    await pool.query(
      `INSERT INTO fx_market_day(valid_date,status,evidence_type,snapshot_id,reason)
       VALUES('2026-04-10','OPEN','OFFICIAL_CALENDAR',$1,'synthetic shipment-only calculation')`,
      [fxSnapshotId],
    );

    const postgres = new PostgresDatabase(pool);
    const reports = new PostgresReportService(postgres, postgres);
    const requested = await reports.requestCalculation(shopId, {
      actorAccountId,
      idempotencyKey: `shipment-only-${materialized.importBatchId}`,
    });
    const runSlices = await pool.query<{
      slice_id: string;
      dataset_version_id: string;
      disposition: "INCLUDED" | "INCLUDED_WITH_WARNING" | "HARD_EXCLUDED";
    }>(
      `SELECT dataset_slice_id::text slice_id,dataset_version_id::text,disposition
         FROM calculation_run_slice WHERE calculation_run_id=$1`,
      [requested.runId],
    );
    expect(runSlices.rows).toEqual([{
      slice_id: materialized.sliceId,
      dataset_version_id: materialized.datasetVersionId,
      disposition: "INCLUDED",
    }]);

    await calculateRun(pool, requested.runId);
    const income = await pool.query<{ amount_original: string; amount_cny: string }>(
      `SELECT COALESCE(sum(amount_original),0)::text amount_original,
              COALESCE(sum(amount_cny),0)::text amount_cny
         FROM calculation_fact_result
        WHERE calculation_run_id=$1 AND dataset_version_id=$2
          AND fact_kind='SHIPMENT' AND component='INCOME'`,
      [requested.runId, materialized.datasetVersionId],
    );
    expect(income.rows[0]).toEqual({ amount_original: "123.45000000", amount_cny: "123.45000000" });

    const published = await reports.publish({
      calculationRunId: requested.runId,
      shopId,
      slices: runSlices.rows.map((slice) => ({
        sliceId: slice.slice_id,
        datasetVersionId: slice.dataset_version_id,
        disposition: slice.disposition,
      })),
    }, {
      actorAccountId,
      idempotencyKey: `publish-shipment-only-${materialized.importBatchId}`,
    }, { snapshotOnly: true });
    const publishedSlice = await pool.query<{ disposition: string }>(
      `SELECT disposition FROM published_snapshot_slice
        WHERE published_snapshot_id=$1 AND dataset_version_id=$2`,
      [published.snapshotId, materialized.datasetVersionId],
    );
    expect(publishedSlice.rows).toEqual([{ disposition: "INCLUDED" }]);
  });

  it("persists the v3 mutually-exclusive fee classification in PostgreSQL", async () => {
    const result = await materialize([
      { fulfillmentMode: "BLANK", sellingFees: "-1" },
      { fulfillmentMode: "BLANK", fbaFees: "-2" },
      { fulfillmentMode: "BLANK", description: "COST_OF_ADVERTISING", otherTransactionFees: "-3" },
      { fulfillmentMode: "BLANK", type: "FBA_INVENTORY_FEE", other: "-4" },
      { fulfillmentMode: "BLANK", type: "TRANSFER", other: "-5" },
      { fulfillmentMode: "BLANK", type: "DEBT", other: "-6" },
      { fulfillmentMode: "BLANK", other: "-7" },
      { fulfillmentMode: "BLANK", type: "FBA_INVENTORY_FEE_REVERSAL", other: "8" },
      { fulfillmentMode: "BLANK", type: "FBA_INVENTORY_FEE_CORRECTION", other: "-9" },
    ]);

    expect(result.feeComponents).toEqual([
      { source_column: "selling_fees", category: "PLATFORM_FEE", classification_version: "transaction-fee-v3" },
      { source_column: "fba_fees", category: "FBA_FULFILLMENT_FEE", classification_version: "transaction-fee-v3" },
      { source_column: "other_transaction_fees", category: "ADVERTISING_FEE", classification_version: "transaction-fee-v3" },
      { source_column: "other_amount", category: "FBA_STORAGE_FEE", classification_version: "transaction-fee-v3" },
      { source_column: "other_amount", category: "EXCLUDED_TRANSFER_DEBT", classification_version: "transaction-fee-v3" },
      { source_column: "other_amount", category: "EXCLUDED_TRANSFER_DEBT", classification_version: "transaction-fee-v3" },
      { source_column: "other_amount", category: "OTHER_DEDUCTION", classification_version: "transaction-fee-v3" },
      { source_column: "other_amount", category: "OTHER_DEDUCTION", classification_version: "transaction-fee-v3" },
      { source_column: "other_amount", category: "OTHER_DEDUCTION", classification_version: "transaction-fee-v3" },
    ]);
  });
});
