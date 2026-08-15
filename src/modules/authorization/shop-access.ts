import type { ShopState } from './index.js';

interface ShopAccessQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<{ readonly rows: Row[] }>;
}

export type EffectiveShopAccessRow = {
  readonly id: string;
  readonly enterprise_id: string;
  readonly status: ShopState;
  readonly membership_id: string | null;
  readonly membership_status: 'ACTIVE' | 'REVOKED' | 'EXPIRED' | null;
  readonly export_allowed: boolean | null;
  readonly authorization_epoch: string | null;
};

export async function readEffectiveShopAccess(
  client: ShopAccessQueryClient,
  shopId: string,
  actorAccountId: string,
  options: { readonly forUpdate?: boolean } = {},
): Promise<EffectiveShopAccessRow | null> {
  const result = await client.query<EffectiveShopAccessRow>(
    `SELECT s.id, s.enterprise_id,
            CASE WHEN s.status = 'ACTIVE'
                       AND s.close_date <= timezone('Asia/Shanghai', clock_timestamp())::date
                 THEN 'EXPIRED_READONLY' ELSE s.status END AS status,
            sm.id AS membership_id, sm.status AS membership_status,
            sm.export_allowed, sm.authorization_epoch::text AS authorization_epoch
       FROM shop s
       LEFT JOIN shop_membership sm ON sm.shop_id = s.id AND sm.account_id = $2
      WHERE s.id = $1${options.forUpdate ? '\n      FOR UPDATE OF s' : ''}`,
    [shopId, actorAccountId],
  );
  return result.rows[0] ?? null;
}
