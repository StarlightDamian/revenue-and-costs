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
});

describe("单文件上传失败恢复", () => {
  it("标记失败文件、继续其余文件，重试时跳过已完成文件并按服务端 offset 续传", async () => {
    const first = item("first.csv", "abcd");
    const second = item("second.csv", "xy");
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

    const failed = await uploadFilesContinuing([first, second], { chunkBytes: 2, getOffset, uploadChunk });
    expect(failed).toEqual({ completed: 1, failed: 1 });
    expect(first).toMatchObject({ state: "failed", error: "NETWORK_INTERRUPTED" });
    expect(second.state).toBe("complete");
    expect("error" in second).toBe(false);
    expect(chunks).toContain(`remote-${second.path}:0:2`);
    expect(uploadFailureMessage(failed.failed)).toContain("继续上传");

    chunks.length = 0;
    const retried = await uploadFilesContinuing([first, second], { chunkBytes: 2, getOffset, uploadChunk });
    expect(retried).toEqual({ completed: 2, failed: 0 });
    expect(first.state).toBe("complete");
    expect("error" in first).toBe(false);
    expect(chunks).toEqual([`remote-${first.path}:2:2`]);
  });

  it("拒绝服务端倒退、越界或非整数 offset，并继续其他文件", async () => {
    const broken = item("broken.csv", "abcd");
    const healthy = item("healthy.csv", "ok");
    const result = await uploadFilesContinuing([broken, healthy], {
      chunkBytes: 2,
      getOffset: async (remoteId) => remoteId === broken.remoteId ? "5" : "0",
      uploadChunk: async (_remoteId, offset, chunk) => ({ offset: String(Number(offset) + chunk.size) }),
    });
    expect(result).toEqual({ completed: 1, failed: 1 });
    expect(broken.error).toBe("服务端返回了无效的上传 offset");
    expect(healthy.state).toBe("complete");
  });

  it("全部文件失败时给出无可计算数据的批次结论", async () => {
    const files = [item("one.csv", "1"), item("two.csv", "2")];
    await uploadFilesContinuing(files, {
      chunkBytes: 2,
      getOffset: async () => "0",
      uploadChunk: async () => { throw new Error("OFFLINE"); },
    });
    expect(uploadBatchConclusion(files)).toEqual(expect.objectContaining({ tone: "error", title: "无可计算数据" }));
    for (const file of files) file.state = "skipped";
    expect(uploadBatchConclusion(files)).toEqual(expect.objectContaining({ tone: "error", title: "无可计算数据" }));
  });
});
