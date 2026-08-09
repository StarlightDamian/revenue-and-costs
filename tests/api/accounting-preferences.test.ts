import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { accountingPreferenceRoutes } from "../../src/api/routes/accounting-preferences.js";
import type { Actor } from "../../src/modules/authorization/index.js";

const actor: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
  enterpriseIds: new Set(),
};

describe("accounting preference routes", () => {
  it("reads blank defaults and persists normalized optional ratios with CSRF authentication", async () => {
    const update = vi.fn(async (_actor, assumptions) => assumptions);
    const authenticate = vi.fn(async () => actor);
    const app = Fastify();
    await app.register(accountingPreferenceRoutes, {
      service: {
        async get() { return { profitRate: null, minimumSalesCostRate: null, continentPrefixes: ["EU"] as const }; },
        update,
      },
      authenticate,
    });

    const current = await app.inject({ method: "GET", url: "/api/v1/me/accounting-preferences" });
    expect(current.json()).toEqual({ profitRate: null, minimumSalesCostRate: null, continentPrefixes: ["EU"] });
    expect(authenticate).toHaveBeenLastCalledWith(expect.anything(), false);

    const saved = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/accounting-preferences",
      payload: { profitRate: "0.0437", minimumSalesCostRate: "0.15" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toEqual({ profitRate: "0.04370000", minimumSalesCostRate: "0.15000000", continentPrefixes: ["EU"] });
    expect(authenticate).toHaveBeenLastCalledWith(expect.anything(), true);
    expect(update).toHaveBeenCalledWith(actor, {
      profitRate: "0.04370000",
      minimumSalesCostRate: "0.15000000",
      continentPrefixes: ["EU"],
    }, expect.any(String));
    await app.close();
  });

  it("rejects out-of-range ratios before persistence", async () => {
    const update = vi.fn();
    const app = Fastify();
    await app.register(accountingPreferenceRoutes, {
      service: { async get() { return { profitRate: null, minimumSalesCostRate: null, continentPrefixes: ["EU"] as const }; }, update },
      async authenticate() { return actor; },
    });
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/me/accounting-preferences",
      payload: { profitRate: "1.00000001", minimumSalesCostRate: null },
    });
    expect(response.statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
    await app.close();
  });
});
