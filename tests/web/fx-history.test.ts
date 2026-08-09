import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { defaultFxHistoryRange, pivotFxHistory } from "../../src/web/fx-history.js";

describe("FX history page model", () => {
  it("defaults to the preceding calendar month in Shanghai time", () => {
    expect(defaultFxHistoryRange(Temporal.PlainDate.from("2026-07-28"))).toEqual({
      from: "2026-06-28",
      to: "2026-07-28",
    });
  });

  it("pivots official pairs into descending date rows and keeps new pairs", () => {
    const quote = (date: string, officialPair: string, officialRate: string) => ({
      date, officialPair, officialRate, currency: officialPair.startsWith("CNY/") ? officialPair.slice(4) : officialPair.replace(/^\d*/u, "").slice(0, 3),
      cnyPerUnit: officialRate, quoteId: `${date}:${officialPair}`, source: "OFFICIAL",
    });
    const result = pivotFxHistory([
      quote("2026-07-27", "ZZZ/CNY", "1.00000000"),
      quote("2026-07-28", "100JPY/CNY", "4.14270000"),
      quote("2026-07-28", "USD/CNY", "6.79280000"),
    ]);
    expect(result.columns).toEqual(["USD/CNY", "100JPY/CNY", "ZZZ/CNY"]);
    expect(result.rows).toEqual([
      { date: "2026-07-28", rates: { "100JPY/CNY": "4.14270000", "USD/CNY": "6.79280000" } },
      { date: "2026-07-27", rates: { "ZZZ/CNY": "1.00000000" } },
    ]);
  });
});
