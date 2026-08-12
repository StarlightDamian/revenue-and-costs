import { createRouter, createWebHistory, type RouteLocationNormalized } from "vue-router";
import AppShell from "./components/AppShell.vue";
import ShopWorkflowShell from "./components/ShopWorkflowShell.vue";
import { api } from "./api/client";
import { canAccessShopPage, hasPlatformRole, type ShopPageCapability } from "./navigation";
import { loadSession, session } from "./session";

declare module "vue-router" {
  interface RouteMeta {
    requiresAuth?: boolean;
    adminOnly?: boolean;
    shopCapability?: ShopPageCapability;
    title?: string;
    roles?: Array<"ACCOUNTANT" | "ADMIN">;
  }
}

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/login", name: "login", component: () => import("./pages/LoginPage.vue"), meta: { title: "登录" } },
    {
      path: "/shops/:shopId/workflow",
      component: ShopWorkflowShell,
      meta: { requiresAuth: true },
      children: [
        { path: "", redirect: (to) => ({ name: "workflow-commit", params: { shopId: to.params.shopId } }) },
        { path: "commit", name: "workflow-commit", component: () => import("./pages/UploadPage.vue"), meta: { title: "资料准备", shopCapability: "MANAGE_IMPORT" } },
        { path: "calculate", name: "workflow-calculate", component: () => import("./pages/CalculatePage.vue"), meta: { title: "计算复核", shopCapability: "RESULTS" } },
        { path: "export", name: "workflow-export", component: () => import("./pages/ExportPage.vue"), meta: { title: "报告交付", shopCapability: "EXPORT" } },
        { path: "receive", name: "workflow-receive", redirect: (to) => ({ name: "workflow-commit", params: { shopId: to.params.shopId } }), meta: { title: "资料准备", shopCapability: "MANAGE_IMPORT" } },
        { path: "preflight", name: "workflow-preflight", redirect: (to) => ({ name: "workflow-commit", params: { shopId: to.params.shopId } }), meta: { title: "资料准备", shopCapability: "MANAGE_IMPORT" } },
        { path: "publish", name: "workflow-publish", redirect: (to) => ({ name: "workflow-calculate", params: { shopId: to.params.shopId } }), meta: { title: "计算复核", shopCapability: "RESULTS" } },
      ],
    },
    {
      path: "/",
      component: AppShell,
      meta: { requiresAuth: true },
      children: [
        { path: "", redirect: "/workspace" },
        { path: "workspace", name: "workspace", component: () => import("./pages/WorkspacePage.vue"), meta: { title: "工作台" } },
        { path: "sales-cost", name: "sales-cost", component: () => import("./pages/SalesCostPage.vue"), meta: { title: "销售成本", roles: ["ACCOUNTANT", "ADMIN"] } },
        { path: "accounting-habits", name: "accounting-habits", component: () => import("./pages/AccountingHabitsPage.vue"), meta: { title: "做账习惯", roles: ["ACCOUNTANT", "ADMIN"] } },
        { path: "shops/:shopId/upload", name: "upload", redirect: (to) => ({ name: "workflow-commit", params: { shopId: to.params.shopId } }), meta: { title: "资料准备", shopCapability: "MANAGE_IMPORT" } },
        { path: "shops/:shopId/integrity", name: "integrity", redirect: (to) => ({ name: "workflow-commit", params: { shopId: to.params.shopId } }), meta: { title: "资料准备", shopCapability: "MANAGE_IMPORT" } },
        { path: "shops/:shopId/results", name: "results", redirect: (to) => ({ name: "workflow-calculate", params: { shopId: to.params.shopId } }), meta: { title: "计算复核", shopCapability: "RESULTS" } },
        { path: "shops/:shopId/exports", name: "exports", redirect: (to) => ({ name: "workflow-export", params: { shopId: to.params.shopId } }), meta: { title: "报告交付", shopCapability: "EXPORT" } },
        { path: "fx", name: "fx", component: () => import("./pages/FxPage.vue"), meta: { title: "外汇市场", roles: ["ACCOUNTANT", "ADMIN"] } },
        { path: "account", name: "account", component: () => import("./pages/AccountPage.vue"), meta: { title: "账号设置" } },
        { path: "organization/enterprise", name: "enterprise-organization", component: () => import("./pages/EnterpriseOrganizationPage.vue"), meta: { title: "企业与成员", roles: ["ACCOUNTANT", "ADMIN"] } },
        { path: "wallet", name: "wallet", component: () => import("./pages/WalletPage.vue"), meta: { title: "企业钱包与流水", roles: ["ACCOUNTANT", "ADMIN"] } },
        { path: "admin/users", name: "admin-users", component: () => import("./pages/UserAdminPage.vue"), meta: { title: "做账员管理", adminOnly: true } },
        { path: "admin/apps", name: "admin-apps", component: () => import("./pages/AppAdminPage.vue"), meta: { title: "应用管理", adminOnly: true } },
        { path: "admin/operations", name: "admin-operations", component: () => import("./pages/OperationsAdminPage.vue"), meta: { title: "运营状态", adminOnly: true } },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/workspace" },
  ],
  scrollBehavior: () => ({ top: 0 }),
});

function returnToLogin(to: RouteLocationNormalized) {
  return { name: "login", query: { returnTo: to.fullPath } };
}

function homeRoute() {
  return { name: "workspace" };
}

router.beforeEach(async (to) => {
  document.title = `${to.meta.title ?? "工作台"} | 销售成本测算`;
  if (to.meta.requiresAuth || to.matched.some((item) => item.meta.requiresAuth)) {
    if (session.status === "loading") await loadSession();
    if (session.status === "anonymous") return returnToLogin(to);
    if (session.status === "error") return true;
    if (to.meta.adminOnly && !hasPlatformRole(session.me, "ADMIN")) return homeRoute();
    if (to.meta.roles && !to.meta.roles.some((role) => hasPlatformRole(session.me, role))) return homeRoute();
    if (to.meta.shopCapability) {
      const shopId = typeof to.params.shopId === "string" ? to.params.shopId : "";
      try {
        const shops = await api.listShops();
        if (!canAccessShopPage(shops.find((shop) => shop.id === shopId), to.meta.shopCapability)) return homeRoute();
      } catch {
        return homeRoute();
      }
    }
  }
  if (to.name === "login" && session.status === "authenticated") return homeRoute();
  return true;
});
