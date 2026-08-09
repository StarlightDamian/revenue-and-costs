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

test("无企业做账员只在首次登录会话看到三步引导", async ({ page }, testInfo) => {
  let dismissed = false;
  let isFirstLogin = true;
  await page.route("**/api/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...me, isFirstLogin }) }));
  await page.route("**/api/v1/enterprises", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/v1/shops**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/v1/me/onboarding**", async (route) => {
    if (route.request().method() === "PATCH") dismissed = Boolean((route.request().postDataJSON() as { dismissed?: boolean }).dismissed);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ dismissed }) });
  });

  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "第一次使用" })).toBeVisible();
  const guide = page.locator("body > .onboarding-overlay");
  await expect(guide).toHaveCSS("position", "fixed");
  await expect(guide.getByRole("heading", { level: 3 })).toHaveText(["创建企业", "创建公司", "开始做账"]);
  await expect(guide.getByAltText("水彩动物引导角色")).toHaveCount(3);
  await expect(page.getByRole("heading", { name: "工作台" })).toBeVisible();
  const navigation = page.getByRole("navigation");
  if ((page.viewportSize()?.width ?? 1440) <= 1180) await page.getByRole("button", { name: "菜单" }).click();
  await expect(navigation.getByRole("link", { name: "创建企业" })).toBeVisible();
  await expect(navigation.getByRole("link", { name: "企业钱包" })).toHaveCount(0);
  if ((page.viewportSize()?.width ?? 1440) <= 1180) {
    await page.getByRole("button", { name: "关闭导航" }).click({ position: { x: (page.viewportSize()?.width ?? 390) - 8, y: 120 } });
  }

  await page.getByRole("button", { name: "跳过引导" }).click();
  await expect(guide).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重新查看引导" })).toHaveCount(0);
  isFirstLogin = false;
  await page.reload();
  await expect(page.getByRole("heading", { name: "第一次使用" })).toHaveCount(0);

  const evidenceDirectory = resolve(".work/evidence/onboarding-workspace");
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDirectory, `${testInfo.project.name}.png`), fullPage: true });
});
