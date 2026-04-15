import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  buildHouseholdParityFixture,
  HOUSEHOLD_PARITY_MODULES,
} from "./fixtures/householdParityFixtures.js";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

function randomPort() {
  return 18100 + Math.floor(Math.random() * 3000);
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

describe("planner unified feed contract", () => {
  it("returns cross-module feed entries with normalized metadata", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `unified-feed-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const response = await fetch(
        `${baseUrl}/api/planners/feed/unified?householdId=${encodeURIComponent(householdId)}&modules=meal,storehouse,homestead,community&limit=20`
      );
      expect(response.status).toBe(200);
      const payload = await response.json();

      expect(payload.ok).toBe(true);
      expect(payload.householdId).toBe(householdId);
      expect(Array.isArray(payload.items)).toBe(true);
      expect(payload.items.length).toBeGreaterThanOrEqual(4);

      const modules = new Set(payload.items.map((item) => item.sourceModule));
      expect(modules.has("meal")).toBe(true);
      expect(modules.has("storehouse")).toBe(true);
      expect(modules.has("homestead")).toBe(true);
      expect(modules.has("community")).toBe(true);

      const first = payload.items[0];
      expect(first).toMatchObject({
        householdId,
      });
      expect(typeof first.id).toBe("string");
      expect(typeof first.sourceId).toBe("string");
      expect(typeof first.author).toBe("string");
      expect(typeof first.content).toBe("string");
      expect(typeof first.stats).toBe("object");
      expect(typeof first.stats.likes).toBe("number");
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("persists unified reactions and comment threads across modules", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `unified-actions-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const feedResponse = await fetch(
        `${baseUrl}/api/planners/feed/unified?householdId=${encodeURIComponent(householdId)}&modules=meal,storehouse,homestead,community&limit=20`
      );
      expect(feedResponse.status).toBe(200);
      const feedPayload = await feedResponse.json();
      const items = Array.isArray(feedPayload?.items) ? feedPayload.items : [];

      const pickByModule = (moduleName) =>
        items.find((item) => String(item?.sourceModule) === moduleName);

      const moduleTargets = ["meal", "storehouse", "homestead", "community"]
        .map((moduleName) => ({ moduleName, item: pickByModule(moduleName) }))
        .filter((entry) => entry.item && entry.item.sourceId);

      expect(moduleTargets.length).toBe(4);

      for (const { moduleName, item } of moduleTargets) {
        const sourceId = String(item.sourceId);

        const likeResOne = await fetch(
          `${baseUrl}/api/planners/feed/unified/${encodeURIComponent(moduleName)}/${encodeURIComponent(sourceId)}/reaction`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ householdId, action: "like", delta: 1 }),
          }
        );
        expect(likeResOne.status).toBe(200);
        const likePayloadOne = await likeResOne.json();
        const likesAfterOne = Number(likePayloadOne?.updatedItem?.stats?.likes || 0);
        expect(likesAfterOne).toBeGreaterThan(0);
        expect(String(likePayloadOne?.event?.mutationType || "")).toBe("reaction");
        expect(String(likePayloadOne?.event?.sourceModule || "")).toBe(moduleName);
        expect(String(likePayloadOne?.event?.sourceId || "")).toBe(sourceId);
        expect(String(likePayloadOne?.event?.action || "")).toBe("like");

        const likeResTwo = await fetch(
          `${baseUrl}/api/planners/feed/unified/${encodeURIComponent(moduleName)}/${encodeURIComponent(sourceId)}/reaction`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ householdId, action: "like", delta: 1 }),
          }
        );
        expect(likeResTwo.status).toBe(200);
        const likePayloadTwo = await likeResTwo.json();
        const likesAfterTwo = Number(likePayloadTwo?.updatedItem?.stats?.likes || 0);
        expect(likesAfterTwo).toBe(likesAfterOne + 1);

        const threadBefore = await fetch(
          `${baseUrl}/api/planners/feed/unified/${encodeURIComponent(moduleName)}/${encodeURIComponent(sourceId)}/comments?householdId=${encodeURIComponent(householdId)}`
        );
        expect(threadBefore.status).toBe(200);
        const beforePayload = await threadBefore.json();
        const beforeThreadLength = Array.isArray(beforePayload?.comments)
          ? beforePayload.comments.length
          : 0;

        const commentRes = await fetch(
          `${baseUrl}/api/planners/feed/unified/${encodeURIComponent(moduleName)}/${encodeURIComponent(sourceId)}/comments`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ householdId, body: `Contract thread note for ${moduleName}` }),
          }
        );
        expect(commentRes.status).toBe(200);
        const commentPayload = await commentRes.json();
        expect(Array.isArray(commentPayload?.comments)).toBe(true);
        expect(commentPayload.comments.length).toBeGreaterThan(0);
        expect(commentPayload.comments.length).toBe(beforeThreadLength + 1);
        expect(String(commentPayload?.event?.mutationType || "")).toBe("comment");
        expect(String(commentPayload?.event?.sourceModule || "")).toBe(moduleName);
        expect(String(commentPayload?.event?.sourceId || "")).toBe(sourceId);

        const lastComment = commentPayload.comments[commentPayload.comments.length - 1];
        expect(String(lastComment?.body || "")).toContain(moduleName);
        expect(Number(commentPayload?.updatedItem?.stats?.comments || 0)).toBeGreaterThan(0);

        const replyRes = await fetch(
          `${baseUrl}/api/planners/feed/unified/${encodeURIComponent(moduleName)}/${encodeURIComponent(sourceId)}/comments`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              body: `Replying to @${moduleName} thread`,
              parentCommentId: String(lastComment.id),
            }),
          }
        );
        expect(replyRes.status).toBe(200);
        const replyPayload = await replyRes.json();
        const appendedReply = replyPayload.comments[replyPayload.comments.length - 1];
        expect(String(appendedReply?.parentCommentId || "")).toBe(String(lastComment.id));
        expect(Array.isArray(appendedReply?.mentions)).toBe(true);
        expect(appendedReply.mentions.includes(moduleName)).toBe(true);
        expect(Array.isArray(replyPayload?.threadedComments)).toBe(true);
        expect(Array.isArray(replyPayload?.mentionNotifications)).toBe(true);
        expect(
          replyPayload.mentionNotifications.some(
            (entry) =>
              String(entry?.mention || "") === moduleName &&
              String(entry?.sourceModule || "") === moduleName
          )
        ).toBe(true);

        const rootComment = replyPayload.threadedComments.find(
          (node) => String(node?.id || "") === String(lastComment.id)
        );
        expect(rootComment).toBeTruthy();
        expect(Array.isArray(rootComment.replies)).toBe(true);
        expect(
          rootComment.replies.some((node) => String(node?.id || "") === String(appendedReply?.id || ""))
        ).toBe(true);

        const readThread = await fetch(
          `${baseUrl}/api/planners/feed/unified/${encodeURIComponent(moduleName)}/${encodeURIComponent(sourceId)}/comments?householdId=${encodeURIComponent(householdId)}`
        );
        expect(readThread.status).toBe(200);
        const threadPayload = await readThread.json();
        expect(Array.isArray(threadPayload?.comments)).toBe(true);
        expect(threadPayload.comments.length).toBeGreaterThan(0);
        expect(Array.isArray(threadPayload?.threadedComments)).toBe(true);

        const notificationsRes = await fetch(
          `${baseUrl}/api/planners/community/notifications?householdId=${encodeURIComponent(householdId)}`
        );
        expect(notificationsRes.status).toBe(200);
        const notificationsPayload = await notificationsRes.json();
        expect(Array.isArray(notificationsPayload?.notifications)).toBe(true);
        expect(
          notificationsPayload.notifications.some(
            (entry) =>
              String(entry?.type || "") === "mention" &&
              String(entry?.mention || "") === moduleName &&
              String(entry?.sourceModule || "") === moduleName &&
              String(entry?.sourceId || "") === sourceId &&
              String(entry?.eventType || "") === "feed.mentioned" &&
              String(entry?.severity || "") === "action_required"
          )
        ).toBe(true);
      }
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("supports unified feed search across modules", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `unified-search-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const seedResponse = await fetch(
        `${baseUrl}/api/planners/feed/unified?householdId=${encodeURIComponent(householdId)}&modules=meal,storehouse,homestead,community&limit=20`
      );
      expect(seedResponse.status).toBe(200);

      const searchResponse = await fetch(
        `${baseUrl}/api/planners/feed/unified/search?householdId=${encodeURIComponent(householdId)}&q=meal&modules=meal,storehouse,homestead,community&limit=20`
      );
      expect(searchResponse.status).toBe(200);
      const payload = await searchResponse.json();

      expect(payload.ok).toBe(true);
      expect(payload.householdId).toBe(householdId);
      expect(payload.query).toBe("meal");
      expect(Array.isArray(payload.items)).toBe(true);
      expect(payload.items.length).toBeGreaterThan(0);
      expect(payload.items.some((item) => String(item?.sourceModule || "") === "meal")).toBe(true);
      expect(payload.items.every((item) => String(item?.householdId || "") === householdId)).toBe(true);
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("serves discovery profiles and persists profile visibility", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `community-visibility-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const feedResponse = await fetch(
        `${baseUrl}/api/planners/feed/unified?householdId=${encodeURIComponent(householdId)}&modules=meal,storehouse,homestead,community&limit=20`
      );
      expect(feedResponse.status).toBe(200);

      const discoveryResponse = await fetch(
        `${baseUrl}/api/planners/community/discovery/profiles?householdId=${encodeURIComponent(householdId)}&q=meal&limit=12`
      );
      expect(discoveryResponse.status).toBe(200);
      const discoveryPayload = await discoveryResponse.json();
      expect(discoveryPayload.ok).toBe(true);
      expect(discoveryPayload.householdId).toBe(householdId);
      expect(Array.isArray(discoveryPayload.profiles)).toBe(true);
      expect(discoveryPayload.profiles.length).toBeGreaterThan(0);
      expect(discoveryPayload.profiles.every((entry) => typeof entry?.href === "string")).toBe(true);

      const visibilityReadBefore = await fetch(
        `${baseUrl}/api/planners/community/profile-visibility?householdId=${encodeURIComponent(householdId)}`
      );
      expect(visibilityReadBefore.status).toBe(200);
      const visibilityBeforePayload = await visibilityReadBefore.json();
      expect(visibilityBeforePayload.ok).toBe(true);
      expect(visibilityBeforePayload.householdId).toBe(householdId);
      expect(typeof visibilityBeforePayload?.profileVisibility?.mode).toBe("string");

      const visibilityWrite = await fetch(`${baseUrl}/api/planners/community/profile-visibility`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          mode: "friends",
          discoverable: false,
          showHouseholdName: false,
          updatedBy: "contract-test",
        }),
      });
      expect(visibilityWrite.status).toBe(200);
      const visibilityWritePayload = await visibilityWrite.json();
      expect(visibilityWritePayload.ok).toBe(true);
      expect(visibilityWritePayload.profileVisibility).toMatchObject({
        mode: "friends",
        discoverable: false,
        showHouseholdName: false,
      });

      const visibilityReadAfter = await fetch(
        `${baseUrl}/api/planners/community/profile-visibility?householdId=${encodeURIComponent(householdId)}`
      );
      expect(visibilityReadAfter.status).toBe(200);
      const visibilityAfterPayload = await visibilityReadAfter.json();
      expect(visibilityAfterPayload.profileVisibility).toMatchObject({
        mode: "friends",
        discoverable: false,
        showHouseholdName: false,
      });
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("persists community context save paths for shared, garden, and animal plans", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `community-context-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const sharedPlanRes = await fetch(`${baseUrl}/api/planners/community/shared-plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          plan: { title: "Shared prep night", lane: "meal" },
          updatedBy: "contract-test",
        }),
      });
      expect(sharedPlanRes.status).toBe(200);

      const gardenPlanRes = await fetch(`${baseUrl}/api/planners/community/garden-plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          plan: { title: "Compost relay", lane: "garden" },
          updatedBy: "contract-test",
        }),
      });
      expect(gardenPlanRes.status).toBe(200);

      const animalPlanRes = await fetch(`${baseUrl}/api/planners/community/animal-plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          plan: { title: "Livestock rotation", lane: "animals" },
          updatedBy: "contract-test",
        }),
      });
      expect(animalPlanRes.status).toBe(200);

      const contextRes = await fetch(
        `${baseUrl}/api/planners/community/context?householdId=${encodeURIComponent(householdId)}`
      );
      expect(contextRes.status).toBe(200);
      const contextPayload = await contextRes.json();
      const context = contextPayload?.context || {};

      expect(Array.isArray(context.sharedPlans)).toBe(true);
      expect(Array.isArray(context.gardenPlans)).toBe(true);
      expect(Array.isArray(context.animalPlans)).toBe(true);
      expect(context.sharedPlans.some((item) => String(item?.title || "") === "Shared prep night")).toBe(true);
      expect(context.gardenPlans.some((item) => String(item?.title || "") === "Compost relay")).toBe(true);
      expect(context.animalPlans.some((item) => String(item?.title || "") === "Livestock rotation")).toBe(true);

      const notificationsRes = await fetch(
        `${baseUrl}/api/planners/community/notifications?householdId=${encodeURIComponent(householdId)}`
      );
      expect(notificationsRes.status).toBe(200);
      const notificationsPayload = await notificationsRes.json();
      expect(
        notificationsPayload.notifications.some(
          (entry) => String(entry?.title || "").toLowerCase() === "shared plan updated"
        )
      ).toBe(true);
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("queues moderation report notifications in community flow", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `community-moderation-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const reportRes = await fetch(`${baseUrl}/api/planners/community/moderation/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          targetId: "feed-item-1",
          reason: "safety",
          details: "Contract moderation flow",
          updatedBy: "contract-test",
        }),
      });
      expect(reportRes.status).toBe(200);
      const reportPayload = await reportRes.json();
      expect(reportPayload.ok).toBe(true);
      expect(String(reportPayload?.report?.status || "")).toBe("queued");

      const notificationsRes = await fetch(
        `${baseUrl}/api/planners/community/notifications?householdId=${encodeURIComponent(householdId)}`
      );
      expect(notificationsRes.status).toBe(200);
      const notificationsPayload = await notificationsRes.json();
      expect(
        notificationsPayload.notifications.some(
          (entry) =>
            String(entry?.module || "") === "moderation" &&
            String(entry?.title || "") === "Moderation report submitted" &&
            String(entry?.eventType || "") === "approval.requested" &&
            String(entry?.severity || "") === "action_required"
        )
      ).toBe(true);
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("keeps escalation visibility deterministic in community inbox aggregation", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `community-inbox-severity-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const reportRes = await fetch(`${baseUrl}/api/planners/community/moderation/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          targetId: "feed-item-severity-order",
          reason: "safety",
          details: "Escalation visibility ordering contract",
          updatedBy: "contract-test",
        }),
      });
      expect(reportRes.status).toBe(200);

      await sleep(20);

      const sharedPlanRes = await fetch(`${baseUrl}/api/planners/community/shared-plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          plan: { title: "Info-level update after escalation", lane: "community" },
          updatedBy: "contract-test",
        }),
      });
      expect(sharedPlanRes.status).toBe(200);

      const notificationsRes = await fetch(
        `${baseUrl}/api/planners/community/notifications?householdId=${encodeURIComponent(householdId)}`
      );
      expect(notificationsRes.status).toBe(200);
      const notificationsPayload = await notificationsRes.json();
      const notifications = Array.isArray(notificationsPayload?.notifications)
        ? notificationsPayload.notifications
        : [];

      expect(notifications.length).toBeGreaterThanOrEqual(2);
      expect(String(notifications[0]?.eventType || "")).toBe("approval.requested");
      expect(String(notifications[0]?.severity || "")).toBe("action_required");

      const escalationIndex = notifications.findIndex(
        (entry) => String(entry?.eventType || "") === "approval.requested"
      );
      const informationalIndex = notifications.findIndex(
        (entry) => String(entry?.eventType || "") === "community.invited"
      );
      expect(escalationIndex).toBeGreaterThanOrEqual(0);
      expect(informationalIndex).toBeGreaterThanOrEqual(0);
      expect(escalationIndex).toBeLessThan(informationalIndex);
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("enforces deterministic approval workflow transitions", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `community-approval-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const reportRes = await fetch(`${baseUrl}/api/planners/community/moderation/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          targetId: "feed-item-approval",
          reason: "policy",
          details: "Approval transition contract",
          updatedBy: "contract-test",
        }),
      });
      expect(reportRes.status).toBe(200);
      const reportPayload = await reportRes.json();
      const approvalId = String(
        reportPayload?.approvalRequest?.id || reportPayload?.report?.approvalRequestId || ""
      );
      expect(approvalId.length).toBeGreaterThan(0);
      expect(String(reportPayload?.approvalRequest?.workflowState || "")).toBe("pending_approval");

      const approvalsRes = await fetch(
        `${baseUrl}/api/planners/community/approvals?householdId=${encodeURIComponent(householdId)}`
      );
      expect(approvalsRes.status).toBe(200);
      const approvalsPayload = await approvalsRes.json();
      expect(approvalsPayload.ok).toBe(true);
      const seedApproval = Array.isArray(approvalsPayload?.approvals)
        ? approvalsPayload.approvals.find((entry) => String(entry?.id || "") === approvalId)
        : null;
      expect(seedApproval).toBeTruthy();
      expect(String(seedApproval?.workflowState || "")).toBe("pending_approval");
      expect(Array.isArray(seedApproval?.allowedNextStates)).toBe(true);
      expect(seedApproval.allowedNextStates.includes("active")).toBe(true);

      const transitionToActiveRes = await fetch(
        `${baseUrl}/api/planners/community/approvals/${encodeURIComponent(approvalId)}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            nextState: "active",
            reason: "Moderator accepted review",
            updatedBy: "contract-test",
          }),
        }
      );
      expect(transitionToActiveRes.status).toBe(200);
      const transitionToActivePayload = await transitionToActiveRes.json();
      expect(String(transitionToActivePayload?.approval?.workflowState || "")).toBe("active");
      expect(String(transitionToActivePayload?.report?.workflowState || "")).toBe("active");
      expect(String(transitionToActivePayload?.report?.status || "")).toBe("in_review");

      const transitionToCompletedRes = await fetch(
        `${baseUrl}/api/planners/community/approvals/${encodeURIComponent(approvalId)}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            nextState: "completed",
            reason: "Review completed",
            updatedBy: "contract-test",
          }),
        }
      );
      expect(transitionToCompletedRes.status).toBe(200);
      const transitionToCompletedPayload = await transitionToCompletedRes.json();
      expect(String(transitionToCompletedPayload?.approval?.workflowState || "")).toBe("completed");
      expect(String(transitionToCompletedPayload?.report?.workflowState || "")).toBe("completed");
      expect(String(transitionToCompletedPayload?.report?.status || "")).toBe("resolved");

      const invalidTransitionRes = await fetch(
        `${baseUrl}/api/planners/community/approvals/${encodeURIComponent(approvalId)}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            nextState: "blocked",
            reason: "Invalid move after completion",
            updatedBy: "contract-test",
          }),
        }
      );
      expect(invalidTransitionRes.status).toBe(409);
      const invalidTransitionPayload = await invalidTransitionRes.json();
      expect(String(invalidTransitionPayload?.error || "")).toBe("invalid_approval_transition");
      expect(String(invalidTransitionPayload?.fromState || "")).toBe("completed");
      expect(String(invalidTransitionPayload?.toState || "")).toBe("blocked");
      expect(Array.isArray(invalidTransitionPayload?.allowedNextStates)).toBe(true);
      expect(invalidTransitionPayload.allowedNextStates.length).toBe(0);
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("persists approval audit trail and decision notifications deterministically", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `community-approval-audit-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const reportRes = await fetch(`${baseUrl}/api/planners/community/moderation/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          targetId: "feed-item-audit",
          reason: "policy",
          details: "Approval audit trail contract",
          updatedBy: "contract-test",
        }),
      });
      expect(reportRes.status).toBe(200);
      const reportPayload = await reportRes.json();
      const approvalId = String(
        reportPayload?.approvalRequest?.id || reportPayload?.report?.approvalRequestId || ""
      );
      expect(approvalId.length).toBeGreaterThan(0);

      const transitionToActiveRes = await fetch(
        `${baseUrl}/api/planners/community/approvals/${encodeURIComponent(approvalId)}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            nextState: "active",
            reason: "Begin review",
            updatedBy: "contract-test",
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
            reason: "Finish review",
            updatedBy: "contract-test",
          }),
        }
      );
      expect(transitionToCompletedRes.status).toBe(200);

      const approvalsRes = await fetch(
        `${baseUrl}/api/planners/community/approvals?householdId=${encodeURIComponent(householdId)}`
      );
      expect(approvalsRes.status).toBe(200);
      const approvalsPayload = await approvalsRes.json();
      const approvalRow = Array.isArray(approvalsPayload?.approvals)
        ? approvalsPayload.approvals.find((entry) => String(entry?.id || "") === approvalId)
        : null;
      expect(approvalRow).toBeTruthy();
      expect(String(approvalRow?.workflowState || "")).toBe("completed");
      expect(Array.isArray(approvalRow?.auditLog)).toBe(true);
      expect((approvalRow?.auditLog || []).length).toBeGreaterThanOrEqual(3);

      const terminalAuditSteps = (approvalRow?.auditLog || [])
        .map((step) => `${String(step?.fromState || "")}->${String(step?.toState || "")}`)
        .filter(Boolean);
      expect(terminalAuditSteps).toContain("pending_approval->active");
      expect(terminalAuditSteps).toContain("active->completed");

      const notificationsRes = await fetch(
        `${baseUrl}/api/planners/community/notifications?householdId=${encodeURIComponent(householdId)}`
      );
      expect(notificationsRes.status).toBe(200);
      const notificationsPayload = await notificationsRes.json();
      const notifications = Array.isArray(notificationsPayload?.notifications)
        ? notificationsPayload.notifications
        : [];

      const requestedIndex = notifications.findIndex(
        (entry) => String(entry?.eventType || "") === "approval.requested"
      );
      const decidedIndex = notifications.findIndex(
        (entry) => String(entry?.eventType || "") === "approval.decided"
      );

      expect(requestedIndex).toBeGreaterThanOrEqual(0);
      expect(decidedIndex).toBeGreaterThanOrEqual(0);
      expect(String(notifications[requestedIndex]?.severity || "")).toBe("action_required");
      expect(String(notifications[decidedIndex]?.severity || "")).toBe("informational");
      expect(requestedIndex).toBeLessThan(decidedIndex);
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("returns a unified household today and upcoming agenda", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `household-agenda-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const seedSharedPlanRes = await fetch(`${baseUrl}/api/planners/community/shared-plans`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          plan: { title: "Saturday co-op prep", lane: "community", status: "planned" },
          updatedBy: "contract-test",
        }),
      });
      expect(seedSharedPlanRes.status).toBe(200);

      const agendaRes = await fetch(
        `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&todayLimit=12&upcomingLimit=12`
      );
      expect(agendaRes.status).toBe(200);
      const agendaPayload = await agendaRes.json();

      expect(agendaPayload.ok).toBe(true);
      expect(agendaPayload.householdId).toBe(householdId);
      expect(Array.isArray(agendaPayload.modules)).toBe(true);
      expect(Array.isArray(agendaPayload.today)).toBe(true);
      expect(Array.isArray(agendaPayload.upcoming)).toBe(true);
      expect(typeof agendaPayload.metrics).toBe("object");
      expect(Number(agendaPayload.metrics.todayCount || 0)).toBeGreaterThan(0);
      expect(Number(agendaPayload.metrics.upcomingCount || 0)).toBeGreaterThan(0);
      expect(
        agendaPayload.today.some((item) => {
          return ["alert", "notification", "feed"].includes(String(item?.sourceType || ""));
        })
      ).toBe(true);
      expect(
        agendaPayload.upcoming.some((item) => String(item?.sourceType || "") === "shared_plan")
      ).toBe(true);
      expect(
        agendaPayload.upcoming.some((item) => String(item?.title || "").toLowerCase().includes("co-op prep"))
      ).toBe(true);
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("supports household task lifecycle with dependencies recurrence and conflict checks", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `household-task-lifecycle-${randomUUID()}`;
    const now = new Date();
    const dueSoonIso = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const dueLaterIso = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();

    try {
      await waitForHealth(port, child, outputCapture);

      const taskARes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          task: {
            moduleKey: "meal",
            title: "Prep grains",
            ownerId: "member-alpha",
            dueAt: dueSoonIso,
            priority: "high",
          },
        }),
      });
      expect(taskARes.status).toBe(200);
      const taskAPayload = await taskARes.json();
      const taskAId = String(taskAPayload?.task?.id || "");
      expect(taskAId.length).toBeGreaterThan(0);
      expect(String(taskAPayload?.task?.workflowState || "")).toBe("active");

      const conflictingTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          task: {
            moduleKey: "storehouse",
            title: "Stock jars",
            ownerId: "member-alpha",
            dueAt: dueSoonIso,
          },
        }),
      });
      expect(conflictingTaskRes.status).toBe(200);
      const conflictingTaskPayload = await conflictingTaskRes.json();
      expect(Array.isArray(conflictingTaskPayload?.task?.conflictsWithTaskIds)).toBe(true);
      expect(conflictingTaskPayload.task.conflictsWithTaskIds.includes(taskAId)).toBe(true);

      const dependentTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          task: {
            moduleKey: "homestead",
            title: "Run batching window",
            ownerId: "member-beta",
            dueAt: dueLaterIso,
            dependsOn: [taskAId],
            recurrence: {
              enabled: true,
              frequency: "daily",
            },
          },
        }),
      });
      expect(dependentTaskRes.status).toBe(200);
      const dependentTaskPayload = await dependentTaskRes.json();
      const dependentTaskId = String(dependentTaskPayload?.task?.id || "");
      expect(dependentTaskId.length).toBeGreaterThan(0);

      const blockedTransitionRes = await fetch(
        `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(dependentTaskId)}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            nextState: "completed",
            reason: "Attempt before dependency",
          }),
        }
      );
      expect(blockedTransitionRes.status).toBe(409);
      const blockedTransitionPayload = await blockedTransitionRes.json();
      expect(String(blockedTransitionPayload?.error || "")).toBe("task_dependency_incomplete");
      expect(Array.isArray(blockedTransitionPayload?.blockingTaskIds)).toBe(true);
      expect(blockedTransitionPayload.blockingTaskIds.includes(taskAId)).toBe(true);

      const taskACompleteRes = await fetch(
        `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(taskAId)}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ householdId, nextState: "completed", reason: "Finished prep" }),
        }
      );
      expect(taskACompleteRes.status).toBe(200);

      const dependentCompleteRes = await fetch(
        `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(dependentTaskId)}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ householdId, nextState: "completed", reason: "Finished batch" }),
        }
      );
      expect(dependentCompleteRes.status).toBe(200);
      const dependentCompletePayload = await dependentCompleteRes.json();
      expect(String(dependentCompletePayload?.task?.workflowState || "")).toBe("completed");
      expect(dependentCompletePayload?.spawnedTask).toBeTruthy();
      expect(String(dependentCompletePayload?.spawnedTask?.workflowState || "")).toBe("active");
      expect(String(dependentCompletePayload?.spawnedTask?.sourceTaskId || "")).toBe(dependentTaskId);

      const tasksRes = await fetch(
        `${baseUrl}/api/planners/household/tasks?householdId=${encodeURIComponent(householdId)}`
      );
      expect(tasksRes.status).toBe(200);
      const tasksPayload = await tasksRes.json();
      expect(Array.isArray(tasksPayload?.tasks)).toBe(true);
      expect(tasksPayload.tasks.length).toBeGreaterThanOrEqual(3);

      const agendaRes = await fetch(
        `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&todayLimit=20&upcomingLimit=20`
      );
      expect(agendaRes.status).toBe(200);
      const agendaPayload = await agendaRes.json();
      const allAgendaItems = [
        ...(Array.isArray(agendaPayload?.today) ? agendaPayload.today : []),
        ...(Array.isArray(agendaPayload?.upcoming) ? agendaPayload.upcoming : []),
      ];
      const anyTaskAgendaItem = allAgendaItems.find((item) => String(item?.sourceType || "") === "task");
      expect(
        agendaPayload.today.some((item) => String(item?.sourceType || "") === "task") ||
          agendaPayload.upcoming.some((item) => String(item?.sourceType || "") === "task")
      ).toBe(true);
      expect(anyTaskAgendaItem).toBeTruthy();
      expect(Object.prototype.hasOwnProperty.call(anyTaskAgendaItem || {}, "recurrenceEnabled")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(anyTaskAgendaItem || {}, "hasDependencyBlock")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(anyTaskAgendaItem || {}, "hasConflict")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(anyTaskAgendaItem || {}, "ownerId")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(anyTaskAgendaItem || {}, "priority")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(anyTaskAgendaItem || {}, "workflowState")).toBe(true);
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("filters and sorts household today-upcoming agenda by person module priority and status", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `household-agenda-filters-${randomUUID()}`;
    const now = Date.now();
    const dueAnchor = new Date(now);
    dueAnchor.setUTCHours(12, 0, 0, 0);
    if (dueAnchor.getTime() <= now) {
      dueAnchor.setUTCDate(dueAnchor.getUTCDate() + 1);
    }

    const collectAgendaRows = (payload) => [
      ...(Array.isArray(payload?.today) ? payload.today : []),
      ...(Array.isArray(payload?.upcoming) ? payload.upcoming : []),
    ];

    try {
      await waitForHealth(port, child, outputCapture);

      const highTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          task: {
            moduleKey: "cleaning",
            title: "Deep clean pantry",
            ownerId: "member-alpha",
            dueAt: new Date(dueAnchor.getTime() + 90 * 60 * 1000).toISOString(),
            priority: "high",
          },
        }),
      });
      expect(highTaskRes.status).toBe(200);
      const highTaskPayload = await highTaskRes.json();
      const highTaskId = String(highTaskPayload?.task?.id || "");
      expect(highTaskId.length).toBeGreaterThan(0);

      const lowTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          task: {
            moduleKey: "cleaning",
            title: "Refill mop station",
            ownerId: "member-alpha",
            dueAt: new Date(dueAnchor.getTime() + 120 * 60 * 1000).toISOString(),
            priority: "low",
          },
        }),
      });
      expect(lowTaskRes.status).toBe(200);
      const lowTaskPayload = await lowTaskRes.json();
      const lowTaskId = String(lowTaskPayload?.task?.id || "");
      expect(lowTaskId.length).toBeGreaterThan(0);

      const normalTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          task: {
            moduleKey: "meal",
            title: "Prep soup base",
            ownerId: "member-beta",
            dueAt: new Date(dueAnchor.getTime() + 150 * 60 * 1000).toISOString(),
            priority: "normal",
          },
        }),
      });
      expect(normalTaskRes.status).toBe(200);
      const normalTaskPayload = await normalTaskRes.json();
      const normalTaskId = String(normalTaskPayload?.task?.id || "");
      expect(normalTaskId.length).toBeGreaterThan(0);

      const lowBlockedRes = await fetch(
        `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(lowTaskId)}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ householdId, nextState: "blocked", reason: "Waiting on supplies" }),
        }
      );
      expect(lowBlockedRes.status).toBe(200);

      const ownerFilteredRes = await fetch(
        `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&person=${encodeURIComponent("member-alpha")}&todayLimit=50&upcomingLimit=50`
      );
      expect(ownerFilteredRes.status).toBe(200);
      const ownerFilteredPayload = await ownerFilteredRes.json();
      const ownerRows = collectAgendaRows(ownerFilteredPayload).filter(
        (item) => String(item?.sourceType || "") === "task"
      );
      expect(ownerRows.length).toBeGreaterThan(0);
      expect(ownerRows.every((item) => String(item?.ownerId || "") === "member-alpha")).toBe(true);

      const moduleFilteredRes = await fetch(
        `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&module=cleaning&todayLimit=50&upcomingLimit=50`
      );
      expect(moduleFilteredRes.status).toBe(200);
      const moduleFilteredPayload = await moduleFilteredRes.json();
      expect(moduleFilteredPayload?.applied?.filters).toMatchObject({
        module: "cleaning",
      });
      expect(moduleFilteredPayload?.applied?.limits).toMatchObject({
        today: 50,
        upcoming: 50,
      });
      const moduleRows = collectAgendaRows(moduleFilteredPayload).filter(
        (item) => String(item?.sourceType || "") === "task"
      );
      expect(moduleRows.length).toBeGreaterThan(0);
      expect(moduleRows.every((item) => String(item?.module || item?.lane || "") === "cleaning")).toBe(true);

      const statusFilteredRes = await fetch(
        `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&status=blocked&todayLimit=50&upcomingLimit=50`
      );
      expect(statusFilteredRes.status).toBe(200);
      const statusFilteredPayload = await statusFilteredRes.json();
      const statusRows = collectAgendaRows(statusFilteredPayload).filter(
        (item) => String(item?.sourceType || "") === "task"
      );
      expect(statusRows.length).toBeGreaterThan(0);
      expect(statusRows.every((item) => String(item?.workflowState || item?.state || "") === "blocked")).toBe(true);

      const priorityFilteredRes = await fetch(
        `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&module=cleaning&priority=high&todayLimit=50&upcomingLimit=50`
      );
      expect(priorityFilteredRes.status).toBe(200);
      const priorityFilteredPayload = await priorityFilteredRes.json();
      const priorityRows = collectAgendaRows(priorityFilteredPayload).filter(
        (item) => String(item?.sourceType || "") === "task"
      );
      expect(priorityRows.length).toBeGreaterThan(0);
      expect(priorityRows.every((item) => String(item?.priority || "") === "high")).toBe(true);

      const prioritySortedRes = await fetch(
        `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&module=cleaning&sortBy=priority&sortDirection=desc&todayLimit=50&upcomingLimit=50`
      );
      expect(prioritySortedRes.status).toBe(200);
      const prioritySortedPayload = await prioritySortedRes.json();
      const priorityRowsSorted = collectAgendaRows(prioritySortedPayload).filter(
        (item) => String(item?.sourceType || "") === "task"
      );
      const highIndex = priorityRowsSorted.findIndex((item) => String(item?.id || "") === `task-${highTaskId}`);
      const lowIndex = priorityRowsSorted.findIndex((item) => String(item?.id || "") === `task-${lowTaskId}`);
      expect(highIndex).toBeGreaterThanOrEqual(0);
      expect(lowIndex).toBeGreaterThanOrEqual(0);
      expect(highIndex).toBeLessThan(lowIndex);

      const statusSortedRes = await fetch(
        `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&module=cleaning&sortBy=status&sortDirection=desc&todayLimit=50&upcomingLimit=50`
      );
      expect(statusSortedRes.status).toBe(200);
      const statusSortedPayload = await statusSortedRes.json();
      expect(statusSortedPayload?.applied).toMatchObject({
        sortBy: "status",
        sortDirection: "desc",
      });
      const statusRowsSorted = collectAgendaRows(statusSortedPayload).filter(
        (item) => String(item?.sourceType || "") === "task"
      );
      const blockedIndex = statusRowsSorted.findIndex((item) => String(item?.id || "") === `task-${lowTaskId}`);
      const activeIndex = statusRowsSorted.findIndex((item) => String(item?.id || "") === `task-${highTaskId}`);
      expect(blockedIndex).toBeGreaterThanOrEqual(0);
      expect(activeIndex).toBeGreaterThanOrEqual(0);
      expect(blockedIndex).toBeLessThan(activeIndex);

      const dueAscRes = await fetch(
        `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&module=meal&sortBy=dueAt&sortDirection=asc&todayLimit=50&upcomingLimit=50`
      );
      expect(dueAscRes.status).toBe(200);
      const dueAscPayload = await dueAscRes.json();
      const dueAscRows = collectAgendaRows(dueAscPayload).filter(
        (item) => String(item?.sourceType || "") === "task"
      );
      expect(dueAscRows.some((item) => String(item?.id || "") === `task-${normalTaskId}`)).toBe(true);
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("applies recurrence and dependency parity across household modules", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `household-parity-${randomUUID()}`;
    const moduleFixture = buildHouseholdParityFixture();

    try {
      await waitForHealth(port, child, outputCapture);

      const taskIdsByModule = new Map();

      for (const fixture of moduleFixture) {
        const baseTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            task: fixture.baseTask,
          }),
        });
        expect(baseTaskRes.status).toBe(200);
        const baseTaskPayload = await baseTaskRes.json();
        const baseTaskId = String(baseTaskPayload?.task?.id || "");
        expect(baseTaskId.length).toBeGreaterThan(0);

        const dependentTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            task: {
              ...fixture.dependentTask,
              dependsOn: [baseTaskId],
            },
          }),
        });
        expect(dependentTaskRes.status).toBe(200);
        const dependentTaskPayload = await dependentTaskRes.json();
        const dependentTaskId = String(dependentTaskPayload?.task?.id || "");
        expect(dependentTaskId.length).toBeGreaterThan(0);

        taskIdsByModule.set(fixture.moduleKey, {
          baseTaskId,
          dependentTaskId,
        });
      }

      for (const moduleKey of HOUSEHOLD_PARITY_MODULES) {
        const taskIds = taskIdsByModule.get(moduleKey);
        expect(taskIds).toBeTruthy();

        const blockedTransitionRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(taskIds.dependentTaskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "completed",
              reason: `dependency check ${moduleKey}`,
            }),
          }
        );
        expect(blockedTransitionRes.status).toBe(409);
        const blockedTransitionPayload = await blockedTransitionRes.json();
        expect(String(blockedTransitionPayload?.error || "")).toBe("task_dependency_incomplete");
        expect(Array.isArray(blockedTransitionPayload?.blockingTaskIds)).toBe(true);
        expect(blockedTransitionPayload.blockingTaskIds.includes(taskIds.baseTaskId)).toBe(true);

        const completeBaseRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(taskIds.baseTaskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ householdId, nextState: "completed", reason: `complete base ${moduleKey}` }),
          }
        );
        expect(completeBaseRes.status).toBe(200);

        const completeDependentRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(taskIds.dependentTaskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "completed",
              reason: `complete dependent ${moduleKey}`,
            }),
          }
        );
        expect(completeDependentRes.status).toBe(200);
        const completeDependentPayload = await completeDependentRes.json();
        expect(String(completeDependentPayload?.task?.workflowState || "")).toBe("completed");
        expect(completeDependentPayload?.spawnedTask).toBeTruthy();
        expect(String(completeDependentPayload?.spawnedTask?.workflowState || "")).toBe("active");
        expect(String(completeDependentPayload?.spawnedTask?.sourceTaskId || "")).toBe(taskIds.dependentTaskId);
      }

      const agendaRes = await fetch(
        `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&todayLimit=80&upcomingLimit=80`
      );
      expect(agendaRes.status).toBe(200);
      const agendaPayload = await agendaRes.json();
      const taskRows = [
        ...(Array.isArray(agendaPayload?.today) ? agendaPayload.today : []),
        ...(Array.isArray(agendaPayload?.upcoming) ? agendaPayload.upcoming : []),
      ].filter((item) => String(item?.sourceType || "") === "task");

      expect(taskRows.length).toBeGreaterThan(0);
      for (const moduleKey of HOUSEHOLD_PARITY_MODULES) {
        const moduleRows = taskRows.filter(
          (item) => String(item?.module || item?.lane || item?.moduleKey || "") === moduleKey
        );
        expect(moduleRows.length).toBeGreaterThan(0);
      }

      expect(taskRows.some((item) => item?.recurrenceEnabled === true)).toBe(true);
      expect(taskRows.every((item) => Object.prototype.hasOwnProperty.call(item || {}, "hasDependencyBlock"))).toBe(
        true
      );
      expect(taskRows.every((item) => Object.prototype.hasOwnProperty.call(item || {}, "workflowState"))).toBe(true);
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("keeps blocked-to-active transition parity across household modules", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `household-blocked-active-parity-${randomUUID()}`;
    const now = Date.now();
    const dueAnchor = new Date(now);
    dueAnchor.setUTCHours(12, 0, 0, 0);
    if (dueAnchor.getTime() <= now) {
      dueAnchor.setUTCDate(dueAnchor.getUTCDate() + 1);
    }

    try {
      await waitForHealth(port, child, outputCapture);

      const transitionSnapshotByModule = new Map();

      for (const [index, moduleKey] of HOUSEHOLD_PARITY_MODULES.entries()) {
        const taskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            task: {
              moduleKey,
              title: `Blocked-active parity ${moduleKey}`,
              ownerId: `member-blocked-${moduleKey}`,
              dueAt: new Date(dueAnchor.getTime() + (index + 1) * 35 * 60 * 1000).toISOString(),
              priority: "normal",
            },
          }),
        });
        expect(taskRes.status).toBe(200);
        const taskPayload = await taskRes.json();
        const taskId = String(taskPayload?.task?.id || "");
        expect(taskId.length).toBeGreaterThan(0);

        const blockRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(taskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "blocked",
              reason: `blocked state parity ${moduleKey}`,
            }),
          }
        );
        expect(blockRes.status).toBe(200);
        const blockPayload = await blockRes.json();
        expect(String(blockPayload?.task?.workflowState || "")).toBe("blocked");

        const activateRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(taskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "active",
              reason: `active state parity ${moduleKey}`,
            }),
          }
        );
        expect(activateRes.status).toBe(200);
        const activatePayload = await activateRes.json();
        expect(String(activatePayload?.task?.workflowState || "")).toBe("active");

        transitionSnapshotByModule.set(moduleKey, {
          postBlockState: String(blockPayload?.task?.workflowState || ""),
          postActiveState: String(activatePayload?.task?.workflowState || ""),
          moduleKey: String(activatePayload?.task?.moduleKey || ""),
          priority: String(activatePayload?.task?.priority || ""),
          hasCompletedAt: Boolean(activatePayload?.task?.completedAt),
          hasArchivedAt: Boolean(activatePayload?.task?.archivedAt),
        });
      }

      const baseline = transitionSnapshotByModule.get(HOUSEHOLD_PARITY_MODULES[0]);
      expect(baseline).toBeTruthy();
      for (const moduleKey of HOUSEHOLD_PARITY_MODULES.slice(1)) {
        const snapshot = transitionSnapshotByModule.get(moduleKey);
        expect(snapshot).toBeTruthy();
        expect(snapshot.postBlockState).toBe(baseline.postBlockState);
        expect(snapshot.postActiveState).toBe(baseline.postActiveState);
        expect(snapshot.priority).toBe(baseline.priority);
        expect(snapshot.hasCompletedAt).toBe(baseline.hasCompletedAt);
        expect(snapshot.hasArchivedAt).toBe(baseline.hasArchivedAt);
      }
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("keeps dependency unblock transition parity from blocked state across household modules", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `household-dependency-unblock-parity-${randomUUID()}`;
    const now = Date.now();
    const dueAnchor = new Date(now);
    dueAnchor.setUTCHours(12, 0, 0, 0);
    if (dueAnchor.getTime() <= now) {
      dueAnchor.setUTCDate(dueAnchor.getUTCDate() + 1);
    }

    try {
      await waitForHealth(port, child, outputCapture);

      const snapshotByModule = new Map();

      for (const [index, moduleKey] of HOUSEHOLD_PARITY_MODULES.entries()) {
        const baseTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            task: {
              moduleKey,
              title: `Dependency base ${moduleKey}`,
              ownerId: `member-dependency-${moduleKey}`,
              dueAt: new Date(dueAnchor.getTime() + (index + 1) * 40 * 60 * 1000).toISOString(),
              priority: "normal",
            },
          }),
        });
        expect(baseTaskRes.status).toBe(200);
        const baseTaskPayload = await baseTaskRes.json();
        const baseTaskId = String(baseTaskPayload?.task?.id || "");
        expect(baseTaskId.length).toBeGreaterThan(0);

        const dependentTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            task: {
              moduleKey,
              title: `Dependency child ${moduleKey}`,
              ownerId: `member-dependency-${moduleKey}`,
              dueAt: new Date(dueAnchor.getTime() + (index + 1) * 55 * 60 * 1000).toISOString(),
              priority: "normal",
              dependsOn: [baseTaskId],
            },
          }),
        });
        expect(dependentTaskRes.status).toBe(200);
        const dependentTaskPayload = await dependentTaskRes.json();
        const dependentTaskId = String(dependentTaskPayload?.task?.id || "");
        expect(dependentTaskId.length).toBeGreaterThan(0);

        const blockDependentRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(dependentTaskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "blocked",
              reason: `dependency blocked parity ${moduleKey}`,
            }),
          }
        );
        expect(blockDependentRes.status).toBe(200);
        const blockDependentPayload = await blockDependentRes.json();
        expect(String(blockDependentPayload?.task?.workflowState || "")).toBe("blocked");

        const completeBlockedDependentRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(dependentTaskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "completed",
              reason: `dependency completion guard parity ${moduleKey}`,
            }),
          }
        );
        expect(completeBlockedDependentRes.status).toBe(409);
        const completeBlockedDependentPayload = await completeBlockedDependentRes.json();
        expect(String(completeBlockedDependentPayload?.error || "")).toBe("invalid_task_transition");
        expect(String(completeBlockedDependentPayload?.fromState || "")).toBe("blocked");
        expect(String(completeBlockedDependentPayload?.toState || "")).toBe("completed");
        expect(Array.isArray(completeBlockedDependentPayload?.allowedNextStates)).toBe(true);
        expect(completeBlockedDependentPayload.allowedNextStates.includes("active")).toBe(true);

        const activateDependentRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(dependentTaskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "active",
              reason: `dependency active parity ${moduleKey}`,
            }),
          }
        );
        expect(activateDependentRes.status).toBe(200);
        const activateDependentPayload = await activateDependentRes.json();
        expect(String(activateDependentPayload?.task?.workflowState || "")).toBe("active");

        const completeActiveDependentRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(dependentTaskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "completed",
              reason: `dependency guard parity ${moduleKey}`,
            }),
          }
        );
        expect(completeActiveDependentRes.status).toBe(409);
        const completeActiveDependentPayload = await completeActiveDependentRes.json();
        expect(String(completeActiveDependentPayload?.error || "")).toBe("task_dependency_incomplete");
        expect(Array.isArray(completeActiveDependentPayload?.blockingTaskIds)).toBe(true);
        expect(completeActiveDependentPayload.blockingTaskIds.includes(baseTaskId)).toBe(true);

        const completeBaseRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(baseTaskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "completed",
              reason: `dependency base complete ${moduleKey}`,
            }),
          }
        );
        expect(completeBaseRes.status).toBe(200);

        const completeDependentRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(dependentTaskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "completed",
              reason: `dependency dependent complete ${moduleKey}`,
            }),
          }
        );
        expect(completeDependentRes.status).toBe(200);
        const completeDependentPayload = await completeDependentRes.json();
        expect(String(completeDependentPayload?.task?.workflowState || "")).toBe("completed");

        snapshotByModule.set(moduleKey, {
          blockedState: String(blockDependentPayload?.task?.workflowState || ""),
          blockedCompletionError: String(completeBlockedDependentPayload?.error || ""),
          activatedState: String(activateDependentPayload?.task?.workflowState || ""),
          dependencyGuardError: String(completeActiveDependentPayload?.error || ""),
          completedState: String(completeDependentPayload?.task?.workflowState || ""),
        });
      }

      const baseline = snapshotByModule.get(HOUSEHOLD_PARITY_MODULES[0]);
      expect(baseline).toBeTruthy();
      for (const moduleKey of HOUSEHOLD_PARITY_MODULES.slice(1)) {
        const snapshot = snapshotByModule.get(moduleKey);
        expect(snapshot).toBeTruthy();
        expect(snapshot).toEqual(baseline);
      }
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("keeps owner-overlap conflict detection parity across household modules", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `household-conflict-parity-${randomUUID()}`;
    const now = Date.now();
    const dueAnchor = new Date(now);
    dueAnchor.setUTCHours(12, 0, 0, 0);
    if (dueAnchor.getTime() <= now) {
      dueAnchor.setUTCDate(dueAnchor.getUTCDate() + 1);
    }

    try {
      await waitForHealth(port, child, outputCapture);

      const conflictSnapshotByModule = new Map();

      for (const [index, moduleKey] of HOUSEHOLD_PARITY_MODULES.entries()) {
        const ownerId = `member-conflict-${moduleKey}`;
        const baseDueAt = new Date(dueAnchor.getTime() + (index + 1) * 50 * 60 * 1000).toISOString();
        const overlapDueAt = new Date(dueAnchor.getTime() + (index + 1) * 55 * 60 * 1000).toISOString();

        const baseTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            task: {
              moduleKey,
              title: `Conflict base ${moduleKey}`,
              ownerId,
              dueAt: baseDueAt,
              priority: "normal",
            },
          }),
        });
        expect(baseTaskRes.status).toBe(200);
        const baseTaskPayload = await baseTaskRes.json();
        const baseTaskId = String(baseTaskPayload?.task?.id || "");
        expect(baseTaskId.length).toBeGreaterThan(0);

        const overlapTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            task: {
              moduleKey,
              title: `Conflict overlap ${moduleKey}`,
              ownerId,
              dueAt: overlapDueAt,
              priority: "normal",
            },
          }),
        });
        expect(overlapTaskRes.status).toBe(200);
        const overlapTaskPayload = await overlapTaskRes.json();
        const overlapTaskId = String(overlapTaskPayload?.task?.id || "");
        expect(overlapTaskId.length).toBeGreaterThan(0);
        expect(Array.isArray(overlapTaskPayload?.task?.conflictsWithTaskIds)).toBe(true);
        expect(overlapTaskPayload.task.conflictsWithTaskIds.includes(baseTaskId)).toBe(true);

        const agendaRes = await fetch(
          `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&module=${encodeURIComponent(moduleKey)}&person=${encodeURIComponent(ownerId)}&todayLimit=50&upcomingLimit=50`
        );
        expect(agendaRes.status).toBe(200);
        const agendaPayload = await agendaRes.json();
        const moduleRows = [
          ...(Array.isArray(agendaPayload?.today) ? agendaPayload.today : []),
          ...(Array.isArray(agendaPayload?.upcoming) ? agendaPayload.upcoming : []),
        ].filter((item) => String(item?.sourceType || "") === "task");

        expect(moduleRows.length).toBeGreaterThanOrEqual(2);
        const overlapAgendaRow = moduleRows.find((item) => String(item?.id || "") === `task-${overlapTaskId}`);
        expect(overlapAgendaRow).toBeTruthy();
        expect(Boolean(overlapAgendaRow?.hasConflict)).toBe(true);

        conflictSnapshotByModule.set(moduleKey, {
          overlapConflictCount: Number(overlapTaskPayload?.task?.conflictsWithTaskIds?.length || 0),
          agendaConflictFlag: Boolean(overlapAgendaRow?.hasConflict),
        });
      }

      const baseline = conflictSnapshotByModule.get(HOUSEHOLD_PARITY_MODULES[0]);
      expect(baseline).toBeTruthy();
      for (const moduleKey of HOUSEHOLD_PARITY_MODULES.slice(1)) {
        const snapshot = conflictSnapshotByModule.get(moduleKey);
        expect(snapshot).toBeTruthy();
        expect(snapshot).toEqual(baseline);
      }
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("keeps lifecycle transition parity across household modules", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `household-lifecycle-parity-${randomUUID()}`;
    const now = Date.now();
    const dueAnchor = new Date(now);
    dueAnchor.setUTCHours(12, 0, 0, 0);
    if (dueAnchor.getTime() <= now) {
      dueAnchor.setUTCDate(dueAnchor.getUTCDate() + 1);
    }

    try {
      await waitForHealth(port, child, outputCapture);

      const lifecycleSnapshotByModule = new Map();

      for (const [index, moduleKey] of HOUSEHOLD_PARITY_MODULES.entries()) {
        const createRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            task: {
              moduleKey,
              title: `Lifecycle parity ${moduleKey}`,
              ownerId: `member-lifecycle-${moduleKey}`,
              dueAt: new Date(dueAnchor.getTime() + (index + 1) * 30 * 60 * 1000).toISOString(),
              priority: "normal",
            },
          }),
        });
        expect(createRes.status).toBe(200);
        const createPayload = await createRes.json();
        const taskId = String(createPayload?.task?.id || "");
        expect(taskId.length).toBeGreaterThan(0);
        expect(String(createPayload?.task?.workflowState || "")).toBe("active");
        expect(Array.isArray(createPayload?.task?.allowedNextStates)).toBe(true);
        expect(createPayload.task.allowedNextStates.includes("completed")).toBe(true);
        expect(createPayload.task.allowedNextStates.includes("blocked")).toBe(true);

        const blockRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(taskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "blocked",
              reason: `lifecycle blocked ${moduleKey}`,
            }),
          }
        );
        expect(blockRes.status).toBe(200);
        const blockPayload = await blockRes.json();
        expect(String(blockPayload?.task?.workflowState || "")).toBe("blocked");
        expect(Array.isArray(blockPayload?.task?.allowedNextStates)).toBe(true);
        expect(blockPayload.task.allowedNextStates.includes("active")).toBe(true);

        const activeRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(taskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "active",
              reason: `lifecycle active ${moduleKey}`,
            }),
          }
        );
        expect(activeRes.status).toBe(200);
        const activePayload = await activeRes.json();
        expect(String(activePayload?.task?.workflowState || "")).toBe("active");

        const completeRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(taskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "completed",
              reason: `lifecycle completed ${moduleKey}`,
            }),
          }
        );
        expect(completeRes.status).toBe(200);
        const completePayload = await completeRes.json();
        expect(String(completePayload?.task?.workflowState || "")).toBe("completed");
        expect(Boolean(completePayload?.task?.completedAt)).toBe(true);
        expect(Array.isArray(completePayload?.task?.allowedNextStates)).toBe(true);
        expect(completePayload.task.allowedNextStates.includes("archived")).toBe(true);

        const archiveRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(taskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "archived",
              reason: `lifecycle archived ${moduleKey}`,
            }),
          }
        );
        expect(archiveRes.status).toBe(200);
        const archivePayload = await archiveRes.json();
        expect(String(archivePayload?.task?.workflowState || "")).toBe("archived");
        expect(Boolean(archivePayload?.task?.archivedAt)).toBe(true);
        expect(Array.isArray(archivePayload?.task?.allowedNextStates)).toBe(true);
        expect(archivePayload.task.allowedNextStates.length).toBe(0);

        lifecycleSnapshotByModule.set(moduleKey, {
          createdState: String(createPayload?.task?.workflowState || ""),
          blockedState: String(blockPayload?.task?.workflowState || ""),
          activeState: String(activePayload?.task?.workflowState || ""),
          completedState: String(completePayload?.task?.workflowState || ""),
          archivedState: String(archivePayload?.task?.workflowState || ""),
          completedHasTimestamp: Boolean(completePayload?.task?.completedAt),
          archivedHasTimestamp: Boolean(archivePayload?.task?.archivedAt),
          archivedNextStatesCount: Number(archivePayload?.task?.allowedNextStates?.length || 0),
        });
      }

      const baseline = lifecycleSnapshotByModule.get(HOUSEHOLD_PARITY_MODULES[0]);
      expect(baseline).toBeTruthy();
      for (const moduleKey of HOUSEHOLD_PARITY_MODULES.slice(1)) {
        const snapshot = lifecycleSnapshotByModule.get(moduleKey);
        expect(snapshot).toBeTruthy();
        expect(snapshot).toEqual(baseline);
      }
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("keeps weekly recurrence spawn parity across household modules", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `household-weekly-recurrence-${randomUUID()}`;
    const now = Date.now();
    const dueAnchor = new Date(now);
    dueAnchor.setUTCHours(12, 0, 0, 0);
    if (dueAnchor.getTime() <= now) {
      dueAnchor.setUTCDate(dueAnchor.getUTCDate() + 1);
    }

    try {
      await waitForHealth(port, child, outputCapture);

      const recurrenceShapeByModule = new Map();

      for (const [index, moduleKey] of HOUSEHOLD_PARITY_MODULES.entries()) {
        const dueAtIso = new Date(dueAnchor.getTime() + (index + 1) * 60 * 60 * 1000).toISOString();

        const taskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            task: {
              moduleKey,
              title: `Weekly parity ${moduleKey}`,
              ownerId: `member-weekly-${moduleKey}`,
              dueAt: dueAtIso,
              priority: "normal",
              recurrence: {
                enabled: true,
                frequency: "weekly",
              },
            },
          }),
        });
        expect(taskRes.status).toBe(200);
        const taskPayload = await taskRes.json();
        const taskId = String(taskPayload?.task?.id || "");
        expect(taskId.length).toBeGreaterThan(0);

        const completeRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(taskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "completed",
              reason: `weekly recurrence parity ${moduleKey}`,
            }),
          }
        );
        expect(completeRes.status).toBe(200);
        const completePayload = await completeRes.json();
        const spawnedTask = completePayload?.spawnedTask;
        expect(spawnedTask).toBeTruthy();
        expect(String(spawnedTask?.moduleKey || "")).toBe(moduleKey);
        expect(String(spawnedTask?.sourceTaskId || "")).toBe(taskId);
        expect(Boolean(spawnedTask?.recurrence?.enabled)).toBe(true);
        expect(String(spawnedTask?.recurrence?.frequency || "")).toBe("weekly");
        expect(Number(spawnedTask?.recurrence?.intervalDays || 0)).toBe(7);

        const originalDueAt = Date.parse(dueAtIso);
        const spawnedDueAt = Date.parse(String(spawnedTask?.dueAt || ""));
        expect(Number.isFinite(originalDueAt)).toBe(true);
        expect(Number.isFinite(spawnedDueAt)).toBe(true);
        const dueDeltaDays = (spawnedDueAt - originalDueAt) / (24 * 60 * 60 * 1000);
        expect(dueDeltaDays).toBeGreaterThanOrEqual(6.95);
        expect(dueDeltaDays).toBeLessThanOrEqual(7.05);

        recurrenceShapeByModule.set(moduleKey, {
          recurrence: {
            enabled: Boolean(spawnedTask?.recurrence?.enabled),
            frequency: String(spawnedTask?.recurrence?.frequency || ""),
            intervalDays: Number(spawnedTask?.recurrence?.intervalDays || 0),
          },
          dueDeltaDays: Number(dueDeltaDays.toFixed(2)),
        });
      }

      const baseline = recurrenceShapeByModule.get(HOUSEHOLD_PARITY_MODULES[0]);
      expect(baseline).toBeTruthy();
      for (const moduleKey of HOUSEHOLD_PARITY_MODULES.slice(1)) {
        const snapshot = recurrenceShapeByModule.get(moduleKey);
        expect(snapshot).toBeTruthy();
        expect(snapshot.recurrence).toEqual(baseline.recurrence);
        expect(snapshot.dueDeltaDays).toBe(baseline.dueDeltaDays);
      }
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("keeps custom recurrence spawn parity across household modules", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `household-custom-recurrence-${randomUUID()}`;
    const now = Date.now();
    const dueAnchor = new Date(now);
    dueAnchor.setUTCHours(12, 0, 0, 0);
    if (dueAnchor.getTime() <= now) {
      dueAnchor.setUTCDate(dueAnchor.getUTCDate() + 1);
    }

    try {
      await waitForHealth(port, child, outputCapture);

      const recurrenceShapeByModule = new Map();

      for (const [index, moduleKey] of HOUSEHOLD_PARITY_MODULES.entries()) {
        const dueAtIso = new Date(dueAnchor.getTime() + (index + 1) * 50 * 60 * 1000).toISOString();

        const taskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            task: {
              moduleKey,
              title: `Custom parity ${moduleKey}`,
              ownerId: `member-custom-${moduleKey}`,
              dueAt: dueAtIso,
              priority: "normal",
              recurrence: {
                enabled: true,
                frequency: "custom",
                intervalDays: 3,
              },
            },
          }),
        });
        expect(taskRes.status).toBe(200);
        const taskPayload = await taskRes.json();
        const taskId = String(taskPayload?.task?.id || "");
        expect(taskId.length).toBeGreaterThan(0);

        const completeRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(taskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "completed",
              reason: `custom recurrence parity ${moduleKey}`,
            }),
          }
        );
        expect(completeRes.status).toBe(200);
        const completePayload = await completeRes.json();
        const spawnedTask = completePayload?.spawnedTask;
        expect(spawnedTask).toBeTruthy();
        expect(String(spawnedTask?.moduleKey || "")).toBe(moduleKey);
        expect(String(spawnedTask?.sourceTaskId || "")).toBe(taskId);
        expect(Boolean(spawnedTask?.recurrence?.enabled)).toBe(true);
        expect(String(spawnedTask?.recurrence?.frequency || "")).toBe("custom");
        expect(Number(spawnedTask?.recurrence?.intervalDays || 0)).toBe(3);

        const originalDueAt = Date.parse(dueAtIso);
        const spawnedDueAt = Date.parse(String(spawnedTask?.dueAt || ""));
        expect(Number.isFinite(originalDueAt)).toBe(true);
        expect(Number.isFinite(spawnedDueAt)).toBe(true);
        const dueDeltaDays = (spawnedDueAt - originalDueAt) / (24 * 60 * 60 * 1000);
        expect(dueDeltaDays).toBeGreaterThanOrEqual(2.95);
        expect(dueDeltaDays).toBeLessThanOrEqual(3.05);

        recurrenceShapeByModule.set(moduleKey, {
          recurrence: {
            enabled: Boolean(spawnedTask?.recurrence?.enabled),
            frequency: String(spawnedTask?.recurrence?.frequency || ""),
            intervalDays: Number(spawnedTask?.recurrence?.intervalDays || 0),
          },
          dueDeltaDays: Number(dueDeltaDays.toFixed(2)),
        });
      }

      const baseline = recurrenceShapeByModule.get(HOUSEHOLD_PARITY_MODULES[0]);
      expect(baseline).toBeTruthy();
      for (const moduleKey of HOUSEHOLD_PARITY_MODULES.slice(1)) {
        const snapshot = recurrenceShapeByModule.get(moduleKey);
        expect(snapshot).toBeTruthy();
        expect(snapshot.recurrence).toEqual(baseline.recurrence);
        expect(snapshot.dueDeltaDays).toBe(baseline.dueDeltaDays);
      }
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("keeps today-upcoming comparator parity across module filter permutations", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `household-parity-comparator-${randomUUID()}`;
    const now = Date.now();
    const dueAnchor = new Date(now);
    dueAnchor.setUTCHours(12, 0, 0, 0);
    if (dueAnchor.getTime() <= now) {
      dueAnchor.setUTCDate(dueAnchor.getUTCDate() + 1);
    }

    const collectTaskRows = (payload) =>
      [
        ...(Array.isArray(payload?.today) ? payload.today : []),
        ...(Array.isArray(payload?.upcoming) ? payload.upcoming : []),
      ].filter((item) => String(item?.sourceType || "") === "task");

    const assertAscendingDueAt = (rows) => {
      for (let index = 1; index < rows.length; index += 1) {
        const prev = Date.parse(String(rows[index - 1]?.dueAt || ""));
        const next = Date.parse(String(rows[index]?.dueAt || ""));
        expect(Number.isFinite(prev)).toBe(true);
        expect(Number.isFinite(next)).toBe(true);
        expect(prev).toBeLessThanOrEqual(next);
      }
    };

    try {
      await waitForHealth(port, child, outputCapture);

      const moduleSnapshots = new Map();

      for (const [moduleIndex, fixture] of buildHouseholdParityFixture(now).entries()) {
        const highTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            task: {
              moduleKey: fixture.moduleKey,
              title: `Comparator high ${fixture.moduleKey}`,
              ownerId: fixture.ownerId,
              dueAt: new Date(dueAnchor.getTime() + (moduleIndex * 300 + 90) * 60 * 1000).toISOString(),
              priority: "high",
            },
          }),
        });
        expect(highTaskRes.status).toBe(200);
        const highTaskPayload = await highTaskRes.json();
        const highTaskId = String(highTaskPayload?.task?.id || "");
        expect(highTaskId.length).toBeGreaterThan(0);

        const normalTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            task: {
              moduleKey: fixture.moduleKey,
              title: `Comparator normal ${fixture.moduleKey}`,
              ownerId: fixture.ownerId,
              dueAt: new Date(dueAnchor.getTime() + (moduleIndex * 300 + 120) * 60 * 1000).toISOString(),
              priority: "normal",
            },
          }),
        });
        expect(normalTaskRes.status).toBe(200);
        const normalTaskPayload = await normalTaskRes.json();
        const normalTaskId = String(normalTaskPayload?.task?.id || "");
        expect(normalTaskId.length).toBeGreaterThan(0);

        const lowTaskRes = await fetch(`${baseUrl}/api/planners/household/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            task: {
              moduleKey: fixture.moduleKey,
              title: `Comparator blocked ${fixture.moduleKey}`,
              ownerId: fixture.ownerId,
              dueAt: new Date(dueAnchor.getTime() + (moduleIndex * 300 + 150) * 60 * 1000).toISOString(),
              priority: "low",
            },
          }),
        });
        expect(lowTaskRes.status).toBe(200);
        const lowTaskPayload = await lowTaskRes.json();
        const lowTaskId = String(lowTaskPayload?.task?.id || "");
        expect(lowTaskId.length).toBeGreaterThan(0);

        const lowBlockedRes = await fetch(
          `${baseUrl}/api/planners/household/tasks/${encodeURIComponent(lowTaskId)}/transition`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              householdId,
              nextState: "blocked",
              reason: `Comparator blocked ${fixture.moduleKey}`,
            }),
          }
        );
        expect(lowBlockedRes.status).toBe(200);

        const priorityRes = await fetch(
          `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&module=${encodeURIComponent(fixture.moduleKey)}&sortBy=priority&sortDirection=desc&todayLimit=80&upcomingLimit=80`
        );
        expect(priorityRes.status).toBe(200);
        const priorityPayload = await priorityRes.json();
        const priorityRows = collectTaskRows(priorityPayload);
        expect(priorityRows.length).toBeGreaterThanOrEqual(3);
        expect(priorityRows.every((item) => String(item?.module || item?.lane || "") === fixture.moduleKey)).toBe(
          true
        );
        expect(String(priorityRows[0]?.priority || "")).toBe("high");

        const statusRes = await fetch(
          `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&module=${encodeURIComponent(fixture.moduleKey)}&sortBy=status&sortDirection=desc&todayLimit=80&upcomingLimit=80`
        );
        expect(statusRes.status).toBe(200);
        const statusPayload = await statusRes.json();
        const statusRows = collectTaskRows(statusPayload);
        expect(statusRows.length).toBeGreaterThanOrEqual(3);
        const statusPattern = statusRows
          .slice(0, 3)
          .map((item) => String(item?.workflowState || item?.state || ""));
        expect(statusPattern).toContain("blocked");

        const blockedRes = await fetch(
          `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&module=${encodeURIComponent(fixture.moduleKey)}&status=blocked&todayLimit=80&upcomingLimit=80`
        );
        expect(blockedRes.status).toBe(200);
        const blockedPayload = await blockedRes.json();
        const blockedRows = collectTaskRows(blockedPayload);
        expect(blockedRows.length).toBe(1);
        expect(String(blockedRows[0]?.workflowState || blockedRows[0]?.state || "")).toBe("blocked");

        const ownerRes = await fetch(
          `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&module=${encodeURIComponent(fixture.moduleKey)}&person=${encodeURIComponent(fixture.ownerId)}&sortBy=dueAt&sortDirection=asc&todayLimit=80&upcomingLimit=80`
        );
        expect(ownerRes.status).toBe(200);
        const ownerPayload = await ownerRes.json();
        const ownerRows = collectTaskRows(ownerPayload);
        expect(ownerRows.length).toBeGreaterThanOrEqual(3);
        expect(ownerRows.every((item) => String(item?.ownerId || "") === fixture.ownerId)).toBe(true);
        assertAscendingDueAt(ownerRows);

        moduleSnapshots.set(fixture.moduleKey, {
          priorityPattern: priorityRows.slice(0, 3).map((item) => String(item?.priority || "")),
          statusPattern: statusRows
            .slice(0, 3)
            .map((item) => String(item?.workflowState || item?.state || "")),
          blockedCount: blockedRows.length,
          ownerCount: ownerRows.length,
          ownerDueAtPattern: ownerRows.slice(0, 3).map((item) => String(item?.dueAt || "")),
          flagsShape: ownerRows.slice(0, 3).map((item) => ({
            recurrenceEnabled: Object.prototype.hasOwnProperty.call(item || {}, "recurrenceEnabled"),
            hasDependencyBlock: Object.prototype.hasOwnProperty.call(item || {}, "hasDependencyBlock"),
            hasConflict: Object.prototype.hasOwnProperty.call(item || {}, "hasConflict"),
            workflowState: Object.prototype.hasOwnProperty.call(item || {}, "workflowState"),
          })),
        });

        expect(priorityRows.some((item) => String(item?.id || "") === `task-${highTaskId}`)).toBe(true);
        expect(priorityRows.some((item) => String(item?.id || "") === `task-${normalTaskId}`)).toBe(true);
        expect(priorityRows.some((item) => String(item?.id || "") === `task-${lowTaskId}`)).toBe(true);
      }

      const baselineModuleKey = HOUSEHOLD_PARITY_MODULES[0];
      const baseline = moduleSnapshots.get(baselineModuleKey);
      expect(baseline).toBeTruthy();

      for (const moduleKey of HOUSEHOLD_PARITY_MODULES.slice(1)) {
        const snapshot = moduleSnapshots.get(moduleKey);
        expect(snapshot).toBeTruthy();
        expect(snapshot.priorityPattern).toEqual(baseline.priorityPattern);
        expect(snapshot.statusPattern).toEqual(baseline.statusPattern);
        expect(snapshot.blockedCount).toBe(baseline.blockedCount);
        expect(snapshot.ownerCount).toBe(baseline.ownerCount);
        expect(snapshot.ownerDueAtPattern.length).toBe(baseline.ownerDueAtPattern.length);
        expect(snapshot.flagsShape).toEqual(baseline.flagsShape);
      }
    } finally {
      await stopServer(child);
    }
  }, 60000);

  it("supports semantic workflow actions beyond basic reactions", async () => {
    const { child, port, outputCapture } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;
    const householdId = `unified-semantic-${randomUUID()}`;

    try {
      await waitForHealth(port, child, outputCapture);

      const feedRes = await fetch(
        `${baseUrl}/api/planners/feed/unified?householdId=${encodeURIComponent(householdId)}&modules=community&limit=10`
      );
      expect(feedRes.status).toBe(200);
      const feedPayload = await feedRes.json();
      const target = Array.isArray(feedPayload?.items)
        ? feedPayload.items.find((item) => String(item?.sourceModule || "") === "community")
        : null;
      expect(target).toBeTruthy();

      const sourceId = String(target?.sourceId || "");
      const handoffRes = await fetch(
        `${baseUrl}/api/planners/feed/unified/community/${encodeURIComponent(sourceId)}/semantic-action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            actionType: "handoff",
            detail: "Handoff requested by contract suite",
            metadata: { lane: "community" },
            updatedBy: "contract-test",
          }),
        }
      );
      expect(handoffRes.status).toBe(200);
      const handoffPayload = await handoffRes.json();
      expect(handoffPayload.ok).toBe(true);
      expect(Number(handoffPayload?.updatedItem?.stats?.semanticActions?.handoff || 0)).toBe(1);
      expect(String(handoffPayload?.event?.mutationType || "")).toBe("semantic_action");
      expect(String(handoffPayload?.event?.sourceModule || "")).toBe("community");
      expect(String(handoffPayload?.event?.sourceId || "")).toBe(sourceId);
      expect(String(handoffPayload?.event?.action || "")).toBe("handoff");

      const requestHelpRes = await fetch(
        `${baseUrl}/api/planners/feed/unified/community/${encodeURIComponent(sourceId)}/semantic-action`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            householdId,
            actionType: "request_help",
            detail: "Need support for feed moderation",
            metadata: { urgency: "high" },
            updatedBy: "contract-test",
          }),
        }
      );
      expect(requestHelpRes.status).toBe(200);
      const requestHelpPayload = await requestHelpRes.json();
      expect(Number(requestHelpPayload?.updatedItem?.stats?.semanticActions?.request_help || 0)).toBe(1);

      const refreshRes = await fetch(
        `${baseUrl}/api/planners/feed/unified?householdId=${encodeURIComponent(householdId)}&modules=community&limit=10`
      );
      expect(refreshRes.status).toBe(200);
      const refreshPayload = await refreshRes.json();
      const refreshedTarget = Array.isArray(refreshPayload?.items)
        ? refreshPayload.items.find((item) => String(item?.sourceId || "") === sourceId)
        : null;

      expect(Number(refreshedTarget?.stats?.semanticActions?.handoff || 0)).toBeGreaterThanOrEqual(1);
      expect(Number(refreshedTarget?.stats?.semanticActions?.request_help || 0)).toBeGreaterThanOrEqual(1);
    } finally {
      await stopServer(child);
    }
  }, 60000);
});
