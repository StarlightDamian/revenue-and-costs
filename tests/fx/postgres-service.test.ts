import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../../src/modules/authorization/index.js";
import { PostgresFxService } from "../../src/modules/fx/postgres-service.js";

describe("PostgresFxService", () => {
  it("loads quotes and market days from the requested date through ten future days", async () => {
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      void values;
      if (sql.includes("FROM fx_current_quote")) return { rows: [] };
      if (sql.includes("FROM fx_current_market_day")) return { rows: [] };
      if (sql.includes("FROM fx_override")) return { rows: [] };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const service = new PostgresFxService({ query } as unknown as SqlClient);

    await service.convertBatch([{ input: "2026-08-01", fromCurrency: "USD", toCurrency: "CNY" }]);

    const quoteSql = query.mock.calls.find(([sql]) => sql.includes("FROM fx_current_quote"))?.[0] ?? "";
    const calendarSql = query.mock.calls.find(([sql]) => sql.includes("FROM fx_current_market_day"))?.[0] ?? "";
    expect(quoteSql).toContain("valid_date >= $1::date");
    expect(quoteSql).toContain("valid_date <= $2::date + interval '10 days'");
    expect(calendarSql).toContain("valid_date >= $1::date");
    expect(calendarSql).toContain("valid_date <= $2::date + interval '10 days'");
    expect(query.mock.calls.every(([, values]) => values === undefined || values[0] !== "2026-07-22")).toBe(true);
  });
});
