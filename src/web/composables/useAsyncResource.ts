import { onMounted, ref, type Ref } from "vue";

export function useAsyncResource<T>(loader: () => Promise<T>): {
  data: Ref<T | null>;
  status: Ref<"loading" | "ready" | "empty" | "error">;
  error: Ref<string>;
  reload: () => Promise<void>;
} {
  const data = ref<T | null>(null) as Ref<T | null>;
  const status = ref<"loading" | "ready" | "empty" | "error">("loading");
  const error = ref("");
  let latestRequest = 0;

  async function reload() {
    const request = ++latestRequest;
    status.value = "loading";
    error.value = "";
    try {
      const result = await loader();
      if (request !== latestRequest) return;
      data.value = result;
      status.value = Array.isArray(result) && result.length === 0 ? "empty" : "ready";
    } catch (caught) {
      if (request !== latestRequest) return;
      error.value = caught instanceof Error ? caught.message : "读取失败，请稍后重试";
      status.value = "error";
    }
  }

  onMounted(reload);
  return { data, status, error, reload };
}
