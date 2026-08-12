import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/shared/config";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

describe("production configuration", () => {
  it("validates explicit application base paths", () => {
    const base = {
      ...original,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://invalid",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "x".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
    };
    process.env = { ...base, APP_BASE_PATH: "/custom-app" };
    expect(loadConfig().appBasePath).toBe("/custom-app");

    process.env = { ...base, APP_BASE_PATH: "/custom-app/" };
    expect(() => loadConfig()).toThrow("APP_BASE_PATH");

    process.env = { ...base, APP_BASE_PATH: "/../admin" };
    expect(() => loadConfig()).toThrow("APP_BASE_PATH");
  });

  it("rejects a PUBLIC_ORIGIN path and non-HTTPS production origin", () => {
    const base = {
      ...original,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://invalid",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "x".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
    };
    process.env = { ...base, PUBLIC_ORIGIN: "https://www.googcci.com.cn/revenue-costs" };
    expect(() => loadConfig()).toThrow("PUBLIC_ORIGIN");

    process.env = { ...base, NODE_ENV: "production", PUBLIC_ORIGIN: "http://www.googcci.com.cn" };
    expect(() => loadConfig()).toThrow("PUBLIC_ORIGIN");
  });

  it("resolves an explicit database capacity path for host-level free-space checks", () => {
    process.env = {
      ...original,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://invalid",
      DATABASE_CAPACITY_PATH: ".work/database-volume",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "x".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
    };
    expect(loadConfig().databaseCapacityPath).toBe(`${process.cwd()}\\.work\\database-volume`);
  });

  it("uses the documented fixed OTP for a local sandbox and accepts an E.164 registration administrator", () => {
    process.env = {
      ...original,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://invalid",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "x".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
      SMS_PROVIDER: "sandbox",
      SANDBOX_OTP_CODE: "",
      REGISTRATION_ADMIN_PHONE: "+8613800000000",
    };
    expect(loadConfig()).toMatchObject({
      sandboxOtpCode: "246810",
      registrationAdminPhoneE164: "+8613800000000",
    });
  });

  it("rejects fixed OTP and registration administrator configuration in production", () => {
    process.env = {
      ...original,
      NODE_ENV: "production",
      DATABASE_URL: "postgres://invalid",
      PUBLIC_ORIGIN: "https://revenue.example.test",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "x".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
      EXPORT_OUTPUT_ROOT: ".work/exports",
      PAYMENT_PROVIDER: "configured-payment",
      SMS_PROVIDER: "configured-sms",
      SANDBOX_OTP_CODE: "246810",
    };
    expect(() => loadConfig()).toThrow("生产环境禁止固定验证码和注册即授予管理员");
  });

  it("accepts explicit public registration in temporary production mode without external integrations", () => {
    process.env = {
      ...original,
      NODE_ENV: "production",
      DATABASE_URL: "postgres://invalid",
      DATABASE_CAPACITY_PATH: ".work/postgres-data",
      PUBLIC_ORIGIN: "https://www.googcci.com.cn",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "y".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
      EXPORT_OUTPUT_ROOT: ".work/exports",
      TEMPORARY_DEGRADED_PRODUCTION: "true",
      TEMPORARY_PUBLIC_REGISTRATION: "true",
      SMS_PROVIDER: "temporary-admin-fixed",
      TEMPORARY_ADMIN_OTP_CODE: "246810",
      REGISTRATION_ADMIN_PHONE: "+8613800000000",
      PAYMENT_PROVIDER: "temporary-manual",
      CHINAMONEY_ENABLED: "false",
      STORAGE_POLICY: "LOCAL_VERIFIED",
      STORAGE_REPLICA_ROOT: "",
      REMOTE_BACKUP_TARGET: "",
    };

    expect(loadConfig()).toMatchObject({
      mode: "production",
      appBasePath: "/revenue-costs",
      temporaryDegradedProduction: true,
      temporaryPublicRegistration: true,
      temporaryAdminOtpCode: "246810",
      registrationAdminPhoneE164: "+8613800000000",
      smsProvider: "temporary-admin-fixed",
      paymentProvider: "temporary-manual",
      chinaMoneyEnabled: false,
      storagePolicy: "LOCAL_VERIFIED",
    });
  });

  it("rejects the sandbox payment adapter in temporary production mode", () => {
    process.env = {
      ...original,
      NODE_ENV: "production",
      DATABASE_URL: "postgres://invalid",
      DATABASE_CAPACITY_PATH: ".work/postgres-data",
      PUBLIC_ORIGIN: "https://www.googcci.com.cn",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "y".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
      EXPORT_OUTPUT_ROOT: ".work/exports",
      TEMPORARY_DEGRADED_PRODUCTION: "true",
      SMS_PROVIDER: "temporary-admin-fixed",
      TEMPORARY_ADMIN_OTP_CODE: "246810",
      REGISTRATION_ADMIN_PHONE: "+8613800000000",
      PAYMENT_PROVIDER: "sandbox",
      CHINAMONEY_ENABLED: "false",
      STORAGE_POLICY: "LOCAL_VERIFIED",
    };

    expect(() => loadConfig()).toThrow("临时生产模式必须使用受限固定验证码");
  });

  it("rejects temporary public registration outside temporary production mode", () => {
    process.env = {
      ...original,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://invalid",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "y".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
      TEMPORARY_PUBLIC_REGISTRATION: "true",
    };

    expect(() => loadConfig()).toThrow("TEMPORARY_PUBLIC_REGISTRATION 只允许用于临时 production 模式");
  });

  it("rejects the controlled recharge adapter outside temporary production mode", () => {
    process.env = {
      ...original,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://invalid",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "y".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
      PAYMENT_PROVIDER: "temporary-manual",
    };

    expect(() => loadConfig()).toThrow("PAYMENT_PROVIDER=temporary-manual 只允许用于临时 production 模式");
  });

  it("fails closed while sandbox providers are active", () => {
    process.env = {
      ...original,
      NODE_ENV: "production",
      DATABASE_URL: "postgres://invalid",
      PUBLIC_ORIGIN: "https://revenue.example.test",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "x".repeat(32),
      FILE_KEK_BASE64: "eA==",
      PAYMENT_PROVIDER: "sandbox",
      SMS_PROVIDER: "sandbox",
    };
    expect(() => loadConfig()).toThrow("生产外部配置不完整");
  });

  it("fails closed when ChinaMoney is enabled without a complete pageable source", () => {
    process.env = {
      ...original,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://invalid",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "x".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
      CHINAMONEY_ENABLED: "true",
      CHINAMONEY_HISTORY_START: "2026-02-30",
      CHINAMONEY_ENDPOINT_TEMPLATE: "https://example.test/quotes?from={from}",
    };
    expect(() => loadConfig()).toThrow("ChinaMoney 全量同步起始日期未配置或格式无效");
    process.env.CHINAMONEY_HISTORY_START = "2006-01-04";
    expect(() => loadConfig()).toThrow("ChinaMoney 端点缺少分页占位符");
  });

  it("allows an explicit local fixture outside production", () => {
    process.env = {
      ...original,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://invalid",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "x".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
      CHINAMONEY_ENABLED: "true",
      CHINAMONEY_HISTORY_START: "2006-01-04",
      CHINAMONEY_FIXTURE_PATH: "tests/fixtures/fx/chinamoney-sample.json",
    };
    const config = loadConfig();
    expect(config.chinaMoneyEnabled).toBe(true);
    expect(config.chinaMoneyFixturePath).toMatch(/chinamoney-sample\.json$/u);
  });

  it("allows the official XLSX source without a JSON endpoint outside production", () => {
    process.env = {
      ...original,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://invalid",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "x".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
      CHINAMONEY_ENABLED: "true",
      CHINAMONEY_HISTORY_START: "2006-01-04",
      CHINAMONEY_ENDPOINT_TEMPLATE: "",
      CHINAMONEY_FIXTURE_PATH: "",
    };
    expect(loadConfig()).toMatchObject({
      chinaMoneyEnabled: true,
      chinaMoneyEndpointTemplate: undefined,
      chinaMoneyFixturePath: undefined,
    });
  });

  it("rejects fixture mode in production even when all other stop conditions are configured", () => {
    process.env = {
      ...original,
      NODE_ENV: "production",
      DATABASE_URL: "postgres://invalid",
      PUBLIC_ORIGIN: "https://revenue.example.test",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "x".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
      PAYMENT_PROVIDER: "configured-payment",
      SMS_PROVIDER: "configured-sms",
      STORAGE_POLICY: "REMOTE_REQUIRED",
      STORAGE_REPLICA_ROOT: ".work/storage/replica",
      REMOTE_BACKUP_TARGET: "configured-remote-target",
      CHINAMONEY_ENABLED: "true",
      CHINAMONEY_HISTORY_START: "2006-01-04",
      CHINAMONEY_ENDPOINT_TEMPLATE: "https://www.chinamoney.com.cn/quotes?from={from}&to={to}&page={page}&size={pageSize}",
      CHINAMONEY_AUTHORIZATION_REFERENCE: "ops-record-1",
      CHINAMONEY_FIXTURE_PATH: "tests/fixtures/fx/chinamoney-sample.json",
    };
    expect(() => loadConfig()).toThrow("ChinaMoney 生产端点、授权留档或运行模式未就绪");
  });

  it("accepts production only with official pageable ChinaMoney and all external stop conditions", () => {
    process.env = {
      ...original,
      NODE_ENV: "production",
      DATABASE_URL: "postgres://invalid",
      DATABASE_CAPACITY_PATH: ".work/postgres-data",
      PUBLIC_ORIGIN: "https://revenue.example.test",
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "x".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
      EXPORT_OUTPUT_ROOT: ".work/exports",
      PAYMENT_PROVIDER: "configured-payment",
      SMS_PROVIDER: "configured-sms",
      STORAGE_POLICY: "REMOTE_REQUIRED",
      STORAGE_REPLICA_ROOT: ".work/storage/replica",
      REMOTE_BACKUP_TARGET: "configured-remote-target",
      CHINAMONEY_ENABLED: "true",
      CHINAMONEY_HISTORY_START: "2006-01-04",
      CHINAMONEY_ENDPOINT_TEMPLATE: "https://www.chinamoney.com.cn/quotes?from={from}&to={to}&page={page}&size={pageSize}",
      CHINAMONEY_AUTHORIZATION_REFERENCE: "ops-record-1",
    };
    expect(loadConfig()).toMatchObject({
      mode: "production",
      appBasePath: "/revenue-costs",
      chinaMoneyEnabled: true,
      chinaMoneyHistoryStart: "2006-01-04",
      storagePolicy: "REMOTE_REQUIRED",
    });
  });
});
