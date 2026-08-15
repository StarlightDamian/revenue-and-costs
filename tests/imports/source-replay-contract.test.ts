import { describe, expect, it } from "vitest";
import {
  sourceReplayClosureHash,
  type SourceReplayClosureRow,
} from "../../src/modules/imports/source-replay-contract.js";

const first: SourceReplayClosureRow = {
  dataset_version_id: "10000000-0000-4000-8000-000000000001",
  report_kind: "SHIPMENT",
  import_file_id: "20000000-0000-4000-8000-000000000001",
  stored_object_id: "30000000-0000-4000-8000-000000000001",
  mapping_version_id: "40000000-0000-4000-8000-000000000001",
};
const second: SourceReplayClosureRow = {
  dataset_version_id: "10000000-0000-4000-8000-000000000002",
  report_kind: "TRANSACTION",
  import_file_id: "20000000-0000-4000-8000-000000000002",
  stored_object_id: "30000000-0000-4000-8000-000000000002",
  mapping_version_id: "40000000-0000-4000-8000-000000000002",
};

describe("source replay closure contract", () => {
  it("hashes the same closure independently of query row order", () => {
    expect(sourceReplayClosureHash([second, first])).toBe(sourceReplayClosureHash([first, second]));
  });

  it.each([
    ["dataset_version_id", "10000000-0000-4000-8000-000000000099"],
    ["report_kind", "TRANSACTION"],
    ["import_file_id", "20000000-0000-4000-8000-000000000099"],
    ["stored_object_id", "30000000-0000-4000-8000-000000000099"],
    ["mapping_version_id", "40000000-0000-4000-8000-000000000099"],
  ] as const)("changes when %s changes", (field, value) => {
    const changed = { ...first, [field]: value };
    expect(sourceReplayClosureHash([changed, second])).not.toBe(sourceReplayClosureHash([first, second]));
  });
});
