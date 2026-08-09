import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { authRoutes } from "../../src/api/routes/auth.js";
import type { Actor } from "../../src/modules/authorization/index.js";

const publicOrigin = "https://app.example.test";
const actor: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
};

async function createAuthApp() {
  const authenticate = vi.fn(async () => ({ actor, sessionId: "session-1" }));
  const logout = vi.fn(async () => undefined);
  const changePhone = vi.fn(async () => undefined);
  const verifyLogin = vi.fn(async () => ({
    expiresAt: "2026-08-04T00:00:00.000Z",
    sessionToken: "session-token",
    csrfToken: "csrf-token",
    account: {
      id: actor.accountId,
      displayName: "测试用户",
      avatarId: 1,
      status: "ACTIVE",
      themeId: "comfort",
      roles: actor.roles,
    },
  }));
  const app = Fastify({ requestIdHeader: "x-request-id" });
  await app.register(cookie);
  await app.register(authRoutes, {
    auth: { authenticate, logout, changePhone, verifyLogin } as never,
    publicOrigin,
    secureCookies: false,
  });
  return { app, authenticate, logout, changePhone, verifyLogin };
}

describe("auth route CSRF enforcement", () => {
  it.each([
    { url: "/api/v1/auth/logout", payload: undefined },
    {
      url: "/api/v1/auth/change-phone",
      payload: {
        oldChallengeId: "20000000-0000-4000-8000-000000000002",
        newChallengeId: "30000000-0000-4000-8000-000000000003",
        newPhone: "+8613900000000",
      },
    },
  ])("rejects an empty CSRF token on $url", async ({ url, payload }) => {
    const fixture = await createAuthApp();
    const response = await fixture.app.inject({
      method: "POST",
      url,
      headers: {
        cookie: "rc_session=session-token",
        origin: publicOrigin,
        "x-csrf-token": "",
      },
      ...(payload === undefined ? {} : { payload }),
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.authenticate).not.toHaveBeenCalled();
    expect(fixture.logout).not.toHaveBeenCalled();
    expect(fixture.changePhone).not.toHaveBeenCalled();
    await fixture.app.close();
  });

  it("passes Fastify request IDs to login and phone-change audit boundaries", async () => {
    const fixture = await createAuthApp();
    const login = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/auth/verify",
      headers: { origin: publicOrigin, "x-request-id": "login-request-id" },
      payload: {
        challengeId: "20000000-0000-4000-8000-000000000002",
        phone: "+8613800000000",
        purpose: "LOGIN",
        code: "246810",
      },
    });
    const changed = await fixture.app.inject({
      method: "POST",
      url: "/api/v1/auth/change-phone",
      headers: {
        cookie: "rc_session=session-token",
        origin: publicOrigin,
        "x-csrf-token": "csrf-token",
        "x-request-id": "phone-change-request-id",
      },
      payload: {
        oldChallengeId: "30000000-0000-4000-8000-000000000003",
        newChallengeId: "40000000-0000-4000-8000-000000000004",
        newPhone: "+8613900000000",
      },
    });

    expect(login.statusCode).toBe(200);
    expect(changed.statusCode).toBe(200);
    expect(fixture.verifyLogin).toHaveBeenCalledWith(expect.objectContaining({ requestId: "login-request-id" }));
    expect(fixture.changePhone).toHaveBeenCalledWith(expect.objectContaining({
      accountId: actor.accountId,
      actorRoles: ["ACCOUNTANT"],
      requestId: "phone-change-request-id",
    }));
    await fixture.app.close();
  });
});
