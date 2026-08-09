import { describe, expect, it } from "vitest";
import {
  summarizePerformanceDelta,
  type PerformanceCheckpoint,
} from "../../scripts/performance-metrics.js";

function checkpoint(input: {
  readonly label: string;
  readonly capturedAt: string;
  readonly storageCaptured: boolean;
  readonly totalBytes: string;
}): PerformanceCheckpoint {
  return {
    label: input.label,
    capturedAt: input.capturedAt,
    generation: "test-generation",
    processes: [],
    database: {
      sampledAt: input.capturedAt,
      statsReset: null,
      walLsn: "0/0",
      databaseBytes: "0",
      xactCommit: "0",
      xactRollback: "0",
      blocksRead: "0",
      blocksHit: "0",
      tuplesReturned: "0",
      tuplesFetched: "0",
      tuplesInserted: "0",
      tuplesUpdated: "0",
      tuplesDeleted: "0",
      conflicts: "0",
      tempFiles: "0",
      tempBytes: "0",
      deadlocks: "0",
      blockReadTimeMs: "0",
      blockWriteTimeMs: "0",
      activeTimeMs: "0",
      sessions: "0",
    },
    storage: {
      totalBytes: input.totalBytes,
      temporaryBytes: "0",
      fileCount: 0,
      temporaryFileCount: 0,
    },
    storageCaptured: input.storageCaptured,
  } as PerformanceCheckpoint;
}

describe("performance checkpoint deltas", () => {
  it("does not claim a storage delta from a reused intermediate snapshot", () => {
    const before = checkpoint({
      label: "before-upload",
      capturedAt: "2026-08-06T00:00:00.000Z",
      storageCaptured: true,
      totalBytes: "100",
    });
    const after = checkpoint({
      label: "after-upload",
      capturedAt: "2026-08-06T00:00:01.000Z",
      storageCaptured: false,
      totalBytes: "100",
    });

    expect(summarizePerformanceDelta(before, after)).toMatchObject({
      wallMs: 1_000,
      storage: { measured: false },
    });
  });

  it("reports storage change only between two fresh directory samples", () => {
    const before = checkpoint({
      label: "before-upload",
      capturedAt: "2026-08-06T00:00:00.000Z",
      storageCaptured: true,
      totalBytes: "100",
    });
    const after = checkpoint({
      label: "after-export",
      capturedAt: "2026-08-06T00:00:02.000Z",
      storageCaptured: true,
      totalBytes: "175",
    });

    expect(summarizePerformanceDelta(before, after)).toMatchObject({
      wallMs: 2_000,
      storage: {
        measured: true,
        totalBytesDelta: "75",
      },
    });
  });
});
