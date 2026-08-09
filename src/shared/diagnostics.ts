const SAFE_SYSTEM_CODE = /^[A-Z0-9_]{2,80}$/u;
const SAFE_ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

export interface SafeErrorDiagnostic {
  readonly errorType?: string;
  readonly errorMessageCode?: string;
  readonly errorSource?: string;
  readonly errorSystemCode?: string;
  readonly errorConstraint?: string;
  readonly causeType?: string;
  readonly causeMessageCode?: string;
  readonly causeSource?: string;
  readonly causeSystemCode?: string;
}

function safeConstraint(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("constraint" in error)) return undefined;
  const constraint = (error as { readonly constraint?: unknown }).constraint;
  return typeof constraint === "string" && SAFE_SYSTEM_CODE.test(constraint.toUpperCase()) ? constraint : undefined;
}

function safeMessageCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (SAFE_SYSTEM_CODE.test(error.message)) return error.message;
  return error.message.match(/^([A-Z][A-Z0-9_]{1,79}):/u)?.[1];
}

function safeErrorType(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return SAFE_ERROR_TYPE.test(error.name) ? error.name : "Error";
}

function safeSystemCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && SAFE_SYSTEM_CODE.test(code) ? code : undefined;
}

function projectSource(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.stack) return undefined;
  const sourceRoot = `${process.cwd().replaceAll("\\", "/")}/src/`;
  for (const line of error.stack.split(/\r?\n/u).slice(1)) {
    const normalized = line.replaceAll("\\", "/");
    const marker = normalized.lastIndexOf(sourceRoot);
    if (marker < 0) continue;
    const candidate = normalized.slice(marker + sourceRoot.length - "src/".length)
      .match(/^src\/[A-Za-z0-9_./-]+\.(?:ts|js):[0-9]+:[0-9]+/u)?.[0];
    if (candidate) return candidate;
  }
  return undefined;
}

export function safeErrorDiagnostic(error: unknown): SafeErrorDiagnostic {
  const cause = error instanceof Error ? error.cause : undefined;
  const errorType = safeErrorType(error);
  const errorMessageCode = safeMessageCode(error);
  const errorSource = projectSource(error);
  const errorSystemCode = safeSystemCode(error);
  const errorConstraint = safeConstraint(error);
  const causeType = safeErrorType(cause);
  const causeMessageCode = safeMessageCode(cause);
  const causeSource = projectSource(cause);
  const causeSystemCode = safeSystemCode(cause);
  return {
    ...(errorType ? { errorType } : {}),
    ...(errorMessageCode ? { errorMessageCode } : {}),
    ...(errorSource ? { errorSource } : {}),
    ...(errorSystemCode ? { errorSystemCode } : {}),
    ...(errorConstraint ? { errorConstraint } : {}),
    ...(causeType ? { causeType } : {}),
    ...(causeMessageCode ? { causeMessageCode } : {}),
    ...(causeSource ? { causeSource } : {}),
    ...(causeSystemCode ? { causeSystemCode } : {}),
  };
}
