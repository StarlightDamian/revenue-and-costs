import { describe, expect, it } from "vitest";
import { deriveWorkflowSteps, type WorkflowBatchState, type WorkflowInput } from "../../src/modules/shops/workflow.js";

const batch = (overrides: Partial<WorkflowBatchState> = {}): WorkflowBatchState => ({
  id: "batch-1",
  status: "ANALYZING",
  stage: "ANALYZE",
  failureCode: null,
  declaredBytes: "1000",
  receivedBytes: "1000",
  fileCount: 10,
  processedFileCount: 4,
  warningCount: 1,
  blockingCount: 0,
  publishedSnapshotMatchesBatch: false,
  ...overrides,
});

const input = (overrides: Partial<WorkflowInput> = {}): WorkflowInput => ({
  access: "ENTERPRISE",
  shopStatus: "ACTIVE",
  hasPublishedSnapshot: false,
  canExport: true,
  ...overrides,
});

describe("shop workflow step derivation", () => {
  it("starts at data receipt without inventing progress", () => {
    const result = deriveWorkflowSteps(input());
    expect(result.currentStep).toBe("RECEIVE");
    expect(result.steps[0]).toMatchObject({ state: "NOT_STARTED", progress: null, clickable: true });
    expect(result.steps[1]).toMatchObject({ state: "NOT_STARTED", clickable: false });
  });

  it("uses processed files as real preflight progress and preserves warnings", () => {
    const result = deriveWorkflowSteps(input({ batch: batch() }));
    expect(result.currentStep).toBe("PREFLIGHT");
    expect(result.steps[0]).toMatchObject({ state: "COMPLETED", progress: "100" });
    expect(result.steps[1]).toMatchObject({ state: "IN_PROGRESS", progress: "40", severity: "WARNING", warningCount: 1 });
  });

  it("unlocks confirmation after preflight and keeps atomic commit indeterminate", () => {
    const result = deriveWorkflowSteps(input({ batch: batch({ status: "AWAITING_COMMIT_CONFIRMATION", processedFileCount: 10 }) }));
    expect(result.currentStep).toBe("COMMIT");
    expect(result.steps[1]).toMatchObject({ state: "COMPLETED", progress: "100" });
    expect(result.steps[2]).toMatchObject({ state: "NOT_STARTED", progress: null, clickable: true });
  });

  it("shows calculation and automatic publication as distinct durable stages", () => {
    const calculating = deriveWorkflowSteps(input({
      batch: batch({ status: "CALCULATING", stage: "CALCULATION", processedFileCount: 10 }),
      calculation: { status: "RUNNING", failureCode: null },
    }));
    expect(calculating.currentStep).toBe("CALCULATE");
    expect(calculating.steps[2]).toMatchObject({ state: "COMPLETED", progress: "100" });
    expect(calculating.steps[3]).toMatchObject({ state: "IN_PROGRESS", progress: null });

    const publishing = deriveWorkflowSteps(input({
      batch: batch({ status: "RESULT_PUBLISHING", stage: "PUBLISH", processedFileCount: 10 }),
      calculation: { status: "READY", failureCode: null },
    }));
    expect(publishing.currentStep).toBe("PUBLISH");
    expect(publishing.steps[3]).toMatchObject({ state: "COMPLETED", progress: "100" });
    expect(publishing.steps[4]).toMatchObject({ state: "IN_PROGRESS", progress: null });
  });

  it("marks automatic publication failure as blocking", () => {
    const result = deriveWorkflowSteps(input({
      batch: batch({ status: "READY_FOR_REVIEW", stage: "AUTO_PUBLISH_FAILED", failureCode: "AUTO_PUBLISH_FAILED", processedFileCount: 10 }),
      calculation: { status: "READY", failureCode: null },
    }));
    expect(result.currentStep).toBe("PUBLISH");
    expect(result.steps[4]).toMatchObject({ state: "NOT_STARTED", severity: "BLOCKING", blockingCount: 1, clickable: true });
  });

  it("keeps nonblocking import issues yellow but prevents future steps for an active red failure", () => {
    const warning = deriveWorkflowSteps(input({ batch: batch({ status: "COMMITTING", warningCount: 9, blockingCount: 0 }) }));
    expect(warning.steps[1]).toMatchObject({ state: "COMPLETED", severity: "WARNING", warningCount: 9 });
    expect(warning.steps[2]).toMatchObject({ state: "IN_PROGRESS", clickable: true });

    const blocker = deriveWorkflowSteps(input({ batch: batch({
      status: "FAILED",
      stage: "PREFLIGHT_COMPLETE",
      failureCode: "NO_USABLE_UPLOAD_FILES",
      warningCount: 0,
      blockingCount: 1,
    }) }));
    expect(blocker.steps[1]).toMatchObject({ severity: "BLOCKING", blockingCount: 1, clickable: true });
    expect(blocker.steps[2]).toMatchObject({ state: "NOT_STARTED", clickable: false });
  });

  it("keeps hard-incomplete confirmation red in commit and locks calculation", () => {
    const result = deriveWorkflowSteps(input({ batch: batch({
      status: "FAILED",
      stage: "CALCULATION_BLOCKED",
      failureCode: "HARD_INCOMPLETE_CONFIRMATION_REQUIRED",
      processedFileCount: 10,
    }) }));
    expect(result.steps[1]).toMatchObject({ state: "COMPLETED", severity: "WARNING" });
    expect(result.steps[2]).toMatchObject({ state: "NOT_STARTED", severity: "BLOCKING", clickable: true });
    expect(result.steps[3]).toMatchObject({ state: "NOT_STARTED", severity: "NONE", clickable: false });
    expect(result.steps[4]).toMatchObject({ state: "NOT_STARTED", clickable: false });
    expect(result.currentStep).toBe("COMMIT");
  });

  it("does not expose draft stages to customers", () => {
    const result = deriveWorkflowSteps(input({ access: "CUSTOMER", hasPublishedSnapshot: true, canExport: false }));
    expect(result.steps.slice(0, 4).every((step) => step.state === "COMPLETED" && !step.clickable)).toBe(true);
    expect(result.steps[4]).toMatchObject({ state: "COMPLETED", clickable: true });
    expect(result.steps[5]).toMatchObject({ clickable: false });
  });

  it("makes report download green as soon as the current formal snapshot is downloadable", () => {
    const result = deriveWorkflowSteps(input({
      hasPublishedSnapshot: true,
      batch: batch({ status: "RESULT_PUBLISHED", publishedSnapshotMatchesBatch: true }),
    }));
    expect(result.steps[5]).toMatchObject({ state: "COMPLETED", progress: "100", clickable: true });
  });

  it("keeps download readiness green even when an older generation task failed", () => {
    const result = deriveWorkflowSteps(input({
      hasPublishedSnapshot: true,
      batch: batch({ status: "RESULT_PUBLISHED", publishedSnapshotMatchesBatch: true }),
      latestExport: { id: "export-1", snapshotId: "snapshot-1", status: "FAILED", progress: "20" },
    }));
    expect(result.steps[5]).toMatchObject({ state: "COMPLETED", severity: "NONE", progress: "100", clickable: true });
  });

  it("keeps export and quick download locked while the latest batch has not produced the current snapshot", () => {
    const result = deriveWorkflowSteps(input({
      hasPublishedSnapshot: true,
      batch: batch({ status: "CALCULATING", publishedSnapshotMatchesBatch: false }),
    }));
    expect(result.steps[5]).toMatchObject({ state: "NOT_STARTED", clickable: false });
  });
});
