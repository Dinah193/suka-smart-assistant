import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const controllerPath = path.resolve(
  process.cwd(),
  "src/server/routes/realtimeController.js"
);
const scopeMiddlewarePath = path.resolve(
  process.cwd(),
  "src/server/middleware/realtime/authorizeScope.js"
);
const validationMiddlewarePath = path.resolve(
  process.cwd(),
  "src/server/middleware/realtime/validateRealtimeEnvelope.js"
);

function readController() {
  return fs.readFileSync(controllerPath, "utf8");
}

function readScopeMiddleware() {
  return fs.readFileSync(scopeMiddlewarePath, "utf8");
}

function readValidationMiddleware() {
  return fs.readFileSync(validationMiddlewarePath, "utf8");
}

describe("realtimeController contract guards", () => {
  it("keeps UI compatibility aliases for suggestions and suggestion payloads", () => {
    const src = readController();

    // GET /suggestions should include suggestions alias for UI hook compatibility.
    expect(src).toMatch(/suggestions\s*:\s*items/);

    // Consume/assign should include suggestion alias for UI hook compatibility.
    expect(src).toMatch(/suggestion\s*:\s*item/);
  });

  it("mounts deterministic middleware layering for realtime routes", () => {
    const src = readController();

    expect(src).toMatch(/router\.use\(/);
    expect(src).toMatch(/realtimeRateLimit/);
    expect(src).toMatch(/correlationContext/);
    expect(src).toMatch(/authenticateRequest/);
    expect(src).toMatch(/requireHouseholdAccessPolicy\(\)/);
    expect(src).toMatch(/requireCollaborationPolicy\(\{ moduleKey: "realtime" \}\)/);
    expect(src).toMatch(/requireEntitlementPolicy\(\{ feature: "planner\.base" \}\)/);
    expect(src).toMatch(/authorizeScope/);
    expect(src).toMatch(/validateRealtimeEnvelope/);
    expect(src).toMatch(/router\.use\(mapRealtimeErrorMiddleware\)/);
  });

  it("retains scoped auth guardrails for cross-scope requests", () => {
    const src = readScopeMiddleware();

    // Core scope authorization failure contracts.
    expect(src).toMatch(/forbidden_scope/);
    expect(src).toMatch(/family_scope_forbidden/);
    expect(src).toMatch(/household_scope_missing/);
  });

  it("enforces canonical realtime envelope validation middleware", () => {
    const src = readValidationMiddleware();
    expect(src).toMatch(/validateEnvelope/);
    expect(src).toMatch(/schema_validation_failed/);
    expect(src).toMatch(/invalid_event/);
  });

  it("keeps assignment and report export endpoints in controller", () => {
    const src = readController();

    expect(src).toMatch(/\/suggestions\/:id\/assign/);
    expect(src).toMatch(/\/reports\/latest\.csv/);
    expect(src).toMatch(/getAuditHistory/);
    expect(src).toMatch(/getSignalHistory/);
  });
});
