import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

async function getAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((closeError) => {
        if (closeError) return reject(closeError);
        if (!port) return reject(new Error("port_allocation_failed"));
        return resolve(port);
      });
    });
  });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createOutputCapture(child) {
  const stdout = [];
  const stderr = [];

  child.stdout?.on("data", (chunk) => {
    stdout.push(String(chunk));
    if (stdout.length > 60) stdout.shift();
  });

  child.stderr?.on("data", (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 60) stderr.shift();
  });

  return {
    tail() {
      return {
        stdout: stdout.join("").slice(-3000),
        stderr: stderr.join("").slice(-3000),
      };
    },
  };
}

async function waitForHealth(port, child, outputCapture, timeoutMs = 30000) {
  const started = Date.now();
  const onExit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ exited: true, code, signal });
    });
  });

  while (Date.now() - started < timeoutMs) {
    const exited = await Promise.race([onExit, sleep(0).then(() => null)]);
    if (exited?.exited) {
      const logs = outputCapture.tail();
      throw new Error(
        `server_exited_before_health code=${exited.code} signal=${exited.signal} stderr=${logs.stderr || "<empty>"} stdout=${logs.stdout || "<empty>"}`
      );
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(150);
  }

  const logs = outputCapture.tail();
  throw new Error(
    `health_timeout port=${port} timeoutMs=${timeoutMs} stderr=${logs.stderr || "<empty>"} stdout=${logs.stdout || "<empty>"}`
  );
}

async function startServer(extraEnv = {}) {
  const port = await getAvailablePort();
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
      ALLOW_INSECURE_HEADER_AUTH: "true",
      SSA_DEV_AUTH_BYPASS: "true",
      SSA_DEV_POLICY_BYPASS: "true",
      PLANNER_OPERATIONAL_OUTBOX_WORKER_DISABLED: "true",
      MONGO_SERVER_SELECTION_TIMEOUT_MS: "100",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const outputCapture = createOutputCapture(child);

  return { child, port, outputCapture };
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
    const { child, port, outputCapture } = await startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `slice-a-household-${randomUUID()}`;
    const authHeaders = { "x-user-id": "dev-local-user" };

    try {
      await waitForHealth(port, child, outputCapture);

      const beforeRes = await fetch(
        `${baseUrl}/api/planners/meal/context?householdId=${encodeURIComponent(householdId)}`,
        { headers: authHeaders }
      );
      expect(beforeRes.status).toBe(200);
      const beforeBody = await beforeRes.json();
      const basePost = beforeBody.feed.find((item) => item.id === "meal-feed-1");
      expect(basePost).toBeTruthy();
      const baselineLikes = Number(basePost?.likes || 0);
      const baselineComments = Number(basePost?.comments || 0);
      const baselineShares = Number(basePost?.shares || 0);

      const likeRes = await fetch(
        `${baseUrl}/api/planners/meal/context/feed/meal-feed-1/action`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ householdId, action: "like", delta: 1 }),
        }
      );
      expect(likeRes.status).toBe(200);
      const likeBody = await likeRes.json();
      expect(likeBody.ok).toBe(true);
      expect(Number(likeBody.updatedPost.likes)).toBeGreaterThanOrEqual(1);
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
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ householdId, action: "comment", delta: 2 }),
        }
      );
      expect(commentRes.status).toBe(200);
      const commentBody = await commentRes.json();
      expect(Number(commentBody.updatedPost.comments)).toBeGreaterThanOrEqual(1);

      const shareClampRes = await fetch(
        `${baseUrl}/api/planners/meal/context/feed/meal-feed-1/action`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
          body: JSON.stringify({ householdId, action: "share", delta: -999 }),
        }
      );
      expect(shareClampRes.status).toBe(200);
      const shareClampBody = await shareClampRes.json();
      expect(shareClampBody.updatedPost.shares).toBe(Math.max(0, baselineShares - 999));

      const afterRes = await fetch(
        `${baseUrl}/api/planners/meal/context?householdId=${encodeURIComponent(householdId)}`,
        { headers: authHeaders }
      );
      expect(afterRes.status).toBe(200);
      const afterBody = await afterRes.json();
      const afterPost = afterBody.feed.find((item) => item.id === "meal-feed-1");

      expect(Number(afterPost.likes)).toBeGreaterThanOrEqual(1);
      expect(Number(afterPost.comments)).toBeGreaterThanOrEqual(2);
      expect(Number(afterPost.shares)).toBeGreaterThanOrEqual(0);
      expect(afterPost.updatedBy).toBe("dev-local-user");
      expect(Array.isArray(afterPost.actionLog)).toBe(true);
      expect(afterPost.actionLog.length).toBeGreaterThanOrEqual(2);
    } finally {
      await stopServer(child);
    }
  }, 30000);

  it("rejects unsupported feed actions with a contract error", async () => {
    const { child, port, outputCapture } = await startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `slice-a-household-${randomUUID()}-unsupported`;
    const authHeaders = { "x-user-id": "dev-local-user" };

    try {
      await waitForHealth(port, child, outputCapture);

      const response = await fetch(
        `${baseUrl}/api/planners/meal/context/feed/meal-feed-1/action`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...authHeaders },
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
