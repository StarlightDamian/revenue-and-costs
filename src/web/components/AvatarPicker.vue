<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AVATARS, avatarById, normalizeAvatarId } from "../avatars";

const props = withDefaults(defineProps<{
  modelValue: number;
  label?: string;
}>(), { label: "选择头像" });
const emit = defineEmits<{ "update:modelValue": [avatarId: number] }>();

const dialog = ref<{ showModal: () => void; close: () => void } | null>(null);
const pendingAvatarId = ref(normalizeAvatarId(props.modelValue));
const round = ref(Math.floor((pendingAvatarId.value - 1) / 10));
const roundCount = Math.ceil(AVATARS.length / 10);
const selected = computed(() => avatarById(props.modelValue));
const visibleAvatars = computed(() => AVATARS.slice(round.value * 10, round.value * 10 + 10));

watch(() => props.modelValue, (value) => {
  pendingAvatarId.value = normalizeAvatarId(value);
});

function open() {
  pendingAvatarId.value = normalizeAvatarId(props.modelValue);
  round.value = Math.floor((pendingAvatarId.value - 1) / 10);
  dialog.value?.showModal();
}

function close() {
  dialog.value?.close();
}

function previousRound() {
  round.value = (round.value + roundCount - 1) % roundCount;
}

function nextRound() {
  round.value = (round.value + 1) % roundCount;
}

function confirm() {
  emit("update:modelValue", pendingAvatarId.value);
  close();
}
</script>

<template>
  <button class="avatar-picker-trigger" type="button" :aria-label="label" @click="open">
    <img :src="selected.src" :alt="`${selected.name}头像`" />
    <span>{{ selected.name }}</span>
  </button>
  <Teleport to="body">
    <dialog ref="dialog" class="avatar-dialog" aria-labelledby="avatar-dialog-title" @click.self="close">
      <div class="avatar-dialog-head">
        <div>
          <p>身份偏好</p>
          <h2 id="avatar-dialog-title">选择你的头像</h2>
          <span>59 个动物头像，每组最多 10 个。</span>
        </div>
        <button class="secondary-button compact" type="button" @click="close">关闭</button>
      </div>
      <div class="avatar-grid" role="group" aria-label="动物头像">
        <button
          v-for="avatar in visibleAvatars"
          :key="avatar.id"
          class="avatar-option"
          :class="{ 'is-selected': pendingAvatarId === avatar.id }"
          type="button"
          :aria-pressed="pendingAvatarId === avatar.id"
          @click="pendingAvatarId = avatar.id"
        >
          <img :src="avatar.src" alt="" />
          <span>{{ avatar.name }}</span>
        </button>
      </div>
      <div class="avatar-dialog-foot">
        <div class="avatar-round-controls">
          <button class="secondary-button compact" type="button" @click="previousRound">上一组</button>
          <span>第 {{ round + 1 }} / {{ roundCount }} 组</span>
          <button class="secondary-button compact" type="button" @click="nextRound">下一组</button>
        </div>
        <button class="primary-button compact" type="button" @click="confirm">使用这个头像</button>
      </div>
    </dialog>
  </Teleport>
</template>
