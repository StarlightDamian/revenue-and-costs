import { describe, expect, it, vi } from "vitest";
import type { Actor, SqlClient, TransactionRunner, TransactionSideEffects } from "../../src/modules/authorization/index.js";
import { ShopService } from "../../src/modules/shops/service.js";

const actor: Actor = { accountId: "account-1", status: "ACTIVE", roles: new Set(["ACCOUNTANT"]), enterpriseIds: new Set(["enterprise-1"]) };
const shops = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"].map((id) => ({
  id,
  application_id: "app-1",
  owner_account_id: actor.accountId,
  enterprise_id: "enterprise-1",
  name: `shop-${id.at(-1)}`,
  status: "ACTIVE",
  start_date: "2026-01-01",
  close_date: "2027-01-01",
  rename_count: 0,
}));

function fixture(activeShopIds: string[] = []) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM idempotency_record")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT * FROM shop")) return { rows: shops, rowCount: shops.length };
    if (sql.includes("SELECT DISTINCT shop_id")) return { rows: activeShopIds.map((shop_id) => ({ shop_id })), rowCount: activeShopIds.length };
    if (sql.startsWith("UPDATE shop")) return { rows: shops.map((shop) => ({ ...shop, status: "TRASHED" })), rowCount: shops.length };
    return { rows: [], rowCount: 0 };
  });
  const client = { query } as unknown as SqlClient;
  const transactions: TransactionRunner = { transaction: (work) => work(client) };
  const effects: TransactionSideEffects = { audit: vi.fn(), outbox: vi.fn() };
  return { service: new ShopService(transactions, client, effects), query, effects };
}

describe("bulk shop trash", () => {
  it("locks, validates and trashes all selected shops in one transaction", async () => {
    const test = fixture();
    await expect(test.service.bulkTrash({ actor, shopIds: [shops[1]!.id, shops[0]!.id], reason: "批量整理", idempotencyKey: "key-1", requestId: "request-1" }))
      .resolves.toEqual({ count: 2, status: "TRASHED" });
    expect(test.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE shop"))).toBe(true);
    expect(test.effects.audit).toHaveBeenCalledTimes(2);
  });

  it("rejects the whole operation when any shop has an active workflow", async () => {
    const test = fixture([shops[0]!.id]);
    await expect(test.service.bulkTrash({ actor, shopIds: shops.map((shop) => shop.id), reason: "批量整理", idempotencyKey: "key-2", requestId: "request-2" }))
      .rejects.toMatchObject({ code: "SHOP_HAS_ACTIVE_WORKFLOW", statusCode: 409, message: "所选店铺存在运行中的任务，请完成或取消后再删除" });
    expect(test.query.mock.calls.some(([sql]) => String(sql).startsWith("UPDATE shop"))).toBe(false);
    expect(test.effects.audit).not.toHaveBeenCalled();
  });
});
