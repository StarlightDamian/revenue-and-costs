import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/modules/authorization/index.js";
import { adminRoutes } from "../../src/api/routes/admin.js";

const admin: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(["ADMIN"]),
};
const accountant: Actor = { ...admin, roles: new Set(["ACCOUNTANT"]) };
const override = {
  id: "20000000-0000-4000-8000-000000000002",
  currency: "BRL",
  validFrom: "2025-12-30",
  validTo: "2025-12-30",
  cnyPerUnit: "1.33000000",
  sourceReference: "授权来源记录 FX-2025-12-30",
  reason: "补齐小币种缺口",
  createdAt: "2026-08-09T00:00:00.000Z",
  supersedesOverrideId: null,
  isCurrent: true,
};
const payload = {
  currency: "BRL",
  validFrom: "2025-12-30",
  validTo: "2025-12-30",
  cnyPerUnit: "1.33",
  sourceReference: "授权来源记录 FX-2025-12-30",
  reason: "补齐小币种缺口",
};

function dependencies(actor: Actor) {
  return {
    identity: {} as never,
    wallet: {} as never,
    fx: {
      listOverrides: vi.fn(async () => ({ rows: [override] })),
      createOverride: vi.fn(async () => ({ override })),
      reviseOverride: vi.fn(async () => ({ override: { ...override, supersedesOverrideId: override.id } })),
    },
    authenticate: vi.fn(async (request: unknown, csrf: boolean) => {
      void request;
      void csrf;
      return actor;
    }),
  };
}

describe("admin manual FX routes", () => {
  it("returns current and historical overrides only to an administrator", async () => {
    const allowed = dependencies(admin);
    const app = Fastify();
    await app.register(adminRoutes, allowed);

    const response = await app.inject({ method: "GET", url: "/api/v1/admin/fx-overrides" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rows: [override] });
    expect(allowed.authenticate).toHaveBeenCalledWith(expect.anything(), false);
    await app.close();

    const denied = dependencies(accountant);
    const deniedApp = Fastify();
    await deniedApp.register(adminRoutes, denied);
    const deniedResponse = await deniedApp.inject({ method: "GET", url: "/api/v1/admin/fx-overrides" });
    expect(deniedResponse.statusCode).toBe(404);
    expect(denied.fx.listOverrides).not.toHaveBeenCalled();
    await deniedApp.close();
  });

  it("requires CSRF authentication and an idempotency key when creating an override", async () => {
    const deps = dependencies(admin);
    const app = Fastify();
    await app.register(adminRoutes, deps);

    const missingKey = await app.inject({ method: "POST", url: "/api/v1/admin/fx-overrides", payload });
    expect(missingKey.statusCode).toBe(400);
    expect(deps.fx.createOverride).not.toHaveBeenCalled();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/admin/fx-overrides",
      headers: { "idempotency-key": "fx-create-0001" },
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ override });
    expect(deps.authenticate).toHaveBeenLastCalledWith(expect.anything(), true);
    expect(deps.fx.createOverride).toHaveBeenCalledWith(expect.objectContaining({
      actor: admin,
      currency: "BRL",
      cnyPerUnit: "1.33",
      idempotencyKey: "fx-create-0001",
      requestId: expect.any(String),
    }));
    await app.close();
  });

  it("creates a revision through a versioned endpoint and validates the predecessor id", async () => {
    const deps = dependencies(admin);
    const app = Fastify();
    await app.register(adminRoutes, deps);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/admin/fx-overrides/not-a-uuid/revisions",
      headers: { "idempotency-key": "fx-revise-0001" },
      payload,
    });
    expect(invalid.statusCode).toBe(400);
    expect(deps.authenticate).not.toHaveBeenCalled();

    const revised = await app.inject({
      method: "POST",
      url: `/api/v1/admin/fx-overrides/${override.id}/revisions`,
      headers: { "idempotency-key": "fx-revise-0001" },
      payload: { ...payload, cnyPerUnit: "1.34", reason: "修订授权汇率" },
    });
    expect(revised.statusCode).toBe(201);
    expect(deps.fx.reviseOverride).toHaveBeenCalledWith(override.id, expect.objectContaining({
      actor: admin,
      currency: "BRL",
      cnyPerUnit: "1.34",
      idempotencyKey: "fx-revise-0001",
    }));
    await app.close();
  });

  it("rejects numeric, zero, and over-precision rates at the HTTP boundary", async () => {
    const deps = dependencies(admin);
    const app = Fastify();
    await app.register(adminRoutes, deps);

    for (const cnyPerUnit of [1.33, "0", "0.073000001"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/admin/fx-overrides",
        headers: { "idempotency-key": "fx-create-invalid" },
        payload: { ...payload, cnyPerUnit },
      });
      expect(response.statusCode, `cnyPerUnit=${String(cnyPerUnit)}`).toBe(400);
    }
    expect(deps.authenticate).not.toHaveBeenCalled();
    expect(deps.fx.createOverride).not.toHaveBeenCalled();
    await app.close();
  });
});
