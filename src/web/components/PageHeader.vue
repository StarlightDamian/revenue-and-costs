<script setup lang="ts">
defineProps<{ title: string; description: string; status?: string; tone?: "neutral" | "warning" | "official" }>();
</script>

<template>
  <header class="page-header">
    <div>
      <h1>{{ title }}</h1>
      <p>{{ description }}</p>
    </div>
    <div v-if="status || $slots.actions" class="page-header-actions">
      <span v-if="status" class="status-chip" :data-tone="tone ?? 'neutral'">{{ status }}</span>
      <slot name="actions"></slot>
    </div>
  </header>
</template>
