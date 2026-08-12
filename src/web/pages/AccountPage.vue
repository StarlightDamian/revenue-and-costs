<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { api } from "../api/client";
import AvatarPicker from "../components/AvatarPicker.vue";
import PageHeader from "../components/PageHeader.vue";
import PhoneDisplay from "../components/PhoneDisplay.vue";
import ThemeSwitcher from "../components/ThemeSwitcher.vue";
import { hasPlatformRole } from "../navigation";
import { acceptSession, session } from "../session";

const isAdmin = computed(() => hasPlatformRole(session.me, "ADMIN"));
const roleText = computed(() => isAdmin.value ? "管理员" : "做账员");
const avatarStatus = ref<"idle" | "saving" | "saved" | "error">("idle");
const avatarMessage = ref("");
const displayName = ref(session.me?.displayName ?? "");
const profileStatus = ref<"idle" | "saving" | "saved" | "error">("idle");
const profileMessage = ref("");
const normalizedDisplayName = computed(() => displayName.value.trim().normalize("NFC"));
const profileChanged = computed(() => normalizedDisplayName.value !== (session.me?.displayName ?? ""));
const displayNameLength = computed(() => Array.from(normalizedDisplayName.value).length);
const profileInputValid = computed(() => displayNameLength.value <= 80 && !Array.from(normalizedDisplayName.value).some((character) => {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff);
}));

watch(() => session.me?.displayName, (value) => {
  if (profileStatus.value !== "saving") displayName.value = value ?? "";
});

async function saveProfile() {
  if (!profileInputValid.value) {
    profileStatus.value = "error";
    profileMessage.value = "账号名称须为 80 个以内的可见字符";
    return;
  }
  profileStatus.value = "saving";
  profileMessage.value = "";
  try {
    const updated = await api.updateProfile(displayName.value);
    acceptSession(updated);
    displayName.value = updated.displayName ?? "";
    profileStatus.value = "saved";
    profileMessage.value = updated.displayName ? "账号名称已更新" : "账号名称已清空";
  } catch (caught) {
    profileStatus.value = "error";
    profileMessage.value = caught instanceof Error ? caught.message : "账号名称更新失败";
  }
}

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
        <form class="account-profile-form" @submit.prevent="saveProfile">
          <label class="form-field"><span>账号名称</span><span class="account-name-control"><input v-model="displayName" autocomplete="name" placeholder="例如：香港公司名称" :aria-invalid="!profileInputValid" :disabled="profileStatus === 'saving'" /><button class="primary-button compact" type="submit" :disabled="profileStatus === 'saving' || !profileChanged || !profileInputValid">{{ profileStatus === "saving" ? "保存中" : "保存名称" }}</button></span><small>最多 80 个字符，留空可清除名称，不会改变登录手机号。当前 {{ displayNameLength }}/80。</small></label>
          <p v-if="profileMessage" :class="profileStatus === 'error' ? 'form-error' : 'form-success'" role="status">{{ profileMessage }}</p>
        </form>
        <dl class="definition-list"><div><dt>手机号</dt><dd><PhoneDisplay :value="session.me?.phoneMasked" /></dd></div><div><dt>平台角色</dt><dd>{{ roleText }}</dd></div><div v-if="session.me?.customerShopCount"><dt>客户授权公司</dt><dd>{{ session.me.customerShopCount }}</dd></div></dl>
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
