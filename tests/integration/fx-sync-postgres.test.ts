import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FixtureChinaMoneySource, syncChinaMoney, type ChinaMoneySource } from "../../src/modules/fx/index.js";
import { createPostgresTestSchema, type PostgresTestSchema } from "./postgres-harness.js";

describe("ChinaMoney PostgreSQL sync", () => {
  let database: PostgresTestSchema | undefined;
  let pool!: PostgresTestSchema["pool"];
  const source = new FixtureChinaMoneySource(resolve("tests/fixtures/fx/chinamoney-sample.json"));

  beforeAll(async () => {
    database = await createPostgresTestSchema();
    pool = database.pool;
  });
  afterAll(async () => { await database?.cleanup(); });

  it("links repeated immutable payloads to every successful run without duplicating quotes", async () => {
    const before = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM fx_quote");
    const first = await syncChinaMoney(pool, source, "MANUAL_RETRY", { from: "2026-07-24", to: "2026-07-26" });
    const afterFirst = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM fx_quote");
    const second = await syncChinaMoney(pool, source, "MANUAL_RETRY", { from: "2026-07-24", to: "2026-07-26" });
    const afterSecond = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM fx_quote");
    const links = await pool.query<{ run_id: string; request_parameters: Record<string, string> }>(
      "SELECT sync_run_id::text AS run_id,request_parameters FROM fx_sync_run_snapshot WHERE sync_run_id=ANY($1::uuid[]) ORDER BY sync_run_id",
      [[first, second]],
    );
    const runs = await pool.query<{ id: string; status: string; coverage_from: string; coverage_to: string }>(
      "SELECT id::text,status,coverage_from::text,coverage_to::text FROM fx_sync_run WHERE id=ANY($1::uuid[]) ORDER BY id",
      [[first, second]],
    );
    expect(BigInt(afterFirst.rows[0]!.count) - BigInt(before.rows[0]!.count)).toBeGreaterThanOrEqual(0n);
    expect(afterSecond.rows[0]!.count).toBe(afterFirst.rows[0]!.count);
    expect(new Set(links.rows.map((row) => row.run_id))).toEqual(new Set([first, second]));
    expect(links.rows.every((row) => row.request_parameters.fixture === "chinamoney-sample.json" && !row.request_parameters.fixture.includes(":"))).toBe(true);
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows.every((run) => run.status === "SUCCEEDED" && run.coverage_from === "2026-07-24" && run.coverage_to === "2026-07-26")).toBe(true);
  });

  it("makes a snapshot current when a successful retry reuses bytes first stored by a failed run", async () => {
    const scenario = randomUUID();
    const payload = { scenario, records: [{ validDate: "2040-01-02", currencyPair: "CHF/CNY", rate: "8.12500000" }] };
    const rawBody = JSON.stringify(payload);
    const source = (failAfterFirstPage: boolean): ChinaMoneySource => ({
      sourceName: "ChinaMoneyFixture",
      async fetchPage(range, page, pageSize) {
        if (page === 2) throw new Error("INJECTED_SECOND_PAGE_FAILURE");
        return {
          request: { fixture: "retry-scenario.json", from: range.from, to: range.to, page: String(page), pageSize: String(pageSize) },
          status: 200,
          headers: { "content-type": "application/json" },
          rawBody,
          payload,
          page,
          hasMore: failAfterFirstPage,
        };
      },
    });
    await expect(syncChinaMoney(pool, source(true), "MANUAL_RETRY", { from: "2040-01-02", to: "2040-01-02" }))
      .rejects.toThrow("INJECTED_SECOND_PAGE_FAILURE");
    const succeeded = await syncChinaMoney(pool, source(false), "MANUAL_RETRY", { from: "2040-01-02", to: "2040-01-02" });
    const current = await pool.query<{ cny_per_unit: string }>(
      "SELECT cny_per_unit::text FROM fx_current_quote WHERE valid_date='2040-01-02' AND cny_currency='CHF'",
    );
    const trace = await pool.query<{ request_parameters: Record<string, string> }>(
      "SELECT request_parameters FROM fx_sync_run_snapshot WHERE sync_run_id=$1",
      [succeeded],
    );
    expect(current.rows[0]?.cny_per_unit).toBe("8.12500000");
    expect(trace.rows[0]?.request_parameters.fixture).toBe("retry-scenario.json");
  });

  it("fails a stalled paginated source instead of ingesting the same page until the hard limit", async () => {
    const payload = { records: [{ validDate: "2040-01-03", currencyPair: "NZD/CNY", rate: "4.25000000" }] };
    const rawBody = JSON.stringify(payload);
    const stalled: ChinaMoneySource = {
      sourceName: "ChinaMoneyFixture",
      async fetchPage(range, page, pageSize) {
        return {
          request: { fixture: "stalled.json", from: range.from, to: range.to, page: String(page), pageSize: String(pageSize) },
          status: 200,
          headers: { "content-type": "application/json" },
          rawBody,
          payload,
          page,
          hasMore: true,
        };
      },
    };
    await expect(syncChinaMoney(pool, stalled, "MANUAL_RETRY", { from: "2040-01-03", to: "2040-01-03" }))
      .rejects.toThrow("CHINAMONEY_PAGINATION_STALLED");
    const failed = await pool.query<{ status: string; error_code: string }>(
      "SELECT status,error_code FROM fx_sync_run WHERE requested_from='2040-01-03' ORDER BY started_at DESC LIMIT 1",
    );
    expect(failed.rows[0]).toMatchObject({ status: "FAILED", error_code: "Error: CHINAMONEY_PAGINATION_STALLED" });
    expect(await pool.query("SELECT 1 FROM fx_current_market_day WHERE valid_date='2040-01-03'")).toHaveProperty("rowCount", 0);
  });

  it("rejects two directional fields that normalize to conflicting CNY rates", async () => {
    const payload = { records: [{ validDate: "2040-01-04", "USD/CNY": "7.10000000", "CNY/USD": "0.15000000" }] };
    const rawBody = JSON.stringify(payload);
    const conflicting: ChinaMoneySource = {
      sourceName: "ChinaMoneyFixture",
      async fetchPage(range, page, pageSize) {
        return {
          request: { fixture: "conflicting.json", from: range.from, to: range.to, page: String(page), pageSize: String(pageSize) },
          status: 200,
          headers: { "content-type": "application/json" },
          rawBody,
          payload,
          page,
          hasMore: false,
        };
      },
    };
    await expect(syncChinaMoney(pool, conflicting, "MANUAL_RETRY", { from: "2040-01-04", to: "2040-01-04" }))
      .rejects.toThrow("CHINAMONEY_CONFLICTING_NORMALIZED_QUOTE");
  });

  it("records all-pairs-absent dates from an explicitly marked authoritative range as non-trading", async () => {
    const payload = { records: [{ validDate: "2040-01-06", "USD/CNY": "7.10000000" }] };
    const rawBody = JSON.stringify(payload);
    const source: ChinaMoneySource = {
      sourceName: "ChinaMoney",
      async fetchPage(_range, page, pageSize) {
        return {
          request: {
            from: "2040-01-06",
            to: "2040-01-08",
            page: String(page),
            pageSize: String(pageSize),
            allPairs: "true",
            allPairsAbsentThrough: "2040-01-08",
          },
          status: 200,
          headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
          rawBody,
          payload,
          page,
          hasMore: false,
        };
      },
    };

    await syncChinaMoney(pool, source, "MANUAL_RETRY", { from: "2040-01-06", to: "2040-01-08" });
    const days = await pool.query<{ valid_date: string; status: string; evidence_type: string }>(
      `SELECT valid_date::text,status,evidence_type FROM fx_current_market_day
        WHERE valid_date BETWEEN '2040-01-06' AND '2040-01-08' ORDER BY valid_date`,
    );
    expect(days.rows).toEqual([
      { valid_date: "2040-01-06", status: "OPEN", evidence_type: "OFFICIAL_CALENDAR" },
      { valid_date: "2040-01-07", status: "NON_TRADING", evidence_type: "ALL_OFFICIAL_PAIRS_ABSENT" },
      { valid_date: "2040-01-08", status: "NON_TRADING", evidence_type: "ALL_OFFICIAL_PAIRS_ABSENT" },
    ]);
  });
});
