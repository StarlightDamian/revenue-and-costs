import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { exportRoutes } from "../../src/api/routes/exports.js";
import { shopRoutes } from "../../src/api/routes/shops.js";
import type { Actor } from "../../src/modules/authorization/index.js";

const actor: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
};
const shopId = "20000000-0000-4000-8000-000000000002";
const secondShopId = "20000000-0000-4000-8000-000000000003";

describe("workflow route contract", () => {
  it("passes the authenticated actor to the permission-trimmed workflow query", async () => {
    const getWorkflow = vi.fn(async () => ({ currentStep: "RECEIVE", steps: [] }));
    const authenticate = vi.fn(async () => actor);
    const app = Fastify();
    await app.register(shopRoutes, {
      shops: { getWorkflow } as never,
      memberships: {} as never,
      authenticate,
    });

    const response = await app.inject({ method: "GET", url: `/api/v1/shops/${shopId}/workflow` });

    expect(response.statusCode).toBe(200);
    expect(authenticate).toHaveBeenCalledWith(expect.anything(), false);
    expect(getWorkflow).toHaveBeenCalledWith(actor, shopId);
    await app.close();
  });

  it("requires a reason and idempotency key before bulk trashing", async () => {
    const bulkTrash = vi.fn(async () => ({ affected: 2 }));
    const app = Fastify({ genReqId: () => "bulk-trash-request" });
    await app.register(shopRoutes, {
      shops: { bulkTrash } as never,
      memberships: {} as never,
      authenticate: async () => actor,
    });

    const missingReason = await app.inject({
      method: "POST",
      url: "/api/v1/shops/bulk-trash",
      headers: { "idempotency-key": "bulk-trash-key" },
      payload: { shopIds: [shopId] },
    });
    const missingKey = await app.inject({
      method: "POST",
      url: "/api/v1/shops/bulk-trash",
      payload: { shopIds: [shopId], reason: "清理重复测试店铺" },
    });
    const success = await app.inject({
      method: "POST",
      url: "/api/v1/shops/bulk-trash",
      headers: { "idempotency-key": "bulk-trash-key" },
      payload: { shopIds: [secondShopId, shopId], reason: "清理重复测试店铺" },
    });

    expect(missingReason.statusCode).toBe(400);
    expect(missingKey.statusCode).toBe(400);
    expect(success.statusCode).toBe(200);
    expect(bulkTrash).toHaveBeenCalledWith({
      actor,
      shopIds: [secondShopId, shopId],
      reason: "清理重复测试店铺",
      idempotencyKey: "bulk-trash-key",
      requestId: "bulk-trash-request",
    });
    await app.close();
  });

  it("creates an export from the server-side current snapshot", async () => {
    const createCurrent = vi.fn(async () => ({
      id: "30000000-0000-4000-8000-000000000003",
      status: "QUEUED",
    }));
    const app = Fastify({ genReqId: () => "current-export-request" });
    await app.register(exportRoutes, {
      service: { createCurrent } as never,
      authenticate: async () => actor,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/shops/${shopId}/exports/current`,
      headers: { "idempotency-key": "current-export-key" },
      payload: { profitRate: "0.04370000", minimumSalesCostRate: "0.15000000" },
    });

    expect(response.statusCode).toBe(200);
    expect(createCurrent).toHaveBeenCalledWith(actor, shopId, "current-export-key", "current-export-request", {
      profitRate: "0.04370000",
      minimumSalesCostRate: "0.15000000",
    });
    await app.close();
  });

  it("previews explicit blank and overridden cost assumptions without CSRF", async () => {
    const previewCostAccounting = vi.fn(async () => ({ year: "2026", rows: [] }));
    const authenticate = vi.fn(async () => actor);
    const app = Fastify();
    await app.register(exportRoutes, {
      service: { previewCostAccounting } as never,
      authenticate,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/shops/${shopId}/exports/cost-preview?profitRate=0.04370000&minimumSalesCostRate=`,
    });

    expect(response.statusCode).toBe(200);
    expect(authenticate).toHaveBeenCalledWith(expect.anything(), false);
    expect(previewCostAccounting).toHaveBeenCalledWith(actor, shopId, {
      profitRate: "0.04370000",
      minimumSalesCostRate: null,
    });
    await app.close();
  });
});
