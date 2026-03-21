import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

function randomPort() {
  return 17200 + Math.floor(Math.random() * 5000);
}

function createTestDataPaths(tag = "access-policy-audit-maintenance") {
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
    rolloverFile: path.join(testDataDir, "access-policy-audit-rollover.ndjson"),
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
      ACCESS_POLICY_AUDIT_ROLLOVER_FILE: testDataPaths.rolloverFile,
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
  const email = `maintenance-${suffix}-${Date.now()}@example.com`;
  const password = "Password1234";

  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Retention",
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
    body: JSON.stringify({ householdName: "Retention Household" }),
  });
  const bootstrapJson = await bootstrapRes.json();
  expect(bootstrapRes.status).toBe(200);

  return {
    token: String(bootstrapJson?.session?.accessToken || token),
  };
}

describe("access policy audit maintenance contract", () => {
  it("prunes and rolls over old events according to maintenance controls", async () => {
    const { child, port, testDataPaths } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);
      const session = await registerAndBootstrap(baseUrl, "contract");

      for (let i = 0; i < 6; i += 1) {
        const res = await fetch(`${baseUrl}/api/access-policies/entitlements/user-maint-${i}`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${session.token}`,
            "x-ops-token": "ops-contract-token",
            "content-type": "application/json",
          },
          body: JSON.stringify({ entitlements: ["planner.base"] }),
        });
        expect(res.status).toBe(200);
      }

      const maintenanceRes = await fetch(`${baseUrl}/api/access-policies/audit-events/maintenance`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.token}`,
          "x-ops-token": "ops-contract-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          maxEvents: 2,
          retentionMs: 31536000000,
          rolloverEnabled: true,
        }),
      });
      const maintenanceBody = await maintenanceRes.json();
      expect(maintenanceRes.status).toBe(200);
      expect(maintenanceBody.ok).toBe(true);
      expect(maintenanceBody.totalAfter).toBe(2);
      expect(maintenanceBody.prunedCount).toBeGreaterThanOrEqual(4);
      expect(maintenanceBody.rolledCount).toBeGreaterThanOrEqual(4);
      expect(Number(maintenanceBody.prunedByReason?.max_events || 0)).toBeGreaterThanOrEqual(4);

      const rawAudit = JSON.parse(await fs.readFile(testDataPaths.auditFile, "utf8"));
      expect(Array.isArray(rawAudit.events)).toBe(true);
      expect(rawAudit.events.length).toBeGreaterThanOrEqual(2);
      expect(rawAudit.events.length).toBeLessThanOrEqual(3);
      expect(
        rawAudit.events.some((evt) => String(evt?.action || "") === "policy.audit_events.maintenance.run")
      ).toBe(true);

      const rolloverRaw = await fs.readFile(testDataPaths.rolloverFile, "utf8");
      const lines = rolloverRaw
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(lines.length).toBeGreaterThanOrEqual(4);
      expect(lines.every((entry) => entry.reason === "max_events")).toBe(true);
    } finally {
      await stopServer(child);
      await fs.rm(testDataPaths.testDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }, 45000);
});
