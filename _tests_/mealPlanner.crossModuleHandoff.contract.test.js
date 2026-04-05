import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

function randomPort() {
  return 16000 + Math.floor(Math.random() * 6000);
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
      SSA_DEV_AUTH_BYPASS: "true",
      SSA_DEV_POLICY_BYPASS: "true",
      PLANNER_OPERATIONAL_OUTBOX_WORKER_DISABLED: "true",
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

describe("meal planner cross-module handoff contract", () => {
  it("mirrors meal feed share actions into homestead collaboration feed", async () => {
    const { child, port } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `slice-b-household-${Date.now()}`;

    try {
      await waitForHealth(port);

      const beforeHomesteadRes = await fetch(
        `${baseUrl}/api/planners/homestead/collaboration?householdId=${encodeURIComponent(householdId)}`
      );
      expect(beforeHomesteadRes.status).toBe(200);
      const beforeHomesteadBody = await beforeHomesteadRes.json();
      const beforeCount = Array.isArray(beforeHomesteadBody?.collaboration?.feed)
        ? beforeHomesteadBody.collaboration.feed.length
        : 0;

      const shareRes = await fetch(
        `${baseUrl}/api/planners/meal/context/feed/meal-feed-1/action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ householdId, action: "share", delta: 1 }),
        }
      );
      expect(shareRes.status).toBe(200);
      const shareBody = await shareRes.json();
      expect(shareBody.ok).toBe(true);

      const afterHomesteadRes = await fetch(
        `${baseUrl}/api/planners/homestead/collaboration?householdId=${encodeURIComponent(householdId)}`
      );
      expect(afterHomesteadRes.status).toBe(200);
      const afterHomesteadBody = await afterHomesteadRes.json();
      const feed = afterHomesteadBody?.collaboration?.feed || [];

      expect(feed.length).toBe(beforeCount + 1);
      const handoff = feed[0];
      expect(handoff).toMatchObject({
        author: "Meal Planner Handoff",
        source: "meal-planner",
        sourcePostId: "meal-feed-1",
        updatedBy: "dev-local-user",
        lastAction: "handoff_from_meal",
      });
      expect(Array.isArray(handoff.actionLog)).toBe(true);
      expect(handoff.actionLog.at(-1)).toMatchObject({
        action: "handoff_from_meal",
        updatedBy: "dev-local-user",
      });
    } finally {
      await stopServer(child);
    }
  }, 30000);
});
