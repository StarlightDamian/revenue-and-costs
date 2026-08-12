import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { syncChinaMoney, type ChinaMoneySource } from "../../src/modules/fx/index.js";

function syncPool(): {
  readonly pool: Pool;
  readonly clientQueries: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }>;
  readonly runQueries: Array<{ readonly sql: string; readonly parameters?: readonly unknown[] }>;
} {
  const clientQueries: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
  const runQueries: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
  const client = {
    async query(sql: string, parameters?: readonly unknown[]) {
      clientQueries.push({ sql, ...(parameters ? { parameters } : {}) });
      if (sql.includes("INSERT INTO fx_raw_snapshot")) {
        return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: vi.fn(),
  } as unknown as PoolClient;
  const pool = {
    async query(sql: string, parameters?: readonly unknown[]) {
      runQueries.push({ sql, ...(parameters ? { parameters } : {}) });
      return { rows: [], rowCount: 1 };
    },
    async connect() {
      return client;
    },
  } as unknown as Pool;
  return { pool, clientQueries, runQueries };
}

function allPairsSource(absentThrough: string): ChinaMoneySource {
  const payload = {
    records: [
      { validDate: "2026-07-31", "USD/CNY": "6.7894" },
      { validDate: "2026-08-03", "USD/CNY": "6.7898" },
      { validDate: "2026-08-04", "USD/CNY": "6.7917" },
      { validDate: "2026-08-05", "USD/CNY": "6.7889" },
      { validDate: "2026-08-06", "USD/CNY": "6.7895" },
      { validDate: "2026-08-07", "USD/CNY": "6.7904" },
      { validDate: "2026-08-10", "USD/CNY": "6.7884" },
    ],
  };
  return {
    sourceName: "ChinaMoney",
    pageSize: 15,
    async fetchPage(range, page, pageSize) {
      expect(pageSize).toBe(15);
      return {
        request: {
          from: range.from,
          to: range.to,
          page: String(page),
          pageSize: String(pageSize),
          allPairs: "true",
          allPairsAbsentThrough: absentThrough,
        },
        status: 200,
        headers: { "content-type": "application/json" },
        rawBody: JSON.stringify(payload),
        payload,
        page,
        hasMore: false,
      };
    },
  };
}

describe("ChinaMoney all-pairs absence evidence", () => {
  it("infers missing market days only through the source's safe current-day cutoff", async () => {
    const fixture = syncPool();
    await syncChinaMoney(
      fixture.pool,
      allPairsSource("2026-08-10"),
      "MANUAL_RETRY",
      { from: "2026-07-31", to: "2026-08-11" },
    );

    const absenceInsert = fixture.clientQueries.find((query) => query.sql.includes("ALL_OFFICIAL_PAIRS_ABSENT"));
    expect(absenceInsert?.parameters).toEqual([
      "2026-07-31",
      "2026-08-10",
      "00000000-0000-4000-8000-000000000001",
      ["2026-07-31", "2026-08-03", "2026-08-04", "2026-08-05", "2026-08-06", "2026-08-07", "2026-08-10"],
      [],
    ]);
  });

  it("rejects an all-pairs cutoff beyond the audited request range", async () => {
    const fixture = syncPool();
    await expect(syncChinaMoney(
      fixture.pool,
      allPairsSource("2026-08-12"),
      "MANUAL_RETRY",
      { from: "2026-07-31", to: "2026-08-11" },
    )).rejects.toThrow("CHINAMONEY_ALL_PAIRS_RANGE_EVIDENCE_INVALID");
    expect(fixture.clientQueries.at(-1)?.sql).toBe("ROLLBACK");
    expect(fixture.runQueries.at(-1)?.sql).toContain("status='FAILED'");
  });
});
