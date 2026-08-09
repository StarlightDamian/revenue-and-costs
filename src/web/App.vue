<script setup lang="ts">
import { onMounted } from "vue";
import { RouterView, useRouter } from "vue-router";
import { loadSession, session } from "./session";

const router = useRouter();

onMounted(async () => {
  await loadSession();
  if (session.status === "anonymous" && router.currentRoute.value.meta.requiresAuth) {
    await router.replace({ name: "login", query: { returnTo: router.currentRoute.value.fullPath } });
  }
});
</script>

<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <RouterView />
</template>
