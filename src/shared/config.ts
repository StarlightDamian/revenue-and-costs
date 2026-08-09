import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { resolve } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { AppError } from "./errors";

export type RuntimeMode = "development" | "test" | "production";
export type StoragePolicy = "LOCAL_VERIFIED" | "REMOTE_REQUIRED";

export interface AppConfig {
  mode: RuntimeMode;
  host: string;
  port: number;
  databaseUrl: string;
  databaseCapacityPath?: string;
  publicOrigin: string;
  otpHmacKey: string;
  sessionHmacKey: string;
  paymentProvider: string;
  smsProvider: string;
  sandboxOtpCode?: string;
  registrationAdminPhoneE164?: string;
  chinaMoneyEnabled: boolean;
  chinaMoneyEndpointTemplate: string | undefined;
  chinaMoneyAuthorizationReference: string | undefined;
  chinaMoneyFixturePath: string | undefined;
  chinaMoneyHistoryStart: string | undefined;
  storageRoot: string;
  storageReplicaRoot: string | undefined;
  storagePolicy: StoragePolicy;
  fileKekBase64: string;
  remoteBackupTarget: string | undefined;
}

function loadLocalEnv(): void {
  if (process.env.NODE_ENV === "production") return;
  const file = resolve(process.cwd(), ".env.local");
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(parsed)) process.env[key] ??= value;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new AppError("CONFIG_MISSING", `缺少配置 ${name}`, 500, name);
  return value;
}

function isIsoDate(value: string): boolean {
  try { return Temporal.PlainDate.from(value).toString() === value; } catch { return false; }
}

export function loadConfig(): AppConfig {
  loadLocalEnv();
  const mode = (process.env.NODE_ENV ?? "development") as RuntimeMode;
  if (!["development", "test", "production"].includes(mode)) throw new AppError("CONFIG_INVALID", "NODE_ENV 无效", 500);
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError("CONFIG_INVALID", "PORT 无效", 500, "PORT");
  const policy = (process.env.STORAGE_POLICY ?? "LOCAL_VERIFIED") as StoragePolicy;
  const smsProvider = process.env.SMS_PROVIDER ?? "sandbox";
  const configuredSandboxOtp = process.env.SANDBOX_OTP_CODE?.trim();
  const configuredRegistrationAdmin = process.env.REGISTRATION_ADMIN_PHONE?.trim();
  const config: AppConfig = {
    mode,
    host: process.env.HOST ?? "127.0.0.1",
    port,
    databaseUrl: required("DATABASE_URL"),
    ...(process.env.DATABASE_CAPACITY_PATH ? { databaseCapacityPath: resolve(process.env.DATABASE_CAPACITY_PATH) } : {}),
    publicOrigin: process.env.PUBLIC_ORIGIN ?? "http://127.0.0.1:5173",
    otpHmacKey: required("OTP_HMAC_KEY"),
    sessionHmacKey: required("SESSION_HMAC_KEY"),
    paymentProvider: process.env.PAYMENT_PROVIDER ?? "sandbox",
    smsProvider,
    ...(mode !== "production" && smsProvider === "sandbox"
      ? { sandboxOtpCode: configuredSandboxOtp || "246810" }
      : {}),
    ...(mode !== "production" && configuredRegistrationAdmin
      ? { registrationAdminPhoneE164: configuredRegistrationAdmin }
      : {}),
    chinaMoneyEnabled: process.env.CHINAMONEY_ENABLED === "true",
    chinaMoneyEndpointTemplate: process.env.CHINAMONEY_ENDPOINT_TEMPLATE?.trim() || undefined,
    chinaMoneyAuthorizationReference: process.env.CHINAMONEY_AUTHORIZATION_REFERENCE?.trim() || undefined,
    chinaMoneyFixturePath: process.env.CHINAMONEY_FIXTURE_PATH ? resolve(process.env.CHINAMONEY_FIXTURE_PATH) : undefined,
    chinaMoneyHistoryStart: process.env.CHINAMONEY_HISTORY_START?.trim() || undefined,
    storageRoot: resolve(process.env.STORAGE_ROOT ?? ".work/storage/local"),
    storageReplicaRoot: process.env.STORAGE_REPLICA_ROOT ? resolve(process.env.STORAGE_REPLICA_ROOT) : undefined,
    storagePolicy: policy,
    fileKekBase64: required("FILE_KEK_BASE64"),
    remoteBackupTarget: process.env.REMOTE_BACKUP_TARGET || undefined,
  };
  if (configuredSandboxOtp && !/^[0-9]{6}$/u.test(configuredSandboxOtp)) {
    throw new AppError("CONFIG_INVALID", "SANDBOX_OTP_CODE 必须是 6 位数字", 500, "SANDBOX_OTP_CODE");
  }
  if (configuredRegistrationAdmin && !/^\+[1-9][0-9]{7,14}$/u.test(configuredRegistrationAdmin)) {
    throw new AppError("CONFIG_INVALID", "REGISTRATION_ADMIN_PHONE 必须是 E.164 手机号", 500, "REGISTRATION_ADMIN_PHONE");
  }
  if (mode === "production" && (configuredSandboxOtp || configuredRegistrationAdmin)) {
    throw new AppError("PRODUCTION_NOT_READY", "生产环境禁止固定验证码和注册即授予管理员", 503);
  }
  if (config.chinaMoneyEnabled) {
    if (!config.chinaMoneyHistoryStart || !isIsoDate(config.chinaMoneyHistoryStart)) {
      throw new AppError("CHINAMONEY_CONFIG_INVALID", "ChinaMoney 全量同步起始日期未配置或格式无效", 503, "CHINAMONEY_HISTORY_START");
    }
    const endpoint = config.chinaMoneyEndpointTemplate;
    if (endpoint) {
      for (const placeholder of ["{from}", "{to}", "{page}", "{pageSize}"]) {
        if (!endpoint.includes(placeholder)) {
          throw new AppError("CHINAMONEY_CONFIG_INVALID", `ChinaMoney 端点缺少分页占位符 ${placeholder}`, 503, "CHINAMONEY_ENDPOINT_TEMPLATE");
        }
      }
    }
    if (mode === "production") {
      if (!endpoint || !config.chinaMoneyAuthorizationReference || config.chinaMoneyFixturePath) {
        throw new AppError("CHINAMONEY_CONFIG_INVALID", "ChinaMoney 生产端点、授权留档或运行模式未就绪", 503);
      }
      let url: URL;
      try {
        url = new URL(endpoint.replaceAll("{from}", "2000-01-01").replaceAll("{to}", "2000-01-02").replaceAll("{page}", "1").replaceAll("{pageSize}", "500"));
      } catch {
        throw new AppError("CHINAMONEY_CONFIG_INVALID", "ChinaMoney 生产端点 URL 无效", 503, "CHINAMONEY_ENDPOINT_TEMPLATE");
      }
      if (url.protocol !== "https:" || url.hostname !== "www.chinamoney.com.cn") {
        throw new AppError("CHINAMONEY_CONFIG_INVALID", "ChinaMoney 生产端点必须使用官方 HTTPS 主机", 503);
      }
    }
  }
  if (mode === "production") {
    const unsafe = config.smsProvider === "sandbox" || config.paymentProvider === "sandbox" || !config.chinaMoneyEnabled || policy !== "REMOTE_REQUIRED" || !config.storageReplicaRoot || !config.remoteBackupTarget;
    if (unsafe) throw new AppError("PRODUCTION_NOT_READY", "生产外部配置不完整或仍启用沙箱", 503);
  }
  if (Buffer.byteLength(config.otpHmacKey, "utf8") < 32 || Buffer.byteLength(config.sessionHmacKey, "utf8") < 32) {
    throw new AppError("CONFIG_INVALID", "OTP_HMAC_KEY 和 SESSION_HMAC_KEY 至少需要 32 字节", 500);
  }
  const fileKey = Buffer.from(config.fileKekBase64, "base64");
  if (fileKey.byteLength !== 32 || fileKey.toString("base64").replaceAll("=", "") !== config.fileKekBase64.replaceAll("=", "")) {
    throw new AppError("CONFIG_INVALID", "FILE_KEK_BASE64 必须是规范的 32 字节 Base64 密钥", 500, "FILE_KEK_BASE64");
  }
  return config;
}
