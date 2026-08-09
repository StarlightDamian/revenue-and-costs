import { createHash, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { Pool } from "pg";

type Role = "ADMIN" | "USER" | "CUSTOMER";
type BrowserName = "chrome" | "edge";

interface Fixture {
  readonly shopId: string;
  readonly snapshotId: string;
  readonly membershipId: string;
  readonly adminPhone: string;
  readonly userPhone: string;
  readonly customerPhone: string;
  readonly originalOwnerId: string;
  readonly acceptanceOwnerId: string;
  readonly originalShopName: string;
  readonly originalNormalizedShopName: string;
  readonly originalShopStatus: "ACTIVE" | "EXPIRED_READONLY";
  readonly originalCloseDate: string;
}

interface RequestEvidence {
  readonly check: string;
  readonly status: number;
}

interface PageEvidence {
  readonly page: string;
  readonly route: string;
  readonly heading: string;
  readonly overflow: boolean;
  readonly screenshot: string;
}

interface RoleEvidence {
  readonly browser: BrowserName;
  readonly role: Role;
  readonly viewport: string;
  readonly identity: { readonly roles: readonly string[]; readonly customerShopCount: number };
  readonly navigation: Record<string, boolean>;
  readonly pages: readonly PageEvidence[];
  readonly requests: readonly RequestEvidence[];
  readonly diagnostics: readonly string[];
}

interface ThemeEvidence {
  readonly browser: BrowserName;
  readonly viewport: string;
  readonly theme: string;
  readonly domContentLoadedTheme: string;
  readonly finalTheme: string;
  readonly overflow: boolean;
  readonly screenshot: string;
}

const baseUrl = process.env.ACCEPTANCE_BASE_URL ?? "http://127.0.0.1:5173";
const databaseUrl = process.env.ACCEPTANCE_DATABASE_URL;
const requestedShopId = process.env.ACCEPTANCE_SHOP_ID;
const outputRoot = resolve(process.env.ACCEPTANCE_BROWSER_OUTPUT ?? ".work/acceptance/browser-role-matrix");
const standardExecutables = {
  chrome: [
    process.env.ACCEPTANCE_CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ],
  edge: [
    process.env.ACCEPTANCE_EDGE_PATH,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ],
} as const;

if (!databaseUrl) throw new Error("ACCEPTANCE_DATABASE_URL_REQUIRED");

function opaqueId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function syntheticPhone(seed: string, prefix: "195" | "196" | "197"): string {
  const digits = BigInt(`0x${createHash("sha256").update(seed).digest("hex").slice(0, 12)}`) % 100_000_000n;
  return `+86${prefix}${digits.toString().padStart(8, "0")}`;
}

function redact(value: string): string {
  return value
    .replace(/([?&](?:token|code|signature)=)[^&\s]+/giu, "$1[REDACTED]")
    .replace(/\+?\d{11,15}/gu, "[PHONE]")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, "[ID]")
    .slice(0, 500);
}

async function executable(name: BrowserName): Promise<string> {
  for (const candidate of standardExecutables[name]) {
    if (!candidate) continue;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard installation path.
    }
  }
  throw new Error(`${name.toUpperCase()}_EXECUTABLE_NOT_FOUND`);
}

async function prepareFixture(pool: Pool): Promise<Fixture> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const database = await client.query<{ database: string }>("SELECT current_database() AS database");
    const databaseName = database.rows[0]?.database ?? "";
    if (!/(?:test|acceptance)/iu.test(databaseName)) throw new Error("ACCEPTANCE_DATABASE_NAME_REQUIRED");

    const target = await client.query<{
    shop_id: string;
    snapshot_id: string;
    owner_account_id: string;
    shop_name: string;
    normalized_shop_name: string;
    shop_status: "ACTIVE" | "EXPIRED_READONLY";
    close_date: string;
  }>(
    `SELECT s.id AS shop_id,p.published_snapshot_id AS snapshot_id,s.owner_account_id,s.name AS shop_name,
            s.normalized_name AS normalized_shop_name,s.status AS shop_status,s.close_date::text
       FROM shop s
       JOIN account owner ON owner.id=s.owner_account_id AND owner.status='ACTIVE'
       JOIN shop_current_published_snapshot p ON p.shop_id=s.id
      WHERE s.status IN ('ACTIVE','EXPIRED_READONLY') AND ($1::uuid IS NULL OR s.id=$1)
      ORDER BY p.switched_at DESC,s.id
      LIMIT 1`,
    [requestedShopId ?? null],
  );
    const shop = target.rows[0];
    if (!shop) throw new Error("PUBLISHED_ACCEPTANCE_SHOP_REQUIRED");

    const admin = await client.query<{ id: string }>(
      `SELECT a.id FROM account a
       JOIN account_role r ON r.account_id=a.id AND r.role='ADMIN'
      WHERE a.status='ACTIVE' ORDER BY a.created_at,a.id LIMIT 1`,
    );
    const grantingAdmin = admin.rows[0];
    if (!grantingAdmin) throw new Error("ACTIVE_ADMIN_REQUIRED");

    const adminPhone = syntheticPhone(`${shop.shop_id}:admin`, "195");
    const acceptanceAdmin = await client.query<{ id: string }>(
      `INSERT INTO account(phone_e164,phone_verified_at)
       VALUES($1,clock_timestamp())
       ON CONFLICT(phone_e164) DO UPDATE SET status='ACTIVE',phone_verified_at=EXCLUDED.phone_verified_at
       RETURNING id`,
      [adminPhone],
    );
    const acceptanceAdminId = acceptanceAdmin.rows[0]!.id;
    await client.query(
      `INSERT INTO account_role(account_id,role,granted_by)
       SELECT $1,role,$2 FROM unnest(ARRAY['USER','ADMIN']::text[]) AS roles(role)
       ON CONFLICT DO NOTHING`,
      [acceptanceAdminId, grantingAdmin.id],
    );

    const userPhone = syntheticPhone(`${shop.shop_id}:owner`, "197");
    const owner = await client.query<{ id: string }>(
      `INSERT INTO account(phone_e164,phone_verified_at)
       VALUES($1,clock_timestamp())
       ON CONFLICT(phone_e164) DO UPDATE SET status='ACTIVE',phone_verified_at=EXCLUDED.phone_verified_at
       RETURNING id`,
      [userPhone],
    );
    const acceptanceOwnerId = owner.rows[0]!.id;
    const unexpectedRole = await client.query<{ role: string }>(
      "SELECT role FROM account_role WHERE account_id=$1 AND role<>'USER'",
      [acceptanceOwnerId],
    );
    if (unexpectedRole.rowCount) throw new Error("SYNTHETIC_OWNER_ROLE_CONFLICT");
    await client.query(
      "INSERT INTO account_role(account_id,role,granted_by) VALUES($1,'USER',$2) ON CONFLICT DO NOTHING",
      [acceptanceOwnerId, grantingAdmin.id],
    );
    const safeShopName = `浏览器验收店铺-${opaqueId(shop.shop_id)}`;
    await client.query(
      "UPDATE shop SET owner_account_id=$2,name=$3,normalized_name=$3,status='ACTIVE',close_date='2099-01-01',updated_at=clock_timestamp() WHERE id=$1",
      [shop.shop_id, acceptanceOwnerId, safeShopName],
    );

    const customerPhone = syntheticPhone(`${shop.shop_id}:customer`, "196");
    const customer = await client.query<{ id: string }>(
    `INSERT INTO account(phone_e164,phone_verified_at)
     VALUES($1,clock_timestamp())
     ON CONFLICT(phone_e164) DO UPDATE SET status='ACTIVE',phone_verified_at=EXCLUDED.phone_verified_at
     RETURNING id`,
    [customerPhone],
  );
    const customerId = customer.rows[0]!.id;
    const customerRoles = await client.query("SELECT role FROM account_role WHERE account_id=$1", [customerId]);
    if (customerRoles.rowCount) throw new Error("SYNTHETIC_CUSTOMER_PLATFORM_ROLE_CONFLICT");
    const membership = await client.query<{ id: string }>(
    `INSERT INTO shop_membership(shop_id,account_id,status,export_allowed,granted_by)
     VALUES($1,$2,'ACTIVE',false,$3)
     ON CONFLICT(shop_id,account_id) DO UPDATE
       SET status='ACTIVE',export_allowed=false,authorization_epoch=shop_membership.authorization_epoch+1,
           granted_by=EXCLUDED.granted_by,granted_at=clock_timestamp(),revoked_at=NULL,revoke_reason=NULL
     RETURNING id`,
    [shop.shop_id, customerId, acceptanceOwnerId],
    );
    await client.query("DELETE FROM otp_challenge WHERE phone_e164=ANY($1::text[])", [[adminPhone, userPhone, customerPhone]]);
    const fixture = {
      shopId: shop.shop_id,
      snapshotId: shop.snapshot_id,
      membershipId: membership.rows[0]!.id,
      adminPhone,
      userPhone,
      customerPhone,
      originalOwnerId: shop.owner_account_id,
      acceptanceOwnerId,
      originalShopName: shop.shop_name,
      originalNormalizedShopName: shop.normalized_shop_name,
      originalShopStatus: shop.shop_status,
      originalCloseDate: shop.close_date,
    } satisfies Fixture;
    await client.query("COMMIT");
    return fixture;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function restoreFixture(pool: Pool, fixture: Fixture): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE shop_membership SET status='ACTIVE',export_allowed=false,
         authorization_epoch=authorization_epoch+1,revoked_at=NULL,revoke_reason=NULL
       WHERE id=$1`,
      [fixture.membershipId],
    );
    await client.query(
      "UPDATE shop SET owner_account_id=$2,name=$3,normalized_name=$4,status=$5,close_date=$6,updated_at=clock_timestamp() WHERE id=$1",
      [fixture.shopId, fixture.originalOwnerId, fixture.originalShopName, fixture.originalNormalizedShopName, fixture.originalShopStatus, fixture.originalCloseDate],
    );
    await client.query("DELETE FROM otp_challenge WHERE phone_e164=ANY($1::text[])", [[fixture.adminPhone, fixture.userPhone, fixture.customerPhone]]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function login(page: Page, phone: string): Promise<void> {
  await page.goto(`${baseUrl}/login`, { waitUntil: "networkidle" });
  await page.getByPlaceholder("请输入 11 位手机号").fill(phone.slice(3));
  await page.getByRole("button", { name: "获取验证码" }).click();
  const sandboxCode = (await page.locator(".sandbox-notice code").textContent())?.trim();
  if (!sandboxCode) throw new Error("SANDBOX_OTP_NOT_DISCLOSED");
  await page.getByPlaceholder("输入验证码").fill(sandboxCode);
  await page.getByRole("button", { name: "登录并进入工作台", exact: true }).click();
  await page.waitForURL(/\/sales-cost$/u);
  await page.getByRole("heading", { name: "销售成本", exact: true }).waitFor();
}

async function apiRequest(page: Page, path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}) {
  return page.evaluate(async ({ target, method, body, key }) => {
    const csrf = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("rc_csrf="))?.slice(8);
    const headers = new Headers({ Accept: "application/json" });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (method && !["GET", "HEAD"].includes(method)) {
      if (csrf) headers.set("X-CSRF-Token", decodeURIComponent(csrf));
      headers.set("Idempotency-Key", key ?? crypto.randomUUID());
    }
    const response = await fetch(target, {
      method: method ?? "GET",
      headers,
      credentials: "include",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json") ? await response.json().catch(() => undefined) : undefined;
    return { status: response.status, payload };
  }, { target: path, method: init.method, body: init.body, key: init.idempotencyKey });
}

async function redactEvidenceDom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.textContent) {
        node.textContent = node.textContent
          .replace(/(?:\+?\d{2,4})?\*{4}\d{4}/gu, "[账号已脱敏]")
          .replace(/\+?\d{11,15}/gu, "[手机号已脱敏]");
      }
      node = walker.nextNode();
    }
  });
}

async function screenshotPage(page: Page, input: {
  name: string;
  route: string;
  heading: string;
}): Promise<PageEvidence> {
  await page.goto(`${baseUrl}${input.route}`, { waitUntil: "networkidle" });
  try {
    await page.getByRole("heading", { name: input.heading, exact: true }).waitFor({ timeout: 10_000 });
  } catch {
    const observed = await page.locator("h1,h2").allTextContents();
    throw new Error(`EXPECTED_HEADING_MISSING:${input.name}:${new URL(page.url()).pathname}:${redact(observed.join("|"))}`);
  }
  await redactEvidenceDom(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  const screenshot = resolve(outputRoot, `${input.name}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  if (overflow) throw new Error(`PAGE_LEVEL_HORIZONTAL_OVERFLOW:${input.name}`);
  return { page: input.name, route: input.route.replace(/[0-9a-f-]{36}/giu, ":shopId"), heading: input.heading, overflow, screenshot };
}

function assertDenied(status: number, check: string): void {
  if (![403, 404].includes(status)) throw new Error(`${check}:${status}`);
}

function expectedHttpFailure(role: Role, responseUrl: string, status: number): boolean {
  if (status < 400) return true;
  const path = new URL(responseUrl).pathname;
  if (!path.startsWith("/api/")) return true;
  if (status === 401 && path === "/api/v1/me") return true;
  if (role === "ADMIN" && status === 503 && path === "/api/v1/admin/operations/readiness") return true;
  if (![403, 404].includes(status)) return false;
  if (/^\/api\/v1\/reports\/shops\/00000000-0000-4000-8000-000000000099\/current$/u.test(path)) return true;
  if (role !== "ADMIN" && path === "/api/v1/admin/users") return true;
  if (role !== "CUSTOMER") return false;
  return /^\/api\/v1\/reports\/shops\/[^/]+\/(?:preview|current)$/u.test(path)
    || path === "/api/v1/uploads/batches"
    || path === "/api/v1/imports/completeness"
    || path === "/api/v1/exports"
    || /^\/api\/v1\/exports\/[^/]+\/download$/u.test(path);
}

async function exerciseRole(input: {
  browserName: BrowserName;
  executablePath: string;
  role: Role;
  phone: string;
  fixture: Fixture;
  viewport: { width: number; height: number };
}): Promise<{ evidence: RoleEvidence; page: Page; browser: Browser }> {
  const browser = await chromium.launch({ executablePath: input.executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: input.viewport });
    const page = await context.newPage();
    const diagnostics: string[] = [];
    const unexpectedResponses: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error" && !/^Failed to load resource:/u.test(message.text())) {
        diagnostics.push(redact(`${message.text()} @ ${message.location().url}`));
      }
    });
    page.on("pageerror", (error) => diagnostics.push(redact(error.message)));
    page.on("response", (response) => {
      if (!expectedHttpFailure(input.role, response.url(), response.status())) {
        unexpectedResponses.push(redact(`${response.status()} ${new URL(response.url()).pathname}`));
      }
    });
    await login(page, input.phone);

  const me = await apiRequest(page, "/api/v1/me");
  if (me.status !== 200 || !me.payload || typeof me.payload !== "object") throw new Error(`${input.role}_ME_FAILED:${me.status}`);
  const identity = me.payload as { roles?: string[]; customerShopCount?: number };
  const roles = identity.roles ?? [];
  if (input.role === "ADMIN" && (!roles.includes("ADMIN") || !roles.includes("USER"))) throw new Error("ADMIN_COMPOSABLE_ROLES_NOT_PRESENT");
  if (input.role === "USER" && (!roles.includes("USER") || roles.includes("ADMIN"))) throw new Error("USER_ROLE_NOT_ISOLATED");
  if (input.role === "CUSTOMER" && (roles.length !== 0 || (identity.customerShopCount ?? 0) < 1)) throw new Error("CUSTOMER_ROLE_NOT_ISOLATED");

  const labels = ["用户管理", "应用管理", "运营状态", "销售成本", "外汇市场", "账号设置"];
  const observedNavigation = (await page.locator(".side-nav a").allTextContents()).map((label) => label.trim());
  const navigation: Record<string, boolean> = {};
  for (const label of labels) navigation[label] = observedNavigation.includes(label);
  if (input.role === "ADMIN" && !(navigation["用户管理"] && navigation["应用管理"] && navigation["运营状态"])) {
    throw new Error(`ADMIN_NAVIGATION_INCOMPLETE:${JSON.stringify(navigation)}:${redact(observedNavigation.join("|"))}`);
  }
  if (input.role !== "ADMIN" && (navigation["用户管理"] || navigation["应用管理"] || navigation["运营状态"])) throw new Error(`${input.role}_ADMIN_NAVIGATION_VISIBLE`);

  const pages: PageEvidence[] = [];
  const requests: RequestEvidence[] = [];
  const suffix = `${input.browserName}-${input.role.toLowerCase()}-${input.viewport.width}x${input.viewport.height}`;
  if (input.role === "ADMIN") {
    pages.push(await screenshotPage(page, { name: `${suffix}-users`, route: "/admin/users", heading: "用户管理" }));
    pages.push(await screenshotPage(page, { name: `${suffix}-apps`, route: "/admin/apps", heading: "应用管理" }));
    pages.push(await screenshotPage(page, { name: `${suffix}-operations`, route: "/admin/operations", heading: "运营状态" }));
  } else if (input.role === "USER") {
    pages.push(await screenshotPage(page, { name: `${suffix}-upload`, route: `/shops/${input.fixture.shopId}/upload`, heading: "上传与预检" }));
    pages.push(await screenshotPage(page, { name: `${suffix}-integrity`, route: `/shops/${input.fixture.shopId}/integrity`, heading: "完整性检查" }));
    pages.push(await screenshotPage(page, { name: `${suffix}-results`, route: `/shops/${input.fixture.shopId}/results`, heading: "测算结果" }));
    await page.goto(`${baseUrl}/admin/users`, { waitUntil: "networkidle" });
    await page.waitForURL(/\/sales-cost$/u);
    const direct = await apiRequest(page, "/api/v1/admin/users");
    assertDenied(direct.status, "USER_ADMIN_API_NOT_DENIED");
    requests.push({ check: "admin-api-denied", status: direct.status });
  } else {
    const shops = await apiRequest(page, "/api/v1/shops");
    const accessible = Array.isArray(shops.payload) ? shops.payload as Array<{ id?: string }> : [];
    if (shops.status !== 200 || accessible.length !== 1 || accessible[0]?.id !== input.fixture.shopId) throw new Error("CUSTOMER_SHOP_SCOPE_INVALID");
    await page.goto(`${baseUrl}/sales-cost`, { waitUntil: "networkidle" });
    for (const hidden of ["上传与预检", "完整性", "创建店铺 · 20.00 元/年"]) {
      if (await page.getByText(hidden, { exact: true }).count()) throw new Error(`CUSTOMER_ACTION_VISIBLE:${hidden}`);
    }
    pages.push(await screenshotPage(page, { name: `${suffix}-results`, route: `/shops/${input.fixture.shopId}/results`, heading: "测算结果" }));
    for (const hidden of ["完整性", "导出", "发布正式结果"]) {
      if (await page.getByText(hidden, { exact: true }).count()) throw new Error(`CUSTOMER_RESULT_ACTION_VISIBLE:${hidden}`);
    }
    for (const route of ["upload", "integrity", "exports"]) {
      await page.goto(`${baseUrl}/shops/${input.fixture.shopId}/${route}`, { waitUntil: "networkidle" });
      await page.waitForURL(/\/sales-cost$/u);
    }
    const deniedRequests = [
      ["upload-api-denied", "/api/v1/uploads/batches", { method: "POST", body: { shopId: input.fixture.shopId } }],
      ["integrity-api-denied", `/api/v1/imports/completeness?shopId=${input.fixture.shopId}`, {}],
      ["admin-api-denied", "/api/v1/admin/users", {}],
    ] as const;
    for (const [check, path, init] of deniedRequests) {
      const response = await apiRequest(page, path, init);
      assertDenied(response.status, `CUSTOMER_${check}`);
      requests.push({ check, status: response.status });
    }
  }

  const guessed = await apiRequest(page, "/api/v1/reports/shops/00000000-0000-4000-8000-000000000099/current");
  assertDenied(guessed.status, `${input.role}_OBJECT_GUESS_NOT_DENIED`);
  requests.push({ check: "guessed-shop-denied", status: guessed.status });
  if (diagnostics.length) throw new Error(`${input.role}_PAGE_DIAGNOSTICS:${JSON.stringify(diagnostics)}`);
  if (unexpectedResponses.length) throw new Error(`${input.role}_UNEXPECTED_HTTP_FAILURES:${JSON.stringify(unexpectedResponses)}`);
    return {
      browser,
      page,
      evidence: {
        browser: input.browserName,
        role: input.role,
        viewport: `${input.viewport.width}x${input.viewport.height}`,
        identity: { roles, customerShopCount: identity.customerShopCount ?? 0 },
        navigation,
        pages,
        requests,
        diagnostics,
      },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function verifyThemes(page: Page, browser: BrowserName, viewport: string): Promise<ThemeEvidence[]> {
  await page.addInitScript(() => {
    window.addEventListener("DOMContentLoaded", () => {
      (window as Window & { __acceptanceDomTheme?: string }).__acceptanceDomTheme = document.documentElement.dataset.theme ?? "";
    }, { once: true });
  });
  const themes = [
    ["comfort", "舒适"],
    ["tech", "科技"],
    ["light", "浅色"],
    ["dark", "深色"],
  ] as const;
  const evidence: ThemeEvidence[] = [];
  for (const [theme, label] of themes) {
    await page.goto(`${baseUrl}/sales-cost`, { waitUntil: "networkidle" });
    const sync = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/me/theme" && response.request().method() === "PATCH");
    await page.getByRole("button", { name: label, exact: true }).click();
    const syncResponse = await sync;
    if (syncResponse.status() !== 200) throw new Error(`THEME_ACCOUNT_SYNC_FAILED:${theme}:${syncResponse.status()}`);
    await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
    await page.reload({ waitUntil: "networkidle" });
    const state = await page.evaluate(() => ({
      domContentLoadedTheme: (window as Window & { __acceptanceDomTheme?: string }).__acceptanceDomTheme ?? "",
      finalTheme: document.documentElement.dataset.theme ?? "",
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    }));
    if (state.domContentLoadedTheme !== theme || state.finalTheme !== theme) throw new Error(`THEME_REFRESH_MISMATCH:${theme}`);
    if (state.overflow) throw new Error(`THEME_PAGE_OVERFLOW:${theme}`);
    if (await page.locator(".theme-sync-error").count()) throw new Error(`THEME_SYNC_ERROR_VISIBLE:${theme}`);
    await redactEvidenceDom(page);
    const screenshot = resolve(outputRoot, `${browser}-${viewport}-theme-${theme}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    evidence.push({ browser, viewport, theme, ...state, screenshot });
  }
  return evidence;
}

async function verifyRevocation(owner: Page, customer: Page, fixture: Fixture, pool: Pool): Promise<readonly RequestEvidence[]> {
  const evidence: RequestEvidence[] = [];
  const before = await apiRequest(customer, `/api/v1/reports/shops/${fixture.shopId}/current`);
  if (before.status !== 200) throw new Error(`CUSTOMER_REPORT_BEFORE_REVOKE_FAILED:${before.status}`);
  evidence.push({ check: "report-before-revoke", status: before.status });

  const allowed = await apiRequest(owner, `/api/v1/shops/memberships/${fixture.membershipId}/export`, {
    method: "PATCH",
    body: { allowed: true, reason: "浏览器验收临时授权" },
    idempotencyKey: `browser-export-${randomUUID()}`,
  });
  if (allowed.status !== 200) throw new Error(`CUSTOMER_EXPORT_GRANT_FAILED:${allowed.status}`);
  const created = await apiRequest(customer, "/api/v1/exports", {
    method: "POST",
    body: { shopId: fixture.shopId, snapshotId: fixture.snapshotId },
    idempotencyKey: `browser-create-export-${randomUUID()}`,
  });
  const exportId = created.payload && typeof created.payload === "object" && "id" in created.payload
    ? String((created.payload as { id: unknown }).id)
    : "";
  if (created.status !== 200 || !exportId) throw new Error(`CUSTOMER_EXPORT_CREATE_FAILED:${created.status}`);
  evidence.push({ check: "export-create-before-revoke", status: created.status });

  const revoked = await apiRequest(owner, `/api/v1/shops/memberships/${fixture.membershipId}/revoke`, {
    method: "POST",
    body: { reason: "浏览器验收撤权" },
    idempotencyKey: `browser-revoke-${randomUUID()}`,
  });
  if (revoked.status !== 200) throw new Error(`CUSTOMER_REVOKE_FAILED:${revoked.status}`);

  const checks = [
    ["report-after-revoke", `/api/v1/reports/shops/${fixture.shopId}/current`, {}],
    ["exports-after-revoke", `/api/v1/exports?shopId=${fixture.shopId}`, {}],
    ["export-create-after-revoke", "/api/v1/exports", { method: "POST", body: { shopId: fixture.shopId, snapshotId: fixture.snapshotId } }],
    ["download-after-revoke", `/api/v1/exports/${exportId}/download`, {}],
  ] as const;
  for (const [check, path, init] of checks) {
    const response = await apiRequest(customer, path, init);
    assertDenied(response.status, check);
    evidence.push({ check, status: response.status });
  }
  const state = await pool.query<{ status: string }>("SELECT status FROM export_request WHERE id=$1", [exportId]);
  if (state.rows[0]?.status !== "REVOKED") throw new Error("CUSTOMER_EXPORT_NOT_REVOKED");
  await customer.goto(`${baseUrl}/shops/${fixture.shopId}/results`, { waitUntil: "networkidle" });
  await customer.waitForURL(/\/sales-cost$/u);
  return evidence;
}

await mkdir(outputRoot, { recursive: true });
const pool = new Pool({ connectionString: databaseUrl });
let fixture: Fixture | undefined;
const sessions: Array<{ browser: Browser; page: Page }> = [];
try {
  fixture = await prepareFixture(pool);
  const executables = { chrome: await executable("chrome"), edge: await executable("edge") };
  const matrix = [
    { browserName: "chrome", role: "ADMIN", phone: fixture.adminPhone, viewport: { width: 1440, height: 900 } },
    { browserName: "chrome", role: "USER", phone: fixture.userPhone, viewport: { width: 1440, height: 900 } },
    { browserName: "chrome", role: "CUSTOMER", phone: fixture.customerPhone, viewport: { width: 1440, height: 900 } },
    { browserName: "edge", role: "ADMIN", phone: fixture.adminPhone, viewport: { width: 390, height: 844 } },
    { browserName: "edge", role: "USER", phone: fixture.userPhone, viewport: { width: 390, height: 844 } },
    { browserName: "edge", role: "CUSTOMER", phone: fixture.customerPhone, viewport: { width: 390, height: 844 } },
  ] as const;
  const roles: RoleEvidence[] = [];
  for (const item of matrix) {
    const result = await exerciseRole({ ...item, fixture, executablePath: executables[item.browserName] });
    sessions.push(result);
    roles.push(result.evidence);
  }
  const themes = [
    ...await verifyThemes(sessions[0]!.page, "chrome", "1440x900"),
    ...await verifyThemes(sessions[4]!.page, "edge", "390x844"),
  ];
  const revocation = await verifyRevocation(sessions[1]!.page, sessions[2]!.page, fixture, pool);
  const result = {
    schemaVersion: 2,
    target: { baseUrl, shopRef: opaqueId(fixture.shopId), snapshotRef: opaqueId(fixture.snapshotId) },
    roles,
    themes,
    revocation,
    privacy: { phoneRecorded: false, tokenRecorded: false, piiRecorded: false },
    checkedAt: new Date().toISOString(),
  };
  const evidencePath = resolve(outputRoot, "browser-role-matrix.json");
  await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ evidencePath, roleSessions: roles.length, themeChecks: themes.length, revocationChecks: revocation.length })}\n`);
} finally {
  await Promise.allSettled(sessions.map((session) => session.browser.close()));
  try {
    if (fixture) await restoreFixture(pool, fixture);
  } finally {
    await pool.end();
  }
}
