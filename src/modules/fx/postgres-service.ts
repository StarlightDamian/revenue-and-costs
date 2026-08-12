import { createHash } from "node:crypto";
import type { SqlClient } from "../authorization/index.js";
import type { Actor, TransactionRunner, TransactionSideEffects } from "../authorization/index.js";
import { AppError } from "../../shared/errors.js";
import { convertBatch } from "./convert.js";
import { parseUnambiguousDate } from "./date.js";
import { currencyCode, decimal, decimal8 } from "./decimal.js";
import type { FxQuoteBook, MarketDayStatus, NormalizedFxQuote } from "./types.js";

export interface FxOverrideRecord {
  readonly id: string;
  readonly currency: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly cnyPerUnit: string;
  readonly sourceReference: string;
  readonly reason: string;
  readonly createdAt: string;
  readonly supersedesOverrideId: string | null;
  readonly isCurrent: boolean;
}

export interface FxOverrideWriteInput {
  readonly actor: Actor;
  readonly currency: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly cnyPerUnit: string;
  readonly sourceReference: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly requestId: string;
}

interface FxOverrideRow extends Record<string, unknown> {
  readonly id: string;
  readonly currency: string;
  readonly valid_from: string;
  readonly valid_to: string;
  readonly cny_per_unit: string;
  readonly source_reference: string;
  readonly reason: string;
  readonly created_at: Date | string;
  readonly supersedes_override_id: string | null;
  readonly is_current: boolean;
}

interface NormalizedOverrideWrite {
  readonly currency: string;
  readonly validFrom: string;
  readonly validTo: string;
  readonly cnyPerUnit: string;
  readonly sourceReference: string;
  readonly reason: string;
}

function normalizeOverrideWrite(input: FxOverrideWriteInput): NormalizedOverrideWrite {
  let currency: string;
  try {
    currency = currencyCode(input.currency);
  } catch {
    throw new AppError("FX_OVERRIDE_CURRENCY_INVALID", "币种必须是 CNY 以外的三位字母代码", 400, "currency");
  }
  if (currency === "CNY") {
    throw new AppError("FX_OVERRIDE_CURRENCY_INVALID", "人工汇率币种不能是 CNY", 400, "currency");
  }

  const validFrom = input.validFrom.trim();
  const validTo = input.validTo.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(validFrom) || parseUnambiguousDate(validFrom) !== validFrom) {
    throw new AppError("FX_OVERRIDE_DATE_INVALID", "开始日期无效", 400, "validFrom");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(validTo) || parseUnambiguousDate(validTo) !== validTo) {
    throw new AppError("FX_OVERRIDE_DATE_INVALID", "结束日期无效", 400, "validTo");
  }
  if (validFrom > validTo) {
    throw new AppError("FX_OVERRIDE_DATE_RANGE_INVALID", "开始日期不能晚于结束日期", 400, "validFrom");
  }

  const rawRate = input.cnyPerUnit.trim();
  if (!/^(?:0|[1-9][0-9]{0,21})(?:\.[0-9]{1,8})?$/u.test(rawRate)) {
    throw new AppError("FX_OVERRIDE_RATE_INVALID", "汇率必须是正数且最多保留 8 位小数", 400, "cnyPerUnit");
  }
  const rate = decimal(rawRate);
  if (rate.lte(0)) {
    throw new AppError("FX_OVERRIDE_RATE_INVALID", "汇率必须大于 0", 400, "cnyPerUnit");
  }

  const sourceReference = input.sourceReference.trim();
  if (!sourceReference) {
    throw new AppError("FX_OVERRIDE_SOURCE_REQUIRED", "人工汇率必须填写授权来源", 400, "sourceReference");
  }
  if (sourceReference.length > 2000) {
    throw new AppError("FX_OVERRIDE_SOURCE_TOO_LONG", "授权来源不能超过 2000 个字符", 400, "sourceReference");
  }
  const reason = input.reason.trim();
  if (!reason) throw new AppError("REASON_REQUIRED", "人工汇率必须填写新增或修改原因", 400, "reason");
  if (reason.length > 1000) throw new AppError("REASON_TOO_LONG", "新增或修改原因不能超过 1000 个字符", 400, "reason");
  return { currency, validFrom, validTo, cnyPerUnit: decimal8(rate), sourceReference, reason };
}

function overrideRecord(row: FxOverrideRow): FxOverrideRecord {
  return {
    id: row.id,
    currency: row.currency,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    cnyPerUnit: row.cny_per_unit,
    sourceReference: row.source_reference,
    reason: row.reason,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    supersedesOverrideId: row.supersedes_override_id,
    isCurrent: row.is_current,
  };
}

function fxWriteConflict(error: unknown): never {
  if (error instanceof AppError) throw error;
  const constraint = typeof error === "object" && error !== null && "constraint" in error
    ? String((error as { constraint?: unknown }).constraint ?? "")
    : "";
  if (constraint === "fx_override_official_gap_only") {
    throw new AppError("FX_OVERRIDE_OFFICIAL_QUOTE_EXISTS", "所选期间已有官方报价，人工汇率只能补齐官方缺口", 409);
  }
  if (constraint === "fx_override_current_range_no_overlap") {
    throw new AppError("FX_OVERRIDE_RANGE_OVERLAP", "该币种已有生效期间重叠的人工汇率", 409);
  }
  if (["fx_override_predecessor_current", "fx_override_single_successor_uq"].includes(constraint)) {
    throw new AppError("FX_OVERRIDE_REVISION_CONFLICT", "该人工汇率已被修改，请刷新后重试", 409);
  }
  if (constraint === "fx_override_revision_currency") {
    throw new AppError("FX_OVERRIDE_CURRENCY_IMMUTABLE", "修改人工汇率时不能更换币种", 409, "currency");
  }
  throw error;
}

export class PostgresFxService {
  constructor(
    private readonly database: SqlClient,
    private readonly transactions: TransactionRunner,
    private readonly effects: TransactionSideEffects,
  ) {}

  async listOverrides(): Promise<{ rows: readonly FxOverrideRecord[] }> {
    const result = await this.database.query<FxOverrideRow>(
      `SELECT entry.id,entry.currency,entry.valid_from::text,entry.valid_to::text,entry.cny_per_unit::text,
              entry.source_reference,entry.reason,entry.created_at,entry.supersedes_override_id,
              NOT EXISTS(SELECT 1 FROM fx_override successor WHERE successor.supersedes_override_id=entry.id) AS is_current
         FROM fx_override entry
        ORDER BY entry.currency,entry.valid_from DESC,entry.created_at DESC,entry.id DESC`,
    );
    return { rows: result.rows.map(overrideRecord) };
  }

  async createOverride(input: FxOverrideWriteInput): Promise<{ override: FxOverrideRecord }> {
    return this.writeOverride(input, null);
  }

  async reviseOverride(overrideId: string, input: FxOverrideWriteInput): Promise<{ override: FxOverrideRecord }> {
    return this.writeOverride(input, overrideId);
  }

  private async writeOverride(
    input: FxOverrideWriteInput,
    supersedesOverrideId: string | null,
  ): Promise<{ override: FxOverrideRecord }> {
    const normalized = normalizeOverrideWrite(input);
    const scope = supersedesOverrideId ? `fx.override.revise:${supersedesOverrideId}` : "fx.override.create";
    const requestHash = createHash("sha256").update(JSON.stringify({ supersedesOverrideId, ...normalized })).digest("hex");
    try {
      return await this.transactions.transaction(async (client) => {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('idempotency:' || $1 || ':' || $2 || ':' || $3, 0))",
          [input.actor.accountId, scope, input.idempotencyKey],
        );
        const prior = await client.query<{
          request_hash: string;
          response_body: { override: FxOverrideRecord } | null;
        }>(
          `SELECT request_hash,response_body FROM idempotency_record
            WHERE actor_account_id=$1 AND scope=$2 AND idempotency_key=$3`,
          [input.actor.accountId, scope, input.idempotencyKey],
        );
        const replay = prior.rows[0];
        if (replay) {
          if (replay.request_hash !== requestHash) {
            throw new AppError("IDEMPOTENCY_KEY_REUSED", "同一幂等键不能用于不同人工汇率操作", 409);
          }
          if (!replay.response_body?.override) throw new Error("IDEMPOTENT_FX_OVERRIDE_RESPONSE_MISSING");
          return replay.response_body;
        }

        let predecessor: FxOverrideRecord | null = null;
        if (supersedesOverrideId) {
          const selected = await client.query<FxOverrideRow>(
            `SELECT entry.id,entry.currency,entry.valid_from::text,entry.valid_to::text,entry.cny_per_unit::text,
                    entry.source_reference,entry.reason,entry.created_at,entry.supersedes_override_id,
                    NOT EXISTS(SELECT 1 FROM fx_override successor WHERE successor.supersedes_override_id=entry.id) AS is_current
               FROM fx_override entry WHERE entry.id=$1`,
            [supersedesOverrideId],
          );
          const row = selected.rows[0];
          if (!row) throw new AppError("RESOURCE_NOT_FOUND", "人工汇率不存在", 404);
          predecessor = overrideRecord(row);
          if (!predecessor.isCurrent) {
            throw new AppError("FX_OVERRIDE_REVISION_CONFLICT", "该人工汇率已被修改，请刷新后重试", 409);
          }
          if (predecessor.currency !== normalized.currency) {
            throw new AppError("FX_OVERRIDE_CURRENCY_IMMUTABLE", "修改人工汇率时不能更换币种", 409, "currency");
          }
        }

        const inserted = await client.query<FxOverrideRow>(
          `INSERT INTO fx_override(currency,valid_from,valid_to,cny_per_unit,source_reference,reason,created_by,supersedes_override_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING id,currency,valid_from::text,valid_to::text,cny_per_unit::text,source_reference,reason,created_at,
                     supersedes_override_id,true AS is_current`,
          [normalized.currency, normalized.validFrom, normalized.validTo, normalized.cnyPerUnit,
            normalized.sourceReference, normalized.reason, input.actor.accountId, supersedesOverrideId],
        );
        const row = inserted.rows[0];
        if (!row) throw new Error("FX_OVERRIDE_CREATE_FAILED");
        const override = overrideRecord(row);
        const response = { override };
        await this.effects.audit(client, {
          actorAccountId: input.actor.accountId,
          actorRoles: [...input.actor.roles],
          objectType: "fx_override",
          objectId: override.id,
          action: predecessor ? "FX_OVERRIDE_REVISED" : "FX_OVERRIDE_CREATED",
          result: "SUCCEEDED",
          reason: normalized.reason,
          requestId: input.requestId,
          before: predecessor ? { ...predecessor } : null,
          after: { ...override },
        });
        await client.query(
          `INSERT INTO idempotency_record(actor_account_id,scope,idempotency_key,request_hash,response_status,response_body,expires_at)
           VALUES($1,$2,$3,$4,201,$5::jsonb,clock_timestamp()+interval '365 days')`,
          [input.actor.accountId, scope, input.idempotencyKey, requestHash, JSON.stringify(response)],
        );
        return response;
      });
    } catch (error) {
      return fxWriteConflict(error);
    }
  }

  async history(input: { from?: string; to?: string; currencies?: readonly string[] }) {
    const result = await this.database.query<{
      id: string; valid_date: string; base_currency: string; quote_currency: string; base_unit: string;
      rate: string; cny_currency: string; cny_per_unit: string;
    }>(
      `SELECT id, valid_date::text, base_currency, quote_currency, base_unit::numeric(30,0)::text AS base_unit, rate::text,
              cny_currency, cny_per_unit::text
         FROM fx_current_quote
        WHERE ($1::date IS NULL OR valid_date >= $1::date)
          AND ($2::date IS NULL OR valid_date <= $2::date)
          AND ($3::text[] IS NULL OR cny_currency = ANY($3::text[]))
        ORDER BY valid_date DESC, cny_currency LIMIT 5000`,
      [input.from ?? null, input.to ?? null, input.currencies?.length ? input.currencies : null],
    );
    return { rows: result.rows.map((row) => ({
      id: row.id,
      validDate: row.valid_date,
      currency: row.cny_currency,
      cnyPerUnit: row.cny_per_unit,
      officialPair: `${row.base_unit === "1" ? "" : row.base_unit}${row.base_currency}/${row.quote_currency}`,
      officialRate: row.rate,
    })) };
  }

  async status() {
    const [latest, coverage, lastSucceeded] = await Promise.all([this.database.query<{
      id: string; sync_kind: string; status: string; coverage_from: string | null; coverage_to: string | null;
      started_at: Date; finished_at: Date | null; error_code: string | null;
    }>(`SELECT id, sync_kind, status, coverage_from::text, coverage_to::text, started_at, finished_at, error_code
          FROM fx_sync_run ORDER BY started_at DESC LIMIT 1`), this.database.query<{
      coverage_from: string | null; coverage_to: string | null; quote_count: string;
    }>(`SELECT min(valid_date)::text AS coverage_from,max(valid_date)::text AS coverage_to,count(*)::text AS quote_count
          FROM fx_current_quote`), this.database.query<{ finished_at: Date }>(
      `SELECT finished_at FROM fx_sync_run WHERE status='SUCCEEDED' ORDER BY finished_at DESC LIMIT 1`,
    )]);
    const row = latest.rows[0];
    const stored = coverage.rows[0];
    return row ? {
      id: row.id, syncKind: row.sync_kind, status: row.status, coverageFrom: stored?.coverage_from ?? null,
      coverageTo: stored?.coverage_to ?? null, quoteCount: Number(stored?.quote_count ?? "0"),
      startedAt: row.started_at.toISOString(), finishedAt: row.finished_at?.toISOString() ?? null,
      lastSucceededAt: lastSucceeded.rows[0]?.finished_at.toISOString() ?? null,
      errorCode: row.error_code,
    } : { status: "NEVER_SYNCED", coverageFrom: null, coverageTo: null, quoteCount: 0, lastSucceededAt: null };
  }

  async convertBatch(rows: readonly { input: string; fromCurrency: string; toCurrency: string }[]) {
    const dates = rows.map((row) => row.input).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort();
    const latest = dates.at(-1);
    const earliest = dates[0];
    const quoteRows = await this.database.query<{
      id: string; valid_date: string; cny_currency: string; cny_per_unit: string;
    }>(
      `SELECT id, valid_date::text, cny_currency, cny_per_unit::text FROM fx_current_quote
        WHERE ($1::date IS NULL OR valid_date >= $1::date)
          AND ($2::date IS NULL OR valid_date <= $2::date + interval '10 days')`,
      [earliest ?? null, latest ?? null],
    );
    const marketRows = await this.database.query<{ valid_date: string; status: Exclude<MarketDayStatus, "UNKNOWN"> }>(
      `SELECT valid_date::text, status FROM fx_current_market_day
        WHERE ($1::date IS NULL OR valid_date >= $1::date)
          AND ($2::date IS NULL OR valid_date <= $2::date + interval '10 days')
        ORDER BY valid_date`,
      [earliest ?? null, latest ?? null],
    );
    const overrideRows = await this.database.query<{
      id: string; currency: string; valid_from: string; valid_to: string; cny_per_unit: string;
    }>(`SELECT id, currency, valid_from::text, valid_to::text, cny_per_unit::text FROM fx_current_override`);
    const days = new Map(marketRows.rows.map((row) => [row.valid_date, row.status]));
    const official: NormalizedFxQuote[] = quoteRows.rows.map((row) => ({
      id: row.id, source: "OFFICIAL", validDate: row.valid_date, currency: row.cny_currency, cnyPerUnit: row.cny_per_unit,
    }));
    const book: FxQuoteBook = {
      official,
      overrides: overrideRows.rows.map((row) => ({ id: row.id, currency: row.currency, validFrom: row.valid_from, validTo: row.valid_to, cnyPerUnit: row.cny_per_unit })),
      marketDayStatus(date) { return days.get(date) ?? "UNKNOWN"; },
    };
    return { rows: convertBatch(book, rows) };
  }
}
