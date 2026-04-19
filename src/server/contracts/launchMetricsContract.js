"use strict";

const DEFAULT_LAUNCH_GATE_THRESHOLDS = Object.freeze({
  activationRate: 0.35,
  weeklyActiveHouseholdsRate: 0.4,
  taskCompletionRate: 0.65,
  collaborationDepth: 1.2,
  participationRate: 0.5,
  medianResolutionHours: 48,
  retentionWeek2: 0.25,
  retentionWeek4: 0.15,
});

function toValidDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function normalizeTimeWindow({ from, to } = {}) {
  const end = toValidDate(to) || new Date();
  const start = toValidDate(from) || new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (start > end) {
    return {
      from: end,
      to: start,
    };
  }
  return {
    from: start,
    to: end,
  };
}

function inWindow(value, window) {
  const date = toValidDate(value);
  if (!date) return false;
  return date >= window.from && date <= window.to;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function percentage(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function median(values) {
  const list = safeArray(values)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!list.length) return 0;
  const middle = Math.floor(list.length / 2);
  if (list.length % 2 === 0) {
    return Number(((list[middle - 1] + list[middle]) / 2).toFixed(2));
  }
  return Number(list[middle].toFixed(2));
}

function resolveCohortMatch(record, cohort) {
  if (!cohort) return true;
  const value = String(record?.cohort || record?.householdCohort || "").toLowerCase();
  return value === String(cohort).toLowerCase();
}

function computeLaunchMetrics({ householdState = {}, cohort = null, timeWindow } = {}) {
  const window = normalizeTimeWindow(timeWindow);
  const tasks = safeArray(householdState.tasks).filter((task) => inWindow(task?.createdAt || task?.updatedAt, window));
  const completedTasks = tasks.filter((task) => String(task?.status || "").toLowerCase() === "completed");

  const approvals = safeArray(householdState.approvals).filter((approval) => inWindow(approval?.createdAt || approval?.decidedAt, window));
  const resolvedApprovals = approvals.filter((approval) => approval?.decidedAt);

  const projects = safeArray(householdState.projectSpaces).filter((space) => resolveCohortMatch(space, cohort));
  const contributions = projects.reduce((sum, space) => sum + safeArray(space?.contributions).length, 0);
  const disputes = projects.reduce((sum, space) => sum + safeArray(space?.disputes).length, 0);

  const memberships = safeArray(householdState.memberships).filter((membership) => resolveCohortMatch(membership, cohort));
  const activeMemberships = memberships.filter((membership) => {
    const touchedAt = membership?.lastActiveAt || membership?.updatedAt || membership?.createdAt;
    return inWindow(touchedAt, window);
  });

  const events = [
    ...safeArray(householdState.tasks).map((task) => ({
      actor: task?.assignee || task?.owner,
      at: task?.createdAt || task?.updatedAt,
    })),
    ...safeArray(householdState.approvals).map((approval) => ({
      actor: approval?.requestedBy,
      at: approval?.createdAt,
    })),
    ...projects.flatMap((space) =>
      safeArray(space?.contributions).map((contribution) => ({
        actor: contribution?.author,
        at: contribution?.createdAt,
      })),
    ),
  ].filter((event) => event.actor && inWindow(event.at, window));

  const uniqueActors = new Set(events.map((event) => String(event.actor))).size;
  const weeklyActiveHouseholdsRate = events.length > 0 ? 1 : 0;

  const resolutionHours = resolvedApprovals
    .map((approval) => {
      const createdAt = toValidDate(approval?.createdAt);
      const decidedAt = toValidDate(approval?.decidedAt);
      if (!createdAt || !decidedAt) return null;
      return (decidedAt.getTime() - createdAt.getTime()) / (60 * 60 * 1000);
    })
    .filter((hours) => Number.isFinite(hours) && hours >= 0);

  const firstEventDate = events
    .map((event) => toValidDate(event.at))
    .filter(Boolean)
    .sort((a, b) => a - b)[0] || null;

  const day = 24 * 60 * 60 * 1000;
  const retentionWeek2 = firstEventDate
    ? events.some((event) => {
        const at = toValidDate(event.at);
        if (!at) return false;
        const delta = at.getTime() - firstEventDate.getTime();
        return delta >= 8 * day && delta <= 14 * day;
      })
      ? 1
      : 0
    : 0;

  const retentionWeek4 = firstEventDate
    ? events.some((event) => {
        const at = toValidDate(event.at);
        if (!at) return false;
        const delta = at.getTime() - firstEventDate.getTime();
        return delta >= 22 * day && delta <= 30 * day;
      })
      ? 1
      : 0
    : 0;

  return {
    cohort: cohort ? String(cohort) : null,
    timeWindow: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    },
    metrics: {
      activationRate: percentage(tasks.length > 0 ? 1 : 0, 1),
      weeklyActiveHouseholdsRate,
      taskCompletionRate: percentage(completedTasks.length, tasks.length),
      collaborationDepth: Number((projects.length ? (contributions + disputes) / projects.length : 0).toFixed(4)),
      participationRate: percentage(uniqueActors, Math.max(memberships.length, 1)),
      medianResolutionHours: median(resolutionHours),
      retentionWeek2,
      retentionWeek4,
    },
  };
}

function evaluateLaunchGates(metrics, thresholds = DEFAULT_LAUNCH_GATE_THRESHOLDS) {
  const pairs = [
    ["activationRate", "gte"],
    ["weeklyActiveHouseholdsRate", "gte"],
    ["taskCompletionRate", "gte"],
    ["collaborationDepth", "gte"],
    ["participationRate", "gte"],
    ["medianResolutionHours", "lte"],
    ["retentionWeek2", "gte"],
    ["retentionWeek4", "gte"],
  ];

  const failures = [];

  pairs.forEach(([key, mode]) => {
    const actual = Number(metrics?.[key]);
    const target = Number(thresholds?.[key]);
    if (!Number.isFinite(actual) || !Number.isFinite(target)) return;
    const pass = mode === "lte" ? actual <= target : actual >= target;
    if (!pass) {
      failures.push({ key, mode, actual, target });
    }
  });

  return {
    pass: failures.length === 0,
    failures,
    thresholds,
  };
}

module.exports = {
  DEFAULT_LAUNCH_GATE_THRESHOLDS,
  normalizeTimeWindow,
  computeLaunchMetrics,
  evaluateLaunchGates,
};
