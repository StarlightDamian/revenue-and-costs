import type { CustomerMembership, SqlClient } from "../authorization/index.js";

export interface MembershipArtifactInvalidator {
  invalidateForMembership(
    client: SqlClient,
    membershipId: string,
    newAuthorizationEpoch: string,
  ): Promise<void>;
}

interface MembershipRow extends Record<string, unknown> {
  id: string;
  shop_id: string;
  account_id: string;
  status: CustomerMembership["status"];
  export_allowed: boolean;
  authorization_epoch: string;
}

export async function activateShopMembership(
  client: SqlClient,
  artifactInvalidator: MembershipArtifactInvalidator,
  input: {
    readonly shopId: string;
    readonly accountId: string;
    readonly exportAllowed: boolean;
    readonly invitationId: string;
    readonly grantedBy: string;
  },
): Promise<CustomerMembership> {
  const result = await client.query<MembershipRow>(
    `INSERT INTO shop_membership
      (shop_id, account_id, export_allowed, invitation_id, granted_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (shop_id, account_id) DO UPDATE
       SET status = 'ACTIVE', export_allowed = EXCLUDED.export_allowed,
           authorization_epoch = shop_membership.authorization_epoch + 1,
           invitation_id = EXCLUDED.invitation_id, granted_by = EXCLUDED.granted_by,
           granted_at = clock_timestamp(), revoked_at = NULL, revoke_reason = NULL,
           updated_at = clock_timestamp()
     RETURNING id, shop_id, account_id, status, export_allowed, authorization_epoch`,
    [input.shopId, input.accountId, input.exportAllowed, input.invitationId, input.grantedBy],
  );
  const row = result.rows[0];
  if (!row) throw new Error("SHOP_MEMBERSHIP_ACTIVATION_FAILED");

  // authorization_epoch starts at 1 by schema contract. Any larger returned
  // value came from the conflict branch, including a concurrent activation.
  if (row.authorization_epoch !== "1") {
    await artifactInvalidator.invalidateForMembership(client, row.id, row.authorization_epoch);
  }

  return {
    id: row.id,
    shopId: row.shop_id,
    accountId: row.account_id,
    status: row.status,
    exportAllowed: row.export_allowed,
    authorizationEpoch: row.authorization_epoch,
  };
}
