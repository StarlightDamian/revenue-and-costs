import { describe, expect, it, vi } from "vitest";
import {
  decideUploadPreflight,
  isClientUploadFailureCode,
  refreshUploadPreflight,
} from "../../src/modules/uploads/partial-failure.js";

describe("upload partial failure projection", () => {
  it("allows analyzed usable files to continue when a sibling file failed", () => {
    expect(decideUploadPreflight({ expected: "1", analyzed: "1", parsed: "1", awaiting: "0", failed: "1" })).toEqual({
      status: "COMMITTING",
      stage: "COPY",
      failureCode: null,
    });
  });

  it("ends with an explicit reportable failure when no usable file remains", () => {
    expect(decideUploadPreflight({ expected: "0", analyzed: "0", parsed: "0", awaiting: "0", failed: "2" })).toEqual({
      status: "FAILED",
      stage: "PREFLIGHT_COMPLETE",
      failureCode: "NO_USABLE_UPLOAD_FILES",
    });
  });

  it("keeps waiting while a usable sibling is not analyzed yet", () => {
    expect(decideUploadPreflight({ expected: "2", analyzed: "1", parsed: "1", awaiting: "0", failed: "1" })).toEqual({
      status: "ANALYZING",
      stage: "PREFLIGHT",
      failureCode: null,
    });
  });

  it("filters unknown sibling files while allowing parsed files to continue", () => {
    expect(decideUploadPreflight({ expected: "2", analyzed: "2", parsed: "1", awaiting: "1", failed: "0" })).toEqual({
      status: "COMMITTING",
      stage: "COPY",
      failureCode: null,
    });
  });

  it("fails instead of publishing an empty import when every source is unknown", () => {
    expect(decideUploadPreflight({ expected: "2", analyzed: "2", parsed: "0", awaiting: "2", failed: "0" })).toEqual({
      status: "FAILED",
      stage: "PREFLIGHT_COMPLETE",
      failureCode: "NO_USABLE_UPLOAD_FILES",
    });
  });

  it("accepts only public client failure codes and rejects internal or arbitrary codes", () => {
    expect(isClientUploadFailureCode("CLIENT_NETWORK_RETRY_EXHAUSTED")).toBe(true);
    expect(isClientUploadFailureCode("CLIENT_FILE_READ_FAILED")).toBe(true);
    expect(isClientUploadFailureCode("CLIENT_UPLOAD_ABORTED")).toBe(true);
    expect(isClientUploadFailureCode("ZIP_UNSAFE_PATH")).toBe(false);
    expect(isClientUploadFailureCode("../../arbitrary text")).toBe(false);
  });

  it("locks and stages exactly one durable automatic commit when usable parsing completes", async () => {
    const statements: string[] = [];
    const tx = { query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes("FROM import_batch WHERE id=$1 FOR UPDATE")) {
        return { rows: [{ status: "ANALYZING", shop_id: "shop-1", created_by: "actor-1" }], rowCount: 1 };
      }
      if (sql.includes("count(DISTINCT")) {
        return { rows: [{ expected: "2", analyzed: "2", parsed: "1", awaiting: "1", failed: "0" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }) };

    await expect(refreshUploadPreflight(tx as never, "upload-1", "import-1")).resolves.toEqual({
      status: "COMMITTING",
      stage: "COPY",
      failureCode: null,
    });
    expect(statements[0]).toContain("FOR UPDATE");
    expect(statements.filter((sql) => sql.includes("'import.commit'")).length).toBe(1);
    expect(statements.some((sql) => sql.includes("status=$2"))).toBe(true);
  });
});
