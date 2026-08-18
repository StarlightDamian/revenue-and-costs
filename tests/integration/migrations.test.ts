import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

const temporaryDirectories: string[] = [];

afterAll(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("forward migration runner", () => {
  let database: PostgresTestSchema | undefined;
  let first!: PostgresTestSchema["pool"];
  let second!: PostgresTestSchema["pool"];

  beforeAll(async () => {
    database = await createPostgresTestSchema({ migrate: false });
    first = database.pool;
    second = database.createPool();
  });

  afterAll(async () => { await database?.cleanup(); });

  it("serializes concurrent runners, is repeatable, and rejects checksum drift", async () => {
    await Promise.all([migrate(first), migrate(second)]);
      await expect(migrate(first)).resolves.toEqual([]);
      const status = await first.query<{ applied: string; duplicates: string }>(
        `SELECT count(*)::text AS applied,
                (count(*)-count(DISTINCT filename))::text AS duplicates
           FROM schema_migration`,
      );
      expect(Number(status.rows[0]?.applied ?? "0")).toBeGreaterThanOrEqual(49);
      expect(status.rows[0]?.duplicates).toBe("0");
      const enterpriseModel = await first.query<{
        invalid_roles: string; orphan_companies: string; invalid_wallet_owners: string; current_price: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM account_role WHERE role NOT IN ('ACCOUNTANT','ADMIN')) invalid_roles,
           (SELECT count(*)::text FROM shop WHERE enterprise_id IS NULL OR created_by_account_id IS NULL OR last_operated_by_account_id IS NULL) orphan_companies,
           (SELECT count(*)::text FROM wallet_account
             WHERE (owner_account_id IS NULL) = (enterprise_id IS NULL)) invalid_wallet_owners,
           (SELECT annual_price_cents::text FROM application_price_version price
             JOIN application app ON app.id=price.application_id
            WHERE app.code='amazon-sales-cost' ORDER BY price.effective_from DESC LIMIT 1) current_price`,
      );
      expect(enterpriseModel.rows[0]).toEqual({
        invalid_roles: "0", orphan_companies: "0", invalid_wallet_owners: "0", current_price: "18800",
      });
      const exportFormat = await first.query<{ column_default: string | null; pre_cutover_v2: string; unisolated_legacy: string }>(
        `SELECT c.column_default,
                (SELECT count(*)::text
                   FROM export_request
                  WHERE format_version='revenue-and-costs-export-v2') AS pre_cutover_v2,
                (SELECT count(*)::text
                   FROM export_request
                  WHERE format_version='revenue-and-costs-export-v1'
                    AND business_key<>'legacy-export:' || id::text) AS unisolated_legacy
           FROM information_schema.columns c
          WHERE c.table_schema=current_schema()
            AND c.table_name='export_request'
            AND c.column_name='format_version'`,
      );
      expect(exportFormat.rows[0]?.column_default).toBeNull();
      expect(exportFormat.rows[0]?.pre_cutover_v2).toBe("0");
      expect(exportFormat.rows[0]?.unisolated_legacy).toBe("0");
      const accountingColumns = await first.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM information_schema.columns
          WHERE table_schema=current_schema()
            AND ((table_name='account' AND column_name IN ('accounting_profit_rate','minimum_sales_cost_rate'))
              OR (table_name='export_request' AND column_name IN ('profit_rate','minimum_sales_cost_rate')))`
      );
      expect(accountingColumns.rows[0]?.count).toBe("4");
      const accountingPeriodContract = await first.query<{ columns: string; period_check: string; run_disposition_check: string; snapshot_disposition_check: string }>(
        `SELECT
           (SELECT count(*)::text FROM information_schema.columns
             WHERE table_schema=current_schema() AND table_name='import_batch'
               AND column_name IN ('accounting_period_start','accounting_period_end')) columns,
           (SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con
             JOIN pg_class relation ON relation.oid=con.conrelid
             JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
            WHERE namespace.nspname=current_schema() AND relation.relname='import_batch'
              AND con.conname='import_batch_accounting_period_scope_check') period_check,
           (SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con
             JOIN pg_class relation ON relation.oid=con.conrelid
             JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
            WHERE namespace.nspname=current_schema() AND relation.relname='calculation_run_slice'
              AND con.conname='calculation_run_slice_disposition_check') run_disposition_check,
           (SELECT pg_get_constraintdef(con.oid) FROM pg_constraint con
             JOIN pg_class relation ON relation.oid=con.conrelid
             JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
            WHERE namespace.nspname=current_schema() AND relation.relname='published_snapshot_slice'
              AND con.conname='published_snapshot_slice_disposition_check') snapshot_disposition_check`,
      );
      expect(accountingPeriodContract.rows[0]).toMatchObject({
        columns: "2",
        period_check: expect.stringContaining("date_trunc"),
        run_disposition_check: expect.stringContaining("OUT_OF_SCOPE"),
        snapshot_disposition_check: expect.stringContaining("OUT_OF_SCOPE"),
      });
      const fulfillmentContract = await first.query<{ is_nullable: string; definition: string }>(
        `SELECT column_info.is_nullable,pg_get_constraintdef(con.oid) definition
           FROM information_schema.columns column_info
           JOIN pg_constraint con ON con.conname='transaction_fact_fulfillment_mode_check'
           JOIN pg_class relation ON relation.oid=con.conrelid AND relation.relname='transaction_fact'
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace AND namespace.nspname=current_schema()
          WHERE column_info.table_schema=current_schema()
            AND column_info.table_name='transaction_fact'
            AND column_info.column_name='fulfillment_mode'`,
      );
        expect(fulfillmentContract.rows).toEqual([{
          is_nullable: "YES",
          definition: expect.stringContaining("fulfillment_mode"),
        }]);
        const feeClassificationContract = await first.query<{ column_default: string; definition: string }>(
          `SELECT column_info.column_default,pg_get_constraintdef(con.oid) definition
             FROM information_schema.columns column_info
             JOIN pg_constraint con ON con.conname='transaction_fee_component_classification_version_check'
             JOIN pg_class relation ON relation.oid=con.conrelid AND relation.relname='transaction_fee_component'
             JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace AND namespace.nspname=current_schema()
            WHERE column_info.table_schema=current_schema()
              AND column_info.table_name='transaction_fee_component'
              AND column_info.column_name='classification_version'`,
        );
        expect(feeClassificationContract.rows).toEqual([{
          column_default: "'transaction-fee-v1'::text",
          definition: expect.stringContaining("transaction-fee-v3"),
        }]);
        const feeRunContract = await first.query<{ column_default: string }>(
          `SELECT column_default FROM information_schema.columns
            WHERE table_schema=current_schema() AND table_name='calculation_run'
              AND column_name='fee_classification_version'`,
        );
        expect(feeRunContract.rows).toEqual([{ column_default: "'transaction-fee-v1'::text" }]);
        const protectedRunInputs = await first.query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM pg_trigger trigger
             JOIN pg_class relation ON relation.oid=trigger.tgrelid
             JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
            WHERE namespace.nspname=current_schema() AND relation.relname='calculation_run'
              AND trigger.tgname='calculation_run_inputs_immutable' AND NOT trigger.tgisinternal
           ) AS exists`,
        );
        expect(protectedRunInputs.rows).toEqual([{ exists: true }]);
      const australianPolicy = await first.query<{ timezone: string; mode: string }>(
        `SELECT iana_timezone timezone,date_attribution_mode mode
           FROM marketplace_policy_version
          WHERE normalized_marketplace='AU'
          ORDER BY effective_from DESC,id DESC LIMIT 1`,
      );
      expect(australianPolicy.rows).toEqual([{ timezone: "Australia/Sydney", mode: "REPORT_LITERAL_DATE" }]);
      const exportProgressColumns = await first.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM information_schema.columns
          WHERE table_schema=current_schema()
            AND table_name='export_request'
            AND column_name IN ('stage','progress_percent','processed_rows','total_rows','heartbeat_at')`,
      );
      expect(exportProgressColumns.rows[0]?.count).toBe("5");
      const outboxNotifyTrigger = await first.query<{ count: string }>(
        `SELECT count(*)::text count
           FROM pg_trigger trigger
           JOIN pg_class relation ON relation.oid=trigger.tgrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname=current_schema()
            AND relation.relname='outbox_event'
            AND trigger.tgname='outbox_event_notify_insert'
            AND NOT trigger.tgisinternal`,
      );
      expect(outboxNotifyTrigger.rows[0]?.count).toBe("1");
      const replicationOutboxTrigger = await first.query<{ count: string }>(
        `SELECT count(*)::text count
           FROM pg_trigger trigger
           JOIN pg_class relation ON relation.oid=trigger.tgrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname=current_schema()
            AND relation.relname='stored_object'
            AND trigger.tgname='stored_object_replication_outbox'
            AND NOT trigger.tgisinternal`,
      );
      expect(replicationOutboxTrigger.rows[0]?.count).toBe("1");
      const replicationObjectId = randomUUID();
      await first.query("BEGIN");
      try {
        await first.query(
          `INSERT INTO stored_object
             (id,object_kind,immutable_key,storage_path,plaintext_size,plaintext_sha256,ciphertext_sha256,
              encryption_format,encryption_context,verification_status)
           VALUES($1,'SOURCE',$2,$3,1,$4,$4,'AWS_ESDK_V2_FRAMED','{}'::jsonb,'LOCAL_VERIFIED')`,
          [replicationObjectId, `migration/${replicationObjectId}`, `migration/${replicationObjectId}.esdk`, "a".repeat(64)],
        );
        const replicationEvent = await first.query<{ topic: string; business_key: string; object_id: string }>(
          `SELECT topic,business_key,payload->>'objectId' AS object_id
             FROM outbox_event
            WHERE topic='storage.replicate' AND business_key=$1`,
          [replicationObjectId],
        );
        expect(replicationEvent.rows).toEqual([{
          topic: "storage.replicate",
          business_key: replicationObjectId,
          object_id: replicationObjectId,
        }]);
      } finally {
        await first.query("ROLLBACK");
      }
      const fxOffsetConstraint = await first.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(con.oid) definition
           FROM pg_constraint con
           JOIN pg_class relation ON relation.oid=con.conrelid
           JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
          WHERE namespace.nspname=current_schema()
            AND relation.relname='calculation_fx_usage'
            AND con.conname='calculation_fx_usage_hit_date_offset_check'`,
      );
      expect(fxOffsetConstraint.rows[0]?.definition).toMatch(/abs\(\(hit_date - requested_date\)\).*fallback_days/u);
      const marketplacePolicies = await first.query<{
        br_historical_count: string;
        br_timezone: string;
        sa_historical_size: string;
        sa_current_size: string;
        se_historical_size: string;
        se_current_size: string;
        current_non_literal_count: string;
        current_shanghai_count: string;
        current_policy_count: string;
        historical_shanghai_instant_count: string;
        source_timezone_mismatch_count: string;
        changed_size_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM marketplace_policy_version
             WHERE normalized_marketplace='BR'
               AND effective_from<='2026-08-07T08:24:59Z'::timestamptz) br_historical_count,
           (SELECT iana_timezone FROM marketplace_policy_version
             WHERE normalized_marketplace='BR'
               AND effective_from<='2026-08-07T08:25:00Z'::timestamptz
             ORDER BY effective_from DESC,id DESC LIMIT 1) br_timezone,
           (SELECT marketplace_size FROM marketplace_policy_version
             WHERE normalized_marketplace='SA'
               AND effective_from<='2026-08-07T08:24:59Z'::timestamptz
             ORDER BY effective_from DESC,id DESC LIMIT 1) sa_historical_size,
           (SELECT marketplace_size FROM marketplace_policy_version
             WHERE normalized_marketplace='SA'
               AND effective_from<='2026-08-07T08:25:00Z'::timestamptz
             ORDER BY effective_from DESC,id DESC LIMIT 1) sa_current_size,
           (SELECT marketplace_size FROM marketplace_policy_version
             WHERE normalized_marketplace='SE'
               AND effective_from<='2026-08-07T08:24:59Z'::timestamptz
             ORDER BY effective_from DESC,id DESC LIMIT 1) se_historical_size,
           (SELECT marketplace_size FROM marketplace_policy_version
             WHERE normalized_marketplace='SE'
               AND effective_from<='2026-08-07T08:25:00Z'::timestamptz
             ORDER BY effective_from DESC,id DESC LIMIT 1) se_current_size,
           (SELECT count(*)::text FROM (
              SELECT DISTINCT ON (normalized_marketplace) normalized_marketplace,date_attribution_mode
                FROM marketplace_policy_version
               ORDER BY normalized_marketplace,effective_from DESC,id DESC
            ) current_policy WHERE date_attribution_mode<>'REPORT_LITERAL_DATE') current_non_literal_count,
           (SELECT count(*)::text FROM (
              SELECT DISTINCT ON (normalized_marketplace) normalized_marketplace,iana_timezone
                FROM marketplace_policy_version
               ORDER BY normalized_marketplace,effective_from DESC,id DESC
            ) current_policy WHERE iana_timezone='Asia/Shanghai') current_shanghai_count,
           (SELECT count(DISTINCT normalized_marketplace)::text
              FROM marketplace_policy_version) current_policy_count,
           (SELECT count(*)::text FROM marketplace_policy_version
             WHERE iana_timezone='Asia/Shanghai'
               AND date_attribution_mode='INSTANT_TO_IANA_TIMEZONE') historical_shanghai_instant_count,
           (SELECT count(*)::text
              FROM (
                SELECT DISTINCT ON (normalized_marketplace) id,normalized_marketplace,iana_timezone
                  FROM marketplace_policy_version
                 ORDER BY normalized_marketplace,effective_from DESC,id DESC
              ) current_policy
              JOIN LATERAL (
                SELECT historical.iana_timezone
                  FROM marketplace_policy_version historical
                 WHERE historical.normalized_marketplace=current_policy.normalized_marketplace
                   AND historical.id<>current_policy.id
                   AND historical.iana_timezone<>'Asia/Shanghai'
                 ORDER BY historical.effective_from DESC,historical.id DESC LIMIT 1
              ) source_policy ON true
             WHERE current_policy.iana_timezone IS DISTINCT FROM source_policy.iana_timezone) source_timezone_mismatch_count,
           (SELECT count(*)::text FROM (
              SELECT normalized_marketplace,
                     (array_agg(marketplace_size ORDER BY effective_from DESC,id DESC))[1] latest_size,
                     (array_agg(marketplace_size ORDER BY effective_from DESC,id DESC))[2] previous_size
                FROM marketplace_policy_version
               GROUP BY normalized_marketplace
            ) policy_history
             WHERE previous_size IS NOT NULL
               AND latest_size IS DISTINCT FROM previous_size) changed_size_count`,
      );
      const marketplacePolicy = marketplacePolicies.rows[0];
      expect(marketplacePolicy).toMatchObject({
        br_historical_count: "0",
        br_timezone: "America/Sao_Paulo",
        sa_historical_size: "LARGE",
        sa_current_size: "SMALL",
        se_historical_size: "LARGE",
        se_current_size: "SMALL",
        current_non_literal_count: "0",
        current_shanghai_count: "0",
        source_timezone_mismatch_count: "0",
        changed_size_count: "0",
      });
      expect(Number(marketplacePolicy?.historical_shanghai_instant_count) + 1).toBe(
        Number(marketplacePolicy?.current_policy_count),
      );
      const listener = await first.connect();
      const outboxEventId = randomUUID();
      try {
        await listener.query("LISTEN revenue_costs_outbox");
        const notified = new Promise<boolean>((resolveNotification) => {
          const timeout = setTimeout(() => resolveNotification(false), 2_000);
          listener.once("notification", (message) => {
            clearTimeout(timeout);
            resolveNotification(message.channel === "revenue_costs_outbox");
          });
        });
        await first.query(
          `INSERT INTO outbox_event(id,topic,business_key,payload)
           VALUES($1::uuid,'migration.notify.test',$2,'{}'::jsonb)`,
          [outboxEventId, outboxEventId],
        );
        await expect(notified).resolves.toBe(true);
      } finally {
        await first.query("DELETE FROM outbox_event WHERE id=$1", [outboxEventId]);
        await listener.query("UNLISTEN revenue_costs_outbox");
        listener.release();
      }
      await first.query(
        `PREPARE export_scope_contract(uuid) AS
         SELECT to_char(ds.local_month,'YYYY-MM') AS "period",to_char(ds.local_month,'YYYY-MM') AS "month",
                ds.normalized_marketplace AS marketplace,ps.disposition,
                ps.dataset_version_id::text AS "datasetVersionId",
                COALESCE(
                  (SELECT tf.currency FROM transaction_fact tf WHERE tf.dataset_version_id=ps.dataset_version_id ORDER BY tf.id LIMIT 1),
                  (SELECT sf.currency FROM shipment_fact sf WHERE sf.dataset_version_id=ps.dataset_version_id ORDER BY sf.id LIMIT 1)
                ) AS currency
           FROM published_snapshot_slice ps
           JOIN dataset_slice ds ON ds.id=ps.dataset_slice_id
          WHERE ps.published_snapshot_id=$1
          ORDER BY ds.local_month,ds.normalized_marketplace`,
      );
      await first.query("DEALLOCATE export_scope_contract");

      const copyRoot = await mkdtemp(join(tmpdir(), "revenue-migrations-"));
      temporaryDirectories.push(copyRoot);
      const copiedMigrations = join(copyRoot, "migrations");
      await cp(resolve("migrations"), copiedMigrations, { recursive: true });
      await appendFile(join(copiedMigrations, "0001_core_audit_jobs.sql"), "\n-- prohibited history rewrite\n", "utf8");
      await expect(migrate(first, copiedMigrations)).rejects.toThrow("MIGRATION_CHECKSUM_MISMATCH:0001_core_audit_jobs.sql");
  });
});
