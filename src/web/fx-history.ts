import { Temporal } from "@js-temporal/polyfill";
import type { FxQuote } from "./api/types";

const PAIR_ORDER = [
  "USD/CNY", "EUR/CNY", "100JPY/CNY", "HKD/CNY", "GBP/CNY", "AUD/CNY", "NZD/CNY",
  "SGD/CNY", "CHF/CNY", "CAD/CNY", "CNY/MOP", "CNY/MYR", "CNY/RUB", "CNY/ZAR",
  "CNY/KRW", "CNY/AED", "CNY/SAR", "CNY/HUF", "CNY/PLN", "CNY/DKK", "CNY/SEK",
  "CNY/NOK", "CNY/TRY", "CNY/MXN", "CNY/THB",
] as const;

export const FX_CURRENCY_OPTIONS = Object.freeze([
  "CNY",
  ...PAIR_ORDER.map((pair) => {
    const normalizedPair = pair.replace(/^\d+/u, "");
    return normalizedPair.startsWith("CNY/") ? normalizedPair.slice(4) : normalizedPair.slice(0, 3);
  }),
].filter((currency, index, all) => all.indexOf(currency) === index));

export interface FxHistoryPivotRow {
  readonly date: string;
  readonly rates: Readonly<Record<string, string>>;
}

export function defaultFxHistoryRange(today = Temporal.Now.plainDateISO("Asia/Shanghai")): { from: string; to: string } {
  return { from: today.subtract({ months: 1 }).toString(), to: today.toString() };
}

export function pivotFxHistory(quotes: readonly FxQuote[]): { columns: string[]; rows: FxHistoryPivotRow[] } {
  const preferred = new Map<string, number>(PAIR_ORDER.map((pair, index) => [pair, index]));
  const columns = [...new Set(quotes.map((quote) => quote.officialPair))].sort((left, right) => {
    const leftIndex = preferred.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = preferred.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftIndex - rightIndex || left.localeCompare(right);
  });
  const byDate = new Map<string, Record<string, string>>();
  for (const quote of quotes) {
    const rates = byDate.get(quote.date) ?? {};
    rates[quote.officialPair] = quote.officialRate;
    byDate.set(quote.date, rates);
  }
  const rows = [...byDate.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([date, rates]) => ({ date, rates }));
  return { columns, rows };
}
