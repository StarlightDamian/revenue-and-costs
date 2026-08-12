import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { materializeImportSlices } from "../../src/modules/imports/postgres-commit";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

describe("source replay slice retirement", () => {
  let database: PostgresTestSchema | undefined;
  let pool!: PostgresTestSchema["pool"];

  beforeAll(async () => {
    database = await createPostgresTestSchema();
    pool = database.pool;
  });

  afterAll(async () => { await database?.cleanup(); });

  it("retires only a vanished slice whose complete source-object set was replayed", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO account(id,phone_e164,phone_verified_at)
        VALUES ('10000000-0000-4000-8000-000000000001','+8613800000001',clock_timestamp());

        INSERT INTO enterprise(id,name,normalized_name,created_by_account_id)
        VALUES ('20000000-0000-4000-8000-000000000001','合成企业','合成企业','10000000-0000-4000-8000-000000000001');

        INSERT INTO shop(id,application_id,owner_account_id,name,normalized_name,status,start_date,close_date,
                         enterprise_id,created_by_account_id,last_operated_by_account_id)
        SELECT '30000000-0000-4000-8000-000000000001',id,'10000000-0000-4000-8000-000000000001',
               '合成公司','合成公司','ACTIVE','2026-01-01','2027-01-01',
               '20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
               '10000000-0000-4000-8000-000000000001'
          FROM application WHERE code='amazon-sales-cost';

        INSERT INTO upload_batch(id,shop_id,created_by,status,expires_at)
        VALUES
          ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','READY',clock_timestamp()+interval '1 day'),
          ('40000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','READY',clock_timestamp()+interval '1 day');

        INSERT INTO import_batch(id,shop_id,upload_batch_id,status,current_stage,idempotency_key,created_by)
        VALUES
          ('50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','RESULT_PUBLISHED','PUBLISHED','old-source-set','10000000-0000-4000-8000-000000000001'),
          ('50000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','COMMITTING','COPY','replay-source-set','10000000-0000-4000-8000-000000000001');

        INSERT INTO field_mapping(id,report_kind,locale,name)
        VALUES ('60000000-0000-4000-8000-000000000001','SHIPMENT','synthetic','synthetic');
        INSERT INTO field_mapping_version(id,field_mapping_id,version_no,definition,definition_sha256,created_by,reason)
        VALUES ('61000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001',1,'{}',
                digest('{}','sha256'),'10000000-0000-4000-8000-000000000001','synthetic mapping');

        INSERT INTO stored_object(id,object_kind,owner_shop_id,immutable_key,storage_path,plaintext_size,
                                  plaintext_sha256,ciphertext_sha256,encryption_format,encryption_context,verification_status)
        VALUES
          ('70000000-0000-4000-8000-000000000001','SOURCE','30000000-0000-4000-8000-000000000001','object-a','synthetic/a',1,'a','ca','AWS_ESDK_V2_FRAMED','{}','LOCAL_VERIFIED'),
          ('70000000-0000-4000-8000-000000000002','SOURCE','30000000-0000-4000-8000-000000000001','object-b','synthetic/b',1,'b','cb','AWS_ESDK_V2_FRAMED','{}','LOCAL_VERIFIED'),
          ('70000000-0000-4000-8000-000000000003','SOURCE','30000000-0000-4000-8000-000000000001','object-c','synthetic/c',1,'c','cc','AWS_ESDK_V2_FRAMED','{}','LOCAL_VERIFIED'),
          ('70000000-0000-4000-8000-000000000004','SOURCE','30000000-0000-4000-8000-000000000001','object-d','synthetic/d',1,'d','cd','AWS_ESDK_V2_FRAMED','{}','LOCAL_VERIFIED');

        INSERT INTO import_file(id,import_batch_id,stored_object_id,relative_path,classification,parse_status,
                                mapping_version_id,sha256,size_bytes)
        VALUES
          ('80000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','old-a.csv','SHIPMENT','PARSED','61000000-0000-4000-8000-000000000001',digest('a','sha256'),1),
          ('80000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000002','old-b.csv','TRANSACTION','PARSED','61000000-0000-4000-8000-000000000001',digest('b','sha256'),1),
          ('80000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000003','old-c.csv','TRANSACTION','PARSED','61000000-0000-4000-8000-000000000001',digest('c','sha256'),1),
          ('80000000-0000-4000-8000-000000000004','50000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000004','old-d.csv','SHIPMENT','PARSED','61000000-0000-4000-8000-000000000001',digest('d','sha256'),1),
          ('81000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000001','replay-a.csv','SHIPMENT','PARSED','61000000-0000-4000-8000-000000000001',digest('a','sha256'),1),
          ('81000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000002','replay-b.csv','TRANSACTION','PARSED','61000000-0000-4000-8000-000000000001',digest('b','sha256'),1);

        INSERT INTO dataset_slice(id,shop_id,normalized_marketplace,local_month)
        VALUES
          ('90000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','CA','2026-07-01'),
          ('90000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001','US','2026-07-01'),
          ('90000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000001','MX','2026-07-01');
        INSERT INTO dataset_version(id,dataset_slice_id,import_batch_id,version_no,status,manifest_sha256,activated_at,created_by)
        VALUES
          ('91000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',1,'ACTIVE',digest('ca-old','sha256'),clock_timestamp(),'10000000-0000-4000-8000-000000000001'),
          ('91000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001',1,'ACTIVE',digest('us-old','sha256'),clock_timestamp(),'10000000-0000-4000-8000-000000000001'),
          ('91000000-0000-4000-8000-000000000003','90000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000001',1,'ACTIVE',digest('mx-old','sha256'),clock_timestamp(),'10000000-0000-4000-8000-000000000001');
        UPDATE dataset_slice SET current_version_id=CASE id
          WHEN '90000000-0000-4000-8000-000000000001' THEN '91000000-0000-4000-8000-000000000001'::uuid
          WHEN '90000000-0000-4000-8000-000000000002' THEN '91000000-0000-4000-8000-000000000002'::uuid
          ELSE '91000000-0000-4000-8000-000000000003'::uuid END;

        INSERT INTO dataset_source_binding(dataset_version_id,report_kind,import_file_id,mapping_version_id,coverage_start,coverage_end)
        VALUES
          ('91000000-0000-4000-8000-000000000001','SHIPMENT','80000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','2026-07-01','2026-07-31'),
          ('91000000-0000-4000-8000-000000000001','TRANSACTION','80000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-000000000001','2026-07-01','2026-07-31'),
          ('91000000-0000-4000-8000-000000000002','SHIPMENT','80000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000001','2026-07-01','2026-07-31'),
          ('91000000-0000-4000-8000-000000000002','TRANSACTION','80000000-0000-4000-8000-000000000003','61000000-0000-4000-8000-000000000001','2026-07-01','2026-07-31'),
          ('91000000-0000-4000-8000-000000000003','SHIPMENT','80000000-0000-4000-8000-000000000004','61000000-0000-4000-8000-000000000001','2026-07-01','2026-07-31');

        CREATE TEMP TABLE import_stage (
          report_kind text,file_id uuid,row_number bigint,row_hash bytea,date_text text,parsed_at timestamptz,source_timezone text,
          fx_date date,local_date date,local_month date,marketplace text,raw_marketplace text,order_id text,sku text,currency text,
          quantity numeric(30,8),type text,description text,fulfillment_mode text,product_sales numeric(30,8),product_sales_tax numeric(30,8),
          shipping_credits numeric(30,8),shipping_credits_tax numeric(30,8),gift_wrap_credits numeric(30,8),gift_wrap_credits_tax numeric(30,8),
          regulatory_fee numeric(30,8),tax_on_regulatory_fee numeric(30,8),promotional_rebates numeric(30,8),promotional_rebates_tax numeric(30,8),
          marketplace_withheld_tax numeric(30,8),selling_fees numeric(30,8),fba_fees numeric(30,8),other_transaction_fees numeric(30,8),
          other_amount numeric(30,8),product_price numeric(30,8),product_tax numeric(30,8),shipping_price numeric(30,8),shipping_tax numeric(30,8),
          gift_wrap_price numeric(30,8),gift_wrap_tax numeric(30,8),product_promotion_discount numeric(30,8),shipment_promotion_discount numeric(30,8)
        ) ON COMMIT DROP;
      `);

      const retired = await materializeImportSlices(
        client,
        "50000000-0000-4000-8000-000000000002",
        "10000000-0000-4000-8000-000000000001",
      );
      expect(retired).toEqual([{ marketplace: "CA", local_month: "2026-07-01", retired: true }]);

      const state = (await client.query<{
        marketplace: string; current_version_id: string; status: string; version_count: string;
        binding_count: string; fact_count: string; audit_count: string;
      }>(`
        SELECT slice.normalized_marketplace marketplace,slice.current_version_id::text,
               current_version.status,count(version.id)::text version_count,
               (SELECT count(*)::text FROM dataset_source_binding binding WHERE binding.dataset_version_id=slice.current_version_id) binding_count,
               ((SELECT count(*) FROM shipment_fact fact WHERE fact.dataset_version_id=slice.current_version_id)
                +(SELECT count(*) FROM transaction_fact fact WHERE fact.dataset_version_id=slice.current_version_id))::text fact_count,
               (SELECT count(*)::text FROM audit_event audit
                 WHERE audit.object_id=slice.current_version_id
                   AND audit.action='DATASET_SLICE_RETIRED_BY_SOURCE_REPLAY') audit_count
          FROM dataset_slice slice
          JOIN dataset_version current_version ON current_version.id=slice.current_version_id
          JOIN dataset_version version ON version.dataset_slice_id=slice.id
         WHERE slice.shop_id='30000000-0000-4000-8000-000000000001'
         GROUP BY slice.id,current_version.id
         ORDER BY slice.normalized_marketplace
      `)).rows;
      expect(state).toEqual([
        expect.objectContaining({ marketplace: "CA", status: "INCOMPLETE", version_count: "2", binding_count: "0", fact_count: "0", audit_count: "1" }),
        expect.objectContaining({ marketplace: "MX", current_version_id: "91000000-0000-4000-8000-000000000003", status: "ACTIVE", version_count: "1", audit_count: "0" }),
        expect.objectContaining({ marketplace: "US", current_version_id: "91000000-0000-4000-8000-000000000002", status: "ACTIVE", version_count: "1", audit_count: "0" }),
      ]);
      await expect(client.query("SELECT status FROM dataset_version WHERE id='91000000-0000-4000-8000-000000000001'"))
        .resolves.toMatchObject({ rows: [{ status: "SUPERSEDED" }] });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
