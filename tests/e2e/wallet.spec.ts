import { expect, test } from "@playwright/test";

const accountId = "50000000-0000-4000-8000-000000000071";
const enterpriseId = "60000000-0000-4000-8000-000000000071";
const shopId = "10000000-0000-4000-8000-000000000071";

test("企业钱包一键充值且账本说明来自真实公司引用", async ({ page }) => {
  let quoteRequests = 0;
  let rechargeRequests = 0;
  let submittedCents = "";

  await page.route("**/api/v1/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      id: accountId,
      phoneMasked: "166****0256",
      displayName: "钱包验收做账员",
      avatarId: 24,
      roles: ["ACCOUNTANT"],
      theme: "comfort",
      customerShopCount: 0,
      isFirstLogin: false,
    }),
  }));
  await page.route("**/api/v1/enterprises", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([{
      id: enterpriseId,
      createdByAccountId: accountId,
      name: "钱包验收企业",
      unifiedSocialCreditCode: "91310110MA1G5X1R2X",
      profileComplete: true,
      memberCount: 1,
      companyCount: 1,
      notStartedCount: 1,
      submittedCount: 0,
      wallet: { id: "61000000-0000-4000-8000-000000000071", balanceCents: "981200", status: "ACTIVE" },
      canEditName: true,
      canEditCreditCode: false,
    }]),
  }));
  await page.route("**/api/v1/payments/ledger?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify([{
      id: "41",
      type: "SHOP_CHARGE",
      amountCents: "-18800",
      balanceAfterCents: "981200",
      occurredAt: "2026-08-10T12:48:55.372Z",
      reference: { type: "SHOP", id: shopId, name: "香港公司名称", status: "TRASHED" },
    }]),
  }));
  await page.route("**/api/v1/payments/quote", (route) => {
    quoteRequests += 1;
    return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "QUOTE_SHOULD_NOT_BE_CALLED", message: "不应调用报价接口" }) });
  });
  await page.route("**/api/v1/payments/manual/orders", async (route) => {
    rechargeRequests += 1;
    submittedCents = String((route.request().postDataJSON() as { creditAmountCents?: string }).creditAmountCents ?? "");
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ orderId: "20000000-0000-4000-8000-000000000071", status: "PAID" }),
    });
  });

  await page.goto("/wallet");

  const amount = page.getByRole("textbox", { name: "充值金额（元）" });
  await expect(amount).toHaveValue("");
  await expect(amount).toHaveAttribute("placeholder", "10000.00");
  await expect(page.getByRole("button", { name: "获取报价" })).toHaveCount(0);
  await expect(page.getByText("公司：香港公司名称（回收站）", { exact: true })).toBeVisible();

  const recharge = page.getByRole("button", { name: "充值", exact: true });
  await recharge.click();
  await expect(page.getByRole("alert")).toContainText("金额必须是最多两位小数的非负十进制数");
  expect(rechargeRequests).toBe(0);
  await expect(recharge).toBeEnabled();

  await amount.fill("10000.00");
  await expect(amount).toHaveValue("10000.00");
  await recharge.evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => rechargeRequests).toBe(1);
  expect(submittedCents).toBe("1000000");
  expect(quoteRequests).toBe(0);
  await expect(amount).toHaveValue("");
});
