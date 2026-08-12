import type { ShopWorkflow, WorkflowStepCode } from "./api/types";

export interface WorkflowBlockerAction {
  readonly label: string;
  readonly to: string;
}

export interface WorkflowBlockerPresentation {
  readonly key: string;
  readonly title: string;
  readonly message: string;
  readonly diagnosticId: string;
  readonly action: WorkflowBlockerAction;
}

const fxFailurePattern = /^(FX_DATA_GAP|FX_NO_AVAILABLE_QUOTE)(?::([A-Z]{3}):(\d{4}-\d{2}-\d{2}))?$/u;

function workflowRoute(shopId: string, code: WorkflowStepCode): WorkflowBlockerAction {
  if (["RECEIVE", "PREFLIGHT", "COMMIT"].includes(code)) {
    return { label: "查看资料准备", to: `/shops/${encodeURIComponent(shopId)}/workflow/commit` };
  }
  if (["CALCULATE", "PUBLISH"].includes(code)) {
    return { label: "查看计算复核", to: `/shops/${encodeURIComponent(shopId)}/workflow/calculate` };
  }
  return { label: "查看报告交付", to: `/shops/${encodeURIComponent(shopId)}/workflow/export` };
}

function knownBatchFailure(
  workflow: ShopWorkflow,
  code: WorkflowStepCode,
  administrator: boolean,
): Pick<WorkflowBlockerPresentation, "title" | "message" | "action"> {
  if (workflow.processingHealth?.terminalRecoveryBlocked === true) {
    return {
      title: "后台任务恢复受阻",
      message: "后台任务已超时，原处理仍在退出或失败终态尚未恢复成功。当前流程已明确标记为阻断，不会无提示地继续处理中；如持续出现，请提供诊断 ID 联系管理员。",
      action: workflowRoute(workflow.shop.id, code),
    };
  }
  if (workflow.processingHealth?.workerAvailable === false) {
    return {
      title: "后台处理服务暂不可用",
      message: "后台处理服务暂不可用，请稍后重试或联系管理员，并提供诊断 ID。系统已经停止等待，不会无提示地持续处理中。",
      action: workflowRoute(workflow.shop.id, code),
    };
  }
  const failureCode = workflow.latestBatch?.failureCode ?? "";
  const fxFailure = fxFailurePattern.exec(failureCode);
  if (fxFailure) {
    const currency = fxFailure[2];
    const date = fxFailure[3];
    const subject = currency && date ? `${date} ${currency}/CNY` : "报表日期对应币种";
    return {
      title: "计算所需汇率缺失",
      message: administrator
        ? `${subject} 没有可用报价。请依据授权来源新增或修订人工汇率，再重新导入；系统不会借用旧报价或猜测汇率。`
        : `${subject} 没有可用报价。请联系管理员依据授权来源补齐汇率后重新导入；系统不会借用旧报价或猜测汇率。`,
      action: administrator && currency && date
        ? { label: "前往外汇市场", to: `/fx?currency=${encodeURIComponent(currency)}&date=${encodeURIComponent(date)}` }
        : workflowRoute(workflow.shop.id, "CALCULATE"),
    };
  }
  if (failureCode === "HARD_INCOMPLETE_CONFIRMATION_REQUIRED") {
    return {
      title: "资料缺失，等待处理",
      message: "缺失资料不能按 0 计算。请补充文件，或在当前页面确认排除缺失切片后继续。",
      action: workflowRoute(workflow.shop.id, "COMMIT"),
    };
  }
  if (failureCode === "CALCULATION_DATE_ATTRIBUTION_MODE_MIXED") {
    return {
      title: "数据日期口径不一致",
      message: "同一正式结果不能混用不同日期口径。请按报表字面日期口径完整重传当前数据范围。",
      action: workflowRoute(workflow.shop.id, "CALCULATE"),
    };
  }
  if (["IMPORT_DATABASE_CAPACITY_UNAVAILABLE", "IMPORT_DATABASE_CAPACITY_INSUFFICIENT"].includes(failureCode)) {
    return {
      title: "数据入库暂时不可用",
      message: failureCode === "IMPORT_DATABASE_CAPACITY_INSUFFICIENT"
        ? "数据库可用空间不足，系统已停止入库。释放空间后可在资料准备页重试，无需重新上传。"
        : "数据库容量检查暂时不可用，系统已停止入库。配置恢复后可在资料准备页重试，无需重新上传。",
      action: workflowRoute(workflow.shop.id, "COMMIT"),
    };
  }
  if (failureCode === "AUTO_PUBLISH_FAILED") {
    return {
      title: "正式结果发布失败",
      message: "计算已经完成，但自动发布未成功。上一份正式结果仍然有效，请在计算复核页查看并受控重试。",
      action: workflowRoute(workflow.shop.id, "PUBLISH"),
    };
  }
  const blockingStep = workflow.steps.find((step) => step.code === code);
  return {
    title: `${blockingStep?.label ?? "当前流程"}被阻断`,
    message: failureCode
      ? `系统已停止当前处理，错误代码为 ${failureCode}。请在当前阶段查看处理方式；如需协助，请提供诊断 ID。`
      : "系统已停止当前处理。请在当前阶段查看阻断详情；如需协助，请提供诊断 ID。",
    action: workflowRoute(workflow.shop.id, code),
  };
}

export function workflowBlockerPresentation(
  workflow: ShopWorkflow | null | undefined,
  administrator: boolean,
): WorkflowBlockerPresentation | null {
  if (!workflow) return null;
  const blockingStep = workflow.steps.find((step) => step.severity === "BLOCKING");
  const batchFailed = workflow.latestBatch?.status === "FAILED";
  if (blockingStep || batchFailed) {
    const code = blockingStep?.code ?? workflow.currentStep;
    const batch = workflow.latestBatch;
    const presentation = knownBatchFailure(workflow, code, administrator);
    return {
      key: `batch:${batch?.id ?? "unknown"}:${batch?.status ?? "unknown"}:${batch?.stage ?? "unknown"}:${batch?.failureCode ?? "NO_CODE"}:${workflow.processingHealth?.terminalRecoveryBlocked === true ? "TERMINAL_RECOVERY_BLOCKED" : workflow.processingHealth?.workerAvailable === false ? "WORKER_UNAVAILABLE" : "WORKER_AVAILABLE"}:${code}`,
      diagnosticId: workflow.diagnosticId,
      ...presentation,
    };
  }

  const latestExport = workflow.download.latestExport;
  if (latestExport && ["FAILED", "REVOKED"].includes(latestExport.status)) {
    return {
      key: `export:${latestExport.id}:${latestExport.status}:${latestExport.stage ?? "unknown"}`,
      title: latestExport.status === "REVOKED" ? "报告下载授权已失效" : "报告生成失败",
      message: latestExport.status === "REVOKED"
        ? "当前报告的下载授权已经失效。请在报告交付页重新检查权限并创建新报告。"
        : "报告未能生成，系统已停止等待。请在报告交付页查看任务状态并受控重试。",
      diagnosticId: workflow.diagnosticId,
      action: workflowRoute(workflow.shop.id, "EXPORT"),
    };
  }
  return null;
}
