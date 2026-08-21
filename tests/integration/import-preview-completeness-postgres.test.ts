import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresImportService } from "../../src/modules/imports/postgres-service.js";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

describe("import completeness source presence PostgreSQL projection", () => {
  let database: PostgresTestSchema | undefined;
  let pool!: PostgresTestSchema["pool"];

  beforeAll(async () => {
    database = await createPostgresTestSchema();
    pool = database.pool;
    await pool.query(`
      INSERT INTO account(id,phone_e164,phone_verified_at)
      VALUES ('10000000-0000-4000-8000-000000000001','+8613800000001',clock_timestamp());

      INSERT INTO enterprise(id,name,normalized_name,created_by_account_id)
      VALUES ('20000000-0000-4000-8000-000000000001','合成企业','合成企业','10000000-0000-4000-8000-000000000001');

      INSERT INTO shop(id,application_id,owner_account_id,name,normalized_name,status,start_date,close_date,
                       enterprise_id,created_by_account_id,last_operated_by_account_id)
      SELECT '30000000-0000-4000-8000-000000000001',id,'10000000-0000-4000-8000-000000000001',
             '合成店铺','合成店铺','ACTIVE','2026-01-01','2027-01-01',
             '20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
             '10000000-0000-4000-8000-000000000001'
        FROM application WHERE code='amazon-sales-cost';

      INSERT INTO upload_batch(id,shop_id,created_by,status,expires_at)
      VALUES ('40000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',
              '10000000-0000-4000-8000-000000000001','READY',clock_timestamp()+interval '1 day');

      INSERT INTO import_batch(id,shop_id,upload_batch_id,status,current_stage,idempotency_key,created_by)
      VALUES ('50000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001',
              '40000000-0000-4000-8000-000000000001','RESULT_PUBLISHED','PUBLISHED','source-presence',
              '10000000-0000-4000-8000-000000000001');

      INSERT INTO field_mapping(id,report_kind,locale,name) VALUES
        ('60000000-0000-4000-8000-000000000001','SHIPMENT','synthetic','shipment presence'),
        ('60000000-0000-4000-8000-000000000002','TRANSACTION','synthetic','transaction presence');
      INSERT INTO field_mapping_version(id,field_mapping_id,version_no,definition,definition_sha256,created_by,reason) VALUES
        ('61000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001',1,'{}',
         digest('shipment-presence','sha256'),'10000000-0000-4000-8000-000000000001','shipment source presence'),
        ('61000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000002',1,'{}',
         digest('transaction-presence','sha256'),'10000000-0000-4000-8000-000000000001','transaction source presence');

      INSERT INTO stored_object(id,object_kind,owner_shop_id,immutable_key,storage_path,plaintext_size,
                                plaintext_sha256,ciphertext_sha256,encryption_format,encryption_context,verification_status) VALUES
        ('70000000-0000-4000-8000-000000000001','SOURCE','30000000-0000-4000-8000-000000000001',
         'presence/ca-shipment','presence/ca-shipment.enc',1,digest('ca-shipment','sha256'),digest('ca-shipment-cipher','sha256'),
         'AWS_ESDK_V2_FRAMED','{}','LOCAL_VERIFIED'),
        ('70000000-0000-4000-8000-000000000002','SOURCE','30000000-0000-4000-8000-000000000001',
         'presence/mx-transaction','presence/mx-transaction.enc',1,digest('mx-transaction','sha256'),digest('mx-transaction-cipher','sha256'),
         'AWS_ESDK_V2_FRAMED','{}','LOCAL_VERIFIED'),
        ('70000000-0000-4000-8000-000000000003','SOURCE','30000000-0000-4000-8000-000000000001',
         'presence/us-transaction','presence/us-transaction.enc',1,digest('us-transaction','sha256'),digest('us-transaction-cipher','sha256'),
         'AWS_ESDK_V2_FRAMED','{}','LOCAL_VERIFIED');

      INSERT INTO import_file(id,import_batch_id,stored_object_id,relative_path,classification,parse_status,
                              mapping_version_id,sha256,size_bytes) VALUES
        ('80000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',
         '70000000-0000-4000-8000-000000000001','CA/shipment.csv','SHIPMENT','PARSED',
         '61000000-0000-4000-8000-000000000001',digest('ca-file','sha256'),1),
        ('80000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001',
         '70000000-0000-4000-8000-000000000002','MX/transaction.csv','TRANSACTION','PARSED',
         '61000000-0000-4000-8000-000000000002',digest('mx-file','sha256'),1),
        ('80000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000001',
         '70000000-0000-4000-8000-000000000003','US/transaction.csv','TRANSACTION','PARSED',
         '61000000-0000-4000-8000-000000000002',digest('us-file','sha256'),1);

      INSERT INTO dataset_slice(id,shop_id,normalized_marketplace,local_month) VALUES
        ('90000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','CA','2026-04-01'),
        ('90000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001','MX','2026-04-01'),
        ('90000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000001','US','2026-04-01');
      INSERT INTO dataset_version(id,dataset_slice_id,import_batch_id,version_no,status,manifest_sha256,activated_at,created_by) VALUES
        ('91000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',
         '50000000-0000-4000-8000-000000000001',1,'ACTIVE',digest('ca-version','sha256'),clock_timestamp(),'10000000-0000-4000-8000-000000000001'),
        ('91000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000002',
         '50000000-0000-4000-8000-000000000001',1,'ACTIVE',digest('mx-version','sha256'),clock_timestamp(),'10000000-0000-4000-8000-000000000001'),
        ('91000000-0000-4000-8000-000000000003','90000000-0000-4000-8000-000000000003',
         '50000000-0000-4000-8000-000000000001',1,'INCOMPLETE',digest('us-version','sha256'),clock_timestamp(),'10000000-0000-4000-8000-000000000001');
      UPDATE dataset_slice SET current_version_id=CASE id
        WHEN '90000000-0000-4000-8000-000000000001' THEN '91000000-0000-4000-8000-000000000001'::uuid
        WHEN '90000000-0000-4000-8000-000000000002' THEN '91000000-0000-4000-8000-000000000002'::uuid
        ELSE '91000000-0000-4000-8000-000000000003'::uuid END;

      INSERT INTO dataset_source_binding(dataset_version_id,report_kind,import_file_id,mapping_version_id,coverage_start,coverage_end) VALUES
        ('91000000-0000-4000-8000-000000000001','SHIPMENT','80000000-0000-4000-8000-000000000001',
         '61000000-0000-4000-8000-000000000001','2026-04-01','2026-04-30'),
        ('91000000-0000-4000-8000-000000000002','TRANSACTION','80000000-0000-4000-8000-000000000002',
         '61000000-0000-4000-8000-000000000002','2026-04-01','2026-04-30'),
        ('91000000-0000-4000-8000-000000000003','TRANSACTION','80000000-0000-4000-8000-000000000003',
         '61000000-0000-4000-8000-000000000002','2026-04-01','2026-04-30');

      INSERT INTO shipment_fact(dataset_version_id,source_file_id,row_number,row_hash,original_datetime_text,parsed_at,
                                source_timezone,fx_date,marketplace_local_date,local_month,normalized_marketplace,
                                original_sales_channel,currency,shipped_quantity)
      VALUES ('91000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001',1,
              digest('ca-row','sha256'),'2026-04-10','2026-04-10','UTC','2026-04-10','2026-04-10','2026-04-01',
              'CA','synthetic.example','CAD',1);
      INSERT INTO transaction_fact(dataset_version_id,source_file_id,row_number,row_hash,original_datetime_text,parsed_at,
                                   source_timezone,fx_date,marketplace_local_date,local_month,normalized_marketplace,
                                   normalized_type,normalized_description,currency,fulfillment_mode)
      VALUES ('91000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000002',1,
              digest('mx-row','sha256'),'2026-04-10','2026-04-10','UTC','2026-04-10','2026-04-10','2026-04-01',
              'MX','ORDER','pure FMB','MXN','MERCHANT');
    `);
  });

  afterAll(async () => { await database?.cleanup(); });

  it("keeps binding presence separate from single-source calculability", async () => {
    const service = new PostgresImportService({ transaction: vi.fn() } as never, pool as never);

    await expect(service.getCompleteness("30000000-0000-4000-8000-000000000001")).resolves.toEqual([
      expect.objectContaining({
        marketplace: "CA",
        state: "COMPLETE",
        shipmentSourceCount: "1",
        transactionSourceCount: "0",
        shipmentQuantity: null,
        transactionQuantity: null,
        missingReports: [],
      }),
      expect.objectContaining({
        marketplace: "MX",
        state: "COMPLETE",
        shipmentSourceCount: "0",
        transactionSourceCount: "1",
        shipmentQuantity: null,
        transactionQuantity: null,
        missingReports: [],
      }),
      expect.objectContaining({
        marketplace: "US",
        state: "MISSING_SHIPMENT",
        shipmentSourceCount: "0",
        transactionSourceCount: "1",
        missingReports: ["SHIPMENT"],
      }),
    ]);
  });
});
