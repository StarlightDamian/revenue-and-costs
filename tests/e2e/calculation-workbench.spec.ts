import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const accountId = "50000000-0000-4000-8000-000000000001";
const shopId = "10000000-0000-4000-8000-000000000019";
const calculationRunId = "30000000-0000-4000-8000-000000000019";
const me = { id: accountId, phoneMasked: "138****0000", displayName: "计算验收做账员", avatarId: 24, roles: ["ACCOUNTANT"], theme: "comfort", customerShopCount: 0, isFirstLogin: false };
const shop = {
  id: shopId, enterpriseId: "60000000-0000-4000-8000-000000000019", createdByAccountId: accountId, lastOperatedByAccountId: accountId,
  name: "计算验收公司", access: "ENTERPRISE", accountingStatus: "SUBMITTED", status: "ACTIVE", termStart: "2026-01-01", termEndExclusive: "2027-01-01", renameAvailable: true,
};

test("业务计算固定筛选、中文字段、全量合计并让窄屏筛选可折叠", async ({ page }, testInfo) => {
  let lastListUrl = "";
  let reportMode: "DRAFT" | "STALE" = "DRAFT";
  let publishRequests = 0;
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/api/v1/shops", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([shop]) }));
  await page.route(`**/api/v1/shops/${shopId}/workflow`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    shop: { id: shopId, name: shop.name, access: "ENTERPRISE", status: "ACTIVE", canEdit: true },
    diagnosticId: "I0000000000000000000001",
    currentStep: "CALCULATE",
    latestBatch: { id: "20000000-0000-4000-8000-000000000019", calculationRunId, status: "PUBLISHED", stage: "RESULT_PUBLISHED", failureCode: null },
    steps: [
      { code: "RECEIVE", state: "COMPLETED" }, { code: "PREFLIGHT", state: "COMPLETED" }, { code: "COMMIT", state: "COMPLETED" },
      { code: "CALCULATE", state: "COMPLETED" }, { code: "PUBLISH", state: "NOT_STARTED" }, { code: "EXPORT", state: "NOT_STARTED" },
    ].map((step) => ({ ...step, label: step.code, severity: "NONE", progress: step.state === "COMPLETED" ? "100" : "0", warningCount: step.code === "CALCULATE" ? 2 : 0, blockingCount: 0, clickable: true })),
    download: { available: false, usesPreviousPublishedVersion: false },
  }) }));
  await page.route("**/api/v1/me/onboarding**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dismissed: true }) }));
  await page.route(`**/api/v1/reports/shops/${shopId}/intermediate**`, (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/summary")) {
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
        coverage: { start: "2026-04-01", end: "2026-05-31" },
        options: { marketplaces: ["BE", "US"], currencies: ["EUR", "USD"] },
        matchedRows: "1250",
        totalsByCurrency: [{ currency: "EUR", values: { quantity: "12.00", productSales: "1250.50" } }],
        cnyTotal: "8960.25",
      }) });
    }
    lastListUrl = url.toString();
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: [{
      id: "1", marketplace: "BE", localDate: "2026-04-01", type: "Order", description: "订单", orderId: "ORDER-1", sku: "SKU-1", currency: "EUR", quantity: "2",
      productSales: "100.5", productSalesTax: "0", shippingCredits: "0", shippingCreditsTax: "0", giftWrapCredits: "0", giftWrapCreditsTax: "0",
      regulatoryFee: "0", taxOnRegulatoryFee: "0", promotionalRebates: "-1.6", promotionalRebatesTax: "0", marketplaceWithheldTax: "0",
      sellingFees: "-10", fbaFees: "-8", otherTransactionFees: "0", otherAmount: "0", cnyRate: "7.81234567",
    }] }) });
  });
  await page.route(`**/api/v1/reports/shops/${shopId}/preview?**`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    shopId, mode: reportMode, runId: calculationRunId, calculatedAt: "2026-06-30T12:00:00.000Z",
    dataVersion: "data-v1", mappingVersion: "mapping-v1", timezoneVersion: "timezone-v1", policyVersion: "policy-v1", formulaVersion: "formula-v1", fxVersion: "fx-v1",
    metrics: [],
    completeness: [
      { marketplace: "US", month: "2026-04", state: "COMPLETE", missingReports: [] },
      { marketplace: "BE", month: "2026-04", state: "EXCLUDED", note: "HARD_INCOMPLETE" },
      { marketplace: "AE", month: "2026-05", state: "PUBLISHED_WARNING", note: "SOFT_RECONCILIATION_WARNING" },
      { marketplace: "SA", month: "2026-05", state: "CONFLICT", note: "SOFT_RECONCILIATION_WARNING" },
    ],
    fees: [
      { category: "PLATFORM_FEE", marketplace: "BE", month: "2026-04", sourceRows: "3", amountCny: "12.34" },
      { category: "PRIVATE_INTERNAL_FEE_CODE", marketplace: "AE", month: "2026-05", sourceRows: "1", amountCny: "5.67" },
    ],
    notices: [], canPublish: true,
  }) }));
  await page.route(`**/api/v1/reports/shops/${shopId}/publish`, (route) => {
    publishRequests += 1;
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "request should not be sent" }) });
  });

  await page.goto(`/shops/${shopId}/workflow/calculate`);
  await expect(page.getByRole("heading", { name: "计算复核" })).toBeVisible();
  const phaseLinks = page.locator(".workflow-phases a");
  await expect(phaseLinks).toHaveCount(3);
  await expect(phaseLinks.nth(0)).toHaveAttribute("href", `/shops/${shopId}/workflow/commit`);
  await expect(phaseLinks.nth(1)).toHaveAttribute("href", `/shops/${shopId}/workflow/calculate`);
  await expect(phaseLinks.nth(2)).toHaveAttribute("href", `/shops/${shopId}/workflow/export`);
  await expect(page.locator(".workflow-phases small")).toHaveCount(0);
  expect(await page.locator(".workflow-phases").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(3);
  const diagnostic = page.getByRole("button", { name: "复制处理编号：I0000000000000000000001" });
  await diagnostic.click();
  await expect(diagnostic).toContainText("已复制");
  await expect(page.locator(".calculation-status-strip")).toContainText("30000000");
  await expect(page.locator(".calculation-status-strip")).toContainText("1250");
  await expect(page.getByRole("link", { name: "核对并发布" })).toHaveAttribute("href", "#review-result");
  await expect(page.getByRole("heading", { name: "核算结果" })).toBeVisible();
  await expect(page.locator("#review-result")).not.toContainText("上一版正式结果");
  const disclosures = page.locator("#review-result .commit-coverage-table");
  await expect(disclosures).toContainText("资料不完整，已确认不计算");
  await expect(disclosures).toContainText("已确认不计算");
  await expect(disclosures).toContainText("已计入，有数量差异");
  await expect(disclosures).toContainText("数量差异待确认");
  await expect(disclosures).toContainText("这部分资料已计入结果，但两份资料的数量不一致，请继续核对。");
  await expect(disclosures).toContainText("这部分资料暂时不能发布。请先核对两份资料的数量，确认后再继续。");
  await expect(disclosures).not.toContainText(/HARD_INCOMPLETE|SOFT_RECONCILIATION_WARNING|PUBLISHED_WARNING|CONFLICT/u);
  await expect(page.locator("#review-result")).not.toContainText("资料已齐全");
  const fees = page.locator("#review-result .surface-section").filter({ hasText: "费用明细与来源" });
  await expect(fees).toContainText("平台服务费");
  await expect(fees).toContainText("其他费用");
  await expect(fees).not.toContainText(/PLATFORM_FEE|PRIVATE_INTERNAL_FEE_CODE/u);
  await page.locator("#review-result").getByRole("button", { name: "发布正式结果" }).evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.locator("#review-result")).toContainText("本次计算缺少发布需要的资料信息，暂时不能发布");
  expect(publishRequests).toBe(0);

  reportMode = "STALE";
  await page.locator("#review-result .filter-bar").getByRole("button", { name: "应用筛选" }).click();
  await expect(page.locator("#review-result")).toContainText("本次计算还没有完成");
  await expect(page.locator("#review-result").getByLabel("九项核心指标")).toHaveCount(0);
  await expect(page.locator("#review-result").getByRole("button", { name: "发布正式结果" })).toHaveCount(0);

  await expect(page.getByRole("columnheader", { name: "报表日期" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "交易说明" })).toBeVisible();
  await expect(page.getByText("-1.60", { exact: true })).toBeVisible();
  await expect(page.locator(".table-footer-actions")).toContainText("原币金额按币种分别合计");

  const filterDrawer = page.locator(".intermediate-filter-drawer");
  if ((page.viewportSize()?.width ?? 1440) <= 680) {
    await expect(filterDrawer.locator(":scope > summary")).toBeVisible();
    await filterDrawer.locator(":scope > summary").click();
    await expect(page.locator(".intermediate-filter-bar")).not.toBeVisible();
    await filterDrawer.locator(":scope > summary").click();
  } else {
    expect(await page.locator(".intermediate-filter-bar").evaluate((node) => getComputedStyle(node).position)).toBe("sticky");
  }

  const dateRange = page.locator(".date-range-picker");
  await expect(dateRange.getByRole("button", { name: /日期范围/u })).toContainText("2026年04月 — 2026年05月");
  await expect(page.getByLabel("开始", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("结束（含）", { exact: true })).toHaveCount(0);
  await dateRange.getByRole("button", { name: /日期范围/u }).click();
  await expect(dateRange.getByRole("dialog", { name: "选择日期范围" })).toBeVisible();
  await expect(dateRange.getByRole("button", { name: "月度" })).toHaveAttribute("aria-pressed", "true");
  await dateRange.getByRole("button", { name: "日度" }).click();
  await expect(dateRange.getByRole("button", { name: /日期范围/u })).toContainText("2026年04月01日 — 2026年05月31日");
  await page.locator("#intermediate-title").click();
  await expect(dateRange.getByRole("dialog", { name: "选择日期范围" })).toHaveCount(0);

  const marketplacePopover = page.locator(".filter-popover").first();
  await marketplacePopover.locator("summary").click();
  await marketplacePopover.getByLabel("BE", { exact: true }).check();
  await page.locator("#intermediate-title").click();
  await expect(marketplacePopover).not.toHaveAttribute("open", "");
  await page.locator(".intermediate-results").getByRole("button", { name: "应用筛选" }).click();
  await expect.poll(() => lastListUrl).toContain("marketplaces=BE");
  await expect(page.getByRole("link", { name: "导出当前筛选" })).toHaveAttribute("href", /marketplaces=BE/u);

  await page.locator("details.field-picker > summary").click();
  const descriptionField = page.locator("details.field-picker").getByLabel("交易说明", { exact: true });
  await descriptionField.focus();
  await descriptionField.press("Space");
  await expect(page.getByRole("columnheader", { name: "交易说明" })).toHaveCount(0);
  await page.locator("#intermediate-title").click();
  await expect(page.locator("details.field-picker")).not.toHaveAttribute("open", "");

  await page.getByRole("button", { name: "配送货件" }).click();
  await expect(page.locator(".table-footer-actions")).toContainText("8,960.25");

  await page.goto(`/shops/${shopId}/workflow/publish`);
  await expect(page).toHaveURL(new RegExp(`/shops/${shopId}/workflow/calculate$`));

  const evidenceDirectory = resolve(".work/evidence/calculation-workbench");
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDirectory, `${testInfo.project.name}.png`), fullPage: true });
});

test("旧发布地址进入计算复核，并在当前页面确认资料缺失", async ({ page }) => {
  const batchId = "20000000-0000-4000-8000-000000000029";
  let acknowledged = 0;
  let confirmed = 0;
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/api/v1/shops", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([shop]) }));
  await page.route(`**/api/v1/shops/${shopId}/workflow`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    shop: { id: shopId, name: shop.name, access: "ENTERPRISE", status: "ACTIVE", canEdit: true },
    diagnosticId: "I0000000000000000000029",
    currentStep: "COMMIT",
    latestBatch: { id: batchId, status: "FAILED", stage: "CALCULATION_BLOCKED", failureCode: "HARD_INCOMPLETE_CONFIRMATION_REQUIRED" },
    steps: [
      { code: "RECEIVE", state: "COMPLETED" }, { code: "PREFLIGHT", state: "COMPLETED" }, { code: "COMMIT", state: "IN_PROGRESS" },
      { code: "CALCULATE", state: "NOT_STARTED" }, { code: "PUBLISH", state: "NOT_STARTED" }, { code: "EXPORT", state: "NOT_STARTED" },
    ].map((step) => ({ ...step, label: step.code, severity: step.code === "COMMIT" ? "BLOCKING" : "NONE", progress: step.state === "COMPLETED" ? "100" : "0", warningCount: 0, blockingCount: step.code === "COMMIT" ? 1 : 0, clickable: step.code !== "EXPORT" })),
    download: { available: false, usesPreviousPublishedVersion: false },
  }) }));
  await page.route("**/api/v1/me/onboarding**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dismissed: true }) }));
  await page.route("**/api/v1/imports/completeness?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
    { sliceId: "slice-be", datasetVersionId: "version-be", marketplace: "BE", month: "2026-05", state: "MISSING_SHIPMENT", missingReports: ["SHIPMENT"] },
  ]) }));
  await page.route(`**/api/v1/imports/shops/${shopId}/issues/*/acknowledge`, (route) => {
    acknowledged += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id: "version-be", status: "ACKNOWLEDGED" }) });
  });
  await page.route(`**/api/v1/imports/shops/${shopId}/batches/${batchId}/confirm`, (route) => {
    confirmed += 1;
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: batchId, status: "PROCESSING" }) });
  });

  await page.goto(`/shops/${shopId}/workflow/publish`);
  await expect(page).toHaveURL(new RegExp(`/shops/${shopId}/workflow/calculate$`));
  const blocker = page.getByRole("alertdialog", { name: "资料缺失，等待处理" });
  await expect(blocker).toContainText("I0000000000000000000029");
  await blocker.getByRole("button", { name: "我知道了" }).click();
  await expect(page.getByRole("heading", { name: "资料缺失，确认后继续" })).toBeVisible();
  await expect(page.getByRole("region", { name: "计算复核缺失资料" })).toContainText("BE");
  await page.getByRole("button", { name: "确认排除并继续" }).click();
  await expect.poll(() => acknowledged).toBe(1);
  await expect.poll(() => confirmed).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/shops/${shopId}/workflow/calculate$`));
});
