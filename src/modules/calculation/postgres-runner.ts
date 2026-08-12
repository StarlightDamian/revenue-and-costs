import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { Writable } from "node:stream";
import { from as copyFrom } from "pg-copy-streams";
import type { Pool, PoolClient } from "pg";
import { convertCurrency, type FxQuoteBook, type MarketDayStatus, type NormalizedFxQuote } from "../fx/index.js";
import { FinancialAccumulator } from "./financial.js";
import { FEE_CLASSIFICATION_POLICY_SHA256, FEE_CLASSIFICATION_VERSION } from "./fee-classification.js";
import type { FactFxConversion, FeeClassificationAudit, FinancialSummary, ShipmentFact, TransactionFact } from "./types.js";

function escaped(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n").replaceAll("\r", "\\r"); }
async function line(stream: Writable, values: readonly string[]): Promise<void> {
  if (!stream.write(`${values.map(escaped).join("\t")}\n`)) await once(stream, "drain");
}
function pgArray(ids: readonly string[]): string { return ids.length ? `{${ids.join(",")}}` : "{}"; }

const PERMANENT_CALCULATION_FAILURE_CODES = [
  "FX_INVALID_DATE",
  "FX_INVALID_CURRENCY",
  "FX_DATA_GAP",
  "FX_NO_AVAILABLE_QUOTE",
  "AMBIGUOUS_FX_OVERRIDE",
  "AMBIGUOUS_OFFICIAL_QUOTE",
  "FX_DATE_MISMATCH",
  "INVALID_FX_HIT_DATE",
  "INVALID_FX_FALLBACK",
  "INVALID_FX_RATE",
  "INVALID_MAXIMUM_FX_FALLBACK_DAYS",
  "CALCULATION_SLICE_NOT_SELECTED",
  "CALCULATION_RUN_NOT_RUNNABLE",
  "CALCULATION_FX_OVERRIDE_MANIFEST_INVALID",
  "CALCULATION_FEE_CLASSIFICATION_MANIFEST_INVALID",
  "FEE_CLASSIFICATION_AUDIT_MISMATCH",
] as const;

type PermanentCalculationFailureCode = typeof PERMANENT_CALCULATION_FAILURE_CODES[number];
const permanentCalculationFailureCodes = new Set<string>(PERMANENT_CALCULATION_FAILURE_CODES);

export function permanentCalculationFailureCode(error: unknown): PermanentCalculationFailureCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = error.message.match(/^([A-Z][A-Z0-9_]*)(?::|$)/u)?.[1];
  return code && permanentCalculationFailureCodes.has(code) ? code as PermanentCalculationFailureCode : undefined;
}

function persistedCalculationFailureCode(error: unknown): string {
  if (error instanceof Error && /^(?:FX_DATA_GAP|FX_NO_AVAILABLE_QUOTE):[A-Z]{3}:\d{4}-\d{2}-\d{2}$/u.test(error.message)) {
    return error.message;
  }
  return permanentCalculationFailureCode(error) ?? "CALCULATION_FAILED";
}

export async function loadFxBook(
  client: PoolClient,
  from: string,
  to: string,
  frozenOverrideIds?: readonly string[],
): Promise<FxQuoteBook> {
  const quotes = await client.query<{ id: string; valid_date: string; cny_currency: string; cny_per_unit: string }>(
    `SELECT id,valid_date::text,cny_currency,cny_per_unit::text FROM fx_current_quote
      WHERE valid_date BETWEEN $1::date AND $2::date+interval '10 days'`, [from, to],
  );
  const overrides = frozenOverrideIds === undefined
    ? await client.query<{ id: string; currency: string; valid_from: string; valid_to: string; cny_per_unit: string }>(
      `SELECT id,currency,valid_from::text,valid_to::text,cny_per_unit::text FROM fx_current_override
        WHERE valid_to >= $1::date AND valid_from <= $2::date+interval '10 days'`, [from, to],
    )
    : await client.query<{ id: string; currency: string; valid_from: string; valid_to: string; cny_per_unit: string }>(
      `SELECT id,currency,valid_from::text,valid_to::text,cny_per_unit::text FROM fx_override
        WHERE valid_to >= $1::date AND valid_from <= $2::date+interval '10 days'
          AND id=ANY($3::uuid[])`, [from, to, frozenOverrideIds],
    );
  const days = await client.query<{ valid_date: string; status: Exclude<MarketDayStatus, "UNKNOWN"> }>(
    `SELECT valid_date::text,status FROM fx_current_market_day
      WHERE valid_date BETWEEN $1::date AND $2::date+interval '10 days' ORDER BY valid_date`, [from, to],
  );
  const dayMap = new Map(days.rows.map((row) => [row.valid_date, row.status]));
  const official: NormalizedFxQuote[] = quotes.rows.map((row) => ({ id: row.id, source: "OFFICIAL", validDate: row.valid_date, currency: row.cny_currency, cnyPerUnit: row.cny_per_unit }));
  return {
    official,
    overrides: overrides.rows.map((row) => ({ id: row.id, currency: row.currency, validFrom: row.valid_from, validTo: row.valid_to, cnyPerUnit: row.cny_per_unit })),
    marketDayStatus(date) { return dayMap.get(date) ?? "UNKNOWN"; },
  };
}

function conversion(book: FxQuoteBook, date: string, currency: string): FactFxConversion {
  const result = convertCurrency(book, date, currency, "CNY");
  if (result.status !== "OK" || !result.hitDate || !result.rate || result.fallbackDays === undefined) throw new Error(`FX_${result.status}:${currency}:${date}`);
  return { requestedDate: date, hitDate: result.hitDate, fallbackDays: result.fallbackDays, rate: result.rate, quoteIds: result.quoteIds, overrideIds: result.overrideIds };
}

interface CalculationSliceRow {
  readonly dataset_slice_id: string;
  readonly dataset_version_id: string;
}

export async function processRunFacts(
  client: PoolClient,
  runId: string,
  slices: readonly CalculationSliceRow[],
  book: FxQuoteBook,
  sink: Writable,
) {
  const accumulators = new Map(slices.map((slice) => [slice.dataset_slice_id, new FinancialAccumulator()]));
  const accumulatorFor = (sliceId: string) => {
    const accumulator = accumulators.get(sliceId);
    if (!accumulator) throw new Error(`CALCULATION_SLICE_NOT_SELECTED:${sliceId}`);
    return accumulator;
  };
  let lastShipment = 0n;
  while (true) {
    const rows = await client.query<Record<string, string>>(
      `SELECT rs.dataset_slice_id::text AS slice_id,sf.id::text AS fact_id,sf.dataset_version_id,sf.source_file_id,
        sf.row_number::text,encode(sf.row_hash,'hex') row_hash,
        normalized_marketplace,local_month::text,currency,fx_date::text,shipped_quantity::text,
        product_price::text,product_tax::text,shipping_price::text,shipping_tax::text,gift_wrap_price::text,gift_wrap_tax::text,
        product_promotion_discount::text,shipment_promotion_discount::text
       FROM shipment_fact sf JOIN calculation_run_slice rs ON rs.dataset_version_id=sf.dataset_version_id
        AND rs.calculation_run_id=$1 AND rs.disposition<>'HARD_EXCLUDED'
       WHERE sf.id>$2::bigint ORDER BY sf.id LIMIT 1000`, [runId, lastShipment.toString()],
    );
    if (!rows.rows.length) break;
    for (const row of rows.rows) {
      lastShipment = BigInt(row.fact_id!);
      const fact: ShipmentFact = { kind: "SHIPMENT", id: row.fact_id!, datasetVersionId: row.dataset_version_id!, sourceFileId: row.source_file_id!, rowNumber: row.row_number!, rowHash: row.row_hash!, marketplace: row.normalized_marketplace!, localMonth: row.local_month!, currency: row.currency!, fxDate: row.fx_date!, shippedQuantity: row.shipped_quantity!, amounts: { productPrice: row.product_price!, productTax: row.product_tax!, shippingPrice: row.shipping_price!, shippingTax: row.shipping_tax!, giftWrapPrice: row.gift_wrap_price!, giftWrapTax: row.gift_wrap_tax!, productPromotionDiscount: row.product_promotion_discount!, shipmentPromotionDiscount: row.shipment_promotion_discount! } };
      const fx = conversion(book, fact.fxDate, fact.currency);
      for (const result of accumulatorFor(row.slice_id!).addShipment(fact, fx)) await line(sink, [row.slice_id!, result.datasetVersionId, result.factKind, result.factId, result.sourceColumn, result.component, result.amountOriginal, result.amountCny, fx.requestedDate, fx.hitDate, fx.fallbackDays, pgArray(fx.quoteIds), pgArray(fx.overrideIds ?? []), fx.rate]);
    }
  }
  let lastTransaction = 0n;
  while (true) {
    const rows = await client.query<Record<string, string>>(
      `SELECT rs.dataset_slice_id::text AS slice_id,tf.id::text AS fact_id,tf.dataset_version_id,tf.source_file_id,
        tf.row_number::text,encode(tf.row_hash,'hex') row_hash,tf.normalized_marketplace,
        local_month::text,currency,fx_date::text,normalized_type,normalized_description,
        COALESCE(tf.fulfillment_mode,'BLANK') fulfillment_mode,product_sales::text,product_sales_tax::text,
        shipping_credits::text,shipping_credits_tax::text,gift_wrap_credits::text,gift_wrap_credits_tax::text,regulatory_fee::text,
        tax_on_regulatory_fee::text,promotional_rebates::text,promotional_rebates_tax::text,marketplace_withheld_tax::text,
        selling_fees::text,fba_fees::text,other_transaction_fees::text,other_amount::text
       FROM transaction_fact tf JOIN calculation_run_slice rs ON rs.dataset_version_id=tf.dataset_version_id
        AND rs.calculation_run_id=$1 AND rs.disposition<>'HARD_EXCLUDED'
       WHERE tf.id>$2::bigint ORDER BY tf.id LIMIT 1000`, [runId, lastTransaction.toString()],
    );
    if (!rows.rows.length) break;
    for (const row of rows.rows) {
      lastTransaction = BigInt(row.fact_id!);
      const fact: TransactionFact = {
        kind: "TRANSACTION",
        id: row.fact_id!,
        datasetVersionId: row.dataset_version_id!,
        sourceFileId: row.source_file_id!,
        rowNumber: row.row_number!,
        rowHash: row.row_hash!,
        marketplace: row.normalized_marketplace!,
        localMonth: row.local_month!,
        currency: row.currency!,
        fxDate: row.fx_date!,
        type: row.normalized_type!,
        description: row.normalized_description!,
        fulfillmentMode: row.fulfillment_mode! as TransactionFact["fulfillmentMode"],
        amounts: {
          productSales: row.product_sales!,
          productSalesTax: row.product_sales_tax!,
          shippingCredits: row.shipping_credits!,
          shippingCreditsTax: row.shipping_credits_tax!,
          giftWrapCredits: row.gift_wrap_credits!,
          giftWrapCreditsTax: row.gift_wrap_credits_tax!,
          regulatoryFee: row.regulatory_fee!,
          taxOnRegulatoryFee: row.tax_on_regulatory_fee!,
          promotionalRebates: row.promotional_rebates!,
          promotionalRebatesTax: row.promotional_rebates_tax!,
          marketplaceWithheldTax: row.marketplace_withheld_tax!,
          sellingFees: row.selling_fees!,
          fbaFees: row.fba_fees!,
          otherTransactionFees: row.other_transaction_fees!,
          other: row.other_amount!,
        },
      };
      const fx = conversion(book, fact.fxDate, fact.currency);
      for (const result of accumulatorFor(row.slice_id!).addTransaction(fact, fx)) await line(sink, [row.slice_id!, result.datasetVersionId, result.factKind, result.factId, result.sourceColumn, result.component, result.amountOriginal, result.amountCny, fx.requestedDate, fx.hitDate, fx.fallbackDays, pgArray(fx.quoteIds), pgArray(fx.overrideIds ?? []), fx.rate]);
    }
  }
  return slices.map((slice) => ({ sliceId: slice.dataset_slice_id, summary: accumulatorFor(slice.dataset_slice_id).summary() }));
}

export async function insertFeeClassificationAudits(
  client: PoolClient,
  audits: readonly FeeClassificationAudit[],
): Promise<void> {
  if (!audits.length) return;
  const rows = audits.map((audit) => ({
    fact_id: audit.factId,
    source_column: audit.sourceColumn === "other" ? "other_amount" : audit.sourceColumn.replace(/[A-Z]/gu, (value) => `_${value.toLowerCase()}`),
    category: audit.category,
    reason: audit.reason,
    amount_original: audit.amountOriginal,
  }));
  await client.query(
    `WITH input AS (
       SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(
         fact_id bigint,source_column text,category text,reason text,amount_original numeric)
     ), inserted AS (
       INSERT INTO transaction_fee_component(transaction_fact_id,source_column,category,amount_original,mapping_version_id,
         classification_version,classification_reason)
       SELECT input.fact_id,input.source_column,input.category,input.amount_original,file.mapping_version_id,$2,input.reason
         FROM input JOIN transaction_fact fact ON fact.id=input.fact_id JOIN import_file file ON file.id=fact.source_file_id
       ON CONFLICT(transaction_fact_id,source_column,classification_version) DO NOTHING
       RETURNING transaction_fact_id,source_column
     )
     SELECT 1
      WHERE EXISTS (
        SELECT 1 FROM input JOIN transaction_fee_component component
          ON component.transaction_fact_id=input.fact_id AND component.source_column=input.source_column
         AND component.classification_version=$2
        WHERE component.category<>input.category OR component.amount_original<>input.amount_original
           OR component.classification_reason<>input.reason
      )`,
    [JSON.stringify(rows), FEE_CLASSIFICATION_VERSION],
  ).then((result) => {
    if (result.rowCount) throw new Error("FEE_CLASSIFICATION_AUDIT_MISMATCH");
  });
}

async function processRunFeeClassifications(
  reader: PoolClient,
  writer: PoolClient,
  runId: string,
): Promise<void> {
  const classifier = new FinancialAccumulator();
  let lastTransaction = 0n;
  while (true) {
    const rows = await reader.query<Record<string, string>>(
      `SELECT tf.id::text AS fact_id,tf.normalized_type,tf.normalized_description,
        tf.selling_fees::text,tf.fba_fees::text,tf.other_transaction_fees::text,tf.other_amount::text
       FROM transaction_fact tf JOIN calculation_run_slice rs ON rs.dataset_version_id=tf.dataset_version_id
        AND rs.calculation_run_id=$1 AND rs.disposition<>'HARD_EXCLUDED'
       WHERE tf.id>$2::bigint ORDER BY tf.id LIMIT 1000`,
      [runId, lastTransaction.toString()],
    );
    if (!rows.rows.length) break;
    const audits: FeeClassificationAudit[] = [];
    for (const row of rows.rows) {
      lastTransaction = BigInt(row.fact_id!);
      audits.push(...classifier.classifyTransactionFees({
        id: row.fact_id!,
        type: row.normalized_type!,
        description: row.normalized_description!,
        amounts: {
          sellingFees: row.selling_fees!,
          fbaFees: row.fba_fees!,
          otherTransactionFees: row.other_transaction_fees!,
          other: row.other_amount!,
        },
      }));
    }
    await insertFeeClassificationAudits(writer, audits);
  }
}

export async function insertMonthlySummaries(
  client: PoolClient,
  runId: string,
  summaries: readonly { readonly sliceId: string; readonly summary: FinancialSummary }[],
): Promise<void> {
  if (!summaries.length) return;
  const rows = summaries.map(({ sliceId, summary }) => ({
    slice_id: sliceId,
    income: summary.income,
    refund: summary.refund,
    withheld_tax: summary.withheldTax,
    platform_fee: summary.platformFee,
    fba_fulfillment_fee: summary.fbaFulfillmentFee,
    advertising_fee: summary.advertisingFee,
    fba_storage_fee: summary.fbaStorageFee,
    other_deduction: summary.otherDeduction,
    platform_balance: summary.platformBalance,
  }));
  await client.query(
    `INSERT INTO monthly_cost_summary(calculation_run_id,dataset_slice_id,income,refund,withheld_tax,platform_fee,
       fba_fulfillment_fee,advertising_fee,fba_storage_fee,other_deduction,platform_balance)
     SELECT $1::uuid,input.slice_id,input.income,input.refund,input.withheld_tax,input.platform_fee,
       input.fba_fulfillment_fee,input.advertising_fee,input.fba_storage_fee,input.other_deduction,input.platform_balance
       FROM jsonb_to_recordset($2::jsonb) AS input(
         slice_id uuid,income numeric,refund numeric,withheld_tax numeric,platform_fee numeric,
         fba_fulfillment_fee numeric,advertising_fee numeric,fba_storage_fee numeric,other_deduction numeric,platform_balance numeric
       )`,
    [runId, JSON.stringify(rows)],
  );
}

export async function calculateRun(pool: Pool, runId: string, transactionClient?: PoolClient): Promise<void> {
  const client = transactionClient ?? await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await client.query<{ status: string; input_manifest: Record<string, unknown>; requested_by: string; fee_classification_version: string }>(
      "SELECT status,input_manifest,requested_by,fee_classification_version FROM calculation_run WHERE id=$1 FOR UPDATE",
      [runId],
    );
    const runRow = run.rows[0];
    const enqueueAutoPublish = async () => {
      const sourceImportBatchId = runRow?.input_manifest.sourceImportBatchId;
      if (runRow?.input_manifest.autoPublish !== true || typeof sourceImportBatchId !== "string") return;
      await client.query(
        `INSERT INTO outbox_event(id,topic,business_key,payload) VALUES($1,'report.auto-publish',$2,$3::jsonb)
         ON CONFLICT(topic,business_key) DO NOTHING`,
        [randomUUID(), runId, JSON.stringify({ runId, actorAccountId: runRow.requested_by, sourceImportBatchId })],
      );
    };
    if (runRow?.status === "READY") { await enqueueAutoPublish(); await client.query("COMMIT"); return; }
    if (!runRow || !["QUEUED","RUNNING","BLOCKED"].includes(runRow.status)) throw new Error("CALCULATION_RUN_NOT_RUNNABLE");
    if (runRow.fee_classification_version !== FEE_CLASSIFICATION_VERSION
        || runRow.input_manifest.feeClassificationVersion !== FEE_CLASSIFICATION_VERSION
        || runRow.input_manifest.feeClassificationPolicySha256 !== FEE_CLASSIFICATION_POLICY_SHA256) {
      throw new Error("CALCULATION_FEE_CLASSIFICATION_MANIFEST_INVALID");
    }
    await client.query("UPDATE calculation_run SET status='RUNNING',started_at=COALESCE(started_at,clock_timestamp()),finished_at=NULL,failure_code=NULL WHERE id=$1", [runId]);
    const range = await client.query<{ from_date: string; to_date: string }>(
      `SELECT min(fx_date)::text from_date,max(fx_date)::text to_date FROM (
        SELECT fx_date FROM shipment_fact sf JOIN calculation_run_slice rs ON rs.dataset_version_id=sf.dataset_version_id WHERE rs.calculation_run_id=$1 AND rs.disposition<>'HARD_EXCLUDED'
        UNION ALL SELECT fx_date FROM transaction_fact tf JOIN calculation_run_slice rs ON rs.dataset_version_id=tf.dataset_version_id WHERE rs.calculation_run_id=$1 AND rs.disposition<>'HARD_EXCLUDED') q`, [runId],
    );
    const dateRange = range.rows[0];
    const manifestOverrideIds = runRow.input_manifest.fxOverrideIds;
    if (manifestOverrideIds !== undefined && (
      !Array.isArray(manifestOverrideIds)
      || !manifestOverrideIds.every((id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id))
    )) throw new Error("CALCULATION_FX_OVERRIDE_MANIFEST_INVALID");
    const book = dateRange?.from_date
      ? await loadFxBook(client, dateRange.from_date, dateRange.to_date, manifestOverrideIds as readonly string[] | undefined)
      : { official: [], marketDayStatus: () => "UNKNOWN" as const };
    await client.query(`CREATE TEMP TABLE calculation_stage(slice_id uuid,dataset_version_id uuid,fact_kind text,fact_id bigint,source_column text,
      component text,amount_original numeric(30,8),amount_cny numeric(30,8),requested_date date,hit_date date,fallback_days smallint,
      quote_ids uuid[],override_ids uuid[],rate numeric(30,8),
      UNIQUE(fact_kind,fact_id,source_column,component)) ON COMMIT DROP`);
    const slices = await client.query<CalculationSliceRow>(
      "SELECT dataset_slice_id,dataset_version_id FROM calculation_run_slice WHERE calculation_run_id=$1 AND disposition<>'HARD_EXCLUDED' ORDER BY dataset_slice_id", [runId],
    );
    const reader = await pool.connect();
    let summaries;
    try {
      const sink = client.query(copyFrom("COPY calculation_stage FROM STDIN"));
      const sinkFinished = new Promise<void>((resolve, reject) => {
        sink.once("finish", resolve);
        sink.once("error", reject);
      });
      try {
        summaries = await processRunFacts(reader, runId, slices.rows, book, sink);
        sink.end(); await sinkFinished;
        await processRunFeeClassifications(reader, client, runId);
      } catch (error) {
        sink.destroy(error instanceof Error ? error : new Error(String(error)));
        await sinkFinished.catch(() => undefined);
        throw error;
      }
    } finally { reader.release(); }
    await insertMonthlySummaries(client, runId, summaries);
    await client.query(
      `INSERT INTO calculation_fact_result(calculation_run_id,dataset_version_id,fact_kind,fact_id,source_column,component,amount_original,amount_cny)
       SELECT $1,dataset_version_id,fact_kind,fact_id,source_column,component,amount_original,amount_cny
         FROM calculation_stage`, [runId],
    );
    await client.query(
      `INSERT INTO calculation_fx_usage(calculation_fact_result_id,requested_date,hit_date,fallback_days,official_quote_ids,override_ids,cny_per_unit)
       SELECT r.id,s.requested_date,s.hit_date,s.fallback_days,s.quote_ids,s.override_ids,s.rate
         FROM calculation_stage s JOIN calculation_fact_result r ON r.calculation_run_id=$1 AND r.fact_kind=s.fact_kind
          AND r.fact_id=s.fact_id AND r.source_column=s.source_column AND r.component=s.component`, [runId],
    );
    await client.query("UPDATE calculation_run SET status='READY',finished_at=clock_timestamp() WHERE id=$1", [runId]);
    await enqueueAutoPublish();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (!transactionClient) client.release();
  }
}

export async function markCalculationRunFailed(pool: Pool, runId: string, error: unknown): Promise<void> {
  await pool.query(
    `WITH failed_run AS (
       UPDATE calculation_run
          SET status='FAILED',failure_code=$2,finished_at=clock_timestamp()
        WHERE id=$1 AND status IN ('QUEUED','RUNNING','BLOCKED')
        RETURNING input_manifest,shop_id
     )
     UPDATE import_batch AS batch
        SET status='FAILED',current_stage='CALCULATION_BLOCKED',failure_code=$2,updated_at=clock_timestamp()
       FROM failed_run
      WHERE batch.id::text=failed_run.input_manifest->>'sourceImportBatchId'
        AND batch.shop_id=failed_run.shop_id
        AND batch.status IN ('COMMITTED','COMMITTED_WITH_EXCLUSIONS','CALCULATING')`,
    [runId, persistedCalculationFailureCode(error)],
  );
}
