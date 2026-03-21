import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");
const accessPolicyFile = path.resolve(repoRoot, "data/access-policies.json");

function randomPort() {
  return 13000 + Math.floor(Math.random() * 10000);
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

function defaultPolicyStore() {
  return {
    version: 1,
    collaborationGrants: [],
    entitlementGrantsByUserId: {},
    householdRolesByHouseholdId: {},
    updatedAt: new Date().toISOString(),
  };
}

async function readPolicyBackup() {
  try {
    return await fs.readFile(accessPolicyFile, "utf8");
  } catch {
    return null;
  }
}

async function restorePolicyBackup(backup) {
  if (backup === null) {
    try {
      await fs.unlink(accessPolicyFile);
    } catch {
      // ignore
    }
    return;
  }
  await fs.writeFile(accessPolicyFile, backup, "utf8");
}

async function grantReadCollaboration({ userId, householdId, moduleKey }) {
  let parsed = defaultPolicyStore();
  try {
    const raw = await fs.readFile(accessPolicyFile, "utf8");
    const json = JSON.parse(raw || "{}");
    parsed = {
      ...defaultPolicyStore(),
      ...json,
      collaborationGrants: Array.isArray(json?.collaborationGrants)
        ? json.collaborationGrants
        : [],
    };
  } catch {
    // use default
  }

  parsed.collaborationGrants = parsed.collaborationGrants.filter((grant) => {
    if (!grant || typeof grant !== "object") return false;
    return !(
      String(grant.userId || "") === String(userId || "") &&
      String(grant.householdId || "") === String(householdId || "") &&
      String(grant.moduleKey || "") === String(moduleKey || "")
    );
  });

  parsed.collaborationGrants.push({
    userId,
    householdId,
    moduleKey,
    actions: ["read"],
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  parsed.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(accessPolicyFile), { recursive: true });
  await fs.writeFile(accessPolicyFile, JSON.stringify(parsed, null, 2), "utf8");
}

async function registerAndBootstrap(baseUrl, suffix) {
  const email = `policy-${suffix}-${Date.now()}@example.com`;
  const password = "Password1234";

  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Policy",
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
  expect(token.length).toBeGreaterThan(0);

  const bootstrapRes = await fetch(`${baseUrl}/api/auth/household/bootstrap`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ householdName: `Policy Household ${suffix}` }),
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

const routeGroups = [
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
];

describe("access policy protected route groups contract", () => {
  for (const group of routeGroups) {
    it(`enforces unauthenticated, no-policy, and granted-policy flows for ${group.name}`, async () => {
      const backup = await readPolicyBackup();
      const { child, port } = startServer();
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        await waitForHealth(port);

        const owner = await registerAndBootstrap(baseUrl, `${group.name}-owner`);
        const collaborator = await registerAndBootstrap(baseUrl, `${group.name}-collab`);

        const unauthRes = await fetch(group.buildUrl(baseUrl, owner.householdId));
        expect(unauthRes.status).toBe(401);

        const noPolicyRes = await fetch(group.buildUrl(baseUrl, owner.householdId), {
          headers: { authorization: `Bearer ${collaborator.token}` },
        });
        const noPolicyBody = await noPolicyRes.json();
        expect(noPolicyRes.status).toBe(403);
        expect(noPolicyBody.error).toBe("collaboration_required");

        await grantReadCollaboration({
          userId: collaborator.userId,
          householdId: owner.householdId,
          moduleKey: group.moduleKey,
        });

        const grantedRes = await fetch(group.buildUrl(baseUrl, owner.householdId), {
          headers: { authorization: `Bearer ${collaborator.token}` },
        });
        const grantedBody = await grantedRes.json();
        expect(grantedRes.status).toBe(200);
        expect(grantedBody.ok).toBe(true);
      } finally {
        await stopServer(child);
        await restorePolicyBackup(backup);
      }
    }, 30000);
  }
});
