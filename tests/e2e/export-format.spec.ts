import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const shopId = "10000000-0000-4000-8000-000000000019";
const snapshotId = "30000000-0000-4000-8000-000000000019";
const enterpriseId = "60000000-0000-4000-8000-000000000019";
const me = {
  id: "50000000-0000-4000-8000-000000000001",
  phoneMasked: "138****0000",
  displayName: "浏览器验收做账员",
  avatarId: 24,
  roles: ["ACCOUNTANT"],
  theme: "comfort",
  customerShopCount: 0,
  isFirstLogin: true,
};

test("报告下载固定五个 Sheet，并把旧格式任务与当前版本分开标识", async ({ page }, testInfo) => {
  let putLegacyFirst = false;
  let downloadTokenExportId = "";
  let onboardingRequests = 0;
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/api/v1/me/onboarding**", (route) => {
    onboardingRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dismissed: false }) });
  });
  await page.route("**/api/v1/shops", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{
    id: shopId, enterpriseId, createdByAccountId: me.id, lastOperatedByAccountId: me.id,
    name: "导出验收公司", access: "ENTERPRISE", accountingStatus: "SUBMITTED", status: "ACTIVE", termStart: "2026-08-02", termEndExclusive: "2027-08-02", renameAvailable: true,
  }]) }));
  await page.route(`**/api/v1/shops/${shopId}/workflow`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    shop: { id: shopId, name: "导出验收公司", access: "ENTERPRISE", status: "ACTIVE", canEdit: true },
    currentStep: "EXPORT",
    steps: ["RECEIVE", "PREFLIGHT", "COMMIT", "CALCULATE", "PUBLISH", "EXPORT"].map((code, index) => ({
      code,
      label: ["数据接收", "预检解析", "确认入库", "业务计算", "结果发布", "报告下载"][index],
      state: "COMPLETED",
      severity: "NONE",
      progress: "100",
      warningCount: 0,
      blockingCount: 0,
      clickable: true,
    })),
    publishedSnapshot: { id: snapshotId, publishedAt: "2026-08-02T12:00:00.000Z", stale: false },
    download: { available: true, usesPreviousPublishedVersion: false },
  }) }));
  await page.route("**/api/v1/me/accounting-preferences", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ profitRate: null, minimumSalesCostRate: null, continentPrefixes: ["EU"] }),
  }));
  await page.route(`**/api/v1/shops/${shopId}/exports/cost-preview**`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      snapshotId,
      year: "2026",
      assumptions: { profitRate: null, minimumSalesCostRate: null },
      rows: [],
      total: { incomeTotalCny: "0", netIncomeCny: "0", platformExpensesCny: "0", targetProfitCny: null, profitCny: "0", procurementCny: "0", salesCostRate: "0", minimumAdjusted: false },
    }),
  }));
  const current = { id: "80000000-0000-4000-8000-000000000019", shopId, snapshotId, status: "SUCCEEDED", progress: "100", stage: "SUCCEEDED", processedRows: "0", totalRows: null, heartbeatAt: null, format: "XLSX", isCurrentFormat: true, profitRate: null, minimumSalesCostRate: null, createdAt: "2026-08-02T13:00:00.000Z" };
  const legacy = { id: "80000000-0000-4000-8000-000000000018", shopId, snapshotId, status: "SUCCEEDED", progress: "100", stage: "SUCCEEDED", processedRows: "0", totalRows: null, heartbeatAt: null, format: "XLSX", isCurrentFormat: false, profitRate: null, minimumSalesCostRate: null, createdAt: "2026-08-02T11:00:00.000Z" };
  await page.route(`**/api/v1/exports?shopId=${shopId}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(putLegacyFirst ? [legacy, current] : [current, legacy]),
  }));
  await page.route(`**/api/v1/shops/${shopId}/exports/current`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(current),
  }));
  await page.route("**/api/v1/exports/*/download-token", (route) => {
    downloadTokenExportId = route.request().url().split("/").at(-2) ?? "";
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: "#current-download" }) });
  });

  await page.goto(`/shops/${shopId}/workflow/export`);

  await expect(page.getByRole("navigation", { name: "店铺数据处理阶段" }).getByRole("link")).toHaveCount(3);
  const onboarding = page.locator("body > .onboarding-overlay");
  await expect(onboarding).toHaveCount(0);
  expect(onboardingRequests).toBe(0);
  await expect(page.getByText("当前正式版本", { exact: true })).toHaveCount(0);
  await expect(page.locator(".export-assumption-actions").getByRole("button", { name: "生成并下载" })).toBeVisible();
  await expect(page.getByRole("list", { name: "报告包含的表格" })).toHaveCount(0);
  const rows = page.locator(".surface-section table tbody tr");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("当前版本");
  await expect(rows.nth(0).getByRole("button", { name: "下载", exact: true })).toBeVisible();
  await expect(rows.nth(1)).toContainText("旧版导出");
  await expect(rows.nth(1)).toContainText("旧版格式");
  await expect(rows.nth(1).getByRole("button", { name: "下载旧版", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  const evidenceDirectory = resolve(".work/evidence/export-format-v2");
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDirectory, `${testInfo.project.name}.png`), fullPage: true });

  putLegacyFirst = true;
  await page.locator(".workflow-download").click();
  await expect.poll(() => downloadTokenExportId).toBe(current.id);

  downloadTokenExportId = "";
  await page.goto(`/shops/${shopId}/workflow/export?auto=${legacy.id}`);
  await expect(page.getByRole("alert")).toContainText("该链接指向旧版导出");
  await expect(page).toHaveURL(new RegExp(`/shops/${shopId}/workflow/export$`));
  expect(downloadTokenExportId).toBe("");
});
