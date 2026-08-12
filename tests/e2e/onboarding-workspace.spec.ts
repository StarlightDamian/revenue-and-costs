import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const me = {
  id: "50000000-0000-4000-8000-000000000001",
  phoneMasked: "138****0000",
  displayName: "首次登录做账员",
  avatarId: 24,
  roles: ["ACCOUNTANT"],
  theme: "comfort",
  customerShopCount: 0,
};

test("关闭新手引导后首次登录仍可直接使用工作台", async ({ page }, testInfo) => {
  let onboardingRequests = 0;
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...me, isFirstLogin: true }) }));
  await page.route("**/api/v1/enterprises", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/v1/shops**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/v1/me/onboarding**", (route) => {
    onboardingRequests += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dismissed: false }) });
  });

  await page.goto("/workspace");
  const guide = page.locator("body > .onboarding-overlay");
  await expect(guide).toHaveCount(0);
  expect(onboardingRequests).toBe(0);
  await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();
  await expect(page.getByRole("link", { name: "前往处理" })).toHaveAttribute("href", "/organization/enterprise");

  const evidenceDirectory = resolve(".work/evidence/onboarding-workspace");
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDirectory, `${testInfo.project.name}.png`), fullPage: true });
});
