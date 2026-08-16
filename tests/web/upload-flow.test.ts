import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { prepareUploadChecksum, sha256Base64 } from "../../src/web/uploads/checksum";
import { uploadBatchConclusion, uploadFilesContinuing, uploadFailureMessage, type UploadFileItem } from "../../src/web/uploads/upload-flow";
import { api } from "../../src/web/api/client";

function item(path: string, value: string): UploadFileItem {
  const bytes = new TextEncoder().encode(value);
  return {
    key: path,
    path,
    size: bytes.byteLength,
    remoteId: `remote-${path}`,
    state: "pending",
    source: new Blob([bytes]),
  };
}

describe("HTTP 上传的分片校验和", () => {
  it("在 insecure context 没有 SubtleCrypto 时仍生成标准 SHA-256 Base64", async () => {
    for (const value of ["", "abc", "a".repeat(1_000_000)]) {
      const bytes = new TextEncoder().encode(value);
      const expected = createHash("sha256").update(bytes).digest("base64");
      await expect(sha256Base64(bytes.buffer, null)).resolves.toBe(expected);
    }
    await expect(prepareUploadChecksum()).resolves.toBeUndefined();
  });

  it("有 Web Crypto 时优先使用平台实现", async () => {
    const digest = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
    await expect(sha256Base64(new Uint8Array([9]).buffer, { digest })).resolves.toBe("AQID");
    expect(digest).toHaveBeenCalledWith("SHA-256", expect.any(ArrayBuffer));
  });

  it("api.uploadChunk 在 crypto.subtle 缺失时仍发送兼容的校验和", async () => {
    const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalFetch = globalThis.fetch;
    const requests: RequestInit[] = [];
    try {
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
      Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
      globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        return new Response(null, { status: 204, headers: { "Upload-Offset": "3" } });
      });
      await expect(api.uploadChunk("file-id", "0", new Blob(["abc"]))).resolves.toEqual({ offset: "3" });
      const headers = new Headers(requests[0]?.headers);
      expect(headers.get("Upload-Checksum")).toBe(`sha256 ${createHash("sha256").update("abc").digest("base64")}`);
    } finally {
      if (originalCrypto) Object.defineProperty(globalThis, "crypto", originalCrypto);
      else Reflect.deleteProperty(globalThis, "crypto");
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      globalThis.fetch = originalFetch;
    }
  });

  it("compresses a repetitive CSV chunk for transport while checksumming the original bytes", async () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalFetch = globalThis.fetch;
    let request: RequestInit | undefined;
    const chunk = new Blob(["date,amount\n2026-08-10,123.45\n".repeat(10_000)], { type: "text/csv" });
    try {
      Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
      globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        request = init;
        return new Response(null, { status: 204, headers: { "Upload-Offset": String(chunk.size) } });
      });

      await expect(api.uploadChunk("file-id", "0", chunk)).resolves.toEqual({ offset: String(chunk.size) });

      const headers = new Headers(request?.headers);
      expect(headers.get("Upload-Content-Encoding")).toBe("gzip");
      expect(headers.get("Upload-Uncompressed-Length")).toBe(String(chunk.size));
      expect(headers.get("Upload-Checksum")).toBe(`sha256 ${createHash("sha256").update(Buffer.from(await chunk.arrayBuffer())).digest("base64")}`);
      expect((request?.body as Blob).size).toBeLessThan(chunk.size);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      globalThis.fetch = originalFetch;
    }
  });
});

describe("单文件上传失败恢复", () => {
  it("空批次保持在显式开始前的选择状态", () => {
    expect(uploadBatchConclusion([])).toEqual({
      tone: "neutral",
      title: "等待选择",
      detail: "可继续追加文件；确认清单后点击“开始上传”。",
    });
  });

  it("all upload status messages avoid internal terms", () => {
    const messages = [
      uploadFailureMessage(1),
      ...[
        [{ state: "failed" as const }],
        [{ state: "skipped" as const }, { state: "complete" as const }],
        [{ state: "complete" as const }],
      ].flatMap((items) => Object.values(uploadBatchConclusion(items))),
    ].join(" ");
    expect(messages).not.toMatch(/预检|入库|阻断|相对路径|制表符|原生选择器|切片|诊断|offset|分片|批次/u);
  });

  it("标记失败文件、继续其余文件，重试时跳过已完成文件并从服务器确认的位置续传", async () => {
    const first = { ...item("first.csv", "abcd"), initialOffset: "0" };
    const second = { ...item("second.csv", "xy"), initialOffset: "0" };
    const chunks: string[] = [];
    let firstAttempt = true;
    const getOffset = vi.fn(async (remoteId: string) => remoteId === first.remoteId && !firstAttempt ? "2" : "0");
    const uploadChunk = vi.fn(async (remoteId: string, offset: string, chunk: Blob) => {
      chunks.push(`${remoteId}:${offset}:${chunk.size}`);
      if (remoteId === first.remoteId && firstAttempt) {
        firstAttempt = false;
        throw new Error("NETWORK_INTERRUPTED");
      }
      return { offset: String(Number(offset) + chunk.size) };
    });

    const failed = await uploadFilesContinuing([first, second], { chunkBytes: 2, fileConcurrency: 4, getOffset, uploadChunk });
    expect(failed).toEqual({ completed: 1, failed: 1 });
    expect(first).toMatchObject({ state: "failed", error: "NETWORK_INTERRUPTED" });
    expect(second.state).toBe("complete");
    expect("error" in second).toBe(false);
    expect(chunks).toContain(`remote-${second.path}:0:2`);
    expect(getOffset).not.toHaveBeenCalled();
    expect(uploadFailureMessage(failed.failed)).toContain("继续上传");
    expect(uploadFailureMessage(failed.failed)).toContain("上次成功的位置");
    expect(uploadFailureMessage(failed.failed)).not.toContain("offset");

    chunks.length = 0;
    const retried = await uploadFilesContinuing([first, second], { chunkBytes: 2, fileConcurrency: 4, getOffset, uploadChunk });
    expect(retried).toEqual({ completed: 2, failed: 0 });
    expect(first.state).toBe("complete");
    expect("error" in first).toBe(false);
    expect(chunks).toEqual([`remote-${first.path}:2:2`]);
    expect(getOffset).toHaveBeenCalledOnce();
    expect(getOffset).toHaveBeenCalledWith(first.remoteId);
  });

  it("新注册的 PDF 元数据文件使用返回的 0 offset，不发 HEAD 或正文 PATCH", async () => {
    const pdf = { ...item("invoice.pdf", ""), initialOffset: "0" };
    const getOffset = vi.fn(async () => { throw new Error("HEAD_NOT_EXPECTED"); });
    const uploadChunk = vi.fn(async () => { throw new Error("PATCH_NOT_EXPECTED"); });

    await expect(uploadFilesContinuing([pdf], { chunkBytes: 2, fileConcurrency: 4, getOffset, uploadChunk }))
      .resolves.toEqual({ completed: 1, failed: 0 });
    expect(pdf.state).toBe("complete");
    expect(getOffset).not.toHaveBeenCalled();
    expect(uploadChunk).not.toHaveBeenCalled();
  });

  it("拒绝服务端倒退、越界或非整数 offset，并继续其他文件", async () => {
    const broken = item("broken.csv", "abcd");
    const healthy = item("healthy.csv", "ok");
    const result = await uploadFilesContinuing([broken, healthy], {
      chunkBytes: 2,
      fileConcurrency: 4,
      getOffset: async (remoteId) => remoteId === broken.remoteId ? "5" : "0",
      uploadChunk: async (_remoteId, offset, chunk) => ({ offset: String(Number(offset) + chunk.size) }),
    });
    expect(result).toEqual({ completed: 1, failed: 1 });
    expect(broken.error).toBe("服务器返回的上传位置不正确，请重新选择该文件后再试");
    expect(healthy.state).toBe("complete");
  });

  it("全部文件失败时给出无可计算数据的批次结论", async () => {
    const files = [item("one.csv", "1"), item("two.csv", "2")];
    await uploadFilesContinuing(files, {
      chunkBytes: 2,
      fileConcurrency: 4,
      getOffset: async () => "0",
      uploadChunk: async () => { throw new Error("OFFLINE"); },
    });
    expect(uploadBatchConclusion(files)).toEqual(expect.objectContaining({ tone: "error", title: "无可计算数据" }));
    for (const file of files) file.state = "skipped";
    expect(uploadBatchConclusion(files)).toEqual(expect.objectContaining({ tone: "error", title: "无可计算数据" }));
  });

  it("最多同时上传四个文件", async () => {
    const files = Array.from({ length: 8 }, (_, index) => ({ ...item(`part-${index}.csv`, "x"), initialOffset: "0" }));
    let active = 0;
    let maximumActive = 0;
    let releaseUploads = () => {};
    const gate = new Promise<void>((resolve) => { releaseUploads = resolve; });
    const uploadChunk = vi.fn(async (_remoteId: string, offset: string, chunk: Blob) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await gate;
      active -= 1;
      return { offset: String(Number(offset) + chunk.size) };
    });

    const running = uploadFilesContinuing(files, {
      chunkBytes: 1,
      fileConcurrency: 4,
      getOffset: async () => "0",
      uploadChunk,
    });
    try {
      await vi.waitFor(() => { expect(active).toBe(4); }, { timeout: 500 });
      expect(maximumActive).toBe(4);
    } finally {
      releaseUploads();
    }

    await expect(running).resolves.toEqual({ completed: 8, failed: 0 });
    expect(maximumActive).toBe(4);
  });

  it("同一文件的分片严格按 offset 串行，不同文件可交错", async () => {
    const files = [
      { ...item("first.csv", "abcdef"), initialOffset: "0" },
      { ...item("second.csv", "uvwxyz"), initialOffset: "0" },
    ];
    const activeFiles = new Set<string>();
    const offsets = new Map<string, string[]>();
    const uploadChunk = vi.fn(async (remoteId: string, offset: string, chunk: Blob) => {
      expect(activeFiles.has(remoteId)).toBe(false);
      activeFiles.add(remoteId);
      offsets.set(remoteId, [...(offsets.get(remoteId) ?? []), offset]);
      await Promise.resolve();
      activeFiles.delete(remoteId);
      return { offset: String(Number(offset) + chunk.size) };
    });

    await expect(uploadFilesContinuing(files, {
      chunkBytes: 2,
      fileConcurrency: 4,
      getOffset: async () => "0",
      uploadChunk,
    })).resolves.toEqual({ completed: 2, failed: 0 });

    expect(offsets.get(files[0]!.remoteId)).toEqual(["0", "2", "4"]);
    expect(offsets.get(files[1]!.remoteId)).toEqual(["0", "2", "4"]);
    expect(uploadChunk.mock.calls.slice(0, 2).map(([remoteId]) => remoteId)).toEqual([
      files[0]!.remoteId,
      files[1]!.remoteId,
    ]);
  });

  it("并发上传时结果和累计进度保持守恒", async () => {
    const done = { ...item("done.csv", "abc"), state: "complete" as const };
    const skipped = { ...item("skipped.csv", "no"), state: "skipped" as const };
    const resumed = { ...item("resumed.csv", "abcd"), initialOffset: "2" };
    const empty = { ...item("empty.csv", ""), initialOffset: "0" };
    const fresh = { ...item("fresh.csv", "xyz"), initialOffset: "0" };
    const progress: number[] = [];
    const getOffset = vi.fn(async () => "0");

    await expect(uploadFilesContinuing([done, skipped, resumed, empty, fresh], {
      chunkBytes: 2,
      fileConcurrency: 4,
      getOffset,
      uploadChunk: async (_remoteId, offset, chunk) => ({ offset: String(Number(offset) + chunk.size) }),
      onProgress: (sent) => { progress.push(sent); },
    })).resolves.toEqual({ completed: 4, failed: 0 });

    expect(getOffset).not.toHaveBeenCalled();
    expect(progress[0]).toBe(done.size);
    expect(progress.at(-1)).toBe(done.size + resumed.size + empty.size + fresh.size);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1]!)).toBe(true);
    expect(skipped.state).toBe("skipped");
  });

  it("拒绝超过安全上限或非整数的文件并发配置", async () => {
    const dependencies = {
      chunkBytes: 2,
      getOffset: async () => "0",
      uploadChunk: async (_remoteId: string, offset: string, chunk: Blob) => ({ offset: String(Number(offset) + chunk.size) }),
    };
    for (const fileConcurrency of [0, 5, 1.5]) {
      await expect(uploadFilesContinuing([], { ...dependencies, fileConcurrency })).rejects.toThrow("上传文件并发数无效");
    }
  });
});

describe("上传批次文件注册", () => {
  it("一次注册整批文件，保持返回顺序和 PDF 元数据契约", async () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalFetch = globalThis.fetch;
    const requestBodies: Array<Record<string, unknown>> = [];
    try {
      Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        expect(path.endsWith("/api/v1/uploads/batches")).toBe(true);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
          files: Array<{ relativePath: string }>;
        };
        requestBodies.push(body);
        return Response.json({
          id: "batch-id",
          files: body.files.map((file) => ({ id: `remote-${file.relativePath}`, relativePath: file.relativePath, offset: "0" })),
        });
      });
      const files = Array.from({ length: 11 }, (_, index) => ({
        relativePath: index === 10 ? "invoice.pdf" : `part-${index}.csv`,
        bytes: index === 10 ? "0" : "12",
        contentType: index === 10 ? "application/pdf" : "text/csv",
        ...(index === 10 ? { metadataOnly: true } : {}),
      }));

      const result = await api.createUploadBatch("shop-id", files);

      expect(globalThis.fetch).toHaveBeenCalledOnce();
      expect(result.files.map((file) => file.relativePath)).toEqual(files.map((file) => file.relativePath));
      expect(result.files.every((file) => file.offset === "0")).toBe(true);
      expect(requestBodies).toHaveLength(1);
      expect(requestBodies[0]).toEqual(expect.objectContaining({
        shopId: "shop-id",
        fileCount: 11,
      }));
      expect(requestBodies[0]?.files).toContainEqual(expect.objectContaining({
        relativePath: "invoice.pdf",
        declaredSize: "0",
        metadataOnly: true,
      }));
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      globalThis.fetch = originalFetch;
    }
  });

  it("批量注册失败时保持原错误并且不自动重试", async () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalFetch = globalThis.fetch;
    let failedFileCalls = 0;
    try {
      Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const path = String(input);
        if (path.endsWith("/api/v1/uploads/batches")) {
          failedFileCalls += 1;
          return Response.json({ code: "UPLOAD_BATCH_LIMIT", message: "registration failed" }, { status: 409 });
        }
        throw new Error(`unexpected request: ${path} ${String(init?.body)}`);
      });

      await expect(api.createUploadBatch("shop-id", Array.from({ length: 8 }, (_, index) => ({
        relativePath: `part-${index}.csv`,
        bytes: "12",
        contentType: "text/csv",
      })))).rejects.toMatchObject({ code: "UPLOAD_BATCH_LIMIT", message: "registration failed", status: 409 });
      expect(failedFileCalls).toBe(1);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      globalThis.fetch = originalFetch;
    }
  });

  it("响应丢失时仅使用同一 Idempotency-Key 重放一次", async () => {
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    const originalFetch = globalThis.fetch;
    const keys: string[] = [];
    let calls = 0;
    try {
      Object.defineProperty(globalThis, "document", { configurable: true, value: { cookie: "" } });
      globalThis.fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
        if (calls === 1) throw new TypeError("response lost");
        return Response.json({
          id: "batch-id",
          files: [{ id: "remote-part-1", relativePath: "part-1.csv", offset: "0" }],
        });
      });

      await expect(api.createUploadBatch("shop-id", [{
        relativePath: "part-1.csv",
        bytes: "12",
        contentType: "text/csv",
      }])).resolves.toMatchObject({ id: "batch-id" });

      expect(calls).toBe(2);
      expect(keys[0]).toBeTruthy();
      expect(keys[1]).toBe(keys[0]);
    } finally {
      if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
      else Reflect.deleteProperty(globalThis, "document");
      globalThis.fetch = originalFetch;
    }
  });
});
