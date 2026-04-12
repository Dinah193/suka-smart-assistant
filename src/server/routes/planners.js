"use strict";

const express = require("express");
const fs = require("fs/promises");
const path = require("path");
const { authenticateRequest } = require("../middleware/realtime/authenticateRequest.js");
const {
  requireHouseholdAccessPolicy,
  requireCollaborationPolicy,
  requireEntitlementPolicy,
  requirePlannerAdminRole,
} = require("../middleware/accessPolicy.js");
const {
  appendHouseholdNotifications,
  buildMentionNotificationEntries: buildRoutedMentionNotificationEntries,
  buildNotificationEntry,
} = require("../services/planners/HouseholdNotificationRouter.js");
const {
  buildUnifiedFeedMutationEvent,
  buildUnifiedFeedMutationResponse,
} = require("../services/planners/HouseholdFeedEventEmitter.js");
const { WORKFLOW_STATES } = require("../contracts/householdSocialContract.js");

function isLocalDevRequest(req) {
  if (String(process.env.NODE_ENV || "").toLowerCase() === "production") {
    return false;
  }
  const host = String(req?.hostname || req?.headers?.host || "").split(":")[0].toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function buildDevAssistantFallbackBundle(householdId, payload = {}) {
  const cuisines = Array.isArray(payload?.preferences?.cuisines)
    ? payload.preferences.cuisines.filter(Boolean)
    : [];
  const dietaryNeeds = Array.isArray(payload?.preferences?.dietaryNeeds)
    ? payload.preferences.dietaryNeeds.filter(Boolean)
    : [];

  return {
    generatedAt: new Date().toISOString(),
    profile: {
      householdSize: Number(payload?.history?.householdSize || 4),
      skillLevel: String(payload?.history?.skillLevel || "novice"),
    },
    goals: {
      cuisines,
      dietaryNeeds,
      nutrition: payload?.goals?.nutrition || {},
    },
    suggestions: {
      meal: {
        recipes: [
          {
            title: "Sheet-pan chicken and vegetables",
            reason: "Balanced batch-friendly meal with simple cleanup.",
          },
          {
            title: "Lentil skillet with seasonal greens",
            reason: "Supports fiber and protein goals with pantry staples.",
          },
        ],
        educationalHints: [
          "Batch-cook proteins once and repurpose for 2-3 meals this week.",
          "Use one preserved ingredient per meal to reduce pantry waste.",
        ],
      },
      storehouse: {
        categories: [
          { bucket: "freezer", items: ["cooked chicken portions", "stock cubes"] },
          { bucket: "dehydration", items: ["onion flakes", "herb blend"] },
          { bucket: "fermentation", items: ["quick kraut base"] },
        ],
        educationalHints: [
          "Label every preserved batch with date + intended meal use.",
        ],
      },
      homestead: {
        suggestedCrops: [
          { name: "kale", purpose: "weekly meal greens" },
          { name: "carrot", purpose: "storage crop for soups" },
        ],
        suggestedAnimals: [
          { type: "chicken", targetCount: 6, outputs: ["eggs", "manure"] },
        ],
        productionForecast: { seasonKey: "current" },
        educationalHints: [
          "Stagger sowing every 2 weeks to smooth harvest volume.",
        ],
      },
    },
    context: { householdId },
  };
}

const MEAL_CONTEXT_STATE_FILE = path.resolve(
  __dirname,
  "../../../data/meal-planner-context-state.json"
);

const HOMESTEAD_CONTEXT_STATE_FILE = path.resolve(
  __dirname,
  "../../../data/homestead-planner-context-state.json"
);

const STOREHOUSE_CONTEXT_STATE_FILE = path.resolve(
  __dirname,
  "../../../data/storehouse-planner-context-state.json"
);

const PROFILE_MESSAGES_STATE_FILE = path.resolve(
  __dirname,
  "../../../data/profile-messages-context-state.json"
);

const COMMUNITY_CONTEXT_STATE_FILE = path.resolve(
  __dirname,
  "../../../data/community-context-state.json"
);

const MEAL_CONTEXT_ACTION_LOG_LIMIT = 25;
const HOMESTEAD_ACTION_LOG_LIMIT = 40;
const STOREHOUSE_ACTION_LOG_LIMIT = 30;

const APPROVAL_WORKFLOW_TRANSITIONS = Object.freeze({
  [WORKFLOW_STATES.DRAFT]: [WORKFLOW_STATES.PENDING_APPROVAL, WORKFLOW_STATES.ARCHIVED],
  [WORKFLOW_STATES.PENDING_APPROVAL]: [WORKFLOW_STATES.ACTIVE, WORKFLOW_STATES.BLOCKED, WORKFLOW_STATES.ARCHIVED],
  [WORKFLOW_STATES.ACTIVE]: [WORKFLOW_STATES.COMPLETED, WORKFLOW_STATES.BLOCKED, WORKFLOW_STATES.ARCHIVED],
  [WORKFLOW_STATES.BLOCKED]: [WORKFLOW_STATES.PENDING_APPROVAL, WORKFLOW_STATES.ARCHIVED],
  [WORKFLOW_STATES.COMPLETED]: [],
  [WORKFLOW_STATES.ARCHIVED]: [],
});

const TASK_WORKFLOW_TRANSITIONS = Object.freeze({
  [WORKFLOW_STATES.DRAFT]: [WORKFLOW_STATES.ACTIVE, WORKFLOW_STATES.PENDING_APPROVAL, WORKFLOW_STATES.ARCHIVED],
  [WORKFLOW_STATES.PENDING_APPROVAL]: [WORKFLOW_STATES.ACTIVE, WORKFLOW_STATES.BLOCKED, WORKFLOW_STATES.ARCHIVED],
  [WORKFLOW_STATES.ACTIVE]: [WORKFLOW_STATES.COMPLETED, WORKFLOW_STATES.BLOCKED, WORKFLOW_STATES.ARCHIVED],
  [WORKFLOW_STATES.BLOCKED]: [WORKFLOW_STATES.ACTIVE, WORKFLOW_STATES.ARCHIVED],
  [WORKFLOW_STATES.COMPLETED]: [WORKFLOW_STATES.ARCHIVED],
  [WORKFLOW_STATES.ARCHIVED]: [],
});

const TASK_ALLOWED_MODULES = new Set(["meal", "cleaning", "storehouse", "homestead", "community"]);
const TASK_ALLOWED_PRIORITIES = new Set(["low", "normal", "high", "critical"]);

function normalizeTaskWorkflowState(value, fallback = WORKFLOW_STATES.ACTIVE) {
  const key = String(value || "").trim().toLowerCase();
  return TASK_WORKFLOW_TRANSITIONS[key] ? key : fallback;
}

function listAllowedTaskWorkflowTransitions(fromState) {
  const key = normalizeTaskWorkflowState(fromState, WORKFLOW_STATES.ACTIVE);
  return Array.isArray(TASK_WORKFLOW_TRANSITIONS[key])
    ? [...TASK_WORKFLOW_TRANSITIONS[key]]
    : [];
}

function canTransitionTaskWorkflowState(fromState, toState) {
  const next = normalizeTaskWorkflowState(toState, "");
  if (!next) return false;
  return listAllowedTaskWorkflowTransitions(fromState).includes(next);
}

function normalizeTaskPriority(value, fallback = "normal") {
  const key = String(value || "").trim().toLowerCase();
  return TASK_ALLOWED_PRIORITIES.has(key) ? key : fallback;
}

function normalizeTaskModuleKey(value, fallback = "community") {
  const key = String(value || "").trim().toLowerCase();
  return TASK_ALLOWED_MODULES.has(key) ? key : fallback;
}

function normalizeTaskRecurrence(value) {
  const raw = value && typeof value === "object" ? value : {};
  const frequency = String(raw.frequency || "").trim().toLowerCase();
  const enabled = raw.enabled === true && ["daily", "weekly", "custom"].includes(frequency);
  const intervalDaysRaw = Number(raw.intervalDays);
  const intervalDays = Number.isFinite(intervalDaysRaw) && intervalDaysRaw > 0
    ? Math.min(365, Math.floor(intervalDaysRaw))
    : frequency === "weekly"
      ? 7
      : 1;
  return {
    enabled,
    frequency: enabled ? frequency : null,
    intervalDays: enabled ? intervalDays : null,
  };
}

function detectHouseholdTaskConflicts(rows, candidateTask) {
  const list = Array.isArray(rows) ? rows : [];
  const candidate = candidateTask && typeof candidateTask === "object" ? candidateTask : {};
  const dueAt = Date.parse(String(candidate.dueAt || ""));
  if (!Number.isFinite(dueAt)) return [];

  const ownerId = String(candidate.ownerId || "").trim().toLowerCase();
  if (!ownerId) return [];

  return list
    .filter((task) => {
      if (!task || typeof task !== "object") return false;
      if (String(task.id || "") === String(candidate.id || "")) return false;
      if (String(task.ownerId || "").trim().toLowerCase() !== ownerId) return false;
      const state = normalizeTaskWorkflowState(task.workflowState, WORKFLOW_STATES.ACTIVE);
      if (state === WORKFLOW_STATES.COMPLETED || state === WORKFLOW_STATES.ARCHIVED) return false;
      const taskDueAt = Date.parse(String(task.dueAt || ""));
      if (!Number.isFinite(taskDueAt)) return false;
      return Math.abs(taskDueAt - dueAt) <= 60 * 60 * 1000;
    })
    .map((task) => String(task.id || ""))
    .filter(Boolean);
}

function computeNextRecurrenceDueAt(baseDueAt, recurrence, fallbackNowIso) {
  const parsed = Date.parse(String(baseDueAt || ""));
  const baseDate = Number.isFinite(parsed) ? new Date(parsed) : new Date(String(fallbackNowIso || new Date().toISOString()));
  const rec = normalizeTaskRecurrence(recurrence);
  if (!rec.enabled) return null;
  const next = new Date(baseDate.getTime());
  next.setUTCDate(next.getUTCDate() + Number(rec.intervalDays || 1));
  return next.toISOString();
}

function normalizeHouseholdTaskRecord({ incoming, existing, householdId, actor, nowIso }) {
  const raw = incoming && typeof incoming === "object" ? incoming : {};
  const current = existing && typeof existing === "object" ? existing : null;
  const id = String(raw.id || current?.id || generateHomesteadId("household-task"));
  const recurrence = normalizeTaskRecurrence(raw.recurrence ?? current?.recurrence);
  const workflowState = normalizeTaskWorkflowState(raw.workflowState ?? current?.workflowState, WORKFLOW_STATES.ACTIVE);
  const dependsOn = Array.isArray(raw.dependsOn)
    ? raw.dependsOn.map((value) => String(value || "").trim()).filter(Boolean)
    : Array.isArray(current?.dependsOn)
      ? current.dependsOn.map((value) => String(value || "").trim()).filter(Boolean)
      : [];

  return {
    id,
    householdId,
    moduleKey: normalizeTaskModuleKey(raw.moduleKey ?? current?.moduleKey),
    title: String(raw.title ?? current?.title ?? "").trim(),
    detail: String(raw.detail ?? current?.detail ?? "").trim(),
    ownerId: String(raw.ownerId ?? current?.ownerId ?? "").trim() || null,
    dueAt: coerceIsoDate(raw.dueAt ?? current?.dueAt, nowIso),
    workflowState,
    priority: normalizeTaskPriority(raw.priority ?? current?.priority),
    dependsOn,
    recurrence,
    sourceTaskId: String(raw.sourceTaskId ?? current?.sourceTaskId ?? "").trim() || null,
    createdAt: String(current?.createdAt || nowIso),
    updatedAt: String(nowIso),
    updatedBy: String(actor || current?.updatedBy || "unknown"),
    completedAt:
      workflowState === WORKFLOW_STATES.COMPLETED
        ? String(raw.completedAt || current?.completedAt || nowIso)
        : null,
    archivedAt:
      workflowState === WORKFLOW_STATES.ARCHIVED
        ? String(raw.archivedAt || current?.archivedAt || nowIso)
        : null,
    auditLog: Array.isArray(current?.auditLog) ? [...current.auditLog] : [],
  };
}

function normalizeApprovalWorkflowState(value, fallback = WORKFLOW_STATES.PENDING_APPROVAL) {
  const key = String(value || "").trim().toLowerCase();
  return APPROVAL_WORKFLOW_TRANSITIONS[key] ? key : fallback;
}

function listAllowedApprovalWorkflowTransitions(fromState) {
  const key = normalizeApprovalWorkflowState(fromState, WORKFLOW_STATES.PENDING_APPROVAL);
  return Array.isArray(APPROVAL_WORKFLOW_TRANSITIONS[key])
    ? [...APPROVAL_WORKFLOW_TRANSITIONS[key]]
    : [];
}

function canTransitionApprovalWorkflowState(fromState, toState) {
  const next = normalizeApprovalWorkflowState(toState, "");
  if (!next) return false;
  const allowed = listAllowedApprovalWorkflowTransitions(fromState);
  return allowed.includes(next);
}

function mapReportStatusFromWorkflowState(workflowState) {
  const key = normalizeApprovalWorkflowState(workflowState, WORKFLOW_STATES.PENDING_APPROVAL);
  if (key === WORKFLOW_STATES.ACTIVE) return "in_review";
  if (key === WORKFLOW_STATES.BLOCKED) return "rejected";
  if (key === WORKFLOW_STATES.COMPLETED) return "resolved";
  if (key === WORKFLOW_STATES.ARCHIVED) return "archived";
  return "queued";
}

const DEFAULT_PROFILE_MESSAGES_CONTEXT = Object.freeze({
  conversations: [],
  selectedConversationId: null,
  lastUpdatedAt: null,
});

function cloneProfileMessagesContext(value) {
  return JSON.parse(JSON.stringify(value || DEFAULT_PROFILE_MESSAGES_CONTEXT));
}

function normalizeProfileMessagesContext(value) {
  const raw = value && typeof value === "object" ? value : {};
  const conversations = Array.isArray(raw.conversations) ? raw.conversations : [];

  return {
    conversations,
    selectedConversationId:
      String(raw.selectedConversationId || "").trim() || conversations[0]?.id || null,
    lastUpdatedAt: raw.lastUpdatedAt || new Date().toISOString(),
  };
}

async function readProfileMessagesStateFile() {
  try {
    const raw = await fs.readFile(PROFILE_MESSAGES_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { version: 1, households: {} };
    }
    if (!parsed.households || typeof parsed.households !== "object") {
      parsed.households = {};
    }
    return parsed;
  } catch {
    return { version: 1, households: {} };
  }
}

async function writeProfileMessagesStateFile(state) {
  await fs.mkdir(path.dirname(PROFILE_MESSAGES_STATE_FILE), { recursive: true });
  await fs.writeFile(PROFILE_MESSAGES_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function getProfileMessagesContextForHousehold(householdId) {
  const state = await readProfileMessagesStateFile();
  const current = normalizeProfileMessagesContext(state.households?.[householdId] || {});
  return { state, current };
}

function appendMessageToConversation(context, conversationId, message, actorId) {
  const next = normalizeProfileMessagesContext(context);
  const targetId = String(conversationId || "").trim();
  if (!targetId) {
    throw new Error("conversation_id_required");
  }

  const nowIso = new Date().toISOString();
  const nextMessage = {
    id: String(message?.id || `dm-msg-${Date.now()}`),
    from: String(message?.from || "me"),
    body: String(message?.body || "").trim(),
    moduleKey: String(message?.moduleKey || "meals"),
    seasonalCue: String(message?.seasonalCue || "Seasonal collaboration"),
    at: String(message?.at || new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })),
    actionType: message?.actionType ? String(message.actionType) : undefined,
    updatedBy: actorId,
    updatedAt: nowIso,
  };

  const existing = next.conversations.find((conversation) => conversation.id === targetId);
  if (existing) {
    existing.thread = Array.isArray(existing.thread) ? [...existing.thread, nextMessage] : [nextMessage];
    existing.lastMessage = nextMessage.body;
    existing.lastAt = "just now";
    existing.lastUpdatedAt = nowIso;
  } else {
    next.conversations.unshift({
      id: targetId,
      household: String(message?.household || "Household"),
      animal: String(message?.animal || "sheep"),
      unread: 0,
      status: "assigned",
      lastAt: "just now",
      lastMessage: nextMessage.body,
      moduleParticipation: [],
      thread: [nextMessage],
      lastUpdatedAt: nowIso,
    });
  }

  next.selectedConversationId = targetId;
  next.lastUpdatedAt = nowIso;
  return next;
}

function cloneDefaultCommunityContext(householdId) {
  return {
    householdId,
    sharedPlans: [],
    gardenPlans: [],
    animalPlans: [],
    feed: [
      {
        id: "community-feed-1",
        author: "Community Board",
        content:
          "Share your household plan updates to coordinate swaps and seasonal labor.",
        timestamp: "Today 09:00",
        likes: 0,
        comments: 0,
        shares: 0,
      },
    ],
    notifications: [],
    reports: [],
    approvals: [],
    tasks: [],
    profileVisibility: {
      mode: "community",
      discoverable: true,
      showHouseholdName: true,
    },
    updatedAt: new Date().toISOString(),
  };
}

async function readCommunityContextStateFile() {
  try {
    const raw = await fs.readFile(COMMUNITY_CONTEXT_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { version: 1, households: {} };
    }
    if (!parsed.households || typeof parsed.households !== "object") {
      parsed.households = {};
    }
    return parsed;
  } catch {
    return { version: 1, households: {} };
  }
}

async function writeCommunityContextStateFile(state) {
  await fs.mkdir(path.dirname(COMMUNITY_CONTEXT_STATE_FILE), { recursive: true });
  await fs.writeFile(COMMUNITY_CONTEXT_STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function ensureCommunityHouseholdState(state, householdId) {
  if (!state.households[householdId] || typeof state.households[householdId] !== "object") {
    state.households[householdId] = cloneDefaultCommunityContext(householdId);
  }
  const current = state.households[householdId];
  current.sharedPlans = Array.isArray(current.sharedPlans) ? current.sharedPlans : [];
  current.gardenPlans = Array.isArray(current.gardenPlans) ? current.gardenPlans : [];
  current.animalPlans = Array.isArray(current.animalPlans) ? current.animalPlans : [];
  current.feed = Array.isArray(current.feed) ? current.feed : [];
  current.commentThreads =
    current.commentThreads && typeof current.commentThreads === "object"
      ? current.commentThreads
      : {};
  current.notifications = Array.isArray(current.notifications) ? current.notifications : [];
  current.reports = Array.isArray(current.reports) ? current.reports : [];
  current.approvals = Array.isArray(current.approvals) ? current.approvals : [];
  current.tasks = Array.isArray(current.tasks) ? current.tasks : [];
  current.profileVisibility =
    current.profileVisibility && typeof current.profileVisibility === "object"
      ? {
          mode: toTrimmedString(current.profileVisibility.mode || "community") || "community",
          discoverable: current.profileVisibility.discoverable !== false,
          showHouseholdName: current.profileVisibility.showHouseholdName !== false,
        }
      : {
          mode: "community",
          discoverable: true,
          showHouseholdName: true,
        };
  return current;
}

async function getCommunityContextForHousehold(householdId) {
  const state = await readCommunityContextStateFile();
  const householdState = ensureCommunityHouseholdState(state, householdId);
  return { state, householdState };
}

const DEFAULT_MEAL_CONTEXT = Object.freeze({
  feed: [
    {
      id: "meal-feed-1",
      author: "Meal Planning Team",
      content:
        "Cycle planning now aligns prep, procurement, and storehouse signals in one weekly rhythm.",
      timestamp: "Today 08:21",
      likes: 17,
      comments: 4,
      shares: 2,
    },
    {
      id: "meal-feed-2",
      author: "Homestead Coordinator",
      household: true,
      content:
        "Seasonal produce constraints were applied to this cycle to reduce procurement drift.",
      timestamp: "Today 07:09",
      likes: 10,
      comments: 3,
      shares: 1,
    },
  ],
  alerts: [
    {
      id: "meal-alert-1",
      type: "info",
      title: "Planning Context Synced",
      message:
        "Meal Planner now shares a unified Sacred visual language with Home and Storehouse.",
      timestamp: "Now",
    },
    {
      id: "meal-alert-2",
      type: "success",
      title: "Draft Workflow Ready",
      message:
        "Use Generate -> Draft to capture scenarios without overwriting current plan.",
      timestamp: "5m ago",
    },
  ],
});

function cloneDefaultMealContext() {
  return {
    feed: DEFAULT_MEAL_CONTEXT.feed.map((item) => ({ ...item })),
    alerts: DEFAULT_MEAL_CONTEXT.alerts.map((item) => ({ ...item })),
  };
}

async function readMealContextStateFile() {
  try {
    const raw = await fs.readFile(MEAL_CONTEXT_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { version: 1, households: {} };
    }
    if (!parsed.households || typeof parsed.households !== "object") {
      parsed.households = {};
    }
    return parsed;
  } catch {
    return { version: 1, households: {} };
  }
}

async function writeMealContextStateFile(state) {
  await fs.mkdir(path.dirname(MEAL_CONTEXT_STATE_FILE), { recursive: true });
  await fs.writeFile(
    MEAL_CONTEXT_STATE_FILE,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );
}

function mergeMealContextWithState(householdState) {
  const defaults = cloneDefaultMealContext();
  const dismissed = new Set(
    Array.isArray(householdState?.dismissedAlertIds)
      ? householdState.dismissedAlertIds
      : []
  );
  const statsByPost =
    householdState?.postStats && typeof householdState.postStats === "object"
      ? householdState.postStats
      : {};
  const alertAuditById =
    householdState?.alertAudit && typeof householdState.alertAudit === "object"
      ? householdState.alertAudit
      : {};
  const feedAuditById =
    householdState?.feedAudit && typeof householdState.feedAudit === "object"
      ? householdState.feedAudit
      : {};

  const alerts = defaults.alerts
    .filter((item) => !dismissed.has(item.id))
    .map((item) => {
      const audit = alertAuditById[item.id] || {};
      return {
        ...item,
        updatedBy: audit.updatedBy || null,
        actionLog: Array.isArray(audit.actionLog) ? audit.actionLog : [],
      };
    });
  const feed = defaults.feed.map((item) => {
    const stats = statsByPost[item.id] || {};
    const audit = feedAuditById[item.id] || {};
    const semanticActions =
      stats.semanticActions && typeof stats.semanticActions === "object"
        ? stats.semanticActions
        : {};
    return {
      ...item,
      likes: Number.isFinite(Number(stats.likes)) ? Number(stats.likes) : item.likes,
      comments: Number.isFinite(Number(stats.comments))
        ? Number(stats.comments)
        : item.comments,
      shares: Number.isFinite(Number(stats.shares)) ? Number(stats.shares) : item.shares,
      semanticActions,
      updatedBy: audit.updatedBy || null,
      actionLog: Array.isArray(audit.actionLog) ? audit.actionLog : [],
    };
  });

  return { alerts, feed };
}

function resolveMealContextActor(req, body = {}) {
  const headerActor = String(req.headers["x-user-id"] || "").trim();
  const bodyActor = String(body.updatedBy || body.userId || "").trim();
  const userActor = String(req.user?.id || req.user?.userId || "").trim();
  return bodyActor || userActor || headerActor || "unknown";
}

function appendMealContextActionLog(existingLog, entry) {
  const base = Array.isArray(existingLog) ? existingLog : [];
  const next = [...base, entry];
  if (next.length <= MEAL_CONTEXT_ACTION_LOG_LIMIT) {
    return next;
  }
  return next.slice(next.length - MEAL_CONTEXT_ACTION_LOG_LIMIT);
}

const DEFAULT_STOREHOUSE_CONTEXT = Object.freeze({
  feed: [
    {
      id: "store-feed-1",
      author: "Storehouse Coordinator",
      content:
        "Weekly projection updated from garden + animal queues. Prioritize grain and legumes procurement.",
      timestamp: "Today 07:50",
      likes: 11,
      comments: 2,
      shares: 1,
    },
    {
      id: "store-feed-2",
      author: "Willow Household",
      household: true,
      content:
        "Preservation queue aligned with incoming produce peaks for this cycle.",
      timestamp: "Today 06:35",
      likes: 8,
      comments: 1,
      shares: 0,
    },
  ],
  alerts: [
    {
      id: "store-alert-1",
      type: "info",
      title: "Forecast loop active",
      message: "Storehouse projections are synced with current household profile inputs.",
      timestamp: "Now",
    },
    {
      id: "store-alert-2",
      type: "warning",
      title: "Replenishment watch",
      message:
        "Review low-stock items before next batch-cooking window for smoother flow.",
      timestamp: "12m ago",
    },
  ],
});

function cloneDefaultStorehouseContext() {
  return {
    feed: DEFAULT_STOREHOUSE_CONTEXT.feed.map((item) => ({ ...item })),
    alerts: DEFAULT_STOREHOUSE_CONTEXT.alerts.map((item) => ({ ...item })),
  };
}

async function readStorehouseContextStateFile() {
  try {
    const raw = await fs.readFile(STOREHOUSE_CONTEXT_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { version: 1, households: {} };
    }
    if (!parsed.households || typeof parsed.households !== "object") {
      parsed.households = {};
    }
    return parsed;
  } catch {
    return { version: 1, households: {} };
  }
}

async function writeStorehouseContextStateFile(state) {
  await fs.mkdir(path.dirname(STOREHOUSE_CONTEXT_STATE_FILE), { recursive: true });
  await fs.writeFile(
    STOREHOUSE_CONTEXT_STATE_FILE,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );
}

function mergeStorehouseContextWithState(householdState) {
  const defaults = cloneDefaultStorehouseContext();
  const dismissed = new Set(
    Array.isArray(householdState?.dismissedAlertIds)
      ? householdState.dismissedAlertIds
      : []
  );
  const statsByPost =
    householdState?.postStats && typeof householdState.postStats === "object"
      ? householdState.postStats
      : {};
  const alertAuditById =
    householdState?.alertAudit && typeof householdState.alertAudit === "object"
      ? householdState.alertAudit
      : {};
  const feedAuditById =
    householdState?.feedAudit && typeof householdState.feedAudit === "object"
      ? householdState.feedAudit
      : {};

  const alerts = defaults.alerts
    .filter((item) => !dismissed.has(item.id))
    .map((item) => {
      const audit = alertAuditById[item.id] || {};
      return {
        ...item,
        updatedBy: audit.updatedBy || null,
        actionLog: Array.isArray(audit.actionLog) ? audit.actionLog : [],
      };
    });

  const feed = defaults.feed.map((item) => {
    const stats = statsByPost[item.id] || {};
    const audit = feedAuditById[item.id] || {};
    const semanticActions =
      stats.semanticActions && typeof stats.semanticActions === "object"
        ? stats.semanticActions
        : {};
    return {
      ...item,
      likes: Number.isFinite(Number(stats.likes)) ? Number(stats.likes) : item.likes,
      comments: Number.isFinite(Number(stats.comments))
        ? Number(stats.comments)
        : item.comments,
      shares: Number.isFinite(Number(stats.shares)) ? Number(stats.shares) : item.shares,
      semanticActions,
      updatedBy: audit.updatedBy || null,
      actionLog: Array.isArray(audit.actionLog) ? audit.actionLog : [],
    };
  });

  return { alerts, feed };
}

function resolveStorehouseContextActor(req, body = {}) {
  const headerActor = String(req.headers["x-user-id"] || "").trim();
  const bodyActor = String(body.updatedBy || body.userId || "").trim();
  const userActor = String(req.user?.id || req.user?.userId || "").trim();
  return bodyActor || userActor || headerActor || "unknown";
}

function appendStorehouseActionLog(existingLog, entry) {
  const base = Array.isArray(existingLog) ? existingLog : [];
  const next = [...base, entry];
  if (next.length <= STOREHOUSE_ACTION_LOG_LIMIT) {
    return next;
  }
  return next.slice(next.length - STOREHOUSE_ACTION_LOG_LIMIT);
}

async function getStorehouseContextForHousehold(householdId) {
  const state = await readStorehouseContextStateFile();
  const householdState =
    state.households && typeof state.households === "object"
      ? state.households[householdId] || {}
      : {};
  const context = mergeStorehouseContextWithState(householdState);
  return {
    context,
    state,
    householdState,
  };
}

async function mirrorMealShareToHomesteadFeed({ householdId, postId, actor, actionAt }) {
  const homesteadState = await readHomesteadContextStateFile();
  const household = ensureHomesteadHouseholdState(homesteadState, householdId);
  const feed = Array.isArray(household?.collaboration?.feed)
    ? household.collaboration.feed
    : [];

  const handoffId = `meal-handoff-${postId}-${Date.now()}`;
  feed.unshift({
    id: handoffId,
    author: "Meal Planner Handoff",
    content:
      "Meal planner shared an update for cross-module follow-up. Review and coordinate next actions.",
    timestamp: "Now",
    likes: 0,
    coordinates: 0,
    shares: 0,
    source: "meal-planner",
    sourcePostId: postId,
    updatedBy: actor,
    lastAction: "handoff_from_meal",
    lastActionAt: actionAt,
    actionLog: [
      {
        action: "handoff_from_meal",
        at: actionAt,
        updatedBy: actor,
      },
    ],
  });

  household.collaboration.feed = feed;
  household.updatedAt = new Date().toISOString();
  homesteadState.households[householdId] = household;
  await writeHomesteadContextStateFile(homesteadState);
}

async function getMealContextForHousehold(householdId) {
  const state = await readMealContextStateFile();
  const householdState =
    state.households && typeof state.households === "object"
      ? state.households[householdId] || {}
      : {};
  const context = mergeMealContextWithState(householdState);
  return {
    context,
    state,
    householdState,
  };
}

function generateHomesteadId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneDefaultHomesteadContext(householdId) {
  return {
    householdId,
    targets: [],
    collaboration: {
      needs: [],
      offers: [],
      assignments: [],
      fulfillments: [],
      feed: [
        {
          id: "homestead-feed-1",
          author: "Homestead Coordination Team",
          content:
            "Coordinate planting windows with neighboring households to close animal feed and pantry gaps.",
          timestamp: "Today 07:15",
          likes: 9,
          coordinates: 2,
          shares: 3,
          updatedBy: null,
          actionLog: [],
        },
      ],
    },
    updatedAt: new Date().toISOString(),
  };
}

async function readHomesteadContextStateFile() {
  try {
    const raw = await fs.readFile(HOMESTEAD_CONTEXT_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { version: 1, households: {} };
    }
    if (!parsed.households || typeof parsed.households !== "object") {
      parsed.households = {};
    }
    return parsed;
  } catch {
    return { version: 1, households: {} };
  }
}

async function writeHomesteadContextStateFile(state) {
  await fs.mkdir(path.dirname(HOMESTEAD_CONTEXT_STATE_FILE), { recursive: true });
  await fs.writeFile(
    HOMESTEAD_CONTEXT_STATE_FILE,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );
}

function appendHomesteadActionLog(existingLog, entry) {
  const base = Array.isArray(existingLog) ? existingLog : [];
  const next = [...base, entry];
  if (next.length <= HOMESTEAD_ACTION_LOG_LIMIT) {
    return next;
  }
  return next.slice(next.length - HOMESTEAD_ACTION_LOG_LIMIT);
}

function resolveHomesteadContextActor(req, body = {}) {
  const headerActor = String(req.headers["x-user-id"] || "").trim();
  const bodyActor = String(body.updatedBy || body.userId || "").trim();
  const userActor = String(req.user?.id || req.user?.userId || "").trim();
  return bodyActor || userActor || headerActor || "unknown";
}

function ensureHomesteadHouseholdState(state, householdId) {
  if (!state.households[householdId] || typeof state.households[householdId] !== "object") {
    state.households[householdId] = cloneDefaultHomesteadContext(householdId);
  }
  const current = state.households[householdId];
  if (!Array.isArray(current.targets)) {
    current.targets = [];
  }
  if (!current.collaboration || typeof current.collaboration !== "object") {
    current.collaboration = {
      needs: [],
      offers: [],
      assignments: [],
      fulfillments: [],
      feed: [],
      commentThreads: {},
    };
  }
  current.collaboration.needs = Array.isArray(current.collaboration.needs)
    ? current.collaboration.needs
    : [];
  current.collaboration.offers = Array.isArray(current.collaboration.offers)
    ? current.collaboration.offers
    : [];
  current.collaboration.assignments = Array.isArray(current.collaboration.assignments)
    ? current.collaboration.assignments
    : [];
  current.collaboration.fulfillments = Array.isArray(current.collaboration.fulfillments)
    ? current.collaboration.fulfillments
    : [];
  current.collaboration.feed = Array.isArray(current.collaboration.feed)
    ? current.collaboration.feed
    : [];
  current.collaboration.commentThreads =
    current.collaboration.commentThreads &&
    typeof current.collaboration.commentThreads === "object"
      ? current.collaboration.commentThreads
      : {};
  if (!current.resources || typeof current.resources !== "object") {
    current.resources = {};
  }
  if (!Array.isArray(current.resources.components)) {
    current.resources.components = [];
  }
  if (!Array.isArray(current.resources.inventory)) {
    current.resources.inventory = [];
  }
  if (!Array.isArray(current.resources.batches)) {
    current.resources.batches = [];
  }
  if (!Array.isArray(current.resources.animalTargets)) {
    current.resources.animalTargets = [];
  }
  if (!Array.isArray(current.resources.gardenTargets)) {
    current.resources.gardenTargets = [];
  }
  if (!current.resources.cuisines || typeof current.resources.cuisines !== "object") {
    current.resources.cuisines = { profiles: [], rotations: [], prefs: {} };
  }
  if (!Array.isArray(current.resources.cuisines.profiles)) {
    current.resources.cuisines.profiles = [];
  }
  if (!Array.isArray(current.resources.cuisines.rotations)) {
    current.resources.cuisines.rotations = [];
  }
  if (!current.resources.cuisines.prefs || typeof current.resources.cuisines.prefs !== "object") {
    current.resources.cuisines.prefs = {};
  }
  if (!current.resources.preferences || typeof current.resources.preferences !== "object") {
    current.resources.preferences = {
      household: {
        id: "primary",
        name: "Household",
        timezone: "America/Chicago",
        membersCount: 1,
      },
      profile: {
        taste: {},
        likes: {},
        avoids: {},
        allergies: {},
        constraints: {},
        rhythms: {},
        notes: "",
        tags: [],
      },
    };
  }
  if (!current.resources.skills || typeof current.resources.skills !== "object") {
    current.resources.skills = { paths: [], progress: [] };
  }
  if (!Array.isArray(current.resources.skills.paths)) {
    current.resources.skills.paths = [];
  }
  if (!Array.isArray(current.resources.skills.progress)) {
    current.resources.skills.progress = [];
  }
  return current;
}

function upsertById(list, item) {
  const id = String(item?.id || "").trim();
  if (!id) {
    return { list, item: null };
  }
  const nextItem = { ...item, id };
  const index = list.findIndex((row) => String(row?.id) === id);
  if (index >= 0) {
    const next = [...list];
    next[index] = nextItem;
    return { list: next, item: nextItem };
  }
  return { list: [nextItem, ...list], item: nextItem };
}

function deleteById(list, id) {
  return list.filter((row) => String(row?.id) !== String(id));
}

function normalizeHomesteadResourceItems(items, { prefix, actor, now }) {
  const source = Array.isArray(items) ? items : [];
  return source
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }
      const id = String(item.id || generateHomesteadId(prefix));
      return {
        ...item,
        id,
        updatedBy: String(item.updatedBy || actor || "unknown"),
        createdAt: String(item.createdAt || now),
        updatedAt: now,
      };
    })
    .filter(Boolean);
}

function upsertManyById(list, incoming) {
  const base = Array.isArray(list) ? [...list] : [];
  const indexById = new Map(base.map((item, index) => [String(item?.id), index]));
  for (const item of incoming) {
    const id = String(item?.id || "").trim();
    if (!id) {
      continue;
    }
    if (indexById.has(id)) {
      const idx = indexById.get(id);
      base[idx] = { ...base[idx], ...item };
      continue;
    }
    indexById.set(id, base.length);
    base.push(item);
  }
  return base;
}

async function getHomesteadContextForHousehold(householdId) {
  const state = await readHomesteadContextStateFile();
  const householdState = ensureHomesteadHouseholdState(state, householdId);
  return { state, householdState };
}

function normalizeUnifiedFeedItem(item, moduleKey, householdId, index = 0) {
  const normalized = item && typeof item === "object" ? item : {};
  const semanticActions =
    normalized.semanticActions && typeof normalized.semanticActions === "object"
      ? Object.fromEntries(
          Object.entries(normalized.semanticActions)
            .map(([key, value]) => [
              toTrimmedString(key).toLowerCase(),
              Math.max(0, Number(value || 0)),
            ])
            .filter(([key]) => Boolean(key))
        )
      : {};
  return {
    id: `${moduleKey}:${String(normalized.id || `${moduleKey}-${index}`)}`,
    sourceId: String(normalized.id || `${moduleKey}-${index}`),
    sourceModule: moduleKey,
    householdId,
    author: String(normalized.author || "Household"),
    content: String(normalized.content || ""),
    timestamp: String(normalized.timestamp || "Now"),
    stats: {
      likes: Number(normalized.likes || 0),
      comments: Number(normalized.comments || 0),
      shares: Number(normalized.shares || 0),
      coordinates: Number(normalized.coordinates || 0),
      semanticActions,
    },
    updatedBy: normalized.updatedBy || null,
    lastAction: normalized.lastAction || null,
    lastActionAt: normalized.lastActionAt || normalized.updatedAt || null,
  };
}

function sortUnifiedFeedItems(items) {
  return [...items].sort((a, b) => {
    const aTime = a?.lastActionAt ? Date.parse(a.lastActionAt) : 0;
    const bTime = b?.lastActionAt ? Date.parse(b.lastActionAt) : 0;
    if (bTime !== aTime) return bTime - aTime;
    return String(a.id).localeCompare(String(b.id));
  });
}

const UNIFIED_FEED_MODULES = new Set(["meal", "storehouse", "homestead", "community"]);
const DEFAULT_UNIFIED_FEED_MODULES = ["meal", "storehouse", "homestead", "community"];

function normalizeRequestedFeedModules(modulesRaw) {
  const requestedModules = String(modulesRaw || DEFAULT_UNIFIED_FEED_MODULES.join(","))
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => UNIFIED_FEED_MODULES.has(item));
  return requestedModules.length ? Array.from(new Set(requestedModules)) : [...DEFAULT_UNIFIED_FEED_MODULES];
}

async function collectUnifiedFeedItemsForHousehold({ householdId, requestedModules }) {
  const modules = Array.isArray(requestedModules) && requestedModules.length
    ? requestedModules
    : [...DEFAULT_UNIFIED_FEED_MODULES];
  const selected = new Set(modules);
  const items = [];

  if (selected.has("meal")) {
    const { context } = await getMealContextForHousehold(householdId);
    const feed = Array.isArray(context?.feed) ? context.feed : [];
    items.push(...feed.map((item, index) => normalizeUnifiedFeedItem(item, "meal", householdId, index)));
  }

  if (selected.has("storehouse")) {
    const { context } = await getStorehouseContextForHousehold(householdId);
    const feed = Array.isArray(context?.feed) ? context.feed : [];
    items.push(...feed.map((item, index) => normalizeUnifiedFeedItem(item, "storehouse", householdId, index)));
  }

  if (selected.has("homestead")) {
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    const feed = Array.isArray(householdState?.collaboration?.feed)
      ? householdState.collaboration.feed
      : [];
    items.push(...feed.map((item, index) => normalizeUnifiedFeedItem(item, "homestead", householdId, index)));
  }

  if (selected.has("community")) {
    const { householdState } = await getCommunityContextForHousehold(householdId);
    const feed = Array.isArray(householdState?.feed) ? householdState.feed : [];
    items.push(...feed.map((item, index) => normalizeUnifiedFeedItem(item, "community", householdId, index)));
  }

  return sortUnifiedFeedItems(items);
}

function makeHouseholdAgendaItem({ id, lane, module, title, detail, dueAt, state, sourceType }) {
  return {
    id,
    lane,
    module,
    title,
    detail,
    dueAt,
    state,
    sourceType,
  };
}

const AGENDA_PRIORITY_RANK = Object.freeze({
  critical: 4,
  high: 3,
  normal: 2,
  low: 1,
});

const AGENDA_STATUS_RANK = Object.freeze({
  blocked: 5,
  pending_approval: 4,
  active: 3,
  draft: 2,
  completed: 1,
  archived: 0,
  planned: 2,
  pending: 2,
  today: 2,
});

function normalizeAgendaSortBy(value) {
  const key = String(value || "").trim().toLowerCase();
  if (["priority", "status", "dueat"].includes(key)) return key;
  return "dueat";
}

function normalizeAgendaSortDirection(value) {
  const key = String(value || "").trim().toLowerCase();
  return key === "asc" ? "asc" : "desc";
}

function normalizeAgendaFilters(query = {}) {
  return {
    ownerId: String(query.ownerId || query.person || "").trim().toLowerCase(),
    moduleKey: String(query.moduleKey || query.module || "").trim().toLowerCase(),
    priority: String(query.priority || "").trim().toLowerCase(),
    workflowState: String(query.workflowState || query.status || "").trim().toLowerCase(),
  };
}

function agendaItemMatchesFilters(item, filters = {}) {
  const row = item && typeof item === "object" ? item : {};
  const f = filters && typeof filters === "object" ? filters : {};
  if (f.ownerId) {
    const owner = String(row.ownerId || "").trim().toLowerCase();
    if (owner !== f.ownerId) return false;
  }
  if (f.moduleKey) {
    const moduleKey = String(row.module || row.lane || "").trim().toLowerCase();
    if (moduleKey !== f.moduleKey) return false;
  }
  if (f.priority) {
    const priority = String(row.priority || "").trim().toLowerCase();
    if (priority !== f.priority) return false;
  }
  if (f.workflowState) {
    const status = String(row.workflowState || row.state || "").trim().toLowerCase();
    if (status !== f.workflowState) return false;
  }
  return true;
}

function compareAgendaItems(left, right, sortBy, sortDirection) {
  const a = left && typeof left === "object" ? left : {};
  const b = right && typeof right === "object" ? right : {};
  const direction = sortDirection === "asc" ? 1 : -1;

  if (sortBy === "priority") {
    const aRank = Number(AGENDA_PRIORITY_RANK[String(a.priority || "").toLowerCase()] || 0);
    const bRank = Number(AGENDA_PRIORITY_RANK[String(b.priority || "").toLowerCase()] || 0);
    if (aRank !== bRank) return (aRank - bRank) * direction;
  }

  if (sortBy === "status") {
    const aRank = Number(AGENDA_STATUS_RANK[String(a.workflowState || a.state || "").toLowerCase()] || 0);
    const bRank = Number(AGENDA_STATUS_RANK[String(b.workflowState || b.state || "").toLowerCase()] || 0);
    if (aRank !== bRank) return (aRank - bRank) * direction;
  }

  const aTime = Date.parse(String(a.dueAt || ""));
  const bTime = Date.parse(String(b.dueAt || ""));
  const aVal = Number.isFinite(aTime) ? aTime : 0;
  const bVal = Number.isFinite(bTime) ? bTime : 0;
  if (aVal !== bVal) return (aVal - bVal) * direction;
  return String(a.id || "").localeCompare(String(b.id || "")) * direction;
}

function applyAgendaFiltersAndSort(items, { filters, sortBy, sortDirection, limit }) {
  const rows = Array.isArray(items) ? items : [];
  const filtered = rows.filter((item) => agendaItemMatchesFilters(item, filters));
  const sorted = [...filtered].sort((a, b) => compareAgendaItems(a, b, sortBy, sortDirection));
  const maxItems = Number.isFinite(Number(limit)) ? Number(limit) : sorted.length;
  return sorted.slice(0, Math.max(0, maxItems));
}

function coerceIsoDate(value, fallbackIso) {
  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return fallbackIso;
}

function buildTodayAndUpcomingAgenda({
  householdId,
  nowIso,
  mealContext,
  storehouseContext,
  homesteadState,
  communityState,
  unifiedFeedItems,
  todayLimit,
  upcomingLimit,
  filters,
  sortBy,
  sortDirection,
}) {
  const today = [];
  const upcoming = [];

  const mealAlerts = Array.isArray(mealContext?.alerts) ? mealContext.alerts : [];
  const storehouseAlerts = Array.isArray(storehouseContext?.alerts) ? storehouseContext.alerts : [];
  mealAlerts.forEach((alert) => {
    today.push(
      makeHouseholdAgendaItem({
        id: `today-meal-alert-${alert.id || today.length}`,
        lane: "meal",
        module: "meal",
        title: toTrimmedString(alert.title || "Meal alert"),
        detail: toTrimmedString(alert.message || ""),
        dueAt: nowIso,
        state: "today",
        sourceType: "alert",
      })
    );
  });
  storehouseAlerts.forEach((alert) => {
    today.push(
      makeHouseholdAgendaItem({
        id: `today-storehouse-alert-${alert.id || today.length}`,
        lane: "storehouse",
        module: "storehouse",
        title: toTrimmedString(alert.title || "Storehouse alert"),
        detail: toTrimmedString(alert.message || ""),
        dueAt: nowIso,
        state: "today",
        sourceType: "alert",
      })
    );
  });

  const unreadNotifications = (Array.isArray(communityState?.notifications) ? communityState.notifications : [])
    .filter((item) => item?.read !== true)
    .slice(0, 8);
  unreadNotifications.forEach((notification, index) => {
    today.push(
      makeHouseholdAgendaItem({
        id: `today-notification-${notification.id || index}`,
        lane: "community",
        module: "community",
        title: toTrimmedString(notification.title || "Community notification"),
        detail: toTrimmedString(notification.message || ""),
        dueAt: coerceIsoDate(notification.createdAt, nowIso),
        state: "today",
        sourceType: "notification",
      })
    );
  });

  const recentFeed = Array.isArray(unifiedFeedItems) ? unifiedFeedItems.slice(0, 8) : [];
  recentFeed.forEach((item, index) => {
    today.push(
      makeHouseholdAgendaItem({
        id: `today-feed-${item.sourceModule}-${item.sourceId || index}`,
        lane: item.sourceModule,
        module: item.sourceModule,
        title: `Feed update from ${item.sourceModule}`,
        detail: toTrimmedString(item.content || ""),
        dueAt: coerceIsoDate(item.lastActionAt || item.updatedAt, nowIso),
        state: "today",
        sourceType: "feed",
      })
    );
  });

  const assignmentRows = Array.isArray(homesteadState?.collaboration?.assignments)
    ? homesteadState.collaboration.assignments
    : [];
  assignmentRows.forEach((assignment, index) => {
    const status = toTrimmedString(assignment.status || "pending").toLowerCase();
    if (status === "done" || status === "completed") return;
    upcoming.push(
      makeHouseholdAgendaItem({
        id: `upcoming-assignment-${assignment.id || index}`,
        lane: "homestead",
        module: "homestead",
        title: toTrimmedString(assignment.title || assignment.name || "Homestead assignment"),
        detail: toTrimmedString(assignment.notes || "Coordination task awaiting execution."),
        dueAt: coerceIsoDate(assignment.dueAt || assignment.updatedAt, nowIso),
        state: status || "pending",
        sourceType: "assignment",
      })
    );
  });

  const planGroups = [
    { lane: "community", sourceType: "shared_plan", rows: communityState?.sharedPlans },
    { lane: "community", sourceType: "garden_plan", rows: communityState?.gardenPlans },
    { lane: "community", sourceType: "animal_plan", rows: communityState?.animalPlans },
  ];
  planGroups.forEach((group) => {
    const rows = Array.isArray(group.rows) ? group.rows : [];
    rows.forEach((plan, index) => {
      upcoming.push(
        makeHouseholdAgendaItem({
          id: `upcoming-${group.sourceType}-${plan.id || index}`,
          lane: group.lane,
          module: "community",
          title: toTrimmedString(plan.title || "Community plan"),
          detail: toTrimmedString(plan.description || plan.lane || "Upcoming community planning item."),
          dueAt: coerceIsoDate(plan.targetAt || plan.updatedAt, nowIso),
          state: toTrimmedString(plan.status || "planned") || "planned",
          sourceType: group.sourceType,
        })
      );
    });
  });

  const taskRows = Array.isArray(communityState?.tasks) ? communityState.tasks : [];
  const workflowStateByTaskId = new Map(
    taskRows.map((task) => [
      String(task?.id || ""),
      normalizeTaskWorkflowState(task?.workflowState, WORKFLOW_STATES.ACTIVE),
    ])
  );
  taskRows.forEach((task, index) => {
    const workflowState = normalizeTaskWorkflowState(task?.workflowState, WORKFLOW_STATES.ACTIVE);
    if (workflowState === WORKFLOW_STATES.COMPLETED || workflowState === WORKFLOW_STATES.ARCHIVED) {
      return;
    }

    const dueAtIso = coerceIsoDate(task?.dueAt, nowIso);
    const dueAtDate = new Date(dueAtIso);
    const nowDate = new Date(nowIso);
    const isSameDay =
      dueAtDate.getUTCFullYear() === nowDate.getUTCFullYear() &&
      dueAtDate.getUTCMonth() === nowDate.getUTCMonth() &&
      dueAtDate.getUTCDate() === nowDate.getUTCDate();

    const agendaItem = makeHouseholdAgendaItem({
      id: `task-${task.id || index}`,
      lane: normalizeTaskModuleKey(task?.moduleKey, "community"),
      module: normalizeTaskModuleKey(task?.moduleKey, "community"),
      title: toTrimmedString(task?.title || "Household task"),
      detail: toTrimmedString(task?.detail || ""),
      dueAt: dueAtIso,
      state: workflowState,
      sourceType: "task",
    });

    const dependencyIds = Array.isArray(task?.dependsOn)
      ? task.dependsOn.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    const blockingDependencyIds = dependencyIds.filter((dependencyId) => {
      const state = workflowStateByTaskId.get(dependencyId);
      return state !== WORKFLOW_STATES.COMPLETED;
    });
    const conflictIds = Array.isArray(task?.conflictsWithTaskIds)
      ? task.conflictsWithTaskIds.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    const nowEpoch = Date.parse(String(nowIso || ""));
    const dueEpoch = Date.parse(String(dueAtIso || ""));
    const isOverdue = Number.isFinite(nowEpoch) && Number.isFinite(dueEpoch) && dueEpoch < nowEpoch;

    Object.assign(agendaItem, {
      ownerId: String(task?.ownerId || "").trim() || null,
      priority: normalizeTaskPriority(task?.priority),
      workflowState,
      recurrenceEnabled: Boolean(task?.recurrence?.enabled),
      dependencyCount: dependencyIds.length,
      blockingDependencyCount: blockingDependencyIds.length,
      hasDependencyBlock: blockingDependencyIds.length > 0,
      conflictCount: conflictIds.length,
      hasConflict: conflictIds.length > 0,
      overdue: isOverdue,
      moduleKey: normalizeTaskModuleKey(task?.moduleKey, "community"),
    });

    if (isSameDay || dueAtDate.getTime() < nowDate.getTime()) {
      today.push(agendaItem);
      return;
    }
    upcoming.push(agendaItem);
  });

  const todaySorted = applyAgendaFiltersAndSort(today, {
    filters,
    sortBy,
    sortDirection,
    limit: todayLimit,
  });

  const upcomingSorted = applyAgendaFiltersAndSort(upcoming, {
    filters,
    sortBy,
    sortDirection,
    limit: upcomingLimit,
  });

  return {
    householdId,
    generatedAt: nowIso,
    metrics: {
      todayCount: todaySorted.length,
      upcomingCount: upcomingSorted.length,
      unreadNotifications: unreadNotifications.length,
      activeAssignments: assignmentRows.length,
    },
    today: todaySorted,
    upcoming: upcomingSorted,
  };
}

function toTrimmedString(value) {
  return String(value || "").trim();
}

function extractMentionHandles(input) {
  const text = String(input || "");
  const matches = text.match(/(^|\s)@([a-zA-Z0-9_.-]{2,32})/g) || [];
  const unique = new Set();
  for (const token of matches) {
    const handle = String(token).trim().replace(/^@/, "").replace(/^\s*@/, "").trim();
    if (handle) unique.add(handle.toLowerCase());
  }
  return Array.from(unique);
}

function buildFeedCommentEntry({ body, actor, nowIso, parentCommentId = null }) {
  const text = String(body || "").trim();
  return {
    id: generateHomesteadId("feed-comment"),
    body: text,
    createdAt: nowIso,
    updatedAt: nowIso,
    parentCommentId: parentCommentId ? String(parentCommentId) : null,
    mentions: extractMentionHandles(text),
    actor: {
      id: String(actor || "household-user"),
      name: String(actor || "household-user"),
    },
    author: actor,
  };
}

function normalizeCommentThreadEntries(rawThread) {
  if (!Array.isArray(rawThread)) return [];
  return rawThread.map((entry) => {
    const item = entry && typeof entry === "object" ? entry : {};
    const actorId = toTrimmedString(item.actor?.id || item.author || "household-user");
    const actorName = toTrimmedString(item.actor?.name || item.author || actorId || "household-user");
    return {
      id: toTrimmedString(item.id || generateHomesteadId("feed-comment")),
      body: toTrimmedString(item.body),
      createdAt: toTrimmedString(item.createdAt || new Date().toISOString()),
      updatedAt: toTrimmedString(item.updatedAt || item.createdAt || new Date().toISOString()),
      parentCommentId: item.parentCommentId ? toTrimmedString(item.parentCommentId) : null,
      mentions: Array.isArray(item.mentions)
        ? item.mentions.map((value) => toTrimmedString(value).toLowerCase()).filter(Boolean)
        : extractMentionHandles(item.body),
      actor: {
        id: actorId || "household-user",
        name: actorName || "household-user",
      },
      author: toTrimmedString(item.author || actorName || "household-user"),
    };
  });
}

function buildThreadedCommentView(comments) {
  const rows = normalizeCommentThreadEntries(comments);
  const byParent = new Map();
  for (const row of rows) {
    const key = row.parentCommentId || "ROOT";
    const current = byParent.get(key) || [];
    current.push({ ...row, replies: [] });
    byParent.set(key, current);
  }

  const attach = (parentId) => {
    const nodes = byParent.get(parentId) || [];
    return nodes.map((node) => ({
      ...node,
      replies: attach(node.id),
    }));
  };

  return attach("ROOT");
}

function buildMentionProfileHref(handle) {
  const safe = toTrimmedString(handle).toLowerCase();
  return `/settings/profile?handle=${encodeURIComponent(safe)}`;
}

async function appendMentionNotificationsForHousehold({
  householdId,
  moduleKey,
  sourceId,
  comment,
  actor,
  nowIso,
}) {
  const entries = buildRoutedMentionNotificationEntries({
    moduleKey,
    sourceId,
    comment,
    actor,
    nowIso,
    idFactory: generateHomesteadId,
    profileHrefBuilder: buildMentionProfileHref,
  });
  if (!entries.length) return [];

  const { state, householdState } = await getCommunityContextForHousehold(householdId);
  appendHouseholdNotifications({ householdState, entries, nowIso });
  state.households[householdId] = householdState;
  await writeCommunityContextStateFile(state);
  return entries;
}

function normalizeCommentThreadMap(raw) {
  return raw && typeof raw === "object" ? { ...raw } : {};
}

function normalizeDiscoveryHandle(value) {
  return toTrimmedString(value)
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 32);
}

function buildProfileHrefFromHandle(handle) {
  return `/settings/profile?handle=${encodeURIComponent(normalizeDiscoveryHandle(handle))}`;
}

function collectCommunityDiscoveryProfiles({ householdId, query = "" }) {
  const normalizedQuery = normalizeDiscoveryHandle(query);
  const rows = [];
  const seen = new Set();

  const push = (rawHandle, rawName, source) => {
    const handle = normalizeDiscoveryHandle(rawHandle || rawName);
    if (!handle || seen.has(handle)) return;
    if (normalizedQuery && !handle.includes(normalizedQuery) && !String(rawName || "").toLowerCase().includes(normalizedQuery)) {
      return;
    }
    seen.add(handle);
    rows.push({
      id: `profile-${handle}`,
      handle,
      displayName: toTrimmedString(rawName || rawHandle || handle) || handle,
      href: buildProfileHrefFromHandle(handle),
      source,
      householdId,
    });
  };

  const wellKnown = ["meal", "storehouse", "homestead", "community"];
  wellKnown.forEach((name) => push(name, name, "well_known"));

  return { push, rows };
}

function loadPlannerIntegrationService() {
  try {
    return require("../services/planners/PlannerIntegrationService");
  } catch {
    return {};
  }
}

function loadPlannerProjectionSync() {
  try {
    return require("../services/planners/PlannerProjectionSync");
  } catch {
    return {};
  }
}

function loadMealPlannerOrchestrationService() {
  try {
    return require("../services/planners/MealPlannerOrchestrationService");
  } catch {
    return {};
  }
}

function loadOperationalReadinessService() {
  try {
    return require("../services/planners/HouseholdOperationalReadinessService");
  } catch {
    return {};
  }
}

function loadOperationalOutboxService() {
  try {
    return require("../services/planners/OperationalOutboxService");
  } catch {
    return {};
  }
}

function loadOperationalProjectionWorker() {
  try {
    return require("../services/planners/OperationalProjectionWorker");
  } catch {
    return {};
  }
}

function withAsyncTimeout(promise, timeoutMs, fallbackValue) {
  const safeTimeout = Math.max(250, Number(timeoutMs || 5000));
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallbackValue), safeTimeout);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function loadOperationalOutboxObservability() {
  try {
    return require("../services/planners/OperationalOutboxObservability");
  } catch {
    return {};
  }
}

function loadHouseholdPlanningIntelligenceService() {
  try {
    return require("../services/planners/HouseholdPlanningIntelligenceService");
  } catch {
    return {};
  }
}

function loadHouseholdAutomationRecommendationModel() {
  try {
    return require("../db/models/HouseholdAutomationRecommendation");
  } catch {
    return {};
  }
}

const router = express.Router();

router.use(authenticateRequest);
router.use(requireHouseholdAccessPolicy());
router.use(requireCollaborationPolicy({ moduleKey: "planners" }));
router.use(requireEntitlementPolicy({ feature: "planner.base" }));

router.get("/meal", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { getMealPlannerSnapshot } = loadPlannerIntegrationService();
    if (typeof getMealPlannerSnapshot !== "function") {
      return res.json({ ok: true, snapshot: null, meals: [], preservationTasks: [] });
    }
    const snapshot = await getMealPlannerSnapshot(householdId);
    return res.json({ ok: true, snapshot, meals: snapshot?.planner_output?.meals || [], preservationTasks: snapshot?.planner_output?.preservationTasks || [] });
  } catch (error) {
    if (isLocalDevRequest(req)) {
      return res.json({
        ok: true,
        snapshot: null,
        meals: [],
        preservationTasks: [],
        warnings: [`meal_snapshot_dev_fallback:${String(error?.message || error)}`],
      });
    }
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/meal", express.json(), async (req, res) => {
  try {
    const {
      ensureMongoConnected,
      saveMealPlannerOutput,
      persistMealPlannerFanoutContracts,
    } = loadPlannerIntegrationService();
    const { orchestrateMealPlanFanout } = loadMealPlannerOrchestrationService();
    const { syncMealPlannerFanoutContracts } = loadPlannerProjectionSync();
    const warnings = [];
    if (typeof saveMealPlannerOutput !== "function") {
      return res.status(503).json({ ok: false, error: "planner_integration_unavailable" });
    }
    if (typeof ensureMongoConnected === "function") {
      try {
        await ensureMongoConnected();
      } catch (error) {
        warnings.push(`mongo_connect_failed:${String(error?.message || error || "unknown")}`);
      }
    }
    const payload = req.body || {};
    const out = await saveMealPlannerOutput(payload);

    let orchestration = {
      ok: false,
      skipped: true,
      reason: "meal_planner_orchestration_unavailable",
    };

    if (typeof orchestrateMealPlanFanout === "function") {
      orchestration = await orchestrateMealPlanFanout({
        mealPayload: payload,
        mealSaveResult: {
          id: out.id || payload.id,
          householdId: payload.householdId,
        },
        persistContracts:
          typeof persistMealPlannerFanoutContracts === "function"
            ? ({ mealPlanId, householdId, contracts }) =>
                persistMealPlannerFanoutContracts({
                  mealPlanId,
                  householdId,
                  contracts,
                  updatedBy: String(payload.updatedBy || payload.userId || "mealplanner:backendOrchestration"),
                  changeReason: "meal_plan_backend_fanout",
                })
            : null,
        syncProjection:
          typeof syncMealPlannerFanoutContracts === "function"
            ? (args) => syncMealPlannerFanoutContracts(args)
            : null,
      });
    }

    return res.json({ ok: true, ...out, orchestration, warnings });
  } catch (error) {
    if (isLocalDevRequest(req)) {
      const payload = req.body || {};
      const fallbackMealId = String(payload.id || `meal-dev-${Date.now()}`);
      const fallbackHouseholdId = String(
        payload.householdId || req.query?.householdId || "default-household"
      );

      let orchestration = {
        ok: false,
        skipped: true,
        reason: "meal_planner_orchestration_dev_fallback",
      };

      try {
        const { orchestrateMealPlanFanout } = loadMealPlannerOrchestrationService();
        const { syncMealPlannerFanoutContracts } = loadPlannerProjectionSync();

        if (typeof orchestrateMealPlanFanout === "function") {
          orchestration = await orchestrateMealPlanFanout({
            mealPayload: {
              ...payload,
              id: fallbackMealId,
              householdId: fallbackHouseholdId,
            },
            mealSaveResult: {
              id: fallbackMealId,
              householdId: fallbackHouseholdId,
            },
            persistContracts: ({ mealPlanId, householdId, contracts }) => {
              const safeContracts = Array.isArray(contracts) ? contracts : [];
              return {
                ok: true,
                queuedCount: safeContracts.length,
                queuedContracts: safeContracts.map((item) => ({
                  mealPlanId,
                  householdId,
                  eventType: item?.eventType || "planner.contract",
                  status: "queued",
                })),
              };
            },
            syncProjection:
              typeof syncMealPlannerFanoutContracts === "function"
                ? (args) => syncMealPlannerFanoutContracts(args)
                : null,
          });
        }
      } catch (orchestrationError) {
        orchestration = {
          ok: false,
          skipped: true,
          reason: `meal_planner_orchestration_dev_fallback_failed:${String(
            orchestrationError?.message || orchestrationError
          )}`,
        };
      }

      return res.json({
        ok: true,
        id: fallbackMealId,
        householdId: fallbackHouseholdId,
        orchestration,
        warnings: [`meal_save_dev_fallback:${String(error?.message || error)}`],
      });
    }
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/meal/context", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { context } = await getMealContextForHousehold(householdId);
    return res.json({ ok: true, householdId, ...context });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/meal/context/alerts/:id/dismiss", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const alertId = String(req.params.id || "").trim();
    if (!alertId) {
      return res.status(400).json({ ok: false, error: "missing_alert_id" });
    }

    const dismiss = req.body?.dismiss !== false;
    const updatedBy = resolveMealContextActor(req, req.body || {});
    const actionAt = new Date().toISOString();
    const { state, householdState } = await getMealContextForHousehold(householdId);
    const dismissedSet = new Set(
      Array.isArray(householdState.dismissedAlertIds)
        ? householdState.dismissedAlertIds
        : []
    );
    if (dismiss) dismissedSet.add(alertId);
    else dismissedSet.delete(alertId);

    const alertAudit =
      householdState.alertAudit && typeof householdState.alertAudit === "object"
        ? { ...householdState.alertAudit }
        : {};
    const currentAudit =
      alertAudit[alertId] && typeof alertAudit[alertId] === "object"
        ? { ...alertAudit[alertId] }
        : {};
    const actionLog = appendMealContextActionLog(currentAudit.actionLog, {
      action: dismiss ? "dismiss" : "undismiss",
      at: actionAt,
      updatedBy,
    });
    alertAudit[alertId] = {
      updatedBy,
      lastAction: dismiss ? "dismiss" : "undismiss",
      lastActionAt: actionAt,
      actionLog,
    };

    const nextHouseholdState = {
      ...householdState,
      dismissedAlertIds: Array.from(dismissedSet),
      postStats:
        householdState.postStats && typeof householdState.postStats === "object"
          ? householdState.postStats
          : {},
      alertAudit,
      feedAudit:
        householdState.feedAudit && typeof householdState.feedAudit === "object"
          ? householdState.feedAudit
          : {},
      updatedAt: new Date().toISOString(),
    };

    state.households[householdId] = nextHouseholdState;
    await writeMealContextStateFile(state);
    const context = mergeMealContextWithState(nextHouseholdState);
    return res.json({ ok: true, householdId, ...context });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/meal/context/feed/:id/action", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const postId = String(req.params.id || "").trim();
    if (!postId) {
      return res.status(400).json({ ok: false, error: "missing_post_id" });
    }

    const action = String(req.body?.action || "").toLowerCase();
    const actionToKey = {
      like: "likes",
      comment: "comments",
      share: "shares",
    };
    const statKey = actionToKey[action];
    if (!statKey) {
      return res.status(400).json({ ok: false, error: "unsupported_action" });
    }

    const deltaRaw = Number(req.body?.delta);
    const delta = Number.isFinite(deltaRaw) && deltaRaw !== 0 ? deltaRaw : 1;
    const updatedBy = resolveMealContextActor(req, req.body || {});
    const actionAt = new Date().toISOString();

    const { state, householdState } = await getMealContextForHousehold(householdId);
    const postStats =
      householdState.postStats && typeof householdState.postStats === "object"
        ? { ...householdState.postStats }
        : {};
    const current =
      postStats[postId] && typeof postStats[postId] === "object"
        ? { ...postStats[postId] }
        : {};

    const nextValue = Math.max(0, Number(current[statKey] || 0) + delta);
    current[statKey] = nextValue;
    postStats[postId] = current;

    const feedAudit =
      householdState.feedAudit && typeof householdState.feedAudit === "object"
        ? { ...householdState.feedAudit }
        : {};
    const currentAudit =
      feedAudit[postId] && typeof feedAudit[postId] === "object"
        ? { ...feedAudit[postId] }
        : {};
    const actionLog = appendMealContextActionLog(currentAudit.actionLog, {
      action,
      delta,
      at: actionAt,
      updatedBy,
    });
    feedAudit[postId] = {
      updatedBy,
      lastAction: action,
      lastActionAt: actionAt,
      actionLog,
    };

    const nextHouseholdState = {
      ...householdState,
      dismissedAlertIds: Array.isArray(householdState.dismissedAlertIds)
        ? householdState.dismissedAlertIds
        : [],
      postStats,
      alertAudit:
        householdState.alertAudit && typeof householdState.alertAudit === "object"
          ? householdState.alertAudit
          : {},
      feedAudit,
      updatedAt: new Date().toISOString(),
    };

    state.households[householdId] = nextHouseholdState;
    await writeMealContextStateFile(state);

    // Slice B bridge: promote share activity into homestead collaboration feed.
    if (action === "share") {
      try {
        await mirrorMealShareToHomesteadFeed({
          householdId,
          postId,
          actor: updatedBy,
          actionAt,
        });
      } catch {
        // Do not fail meal context action path if cross-module mirror fails.
      }
    }

    const context = mergeMealContextWithState(nextHouseholdState);
    const updatedPost = context.feed.find((item) => item.id === postId) || null;
    return res.json({ ok: true, householdId, updatedPost, ...context });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/storehouse", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { getStorehousePlannerSnapshot } = loadPlannerIntegrationService();
    if (typeof getStorehousePlannerSnapshot !== "function") {
      return res.json({
        ok: true,
        householdId,
        inventory: [],
        summary: { totalItems: 0, preservedItems: 0, lowStockItems: 0 },
        warnings: ["planner_integration_unavailable"],
      });
    }

    const snapshot = await getStorehousePlannerSnapshot(householdId);
    return res.json({
      ok: true,
      householdId,
      inventory: Array.isArray(snapshot?.inventory) ? snapshot.inventory : [],
      summary: snapshot?.summary || { totalItems: 0, preservedItems: 0, lowStockItems: 0 },
      warnings: Array.isArray(snapshot?.warnings) ? snapshot.warnings : [],
    });
  } catch (error) {
    if (isLocalDevRequest(req)) {
      const householdId = String(req.query.householdId || "default-household");
      return res.json({
        ok: true,
        householdId,
        inventory: [],
        summary: { totalItems: 0, preservedItems: 0, lowStockItems: 0 },
        warnings: [`storehouse_snapshot_dev_fallback:${String(error?.message || error)}`],
      });
    }
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/storehouse/context", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { context } = await getStorehouseContextForHousehold(householdId);
    return res.json({ ok: true, householdId, ...context });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/storehouse/context/alerts/:id/dismiss", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const alertId = String(req.params.id || "").trim();
    if (!alertId) {
      return res.status(400).json({ ok: false, error: "missing_alert_id" });
    }

    const dismiss = req.body?.dismiss !== false;
    const updatedBy = resolveStorehouseContextActor(req, req.body || {});
    const actionAt = new Date().toISOString();
    const { state, householdState } = await getStorehouseContextForHousehold(householdId);
    const dismissedSet = new Set(
      Array.isArray(householdState.dismissedAlertIds)
        ? householdState.dismissedAlertIds
        : []
    );
    if (dismiss) dismissedSet.add(alertId);
    else dismissedSet.delete(alertId);

    const alertAudit =
      householdState.alertAudit && typeof householdState.alertAudit === "object"
        ? { ...householdState.alertAudit }
        : {};
    const currentAudit =
      alertAudit[alertId] && typeof alertAudit[alertId] === "object"
        ? { ...alertAudit[alertId] }
        : {};
    const actionLog = appendStorehouseActionLog(currentAudit.actionLog, {
      action: dismiss ? "dismiss" : "undismiss",
      at: actionAt,
      updatedBy,
    });
    alertAudit[alertId] = {
      updatedBy,
      lastAction: dismiss ? "dismiss" : "undismiss",
      lastActionAt: actionAt,
      actionLog,
    };

    const nextHouseholdState = {
      ...householdState,
      dismissedAlertIds: Array.from(dismissedSet),
      postStats:
        householdState.postStats && typeof householdState.postStats === "object"
          ? householdState.postStats
          : {},
      alertAudit,
      feedAudit:
        householdState.feedAudit && typeof householdState.feedAudit === "object"
          ? householdState.feedAudit
          : {},
      updatedAt: new Date().toISOString(),
    };

    state.households[householdId] = nextHouseholdState;
    await writeStorehouseContextStateFile(state);
    const context = mergeStorehouseContextWithState(nextHouseholdState);
    return res.json({ ok: true, householdId, ...context });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/storehouse/context/feed/:id/action", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const postId = String(req.params.id || "").trim();
    if (!postId) {
      return res.status(400).json({ ok: false, error: "missing_post_id" });
    }

    const action = String(req.body?.action || "").toLowerCase();
    const actionToKey = {
      like: "likes",
      comment: "comments",
      share: "shares",
    };
    const statKey = actionToKey[action];
    if (!statKey) {
      return res.status(400).json({ ok: false, error: "unsupported_action" });
    }

    const deltaRaw = Number(req.body?.delta);
    const delta = Number.isFinite(deltaRaw) && deltaRaw !== 0 ? deltaRaw : 1;
    const updatedBy = resolveStorehouseContextActor(req, req.body || {});
    const actionAt = new Date().toISOString();

    const { state, householdState } = await getStorehouseContextForHousehold(householdId);
    const postStats =
      householdState.postStats && typeof householdState.postStats === "object"
        ? { ...householdState.postStats }
        : {};
    const current =
      postStats[postId] && typeof postStats[postId] === "object"
        ? { ...postStats[postId] }
        : {};

    const nextValue = Math.max(0, Number(current[statKey] || 0) + delta);
    current[statKey] = nextValue;
    postStats[postId] = current;

    const feedAudit =
      householdState.feedAudit && typeof householdState.feedAudit === "object"
        ? { ...householdState.feedAudit }
        : {};
    const currentAudit =
      feedAudit[postId] && typeof feedAudit[postId] === "object"
        ? { ...feedAudit[postId] }
        : {};
    const actionLog = appendStorehouseActionLog(currentAudit.actionLog, {
      action,
      delta,
      at: actionAt,
      updatedBy,
    });
    feedAudit[postId] = {
      updatedBy,
      lastAction: action,
      lastActionAt: actionAt,
      actionLog,
    };

    const nextHouseholdState = {
      ...householdState,
      dismissedAlertIds: Array.isArray(householdState.dismissedAlertIds)
        ? householdState.dismissedAlertIds
        : [],
      postStats,
      alertAudit:
        householdState.alertAudit && typeof householdState.alertAudit === "object"
          ? householdState.alertAudit
          : {},
      feedAudit,
      updatedAt: new Date().toISOString(),
    };

    state.households[householdId] = nextHouseholdState;
    await writeStorehouseContextStateFile(state);

    const context = mergeStorehouseContextWithState(nextHouseholdState);
    const updatedPost = context.feed.find((item) => item.id === postId) || null;
    return res.json({ ok: true, householdId, updatedPost, ...context });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/storehouse/inventory", express.json(), async (req, res) => {
  try {
    const { upsertStorehouseInventory } = loadPlannerIntegrationService();
    const { syncStorehouseUpdate } = loadPlannerProjectionSync();
    if (typeof upsertStorehouseInventory !== "function") {
      return res.status(503).json({ ok: false, error: "planner_integration_unavailable" });
    }
    if (typeof syncStorehouseUpdate !== "function") {
      return res.status(503).json({ ok: false, error: "planner_projection_unavailable" });
    }
    const payload = req.body || {};
    const upsert = await upsertStorehouseInventory(payload);
    const projection = await syncStorehouseUpdate({
      payload,
      upsert,
      queuedJob: upsert.projectionQueue,
    });
    return res.json({ ok: true, upsert, projection });
  } catch (error) {
    if (isLocalDevRequest(req)) {
      const payload = req.body || {};
      return res.json({
        ok: true,
        upsert: {
          householdId: String(payload.householdId || req.query?.householdId || "default-household"),
          inventory: Array.isArray(payload.inventory) ? payload.inventory : [],
          mode: "dev-fallback",
        },
        projection: {
          ok: false,
          skipped: true,
          reason: "planner_projection_dev_fallback",
        },
        warnings: [`storehouse_upsert_dev_fallback:${String(error?.message || error)}`],
      });
    }
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { getHomesteadPlannerSnapshot } = loadPlannerIntegrationService();
    if (typeof getHomesteadPlannerSnapshot !== "function") {
      return res.json({
        ok: true,
        householdId,
        planId: null,
        seasonKey: null,
        gardenTasks: [],
        animalPlan: {},
        outputs: [],
        preservationForecast: {
          totalOutputs: 0,
          preservationReadyCount: 0,
          preservationReadyQty: 0,
        },
        warnings: ["planner_integration_unavailable"],
      });
    }

    const snapshot = await getHomesteadPlannerSnapshot(householdId);
    return res.json({
      ok: true,
      householdId,
      planId: snapshot?.planId || null,
      seasonKey: snapshot?.seasonKey || null,
      gardenTasks: Array.isArray(snapshot?.gardenTasks) ? snapshot.gardenTasks : [],
      animalPlan: snapshot?.animalPlan || {},
      outputs: Array.isArray(snapshot?.outputs) ? snapshot.outputs : [],
      preservationForecast: snapshot?.preservationForecast || {
        totalOutputs: 0,
        preservationReadyCount: 0,
        preservationReadyQty: 0,
      },
      warnings: Array.isArray(snapshot?.warnings) ? snapshot.warnings : [],
    });
  } catch (error) {
    if (isLocalDevRequest(req)) {
      const householdId = String(req.query.householdId || "default-household");
      return res.json({
        ok: true,
        householdId,
        planId: null,
        seasonKey: null,
        gardenTasks: [],
        animalPlan: {},
        outputs: [],
        preservationForecast: {
          totalOutputs: 0,
          preservationReadyCount: 0,
          preservationReadyQty: 0,
        },
        warnings: [`homestead_snapshot_dev_fallback:${String(error?.message || error)}`],
      });
    }
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead", express.json(), async (req, res) => {
  try {
    const { upsertHomesteadPlan, getHomesteadPlannerSnapshot } = loadPlannerIntegrationService();
    const { syncHomesteadUpdate } = loadPlannerProjectionSync();
    if (
      typeof upsertHomesteadPlan !== "function" ||
      typeof getHomesteadPlannerSnapshot !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "planner_integration_unavailable" });
    }
    if (typeof syncHomesteadUpdate !== "function") {
      return res.status(503).json({ ok: false, error: "planner_projection_unavailable" });
    }

    const payload = req.body || {};
    const saved = await upsertHomesteadPlan(payload);
    const snapshot = await getHomesteadPlannerSnapshot(saved.householdId);
    const projection = await syncHomesteadUpdate({
      payload,
      saved,
      snapshot,
    });
    return res.json({ ok: true, saved, snapshot, projection });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/targets", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({
      ok: true,
      householdId,
      targets: householdState.targets,
      updatedAt: householdState.updatedAt || null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/targets", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const payload = req.body?.target && typeof req.body.target === "object" ? req.body.target : req.body || {};
    const now = new Date().toISOString();
    const targetId = String(payload.id || generateHomesteadId("target"));
    const nextTarget = {
      ...payload,
      id: targetId,
      householdId,
      updatedBy: actor,
      createdAt: String(payload.createdAt || now),
      updatedAt: now,
    };

    const existingIndex = householdState.targets.findIndex((item) => String(item.id) === targetId);
    if (existingIndex >= 0) {
      householdState.targets[existingIndex] = {
        ...householdState.targets[existingIndex],
        ...nextTarget,
      };
    } else {
      householdState.targets.push(nextTarget);
    }

    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);

    return res.json({ ok: true, householdId, target: nextTarget, targets: householdState.targets });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.delete("/homestead/targets/:id", async (req, res) => {
  try {
    const householdId = String(req.query?.householdId || req.body?.householdId || "default-household");
    const targetId = String(req.params.id || "").trim();
    if (!targetId) {
      return res.status(400).json({ ok: false, error: "missing_target_id" });
    }
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    householdState.targets = householdState.targets.filter((item) => String(item.id) !== targetId);
    householdState.updatedAt = new Date().toISOString();
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, targets: householdState.targets });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/collaboration", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({ ok: true, householdId, collaboration: householdState.collaboration });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/collaboration/:kind", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const kind = String(req.params.kind || "").toLowerCase();
    const allowed = new Set(["needs", "offers", "assignments", "fulfillments"]);
    if (!allowed.has(kind)) {
      return res.status(400).json({ ok: false, error: "unsupported_collaboration_kind" });
    }
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const item = {
      ...(req.body?.item && typeof req.body.item === "object" ? req.body.item : req.body || {}),
      id: String(req.body?.item?.id || req.body?.id || generateHomesteadId(kind.slice(0, -1) || "item")),
      householdId,
      updatedBy: actor,
      updatedAt: now,
    };

    const list = householdState.collaboration[kind];
    const existingIndex = list.findIndex((entry) => String(entry.id) === item.id);
    if (existingIndex >= 0) {
      list[existingIndex] = { ...list[existingIndex], ...item };
    } else {
      list.push(item);
    }

    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, kind, item, collaboration: householdState.collaboration });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/collaboration/feed/:id/action", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const postId = String(req.params.id || "").trim();
    if (!postId) {
      return res.status(400).json({ ok: false, error: "missing_post_id" });
    }

    const action = String(req.body?.action || "").toLowerCase();
    const actionToKey = {
      like: "likes",
      coordinate: "coordinates",
      share_information: "shares",
      share: "shares",
    };
    const statKey = actionToKey[action];
    if (!statKey) {
      return res.status(400).json({ ok: false, error: "unsupported_action" });
    }

    const deltaRaw = Number(req.body?.delta);
    const delta = Number.isFinite(deltaRaw) && deltaRaw !== 0 ? deltaRaw : 1;
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();

    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    const feed = householdState.collaboration.feed;
    const index = feed.findIndex((item) => String(item.id) === postId);
    if (index < 0) {
      return res.status(404).json({ ok: false, error: "feed_item_not_found" });
    }

    const current = { ...feed[index] };
    const nextValue = Math.max(0, Number(current[statKey] || 0) + delta);
    const actionLog = appendHomesteadActionLog(current.actionLog, {
      action,
      delta,
      at: now,
      updatedBy: actor,
    });
    feed[index] = {
      ...current,
      [statKey]: nextValue,
      updatedBy: actor,
      lastAction: action,
      lastActionAt: now,
      actionLog,
    };

    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({
      ok: true,
      householdId,
      updatedPost: feed[index],
      collaboration: householdState.collaboration,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/feed/unified", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const requestedModules = normalizeRequestedFeedModules(req.query.modules);
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 40;
    const sorted = (await collectUnifiedFeedItemsForHousehold({ householdId, requestedModules })).slice(0, limit);
    return res.json({
      ok: true,
      householdId,
      modules: requestedModules,
      total: sorted.length,
      items: sorted,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/feed/unified/search", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const query = toTrimmedString(req.query.q || req.query.query || "").toLowerCase();
    const requestedModules = normalizeRequestedFeedModules(req.query.modules);
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 40;
    const feedResponse = await collectUnifiedFeedItemsForHousehold({ householdId, requestedModules });

    const filtered = query
      ? feedResponse.filter((item) => {
          const haystack = [
            item?.author,
            item?.content,
            item?.sourceModule,
            item?.sourceId,
          ]
            .map((value) => toTrimmedString(value).toLowerCase())
            .join(" ");
          return haystack.includes(query);
        })
      : feedResponse;

    return res.json({
      ok: true,
      householdId,
      query,
      total: filtered.length,
      items: filtered.slice(0, limit),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/household/today-upcoming", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const requestedModules = normalizeRequestedFeedModules(req.query.modules);
    const filters = normalizeAgendaFilters({
      person: req.query.person,
      module: req.query.module,
      priority: req.query.priority,
      status: req.query.status,
    });
    const sortBy = normalizeAgendaSortBy(req.query.sortBy);
    const sortDirection = normalizeAgendaSortDirection(req.query.sortDirection);
    const todayLimitRaw = Number(req.query.todayLimit);
    const upcomingLimitRaw = Number(req.query.upcomingLimit);
    const todayLimit = Number.isFinite(todayLimitRaw) && todayLimitRaw > 0
      ? Math.min(todayLimitRaw, 100)
      : 16;
    const upcomingLimit = Number.isFinite(upcomingLimitRaw) && upcomingLimitRaw > 0
      ? Math.min(upcomingLimitRaw, 100)
      : 16;

    const nowIso = new Date().toISOString();
    const [{ context: mealContext }, { context: storehouseContext }, { householdState: homesteadState }, { householdState: communityState }, unifiedFeedItems] = await Promise.all([
      getMealContextForHousehold(householdId),
      getStorehouseContextForHousehold(householdId),
      getHomesteadContextForHousehold(householdId),
      getCommunityContextForHousehold(householdId),
      collectUnifiedFeedItemsForHousehold({ householdId, requestedModules }),
    ]);

    const payload = buildTodayAndUpcomingAgenda({
      householdId,
      nowIso,
      mealContext,
      storehouseContext,
      homesteadState,
      communityState,
      unifiedFeedItems,
      todayLimit,
      upcomingLimit,
      filters,
      sortBy,
      sortDirection,
    });

    return res.json({
      ok: true,
      householdId,
      modules: requestedModules,
      applied: {
        filters: {
          person: String(filters?.ownerId || ""),
          module: String(filters?.moduleKey || ""),
          priority: String(filters?.priority || ""),
          status: String(filters?.workflowState || ""),
        },
        sortBy,
        sortDirection,
        limits: {
          today: todayLimit,
          upcoming: upcomingLimit,
        },
      },
      ...payload,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/feed/unified/:module/:id/reaction", express.json(), async (req, res) => {
  try {
    const moduleKey = toTrimmedString(req.params.module).toLowerCase();
    const sourceId = toTrimmedString(req.params.id);
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const action = toTrimmedString(req.body?.action).toLowerCase();
    const deltaRaw = Number(req.body?.delta);
    const delta = Number.isFinite(deltaRaw) && deltaRaw !== 0 ? deltaRaw : 1;
    const nowIso = new Date().toISOString();

    if (!UNIFIED_FEED_MODULES.has(moduleKey)) {
      return res.status(400).json({ ok: false, error: "unsupported_module" });
    }
    if (!sourceId) {
      return res.status(400).json({ ok: false, error: "missing_feed_id" });
    }

    if (moduleKey === "meal" || moduleKey === "storehouse") {
      const actionToKey = { like: "likes", comment: "comments", share: "shares" };
      const statKey = actionToKey[action];
      if (!statKey) {
        return res.status(400).json({ ok: false, error: "unsupported_action" });
      }

      const actor =
        moduleKey === "meal"
          ? resolveMealContextActor(req, req.body || {})
          : resolveStorehouseContextActor(req, req.body || {});

      const getter = moduleKey === "meal" ? getMealContextForHousehold : getStorehouseContextForHousehold;
      const writer = moduleKey === "meal" ? writeMealContextStateFile : writeStorehouseContextStateFile;
      const merger = moduleKey === "meal" ? mergeMealContextWithState : mergeStorehouseContextWithState;
      const appendLog =
        moduleKey === "meal" ? appendMealContextActionLog : appendStorehouseActionLog;

      const { state, householdState } = await getter(householdId);
      const postStats =
        householdState.postStats && typeof householdState.postStats === "object"
          ? { ...householdState.postStats }
          : {};
      const current =
        postStats[sourceId] && typeof postStats[sourceId] === "object"
          ? { ...postStats[sourceId] }
          : {};

      current[statKey] = Math.max(0, Number(current[statKey] || 0) + delta);
      postStats[sourceId] = current;

      const feedAudit =
        householdState.feedAudit && typeof householdState.feedAudit === "object"
          ? { ...householdState.feedAudit }
          : {};
      const currentAudit =
        feedAudit[sourceId] && typeof feedAudit[sourceId] === "object"
          ? { ...feedAudit[sourceId] }
          : {};
      const actionLog = appendLog(currentAudit.actionLog, {
        action,
        delta,
        at: nowIso,
        updatedBy: actor,
      });
      feedAudit[sourceId] = {
        updatedBy: actor,
        lastAction: action,
        lastActionAt: nowIso,
        actionLog,
      };

      const nextHouseholdState = {
        ...householdState,
        dismissedAlertIds: Array.isArray(householdState.dismissedAlertIds)
          ? householdState.dismissedAlertIds
          : [],
        postStats,
        commentThreads: normalizeCommentThreadMap(householdState.commentThreads),
        alertAudit:
          householdState.alertAudit && typeof householdState.alertAudit === "object"
            ? householdState.alertAudit
            : {},
        feedAudit,
        updatedAt: nowIso,
      };

      state.households[householdId] = nextHouseholdState;
      await writer(state);
      const context = merger(nextHouseholdState);
      const updatedPost = context.feed.find((item) => item.id === sourceId) || null;
      const updatedItem = normalizeUnifiedFeedItem(updatedPost || {}, moduleKey, householdId);
      const event = buildUnifiedFeedMutationEvent({
        householdId,
        moduleKey,
        sourceId,
        mutationType: "reaction",
        action,
        delta,
        actor,
        at: nowIso,
        updatedItem,
      });
      return res.json(
        buildUnifiedFeedMutationResponse({
          householdId,
          moduleKey,
          updatedItem,
          event,
        })
      );
    }

    if (moduleKey === "homestead") {
      const actionToKey = {
        like: "likes",
        coordinate: "coordinates",
        share_information: "shares",
        share: "shares",
      };
      const statKey = actionToKey[action];
      if (!statKey) {
        return res.status(400).json({ ok: false, error: "unsupported_action" });
      }

      const actor = resolveHomesteadContextActor(req, req.body || {});
      const { state, householdState } = await getHomesteadContextForHousehold(householdId);
      const feed = householdState.collaboration.feed;
      const index = feed.findIndex((item) => String(item.id) === sourceId);
      if (index < 0) {
        return res.status(404).json({ ok: false, error: "feed_item_not_found" });
      }

      const current = { ...feed[index] };
      const nextValue = Math.max(0, Number(current[statKey] || 0) + delta);
      const actionLog = appendHomesteadActionLog(current.actionLog, {
        action,
        delta,
        at: nowIso,
        updatedBy: actor,
      });
      feed[index] = {
        ...current,
        [statKey]: nextValue,
        updatedBy: actor,
        lastAction: action,
        lastActionAt: nowIso,
        actionLog,
      };

      householdState.updatedAt = nowIso;
      state.households[householdId] = householdState;
      await writeHomesteadContextStateFile(state);
      const updatedItem = normalizeUnifiedFeedItem(feed[index], moduleKey, householdId);
      const event = buildUnifiedFeedMutationEvent({
        householdId,
        moduleKey,
        sourceId,
        mutationType: "reaction",
        action,
        delta,
        actor,
        at: nowIso,
        updatedItem,
      });
      return res.json(
        buildUnifiedFeedMutationResponse({
          householdId,
          moduleKey,
          updatedItem,
          event,
        })
      );
    }

    const actionToKey = { like: "likes", comment: "comments", share: "shares" };
    const statKey = actionToKey[action];
    if (!statKey) {
      return res.status(400).json({ ok: false, error: "unsupported_action" });
    }

    const actor = resolveHomesteadContextActor(req, req.body || {});
    const { state, householdState } = await getCommunityContextForHousehold(householdId);
    const feed = householdState.feed;
    const index = feed.findIndex((item) => String(item.id) === sourceId);
    if (index < 0) {
      return res.status(404).json({ ok: false, error: "feed_item_not_found" });
    }

    const current = { ...feed[index] };
    const nextValue = Math.max(0, Number(current[statKey] || 0) + delta);
    const actionLog = appendHomesteadActionLog(current.actionLog, {
      action,
      delta,
      at: nowIso,
      updatedBy: actor,
    });
    feed[index] = {
      ...current,
      [statKey]: nextValue,
      updatedBy: actor,
      lastAction: action,
      lastActionAt: nowIso,
      actionLog,
    };

    householdState.updatedAt = nowIso;
    state.households[householdId] = householdState;
    await writeCommunityContextStateFile(state);
    const updatedItem = normalizeUnifiedFeedItem(feed[index], moduleKey, householdId);
    const event = buildUnifiedFeedMutationEvent({
      householdId,
      moduleKey,
      sourceId,
      mutationType: "reaction",
      action,
      delta,
      actor,
      at: nowIso,
      updatedItem,
    });
    return res.json(
      buildUnifiedFeedMutationResponse({
        householdId,
        moduleKey,
        updatedItem,
        event,
      })
    );
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/feed/unified/:module/:id/semantic-action", express.json(), async (req, res) => {
  try {
    const moduleKey = toTrimmedString(req.params.module).toLowerCase();
    const sourceId = toTrimmedString(req.params.id);
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const actionType = toTrimmedString(req.body?.actionType).toLowerCase();
    const detail = toTrimmedString(req.body?.detail || "");
    const metadata = req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {};
    const nowIso = new Date().toISOString();

    if (!UNIFIED_FEED_MODULES.has(moduleKey)) {
      return res.status(400).json({ ok: false, error: "unsupported_module" });
    }
    if (!sourceId) {
      return res.status(400).json({ ok: false, error: "missing_feed_id" });
    }

    const allowedActionTypes = new Set(["handoff", "request_help", "acknowledge", "bookmark"]);
    if (!allowedActionTypes.has(actionType)) {
      return res.status(400).json({ ok: false, error: "unsupported_semantic_action" });
    }

    const actor =
      moduleKey === "meal"
        ? resolveMealContextActor(req, req.body || {})
        : moduleKey === "storehouse"
          ? resolveStorehouseContextActor(req, req.body || {})
          : resolveHomesteadContextActor(req, req.body || {});

    if (moduleKey === "meal" || moduleKey === "storehouse") {
      const getter = moduleKey === "meal" ? getMealContextForHousehold : getStorehouseContextForHousehold;
      const writer = moduleKey === "meal" ? writeMealContextStateFile : writeStorehouseContextStateFile;
      const merger = moduleKey === "meal" ? mergeMealContextWithState : mergeStorehouseContextWithState;
      const appendLog = moduleKey === "meal" ? appendMealContextActionLog : appendStorehouseActionLog;

      const { state, householdState } = await getter(householdId);
      const postStats =
        householdState.postStats && typeof householdState.postStats === "object"
          ? { ...householdState.postStats }
          : {};
      const current =
        postStats[sourceId] && typeof postStats[sourceId] === "object"
          ? { ...postStats[sourceId] }
          : {};
      const semanticActions =
        current.semanticActions && typeof current.semanticActions === "object"
          ? { ...current.semanticActions }
          : {};
      semanticActions[actionType] = Math.max(0, Number(semanticActions[actionType] || 0) + 1);
      current.semanticActions = semanticActions;
      postStats[sourceId] = current;

      const feedAudit =
        householdState.feedAudit && typeof householdState.feedAudit === "object"
          ? { ...householdState.feedAudit }
          : {};
      const currentAudit =
        feedAudit[sourceId] && typeof feedAudit[sourceId] === "object"
          ? { ...feedAudit[sourceId] }
          : {};
      const actionLog = appendLog(currentAudit.actionLog, {
        action: `semantic:${actionType}`,
        detail,
        metadata,
        at: nowIso,
        updatedBy: actor,
      });
      feedAudit[sourceId] = {
        updatedBy: actor,
        lastAction: `semantic:${actionType}`,
        lastActionAt: nowIso,
        actionLog,
      };

      const nextHouseholdState = {
        ...householdState,
        dismissedAlertIds: Array.isArray(householdState.dismissedAlertIds)
          ? householdState.dismissedAlertIds
          : [],
        postStats,
        commentThreads: normalizeCommentThreadMap(householdState.commentThreads),
        alertAudit:
          householdState.alertAudit && typeof householdState.alertAudit === "object"
            ? householdState.alertAudit
            : {},
        feedAudit,
        updatedAt: nowIso,
      };

      state.households[householdId] = nextHouseholdState;
      await writer(state);
      const context = merger(nextHouseholdState);
      const updatedPost = context.feed.find((item) => item.id === sourceId) || null;
      const updatedItem = normalizeUnifiedFeedItem(updatedPost || {}, moduleKey, householdId);
      const event = buildUnifiedFeedMutationEvent({
        householdId,
        moduleKey,
        sourceId,
        mutationType: "semantic_action",
        action: actionType,
        actor,
        at: nowIso,
        detail,
        metadata,
        updatedItem,
      });
      return res.json(
        buildUnifiedFeedMutationResponse({
          householdId,
          moduleKey,
          updatedItem,
          event,
          extra: {
            semanticAction: { actionType, detail, metadata, updatedBy: actor, updatedAt: nowIso },
          },
        })
      );
    }

    const getter = moduleKey === "homestead" ? getHomesteadContextForHousehold : getCommunityContextForHousehold;
    const writer = moduleKey === "homestead" ? writeHomesteadContextStateFile : writeCommunityContextStateFile;
    const { state, householdState } = await getter(householdId);
    const feed = moduleKey === "homestead" ? householdState.collaboration.feed : householdState.feed;
    const index = feed.findIndex((item) => String(item.id) === sourceId);
    if (index < 0) {
      return res.status(404).json({ ok: false, error: "feed_item_not_found" });
    }

    const current = { ...feed[index] };
    const semanticActions =
      current.semanticActions && typeof current.semanticActions === "object"
        ? { ...current.semanticActions }
        : {};
    semanticActions[actionType] = Math.max(0, Number(semanticActions[actionType] || 0) + 1);
    const actionLog = appendHomesteadActionLog(current.actionLog, {
      action: `semantic:${actionType}`,
      detail,
      metadata,
      at: nowIso,
      updatedBy: actor,
    });
    feed[index] = {
      ...current,
      semanticActions,
      updatedBy: actor,
      lastAction: `semantic:${actionType}`,
      lastActionAt: nowIso,
      actionLog,
    };

    householdState.updatedAt = nowIso;
    state.households[householdId] = householdState;
    await writer(state);
    const updatedItem = normalizeUnifiedFeedItem(feed[index], moduleKey, householdId);
    const event = buildUnifiedFeedMutationEvent({
      householdId,
      moduleKey,
      sourceId,
      mutationType: "semantic_action",
      action: actionType,
      actor,
      at: nowIso,
      detail,
      metadata,
      updatedItem,
    });
    return res.json(
      buildUnifiedFeedMutationResponse({
        householdId,
        moduleKey,
        updatedItem,
        event,
        extra: {
          semanticAction: { actionType, detail, metadata, updatedBy: actor, updatedAt: nowIso },
        },
      })
    );
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/feed/unified/:module/:id/comments", async (req, res) => {
  try {
    const moduleKey = toTrimmedString(req.params.module).toLowerCase();
    const sourceId = toTrimmedString(req.params.id);
    const householdId = String(req.query.householdId || "default-household");

    if (!UNIFIED_FEED_MODULES.has(moduleKey)) {
      return res.status(400).json({ ok: false, error: "unsupported_module" });
    }
    if (!sourceId) {
      return res.status(400).json({ ok: false, error: "missing_feed_id" });
    }

    let comments = [];
    if (moduleKey === "meal") {
      const { householdState } = await getMealContextForHousehold(householdId);
      const map = normalizeCommentThreadMap(householdState.commentThreads);
      comments = Array.isArray(map[sourceId]) ? map[sourceId] : [];
    } else if (moduleKey === "storehouse") {
      const { householdState } = await getStorehouseContextForHousehold(householdId);
      const map = normalizeCommentThreadMap(householdState.commentThreads);
      comments = Array.isArray(map[sourceId]) ? map[sourceId] : [];
    } else if (moduleKey === "homestead") {
      const { householdState } = await getHomesteadContextForHousehold(householdId);
      const map = normalizeCommentThreadMap(householdState.collaboration.commentThreads);
      comments = Array.isArray(map[sourceId]) ? map[sourceId] : [];
    } else {
      const { householdState } = await getCommunityContextForHousehold(householdId);
      const map = normalizeCommentThreadMap(householdState.commentThreads);
      comments = Array.isArray(map[sourceId]) ? map[sourceId] : [];
    }

    const normalizedComments = normalizeCommentThreadEntries(comments);
    return res.json({
      ok: true,
      householdId,
      module: moduleKey,
      sourceId,
      comments: normalizedComments,
      threadedComments: buildThreadedCommentView(normalizedComments),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/feed/unified/:module/:id/comments", express.json(), async (req, res) => {
  try {
    const moduleKey = toTrimmedString(req.params.module).toLowerCase();
    const sourceId = toTrimmedString(req.params.id);
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const body = toTrimmedString(req.body?.body || req.body?.comment);
    const parentCommentId = toTrimmedString(req.body?.parentCommentId);
    const nowIso = new Date().toISOString();

    if (!UNIFIED_FEED_MODULES.has(moduleKey)) {
      return res.status(400).json({ ok: false, error: "unsupported_module" });
    }
    if (!sourceId) {
      return res.status(400).json({ ok: false, error: "missing_feed_id" });
    }
    if (!body) {
      return res.status(400).json({ ok: false, error: "missing_comment_body" });
    }

    if (moduleKey === "meal" || moduleKey === "storehouse") {
      const actor =
        moduleKey === "meal"
          ? resolveMealContextActor(req, req.body || {})
          : resolveStorehouseContextActor(req, req.body || {});
      const getter = moduleKey === "meal" ? getMealContextForHousehold : getStorehouseContextForHousehold;
      const writer = moduleKey === "meal" ? writeMealContextStateFile : writeStorehouseContextStateFile;
      const merger = moduleKey === "meal" ? mergeMealContextWithState : mergeStorehouseContextWithState;
      const appendLog =
        moduleKey === "meal" ? appendMealContextActionLog : appendStorehouseActionLog;

      const { state, householdState } = await getter(householdId);
      const commentThreads = normalizeCommentThreadMap(householdState.commentThreads);
      const currentThread = normalizeCommentThreadEntries(commentThreads[sourceId]);
      if (parentCommentId && !currentThread.some((entry) => String(entry.id) === parentCommentId)) {
        return res.status(400).json({ ok: false, error: "comment_parent_not_found" });
      }

      const comment = buildFeedCommentEntry({ body, actor, nowIso, parentCommentId: parentCommentId || null });
      commentThreads[sourceId] = [...currentThread, comment];

      const postStats =
        householdState.postStats && typeof householdState.postStats === "object"
          ? { ...householdState.postStats }
          : {};
      const current =
        postStats[sourceId] && typeof postStats[sourceId] === "object"
          ? { ...postStats[sourceId] }
          : {};
      current.comments = Math.max(0, Number(current.comments || 0) + 1);
      postStats[sourceId] = current;

      const feedAudit =
        householdState.feedAudit && typeof householdState.feedAudit === "object"
          ? { ...householdState.feedAudit }
          : {};
      const currentAudit =
        feedAudit[sourceId] && typeof feedAudit[sourceId] === "object"
          ? { ...feedAudit[sourceId] }
          : {};
      const actionLog = appendLog(currentAudit.actionLog, {
        action: "thread_comment",
        delta: 1,
        at: nowIso,
        updatedBy: actor,
      });
      feedAudit[sourceId] = {
        updatedBy: actor,
        lastAction: "thread_comment",
        lastActionAt: nowIso,
        actionLog,
      };

      const nextHouseholdState = {
        ...householdState,
        dismissedAlertIds: Array.isArray(householdState.dismissedAlertIds)
          ? householdState.dismissedAlertIds
          : [],
        postStats,
        commentThreads,
        alertAudit:
          householdState.alertAudit && typeof householdState.alertAudit === "object"
            ? householdState.alertAudit
            : {},
        feedAudit,
        updatedAt: nowIso,
      };

      state.households[householdId] = nextHouseholdState;
      await writer(state);
      const context = merger(nextHouseholdState);
      const updatedPost = context.feed.find((item) => item.id === sourceId) || null;
      const mentionNotifications = await appendMentionNotificationsForHousehold({
        householdId,
        moduleKey,
        sourceId,
        comment,
        actor,
        nowIso,
      });
      const updatedItem = normalizeUnifiedFeedItem(updatedPost || {}, moduleKey, householdId);
      const event = buildUnifiedFeedMutationEvent({
        householdId,
        moduleKey,
        sourceId,
        mutationType: "comment",
        action: "thread_comment",
        delta: 1,
        actor,
        at: nowIso,
        detail: comment?.body,
        metadata: {
          commentId: comment?.id,
          parentCommentId: comment?.parentCommentId || null,
          mentionCount: Array.isArray(comment?.mentions) ? comment.mentions.length : 0,
        },
        updatedItem,
      });
      return res.json(
        buildUnifiedFeedMutationResponse({
          householdId,
          moduleKey,
          updatedItem,
          event,
          extra: {
            sourceId,
            comment,
            comments: normalizeCommentThreadEntries(commentThreads[sourceId]),
            threadedComments: buildThreadedCommentView(commentThreads[sourceId]),
            mentionNotifications,
          },
        })
      );
    }

    if (moduleKey === "homestead") {
      const actor = resolveHomesteadContextActor(req, req.body || {});
      const { state, householdState } = await getHomesteadContextForHousehold(householdId);
      const feed = householdState.collaboration.feed;
      const index = feed.findIndex((item) => String(item.id) === sourceId);
      if (index < 0) {
        return res.status(404).json({ ok: false, error: "feed_item_not_found" });
      }

      const comment = buildFeedCommentEntry({ body, actor, nowIso, parentCommentId: parentCommentId || null });
      const threads = normalizeCommentThreadMap(householdState.collaboration.commentThreads);
      const currentThread = normalizeCommentThreadEntries(threads[sourceId]);
      if (parentCommentId && !currentThread.some((entry) => String(entry.id) === parentCommentId)) {
        return res.status(400).json({ ok: false, error: "comment_parent_not_found" });
      }
      threads[sourceId] = [...currentThread, comment];

      const current = { ...feed[index] };
      const actionLog = appendHomesteadActionLog(current.actionLog, {
        action: "thread_comment",
        delta: 1,
        at: nowIso,
        updatedBy: actor,
      });
      feed[index] = {
        ...current,
        comments: Math.max(0, Number(current.comments || 0) + 1),
        updatedBy: actor,
        lastAction: "thread_comment",
        lastActionAt: nowIso,
        actionLog,
      };
      householdState.collaboration.commentThreads = threads;
      householdState.updatedAt = nowIso;
      state.households[householdId] = householdState;
      await writeHomesteadContextStateFile(state);

      const mentionNotifications = await appendMentionNotificationsForHousehold({
        householdId,
        moduleKey,
        sourceId,
        comment,
        actor,
        nowIso,
      });

      const updatedItem = normalizeUnifiedFeedItem(feed[index], moduleKey, householdId);
      const event = buildUnifiedFeedMutationEvent({
        householdId,
        moduleKey,
        sourceId,
        mutationType: "comment",
        action: "thread_comment",
        delta: 1,
        actor,
        at: nowIso,
        detail: comment?.body,
        metadata: {
          commentId: comment?.id,
          parentCommentId: comment?.parentCommentId || null,
          mentionCount: Array.isArray(comment?.mentions) ? comment.mentions.length : 0,
        },
        updatedItem,
      });
      return res.json(
        buildUnifiedFeedMutationResponse({
          householdId,
          moduleKey,
          updatedItem,
          event,
          extra: {
            sourceId,
            comment,
            comments: normalizeCommentThreadEntries(threads[sourceId]),
            threadedComments: buildThreadedCommentView(threads[sourceId]),
            mentionNotifications,
          },
        })
      );
    }

    const actor = resolveHomesteadContextActor(req, req.body || {});
    const { state, householdState } = await getCommunityContextForHousehold(householdId);
    const feed = householdState.feed;
    const index = feed.findIndex((item) => String(item.id) === sourceId);
    if (index < 0) {
      return res.status(404).json({ ok: false, error: "feed_item_not_found" });
    }

    const comment = buildFeedCommentEntry({ body, actor, nowIso, parentCommentId: parentCommentId || null });
    const threads = normalizeCommentThreadMap(householdState.commentThreads);
    const currentThread = normalizeCommentThreadEntries(threads[sourceId]);
    if (parentCommentId && !currentThread.some((entry) => String(entry.id) === parentCommentId)) {
      return res.status(400).json({ ok: false, error: "comment_parent_not_found" });
    }
    threads[sourceId] = [...currentThread, comment];

    const current = { ...feed[index] };
    const actionLog = appendHomesteadActionLog(current.actionLog, {
      action: "thread_comment",
      delta: 1,
      at: nowIso,
      updatedBy: actor,
    });
    feed[index] = {
      ...current,
      comments: Math.max(0, Number(current.comments || 0) + 1),
      updatedBy: actor,
      lastAction: "thread_comment",
      lastActionAt: nowIso,
      actionLog,
    };

    householdState.commentThreads = threads;
    const mentionNotifications = buildRoutedMentionNotificationEntries({
      moduleKey,
      sourceId,
      comment,
      actor,
      nowIso,
      idFactory: generateHomesteadId,
      profileHrefBuilder: buildMentionProfileHref,
    });
    appendHouseholdNotifications({ householdState, entries: mentionNotifications, nowIso });
    householdState.updatedAt = nowIso;
    state.households[householdId] = householdState;
    await writeCommunityContextStateFile(state);

    const updatedItem = normalizeUnifiedFeedItem(feed[index], moduleKey, householdId);
    const event = buildUnifiedFeedMutationEvent({
      householdId,
      moduleKey,
      sourceId,
      mutationType: "comment",
      action: "thread_comment",
      delta: 1,
      actor,
      at: nowIso,
      detail: comment?.body,
      metadata: {
        commentId: comment?.id,
        parentCommentId: comment?.parentCommentId || null,
        mentionCount: Array.isArray(comment?.mentions) ? comment.mentions.length : 0,
      },
      updatedItem,
    });
    return res.json(
      buildUnifiedFeedMutationResponse({
        householdId,
        moduleKey,
        updatedItem,
        event,
        extra: {
          sourceId,
          comment,
          comments: normalizeCommentThreadEntries(threads[sourceId]),
          threadedComments: buildThreadedCommentView(threads[sourceId]),
          mentionNotifications,
        },
      })
    );
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/community/context", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getCommunityContextForHousehold(householdId);
    return res.json({ ok: true, householdId, context: householdState });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/community/shared-plans", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const plan = req.body?.plan && typeof req.body.plan === "object" ? req.body.plan : req.body || {};
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const { state, householdState } = await getCommunityContextForHousehold(householdId);
    const nextPlan = {
      ...plan,
      id: String(plan.id || generateHomesteadId("community-plan")),
      householdId,
      updatedBy: actor,
      updatedAt: now,
    };
    householdState.sharedPlans = upsertById(householdState.sharedPlans, nextPlan).list;
    appendHouseholdNotifications({
      householdState,
      entries: [
        buildNotificationEntry({
          idFactory: generateHomesteadId,
          eventType: "COMMUNITY_INVITED",
          createdAt: now,
          type: "shared_plan",
          title: "Shared plan updated",
          message: `A shared community plan was updated by ${actor}.`,
          module: "community",
          metadata: {
            planId: nextPlan.id,
          },
        }),
      ],
      nowIso: now,
    });
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeCommunityContextStateFile(state);
    return res.json({ ok: true, householdId, plan: nextPlan, context: householdState });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/community/garden-plans", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const plan = req.body?.plan && typeof req.body.plan === "object" ? req.body.plan : req.body || {};
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const { state, householdState } = await getCommunityContextForHousehold(householdId);
    const nextPlan = {
      ...plan,
      id: String(plan.id || generateHomesteadId("community-garden")),
      householdId,
      updatedBy: actor,
      updatedAt: now,
    };
    householdState.gardenPlans = upsertById(householdState.gardenPlans, nextPlan).list;
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeCommunityContextStateFile(state);
    return res.json({ ok: true, householdId, plan: nextPlan, context: householdState });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/community/animal-plans", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const plan = req.body?.plan && typeof req.body.plan === "object" ? req.body.plan : req.body || {};
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const { state, householdState } = await getCommunityContextForHousehold(householdId);
    const nextPlan = {
      ...plan,
      id: String(plan.id || generateHomesteadId("community-animal")),
      householdId,
      updatedBy: actor,
      updatedAt: now,
    };
    householdState.animalPlans = upsertById(householdState.animalPlans, nextPlan).list;
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeCommunityContextStateFile(state);
    return res.json({ ok: true, householdId, plan: nextPlan, context: householdState });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/community/notifications", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getCommunityContextForHousehold(householdId);
    return res.json({ ok: true, householdId, notifications: householdState.notifications });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/community/discovery/profiles", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const query = toTrimmedString(req.query.q || req.query.query || "");
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 24;

    const collector = collectCommunityDiscoveryProfiles({ householdId, query });

    const { householdState: communityState } = await getCommunityContextForHousehold(householdId);
    (Array.isArray(communityState.feed) ? communityState.feed : []).forEach((item) => {
      collector.push(item?.author, item?.author, "community_feed");
    });
    Object.values(normalizeCommentThreadMap(communityState.commentThreads)).forEach((thread) => {
      normalizeCommentThreadEntries(thread).forEach((comment) => {
        collector.push(comment?.actor?.id || comment?.author, comment?.actor?.name || comment?.author, "community_thread");
        (Array.isArray(comment?.mentions) ? comment.mentions : []).forEach((mention) => {
          collector.push(mention, mention, "mention");
        });
      });
    });

    const { context: mealContext } = await getMealContextForHousehold(householdId);
    (Array.isArray(mealContext.feed) ? mealContext.feed : []).forEach((item) => {
      collector.push(item?.author, item?.author, "meal_feed");
    });

    const { context: storehouseContext } = await getStorehouseContextForHousehold(householdId);
    (Array.isArray(storehouseContext.feed) ? storehouseContext.feed : []).forEach((item) => {
      collector.push(item?.author, item?.author, "storehouse_feed");
    });

    const { householdState: homesteadState } = await getHomesteadContextForHousehold(householdId);
    (Array.isArray(homesteadState?.collaboration?.feed) ? homesteadState.collaboration.feed : []).forEach(
      (item) => {
        collector.push(item?.author, item?.author, "homestead_feed");
      }
    );

    const rows = collector.rows.slice(0, limit);
    return res.json({ ok: true, householdId, query: normalizeDiscoveryHandle(query), profiles: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/community/profile-visibility", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getCommunityContextForHousehold(householdId);
    return res.json({
      ok: true,
      householdId,
      profileVisibility: householdState.profileVisibility,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/community/profile-visibility", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const mode = toTrimmedString(req.body?.mode || "community") || "community";
    const discoverable = req.body?.discoverable !== false;
    const showHouseholdName = req.body?.showHouseholdName !== false;
    const { state, householdState } = await getCommunityContextForHousehold(householdId);
    householdState.profileVisibility = {
      mode,
      discoverable,
      showHouseholdName,
    };
    householdState.updatedAt = new Date().toISOString();
    state.households[householdId] = householdState;
    await writeCommunityContextStateFile(state);
    return res.json({
      ok: true,
      householdId,
      profileVisibility: householdState.profileVisibility,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/community/moderation/report", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const report = {
      id: generateHomesteadId("community-report"),
      targetId: String(req.body?.targetId || "unknown"),
      reason: String(req.body?.reason || "unspecified"),
      details: String(req.body?.details || ""),
      status: "queued",
      workflowState: WORKFLOW_STATES.PENDING_APPROVAL,
      reportedBy: actor,
      createdAt: now,
    };

    const approvalRequest = {
      id: generateHomesteadId("approval-request"),
      subjectType: "moderation_report",
      subjectId: report.id,
      workflowState: WORKFLOW_STATES.PENDING_APPROVAL,
      requestedBy: actor,
      requestedAt: now,
      updatedAt: now,
      updatedBy: actor,
      reason: report.reason,
      details: report.details,
      auditLog: [
        {
          fromState: null,
          toState: WORKFLOW_STATES.PENDING_APPROVAL,
          at: now,
          updatedBy: actor,
          reason: "moderation_report_submitted",
        },
      ],
    };
    report.approvalRequestId = approvalRequest.id;

    const { state, householdState } = await getCommunityContextForHousehold(householdId);
    householdState.reports.unshift(report);
    householdState.approvals.unshift(approvalRequest);
    appendHouseholdNotifications({
      householdState,
      entries: [
        buildNotificationEntry({
          idFactory: generateHomesteadId,
          eventType: "APPROVAL_REQUESTED",
          createdAt: now,
          type: "moderation",
          title: "Moderation report submitted",
          message: "Your report has been queued for review.",
          module: "moderation",
          sourceModule: "community",
          sourceId: report.id,
          metadata: {
            reason: report.reason,
            targetId: report.targetId,
          },
        }),
      ],
      nowIso: now,
    });
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeCommunityContextStateFile(state);
    return res.json({ ok: true, householdId, report, approvalRequest });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/community/approvals", requirePlannerAdminRole(), async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getCommunityContextForHousehold(householdId);
    const approvals = (Array.isArray(householdState.approvals) ? householdState.approvals : []).map(
      (entry) => {
        const workflowState = normalizeApprovalWorkflowState(entry?.workflowState);
        return {
          ...entry,
          workflowState,
          allowedNextStates: listAllowedApprovalWorkflowTransitions(workflowState),
        };
      }
    );
    return res.json({
      ok: true,
      householdId,
      transitions: APPROVAL_WORKFLOW_TRANSITIONS,
      approvals,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post(
  "/community/approvals/:id/transition",
  requirePlannerAdminRole(),
  express.json(),
  async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const approvalId = String(req.params.id || "").trim();
    const nextState = normalizeApprovalWorkflowState(req.body?.nextState, "");
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const reason = String(req.body?.reason || "").trim();
    const now = new Date().toISOString();

    if (!approvalId) {
      return res.status(400).json({ ok: false, error: "missing_approval_id" });
    }
    if (!nextState) {
      return res.status(400).json({ ok: false, error: "missing_next_state" });
    }

    const { state, householdState } = await getCommunityContextForHousehold(householdId);
    const approvals = Array.isArray(householdState.approvals) ? [...householdState.approvals] : [];
    const approvalIndex = approvals.findIndex((entry) => String(entry?.id || "") === approvalId);
    if (approvalIndex < 0) {
      return res.status(404).json({ ok: false, error: "approval_request_not_found" });
    }

    const currentApproval = { ...approvals[approvalIndex] };
    const currentState = normalizeApprovalWorkflowState(currentApproval.workflowState);
    const allowedNextStates = listAllowedApprovalWorkflowTransitions(currentState);
    if (!canTransitionApprovalWorkflowState(currentState, nextState)) {
      return res.status(409).json({
        ok: false,
        error: "invalid_approval_transition",
        approvalId,
        fromState: currentState,
        toState: nextState,
        allowedNextStates,
      });
    }

    const nextAuditLog = Array.isArray(currentApproval.auditLog) ? [...currentApproval.auditLog] : [];
    nextAuditLog.push({
      fromState: currentState,
      toState: nextState,
      at: now,
      updatedBy: actor,
      reason: reason || null,
    });

    const nextApproval = {
      ...currentApproval,
      workflowState: nextState,
      updatedAt: now,
      updatedBy: actor,
      reason: reason || currentApproval.reason || "",
      auditLog: nextAuditLog,
      allowedNextStates: listAllowedApprovalWorkflowTransitions(nextState),
    };
    approvals[approvalIndex] = nextApproval;
    householdState.approvals = approvals;

    const reports = Array.isArray(householdState.reports) ? [...householdState.reports] : [];
    const reportIndex = reports.findIndex(
      (entry) => String(entry?.approvalRequestId || "") === approvalId
    );
    if (reportIndex >= 0) {
      reports[reportIndex] = {
        ...reports[reportIndex],
        workflowState: nextState,
        status: mapReportStatusFromWorkflowState(nextState),
        updatedAt: now,
        updatedBy: actor,
      };
    }
    householdState.reports = reports;

    const linkedReport = reportIndex >= 0 ? reports[reportIndex] : null;
    appendHouseholdNotifications({
      householdState,
      entries: [
        buildNotificationEntry({
          idFactory: generateHomesteadId,
          eventType:
            nextState === WORKFLOW_STATES.PENDING_APPROVAL ? "APPROVAL_REQUESTED" : "APPROVAL_DECIDED",
          createdAt: now,
          type: "moderation",
          title: "Approval workflow updated",
          message: `Approval ${approvalId} moved from ${currentState} to ${nextState}.`,
          module: "moderation",
          sourceModule: "community",
          sourceId: linkedReport?.id || currentApproval.subjectId || approvalId,
          metadata: {
            approvalId,
            fromState: currentState,
            toState: nextState,
            reason: reason || null,
          },
        }),
      ],
      nowIso: now,
    });

    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeCommunityContextStateFile(state);

    return res.json({
      ok: true,
      householdId,
      approval: nextApproval,
      report: linkedReport,
      transitions: APPROVAL_WORKFLOW_TRANSITIONS,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
  }
);

router.get("/household/tasks", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const moduleKeyFilter = String(req.query.moduleKey || "").trim().toLowerCase();
    const ownerIdFilter = String(req.query.ownerId || "").trim().toLowerCase();
    const workflowStateFilter = String(req.query.workflowState || "").trim().toLowerCase();
    const includeArchived = String(req.query.includeArchived || "false").toLowerCase() === "true";

    const { householdState } = await getCommunityContextForHousehold(householdId);
    const tasks = (Array.isArray(householdState.tasks) ? householdState.tasks : [])
      .map((task) => {
        const normalizedState = normalizeTaskWorkflowState(task?.workflowState, WORKFLOW_STATES.ACTIVE);
        return {
          ...task,
          workflowState: normalizedState,
          allowedNextStates: listAllowedTaskWorkflowTransitions(normalizedState),
        };
      })
      .filter((task) => (includeArchived ? true : task.workflowState !== WORKFLOW_STATES.ARCHIVED))
      .filter((task) => (moduleKeyFilter ? task.moduleKey === moduleKeyFilter : true))
      .filter((task) =>
        ownerIdFilter ? String(task.ownerId || "").trim().toLowerCase() === ownerIdFilter : true
      )
      .filter((task) => (workflowStateFilter ? task.workflowState === workflowStateFilter : true))
      .sort((a, b) => Date.parse(String(a?.dueAt || "")) - Date.parse(String(b?.dueAt || "")));

    return res.json({
      ok: true,
      householdId,
      total: tasks.length,
      tasks,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/household/tasks", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const nowIso = new Date().toISOString();
    const incomingTask = req.body?.task && typeof req.body.task === "object" ? req.body.task : req.body || {};

    const { state, householdState } = await getCommunityContextForHousehold(householdId);
    const tasks = Array.isArray(householdState.tasks) ? [...householdState.tasks] : [];
    const nextTask = normalizeHouseholdTaskRecord({
      incoming: incomingTask,
      existing: null,
      householdId,
      actor,
      nowIso,
    });
    if (!nextTask.title) {
      return res.status(400).json({ ok: false, error: "missing_task_title" });
    }

    const conflictsWithTaskIds = detectHouseholdTaskConflicts(tasks, nextTask);
    nextTask.conflictsWithTaskIds = conflictsWithTaskIds;
    nextTask.auditLog.push({
      action: "created",
      at: nowIso,
      updatedBy: actor,
    });

    tasks.unshift(nextTask);
    householdState.tasks = tasks;
    householdState.updatedAt = nowIso;
    appendHouseholdNotifications({
      householdState,
      entries: [
        buildNotificationEntry({
          idFactory: generateHomesteadId,
          eventType: "ASSIGNMENT_CREATED",
          createdAt: nowIso,
          type: "task",
          title: `Task created: ${nextTask.title}`,
          message: `Task for ${nextTask.moduleKey} created by ${actor}.`,
          module: "community",
          sourceModule: nextTask.moduleKey,
          sourceId: nextTask.id,
          metadata: {
            ownerId: nextTask.ownerId,
            dueAt: nextTask.dueAt,
            conflicts: conflictsWithTaskIds.length,
          },
        }),
      ],
      nowIso,
    });

    state.households[householdId] = householdState;
    await writeCommunityContextStateFile(state);

    return res.json({
      ok: true,
      householdId,
      task: {
        ...nextTask,
        allowedNextStates: listAllowedTaskWorkflowTransitions(nextTask.workflowState),
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.patch("/household/tasks/:id", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const taskId = String(req.params.id || "").trim();
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const nowIso = new Date().toISOString();
    const updates = req.body?.task && typeof req.body.task === "object" ? req.body.task : req.body || {};

    if (!taskId) {
      return res.status(400).json({ ok: false, error: "missing_task_id" });
    }
    if (Object.prototype.hasOwnProperty.call(updates, "workflowState")) {
      return res.status(400).json({ ok: false, error: "workflow_state_requires_transition_endpoint" });
    }

    const { state, householdState } = await getCommunityContextForHousehold(householdId);
    const tasks = Array.isArray(householdState.tasks) ? [...householdState.tasks] : [];
    const index = tasks.findIndex((task) => String(task?.id || "") === taskId);
    if (index < 0) {
      return res.status(404).json({ ok: false, error: "task_not_found" });
    }

    const currentTask = tasks[index];
    const nextTask = normalizeHouseholdTaskRecord({
      incoming: { ...currentTask, ...updates, id: taskId },
      existing: currentTask,
      householdId,
      actor,
      nowIso,
    });
    if (!nextTask.title) {
      return res.status(400).json({ ok: false, error: "missing_task_title" });
    }

    const conflictsWithTaskIds = detectHouseholdTaskConflicts(tasks, nextTask);
    nextTask.conflictsWithTaskIds = conflictsWithTaskIds;
    nextTask.auditLog.push({
      action: "updated",
      at: nowIso,
      updatedBy: actor,
      changes: Object.keys(updates || {}),
    });

    tasks[index] = nextTask;
    householdState.tasks = tasks;
    householdState.updatedAt = nowIso;
    state.households[householdId] = householdState;
    await writeCommunityContextStateFile(state);

    return res.json({
      ok: true,
      householdId,
      task: {
        ...nextTask,
        allowedNextStates: listAllowedTaskWorkflowTransitions(nextTask.workflowState),
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/household/tasks/:id/transition", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const taskId = String(req.params.id || "").trim();
    const nextState = normalizeTaskWorkflowState(req.body?.nextState, "");
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const reason = String(req.body?.reason || "").trim();
    const nowIso = new Date().toISOString();

    if (!taskId) {
      return res.status(400).json({ ok: false, error: "missing_task_id" });
    }
    if (!nextState) {
      return res.status(400).json({ ok: false, error: "missing_next_state" });
    }

    const { state, householdState } = await getCommunityContextForHousehold(householdId);
    const tasks = Array.isArray(householdState.tasks) ? [...householdState.tasks] : [];
    const index = tasks.findIndex((task) => String(task?.id || "") === taskId);
    if (index < 0) {
      return res.status(404).json({ ok: false, error: "task_not_found" });
    }

    const currentTask = { ...tasks[index] };
    const currentState = normalizeTaskWorkflowState(currentTask.workflowState, WORKFLOW_STATES.ACTIVE);
    const allowedNextStates = listAllowedTaskWorkflowTransitions(currentState);
    if (!canTransitionTaskWorkflowState(currentState, nextState)) {
      return res.status(409).json({
        ok: false,
        error: "invalid_task_transition",
        taskId,
        fromState: currentState,
        toState: nextState,
        allowedNextStates,
      });
    }

    if (nextState === WORKFLOW_STATES.COMPLETED) {
      const blockingTaskIds = (Array.isArray(currentTask.dependsOn) ? currentTask.dependsOn : []).filter(
        (dependencyId) => {
          const dependencyTask = tasks.find((task) => String(task?.id || "") === String(dependencyId || ""));
          if (!dependencyTask) return true;
          return normalizeTaskWorkflowState(dependencyTask.workflowState, WORKFLOW_STATES.ACTIVE) !== WORKFLOW_STATES.COMPLETED;
        }
      );

      if (blockingTaskIds.length) {
        return res.status(409).json({
          ok: false,
          error: "task_dependency_incomplete",
          taskId,
          blockingTaskIds,
        });
      }
    }

    const nextTask = {
      ...currentTask,
      workflowState: nextState,
      completedAt: nextState === WORKFLOW_STATES.COMPLETED ? nowIso : null,
      archivedAt: nextState === WORKFLOW_STATES.ARCHIVED ? nowIso : null,
      updatedAt: nowIso,
      updatedBy: actor,
      auditLog: Array.isArray(currentTask.auditLog) ? [...currentTask.auditLog] : [],
    };
    nextTask.auditLog.push({
      action: "state_transition",
      fromState: currentState,
      toState: nextState,
      at: nowIso,
      updatedBy: actor,
      reason: reason || null,
    });
    nextTask.conflictsWithTaskIds = detectHouseholdTaskConflicts(tasks, nextTask);
    tasks[index] = nextTask;

    let spawnedTask = null;
    if (nextState === WORKFLOW_STATES.COMPLETED && normalizeTaskRecurrence(nextTask.recurrence).enabled) {
      const nextDueAt = computeNextRecurrenceDueAt(nextTask.dueAt, nextTask.recurrence, nowIso);
      if (nextDueAt) {
        spawnedTask = normalizeHouseholdTaskRecord({
          incoming: {
            ...nextTask,
            id: generateHomesteadId("household-task"),
            workflowState: WORKFLOW_STATES.ACTIVE,
            dueAt: nextDueAt,
            sourceTaskId: nextTask.id,
          },
          existing: null,
          householdId,
          actor,
          nowIso,
        });
        spawnedTask.auditLog.push({
          action: "spawned_from_recurrence",
          sourceTaskId: nextTask.id,
          at: nowIso,
          updatedBy: actor,
        });
        spawnedTask.conflictsWithTaskIds = detectHouseholdTaskConflicts(tasks, spawnedTask);
        tasks.unshift(spawnedTask);
      }
    }

    householdState.tasks = tasks;
    householdState.updatedAt = nowIso;
    state.households[householdId] = householdState;
    await writeCommunityContextStateFile(state);

    return res.json({
      ok: true,
      householdId,
      task: {
        ...nextTask,
        allowedNextStates: listAllowedTaskWorkflowTransitions(nextTask.workflowState),
      },
      spawnedTask,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/components", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({ ok: true, householdId, items: householdState.resources.components });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/components", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const incoming = req.body?.item || {};
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const id = String(incoming.id || generateHomesteadId("component"));
    const nextItem = {
      ...incoming,
      id,
      updatedBy: actor,
      createdAt: incoming.createdAt || now,
      updatedAt: now,
    };
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    const upserted = upsertById(householdState.resources.components, nextItem);
    householdState.resources.components = upserted.list;
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, item: upserted.item, items: householdState.resources.components });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.delete("/homestead/components/:id", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || req.body?.householdId || "default-household");
    const id = String(req.params.id || "").trim();
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    householdState.resources.components = deleteById(householdState.resources.components, id);
    householdState.updatedAt = new Date().toISOString();
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, id, items: householdState.resources.components });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/components/export", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({
      ok: true,
      householdId,
      exportedAt: new Date().toISOString(),
      resource: "components",
      count: householdState.resources.components.length,
      items: householdState.resources.components,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/components/import", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const mode = String(req.body?.mode || "merge").toLowerCase() === "replace" ? "replace" : "merge";
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const incoming = normalizeHomesteadResourceItems(req.body?.items, {
      prefix: "component",
      actor,
      now,
    });
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    householdState.resources.components =
      mode === "replace"
        ? incoming
        : upsertManyById(householdState.resources.components, incoming);
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({
      ok: true,
      householdId,
      mode,
      importedCount: incoming.length,
      items: householdState.resources.components,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/inventory", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({ ok: true, householdId, items: householdState.resources.inventory });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/inventory", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const incoming = req.body?.item || {};
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const id = String(incoming.id || generateHomesteadId("inventory"));
    const nextItem = {
      ...incoming,
      id,
      updatedBy: actor,
      createdAt: incoming.createdAt || now,
      updatedAt: now,
    };
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    const upserted = upsertById(householdState.resources.inventory, nextItem);
    householdState.resources.inventory = upserted.list;
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, item: upserted.item, items: householdState.resources.inventory });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.delete("/homestead/inventory/:id", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || req.body?.householdId || "default-household");
    const id = String(req.params.id || "").trim();
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    householdState.resources.inventory = deleteById(householdState.resources.inventory, id);
    householdState.updatedAt = new Date().toISOString();
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, id, items: householdState.resources.inventory });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/inventory/export", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({
      ok: true,
      householdId,
      exportedAt: new Date().toISOString(),
      resource: "inventory",
      count: householdState.resources.inventory.length,
      items: householdState.resources.inventory,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/inventory/import", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const mode = String(req.body?.mode || "merge").toLowerCase() === "replace" ? "replace" : "merge";
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const incoming = normalizeHomesteadResourceItems(req.body?.items, {
      prefix: "inventory",
      actor,
      now,
    });
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    householdState.resources.inventory =
      mode === "replace"
        ? incoming
        : upsertManyById(householdState.resources.inventory, incoming);
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({
      ok: true,
      householdId,
      mode,
      importedCount: incoming.length,
      items: householdState.resources.inventory,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/batches", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({ ok: true, householdId, items: householdState.resources.batches });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/batches", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const incoming = req.body?.item || {};
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const id = String(incoming.id || generateHomesteadId("batch"));
    const nextItem = {
      ...incoming,
      id,
      updatedBy: actor,
      createdAt: incoming.createdAt || now,
      updatedAt: now,
    };
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    const upserted = upsertById(householdState.resources.batches, nextItem);
    householdState.resources.batches = upserted.list;
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, item: upserted.item, items: householdState.resources.batches });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.delete("/homestead/batches/:id", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || req.body?.householdId || "default-household");
    const id = String(req.params.id || "").trim();
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    householdState.resources.batches = deleteById(householdState.resources.batches, id);
    householdState.updatedAt = new Date().toISOString();
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, id, items: householdState.resources.batches });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/batches/export", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({
      ok: true,
      householdId,
      exportedAt: new Date().toISOString(),
      resource: "batches",
      count: householdState.resources.batches.length,
      items: householdState.resources.batches,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/batches/import", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const mode = String(req.body?.mode || "merge").toLowerCase() === "replace" ? "replace" : "merge";
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const incoming = normalizeHomesteadResourceItems(req.body?.items, {
      prefix: "batch",
      actor,
      now,
    });
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    householdState.resources.batches =
      mode === "replace"
        ? incoming
        : upsertManyById(householdState.resources.batches, incoming);
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({
      ok: true,
      householdId,
      mode,
      importedCount: incoming.length,
      items: householdState.resources.batches,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/skills", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({
      ok: true,
      householdId,
      paths: householdState.resources.skills.paths,
      progress: householdState.resources.skills.progress,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/skills/path", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const incoming = req.body?.path || {};
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const id = String(incoming.id || generateHomesteadId("skill-path"));
    const nextItem = {
      ...incoming,
      id,
      updatedBy: actor,
      createdAt: incoming.createdAt || now,
      updatedAt: now,
    };
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    const upserted = upsertById(householdState.resources.skills.paths, nextItem);
    householdState.resources.skills.paths = upserted.list;
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, path: upserted.item, paths: householdState.resources.skills.paths });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/skills/progress", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const incoming = req.body?.progress || {};
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const id = String(incoming.id || generateHomesteadId("skill-progress"));
    const nextItem = {
      ...incoming,
      id,
      updatedBy: actor,
      createdAt: incoming.createdAt || now,
      updatedAt: now,
    };
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    const upserted = upsertById(householdState.resources.skills.progress, nextItem);
    householdState.resources.skills.progress = upserted.list;
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, progress: upserted.item, progressList: householdState.resources.skills.progress });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/skills/export", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({
      ok: true,
      householdId,
      exportedAt: new Date().toISOString(),
      resource: "skills",
      paths: householdState.resources.skills.paths,
      progress: householdState.resources.skills.progress,
      counts: {
        paths: householdState.resources.skills.paths.length,
        progress: householdState.resources.skills.progress.length,
      },
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/skills/import", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const mode = String(req.body?.mode || "merge").toLowerCase() === "replace" ? "replace" : "merge";
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const incomingPaths = normalizeHomesteadResourceItems(req.body?.paths, {
      prefix: "skill-path",
      actor,
      now,
    });
    const incomingProgress = normalizeHomesteadResourceItems(req.body?.progress, {
      prefix: "skill-progress",
      actor,
      now,
    });

    const { state, householdState } = await getHomesteadContextForHousehold(householdId);

    householdState.resources.skills.paths =
      mode === "replace"
        ? incomingPaths
        : upsertManyById(householdState.resources.skills.paths, incomingPaths);

    householdState.resources.skills.progress =
      mode === "replace"
        ? incomingProgress
        : upsertManyById(householdState.resources.skills.progress, incomingProgress);

    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);

    return res.json({
      ok: true,
      householdId,
      mode,
      imported: {
        paths: incomingPaths.length,
        progress: incomingProgress.length,
      },
      paths: householdState.resources.skills.paths,
      progress: householdState.resources.skills.progress,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/animal-targets", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({ ok: true, householdId, items: householdState.resources.animalTargets });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/animal-targets", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const incoming = req.body?.item || {};
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const id = String(incoming.id || generateHomesteadId("animal-target"));
    const nextItem = { ...incoming, id, updatedBy: actor, createdAt: incoming.createdAt || now, updatedAt: now };
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    const upserted = upsertById(householdState.resources.animalTargets, nextItem);
    householdState.resources.animalTargets = upserted.list;
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, item: upserted.item, items: householdState.resources.animalTargets });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.delete("/homestead/animal-targets/:id", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || req.body?.householdId || "default-household");
    const id = String(req.params.id || "").trim();
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    householdState.resources.animalTargets = deleteById(householdState.resources.animalTargets, id);
    householdState.updatedAt = new Date().toISOString();
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, id, items: householdState.resources.animalTargets });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/garden-targets", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({ ok: true, householdId, items: householdState.resources.gardenTargets });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/garden-targets", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const incoming = req.body?.item || {};
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const id = String(incoming.id || generateHomesteadId("garden-target"));
    const nextItem = { ...incoming, id, updatedBy: actor, createdAt: incoming.createdAt || now, updatedAt: now };
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    const upserted = upsertById(householdState.resources.gardenTargets, nextItem);
    householdState.resources.gardenTargets = upserted.list;
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, item: upserted.item, items: householdState.resources.gardenTargets });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.delete("/homestead/garden-targets/:id", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || req.body?.householdId || "default-household");
    const id = String(req.params.id || "").trim();
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    householdState.resources.gardenTargets = deleteById(householdState.resources.gardenTargets, id);
    householdState.updatedAt = new Date().toISOString();
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, id, items: householdState.resources.gardenTargets });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/cuisines", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({
      ok: true,
      householdId,
      profiles: householdState.resources.cuisines.profiles,
      rotations: householdState.resources.cuisines.rotations,
      prefs: householdState.resources.cuisines.prefs,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/cuisines/profile", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const incoming = req.body?.profile || {};
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const id = String(incoming.id || generateHomesteadId("cuisine-profile"));
    const nextItem = { ...incoming, id, updatedBy: actor, createdAt: incoming.createdAt || now, updatedAt: now };
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    householdState.resources.cuisines.profiles = upsertManyById(householdState.resources.cuisines.profiles, [nextItem]);
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, profile: nextItem, profiles: householdState.resources.cuisines.profiles });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/cuisines/rotation", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const incoming = req.body?.rotation || {};
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const id = String(incoming.id || generateHomesteadId("cuisine-rotation"));
    const nextItem = { ...incoming, id, updatedBy: actor, createdAt: incoming.createdAt || now, updatedAt: now };
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    householdState.resources.cuisines.rotations = upsertManyById(householdState.resources.cuisines.rotations, [nextItem]);
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, rotation: nextItem, rotations: householdState.resources.cuisines.rotations });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/cuisines/prefs", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const prefs = req.body?.prefs && typeof req.body.prefs === "object" ? req.body.prefs : {};
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    householdState.resources.cuisines.prefs = {
      ...householdState.resources.cuisines.prefs,
      ...prefs,
      updatedBy: actor,
      updatedAt: now,
    };
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, prefs: householdState.resources.cuisines.prefs });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead/preferences", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { householdState } = await getHomesteadContextForHousehold(householdId);
    return res.json({
      ok: true,
      householdId,
      household: householdState.resources.preferences.household,
      profile: householdState.resources.preferences.profile,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead/preferences", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household");
    const actor = resolveHomesteadContextActor(req, req.body || {});
    const now = new Date().toISOString();
    const incomingHousehold = req.body?.household && typeof req.body.household === "object" ? req.body.household : {};
    const incomingProfile = req.body?.profile && typeof req.body.profile === "object" ? req.body.profile : {};
    const { state, householdState } = await getHomesteadContextForHousehold(householdId);
    householdState.resources.preferences = {
      household: {
        ...householdState.resources.preferences.household,
        ...incomingHousehold,
        updatedBy: actor,
        updatedAt: now,
      },
      profile: {
        ...householdState.resources.preferences.profile,
        ...incomingProfile,
        updatedBy: actor,
        updatedAt: now,
      },
    };
    householdState.updatedAt = now;
    state.households[householdId] = householdState;
    await writeHomesteadContextStateFile(state);
    return res.json({ ok: true, householdId, ...householdState.resources.preferences });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post(
  "/assistant/plan",
  requireEntitlementPolicy({ feature: "planner.assistant" }),
  requirePlannerAdminRole(),
  express.json(),
  async (req, res) => {
  try {
    const payload = req.body || {};
    const householdId = String(payload.householdId || "default-household");

    const {
      getMealPlannerSnapshot,
      getStorehousePlannerSnapshot,
      getHomesteadPlannerSnapshot,
    } = loadPlannerIntegrationService();
    const { generateHouseholdPlannerBundle } = loadHouseholdPlanningIntelligenceService();
    const { saveRecommendation } = loadHouseholdAutomationRecommendationModel();

    if (typeof generateHouseholdPlannerBundle !== "function") {
      return res.status(503).json({ ok: false, error: "planner_intelligence_unavailable" });
    }

    const warnings = [];

    const [mealSnapshot, storehouseSnapshot, homesteadSnapshot] = await Promise.all([
      typeof getMealPlannerSnapshot === "function"
        ? getMealPlannerSnapshot(householdId).catch((error) => {
            warnings.push(`meal_snapshot_unavailable:${String(error?.message || error)}`);
            return null;
          })
        : Promise.resolve(null),
      typeof getStorehousePlannerSnapshot === "function"
        ? getStorehousePlannerSnapshot(householdId).catch((error) => {
            warnings.push(`storehouse_snapshot_unavailable:${String(error?.message || error)}`);
            return null;
          })
        : Promise.resolve(null),
      typeof getHomesteadPlannerSnapshot === "function"
        ? getHomesteadPlannerSnapshot(householdId).catch((error) => {
            warnings.push(`homestead_snapshot_unavailable:${String(error?.message || error)}`);
            return null;
          })
        : Promise.resolve(null),
    ]);

    const bundle = generateHouseholdPlannerBundle({
      householdId,
      preferences: payload.preferences,
      goals: payload.goals,
      history: payload.history,
      mealPlan: payload.mealPlan || mealSnapshot?.planner_output || {},
      storehouse: payload.storehouse || storehouseSnapshot || {},
      homestead: payload.homestead || homesteadSnapshot || {},
    });

    let persistence = null;
    if (typeof saveRecommendation === "function") {
      try {
        persistence = await saveRecommendation({
          householdId,
          generatedAt: bundle.generatedAt,
          source: "planners.assistant.plan",
          profile: bundle.profile,
          goals: bundle.goals,
          bundle,
        });
      } catch (error) {
        warnings.push(`assistant_bundle_persist_failed:${String(error?.message || error)}`);
      }
    }

    return res.json({
      ok: true,
      householdId,
      warnings,
      bundle,
      persistence,
    });
  } catch (error) {
    if (isLocalDevRequest(req)) {
      const payload = req.body || {};
      const householdId = String(payload.householdId || req.query?.householdId || "default-household");
      return res.json({
        ok: true,
        householdId,
        warnings: [`assistant_plan_dev_fallback:${String(error?.message || error)}`],
        bundle: buildDevAssistantFallbackBundle(householdId, payload),
        persistence: null,
      });
    }
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
  }
);

router.get("/profile/messages", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household").trim() || "default-household";
    const { current } = await getProfileMessagesContextForHousehold(householdId);
    return res.json({
      ok: true,
      householdId,
      messages: cloneProfileMessagesContext(current),
    });
  } catch (error) {
    if (isLocalDevRequest(req)) {
      return res.json({
        ok: true,
        householdId: String(req.query.householdId || "default-household"),
        warnings: [`profile_messages_dev_fallback:${String(error?.message || error)}`],
        messages: cloneProfileMessagesContext(DEFAULT_PROFILE_MESSAGES_CONTEXT),
      });
    }
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/profile/messages", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || req.query?.householdId || "default-household").trim() || "default-household";
    const actorId = String(req.user?.id || req.user?.userId || req.headers["x-user-id"] || "unknown").trim() || "unknown";
    const incomingMessages = normalizeProfileMessagesContext(req.body?.messages || {});

    const { state } = await getProfileMessagesContextForHousehold(householdId);
    state.households[householdId] = {
      ...incomingMessages,
      lastUpdatedBy: actorId,
      lastUpdatedAt: new Date().toISOString(),
    };
    await writeProfileMessagesStateFile(state);

    return res.json({
      ok: true,
      householdId,
      messages: cloneProfileMessagesContext(state.households[householdId]),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/profile/messages/append", express.json(), async (req, res) => {
  try {
    const householdId = String(req.body?.householdId || "default-household").trim() || "default-household";
    const conversationId = String(req.body?.conversationId || "").trim();
    const message = req.body?.message || {};
    const actorId = String(req.user?.id || req.user?.userId || req.headers["x-user-id"] || "unknown").trim() || "unknown";

    if (!conversationId) {
      return res.status(400).json({ ok: false, error: "conversation_id_required" });
    }

    const { state, current } = await getProfileMessagesContextForHousehold(householdId);
    const next = appendMessageToConversation(current, conversationId, message, actorId);
    state.households[householdId] = {
      ...next,
      lastUpdatedBy: actorId,
      lastUpdatedAt: new Date().toISOString(),
    };
    await writeProfileMessagesStateFile(state);

    return res.json({
      ok: true,
      householdId,
      messages: cloneProfileMessagesContext(state.households[householdId]),
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/projection/status", async (req, res) => {
  try {
    const { getProjectionStatus } = loadPlannerProjectionSync();
    if (typeof getProjectionStatus !== "function") {
      return res.status(503).json({ ok: false, error: "planner_projection_unavailable" });
    }

    const status = await getProjectionStatus();
    return res.json({ ok: true, ...status });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post(
  "/projection/replay",
  requirePlannerAdminRole(),
  express.json(),
  async (req, res) => {
  try {
    const {
      replayProjectionJobs,
      processProjectionBacklog,
      processProjectionBacklogWithTimeout,
    } = loadPlannerProjectionSync();
    if (
      typeof replayProjectionJobs !== "function" ||
      typeof processProjectionBacklog !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "planner_projection_unavailable" });
    }

    const payload = req.body || {};
    const replayed = await replayProjectionJobs(payload);
    const processLimit = Number(payload.processLimit || 20);
    const timeoutMs = Number(payload.processTimeoutMs || process.env.PLANNER_PROJECTION_ROUTE_TIMEOUT_MS || 6000);
    const processed =
      typeof processProjectionBacklogWithTimeout === "function"
        ? await processProjectionBacklogWithTimeout({ limit: processLimit, timeoutMs })
        : await withAsyncTimeout(
            processProjectionBacklog({ limit: processLimit }),
            timeoutMs,
            { ok: false, timedOut: true, processed: 0, results: [], timeoutMs }
          );
    return res.json({ ok: true, replayed, processed });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
  }
);

router.post(
  "/projection/reconcile",
  requirePlannerAdminRole(),
  express.json(),
  async (req, res) => {
  try {
    const { reconcileHouseholdProjection } = loadPlannerProjectionSync();
    if (typeof reconcileHouseholdProjection !== "function") {
      return res.status(503).json({ ok: false, error: "planner_projection_unavailable" });
    }

    const payload = req.body || {};
    const timeoutMs = Number(payload.processTimeoutMs || process.env.PLANNER_PROJECTION_ROUTE_TIMEOUT_MS || 6000);
    const plannerMode = payload.planner || "all";
    const timedOutQueued =
      plannerMode === "all"
        ? [{ planner: "storehouse", jobId: null }, { planner: "homestead", jobId: null }]
        : [{ planner: plannerMode, jobId: null }];
    const result = await withAsyncTimeout(
      reconcileHouseholdProjection({
        householdId: payload.householdId,
        planner: plannerMode,
        processNow: payload.processNow !== false,
      }),
      timeoutMs,
      {
        ok: true,
        timedOut: true,
        householdId: String(payload.householdId || "default-household"),
        planner: plannerMode,
        queued: timedOutQueued,
        processed: { ok: false, timedOut: true, processed: 0, results: [], timeoutMs },
      }
    );
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
  }
);

router.get("/operational/readiness/meal", async (req, res) => {
  try {
    const { getMealPlanningReadiness } = loadOperationalReadinessService();
    if (typeof getMealPlanningReadiness !== "function") {
      return res.status(503).json({ ok: false, error: "operational_readiness_unavailable" });
    }
    const householdId = String(req.query.householdId || req.query.householdKey || "");
    const readiness = await getMealPlanningReadiness(householdId);
    return res.json({ ok: true, readiness });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/readiness/storehouse", async (req, res) => {
  try {
    const { getStorehouseInventoryReadiness } = loadOperationalReadinessService();
    if (typeof getStorehouseInventoryReadiness !== "function") {
      return res.status(503).json({ ok: false, error: "operational_readiness_unavailable" });
    }
    const householdId = String(req.query.householdId || req.query.householdKey || "");
    const readiness = await getStorehouseInventoryReadiness(householdId);
    return res.json({ ok: true, readiness });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/readiness/homestead", async (req, res) => {
  try {
    const { getHomesteadProductionReadiness } = loadOperationalReadinessService();
    if (typeof getHomesteadProductionReadiness !== "function") {
      return res.status(503).json({ ok: false, error: "operational_readiness_unavailable" });
    }
    const householdId = String(req.query.householdId || req.query.householdKey || "");
    const readiness = await getHomesteadProductionReadiness(householdId);
    return res.json({ ok: true, readiness });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/readiness", async (req, res) => {
  try {
    const {
      getMealPlanningReadiness,
      getStorehouseInventoryReadiness,
      getHomesteadProductionReadiness,
    } = loadOperationalReadinessService();
    if (
      typeof getMealPlanningReadiness !== "function" ||
      typeof getStorehouseInventoryReadiness !== "function" ||
      typeof getHomesteadProductionReadiness !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "operational_readiness_unavailable" });
    }
    const householdId = String(req.query.householdId || req.query.householdKey || "");
    const [meal, storehouse, homestead] = await Promise.all([
      getMealPlanningReadiness(householdId),
      getStorehouseInventoryReadiness(householdId),
      getHomesteadProductionReadiness(householdId),
    ]);
    return res.json({ ok: true, householdId, readiness: { meal, storehouse, homestead } });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/saved-recipes/search", async (req, res) => {
  try {
    const { searchSavedRecipes } = loadOperationalReadinessService();
    if (typeof searchSavedRecipes !== "function") {
      return res.status(503).json({ ok: false, error: "operational_readiness_unavailable" });
    }
    const householdIdOrKey = String(req.query.householdId || req.query.householdKey || "");
    const query = String(req.query.q || "");
    const limit = Number(req.query.limit || 25);
    const rows = await searchSavedRecipes({ householdIdOrKey, query, limit });
    return res.json({ ok: true, count: rows.length, items: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/outbox/status", async (req, res) => {
  try {
    const { getOutboxStatus, getOutboxHealthSignals } = loadOperationalOutboxService();
    const { getOperationalProjectionWorkerStatus } = loadOperationalProjectionWorker();
    if (typeof getOutboxStatus !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_unavailable" });
    }
    const householdId = String(req.query.householdId || "").trim();
    const outbox = await getOutboxStatus({ householdId: householdId || null });
    const health =
      typeof getOutboxHealthSignals === "function"
        ? await getOutboxHealthSignals({ householdId: householdId || null })
        : null;
    if (typeof getOperationalProjectionWorkerStatus === "function") {
      const worker = await getOperationalProjectionWorkerStatus();
      return res.json({ ok: true, ...outbox, health, worker: worker.worker });
    }
    return res.json({ ok: true, ...outbox, health });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/outbox/metrics", async (req, res) => {
  try {
    const { getOutboxStatus, getOutboxHealthSignals } = loadOperationalOutboxService();
    const { getOperationalProjectionWorkerStatus } = loadOperationalProjectionWorker();
    const { getMetricsSnapshot } = loadOperationalOutboxObservability();
    if (
      typeof getOutboxStatus !== "function" ||
      typeof getOutboxHealthSignals !== "function" ||
      typeof getMetricsSnapshot !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const householdId = String(req.query.householdId || "").trim();
    const windowMs = Number(req.query.windowMs || 300000);
    const [outbox, health, metrics, workerStatus] = await Promise.all([
      getOutboxStatus({ householdId: householdId || null }),
      getOutboxHealthSignals({ householdId: householdId || null }),
      Promise.resolve(getMetricsSnapshot({ windowMs })),
      typeof getOperationalProjectionWorkerStatus === "function"
        ? getOperationalProjectionWorkerStatus()
        : Promise.resolve(null),
    ]);

    return res.json({
      ok: true,
      householdId: householdId || null,
      outbox: outbox.summary,
      health,
      metrics,
      worker: workerStatus?.worker || null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/outbox/alerts", async (req, res) => {
  try {
    const { getOutboxStatus, getOutboxHealthSignals } = loadOperationalOutboxService();
    const { evaluateAlerts, ensureThresholdOverridesLoaded, deliverAlerts } = loadOperationalOutboxObservability();
    if (
      typeof getOutboxStatus !== "function" ||
      typeof getOutboxHealthSignals !== "function" ||
      typeof evaluateAlerts !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const householdId = String(req.query.householdId || "").trim();
    const windowMs = Number(req.query.windowMs || 300000);
    const [outbox, health] = await Promise.all([
      getOutboxStatus({ householdId: householdId || null }),
      getOutboxHealthSignals({ householdId: householdId || null }),
    ]);

    if (typeof ensureThresholdOverridesLoaded === "function") {
      await ensureThresholdOverridesLoaded();
    }

    const alerts = evaluateAlerts({
      outboxSummary: outbox.summary,
      healthSignals: health,
      windowMs,
    });

    let delivery = null;
    const dispatch = String(req.query.dispatch || "").toLowerCase();
    const shouldDispatch = dispatch === "1" || dispatch === "true" || dispatch === "yes";
    if (shouldDispatch && typeof deliverAlerts === "function") {
      delivery = await deliverAlerts({
        payload: {
          householdId: householdId || null,
          windowMs: alerts.windowMs,
          outbox: outbox.summary,
          health,
          thresholds: alerts.thresholds,
          alerts: alerts.alerts,
          hasCritical: alerts.hasCritical,
          hasWarning: alerts.hasWarning,
        },
      });
    }

    return res.json({
      ok: true,
      householdId: householdId || null,
      outbox: outbox.summary,
      health,
      ...alerts,
      delivery,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post(
  "/operational/outbox/alerts/dispatch",
  requirePlannerAdminRole(),
  express.json(),
  async (req, res) => {
  try {
    const { getOutboxStatus, getOutboxHealthSignals } = loadOperationalOutboxService();
    const { evaluateAlerts, ensureThresholdOverridesLoaded, deliverAlerts } =
      loadOperationalOutboxObservability();
    if (
      typeof getOutboxStatus !== "function" ||
      typeof getOutboxHealthSignals !== "function" ||
      typeof evaluateAlerts !== "function" ||
      typeof deliverAlerts !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const payload = req.body || {};
    const householdId = String(payload.householdId || req.query.householdId || "").trim();
    const windowMs = Number(payload.windowMs || req.query.windowMs || 300000);
    const [outbox, health] = await Promise.all([
      getOutboxStatus({ householdId: householdId || null }),
      getOutboxHealthSignals({ householdId: householdId || null }),
    ]);

    if (typeof ensureThresholdOverridesLoaded === "function") {
      await ensureThresholdOverridesLoaded();
    }

    const alerts = evaluateAlerts({
      outboxSummary: outbox.summary,
      healthSignals: health,
      windowMs,
    });

    const delivery = await deliverAlerts({
      payload: {
        householdId: householdId || null,
        windowMs: alerts.windowMs,
        outbox: outbox.summary,
        health,
        thresholds: alerts.thresholds,
        alerts: alerts.alerts,
        hasCritical: alerts.hasCritical,
        hasWarning: alerts.hasWarning,
      },
      force: payload.force === true,
      urls: Array.isArray(payload.urls) ? payload.urls : null,
    });

    return res.json({
      ok: true,
      householdId: householdId || null,
      outbox: outbox.summary,
      health,
      alerts,
      delivery,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
  }
);

router.get("/operational/outbox/alert-deliveries", async (req, res) => {
  try {
    const { getAlertDeliveryHistory } = loadOperationalOutboxObservability();
    if (typeof getAlertDeliveryHistory !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const limit = Number(req.query.limit || 50);
    const items = getAlertDeliveryHistory({ limit });
    return res.json({ ok: true, count: items.length, items });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/outbox/events", async (req, res) => {
  try {
    const { getRecentEvents } = loadOperationalOutboxObservability();
    if (typeof getRecentEvents !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const limit = Number(req.query.limit || 100);
    const items = getRecentEvents({ limit });
    return res.json({ ok: true, count: items.length, items });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/outbox/alert-thresholds", async (req, res) => {
  try {
    const { getThresholds, ensureThresholdOverridesLoaded } = loadOperationalOutboxObservability();
    if (typeof getThresholds !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    if (typeof ensureThresholdOverridesLoaded === "function") {
      await ensureThresholdOverridesLoaded();
    }

    return res.json({ ok: true, thresholds: getThresholds() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post(
  "/operational/outbox/alert-thresholds",
  requirePlannerAdminRole(),
  express.json(),
  async (req, res) => {
  try {
    const { setThresholdOverrides, clearThresholdOverrides, getThresholds } =
      loadOperationalOutboxObservability();
    if (
      typeof setThresholdOverrides !== "function" ||
      typeof clearThresholdOverrides !== "function" ||
      typeof getThresholds !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const payload = req.body || {};
    if (payload.reset === true) {
      const thresholds = await clearThresholdOverrides();
      return res.json({ ok: true, reset: true, thresholds });
    }

    const thresholds = await setThresholdOverrides(payload.thresholds || {});
    return res.json({ ok: true, thresholds });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
  }
);

router.get("/operational/outbox/observability", async (req, res) => {
  try {
    const { getOutboxStatus, getOutboxHealthSignals } = loadOperationalOutboxService();
    const { getOperationalProjectionWorkerStatus } = loadOperationalProjectionWorker();
    const { getMetricsSnapshot, evaluateAlerts, getThresholds, getRecentEvents, ensureThresholdOverridesLoaded } =
      loadOperationalOutboxObservability();
    if (
      typeof getOutboxStatus !== "function" ||
      typeof getOutboxHealthSignals !== "function" ||
      typeof getMetricsSnapshot !== "function" ||
      typeof evaluateAlerts !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const householdId = String(req.query.householdId || "").trim();
    const windowMs = Number(req.query.windowMs || 300000);
    const recentLimit = Number(req.query.eventsLimit || 50);
    const [outbox, health, metrics, workerStatus] = await Promise.all([
      getOutboxStatus({ householdId: householdId || null }),
      getOutboxHealthSignals({ householdId: householdId || null }),
      Promise.resolve(getMetricsSnapshot({ windowMs })),
      typeof getOperationalProjectionWorkerStatus === "function"
        ? getOperationalProjectionWorkerStatus()
        : Promise.resolve(null),
    ]);

    if (typeof ensureThresholdOverridesLoaded === "function") {
      await ensureThresholdOverridesLoaded();
    }

    const alerts = evaluateAlerts({
      outboxSummary: outbox.summary,
      healthSignals: health,
      windowMs,
    });

    return res.json({
      ok: true,
      householdId: householdId || null,
      outbox: outbox.summary,
      health,
      worker: workerStatus?.worker || null,
      metrics,
      alerts,
      thresholds: typeof getThresholds === "function" ? getThresholds() : null,
      recentEvents: typeof getRecentEvents === "function" ? getRecentEvents({ limit: recentLimit }) : [],
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post(
  "/operational/outbox/claim",
  requirePlannerAdminRole(),
  express.json(),
  async (req, res) => {
  try {
    const { claimOutboxBatch } = loadOperationalOutboxService();
    if (typeof claimOutboxBatch !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_unavailable" });
    }
    const payload = req.body || {};
    const claimed = await claimOutboxBatch({
      limit: Number(payload.limit || 25),
      householdId: payload.householdId == null ? null : String(payload.householdId),
    });
    return res.json({ ok: true, claimed: claimed.length, items: claimed });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
  }
);

router.post(
  "/operational/outbox/retry",
  requirePlannerAdminRole(),
  express.json(),
  async (req, res) => {
  try {
    const { markOutboxRetry, markOutboxDeadLetter, getOutboxEventById } = loadOperationalOutboxService();
    if (typeof markOutboxRetry !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_unavailable" });
    }
    const payload = req.body || {};
    const id = String(payload.id || "").trim();
    if (!id) {
      return res.status(400).json({ ok: false, error: "missing_outbox_id" });
    }

    const existing =
      typeof getOutboxEventById === "function" ? await getOutboxEventById(id) : null;
    if (!existing) {
      return res.status(404).json({ ok: false, error: "outbox_event_not_found" });
    }

    if (payload.deadLetter === true) {
      if (typeof markOutboxDeadLetter !== "function") {
        return res.status(503).json({ ok: false, error: "operational_outbox_dead_letter_unavailable" });
      }

      const deadLettered = await markOutboxDeadLetter(id, {
        reason: payload.error || "manual_dead_letter",
        updatedBy: String(payload.updatedBy || "operational.api"),
        changeReason: String(payload.changeReason || "manual_dead_letter"),
      });
      return res.json({ ok: true, deadLettered });
    }

    const retried = await markOutboxRetry(id, {
      delayMs: Number(payload.delayMs || 0),
      error: payload.error || "manual_retry",
      updatedBy: String(payload.updatedBy || "operational.api"),
      changeReason: String(payload.changeReason || "manual_retry"),
    });

    return res.json({ ok: true, retried });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
  }
);

router.post(
  "/operational/outbox/replay-dead-letter",
  requirePlannerAdminRole(),
  express.json(),
  async (req, res) => {
  try {
    const { replayDeadLetter, getDeadLetterSummary } = loadOperationalOutboxService();
    if (typeof replayDeadLetter !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_unavailable" });
    }

    const payload = req.body || {};
    const replayed = await replayDeadLetter({
      householdId: payload.householdId == null ? null : String(payload.householdId),
      eventType: payload.eventType == null ? null : String(payload.eventType),
      limit: Number(payload.limit || 100),
      updatedBy: String(payload.updatedBy || "operational.api"),
      changeReason: String(payload.changeReason || "manual_dead_letter_replay"),
    });

    const deadLetterSummary =
      typeof getDeadLetterSummary === "function"
        ? await getDeadLetterSummary({
            householdId: payload.householdId == null ? null : String(payload.householdId),
          })
        : [];

    return res.json({
      ok: true,
      replayed: replayed.length,
      items: replayed,
      deadLetterSummary,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
  }
);

router.post(
  "/operational/outbox/process",
  requirePlannerAdminRole(),
  express.json(),
  async (req, res) => {
  try {
    const { processOutboxBatch } = loadOperationalProjectionWorker();
    if (typeof processOutboxBatch !== "function") {
      return res.status(503).json({ ok: false, error: "operational_projection_unavailable" });
    }
    const payload = req.body || {};
    const result = await processOutboxBatch({
      limit: Number(payload.limit || 25),
      householdId: payload.householdId == null ? null : String(payload.householdId),
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
  }
);

module.exports = router;
