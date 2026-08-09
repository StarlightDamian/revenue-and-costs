import { describe, expect, it } from "vitest";
import { canAccessShopPage, deriveNavigation, hasPlatformRole } from "../../src/web/navigation";
import type { Me, Shop } from "../../src/web/api/types";

function me(roles: Me["roles"], customerShopCount = 0): Me {
  return { id: "00000000-0000-4000-8000-000000000001", phoneMasked: "138****0000", avatarId: 1, roles, theme: "comfort", customerShopCount, isFirstLogin: false };
}

describe("single-role navigation", () => {
  it("keeps customer relationships independent from the accountant platform role", () => {
    const account = me(["ACCOUNTANT"], 2);
    expect(hasPlatformRole(account, "ACCOUNTANT")).toBe(true);
    expect(deriveNavigation(account, true).map((group) => group.label)).toEqual(["工作台", "销售成本", "数据与规则", "组织与账号"]);
  });

  it("gives administrators sales, FX, and governance navigation without user billing features", () => {
    const account = me(["ADMIN"]);
    expect(deriveNavigation(account, true).map((group) => group.label)).toEqual(["工作台", "销售成本", "数据与规则", "组织与账号", "平台管理"]);
  });

  it("keeps the no-enterprise state focused on creating an enterprise", () => {
    const groups = deriveNavigation(me(["ACCOUNTANT"]), false);
    expect(groups.flatMap((group) => group.items).map((item) => item.label)).not.toContain("企业钱包");
    expect(groups.flatMap((group) => group.items).map((item) => item.label)).toContain("创建企业");
  });

  it("keeps customer shop pages read-only and hides ungranted export", () => {
    const published = { id: "snapshot-1", publishedAt: "2026-07-28T00:00:00.000Z", stale: false };
    const customer: Shop = {
      id: "shop-customer", name: "授权店铺", access: "CUSTOMER", status: "ACTIVE",
      enterpriseId: "enterprise-1", createdByAccountId: "account-1", lastOperatedByAccountId: "account-1", accountingStatus: "SUBMITTED",
      termStart: "2026-01-01", termEndExclusive: "2027-01-01", renameAvailable: false,
      publishedSnapshot: published, customerExportAllowed: false,
    };
    expect(canAccessShopPage(customer, "RESULTS")).toBe(true);
    expect(canAccessShopPage(customer, "MANAGE_IMPORT")).toBe(false);
    expect(canAccessShopPage(customer, "EXPORT")).toBe(false);
    expect(canAccessShopPage({ ...customer, customerExportAllowed: true }, "EXPORT")).toBe(true);
    const { publishedSnapshot, ...withoutSnapshot } = customer;
    expect(publishedSnapshot).toBeDefined();
    expect(canAccessShopPage(withoutSnapshot, "RESULTS")).toBe(true);
    expect(canAccessShopPage(undefined, "RESULTS")).toBe(false);
  });

  it("allows owners and administrators to reach management pages", () => {
    const base: Omit<Shop, "access"> = {
      id: "shop-owned", name: "自有店铺", status: "ACTIVE", termStart: "2026-01-01",
      enterpriseId: "enterprise-1", createdByAccountId: "account-1", lastOperatedByAccountId: "account-1", accountingStatus: "NOT_STARTED",
      termEndExclusive: "2027-01-01", renameAvailable: true,
    };
    for (const access of ["ENTERPRISE", "ADMIN"] as const) {
      expect(canAccessShopPage({ ...base, access }, "RESULTS")).toBe(true);
      expect(canAccessShopPage({ ...base, access }, "MANAGE_IMPORT")).toBe(true);
      expect(canAccessShopPage({ ...base, access }, "EXPORT")).toBe(true);
      expect(canAccessShopPage({ ...base, access, status: "EXPIRED" }, "MANAGE_IMPORT")).toBe(false);
      expect(canAccessShopPage({ ...base, access, status: "EXPIRED" }, "RESULTS")).toBe(true);
      expect(canAccessShopPage({ ...base, access, status: "TRASHED" }, "RESULTS")).toBe(false);
    }
  });
});
