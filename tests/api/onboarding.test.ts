import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { onboardingRoutes } from "../../src/api/routes/onboarding.js";
import type { Actor } from "../../src/modules/authorization/index.js";

const actor: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
};
const shopId = "20000000-0000-4000-8000-000000000002";

describe("onboarding routes", () => {
  it("persists account-version scope and authorizes per-shop guide state", async () => {
    const get = vi.fn(async () => ({ dismissed: false }));
    const set = vi.fn(async (_accountId, _guide, _resource, _version, dismissed: boolean) => ({ dismissed }));
    const authorize = vi.fn(async () => undefined);
    const authenticate = vi.fn(async () => actor);
    const app = Fastify();
    await app.register(onboardingRoutes, { service: { get, set } as never, authenticate, authorize });

    const current = await app.inject({ method: "GET", url: `/api/v1/me/onboarding?guide=SHOP_WORKFLOW&version=2&shopId=${shopId}` });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual({ dismissed: false });
    expect(authorize).toHaveBeenCalledWith(actor, shopId, "SHOP_READ");
    expect(get).toHaveBeenCalledWith(actor.accountId, "SHOP_WORKFLOW", shopId, 2);

    const saved = await app.inject({ method: "PATCH", url: "/api/v1/me/onboarding", payload: { guide: "WORKSPACE", version: 2, dismissed: true } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ dismissed: true });
    expect(authenticate).toHaveBeenLastCalledWith(expect.anything(), true);
    expect(set).toHaveBeenCalledWith(actor.accountId, "WORKSPACE", "GLOBAL", 2, true);
    await app.close();
  });

  it("rejects a shop guide without a shop and a workspace guide with one", async () => {
    const app = Fastify();
    await app.register(onboardingRoutes, {
      service: { get: vi.fn(), set: vi.fn() } as never,
      authenticate: async () => actor,
      authorize: async () => undefined,
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/me/onboarding?guide=SHOP_WORKFLOW&version=1" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/v1/me/onboarding?guide=WORKSPACE&version=1&shopId=${shopId}` })).statusCode).toBe(400);
    await app.close();
  });
});
