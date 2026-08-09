import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FixtureChinaMoneySource,
  HttpChinaMoneySource,
  normalizeOfficialQuote,
  parseChinaMoneyPage,
} from "../../src/modules/fx/index.js";

const fixturePath = resolve("tests/fixtures/fx/chinamoney-sample.json");

describe("ChinaMoney provider adapter", () => {
  it("parses wide official quote rows, 100 JPY and explicit non-trading evidence", async () => {
    const payload: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
    const parsed = parseChinaMoneyPage(payload);
    expect(parsed.explicitNonTradingDates).toEqual(["2026-07-25", "2026-07-26"]);
    expect(parsed.quotes).toHaveLength(3);
    expect(parsed.quotes.map((quote, index) => normalizeOfficialQuote({
      id: `q-${index}`,
      snapshotId: "snapshot",
      ...quote,
    }).cnyPerUnit)).toEqual(["7.10000000", "0.04800000", "1.53846154"]);
  });

  it("rejects conflicting values for one date and currency pair", () => {
    expect(() => parseChinaMoneyPage({ records: [
      { validDate: "2026-07-24", currencyPair: "USD/CNY", rate: "7.1" },
      { validDate: "2026-07-24", currencyPair: "USD/CNY", rate: "7.2" },
    ] })).toThrow("CHINAMONEY_CONFLICTING_QUOTE");
  });

  it("retains directional pairs for normalization-level conflict validation", () => {
    const parsed = parseChinaMoneyPage({ records: [{
      validDate: "2026-07-24",
      "USD/CNY": "7.10000000",
      "CNY/USD": "0.15000000"
    }] });
    expect(parsed.quotes).toHaveLength(2);
  });

  it("rejects JSON numeric rates before JavaScript number precision can enter finance", () => {
    expect(() => parseChinaMoneyPage({ records: [
      { validDate: "2026-07-24", currencyPair: "USD/CNY", rate: 7.1 },
    ] })).toThrow("CHINAMONEY_QUOTES_NOT_FOUND");
  });

  it("keeps fixture use local and single-page", async () => {
    const source = new FixtureChinaMoneySource(fixturePath);
    const page = await source.fetchPage({ from: "2026-07-24", to: "2026-07-26" }, 1, 500);
    expect(page).toMatchObject({ status: 200, page: 1, hasMore: false });
    expect(page.request.fixture).toBe("chinamoney-sample.json");
    expect(page.request.fixture).not.toContain(":");
    await expect(source.fetchPage({ from: "2026-07-24", to: "2026-07-26" }, 2, 500))
      .rejects.toThrow("CHINAMONEY_FIXTURE_SINGLE_PAGE_ONLY");
  });

  it("requires a pageable endpoint and preserves page metadata", async () => {
    expect(() => new HttpChinaMoneySource("https://example.test?from={from}"))
      .toThrow("CHINAMONEY_ENDPOINT_PLACEHOLDER_MISSING");
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        records: [{ validDate: "2026-07-24", currencyPair: "USD/CNY", rate: "7.1" }],
        totalPages: 2,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const source = new HttpChinaMoneySource(
      "https://example.test/quotes?from={from}&to={to}&page={page}&size={pageSize}",
      fetcher,
    );
    const page = await source.fetchPage({ from: "2026-07-01", to: "2026-07-24" }, 1, 500);
    expect(page.hasMore).toBe(true);
    expect(requests[0]).toContain("page=1");
    expect(page.request).toEqual({ endpoint: "https://example.test/quotes", from: "2026-07-01", to: "2026-07-24", page: "1", pageSize: "500" });
  });
});
