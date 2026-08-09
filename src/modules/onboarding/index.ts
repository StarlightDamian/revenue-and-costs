import type { SqlClient } from "../authorization/index.js";

export type OnboardingGuide = "WORKSPACE" | "SHOP_WORKFLOW";

export class PostgresOnboardingService {
  constructor(private readonly database: SqlClient) {}

  async get(accountId: string, guide: OnboardingGuide, resourceKey: string, version: number): Promise<{ dismissed: boolean }> {
    const result = await this.database.query(
      `SELECT 1 FROM account_onboarding_state
        WHERE account_id=$1 AND guide_key=$2 AND resource_key=$3 AND guide_version=$4`,
      [accountId, guide, resourceKey, version],
    );
    return { dismissed: Boolean(result.rows[0]) };
  }

  async set(accountId: string, guide: OnboardingGuide, resourceKey: string, version: number, dismissed: boolean): Promise<{ dismissed: boolean }> {
    if (dismissed) {
      await this.database.query(
        `INSERT INTO account_onboarding_state(account_id,guide_key,resource_key,guide_version)
         VALUES($1,$2,$3,$4)
         ON CONFLICT(account_id,guide_key,resource_key,guide_version)
         DO UPDATE SET dismissed_at=clock_timestamp(),updated_at=clock_timestamp()`,
        [accountId, guide, resourceKey, version],
      );
    } else {
      await this.database.query(
        `DELETE FROM account_onboarding_state
          WHERE account_id=$1 AND guide_key=$2 AND resource_key=$3 AND guide_version=$4`,
        [accountId, guide, resourceKey, version],
      );
    }
    return { dismissed };
  }
}
