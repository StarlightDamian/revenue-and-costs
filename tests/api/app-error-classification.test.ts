import { describe, expect, it } from "vitest";
import { classifyHttpError } from "../../src/api/app.js";
import { AuthFailure } from "../../src/modules/auth/service.js";
import { AppError } from "../../src/shared/errors.js";

describe("API error classification", () => {
  it("preserves stable 4xx codes", () => {
    expect(classifyHttpError(new AppError("ACCOUNT_NOT_REGISTERED", "请先注册", 409))).toEqual({
      code: "ACCOUNT_NOT_REGISTERED",
      message: "请先注册",
      statusCode: 409,
    });
  });

  it("preserves fail-closed authentication 503 codes without exposing causes", () => {
    const cause = new Error("database secret sentinel");
    const problem = classifyHttpError(new AuthFailure(
      "AUTH_AUDIT_UNAVAILABLE",
      "登录服务暂时不可用，请稍后重试",
      503,
      { cause },
    ));

    expect(problem).toEqual({
      code: "AUTH_AUDIT_UNAVAILABLE",
      message: "服务暂时不可用，请稍后重试",
      statusCode: 503,
    });
    expect(JSON.stringify(problem)).not.toContain("sentinel");
  });

  it("maps unexpected messages to a generic internal failure", () => {
    expect(classifyHttpError(new Error("raw upstream secret sentinel"))).toEqual({
      code: "INTERNAL_ERROR",
      message: "服务器内部错误",
      statusCode: 500,
    });
  });
});
