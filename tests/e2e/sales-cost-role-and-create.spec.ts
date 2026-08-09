import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const accountId = "50000000-0000-4000-8000-000000000001";
const enterpriseId = "60000000-0000-4000-8000-000000000001";
const secondEnterpriseId = "60000000-0000-4000-8000-000000000002";
const companyId = "10000000-0000-4000-8000-000000000001";
const accountant = {
  id: accountId,
  phoneMasked: "138****0000",
  displayName: "浏览器验收做账员",
  avatarId: 24,
  roles: ["ACCOUNTANT"],
  theme: "comfort",
  customerShopCount: 0,
};
const enterprise = {
  id: enterpriseId,
  name: "星河财务服务有限公司",
  unifiedSocialCreditCode: "91310110MA1G5X1R2X",
  profileComplete: true,
  memberCount: 2,
  companyCount: 1,
  notStartedCount: 1,
  submittedCount: 0,
  wallet: { id: "61000000-0000-4000-8000-000000000001", balanceCents: "298000", status: "ACTIVE" },
  createdByAccountId: accountId,
  canEditName: true,
  canEditCreditCode: false,
};
const secondEnterprise = {
  ...enterprise,
  id: secondEnterpriseId,
  name: "远山跨境服务有限公司",
  unifiedSocialCreditCode: "91310110MA1G5X2R3Y",
  companyCount: 1,
  wallet: { ...enterprise.wallet, id: "61000000-0000-4000-8000-000000000002", balanceCents: "18800" },
};
const company = {
  id: companyId,
  enterpriseId,
  createdByAccountId: accountId,
  lastOperatedByAccountId: "50000000-0000-4000-8000-000000000002",
  createdByDisplayName: "浏览器验收做账员",
  lastOperatedByDisplayName: "协同做账员",
  name: "星河跨境一公司",
  access: "ENTERPRISE",
  accountingStatus: "NOT_STARTED",
  status: "ACTIVE",
  termStart: "2026-08-04",
  termEndExclusive: "2027-08-04",
  renameAvailable: true,
};
const secondCompany = {
  ...company,
  id: "10000000-0000-4000-8000-000000000003",
  enterpriseId: secondEnterpriseId,
  name: "远山跨境二公司",
};

async function mockEnterpriseWorkspace(page: Page, me = accountant) {
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/api/v1/enterprises", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([enterprise, secondEnterprise]) }));
  await page.route(`**/api/v1/enterprises/${enterpriseId}/members`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([
      { id: "62000000-0000-4000-8000-000000000001", accountId, displayName: "浏览器验收做账员", phoneMasked: "138****0000", avatarId: 24, status: "ACTIVE", createdAt: "2026-08-04T00:00:00.000Z" },
      { id: "62000000-0000-4000-8000-000000000002", displayName: "待加入同事", phoneMasked: "139****0000", status: "PENDING", createdAt: "2026-08-04T00:01:00.000Z" },
    ]),
  }));
  await page.route("**/api/v1/apps", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([{
      id: "70000000-0000-4000-8000-000000000001",
      code: "amazon-sales-cost",
      name: "亚马逊销售成本",
      status: "ACTIVE",
      sortOrder: 10,
      allowedRoles: ["ACCOUNTANT"],
      currentPrice: { id: "71000000-0000-4000-8000-000000000001", annualPriceCents: "18800" },
    }]),
  }));
}

test("做账员在销售成本页切换企业并按每年 188 元创建公司", async ({ page }, testInfo) => {
  await mockEnterpriseWorkspace(page);
  await page.route("**/api/v1/shops**", (route) => {
    const selectedEnterprise = new URL(route.request().url()).searchParams.get("enterpriseId");
    const companies = selectedEnterprise === enterpriseId ? [company] : selectedEnterprise === secondEnterpriseId ? [secondCompany] : [];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(companies) });
  });

  await page.goto("/sales-cost");

  await expect(page.locator(".account-summary").getByText("做账员", { exact: true })).toHaveCount(1);
  const companyRow = page.locator(".shop-row").filter({ hasText: "星河跨境一公司" });
  await expect(companyRow.getByRole("heading", { name: "星河跨境一公司" })).toBeVisible();
  await expect(companyRow.getByText("未做账", { exact: true })).toBeVisible();
  await expect(companyRow.getByText("协同做账员", { exact: true })).toBeVisible();

  const enterpriseSwitch = page.locator(".global-enterprise-switch select");
  await enterpriseSwitch.selectOption(secondEnterpriseId);
  await expect(page.getByRole("heading", { name: "远山跨境二公司" })).toBeVisible();
  await enterpriseSwitch.selectOption(enterpriseId);
  await expect(page.getByRole("heading", { name: "星河跨境一公司" })).toBeVisible();

  const evidenceDirectory = resolve(".work/evidence/enterprise-workspace");
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDirectory, `${testInfo.project.name}.png`), fullPage: true });

  await page.getByRole("button", { name: "创建公司", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "创建公司" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("188￥", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "创建（消耗188￥）" })).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDirectory, `create-company-${testInfo.project.name}.png`), fullPage: true });

  await dialog.getByRole("button", { name: "取消" }).click();
  const tutorialTrigger = page.getByRole("button", { name: "获取资料教程", exact: true });
  await tutorialTrigger.click();
  const tutorial = page.getByRole("dialog", { name: "获取资料教程" });
  await expect(tutorial.locator(".tutorial-guide-icon")).toBeVisible();
  await expect(tutorial.locator(".tutorial-hero img")).toHaveCount(0);
  expect(await tutorial.evaluate((element) => element.matches(":modal"))).toBe(true);
  expect(await tutorial.evaluate((element) => getComputedStyle(element, "::backdrop").backdropFilter)).not.toBe("none");
  await expect(tutorial.getByRole("heading", { name: "获取配送货件" })).toBeVisible();
  await expect(tutorial.getByRole("button", { name: /^查看大图：/ })).toHaveCount(2);
  await page.screenshot({ path: resolve(evidenceDirectory, `tutorial-${testInfo.project.name}.png`), fullPage: true });
  await tutorial.getByRole("button", { name: "关闭教程" }).click();
  await expect(tutorialTrigger).toBeFocused();
});

test("管理员侧栏按 MECE 分组并提供平台治理入口", async ({ page }, testInfo) => {
  const admin = { ...accountant, roles: ["ADMIN"] };
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(admin) }));
  await page.route("**/api/v1/admin/users?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([{ ...admin, status: "ACTIVE", enterpriseCount: 1, companyCount: 1 }]),
  }));

  await page.goto("/admin/users");
  const menuButton = page.getByRole("button", { name: "菜单" });
  if ((page.viewportSize()?.width ?? 1440) <= 1180) await menuButton.click();

  const navigation = page.getByRole("navigation");
  await expect(navigation.getByText("工作台", { exact: true })).toBeVisible();
  await expect(navigation.getByText("销售成本", { exact: true })).toBeVisible();
  await expect(navigation.getByText("数据与规则", { exact: true })).toBeVisible();
  await expect(navigation.getByText("组织与账号", { exact: true })).toBeVisible();
  await expect(navigation.getByText("平台管理", { exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "公司与做账" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "外汇市场" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "企业钱包" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "做账员" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "应用" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "运营状态" })).toBeVisible();

  const evidenceDirectory = resolve(".work/evidence/admin-navigation");
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDirectory, `${testInfo.project.name}.png`), fullPage: true });
});

test("管理员为选定企业免费创建公司并记录 188 元原价", async ({ page }, testInfo) => {
  const admin = { ...accountant, roles: ["ADMIN"] };
  let createPayload: Record<string, unknown> | undefined;
  await mockEnterpriseWorkspace(page, admin);
  await page.route("**/api/v1/shops**", async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      if (payload.name === "已有公司") {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ code: "SHOP_NAME_CONFLICT", message: "已有同名公司（包括回收站），请更换公司名称", field: "name" }) });
        return;
      }
      createPayload = payload;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...company, id: "10000000-0000-4000-8000-000000000002", name: "管理员新公司", access: "ADMIN" }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(new URL(route.request().url()).searchParams.has("enterpriseId") ? [{ ...company, name: "已有公司", access: "ADMIN" }] : []) });
  });

  await page.goto("/sales-cost");
  await page.locator(".shop-index-heading").getByRole("button", { name: "创建公司", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "创建公司" });
  await expect(dialog.getByText("0￥", { exact: true })).toBeVisible();
  await expect(dialog.getByText("原价 188￥，提交时写入 ADMIN_FREE 审计", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("减免原因")).toHaveCount(0);
  await dialog.getByLabel("公司名称").fill("已有公司");
  await dialog.getByRole("button", { name: "创建（管理员免费）" }).click();
  await expect(dialog.getByText("已有同名公司（包括回收站），请更换公司名称", { exact: true })).toBeVisible();
  await dialog.getByLabel("公司名称").fill("管理员新公司");
  const evidenceDirectory = resolve(".work/evidence/admin-company-create");
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDirectory, `${testInfo.project.name}.png`), fullPage: true });
  await dialog.getByRole("button", { name: "创建（管理员免费）" }).click();

  await expect.poll(() => createPayload).toMatchObject({
    enterpriseId,
    name: "管理员新公司",
  });
  expect(createPayload).not.toHaveProperty("waiverReason");
});
