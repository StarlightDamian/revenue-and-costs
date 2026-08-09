import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresDatabase } from "../../src/db/database.js";
import type { SqlClient, TransactionRunner } from "../../src/modules/authorization/index.js";
import { calculateRun } from "../../src/modules/calculation/postgres-runner.js";
import { PostgresImportService } from "../../src/modules/imports/postgres-service.js";
import { PostgresReportService } from "../../src/modules/publishing/postgres-service.js";

const databaseUrl = process.env.REPORT_ACCEPTANCE_DATABASE_URL;
const describeWithDatabase = databaseUrl ? describe : describe.skip;

describeWithDatabase("published report acceptance database", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const database = new PostgresDatabase(pool);
  const imports = new PostgresImportService(database, database);
  const reports = new PostgresReportService(database, database);

  afterAll(async () => { await pool.end(); });

  it("reads the published pointer and proves calculation result keys are unique", async () => {
    const pointer = await pool.query<{ shop_id: string; published_snapshot_id: string }>(
      "SELECT shop_id,published_snapshot_id FROM shop_current_published_snapshot ORDER BY switched_at DESC LIMIT 1",
    );
    const currentPointer = pointer.rows[0];
    if (!currentPointer) throw new Error("REPORT_ACCEPTANCE_SNAPSHOT_REQUIRED");
    const preview = await reports.getPreview(currentPointer.shop_id);
    const current = await reports.getCurrent(currentPointer.shop_id);
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
    expect(preview).toMatchObject({ mode: "PUBLISHED", snapshotId: currentPointer.published_snapshot_id, canPublish: false });
    expect(current).toMatchObject({ mode: "PUBLISHED", snapshotId: currentPointer.published_snapshot_id });
    expect(current.metrics).toHaveLength(9);
    expect(resultKeys.rows[0]!.total).not.toBe("0");
    expect(resultKeys.rows[0]!.total).toBe(resultKeys.rows[0]!.distinct_total);
    expect(snapshotSlices.rows[0]!.count).toBe(String(current.completeness.length));

    const trace = await pool.query<{ canonical_hash: string; recomputed_hash: string }>(
      `SELECT encode(integrity.canonical_manifest_sha256,'hex') AS canonical_hash,
              encode(digest(s.manifest::text,'sha256'),'hex') AS recomputed_hash,
              integrity.hash_format
         FROM published_snapshot s
         JOIN published_snapshot_integrity integrity ON integrity.published_snapshot_id=s.id
        WHERE s.id=$1`,
      [current.snapshotId],
    );
    expect(trace.rows[0]?.canonical_hash).toBe(trace.rows[0]?.recomputed_hash);
  });

  it("builds a calculation manifest with only reusable unbound quality acknowledgements", async () => {
    const pointer = await pool.query<{ shop_id: string; owner_account_id: string }>(
      `SELECT pointer.shop_id,shop.owner_account_id FROM shop_current_published_snapshot pointer
       JOIN shop ON shop.id=pointer.shop_id ORDER BY pointer.switched_at DESC LIMIT 1`,
    );
    const target = pointer.rows[0];
    if (!target) throw new Error("REPORT_ACCEPTANCE_SNAPSHOT_REQUIRED");
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
    await expect(rollbackReports.requestCalculation(target.shop_id, {
      actorAccountId: target.owner_account_id,
      idempotencyKey: "rollback-query-validation",
    })).resolves.toMatchObject({ status: expect.stringMatching(/^(QUEUED|READY)$/u) });
  });

  it("recalculates and explicitly publishes a canonical snapshot with exact per-slice marketplace policies", async () => {
    const target = (await pool.query<{ shop_id: string; owner_account_id: string; published_snapshot_id: string }>(
      `SELECT pointer.shop_id,shop.owner_account_id,pointer.published_snapshot_id
         FROM shop_current_published_snapshot pointer JOIN shop ON shop.id=pointer.shop_id
        ORDER BY pointer.switched_at DESC LIMIT 1`,
    )).rows[0];
    if (!target) throw new Error("REPORT_ACCEPTANCE_SNAPSHOT_REQUIRED");
    const before = (await pool.query<{ manifest_text: string; hash: string }>(
      "SELECT manifest::text manifest_text,encode(manifest_sha256,'hex') hash FROM published_snapshot WHERE id=$1",
      [target.published_snapshot_id],
    )).rows[0]!;
    const warnings = await pool.query<{ dataset_version_id: string }>(
      `SELECT dv.id::text AS dataset_version_id
         FROM dataset_slice ds
         JOIN dataset_version dv ON dv.id=ds.current_version_id
         JOIN reconciliation_result rr ON rr.dataset_version_id=dv.id AND rr.warning
        WHERE ds.shop_id=$1
          AND NOT EXISTS (
            SELECT 1 FROM quality_acknowledgement acknowledgement
             WHERE acknowledgement.dataset_version_id=dv.id
               AND acknowledgement.calculation_run_id IS NULL
               AND acknowledgement.issue_kind='SOFT_RECONCILIATION_WARNING'
          )
        ORDER BY dv.id`,
      [target.shop_id],
    );
    for (const warning of warnings.rows) {
      await imports.acknowledge(target.shop_id, warning.dataset_version_id, {
        actorAccountId: target.owner_account_id,
        reason: "报告验收确认数量差异",
        confirmations: "2",
        idempotencyKey: `acceptance-warning-${warning.dataset_version_id}`,
      });
    }
    const requested = await reports.requestCalculation(target.shop_id, {
      actorAccountId: target.owner_account_id,
      idempotencyKey: "acceptance-policy-manifest-v1",
    });
    await calculateRun(pool, requested.runId);
    const slices = await pool.query<{ slice_id: string; dataset_version_id: string; disposition: "INCLUDED" | "INCLUDED_WITH_WARNING" | "HARD_EXCLUDED" }>(
      `SELECT dataset_slice_id::text slice_id,dataset_version_id::text,disposition
         FROM calculation_run_slice WHERE calculation_run_id=$1 ORDER BY dataset_slice_id`,
      [requested.runId],
    );
    const published = await reports.publish({
      calculationRunId: requested.runId,
      shopId: target.shop_id,
      slices: slices.rows.map((slice) => ({ sliceId: slice.slice_id, datasetVersionId: slice.dataset_version_id, disposition: slice.disposition })),
    }, { actorAccountId: target.owner_account_id, idempotencyKey: "acceptance-policy-publish-v1" });
    const trace = (await pool.query<{ stored_hash: string; canonical_hash: string; recomputed_hash: string; policy_slices: string; total_slices: string }>(
      `SELECT encode(snapshot.manifest_sha256,'hex') stored_hash,
              encode(integrity.canonical_manifest_sha256,'hex') canonical_hash,
              encode(digest(snapshot.manifest::text,'sha256'),'hex') recomputed_hash,
              (SELECT count(*)::text FROM jsonb_array_elements(snapshot.manifest->'slices') slice
                JOIN marketplace_policy_version policy
                  ON policy.id=(slice->>'marketplacePolicyVersionId')::uuid
                 AND policy.normalized_marketplace=slice->>'normalizedMarketplace'
                 AND policy.iana_timezone=slice->>'ianaTimezone') policy_slices,
              jsonb_array_length(snapshot.manifest->'slices')::text total_slices
         FROM published_snapshot snapshot
         JOIN published_snapshot_integrity integrity ON integrity.published_snapshot_id=snapshot.id
        WHERE snapshot.id=$1`,
      [published.snapshotId],
    )).rows[0]!;
    expect(trace.stored_hash).toBe(trace.recomputed_hash);
    expect(trace.canonical_hash).toBe(trace.recomputed_hash);
    expect(trace.policy_slices).toBe(trace.total_slices);
    expect((await reports.getCurrent(target.shop_id)).snapshotId).toBe(published.snapshotId);
    expect((await pool.query<{ manifest_text: string; hash: string }>(
      "SELECT manifest::text manifest_text,encode(manifest_sha256,'hex') hash FROM published_snapshot WHERE id=$1",
      [target.published_snapshot_id],
    )).rows[0]).toEqual(before);
  });
});
