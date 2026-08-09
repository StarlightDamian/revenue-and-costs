<script setup lang="ts">
import { RouterLink } from "vue-router";
import { avatarById } from "../avatars";

interface OnboardingStep {
  readonly title: string;
  readonly text: string;
  readonly animal: number;
  readonly done?: boolean;
  readonly to?: string;
  readonly actionLabel?: string;
}

defineProps<{
  readonly title: string;
  readonly description: string;
  readonly steps: readonly OnboardingStep[];
  readonly dismissLabel?: string;
}>();

defineEmits<{ dismiss: [] }>();
</script>

<template>
  <Teleport to="body">
    <div class="onboarding-overlay" role="region" :aria-label="title">
      <section class="onboarding-floating-panel">
        <header class="onboarding-floating-head">
          <div><span>快速开始</span><h2>{{ title }}</h2><p>{{ description }}</p></div>
          <button class="secondary-button compact" type="button" @click="$emit('dismiss')">{{ dismissLabel || "跳过引导" }}</button>
        </header>
        <div class="onboarding-cards compact">
          <article v-for="(step, index) in steps" :key="step.title" :class="{ complete: step.done }">
            <img :src="avatarById(step.animal).src" alt="水彩动物引导角色" />
            <span>{{ step.done ? "已完成" : `步骤 ${index + 1}` }}</span>
            <h3>{{ step.title }}</h3>
            <p>{{ step.text }}</p>
            <RouterLink v-if="step.to" class="secondary-button compact" :to="step.to">{{ step.actionLabel || (step.done ? "查看" : "开始") }}</RouterLink>
          </article>
        </div>
      </section>
    </div>
  </Teleport>
</template>
