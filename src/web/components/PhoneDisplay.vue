<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ value: string | undefined }>();

const presentation = computed(() => {
  const value = props.value?.trim() || "***";
  if (value.startsWith("+86")) {
    return { label: `+86 ${value.slice(3).trimStart() || "***"}`, countryCode: "+86", number: value.slice(3).trimStart() || "***" };
  }
  if (/^1\d{2}\*{4}\d{4}$/u.test(value)) {
    return { label: `+86 ${value}`, countryCode: "+86", number: value };
  }
  return { label: value, countryCode: "", number: value };
});
</script>

<template>
  <span class="phone-display" :aria-label="presentation.label"><span v-if="presentation.countryCode" class="phone-country-code" aria-hidden="true">{{ presentation.countryCode }}</span><span v-if="presentation.countryCode" class="phone-separator" aria-hidden="true"> </span><span class="phone-number" aria-hidden="true">{{ presentation.number }}</span></span>
</template>
