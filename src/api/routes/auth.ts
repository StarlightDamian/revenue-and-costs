import { Type, type Static } from '@sinclair/typebox';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { AppError } from '../../shared/errors.js';
import { UuidSchema } from '../../shared/contracts.js';
import type { Actor } from '../../modules/authorization/index.js';
import type { AuthService, OtpPurpose } from '../../modules/auth/index.js';

const PhoneSchema = Type.String({ pattern: '^\\+[1-9][0-9]{7,14}$' });
const OtpRequestSchema = Type.Object({
  phone: PhoneSchema,
  purpose: Type.Union([
    Type.Literal('REGISTER'),
    Type.Literal('LOGIN'),
    Type.Literal('PHONE_CHANGE_OLD'),
    Type.Literal('PHONE_CHANGE_NEW'),
  ]),
  deviceId: Type.String({ minLength: 8, maxLength: 200 }),
});
const OtpVerifySchema = Type.Object({
  challengeId: UuidSchema,
  phone: PhoneSchema,
  purpose: Type.Union([
    Type.Literal('LOGIN'),
    Type.Literal('PHONE_CHANGE_OLD'),
    Type.Literal('PHONE_CHANGE_NEW'),
  ]),
  code: Type.String({ pattern: '^[0-9]{6}$' }),
});
const PhoneChangeSchema = Type.Object({
  oldChallengeId: UuidSchema,
  newChallengeId: UuidSchema,
  newPhone: PhoneSchema,
});
const RegistrationSchema = Type.Object({
  challengeId: UuidSchema,
  phone: PhoneSchema,
  purpose: Type.Literal('REGISTER'),
  code: Type.String({ pattern: '^[0-9]{6}$' }),
  displayName: Type.Optional(Type.String({ maxLength: 80 })),
});

type OtpRequest = Static<typeof OtpRequestSchema>;
type OtpVerify = Static<typeof OtpVerifySchema>;
type PhoneChange = Static<typeof PhoneChangeSchema>;
type Registration = Static<typeof RegistrationSchema>;

export interface AuthRouteOptions {
  readonly auth: AuthService;
  readonly publicOrigin: string;
  readonly secureCookies: boolean;
}

function sessionToken(request: FastifyRequest): string {
  const token = request.cookies.rc_session;
  if (!token) throw new AppError('SESSION_REQUIRED', '请先登录', 401);
  return token;
}

function requirePublicOrigin(
  options: Pick<AuthRouteOptions, 'publicOrigin'>,
  request: FastifyRequest,
): void {
  if (request.headers.origin !== options.publicOrigin) {
    throw new AppError('ORIGIN_INVALID', '请求来源无效', 403);
  }
}

export async function authenticateAuthSession(
  options: Pick<AuthRouteOptions, 'auth' | 'publicOrigin'>,
  request: FastifyRequest,
  requireCsrf: boolean,
): ReturnType<AuthService['authenticate']> {
  let csrf: string | undefined;
  if (requireCsrf) {
    requirePublicOrigin(options, request);
    const value = request.headers['x-csrf-token'];
    if (typeof value !== 'string' || !value) {
      throw new AppError('CSRF_REQUIRED', '缺少请求校验信息', 403);
    }
    csrf = value;
  }
  return options.auth.authenticate(sessionToken(request), csrf);
}

export async function authenticateAuthRoute(
  options: Pick<AuthRouteOptions, 'auth' | 'publicOrigin'>,
  request: FastifyRequest,
  requireCsrf: boolean,
): Promise<Actor> {
  return (await authenticateAuthSession(options, request, requireCsrf)).actor;
}

export const authRoutes: FastifyPluginAsync<AuthRouteOptions> = async (app, options) => {
  app.post<{ Body: OtpRequest }>(
    '/api/v1/auth/otp',
    { schema: { body: OtpRequestSchema } },
    async (request) => {
      requirePublicOrigin(options, request);
      try {
        return await options.auth.requestOtp({
          phone: request.body.phone,
          purpose: request.body.purpose as OtpPurpose,
          ip: request.ip,
          deviceId: request.body.deviceId,
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'OtpRateLimitError') {
          throw new AppError('OTP_RATE_LIMITED', '验证码请求过于频繁', 429);
        }
        throw error;
      }
    },
  );

  app.post<{ Body: OtpVerify }>(
    '/api/v1/auth/verify',
    { schema: { body: OtpVerifySchema } },
    async (request, reply) => {
      requirePublicOrigin(options, request);
      if (request.body.purpose !== 'LOGIN') {
        return options.auth.verifyChallenge({
          challengeId: request.body.challengeId,
          phone: request.body.phone,
          purpose: request.body.purpose,
          code: request.body.code,
        });
      }
      const result = await options.auth.verifyLogin({ ...request.body, requestId: request.id });
      const cookieBase = {
        path: '/',
        secure: options.secureCookies,
        sameSite: 'lax' as const,
        expires: new Date(result.expiresAt),
      };
      reply.setCookie('rc_session', result.sessionToken, { ...cookieBase, httpOnly: true });
      reply.setCookie('rc_csrf', result.csrfToken, { ...cookieBase, httpOnly: false });
      return {
        expiresAt: result.expiresAt,
        isFirstLogin: result.isFirstLogin,
        account: {
          id: result.account.id,
          displayName: result.account.displayName ?? undefined,
          avatarId: result.account.avatarId,
          status: result.account.status,
          themeId: result.account.themeId,
          roles: [...result.account.roles],
        },
      };
    },
  );

  app.post<{ Body: Registration }>(
    '/api/v1/auth/register',
    { schema: { body: RegistrationSchema } },
    async (request, reply) => {
      requirePublicOrigin(options, request);
      const result = await options.auth.verifyRegistration(request.body);
      return reply.code(201).send(result);
    },
  );

  app.post('/api/v1/auth/logout', async (request, reply) => {
    await authenticateAuthRoute(options, request, true);
    await options.auth.logout(sessionToken(request));
    reply.clearCookie('rc_session', { path: '/' });
    reply.clearCookie('rc_csrf', { path: '/' });
    return { loggedOut: true };
  });

  app.post<{ Body: PhoneChange }>(
    '/api/v1/auth/change-phone',
    { schema: { body: PhoneChangeSchema } },
    async (request, reply) => {
      const actor = await authenticateAuthRoute(options, request, true);
      await options.auth.changePhone({
        accountId: actor.accountId,
        actorRoles: [...actor.roles],
        requestId: request.id,
        ...request.body,
      });
      reply.clearCookie('rc_session', { path: '/' });
      reply.clearCookie('rc_csrf', { path: '/' });
      return { changed: true, reauthenticationRequired: true };
    },
  );
};
