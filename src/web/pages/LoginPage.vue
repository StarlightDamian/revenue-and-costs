<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api/client";
import { isApiErrorCode } from "../api/http";
import { acceptSession } from "../session";
import { avatarById } from "../avatars";
import ThemeSwitcher from "../components/ThemeSwitcher.vue";

const route = useRoute();
const router = useRouter();
const phone = ref("");
const displayName = ref("");
const code = ref("");
const authMode = ref<"login" | "register">("login");
const challengeId = ref("");
const sandboxCode = ref("");
const busy = ref(false);
const error = ref("");
const success = ref("");
const countdown = ref(0);
let timer: number | undefined;

const selectedAvatar = computed(() => avatarById(24));
const stageAvatars = [avatarById(31), avatarById(3), avatarById(4)];

const canSend = computed(() => /^1\d{10}$/.test(phone.value) && countdown.value === 0 && !busy.value);
const canVerify = computed(() => Boolean(challengeId.value) && /^\d{6}$/.test(code.value) && !busy.value);

function clearChallenge() {
  challengeId.value = "";
  sandboxCode.value = "";
  code.value = "";
  countdown.value = 0;
  window.clearInterval(timer);
}

function setAuthMode(mode: "login" | "register") {
  authMode.value = mode;
  error.value = "";
  success.value = "";
  clearChallenge();
}

function beginCountdown() {
  countdown.value = 60;
  window.clearInterval(timer);
  timer = window.setInterval(() => {
    countdown.value -= 1;
    if (countdown.value <= 0) window.clearInterval(timer);
  }, 1000);
}

async function sendOtp() {
  error.value = "";
  success.value = "";
  if (!canSend.value) {
    error.value = "请输入有效的 11 位手机号";
    return;
  }
  busy.value = true;
  try {
    const result = await api.requestOtp(phone.value, authMode.value === "register" ? "REGISTER" : "LOGIN");
    challengeId.value = result.challengeId;
    sandboxCode.value = result.sandboxCode ?? "";
    beginCountdown();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "验证码发送失败";
  } finally { busy.value = false; }
}

async function submitAuth() {
  error.value = "";
  success.value = "";
  if (!canVerify.value) return;
  busy.value = true;
  try {
    const me = authMode.value === "register"
      ? await api.registerAccount(challengeId.value, phone.value, code.value, displayName.value.trim() || undefined)
      : await api.verifyOtp(challengeId.value, phone.value, code.value);
    acceptSession(me);
    const requested = typeof route.query.returnTo === "string" ? route.query.returnTo : "";
    const fallback = me.isFirstLogin
      ? "/workspace"
      : me.roles.includes("ADMIN")
      ? "/admin/users"
      : "/sales-cost";
    await router.replace(requested.startsWith("/") && !requested.startsWith("//") ? requested : fallback);
  } catch (caught) {
    if (authMode.value === "login" && isApiErrorCode(caught, "ACCOUNT_NOT_REGISTERED")) {
      authMode.value = "register";
      clearChallenge();
      error.value = "该手机号尚未注册，已切换到注册。姓名可以不填，请重新获取验证码。";
      return;
    }
    error.value = caught instanceof Error ? caught.message : "登录失败";
  } finally { busy.value = false; }
}

watch(phone, () => {
  if (challengeId.value) clearChallenge();
  error.value = "";
  success.value = "";
});
onBeforeUnmount(() => window.clearInterval(timer));
</script>

<template>
  <div class="login-screen">
    <div class="ambient" aria-hidden="true"><div class="ambient-image"></div><div class="ambient-scrim"></div></div>
    <header class="login-header">
      <div class="brand"><span class="brand-mark">RC</span><span class="brand-copy"><strong>销售成本测算</strong><small>跨境电商财务工作台</small></span></div>
      <ThemeSwitcher />
    </header>
    <main id="main-content" class="login-layout">
      <section class="login-context" aria-labelledby="login-context-title">
        <p>收入与平台成本</p>
        <h1 id="login-context-title">让每一笔成本，回到来源</h1>
        <div class="login-avatar-stage" aria-label="59 个动物头像预览">
          <img class="is-main" :src="selectedAvatar.src" :alt="`${selectedAvatar.name}头像`" />
          <img v-for="avatar in stageAvatars" :key="avatar.id" :src="avatar.src" alt="" />
          <div><strong>59 个动物头像</strong><span>用熟悉的角色进入成本测算</span></div>
        </div>
        <div class="login-principles">
          <div><strong>按版本复核</strong><span>数据、映射、日期口径、公式与汇率共同固定</span></div>
          <div><strong>自动发布</strong><span>资料准备完成后自动计算并发布，失败时保留可追溯恢复入口</span></div>
        </div>
      </section>
      <section class="login-card" aria-labelledby="login-title">
        <div class="login-card-head">
          <div><p>安全入口</p><h2 id="login-title">{{ authMode === "login" ? "做账员登录" : "注册做账员" }}</h2><span>{{ authMode === "login" ? "使用已注册或已受邀手机号验证身份，进入企业工作台。" : "验证手机号即可注册；姓名选填，头像由系统随机分配。" }}</span></div>
        </div>
        <form @submit.prevent="submitAuth" novalidate>
          <label class="form-field">
            <span>手机号</span>
            <div class="phone-input-field"><span aria-hidden="true">+86</span><input v-model.trim="phone" aria-label="手机号码" type="tel" inputmode="numeric" maxlength="11" autocomplete="tel" placeholder="请输入 11 位手机号" :disabled="busy" /></div>
          </label>
          <label v-if="authMode === 'register'" class="form-field">
            <span>姓名（选填）</span>
            <input v-model.trim="displayName" type="text" maxlength="80" autocomplete="name" placeholder="便于企业成员识别" :disabled="busy" />
          </label>
          <label class="form-field">
            <span>短信验证码</span>
            <div class="code-input-row"><input v-model.trim="code" inputmode="numeric" maxlength="8" autocomplete="one-time-code" placeholder="输入验证码" :disabled="busy" /><button class="secondary-button" type="button" :disabled="!canSend" @click="sendOtp">{{ countdown ? `${countdown} 秒` : "获取验证码" }}</button></div>
          </label>
          <div v-if="sandboxCode" class="sandbox-notice" role="status"><strong>开发沙箱验证码</strong><code>{{ sandboxCode }}</code><span>本地验证默认 246810；生产环境不会启用固定验证码。</span></div>
          <p v-if="success" class="form-success" role="status">{{ success }}</p>
          <p v-if="error" class="form-error" role="alert">{{ error }}</p>
          <button class="primary-button login-submit" type="submit" :disabled="!canVerify">{{ busy ? "正在验证" : authMode === "login" ? "登录并进入工作台" : "完成注册" }}</button>
          <div class="auth-switch"><span>{{ authMode === "login" ? "还没有账号？" : "已有账号？" }}</span><button type="button" @click="setAuthMode(authMode === 'login' ? 'register' : 'login')">{{ authMode === "login" ? "注册账号" : "返回登录" }}</button></div>
          <p class="prototype-note">受邀手机号可直接登录并自动加入企业；未受邀的新手机号请先注册。</p>
        </form>
      </section>
    </main>
  </div>
</template>
