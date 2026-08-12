import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FinancialAccumulator } from "../../src/modules/calculation/financial.js";
import { insertFeeClassificationAudits } from "../../src/modules/calculation/postgres-runner.js";
import { materializeImportSlices } from "../../src/modules/imports/postgres-commit.js";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

describe("transaction-only FMB slice materialization", () => {
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

  interface SyntheticTransactionRow {
    readonly fulfillmentMode: string;
    readonly type?: string;
    readonly description?: string;
    readonly sellingFees?: string;
    readonly fbaFees?: string;
    readonly otherTransactionFees?: string;
    readonly other?: string;
  }

  async function materialize(modeRows: readonly (string | SyntheticTransactionRow)[]): Promise<{
    readonly status: string;
    readonly transactionQuantity: string;
    readonly feeComponents: readonly { source_column: string; category: string; classification_version: string }[];
  }> {
    const client = await pool.connect();
    try {
      const uploadBatchId = randomUUID();
      const importBatchId = randomUUID();
      const mappingId = randomUUID();
      const mappingVersionId = randomUUID();
      const storedObjectId = randomUUID();
      const importFileId = randomUUID();
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
      await client.query(
        `INSERT INTO field_mapping(id,report_kind,locale,name)
         VALUES($1,'TRANSACTION','synthetic',$2)`,
        [mappingId, `synthetic-${importBatchId}`],
      );
      await client.query(
        `INSERT INTO stored_object(id,object_kind,owner_shop_id,immutable_key,storage_path,plaintext_size,
                                   plaintext_sha256,ciphertext_sha256,encryption_format,encryption_context,verification_status)
         VALUES($1,'SOURCE',$2,$3,$4,1,'a','b','AWS_ESDK_V2_FRAMED','{}','LOCAL_VERIFIED')`,
        [storedObjectId, shopId, `key-${storedObjectId}`, `path-${storedObjectId}`],
      );
      await client.query(
        `INSERT INTO field_mapping_version(id,field_mapping_id,version_no,definition,definition_sha256,created_by,reason)
         VALUES($1,$2,1,'{}',digest($3,'sha256'),$4,'synthetic FMB test')`,
        [mappingVersionId, mappingId, `mapping-${importBatchId}`, actorAccountId],
      );
      await client.query(
        `INSERT INTO import_file(id,import_batch_id,stored_object_id,relative_path,classification,parse_status,mapping_version_id,sha256,size_bytes)
         VALUES($1,$2,$3,'synthetic.csv','TRANSACTION','PARSED',$4,digest($5,'sha256'),1)`,
        [importFileId, importBatchId, storedObjectId, mappingVersionId, `file-${importBatchId}`],
      );
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
      for (const [index, input] of modeRows.entries()) {
        const row = typeof input === "string" ? { fulfillmentMode: input } : input;
        await client.query(
          `INSERT INTO import_stage(report_kind,file_id,row_number,row_hash,date_text,parsed_at,source_timezone,fx_date,local_date,
                                    local_month,marketplace,raw_marketplace,currency,quantity,type,description,fulfillment_mode,
                                    selling_fees,fba_fees,other_transaction_fees,other_amount)
           VALUES('TRANSACTION',$1,$2,digest($3,'sha256'),'2026-04-10',clock_timestamp(),'America/Los_Angeles',
                  '2026-04-10','2026-04-10','2026-04-01','US','amazon.com','USD',1,$4,$5,$6,$7,$8,$9,$10)`,
          [importFileId, index + 1, `${importBatchId}-${index}`, row.type ?? "ORDER", row.description ?? "synthetic",
            row.fulfillmentMode, row.sellingFees ?? "0", row.fbaFees ?? "0", row.otherTransactionFees ?? "0", row.other ?? "0"],
        );
      }
      await materializeImportSlices(client, importBatchId, actorAccountId);
      const facts = await client.query<Record<string, string>>(
        `SELECT id::text,dataset_version_id::text,source_file_id::text,row_number::text,encode(row_hash,'hex') row_hash,
                normalized_marketplace,local_month::text,currency,fx_date::text,normalized_type,normalized_description,
                fulfillment_mode,selling_fees::text,fba_fees::text,other_transaction_fees::text,other_amount::text
           FROM transaction_fact WHERE source_file_id=$1 ORDER BY row_number`,
        [importFileId],
      );
      const accumulator = new FinancialAccumulator();
      const audits = facts.rows.flatMap((fact) => accumulator.classifyTransactionFees({
        id: fact.id!, type: fact.normalized_type!, description: fact.normalized_description!,
        amounts: {
          sellingFees: fact.selling_fees!, fbaFees: fact.fba_fees!, otherTransactionFees: fact.other_transaction_fees!, other: fact.other_amount!,
        },
      }));
      await insertFeeClassificationAudits(client, audits);
      const result = (await client.query<{ status: string; transaction_quantity: string }>(
        `SELECT version.status, reconciliation.transaction_quantity::text
           FROM dataset_version version
           JOIN reconciliation_result reconciliation ON reconciliation.dataset_version_id=version.id
          WHERE version.import_batch_id=$1`,
        [importBatchId],
      )).rows[0];
      const feeComponents = (await client.query<{ source_column: string; category: string; classification_version: string }>(
        `SELECT component.source_column,component.category,component.classification_version
           FROM transaction_fee_component component
           JOIN transaction_fact fact ON fact.id=component.transaction_fact_id
          WHERE fact.source_file_id=$1
          ORDER BY fact.row_number,component.source_column`,
        [importFileId],
      )).rows;
      await client.query("ROLLBACK");
      if (!result) throw new Error("FMB_SLICE_STATUS_MISSING");
      return { status: result.status, transactionQuantity: result.transaction_quantity, feeComponents };
    } finally {
      client.release();
    }
  }

  it("activates only a transaction slice whose order rows are all merchant fulfilled", async () => {
    await expect(materialize(["MERCHANT", "MERCHANT"])).resolves.toEqual({
      status: "ACTIVE",
      transactionQuantity: "0.00000000",
      feeComponents: [],
    });
    await expect(materialize(["MERCHANT", "AMAZON"])).resolves.toEqual({
      status: "INCOMPLETE",
      transactionQuantity: "1.00000000",
      feeComponents: [],
    });
    await expect(materialize(["MERCHANT", "BLANK"])).resolves.toEqual({
      status: "INCOMPLETE",
      transactionQuantity: "1.00000000",
      feeComponents: [],
    });
  });

  it("persists the v2 mutually-exclusive fee classification in PostgreSQL", async () => {
    const result = await materialize([
      { fulfillmentMode: "BLANK", sellingFees: "-1" },
      { fulfillmentMode: "BLANK", fbaFees: "-2" },
      { fulfillmentMode: "BLANK", description: "COST_OF_ADVERTISING", otherTransactionFees: "-3" },
      { fulfillmentMode: "BLANK", type: "FBA_INVENTORY_FEE", other: "-4" },
      { fulfillmentMode: "BLANK", type: "TRANSFER", other: "-5" },
      { fulfillmentMode: "BLANK", type: "DEBT", other: "-6" },
      { fulfillmentMode: "BLANK", other: "-7" },
    ]);

    expect(result.feeComponents).toEqual([
      { source_column: "selling_fees", category: "PLATFORM_FEE", classification_version: "transaction-fee-v2" },
      { source_column: "fba_fees", category: "FBA_FULFILLMENT_FEE", classification_version: "transaction-fee-v2" },
      { source_column: "other_transaction_fees", category: "ADVERTISING_FEE", classification_version: "transaction-fee-v2" },
      { source_column: "other_amount", category: "FBA_STORAGE_FEE", classification_version: "transaction-fee-v2" },
      { source_column: "other_amount", category: "EXCLUDED_TRANSFER_DEBT", classification_version: "transaction-fee-v2" },
      { source_column: "other_amount", category: "EXCLUDED_TRANSFER_DEBT", classification_version: "transaction-fee-v2" },
      { source_column: "other_amount", category: "OTHER_DEDUCTION", classification_version: "transaction-fee-v2" },
    ]);
  });
});
