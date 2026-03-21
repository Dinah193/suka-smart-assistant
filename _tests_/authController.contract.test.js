import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

function randomPort() {
  return 12000 + Math.floor(Math.random() * 20000);
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

describe("authController contract", () => {
  it("supports login/register/me/refresh/logout/forgot-password endpoints", async () => {
    const { child, port } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const email = `auth-${Date.now()}@example.com`;
    const password = "Password1234";

    try {
      await waitForHealth(port);

      const registerRes = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: "Test",
          lastName: "User",
          email,
          password,
          confirmPassword: password,
          consent: true,
        }),
      });
      const registerJson = await registerRes.json();
      expect(registerRes.status).toBe(201);
      expect(registerJson.ok).toBe(true);
      expect(typeof registerJson.session?.accessToken).toBe("string");

      const duplicateRegisterRes = await fetch(`${baseUrl}/api/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          firstName: "Test",
          lastName: "User",
          email,
          password,
          confirmPassword: password,
          consent: true,
        }),
      });
      expect(duplicateRegisterRes.status).toBe(409);

      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, rememberMe: true }),
      });
      const loginJson = await loginRes.json();
      expect(loginRes.status).toBe(200);
      expect(loginJson.ok).toBe(true);
      expect(loginJson.user.email).toBe(email.toLowerCase());
      expect(typeof loginJson.session?.accessToken).toBe("string");

      const token = String(loginJson.session?.accessToken || "");
      expect(token.length).toBeGreaterThan(0);

      const meUnauthorizedRes = await fetch(`${baseUrl}/api/auth/me`);
      expect(meUnauthorizedRes.status).toBe(401);

      const meRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const meJson = await meRes.json();
      expect(meRes.status).toBe(200);
      expect(meJson.ok).toBe(true);
      expect(meJson.user.email).toBe(email.toLowerCase());

      const bootstrapRes = await fetch(`${baseUrl}/api/auth/household/bootstrap`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ householdName: "Contract Household" }),
      });
      const bootstrapJson = await bootstrapRes.json();
      expect(bootstrapRes.status).toBe(200);
      expect(bootstrapJson.ok).toBe(true);
      expect(typeof bootstrapJson.user?.householdId).toBe("string");
      expect(bootstrapJson.user.householdId.length).toBeGreaterThan(0);

      const refreshedToken = String(bootstrapJson.session?.accessToken || token);

      const refreshRes = await fetch(`${baseUrl}/api/auth/session/refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${refreshedToken}` },
      });
      const refreshJson = await refreshRes.json();
      expect(refreshRes.status).toBe(200);
      expect(refreshJson.ok).toBe(true);
      expect(typeof refreshJson.session?.accessToken).toBe("string");

      const forgotRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const forgotJson = await forgotRes.json();
      expect(forgotRes.status).toBe(200);
      expect(forgotJson.ok).toBe(true);
      expect(typeof forgotJson.resetToken).toBe("string");

      const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${refreshedToken}` },
      });
      const logoutJson = await logoutRes.json();
      expect(logoutRes.status).toBe(200);
      expect(logoutJson.ok).toBe(true);

      const meAfterLogoutRes = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { authorization: `Bearer ${refreshedToken}` },
      });
      expect(meAfterLogoutRes.status).toBe(401);
    } finally {
      await stopServer(child);
    }
  }, 30000);
});
