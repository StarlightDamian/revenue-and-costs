import { describe, expect, it, vi } from "vitest";
import { WalletService } from "../../src/modules/wallet/service";

describe("wallet ledger shop references", () => {
  it("uses the current name and lifecycle state of the shop identified by the stable reference id", async () => {
    const query = vi.fn(async (sql: string) => {
      if (!sql.includes("FROM wallet_ledger")) throw new Error(`unexpected query: ${sql}`);
      return {
        rows: [{
          id: "41",
          entry_type: "SHOP_CHARGE",
          delta_cents: "-18800",
          balance_after_cents: "981200",
          created_at: new Date("2026-08-10T12:48:55.372Z"),
          reason: null,
          reference_type: "SHOP",
          reference_id: "10000000-0000-4000-8000-000000000001",
          reference_name: "香港公司名称",
          reference_status: "TRASHED",
        }],
      };
    });
    const service = new WalletService({} as never, { query } as never, {} as never);

    await expect(service.listWalletEntries("02000000-0000-4000-8000-000000000001")).resolves.toEqual([{
      id: "41",
      type: "SHOP_CHARGE",
      amountCents: "-18800",
      balanceAfterCents: "981200",
      occurredAt: "2026-08-10T12:48:55.372Z",
      reference: {
        type: "SHOP",
        id: "10000000-0000-4000-8000-000000000001",
        name: "香港公司名称",
        status: "TRASHED",
      },
    }]);
    expect(query.mock.calls[0]?.[0]).toContain("LEFT JOIN shop");
    expect(query.mock.calls[0]?.[0]).toContain("shop.enterprise_id = wallet.enterprise_id");
    expect(query.mock.calls[0]?.[0]).not.toContain("shop_name_history");
  });

  it("fails closed when a corrupt shop reference belongs to another enterprise", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        id: "42",
        entry_type: "SHOP_CHARGE",
        delta_cents: "-18800",
        balance_after_cents: "962400",
        created_at: new Date("2026-08-10T12:49:55.372Z"),
        reason: null,
        reference_type: "SHOP",
        reference_id: "10000000-0000-4000-8000-000000000099",
        reference_name: null,
        reference_status: null,
      }],
    }));
    const service = new WalletService({} as never, { query } as never, {} as never);

    await expect(service.listWalletEntries("02000000-0000-4000-8000-000000000001")).resolves.toEqual([{
      id: "42",
      type: "SHOP_CHARGE",
      amountCents: "-18800",
      balanceAfterCents: "962400",
      occurredAt: "2026-08-10T12:49:55.372Z",
    }]);
  });
});
