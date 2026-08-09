import type { Me, Shop } from "./api/types";

export interface NavigationItem {
  label: string;
  to: string;
  adminOnly?: boolean;
}

export interface NavigationGroup {
  label: string;
  items: NavigationItem[];
}

export type ShopPageCapability = "RESULTS" | "MANAGE_IMPORT" | "EXPORT";

export function hasPlatformRole(me: Me | null, role: Me["roles"][number]): boolean {
  return Boolean(me?.roles.includes(role));
}

export function deriveNavigation(me: Me | null, hasEnterprise = true): NavigationGroup[] {
  const admin = hasPlatformRole(me, "ADMIN");
  const organizationItems: NavigationItem[] = [
    { label: hasEnterprise || admin ? "企业与成员" : "创建企业", to: "/organization/enterprise" },
    ...(hasEnterprise || admin ? [{ label: "企业钱包", to: "/wallet" }] : []),
    { label: "账号设置", to: "/account" },
  ];
  return [
    { label: "工作台", items: [{ label: "概览", to: "/workspace" }] },
    { label: "销售成本", items: [{ label: "公司与做账", to: "/sales-cost" }] },
    { label: "数据与规则", items: [{ label: "做账习惯", to: "/accounting-habits" }, { label: "外汇市场", to: "/fx" }] },
    { label: "组织与账号", items: organizationItems },
    ...(admin ? [{ label: "平台管理", items: [
      { label: "做账员", to: "/admin/users", adminOnly: true }, { label: "应用", to: "/admin/apps", adminOnly: true }, { label: "运营状态", to: "/admin/operations", adminOnly: true },
    ] }] : []),
  ];
}

export function canAccessShopPage(shop: Shop | undefined, capability: ShopPageCapability): boolean {
  if (!shop) return false;
  if (shop.status === "TRASHED") return false;
  if (capability === "MANAGE_IMPORT" && shop.status !== "ACTIVE") return false;
  if (shop.access !== "CUSTOMER") return true;
  if (capability === "MANAGE_IMPORT") return false;
  if (capability === "RESULTS") return true;
  return Boolean(shop.publishedSnapshot && shop.customerExportAllowed === true);
}
