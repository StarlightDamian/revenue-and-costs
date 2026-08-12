import { describe, expect, it } from "vitest";
import { uploadFilesContinuing, type UploadFileItem } from "../../src/web/uploads/upload-flow";

describe("large resumable upload flow", () => {
  it("sends a 300 MiB file as bounded 16 MiB chunks without allocating the file", async () => {
    const size = 300 * 1024 * 1024;
    const large: UploadFileItem = {
      key: "large.csv",
      path: "large.csv",
      size,
      remoteId: "remote-large.csv",
      state: "pending",
      source: {
        size,
        type: "text/csv",
        slice(start = 0, end = size, type = "") {
          return { size: end - start, type } as Blob;
        },
      },
    };
    const chunks: Array<{ offset: number; size: number }> = [];

    const result = await uploadFilesContinuing([large], {
      chunkBytes: 16 * 1024 * 1024,
      getOffset: async () => "0",
      uploadChunk: async (_remoteId, offset, chunk) => {
        chunks.push({ offset: Number(offset), size: chunk.size });
        return { offset: String(Number(offset) + chunk.size) };
      },
    });

    expect(result).toEqual({ completed: 1, failed: 0 });
    expect(chunks).toHaveLength(19);
    expect(chunks[0]).toEqual({ offset: 0, size: 16 * 1024 * 1024 });
    expect(chunks.at(-1)).toEqual({ offset: 288 * 1024 * 1024, size: 12 * 1024 * 1024 });
  });
});
