import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { migrate } from "../../src/db/migrate";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const temporaryDirectories: string[] = [];

afterAll(async () => Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe.skipIf(!databaseUrl)("forward migration runner", () => {
  it("serializes concurrent runners, is repeatable, and rejects checksum drift", async () => {
    const first = new Pool({ connectionString: databaseUrl });
    const second = new Pool({ connectionString: databaseUrl });
    try {
      await Promise.all([migrate(first), migrate(second)]);
      await expect(migrate(first)).resolves.toEqual([]);
      const status = await first.query<{ applied: string; duplicates: string }>(
        `SELECT count(*)::text AS applied,
                (count(*)-count(DISTINCT filename))::text AS duplicates
           FROM schema_migration`,
      );
      expect(Number(status.rows[0]?.applied ?? "0")).toBeGreaterThanOrEqual(42);
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
             ORDER BY effective_from DESC,id DESC LIMIT 1) se_current_size`,
      );
      expect(marketplacePolicies.rows[0]).toEqual({
        br_historical_count: "0",
        br_timezone: "America/Sao_Paulo",
        sa_historical_size: "LARGE",
        sa_current_size: "SMALL",
        se_historical_size: "LARGE",
        se_current_size: "SMALL",
      });
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
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });
});
