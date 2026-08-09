import { expect, test } from "@playwright/test";

test("未受邀的新手机号登录后进入姓名可选的注册流程", async ({ page }) => {
  await page.route("**/api/v1/auth/otp", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          challengeId: "00000000-0000-4000-8000-000000000001",
          sandboxCode: "246810",
        },
      }),
    });
  });
  await page.route("**/api/v1/auth/verify", async (route) => {
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "ACCOUNT_NOT_REGISTERED", message: "该手机号尚未注册，请先注册账号" }),
    });
  });

  await page.goto("/login?returnTo=/sales-cost");
  await page.getByLabel("手机号码").fill("13800000000");
  await page.getByRole("button", { name: "获取验证码" }).click();
  await page.getByPlaceholder("输入验证码").fill("246810");
  await page.getByRole("button", { name: "登录并进入工作台" }).click();

  await expect(page.getByRole("heading", { name: "注册做账员" })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("该手机号尚未注册，已切换到注册。姓名可以不填，请重新获取验证码。");
  await expect(page.getByLabel("姓名（选填）")).toBeVisible();
  await expect(page.getByPlaceholder("输入验证码")).toHaveValue("");
  await expect(page.getByRole("button", { name: "获取验证码" })).toBeEnabled();
});
