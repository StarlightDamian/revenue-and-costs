import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { normalizeOfficialQuote } from "./normalize.js";
import { parseChinaMoneyPage, type ChinaMoneyRange, type ChinaMoneySource } from "./chinamoney.js";
import { parseUnambiguousDate } from "./date.js";

export type FxSyncKind = "FULL_HISTORY" | "RECENT_SEVEN_DAYS" | "MANUAL_RETRY";

async function persistPage(client: PoolClient, runId: string, source: ChinaMoneySource, page: Awaited<ReturnType<ChinaMoneySource["fetchPage"]>>) {
  const digest = createHash("sha256").update(page.rawBody).digest();
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO fx_raw_snapshot(id,sync_run_id,source_name,request_parameters,response_payload,response_sha256,http_status,response_headers)
     VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb)
     ON CONFLICT(source_name,response_sha256) DO NOTHING RETURNING id`,
    [randomUUID(),runId,source.sourceName,JSON.stringify(page.request),JSON.stringify(page.payload),digest,page.status,JSON.stringify(page.headers)],
  );
  const snapshotId = inserted.rows[0]?.id ?? (await client.query<{ id: string }>(
    "SELECT id FROM fx_raw_snapshot WHERE source_name=$1 AND response_sha256=$2",
    [source.sourceName,digest],
  )).rows[0]?.id;
  if (!snapshotId) throw new Error("FX_RAW_SNAPSHOT_NOT_PERSISTED");
  await client.query(
    `INSERT INTO fx_sync_run_snapshot(sync_run_id,snapshot_id,page_number,request_parameters)
     VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(sync_run_id,page_number) DO NOTHING`,
    [runId,snapshotId,page.page,JSON.stringify(page.request)],
  );

  const parsed = parseChinaMoneyPage(page.payload);
  const normalizedQuotes = new Map<string, { raw: (typeof parsed.quotes)[number]; normalized: ReturnType<typeof normalizeOfficialQuote> }>();
  for (const raw of parsed.quotes) {
    const id = randomUUID();
    const normalized = normalizeOfficialQuote({ id, snapshotId, ...raw });
    const normalizedKey = `${raw.validDate}:${normalized.currency}`;
    const existing = normalizedQuotes.get(normalizedKey);
    if (existing && existing.normalized.cnyPerUnit !== normalized.cnyPerUnit) {
      throw new Error(`CHINAMONEY_CONFLICTING_NORMALIZED_QUOTE:${normalizedKey}`);
    }
    if (!existing) normalizedQuotes.set(normalizedKey, { raw, normalized });
  }
  const quoteRows = [...normalizedQuotes.values()];
  if (quoteRows.length > 0) {
    await client.query(
      `INSERT INTO fx_quote(id,snapshot_id,valid_date,base_currency,quote_currency,base_unit,rate,cny_currency,cny_per_unit)
       SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::date[],$4::text[],$5::text[],$6::numeric[],$7::numeric[],$8::text[],$9::numeric[])
       ON CONFLICT DO NOTHING`,
      [
        quoteRows.map(({ normalized }) => normalized.id),
        quoteRows.map(() => snapshotId),
        quoteRows.map(({ raw }) => raw.validDate),
        quoteRows.map(({ raw }) => raw.baseCurrency),
        quoteRows.map(({ raw }) => raw.quoteCurrency),
        quoteRows.map(({ raw }) => raw.baseUnit),
        quoteRows.map(({ raw }) => raw.rate),
        quoteRows.map(({ normalized }) => normalized.currency),
        quoteRows.map(({ normalized }) => normalized.cnyPerUnit),
      ],
    );
  }
  const openDates = [...new Set(parsed.quotes.map((quote) => quote.validDate))];
  if (openDates.length > 0) {
    await client.query(
      `INSERT INTO fx_market_day(valid_date,status,evidence_type,snapshot_id,reason)
       SELECT date,'OPEN','OFFICIAL_CALENDAR',$2,'ChinaMoney 返回当日官方中间价' FROM unnest($1::date[]) AS date
       ON CONFLICT DO NOTHING`,
      [openDates,snapshotId],
    );
  }
  if (parsed.explicitNonTradingDates.length > 0) {
    await client.query(
      `INSERT INTO fx_market_day(valid_date,status,evidence_type,snapshot_id,reason)
       SELECT date,'NON_TRADING','OFFICIAL_CALENDAR',$2,'ChinaMoney 响应明确标记非交易日' FROM unnest($1::date[]) AS date
       ON CONFLICT DO NOTHING`,
      [parsed.explicitNonTradingDates,snapshotId],
    );
  }
  if (page.request.allPairs === "true") {
    const requestedFrom = page.request.from ? parseUnambiguousDate(page.request.from) : undefined;
    const requestedTo = page.request.to ? parseUnambiguousDate(page.request.to) : undefined;
    const absentThrough = page.request.allPairsAbsentThrough;
    if (!requestedFrom || !requestedTo || requestedFrom > requestedTo || !absentThrough) {
      throw new Error("CHINAMONEY_ALL_PAIRS_RANGE_EVIDENCE_INVALID");
    }
    const evidencedDates = [...openDates, ...parsed.explicitNonTradingDates];
    if (evidencedDates.some((date) => date < requestedFrom || date > requestedTo)) {
      throw new Error("CHINAMONEY_ALL_PAIRS_RANGE_EVIDENCE_INVALID");
    }
    if (absentThrough === "none") {
      if (openDates.length > 0) throw new Error("CHINAMONEY_ALL_PAIRS_RANGE_EVIDENCE_INVALID");
      return evidencedDates;
    }
    const parsedAbsentThrough = parseUnambiguousDate(absentThrough);
    if (!parsedAbsentThrough || parsedAbsentThrough < requestedFrom || parsedAbsentThrough > requestedTo
      || openDates.some((date) => date > parsedAbsentThrough)) {
      throw new Error("CHINAMONEY_ALL_PAIRS_RANGE_EVIDENCE_INVALID");
    }
    await client.query(
      `INSERT INTO fx_market_day(valid_date,status,evidence_type,snapshot_id,reason)
       SELECT day::date,'NON_TRADING','ALL_OFFICIAL_PAIRS_ABSENT',$3,
              'ChinaMoney 官方全币对请求在安全证据范围内当日无任何报价'
         FROM generate_series($1::date,$2::date,interval '1 day') AS day
        WHERE NOT (day::date=ANY($4::date[]))
          AND NOT (day::date=ANY($5::date[]))
       ON CONFLICT DO NOTHING`,
      [requestedFrom,parsedAbsentThrough,snapshotId,openDates,parsed.explicitNonTradingDates],
    );
  }
  return [...parsed.quotes.map((quote) => quote.validDate), ...parsed.explicitNonTradingDates];
}

export async function syncChinaMoney(pool: Pool, source: ChinaMoneySource, kind: FxSyncKind, range: ChinaMoneyRange): Promise<string> {
  const runId = randomUUID();
  await pool.query(
    `INSERT INTO fx_sync_run(id,sync_kind,requested_from,requested_to,status) VALUES($1,$2,$3,$4,'RUNNING')`,
    [runId,kind,range.from,range.to],
  );
  try {
    const dates: string[] = [];
    const responseHashes = new Set<string>();
    for (let pageNumber = 1; pageNumber <= 10_000; pageNumber += 1) {
      const page = await source.fetchPage(range,pageNumber,source.pageSize ?? 500);
      const responseHash = createHash("sha256").update(page.rawBody).digest("hex");
      if (responseHashes.has(responseHash)) throw new Error("CHINAMONEY_PAGINATION_STALLED");
      responseHashes.add(responseHash);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        dates.push(...await persistPage(client,runId,source,page));
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK"); throw error;
      } finally { client.release(); }
      if (!page.hasMore) break;
      if (pageNumber === 10_000) throw new Error("CHINAMONEY_PAGE_LIMIT_EXCEEDED");
    }
    dates.sort();
    await pool.query(
      `UPDATE fx_sync_run SET status='SUCCEEDED',coverage_from=$2,coverage_to=$3,finished_at=clock_timestamp(),error_code=NULL WHERE id=$1`,
      [runId,dates[0] ?? null,dates.at(-1) ?? null],
    );
    return runId;
  } catch (error) {
    await pool.query(
      `UPDATE fx_sync_run SET status='FAILED',finished_at=clock_timestamp(),error_code=$2 WHERE id=$1`,
      [runId,String(error).slice(0,500)],
    );
    throw error;
  }
}
