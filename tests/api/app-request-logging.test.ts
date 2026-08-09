import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/api/app.js";
import type { AppConfig } from "../../src/shared/config.js";
import { AppError } from "../../src/shared/errors.js";

const config: AppConfig = {
  mode: "test",
  host: "127.0.0.1",
  port: 3000,
  databaseUrl: "postgresql://diagnostic.invalid/test",
  publicOrigin: "https://app.example.test",
  otpHmacKey: "otp-test-key-32-bytes-minimum-value",
  sessionHmacKey: "session-test-key-32-bytes-minimum",
  paymentProvider: "sandbox",
  smsProvider: "sandbox",
  sandboxOtpCode: "246810",
  chinaMoneyEnabled: false,
  chinaMoneyEndpointTemplate: undefined,
  chinaMoneyAuthorizationReference: undefined,
  chinaMoneyFixturePath: undefined,
  chinaMoneyHistoryStart: undefined,
  storageRoot: resolve(".work/test-request-logging-storage"),
  storageReplicaRoot: undefined,
  storagePolicy: "LOCAL_VERIFIED",
  fileKekBase64: Buffer.alloc(32, 7).toString("base64"),
  remoteBackupTarget: undefined,
};

function eventRecords(logLines: readonly string[]): Array<Record<string, unknown>> {
  return logLines
    .flatMap((line) => line.trim().split(/\r?\n/u))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.event === "http_request_completed");
}

describe("API request logging boundary", () => {
  it("installs the safe error handler before encapsulated auth routes", async () => {
    const logLines: string[] = [];
    const app = await createApp({
      config,
      pool: {} as Pool,
      logStream: { write: (message) => { logLines.push(message); } },
    });
    const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/otp?search=private-query-sentinel",
      headers: {
        origin: "https://wrong-origin.example.test",
        "x-request-id": requestId,
        authorization: "Bearer private-token-sentinel",
        cookie: "rc_session=private-cookie-sentinel",
      },
      payload: { phone: "+8613800000000", purpose: "LOGIN", deviceId: "synthetic-device" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "ORIGIN_INVALID", requestId });
    await app.close();

    const records = eventRecords(logLines);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      event: "http_request_completed",
      service: "api",
      requestId,
      method: "POST",
      route: "/api/v1/auth/otp",
      statusCode: 403,
      outcome: "REJECTED",
      errorCode: "ORIGIN_INVALID",
    });
    const serialized = JSON.stringify(records);
    for (const secret of ["private-query-sentinel", "private-token-sentinel", "private-cookie-sentinel", "+8613800000000", "synthetic-device"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("isolates terminal errors when concurrent requests reuse a valid request ID", async () => {
    const logLines: string[] = [];
    const app = await createApp({
      config,
      pool: {} as Pool,
      logStream: { write: (message) => { logLines.push(message); } },
    });
    app.addHook("onSend", async (request) => {
      if (request.routeOptions.url === "/test/log-race-a") await delay(50);
    });
    app.get("/test/log-race-a", async () => {
      throw new AppError("RACE_A", "first", 409);
    });
    app.get("/test/log-race-b", async () => {
      throw new AppError("RACE_B", "second", 409);
    });
    const requestId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    const first = app.inject({ method: "GET", url: "/test/log-race-a", headers: { "x-request-id": requestId } });
    await delay(5);
    const second = app.inject({ method: "GET", url: "/test/log-race-b", headers: { "x-request-id": requestId } });
    await Promise.all([first, second]);
    await app.close();

    const records = eventRecords(logLines);
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.route === "/test/log-race-a")).toMatchObject({ errorCode: "RACE_A" });
    expect(records.find((record) => record.route === "/test/log-race-b")).toMatchObject({ errorCode: "RACE_B" });
  });

  it("writes exactly one terminal event when the client closes before the response", async () => {
    const logLines: string[] = [];
    const app = await createApp({
      config,
      pool: {} as Pool,
      logStream: { write: (message) => { logLines.push(message); } },
    });
    let markEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolveEntered) => { markEntered = resolveEntered; });
    app.get("/test/client-abort", async () => {
      markEntered?.();
      await delay(100);
      return { ok: true };
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("test listener address unavailable");

    const closed = new Promise<void>((resolveClosed) => {
      const outgoing = httpRequest({ host: "127.0.0.1", port: address.port, path: "/test/client-abort", method: "GET" });
      outgoing.on("error", () => undefined);
      outgoing.on("close", resolveClosed);
      outgoing.end();
      void entered.then(() => outgoing.destroy());
    });
    await closed;
    await delay(150);
    await app.close();

    const records = eventRecords(logLines).filter((record) => record.route === "/test/client-abort");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      statusCode: 499,
      outcome: "ABORTED",
      errorCode: "CLIENT_ABORTED",
    });
  });
});
