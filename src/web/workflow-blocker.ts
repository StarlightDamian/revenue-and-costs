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
      title: "后台处理暂时无法恢复",
      message: "这项后台处理已超时，系统已经暂停，不会一直显示处理中。如多次重试仍出现此问题，请把处理编号发给管理员。",
      action: workflowRoute(workflow.shop.id, code),
    };
  }
  if (workflow.processingHealth?.workerAvailable === false) {
    return {
      title: "后台处理服务暂不可用",
      message: "系统暂时无法继续处理，请稍后重试。如多次重试仍失败，请把处理编号发给管理员。",
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
      message: "缺失资料不能当作 0 计算。请补充文件，或确认不计算这些缺少资料的站点和月份后继续。",
      action: workflowRoute(workflow.shop.id, "COMMIT"),
    };
  }
  if (failureCode === "CALCULATION_DATE_ATTRIBUTION_MODE_MIXED") {
    return {
      title: "资料的日期计算方式不一致",
      message: "同一份正式结果中的日期必须按同一种方法计算。请按报表上显示的日期，重新上传当前范围内的全部资料。",
      action: workflowRoute(workflow.shop.id, "CALCULATE"),
    };
  }
  if (failureCode === "NO_ACTIVE_DATASET_IN_ACCOUNTING_PERIOD") {
    return {
      title: "所选月份没有可核算资料",
      message: "本次核算范围内没有已识别的交易报告或配送货件。请回到资料准备页核对月份范围并补充对应资料。",
      action: workflowRoute(workflow.shop.id, "COMMIT"),
    };
  }
  if (["IMPORT_DATABASE_CAPACITY_UNAVAILABLE", "IMPORT_DATABASE_CAPACITY_INSUFFICIENT"].includes(failureCode)) {
    return {
      title: "资料暂时无法保存",
      message: failureCode === "IMPORT_DATABASE_CAPACITY_INSUFFICIENT"
        ? "服务器可用空间不足，系统已暂停保存资料。管理员释放空间后，可在资料准备页重试，无需重新上传。"
        : "系统暂时无法确认服务器是否有足够空间，因此没有继续保存资料。恢复后可在资料准备页重试，无需重新上传。",
      action: workflowRoute(workflow.shop.id, "COMMIT"),
    };
  }
  if (failureCode === "AUTO_PUBLISH_FAILED") {
    return {
      title: "正式结果发布失败",
      message: "计算已经完成，但新的正式结果没有保存成功。上一份正式结果仍然有效，请到计算复核页查看并重试。",
      action: workflowRoute(workflow.shop.id, "PUBLISH"),
    };
  }
  return {
    title: "当前处理已暂停",
    message: "请在当前页面查看处理方法。如仍无法继续，请把处理编号发给管理员。",
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
        : "报告没有生成成功。请到报告交付页查看状态并重新生成。",
      diagnosticId: workflow.diagnosticId,
      action: workflowRoute(workflow.shop.id, "EXPORT"),
    };
  }
  return null;
}
