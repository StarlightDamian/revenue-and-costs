import { describe, expect, it, vi } from "vitest";
import type {
  Actor,
  AuditRecord,
  SqlClient,
  TransactionRunner,
  TransactionSideEffects,
} from "../../src/modules/authorization/index.js";
import { MembershipService } from "../../src/modules/memberships/service.js";
import type { MembershipArtifactInvalidator } from "../../src/modules/memberships/activation.js";

const owner: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
  enterpriseIds: new Set(["50000000-0000-4000-8000-000000000005"]),
};
const customer: Actor = {
  accountId: "20000000-0000-4000-8000-000000000002",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
};
const shopId = "30000000-0000-4000-8000-000000000003";
const oldInvitationId = "40000000-0000-4000-8000-000000000004";
const phone = "+8613800000000";

class RecordingTransactionRunner implements TransactionRunner {
  commits = 0;
  rollbacks = 0;

  constructor(private readonly client: SqlClient) {}

  async transaction<Result>(work: (client: SqlClient) => Promise<Result>): Promise<Result> {
    try {
      const result = await work(this.client);
      this.commits += 1;
      return result;
    } catch (error) {
      this.rollbacks += 1;
      throw error;
    }
  }
}

function sideEffects() {
  const audit = vi.fn(async (client: SqlClient, record: AuditRecord) => {
    void client;
    void record;
  });
  const effects: TransactionSideEffects = {
    audit,
    async outbox() {},
  };
  return { audit, effects };
}

const invalidator: MembershipArtifactInvalidator = {
  async invalidateForMembership() {},
};

describe("membership invitation expiration", () => {
  it("expires and audits the stale pending row before creating an idempotent replacement", async () => {
    const oldExpiresAt = new Date(Date.now() - 60_000);
    const invitations = [{
      id: oldInvitationId,
      shopId,
      phone,
      invitedBy: owner.accountId,
      exportAllowed: false,
      expiresAt: oldExpiresAt,
      idempotencyKey: "old-invitation-key",
      status: "PENDING",
    }];
    const sqlCalls: string[] = [];
    const query = vi.fn(async (sql: string, parameters: readonly unknown[] = []) => {
      sqlCalls.push(sql);
      if (sql.startsWith("SELECT id, enterprise_id, status FROM shop")) {
        return { rows: [{ id: shopId, enterprise_id: "50000000-0000-4000-8000-000000000005", status: "ACTIVE" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE shop_invitation") && sql.includes("shop_id = $1")) {
        const expired = invitations.filter((invitation) =>
          invitation.shopId === parameters[0]
          && invitation.phone === parameters[1]
          && invitation.status === "PENDING"
          && invitation.expiresAt.getTime() <= Date.now());
        for (const invitation of expired) invitation.status = "EXPIRED";
        return { rows: expired.map((invitation) => ({ id: invitation.id, expires_at: invitation.expiresAt })), rowCount: expired.length };
      }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("FROM shop_invitation WHERE invited_by")) {
        const existing = invitations.find((invitation) =>
          invitation.invitedBy === parameters[0] && invitation.idempotencyKey === parameters[1]);
        return {
          rows: existing ? [{
            id: existing.id,
            shop_id: existing.shopId,
            invited_phone_e164: existing.phone,
            status: existing.status,
            export_allowed: existing.exportAllowed,
            invited_by: existing.invitedBy,
            expires_at: existing.expiresAt,
          }] : [],
          rowCount: existing ? 1 : 0,
        };
      }
      if (sql.includes("INSERT INTO shop_invitation")) {
        if (invitations.some((invitation) =>
          invitation.shopId === parameters[1]
          && invitation.phone === parameters[2]
          && invitation.status === "PENDING")) {
          throw new Error("shop_invitation_pending_phone_uq");
        }
        invitations.push({
          id: String(parameters[0]),
          shopId: String(parameters[1]),
          phone: String(parameters[2]),
          invitedBy: String(parameters[5]),
          exportAllowed: Boolean(parameters[4]),
          expiresAt: parameters[6] as Date,
          idempotencyKey: String(parameters[7]),
          status: "PENDING",
        });
        return { rows: [{ id: parameters[0] }], rowCount: 1 };
      }
      if (sql.includes("FROM account a") && sql.includes("a.phone_e164")) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query } as unknown as SqlClient;
    const transactions = new RecordingTransactionRunner(client);
    const { audit, effects } = sideEffects();
    const service = new MembershipService(transactions, client, effects, Buffer.from("invitation-secret"), invalidator);

    const input = {
      actor: owner,
      shopId,
      phone,
      requestId: "request-reinvite",
      idempotencyKey: "replacement-invitation-key",
    };
    const created = await service.invite(input);
    const repeated = await service.invite(input);

    expect(invitations.find(({ id }) => id === oldInvitationId)?.status).toBe("EXPIRED");
    expect(created.invitationId).not.toBe(oldInvitationId);
    expect(repeated).toEqual(created);
    expect(transactions).toMatchObject({ commits: 2, rollbacks: 0 });
    expect(audit.mock.calls.map(([, record]) => record.action)).toEqual([
      "CUSTOMER_INVITATION_EXPIRED",
      "CUSTOMER_INVITED",
    ]);
    expect(audit.mock.calls[0]?.[1]).toMatchObject({
      actorAccountId: null,
      objectId: oldInvitationId,
      before: { status: "PENDING", expiresAt: oldExpiresAt.toISOString() },
      after: { status: "EXPIRED" },
    });
    expect(sqlCalls.findIndex((sql) => sql.includes("UPDATE shop_invitation")))
      .toBeLessThan(sqlCalls.findIndex((sql) => sql.includes("INSERT INTO shop_invitation")));
  });

  it("commits expiration and its audit before reporting an expired token as invalid", async () => {
    const expiresAt = new Date(Date.now() - 60_000);
    let status = "PENDING";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT i.*, a.phone_e164 AS account_phone")) {
        return { rows: [{
          id: oldInvitationId,
          shop_id: shopId,
          invited_phone_e164: phone,
          status,
          export_allowed: false,
          invited_by: owner.accountId,
          expires_at: expiresAt,
          account_phone: "+8613900000000",
        }], rowCount: 1 };
      }
      if (sql.includes("UPDATE shop_invitation SET status = 'EXPIRED'")) {
        status = "EXPIRED";
        return { rows: [{ id: oldInvitationId, expires_at: expiresAt }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query } as unknown as SqlClient;
    const transactions = new RecordingTransactionRunner(client);
    const { audit, effects } = sideEffects();
    const service = new MembershipService(transactions, client, effects, Buffer.from("invitation-secret"), invalidator);

    await expect(service.accept({ actor: customer, token: "expired-token", requestId: "request-expired-accept" }))
      .rejects.toMatchObject({ code: "INVITATION_INVALID", statusCode: 400 });

    expect(status).toBe("EXPIRED");
    expect(transactions).toMatchObject({ commits: 1, rollbacks: 0 });
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]?.[1]).toMatchObject({
      action: "CUSTOMER_INVITATION_EXPIRED",
      actorAccountId: null,
      objectId: oldInvitationId,
    });
  });
});

describe("membership authorization and idempotency", () => {
  it("invalidates artifacts when accepting a new invitation rotates an existing membership epoch", async () => {
    const membershipId = "60000000-0000-4000-8000-000000000006";
    const expiresAt = new Date(Date.now() + 60_000);
    const operations: string[] = [];
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT i.*, a.phone_e164 AS account_phone")) {
        return {
          rows: [{
            id: oldInvitationId,
            shop_id: shopId,
            invited_phone_e164: phone,
            status: "PENDING",
            export_allowed: true,
            invited_by: owner.accountId,
            expires_at: expiresAt,
            account_phone: phone,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("SELECT id, authorization_epoch::text")) {
        return { rows: [{ id: membershipId, authorization_epoch: "4" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO shop_membership")) {
        return {
          rows: [{
            id: membershipId,
            shop_id: shopId,
            account_id: customer.accountId,
            status: "ACTIVE",
            export_allowed: true,
            authorization_epoch: "5",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("UPDATE shop_invitation SET status = 'ACTIVE'")) {
        operations.push("invitation");
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query } as unknown as SqlClient;
    const transactions = new RecordingTransactionRunner(client);
    const { audit, effects } = sideEffects();
    const invalidateForMembership = vi.fn(async () => {
      operations.push("invalidate");
    });
    const service = new MembershipService(
      transactions,
      client,
      effects,
      Buffer.from("invitation-secret"),
      { invalidateForMembership },
    );

    await expect(service.accept({
      actor: customer,
      token: "replacement-token",
      requestId: "request-replacement-accept",
    })).resolves.toMatchObject({
      id: membershipId,
      status: "ACTIVE",
      exportAllowed: true,
      authorizationEpoch: "5",
    });

    expect(invalidateForMembership).toHaveBeenCalledWith(client, membershipId, "5");
    expect(operations).toEqual(["invalidate", "invitation"]);
    expect(audit.mock.calls[0]?.[1]).toMatchObject({ action: "CUSTOMER_INVITATION_ACCEPTED" });
    expect(transactions).toMatchObject({ commits: 1, rollbacks: 0 });
  });

  it("reauthorizes export-permission and revoke replays before returning stored responses", async () => {
    const formerAdmin: Actor = {
      accountId: "50000000-0000-4000-8000-000000000005",
      status: "ACTIVE",
      roles: new Set(),
    };

    for (const operation of ["export", "revoke"] as const) {
      const query = vi.fn(async (sql: string) => {
        if (sql === "SELECT shop_id FROM shop_membership WHERE id = $1") {
          return { rows: [{ shop_id: shopId }], rowCount: 1 };
        }
        if (sql.includes("FROM shop WHERE")) {
          return { rows: [{ id: shopId, enterprise_id: "50000000-0000-4000-8000-000000000005", status: "ACTIVE" }], rowCount: 1 };
        }
        if (sql.includes("FROM shop_membership") && sql.includes("FOR UPDATE")) {
          return {
            rows: [{
              id: "60000000-0000-4000-8000-000000000006",
              shop_id: shopId,
              account_id: customer.accountId,
              status: "ACTIVE",
              export_allowed: true,
              authorization_epoch: "4",
              enterprise_id: "50000000-0000-4000-8000-000000000005",
              shop_status: "ACTIVE",
            }],
            rowCount: 1,
          };
        }
        throw new Error(`IDEMPOTENCY_READ_BEFORE_AUTHORIZATION:${sql}`);
      });
      const client = { query } as unknown as SqlClient;
      const transactions = new RecordingTransactionRunner(client);
      const { effects } = sideEffects();
      const service = new MembershipService(
        transactions,
        client,
        effects,
        Buffer.from("invitation-secret"),
        invalidator,
      );
      const common = {
        actor: formerAdmin,
        membershipId: "60000000-0000-4000-8000-000000000006",
        reason: "replay authorization regression",
        requestId: `request-${operation}`,
        idempotencyKey: `idempotency-${operation}`,
      };

      const result = operation === "export"
        ? service.setExportAllowed({ ...common, allowed: false })
        : service.revoke(common);

      await expect(result).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND", statusCode: 404 });
      expect(query).toHaveBeenCalledTimes(3);
      expect(transactions).toMatchObject({ commits: 0, rollbacks: 1 });
    }
  });

  it("treats an unchanged export permission as a no-op without rotating the epoch", async () => {
    const membershipId = "60000000-0000-4000-8000-000000000006";
    const sqlCalls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      sqlCalls.push(sql);
      if (sql === "SELECT shop_id FROM shop_membership WHERE id = $1") {
        return { rows: [{ shop_id: shopId }], rowCount: 1 };
      }
      if (sql.includes("FROM shop WHERE")) {
        return { rows: [{ id: shopId, enterprise_id: "50000000-0000-4000-8000-000000000005", status: "ACTIVE" }], rowCount: 1 };
      }
      if (sql.includes("FROM shop_membership") && sql.includes("FOR UPDATE")) {
        return {
          rows: [{
            id: membershipId,
            shop_id: shopId,
            account_id: customer.accountId,
            status: "ACTIVE",
            export_allowed: true,
            authorization_epoch: "4",
            enterprise_id: "50000000-0000-4000-8000-000000000005",
            shop_status: "ACTIVE",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT request_hash, response_body")) return { rows: [], rowCount: 0 };
      if (sql.includes("INSERT INTO idempotency_record")) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query } as unknown as SqlClient;
    const transactions = new RecordingTransactionRunner(client);
    const { audit, effects } = sideEffects();
    const invalidateForMembership = vi.fn(async () => undefined);
    const service = new MembershipService(
      transactions,
      client,
      effects,
      Buffer.from("invitation-secret"),
      { invalidateForMembership },
    );

    await expect(service.setExportAllowed({
      actor: owner,
      membershipId,
      allowed: true,
      reason: "保持现有权限",
      requestId: "request-export-noop",
      idempotencyKey: "idempotency-export-noop",
    })).resolves.toEqual({
      id: membershipId,
      shopId,
      accountId: customer.accountId,
      status: "ACTIVE",
      exportAllowed: true,
      authorizationEpoch: "4",
    });

    expect(sqlCalls.some((sql) => sql.includes("UPDATE shop_membership"))).toBe(false);
    const shopLockIndex = sqlCalls.findIndex((sql) => sql.includes("FROM shop WHERE") && sql.includes("FOR UPDATE"));
    const membershipLockIndex = sqlCalls.findIndex((sql) => sql.includes("FROM shop_membership") && sql.includes("FOR UPDATE"));
    expect(shopLockIndex).toBeGreaterThanOrEqual(0);
    expect(shopLockIndex).toBeLessThan(membershipLockIndex);
    expect(invalidateForMembership).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(transactions).toMatchObject({ commits: 1, rollbacks: 0 });
  });
});
