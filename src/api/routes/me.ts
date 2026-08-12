import { Type, type Static } from '@sinclair/typebox';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Actor } from '../../modules/authorization/index.js';
import { maskPhone, type AccountRecord, type AuthService } from '../../modules/auth/index.js';
import { AppError } from '../../shared/errors.js';

const ThemeSchema = Type.Object({
  themeId: Type.Union([Type.Literal('comfort'), Type.Literal('tech'), Type.Literal('light'), Type.Literal('dark')]),
});
const AvatarSchema = Type.Object({ avatarId: Type.Integer({ minimum: 1, maximum: 59 }) });
// The service validates the NFC-normalized Unicode code-point count. This wider
// transport bound also admits decomposed text and supplementary-plane glyphs.
const ProfileSchema = Type.Object({ displayName: Type.String({ maxLength: 320 }) });
type ThemeBody = Static<typeof ThemeSchema>;
type AvatarBody = Static<typeof AvatarSchema>;
type ProfileBody = Static<typeof ProfileSchema>;

export interface MeRouteOptions {
  readonly authService: AuthService;
  authenticate(request: FastifyRequest, requireCsrf: boolean): Promise<{ readonly actor: Actor; readonly isFirstLogin: boolean }>;
  getAccount(accountId: string): Promise<AccountRecord | null>;
  getCustomerAccess(accountId: string): Promise<{ readonly count: number; readonly homeShopId?: string }>;
}

export const meRoutes: FastifyPluginAsync<MeRouteOptions> = async (app, options) => {
  app.get('/api/v1/me', async (request) => {
    const authentication = await options.authenticate(request, false);
    const { actor } = authentication;
    const account = await options.getAccount(actor.accountId);
    if (!account) throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
    const customerAccess = await options.getCustomerAccess(actor.accountId);
    const phoneMasked = maskPhone(account.phoneE164);
    return {
      id: account.id,
      ...(account.displayName ? { displayName: account.displayName } : {}),
      avatarId: account.avatarId,
      phoneMasked,
      status: account.status,
      themeId: account.themeId,
      theme: account.themeId,
      roles: [...account.roles],
      customerShopCount: customerAccess.count,
      isFirstLogin: authentication.isFirstLogin,
      ...(customerAccess.homeShopId ? { customerHomeShopId: customerAccess.homeShopId } : {}),
    };
  });

  app.patch<{ Body: ThemeBody }>(
    '/api/v1/me/theme',
    { schema: { body: ThemeSchema } },
    async (request) => {
      const authentication = await options.authenticate(request, true);
      const { actor } = authentication;
      await options.authService.setTheme(actor.accountId, request.body.themeId);
      const account = await options.getAccount(actor.accountId);
      const customerAccess = await options.getCustomerAccess(actor.accountId);
      return {
        id: actor.accountId,
        ...(account?.displayName ? { displayName: account.displayName } : {}),
        avatarId: account?.avatarId ?? 1,
        phoneMasked: account ? maskPhone(account.phoneE164) : '***',
        status: account?.status ?? 'ACTIVE',
        themeId: request.body.themeId,
        theme: request.body.themeId,
        roles: [...actor.roles],
        customerShopCount: customerAccess.count,
        isFirstLogin: authentication.isFirstLogin,
        ...(customerAccess.homeShopId ? { customerHomeShopId: customerAccess.homeShopId } : {}),
      };
    },
  );

  app.patch<{ Body: AvatarBody }>(
    '/api/v1/me/avatar',
    { schema: { body: AvatarSchema } },
    async (request) => {
      const authentication = await options.authenticate(request, true);
      const { actor } = authentication;
      await options.authService.setAvatar(actor.accountId, request.body.avatarId);
      const account = await options.getAccount(actor.accountId);
      if (!account) throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
      const customerAccess = await options.getCustomerAccess(actor.accountId);
      return {
        id: account.id,
        ...(account.displayName ? { displayName: account.displayName } : {}),
        avatarId: account.avatarId,
        phoneMasked: maskPhone(account.phoneE164),
        status: account.status,
        themeId: account.themeId,
        theme: account.themeId,
        roles: [...actor.roles],
        customerShopCount: customerAccess.count,
        isFirstLogin: authentication.isFirstLogin,
        ...(customerAccess.homeShopId ? { customerHomeShopId: customerAccess.homeShopId } : {}),
      };
    },
  );

  app.patch<{ Body: ProfileBody }>(
    '/api/v1/me/profile',
    { schema: { body: ProfileSchema } },
    async (request) => {
      const authentication = await options.authenticate(request, true);
      const { actor } = authentication;
      await options.authService.setDisplayName(actor.accountId, request.body.displayName);
      const account = await options.getAccount(actor.accountId);
      if (!account) throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
      const customerAccess = await options.getCustomerAccess(actor.accountId);
      return {
        id: account.id,
        ...(account.displayName ? { displayName: account.displayName } : {}),
        avatarId: account.avatarId,
        phoneMasked: maskPhone(account.phoneE164),
        status: account.status,
        themeId: account.themeId,
        theme: account.themeId,
        roles: [...actor.roles],
        customerShopCount: customerAccess.count,
        isFirstLogin: authentication.isFirstLogin,
        ...(customerAccess.homeShopId ? { customerHomeShopId: customerAccess.homeShopId } : {}),
      };
    },
  );
};
