import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const controllerPath = path.resolve(
  process.cwd(),
  "src/server/routes/realtimeController.js"
);

function readController() {
  return fs.readFileSync(controllerPath, "utf8");
}

describe("realtimeController contract guards", () => {
  it("keeps UI compatibility aliases for suggestions and suggestion payloads", () => {
    const src = readController();

    // GET /suggestions should include suggestions alias for UI hook compatibility.
    expect(src).toMatch(/suggestions\s*:\s*items/);

    // Consume/assign should include suggestion alias for UI hook compatibility.
    expect(src).toMatch(/suggestion\s*:\s*item/);
  });

  it("retains scoped auth guardrails for cross-scope requests", () => {
    const src = readController();

    // Core scope authorization failure contracts.
    expect(src).toMatch(/forbidden_scope/);
    expect(src).toMatch(/family_scope_forbidden/);
    expect(src).toMatch(/household_scope_missing/);

    // Ensure route handlers explicitly return 403 for scoped errors.
    expect(src).toMatch(/status\(403\)\.json\(\{\s*ok:\s*false,\s*error:\s*scoped\.error\s*\}\)/);
  });

  it("keeps assignment and report export endpoints in controller", () => {
    const src = readController();

    expect(src).toMatch(/\/suggestions\/:id\/assign/);
    expect(src).toMatch(/\/reports\/latest\.csv/);
    expect(src).toMatch(/getAuditHistory/);
    expect(src).toMatch(/getSignalHistory/);
  });
});
