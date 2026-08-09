import { describe, expect, it } from "vitest";
import { diagnosticReferenceId, diagnosticReferenceUuid } from "../../src/shared/diagnostic-reference.js";

describe("diagnostic reference", () => {
  it("encodes a UUID as a fixed alphanumeric reference and reverses it", () => {
    const uuid = "40c10dd4-f144-420e-a38e-b1255f86835b";
    const reference = diagnosticReferenceId("E", uuid);

    expect(reference).toMatch(/^E[0-9A-Za-z]{22}$/u);
    expect(diagnosticReferenceUuid(reference)).toEqual({ kind: "E", uuid });
  });

  it("keeps object namespaces distinct", () => {
    const uuid = "40c10dd4-f144-420e-a38e-b1255f86835b";
    expect(diagnosticReferenceId("I", uuid)).not.toBe(diagnosticReferenceId("E", uuid));
  });
});
