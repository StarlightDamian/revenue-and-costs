import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { PostgresDatabase } from "../db/database.js";
import { authorizePlatform, authorizeShop, CoreTransactionSideEffects, requireAllowed, type Actor, type ShopCapability } from "../modules/authorization/index.js";
import {
  AuthService,
  IdentityAdminService,
  PostgresAuthRepository,
  SandboxSmsProvider,
  TemporaryAdminSmsProvider,
} from "../modules/auth/index.js";
import { CatalogService } from "../modules/catalog/index.js";
import { MembershipService } from "../modules/memberships/index.js";
import {
  PaymentService,
  PostgresPaymentRepository,
  SandboxPaymentProvider,
  TemporaryManualPaymentProvider,
  type PaymentProvider,
} from "../modules/payments/index.js";
import { ShopService } from "../modules/shops/index.js";
import { WalletService } from "../modules/wallet/index.js";
import { EnterpriseService } from "../modules/enterprises/index.js";
import { PostgresFxService } from "../modules/fx/index.js";
import { UploadService } from "../modules/uploads/service.js";
import { PostgresImportService } from "../modules/imports/index.js";
import { PostgresReportService } from "../modules/publishing/index.js";
import type { AppConfig } from "../shared/config.js";
import { AppError } from "../shared/errors.js";
import { adminRoutes } from "./routes/admin.js";
import { appRoutes } from "./routes/apps.js";
import { authenticateAuthRoute, authenticateAuthSession, authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { paymentRoutes } from "./routes/payments.js";
import { enterpriseRoutes } from "./routes/enterprises.js";
import { shopRoutes } from "./routes/shops.js";
import { fxRoutes } from "./routes/fx.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { importRoutes } from "./routes/imports.js";
import { reportRoutes } from "./routes/reports.js";
import { EncryptedObjectStore } from "../modules/storage/encrypted-object-store.js";
import { exportOutputRoot, PostgresExportService } from "../modules/exports/postgres.js";
import { PostgresMembershipArtifactInvalidator } from "../modules/exports/postgres-membership-invalidator.js";
import { exportRoutes } from "./routes/exports.js";
import { registerOperationsRoutes } from "./routes/operations.js";
import { PostgresAccountingPreferencesService } from "../modules/accounting-preferences/index.js";
import { accountingPreferenceRoutes } from "./routes/accounting-preferences.js";
import { PostgresOnboardingService } from "../modules/onboarding/index.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { acquireIntermediateExportLease } from "./intermediate-export-capacity.js";

export function createServiceGraph(config: AppConfig, pool: Pool) {
  const database = new PostgresDatabase(pool);
  const effects = new CoreTransactionSideEffects();
  const artifactInvalidator = new PostgresMembershipArtifactInvalidator();
  const authRepository = new PostgresAuthRepository(database, database, artifactInvalidator);
  const sms = config.smsProvider === "sandbox"
    ? new SandboxSmsProvider()
    : config.smsProvider === "temporary-admin-fixed" && config.registrationAdminPhoneE164
      ? new TemporaryAdminSmsProvider(config.registrationAdminPhoneE164, config.temporaryPublicRegistration === true)
      : (() => { throw new AppError("SMS_PROVIDER_NOT_CONFIGURED", "短信适配器尚未配置", 503); })();
  const auth = new AuthService(authRepository, sms, {
    otpSecret: Buffer.from(config.otpHmacKey, "utf8"),
    privacySecret: Buffer.from(config.sessionHmacKey, "utf8"),
    allowSandboxCodeDisclosure: config.mode !== "production",
    ...(config.sandboxOtpCode ? { sandboxOtpCode: config.sandboxOtpCode } : {}),
    ...(config.temporaryAdminOtpCode ? { temporaryAdminOtpCode: config.temporaryAdminOtpCode } : {}),
    ...(config.mode !== "production" && config.registrationAdminPhoneE164
      ? { registrationAdminPhoneE164: config.registrationAdminPhoneE164 }
      : {}),
  });
  const wallet = new WalletService(database, database, effects);
  const enterprises = new EnterpriseService(database, database, effects);
  const catalog = new CatalogService(database, database, effects);
  const shops = new ShopService(database, database, effects);
  const memberships = new MembershipService(
    database,
    database,
    effects,
    Buffer.from(config.sessionHmacKey, 'utf8'),
    artifactInvalidator,
  );
  const identity = new IdentityAdminService(database, database, effects);
  const paymentRepository = new PostgresPaymentRepository(database, database, effects);
  const paymentProviders: PaymentProvider[] = [];
  if (config.paymentProvider === "sandbox") {
    paymentProviders.push(new SandboxPaymentProvider(
      "revenue-costs-sandbox",
      Buffer.from(config.sessionHmacKey, "utf8"),
    ));
  } else if (config.paymentProvider === "temporary-manual") {
    paymentProviders.push(new TemporaryManualPaymentProvider(
      "revenue-costs-temporary-manual",
      Buffer.from(config.sessionHmacKey, "utf8"),
    ));
  } else if (config.paymentProvider !== "disabled") {
    throw new AppError("PAYMENT_PROVIDER_NOT_CONFIGURED", "真实支付适配器尚未配置", 503);
  }
  const payments = new PaymentService(paymentRepository, paymentProviders);
  const fx = new PostgresFxService(database, database, effects);
  const uploads = new UploadService(pool, config.storageRoot);
  const imports = new PostgresImportService(database, database);
  const reports = new PostgresReportService(database, database);
  const accountingPreferences = new PostgresAccountingPreferencesService(database, database, effects);
  const onboarding = new PostgresOnboardingService(database);
  const objectStore = new EncryptedObjectStore(config.storageRoot, Buffer.from(config.fileKekBase64, "base64"));
  const exports = new PostgresExportService(pool, objectStore, config.exportOutputRoot ?? exportOutputRoot(process.cwd()));

  const authenticate = (request: FastifyRequest, requireCsrf: boolean): Promise<Actor> =>
    authenticateAuthRoute({ auth, publicOrigin: config.publicOrigin }, request, requireCsrf);

  const authorizeShopCapability = async (actor: Actor, shopId: string, capability: ShopCapability, reason?: string): Promise<void> => {
    const result = await database.query<{
      id: string;
      enterprise_id: string;
      status: "ACTIVE" | "EXPIRED_READONLY" | "TRASHED" | "PURGED";
      membership_id: string | null;
      membership_status: "ACTIVE" | "REVOKED" | "EXPIRED" | null;
      export_allowed: boolean | null;
      authorization_epoch: string | null;
    }>(
      `SELECT s.id, s.enterprise_id,
              CASE WHEN s.status = 'ACTIVE'
                         AND s.close_date <= timezone('Asia/Shanghai', clock_timestamp())::date
                   THEN 'EXPIRED_READONLY' ELSE s.status END AS status,
              sm.id AS membership_id, sm.status AS membership_status,
              sm.export_allowed, sm.authorization_epoch::text AS authorization_epoch
         FROM shop s
         LEFT JOIN shop_membership sm ON sm.shop_id = s.id AND sm.account_id = $2
        WHERE s.id = $1`,
      [shopId, actor.accountId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError("RESOURCE_NOT_FOUND", "资源不存在或无权访问", 404);
    requireAllowed(authorizeShop(
      actor,
      { id: row.id, enterpriseId: row.enterprise_id, state: row.status },
      row.membership_id ? {
        id: row.membership_id,
        shopId: row.id,
        accountId: actor.accountId,
        status: row.membership_status!,
        exportAllowed: row.export_allowed ?? false,
        authorizationEpoch: row.authorization_epoch!,
      } : null,
      capability,
    ), reason);
  };

  return { database, effects, authRepository, auth, sms, wallet, enterprises, catalog, shops, memberships, identity, payments, fx, uploads, imports, reports, accountingPreferences, onboarding, objectStore, exports, authenticate, authorizeShopCapability };
}

export async function registerCoreRoutes(app: FastifyInstance, config: AppConfig, pool: Pool): Promise<ReturnType<typeof createServiceGraph>> {
  const graph = createServiceGraph(config, pool);
  await app.register(authRoutes, {
    auth: graph.auth,
    publicOrigin: config.publicOrigin,
    secureCookies: config.mode === "production",
    cookiePath: config.appBasePath,
  });
  await app.register(meRoutes, {
    authService: graph.auth,
    authenticate: (request, requireCsrf) => authenticateAuthSession({ auth: graph.auth, publicOrigin: config.publicOrigin }, request, requireCsrf),
    getAccount: (id) => graph.authRepository.findAccountById(id),
    getCustomerAccess: async (id) => {
      const result = await graph.database.query<{ count: string; home_shop_id: string | null }>(
        `SELECT count(*)::text AS count,
                (array_agg(shop_id ORDER BY updated_at DESC, granted_at DESC))[1] AS home_shop_id
           FROM shop_membership
          WHERE account_id = $1 AND status = 'ACTIVE'`,
        [id],
      );
      const row = result.rows[0];
      return {
        count: Number(row?.count ?? "0"),
        ...(row?.home_shop_id ? { homeShopId: row.home_shop_id } : {}),
      };
    },
  });
  await app.register(accountingPreferenceRoutes, {
    service: graph.accountingPreferences,
    authenticate: graph.authenticate,
  });
  await app.register(onboardingRoutes, { service: graph.onboarding, authenticate: graph.authenticate, authorize: graph.authorizeShopCapability });
  await app.register(appRoutes, { catalog: graph.catalog, authenticate: graph.authenticate });
  await app.register(enterpriseRoutes, { enterprises: graph.enterprises, authenticate: graph.authenticate });
  await app.register(shopRoutes, { shops: graph.shops, memberships: graph.memberships, authenticate: graph.authenticate });
  await app.register(adminRoutes, { identity: graph.identity, wallet: graph.wallet, fx: graph.fx, authenticate: graph.authenticate });
  // Keep payment JSON raw-body parsing in its encapsulated Fastify scope.
  await app.register(paymentRoutes, { service: graph.payments, wallet: graph.wallet, authenticate: graph.authenticate });
  await app.register(async (scope) => {
    scope.addHook("onRequest", async (request) => {
      const actor = await graph.authenticate(request, request.method !== "GET");
      requireAllowed(authorizePlatform(actor, "FX_READ"));
    });
    await scope.register(fxRoutes, { services: graph.fx, syncEnabled: config.chinaMoneyEnabled });
  });
  await app.register(async (scope) => {
    await registerUploadRoutes(scope, {
      service: graph.uploads,
      objectStore: graph.objectStore,
      authorize: async (request, shopId, action, reason) => {
        const method = (request as FastifyRequest).method;
        const actor = await graph.authenticate(request as FastifyRequest, method !== "GET" && method !== "HEAD");
        await graph.authorizeShopCapability(actor, shopId, action === "original" ? "ORIGINAL_DOWNLOAD" : "UPLOAD", reason);
        return actor;
      },
      auditOriginalDownload: async (actor, fileId, reason) => {
        await graph.database.query(
          `INSERT INTO audit_event (actor_account_id,action,object_type,object_id,reason,metadata)
           VALUES ($1,'ORIGINAL_DOWNLOAD','UPLOAD_FILE',$2,$3,$4::jsonb)`,
          [actor.accountId, fileId, reason?.trim() || null, JSON.stringify({ actorRoles: [...actor.roles] })],
        );
      },
    });
  });
  const shopRouteSecurity = {
    authenticate: (request: FastifyRequest) => graph.authenticate(request, request.method !== "GET"),
    authorize: graph.authorizeShopCapability,
  };
  await app.register(importRoutes, {
    services: graph.imports,
    ...shopRouteSecurity,
  });
  await app.register(reportRoutes, {
    services: graph.reports,
    acquireIntermediateExport: (accountId) => acquireIntermediateExportLease(pool, accountId),
    getContinentPrefixes: async (accountId) => (await graph.accountingPreferences.get(accountId)).continentPrefixes,
    ...shopRouteSecurity,
    async auditAdminAccess(actor, shopId, view, requestId, filter) {
      await graph.effects.audit(graph.database, {
        actorAccountId: actor.accountId,
        actorRoles: [...actor.roles],
        objectType: "shop",
        objectId: shopId,
        action: "ADMIN_FINANCIAL_REPORT_VIEWED",
        result: "SUCCEEDED",
        reason: null,
        requestId,
        before: null,
        after: { view, filter },
      });
    },
  });
  await app.register(exportRoutes,{service:graph.exports,authenticate:graph.authenticate});
  await registerOperationsRoutes(app, {
    config,
    pool,
    requireAdmin: async (request) => {
      const actor = await graph.authenticate(request as FastifyRequest, false);
      if (!actor.roles.has("ADMIN")) throw new AppError("RESOURCE_NOT_FOUND", "资源不存在或无权访问", 404);
    },
  });
  return graph;
}
