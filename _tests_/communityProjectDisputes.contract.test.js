import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

function randomPort() {
  return 18900 + Math.floor(Math.random() * 3000);
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

describe("community project disputes contract", () => {
  it("captures dispute reports and synchronizes dispute status with approvals workflow", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `community-dispute-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const projectCreateRes = await fetch(`${baseUrl}/api/planners/community/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          project: {
            title: "Co-op packing lane",
            visibilityScope: "public",
            trustMode: "open",
          },
        }),
      });
      expect(projectCreateRes.status).toBe(200);
      const projectCreatePayload = await projectCreateRes.json();
      const projectId = String(projectCreatePayload?.project?.id || "");
      expect(projectId.length).toBeGreaterThan(0);

      const disputeRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(projectId)}/disputes/report`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            reporterHouseholdId: "observer-household",
            summary: "Disputed contribution attribution",
            details: "Two households reported the same shipment crate count.",
          }),
        }
      );
      expect(disputeRes.status).toBe(200);
      const disputePayload = await disputeRes.json();
      const disputeId = String(disputePayload?.dispute?.id || "");
      const approvalId = String(disputePayload?.approvalRequest?.id || "");
      expect(disputeId.length).toBeGreaterThan(0);
      expect(approvalId.length).toBeGreaterThan(0);
      expect(String(disputePayload?.dispute?.status || "")).toBe("queued");

      const listBeforeRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(
          projectId
        )}/disputes?householdId=${encodeURIComponent(householdId)}&viewerHouseholdId=${encodeURIComponent(
          "observer-household"
        )}`
      );
      expect(listBeforeRes.status).toBe(200);
      const listBeforePayload = await listBeforeRes.json();
      const beforeEntry = (Array.isArray(listBeforePayload?.disputes) ? listBeforePayload.disputes : []).find(
        (entry) => String(entry?.id || "") === disputeId
      );
      expect(String(beforeEntry?.status || "")).toBe("queued");

      const transitionToActiveRes = await fetch(
        `${baseUrl}/api/planners/community/approvals/${encodeURIComponent(approvalId)}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            nextState: "active",
            reason: "Dispute moved into active review",
          }),
        }
      );
      expect(transitionToActiveRes.status).toBe(200);

      const transitionToCompletedRes = await fetch(
        `${baseUrl}/api/planners/community/approvals/${encodeURIComponent(approvalId)}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            nextState: "completed",
            reason: "Dispute resolved with corrected contribution log",
          }),
        }
      );
      expect(transitionToCompletedRes.status).toBe(200);

      const listAfterRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(
          projectId
        )}/disputes?householdId=${encodeURIComponent(householdId)}&viewerHouseholdId=${encodeURIComponent(
          "observer-household"
        )}`
      );
      expect(listAfterRes.status).toBe(200);
      const listAfterPayload = await listAfterRes.json();
      const afterEntry = (Array.isArray(listAfterPayload?.disputes) ? listAfterPayload.disputes : []).find(
        (entry) => String(entry?.id || "") === disputeId
      );
      expect(String(afterEntry?.status || "")).toBe("resolved");
      expect(String(afterEntry?.workflowState || "")).toBe("completed");
    } finally {
      await stopServer(child);
    }
  }, 60000);
});
