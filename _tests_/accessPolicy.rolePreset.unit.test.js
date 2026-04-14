import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { requirePlannerAdminRole } = require("../src/server/middleware/accessPolicy.js");

function createResponseDouble() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("requirePlannerAdminRole preset", () => {
  it("defaults to owner/admin when rejecting non-admin roles", async () => {
    const middleware = requirePlannerAdminRole();
    const req = {
      accessContext: { role: "member" },
      user: { roles: [] },
    };
    const res = createResponseDouble();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe("role_required");
    expect(res.body?.requiredRoles).toEqual(["owner", "admin"]);
  });

  it("allows owner/admin roles via household or account role context", async () => {
    const middleware = requirePlannerAdminRole();

    const reqFromHousehold = {
      accessContext: { role: "admin" },
      user: { roles: [] },
    };
    const resFromHousehold = createResponseDouble();
    const nextFromHousehold = vi.fn();

    await middleware(reqFromHousehold, resFromHousehold, nextFromHousehold);

    expect(nextFromHousehold).toHaveBeenCalledTimes(1);
    expect(reqFromHousehold.accessContext.rolePolicyGranted).toBe(true);
    expect(reqFromHousehold.accessContext.rolePolicyMatchedRole).toBe("admin");

    const reqFromAccount = {
      accessContext: { role: "member" },
      user: { roles: ["owner"] },
    };
    const resFromAccount = createResponseDouble();
    const nextFromAccount = vi.fn();

    await middleware(reqFromAccount, resFromAccount, nextFromAccount);

    expect(nextFromAccount).toHaveBeenCalledTimes(1);
    expect(reqFromAccount.accessContext.rolePolicyGranted).toBe(true);
    expect(reqFromAccount.accessContext.rolePolicyMatchedRole).toBe("owner");
  });

  it("rejects requests with no household or account role match", async () => {
    const middleware = requirePlannerAdminRole();
    const req = {
      accessContext: {},
      user: { roles: ["member", "guest"] },
    };
    const res = createResponseDouble();
    const next = vi.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body?.error).toBe("role_required");
    expect(res.body?.requiredRoles).toEqual(["owner", "admin"]);
  });
});
