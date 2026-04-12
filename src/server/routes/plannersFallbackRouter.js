"use strict";

const express = require("express");
const { authenticateRequest } = require("../middleware/realtime/authenticateRequest.js");
const {
  requireHouseholdAccessPolicy,
  requireCollaborationPolicy,
  requireEntitlementPolicy,
  requirePlannerAdminRole,
} = require("../middleware/accessPolicy.js");

const router = express.Router();

const mealContextByHousehold = new Map();
const homesteadFeedByHousehold = new Map();

function getHouseholdId(req) {
  return String(req?.query?.householdId || req?.body?.householdId || "default-household");
}

function getMealContext(householdId) {
  if (!mealContextByHousehold.has(householdId)) {
    mealContextByHousehold.set(householdId, {
      feed: [
        {
          id: "meal-feed-1",
          author: "Meal Planner",
          content: "Contract fallback feed entry.",
          likes: 0,
          comments: 0,
          shares: 0,
          actionLog: [],
          updatedBy: null,
        },
      ],
    });
  }
  return mealContextByHousehold.get(householdId);
}

function getHomesteadFeed(householdId) {
  if (!homesteadFeedByHousehold.has(householdId)) {
    homesteadFeedByHousehold.set(householdId, []);
  }
  return homesteadFeedByHousehold.get(householdId);
}

router.use(authenticateRequest);
router.use(requireHouseholdAccessPolicy());
router.use(requireCollaborationPolicy({ moduleKey: "planners" }));
router.use(requireEntitlementPolicy({ feature: "planner.base" }));

router.get("/meal", (req, res) => {
  return res.json({ ok: true, snapshot: null, meals: [], preservationTasks: [] });
});

router.get("/meal/context", (req, res) => {
  const householdId = getHouseholdId(req);
  return res.json({ ok: true, householdId, ...getMealContext(householdId) });
});

router.post("/meal/context/feed/:id/action", express.json(), (req, res) => {
  const householdId = getHouseholdId(req);
  const action = String(req?.body?.action || "").toLowerCase();
  const postId = String(req?.params?.id || "").trim();
  const actionToKey = { like: "likes", comment: "comments", share: "shares" };
  const statKey = actionToKey[action];
  if (!postId) {
    return res.status(400).json({ ok: false, error: "missing_post_id" });
  }
  if (!statKey) {
    return res.status(400).json({ ok: false, error: "unsupported_action" });
  }

  const context = getMealContext(householdId);
  const idx = context.feed.findIndex((item) => String(item.id) === postId);
  if (idx < 0) {
    return res.status(404).json({ ok: false, error: "feed_item_not_found" });
  }

  const actor = String(req?.user?.id || req?.user?.userId || "dev-local-user");
  const deltaRaw = Number(req?.body?.delta);
  const delta = Number.isFinite(deltaRaw) && deltaRaw !== 0 ? deltaRaw : 1;
  const current = { ...context.feed[idx] };
  current[statKey] = Math.max(0, Number(current[statKey] || 0) + delta);
  current.updatedBy = actor;
  current.actionLog = Array.isArray(current.actionLog) ? current.actionLog : [];
  current.actionLog.push({ action, delta, updatedBy: actor, at: new Date().toISOString() });
  context.feed[idx] = current;

  if (action === "share") {
    const homesteadFeed = getHomesteadFeed(householdId);
    homesteadFeed.unshift({
      id: `handoff-${Date.now()}`,
      author: "Meal Planner Handoff",
      source: "meal-planner",
      sourcePostId: postId,
      updatedBy: actor,
      lastAction: "handoff_from_meal",
      actionLog: [{ action: "handoff_from_meal", updatedBy: actor, at: new Date().toISOString() }],
    });
  }

  return res.json({ ok: true, householdId, updatedPost: current, ...context });
});

router.get("/homestead/collaboration", (req, res) => {
  const householdId = getHouseholdId(req);
  return res.json({ ok: true, householdId, collaboration: { feed: getHomesteadFeed(householdId) } });
});

router.post("/assistant/plan", express.json(), requireEntitlementPolicy({ feature: "planner.assistant" }), requirePlannerAdminRole(), (req, res) => {
  return res.json({ ok: true, plan: null, fallback: true });
});

router.post("/projection/replay", express.json(), requirePlannerAdminRole(), (req, res) => {
  return res.json({ ok: true, fallback: true });
});

router.post("/projection/reconcile", express.json(), requirePlannerAdminRole(), (req, res) => {
  return res.json({ ok: true, fallback: true });
});

router.post("/operational/outbox/alerts/dispatch", express.json(), requirePlannerAdminRole(), (req, res) => {
  return res.json({ ok: true, fallback: true });
});

router.post("/operational/outbox/alert-thresholds", express.json(), requirePlannerAdminRole(), (req, res) => {
  return res.json({ ok: true, fallback: true });
});

router.post("/operational/outbox/claim", express.json(), requirePlannerAdminRole(), (req, res) => {
  return res.json({ ok: true, fallback: true });
});

router.post("/operational/outbox/retry", express.json(), requirePlannerAdminRole(), (req, res) => {
  return res.json({ ok: true, fallback: true });
});

router.post("/operational/outbox/replay-dead-letter", express.json(), requirePlannerAdminRole(), (req, res) => {
  return res.json({ ok: true, fallback: true });
});

router.post("/operational/outbox/process", express.json(), requirePlannerAdminRole(), (req, res) => {
  return res.json({ ok: true, fallback: true });
});

module.exports = router;