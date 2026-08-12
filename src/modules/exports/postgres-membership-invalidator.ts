import type { SqlClient } from "../authorization/index.js";
import type { MembershipArtifactInvalidator } from "../memberships/activation.js";

export class PostgresMembershipArtifactInvalidator implements MembershipArtifactInvalidator {
  async invalidateForMembership(
    client: SqlClient,
    membershipId: string,
    newAuthorizationEpoch: string,
  ): Promise<void> {
    await client.query(
      `UPDATE export_request er
          SET status = 'REVOKED', stage = 'REVOKED', error_code = 'MEMBERSHIP_REVOKED',
              finished_at = clock_timestamp(), heartbeat_at = clock_timestamp()
         FROM shop_membership sm
        WHERE sm.id = $1
          AND er.shop_id = sm.shop_id
          AND er.requested_by = sm.account_id
          AND er.status IN ('QUEUED','RUNNING','SUCCEEDED')
          AND er.membership_authorization_version IS NOT NULL
          AND er.membership_authorization_version::text <> $2`,
      [membershipId, newAuthorizationEpoch],
    );
    await client.query(
      `UPDATE export_download_grant
          SET revoked_at = clock_timestamp()
        WHERE membership_id = $1
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND membership_authorization_version::text <> $2`,
      [membershipId, newAuthorizationEpoch],
    );
  }
}
