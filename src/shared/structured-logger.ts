type LogLevel = "info" | "error";

function jsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { errorType: value.name };
  return value;
}

export function structuredLog(
  level: LogLevel,
  service: "api" | "worker",
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  try {
    const line = JSON.stringify({ level, time: Date.now(), event, service, ...fields }, (_key, value) => jsonValue(value));
    (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
  } catch {
    // Diagnostics must never become a business-flow failure.
  }
}
