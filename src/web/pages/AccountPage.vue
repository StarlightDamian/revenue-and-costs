<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { api } from "../api/client";
import AvatarPicker from "../components/AvatarPicker.vue";
import PageHeader from "../components/PageHeader.vue";
import ThemeSwitcher from "../components/ThemeSwitcher.vue";
import { hasPlatformRole } from "../navigation";
import { acceptSession, session } from "../session";

const isAdmin = computed(() => hasPlatformRole(session.me, "ADMIN"));
const roleText = computed(() => isAdmin.value ? "管理员" : "做账员");
const avatarStatus = ref<"idle" | "saving" | "saved" | "error">("idle");
const avatarMessage = ref("");

async function saveAvatar(avatarId: number) {
  avatarStatus.value = "saving";
  avatarMessage.value = "";
  try {
    acceptSession(await api.updateAvatar(avatarId));
    avatarStatus.value = "saved";
    avatarMessage.value = "头像已更新";
  } catch (caught) {
    avatarStatus.value = "error";
    avatarMessage.value = caught instanceof Error ? caught.message : "头像更新失败";
  }
}
</script>

<template>
  <section>
    <PageHeader title="账号设置" description="查看身份、角色、主题和当前账号能力。" />
    <div class="account-grid">
      <section class="surface-section account-panel">
        <div class="section-heading"><h2>身份与会话</h2><p>角色变化、账号禁用或手机号换绑后，相关会话会被服务端吊销。</p></div>
        <dl class="definition-list"><div><dt>账号</dt><dd>{{ session.me?.displayName || "未设置名称" }}</dd></div><div><dt>手机号</dt><dd>{{ session.me?.phoneMasked }}</dd></div><div><dt>平台角色</dt><dd>{{ roleText }}</dd></div><div v-if="session.me?.customerShopCount"><dt>客户授权公司</dt><dd>{{ session.me.customerShopCount }}</dd></div></dl>
      </section>
      <section class="surface-section account-panel">
        <div class="section-heading"><h2>界面主题</h2><p>切换后先保存在当前浏览器，登录状态下同时写入账号偏好。</p></div>
        <ThemeSwitcher />
      </section>
      <section class="surface-section account-panel account-avatar-panel">
        <div class="section-heading"><h2>个人头像</h2><p>从 59 个动物头像中选择，侧栏和做账员管理会同步显示。</p></div>
        <AvatarPicker :model-value="session.me?.avatarId ?? 1" label="更换账号头像" @update:model-value="saveAvatar" />
        <p v-if="avatarStatus === 'saving'" class="form-help" role="status">正在保存头像...</p>
        <p v-else-if="avatarMessage" :class="avatarStatus === 'error' ? 'form-error' : 'form-success'" role="status">{{ avatarMessage }}</p>
      </section>
      <section class="surface-section account-panel">
        <div class="section-heading"><h2>企业钱包</h2><p>钱包属于企业，同一企业的有效做账员共享余额和流水。</p></div>
        <RouterLink class="primary-button compact" to="/wallet">查看企业钱包</RouterLink>
      </section>
    </div>
  </section>
</template>
