// src/services/sharing/communitySharingService.js
/* eslint-disable no-console */

/**
 * Suka Smart Assistant — Community Sharing & Goals Service
 * -------------------------------------------------------------
 * Share & co-plan with selected people across appropriate categories.
 * Now with collaborative Goals, Milestones, Tasks, and Planning Sessions.
 *
 * - Clear IA: circles (groups) → invites → shares → goals → sessions.
 * - Intuitive flow: create circle → invite → share → define goal →
 *   add milestones/tasks → plan sessions → track progress.
 * - Consistent design: emits ui.* toasts/empty/undo/nba + route glue.
 * - Event-driven: reacts to recipes/inventory/calendar changes.
 * - Safety: optional Sabbath guard, revocable links.
 *
 * Storage: localStorage (swap to remote later). No external deps.
 */

import {
  events,
  NAMES,
  buildEvent,
  emitEvent,
} from "@/services/events/contracts";

import { guardSabbathAction } from "@/services/integration/torahProfileHooks";

/* ──────────────────────────────────────────────────────────────
 * Storage & Schema
 * ────────────────────────────────────────────────────────────── */
const STORAGE_KEY = "suka.community.v2"; // bump version
const isStr = (v) => typeof v === "string" && v.length > 0;
const isNum = (v) => Number.isFinite(v);
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const nowISO = () => new Date().toISOString();

const DEFAULT = Object.freeze({
  circles: [],  // [{ id, name, ownerId, createdAt, members:[{id,email,role}] }]
  invites: [],  // [{ id, circleId, email, role, status, createdAt }]
  shares:  [],  // [{ id, circleId, scope, refId, title, permissions, meta, createdAt }]
  goals:   [],  // [{ id, circleId, title, description, categories[], ownerId, createdAt, updatedAt, progress, progressMode, links[], archived }]
  milestones: [], // [{ id, goalId, title, due, weight, createdAt, completedAt }]
  tasks:    [],  // [{ id, goalId, milestoneId?, title, ownerId?, due?, weight, done, notes }]
  sessions: [],  // [{ id, circleId, goalId?, title, startISO, endISO, attendees[], agenda, createdAt }]
});

const storage = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { ...DEFAULT };
      const parsed = JSON.parse(raw);
      return { ...DEFAULT, ...parsed };
    } catch {
      return { ...DEFAULT };
    }
  },
  save(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn("[community] storage save error", e);
    }
  },
};

function getState() { return storage.load(); }
function setState(next) { storage.save(next); }

/* ──────────────────────────────────────────────────────────────
 * Design-system glue
 * ────────────────────────────────────────────────────────────── */
function toast(variant, title, message) {
  events.emit(buildEvent(NAMES["ui.toast.shown"], { variant, title, message }, { source: "communitySharing" }));
}
function nba(label, hint, route, params) {
  events.emit(buildEvent(NAMES["ui.nba.suggested"], { label, hint, route, params }, { source: "communitySharing" }));
}
function empty(context, actions = []) {
  events.emit(buildEvent(NAMES["ui.empty.presented"], { context, actions }, { source: "communitySharing" }));
}

/* ──────────────────────────────────────────────────────────────
 * Circles (create / rename / delete) — (unchanged API)
 * ────────────────────────────────────────────────────────────── */
export function createCircle(name, { ownerId = "me", members = [] } = {}) {
  if (!isStr(name)) {
    empty("community.circle.empty", [
      { label: "Open Community", eventName: NAMES["ia.route.navigated"], payload: { path: "/community" } },
      { label: "Create Circle",  eventName: NAMES["ui.modal.open"],     payload: { id: "createCircle" } },
    ]);
    return null;
  }
  const s = getState();
  const circle = { id: uid(), name, ownerId, createdAt: nowISO(), members: [{ id: ownerId, email: null, role: "owner" }, ...members] };
  s.circles.unshift(circle);
  setState(s);

  emitEvent(NAMES["community.circle.created"] || "community.circle.created", { circleId: circle.id, name: circle.name }, {
    source: "communitySharing.createCircle",
    undo: { label: "Undo", handler: () => { const x = getState(); x.circles = x.circles.filter(c => c.id !== circle.id); setState(x); toast("info","Circle removed","Creation was undone."); } },
    nextBestAction: { label: "Invite People", hint: "Send a private invite", route: "/community", params: { circleId: circle.id, tab: "invites" } },
  });

  toast("success", "Circle created", `"${name}" is ready.`);
  return circle;
}

export function renameCircle(circleId, nextName) {
  const s = getState(); const c = s.circles.find((x) => x.id === circleId); if (!c) return null;
  const prev = c.name; c.name = nextName; setState(s);
  emitEvent(NAMES["community.circle.renamed"] || "community.circle.renamed", { circleId, name: nextName }, {
    source: "communitySharing.renameCircle",
    undo: { label: "Undo", handler: () => { const y = getState(); const c2 = y.circles.find((x)=>x.id===circleId); if (c2) c2.name = prev; setState(y); toast("info","Reverted","Circle name restored."); } },
  });
  toast("success","Name updated","Circle renamed."); return c;
}

export function deleteCircle(circleId) {
  const s = getState(); const snapshot = { ...s };
  s.circles = s.circles.filter((x)=>x.id!==circleId);
  s.invites = s.invites.filter((i)=>i.circleId!==circleId);
  s.shares  = s.shares.filter((sh)=>sh.circleId!==circleId);
  s.sessions = s.sessions.filter((ss)=>ss.circleId!==circleId);
  const goalIds = s.goals.filter(g=>g.circleId===circleId).map(g=>g.id);
  s.goals = s.goals.filter(g=>g.circleId!==circleId);
  s.milestones = s.milestones.filter(m=>!goalIds.includes(m.goalId));
  s.tasks = s.tasks.filter(t=>!goalIds.includes(t.goalId));
  setState(s);

  emitEvent(NAMES["community.circle.deleted"] || "community.circle.deleted", { circleId }, {
    source: "communitySharing.deleteCircle",
    undo: { label: "Undo", handler: () => { setState(snapshot); toast("info","Circle restored","Deletion was undone."); } },
    nextBestAction: { label: "Create New Circle", hint: "Start a new group", route: "/community#new" },
  });
  toast("warning","Circle deleted","Access revoked for all shares.");
  return true;
}

/* ──────────────────────────────────────────────────────────────
 * Invites (send / revoke / accept) — (unchanged API)
 * ────────────────────────────────────────────────────────────── */
export function inviteToCircle(circleId, email, role = "viewer", { respectSabbath = true } = {}) {
  const s = getState(); const circle = s.circles.find((x) => x.id === circleId);
  if (!circle || !isStr(email)) { empty("community.invite.empty", [{ label:"Open Community", eventName:NAMES["ia.route.navigated"], payload:{ path:"/community"} }]); return null; }
  if (respectSabbath) {
    const { allowed } = guardSabbathAction("Send Invite", { onProceed: null, onBlocked: () => {}, allowEssentials: false });
    if (!allowed) return null;
  }
  const inv = { id: uid(), circleId, email, role, status: "pending", createdAt: nowISO() };
  s.invites.unshift(inv); setState(s);

  emitEvent(NAMES["community.invite.sent"] || "community.invite.sent", { inviteId: inv.id, circleId, email, role }, {
    source: "communitySharing.inviteToCircle",
    undo: { label: "Undo", handler: () => { const x = getState(); x.invites = x.invites.filter((i)=>i.id!==inv.id); setState(x); toast("info","Invite canceled","The invite was withdrawn."); } },
    nextBestAction: { label: "Share Something", hint: "Pick items to share", route: "/community", params: { circleId, tab: "share" } },
  });
  toast("success","Invite sent",`Invited ${email}`); return inv;
}

export function revokeInvite(inviteId) {
  const s = getState(); const inv = s.invites.find((i)=>i.id===inviteId); if (!inv) return false;
  const prev = { ...inv }; inv.status="revoked"; setState(s);
  emitEvent(NAMES["community.invite.revoked"] || "community.invite.revoked", { inviteId }, {
    source: "communitySharing.revokeInvite",
    undo: { label:"Undo", handler: () => { const x=getState(); const i2 = x.invites.find((i)=>i.id===inviteId); if(i2) i2.status=prev.status; setState(x); toast("info","Invite restored","Revocation undone."); } },
  });
  toast("warning","Invite revoked","Recipient can no longer accept."); return true;
}

export function acceptInvite(inviteId, memberId, email) {
  const s=getState(); const inv=s.invites.find((i)=>i.id===inviteId); if(!inv||inv.status!=="pending") return null;
  inv.status="accepted"; const circle=s.circles.find((c)=>c.id===inv.circleId);
  if (circle && !circle.members.some((m)=>m.email===email)) circle.members.push({ id: memberId||uid(), email, role: inv.role });
  setState(s);

  emitEvent(NAMES["community.invite.accepted"] || "community.invite.accepted", { inviteId, circleId: inv.circleId, email }, {
    source: "communitySharing.acceptInvite",
    nextBestAction: { label: "View Shared Items", hint: "See what’s available", route: "/community", params: { circleId: inv.circleId, tab: "shared" } },
  });
  toast("success","Joined circle","You now have access."); return inv;
}

/* ──────────────────────────────────────────────────────────────
 * Shares (by category/scope) — (unchanged API)
 * ────────────────────────────────────────────────────────────── */
const ALLOWED_SCOPES = new Set([
  "meals","recipes","inventory","garden","cleaning",
  "animals","storehouse","waste","preservation","procurement",
  "calendar","mealplan","labels",
]);

export function shareToCircle(circleId, payload) {
  const s = getState(); const circle = s.circles.find((x)=>x.id===circleId);
  if (!circle) { empty("community.share.empty", [{ label:"Open Community", eventName:NAMES["ia.route.navigated"], payload:{ path:"/community"} }]); return null; }
  if (!payload || !ALLOWED_SCOPES.has(payload.scope)) { toast("warning","Not shareable","This category cannot be shared."); return null; }

  const share = { id: uid(), circleId, scope: payload.scope, refId: payload.refId, title: payload.title || payload.refId, permissions: payload.permissions || "view", meta: payload.meta || {}, createdAt: nowISO() };
  s.shares.unshift(share); setState(s);

  emitEvent(NAMES["community.share.created"] || "community.share.created", { shareId: share.id, circleId, scope: share.scope }, {
    source: "communitySharing.shareToCircle",
    undo: { label:"Undo", handler: () => { const x=getState(); x.shares = x.shares.filter((sh)=>sh.id!==share.id); setState(x); toast("info","Share removed","Access revoked."); } },
    nextBestAction: { label: "Create a Goal", hint: "Plan together", route: "/community", params: { circleId, tab: "goals" } },
  });

  toast("success","Shared",`"${share.title}" shared with ${circle.name}`);
  return share;
}

export function revokeShare(shareId) {
  const s=getState(); const idx=s.shares.findIndex((sh)=>sh.id===shareId); if(idx<0) return false;
  const prev=s.shares[idx]; s.shares.splice(idx,1); setState(s);
  emitEvent(NAMES["community.share.revoked"] || "community.share.revoked",{ shareId },{
    source:"communitySharing.revokeShare",
    undo:{ label:"Undo", handler:()=>{ const x=getState(); x.shares.unshift(prev); setState(x); toast("info","Share restored","Access reinstated."); } },
  });
  toast("warning","Share revoked","Circle can no longer view/edit."); return true;
}

/* ──────────────────────────────────────────────────────────────
 * GOALS: create / update / archive / progress
 *   - categories: array of scopes (single or combination).
 *   - progressMode: 'auto' (from tasks & milestones) | 'manual'
 *   - links: tie shares/items to this goal.
 * ────────────────────────────────────────────────────────────── */
function computeProgress(state, goalId) {
  const tasks = state.tasks.filter(t => t.goalId === goalId);
  const mils  = state.milestones.filter(m => m.goalId === goalId);
  let totalW = 0, doneW = 0;

  // Task weights (default 1)
  for (const t of tasks) {
    const w = isNum(t.weight) ? t.weight : 1;
    totalW += w;
    if (t.done) doneW += w;
  }
  // Milestone weights (default 1)
  for (const m of mils) {
    const w = isNum(m.weight) ? m.weight : 1;
    totalW += w;
    if (m.completedAt) doneW += w;
  }

  if (totalW === 0) return 0;
  const pct = Math.round((doneW / totalW) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** Create a collaborative goal, scoped to one or many categories. */
export function createGoal(circleId, { title, description = "", categories = [], ownerId = "me", links = [], progressMode = "auto" } = {}) {
  if (!isStr(title)) {
    empty("community.goal.empty", [
      { label: "Create Goal", eventName: NAMES["ui.modal.open"], payload: { id: "createGoal" } },
      { label: "Open Community", eventName: NAMES["ia.route.navigated"], payload: { path: "/community" } },
    ]);
    return null;
  }
  const s = getState();
  const goal = {
    id: uid(), circleId, title, description, categories: Array.from(new Set(categories.filter(Boolean))),
    ownerId, createdAt: nowISO(), updatedAt: nowISO(), progress: 0, progressMode: progressMode === "manual" ? "manual" : "auto",
    links: Array.isArray(links) ? links : [], archived: false,
  };
  s.goals.unshift(goal); setState(s);

  emitEvent(NAMES["community.goal.created"] || "community.goal.created", { goalId: goal.id, circleId, categories: goal.categories }, {
    source: "communitySharing.createGoal",
    undo: { label: "Undo", handler: () => { const x = getState(); x.goals = x.goals.filter(g => g.id !== goal.id); setState(x); toast("info","Goal removed","Creation was undone."); } },
    nextBestAction: { label: "Add Milestone", hint: "Break it down", route: "/community", params: { circleId, tab: "goals", goalId: goal.id } },
  });

  toast("success","Goal created", `"${title}" started.`);
  return goal;
}

export function updateGoal(goalId, partial = {}) {
  const s = getState(); const g = s.goals.find(x => x.id === goalId); if (!g) return null;
  const prev = { ...g };
  Object.assign(g, partial, { updatedAt: nowISO() });

  if (g.progressMode === "auto") g.progress = computeProgress(s, goalId);
  setState(s);

  emitEvent(NAMES["community.goal.updated"] || "community.goal.updated", { goalId }, {
    source: "communitySharing.updateGoal",
    undo: { label: "Undo", handler: () => { const x=getState(); const ref = x.goals.find(y=>y.id===goalId); if (ref) Object.assign(ref, prev); if (ref?.progressMode==="auto") ref.progress=computeProgress(x, goalId); setState(x); toast("info","Goal restored","Changes were undone."); } },
  });
  toast("success","Goal updated","Changes saved.");
  return g;
}

export function setGoalProgress(goalId, pct) {
  const s = getState(); const g = s.goals.find(x => x.id === goalId); if (!g) return null;
  if (g.progressMode !== "manual") { toast("warning","Auto progress","Switch to manual to override."); return g; }
  const prev = g.progress; g.progress = Math.max(0, Math.min(100, Number(pct)||0)); g.updatedAt = nowISO(); setState(s);

  emitEvent(NAMES["community.goal.progress.set"] || "community.goal.progress.set", { goalId, progress: g.progress }, {
    source:"communitySharing.setGoalProgress",
    undo:{ label:"Undo", handler:()=>{ const x=getState(); const gg=x.goals.find(y=>y.id===goalId); if(gg){ gg.progress=prev; gg.updatedAt=nowISO(); } setState(x); toast("info","Progress reverted","Manual progress restored."); } },
  });
  toast("success","Progress updated",`${g.progress}% complete.`);
  return g;
}

export function archiveGoal(goalId, archived = true) {
  const s=getState(); const g=s.goals.find(x=>x.id===goalId); if(!g) return false;
  const prev = g.archived; g.archived = !!archived; g.updatedAt = nowISO(); setState(s);

  emitEvent(NAMES["community.goal.archived"] || "community.goal.archived", { goalId, archived: g.archived }, {
    source:"communitySharing.archiveGoal",
    undo:{ label:"Undo", handler:()=>{ const x=getState(); const gg=x.goals.find(y=>y.id===goalId); if(gg){ gg.archived=prev; gg.updatedAt=nowISO(); } setState(x); toast("info","Goal restored","Archive undone."); } },
  });
  toast(archived ? "warning" : "success", archived ? "Goal archived" : "Goal active", "");
  return true;
}

/* ──────────────────────────────────────────────────────────────
 * Milestones
 * ────────────────────────────────────────────────────────────── */
export function addMilestone(goalId, { title, due, weight = 1 } = {}) {
  if (!isStr(title)) return null;
  const s = getState();
  const m = { id: uid(), goalId, title, due: due || null, weight: Number(weight)||1, createdAt: nowISO(), completedAt: null };
  s.milestones.push(m);
  // update goal progress if auto
  const g = s.goals.find(x=>x.id===goalId); if (g && g.progressMode==="auto") g.progress=computeProgress(s, goalId); g && (g.updatedAt = nowISO());
  setState(s);

  emitEvent(NAMES["community.milestone.added"] || "community.milestone.added", { goalId, milestoneId: m.id }, {
    source:"communitySharing.addMilestone",
    undo:{ label:"Undo", handler:()=>{ const x=getState(); x.milestones = x.milestones.filter(mm=>mm.id!==m.id); const gg=x.goals.find(y=>y.id===goalId); if(gg && gg.progressMode==="auto") gg.progress=computeProgress(x, goalId); setState(x); toast("info","Milestone removed","Addition undone."); } },
    nextBestAction:{ label:"Add Tasks", hint:"What steps make this real?", route:"/community", params:{ tab:"goals", goalId } },
  });

  toast("success","Milestone added", title);
  return m;
}

export function completeMilestone(milestoneId, done = true) {
  const s=getState(); const m=s.milestones.find(x=>x.id===milestoneId); if(!m) return null;
  const prev = m.completedAt; m.completedAt = done ? nowISO() : null;
  const g=s.goals.find(x=>x.id===m.goalId); if (g && g.progressMode==="auto") g.progress=computeProgress(s, g.id); g && (g.updatedAt=nowISO());
  setState(s);

  emitEvent(NAMES["community.milestone.completed"] || "community.milestone.completed", { milestoneId, goalId: m.goalId, done }, {
    source:"communitySharing.completeMilestone",
    undo:{ label:"Undo", handler:()=>{ const x=getState(); const mm=x.milestones.find(y=>y.id===milestoneId); if(mm) mm.completedAt = prev; const gg=x.goals.find(y=>y.id===m.goalId); if(gg && gg.progressMode==="auto") gg.progress=computeProgress(x, gg.id); setState(x); toast("info","Milestone reverted","Completion undone."); } },
    nextBestAction:{ label:"Plan Session", hint:"Coordinate the next push", route:"/community", params:{ tab:"sessions", goalId: m.goalId } },
  });

  toast("success", done ? "Milestone completed" : "Marked incomplete", "");
  return m;
}

/* ──────────────────────────────────────────────────────────────
 * Tasks
 * ────────────────────────────────────────────────────────────── */
export function addTask(goalId, { title, ownerId = null, due = null, weight = 1, milestoneId = null, notes = "" } = {}) {
  if (!isStr(title)) return null;
  const s = getState();
  const t = { id: uid(), goalId, milestoneId, title, ownerId, due, weight: Number(weight)||1, done: false, notes };
  s.tasks.push(t);
  const g=s.goals.find(x=>x.id===goalId); if (g && g.progressMode==="auto") g.progress=computeProgress(s, goalId); g && (g.updatedAt=nowISO());
  setState(s);

  emitEvent(NAMES["community.task.added"] || "community.task.added", { goalId, taskId: t.id }, {
    source:"communitySharing.addTask",
    undo:{ label:"Undo", handler:()=>{ const x=getState(); x.tasks = x.tasks.filter(tt=>tt.id!==t.id); const gg=x.goals.find(y=>y.id===goalId); if(gg && gg.progressMode==="auto") gg.progress=computeProgress(x, goalId); setState(x); toast("info","Task removed","Addition undone."); } },
  });

  toast("success","Task added", title);
  return t;
}

export function toggleTask(taskId, done = true) {
  const s=getState(); const t=s.tasks.find(x=>x.id===taskId); if(!t) return null;
  const prev = t.done; t.done = !!done;
  const g=s.goals.find(x=>x.id===t.goalId); if (g && g.progressMode==="auto") g.progress=computeProgress(s, g.id); g && (g.updatedAt=nowISO());
  setState(s);

  emitEvent(NAMES["community.task.toggled"] || "community.task.toggled", { taskId, goalId: t.goalId, done }, {
    source:"communitySharing.toggleTask",
    undo:{ label:"Undo", handler:()=>{ const x=getState(); const tt=x.tasks.find(y=>y.id===taskId); if(tt) tt.done = prev; const gg=x.goals.find(y=>y.id===t.goalId); if(gg && gg.progressMode==="auto") gg.progress=computeProgress(x, gg.id); setState(x); toast("info","Task reverted","Completion undone."); } },
    nextBestAction: done ? { label:"Review Progress", hint:"See the updated %", route:"/community", params:{ tab:"goals", goalId: t.goalId } } : undefined,
  });

  toast("success", done ? "Task completed" : "Marked incomplete", "");
  return t;
}

export function updateTask(taskId, partial = {}) {
  const s=getState(); const t=s.tasks.find(x=>x.id===taskId); if(!t) return null;
  const prev = { ...t }; Object.assign(t, partial);
  const g=s.goals.find(x=>x.id===t.goalId); if (g && g.progressMode==="auto") g.progress=computeProgress(s, g.id); g && (g.updatedAt=nowISO());
  setState(s);

  emitEvent(NAMES["community.task.updated"] || "community.task.updated", { taskId, goalId: t.goalId }, {
    source:"communitySharing.updateTask",
    undo:{ label:"Undo", handler:()=>{ const x=getState(); const tt=x.tasks.find(y=>y.id===taskId); if(tt) Object.assign(tt, prev); const gg=x.goals.find(y=>y.id===t.goalId); if(gg && gg.progressMode==="auto") gg.progress=computeProgress(x, gg.id); setState(x); toast("info","Task restored","Changes undone."); } },
  });
  toast("success","Task updated","Changes saved.");
  return t;
}

/* ──────────────────────────────────────────────────────────────
 * Link shares/items to a goal (cross-category composition)
 * ────────────────────────────────────────────────────────────── */
export function linkShareToGoal(goalId, shareId) {
  const s=getState(); const g=s.goals.find(x=>x.id===goalId); const sh=s.shares.find(x=>x.id===shareId);
  if(!g || !sh) return null;
  if (!g.links.includes(shareId)) g.links.push(shareId);
  g.updatedAt = nowISO(); setState(s);

  emitEvent(NAMES["community.goal.linked"] || "community.goal.linked", { goalId, shareId }, {
    source:"communitySharing.linkShareToGoal",
    undo:{ label:"Undo", handler:()=>{ const x=getState(); const gg=x.goals.find(y=>y.id===goalId); if(gg) gg.links = gg.links.filter(id=>id!==shareId); gg && (gg.updatedAt=nowISO()); setState(x); toast("info","Link removed","Association undone."); } },
    nextBestAction:{ label:"Open Goal", hint:"See linked items", route:"/community", params:{ tab:"goals", goalId } },
  });
  toast("success","Linked to goal", sh.title || sh.refId);
  return g;
}

/* ──────────────────────────────────────────────────────────────
 * Planning Sessions (optional calendar glue)
 * ────────────────────────────────────────────────────────────── */
export function schedulePlanningSession(circleId, { goalId = null, title = "Planning Session", startISO, endISO, attendees = [], agenda = "" } = {}) {
  if (!isStr(startISO) || !isStr(endISO)) {
    empty("community.sessions.empty", [
      { label: "Pick Time", eventName: NAMES["ui.modal.open"], payload: { id: "scheduleSession" } },
    ]); return null;
  }
  const s=getState();
  const sess = { id: uid(), circleId, goalId, title, startISO, endISO, attendees, agenda, createdAt: nowISO() };
  s.sessions.push(sess); setState(s);

  // Calendar glue: suggest syncing
  emitEvent(NAMES["calendar.add"] || "calendar/add", { title, startISO, endISO, attendees, meta:{ circleId, goalId } }, {
    source: "communitySharing.schedulePlanningSession",
    nextBestAction: { label: "Open Calendar", hint: "Confirm invite", route: "/calendar" },
  });

  emitEvent(NAMES["community.session.scheduled"] || "community.session.scheduled", { sessionId: sess.id, circleId, goalId }, {
    source: "communitySharing.schedulePlanningSession",
    undo: { label:"Undo", handler:()=>{ const x=getState(); x.sessions = x.sessions.filter(ss=>ss.id!==sess.id); setState(x); toast("info","Session removed","Scheduling undone."); } },
  });

  toast("success","Session scheduled", new Date(startISO).toLocaleString());
  return sess;
}

/* ──────────────────────────────────────────────────────────────
 * Queries (for UI)
 * ────────────────────────────────────────────────────────────── */
export function listCircles()  { return getState().circles; }
export function listInvites()  { return getState().invites; }
export function listShares({ circleId, scope } = {}) {
  const all = getState().shares;
  return all.filter((s) => (!circleId || s.circleId === circleId) && (!scope || s.scope === scope));
}
export function listGoals({ circleId, includeArchived = false } = {}) {
  const all = getState().goals.filter(g => !circleId || g.circleId === circleId);
  return includeArchived ? all : all.filter(g => !g.archived);
}
export function listMilestones(goalId) { return getState().milestones.filter(m => m.goalId === goalId); }
export function listTasks({ goalId, milestoneId } = {}) {
  const all = getState().tasks.filter(t => !goalId || t.goalId === goalId);
  return milestoneId ? all.filter(t => t.milestoneId === milestoneId) : all;
}
export function listSessions({ circleId, goalId } = {}) {
  const all = getState().sessions.filter(s => !circleId || s.circleId === circleId);
  return goalId ? all.filter(s => s.goalId === goalId) : all;
}

/* ──────────────────────────────────────────────────────────────
 * Event-driven nudges
 * ────────────────────────────────────────────────────────────── */
// Recipes consolidated → suggest a goal for meal prep
events.on(NAMES["recipes.consolidated"] || "recipes.consolidated", () => {
  nba("Start a Meal Prep Goal", "Plan this week’s cook-up", "/community", { tab: "goals", pick: ["meals","recipes"] });
});
// Inventory increased → suggest “Pantry Readiness” goal
events.on(NAMES["inventory.updated"], ({ payload }) => {
  const diffs = payload?.diffs || [];
  if (!Array.isArray(diffs) || diffs.length === 0) return;
  const added = diffs.some((d) => Number(d?.delta || 0) > 0);
  if (added) nba("Pantry Readiness Goal", "Set par & labels across bins", "/community", { tab: "goals", pick: ["inventory","labels","storehouse"] });
});
// Calendar synced → nudge to plan session for any active goal < 50%
events.on(NAMES["calendar.events.created"], () => {
  const s = getState();
  const under50 = s.goals.filter(g => !g.archived && (g.progressMode === "manual" ? (g.progress||0) < 50 : computeProgress(s, g.id) < 50));
  if (under50.length) nba("Plan a Session", "Meet to move a goal forward", "/community", { tab: "sessions" });
});

/* ──────────────────────────────────────────────────────────────
 * Empty-state bootstrapping
 * ────────────────────────────────────────────────────────────── */
(function init() {
  const s = getState();
  if (s.circles.length === 0) {
    empty("community.getting-started", [
      { label: "Create a Circle", eventName: NAMES["ui.modal.open"], payload: { id: "createCircle" } },
      { label: "Learn More",      eventName: NAMES["ia.route.navigated"], payload: { path: "/community" } },
    ]);
  } else if (s.goals.filter(g=>!g.archived).length === 0) {
    empty("community.goals.empty", [
      { label: "Create First Goal", eventName: NAMES["ui.modal.open"], payload: { id: "createGoal" } },
      { label: "Share Items",       eventName: NAMES["ia.route.navigated"], payload: { path: "/community?tab=share" } },
    ]);
  }
})();

/* ──────────────────────────────────────────────────────────────
 * Public API
 * ────────────────────────────────────────────────────────────── */
export default {
  // circles
  createCircle,
  renameCircle,
  deleteCircle,

  // invites
  inviteToCircle,
  revokeInvite,
  acceptInvite,

  // shares
  shareToCircle,
  revokeShare,

  // goals
  createGoal,
  updateGoal,
  archiveGoal,
  setGoalProgress,
  linkShareToGoal,

  // milestones
  addMilestone,
  completeMilestone,

  // tasks
  addTask,
  toggleTask,
  updateTask,

  // sessions
  schedulePlanningSession,

  // queries
  listCircles,
  listInvites,
  listShares,
  listGoals,
  listMilestones,
  listTasks,
  listSessions,
};
