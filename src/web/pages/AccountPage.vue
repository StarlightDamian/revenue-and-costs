<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { api } from "../api/client";
import { userFacingError } from "../api/http";
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
const nameDialog = ref<globalThis.HTMLDialogElement | null>(null);
const nameInput = ref<globalThis.HTMLInputElement | null>(null);
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

async function openNameDialog() {
  displayName.value = session.me?.displayName ?? "";
  profileStatus.value = "idle";
  profileMessage.value = "";
  nameDialog.value?.showModal();
  await nextTick();
  nameInput.value?.focus();
}

function closeNameDialog() {
  if (profileStatus.value === "saving") return;
  displayName.value = session.me?.displayName ?? "";
  profileStatus.value = "idle";
  profileMessage.value = "";
  nameDialog.value?.close();
}

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
    nameDialog.value?.close();
  } catch (caught) {
    profileStatus.value = "error";
    profileMessage.value = userFacingError(caught, "无法更新账号名称，请检查网络后重试");
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
    avatarMessage.value = userFacingError(caught, "无法更新头像，请检查网络后重试");
  }
}
</script>

<template>
  <section>
    <PageHeader title="账号设置" description="查看账号信息，按需要修改名称、头像和界面样式。" />
    <section class="surface-section account-settings-panel" aria-labelledby="account-settings-title">
      <h2 id="account-settings-title" class="sr-only">账号信息</h2>
      <dl class="account-settings-list">
        <div>
          <dt>账号名称</dt>
          <dd><strong>{{ session.me?.displayName || "未设置名称" }}</strong><button class="secondary-button compact" type="button" @click="openNameDialog">修改名称</button></dd>
        </div>
        <div><dt>手机号</dt><dd><PhoneDisplay :value="session.me?.phoneMasked" /></dd></div>
        <div><dt>账号类型</dt><dd>{{ roleText }}</dd></div>
        <div v-if="session.me?.customerShopCount"><dt>可查看的客户公司</dt><dd>{{ session.me.customerShopCount }}</dd></div>
        <div class="account-avatar-setting">
          <dt>个人头像</dt>
          <dd><AvatarPicker :model-value="session.me?.avatarId ?? 1" label="更换账号头像" @update:model-value="saveAvatar" /><small>头像会显示在侧边栏和做账员列表中。</small></dd>
        </div>
        <div class="account-theme-setting">
          <dt>界面样式</dt>
          <dd><ThemeSwitcher /><small>选择你看着舒服的界面，切换后会自动保存。</small></dd>
        </div>
      </dl>
      <p v-if="profileStatus === 'saved' && profileMessage" class="form-success account-settings-message" role="status">{{ profileMessage }}</p>
      <p v-if="avatarStatus === 'saving'" class="form-help account-settings-message" role="status">正在保存头像...</p>
      <p v-else-if="avatarMessage" :class="avatarStatus === 'error' ? 'form-error account-settings-message' : 'form-success account-settings-message'" role="status">{{ avatarMessage }}</p>
    </section>

    <Teleport to="body">
      <dialog ref="nameDialog" class="confirm-dialog account-name-dialog" aria-labelledby="account-name-title" @cancel.prevent="closeNameDialog" @click.self="closeNameDialog">
        <form @submit.prevent="saveProfile">
          <span>账号名称</span>
          <h2 id="account-name-title">修改账号名称</h2>
          <p>这个名称只用于系统内显示，不会改变登录手机号。</p>
          <label class="form-field"><span>账号名称</span><input ref="nameInput" v-model="displayName" autocomplete="name" placeholder="例如：张三或星河财务" :aria-invalid="profileInputValid ? undefined : true" :disabled="profileStatus === 'saving'" /><small>最多 80 个字，留空会清除当前名称。当前 {{ displayNameLength }}/80。</small></label>
          <p v-if="profileStatus === 'error' && profileMessage" class="form-error" role="alert">{{ profileMessage }}</p>
          <div class="form-actions"><button class="secondary-button" type="button" :disabled="profileStatus === 'saving'" @click="closeNameDialog">取消</button><button class="primary-button" type="submit" :disabled="profileStatus === 'saving' || !profileChanged || !profileInputValid">{{ profileStatus === "saving" ? "保存中" : "保存名称" }}</button></div>
        </form>
      </dialog>
    </Teleport>
  </section>
</template>
