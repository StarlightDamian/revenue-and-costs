import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { adminRoutes } from "../../src/api/routes/admin.js";
import { appRoutes } from "../../src/api/routes/apps.js";
import { exportRoutes } from "../../src/api/routes/exports.js";
import { importRoutes } from "../../src/api/routes/imports.js";
import { reportRoutes } from "../../src/api/routes/reports.js";
import { shopRoutes } from "../../src/api/routes/shops.js";
import type { Actor } from "../../src/modules/authorization/index.js";

const admin: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(["ADMIN"]),
};

describe("route parameter validation", () => {
  it("rejects invalid shop ids before authentication", async () => {
    const authenticate = vi.fn(async () => admin);
    const list = vi.fn(async () => []);
    const app = Fastify();
    await app.register(shopRoutes, {
      shops: {} as never,
      memberships: { list } as never,
      authenticate,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/shops/not-a-uuid/members",
    });

    expect(response.statusCode).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects invalid application ids before authentication", async () => {
    const authenticate = vi.fn(async () => admin);
    const updateApplication = vi.fn(async () => undefined);
    const app = Fastify();
    await app.register(appRoutes, {
      catalog: { updateApplication } as never,
      authenticate,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/apps/not-a-uuid",
      payload: {
        name: "亚马逊销售成本",
        status: "ACTIVE",
        sortOrder: 10,
        allowedRoles: ["ACCOUNTANT"],
        reason: "参数边界回归",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(updateApplication).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects invalid account ids before authentication", async () => {
    const authenticate = vi.fn(async () => admin);
    const listEntries = vi.fn(async () => []);
    const app = Fastify();
    await app.register(adminRoutes, {
      identity: {} as never,
      wallet: { listEnterpriseEntries: listEntries } as never,
      authenticate,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/admin/enterprises/not-a-uuid/wallet-ledger",
    });

    expect(response.statusCode).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(listEntries).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects invalid export and shop ids before authentication", async () => {
    const authenticate = vi.fn(async () => admin);
    const list = vi.fn(async () => []);
    const cancel = vi.fn(async () => undefined);
    const app = Fastify();
    await app.register(exportRoutes, {
      service: { list, cancel } as never,
      authenticate,
    });

    const invalidShop = await app.inject({
      method: "GET",
      url: "/api/v1/exports?shopId=not-a-uuid",
    });
    const invalidExport = await app.inject({
      method: "POST",
      url: "/api/v1/exports/not-a-uuid/cancel",
    });

    expect(invalidShop.statusCode).toBe(400);
    expect(invalidExport.statusCode).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an invalid completeness shop id before authentication", async () => {
    const authenticate = vi.fn(async () => admin);
    const authorize = vi.fn(async () => undefined);
    const getCompleteness = vi.fn(async () => []);
    const app = Fastify();
    await app.register(importRoutes, {
      services: { getCompleteness } as never,
      authenticate,
      authorize,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/imports/completeness?shopId=not-a-uuid",
    });

    expect(response.statusCode).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(getCompleteness).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an inverted report date range before authentication", async () => {
    const authenticate = vi.fn(async () => admin);
    const authorize = vi.fn(async () => undefined);
    const getPreview = vi.fn(async () => ({}));
    const app = Fastify();
    await app.register(reportRoutes, {
      services: { getPreview } as never,
      authenticate,
      authorize,
      auditAdminAccess: async () => undefined,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/reports/shops/20000000-0000-4000-8000-000000000002/preview?start=2026-08-01&end=2026-07-01",
    });

    expect(response.statusCode).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(getPreview).not.toHaveBeenCalled();
    await app.close();
  });
});
