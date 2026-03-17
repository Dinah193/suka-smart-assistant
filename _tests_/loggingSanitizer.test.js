import { describe, it, expect } from "vitest";

const { redactObject, redactText } = require("../src/server/services/loggingSanitizer.js");

describe("loggingSanitizer", () => {
  it("redacts known sensitive headers and nested secrets", () => {
    const input = {
      authorization: "Bearer abc.def.ghi",
      cookie: "session=xyz",
      nested: { token: "12345", ok: true },
      plain: "safe",
    };

    const out = redactObject(input);
    expect(String(out.authorization)).toContain("[REDACTED]");
    expect(String(out.cookie)).toContain("[REDACTED]");
    expect(String(out.nested.token)).toContain("[REDACTED]");
    expect(out.plain).toBe("safe");
  });

  it("redacts token-like values in text blobs", () => {
    const line = "authorization=Bearer abc123 token=secret-value";
    const out = redactText(line);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("secret-value");
  });

  it("redacts array values for sensitive keys", () => {
    const input = {
      refresh_token: ["tok-a", "tok-b", "tok-c"],
      nested: { ok: true },
    };

    const out = redactObject(input);
    expect(out.refresh_token).toEqual(["[REDACTED]", "[REDACTED]", "[REDACTED]"]);
    expect(out.nested.ok).toBe(true);
  });
});
