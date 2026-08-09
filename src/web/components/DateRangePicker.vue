<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";

type Grain = "MONTH" | "DAY";

const props = defineProps<{
  readonly grain: Grain;
  readonly start: string;
  readonly end: string;
}>();

const emit = defineEmits<{
  "update:grain": [value: Grain];
  "update:start": [value: string];
  "update:end": [value: string];
}>();

const root = ref<globalThis.HTMLElement | null>(null);
const panelOpen = ref(false);
const draftStart = ref("");
const draftEnd = ref("");
const viewMonth = ref("");
const weekdays = ["一", "二", "三", "四", "五", "六", "日"] as const;

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function addMonths(value: string, offset: number): string {
  const match = /^(\d{4})-(\d{2})$/u.exec(value);
  if (!match) return currentMonth();
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatMonth(value: string): string {
  const match = /^(\d{4})-(\d{2})$/u.exec(value);
  return match ? `${match[1]}年${match[2]}月` : "请选择";
}

function formatDay(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  return match ? `${match[1]}年${match[2]}月${match[3]}日` : "请选择";
}

const displayRange = computed(() => {
  const format = props.grain === "MONTH" ? formatMonth : formatDay;
  return `${format(props.start)} — ${format(props.end)}`;
});
const leftYear = computed(() => Number((viewMonth.value || currentMonth()).slice(0, 4)));
const rightYear = computed(() => leftYear.value + 1);
const rightMonth = computed(() => addMonths(viewMonth.value || currentMonth(), 1));

function syncDraft() {
  draftStart.value = props.start;
  draftEnd.value = props.end;
  const startMonth = props.start.slice(0, 7);
  if (startMonth) viewMonth.value = startMonth;
  else if (!viewMonth.value) viewMonth.value = currentMonth();
}

function togglePanel() {
  panelOpen.value = !panelOpen.value;
  if (panelOpen.value) syncDraft();
}

function closePanel() {
  panelOpen.value = false;
}

function chooseGrain(value: Grain) {
  if (value === props.grain) return;
  emit("update:grain", value);
  void nextTick(syncDraft);
}

function chooseValue(value: string) {
  if (!draftStart.value || draftEnd.value) {
    draftStart.value = value;
    draftEnd.value = "";
    emit("update:start", value);
    emit("update:end", "");
    return;
  }
  if (value < draftStart.value) {
    draftStart.value = value;
    emit("update:start", value);
    return;
  }
  draftEnd.value = value;
  emit("update:end", value);
  closePanel();
}

function monthValue(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function monthLabel(year: number, month: number): string {
  return `${year}年${month}月`;
}

function calendarDays(monthValueInput: string): Array<string | null> {
  const [yearText, monthText] = monthValueInput.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const firstWeekday = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  const dayCount = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const days: Array<string | null> = Array.from({ length: firstWeekday }, () => null);
  for (let day = 1; day <= dayCount; day += 1) days.push(`${monthValueInput}-${String(day).padStart(2, "0")}`);
  while (days.length % 7 !== 0) days.push(null);
  return days;
}

function dayNumber(value: string): number {
  return Number(value.slice(-2));
}

function dayLabel(value: string): string {
  const [year, month, day] = value.split("-");
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function selectionClass(value: string) {
  return {
    "is-start": value === draftStart.value,
    "is-end": value === draftEnd.value,
    "is-in-range": Boolean(draftStart.value && draftEnd.value && value > draftStart.value && value < draftEnd.value),
  };
}

function handleOutside(event: globalThis.PointerEvent) {
  if (panelOpen.value && event.target instanceof globalThis.Node && !root.value?.contains(event.target)) closePanel();
}

watch(() => [props.start, props.end] as const, syncDraft);
onMounted(() => document.addEventListener("pointerdown", handleOutside));
onBeforeUnmount(() => document.removeEventListener("pointerdown", handleOutside));
</script>

<template>
  <div ref="root" class="date-range-picker">
    <button class="date-range-trigger" type="button" :aria-expanded="panelOpen" aria-haspopup="dialog" @click="togglePanel">
      <span class="date-range-calendar-icon" aria-hidden="true"></span>
      <span><small>日期范围</small><strong>{{ displayRange }}</strong></span>
      <b aria-hidden="true">⌄</b>
    </button>

    <div v-if="panelOpen" class="date-range-panel" role="dialog" aria-label="选择日期范围" @keydown.esc="closePanel">
      <header class="date-range-panel-head">
        <div class="segmented-control compact" aria-label="日期粒度">
          <button type="button" :class="{ active: grain === 'MONTH' }" :aria-pressed="grain === 'MONTH'" @click="chooseGrain('MONTH')">月度</button>
          <button type="button" :class="{ active: grain === 'DAY' }" :aria-pressed="grain === 'DAY'" @click="chooseGrain('DAY')">日度</button>
        </div>
        <p>先选开始{{ grain === "MONTH" ? "月份" : "日期" }}，再选结束{{ grain === "MONTH" ? "月份" : "日期" }}（含）。</p>
      </header>

      <div v-if="grain === 'MONTH'" class="range-calendar-grid month-range-grid">
        <section v-for="(year, panelIndex) in [leftYear, rightYear]" :key="year" class="range-calendar-panel">
          <header>
            <button v-if="panelIndex === 0" type="button" :aria-label="`查看${year - 1}年`" @click="viewMonth = `${year - 1}-01`">‹</button><span v-else></span>
            <h3>{{ year }}年</h3>
            <button v-if="panelIndex === 1" type="button" :aria-label="`查看${year + 1}年`" @click="viewMonth = `${year}-01`">›</button><span v-else></span>
          </header>
          <div class="month-button-grid">
            <button v-for="month in 12" :key="month" type="button" :class="selectionClass(monthValue(year, month))" :aria-label="monthLabel(year, month)" @click="chooseValue(monthValue(year, month))">{{ month }}月</button>
          </div>
        </section>
      </div>

      <div v-else class="range-calendar-grid day-range-grid">
        <section v-for="(month, panelIndex) in [viewMonth || currentMonth(), rightMonth]" :key="month" class="range-calendar-panel">
          <header>
            <button v-if="panelIndex === 0" type="button" aria-label="上一个月" @click="viewMonth = addMonths(viewMonth, -1)">‹</button><span v-else></span>
            <h3>{{ formatMonth(month) }}</h3>
            <button v-if="panelIndex === 1" type="button" aria-label="下一个月" @click="viewMonth = addMonths(viewMonth, 1)">›</button><span v-else></span>
          </header>
          <div class="weekday-grid"><span v-for="weekday in weekdays" :key="weekday">{{ weekday }}</span></div>
          <div class="day-button-grid">
            <template v-for="(day, index) in calendarDays(month)" :key="day || `blank-${index}`">
              <button v-if="day" type="button" :class="selectionClass(day)" :aria-label="dayLabel(day)" @click="chooseValue(day)">{{ dayNumber(day) }}</button>
              <span v-else></span>
            </template>
          </div>
        </section>
      </div>

      <footer><span>{{ draftStart ? (grain === "MONTH" ? formatMonth(draftStart) : formatDay(draftStart)) : "选择开始" }}</span><b>—</b><span>{{ draftEnd ? (grain === "MONTH" ? formatMonth(draftEnd) : formatDay(draftEnd)) : "请选择结束" }}</span></footer>
    </div>
  </div>
</template>
