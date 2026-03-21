import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

function randomPort() {
  return 14500 + Math.floor(Math.random() * 6000);
}

function createTestDataPaths(tag = "access-policy-audit") {
  const testDataDir = path.resolve(
    repoRoot,
    ".tmp",
    "test-data",
    `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
  return {
    testDataDir,
    authStateFile: path.join(testDataDir, "auth-state.json"),
    accessPolicyFile: path.join(testDataDir, "access-policies.json"),
    auditFile: path.join(testDataDir, "access-policy-audit.json"),
  };
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

function startServer(extraEnv = {}, testDataPaths = createTestDataPaths()) {
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
      AUTH_STATE_FILE: testDataPaths.authStateFile,
      ACCESS_POLICY_FILE: testDataPaths.accessPolicyFile,
      ACCESS_POLICY_AUDIT_FILE: testDataPaths.auditFile,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return { child, port, testDataPaths };
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
  const email = `audit-${suffix}-${Date.now()}@example.com`;
  const password = "Password1234";

  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Audit",
      lastName: "Ops",
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
    body: JSON.stringify({ householdName: "Audit Ops Household" }),
  });
  const bootstrapJson = await bootstrapRes.json();
  expect(bootstrapRes.status).toBe(200);

  return {
    token: String(bootstrapJson?.session?.accessToken || token),
    householdId: String(bootstrapJson?.user?.householdId || ""),
  };
}

describe("access policy admin audit contract", () => {
  it("records mutation events and supports filtered/limited retrieval with redaction", async () => {
    const { child, port, testDataPaths } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);
      const session = await registerAndBootstrap(baseUrl, "contract");
      const authHeader = {
        authorization: `Bearer ${session.token}`,
        "x-ops-token": "ops-contract-token",
        "content-type": "application/json",
      };

      const upsertRes = await fetch(
        `${baseUrl}/api/access-policies/collaboration-grants/upsert`,
        {
          method: "POST",
          headers: authHeader,
          body: JSON.stringify({
            userId: "user-audit-1",
            householdId: session.householdId,
            moduleKey: "realtime",
            actions: ["read"],
            startsAt: new Date().toISOString(),
            secret: "top-secret-should-redact",
          }),
        }
      );
      expect(upsertRes.status).toBe(200);

      const entitlementRes = await fetch(
        `${baseUrl}/api/access-policies/entitlements/user-audit-1`,
        {
          method: "PUT",
          headers: authHeader,
          body: JSON.stringify({
            entitlements: ["planner.base"],
            token: "sensitive-token-should-redact",
          }),
        }
      );
      expect(entitlementRes.status).toBe(200);

      const listRes = await fetch(`${baseUrl}/api/access-policies/audit-events?limit=50`, {
        headers: {
          authorization: `Bearer ${session.token}`,
          "x-ops-token": "ops-contract-token",
        },
      });
      const listBody = await listRes.json();
      expect(listRes.status).toBe(200);
      expect(listBody.ok).toBe(true);
      expect(Array.isArray(listBody.items)).toBe(true);
      expect(listBody.items.length).toBeGreaterThanOrEqual(2);

      const upsertEvent = listBody.items.find((evt) => evt.action === "collaboration_grant.upsert");
      expect(upsertEvent).toBeTruthy();
      expect(String(upsertEvent?.details?.payload?.secret || "")).toContain("[REDACTED]");

      const entitlementEvent = listBody.items.find((evt) => evt.action === "entitlement.set");
      expect(entitlementEvent).toBeTruthy();
      expect(String(entitlementEvent?.details?.entitlements || "")).not.toContain("[REDACTED]");
      expect(String(entitlementEvent?.details?.payload?.token || "")).toContain("[REDACTED]");

      const actorFilterRes = await fetch(
        `${baseUrl}/api/access-policies/audit-events?actorUserId=${encodeURIComponent("user-audit-1")}`,
        {
          headers: {
            authorization: `Bearer ${session.token}`,
            "x-ops-token": "ops-contract-token",
          },
        }
      );
      const actorFilterBody = await actorFilterRes.json();
      expect(actorFilterRes.status).toBe(200);
      expect(actorFilterBody.ok).toBe(true);
      expect(Array.isArray(actorFilterBody.items)).toBe(true);
      expect(actorFilterBody.items.length).toBe(0);

      const actionFilterRes = await fetch(
        `${baseUrl}/api/access-policies/audit-events?action=entitlement.set&limit=1`,
        {
          headers: {
            authorization: `Bearer ${session.token}`,
            "x-ops-token": "ops-contract-token",
          },
        }
      );
      const actionFilterBody = await actionFilterRes.json();
      expect(actionFilterRes.status).toBe(200);
      expect(actionFilterBody.ok).toBe(true);
      expect(actionFilterBody.items.length).toBe(1);
      expect(actionFilterBody.items[0].action).toBe("entitlement.set");

      const futureSince = new Date(Date.now() + 60_000).toISOString();
      const sinceRes = await fetch(
        `${baseUrl}/api/access-policies/audit-events?since=${encodeURIComponent(futureSince)}`,
        {
          headers: {
            authorization: `Bearer ${session.token}`,
            "x-ops-token": "ops-contract-token",
          },
        }
      );
      const sinceBody = await sinceRes.json();
      expect(sinceRes.status).toBe(200);
      expect(sinceBody.ok).toBe(true);
      expect(sinceBody.count).toBe(0);
      expect(Array.isArray(sinceBody.items)).toBe(true);
      expect(sinceBody.items.length).toBe(0);

      const rawAudit = JSON.parse(await fs.readFile(testDataPaths.auditFile, "utf8"));
      expect(Array.isArray(rawAudit.events)).toBe(true);
      expect(rawAudit.events.length).toBeGreaterThanOrEqual(2);
    } finally {
      await stopServer(child);
      await fs.rm(testDataPaths.testDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 45000);
});
