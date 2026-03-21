import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

function randomPort() {
  return 15000 + Math.floor(Math.random() * 8000);
}

function createTestDataPaths(tag = "entitlement") {
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
    battleRhythmFile: path.join(testDataDir, "battle-rhythm.json"),
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
      STRICT_PLANNER_BASE_ENTITLEMENT: "true",
      AUTH_STATE_FILE: testDataPaths.authStateFile,
      ACCESS_POLICY_FILE: testDataPaths.accessPolicyFile,
      BATTLE_RHYTHM_DB_FILE: testDataPaths.battleRhythmFile,
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

function defaultPolicyStore() {
  return {
    version: 1,
    collaborationGrants: [],
    entitlementGrantsByUserId: {},
    householdRolesByHouseholdId: {},
    updatedAt: new Date().toISOString(),
  };
}

async function readPolicy(accessPolicyFile) {
  try {
    const raw = await fs.readFile(accessPolicyFile, "utf8");
    const json = JSON.parse(raw || "{}");
    return {
      ...defaultPolicyStore(),
      ...json,
      collaborationGrants: Array.isArray(json?.collaborationGrants)
        ? json.collaborationGrants
        : [],
      entitlementGrantsByUserId:
        json?.entitlementGrantsByUserId && typeof json.entitlementGrantsByUserId === "object"
          ? json.entitlementGrantsByUserId
          : {},
    };
  } catch {
    return defaultPolicyStore();
  }
}

async function writePolicy(accessPolicyFile, policy) {
  await fs.mkdir(path.dirname(accessPolicyFile), { recursive: true });
  await fs.writeFile(accessPolicyFile, JSON.stringify(policy, null, 2), "utf8");
}

async function grantCollaboration({ userId, householdId, moduleKey, accessPolicyFile }) {
  const policy = await readPolicy(accessPolicyFile);
  policy.collaborationGrants = policy.collaborationGrants.filter((grant) => {
    return !(
      String(grant?.userId || "") === String(userId || "") &&
      String(grant?.householdId || "") === String(householdId || "") &&
      String(grant?.moduleKey || "") === String(moduleKey || "")
    );
  });
  policy.collaborationGrants.push({
    userId,
    householdId,
    moduleKey,
    actions: ["read"],
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  policy.updatedAt = new Date().toISOString();
  await writePolicy(accessPolicyFile, policy);
}

async function setEntitlements({ userId, accessPolicyFile, entitlements = ["planner.base"] }) {
  const policy = await readPolicy(accessPolicyFile);
  policy.entitlementGrantsByUserId[String(userId)] = entitlements;
  policy.updatedAt = new Date().toISOString();
  await writePolicy(accessPolicyFile, policy);
}

async function registerAndBootstrap(baseUrl, suffix) {
  const email = `entitlement-${suffix}-${Date.now()}@example.com`;
  const password = "Password1234";

  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Entitlement",
      lastName: "Contract",
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
    body: JSON.stringify({ householdName: `Entitlement Household ${suffix}` }),
  });
  const bootstrapJson = await bootstrapRes.json();
  expect(bootstrapRes.status).toBe(200);

  const nextToken = String(bootstrapJson?.session?.accessToken || token);
  const householdId = String(bootstrapJson?.user?.householdId || "");
  const userId = String(
    bootstrapJson?.user?.userId || bootstrapJson?.user?.id || registerJson?.user?.userId || ""
  );

  expect(nextToken.length).toBeGreaterThan(0);
  expect(householdId.length).toBeGreaterThan(0);
  expect(userId.length).toBeGreaterThan(0);

  return { token: nextToken, householdId, userId };
}

const groups = [
  {
    name: "planners",
    moduleKey: "planners",
    buildUrl: (baseUrl, householdId) =>
      `${baseUrl}/api/planners/meal?householdId=${encodeURIComponent(householdId)}`,
  },
  {
    name: "mealplan",
    moduleKey: "meal-planning",
    buildUrl: (baseUrl, householdId) =>
      `${baseUrl}/api/mealplan/health?householdId=${encodeURIComponent(householdId)}`,
  },
  {
    name: "battle-rhythm",
    moduleKey: "battle-rhythm",
    buildUrl: (baseUrl, householdId) =>
      `${baseUrl}/api/battle-rhythm/health?householdId=${encodeURIComponent(householdId)}`,
  },
  {
    name: "realtime",
    moduleKey: "realtime",
    buildUrl: (baseUrl, householdId) =>
      `${baseUrl}/api/realtime/suggestions?householdId=${encodeURIComponent(
        householdId
      )}&scope=household&scopeId=${encodeURIComponent(householdId)}`,
  },
];

describe("access policy entitlement gating contract", () => {
  for (const group of groups) {
    it(`returns entitlement_required for ${group.name} until planner.base entitlement is granted`, async () => {
      const testDataPaths = createTestDataPaths(group.name);
      const { child, port } = startServer({}, testDataPaths);
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        await waitForHealth(port);

        const owner = await registerAndBootstrap(baseUrl, `${group.name}-owner`);
        const collaborator = await registerAndBootstrap(baseUrl, `${group.name}-collab`);

        await grantCollaboration({
          userId: collaborator.userId,
          householdId: owner.householdId,
          moduleKey: group.moduleKey,
          accessPolicyFile: testDataPaths.accessPolicyFile,
        });

        const deniedRes = await fetch(group.buildUrl(baseUrl, owner.householdId), {
          headers: { authorization: `Bearer ${collaborator.token}` },
        });
        const denied = await deniedRes.json();
        expect(deniedRes.status).toBe(403);
        expect(denied.error).toBe("entitlement_required");
        expect(denied.feature).toBe("planner.base");

        await setEntitlements({
          userId: collaborator.userId,
          accessPolicyFile: testDataPaths.accessPolicyFile,
          entitlements: ["planner.base"],
        });

        const allowedRes = await fetch(group.buildUrl(baseUrl, owner.householdId), {
          headers: { authorization: `Bearer ${collaborator.token}` },
        });
        const allowed = await allowedRes.json();
        if (group.name === "planners") {
          expect([200, 500]).toContain(allowedRes.status);
          expect(String(allowed?.error || "")).not.toBe("entitlement_required");
        } else if (group.name === "realtime") {
          expect([200, 400, 503]).toContain(allowedRes.status);
          expect(String(allowed?.error || "")).not.toBe("entitlement_required");
        } else {
          expect(allowedRes.status).toBe(200);
          expect(allowed.ok).toBe(true);
        }
      } finally {
        await stopServer(child);
        await fs.rm(testDataPaths.testDataDir, { recursive: true, force: true }).catch(() => {});
      }
    }, 30000);
  }
});
