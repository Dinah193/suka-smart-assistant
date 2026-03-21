import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

function randomPort() {
  return 14000 + Math.floor(Math.random() * 8000);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(150);
  }
  throw new Error("health_timeout");
}

function startServer(extraEnv = {}) {
  const port = randomPort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      STRICT_STARTUP_ENV: "false",
      NEO4J_REQUIRED: "false",
      POSTGRES_REQUIRED: "false",
      MONGODB_REQUIRED: "false",
      MONGO_SERVER_SELECTION_TIMEOUT_MS: "100",
      ACCESS_POLICY_ADMIN_TOKEN: "ops-contract-token",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return { child, port };
}

async function stopServer(child) {
  if (!child || child.killed) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, 2500);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function registerAndBootstrap(baseUrl, suffix) {
  const email = `ops-${suffix}-${Date.now()}@example.com`;
  const password = "Password1234";

  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Ops",
      lastName: "Admin",
      email,
      password,
      confirmPassword: password,
      consent: true,
    }),
  });
  const registerJson = await registerRes.json();
  expect(registerRes.status).toBe(201);

  const token = String(registerJson?.session?.accessToken || "");
  const bootstrapRes = await fetch(`${baseUrl}/api/auth/household/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ householdName: "Ops Household" }),
  });
  const bootstrapJson = await bootstrapRes.json();
  expect(bootstrapRes.status).toBe(200);

  return {
    token: String(bootstrapJson?.session?.accessToken || token),
    householdId: String(bootstrapJson?.user?.householdId || ""),
  };
}

describe("access policy admin contract", () => {
  it("supports read/update workflows behind auth plus ops token", async () => {
    const { child, port } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);
      const session = await registerAndBootstrap(baseUrl, "contract");
      const authHeader = { authorization: `Bearer ${session.token}` };

      const missingTokenRes = await fetch(`${baseUrl}/api/access-policies`, {
        headers: authHeader,
      });
      expect(missingTokenRes.status).toBe(403);

      const listRes = await fetch(`${baseUrl}/api/access-policies`, {
        headers: { ...authHeader, "x-ops-token": "ops-contract-token" },
      });
      const listBody = await listRes.json();
      expect(listRes.status).toBe(200);
      expect(listBody.ok).toBe(true);
      expect(Array.isArray(listBody.policy.collaborationGrants)).toBe(true);

      const upsertRes = await fetch(
        `${baseUrl}/api/access-policies/collaboration-grants/upsert`,
        {
          method: "POST",
          headers: {
            ...authHeader,
            "x-ops-token": "ops-contract-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            userId: "user-contract-1",
            householdId: session.householdId,
            moduleKey: "meal-planning",
            actions: ["read", "update"],
          }),
        }
      );
      const upsertBody = await upsertRes.json();
      expect(upsertRes.status).toBe(200);
      expect(upsertBody.ok).toBe(true);
      expect(upsertBody.grant.moduleKey).toBe("meal-planning");

      const entitlementRes = await fetch(
        `${baseUrl}/api/access-policies/entitlements/user-contract-1`,
        {
          method: "PUT",
          headers: {
            ...authHeader,
            "x-ops-token": "ops-contract-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ entitlements: ["planner.base", "planner.advanced"] }),
        }
      );
      const entitlementBody = await entitlementRes.json();
      expect(entitlementRes.status).toBe(200);
      expect(entitlementBody.ok).toBe(true);
      expect(entitlementBody.entitlements).toEqual(["planner.base", "planner.advanced"]);

      const deleteRes = await fetch(`${baseUrl}/api/access-policies/collaboration-grants`, {
        method: "DELETE",
        headers: {
          ...authHeader,
          "x-ops-token": "ops-contract-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          userId: "user-contract-1",
          householdId: session.householdId,
          moduleKey: "meal-planning",
        }),
      });
      const deleteBody = await deleteRes.json();
      expect(deleteRes.status).toBe(200);
      expect(deleteBody.ok).toBe(true);
      expect(typeof deleteBody.removed).toBe("boolean");
    } finally {
      await stopServer(child);
    }
  }, 30000);
});
