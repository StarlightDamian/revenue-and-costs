import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { SqlClient, TransactionRunner } from "../authorization/index.js";
import { FEE_CLASSIFICATION_POLICY_SHA256, FEE_CLASSIFICATION_VERSION } from "../calculation/fee-classification.js";
import type { ReportFilter } from "./publish.js";
import { INTERMEDIATE_REPORT_COLUMNS, SHIPMENT_AMOUNT_KEYS, type IntermediateFilter, type IntermediateReportKind } from "../../shared/intermediate-report.js";
import { publishSnapshot, type CalculationRunForPublishing, type PublishStore, type PublishTransaction, type SnapshotManifest, type SnapshotSliceInput } from "./publish.js";

function shaHex(value: string): string { return createHash("sha256").update(value).digest("hex"); }

const CALCULATION_FORMULA_VERSION = "revenue-cost-v6";
const CALCULATION_CODE_VERSION = "local-v8";
const FX_DATE_RULE_VERSION = "next-business-day-v2";

type ResolvedCalculationRunSlice = {
  readonly sliceId: string;
  readonly versionId: string;
  readonly disposition: "INCLUDED" | "INCLUDED_WITH_WARNING" | "HARD_EXCLUDED";
  readonly mappings: readonly string[];
  readonly hardReasonCodes: readonly string[];
  readonly hardAcknowledgementId: string | null;
  readonly softAcknowledgementId: string | null;
};

export async function insertCalculationRunSlices(
  client: SqlClient,
  runId: string,
  slices: readonly ResolvedCalculationRunSlice[],
): Promise<void> {
  if (!slices.length) return;
  const rows = slices.map((slice) => ({
    slice_id: slice.sliceId,
    version_id: slice.versionId,
    disposition: slice.disposition,
    mappings: slice.mappings,
    hard_reason_codes: slice.hardReasonCodes,
    hard_ack: slice.hardAcknowledgementId,
    soft_ack: slice.softAcknowledgementId,
  }));
  await client.query(
    `INSERT INTO calculation_run_slice(calculation_run_id,dataset_slice_id,dataset_version_id,disposition,mapping_version_ids,
       hard_reason_codes,hard_exclusion_acknowledgement_id,soft_warning_acknowledgement_id)
     SELECT $1::uuid,input.slice_id,input.version_id,input.disposition,input.mappings,input.hard_reason_codes,input.hard_ack,input.soft_ack
       FROM jsonb_to_recordset($2::jsonb) AS input(
         slice_id uuid,version_id uuid,disposition text,mappings uuid[],hard_reason_codes text[],hard_ack uuid,soft_ack uuid
       )
     ON CONFLICT DO NOTHING`,
    [runId, JSON.stringify(rows)],
  );
}

const REPORT_FACT_DIMENSION_JOINS = `
  JOIN dataset_version dv ON dv.id=r.dataset_version_id
  JOIN dataset_slice ds ON ds.id=dv.dataset_slice_id
  LEFT JOIN shipment_fact sf ON r.fact_kind='SHIPMENT' AND sf.id=r.fact_id
  LEFT JOIN transaction_fact tf ON r.fact_kind='TRANSACTION' AND tf.id=r.fact_id`;
const REPORT_FACT_FILTER = `
  AND ($2::date IS NULL OR COALESCE(sf.marketplace_local_date,tf.marketplace_local_date)>=$2::date)
  AND ($3::date IS NULL OR COALESCE(sf.marketplace_local_date,tf.marketplace_local_date)<=$3::date)
  AND ($4::text IS NULL OR lower(ds.normalized_marketplace)=lower($4))`;

function canonicalManifest(manifest: SnapshotManifest): string {
  return JSON.stringify({
    calculationRunId: manifest.calculationRunId,
    shopId: manifest.shopId,
    slices: [...manifest.slices]
      .sort((left, right) => left.sliceId.localeCompare(right.sliceId))
      .map((slice) => ({ sliceId: slice.sliceId, datasetVersionId: slice.datasetVersionId, disposition: slice.disposition })),
  });
}

class TransactionAdapter implements PublishTransaction {
  constructor(private readonly client: SqlClient) {}
  async lockShop(shopId: string) { await this.client.query("SELECT id FROM shop WHERE id=$1 FOR UPDATE", [shopId]); }
  async getCalculationRun(runId: string): Promise<CalculationRunForPublishing | undefined> {
    const runResult = await this.client.query<{
      id: string; shop_id: string; status: CalculationRunForPublishing["status"]; application_price_version_id: string;
      marketplace_policy_version_id: string; timezone_policy_version: string; formula_version: string; code_version: string;
      input_manifest: Record<string, unknown>;
    }>("SELECT * FROM calculation_run WHERE id=$1", [runId]);
    const run = runResult.rows[0]; if (!run) return undefined;
    const slices = await this.client.query<{
      dataset_slice_id: string; dataset_version_id: string; mapping_version_ids: string[]; hard_reason_codes: string[];
      hard_exclusion_acknowledgement_id: string | null; soft_warning_acknowledgement_id: string | null; soft_warning: boolean;
    }>(
      `SELECT rs.*,COALESCE(rr.warning,false) soft_warning FROM calculation_run_slice rs
       LEFT JOIN reconciliation_result rr ON rr.dataset_version_id=rs.dataset_version_id
       WHERE rs.calculation_run_id=$1 ORDER BY rs.dataset_slice_id`, [runId],
    );
    const rawOverrideIds = run.input_manifest?.fxOverrideIds;
    if (rawOverrideIds !== undefined && (!Array.isArray(rawOverrideIds) || !rawOverrideIds.every((id) => typeof id === "string"))) {
      throw new Error("CALCULATION_FX_OVERRIDE_MANIFEST_INVALID");
    }
    return { id: run.id, shopId: run.shop_id, status: run.status, applicationPriceVersionId: run.application_price_version_id,
      marketplacePolicyVersionId: run.marketplace_policy_version_id, timezonePolicyVersion: run.timezone_policy_version,
      formulaVersion: run.formula_version, codeVersion: run.code_version,
      ...(rawOverrideIds !== undefined ? { fxOverrideIds: rawOverrideIds as string[] } : {}),
      mappingVersionIds: [...new Set(slices.rows.flatMap((row) => row.mapping_version_ids))],
      slices: slices.rows.map((row) => ({ sliceId: row.dataset_slice_id, datasetVersionId: row.dataset_version_id,
        hardReasons: row.hard_reason_codes, softWarning: row.soft_warning,
        ...(row.hard_exclusion_acknowledgement_id ? { hardExclusionAcknowledgementId: row.hard_exclusion_acknowledgement_id } : {}),
        ...(row.soft_warning_acknowledgement_id ? { softWarningAcknowledgementId: row.soft_warning_acknowledgement_id } : {}) })) };
  }
  async getCurrentSliceVersions(shopId: string) {
    const result = await this.client.query<{ id: string; current_version_id: string }>("SELECT id,current_version_id FROM dataset_slice WHERE shop_id=$1 AND current_version_id IS NOT NULL", [shopId]);
    return new Map(result.rows.map((row) => [row.id, row.current_version_id]));
  }
  async getCurrentFxOverrideIds() {
    await this.client.query("SELECT pg_advisory_xact_lock(hashtextextended('fx-override:set', 0))");
    const result = await this.client.query<{ id: string }>("SELECT id FROM fx_current_override ORDER BY id");
    return result.rows.map((row) => row.id);
  }
  async createSnapshot(input: { shopId: string; calculationRunId: string; actorAccountId: string; manifest: SnapshotManifest }) {
    const run = await this.client.query<{ input_manifest: Record<string, unknown> }>("SELECT input_manifest FROM calculation_run WHERE id=$1", [input.calculationRunId]);
    const full = JSON.stringify({ ...run.rows[0]?.input_manifest, publishedSlices: input.manifest.slices });
    const result = await this.client.query<{ id: string }>(
      `INSERT INTO published_snapshot(shop_id,calculation_run_id,manifest,manifest_sha256,published_by)
       VALUES($1,$2,$3::jsonb,digest(($3::jsonb)::text,'sha256'),$4)
       ON CONFLICT(calculation_run_id) DO NOTHING RETURNING id`,
      [input.shopId,input.calculationRunId,full,input.actorAccountId],
    );
    const existing = result.rows[0] ?? (await this.client.query<{ id: string }>(
      "SELECT id FROM published_snapshot WHERE calculation_run_id=$1 AND shop_id=$2",
      [input.calculationRunId, input.shopId],
    )).rows[0];
    const id=existing?.id;
    if(!id) throw new Error("SNAPSHOT_CREATE_FAILED");
    await this.client.query(
      `INSERT INTO published_snapshot_integrity(published_snapshot_id,hash_format,canonical_manifest_sha256)
       SELECT id,'PG_JSONB_TEXT_V1',digest(manifest::text,'sha256') FROM published_snapshot WHERE id=$1
       ON CONFLICT(published_snapshot_id) DO NOTHING`,
      [id],
    );
    return id;
  }
  async createSnapshotSlices(snapshotId: string, slices: readonly SnapshotSliceInput[]) {
    if (!slices.length) return;
    await this.client.query(
      `INSERT INTO published_snapshot_slice(published_snapshot_id,dataset_slice_id,dataset_version_id,disposition,calculation_run_id)
       SELECT snapshot.id,input.slice_id,input.version_id,input.disposition,snapshot.calculation_run_id
         FROM published_snapshot snapshot
         CROSS JOIN jsonb_to_recordset($2::jsonb) AS input(slice_id uuid,version_id uuid,disposition text)
        WHERE snapshot.id=$1
       ON CONFLICT DO NOTHING`,
      [snapshotId, JSON.stringify(slices.map((slice) => ({
        slice_id: slice.sliceId,
        version_id: slice.datasetVersionId,
        disposition: slice.disposition,
      })))],
    );
  }
  async setCurrentSnapshot(shopId: string, snapshotId: string) {
    await this.client.query(`INSERT INTO shop_current_published_snapshot(shop_id,published_snapshot_id) VALUES($1,$2)
      ON CONFLICT(shop_id) DO UPDATE SET published_snapshot_id=EXCLUDED.published_snapshot_id,switched_at=clock_timestamp()
      WHERE shop_current_published_snapshot.published_snapshot_id<>EXCLUDED.published_snapshot_id`, [shopId,snapshotId]);
  }
  async appendAudit(input: { actorAccountId: string; action: string; objectId: string }) {
    await this.client.query(
      `INSERT INTO audit_event(actor_account_id,action,object_type,object_id)
       SELECT $1,$2,'published_snapshot',$3
       WHERE NOT EXISTS(SELECT 1 FROM audit_event WHERE action=$2 AND object_type='published_snapshot' AND object_id=$3)`,
      [input.actorAccountId,input.action,input.objectId],
    );
  }
}

class StoreAdapter implements PublishStore {
  constructor(private readonly transactions: TransactionRunner) {}
  inTransaction<T>(work: (transaction: PublishTransaction) => Promise<T>) { return this.transactions.transaction((client) => work(new TransactionAdapter(client))); }
}

export class PostgresReportService {
  constructor(private readonly transactions: TransactionRunner, private readonly database: SqlClient) {}

  async requestCalculation(shopId: string, input: {
    actorAccountId: string;
    idempotencyKey: string;
    sourceImportBatchId?: string;
    autoPublish?: boolean;
  }) {
    return this.transactions.transaction(async (client) => {
      await client.query("SELECT id FROM shop WHERE id=$1 FOR UPDATE", [shopId]);
      const slices = await client.query<{ slice_id: string; version_id: string; status: string; mappings: string[]; warning: boolean; hard_ack: string | null; soft_ack: string | null; normalized_marketplace: string; policy_id: string | null; iana_timezone: string | null; date_attribution_mode: string | null }>(
        `SELECT ds.id slice_id,dv.id version_id,dv.status,array_remove(array_agg(DISTINCT b.mapping_version_id),NULL) mappings,
                ds.normalized_marketplace,policy.id policy_id,policy.iana_timezone,policy.date_attribution_mode,
                COALESCE(bool_or(rr.warning),false) warning,
                (SELECT qa.id FROM quality_acknowledgement qa WHERE qa.dataset_version_id=dv.id
                  AND qa.calculation_run_id IS NULL AND qa.issue_kind='HARD_INCOMPLETE'
                  ORDER BY qa.created_at DESC,qa.id DESC LIMIT 1) hard_ack,
                (SELECT qa.id FROM quality_acknowledgement qa WHERE qa.dataset_version_id=dv.id
                  AND qa.calculation_run_id IS NULL AND qa.issue_kind='SOFT_RECONCILIATION_WARNING'
                  ORDER BY qa.created_at DESC,qa.id DESC LIMIT 1) soft_ack
           FROM dataset_slice ds JOIN dataset_version dv ON dv.id=ds.current_version_id
           LEFT JOIN dataset_source_binding b ON b.dataset_version_id=dv.id
           LEFT JOIN reconciliation_result rr ON rr.dataset_version_id=dv.id
           LEFT JOIN LATERAL (
             SELECT p.id,p.iana_timezone,p.date_attribution_mode FROM marketplace_policy_version p
              WHERE p.normalized_marketplace=ds.normalized_marketplace
                AND p.effective_from<=dv.created_at
                AND (p.effective_to IS NULL OR p.effective_to>dv.created_at)
              ORDER BY p.effective_from DESC,p.id DESC LIMIT 1
           ) policy ON true
          WHERE ds.shop_id=$1 GROUP BY ds.id,dv.id,policy.id,policy.iana_timezone,policy.date_attribution_mode ORDER BY ds.id`, [shopId],
      );
      if (!slices.rows.length) throw new Error("NO_ACTIVE_DATASET");
      if (slices.rows.some((row) => !row.policy_id || !row.iana_timezone || !row.date_attribution_mode)) {
        throw new Error("CALCULATION_MARKETPLACE_POLICY_NOT_INITIALIZED");
      }
      if (new Set(slices.rows.map((row) => row.date_attribution_mode)).size !== 1) {
        throw new Error("CALCULATION_DATE_ATTRIBUTION_MODE_MIXED");
      }
      if (input.autoPublish && slices.rows.some((row) => row.status === "INCOMPLETE" && !row.hard_ack)) {
        throw new Error("HARD_INCOMPLETE_CONFIRMATION_REQUIRED");
      }
      const meta = await client.query<{ price_id: string; fx_sync_run_id: string | null }>(
        `SELECT (SELECT pv.id FROM shop s JOIN application_price_version pv ON pv.application_id=s.application_id
                 WHERE s.id=$1 AND pv.effective_from<=clock_timestamp() ORDER BY pv.effective_from DESC LIMIT 1) price_id,
                (SELECT run.id FROM fx_sync_run run WHERE run.status='SUCCEEDED'
                   AND EXISTS(SELECT 1 FROM fx_sync_run_snapshot link WHERE link.sync_run_id=run.id)
                 ORDER BY run.finished_at DESC LIMIT 1) fx_sync_run_id`, [shopId],
      );
      const metadata=meta.rows[0]; if(!metadata?.price_id) throw new Error("CALCULATION_POLICY_NOT_INITIALIZED");
      const currentOverrides = await client.query<{ id: string }>(
        `SELECT id FROM fx_current_override ORDER BY id`,
      );
      const policySet=slices.rows.map((row)=>({sliceId:row.slice_id,normalizedMarketplace:row.normalized_marketplace,
        marketplacePolicyVersionId:row.policy_id!,ianaTimezone:row.iana_timezone!,dateAttributionMode:row.date_attribution_mode!}));
      const timezonePolicyVersion=`date-attribution-policy-set:${shaHex(JSON.stringify(policySet))}`;
      const legacyPolicyId=policySet[0]!.marketplacePolicyVersionId;
      const manifestObject={shopId,slices:slices.rows.map((row)=>({sliceId:row.slice_id,versionId:row.version_id,mappings:row.mappings,
        status:row.status,warning:row.warning,hardAcknowledgementId:row.hard_ack,softAcknowledgementId:row.soft_ack,
        normalizedMarketplace:row.normalized_marketplace,marketplacePolicyVersionId:row.policy_id,ianaTimezone:row.iana_timezone,
        dateAttributionMode:row.date_attribution_mode})),
        applicationPriceVersionId:metadata.price_id,marketplacePolicyVersionId:legacyPolicyId,
        marketplacePolicyVersionIds:[...new Set(policySet.map((policy)=>policy.marketplacePolicyVersionId))].sort(),timezonePolicyVersion,
        formulaVersion:CALCULATION_FORMULA_VERSION,codeVersion:CALCULATION_CODE_VERSION,fxDateRuleVersion:FX_DATE_RULE_VERSION,
        feeClassificationVersion:FEE_CLASSIFICATION_VERSION,
        feeClassificationPolicySha256:FEE_CLASSIFICATION_POLICY_SHA256,
        fxSyncRunId:metadata.fx_sync_run_id??"NO_FX_SNAPSHOT",
        fxOverrideIds:currentOverrides.rows.map((row)=>row.id).sort(),
        ...(input.sourceImportBatchId ? { sourceImportBatchId: input.sourceImportBatchId } : {}),
        ...(input.autoPublish ? { autoPublish: true } : {})};
      const manifest=JSON.stringify(manifestObject);
      const inserted=await client.query<{ id:string;status:string }>(
        `INSERT INTO calculation_run(shop_id,application_price_version_id,marketplace_policy_version_id,timezone_policy_version,
          formula_version,code_version,fee_classification_version,status,input_manifest,input_manifest_sha256,requested_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,'QUEUED',$8::jsonb,digest(($8::jsonb)::text,'sha256'),$9)
         ON CONFLICT(shop_id,input_manifest_sha256) DO UPDATE SET shop_id=EXCLUDED.shop_id RETURNING id,status`,
        [shopId,metadata.price_id,legacyPolicyId,timezonePolicyVersion,CALCULATION_FORMULA_VERSION,CALCULATION_CODE_VERSION,FEE_CLASSIFICATION_VERSION,manifest,input.actorAccountId],
      );
      const run=inserted.rows[0]; if(!run) throw new Error("CALCULATION_RUN_CREATE_FAILED");
      const bindAcknowledgement = async (sourceId: string | null, issueKind: "HARD_INCOMPLETE" | "SOFT_RECONCILIATION_WARNING") => {
        if (!sourceId) return null;
        const insertedAck = await client.query<{ id: string }>(
          `INSERT INTO quality_acknowledgement(dataset_version_id,calculation_run_id,marketplace_policy_version_id,
             issue_kind,issue_code,actor_account_id,reason,confirmation_count)
           SELECT dataset_version_id,$1,marketplace_policy_version_id,issue_kind,issue_code,actor_account_id,reason,confirmation_count
             FROM quality_acknowledgement source
            WHERE source.id=$2 AND source.issue_kind=$3
              AND NOT EXISTS (SELECT 1 FROM quality_acknowledgement bound
                WHERE bound.calculation_run_id=$1 AND bound.dataset_version_id=source.dataset_version_id AND bound.issue_kind=$3)
           RETURNING id`,
          [run.id, sourceId, issueKind],
        );
        return insertedAck.rows[0]?.id ?? (await client.query<{ id: string }>(
          `SELECT id FROM quality_acknowledgement WHERE calculation_run_id=$1 AND issue_kind=$2
             AND dataset_version_id=(SELECT dataset_version_id FROM quality_acknowledgement WHERE id=$3)
           ORDER BY created_at DESC LIMIT 1`,
          [run.id, issueKind, sourceId],
        )).rows[0]?.id ?? null;
      };
      const automaticWarningAcknowledgement = async (row: (typeof slices.rows)[number]) => {
        if (!input.autoPublish || !row.policy_id) return null;
        const result = await client.query<{ id: string }>(
          `INSERT INTO quality_acknowledgement(dataset_version_id,calculation_run_id,marketplace_policy_version_id,
             issue_kind,issue_code,actor_account_id,reason,confirmation_count)
           SELECT $1,$2,$3,$4,$5,$6,$7,1
            WHERE NOT EXISTS (SELECT 1 FROM quality_acknowledgement
              WHERE calculation_run_id=$2 AND dataset_version_id=$1 AND issue_kind=$4)
           RETURNING id`,
           [row.version_id, run.id, row.policy_id, "SOFT_RECONCILIATION_WARNING",
             "IMPORT_AUTO_WARNING_INCLUSION", input.actorAccountId, "自动纳入正常数据并持续披露数量差异"],
        );
        return result.rows[0]?.id ?? (await client.query<{ id: string }>(
          `SELECT id FROM quality_acknowledgement
            WHERE calculation_run_id=$1 AND dataset_version_id=$2 AND issue_kind=$3
            ORDER BY created_at DESC LIMIT 1`,
          [run.id, row.version_id, "SOFT_RECONCILIATION_WARNING"],
        )).rows[0]?.id ?? null;
      };
      const resolvedSlices: ResolvedCalculationRunSlice[] = [];
      for(const row of slices.rows){
        const hard=row.status==='INCOMPLETE';
        const hardAck = await bindAcknowledgement(row.hard_ack, "HARD_INCOMPLETE");
        const softAck = !hard
          ? await bindAcknowledgement(row.soft_ack, "SOFT_RECONCILIATION_WARNING")
            ?? (row.warning ? await automaticWarningAcknowledgement(row) : null)
          : null;
        resolvedSlices.push({
          sliceId: row.slice_id,
          versionId: row.version_id,
          disposition: hard ? "HARD_EXCLUDED" : row.warning && softAck ? "INCLUDED_WITH_WARNING" : "INCLUDED",
          mappings: row.mappings,
          hardReasonCodes: hard ? ["HARD_INCOMPLETE"] : [],
          hardAcknowledgementId: hardAck,
          softAcknowledgementId: row.warning ? softAck : null,
        });
      }
      await insertCalculationRunSlices(client, run.id, resolvedSlices);
      if(run.status==='QUEUED') await client.query(
        `INSERT INTO outbox_event(id,topic,business_key,payload) VALUES($1,'calculation.run',$2,$3::jsonb)
         ON CONFLICT(topic,business_key) DO NOTHING`, [randomUUID(),run.id,JSON.stringify({runId:run.id})],
      );
      return { runId:run.id,status:run.status };
    });
  }

  async autoPublishCalculation(runId: string, actorAccountId: string, sourceImportBatchId: string) {
    const run = await this.database.query<{ shop_id: string; input_manifest: Record<string, unknown> }>(
      "SELECT shop_id,input_manifest FROM calculation_run WHERE id=$1",
      [runId],
    );
    const row = run.rows[0];
    if (!row || row.input_manifest.autoPublish !== true || row.input_manifest.sourceImportBatchId !== sourceImportBatchId) {
      throw new Error("AUTO_PUBLISH_RUN_MISMATCH");
    }
    const authorization = await this.database.query<{ authorized: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM account actor JOIN shop target ON target.id=$2
          WHERE actor.id=$1 AND actor.status='ACTIVE' AND target.status='ACTIVE'
            AND (EXISTS(
              SELECT 1 FROM enterprise_member em
               WHERE em.enterprise_id=target.enterprise_id AND em.account_id=actor.id AND em.status='ACTIVE'
            ) OR EXISTS(
              SELECT 1 FROM account_role role WHERE role.account_id=actor.id AND role.role='ADMIN'
            ))
       ) AS authorized`,
      [actorAccountId, row.shop_id],
    );
    if (!authorization.rows[0]?.authorized) throw new Error("AUTO_PUBLISH_ACTOR_NOT_AUTHORIZED");
    const slices = await this.database.query<{ slice_id: string; dataset_version_id: string; disposition: SnapshotSliceInput["disposition"] }>(
      `SELECT dataset_slice_id AS slice_id,dataset_version_id,disposition
         FROM calculation_run_slice WHERE calculation_run_id=$1 ORDER BY dataset_slice_id`,
      [runId],
    );
    await this.database.query(
      `UPDATE import_batch SET status='RESULT_PUBLISHING',current_stage='PUBLISH',failure_code=NULL,updated_at=clock_timestamp()
        WHERE id=$1 AND shop_id=$2`,
      [sourceImportBatchId, row.shop_id],
    );
    const published = await this.publish({
      calculationRunId: runId,
      shopId: row.shop_id,
      slices: slices.rows.map((slice) => ({ sliceId: slice.slice_id, datasetVersionId: slice.dataset_version_id, disposition: slice.disposition })),
    }, { actorAccountId, idempotencyKey: `auto-import:${sourceImportBatchId}:${runId}` }, { snapshotOnly: true });
    return published;
  }

  async markAutoPublishFailed(sourceImportBatchId: string): Promise<void> {
    await this.database.query(
      `UPDATE import_batch SET status='READY_FOR_REVIEW',current_stage='AUTO_PUBLISH_FAILED',failure_code='AUTO_PUBLISH_FAILED',updated_at=clock_timestamp()
        WHERE id=$1 AND status<>'RESULT_PUBLISHED'`,
      [sourceImportBatchId],
    );
  }

  private async latestIntermediateRun(shopId: string): Promise<{ id: string; shopName: string; status: string } | undefined> {
    const run = await this.database.query<{ id: string; shop_name: string; status: string }>(
      `SELECT cr.id,cr.status,s.name shop_name FROM calculation_run cr
         JOIN shop s ON s.id=cr.shop_id
        WHERE cr.shop_id=$1 ORDER BY cr.created_at DESC,cr.id DESC LIMIT 1`, [shopId],
    );
    const row = run.rows[0];
    return row ? { id: row.id, shopName: row.shop_name, status: row.status } : undefined;
  }

  async getIntermediate(shopId: string, kind: IntermediateReportKind, limit: number, afterId?: string, filter: IntermediateFilter = {}, runIdOverride?: string, frozenRatesOverride?: ReadonlyMap<string, string>) {
    const runId = runIdOverride ?? (await this.latestIntermediateRun(shopId))?.id;
    if (!runId) return { items: [] };
    const after = afterId ?? "0";
    const result = kind === "TRANSACTION"
      ? await this.database.query<Record<string, string>>(
        `SELECT tf.id::text id,tf.normalized_marketplace marketplace,tf.marketplace_local_date::text "localDate",tf.fx_date::text "fxDate",
                tf.normalized_type type,tf.normalized_description description,COALESCE(tf.order_id,'') "orderId",COALESCE(tf.sku,'') sku,
                tf.currency,tf.quantity::text quantity,tf.product_sales::text "productSales",tf.product_sales_tax::text "productSalesTax",
                tf.shipping_credits::text "shippingCredits",tf.shipping_credits_tax::text "shippingCreditsTax",
                tf.gift_wrap_credits::text "giftWrapCredits",tf.gift_wrap_credits_tax::text "giftWrapCreditsTax",
                tf.regulatory_fee::text "regulatoryFee",tf.tax_on_regulatory_fee::text "taxOnRegulatoryFee",
                tf.promotional_rebates::text "promotionalRebates",tf.promotional_rebates_tax::text "promotionalRebatesTax",
                tf.marketplace_withheld_tax::text "marketplaceWithheldTax",tf.selling_fees::text "sellingFees",
                tf.fba_fees::text "fbaFees",tf.other_transaction_fees::text "otherTransactionFees",tf.other_amount::text "otherAmount"
           FROM transaction_fact tf JOIN calculation_run_slice rs ON rs.dataset_version_id=tf.dataset_version_id
          WHERE rs.calculation_run_id=$1 AND rs.disposition IN ('INCLUDED','INCLUDED_WITH_WARNING') AND tf.id>$2::bigint
            AND ($4::text[] IS NULL OR tf.normalized_marketplace=ANY($4::text[]))
            AND ($5::text[] IS NULL OR tf.currency=ANY($5::text[]))
            AND ($6::date IS NULL OR tf.marketplace_local_date >= $6::date)
            AND ($7::date IS NULL OR tf.marketplace_local_date <= $7::date)
          ORDER BY tf.id LIMIT $3`,
        [runId, after, limit, filter.marketplaces ?? null, filter.currencies ?? null, filter.start ?? null, filter.end ?? null],
      )
      : await this.database.query<Record<string, string>>(
        `SELECT sf.id::text id,sf.normalized_marketplace marketplace,sf.marketplace_local_date::text "localDate",sf.fx_date::text "fxDate",
                COALESCE(sf.order_id,'') "orderId",COALESCE(sf.sku,'') sku,sf.currency,sf.shipped_quantity::text "shippedQuantity",
                sf.product_price::text "productPrice",sf.product_tax::text "productTax",sf.shipping_price::text "shippingPrice",
                sf.shipping_tax::text "shippingTax",sf.gift_wrap_price::text "giftWrapPrice",sf.gift_wrap_tax::text "giftWrapTax",
                sf.product_promotion_discount::text "productPromotionDiscount",sf.shipment_promotion_discount::text "shipmentPromotionDiscount"
           FROM shipment_fact sf JOIN calculation_run_slice rs ON rs.dataset_version_id=sf.dataset_version_id
          WHERE rs.calculation_run_id=$1 AND rs.disposition IN ('INCLUDED','INCLUDED_WITH_WARNING') AND sf.id>$2::bigint
            AND ($4::text[] IS NULL OR sf.normalized_marketplace=ANY($4::text[]))
            AND ($5::text[] IS NULL OR sf.currency=ANY($5::text[]))
            AND ($6::date IS NULL OR sf.marketplace_local_date >= $6::date)
            AND ($7::date IS NULL OR sf.marketplace_local_date <= $7::date)
          ORDER BY sf.id LIMIT $3`,
        [runId, after, limit, filter.marketplaces ?? null, filter.currencies ?? null, filter.start ?? null, filter.end ?? null],
      );
    const requestedDates = [...new Set(result.rows.map((row) => row.fxDate ?? ""))].filter(Boolean);
    const requestedCurrencies = [...new Set(result.rows.map((row) => row.currency ?? ""))].filter(Boolean);
    const rates = !frozenRatesOverride && result.rows.length
      ? await this.database.query<{ requested_date: string; currency: string; cny_rate: string }>(
        `SELECT u.requested_date::text requested_date,fact.currency,min(u.cny_per_unit)::text cny_rate
           FROM calculation_fact_result r JOIN calculation_fx_usage u ON u.calculation_fact_result_id=r.id
           JOIN ${kind === "TRANSACTION" ? "transaction_fact" : "shipment_fact"} fact ON fact.id=r.fact_id
          WHERE r.calculation_run_id=$1 AND r.fact_kind=$2
            AND u.requested_date=ANY($3::date[]) AND fact.currency=ANY($4::text[])
          GROUP BY u.requested_date,fact.currency HAVING count(DISTINCT u.cny_per_unit)=1`,
        [runId, kind, requestedDates, requestedCurrencies],
      )
      : { rows: [] };
    const rateByConversion = frozenRatesOverride ?? new Map<string, string>(
      rates.rows.map((row) => [`${row.requested_date}\0${row.currency}`, row.cny_rate]),
    );
    const rowsWithRates: Array<Record<string, string>> = result.rows.map((row) => {
      const { fxDate = "", ...visible } = row;
      return { ...visible, cnyRate: rateByConversion.get(`${fxDate}\0${row.currency ?? ""}`) ?? "" };
    });
    const items: Array<Record<string, string>> = kind === "SHIPMENT" ? rowsWithRates.map((row): Record<string, string> => {
      const originalTotal = SHIPMENT_AMOUNT_KEYS.reduce(
        (sum, key) => sum.add(new Decimal(row[key] ?? "0").toDecimalPlaces(2)),
        new Decimal(0),
      );
      return {
        ...row,
        originalTotal: originalTotal.toFixed(2),
        cnyTotal: row.cnyRate ? originalTotal.mul(new Decimal(row.cnyRate)).toDecimalPlaces(2).toFixed(2) : originalTotal.isZero() ? "0.00" : "",
      } as Record<string, string>;
    }) : rowsWithRates;
    const nextCursor = items.length === limit ? items.at(-1)?.id : undefined;
    return { items, ...(nextCursor ? { nextCursor } : {}) };
  }

  async getIntermediateSummary(shopId: string, kind: IntermediateReportKind, filter: IntermediateFilter = {}) {
    const run = await this.latestIntermediateRun(shopId);
    if (!run) return { coverage: {}, options: { marketplaces: [], currencies: [] }, matchedRows: "0", totalsByCurrency: [], cnyTotal: "0.00000000" };
    const factTable = kind === "TRANSACTION" ? "transaction_fact" : "shipment_fact";
    const alias = kind === "TRANSACTION" ? "tf" : "sf";
    const options = await this.database.query<{ coverage_start: string | null; coverage_end: string | null; marketplaces: string[] | null; currencies: string[] | null }>(
      `SELECT min(${alias}.marketplace_local_date)::text coverage_start,max(${alias}.marketplace_local_date)::text coverage_end,
              array_agg(DISTINCT ${alias}.normalized_marketplace ORDER BY ${alias}.normalized_marketplace) marketplaces,
              array_agg(DISTINCT ${alias}.currency ORDER BY ${alias}.currency) currencies
         FROM ${factTable} ${alias} JOIN calculation_run_slice rs ON rs.dataset_version_id=${alias}.dataset_version_id
        WHERE rs.calculation_run_id=$1 AND rs.disposition IN ('INCLUDED','INCLUDED_WITH_WARNING')`, [run.id],
    );
    const parameters = [run.id, filter.marketplaces ?? null, filter.currencies ?? null, filter.start ?? null, filter.end ?? null];
    const totalRows = kind === "TRANSACTION"
      ? await this.database.query<Record<string, string | null>>(
        `SELECT tf.currency,count(*)::text "matchedRows",
                sum(round(tf.quantity,2))::text quantity,
                sum(round(tf.product_sales,2))::text "productSales",sum(round(tf.product_sales_tax,2))::text "productSalesTax",
                sum(round(tf.shipping_credits,2))::text "shippingCredits",sum(round(tf.shipping_credits_tax,2))::text "shippingCreditsTax",
                sum(round(tf.gift_wrap_credits,2))::text "giftWrapCredits",sum(round(tf.gift_wrap_credits_tax,2))::text "giftWrapCreditsTax",
                sum(round(tf.regulatory_fee,2))::text "regulatoryFee",sum(round(tf.tax_on_regulatory_fee,2))::text "taxOnRegulatoryFee",
                sum(round(tf.promotional_rebates,2))::text "promotionalRebates",sum(round(tf.promotional_rebates_tax,2))::text "promotionalRebatesTax",
                sum(round(tf.marketplace_withheld_tax,2))::text "marketplaceWithheldTax",sum(round(tf.selling_fees,2))::text "sellingFees",
                sum(round(tf.fba_fees,2))::text "fbaFees",sum(round(tf.other_transaction_fees,2))::text "otherTransactionFees",
                sum(round(tf.other_amount,2))::text "otherAmount",'0'::text "cnyTotal"
           FROM transaction_fact tf JOIN calculation_run_slice rs ON rs.dataset_version_id=tf.dataset_version_id
          WHERE rs.calculation_run_id=$1 AND rs.disposition IN ('INCLUDED','INCLUDED_WITH_WARNING')
            AND ($2::text[] IS NULL OR tf.normalized_marketplace=ANY($2::text[]))
            AND ($3::text[] IS NULL OR tf.currency=ANY($3::text[]))
            AND ($4::date IS NULL OR tf.marketplace_local_date >= $4::date)
            AND ($5::date IS NULL OR tf.marketplace_local_date <= $5::date)
          GROUP BY tf.currency ORDER BY tf.currency`, parameters)
      : await this.database.query<Record<string, string | null>>(
         `WITH fixed_fx AS (
           SELECT u.requested_date,sf.currency,min(u.cny_per_unit) cny_rate
             FROM calculation_fact_result r JOIN calculation_fx_usage u ON u.calculation_fact_result_id=r.id
             JOIN shipment_fact sf ON sf.id=r.fact_id
            WHERE r.calculation_run_id=$1 AND r.fact_kind='SHIPMENT'
            GROUP BY u.requested_date,sf.currency HAVING count(DISTINCT u.cny_per_unit)=1
         ), filtered AS (
           SELECT sf.*,
                  round(sf.product_price,2)+round(sf.product_tax,2)+round(sf.shipping_price,2)+round(sf.shipping_tax,2)
                    +round(sf.gift_wrap_price,2)+round(sf.gift_wrap_tax,2)+round(sf.product_promotion_discount,2)+round(sf.shipment_promotion_discount,2) original_total,
                  fx.cny_rate
             FROM shipment_fact sf JOIN calculation_run_slice rs ON rs.dataset_version_id=sf.dataset_version_id
             LEFT JOIN fixed_fx fx ON fx.requested_date=sf.fx_date AND fx.currency=sf.currency
            WHERE rs.calculation_run_id=$1 AND rs.disposition IN ('INCLUDED','INCLUDED_WITH_WARNING')
              AND ($2::text[] IS NULL OR sf.normalized_marketplace=ANY($2::text[]))
              AND ($3::text[] IS NULL OR sf.currency=ANY($3::text[]))
              AND ($4::date IS NULL OR sf.marketplace_local_date >= $4::date)
              AND ($5::date IS NULL OR sf.marketplace_local_date <= $5::date)
         )
         SELECT currency,count(*)::text "matchedRows",sum(round(shipped_quantity,2))::text "shippedQuantity",
                sum(round(product_price,2))::text "productPrice",sum(round(product_tax,2))::text "productTax",
                sum(round(shipping_price,2))::text "shippingPrice",sum(round(shipping_tax,2))::text "shippingTax",
                sum(round(gift_wrap_price,2))::text "giftWrapPrice",sum(round(gift_wrap_tax,2))::text "giftWrapTax",
                sum(round(product_promotion_discount,2))::text "productPromotionDiscount",
                sum(round(shipment_promotion_discount,2))::text "shipmentPromotionDiscount",
                sum(original_total)::text "originalTotal",
                CASE WHEN count(cny_rate)=count(*) THEN sum(round(original_total*cny_rate,2))::text ELSE NULL END "cnyTotal"
           FROM filtered GROUP BY currency ORDER BY currency`, parameters);
    const totalKeys = INTERMEDIATE_REPORT_COLUMNS[kind].filter((definition) => definition.total).map((definition) => definition.key);
    const totalsByCurrency = totalRows.rows.map((row) => ({
      currency: row.currency ?? "UNKNOWN",
      values: Object.fromEntries(totalKeys.flatMap((key) => row[key] === null || row[key] === undefined ? [] : [[key, row[key]!]])),
    }));
    const matchedRows = totalRows.rows.reduce((sum, row) => sum + BigInt(row.matchedRows ?? "0"), 0n);
    const cnyComplete = kind === "TRANSACTION" || totalRows.rows.every((row) => row.cnyTotal !== null);
    const cnyTotal = cnyComplete
      ? totalRows.rows.reduce((sum, row) => sum.add(new Decimal(row.cnyTotal ?? "0")), new Decimal(0)).toFixed(2)
      : "";
    const optionRow = options.rows[0];
    return {
      coverage: { ...(optionRow?.coverage_start ? { start: optionRow.coverage_start } : {}), ...(optionRow?.coverage_end ? { end: optionRow.coverage_end } : {}) },
      options: { marketplaces: optionRow?.marketplaces ?? [], currencies: optionRow?.currencies ?? [] },
      matchedRows: matchedRows.toString(), totalsByCurrency, cnyTotal,
    };
  }

  async getIntermediateExportContext(shopId: string, kind: IntermediateReportKind, filter: IntermediateFilter = {}) {
    const run = await this.latestIntermediateRun(shopId);
    if (!run) throw new Error("CALCULATION_RUN_NOT_FOUND");
    if (run.status !== "READY") throw new Error("INTERMEDIATE_FX_NOT_FIXED");
    const factTable = kind === "TRANSACTION" ? "transaction_fact" : "shipment_fact";
    const alias = kind === "TRANSACTION" ? "tf" : "sf";
    const check = await this.database.query<{ requested_date: string; currency: string; cny_rate: string | null; invalid: boolean }>(
      `WITH selected_conversion AS MATERIALIZED (
         SELECT ${alias}.fx_date requested_date,${alias}.currency,
                ${kind === "TRANSACTION" ? "false" : `bool_or(${SHIPMENT_AMOUNT_KEYS.map((key) => `round(${alias}.${key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`)},2)`).join("+")}<>0)`} requires_rate
           FROM ${factTable} ${alias} JOIN calculation_run_slice rs ON rs.dataset_version_id=${alias}.dataset_version_id
          WHERE rs.calculation_run_id=$1 AND rs.disposition IN ('INCLUDED','INCLUDED_WITH_WARNING')
            AND ($3::text[] IS NULL OR ${alias}.normalized_marketplace=ANY($3::text[]))
            AND ($4::text[] IS NULL OR ${alias}.currency=ANY($4::text[]))
            AND ($5::date IS NULL OR ${alias}.marketplace_local_date >= $5::date)
            AND ($6::date IS NULL OR ${alias}.marketplace_local_date <= $6::date)
          GROUP BY ${alias}.fx_date,${alias}.currency
       ), fixed_conversion AS (
         SELECT fact.fx_date requested_date,fact.currency,min(u.cny_per_unit) min_rate,max(u.cny_per_unit) max_rate,
                bool_or(u.id IS NULL) missing_usage
           FROM calculation_fact_result r
           JOIN ${factTable} fact ON fact.id=r.fact_id
           LEFT JOIN calculation_fx_usage u ON u.calculation_fact_result_id=r.id
          WHERE r.calculation_run_id=$1 AND r.fact_kind=$2
          GROUP BY fact.fx_date,fact.currency
       )
       SELECT selected.requested_date::text,selected.currency,fixed.min_rate::text cny_rate,
              (COALESCE(fixed.missing_usage,false)
                OR (fixed.min_rate IS NOT NULL AND fixed.min_rate<>fixed.max_rate)
                OR (selected.requires_rate AND fixed.min_rate IS NULL)) invalid
         FROM selected_conversion selected
         LEFT JOIN fixed_conversion fixed USING(requested_date,currency)`,
      [run.id, kind, filter.marketplaces ?? null, filter.currencies ?? null, filter.start ?? null, filter.end ?? null],
    );
    if (check.rows.some((row) => row.invalid)) throw new Error("INTERMEDIATE_FX_NOT_FIXED");
    return {
      shopName: run.shopName,
      calculationRunId: run.id,
      frozenRates: new Map(check.rows.flatMap((row) => row.cny_rate === null ? [] : [[`${row.requested_date}\0${row.currency}`, row.cny_rate]])),
    };
  }

  async getPreview(shopId: string, filter: ReportFilter = {}) { return this.reportView(shopId, undefined, false, filter); }
  async getCurrent(shopId: string, filter: ReportFilter = {}) {
    const pointer=await this.database.query<{ published_snapshot_id:string }>("SELECT published_snapshot_id FROM shop_current_published_snapshot WHERE shop_id=$1",[shopId]);
    const id=pointer.rows[0]?.published_snapshot_id; if(!id) throw new Error("PUBLISHED_SNAPSHOT_NOT_FOUND");
    return this.reportView(shopId,id,true,filter);
  }
  async publish(
    manifest: SnapshotManifest,
    input: { actorAccountId: string; idempotencyKey: string },
    options: { snapshotOnly?: boolean } = {},
  ) {
    const snapshotId = await this.transactions.transaction(async (client) => {
      const scope = `report.publish:${manifest.shopId}`;
      const requestHash = shaHex(canonicalManifest(manifest));
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('idempotency:' || $1 || ':' || $2 || ':' || $3, 0))",
        [input.actorAccountId, scope, input.idempotencyKey],
      );
      const prior = await client.query<{ request_hash: string; response_body: { snapshotId?: string } | null }>(
        `SELECT request_hash,response_body FROM idempotency_record
         WHERE actor_account_id=$1 AND scope=$2 AND idempotency_key=$3`,
        [input.actorAccountId, scope, input.idempotencyKey],
      );
      const existing = prior.rows[0];
      if (existing) {
        if (existing.request_hash !== requestHash) throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PUBLISH");
        if (!existing.response_body?.snapshotId) throw new Error("IDEMPOTENT_PUBLISH_RESPONSE_MISSING");
        return existing.response_body.snapshotId;
      }
      const transactionRunner: TransactionRunner = { transaction: async (work) => work(client) };
      const created = await publishSnapshot(new StoreAdapter(transactionRunner), { actorAccountId: input.actorAccountId, manifest });
      await client.query(
        `UPDATE shop SET last_operated_by_account_id=$2,updated_at=clock_timestamp() WHERE id=$1`,
        [manifest.shopId, input.actorAccountId],
      );
      await client.query(
        `INSERT INTO idempotency_record(actor_account_id,scope,idempotency_key,request_hash,response_status,response_body,expires_at)
         VALUES($1,$2,$3,$4,200,$5::jsonb,clock_timestamp()+interval '365 days')`,
        [input.actorAccountId, scope, input.idempotencyKey, requestHash, JSON.stringify({ snapshotId: created })],
      );
      return created;
    });
    await this.database.query(
      `UPDATE import_batch batch
          SET status='RESULT_PUBLISHED',current_stage='PUBLISHED',failure_code=NULL,updated_at=clock_timestamp()
         FROM calculation_run run
        WHERE run.id=$1 AND batch.shop_id=$2
          AND run.input_manifest ? 'sourceImportBatchId'
          AND batch.id=(run.input_manifest->>'sourceImportBatchId')::uuid`,
      [manifest.calculationRunId, manifest.shopId],
    );
    if (options.snapshotOnly) return { snapshotId };
    return this.reportView(manifest.shopId,snapshotId,true);
  }

  private async reportView(shopId:string,snapshotId:string|undefined,published:boolean,filter:ReportFilter={}){
    const runResult=await this.database.query<{ id:string;status:string;created_at:Date;finished_at:Date|null;input_manifest:Record<string,unknown>; published_at:Date|null;snapshot_id:string|null }>(
      snapshotId
        ? `SELECT r.*,s.id snapshot_id,s.published_at FROM published_snapshot s JOIN calculation_run r ON r.id=s.calculation_run_id WHERE s.id=$1 AND s.shop_id=$2`
        : `SELECT r.*,s.id snapshot_id,s.published_at FROM calculation_run r
           LEFT JOIN published_snapshot s ON s.calculation_run_id=r.id
           WHERE r.shop_id=$1 ORDER BY r.created_at DESC LIMIT 1`,
      snapshotId ? [snapshotId,shopId] : [shopId],
    );
    const run=runResult.rows[0]; if(!run) throw new Error("CALCULATION_RUN_NOT_FOUND");
    const reportParams=[run.id,filter.start??null,filter.end??null,filter.marketplace??null];
    const totals=await this.database.query<Record<string,string>>(
      `SELECT COALESCE(sum(r.amount_cny) FILTER (WHERE r.component='INCOME'),0)::text income,
              COALESCE(sum(r.amount_cny) FILTER (WHERE r.component='REFUND'),0)::text refund,
              COALESCE(sum(r.amount_cny) FILTER (WHERE r.component='WITHHELD_TAX'),0)::text withheld_tax,
              COALESCE(sum(r.amount_cny) FILTER (WHERE r.component='PLATFORM_FEE'),0)::text platform_fee,
              COALESCE(sum(r.amount_cny) FILTER (WHERE r.component='FBA_FULFILLMENT_FEE'),0)::text fba_fulfillment_fee,
              COALESCE(sum(r.amount_cny) FILTER (WHERE r.component='ADVERTISING_FEE'),0)::text advertising_fee,
              COALESCE(sum(r.amount_cny) FILTER (WHERE r.component='FBA_STORAGE_FEE'),0)::text fba_storage_fee,
              COALESCE(sum(r.amount_cny) FILTER (WHERE r.component='OTHER_DEDUCTION'),0)::text other_deduction
         FROM calculation_fact_result r ${REPORT_FACT_DIMENSION_JOINS}
        WHERE r.calculation_run_id=$1 ${REPORT_FACT_FILTER}`,reportParams,
    );
    const value=totals.rows[0]??{};
    value.platform_balance=new Decimal(value.income??0)
      .sub(value.refund??0).sub(value.withheld_tax??0).sub(value.platform_fee??0)
      .sub(value.fba_fulfillment_fee??0).sub(value.advertising_fee??0)
      .sub(value.fba_storage_fee??0).sub(value.other_deduction??0).toFixed(8);
    const keyMap=[['income','income'],['refund','refund'],['withheldTax','withheld_tax'],['platformFee','platform_fee'],['fbaDelivery','fba_fulfillment_fee'],['advertising','advertising_fee'],['storage','fba_storage_fee'],['other','other_deduction'],['balance','platform_balance']] as const;
    const completeness=await this.database.query<{
      slice_id:string;dataset_version_id:string;disposition:string;normalized_marketplace:string;local_month:string;
      shipment_quantity:string|null;transaction_quantity:string|null;unmatched_absolute:string|null;unmatched_ratio:string|null;
      hard_reason_codes:string[];warning:boolean;
    }>(
      `SELECT rs.dataset_slice_id slice_id,rs.dataset_version_id,rs.disposition,ds.normalized_marketplace,
              to_char(ds.local_month,'YYYY-MM') AS local_month,
              rr.shipment_quantity::text,rr.transaction_quantity::text,rr.unmatched_absolute::text,rr.unmatched_ratio::text,
              rs.hard_reason_codes,COALESCE(rr.warning,false) AS warning
       FROM calculation_run_slice rs JOIN dataset_slice ds ON ds.id=rs.dataset_slice_id
       LEFT JOIN reconciliation_result rr ON rr.dataset_version_id=rs.dataset_version_id
       WHERE rs.calculation_run_id=$1 ORDER BY ds.local_month,ds.normalized_marketplace`,[run.id],
    );
    const fees=await this.database.query<{ component:string;marketplace:string;report_month:string;source_rows:string;amount_cny:string }>(
      `SELECT r.component,ds.normalized_marketplace marketplace,to_char(ds.local_month,'YYYY-MM') AS report_month,count(*)::text source_rows,sum(r.amount_cny)::text amount_cny
       FROM calculation_fact_result r ${REPORT_FACT_DIMENSION_JOINS}
       WHERE r.calculation_run_id=$1 ${REPORT_FACT_FILTER}
         AND r.component NOT IN('INCOME','REFUND','WITHHELD_TAX')
       GROUP BY r.component,ds.id ORDER BY ds.local_month,ds.normalized_marketplace,r.component`,reportParams,
    );
    const fallback=await this.database.query<{ count:string }>(
      `SELECT count(*)::text count FROM calculation_fx_usage u
       JOIN calculation_fact_result r ON r.id=u.calculation_fact_result_id ${REPORT_FACT_DIMENSION_JOINS}
       WHERE r.calculation_run_id=$1 ${REPORT_FACT_FILTER} AND u.fallback_days>0`,
      reportParams,
    );
    const manifest=run.input_manifest;
    const visibleCompleteness = completeness.rows.filter((row) =>
      (!filter.start || row.local_month >= filter.start.slice(0, 7))
      && (!filter.end || row.local_month <= filter.end.slice(0, 7))
      && (!filter.marketplace || row.normalized_marketplace.toLowerCase() === filter.marketplace.toLowerCase()));
    const unacknowledgedWarnings = visibleCompleteness.filter((row) => row.warning && row.disposition === "INCLUDED").length;
    const hasFilter=Boolean(filter.start||filter.end||filter.marketplace);
    const effectivePublished = published || Boolean(run.snapshot_id);
    return {shopId,mode:effectivePublished?'PUBLISHED':run.status==='READY'?'DRAFT':'STALE',runId:run.id,...(run.snapshot_id?{snapshotId:run.snapshot_id}:{}),
      calculatedAt:(run.finished_at??run.created_at).toISOString(),...(run.published_at?{publishedAt:run.published_at.toISOString()}:{}),
      dataVersion:"manifest",mappingVersion:"manifest",timezoneVersion:String(manifest.timezonePolicyVersion??"iana"),policyVersion:String(manifest.marketplacePolicyVersionId??"unknown"),formulaVersion:String(manifest.formulaVersion??"v1"),fxVersion:"calculation_fx_usage",
      metrics:keyMap.map(([key,column])=>{
        const amount=value[column]??"0.00000000";
        const income=value.income??"0.00000000";
        return {key,amountCny:amount,...(new Decimal(income).isZero()?{}:{ratioOfIncome:new Decimal(amount).div(income).toDecimalPlaces(8,Decimal.ROUND_HALF_UP).toFixed(8)})};
      }),
      completeness:visibleCompleteness.map((row)=>({sliceId:row.slice_id,datasetVersionId:row.dataset_version_id,disposition:row.disposition,marketplace:row.normalized_marketplace,month:row.local_month,state:row.disposition==='HARD_EXCLUDED'?'EXCLUDED':row.disposition==='INCLUDED_WITH_WARNING'?'PUBLISHED_WARNING':row.warning?'CONFLICT':'COMPLETE',
        ...(row.transaction_quantity?{transactionQuantity:row.transaction_quantity}:{}),...(row.shipment_quantity?{shipmentQuantity:row.shipment_quantity}:{}),
        ...(row.unmatched_absolute?{unmatchedAbsolute:row.unmatched_absolute}:{}),...(row.unmatched_ratio?{unmatchedRatio:row.unmatched_ratio}:{}),
        ...(row.hard_reason_codes.length
          ? { note: row.hard_reason_codes.join("、") }
          : row.disposition === "INCLUDED_WITH_WARNING"
            ? { note: "数量存在非零差异，已自动纳入并持续披露" }
            : row.warning ? { note: "数量差异尚未确认，不能发布" } : {})})),
      fees:fees.rows.map((row)=>({category:row.component,marketplace:row.marketplace,month:row.report_month,sourceRows:row.source_rows,amountCny:row.amount_cny})),
      notices:[...(BigInt(fallback.rows[0]?.count??"0")>0n?[`${fallback.rows[0]?.count} 笔金额使用了报表日期之后最近一个开市日的汇率，结果已经按该汇率计算。`]:[]),
        ...(unacknowledgedWarnings>0?[`${unacknowledgedWarnings} 个站点和月份的两份资料数量不一致，确认后才能发布正式结果。`]:[]),
        ...(hasFilter&&!effectivePublished?["当前只显示筛选后的部分结果，不能直接发布。请清除筛选后再发布完整结果。"]:[])],
      canPublish:run.status==='READY'&&!effectivePublished&&!hasFilter&&unacknowledgedWarnings===0};
  }
}
