import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/shared/config";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

describe("production configuration", () => {
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
      OTP_HMAC_KEY: "x".repeat(32),
      SESSION_HMAC_KEY: "x".repeat(32),
      FILE_KEK_BASE64: Buffer.alloc(32, 1).toString("base64"),
      PAYMENT_PROVIDER: "configured-payment",
      SMS_PROVIDER: "configured-sms",
      SANDBOX_OTP_CODE: "246810",
    };
    expect(() => loadConfig()).toThrow("生产环境禁止固定验证码和注册即授予管理员");
  });

  it("fails closed while sandbox providers are active", () => {
    process.env = {
      ...original,
      NODE_ENV: "production",
      DATABASE_URL: "postgres://invalid",
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
    };
    expect(loadConfig()).toMatchObject({
      mode: "production",
      chinaMoneyEnabled: true,
      chinaMoneyHistoryStart: "2006-01-04",
      storagePolicy: "REMOTE_REQUIRED",
    });
  });
});
