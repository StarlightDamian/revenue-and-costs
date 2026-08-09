import { describe, expect, it } from "vitest";
import { safeErrorDiagnostic } from "../../src/shared/diagnostics.js";

describe("safe error diagnostics", () => {
  it("keeps stable machine codes needed by CLI troubleshooting", () => {
    expect(safeErrorDiagnostic(new Error("IMPORT_REPORT_DATE_INVALID"))).toMatchObject({
      errorType: "Error",
      errorMessageCode: "IMPORT_REPORT_DATE_INVALID",
    });
  });

  it("does not expose free-form messages or source data", () => {
    expect(safeErrorDiagnostic(new Error("bad row for 13800000000"))).not.toHaveProperty("errorMessageCode");
  });

  it("keeps only the stable prefix from a contextual machine error", () => {
    expect(safeErrorDiagnostic(new Error("FX_NO_AVAILABLE_QUOTE:USD:2025-12-28"))).toMatchObject({
      errorMessageCode: "FX_NO_AVAILABLE_QUOTE",
    });
  });

  it("keeps safe PostgreSQL constraint names for CLI troubleshooting", () => {
    const error = Object.assign(new Error("new row violates check constraint"), {
      code: "23514",
      constraint: "import_file_check",
    });

    expect(safeErrorDiagnostic(error)).toMatchObject({
      errorSystemCode: "23514",
      errorConstraint: "import_file_check",
    });
  });
});
