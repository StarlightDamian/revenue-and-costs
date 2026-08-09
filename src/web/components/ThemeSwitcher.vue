<script setup lang="ts">
import { ref } from "vue";
import { api } from "../api/client";
import { session } from "../session";
import { applyTheme, normalizeTheme, THEME_NAMES, THEMES, type ThemeId } from "../theme";

const current = ref<ThemeId>(normalizeTheme(document.documentElement.dataset.theme));
const failedTheme = ref<ThemeId | null>(null);
const saving = ref(false);
const error = ref("");

async function select(theme: ThemeId) {
  current.value = theme;
  applyTheme(theme);
  error.value = "";
  failedTheme.value = null;
  if (session.status !== "authenticated") return;
  saving.value = true;
  try {
    const me = await api.updateTheme(theme);
    session.me = me;
  } catch (caught) {
    failedTheme.value = theme;
    error.value = caught instanceof Error ? caught.message : "主题尚未同步到账号";
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="theme-control">
    <div class="theme-switch" role="group" aria-label="颜色主题" :aria-busy="saving">
      <button
        v-for="theme in THEMES"
        :key="theme"
        class="theme-choice"
        :class="{ 'is-active': current === theme }"
        type="button"
        :aria-pressed="current === theme"
        @click="select(theme)"
      >
        {{ THEME_NAMES[theme] }}
      </button>
    </div>
    <div v-if="error" class="theme-sync-error" role="status">
      <span>{{ error }}</span>
      <button type="button" @click="failedTheme && select(failedTheme)">重试</button>
    </div>
  </div>
</template>
