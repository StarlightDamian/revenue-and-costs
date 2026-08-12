<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from "vue";
import shipmentMenuUrl from "../../../nas/image/配送货件1.png";
import shipmentDownloadUrl from "../../../nas/image/配送货件2.png";
import transactionMenuUrl from "../../../nas/image/交易报告1.png";
import transactionRequestUrl from "../../../nas/image/交易报告2.png";
import folderGuideUrl from "../../../nas/image/资料教程-站点文件夹-沈星回.webp";

interface TutorialSlide {
  readonly stepIndex: number;
  readonly title: string;
  readonly caption: string;
  readonly src: string;
  readonly alt: string;
}

interface ModalDialogElement {
  readonly open: boolean;
  showModal(): void;
  close(): void;
}

interface FocusableElement {
  focus(): void;
}

interface KeyboardInput {
  readonly key: string;
  preventDefault(): void;
}

const slides: readonly TutorialSlide[] = [
  {
    stepIndex: 0,
    title: "从报告菜单进入配送",
    caption: "在左侧菜单打开“报告”，再选择“配送”。",
    src: shipmentMenuUrl,
    alt: "配送货件教程：从报告菜单进入配送页面",
  },
  {
    stepIndex: 0,
    title: "选择日期并下载 CSV",
    caption: "进入“亚马逊配送货件”，按报表显示日期选择范围并下载 CSV。",
    src: shipmentDownloadUrl,
    alt: "配送货件教程：选择报表日期并下载 CSV",
  },
  {
    stepIndex: 1,
    title: "从付款菜单进入报告库",
    caption: "在左侧菜单打开“付款”，再选择“报告库”。",
    src: transactionMenuUrl,
    alt: "交易报告教程：从付款菜单进入报告库",
  },
  {
    stepIndex: 1,
    title: "设置条件并请求报告",
    caption: "选择标准订单和交易，设置日期范围后请求报告。",
    src: transactionRequestUrl,
    alt: "交易报告教程：选择交易报告条件并请求报告",
  },
  {
    stepIndex: 2,
    title: "按站点合并两类资料",
    caption: "每个实际站点建立一个文件夹，将配送货件和交易报告放在一起。",
    src: folderGuideUrl,
    alt: "资料整理教程：沈星回讲解把两类报告放入对应站点文件夹",
  },
] as const;

const steps = [
  {
    shortTitle: "获取配送货件",
    title: "获取配送货件",
    description: "在亚马逊后台进入“报告 > 配送”，打开“亚马逊配送货件”。按报表显示日期选择范围，下载 CSV 文件。",
    note: "建议下载 CSV。日期按报表显示日期选择，不按文件创建时间判断。",
  },
  {
    shortTitle: "获取交易报告",
    title: "获取交易报告",
    description: "进入“付款 > 报告库”，选择“标准订单”和“交易”，设置日期范围后请求报告并下载。",
    note: "等待报告生成完成后下载原始文件，不要修改列名或另存为 Excel。",
  },
  {
    shortTitle: "按站点整理",
    title: "按站点整理文件",
    description: "每个实际站点使用一个独立文件夹，把该站点的配送货件和交易报告放在一起。整理完成后，将整个站点文件夹发送给我们即可。",
    note: "文件夹名称使用站点中文名或统一站点代码，同一站点的两类资料必须放在同一文件夹中。",
  },
] as const;

const marketplaceFolders = ["阿联酋", "比利时", "波兰", "德国", "法国", "荷兰", "加拿大", "日本"] as const;
const dialog = ref<ModalDialogElement | null>(null);
const closeButton = ref<FocusableElement | null>(null);
const lightboxCloseButton = ref<FocusableElement | null>(null);
const activeStep = ref(0);
const lightboxIndex = ref<number | null>(null);
let returnFocus: FocusableElement | null = null;
let lightboxReturnFocus: FocusableElement | null = null;

const activeSlides = computed(() => slides
  .map((slide, index) => ({ slide, index }))
  .filter(({ slide }) => slide.stepIndex === activeStep.value));
const activeStepDetails = computed(() => steps[activeStep.value] ?? steps[0]);
const activeLightboxSlide = computed(() => lightboxIndex.value === null ? null : slides[lightboxIndex.value]);

function isFocusable(value: unknown): value is FocusableElement {
  if (typeof value !== "object" || value === null || !("focus" in value)) return false;
  return typeof value.focus === "function";
}

function open() {
  if (!dialog.value || dialog.value.open) return;
  returnFocus = isFocusable(document.activeElement) ? document.activeElement : null;
  activeStep.value = 0;
  lightboxIndex.value = null;
  dialog.value.showModal();
  void nextTick(() => closeButton.value?.focus());
}

function close() {
  lightboxIndex.value = null;
  dialog.value?.close();
}

function restorePageFocus() {
  returnFocus?.focus();
  returnFocus = null;
}

function selectStep(index: number) {
  activeStep.value = index;
}

function openLightbox(index: number, event: { readonly currentTarget: unknown }) {
  const slide = slides[index];
  if (!slide) return;
  lightboxReturnFocus = isFocusable(event.currentTarget) ? event.currentTarget : null;
  lightboxIndex.value = index;
  activeStep.value = slide.stepIndex;
  void nextTick(() => lightboxCloseButton.value?.focus());
}

function closeLightbox() {
  lightboxIndex.value = null;
  void nextTick(() => lightboxReturnFocus?.focus());
}

function moveLightbox(offset: number) {
  if (lightboxIndex.value === null) return;
  const nextIndex = (lightboxIndex.value + offset + slides.length) % slides.length;
  const nextSlide = slides[nextIndex];
  if (!nextSlide) return;
  lightboxIndex.value = nextIndex;
  activeStep.value = nextSlide.stepIndex;
}

function handleCancel(event: { preventDefault(): void }) {
  event.preventDefault();
  if (lightboxIndex.value !== null) closeLightbox();
  else close();
}

function handleKeydown(event: KeyboardInput) {
  if (lightboxIndex.value === null) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    moveLightbox(-1);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    moveLightbox(1);
  }
}

onBeforeUnmount(() => {
  if (dialog.value?.open) dialog.value.close();
});

defineExpose({ open });
</script>

<template>
  <dialog
    ref="dialog"
    class="tutorial-dialog"
    aria-labelledby="tutorial-title"
    @cancel="handleCancel"
    @close="restorePageFocus"
    @keydown="handleKeydown"
  >
    <div class="tutorial-dialog-shell">
      <header class="tutorial-hero">
        <div class="tutorial-guide-icon" aria-hidden="true">
          <span />
        </div>
        <div class="tutorial-hero-copy">
          <span>资料准备</span>
          <h2 id="tutorial-title">获取资料教程</h2>
          <p>完成下载和整理。保留原始文件，不改列名，按实际站点归档即可。</p>
        </div>
        <button ref="closeButton" class="tutorial-close-button" type="button" aria-label="关闭教程" @click="close">关闭</button>
      </header>

      <div class="tutorial-layout">
        <nav class="tutorial-step-nav" aria-label="资料获取流程">
          <button
            v-for="(step, index) in steps"
            :key="step.shortTitle"
            type="button"
            :class="{ 'is-active': activeStep === index }"
            :aria-label="step.shortTitle"
            :aria-current="activeStep === index ? 'step' : undefined"
            @click="selectStep(index)"
          >
            <span>{{ index + 1 }}</span>
            <strong>{{ step.shortTitle }}</strong>
          </button>
        </nav>

        <section class="tutorial-stage" aria-live="polite">
          <header>
            <span>{{ activeStep + 1 }} / {{ steps.length }}</span>
            <h3>{{ activeStepDetails.title }}</h3>
            <p>{{ activeStepDetails.description }}</p>
          </header>

          <div class="tutorial-media-grid" :class="{ 'is-single': activeSlides.length === 1 }">
            <figure v-for="item in activeSlides" :key="item.slide.title">
              <button type="button" :aria-label="`查看大图：${item.slide.title}`" @click="openLightbox(item.index, $event)">
                <img :src="item.slide.src" :alt="item.slide.alt" loading="lazy" />
                <span>点击查看大图</span>
              </button>
              <figcaption><strong>{{ item.slide.title }}</strong><span>{{ item.slide.caption }}</span></figcaption>
            </figure>
          </div>

          <div v-if="activeStep === 2" class="tutorial-folder-list" aria-label="站点文件夹示例">
            <span v-for="marketplace in marketplaceFolders" :key="marketplace">{{ marketplace }}</span>
          </div>

          <p class="tutorial-note"><strong>注意</strong>{{ activeStepDetails.note }}</p>
        </section>
      </div>

      <footer class="tutorial-footer">
        <span>图片支持大图查看，并可使用方向键切换。</span>
        <div>
          <button v-if="activeStep > 0" class="secondary-button compact" type="button" @click="selectStep(activeStep - 1)">上一项</button>
          <button v-if="activeStep < steps.length - 1" class="primary-button compact" type="button" @click="selectStep(activeStep + 1)">下一项</button>
          <button v-else class="primary-button compact" type="button" @click="close">完成</button>
        </div>
      </footer>

      <div v-if="activeLightboxSlide" class="tutorial-lightbox" role="dialog" aria-modal="true" aria-label="图片大图">
        <div class="tutorial-lightbox-toolbar">
          <div><strong>{{ activeLightboxSlide.title }}</strong><span>{{ (lightboxIndex ?? 0) + 1 }} / {{ slides.length }}</span></div>
          <button ref="lightboxCloseButton" type="button" aria-label="关闭大图" @click="closeLightbox">关闭大图</button>
        </div>
        <div class="tutorial-lightbox-stage">
          <button type="button" aria-label="上一张" @click="moveLightbox(-1)">上一张</button>
          <img :src="activeLightboxSlide.src" :alt="activeLightboxSlide.alt" />
          <button type="button" aria-label="下一张" @click="moveLightbox(1)">下一张</button>
        </div>
        <p>{{ activeLightboxSlide.caption }}</p>
      </div>
    </div>
  </dialog>
</template>
