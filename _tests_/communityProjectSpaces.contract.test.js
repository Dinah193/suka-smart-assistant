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

  it("enforces privacy matrix and trust modes across household_only trusted and public spaces", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `community-governance-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const createProject = async ({ title, visibilityScope, trustMode, memberships = [] }) => {
        const response = await fetch(`${baseUrl}/api/planners/community/projects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            project: {
              title,
              visibilityScope,
              trustMode,
              memberships,
            },
          }),
        });
        expect(response.status).toBe(200);
        const payload = await response.json();
        return String(payload?.project?.id || "");
      };

      const householdOnlyId = await createProject({
        title: "Household-only canning plan",
        visibilityScope: "household_only",
        trustMode: "invite_only",
      });
      const trustedId = await createProject({
        title: "Trusted orchard coordination",
        visibilityScope: "trusted",
        trustMode: "trusted_only",
        memberships: [
          { householdId: "trusted-household", role: "contributor", trustStatus: "trusted" },
          { householdId: "pending-household", role: "contributor", trustStatus: "pending" },
        ],
      });
      const publicId = await createProject({
        title: "Public seed exchange",
        visibilityScope: "public",
        trustMode: "open",
      });

      expect(householdOnlyId.length).toBeGreaterThan(0);
      expect(trustedId.length).toBeGreaterThan(0);
      expect(publicId.length).toBeGreaterThan(0);

      const ownerListRes = await fetch(
        `${baseUrl}/api/planners/community/projects?householdId=${encodeURIComponent(
          householdId
        )}&viewerHouseholdId=${encodeURIComponent(householdId)}`
      );
      expect(ownerListRes.status).toBe(200);
      const ownerListPayload = await ownerListRes.json();
      expect(Array.isArray(ownerListPayload?.projects)).toBe(true);
      expect(ownerListPayload.projects.length).toBeGreaterThanOrEqual(3);

      const outsiderListRes = await fetch(
        `${baseUrl}/api/planners/community/projects?householdId=${encodeURIComponent(
          householdId
        )}&viewerHouseholdId=${encodeURIComponent("outsider-household")}`
      );
      expect(outsiderListRes.status).toBe(200);
      const outsiderListPayload = await outsiderListRes.json();
      const outsiderIds = (Array.isArray(outsiderListPayload?.projects)
        ? outsiderListPayload.projects
        : []
      ).map((project) => String(project?.id || ""));
      expect(outsiderIds.includes(publicId)).toBe(true);
      expect(outsiderIds.includes(trustedId)).toBe(false);
      expect(outsiderIds.includes(householdOnlyId)).toBe(false);

      const trustedViewerRes = await fetch(
        `${baseUrl}/api/planners/community/projects?householdId=${encodeURIComponent(
          householdId
        )}&viewerHouseholdId=${encodeURIComponent("trusted-household")}`
      );
      expect(trustedViewerRes.status).toBe(200);
      const trustedViewerPayload = await trustedViewerRes.json();
      const trustedViewerIds = (Array.isArray(trustedViewerPayload?.projects)
        ? trustedViewerPayload.projects
        : []
      ).map((project) => String(project?.id || ""));
      expect(trustedViewerIds.includes(publicId)).toBe(true);
      expect(trustedViewerIds.includes(trustedId)).toBe(true);
      expect(trustedViewerIds.includes(householdOnlyId)).toBe(false);

      const pendingContributionRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(trustedId)}/contributions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            actorHouseholdId: "pending-household",
            contribution: {
              summary: "Pending member attempted contribution",
              type: "worklog",
              units: 1,
            },
          }),
        }
      );
      expect(pendingContributionRes.status).toBe(403);

      const trustedContributionRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(trustedId)}/contributions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            actorHouseholdId: "trusted-household",
            contribution: {
              summary: "Trusted member contribution",
              type: "materials",
              units: 3,
            },
          }),
        }
      );
      expect(trustedContributionRes.status).toBe(200);

      const inviteOnlyContributionRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(householdOnlyId)}/contributions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            actorHouseholdId: "outsider-household",
            contribution: {
              summary: "Outsider attempt on invite-only",
            },
          }),
        }
      );
      expect(inviteOnlyContributionRes.status).toBe(403);

      const openContributionRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(publicId)}/contributions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            actorHouseholdId: "outsider-household",
            contribution: {
              summary: "Open-mode contribution",
              type: "worklog",
              units: 2,
            },
          }),
        }
      );
      expect(openContributionRes.status).toBe(200);
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("enforces owner/admin-only authority for membership trust and role changes", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `community-roles-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const createRes = await fetch(`${baseUrl}/api/planners/community/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          project: {
            title: "Role-governance relay",
            visibilityScope: "trusted",
            trustMode: "trusted_only",
            memberships: [
              { householdId: "admin-household", role: "admin", trustStatus: "trusted" },
              { householdId: "contrib-household", role: "contributor", trustStatus: "trusted" },
              { householdId: "viewer-household", role: "viewer", trustStatus: "trusted" },
              { householdId: "candidate-household", role: "viewer", trustStatus: "pending" },
            ],
          },
        }),
      });
      expect(createRes.status).toBe(200);
      const createPayload = await createRes.json();
      const projectId = String(createPayload?.project?.id || "");
      expect(projectId.length).toBeGreaterThan(0);

      const contributorMutateRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(projectId)}/memberships`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            actorHouseholdId: "contrib-household",
            member: {
              householdId: "candidate-household",
              role: "contributor",
              trustStatus: "trusted",
            },
          }),
        }
      );
      expect(contributorMutateRes.status).toBe(403);

      const viewerMutateRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(projectId)}/memberships`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            actorHouseholdId: "viewer-household",
            member: {
              householdId: "candidate-household",
              role: "contributor",
              trustStatus: "trusted",
            },
          }),
        }
      );
      expect(viewerMutateRes.status).toBe(403);

      const adminMutateRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(projectId)}/memberships`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            actorHouseholdId: "admin-household",
            member: {
              householdId: "candidate-household",
              role: "contributor",
              trustStatus: "trusted",
            },
          }),
        }
      );
      expect(adminMutateRes.status).toBe(200);
      const adminMutatePayload = await adminMutateRes.json();
      expect(String(adminMutatePayload?.membership?.role || "")).toBe("contributor");
      expect(String(adminMutatePayload?.membership?.trustStatus || "")).toBe("trusted");

      const ownerMutateRes = await fetch(
        `${baseUrl}/api/planners/community/projects/${encodeURIComponent(projectId)}/memberships`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            actorHouseholdId: householdId,
            member: {
              householdId: "candidate-household",
              role: "admin",
              trustStatus: "trusted",
            },
          }),
        }
      );
      expect(ownerMutateRes.status).toBe(200);
      const ownerMutatePayload = await ownerMutateRes.json();
      expect(String(ownerMutatePayload?.membership?.role || "")).toBe("admin");

      const projectListRes = await fetch(
        `${baseUrl}/api/planners/community/projects?householdId=${encodeURIComponent(
          householdId
        )}&viewerHouseholdId=${encodeURIComponent(householdId)}`
      );
      expect(projectListRes.status).toBe(200);
      const projectListPayload = await projectListRes.json();
      const updatedProject = (Array.isArray(projectListPayload?.projects)
        ? projectListPayload.projects
        : []).find((project) => String(project?.id || "") === projectId);

      const candidateMembership = (Array.isArray(updatedProject?.memberships)
        ? updatedProject.memberships
        : []).find((member) => String(member?.householdId || "") === "candidate-household");
      expect(String(candidateMembership?.trustStatus || "")).toBe("trusted");
      expect(String(candidateMembership?.role || "")).toBe("admin");
    } finally {
      await stopServer(child);
    }
  }, 60000);
});
