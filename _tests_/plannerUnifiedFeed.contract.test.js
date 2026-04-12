import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

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
            dueAt: new Date(now + 90 * 60 * 1000).toISOString(),
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
            dueAt: new Date(now + 120 * 60 * 1000).toISOString(),
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
            dueAt: new Date(now + 150 * 60 * 1000).toISOString(),
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
