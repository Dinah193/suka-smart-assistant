import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

function randomPort() {
  return 15000 + Math.floor(Math.random() * 8000);
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

describe("meal planner context feed actions contract", () => {
  it("persists like/comment/share interactions and returns merged context", async () => {
    const { child, port } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `slice-a-household-${Date.now()}`;

    try {
      await waitForHealth(port);

      const beforeRes = await fetch(
        `${baseUrl}/api/planners/meal/context?householdId=${encodeURIComponent(householdId)}`
      );
      expect(beforeRes.status).toBe(200);
      const beforeBody = await beforeRes.json();
      const basePost = beforeBody.feed.find((item) => item.id === "meal-feed-1");
      expect(basePost).toBeTruthy();

      const likeRes = await fetch(
        `${baseUrl}/api/planners/meal/context/feed/meal-feed-1/action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ householdId, action: "like", delta: 1 }),
        }
      );
      expect(likeRes.status).toBe(200);
      const likeBody = await likeRes.json();
      expect(likeBody.ok).toBe(true);
      expect(likeBody.updatedPost.likes).toBe(1);
      expect(likeBody.updatedPost.updatedBy).toBe("dev-local-user");
      expect(Array.isArray(likeBody.updatedPost.actionLog)).toBe(true);
      expect(likeBody.updatedPost.actionLog.at(-1)).toMatchObject({
        action: "like",
        delta: 1,
        updatedBy: "dev-local-user",
      });

      const commentRes = await fetch(
        `${baseUrl}/api/planners/meal/context/feed/meal-feed-1/action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ householdId, action: "comment", delta: 2 }),
        }
      );
      expect(commentRes.status).toBe(200);
      const commentBody = await commentRes.json();
      expect(commentBody.updatedPost.comments).toBe(2);

      const shareClampRes = await fetch(
        `${baseUrl}/api/planners/meal/context/feed/meal-feed-1/action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ householdId, action: "share", delta: -999 }),
        }
      );
      expect(shareClampRes.status).toBe(200);
      const shareClampBody = await shareClampRes.json();
      expect(shareClampBody.updatedPost.shares).toBe(0);

      const afterRes = await fetch(
        `${baseUrl}/api/planners/meal/context?householdId=${encodeURIComponent(householdId)}`
      );
      expect(afterRes.status).toBe(200);
      const afterBody = await afterRes.json();
      const afterPost = afterBody.feed.find((item) => item.id === "meal-feed-1");

      expect(afterPost.likes).toBe(1);
      expect(afterPost.comments).toBe(2);
      expect(afterPost.shares).toBe(0);
      expect(afterPost.updatedBy).toBe("dev-local-user");
      expect(Array.isArray(afterPost.actionLog)).toBe(true);
      expect(afterPost.actionLog.length).toBeGreaterThanOrEqual(3);
    } finally {
      await stopServer(child);
    }
  }, 30000);

  it("rejects unsupported feed actions with a contract error", async () => {
    const { child, port } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `slice-a-household-${Date.now()}-unsupported`;

    try {
      await waitForHealth(port);

      const response = await fetch(
        `${baseUrl}/api/planners/meal/context/feed/meal-feed-1/action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ householdId, action: "bookmark" }),
        }
      );

      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload).toMatchObject({ ok: false, error: "unsupported_action" });
    } finally {
      await stopServer(child);
    }
  }, 30000);
});
