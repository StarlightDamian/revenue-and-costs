<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { api } from "../api/client";
import { avatarById } from "../avatars";
import { deriveNavigation, hasPlatformRole } from "../navigation";
import { clearSession, loadSession, session } from "../session";
import ThemeSwitcher from "./ThemeSwitcher.vue";
import { currentEnterprise, enterpriseState, loadEnterprises, selectEnterprise } from "../enterprise";

const router = useRouter();
const route = useRoute();
type Focusable = { focus(): void };
type SidebarElement = { querySelector(selector: string): Focusable | null };
type ScrollTarget = { scrollIntoView(options: { block: "nearest"; inline: "nearest" }): void };
type GroupToggleEvent = { currentTarget?: { closest(selector: string): ScrollTarget | null } | null };
const menuOpen = ref(false);
const sidebarRef = ref<SidebarElement | null>(null);
const menuButtonRef = ref<Focusable | null>(null);
const expandedGroupId = ref<string | null>(null);
const sidebarCollapsed = ref(false);
const navigation = computed(() => deriveNavigation(session.me, enterpriseState.items.length > 0));
const accountAvatar = computed(() => avatarById(session.me?.avatarId));
const roleText = computed(() => hasPlatformRole(session.me, "ADMIN")
  ? "管理员"
  : "做账员");
const homeRoute = computed(() => "/workspace");
const activeGroupId = computed(() => navigation.value.find((group) => {
  if (group.id === "sales-cost" && route.path.startsWith("/shops/")) return true;
  return group.items.some((item) => route.path === item.to || route.path.startsWith(`${item.to}/`));
})?.id ?? null);

watch(activeGroupId, (groupId) => {
  if (groupId) expandedGroupId.value = groupId;
}, { immediate: true });

onMounted(() => {
  void loadEnterprises();
  window.addEventListener("keydown", handleGlobalKeydown);
});
onBeforeUnmount(() => window.removeEventListener("keydown", handleGlobalKeydown));

async function logout() {
  try { await api.logout(); } finally {
    clearSession();
    await router.replace({ name: "login" });
  }
}

async function toggleGroup(groupId: string, event: unknown) {
  if (sidebarCollapsed.value) {
    sidebarCollapsed.value = false;
    expandedGroupId.value = groupId;
  } else {
    expandedGroupId.value = expandedGroupId.value === groupId ? null : groupId;
  }
  if (expandedGroupId.value !== groupId) return;
  await nextTick();
  (event as GroupToggleEvent).currentTarget?.closest(".side-nav-group")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function toggleSidebar() {
  sidebarCollapsed.value = !sidebarCollapsed.value;
}

function isNarrowViewport() {
  return window.matchMedia("(max-width: 1180px)").matches;
}

async function openMenu() {
  menuOpen.value = true;
  await nextTick();
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  sidebarRef.value?.querySelector(".side-nav-group-toggle")?.focus();
}

async function closeMenu(restoreFocus = true) {
  const wasOpen = menuOpen.value;
  menuOpen.value = false;
  if (wasOpen && restoreFocus && isNarrowViewport()) {
    await nextTick();
    menuButtonRef.value?.focus();
  }
}

function handleGlobalKeydown(event: { key: string; preventDefault(): void }) {
  if (event.key === "Escape" && menuOpen.value) {
    event.preventDefault();
    void closeMenu(true);
  }
}
</script>

<template>
  <div class="ambient" aria-hidden="true"><div class="ambient-image"></div><div class="ambient-scrim"></div></div>
  <div class="workspace-shell">
    <button v-if="menuOpen" class="sidebar-overlay" type="button" aria-label="关闭导航" @click="closeMenu(true)"></button>
    <aside id="primary-sidebar" ref="sidebarRef" class="sidebar" :class="{ 'is-open': menuOpen, 'is-collapsed': sidebarCollapsed }" aria-label="主导航">
      <RouterLink class="brand" :to="homeRoute" @click="closeMenu(true)">
        <span class="brand-mark">RC</span>
        <span class="brand-copy"><strong>销售成本测算</strong><small>收入与平台成本</small></span>
      </RouterLink>
      <div class="account-summary">
        <button class="account-avatar-toggle" type="button" :aria-label="sidebarCollapsed ? '展开侧栏' : '收起侧栏'" :title="sidebarCollapsed ? '展开侧栏' : '收起侧栏'" @click="toggleSidebar">
          <img :src="accountAvatar.src" :alt="`${accountAvatar.name}头像`" />
        </button>
        <div><strong>{{ session.me?.displayName || "未设置名称" }}</strong><span>{{ roleText }}</span></div>
      </div>
      <nav class="side-nav">
        <section
          v-for="group in navigation"
          :key="group.id"
          class="side-nav-group"
          :data-group="group.id"
          :class="{ 'is-active': activeGroupId === group.id, 'is-expanded': expandedGroupId === group.id }"
        >
          <button
            class="side-nav-group-toggle"
            type="button"
            :aria-label="sidebarCollapsed ? group.label : undefined"
            :aria-expanded="sidebarCollapsed || expandedGroupId === group.id"
            :aria-controls="`side-nav-panel-${group.id}`"
            :title="sidebarCollapsed ? group.label : undefined"
            @click="toggleGroup(group.id, $event)"
          >
            <span class="side-nav-marker" aria-hidden="true">{{ group.marker }}</span>
            <span class="side-nav-group-copy"><strong>{{ group.label }}</strong><small>{{ group.description }}</small></span>
            <span class="side-nav-chevron" aria-hidden="true"></span>
          </button>
          <div v-show="sidebarCollapsed || expandedGroupId === group.id" :id="`side-nav-panel-${group.id}`" class="side-nav-items">
            <RouterLink v-for="item in group.items" :key="item.to" :to="item.to" :aria-label="sidebarCollapsed ? item.label : undefined" :title="sidebarCollapsed ? item.label : undefined" @click="closeMenu(true)"><span class="side-nav-item-marker" aria-hidden="true">{{ item.marker }}</span><span class="side-nav-item-label">{{ item.label }}</span></RouterLink>
          </div>
        </section>
      </nav>
      <div class="sidebar-foot">
        <p>页面权限仅用于指引，所有资源仍由服务端逐项授权。</p>
        <button class="secondary-button compact sidebar-logout" type="button" title="退出登录" @click="logout"><span class="sidebar-logout-icon" aria-hidden="true">退</span><span class="sidebar-logout-label">退出登录</span></button>
      </div>
    </aside>
    <div class="workspace-main">
      <header class="topbar">
        <button ref="menuButtonRef" class="mobile-menu" type="button" aria-controls="primary-sidebar" :aria-expanded="menuOpen" @click="openMenu">菜单</button>
        <div class="topbar-title"><strong>销售成本工作台</strong><span>金额、来源、版本和异常均可追溯</span></div>
        <label v-if="enterpriseState.items.length" class="global-enterprise-switch"><span>当前企业</span><select :value="currentEnterprise?.id" @change="selectEnterprise(($event.target as HTMLSelectElement).value)"><option v-for="enterprise in enterpriseState.items" :key="enterprise.id" :value="enterprise.id">{{ enterprise.name }}</option></select></label>
        <ThemeSwitcher />
      </header>
      <main id="main-content" class="page-content" tabindex="-1">
        <div v-if="session.status === 'loading'" class="skeleton-stack" aria-busy="true"><div class="skeleton-line is-wide"></div><div class="skeleton-line"></div></div>
        <div v-else-if="session.status === 'error'" class="state-panel state-error" role="alert">
          <strong>无法确认登录状态</strong><p>{{ session.error }}</p><button class="secondary-button" type="button" @click="loadSession(true)">重试</button>
        </div>
        <RouterView v-else />
      </main>
    </div>
  </div>
</template>
