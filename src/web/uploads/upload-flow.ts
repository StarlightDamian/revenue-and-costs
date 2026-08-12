export type UploadFileState = "pending" | "uploading" | "complete" | "failed" | "skipped";

export interface UploadFileItem {
  readonly key: string;
  readonly path: string;
  readonly size: number;
  remoteId: string;
  initialOffset?: string;
  readonly source: Pick<Blob, "size" | "slice" | "type">;
  state: UploadFileState;
  error?: string;
}

export interface UploadFlowDependencies {
  readonly chunkBytes: number;
  readonly fileConcurrency?: number;
  getOffset(remoteId: string): Promise<string>;
  uploadChunk(remoteId: string, offset: string, chunk: Blob): Promise<{ readonly offset: string }>;
  onProgress?(sent: number): void;
  onStateChange?(item: UploadFileItem): void;
}

export interface UploadFlowResult {
  readonly completed: number;
  readonly failed: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : "文件上传失败";
}

function validOffset(value: string, size: number): number {
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new Error("服务端返回了无效的上传 offset");
  return offset;
}

export async function uploadFilesContinuing(
  items: readonly UploadFileItem[],
  dependencies: UploadFlowDependencies,
): Promise<UploadFlowResult> {
  if (!Number.isSafeInteger(dependencies.chunkBytes) || dependencies.chunkBytes < 1) throw new Error("上传分片大小无效");
  const fileConcurrency = dependencies.fileConcurrency ?? 1;
  if (!Number.isSafeInteger(fileConcurrency) || fileConcurrency < 1 || fileConcurrency > 4) {
    throw new Error("上传文件并发数无效");
  }
  let completed = items.filter((item) => item.state === "complete").length;
  let failed = 0;
  let sent = items.filter((item) => item.state === "complete").reduce((sum, item) => sum + item.size, 0);
  dependencies.onProgress?.(sent);

  async function uploadFile(item: UploadFileItem): Promise<void> {
    try {
      const initialOffset = item.state === "pending" ? item.initialOffset : undefined;
      delete item.initialOffset;
      item.state = "uploading";
      delete item.error;
      dependencies.onStateChange?.(item);
      let offset = validOffset(initialOffset ?? await dependencies.getOffset(item.remoteId), item.size);
      sent += offset;
      dependencies.onProgress?.(sent);
      while (offset < item.size) {
        const chunk = item.source.slice(offset, Math.min(offset + dependencies.chunkBytes, item.size), item.source.type);
        const next = await dependencies.uploadChunk(item.remoteId, String(offset), chunk);
        const nextOffset = validOffset(next.offset, item.size);
        if (nextOffset <= offset) throw new Error("服务端返回了无效的上传 offset");
        sent += nextOffset - offset;
        offset = nextOffset;
        dependencies.onProgress?.(sent);
      }
      item.state = "complete";
      completed += 1;
      dependencies.onStateChange?.(item);
    } catch (error) {
      item.state = "failed";
      item.error = errorMessage(error);
      failed += 1;
      dependencies.onStateChange?.(item);
    }
  }

  let nextIndex = 0;
  async function uploadNext(): Promise<void> {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      if (!item || item.state === "complete" || item.state === "skipped") continue;
      await uploadFile(item);
    }
  }

  const workerCount = Math.min(fileConcurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, uploadNext));
  return { completed, failed };
}

export function uploadFailureMessage(failed: number): string {
  return `${failed} 个文件上传失败；其他文件已继续处理。请检查失败项后点击“继续上传”，系统会从服务端确认的 offset 续传。`;
}

export function uploadBatchConclusion(items: readonly Pick<UploadFileItem, "state">[]): {
  readonly tone: "neutral" | "warning" | "error" | "success";
  readonly title: string;
  readonly detail: string;
} {
  const failed = items.filter((item) => item.state === "failed").length;
  const skipped = items.filter((item) => item.state === "skipped").length;
  const complete = items.filter((item) => item.state === "complete").length;
  if (items.length > 0 && failed + skipped === items.length) {
    return { tone: "error", title: "无可计算数据", detail: "所有文件上传失败；修复连接或浏览器环境后可继续上传。" };
  }
  if (skipped > 0) {
    return { tone: "warning", title: "部分文件已跳过", detail: `${skipped} 个失败文件不会进入计算，${complete} 个文件已进入预检。` };
  }
  if (failed > 0) {
    return { tone: "warning", title: "批次尚未完成", detail: `${failed} 个文件失败，${complete} 个文件已完成；失败项续传成功前不会开始预检。` };
  }
  if (items.length > 0 && complete === items.length) {
    return { tone: "success", title: "文件上传完成", detail: "全部文件已接收，正在进入预检。" };
  }
  return { tone: "neutral", title: "等待选择", detail: "可继续追加文件；确认清单后点击“开始上传”。" };
}
