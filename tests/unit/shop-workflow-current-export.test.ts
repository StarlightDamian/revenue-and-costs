import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/modules/authorization/index.js";
import { REPORT_EXPORT_FORMAT } from "../../src/modules/exports/export-report.js";
import { ShopService } from "../../src/modules/shops/service.js";

const actor: Actor = { accountId: "account-1", status: "ACTIVE", roles: new Set(["ACCOUNTANT"]) };
const shopId = "10000000-0000-4000-8000-000000000001";
const snapshotId = "20000000-0000-4000-8000-000000000002";
const exportId = "30000000-0000-4000-8000-000000000003";

describe("shop workflow current export projection", () => {
  it("only projects the current persistent export format", async () => {
    const transactionClient = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const transactions = { transaction: vi.fn(async (work: (client: typeof transactionClient) => unknown) => work(transactionClient)) };
    const reader = { query: vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (sql.includes("SELECT DISTINCT ON (s.id)")) {
        return { rows: [{
          id: shopId,
          application_id: "app-1",
          owner_account_id: actor.accountId,
          name: "测试店铺",
          status: "ACTIVE",
          start_date: "2026-08-01",
          close_date: "2027-08-01",
          rename_count: 0,
          access: "OWNER",
          published_snapshot_id: snapshotId,
          published_at: new Date("2026-08-02T00:00:00.000Z"),
          published_snapshot_stale: false,
          export_allowed: null,
        }], rowCount: 1 };
      }
      if (sql.includes("FROM import_batch ib")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM export_request")) {
        return { rows: [{ id: exportId, published_snapshot_id: snapshotId, status: "SUCCEEDED" }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    }) };
    const effects = { audit: vi.fn(async () => undefined) };
    const service = new ShopService(transactions as never, reader as never, effects as never);

    await expect(service.getWorkflow(actor, shopId)).resolves.toMatchObject({
      diagnosticId: expect.stringMatching(/^E[0-9A-Za-z]{22}$/u),
      download: { latestExport: { id: exportId, status: "SUCCEEDED" } },
    });
    const exportCall = reader.query.mock.calls.find((call) => String(call[0]).includes("FROM export_request"));
    expect(String(exportCall?.[0])).toContain("format_version=$4");
    expect(String(exportCall?.[0])).toContain("profit_rate IS NOT DISTINCT FROM");
    expect(String(exportCall?.[0])).toContain("minimum_sales_cost_rate IS NOT DISTINCT FROM");
    expect(String(exportCall?.[0])).toContain("continent_prefixes =");
    expect(exportCall?.[1]).toEqual([shopId, actor.accountId, snapshotId, REPORT_EXPORT_FORMAT]);
  });
});
