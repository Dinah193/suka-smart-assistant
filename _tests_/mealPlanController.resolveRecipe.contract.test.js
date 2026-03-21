import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");
const runtimeFlag = String(process.env.SSA_ENABLE_RUNTIME_CONTRACT_TESTS || "").toLowerCase();
const runtimeEnabled = runtimeFlag === "1" || runtimeFlag === "true" || runtimeFlag === "yes";
const runtimeDescribe = runtimeEnabled ? describe : describe.skip;

function randomPort() {
  return 4700 + Math.floor(Math.random() * 300);
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
      // retry
    }
    await sleep(150);
  }
  throw new Error("health_timeout");
}

async function registerAndBootstrap(baseUrl, suffix) {
  const email = `mealplan-${suffix}-${Date.now()}@example.com`;
  const password = "Password1234";

  const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      firstName: "Meal",
      lastName: "Planner",
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
    body: JSON.stringify({ householdName: "Meal Plan Contract" }),
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

runtimeDescribe("mealPlanController /resolveRecipe runtime contract", () => {
  it("returns passthrough, resolved payload, and validation error contracts", async () => {
    const { child, port } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);
      const session = await registerAndBootstrap(baseUrl, "runtime");
      const auth = { authorization: `Bearer ${session.token}` };

      const healthRes = await fetch(
        `${baseUrl}/api/mealplan/health?householdId=${encodeURIComponent(session.householdId)}`,
        { headers: auth }
      );
      expect(healthRes.status).toBe(200);

      const recipe = {
        id: "r101",
        title: "Weeknight chicken",
        ingredients: [
          { name: "salt", qty: 2, unit: "g" },
          { name: "butter", qty: 10, unit: "g" },
        ],
        time: { totalMins: 40 },
      };

      const passRes = await fetch(`${baseUrl}/api/mealplan/resolveRecipe`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ recipe, householdId: session.householdId, resolveServerSide: false }),
      });
      const passBody = await passRes.json();
      expect(passRes.status).toBe(200);
      expect(passBody.ok).toBe(true);
      expect(passBody.passthrough).toBe(true);
      expect(passBody.recipe).toEqual(recipe);

      const resolveRes = await fetch(`${baseUrl}/api/mealplan/resolveRecipe`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({
          recipe,
          householdId: session.householdId,
          rhythm: {
            enabled: true,
            seasoning: { saltFactor: 0.5 },
          },
          context: { dayKey: "2026-03-10" },
          resolveServerSide: true,
        }),
      });
      const resolveBody = await resolveRes.json();
      expect([200, 500]).toContain(resolveRes.status);
      if (resolveRes.status === 200) {
        expect(resolveBody.ok).toBe(true);
        expect(resolveBody.resolved).toBeTruthy();
        expect(resolveBody.resolved.recipe).toBeTruthy();

        const saltLine = resolveBody.resolved.recipe.ingredients.find((x) =>
          String(x.name || x.label).toLowerCase().includes("salt")
        );
        expect(Number(saltLine.qty)).toBeCloseTo(1, 4);
      } else {
        expect(resolveBody.ok).toBe(false);
        expect(String(resolveBody.error || "").length).toBeGreaterThan(0);
      }

      const invalidRes = await fetch(`${baseUrl}/api/mealplan/resolveRecipe`, {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ householdId: session.householdId, resolveServerSide: true }),
      });
      const invalidBody = await invalidRes.json();
      expect(invalidRes.status).toBe(400);
      expect(invalidBody.ok).toBe(false);
      expect(String(invalidBody.error || "").toLowerCase()).toContain("required property");
    } finally {
      await stopServer(child);
    }
  }, 25000);
});
