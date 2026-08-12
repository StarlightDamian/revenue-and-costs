import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const accountId = "50000000-0000-4000-8000-000000000001";
const shopId = "10000000-0000-4000-8000-000000000019";
const snapshotId = "30000000-0000-4000-8000-000000000019";
const me = {
  id: accountId,
  phoneMasked: "138****0000",
  displayName: "浏览器验收做账员",
  avatarId: 24,
  roles: ["ACCOUNTANT"],
  theme: "comfort",
  customerShopCount: 0,
  isFirstLogin: false,
};

function preview(profitRate: string | null, minimumSalesCostRate: string | null) {
  const emptyMonth = (month: number) => ({
    period: `2026-${String(month).padStart(2, "0")}`,
    incomeTotalCny: month === 4 ? "1000.00000000" : "0.00000000",
    netIncomeCny: month === 4 ? "900.00000000" : "0.00000000",
    platformExpensesCny: month === 4 ? "700.00000000" : "0.00000000",
    targetProfitCny: profitRate === null ? null : month === 4 ? "90.00000000" : "0.00000000",
    profitCny: month === 4 ? "50.00000000" : "0.00000000",
    procurementCny: month === 4 ? "150.00000000" : "0.00000000",
    salesCostRate: month === 4 ? "0.15000000" : "0.00000000",
    minimumAdjusted: month === 4,
  });
  return {
    snapshotId,
    year: "2026",
    assumptions: { profitRate, minimumSalesCostRate },
    rows: Array.from({ length: 12 }, (_, index) => emptyMonth(index + 1)),
    total: {
      incomeTotalCny: "1000.00000000",
      netIncomeCny: "900.00000000",
      platformExpensesCny: "700.00000000",
      targetProfitCny: profitRate === null ? null : "90.00000000",
      profitCny: "50.00000000",
      procurementCny: "150.00000000",
      salesCostRate: "0.15000000",
      minimumAdjusted: true,
    },
  };
}

async function mockWorkspace(page: Page) {
  let preferences = { profitRate: "0.04370000", minimumSalesCostRate: "0.15000000", continentPrefixes: ["EU"] };
  let savedPayload: Record<string, unknown> | undefined;
  let previewQuery = "";
  let failNextExportsRead = false;
  let delayPreferencesRead = false;
  let markPreferencesReadStarted: () => void = () => undefined;
  let releasePreferencesRead: () => void = () => undefined;
  let preferencesReadStarted = Promise.resolve();
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/api/v1/me/accounting-preferences", async (route) => {
    if (route.request().method() === "PATCH") {
      savedPayload = route.request().postDataJSON() as Record<string, unknown>;
      preferences = savedPayload as typeof preferences;
    } else if (delayPreferencesRead) {
      markPreferencesReadStarted();
      await new Promise<void>((resolve) => { releasePreferencesRead = resolve; });
      delayPreferencesRead = false;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(preferences) });
  });
  await page.route("**/api/v1/shops", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{
    id: shopId,
    enterpriseId: "60000000-0000-4000-8000-000000000019",
    createdByAccountId: accountId,
    lastOperatedByAccountId: accountId,
    name: "导出验收公司",
    access: "ENTERPRISE",
    accountingStatus: "SUBMITTED",
    status: "ACTIVE",
    termStart: "2026-08-02",
    termEndExclusive: "2027-08-02",
    renameAvailable: true,
  }]) }));
  await page.route(`**/api/v1/shops/${shopId}/workflow`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    shop: { id: shopId, name: "导出验收公司", access: "ENTERPRISE", status: "ACTIVE", canEdit: true },
    diagnosticId: "I0000000000000000000019",
    currentStep: "EXPORT",
    steps: ["RECEIVE", "PREFLIGHT", "COMMIT", "CALCULATE", "PUBLISH", "EXPORT"].map((code) => ({
      code, label: code, state: "COMPLETED", severity: "NONE", progress: "100", warningCount: 0, blockingCount: 0, clickable: true,
    })),
    publishedSnapshot: { id: snapshotId, publishedAt: "2026-08-02T12:00:00.000Z", stale: false },
    download: { available: true, usesPreviousPublishedVersion: false },
  }) }));
  await page.route(`**/api/v1/exports?shopId=${shopId}`, (route) => {
    if (failNextExportsRead) {
      failNextExportsRead = false;
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "temporary export read failure" }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route(`**/api/v1/shops/${shopId}/exports/cost-preview**`, (route) => {
    previewQuery = new URL(route.request().url()).search;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(preview("0.10000000", "0.15000000")) });
  });
  return {
    savedPayload: () => savedPayload,
    previewQuery: () => previewQuery,
    failNextExportsRead: () => { failNextExportsRead = true; },
    delayNextPreferencesRead: () => {
      delayPreferencesRead = true;
      preferencesReadStarted = new Promise<void>((resolve) => { markPreferencesReadStarted = resolve; });
    },
    waitForPreferencesRead: () => preferencesReadStarted,
    releasePreferencesRead: () => releasePreferencesRead(),
  };
}

test("做账习惯保存默认参数，报告页带入后可预览最低销售成本率调整", async ({ page }, testInfo) => {
  const state = await mockWorkspace(page);
  const evidenceDirectory = resolve(".work/evidence/accounting-habits");
  await mkdir(evidenceDirectory, { recursive: true });

  await page.goto("/accounting-habits");
  await expect(page.getByRole("heading", { name: "做账习惯" })).toBeVisible();
  await expect(page.getByLabel("利润率（可选）")).toHaveValue("4.37");
  await expect(page.getByLabel("最低销售成本率（可选）")).toHaveValue("15");
  await expect(page.getByLabel("欧洲")).toBeChecked();
  await expect(page.getByLabel("美洲")).not.toBeChecked();
  await page.getByLabel("美洲").check();
  await page.getByLabel("利润率（可选）").fill("5.25");
  await page.getByRole("button", { name: "保存做账习惯" }).click();
  await expect.poll(state.savedPayload).toEqual({ profitRate: "0.05250000", minimumSalesCostRate: "0.15000000", continentPrefixes: ["EU", "AM"] });
  await page.screenshot({ path: resolve(evidenceDirectory, `habits-${testInfo.project.name}.png`), fullPage: true });

  await page.goto(`/shops/${shopId}/workflow/export`);
  await expect(page.getByRole("heading", { name: "本次成本测算" })).toBeVisible();
  await expect(page.getByLabel("利润率（可选）")).toHaveValue("5.25");
  await expect(page.getByLabel("最低销售成本率（可选）")).toHaveValue("15");
  await expect(page.getByText("最低销售成本率已触发", { exact: false })).toBeVisible();
  await expect(page.getByRole("definition").filter({ hasText: "15.00%" })).toBeVisible();
  const totalRow = page.locator(".cost-preview tfoot tr");
  await expect(totalRow).toHaveText("全年合计¥1,000.00¥900.00¥700.00¥50.00¥150.0015.00%已触发");
  state.delayNextPreferencesRead();
  await page.reload();
  await state.waitForPreferencesRead();
  const createExportButton = page.getByRole("button", { name: "生成并下载" });
  await expect(createExportButton).toBeDisabled();
  await page.getByLabel("利润率（可选）").fill("10");
  await page.getByLabel("最低销售成本率（可选）").fill("15");
  state.releasePreferencesRead();
  await expect(page.getByLabel("利润率（可选）")).toHaveValue("10");
  await expect(page.getByLabel("最低销售成本率（可选）")).toHaveValue("15");
  await expect.poll(state.previewQuery).toContain("profitRate=0.10000000");
  await expect.poll(state.previewQuery).toContain("minimumSalesCostRate=0.15000000");
  await expect(createExportButton).toBeEnabled();
  state.failNextExportsRead();
  await page.reload();
  await page.getByRole("button", { name: "重新读取" }).click();
  await expect(page.getByLabel("利润率（可选）")).toHaveValue("5.25");
  await expect(createExportButton).toBeEnabled();
  await page.screenshot({ path: resolve(evidenceDirectory, `preview-${testInfo.project.name}.png`), fullPage: true });
});
