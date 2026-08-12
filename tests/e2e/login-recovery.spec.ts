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

test("注册验证码只消费一次并直接进入原目标工作台", async ({ page }) => {
  let registered = false;
  let verifyRequests = 0;
  let otpPurpose = "";
  const me = {
    id: "10000000-0000-4000-8000-000000000001",
    phoneMasked: "+86 138****0000",
    displayName: "新做账员",
    avatarId: 24,
    roles: ["ACCOUNTANT"],
    theme: "comfort",
    customerShopCount: 0,
    isFirstLogin: true,
  };
  await page.route("**/api/v1/me", (route) => route.fulfill(registered
    ? { status: 200, contentType: "application/json", body: JSON.stringify(me) }
    : { status: 401, contentType: "application/json", body: JSON.stringify({ code: "SESSION_REQUIRED", message: "请先登录" }) }));
  await page.route("**/api/v1/auth/otp", async (route) => {
    otpPurpose = String((route.request().postDataJSON() as { purpose?: string }).purpose ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ data: { challengeId: "00000000-0000-4000-8000-000000000001", sandboxCode: "246810" } }),
    });
  });
  await page.route("**/api/v1/auth/register", async (route) => {
    registered = true;
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ isFirstLogin: true }) });
  });
  await page.route("**/api/v1/auth/verify", async (route) => {
    verifyRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "UNEXPECTED_LOGIN", message: "注册后不应二次登录" }) });
  });
  await page.route("**/api/v1/enterprises", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/v1/shops**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/v1/apps", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

  await page.goto("/login?returnTo=/sales-cost");
  await page.getByRole("button", { name: "注册账号" }).click();
  await page.getByLabel("手机号码").fill("13800000000");
  await page.getByLabel("姓名（选填）").fill("新做账员");
  await page.getByRole("button", { name: "获取验证码" }).click();
  await page.getByPlaceholder("输入验证码").fill("246810");
  await page.getByRole("button", { name: "完成注册" }).click();

  await expect(page).toHaveURL(/\/sales-cost$/u);
  await expect(page.getByRole("heading", { name: "销售成本" })).toBeVisible();
  expect(otpPurpose).toBe("REGISTER");
  expect(verifyRequests).toBe(0);
});

test("登录页明确选择的主题进入工作台后保持并同步账号偏好", async ({ page }) => {
  let authenticated = false;
  let accountTheme = "comfort";
  const syncedThemes: string[] = [];
  const me = () => ({
    id: "10000000-0000-4000-8000-000000000002",
    phoneMasked: "+86 138****0000",
    displayName: "主题测试账号",
    avatarId: 24,
    roles: ["ACCOUNTANT"],
    theme: accountTheme,
    customerShopCount: 0,
    isFirstLogin: false,
  });

  await page.route("**/api/v1/me", (route) => route.fulfill(authenticated
    ? { status: 200, contentType: "application/json", body: JSON.stringify(me()) }
    : { status: 401, contentType: "application/json", body: JSON.stringify({ code: "SESSION_REQUIRED", message: "请先登录" }) }));
  await page.route("**/api/v1/me/theme", async (route) => {
    const body = route.request().postDataJSON() as { themeId: string };
    syncedThemes.push(body.themeId);
    accountTheme = body.themeId;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me()) });
  });
  await page.route("**/api/v1/auth/otp", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ data: { challengeId: "00000000-0000-4000-8000-000000000002", sandboxCode: "246810" } }),
  }));
  await page.route("**/api/v1/auth/verify", async (route) => {
    authenticated = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/v1/enterprises", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/v1/shops**", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
  await page.route("**/api/v1/apps", (route) => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));

  await page.goto("/login?returnTo=/sales-cost");
  await page.getByRole("button", { name: "深色" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByLabel("手机号码").fill("13800000000");
  await page.getByRole("button", { name: "获取验证码" }).click();
  await page.getByPlaceholder("输入验证码").fill("246810");
  await page.getByRole("button", { name: "登录并进入工作台" }).click();

  await expect(page).toHaveURL(/\/sales-cost$/u);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(() => syncedThemes).toEqual(["dark"]);
});
