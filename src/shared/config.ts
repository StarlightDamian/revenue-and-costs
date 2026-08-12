import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { isAbsolute, relative, resolve, sep } from "node:path";
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
  appBasePath: string;
  otpHmacKey: string;
  sessionHmacKey: string;
  paymentProvider: string;
  smsProvider: string;
  sandboxOtpCode?: string;
  temporaryAdminOtpCode?: string;
  temporaryDegradedProduction?: boolean;
  temporaryPublicRegistration?: boolean;
  registrationAdminPhoneE164?: string;
  chinaMoneyEnabled: boolean;
  chinaMoneyEndpointTemplate: string | undefined;
  chinaMoneyAuthorizationReference: string | undefined;
  chinaMoneyFixturePath: string | undefined;
  chinaMoneyHistoryStart: string | undefined;
  storageRoot: string;
  exportOutputRoot?: string;
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

function appBasePath(mode: RuntimeMode): string {
  const value = process.env.APP_BASE_PATH?.trim() || (mode === "production" ? "/revenue-costs" : "/");
  const segments = value.split("/").slice(1);
  if (
    !/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/u.test(value)
    || (value !== "/" && (value.endsWith("/") || segments.includes(".") || segments.includes("..")))
  ) {
    throw new AppError("CONFIG_INVALID", "APP_BASE_PATH must be / or a safe absolute path without a trailing slash", 500, "APP_BASE_PATH");
  }
  return value;
}

function publicOrigin(mode: RuntimeMode): string {
  const value = process.env.PUBLIC_ORIGIN?.trim() || "http://127.0.0.1:5173";
  let url: URL;
  try { url = new URL(value); } catch {
    throw new AppError("CONFIG_INVALID", "PUBLIC_ORIGIN must be an absolute browser origin", 500, "PUBLIC_ORIGIN");
  }
  if (value !== url.origin || url.username || url.password || (mode === "production" && url.protocol !== "https:")) {
    throw new AppError("CONFIG_INVALID", "PUBLIC_ORIGIN must be an exact HTTPS origin in production", 500, "PUBLIC_ORIGIN");
  }
  return value;
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
  const configuredTemporaryAdminOtp = process.env.TEMPORARY_ADMIN_OTP_CODE?.trim();
  const configuredRegistrationAdmin = process.env.REGISTRATION_ADMIN_PHONE?.trim();
  const temporaryDegradedProduction = process.env.TEMPORARY_DEGRADED_PRODUCTION === "true";
  const temporaryPublicRegistration = process.env.TEMPORARY_PUBLIC_REGISTRATION === "true";
  const config: AppConfig = {
    mode,
    host: process.env.HOST ?? "127.0.0.1",
    port,
    databaseUrl: required("DATABASE_URL"),
    ...(process.env.DATABASE_CAPACITY_PATH ? { databaseCapacityPath: resolve(process.env.DATABASE_CAPACITY_PATH) } : {}),
    publicOrigin: publicOrigin(mode),
    appBasePath: appBasePath(mode),
    otpHmacKey: required("OTP_HMAC_KEY"),
    sessionHmacKey: required("SESSION_HMAC_KEY"),
    paymentProvider: process.env.PAYMENT_PROVIDER ?? "sandbox",
    smsProvider,
    ...(mode !== "production" && smsProvider === "sandbox"
      ? { sandboxOtpCode: configuredSandboxOtp || "246810" }
      : {}),
    ...(temporaryDegradedProduction && configuredTemporaryAdminOtp
      ? { temporaryAdminOtpCode: configuredTemporaryAdminOtp }
      : {}),
    temporaryDegradedProduction,
    temporaryPublicRegistration,
    ...((mode !== "production" || temporaryDegradedProduction) && configuredRegistrationAdmin
      ? { registrationAdminPhoneE164: configuredRegistrationAdmin }
      : {}),
    chinaMoneyEnabled: process.env.CHINAMONEY_ENABLED === "true",
    chinaMoneyEndpointTemplate: process.env.CHINAMONEY_ENDPOINT_TEMPLATE?.trim() || undefined,
    chinaMoneyAuthorizationReference: process.env.CHINAMONEY_AUTHORIZATION_REFERENCE?.trim() || undefined,
    chinaMoneyFixturePath: process.env.CHINAMONEY_FIXTURE_PATH ? resolve(process.env.CHINAMONEY_FIXTURE_PATH) : undefined,
    chinaMoneyHistoryStart: process.env.CHINAMONEY_HISTORY_START?.trim() || undefined,
    storageRoot: resolve(process.env.STORAGE_ROOT ?? ".work/storage/local"),
    ...(process.env.EXPORT_OUTPUT_ROOT ? { exportOutputRoot: resolve(process.env.EXPORT_OUTPUT_ROOT) } : {}),
    storageReplicaRoot: process.env.STORAGE_REPLICA_ROOT ? resolve(process.env.STORAGE_REPLICA_ROOT) : undefined,
    storagePolicy: policy,
    fileKekBase64: required("FILE_KEK_BASE64"),
    remoteBackupTarget: process.env.REMOTE_BACKUP_TARGET || undefined,
  };
  if (configuredSandboxOtp && !/^[0-9]{6}$/u.test(configuredSandboxOtp)) {
    throw new AppError("CONFIG_INVALID", "SANDBOX_OTP_CODE 必须是 6 位数字", 500, "SANDBOX_OTP_CODE");
  }
  if (configuredTemporaryAdminOtp && !/^[0-9]{6}$/u.test(configuredTemporaryAdminOtp)) {
    throw new AppError("CONFIG_INVALID", "TEMPORARY_ADMIN_OTP_CODE 必须是 6 位数字", 500, "TEMPORARY_ADMIN_OTP_CODE");
  }
  if (configuredRegistrationAdmin && !/^\+[1-9][0-9]{7,14}$/u.test(configuredRegistrationAdmin)) {
    throw new AppError("CONFIG_INVALID", "REGISTRATION_ADMIN_PHONE 必须是 E.164 手机号", 500, "REGISTRATION_ADMIN_PHONE");
  }
  if (temporaryDegradedProduction && mode !== "production") {
    throw new AppError("CONFIG_INVALID", "TEMPORARY_DEGRADED_PRODUCTION 只允许用于 production", 500, "TEMPORARY_DEGRADED_PRODUCTION");
  }
  if (temporaryPublicRegistration && (!temporaryDegradedProduction || mode !== "production")) {
    throw new AppError("CONFIG_INVALID", "TEMPORARY_PUBLIC_REGISTRATION 只允许用于临时 production 模式", 500, "TEMPORARY_PUBLIC_REGISTRATION");
  }
  if (config.paymentProvider === "temporary-manual" && (!temporaryDegradedProduction || mode !== "production")) {
    throw new AppError("CONFIG_INVALID", "PAYMENT_PROVIDER=temporary-manual 只允许用于临时 production 模式", 500, "PAYMENT_PROVIDER");
  }
  if (mode === "production" && !temporaryDegradedProduction && (configuredSandboxOtp || configuredTemporaryAdminOtp || configuredRegistrationAdmin)) {
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
    const replicaRelative = config.storageReplicaRoot ? relative(config.storageRoot, config.storageReplicaRoot) : "";
    const replicaNotIndependent = !!config.storageReplicaRoot
      && (replicaRelative === "" || (!replicaRelative.startsWith(`..${sep}`) && replicaRelative !== ".." && !isAbsolute(replicaRelative)));
    if (temporaryDegradedProduction) {
      const temporaryModeInvalid = config.smsProvider !== "temporary-admin-fixed"
        || !config.temporaryAdminOtpCode || !config.registrationAdminPhoneE164
        || !["disabled", "temporary-manual"].includes(config.paymentProvider) || config.chinaMoneyEnabled
        || policy !== "LOCAL_VERIFIED" || Boolean(config.storageReplicaRoot) || Boolean(config.remoteBackupTarget)
        || !config.databaseCapacityPath || !config.exportOutputRoot;
      if (temporaryModeInvalid) {
        throw new AppError(
          "PRODUCTION_NOT_READY",
          "临时生产模式必须使用受限固定验证码、受控充值并禁用真实支付、ChinaMoney 和异地副本",
          503,
        );
      }
    } else {
      const unsafe = config.smsProvider === "sandbox" || ["sandbox", "disabled", "temporary-manual"].includes(config.paymentProvider)
        || !config.chinaMoneyEnabled || policy !== "REMOTE_REQUIRED"
        || !config.databaseCapacityPath || !config.exportOutputRoot || !config.storageReplicaRoot || replicaNotIndependent
        || !config.remoteBackupTarget;
      if (unsafe) throw new AppError("PRODUCTION_NOT_READY", "生产外部配置不完整或仍启用沙箱", 503);
    }
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
