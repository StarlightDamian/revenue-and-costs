import { expect, test } from "@playwright/test";

const shopId = "10000000-0000-4000-8000-000000000019";

test("工作流账号菜单中的账号设置在按钮区域水平垂直居中", async ({ page }) => {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/api/v1/me")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        id: "50000000-0000-4000-8000-000000000001",
        phoneMasked: "+86 138****0000",
        displayName: "菜单布局验收",
        avatarId: 24,
        roles: ["ACCOUNTANT"],
        theme: "comfort",
        customerShopCount: 0,
        isFirstLogin: false,
      }) });
    }
    if (url.pathname.endsWith(`/api/v1/shops/${shopId}/workflow`)) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        shop: { id: shopId, name: "菜单布局公司", access: "ENTERPRISE", status: "ACTIVE", canEdit: true },
        diagnosticId: "I0000000000000000000001",
        currentStep: "CALCULATE",
        steps: ["RECEIVE", "PREFLIGHT", "COMMIT", "CALCULATE", "PUBLISH", "EXPORT"].map((code) => ({
          code,
          label: code,
          state: code === "CALCULATE" ? "IN_PROGRESS" : "COMPLETED",
          severity: "NONE",
          progress: "100",
          warningCount: 0,
          blockingCount: 0,
          clickable: true,
        })),
        download: { available: false, usesPreviousPublishedVersion: false },
      }) });
    }
    if (url.pathname.endsWith("/summary")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        coverage: {}, options: { marketplaces: [], currencies: [] }, matchedRows: "0", totalsByCurrency: [], cnyTotal: "0",
      }) });
    }
    if (url.pathname.includes("/intermediate")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [] }) });
    }
    if (url.pathname.includes("/preview")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        shopId, mode: "DRAFT", runId: "30000000-0000-4000-8000-000000000019", calculatedAt: "2026-08-11T00:00:00.000Z",
        dataVersion: "d", mappingVersion: "m", timezoneVersion: "t", policyVersion: "p", formulaVersion: "f", fxVersion: "x",
        metrics: [], completeness: [], fees: [], notices: [], canPublish: false,
      }) });
    }
    if (url.pathname.endsWith("/api/v1/shops")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{
        id: shopId,
        enterpriseId: "60000000-0000-4000-8000-000000000019",
        createdByAccountId: "50000000-0000-4000-8000-000000000001",
        lastOperatedByAccountId: "50000000-0000-4000-8000-000000000001",
        name: "菜单布局公司",
        access: "ENTERPRISE",
        accountingStatus: "SUBMITTED",
        status: "ACTIVE",
        termStart: "2026-01-01",
        termEndExclusive: "2027-01-01",
        renameAvailable: true,
      }]) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto(`/shops/${shopId}/workflow/calculate`);
  await page.getByRole("button", { name: "打开账号和主题菜单" }).click();
  const accountLink = page.getByRole("link", { name: "账号设置" });
  await expect(accountLink).toBeVisible();
  const layout = await accountLink.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      display: style.display,
      alignItems: style.alignItems,
      justifyItems: style.justifyItems,
      minHeight: style.minHeight,
      height: element.getBoundingClientRect().height,
    };
  });
  expect(layout).toMatchObject({ display: "grid", alignItems: "center", justifyItems: "center", minHeight: "34px" });
  expect(layout.height).toBeGreaterThan(30);
});
