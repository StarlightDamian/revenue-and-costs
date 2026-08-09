import { Type, type Static } from '@sinclair/typebox';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Actor } from '../../modules/authorization/index.js';
import type { EnterpriseService } from '../../modules/enterprises/index.js';
import { UuidSchema } from '../../shared/contracts.js';

const EnterpriseBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  unifiedSocialCreditCode: Type.String({ minLength: 18, maxLength: 18 }),
});
const EnterprisePatchBodySchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  unifiedSocialCreditCode: Type.Optional(Type.String({ minLength: 18, maxLength: 18 })),
}, { additionalProperties: false, minProperties: 1 });
const MemberBodySchema = Type.Object({
  phone: Type.String({ pattern: '^\\+[1-9][0-9]{7,14}$' }),
  displayName: Type.Optional(Type.String({ maxLength: 80 })),
});
const RemoveBodySchema = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 1000 }) });
type EnterpriseBody = Static<typeof EnterpriseBodySchema>;
type EnterprisePatchBody = Static<typeof EnterprisePatchBodySchema>;
type MemberBody = Static<typeof MemberBodySchema>;
type RemoveBody = Static<typeof RemoveBodySchema>;

export interface EnterpriseRouteOptions {
  readonly enterprises: EnterpriseService;
  authenticate(request: FastifyRequest, requireCsrf: boolean): Promise<Actor>;
}

export const enterpriseRoutes: FastifyPluginAsync<EnterpriseRouteOptions> = async (app, options) => {
  app.get('/api/v1/enterprises', async (request) => options.enterprises.list(await options.authenticate(request, false)));
  app.post<{ Body: EnterpriseBody }>('/api/v1/enterprises', { schema: { body: EnterpriseBodySchema } }, async (request, reply) => {
    const actor = await options.authenticate(request, true);
    return reply.code(201).send(await options.enterprises.create({ actor, ...request.body, requestId: request.id }));
  });
  app.patch<{ Params: { enterpriseId: string }; Body: EnterprisePatchBody }>(
    '/api/v1/enterprises/:enterpriseId',
    { schema: { params: Type.Object({ enterpriseId: UuidSchema }), body: EnterprisePatchBodySchema } },
    async (request, reply) => {
      const actor = await options.authenticate(request, true);
      await options.enterprises.updateProfile({ actor, enterpriseId: request.params.enterpriseId, ...request.body, requestId: request.id });
      return reply.code(204).send();
    },
  );
  app.get<{ Params: { enterpriseId: string } }>(
    '/api/v1/enterprises/:enterpriseId/members',
    { schema: { params: Type.Object({ enterpriseId: UuidSchema }) } },
    async (request) => options.enterprises.listMembers(await options.authenticate(request, false), request.params.enterpriseId),
  );
  app.post<{ Params: { enterpriseId: string }; Body: MemberBody }>(
    '/api/v1/enterprises/:enterpriseId/members',
    { schema: { params: Type.Object({ enterpriseId: UuidSchema }), body: MemberBodySchema } },
    async (request, reply) => {
      const actor = await options.authenticate(request, true);
      return reply.code(201).send(await options.enterprises.addMember({ actor, enterpriseId: request.params.enterpriseId, ...request.body, requestId: request.id }));
    },
  );
  app.delete<{ Params: { enterpriseId: string; memberId: string }; Body: RemoveBody }>(
    '/api/v1/enterprises/:enterpriseId/members/:memberId',
    { schema: { params: Type.Object({ enterpriseId: UuidSchema, memberId: UuidSchema }), body: RemoveBodySchema } },
    async (request, reply) => {
      const actor = await options.authenticate(request, true);
      await options.enterprises.removeMember({ actor, enterpriseId: request.params.enterpriseId, memberId: request.params.memberId, reason: request.body.reason, requestId: request.id });
      return reply.code(204).send();
    },
  );
};
