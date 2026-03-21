import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");
const runtimeFlag = String(process.env.SSA_ENABLE_RUNTIME_CONTRACT_TESTS || "").toLowerCase();
const runtimeEnabled = runtimeFlag === "1" || runtimeFlag === "true" || runtimeFlag === "yes";
const runtimeDescribe = runtimeEnabled ? describe : describe.skip;

function randomPort() {
  return 4400 + Math.floor(Math.random() * 300);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // wait and retry
    }
    await sleep(150);
  }
  throw new Error("health_timeout");
}

async function registerAndBootstrap(baseUrl, suffix) {
  const email = `battle-rhythm-${suffix}-${Date.now()}@example.com`;
  const password = "Password1234";

  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Battle",
      lastName: "Rhythm",
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
    body: JSON.stringify({ householdName: "Battle Rhythm Contract" }),
  });
  const bootstrapJson = await bootstrapRes.json();
  expect(bootstrapRes.status).toBe(200);

  return {
    token: String(bootstrapJson?.session?.accessToken || token),
    householdId: String(bootstrapJson?.user?.householdId || ""),
  };
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

runtimeDescribe("battleRhythmController runtime contract", () => {
  it("serves profile/customizations/resolve endpoints under /api/battle-rhythm", async () => {
    const { child, port } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);
      const session = await registerAndBootstrap(baseUrl, "runtime");
      const auth = { authorization: `Bearer ${session.token}` };

      const healthRes = await fetch(
        `${baseUrl}/api/battle-rhythm/health?householdId=${encodeURIComponent(session.householdId)}`,
        { headers: auth }
      );
      const health = await healthRes.json();
      expect(healthRes.status).toBe(200);
      expect(health.ok).toBe(true);

      const profileGetRes = await fetch(
        `${baseUrl}/api/battle-rhythm/profile?userId=u-test&householdId=${encodeURIComponent(session.householdId)}`,
        { headers: auth }
      );
      const profileGet = await profileGetRes.json();
      expect(profileGetRes.status).toBe(200);
      expect(profileGet.ok).toBe(true);
      expect(typeof profileGet.profile).toBe("object");

      const profilePostRes = await fetch(`${baseUrl}/api/battle-rhythm/profile`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          userId: "u-test",
          householdId: session.householdId,
          profile: { enabled: true, seasoning: { saltFactor: 0.8 } },
        }),
      });
      const profilePost = await profilePostRes.json();
      expect(profilePostRes.status).toBe(200);
      expect(profilePost.ok).toBe(true);
      expect(profilePost.profile.enabled).toBe(true);

      const customListRes = await fetch(
        `${baseUrl}/api/battle-rhythm/customizations?userId=u-test&householdId=${encodeURIComponent(session.householdId)}`,
        { headers: auth }
      );
      const customList = await customListRes.json();
      expect(customListRes.status).toBe(200);
      expect(customList.ok).toBe(true);
      expect(Array.isArray(customList.items)).toBe(true);

      const customUpsertRes = await fetch(`${baseUrl}/api/battle-rhythm/customizations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          userId: "u-test",
          householdId: session.householdId,
          recipeId: "r-test",
          override: { timing: { quickNightMaxMins: 30 } },
        }),
      });
      const customUpsert = await customUpsertRes.json();
      expect(customUpsertRes.status).toBe(200);
      expect(customUpsert.ok).toBe(true);

      const resolvePassRes = await fetch(`${baseUrl}/api/battle-rhythm/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          householdId: session.householdId,
          recipe: { id: "r-test", ingredients: [{ name: "salt", qty: 2 }], time: { totalMins: 30 } },
          resolveServerSide: false,
        }),
      });
      const resolvePass = await resolvePassRes.json();
      expect(resolvePassRes.status).toBe(200);
      expect(resolvePass.ok).toBe(true);
      expect(resolvePass.passthrough).toBe(true);
    } finally {
      await stopServer(child);
    }
  }, 25000);
});
