import type { SqlClient } from "../authorization/index.js";
import { convertBatch } from "./convert.js";
import type { FxQuoteBook, MarketDayStatus, NormalizedFxQuote } from "./types.js";

export class PostgresFxService {
  constructor(private readonly database: SqlClient) {}

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
    }>(`SELECT id, currency, valid_from::text, valid_to::text, cny_per_unit::text FROM fx_override`);
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
