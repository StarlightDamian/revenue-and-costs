import { describe, expect, it, vi } from "vitest";
import type { SqlClient } from "../../src/modules/authorization/index.js";
import { activateShopMembership } from "../../src/modules/memberships/activation.js";

const input = {
  shopId: "10000000-0000-4000-8000-000000000001",
  accountId: "20000000-0000-4000-8000-000000000002",
  exportAllowed: true,
  invitationId: "30000000-0000-4000-8000-000000000003",
  grantedBy: "40000000-0000-4000-8000-000000000004",
};

function fixture(authorizationEpoch: string) {
  const query = vi.fn(async () => ({
    rows: [{
      id: "50000000-0000-4000-8000-000000000005",
      shop_id: input.shopId,
      account_id: input.accountId,
      status: "ACTIVE",
      export_allowed: true,
      authorization_epoch: authorizationEpoch,
    }],
    rowCount: 1,
  }));
  const invalidateForMembership = vi.fn(async () => undefined);
  return {
    client: { query } as unknown as SqlClient,
    invalidator: { invalidateForMembership },
    invalidateForMembership,
  };
}

describe("shop membership activation", () => {
  it("does not invalidate artifacts for the initial epoch", async () => {
    const { client, invalidator, invalidateForMembership } = fixture("1");

    await expect(activateShopMembership(client, invalidator, input)).resolves.toMatchObject({
      authorizationEpoch: "1",
      shopId: input.shopId,
    });

    expect(invalidateForMembership).not.toHaveBeenCalled();
  });

  it("invalidates stale artifacts for every conflict activation epoch", async () => {
    const { client, invalidator, invalidateForMembership } = fixture("5");

    await activateShopMembership(client, invalidator, input);

    expect(invalidateForMembership).toHaveBeenCalledWith(
      client,
      "50000000-0000-4000-8000-000000000005",
      "5",
    );
  });
});
