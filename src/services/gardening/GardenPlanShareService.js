// File: src/services/gardening/GardenPlanShareService.js
/**
 * GardenPlanShareService (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Share Garden Plans & Garden Schedule Packets across:
 *      • Household (self)
 *      • Small Group
 *      • Coalition
 *      • Specific households / roles
 *  - Browser-only. NO Node imports.
 *  - Local-first: supports "export/download/copy" immediately.
 *  - In-app share-ready: uses an Outbox/InBox repository abstraction that can
 *    later be backed by Dexie tables or Hub sync without changing callers.
 *
 * Integrations (soft)
 *  - GardenPlanStore (exportPlan + generateSchedule)
 *  - eventBus for orchestration
 *  - GroupStore / CoalitionStore / Household store (optional; caller can supply)
 *
 * Share Modes
 *  1) assignment (read-only schedule packet):
 *     - recipients execute tasks; can return completion receipts later.
 *  2) collaborative (plan source-of-truth):
 *     - recipients can import + propose changes (merge workflow later).
 *  3) template:
 *     - plan scrubbed of status/history/PII, used as a starter plan.
 *
 * Packet Shapes (SSA style)
 *  - Envelope-like object you can persist or send:
 *    {
 *      id, kind, version,
 *      createdAtISO,
 *      createdBy: { actorId?, householdId? },
 *      scope: { type:"household"|"group"|"coalition"|"direct", id?:string, name?:string },
 *      recipients: [{ type:"household"|"role"|"member", id, label? }],
 *      permissions: { mode, canEdit, canMarkDone, canReturnReceipts },
 *      payload: { ... }              // plan or schedule
 *      meta: { title, notes, tags, links? }
 *    }
 *
 * Events emitted
 *  - garden/plan.share.requested
 *  - garden/plan.share.prepared
 *  - garden/plan.share.sent
 *  - garden/plan.share.failed
 *  - garden/plan.receipt.created (optional)
 *
 * NOTE
 *  - This service does NOT require the Hub. It can run fully offline.
 *  - When you wire Hub sync later, simply implement the ShareTransport below.
 */

import { eventBus } from "@/services/events/eventBus";
import GardenPlanStore from "@/services/gardening/GardenPlanStore";

const SOURCE = "gardening.GardenPlanShareService";

/* -------------------------------------------------------------------------- */
/*                                   Utils                                    */
/* -------------------------------------------------------------------------- */

function nowISO() {
  return new Date().toISOString();
}

function genId(prefix = "gpshare") {
  return `${prefix}_${Math.random()
    .toString(36)
    .slice(2)}_${Date.now().toString(36)}`;
}

function isPlainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function safeString(v) {
  return String(v ?? "");
}

function uniqStrings(arr) {
  const set = new Set();
  for (const s of Array.isArray(arr) ? arr : []) {
    const v = safeString(s).trim();
    if (v) set.add(v);
  }
  return Array.from(set);
}

function deepClone(obj) {
  try {
    return structuredClone(obj);
  } catch {
    return JSON.parse(JSON.stringify(obj || {}));
  }
}

function emit(type, data, opts = {}) {
  try {
    eventBus?.emit?.(type, data, { source: SOURCE, ...(opts || {}) });
  } catch {
    // noop
  }
}

/* -------------------------------------------------------------------------- */
/*                          Default Outbox/InBox Repo                          */
/* -------------------------------------------------------------------------- */

/**
 * Minimal localStorage outbox/inbox so sharing works "in-app" even without Hub.
 * You can later swap this for Dexie tables (recommended).
 */
const LS_OUTBOX = "ssa.share.garden.outbox.v1";
const LS_INBOX = "ssa.share.garden.inbox.v1";

function readLS(key) {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLS(key, value) {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(
      key,
      JSON.stringify(Array.isArray(value) ? value : [])
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * @typedef {Object} ShareRepo
 * @property {(packet:any)=>Promise<any>} addToOutbox
 * @property {(filter?:any)=>Promise<any[]>} listOutbox
 * @property {(packet:any)=>Promise<any>} addToInbox
 * @property {(filter?:any)=>Promise<any[]>} listInbox
 * @property {(id:string)=>Promise<boolean>} markSent
 */

const LocalShareRepo = {
  async addToOutbox(packet) {
    const out = readLS(LS_OUTBOX);
    out.unshift(packet);
    writeLS(LS_OUTBOX, out.slice(0, 500));
    return packet;
  },
  async listOutbox(filter = {}) {
    const out = readLS(LS_OUTBOX);
    if (!isPlainObject(filter) || !Object.keys(filter).length) return out;
    return out.filter((p) => {
      if (filter.kind && p.kind !== filter.kind) return false;
      if (filter.scopeType && p?.scope?.type !== filter.scopeType) return false;
      if (
        filter.scopeId &&
        safeString(p?.scope?.id) !== safeString(filter.scopeId)
      )
        return false;
      if (filter.status && safeString(p?.status) !== safeString(filter.status))
        return false;
      return true;
    });
  },
  async addToInbox(packet) {
    const inbox = readLS(LS_INBOX);
    inbox.unshift(packet);
    writeLS(LS_INBOX, inbox.slice(0, 500));
    return packet;
  },
  async listInbox(filter = {}) {
    const inbox = readLS(LS_INBOX);
    if (!isPlainObject(filter) || !Object.keys(filter).length) return inbox;
    return inbox.filter((p) => {
      if (filter.kind && p.kind !== filter.kind) return false;
      if (filter.scopeType && p?.scope?.type !== filter.scopeType) return false;
      if (
        filter.scopeId &&
        safeString(p?.scope?.id) !== safeString(filter.scopeId)
      )
        return false;
      if (filter.status && safeString(p?.status) !== safeString(filter.status))
        return false;
      return true;
    });
  },
  async markSent(id) {
    const out = readLS(LS_OUTBOX);
    const idx = out.findIndex((p) => safeString(p.id) === safeString(id));
    if (idx < 0) return false;
    out[idx] = { ...out[idx], status: "sent", sentAtISO: nowISO() };
    writeLS(LS_OUTBOX, out);
    return true;
  },
};

/* -------------------------------------------------------------------------- */
/*                              Transport Abstraction                           */
/* -------------------------------------------------------------------------- */

/**
 * ShareTransport is where you eventually:
 *  - push packets to Hub
 *  - sync to coalition endpoints
 *  - send via email/sms APIs (if available)
 *
 * For now, the default transport just stores to outbox and marks as "queued".
 *
 * @typedef {Object} ShareTransport
 * @property {(packet:any)=>Promise<{ok:boolean, status?:string, transport?:string, error?:string}>} send
 */

const DefaultTransport = {
  async send(packet) {
    // Local-first: just mark as queued. A sync worker can send later.
    return { ok: true, status: "queued", transport: "local" };
  },
};

/* -------------------------------------------------------------------------- */
/*                          Packet Building / Scrubbing                         */
/* -------------------------------------------------------------------------- */

/**
 * Scrub plan for template sharing:
 *  - remove task completion history
 *  - remove household/actor ids (optional)
 *  - remove "notes" if requested
 */
function scrubPlanForTemplate(plan, scrub = {}) {
  const p = deepClone(plan || {});
  const s = isPlainObject(scrub) ? scrub : {};

  // scrub identities
  if (s.scrubIdentity !== false) {
    delete p.householdId;
    delete p.actorId;
  }

  // scrub status history
  p.tasks = Array.isArray(p.tasks)
    ? p.tasks.map((t) => {
        const nt = { ...t };
        if (isPlainObject(nt.status)) {
          nt.status = {
            doneDates: [],
            skippedDates: [],
            notes: s.keepTaskNotes ? safeString(nt.status.notes || "") : "",
          };
        } else {
          nt.status = { doneDates: [], skippedDates: [], notes: "" };
        }
        return nt;
      })
    : [];

  // scrub global notes
  if (!s.keepPlanNotes) {
    if (isPlainObject(p.constraints)) p.constraints.notes = "";
  }

  // scrub blackout dates unless asked
  if (!s.keepBlackouts && isPlainObject(p.scheduleOverrides)) {
    p.scheduleOverrides.blackoutDates = [];
  }

  // scrub timestamps optionally
  if (s.scrubTimestamps) {
    delete p.createdAtISO;
    delete p.updatedAtISO;
  }

  // rename
  if (s.templateName) p.name = safeString(s.templateName);

  return p;
}

/**
 * Scrub schedule packet for assignment:
 *  - can include PII removal
 *  - can include/exclude constraints
 */
function scrubScheduleForAssignment(packet, scrub = {}) {
  const p = deepClone(packet || {});
  const s = isPlainObject(scrub) ? scrub : {};

  if (s.scrubIdentity !== false) {
    // packet does not include identity by default, but be safe
    delete p.householdId;
    delete p.actorId;
  }

  if (!s.includeConstraints) {
    p.constraints = { doNot: [], preferredSupplies: [], notes: "" };
  }

  if (!s.includeSupplies) {
    p.suppliesNeeded = [];
    p.items = (p.items || []).map((it) => ({ ...it, supplies: [] }));
  }

  // Remove completion flags for pure assignment sheet
  if (s.stripStatus !== false) {
    p.items = (p.items || []).map((it) => {
      const n = { ...it };
      delete n.status;
      return n;
    });
  }

  return p;
}

/* -------------------------------------------------------------------------- */
/*                           Recipient / Scope Helpers                          */
/* -------------------------------------------------------------------------- */

/**
 * Normalize scope.
 * @param {any} scope
 * @returns {{type:"household"|"group"|"coalition"|"direct", id?:string, name?:string}}
 */
function normalizeScope(scope) {
  const s = isPlainObject(scope) ? scope : {};
  const type = safeString(s.type || "direct");
  const allowed = new Set(["household", "group", "coalition", "direct"]);
  const t = allowed.has(type) ? type : "direct";
  const out = { type: /** @type {any} */ (t) };
  if (s.id != null) out.id = safeString(s.id);
  if (s.name != null) out.name = safeString(s.name);
  return out;
}

/**
 * Normalize recipients.
 * Each recipient:
 *  { type:"household"|"role"|"member", id:string, label?:string }
 */
function normalizeRecipients(recipients) {
  const list = Array.isArray(recipients) ? recipients : [];
  const out = [];
  for (const r of list) {
    if (!r) continue;
    const type = safeString(r.type || "household");
    const allowed = new Set(["household", "role", "member"]);
    const t = allowed.has(type) ? type : "household";
    const id = safeString(r.id || "").trim();
    if (!id) continue;
    out.push({ type: t, id, label: r.label ? safeString(r.label) : "" });
  }
  // de-dupe by type+id
  const seen = new Set();
  const deduped = [];
  for (const r of out) {
    const k = `${r.type}:${r.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(r);
  }
  return deduped;
}

/**
 * Normalize permissions.
 */
function normalizePermissions(permissions, mode) {
  const p = isPlainObject(permissions) ? permissions : {};
  const m = safeString(mode || p.mode || "assignment");
  const allowed = new Set(["assignment", "collaborative", "template"]);
  const mm = allowed.has(m) ? m : "assignment";

  // sensible defaults
  if (mm === "assignment") {
    return {
      mode: "assignment",
      canEdit: !!p.canEdit && false, // assignment is read-only
      canMarkDone: p.canMarkDone !== false, // default true
      canReturnReceipts: p.canReturnReceipts !== false, // default true
    };
  }
  if (mm === "collaborative") {
    return {
      mode: "collaborative",
      canEdit: p.canEdit !== false, // default true
      canMarkDone: p.canMarkDone !== false,
      canReturnReceipts: p.canReturnReceipts !== false,
    };
  }
  // template
  return {
    mode: "template",
    canEdit: p.canEdit !== false, // recipients can edit their imported copy
    canMarkDone: false,
    canReturnReceipts: false,
  };
}

/* -------------------------------------------------------------------------- */
/*                               Public API                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} BuildShareOptions
 * @property {"assignment"|"collaborative"|"template"} mode
 * @property {string} planId
 * @property {any} scope
 * @property {any[]} recipients
 * @property {any} permissions
 * @property {any} scrub
 * @property {any} actor     // { actorId?, householdId?, name? }
 * @property {any} meta      // { title?, notes?, tags? }
 * @property {any} schedule  // for assignment: { fromDayKey?, toDayKey?, includeCompleted?, includeSkipped? }
 */

/**
 * Build a share packet without sending it.
 * @param {BuildShareOptions} opts
 */
export function buildSharePacket(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const mode = safeString(o.mode || "assignment");
  const permissions = normalizePermissions(o.permissions, mode);
  const scope = normalizeScope(o.scope);
  const recipients = normalizeRecipients(o.recipients);

  const actor = isPlainObject(o.actor) ? o.actor : {};
  const createdBy = {
    actorId: actor.actorId ? safeString(actor.actorId) : undefined,
    householdId: actor.householdId ? safeString(actor.householdId) : undefined,
    name: actor.name ? safeString(actor.name) : undefined,
  };

  const meta = isPlainObject(o.meta) ? o.meta : {};
  const tags = uniqStrings(meta.tags);
  const title =
    safeString(meta.title) ||
    (mode === "assignment"
      ? "Garden Tasks"
      : mode === "template"
      ? "Garden Plan Template"
      : "Garden Plan");

  const packetBase = {
    id: genId("gpshare"),
    kind: mode === "assignment" ? "garden.schedule" : "garden.plan",
    version: 1,
    createdAtISO: nowISO(),
    createdBy,
    scope,
    recipients,
    permissions,
    meta: {
      title,
      notes: safeString(meta.notes || ""),
      tags,
    },
  };

  if (mode === "assignment") {
    // Generate schedule packet
    const schedOpts = isPlainObject(o.schedule) ? o.schedule : {};
    const schedulePacket = GardenPlanStore.generateSchedule(o.planId, {
      fromDayKey: schedOpts.fromDayKey,
      toDayKey: schedOpts.toDayKey,
      includeCompleted: !!schedOpts.includeCompleted,
      includeSkipped: !!schedOpts.includeSkipped,
      collapseByDay: true,
    });

    if (!schedulePacket?.ok) {
      return {
        ok: false,
        error: safeString(
          schedulePacket?.error || "Failed to generate schedule"
        ),
      };
    }

    const scrubbed = scrubScheduleForAssignment(schedulePacket, {
      includeConstraints: true,
      includeSupplies: true,
      stripStatus: true,
      ...(isPlainObject(o.scrub) ? o.scrub : {}),
    });

    const packet = {
      ...packetBase,
      payload: {
        planId: schedulePacket.planId,
        planName: schedulePacket.planName,
        range: schedulePacket.range,
        packet: scrubbed,
      },
      status: "prepared",
    };

    return { ok: true, packet };
  }

  // plan-based packets (collaborative or template)
  const plan = GardenPlanStore.exportPlan(o.planId);
  if (!plan) return { ok: false, error: "Plan not found" };

  const planPayload =
    mode === "template"
      ? scrubPlanForTemplate(plan, {
          scrubIdentity: true,
          keepTaskNotes: false,
          keepPlanNotes: true,
          keepBlackouts: false,
          scrubTimestamps: true,
          ...(isPlainObject(o.scrub) ? o.scrub : {}),
        })
      : deepClone(plan);

  const packet = {
    ...packetBase,
    payload: {
      plan: planPayload,
    },
    status: "prepared",
  };

  return { ok: true, packet };
}

/**
 * Send a share packet: stores to outbox and optionally transport-sends.
 * @param {BuildShareOptions & { repo?:any, transport?:any }} opts
 */
export async function sendShare(opts) {
  const repo = opts?.repo || LocalShareRepo;
  const transport = opts?.transport || DefaultTransport;

  emit("garden/plan.share.requested", {
    mode: opts?.mode,
    planId: opts?.planId,
  });

  const built = buildSharePacket(opts);
  if (!built.ok) {
    emit("garden/plan.share.failed", {
      planId: opts?.planId,
      error: built.error,
    });
    return { ok: false, error: built.error };
  }

  const packet = built.packet;
  emit("garden/plan.share.prepared", {
    id: packet.id,
    kind: packet.kind,
    scope: packet.scope,
    recipients: packet.recipients,
  });

  // persist to outbox first
  await repo.addToOutbox({ ...packet, status: "queued" });

  // attempt transport send (no-op for now)
  const res = await transport.send(packet);

  if (res?.ok) {
    // mark outbox sent/queued accordingly
    const status = safeString(res.status || "queued");
    if (status === "sent") {
      await repo.markSent(packet.id);
    } else {
      // update status in outbox (simple local implementation: re-add with updated status)
      await repo.addToOutbox({ ...packet, status });
    }

    emit("garden/plan.share.sent", {
      id: packet.id,
      kind: packet.kind,
      status,
      transport: res.transport || "local",
      recipients: packet.recipients,
      scope: packet.scope,
    });

    return { ok: true, id: packet.id, status, packet };
  }

  emit("garden/plan.share.failed", {
    id: packet.id,
    error: safeString(res?.error || "send failed"),
  });
  return {
    ok: false,
    id: packet.id,
    error: safeString(res?.error || "send failed"),
    packet,
  };
}

/**
 * Import an incoming packet into local stores.
 * - schedule packet: stores to inbox (and can be rendered/printed/exported)
 * - plan packet: imports plan into GardenPlanStore (as a new plan copy)
 *
 * @param {any} packet
 * @param {{ repo?:any, importAsCopy?:boolean, activate?:boolean }} [opts]
 */
export async function receiveSharePacket(packet, opts = {}) {
  const repo = opts?.repo || LocalShareRepo;
  const p = isPlainObject(packet) ? packet : null;
  if (!p?.id || !p?.kind) return { ok: false, error: "Invalid packet" };

  // Always store in inbox for traceability
  await repo.addToInbox({
    ...p,
    receivedAtISO: nowISO(),
    status: p.status || "received",
  });

  if (p.kind === "garden.plan") {
    const plan = p?.payload?.plan;
    if (!plan) return { ok: false, error: "No plan payload" };

    const importAsCopy = opts?.importAsCopy !== false;
    const imported = importAsCopy
      ? GardenPlanStore.importPlan({
          ...deepClone(plan),
          id: genId("plan"),
          name: safeString(plan.name || "Garden Plan") + " (Imported)",
          createdAtISO: nowISO(),
          updatedAtISO: nowISO(),
        })
      : GardenPlanStore.importPlan(plan);

    if (opts?.activate !== false && imported?.id) {
      try {
        GardenPlanStore.setActivePlan(imported.id);
      } catch {
        // noop
      }
    }

    emit("garden/plan.share.received", {
      id: p.id,
      kind: p.kind,
      importedPlanId: imported?.id,
    });
    return { ok: true, kind: p.kind, importedPlanId: imported?.id, packet: p };
  }

  // garden.schedule — nothing to import into plan store automatically
  emit("garden/plan.share.received", { id: p.id, kind: p.kind });
  return { ok: true, kind: p.kind, packet: p };
}

/**
 * Create a "receipt" packet for assignment completion.
 * This can be used to send back to the planner (future: merge into plan status).
 *
 * @param {{
 *   sharePacketId: string,
 *   planId?: string,
 *   completed: Array<{taskId:string, dayKey:string}>,
 *   skipped?: Array<{taskId:string, dayKey:string}>,
 *   notes?: string,
 *   actor?: { actorId?:string, householdId?:string, name?:string },
 *   scope?: any,
 *   recipients?: any[]
 * }} opts
 */
export function buildCompletionReceipt(opts) {
  const o = isPlainObject(opts) ? opts : {};
  const actor = isPlainObject(o.actor) ? o.actor : {};
  const createdBy = {
    actorId: actor.actorId ? safeString(actor.actorId) : undefined,
    householdId: actor.householdId ? safeString(actor.householdId) : undefined,
    name: actor.name ? safeString(actor.name) : undefined,
  };

  const scope = normalizeScope(o.scope);
  const recipients = normalizeRecipients(o.recipients);

  const completed = Array.isArray(o.completed)
    ? o.completed
        .map((x) => ({
          taskId: safeString(x?.taskId || "").trim(),
          dayKey: safeString(x?.dayKey || "").trim(),
        }))
        .filter((x) => x.taskId && x.dayKey)
    : [];

  const skipped = Array.isArray(o.skipped)
    ? o.skipped
        .map((x) => ({
          taskId: safeString(x?.taskId || "").trim(),
          dayKey: safeString(x?.dayKey || "").trim(),
        }))
        .filter((x) => x.taskId && x.dayKey)
    : [];

  const receipt = {
    id: genId("gpreceipt"),
    kind: "garden.receipt",
    version: 1,
    createdAtISO: nowISO(),
    createdBy,
    scope,
    recipients,
    meta: {
      sharePacketId: safeString(o.sharePacketId || ""),
      planId: o.planId ? safeString(o.planId) : undefined,
      notes: safeString(o.notes || ""),
    },
    payload: {
      completed,
      skipped,
    },
    status: "prepared",
  };

  emit("garden/plan.receipt.created", {
    id: receipt.id,
    sharePacketId: receipt.meta.sharePacketId,
  });
  return { ok: true, receipt };
}

/**
 * List outbox packets (local-first repo).
 */
export async function listOutbox(filter = {}, repo = null) {
  const r = repo || LocalShareRepo;
  return r.listOutbox(filter);
}

/**
 * List inbox packets (local-first repo).
 */
export async function listInbox(filter = {}, repo = null) {
  const r = repo || LocalShareRepo;
  return r.listInbox(filter);
}

/* -------------------------------------------------------------------------- */
/*                                 Service Facade                              */
/* -------------------------------------------------------------------------- */

export const GardenPlanShareService = {
  // repo/transport exposed for wiring
  LocalShareRepo,
  DefaultTransport,

  // build/send/receive
  buildSharePacket,
  sendShare,
  receiveSharePacket,

  // receipts
  buildCompletionReceipt,

  // lists
  listOutbox,
  listInbox,
};

export default GardenPlanShareService;
