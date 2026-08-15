import { describe, expect, it } from "vitest";
import { compactDiagnosticId, diagnosticClipboardText } from "../../src/web/diagnostic-id-presentation.js";

describe("diagnostic ID presentation", () => {
  it("shortens a 23-character reference by about 60% with a stable middle ellipsis", () => {
    const fullId = "I4QQr6qR79OTD82CkROjVDq";

    expect(compactDiagnosticId(fullId)).toBe("I4QQ…jVDq");
    expect([...compactDiagnosticId(fullId)]).toHaveLength(9);
  });

  it("does not alter short references and keeps the full ID in clipboard text", () => {
    expect(compactDiagnosticId("I1234567")).toBe("I1234567");
    expect(diagnosticClipboardText("I4QQr6qR79OTD82CkROjVDq")).toBe(
      "处理编号：I4QQr6qR79OTD82CkROjVDq",
    );
  });
});
