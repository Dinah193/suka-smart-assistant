import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

function randomPort() {
  return 18600 + Math.floor(Math.random() * 3000);
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

describe("community project spaces contract", () => {
  it("supports project lifecycle metadata with milestones, contributions, and trust memberships", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `community-project-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const createRes = await fetch(`${baseUrl}/api/planners/community/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          project: {
            title: "Spring Orchard Relay",
            detail: "Coordinate pruning and harvest prep across trusted households.",
            visibilityScope: "trusted",
            trustMode: "trusted_only",
            memberships: [
              { householdId, role: "owner", trustStatus: "trusted" },
              { householdId: "ally-household-1", role: "contributor", trustStatus: "pending" },
            ],
            milestones: [
              {
                title: "Pruning complete",
                detail: "Finish pruning before rain window.",
                workflowState: "active",
              },
            ],
            contributions: [
              {
                actorHouseholdId: householdId,
                actor: "Host household",
                type: "worklog",
                summary: "Supplied ladders and sharpening kits",
                units: 2,
              },
            ],
          },
        }),
      });
      expect(createRes.status).toBe(200);
      const createPayload = await createRes.json();
      const projectId = String(createPayload?.project?.id || "");
      expect(projectId.length).toBeGreaterThan(0);
      expect(String(createPayload?.project?.visibilityScope || "")).toBe("trusted");
      expect(String(createPayload?.project?.trustMode || "")).toBe("trusted_only");
      expect(Array.isArray(createPayload?.project?.milestones)).toBe(true);
      expect(Array.isArray(createPayload?.project?.contributions)).toBe(true);
      expect(Array.isArray(createPayload?.project?.memberships)).toBe(true);

      const membershipRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(projectId)}/memberships`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            member: {
              householdId: "ally-household-1",
              displayName: "Ally One",
              role: "contributor",
              trustStatus: "trusted",
            },
          }),
        }
      );
      expect(membershipRes.status).toBe(200);
      const membershipPayload = await membershipRes.json();
      expect(String(membershipPayload?.membership?.trustStatus || "")).toBe("trusted");

      const milestoneRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(projectId)}/milestones`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            milestone: {
              title: "Harvest logistics locked",
              workflowState: "planned",
            },
          }),
        }
      );
      expect(milestoneRes.status).toBe(200);
      const milestonePayload = await milestoneRes.json();
      expect(String(milestonePayload?.milestone?.title || "")).toContain("Harvest logistics");

      const contributionRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(projectId)}/contributions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            contribution: {
              actorHouseholdId: "ally-household-1",
              actor: "Ally One",
              type: "materials",
              summary: "Delivered crates for sorting lanes",
              units: 6,
            },
          }),
        }
      );
      expect(contributionRes.status).toBe(200);
      const contributionPayload = await contributionRes.json();
      expect(String(contributionPayload?.contribution?.type || "")).toBe("materials");

      const trustedListRes = await fetch(
        `${baseUrl}/api/planners/community/projects?householdId=${encodeURIComponent(
          householdId
        )}&visibility=trusted&memberHouseholdId=${encodeURIComponent("ally-household-1")}&trustStatus=trusted`
      );
      expect(trustedListRes.status).toBe(200);
      const trustedListPayload = await trustedListRes.json();
      expect(Array.isArray(trustedListPayload?.projects)).toBe(true);
      expect(trustedListPayload.projects.length).toBe(1);

      const project = trustedListPayload.projects[0] || {};
      expect(String(project?.id || "")).toBe(projectId);
      expect(Array.isArray(project?.milestones) ? project.milestones.length : 0).toBeGreaterThanOrEqual(2);
      expect(Array.isArray(project?.contributions) ? project.contributions.length : 0).toBeGreaterThanOrEqual(2);

      const trustedMembership = (Array.isArray(project?.memberships) ? project.memberships : []).find(
        (member) => String(member?.householdId || "") === "ally-household-1"
      );
      expect(String(trustedMembership?.trustStatus || "")).toBe("trusted");
    } finally {
      await stopServer(child);
    }
  }, 60000);
});
