import type { Me, Shop } from "./api/types";

export interface NavigationItem {
  label: string;
  marker: string;
  to: string;
  adminOnly?: boolean;
}

export interface NavigationGroup {
  id: string;
  label: string;
  marker: string;
  description: string;
  items: NavigationItem[];
}

export type ShopPageCapability = "RESULTS" | "MANAGE_IMPORT" | "EXPORT";

export function hasPlatformRole(me: Me | null, role: Me["roles"][number]): boolean {
  return Boolean(me?.roles.includes(role));
}

export function deriveNavigation(me: Me | null, hasEnterprise = true): NavigationGroup[] {
  const admin = hasPlatformRole(me, "ADMIN");
  const organizationItems: NavigationItem[] = [
    { label: hasEnterprise || admin ? "企业与成员" : "创建企业", marker: hasEnterprise || admin ? "企" : "建", to: "/organization/enterprise" },
    ...(hasEnterprise || admin ? [{ label: "企业钱包", marker: "钱", to: "/wallet" }] : []),
    { label: "账号设置", marker: "号", to: "/account" },
  ];
  return [
    { id: "workspace", label: "工作台", marker: "台", description: "概览与当前进度", items: [{ label: "概览", marker: "览", to: "/workspace" }] },
    { id: "sales-cost", label: "销售成本", marker: "成", description: "公司与做账入口", items: [{ label: "公司与做账", marker: "账", to: "/sales-cost" }] },
    { id: "data-rules", label: "数据与规则", marker: "规", description: "做账参数与汇率", items: [{ label: "做账习惯", marker: "习", to: "/accounting-habits" }, { label: "外汇市场", marker: "汇", to: "/fx" }] },
    { id: "organization", label: "组织与账号", marker: "组", description: "企业、成员与账号", items: organizationItems },
    ...(admin ? [{ id: "platform", label: "平台管理", marker: "管", description: "平台治理与运营", items: [
      { label: "做账员", marker: "员", to: "/admin/users", adminOnly: true }, { label: "应用", marker: "应", to: "/admin/apps", adminOnly: true }, { label: "运营状态", marker: "运", to: "/admin/operations", adminOnly: true },
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
