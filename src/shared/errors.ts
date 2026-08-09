export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly field: string | undefined;

  constructor(code: string, message: string, statusCode = 400, field?: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.field = field;
  }
}
