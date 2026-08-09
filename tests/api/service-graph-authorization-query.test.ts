import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createServiceGraph } from "../../src/api/service-graph.js";
import type { Actor } from "../../src/modules/authorization/index.js";
import type { AppConfig } from "../../src/shared/config.js";

const shopId = "20000000-0000-4000-8000-000000000002";
const customer: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(),
};
const owner: Actor = {
  accountId: "owner-account",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
};
const config: AppConfig = {
  mode: "test",
  host: "127.0.0.1",
  port: 3000,
  databaseUrl: "postgres://test.invalid/test",
  publicOrigin: "https://app.example.test",
  otpHmacKey: "o".repeat(32),
  sessionHmacKey: "s".repeat(32),
  paymentProvider: "sandbox",
  smsProvider: "sandbox",
  chinaMoneyEnabled: false,
  chinaMoneyEndpointTemplate: undefined,
  chinaMoneyAuthorizationReference: undefined,
  chinaMoneyFixturePath: undefined,
  chinaMoneyHistoryStart: undefined,
  storageRoot: ".work/test-service-graph-storage",
  storageReplicaRoot: undefined,
  storagePolicy: "LOCAL_VERIFIED",
  fileKekBase64: Buffer.alloc(32, 7).toString("base64"),
  remoteBackupTarget: undefined,
};

function authorizationGraph(
  includeShop: boolean,
  status: "ACTIVE" | "EXPIRED_READONLY" = "ACTIVE",
) {
  const query = vi.fn(async (sql: string) => {
    if (!includeShop) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM shop s")) {
      return {
        rows: [{
          id: shopId,
          owner_account_id: "owner-account",
          status,
          membership_id: "30000000-0000-4000-8000-000000000003",
          membership_status: "ACTIVE",
          export_allowed: false,
          authorization_epoch: "5",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM shop WHERE")) {
      return {
        rows: [{ id: shopId, owner_account_id: "owner-account", status: "ACTIVE" }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM shop_membership")) {
      return {
        rows: [{
          id: "30000000-0000-4000-8000-000000000003",
          shop_id: shopId,
          account_id: customer.accountId,
          status: "ACTIVE",
          export_allowed: false,
          authorization_epoch: "5",
        }],
        rowCount: 1,
      };
    }
    throw new Error(`UNEXPECTED_QUERY:${sql}`);
  });
  return {
    graph: createServiceGraph(config, { query } as unknown as Pool),
    query,
  };
}

describe("service graph shop authorization query", () => {
  it("loads the shop and current actor membership in one query", async () => {
    const fixture = authorizationGraph(true);

    await expect(
      fixture.graph.authorizeShopCapability(customer, shopId, "PUBLISHED_RESULT_READ"),
    ).resolves.toBeUndefined();

    expect(fixture.query).toHaveBeenCalledOnce();
    expect(fixture.query.mock.calls[0]?.[0]).toContain("LEFT JOIN shop_membership");
  });

  it("keeps missing shops object-scoped and uses one query", async () => {
    const fixture = authorizationGraph(false);

    await expect(
      fixture.graph.authorizeShopCapability(customer, shopId, "PUBLISHED_RESULT_READ"),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });

    expect(fixture.query).toHaveBeenCalledOnce();
  });

  it("derives the effective Shanghai expiry state before direct object authorization", async () => {
    const fixture = authorizationGraph(true, "EXPIRED_READONLY");

    await expect(
      fixture.graph.authorizeShopCapability(owner, shopId, "UPLOAD"),
    ).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });

    const sql = fixture.query.mock.calls[0]?.[0];
    expect(sql).toContain("s.close_date <= timezone('Asia/Shanghai', clock_timestamp())::date");
    expect(sql).toContain("THEN 'EXPIRED_READONLY' ELSE s.status END AS status");
  });
});
