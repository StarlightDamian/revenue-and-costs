export type PlatformRole = 'ACCOUNTANT' | 'ADMIN';
export type ShopState = 'ACTIVE' | 'EXPIRED_READONLY' | 'TRASHED' | 'PURGED';

export interface Actor {
  readonly accountId: string;
  readonly status: 'ACTIVE' | 'DISABLED';
  readonly roles: ReadonlySet<PlatformRole>;
  readonly enterpriseIds?: ReadonlySet<string>;
}

export interface ShopAccessResource {
  readonly id: string;
  readonly enterpriseId: string;
  readonly state: ShopState;
}

export interface CustomerMembership {
  readonly id: string;
  readonly shopId: string;
  readonly accountId: string;
  readonly status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  readonly exportAllowed: boolean;
  readonly authorizationEpoch: string;
}

export type PlatformCapability =
  | 'FX_READ'
  | 'ACCOUNT_SETTINGS'
  | 'ENTERPRISE_CREATE'
  | 'SHOP_CREATE'
  | 'ADMIN_ACCOUNTANTS'
  | 'ADMIN_APPLICATIONS'
  | 'ADMIN_DATA_GOVERNANCE';

export type ShopCapability =
  | 'SHOP_READ'
  | 'PUBLISHED_RESULT_READ'
  | 'DRAFT_RESULT_READ'
  | 'SHOP_RENAME'
  | 'SHOP_RENEW'
  | 'SHOP_TRASH'
  | 'SHOP_RESTORE'
  | 'SHOP_PURGE'
  | 'MEMBERSHIP_MANAGE'
  | 'UPLOAD'
  | 'IMPORT_COMMIT'
  | 'QUALITY_ACKNOWLEDGE'
  | 'DATASET_ROLLBACK'
  | 'RESULT_PUBLISH'
  | 'RESULT_EXPORT'
  | 'ORIGINAL_DOWNLOAD';

export interface AuthorizationDecision {
  readonly allowed: boolean;
  readonly reasonRequired: boolean;
  readonly scope: 'PLATFORM' | 'ENTERPRISE' | 'CUSTOMER' | 'ADMIN' | 'NONE';
}

const allow = (
  scope: AuthorizationDecision['scope'],
  reasonRequired = false,
): AuthorizationDecision => ({ allowed: true, reasonRequired, scope });
const deny = (): AuthorizationDecision => ({ allowed: false, reasonRequired: false, scope: 'NONE' });

export function authorizePlatform(actor: Actor, capability: PlatformCapability): AuthorizationDecision {
  if (actor.status !== 'ACTIVE') return deny();
  const isAdmin = actor.roles.has('ADMIN');
  const isUser = actor.roles.has('ACCOUNTANT');
  switch (capability) {
    case 'FX_READ':
      return isUser || isAdmin ? allow('PLATFORM') : deny();
    case 'ACCOUNT_SETTINGS':
      return allow('PLATFORM');
    case 'ENTERPRISE_CREATE':
      return isUser ? allow('PLATFORM') : deny();
    case 'SHOP_CREATE':
      return isAdmin ? allow('ADMIN') : isUser ? allow('PLATFORM') : deny();
    case 'ADMIN_ACCOUNTANTS':
    case 'ADMIN_APPLICATIONS':
    case 'ADMIN_DATA_GOVERNANCE':
      return isAdmin ? allow('ADMIN') : deny();
  }
}

const expiredBlockedCapabilities = new Set<ShopCapability>([
  'DRAFT_RESULT_READ',
  'UPLOAD',
  'IMPORT_COMMIT',
  'QUALITY_ACKNOWLEDGE',
  'DATASET_ROLLBACK',
  'RESULT_PUBLISH',
]);

export function authorizeShop(
  actor: Actor,
  shop: ShopAccessResource,
  membership: CustomerMembership | null,
  capability: ShopCapability,
): AuthorizationDecision {
  if (actor.status !== 'ACTIVE' || shop.state === 'PURGED') return deny();
  const isAdmin = actor.roles.has('ADMIN');
  const isEnterpriseMember = actor.enterpriseIds?.has(shop.enterpriseId) ?? false;
  const isCustomer =
    membership?.status === 'ACTIVE' &&
    membership.shopId === shop.id &&
    membership.accountId === actor.accountId;

  if (isAdmin) {
    if (shop.state === 'TRASHED') {
      return capability === 'SHOP_READ' || capability === 'SHOP_RESTORE' || capability === 'SHOP_PURGE'
        ? allow('ADMIN')
        : deny();
    }
    if (shop.state === 'EXPIRED_READONLY' && expiredBlockedCapabilities.has(capability)) return deny();
    return allow('ADMIN', capability === 'ORIGINAL_DOWNLOAD');
  }

  if (isEnterpriseMember) {
    if (shop.state === 'TRASHED') {
      return capability === 'SHOP_READ' || capability === 'SHOP_RESTORE' || capability === 'SHOP_PURGE'
        ? allow('ENTERPRISE')
        : deny();
    }
    if (shop.state === 'EXPIRED_READONLY' && expiredBlockedCapabilities.has(capability)) {
      return deny();
    }
    return allow('ENTERPRISE');
  }

  if (isCustomer && shop.state !== 'TRASHED') {
    if (capability === 'SHOP_READ' || capability === 'PUBLISHED_RESULT_READ') return allow('CUSTOMER');
    if (capability === 'RESULT_EXPORT' && membership.exportAllowed) return allow('CUSTOMER');
  }
  return deny();
}

export class AuthorizationError extends Error {
  readonly code = 'RESOURCE_NOT_FOUND';
  readonly statusCode = 404;

  constructor() {
    super('资源不存在或无权访问');
    this.name = 'AuthorizationError';
  }
}

export function requireAllowed(decision: AuthorizationDecision, reason?: string): void {
  if (!decision.allowed) throw new AuthorizationError();
  if (decision.reasonRequired && !reason?.trim()) {
    const error = new Error('此操作必须填写原因');
    error.name = 'ReasonRequiredError';
    throw error;
  }
}

export interface SqlQueryResult<Row> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

export interface SqlClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    parameters?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
}

export interface TransactionRunner {
  transaction<Result>(work: (client: SqlClient) => Promise<Result>): Promise<Result>;
}

export interface AuditRecord {
  readonly actorAccountId: string | null;
  readonly actorRoles: readonly string[];
  readonly objectType: string;
  readonly objectId: string;
  readonly action: string;
  readonly result: 'SUCCEEDED' | 'FAILED';
  readonly reason: string | null;
  readonly requestId: string;
  readonly before: Readonly<Record<string, unknown>> | null;
  readonly after: Readonly<Record<string, unknown>> | null;
}

export interface TransactionSideEffects {
  audit(client: SqlClient, record: AuditRecord): Promise<void>;
  outbox(
    client: SqlClient,
    event: {
      readonly eventId: string;
      readonly eventType: string;
      readonly businessKey: string;
      readonly payload: Readonly<Record<string, unknown>>;
    },
  ): Promise<void>;
}

export { CoreTransactionSideEffects } from './events.js';
