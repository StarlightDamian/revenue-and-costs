import { describe, expect, it, vi } from "vitest";
import type { SqlClient, TransactionRunner } from "../../src/modules/authorization/index.js";
import { PostgresAuthRepository } from "../../src/modules/auth/postgres.js";

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

function artifactInvalidator() {
  return { invalidateForMembership: vi.fn(async () => undefined) };
}

describe("Postgres auth audit persistence", () => {
  it("bootstraps the first administrator without using a deferrable unique constraint as ON CONFLICT arbiter", async () => {
    const accountId = "10000000-0000-4000-8000-000000000001";
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM identity_bootstrap") && sql.includes("FOR UPDATE")) {
        return { rows: [{ completed_at: null }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO account ")) {
        return { rows: [{
          id: accountId,
          phone_e164: "+8619000000001",
          display_name: null,
          registered_at: null,
          avatar_id: 1,
          status: "ACTIVE",
          theme_id: "comfort",
          session_generation: "0",
        }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO account_role") && sql.includes("ON CONFLICT")) {
        throw new Error("ON CONFLICT does not support deferrable unique constraints/exclusion constraints as arbiters");
      }
      if (sql.includes("SELECT role FROM account_role") && sql.includes("FOR UPDATE")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO account_role")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE identity_bootstrap")) return { rows: [], rowCount: 1 };
      if (sql.includes("SELECT role FROM account_role")) return { rows: [{ role: "ADMIN" }], rowCount: 1 };
      if (sql.includes("FROM enterprise_member")) return { rows: [], rowCount: 0 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query } as unknown as SqlClient;
    const transactions = new RecordingTransactionRunner(client);
    const repository = new PostgresAuthRepository(transactions, client, artifactInvalidator());

    await expect(repository.bootstrapAdministrator("+8619000000001", new Date("2026-08-06T00:00:00.000Z")))
      .resolves.toMatchObject({ id: accountId, roles: new Set(["ADMIN"]) });
    expect(transactions).toMatchObject({ commits: 1, rollbacks: 0 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("phone_verified_at, registered_at"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO account_role") && String(sql).includes("ON CONFLICT"))).toBe(false);
  });

  it("keeps session creation and successful-login audit in one transaction", async () => {
    const accountId = "10000000-0000-4000-8000-000000000001";
    const auditParameters: unknown[][] = [];
    let failAudit = false;
    const query = vi.fn(async (sql: string, parameters: readonly unknown[] = []) => {
      if (sql.includes("UPDATE account") && sql.includes("successful_login_count")) {
        return { rows: [{ login_sequence: "1" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO auth_session")) {
        return { rows: [{ id: "20000000-0000-4000-8000-000000000002" }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO audit_event")) {
        auditParameters.push([...parameters]);
        if (failAudit) throw new Error("audit unavailable");
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query } as unknown as SqlClient;
    const transactions = new RecordingTransactionRunner(client);
    const repository = new PostgresAuthRepository(transactions, client, artifactInvalidator());
    const input = {
      accountId,
      tokenDigest: Buffer.alloc(32, 1),
      csrfDigest: Buffer.alloc(32, 2),
      accountGeneration: "3",
      expiresAt: new Date("2026-08-04T00:00:00.000Z"),
      actorRoles: ["ACCOUNTANT"] as const,
      requestId: "login-audit-request",
    };

    await expect(repository.createSessionWithLoginAudit(input)).resolves.toEqual({ sessionId: "20000000-0000-4000-8000-000000000002", loginSequence: "1" });
    expect(transactions).toMatchObject({ commits: 1, rollbacks: 0 });
    expect(auditParameters[0]?.[0]).toBe(accountId);
    expect(JSON.parse(String(auditParameters[0]?.[1]))).toEqual({
      actorRoles: ["ACCOUNTANT"],
      result: "SUCCEEDED",
      requestId: "login-audit-request",
      before: null,
      after: { sessionCreated: true, loginSequence: "1" },
    });
    expect(JSON.stringify(auditParameters)).not.toContain(Buffer.from(input.tokenDigest).toString("hex"));
    expect(JSON.stringify(auditParameters)).not.toContain(Buffer.from(input.csrfDigest).toString("hex"));

    await expect(repository.createSessionWithLoginAudit({ ...input, requestId: "registration-session" }, client))
      .resolves.toEqual({ sessionId: "20000000-0000-4000-8000-000000000002", loginSequence: "1" });
    expect(transactions).toMatchObject({ commits: 1, rollbacks: 0 });
    expect(JSON.parse(String(auditParameters.at(-1)?.[1]))).toMatchObject({ requestId: "registration-session" });

    failAudit = true;
    await expect(repository.createSessionWithLoginAudit({ ...input, requestId: "failed-audit-request" }))
      .rejects.toThrow("audit unavailable");
    expect(transactions).toMatchObject({ commits: 1, rollbacks: 1 });
  });

  it("keeps phone-change audit and pending-membership artifact invalidation in one transaction", async () => {
    const accountId = "10000000-0000-4000-8000-000000000001";
    const oldChallengeId = "30000000-0000-4000-8000-000000000003";
    const newChallengeId = "40000000-0000-4000-8000-000000000004";
    const oldPhone = "+8613800000000";
    const newPhone = "+8613900000000";
    const shopId = "50000000-0000-4000-8000-000000000005";
    const invitationId = "60000000-0000-4000-8000-000000000006";
    const membershipId = "70000000-0000-4000-8000-000000000007";
    const sqlCalls: Array<{ sql: string; parameters: readonly unknown[] }> = [];
    const query = vi.fn(async (sql: string, parameters: readonly unknown[] = []) => {
      sqlCalls.push({ sql, parameters });
      if (sql.startsWith("SELECT phone_e164, session_generation")) {
        return { rows: [{ phone_e164: oldPhone, session_generation: "7" }], rowCount: 1 };
      }
      if (sql.includes("FROM otp_challenge")) {
        return { rows: [
          {
            id: oldChallengeId,
            phone_e164: oldPhone,
            purpose: "PHONE_CHANGE_OLD",
            consumed_at: new Date("2026-07-28T00:00:00.000Z"),
            expires_at: new Date("2026-07-28T00:05:00.000Z"),
          },
          {
            id: newChallengeId,
            phone_e164: newPhone,
            purpose: "PHONE_CHANGE_NEW",
            consumed_at: new Date("2026-07-28T00:00:00.000Z"),
            expires_at: new Date("2026-07-28T00:05:00.000Z"),
          },
        ], rowCount: 2 };
      }
      if (sql.includes("UPDATE enterprise_member pending") && sql.includes("FROM enterprise_member active")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("UPDATE enterprise_member SET phone_e164")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE account") && sql.includes("RETURNING *")) {
        return { rows: [{
          id: accountId, phone_e164: newPhone, display_name: null, registered_at: new Date("2026-07-01T00:00:00.000Z"),
          avatar_id: 1, status: "ACTIVE", theme_id: "comfort", session_generation: "8",
        }], rowCount: 1 };
      }
      if (sql.includes("UPDATE enterprise_member") && sql.includes("RETURNING id, enterprise_id")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM shop_invitation") && sql.includes("ORDER BY created_at")) {
        return { rows: [{
          id: invitationId,
          shop_id: shopId,
          export_allowed: true,
          invited_by: "80000000-0000-4000-8000-000000000008",
        }], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO shop_membership")) {
        return { rows: [{
          id: membershipId,
          shop_id: shopId,
          account_id: accountId,
          status: "ACTIVE",
          export_allowed: true,
          authorization_epoch: "5",
        }], rowCount: 1 };
      }
      if (sql.includes("UPDATE shop_invitation SET status='ACTIVE'")) return { rows: [], rowCount: 1 };
      if (sql.includes("UPDATE auth_session")) return { rows: [], rowCount: 2 };
      if (sql.includes("INSERT INTO phone_change_request")) return { rows: [], rowCount: 1 };
      if (sql.includes("INSERT INTO audit_event")) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query } as unknown as SqlClient;
    const transactions = new RecordingTransactionRunner(client);
    const invalidator = artifactInvalidator();
    const repository = new PostgresAuthRepository(transactions, client, invalidator);

    await repository.completePhoneChange({
      accountId,
      oldChallengeId,
      newChallengeId,
      newPhoneE164: newPhone,
      now: new Date("2026-07-28T00:00:00.000Z"),
      actorRoles: ["ACCOUNTANT"],
      requestId: "phone-change-audit-request",
    });

    expect(transactions).toMatchObject({ commits: 1, rollbacks: 0 });
    const requestIndex = sqlCalls.findIndex(({ sql }) => sql.includes("INSERT INTO phone_change_request"));
    const auditIndex = sqlCalls.findIndex(({ sql }) => sql.includes("ACCOUNT_PHONE_CHANGED"));
    expect(requestIndex).toBeGreaterThan(-1);
    expect(auditIndex).toBeGreaterThan(requestIndex);
    expect(sqlCalls.some(({ sql }) => sql.includes("UPDATE enterprise_member SET phone_e164"))).toBe(true);
    const membershipMergeQueries = sqlCalls.filter(({ sql }) =>
      sql.includes("UPDATE enterprise_member pending") && sql.includes("FROM enterprise_member active"));
    expect(membershipMergeQueries).toHaveLength(2);
    expect(membershipMergeQueries.every(({ sql }) =>
      sql.includes("authorization_epoch=pending.authorization_epoch+1"))).toBe(true);
    expect(invalidator.invalidateForMembership).toHaveBeenCalledWith(client, membershipId, "5");
    const audit = sqlCalls[auditIndex]!;
    expect(audit.parameters[0]).toBe(accountId);
    expect(JSON.parse(String(audit.parameters[1]))).toEqual({
      actorRoles: ["ACCOUNTANT"],
      result: "SUCCEEDED",
      requestId: "phone-change-audit-request",
      before: { sessionGeneration: "7" },
      after: { sessionGeneration: "8", sessionsRevoked: true },
    });
    expect(JSON.stringify(audit.parameters)).not.toContain(oldPhone);
    expect(JSON.stringify(audit.parameters)).not.toContain(newPhone);
    expect(JSON.stringify(audit.parameters)).not.toContain(oldChallengeId);
    expect(JSON.stringify(audit.parameters)).not.toContain(newChallengeId);
  });

  it("rejects consumed phone-change proofs after their OTP expiry", async () => {
    const accountId = "10000000-0000-4000-8000-000000000001";
    const oldChallengeId = "30000000-0000-4000-8000-000000000003";
    const newChallengeId = "40000000-0000-4000-8000-000000000004";
    const oldPhone = "+8613800000000";
    const newPhone = "+8613900000000";
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT phone_e164, session_generation")) {
        return { rows: [{ phone_e164: oldPhone, session_generation: "7" }], rowCount: 1 };
      }
      if (sql.includes("FROM otp_challenge")) {
        return {
          rows: [
            {
              id: oldChallengeId,
              phone_e164: oldPhone,
              purpose: "PHONE_CHANGE_OLD",
              consumed_at: new Date("2026-07-27T23:55:00.000Z"),
              expires_at: new Date("2026-07-28T00:00:00.000Z"),
            },
            {
              id: newChallengeId,
              phone_e164: newPhone,
              purpose: "PHONE_CHANGE_NEW",
              consumed_at: new Date("2026-07-27T23:56:00.000Z"),
              expires_at: new Date("2026-07-28T00:01:00.000Z"),
            },
          ],
          rowCount: 2,
        };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query } as unknown as SqlClient;
    const transactions = new RecordingTransactionRunner(client);
    const repository = new PostgresAuthRepository(transactions, client, artifactInvalidator());

    await expect(repository.completePhoneChange({
      accountId,
      oldChallengeId,
      newChallengeId,
      newPhoneE164: newPhone,
      now: new Date("2026-07-28T00:02:00.000Z"),
      actorRoles: ["ACCOUNTANT"],
      requestId: "expired-phone-change",
    })).rejects.toMatchObject({ code: "PHONE_CHANGE_VERIFICATION_REQUIRED", statusCode: 400 });

    expect(transactions).toMatchObject({ commits: 0, rollbacks: 1 });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE account"))).toBe(false);
  });
});
