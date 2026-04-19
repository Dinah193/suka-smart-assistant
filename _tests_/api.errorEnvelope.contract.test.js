import { describe, expect, it } from "vitest";

const {
  normalizeApiErrorBody,
  normalizeErrorCode,
  shouldRetryError,
} = require("../src/server/contracts/apiErrorEnvelopeContract.js");

describe("api error envelope contract", () => {
  it("normalizes code, message, retryability, and requestId", () => {
    const envelope = normalizeApiErrorBody(
      {
        code: "Planner Integration Unavailable",
        message: "Planner service currently unavailable",
        details: { subsystem: "planners" },
      },
      { statusCode: 503, requestId: "req-1" },
    );

    expect(envelope.ok).toBe(false);
    expect(envelope.code).toBe("planner_integration_unavailable");
    expect(envelope.error).toBe("planner_integration_unavailable");
    expect(envelope.message).toContain("Planner service");
    expect(envelope.retryable).toBe(true);
    expect(envelope.requestId).toBe("req-1");
    expect(envelope.details).toEqual({ subsystem: "planners" });
  });

  it("derives retryability from code and status", () => {
    expect(shouldRetryError({ statusCode: 429, code: "anything" })).toBe(true);
    expect(shouldRetryError({ statusCode: 400, code: "validation_failed" })).toBe(false);
    expect(shouldRetryError({ statusCode: 503, code: "unknown" })).toBe(true);
  });

  it("normalizes noisy error code values deterministically", () => {
    expect(normalizeErrorCode("  Launch Gate Failed  ")).toBe("launch_gate_failed");
    expect(normalizeErrorCode("bad/code:format")).toBe("bad_code_format");
    expect(normalizeErrorCode(null)).toBe("unknown_error");
  });
});
