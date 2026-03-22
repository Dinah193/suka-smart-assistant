import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

function randomPort() {
  return 14600 + Math.floor(Math.random() * 5000);
}

function createTestDataPaths(tag = "access-policy-alerts") {
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
    } catch {}
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
      } catch {}
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
  const email = `alerts-${suffix}-${Date.now()}@example.com`;
  const password = "Password1234";

  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Alerts",
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
    body: JSON.stringify({ householdName: "Alerts Household" }),
  });
  const bootstrapJson = await bootstrapRes.json();
  expect(bootstrapRes.status).toBe(200);

  return {
    token: String(bootstrapJson?.session?.accessToken || token),
    householdId: String(bootstrapJson?.user?.householdId || ""),
  };
}

describe("access policy audit alerts contract", () => {
  it("emits failure-rate and high-risk action alerts when thresholds are exceeded", async () => {
    const { child, port, testDataPaths } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);
      const session = await registerAndBootstrap(baseUrl, "contract");
      const auth = {
        authorization: `Bearer ${session.token}`,
        "x-ops-token": "ops-contract-token",
        "content-type": "application/json",
      };

      const badUpsertRes = await fetch(
        `${baseUrl}/api/access-policies/collaboration-grants/upsert`,
        {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            userId: "",
            householdId: session.householdId,
            moduleKey: "realtime",
          }),
        }
      );
      expect(badUpsertRes.status).toBe(400);

      const entitlementRes = await fetch(
        `${baseUrl}/api/access-policies/entitlements/user-alert-1`,
        {
          method: "PUT",
          headers: auth,
          body: JSON.stringify({ entitlements: ["planner.base"] }),
        }
      );
      expect(entitlementRes.status).toBe(200);

      const alertsRes = await fetch(
        `${baseUrl}/api/access-policies/audit-events/alerts?windowMs=86400000&minEvents=1&failureRateThreshold=0.1&highRiskActionThreshold=1`,
        {
          headers: {
            authorization: `Bearer ${session.token}`,
            "x-ops-token": "ops-contract-token",
          },
        }
      );
      const alertsBody = await alertsRes.json();
      expect(alertsRes.status).toBe(200);
      expect(alertsBody.ok).toBe(true);
      expect(Array.isArray(alertsBody.alerts)).toBe(true);
      expect(alertsBody.alerts.length).toBeGreaterThanOrEqual(2);
      expect(alertsBody.alerts.some((a) => a.id === "failure_rate_exceeded")).toBe(true);
      expect(
        alertsBody.alerts.some((a) => String(a.id || "").startsWith("high_risk_action_spike:"))
      ).toBe(true);

      const rawAudit = JSON.parse(await fs.readFile(testDataPaths.auditFile, "utf8"));
      expect(Array.isArray(rawAudit.events)).toBe(true);
      expect(rawAudit.events.length).toBeGreaterThanOrEqual(2);
    } finally {
      await stopServer(child);
      await fs.rm(testDataPaths.testDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 45000);
});
