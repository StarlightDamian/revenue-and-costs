<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, RouterView, useRouter } from "vue-router";
import { api } from "../api/client";
import { avatarById } from "../avatars";
import { deriveNavigation, hasPlatformRole } from "../navigation";
import { clearSession, loadSession, session } from "../session";
import ThemeSwitcher from "./ThemeSwitcher.vue";
import { currentEnterprise, enterpriseState, loadEnterprises, selectEnterprise } from "../enterprise";

const router = useRouter();
const menuOpen = ref(false);
const navigation = computed(() => deriveNavigation(session.me, enterpriseState.items.length > 0));
const accountAvatar = computed(() => avatarById(session.me?.avatarId));
const roleText = computed(() => hasPlatformRole(session.me, "ADMIN")
  ? "管理员"
  : "做账员");
const homeRoute = computed(() => "/workspace");

onMounted(() => { void loadEnterprises(); });

async function logout() {
  try { await api.logout(); } finally {
    clearSession();
    await router.replace({ name: "login" });
  }
}
</script>

<template>
  <div class="ambient" aria-hidden="true"><div class="ambient-image"></div><div class="ambient-scrim"></div></div>
  <div class="workspace-shell">
    <button v-if="menuOpen" class="sidebar-overlay" type="button" aria-label="关闭导航" @click="menuOpen = false"></button>
    <aside id="primary-sidebar" class="sidebar" :class="{ 'is-open': menuOpen }" aria-label="主导航">
      <RouterLink class="brand" :to="homeRoute" @click="menuOpen = false">
        <span class="brand-mark">RC</span>
        <span class="brand-copy"><strong>销售成本测算</strong><small>收入与平台成本</small></span>
      </RouterLink>
      <div class="account-summary">
        <img :src="accountAvatar.src" :alt="`${accountAvatar.name}头像`" />
        <div><strong>{{ session.me?.displayName || session.me?.phoneMasked || "当前账号" }}</strong><span>{{ roleText }}</span></div>
      </div>
      <nav class="side-nav">
        <section v-for="group in navigation" :key="group.label" class="side-nav-group"><span>{{ group.label }}</span><RouterLink v-for="item in group.items" :key="item.to" :to="item.to" @click="menuOpen = false">{{ item.label }}</RouterLink></section>
      </nav>
      <div class="sidebar-foot">
        <p>页面权限仅用于指引，所有资源仍由服务端逐项授权。</p>
        <button class="secondary-button compact" type="button" @click="logout">退出登录</button>
      </div>
    </aside>
    <div class="workspace-main">
      <header class="topbar">
        <button class="mobile-menu" type="button" aria-controls="primary-sidebar" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">菜单</button>
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
