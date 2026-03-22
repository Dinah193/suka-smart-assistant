import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

function randomPort() {
  return 18600 + Math.floor(Math.random() * 5000);
}

function createTestDataPaths(tag = "access-policy-anomalies") {
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
  const email = `anomalies-${suffix}-${Date.now()}@example.com`;
  const password = "Password1234";

  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Anomaly",
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
    body: JSON.stringify({ householdName: "Anomaly Household" }),
  });
  const bootstrapJson = await bootstrapRes.json();
  expect(bootstrapRes.status).toBe(200);

  return {
    token: String(bootstrapJson?.session?.accessToken || token),
  };
}

describe("access policy audit anomalies contract", () => {
  it("returns actor anomaly triage payload for high-failure and high-risk activity", async () => {
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

      for (let i = 0; i < 3; i += 1) {
        const badUpsertRes = await fetch(
          `${baseUrl}/api/access-policies/collaboration-grants/upsert`,
          {
            method: "POST",
            headers: auth,
            body: JSON.stringify({
              userId: "",
              householdId: "house_invalid",
              moduleKey: "realtime",
            }),
          }
        );
        expect(badUpsertRes.status).toBe(400);
      }

      for (let i = 0; i < 3; i += 1) {
        const entitlementRes = await fetch(
          `${baseUrl}/api/access-policies/entitlements/user-anomaly-${i}`,
          {
            method: "PUT",
            headers: auth,
            body: JSON.stringify({ entitlements: ["planner.base"] }),
          }
        );
        expect(entitlementRes.status).toBe(200);
      }

      const anomaliesRes = await fetch(
        `${baseUrl}/api/access-policies/audit-events/anomalies?windowMs=86400000&minActorEvents=4&failureRateThreshold=0.4&highRiskActionThreshold=2&highRiskActions=entitlement.set,collaboration_grant.upsert`,
        {
          headers: {
            authorization: `Bearer ${session.token}`,
            "x-ops-token": "ops-contract-token",
          },
        }
      );
      const anomaliesBody = await anomaliesRes.json();
      expect(anomaliesRes.status).toBe(200);
      expect(anomaliesBody.ok).toBe(true);
      expect(Array.isArray(anomaliesBody.anomalies)).toBe(true);
      expect(anomaliesBody.anomalies.length).toBeGreaterThanOrEqual(2);
      expect(
        anomaliesBody.anomalies.some((a) => String(a.type || "") === "actor_failure_rate_high")
      ).toBe(true);
      expect(
        anomaliesBody.anomalies.some((a) => String(a.type || "") === "actor_high_risk_action_spike")
      ).toBe(true);
      expect(
        anomaliesBody.anomalies.every(
          (a) => Array.isArray(a?.triage?.suggestedActions) && a.triage.suggestedActions.length > 0
        )
      ).toBe(true);

      const rawAudit = JSON.parse(await fs.readFile(testDataPaths.auditFile, "utf8"));
      expect(Array.isArray(rawAudit.events)).toBe(true);
      expect(
        rawAudit.events.some((evt) => String(evt?.action || "") === "policy.audit_events.anomalies.read")
      ).toBe(true);
    } finally {
      await stopServer(child);
      await fs.rm(testDataPaths.testDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 45000);
});
