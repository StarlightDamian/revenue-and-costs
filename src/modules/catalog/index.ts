import type { SqlClient, TransactionRunner, TransactionSideEffects } from '../authorization/index.js';
import { AppError } from '../../shared/errors.js';

export interface ApplicationView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'INACTIVE';
  readonly sortOrder: number;
  readonly allowedRoles: readonly 'ACCOUNTANT'[];
  readonly currentPrice: null | {
    readonly id: string;
    readonly annualPriceCents: string;
    readonly effectiveFrom: string;
  };
}

interface ApplicationRow extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  sort_order: number;
  price_id: string | null;
  annual_price_cents: string | null;
  effective_from: Date | null;
  allowed_roles: ('ACCOUNTANT' | 'ADMIN')[] | null;
}

function mapApplication(row: ApplicationRow): ApplicationView {
  const effectiveFrom = row.effective_from === null
    ? null
    : String(row.effective_from).toLocaleLowerCase("en-US").includes("infinity")
      || row.effective_from instanceof Date && Number.isNaN(row.effective_from.getTime())
      ? "0001-01-01T00:00:00.000Z"
      : row.effective_from instanceof Date
        ? row.effective_from.toISOString()
        : new Date(String(row.effective_from)).toISOString();
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    sortOrder: row.sort_order,
    allowedRoles: (row.allowed_roles ?? []).filter((role): role is 'ACCOUNTANT' => role === 'ACCOUNTANT'),
    currentPrice:
      row.price_id && row.annual_price_cents && effectiveFrom
        ? {
            id: row.price_id,
            annualPriceCents: row.annual_price_cents,
            effectiveFrom,
          }
        : null,
  };
}

export class CatalogService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly reader: SqlClient,
    private readonly effects: TransactionSideEffects,
  ) {}

  async list(includeInactive = false): Promise<readonly ApplicationView[]> {
    const result = await this.reader.query<ApplicationRow>(
      `SELECT a.*, p.id AS price_id, p.annual_price_cents, p.effective_from,
              COALESCE(r.allowed_roles, ARRAY[]::text[]) AS allowed_roles
         FROM application a
         LEFT JOIN LATERAL (
           SELECT id, annual_price_cents, effective_from
             FROM application_price_version
            WHERE application_id = a.id AND effective_from <= clock_timestamp()
            ORDER BY effective_from DESC LIMIT 1
         ) p ON true
         LEFT JOIN LATERAL (
           SELECT array_agg(current_policy.platform_role ORDER BY current_policy.platform_role)
                    FILTER (WHERE current_policy.can_create_shop) AS allowed_roles
             FROM (
               SELECT DISTINCT ON (platform_role) platform_role, can_create_shop
                 FROM application_role_policy
                WHERE application_id = a.id AND effective_from <= clock_timestamp()
                ORDER BY platform_role, effective_from DESC
             ) current_policy
         ) r ON true
        WHERE ($1 OR a.status = 'ACTIVE')
        ORDER BY a.sort_order, a.id`,
      [includeInactive],
    );
    return result.rows.map(mapApplication);
  }

  async createPriceVersion(input: {
    readonly applicationId: string;
    readonly annualPriceCents: string;
    readonly effectiveFrom: string;
    readonly actorAccountId: string;
    readonly reason: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<string> {
    const price = BigInt(input.annualPriceCents);
    if (price < 0n) throw new AppError('PRICE_INVALID', '价格不能为负数', 400, 'annualPriceCents');
    const reason = input.reason.trim();
    if (!reason) throw new AppError('REASON_REQUIRED', '价格变更必须填写原因', 400, 'reason');
    const effectiveAt = new Date(input.effectiveFrom);
    if (Number.isNaN(effectiveAt.getTime())) {
      throw new AppError('EFFECTIVE_FROM_INVALID', '价格生效时间无效', 400, 'effectiveFrom');
    }
    const effectiveFrom = effectiveAt.toISOString();
    return this.transactions.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('application-price:' || $1 || ':' || $2, 0))",
        [input.actorAccountId, input.idempotencyKey],
      );
      const existing = await client.query<{
        id: string;
        application_id: string;
        annual_price_cents: string;
        effective_from: Date;
        reason: string | null;
      }>(
        `SELECT apv.id, apv.application_id, apv.annual_price_cents, apv.effective_from, ae.reason
           FROM application_price_version apv
           LEFT JOIN LATERAL (
             SELECT reason FROM audit_event
              WHERE object_type = 'application_price_version' AND object_id = apv.id
                AND action = 'APPLICATION_PRICE_CREATED'
              ORDER BY occurred_at LIMIT 1
           ) ae ON true
          WHERE apv.created_by = $1 AND apv.idempotency_key = $2`,
        [input.actorAccountId, input.idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (
          prior.application_id !== input.applicationId ||
          prior.annual_price_cents !== price.toString() ||
          prior.effective_from.toISOString() !== effectiveFrom ||
          prior.reason !== reason
        ) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', '同一幂等键不能用于不同价格版本', 409);
        }
        return prior.id;
      }
      const result = await client.query<{ id: string }>(
        `INSERT INTO application_price_version
          (application_id, annual_price_cents, effective_from, created_by, idempotency_key)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [input.applicationId, price.toString(), effectiveFrom, input.actorAccountId, input.idempotencyKey],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('创建价格版本失败');
      await this.effects.audit(client, {
        actorAccountId: input.actorAccountId,
        actorRoles: ['ADMIN'],
        objectType: 'application_price_version',
        objectId: id,
        action: 'APPLICATION_PRICE_CREATED',
        result: 'SUCCEEDED',
        reason,
        requestId: input.requestId,
        before: null,
        after: { applicationId: input.applicationId, annualPriceCents: price.toString(), effectiveFrom },
      });
      return id;
    });
  }

  async updateApplication(input: {
    readonly applicationId: string;
    readonly name: string;
    readonly status: 'ACTIVE' | 'INACTIVE';
    readonly sortOrder: number;
    readonly allowedRoles: readonly 'ACCOUNTANT'[];
    readonly actorAccountId: string;
    readonly reason: string;
    readonly requestId: string;
  }): Promise<void> {
    if (!input.name.trim() || !input.reason.trim()) {
      throw new AppError('APPLICATION_INPUT_INVALID', '应用名称和变更原因不能为空', 400);
    }
    const allowedRoles = [...new Set(input.allowedRoles)].sort();
    await this.transactions.transaction(async (client) => {
      const before = await client.query<{ name: string; status: string; sort_order: number }>(
        'SELECT name, status, sort_order FROM application WHERE id = $1 FOR UPDATE',
        [input.applicationId],
      );
      if (!before.rows[0]) throw new AppError('APPLICATION_NOT_FOUND', '应用不存在', 404);
      await client.query(
        `UPDATE application SET name = $2, status = $3, sort_order = $4, updated_at = clock_timestamp()
          WHERE id = $1`,
        [input.applicationId, input.name.trim(), input.status, input.sortOrder],
      );
      const policies = await client.query<{ platform_role: 'ACCOUNTANT' | 'ADMIN'; can_create_shop: boolean }>(
        `SELECT DISTINCT ON (platform_role) platform_role, can_create_shop
           FROM application_role_policy
          WHERE application_id = $1 AND effective_from <= clock_timestamp()
          ORDER BY platform_role, effective_from DESC`,
        [input.applicationId],
      );
      const current = new Map(policies.rows.map((policy) => [policy.platform_role, policy.can_create_shop]));
      const policyEffectiveFrom = new Date().toISOString();
      for (const role of ['ACCOUNTANT', 'ADMIN'] as const) {
        const allowed = role === 'ADMIN' || allowedRoles.includes('ACCOUNTANT');
        if ((current.get(role) ?? false) !== allowed) {
          await client.query(
            `INSERT INTO application_role_policy
              (application_id, platform_role, can_create_shop, effective_from)
             VALUES ($1,$2,$3,$4)`,
            [input.applicationId, role, allowed, policyEffectiveFrom],
          );
        }
      }
      await this.effects.audit(client, {
        actorAccountId: input.actorAccountId,
        actorRoles: ['ADMIN'],
        objectType: 'application',
        objectId: input.applicationId,
        action: 'APPLICATION_UPDATED',
        result: 'SUCCEEDED',
        reason: input.reason.trim(),
        requestId: input.requestId,
        before: {
          ...before.rows[0],
          allowedRoles: [...current.entries()].filter(([, allowed]) => allowed).map(([role]) => role).sort(),
        },
        after: { name: input.name.trim(), status: input.status, sortOrder: input.sortOrder, allowedRoles },
      });
    });
  }
}
