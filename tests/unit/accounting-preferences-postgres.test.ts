import { describe, expect, it, vi } from "vitest";
import type { Actor } from "../../src/modules/authorization/index.js";
import {
  findAccountingPreferences,
  PostgresAccountingPreferencesService,
} from "../../src/modules/accounting-preferences/index.js";

const actor: Actor = {
  accountId: "account-1",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
};

describe("Postgres accounting preferences", () => {
  it("finds and normalizes an account's preferences without imposing a not-found policy", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        profit_rate: "0.04370000",
        minimum_sales_cost_rate: null,
        continent_prefixes: ["OC", "EU", "EU"],
      }],
      rowCount: 1,
    }));

    await expect(findAccountingPreferences({ query } as never, "account-1")).resolves.toEqual({
      profitRate: "0.04370000",
      minimumSalesCostRate: null,
      continentPrefixes: ["EU", "OC"],
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM account"), ["account-1"]);
  });

  it("returns null when the account does not exist", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));

    await expect(findAccountingPreferences({ query } as never, "missing-account")).resolves.toBeNull();
  });

  it("keeps the preferences API's stable not-found error at the service boundary", async () => {
    const service = new PostgresAccountingPreferencesService(
      { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never,
      {} as never,
      {} as never,
    );

    await expect(service.get("missing-account")).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("locks the account, updates both optional defaults, and audits before/after values in one transaction", async () => {
    const client = { query: vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (sql.includes("FROM account") && sql.includes("FOR UPDATE")) {
        return { rows: [{ profit_rate: null, minimum_sales_cost_rate: "0.10000000", continent_prefixes: ["EU"] }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE account")) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    }) };
    const transactions = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => unknown) => work(client)),
    };
    const audit = vi.fn(async () => undefined);
    const service = new PostgresAccountingPreferencesService(
      {} as never,
      transactions as never,
      { audit } as never,
    );

    await expect(service.update(actor, {
      profitRate: "0.0437",
      minimumSalesCostRate: null,
      continentPrefixes: ["OC", "EU", "EU"],
    }, "request-1")).resolves.toEqual({
      profitRate: "0.04370000",
      minimumSalesCostRate: null,
      continentPrefixes: ["EU", "OC"],
    });

    expect(client.query.mock.calls[0]?.[0]).toContain("FOR UPDATE");
    expect(client.query.mock.calls[1]?.[1]).toEqual(["account-1", "0.04370000", null, ["EU", "OC"]]);
    expect(audit).toHaveBeenCalledWith(client, expect.objectContaining({
      actorAccountId: "account-1",
      action: "ACCOUNTING_PREFERENCES_UPDATED",
      requestId: "request-1",
      before: { profitRate: null, minimumSalesCostRate: "0.10000000", continentPrefixes: ["EU"] },
      after: { profitRate: "0.04370000", minimumSalesCostRate: null, continentPrefixes: ["EU", "OC"] },
    }));
  });
});
