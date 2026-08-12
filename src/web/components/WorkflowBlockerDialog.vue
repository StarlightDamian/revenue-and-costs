<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type { WorkflowBlockerPresentation } from "../workflow-blocker";

const props = defineProps<{ blocker: WorkflowBlockerPresentation | null }>();
const emit = defineEmits<{ dismiss: [key: string] }>();
const dialog = ref<globalThis.HTMLDialogElement | null>(null);
const dismissButton = ref<globalThis.HTMLButtonElement | null>(null);

watch(() => props.blocker?.key, async (key) => {
  if (!key) {
    if (dialog.value?.open) dialog.value.close();
    return;
  }
  if (!dialog.value?.open) dialog.value?.showModal();
  await nextTick();
  dismissButton.value?.focus();
}, { flush: "post" });

function dismiss() {
  const key = props.blocker?.key;
  if (!key) return;
  if (dialog.value?.open) dialog.value.close();
  emit("dismiss", key);
}

onBeforeUnmount(() => { if (dialog.value?.open) dialog.value.close(); });
</script>

<template>
  <dialog
    ref="dialog"
    class="confirm-dialog workflow-blocker-dialog"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="workflow-blocker-title"
    aria-describedby="workflow-blocker-message"
    @cancel.prevent="dismiss"
  >
    <template v-if="blocker">
      <span>流程已停止</span>
      <h2 id="workflow-blocker-title">{{ blocker.title }}</h2>
      <p id="workflow-blocker-message">{{ blocker.message }}</p>
      <p class="workflow-blocker-diagnostic"><strong>诊断 ID</strong><code>{{ blocker.diagnosticId }}</code></p>
      <div class="form-actions">
        <button ref="dismissButton" class="secondary-button" type="button" @click="dismiss">我知道了</button>
        <RouterLink class="primary-button" :to="blocker.action.to" @click="dismiss">{{ blocker.action.label }}</RouterLink>
      </div>
    </template>
  </dialog>
</template>
