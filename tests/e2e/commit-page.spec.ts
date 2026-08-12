import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const shopId = "10000000-0000-4000-8000-000000000009";
const batchId = "20000000-0000-4000-8000-000000000009";
const enterpriseId = "60000000-0000-4000-8000-000000000009";

const me = {
  id: "50000000-0000-4000-8000-000000000001",
  phoneMasked: "138****0000",
  displayName: "浏览器验收做账员",
  avatarId: 24,
  roles: ["ACCOUNTANT"],
  theme: "comfort",
  customerShopCount: 0,
  isFirstLogin: false,
};

const preview = {
  id: batchId,
  status: "FAILED",
  progress: "0",
  stage: "CALCULATION_BLOCKED",
  failureCode: "HARD_INCOMPLETE_CONFIRMATION_REQUIRED",
  files: [
    { id: "file-1", relativePath: "US/transaction.csv", bytes: "1024", classification: "TRANSACTION", status: "PARSED" },
    { id: "file-2", relativePath: "US/shipment.csv", bytes: "1024", classification: "SHIPMENT", status: "PARSED" },
    { id: "file-3", relativePath: "notes.pdf", bytes: "512", classification: "LIST_ONLY", status: "LIST_ONLY" },
    { id: "file-4", relativePath: "unknown.csv", bytes: "256", classification: "UNKNOWN", status: "EXCLUDED_UNKNOWN_STRUCTURE" },
  ],
  ignored: [
    { relativePath: "notes.pdf", reason: "LIST_ONLY" },
    { relativePath: "unknown.csv", reason: "UNKNOWN_STRUCTURE" },
  ],
  issues: [{ id: "issue-1", kind: "UNKNOWN_STRUCTURE_EXCLUDED", severity: "WARNING", count: 1, exactCount: true, message: "未识别文件结构，文件已过滤", action: "请检查源文件。" }],
  affectedVersions: [],
};

const completeness = [
  { sliceId: "slice-sa", datasetVersionId: "version-sa", marketplace: "SA", month: "2025-09", state: "MISSING_SHIPMENT", missingReports: ["TRANSACTION", "SHIPMENT"] },
  { sliceId: "slice-be", datasetVersionId: "version-be", marketplace: "BE", month: "2025-10", state: "MISSING_TRANSACTION", missingReports: ["TRANSACTION"] },
  { sliceId: "slice-us", datasetVersionId: "version-us", marketplace: "US", month: "2025-10", state: "COMPLETE", missingReports: [] },
  { sliceId: "slice-ae", datasetVersionId: "version-ae", marketplace: "AE", month: "2025-11", state: "MISSING_SHIPMENT", missingReports: ["SHIPMENT"] },
];

test("资料准备页只展示缺失月份，并在当前页确认阻断", async ({ page }, testInfo) => {
  let acknowledged = 0;
  let confirmed = 0;
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/api/v1/shops", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{
    id: shopId, enterpriseId, createdByAccountId: me.id, lastOperatedByAccountId: me.id,
    name: "测试9", access: "ENTERPRISE", accountingStatus: "NOT_STARTED", status: "ACTIVE", termStart: "2026-08-02", termEndExclusive: "2027-08-02", renameAvailable: true,
  }]) }));
  await page.route(`**/api/v1/shops/${shopId}/workflow`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    shop: { id: shopId, name: "测试9", access: "ENTERPRISE", status: "ACTIVE", canEdit: true },
    diagnosticId: "I0000000000000000000009",
    currentStep: "COMMIT",
    steps: ["RECEIVE", "PREFLIGHT", "COMMIT", "CALCULATE", "PUBLISH", "EXPORT"].map((code, index) => ({
      code,
      label: ["数据接收", "预检解析", "确认入库", "业务计算", "结果发布", "报告下载"][index],
      state: index < 2 ? "COMPLETED" : index === 2 ? "IN_PROGRESS" : "NOT_STARTED",
      severity: index === 2 ? "BLOCKING" : "NONE",
      progress: index === 2 ? null : index < 2 ? "100" : "0",
      warningCount: 0,
      blockingCount: index === 2 ? 3 : 0,
      clickable: index <= 2,
    })),
    latestBatch: { id: batchId, status: "FAILED", stage: "CALCULATION_BLOCKED", failureCode: "HARD_INCOMPLETE_CONFIRMATION_REQUIRED" },
    download: { available: false, usesPreviousPublishedVersion: false },
  }) }));
  await page.route(`**/api/v1/imports/shops/${shopId}/batches/*`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(preview) }));
  await page.route("**/api/v1/imports/completeness?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(completeness) }));
  await page.route(`**/api/v1/imports/shops/${shopId}/issues/*/acknowledge`, (route) => {
    acknowledged += 1;
    return route.fulfill({ status: 204 });
  });
  await page.route(`**/api/v1/imports/shops/${shopId}/batches/${batchId}/confirm`, (route) => {
    confirmed += 1;
    return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ id: batchId, status: "PROCESSING" }) });
  });

  await page.goto(`/shops/${shopId}/workflow/commit`);

  const blocker = page.getByRole("alertdialog", { name: "资料缺失，等待处理" });
  await expect(blocker).toContainText("I0000000000000000000009");
  await blocker.getByRole("button", { name: "我知道了" }).click();
  await expect(page.getByRole("heading", { name: "资料准备" })).toBeVisible();
  await expect(page.locator("input[webkitdirectory]")).toHaveCount(1);
  await expect(page.getByText("选择文件夹", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "拖放文件夹或文件" })).toContainText("拖入文件夹");
  await expect(page.getByRole("heading", { name: "站点 × 月份资料完整性" })).toBeVisible();
  await expect(page.locator(".commit-summary > div").filter({ hasText: "可识别文件" })).toContainText("2");
  await expect(page.locator(".commit-summary > div").filter({ hasText: "过滤文件" })).toContainText("2");
  const table = page.getByRole("region", { name: "站点月份资料完整性" });
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.locator("tbody tr").first()).toHaveAttribute("data-missing", "true");
  await expect(table.locator(".missing-data-chip")).toHaveCount(3);
  await expect(table.locator(".missing-data-chip").nth(0)).toContainText("缺少交易报告、配送货件");
  await expect(table.locator(".missing-data-chip").nth(1)).toContainText("缺少交易报告");
  await expect(table.locator(".missing-data-chip").nth(2)).toContainText("缺少配送货件");
  await expect(table).not.toContainText("US");
  await expect(page.getByRole("heading", { name: "需要确认排除缺失切片" })).toBeVisible();
  await expect(page.locator(".workflow-commit-panel > .commit-coverage-table table")).toHaveCount(1);
  await expect(page.locator("details.preflight-detail")).not.toHaveAttribute("open", "");

  await page.getByRole("button", { name: "确认排除并继续" }).click();
  await expect.poll(() => acknowledged).toBe(3);
  await expect.poll(() => confirmed).toBe(1);
  await expect(page).toHaveURL(new RegExp(`/shops/${shopId}/workflow/commit`));

  await page.goto(`/shops/${shopId}/workflow/receive`);
  await expect(page).toHaveURL(new RegExp(`/shops/${shopId}/workflow/commit$`));

  const evidenceDirectory = resolve(".work/evidence/commit-single-page");
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDirectory, `${testInfo.project.name}.png`), fullPage: true });
});

test("资料完整时不展示月份行，并给出两类报告齐全反馈", async ({ page }) => {
  const completePreview = { ...preview, status: "PUBLISHED", stage: "RESULT_PUBLISHED", failureCode: null };
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/api/v1/shops", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{
    id: shopId, enterpriseId, createdByAccountId: me.id, lastOperatedByAccountId: me.id,
    name: "测试9", access: "ENTERPRISE", accountingStatus: "SUBMITTED", status: "ACTIVE", termStart: "2026-08-02", termEndExclusive: "2027-08-02", renameAvailable: true,
  }]) }));
  await page.route(`**/api/v1/shops/${shopId}/workflow`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    shop: { id: shopId, name: "测试9", access: "ENTERPRISE", status: "ACTIVE", canEdit: true },
    currentStep: "PUBLISH",
    steps: ["RECEIVE", "PREFLIGHT", "COMMIT", "CALCULATE", "PUBLISH", "EXPORT"].map((code, index) => ({
      code, label: code, state: index < 5 ? "COMPLETED" : "NOT_STARTED", severity: "NONE", progress: index < 5 ? "100" : "0", warningCount: 0, blockingCount: 0, clickable: true,
    })),
    latestBatch: { id: batchId, status: "PUBLISHED", stage: "RESULT_PUBLISHED", failureCode: null },
    download: { available: false, usesPreviousPublishedVersion: false },
  }) }));
  await page.route("**/api/v1/me/onboarding**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dismissed: true }) }));
  await page.route(`**/api/v1/imports/shops/${shopId}/batches/*`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(completePreview) }));
  await page.route("**/api/v1/imports/completeness?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([
    { sliceId: "slice-us", datasetVersionId: "version-us", marketplace: "US", month: "2025-10", state: "COMPLETE", missingReports: [] },
  ]) }));

  await page.goto(`/shops/${shopId}/workflow/commit`);
  await expect(page.getByRole("region", { name: "站点月份资料完整性" })).toHaveCount(0);
  const completeState = page.locator(".workflow-commit-panel .warning-panel[data-tone='success']").filter({ hasText: "资料已齐全" });
  await expect(completeState.getByText("资料已齐全", { exact: true })).toBeVisible();
  await expect(completeState.getByText("当前站点与月份均同时包含交易报告和配送货件，可以继续核算。", { exact: true })).toBeVisible();
});

test("上传前可连续追加文件夹和文件，并以最后一次选择解决同路径冲突", async ({ page }, testInfo) => {
  let uploadBatchRequests = 0;
  let uploadedPaths: string[] = [];
  let failNextChunk = true;
  let restoredPreviewRequests = 0;
  let releaseRestoredPreview!: () => void;
  const restoredPreviewGate = new Promise<void>((resolveGate) => { releaseRestoredPreview = resolveGate; });
  const restoredPreview = { id: batchId, status: "READY", progress: "100", stage: "PREFLIGHT_READY", failureCode: null, files: [], ignored: [], issues: [], affectedVersions: [] };
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/api/v1/shops", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([{
    id: shopId, enterpriseId, createdByAccountId: me.id, lastOperatedByAccountId: me.id,
    name: "测试9", access: "ENTERPRISE", accountingStatus: "NOT_STARTED", status: "ACTIVE", termStart: "2026-08-02", termEndExclusive: "2027-08-02", renameAvailable: true,
  }]) }));
  await page.route(`**/api/v1/shops/${shopId}/workflow`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
    shop: { id: shopId, name: "测试9", access: "ENTERPRISE", status: "ACTIVE", canEdit: true },
    diagnosticId: "I0000000000000000000010",
    currentStep: "RECEIVE",
    steps: [],
    latestBatch: null,
    download: { available: false, usesPreviousPublishedVersion: false },
  }) }));
  await page.route(`**/api/v1/imports/shops/${shopId}/batches/latest`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(restoredPreview) }));
  await page.route("**/api/v1/uploads/batches", async (route) => {
    uploadBatchRequests += 1;
    if (uploadBatchRequests === 1) {
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "TEMPORARY_UNAVAILABLE", message: "temporary unavailable" }) });
    }
    const payload = route.request().postDataJSON() as { files?: Array<{ relativePath: string }> };
    uploadedPaths = (payload.files ?? []).map((file) => file.relativePath);
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({
      id: batchId,
      files: (payload.files ?? []).map((file, index) => ({ id: `file-${index}`, relativePath: file.relativePath, offset: "0" })),
    }) });
  });
  await page.route("**/api/v1/uploads/files/*", (route) => {
    if (route.request().method() === "HEAD") {
      return route.fulfill({ status: 204, headers: { "Upload-Offset": "0", "Tus-Resumable": "1.0.0" } });
    }
    if (route.request().method() !== "PATCH") return route.fallback();
    if (failNextChunk) {
      failNextChunk = false;
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "TEMPORARY_UNAVAILABLE", message: "temporary unavailable" }) });
    }
    const headers = route.request().headers();
    const offset = Number(headers["upload-offset"] ?? "0");
    const bytes = Number(headers["upload-uncompressed-length"] ?? route.request().postDataBuffer()?.length ?? 0);
    return route.fulfill({ status: 204, headers: { "Upload-Offset": String(offset + bytes), "Tus-Resumable": "1.0.0" } });
  });
  await page.route(`**/api/v1/uploads/batches/${batchId}/complete`, (route) => route.fulfill({
    status: 202,
    contentType: "application/json",
    body: JSON.stringify({ id: batchId, status: "QUEUED" }),
  }));
  await page.route(`**/api/v1/imports/shops/${shopId}/batches/${batchId}`, async (route) => {
    restoredPreviewRequests += 1;
    if (restoredPreviewRequests === 1) await restoredPreviewGate;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(restoredPreview) });
  });
  await page.route("**/api/v1/imports/completeness?**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

  const usFolder = testInfo.outputPath("US");
  const deFolder = testInfo.outputPath("DE");
  await mkdir(usFolder, { recursive: true });
  await mkdir(deFolder, { recursive: true });
  await writeFile(resolve(usFolder, "transaction.csv"), "one");
  await writeFile(resolve(deFolder, "transaction.csv"), "three");
  await writeFile(resolve(deFolder, "shipment.csv"), "four");

  await page.goto(`/shops/${shopId}/workflow/commit`);
  const folderInput = page.locator('input[webkitdirectory]');
  const fileInput = page.locator('input[type="file"]:not([webkitdirectory])');

  await expect.poll(() => restoredPreviewRequests).toBe(1);
  await expect(folderInput).toBeDisabled();
  await expect(fileInput).toBeDisabled();
  releaseRestoredPreview();
  await expect(folderInput).toBeEnabled();
  await expect(fileInput).toBeEnabled();
  await expect(page.getByRole("heading", { name: "当前批次" })).toBeVisible();

  await folderInput.setInputFiles(usFolder);

  await expect(page.getByRole("button", { name: "开始上传" })).toBeVisible();
  await expect(folderInput).toHaveValue("");
  expect(uploadBatchRequests).toBe(0);

  await folderInput.setInputFiles(deFolder);
  await writeFile(resolve(usFolder, "transaction.csv"), "replaced");
  await folderInput.setInputFiles(usFolder);
  await expect(page.locator('p.action-help[role="status"]')).toContainText("替换 1 个同路径文件");
  await fileInput.setInputFiles({ name: "notes.pdf", mimeType: "application/pdf", buffer: Buffer.from("metadata") });

  await expect(folderInput).toHaveValue("");
  await expect(fileInput).toHaveValue("");
  await expect(page.locator(".selection-summary")).toContainText("4 个文件");
  await expect(page.getByRole("region", { name: "待上传文件" })).toContainText("DE/transaction.csv");
  await expect(page.getByRole("region", { name: "待上传文件" })).toContainText("notes.pdf");
  await expect(page.getByRole("region", { name: "待上传文件" }).locator("div").filter({ hasText: "US/transaction.csv" })).toContainText("8 B");
  expect(uploadBatchRequests).toBe(0);

  await page.getByRole("button", { name: "开始上传" }).click();
  await expect.poll(() => uploadBatchRequests).toBe(1);
  await expect(page.getByRole("button", { name: "重试开始上传" })).toBeVisible();
  await page.getByRole("button", { name: "重试开始上传" }).click();
  await expect.poll(() => uploadBatchRequests).toBe(2);
  await expect(page.getByRole("button", { name: "继续上传" })).toBeVisible();
  await expect(folderInput).toBeDisabled();
  await expect(fileInput).toBeDisabled();
  expect([...uploadedPaths].sort()).toEqual(["US/transaction.csv", "DE/transaction.csv", "DE/shipment.csv", "notes.pdf"].sort());
  await page.getByRole("button", { name: "继续上传" }).click();
  await expect(page.getByRole("heading", { name: "当前批次" })).toBeVisible();
  expect(uploadBatchRequests).toBe(2);
});
