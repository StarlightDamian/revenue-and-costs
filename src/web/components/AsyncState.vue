<script setup lang="ts">
defineProps<{
  status: "loading" | "ready" | "empty" | "error";
  error?: string;
  emptyTitle?: string;
  emptyMessage?: string;
}>();
defineEmits<{ retry: [] }>();
</script>

<template>
  <div v-if="status === 'loading'" class="skeleton-stack" aria-live="polite" aria-busy="true">
    <span class="sr-only">正在读取</span>
    <div class="skeleton-line is-wide"></div>
    <div class="skeleton-line"></div>
    <div class="skeleton-line is-short"></div>
  </div>
  <div v-else-if="status === 'error'" class="state-panel state-error" role="alert">
    <strong>暂时无法读取</strong>
    <p>{{ error || "请求失败，请稍后重试" }}</p>
    <button class="secondary-button compact" type="button" @click="$emit('retry')">重新读取</button>
  </div>
  <div v-else-if="status === 'empty'" class="state-panel">
    <strong>{{ emptyTitle || "暂无内容" }}</strong>
    <p>{{ emptyMessage || "完成相关操作后，内容会显示在这里。" }}</p>
    <slot name="empty-action"></slot>
  </div>
  <slot v-else></slot>
</template>
