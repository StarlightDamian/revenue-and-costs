import { expect, test, type Page } from "@playwright/test";

const accountId = "50000000-0000-4000-8000-000000000041";
const shopId = "10000000-0000-4000-8000-000000000041";
const diagnosticId = "I4QQr6qR79OTD82CkROjVDq";
type OverrideRow = {
  id: string; currency: string; validFrom: string; validTo: string; cnyPerUnit: string; sourceReference: string; reason: string;
  createdAt: string; supersedesOverrideId: string | null; isCurrent: boolean;
};

function me(roles: Array<"ACCOUNTANT" | "ADMIN">) {
  return { id: accountId, phoneMasked: "138****0041", displayName: "汇率验收账号", avatarId: 24, roles, theme: "comfort", customerShopCount: 0, isFirstLogin: false };
}

async function routeSession(page: Page, roles: Array<"ACCOUNTANT" | "ADMIN">) {
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me(roles)) }));
  await page.route("**/api/v1/enterprises", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
}

test("管理员新增和修订小站点币种汇率，窄屏保持页面内滚动", async ({ page }) => {
  await routeSession(page, ["ADMIN"]);
  const mutations: Array<{ path: string; body: Record<string, string>; idempotencyKey: string | undefined }> = [];
  let overrideRows: OverrideRow[] = [{
    id: "override-inr-1", currency: "INR", validFrom: "2025-12-01", validTo: "2025-12-31", cnyPerUnit: "0.07300000",
    sourceReference: "授权来源 INR 2025-12", reason: "补齐 INR 报价", createdAt: "2026-08-09T08:00:00.000Z", supersedesOverrideId: null, isCurrent: true,
  }];
  await page.route("**/api/v1/fx/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "SUCCEEDED", syncEnabled: true, quoteCount: 1, coverageFrom: "2025-01-01", coverageTo: "2026-08-09", lastSucceededAt: "2026-08-09T01:00:00.000Z" }) }));
  await page.route("**/api/v1/fx/history?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rows: [] }) }));
  await page.route("**/api/v1/admin/fx-overrides**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rows: overrideRows }) });
    const body = request.postDataJSON() as Record<string, string>;
    mutations.push({ path, body, idempotencyKey: request.headers()["idempotency-key"] });
    if (path.endsWith("/revisions")) {
      const previous = overrideRows.find((item) => item.id === "override-brl-1")!;
      overrideRows = overrideRows.map((item) => item.id === previous.id ? { ...item, isCurrent: false } : item);
      const revised: OverrideRow = {
        ...previous,
        currency: body.currency ?? previous.currency,
        validFrom: body.validFrom ?? previous.validFrom,
        validTo: body.validTo ?? previous.validTo,
        sourceReference: body.sourceReference ?? previous.sourceReference,
        reason: body.reason ?? previous.reason,
        id: "override-brl-2", cnyPerUnit: "1.34000000", createdAt: "2026-08-09T09:00:00.000Z", supersedesOverrideId: previous.id, isCurrent: true,
      };
      overrideRows.push(revised);
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ override: revised }) });
    }
    const created: OverrideRow = {
      id: "override-brl-1", currency: body.currency ?? "", validFrom: body.validFrom ?? "", validTo: body.validTo ?? "",
      cnyPerUnit: "1.33000000", sourceReference: body.sourceReference ?? "", reason: body.reason ?? "",
      createdAt: "2026-08-09T08:30:00.000Z", supersedesOverrideId: null, isCurrent: true,
    };
    overrideRows.push(created);
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ override: created }) });
  });

  await page.goto("/fx?currency=BRL&date=2025-12-30");
  await expect(page.getByRole("heading", { name: "人工授权汇率" })).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("2025-12-30 BRL/CNY");
  await page.getByRole("button", { name: "新增该日期汇率" }).click();
  const dialog = page.getByRole("dialog", { name: "新增人工汇率" });
  await expect(dialog.getByRole("textbox", { name: "币种", exact: true })).toHaveValue("BRL");
  await expect(dialog.getByLabel("有效开始日")).toHaveValue("2025-12-30");
  await expect(dialog.getByLabel("有效结束日")).toHaveValue("2025-12-30");
  await dialog.getByRole("textbox", { name: "1 单位币种对应 CNY", exact: true }).fill("1.33");
  await dialog.getByLabel("授权来源凭证").fill("授权来源 BRL 2025-12-30");
  await dialog.getByLabel("新增或修订原因").fill("补齐 BRL 报价");
  await dialog.getByRole("button", { name: "新增人工汇率" }).click();

  await expect(page.getByRole("status")).toContainText("BRL/CNY 人工汇率已新增");
  expect(mutations[0]).toMatchObject({
    path: "/api/v1/admin/fx-overrides",
    body: { currency: "BRL", validFrom: "2025-12-30", validTo: "2025-12-30", cnyPerUnit: "1.33", sourceReference: "授权来源 BRL 2025-12-30", reason: "补齐 BRL 报价" },
  });
  expect(mutations[0]?.idempotencyKey).toBeTruthy();

  const currentBrl = page.getByRole("row").filter({ hasText: "BRL/CNY" }).filter({ hasText: "当前" });
  await expect(currentBrl).toContainText("1.33000000");
  await currentBrl.getByRole("button", { name: "修改" }).click();
  const revisionDialog = page.getByRole("dialog", { name: "修订人工汇率" });
  await expect(revisionDialog.getByRole("textbox", { name: "币种", exact: true })).toBeDisabled();
  await revisionDialog.getByRole("textbox", { name: "1 单位币种对应 CNY", exact: true }).fill("1.34");
  await revisionDialog.getByLabel("新增或修订原因").fill("依据新授权凭证修订");
  await revisionDialog.getByRole("button", { name: "保存为新修订" }).click();

  await expect(page.getByRole("status")).toContainText("保存为新修订");
  expect(mutations[1]?.path).toBe("/api/v1/admin/fx-overrides/override-brl-1/revisions");
  expect(mutations[1]?.body.cnyPerUnit).toBe("1.34");
  expect(mutations[1]?.idempotencyKey).toBeTruthy();
  await expect(page.getByRole("row").filter({ hasText: "BRL/CNY" }).filter({ hasText: "历史" })).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("普通做账员看不到人工汇率管理区", async ({ page }) => {
  await routeSession(page, ["ACCOUNTANT"]);
  await page.route("**/api/v1/fx/status", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "SUCCEEDED", syncEnabled: true, quoteCount: 0 }) }));
  await page.route("**/api/v1/fx/history?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ rows: [] }) }));

  await page.goto("/fx");
  await expect(page.getByRole("heading", { name: "外汇市场" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "人工授权汇率" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "新增人工汇率" })).toHaveCount(0);
});

test("持久阻断自动弹窗且同一阻断关闭后不被轮询反复打开，诊断按钮复制完整诊断信息", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:5173" });
  await routeSession(page, ["ACCOUNTANT"]);
  const shop = { id: shopId, enterpriseId: "60000000-0000-4000-8000-000000000041", createdByAccountId: accountId, lastOperatedByAccountId: accountId, name: "阻断验收公司", access: "ENTERPRISE", accountingStatus: "SUBMITTED", status: "ACTIVE", termStart: "2025-01-01", termEndExclusive: "2027-01-01", renameAvailable: true };
  const workflow = {
    shop: { id: shopId, name: shop.name, access: "ENTERPRISE", status: "ACTIVE", canEdit: true }, diagnosticId, currentStep: "CALCULATE",
    latestBatch: { id: "batch-41", status: "FAILED", stage: "CALCULATION_BLOCKED", failureCode: "FX_DATA_GAP:BRL:2025-12-30", calculationRunId: "run-41" },
    steps: ["RECEIVE", "PREFLIGHT", "COMMIT", "CALCULATE", "PUBLISH", "EXPORT"].map((code, index) => ({ code, label: code, state: index < 3 ? "COMPLETED" : code === "CALCULATE" ? "IN_PROGRESS" : "NOT_STARTED", severity: code === "CALCULATE" ? "BLOCKING" : "NONE", progress: code === "CALCULATE" ? "50" : index < 3 ? "100" : "0", warningCount: 0, blockingCount: code === "CALCULATE" ? 1 : 0, clickable: index <= 3 })),
    download: { available: false, usesPreviousPublishedVersion: false },
  };
  await page.route("**/api/v1/shops", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([shop]) }));
  await page.route(`**/api/v1/shops/${shopId}/workflow`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(workflow) }));
  await page.route("**/api/v1/me/onboarding**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dismissed: true }) }));
  await page.route(`**/api/v1/reports/shops/${shopId}/intermediate/summary**`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ coverage: { start: null, end: null }, options: { marketplaces: [], currencies: [] }, matchedRows: "0", totalsByCurrency: [], cnyTotal: null }) }));
  await page.route(`**/api/v1/reports/shops/${shopId}/intermediate**`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) }));

  await page.goto(`/shops/${shopId}/workflow/calculate`);
  const blocker = page.getByRole("alertdialog", { name: "计算所需汇率缺失" });
  await expect(blocker).toContainText("2025-12-30 BRL/CNY");
  await expect(blocker).toContainText("请联系管理员");
  await expect(blocker).toContainText(diagnosticId);
  await blocker.getByRole("button", { name: "我知道了" }).click();
  await expect(blocker).toHaveCount(0);
  await page.waitForTimeout(3000);
  await expect(blocker).toHaveCount(0);

  const diagnostic = page.getByRole("button", { name: `复制诊断ID: ${diagnosticId}` });
  await expect(diagnostic).toHaveText("ID: I4QQ…jVDq");
  await expect(diagnostic).toHaveAttribute("title", "诊断ID");
  await diagnostic.click();
  await expect(diagnostic).toContainText("已复制");
  await expect(diagnostic).toHaveAccessibleName(`复制诊断ID: ${diagnosticId}`);
  await expect(page.getByRole("status")).toHaveText("诊断ID已复制");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`诊断ID: ${diagnosticId}`);
});
