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
  if ((page.viewportSize()?.width ?? 1440) <= 1180) {
    await menuButton.click();
    await expect(page.getByRole("button", { name: /工作台/ })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menuButton).toBeFocused();
    await menuButton.click();
  }

  const navigation = page.getByRole("navigation");
  await expect(navigation.getByText("工作台", { exact: true })).toBeVisible();
  await expect(navigation.getByText("销售成本", { exact: true })).toBeVisible();
  await expect(navigation.getByText("数据与规则", { exact: true })).toBeVisible();
  await expect(navigation.getByText("组织与账号", { exact: true })).toBeVisible();
  await expect(navigation.getByText("平台管理", { exact: true })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "做账员" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "应用" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "运营状态" })).toBeVisible();
  await navigation.getByRole("button", { name: /销售成本/ }).click();
  await expect(navigation.getByRole("link", { name: "公司与做账" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "做账员" })).toBeHidden();
  await navigation.getByRole("button", { name: /数据与规则/ }).click();
  await expect(navigation.getByRole("link", { name: "外汇市场" })).toBeVisible();
  await navigation.getByRole("button", { name: /组织与账号/ }).click();
  await expect(navigation.getByRole("link", { name: "企业钱包" })).toBeVisible();

  const sidebarLayout = await page.locator(".sidebar").evaluate((sidebar) => {
    const group = sidebar.querySelector<HTMLElement>(".side-nav-group");
    const toggle = sidebar.querySelector<HTMLElement>(".side-nav-group-toggle");
    const toggles = [...sidebar.querySelectorAll<HTMLElement>(".side-nav-group-toggle")];
    const nav = sidebar.querySelector<HTMLElement>(".side-nav");
    const footer = sidebar.querySelector<HTMLElement>(".sidebar-foot");
    const sidebarBox = sidebar.getBoundingClientRect();
    const groupStyle = group ? getComputedStyle(group) : undefined;
    const transitionDurations = groupStyle?.transitionDuration.split(",").map((value) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000)) ?? [];
    const headerFills = toggles.map((element) => getComputedStyle(element).backgroundImage);
    const headerTextColors = toggles.map((element) => getComputedStyle(element).color);
    const headerFontWeights = toggles.map((element) => Number.parseInt(getComputedStyle(element.querySelector("strong") ?? element).fontWeight, 10));
    const firstItem = sidebar.querySelector<HTMLElement>(".side-nav-items a");
    return {
      sidebarWidth: sidebarBox.width,
      toggleHeight: toggle?.getBoundingClientRect().height ?? Number.POSITIVE_INFINITY,
      groupAnimation: groupStyle?.animationName,
      groupBorderWidth: groupStyle?.borderTopWidth,
      headerFills,
      headerTextColors,
      headerFontWeights,
      itemFontWeight: firstItem ? Number.parseInt(getComputedStyle(firstItem).fontWeight, 10) : Number.POSITIVE_INFINITY,
      visibleDescriptions: [...sidebar.querySelectorAll<HTMLElement>(".side-nav-group-copy small")].filter((element) => getComputedStyle(element).display !== "none").length,
      longestGroupTransitionMs: Math.max(0, ...transitionDurations),
      navHasUsableViewport: Boolean(nav && nav.clientHeight > 0),
      footerVisible: Boolean(footer && footer.getBoundingClientRect().bottom <= sidebarBox.bottom),
    };
  });
  expect(sidebarLayout.sidebarWidth).toBeLessThanOrEqual(252);
  expect(sidebarLayout.toggleHeight).toBeLessThanOrEqual(52);
  expect(sidebarLayout.groupAnimation).toBe("none");
  expect(sidebarLayout.groupBorderWidth).toBe("0px");
  expect(new Set(sidebarLayout.headerFills).size).toBeGreaterThanOrEqual(4);
  expect(sidebarLayout.headerFills).not.toContain("none");
  expect(new Set(sidebarLayout.headerTextColors).size).toBe(1);
  expect(sidebarLayout.headerTextColors).not.toContain("rgb(36, 24, 0)");
  expect(Math.max(...sidebarLayout.headerFontWeights)).toBeLessThanOrEqual(600);
  expect(sidebarLayout.itemFontWeight).toBeLessThanOrEqual(550);
  expect(sidebarLayout.visibleDescriptions).toBe(0);
  expect(sidebarLayout.longestGroupTransitionMs).toBeLessThanOrEqual(150);
  expect(sidebarLayout.navHasUsableViewport).toBe(true);
  expect(sidebarLayout.footerVisible).toBe(true);

  await navigation.getByRole("button", { name: /平台管理/ }).click();
  const expandedLinks = navigation.locator(".side-nav-group.is-expanded .side-nav-items a");
  await expect(expandedLinks).toHaveCount(3);
  for (const link of await expandedLinks.all()) await expect(link).toBeVisible();
  const expandedBounds = await expandedLinks.evaluateAll((links) => {
    const nav = links[0]?.closest(".side-nav");
    if (!nav) return [];
    const navBox = nav.getBoundingClientRect();
    return links.map((link) => {
      const linkBox = link.getBoundingClientRect();
      return linkBox.top >= navBox.top && linkBox.bottom <= navBox.bottom;
    });
  });
  expect(expandedBounds).toEqual([true, true, true]);

  const evidenceDirectory = resolve(".work/evidence/admin-navigation");
  await mkdir(evidenceDirectory, { recursive: true });
  const collapseButton = page.getByRole("button", { name: "收起侧栏" });
  await expect(collapseButton).toBeVisible();
  await collapseButton.click();
  const collapsedSidebar = page.locator(".sidebar.is-collapsed");
  await expect(collapsedSidebar).toBeVisible();
  await expect(page.getByRole("button", { name: "展开侧栏" })).toBeVisible();
  expect(await collapsedSidebar.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(68);
  const railLinks = collapsedSidebar.locator(".side-nav-items a");
  await expect(railLinks).toHaveCount(10);
  await expect(railLinks.locator(".side-nav-item-marker")).toHaveCount(10);
  expect(await railLinks.locator(".side-nav-item-marker").allTextContents()).not.toContain("");
  await expect(collapsedSidebar.getByRole("link", { name: "做账员" })).toHaveClass(/router-link-active/);
  const collapsedGroupFills = await collapsedSidebar.locator(".side-nav-marker").evaluateAll((markers) => markers.map((marker) => getComputedStyle(marker).backgroundImage));
  expect(new Set(collapsedGroupFills).size).toBeGreaterThanOrEqual(4);
  expect(collapsedGroupFills).not.toContain("none");
  await page.screenshot({ path: resolve(evidenceDirectory, `rail-${testInfo.project.name}.png`), fullPage: true });

  await collapsedSidebar.getByRole("button", { name: "数据与规则" }).click();
  await expect(page.locator(".sidebar.is-collapsed")).toHaveCount(0);
  await expect(navigation.getByRole("link", { name: "外汇市场" })).toBeVisible();
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await page.getByRole("button", { name: "展开侧栏" }).click();
  await expect(page.locator(".sidebar.is-collapsed")).toHaveCount(0);
  await expect(navigation.getByText("数据与规则", { exact: true })).toBeVisible();
  await page.screenshot({ path: resolve(evidenceDirectory, `${testInfo.project.name}.png`), fullPage: true });
});

test("账号名称可修改并即时同步侧栏，手机号区号独立置灰", async ({ page }, testInfo) => {
  let currentAccount = { ...accountant, phoneMasked: "+86 138****0000" };
  let profilePayload: Record<string, unknown> | undefined;
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentAccount) }));
  await page.route("**/api/v1/enterprises", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/v1/me/profile", async (route) => {
    profilePayload = route.request().postDataJSON() as Record<string, unknown>;
    currentAccount = { ...currentAccount, displayName: String(profilePayload.displayName) };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(currentAccount) });
  });

  await page.goto("/account");
  const nameInput = page.getByLabel("账号名称");
  await expect(nameInput).toHaveValue("浏览器验收做账员");
  await expect(nameInput).toHaveAttribute("placeholder", "例如：香港公司名称");
  const phone = page.locator(".definition-list .phone-display");
  await expect(phone.locator(".phone-country-code")).toHaveText("+86");
  await expect(phone).toContainText("138****0000");
  const colors = await phone.evaluate((element) => {
    const prefix = element.querySelector<HTMLElement>(".phone-country-code");
    const number = element.querySelector<HTMLElement>(".phone-number");
    return { prefix: prefix ? getComputedStyle(prefix).color : "", number: number ? getComputedStyle(number).color : "" };
  });
  expect(colors.prefix).not.toBe(colors.number);
  await expect(phone).toHaveAttribute("aria-label", "+86 138****0000");
  expect(await page.locator(".account-avatar-toggle").evaluate((element) => getComputedStyle(element, "::after").content))
    .toMatch(/^(none|normal)$/u);

  await nameInput.fill("😀".repeat(80));
  await expect(page.getByRole("button", { name: "保存名称" })).toBeEnabled();

  await nameInput.fill("测试做账员");
  await page.getByRole("button", { name: "保存名称" }).click();
  await expect(page.getByText("账号名称已更新")).toBeVisible();
  expect(profilePayload).toEqual({ displayName: "测试做账员" });
  if ((page.viewportSize()?.width ?? 1440) <= 1180) await page.getByRole("button", { name: "菜单" }).click();
  await expect(page.locator(".account-summary").getByText("测试做账员", { exact: true })).toBeVisible();
  await expect(page.locator(".account-summary")).not.toContainText("138****0000");

  const evidenceDirectory = resolve(".work/evidence/account-settings");
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
