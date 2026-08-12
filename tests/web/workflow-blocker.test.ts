import { describe, expect, it } from "vitest";
import type { ShopWorkflow, WorkflowStepCode } from "../../src/web/api/types.js";
import { workflowBlockerPresentation } from "../../src/web/workflow-blocker.js";

const stepCodes: WorkflowStepCode[] = ["RECEIVE", "PREFLIGHT", "COMMIT", "CALCULATE", "PUBLISH", "EXPORT"];

function workflow(overrides: Partial<ShopWorkflow> = {}): ShopWorkflow {
  return {
    shop: { id: "shop-1", name: "测试公司", access: "ENTERPRISE", status: "ACTIVE", canEdit: true },
    diagnosticId: "I0000000000000000000001",
    currentStep: "CALCULATE",
    steps: stepCodes.map((code) => ({
      code,
      label: code,
      state: code === "CALCULATE" ? "NOT_STARTED" : "COMPLETED",
      severity: code === "CALCULATE" ? "BLOCKING" : "NONE",
      progress: code === "CALCULATE" ? null : "100",
      warningCount: 0,
      blockingCount: code === "CALCULATE" ? 1 : 0,
      clickable: true,
    })),
    latestBatch: {
      id: "batch-1",
      status: "FAILED",
      stage: "CALCULATION_BLOCKED",
      failureCode: "FX_DATA_GAP:BRL:2025-12-30",
    },
    download: { available: false, usesPreviousPublishedVersion: false },
    ...overrides,
  };
}

describe("workflow blocker presentation", () => {
  it("links an administrator from a dated FX blocker to the prefilled market page", () => {
    const blocker = workflowBlockerPresentation(workflow(), true);

    expect(blocker).toMatchObject({
      title: "计算所需汇率缺失",
      message: expect.stringContaining("2025-12-30 BRL/CNY"),
      diagnosticId: "I0000000000000000000001",
      action: { label: "前往外汇市场", to: "/fx?currency=BRL&date=2025-12-30" },
    });
    expect(blocker?.key).toContain("FX_DATA_GAP:BRL:2025-12-30");
  });

  it("tells a non-admin to contact an administrator without exposing a write action", () => {
    const blocker = workflowBlockerPresentation(workflow(), false);

    expect(blocker?.message).toContain("请联系管理员");
    expect(blocker?.action).toEqual({ label: "查看计算复核", to: "/shops/shop-1/workflow/calculate" });
  });

  it("falls back to the blocking workflow step when no failure code is available", () => {
    const input = workflow({
      currentStep: "PREFLIGHT",
      latestBatch: { id: "batch-2", status: "AWAITING_MAPPING", stage: "PREFLIGHT", failureCode: null },
      steps: stepCodes.map((code) => ({
        code,
        label: code === "PREFLIGHT" ? "预检解析" : code,
        state: code === "PREFLIGHT" ? "NOT_STARTED" : "COMPLETED",
        severity: code === "PREFLIGHT" ? "BLOCKING" : "NONE",
        progress: null,
        warningCount: 0,
        blockingCount: code === "PREFLIGHT" ? 1 : 0,
        clickable: true,
      })),
    });

    expect(workflowBlockerPresentation(input, false)).toMatchObject({
      title: "预检解析被阻断",
      action: { label: "查看资料准备", to: "/shops/shop-1/workflow/commit" },
    });
  });

  it("prioritizes an unavailable worker over a generic workflow failure", () => {
    const input = workflow({ processingHealth: { workerAvailable: false } });

    expect(workflowBlockerPresentation(input, false)).toMatchObject({
      title: "后台处理服务暂不可用",
      message: expect.stringContaining("请稍后重试或联系管理员，并提供诊断 ID"),
    });
  });

  it("surfaces a terminal job whose original callback has not released safely", () => {
    const input = workflow({
      latestBatch: { id: "batch-5", status: "CALCULATING", stage: "CALCULATION", failureCode: null },
      processingHealth: { workerAvailable: true, terminalRecoveryBlocked: true },
    });

    expect(workflowBlockerPresentation(input, false)).toMatchObject({
      title: "后台任务恢复受阻",
      message: expect.stringContaining("当前流程已明确标记为阻断"),
    });
    expect(workflowBlockerPresentation(input, false)?.key).toContain("TERMINAL_RECOVERY_BLOCKED");
  });

  it("reports a failed export even when no workflow step is marked blocking", () => {
    const input = workflow({
      latestBatch: { id: "batch-3", status: "PUBLISHED", stage: "RESULT_PUBLISHED", failureCode: null },
      steps: stepCodes.map((code) => ({
        code, label: code, state: "COMPLETED", severity: "NONE", progress: "100", warningCount: 0, blockingCount: 0, clickable: true,
      })),
      download: {
        available: false,
        usesPreviousPublishedVersion: false,
        latestExport: { id: "export-1", snapshotId: "snapshot-1", status: "FAILED", progress: "40", stage: "FAILED" },
      },
    });

    expect(workflowBlockerPresentation(input, false)).toMatchObject({
      key: "export:export-1:FAILED:FAILED",
      title: "报告生成失败",
      action: { label: "查看报告交付", to: "/shops/shop-1/workflow/export" },
    });
  });

  it("does not report warnings or ordinary unfinished work as blockers", () => {
    const input = workflow({
      latestBatch: { id: "batch-4", status: "CALCULATING", stage: "CALCULATION", failureCode: null },
      steps: stepCodes.map((code) => ({
        code, label: code, state: code === "CALCULATE" ? "IN_PROGRESS" : "COMPLETED", severity: code === "CALCULATE" ? "WARNING" : "NONE", progress: "50", warningCount: code === "CALCULATE" ? 1 : 0, blockingCount: 0, clickable: true,
      })),
    });

    expect(workflowBlockerPresentation(input, false)).toBeNull();
  });
});
