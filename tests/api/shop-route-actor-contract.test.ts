import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { importRoutes } from "../../src/api/routes/imports.js";
import { reportRoutes } from "../../src/api/routes/reports.js";
import type { Actor } from "../../src/modules/authorization/index.js";

const actor: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
};
const shopId = "20000000-0000-4000-8000-000000000002";
const resourceId = "30000000-0000-4000-8000-000000000003";

describe("shop route actor contract", () => {
  it("restores the latest durable import batch with draft-result authorization", async () => {
    const authorize = vi.fn(async () => undefined);
    const getLatestBatch = vi.fn(async () => ({ id: resourceId, status: "RUNNING" }));
    const app = Fastify();
    await app.register(importRoutes, {
      services: { getLatestBatch } as never,
      authenticate: async () => actor,
      authorize,
    });

    const response = await app.inject({ method: "GET", url: `/api/v1/imports/shops/${shopId}/batches/latest` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: resourceId, status: "RUNNING" });
    expect(authorize).toHaveBeenCalledWith(actor, shopId, "DRAFT_RESULT_READ");
    expect(getLatestBatch).toHaveBeenCalledWith(shopId);
    await app.close();
  });

  it("preserves the authenticated Actor through import authorization", async () => {
    const authorize = vi.fn(async () => undefined);
    const confirm = vi.fn<
      (shopId: string, batchId: string, input: unknown) => Promise<{ queued: boolean }>
    >(async () => ({ queued: true }));
    const app = Fastify();
    await app.register(importRoutes, {
      services: { confirm } as never,
      authenticate: async () => actor,
      authorize,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/imports/shops/${shopId}/batches/${resourceId}/confirm`,
      headers: { "idempotency-key": "import-contract-key" },
    });
    const shortKey = await app.inject({
      method: "POST",
      url: `/api/v1/imports/shops/${shopId}/batches/${resourceId}/confirm`,
      headers: { "idempotency-key": "short" },
    });

    expect(response.statusCode).toBe(200);
    expect(shortKey.statusCode).toBe(400);
    expect(authorize).toHaveBeenCalledWith(actor, shopId, "IMPORT_COMMIT");
    expect(confirm).toHaveBeenCalledWith(shopId, resourceId, {
      actorAccountId: actor.accountId,
      idempotencyKey: "import-contract-key",
    });
    await app.close();
  });

  it("accepts an omitted hard-exclusion reason and records a stable audit placeholder", async () => {
    const authorize = vi.fn(async () => undefined);
    const acknowledge = vi.fn(async () => ({ id: resourceId, status: "ACKNOWLEDGED" }));
    const app = Fastify();
    await app.register(importRoutes, {
      services: { acknowledge } as never,
      authenticate: async () => actor,
      authorize,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/imports/shops/${shopId}/issues/${resourceId}/acknowledge`,
      headers: { "idempotency-key": "optional-reason-contract" },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(authorize).toHaveBeenCalledWith(actor, shopId, "QUALITY_ACKNOWLEDGE");
    expect(acknowledge).toHaveBeenCalledWith(shopId, resourceId, {
      actorAccountId: actor.accountId,
      reason: "未填写",
      confirmations: "1",
      idempotencyKey: "optional-reason-contract",
    });
    await app.close();
  });

  it("uses canonical report capabilities without adding an account lookup contract", async () => {
    const authorize = vi.fn(async () => undefined);
    const getCurrent = vi.fn<(shopId: string) => Promise<{ snapshotId: string }>>(
      async () => ({ snapshotId: resourceId }),
    );
    const publish = vi.fn<
      (manifest: unknown, input: unknown) => Promise<{ snapshotId: string }>
    >(async () => ({ snapshotId: resourceId }));
    const auditAdminAccess = vi.fn(async () => undefined);
    const app = Fastify();
    await app.register(reportRoutes, {
      services: { getCurrent, publish } as never,
      authenticate: async () => actor,
      authorize,
      auditAdminAccess,
    });

    const current = await app.inject({
      method: "GET",
      url: `/api/v1/reports/shops/${shopId}/current?start=2026-05-01&end=2026-05-31&marketplace=amazon.com`,
    });
    const published = await app.inject({
      method: "POST",
      url: `/api/v1/reports/shops/${shopId}/publish`,
      headers: { "idempotency-key": "report-contract-key" },
      payload: {
        calculationRunId: resourceId,
        slices: [{
          sliceId: "40000000-0000-4000-8000-000000000004",
          datasetVersionId: "50000000-0000-4000-8000-000000000005",
          disposition: "INCLUDED",
        }],
      },
    });
    const shortKey = await app.inject({
      method: "POST",
      url: `/api/v1/reports/shops/${shopId}/publish`,
      headers: { "idempotency-key": "short" },
      payload: {
        calculationRunId: resourceId,
        slices: [{
          sliceId: "40000000-0000-4000-8000-000000000004",
          datasetVersionId: "50000000-0000-4000-8000-000000000005",
          disposition: "INCLUDED",
        }],
      },
    });

    expect(current.statusCode).toBe(200);
    expect(published.statusCode).toBe(200);
    expect(shortKey.statusCode).toBe(400);
    expect(getCurrent).toHaveBeenCalledWith(shopId, {
      start: "2026-05-01",
      end: "2026-05-31",
      marketplace: "amazon.com",
    });
    expect(authorize.mock.calls).toEqual([
      [actor, shopId, "PUBLISHED_RESULT_READ"],
      [actor, shopId, "RESULT_PUBLISH"],
      [actor, shopId, "RESULT_PUBLISH"],
    ]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[1]).toMatchObject({ actorAccountId: actor.accountId });
    expect(auditAdminAccess).not.toHaveBeenCalled();
    await app.close();
  });

  it("audits successful administrator access to published and preview reports", async () => {
    const admin: Actor = { ...actor, roles: new Set(["ADMIN"]) };
    const authorize = vi.fn(async () => undefined);
    const auditAdminAccess = vi.fn(async () => undefined);
    const app = Fastify({ genReqId: () => "report-admin-request" });
    await app.register(reportRoutes, {
      services: {
        getCurrent: async () => ({ snapshotId: resourceId }),
        getPreview: async () => ({ calculationRunId: resourceId }),
      } as never,
      authenticate: async () => admin,
      authorize,
      auditAdminAccess,
    });

    const current = await app.inject({
      method: "GET",
      url: `/api/v1/reports/shops/${shopId}/current?marketplace=amazon.com`,
    });
    const preview = await app.inject({
      method: "GET",
      url: `/api/v1/reports/shops/${shopId}/preview?start=2026-05-01`,
    });

    expect(current.statusCode).toBe(200);
    expect(preview.statusCode).toBe(200);
    expect(auditAdminAccess.mock.calls).toEqual([
      [admin, shopId, "PUBLISHED", "report-admin-request", { marketplace: "amazon.com" }],
      [admin, shopId, "PREVIEW", "report-admin-request", { start: "2026-05-01" }],
    ]);
    await app.close();
  });
});
