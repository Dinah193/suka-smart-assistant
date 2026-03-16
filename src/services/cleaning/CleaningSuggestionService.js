// File: C:\Users\larho\suka-smart-assistant\src\services\cleaning\CleaningSuggestionService.js
/**
 * CleaningSuggestionService (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Deterministically generate cleaning suggestions and session candidates
 *    from household context (rooms, chores, last-done logs, preferences,
 *    inventory/consumables, upcoming events).
 *
 * Why this exists
 *  - "Little to no AI": This service is rules + scoring, not LLM-driven.
 *  - Works offline with best-effort data; never hard-crashes builds.
 *  - Feeds:
 *      • Dashboard "Today's Cleaning" card
 *      • Planner / SessionBuilder (cleaning sessions)
 *      • Notifications (optional)
 *
 * Key design principles
 *  - Humane: respects quiet hours + sabbath/low-activity periods (note-only).
 *  - Idempotent: same inputs -> same ordered suggestions.
 *  - Extensible: rules + weight profiles; user overrides supported.
 *  - Browser-safe: no Node imports; optional imports only.
 *
 * -----------------------------------------------------------------------------
 * Inputs (best-effort)
 * -----------------------------------------------------------------------------
 * ctx = {
 *   now: Date | ISO,
 *   householdId?: string,
 *   prefs?: {
 *     // from CleaningPrefsStore / PreferencesStore (optional)
 *     sabbathAware?: boolean,
 *     quietHours?: { start:"22:00", end:"07:00", deferTo:"08:00" },
 *     energy?: "low"|"medium"|"high",
 *     defaultSessionMinutes?: number,
 *     focusRooms?: string[],          // room ids or names
 *     avoidTasks?: string[],          // task keys
 *     deepCleanDay?: "Sun"|"Mon"|...,
 *     rotationBias?: "even"|"frontload"| "backload",
 *   },
 *   rooms?: [
 *     { id, name, type?, priority?, lastCleanedAt?, lastDeepCleanAt?, notes?, tags?:[] }
 *   ],
 *   chores?: [
 *     {
 *       id, key, title, roomId?, roomName?,
 *       kind?: "daily"|"weekly"|"monthly"|"seasonal"|"deep",
 *       effort?: 1..5,
 *       minutes?: number,
 *       supplies?: [{ tag?:string, itemId?:string, qty?:number }],
 *       cadence?: { days?: number },        // override kind-based defaults
 *       lastDoneAt?: ISO,
 *       nextDueAt?: ISO,
 *       tags?: string[]
 *     }
 *   ],
 *   logs?: {
 *     cleaning?: [{ atISO, choreId?, key?, roomId?, minutes?, result? }]
 *   },
 *   inventory?: {
 *     items?: [{ id, name, qty, unit, tags?: string[] }]
 *   },
 *   events?: {
 *     // upcoming household events that should bias cleaning suggestions
 *     upcoming?: [{ title, atISO, kind?: "guests"|"sabbath"|"party"|"inspection" }]
 *   }
 * }
 *
 * -----------------------------------------------------------------------------
 * Outputs
 * -----------------------------------------------------------------------------
 * returns {
 *   householdId,
 *   atISO,
 *   suggestions: [
 *     {
 *       id,
 *       kind: "nudge"|"session_candidate"|"inventory_refill",
 *       severity: "info"|"warn"|"high",
 *       title,
 *       message,
 *       score,
 *       roomId?,
 *       choreIds?: string[],
 *       minutesEstimate?: number,
 *       tags?: string[],
 *       meta?: object
 *     }
 *   ],
 *   sessions: [
 *     {
 *       id,
 *       domain: "cleaning",
 *       title,
 *       startHintISO,
 *       minutesEstimate,
 *       chores: [{ choreId, title, minutes? }],
 *       meta
 *     }
 *   ],
 *   meta: { ... }
 * }
 */

const SOURCE = "services.cleaning.CleaningSuggestionService";

/* -----------------------------------------------------------------------------
 * Optional deps (safe)
 * -------------------------------------------------------------------------- */

let DashboardLog = null;
try {
  const mod = await import("../dashboard/DashboardLog.js").catch(() => null);
  DashboardLog = mod?.default || mod?.DashboardLog || null;
} catch {
  DashboardLog = null;
}

let bus = null;
const BUS_CANDIDATES = [
  () => import("../automation/eventBus.js"),
  () => import("../events/eventBus.js"),
  () => import("../automation/runtime.js"),
  () => import("../../services/automation/eventBus.js"),
];
for (const load of BUS_CANDIDATES) {
  try {
    const mod = await load().catch(() => null);
    const b =
      mod?.eventBus ||
      mod?.bus ||
      mod?.default?.eventBus ||
      mod?.default ||
      mod;
    if (
      b &&
      (typeof b.emit === "function" || typeof b.publish === "function")
    ) {
      bus = b;
      break;
    }
  } catch {
    /* keep trying */
  }
}

function tryEmit(event, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(event, payload);
    else if (typeof bus.publish === "function") bus.publish(event, payload);
  } catch {
    /* no-op */
  }
}

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const safeObj = (x) => (isObj(x) ? x : {});
const safeArr = (x) => (Array.isArray(x) ? x : []);
const keyOf = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const toDate = (x) => (x instanceof Date ? x : new Date(x));
const toISO = (x) => toDate(x).toISOString();
const nowISO = () => new Date().toISOString();

function daysBetween(a, b) {
  const da = toDate(a).getTime();
  const db = toDate(b).getTime();
  return Math.round((db - da) / 86400000);
}

function minutesBetween(a, b) {
  const da = toDate(a).getTime();
  const db = toDate(b).getTime();
  return Math.round((db - da) / 60000);
}

function uniqBy(items, keyFn) {
  const out = [];
  const seen = new Set();
  for (const it of safeArr(items)) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function isoDateKey(d) {
  const dt = toDate(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function dayName(d) {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][toDate(d).getDay()];
}

function inQuietHours(date, quiet) {
  if (!quiet) return false;
  const d = toDate(date);
  const [sh, sm] = String(quiet.start || "22:00")
    .split(":")
    .map((n) => +n);
  const [eh, em] = String(quiet.end || "07:00")
    .split(":")
    .map((n) => +n);
  const start = new Date(d);
  start.setHours(sh, sm || 0, 0, 0);
  const end = new Date(d);
  end.setHours(eh, em || 0, 0, 0);

  // crosses midnight
  if (start <= end) return d >= start && d <= end;
  return d >= start || d <= end;
}

function sabbathGuidance(opts, now) {
  // SSA uses "sabbath-aware" as guidance, not hard-blocking
  if (!opts?.sabbathAware) return null;
  const dow = toDate(now).getDay(); // 5 Fri, 6 Sat
  if (dow === 5)
    return "Sabbath-aware: prefer finishing active cleaning before sunset (Fri).";
  if (dow === 6)
    return "Sabbath-aware: prefer low/no active cleaning until after sunset (Sat).";
  return null;
}

/* -----------------------------------------------------------------------------
 * Defaults / cadence rules
 * -------------------------------------------------------------------------- */

const DEFAULT_PREFS = {
  sabbathAware: true,
  quietHours: { start: "22:00", end: "07:00", deferTo: "08:00" },
  energy: "medium",
  defaultSessionMinutes: 45,
  focusRooms: [],
  avoidTasks: [],
  deepCleanDay: "Thu",
  rotationBias: "even",
};

const KIND_TO_CADENCE_DAYS = {
  daily: 1,
  weekly: 7,
  monthly: 30,
  seasonal: 90,
  deep: 180,
};

const EFFORT_TO_MINUTES = {
  1: 10,
  2: 20,
  3: 35,
  4: 50,
  5: 75,
};

const ROOM_PRIORITY_DEFAULT = 3; // 1..5 (5 highest)
const ROOM_TYPE_BIAS = {
  kitchen: 1.25,
  bathroom: 1.25,
  living: 1.1,
  bedroom: 1.0,
  hallway: 0.9,
  laundry: 1.0,
  office: 0.95,
  storage: 0.75,
};

/* -----------------------------------------------------------------------------
 * Suggestion + session builders
 * -------------------------------------------------------------------------- */

function makeSuggestion(partial) {
  const p = safeObj(partial);
  const kind = String(p.kind || "nudge");
  const severity = String(p.severity || "info");
  const title = String(p.title || "Cleaning");
  const message = String(p.message || "");
  const score = Number.isFinite(p.score) ? p.score : 0;

  const roomId = p.roomId ? String(p.roomId) : null;
  const choreIds = safeArr(p.choreIds).map(String);
  const tags = safeArr(p.tags).map(String);

  const base = `cleaning:${keyOf(kind)}:${keyOf(title)}:${keyOf(message)}:${
    roomId || ""
  }:${choreIds.slice().sort().join(",")}`;

  return {
    id: p.id || base,
    kind,
    severity,
    title,
    message,
    score,
    roomId: roomId || undefined,
    choreIds: choreIds.length ? choreIds : undefined,
    minutesEstimate: Number.isFinite(p.minutesEstimate)
      ? p.minutesEstimate
      : undefined,
    tags: tags.length ? tags : undefined,
    meta: safeObj(p.meta),
    source: SOURCE,
    createdAt: nowISO(),
  };
}

function makeSessionCandidate({
  title,
  chores,
  startHintISO,
  minutesEstimate,
  meta,
}) {
  const list = safeArr(chores)
    .map((c) => ({
      choreId: String(c.choreId || ""),
      title: String(c.title || ""),
      minutes: Number.isFinite(c.minutes) ? c.minutes : undefined,
    }))
    .filter((x) => x.choreId || x.title);

  const id = `cleaning_session:${keyOf(title)}:${list
    .map((x) => keyOf(x.choreId || x.title))
    .join(",")}:${startHintISO || ""}`;

  return {
    id,
    domain: "cleaning",
    title: String(title || "Cleaning Session"),
    startHintISO: startHintISO ? String(startHintISO) : undefined,
    minutesEstimate: Number.isFinite(minutesEstimate)
      ? minutesEstimate
      : undefined,
    chores: list,
    meta: safeObj(meta),
    source: SOURCE,
    createdAt: nowISO(),
  };
}

/* -----------------------------------------------------------------------------
 * Normalization
 * -------------------------------------------------------------------------- */

function normalizeCtx(input) {
  const ctx = safeObj(input);
  const now = ctx.now ? toDate(ctx.now) : new Date();
  const householdId = String(ctx.householdId || "primary");

  const prefs = { ...DEFAULT_PREFS, ...safeObj(ctx.prefs) };

  const rooms = safeArr(ctx.rooms).map((r) => {
    const x = safeObj(r);
    return {
      id: String(x.id || ""),
      name: String(x.name || ""),
      type: x.type ? String(x.type) : null,
      priority: Number.isFinite(x.priority)
        ? clamp(x.priority, 1, 5)
        : ROOM_PRIORITY_DEFAULT,
      lastCleanedAt: x.lastCleanedAt || null,
      lastDeepCleanAt: x.lastDeepCleanAt || null,
      notes: x.notes ? String(x.notes) : "",
      tags: safeArr(x.tags).map(String),
    };
  });

  const chores = safeArr(ctx.chores).map((c) => {
    const x = safeObj(c);
    const effort = Number.isFinite(x.effort) ? clamp(x.effort, 1, 5) : 3;
    const kind = String(x.kind || "weekly");
    const cadenceDays = Number.isFinite(safeObj(x.cadence).days)
      ? Math.max(0, Number(x.cadence.days))
      : KIND_TO_CADENCE_DAYS[kind] || 7;

    const minutes = Number.isFinite(x.minutes)
      ? Math.max(1, Number(x.minutes))
      : EFFORT_TO_MINUTES[String(effort)] || 35;

    return {
      id: String(x.id || ""),
      key: String(x.key || x.id || x.title || ""),
      title: String(x.title || x.name || x.key || "Chore"),
      roomId: x.roomId ? String(x.roomId) : null,
      roomName: x.roomName ? String(x.roomName) : null,
      kind,
      cadenceDays,
      effort,
      minutes,
      supplies: safeArr(x.supplies),
      lastDoneAt: x.lastDoneAt || null,
      nextDueAt: x.nextDueAt || null,
      tags: safeArr(x.tags).map(String),
    };
  });

  const logs = safeObj(ctx.logs);
  const inventory = safeObj(ctx.inventory);
  const events = safeObj(ctx.events);

  return { now, householdId, prefs, rooms, chores, logs, inventory, events };
}

/* -----------------------------------------------------------------------------
 * Scoring / ranking
 * -------------------------------------------------------------------------- */

function roomBias(room) {
  const type = keyOf(room?.type);
  return ROOM_TYPE_BIAS[type] || 1.0;
}

function energyMultiplier(energy, effort) {
  const e = keyOf(energy);
  if (e === "low") return effort >= 4 ? 0.6 : 1.0;
  if (e === "high") return effort >= 4 ? 1.15 : 1.0;
  return 1.0; // medium
}

function dueScore(chore, now) {
  // Higher when overdue; modest when upcoming
  if (chore.nextDueAt) {
    const mins = minutesBetween(now, chore.nextDueAt);
    if (mins <= 0) return 1.0;
    if (mins <= 24 * 60) return 0.7;
    return 0.4;
  }

  const last = chore.lastDoneAt;
  if (!last) return 0.9; // unknown treated as likely due
  const daysSince = daysBetween(last, now);
  const cadence = Math.max(1, Number(chore.cadenceDays || 7));

  if (daysSince >= cadence) {
    // overdue scaling up to 2x cadence
    const over = daysSince - cadence;
    return clamp(1.0 + over / cadence, 1.0, 1.6);
  }
  // not yet due: still can be suggested lightly
  return clamp(daysSince / cadence, 0.25, 0.85);
}

function guestEventBoost(events, now) {
  const upcoming = safeArr(events?.upcoming);
  if (!upcoming.length) return 1.0;

  // If any "guests/inspection/party" within 48h boost surface-facing chores
  const soon = upcoming
    .map((e) => ({ ...safeObj(e), at: e?.atISO ? toDate(e.atISO) : null }))
    .filter((e) => e.at && e.at > now)
    .sort((a, b) => a.at - b.at)[0];

  if (!soon?.at) return 1.0;
  const hrs = (toDate(soon.at).getTime() - toDate(now).getTime()) / 3600000;
  const kind = keyOf(soon.kind);

  if (
    hrs <= 48 &&
    (kind === "guests" || kind === "party" || kind === "inspection")
  ) {
    // stronger as it gets closer
    return clamp(1.1 + (48 - hrs) / 80, 1.1, 1.55);
  }
  return 1.0;
}

/* -----------------------------------------------------------------------------
 * Inventory availability checks (tags)
 * -------------------------------------------------------------------------- */

function buildInventoryIndex(inventory) {
  const items = safeArr(inventory?.items);
  const byTag = new Map(); // tag -> [{...}]
  const byId = new Map();
  for (const it of items) {
    if (!it) continue;
    const id = it.id ? String(it.id) : "";
    if (id) byId.set(id, it);
    for (const t of safeArr(it.tags)) {
      const k = keyOf(t);
      if (!k) continue;
      if (!byTag.has(k)) byTag.set(k, []);
      byTag.get(k).push(it);
    }
  }
  return { items, byTag, byId };
}

function suppliesMissing(chore, invIndex) {
  const supplies = safeArr(chore?.supplies);
  if (!supplies.length) return [];

  const missing = [];
  for (const s of supplies) {
    const sup = safeObj(s);
    const tag = sup.tag ? keyOf(sup.tag) : null;
    const itemId = sup.itemId ? String(sup.itemId) : null;
    const needQty = Number.isFinite(sup.qty) ? Number(sup.qty) : null;

    let item = null;
    if (itemId && invIndex.byId.has(itemId)) item = invIndex.byId.get(itemId);
    if (!item && tag && invIndex.byTag.has(tag)) {
      // pick any with qty > 0
      const candidates = invIndex.byTag.get(tag);
      item =
        candidates.find((x) => Number(x.qty || 0) > 0) || candidates[0] || null;
    }

    if (!item) {
      missing.push({
        type: "missing_item",
        tag: sup.tag || null,
        itemId: itemId || null,
        qty: needQty,
      });
      continue;
    }

    const have = Number(item.qty || 0);
    if (needQty != null && have < needQty) {
      missing.push({
        type: "insufficient_qty",
        tag: sup.tag || null,
        itemId: item.id || null,
        name: item.name || null,
        needQty,
        haveQty: have,
        unit: item.unit || null,
      });
    }
  }
  return missing;
}

/* -----------------------------------------------------------------------------
 * Core generation
 * -------------------------------------------------------------------------- */

function buildCandidates(ctx) {
  const { now, prefs } = ctx;

  const invIndex = buildInventoryIndex(ctx.inventory);
  const focusRoomKeys = new Set(safeArr(prefs.focusRooms).map(keyOf));
  const avoidTaskKeys = new Set(safeArr(prefs.avoidTasks).map(keyOf));

  // index rooms by id and name
  const roomById = new Map();
  const roomByNameKey = new Map();
  for (const r of safeArr(ctx.rooms)) {
    if (r.id) roomById.set(String(r.id), r);
    if (r.name) roomByNameKey.set(keyOf(r.name), r);
  }

  const eventBoost = guestEventBoost(ctx.events, now);
  const sabbathMsg = sabbathGuidance(prefs, now);

  const suggestions = [];
  const choreScores = []; // { chore, score, missingSupplies }

  for (const chore of safeArr(ctx.chores)) {
    const choreKey = keyOf(chore.key || chore.id || chore.title);
    if (!choreKey) continue;
    if (avoidTaskKeys.has(choreKey)) continue;

    // match room
    let room = null;
    if (chore.roomId && roomById.has(chore.roomId))
      room = roomById.get(chore.roomId);
    if (!room && chore.roomName && roomByNameKey.has(keyOf(chore.roomName)))
      room = roomByNameKey.get(keyOf(chore.roomName));

    const roomPriority = room ? room.priority : ROOM_PRIORITY_DEFAULT;
    const focusBoost = room
      ? focusRoomKeys.size
        ? focusRoomKeys.has(keyOf(room.id)) ||
          focusRoomKeys.has(keyOf(room.name))
          ? 1.25
          : 0.9
        : 1.0
      : 1.0;

    const baseDue = dueScore(chore, now);
    const roomTypeBias = room ? roomBias(room) : 1.0;
    const energyMult = energyMultiplier(prefs.energy, chore.effort);

    // cadence kind bias: daily chores are more urgent for dashboard
    const kindKey = keyOf(chore.kind);
    const kindBias =
      kindKey === "daily" ? 1.15 : kindKey === "weekly" ? 1.05 : 1.0;

    // supplies gating: if missing supplies, we can still suggest but as "inventory_refill" + lower score
    const missing = suppliesMissing(chore, invIndex);
    const supplyPenalty = missing.length ? 0.7 : 1.0;

    // minutes: shorter tasks surface when energy is low
    const timeBias =
      prefs.energy === "low"
        ? clamp(60 / Math.max(10, chore.minutes), 0.8, 1.25)
        : 1.0;

    // score is 0..100-ish
    const score =
      100 *
      baseDue *
      (0.65 + roomPriority / 10) *
      roomTypeBias *
      kindBias *
      focusBoost *
      energyMult *
      timeBias *
      supplyPenalty *
      eventBoost;

    choreScores.push({ chore, score, room, missing });
  }

  // sort chores by score desc
  choreScores.sort((a, b) => b.score - a.score);

  // Build top nudges (dashboard) + refill suggestions
  const topN = 12;
  for (const entry of choreScores.slice(0, topN)) {
    const { chore, score, room, missing } = entry;

    const severity = score >= 130 ? "high" : score >= 90 ? "warn" : "info";
    const title = room?.name ? `${room.name}: ${chore.title}` : chore.title;

    if (missing.length) {
      // inventory refill suggestion
      const missingNames = missing
        .map((m) => m.name || m.tag || m.itemId || "supply")
        .filter(Boolean)
        .slice(0, 3)
        .join(", ");

      suggestions.push(
        makeSuggestion({
          kind: "inventory_refill",
          severity: severity === "high" ? "warn" : "info",
          title: "Restock cleaning supplies",
          message: `Before "${chore.title}", restock: ${missingNames}${
            missing.length > 3 ? "…" : ""
          }.`,
          score: Math.round(score * 0.85),
          roomId: room?.id || undefined,
          choreIds: [chore.id || chore.key],
          minutesEstimate: 10,
          tags: ["inventory", "cleaning", "supplies"],
          meta: { chore, missing },
        })
      );
      continue;
    }

    suggestions.push(
      makeSuggestion({
        kind: "nudge",
        severity,
        title,
        message: buildNudgeMessage(chore, room),
        score: Math.round(score),
        roomId: room?.id || undefined,
        choreIds: [chore.id || chore.key],
        minutesEstimate: chore.minutes,
        tags: buildTags(chore, room),
        meta: {
          choreId: chore.id,
          kind: chore.kind,
          effort: chore.effort,
          cadenceDays: chore.cadenceDays,
        },
      })
    );
  }

  // Add sabbath guidance (non-blocking)
  if (sabbathMsg) {
    suggestions.push(
      makeSuggestion({
        kind: "nudge",
        severity: "info",
        title: "Sabbath-aware guidance",
        message: sabbathMsg,
        score: 5,
        tags: ["sabbath", "guidance"],
        meta: { day: dayName(now) },
      })
    );
  }

  // If currently in quiet hours, add a gentle note
  if (inQuietHours(now, prefs.quietHours)) {
    suggestions.push(
      makeSuggestion({
        kind: "nudge",
        severity: "info",
        title: "Quiet hours",
        message:
          "Quiet hours are active. Prefer low-noise tasks or defer cleaning to later.",
        score: 6,
        tags: ["quiet_hours", "guidance"],
        meta: { quietHours: prefs.quietHours },
      })
    );
  }

  // Build session candidates from top chores grouped by room + minutes budget
  const sessions = buildSessionsFromScores(ctx, choreScores);

  return { suggestions, sessions };
}

function buildNudgeMessage(chore, room) {
  const kind = keyOf(chore.kind);
  const due = chore.nextDueAt
    ? `Due ${toDate(chore.nextDueAt) <= new Date() ? "now" : "soon"}`
    : chore.lastDoneAt
    ? `Last done ${Math.max(
        0,
        daysBetween(chore.lastDoneAt, new Date())
      )} day(s) ago`
    : "No recent completion logged";

  const est = `${Math.max(5, Math.round(chore.minutes || 15))} min`;

  if (room?.name) {
    return `${due} • Est: ${est} • ${kind || "routine"} cleaning`;
  }
  return `${due} • Est: ${est}`;
}

function buildTags(chore, room) {
  const tags = new Set();
  if (room?.type) tags.add(keyOf(room.type));
  if (room?.name) tags.add(keyOf(room.name));
  if (chore.kind) tags.add(keyOf(chore.kind));
  for (const t of safeArr(chore.tags)) tags.add(keyOf(t));
  tags.add("cleaning");
  return Array.from(tags).filter(Boolean);
}

function buildSessionsFromScores(ctx, choreScores) {
  const { prefs, now } = ctx;
  const minutesBudget = Number.isFinite(prefs.defaultSessionMinutes)
    ? Math.max(10, prefs.defaultSessionMinutes)
    : 45;

  // Build room buckets
  const buckets = new Map(); // roomKey -> entries
  for (const e of choreScores) {
    const roomKey = e.room?.id
      ? `id:${e.room.id}`
      : e.room?.name
      ? `name:${keyOf(e.room.name)}`
      : "unassigned";
    if (!buckets.has(roomKey)) buckets.set(roomKey, []);
    buckets.get(roomKey).push(e);
  }

  // prioritize buckets by top score
  const bucketList = Array.from(buckets.entries()).map(([k, entries]) => ({
    k,
    entries,
    topScore: Math.max(...entries.map((x) => x.score)),
    room: entries[0]?.room || null,
  }));
  bucketList.sort((a, b) => b.topScore - a.topScore);

  const sessions = [];
  const maxSessions = 2; // humane
  const usedChores = new Set();

  for (const bucket of bucketList) {
    if (sessions.length >= maxSessions) break;

    const chores = [];
    let minutes = 0;

    for (const e of bucket.entries) {
      const chore = e.chore;
      const id = chore.id || chore.key || chore.title;
      if (!id) continue;
      if (usedChores.has(id)) continue;

      // skip if supplies missing (sessions should be actionable)
      if (e.missing?.length) continue;

      // skip very heavy chores if energy low
      if (keyOf(prefs.energy) === "low" && chore.effort >= 4) continue;

      const m = Math.max(5, Math.round(chore.minutes || 15));
      if (minutes + m > minutesBudget && chores.length >= 2) break;

      chores.push({ choreId: id, title: chore.title, minutes: m });
      minutes += m;
      usedChores.add(id);

      if (minutes >= minutesBudget) break;
      if (chores.length >= 6) break;
    }

    if (!chores.length) continue;

    const roomName =
      bucket.room?.name || (bucket.k === "unassigned" ? "Whole Home" : "Room");
    const title = `Cleaning Session — ${roomName}`;
    const startHintISO = toISO(now);

    sessions.push(
      makeSessionCandidate({
        title,
        chores,
        startHintISO,
        minutesEstimate: minutes,
        meta: {
          roomId: bucket.room?.id || null,
          roomName,
          budgetMinutes: minutesBudget,
          energy: prefs.energy,
        },
      })
    );
  }

  // If no room-bucketed sessions, build a general quick session from top chores
  if (!sessions.length) {
    const chores = [];
    let minutes = 0;

    for (const e of choreScores) {
      const chore = e.chore;
      const id = chore.id || chore.key || chore.title;
      if (!id) continue;
      if (e.missing?.length) continue;

      const m = Math.max(5, Math.round(chore.minutes || 15));
      if (minutes + m > minutesBudget && chores.length >= 2) break;

      chores.push({ choreId: id, title: chore.title, minutes: m });
      minutes += m;

      if (minutes >= minutesBudget) break;
      if (chores.length >= 6) break;
    }

    if (chores.length) {
      sessions.push(
        makeSessionCandidate({
          title: "Cleaning Session — Quick Wins",
          chores,
          startHintISO: toISO(now),
          minutesEstimate: minutes,
          meta: { budgetMinutes: minutesBudget, energy: prefs.energy },
        })
      );
    }
  }

  return sessions;
}

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

export const CleaningSuggestionService = {
  /**
   * Generate ordered suggestions + 1–2 humane session candidates.
   * @param {object} ctx
   * @param {object} [options]
   * @param {boolean} [options.emitEvent=true]
   * @param {boolean} [options.logDashboard=false]
   * @param {number}  [options.limit=15]              // suggestion limit
   */
  async suggest(ctx, options = {}) {
    const c = normalizeCtx(ctx);
    const opts = safeObj(options);
    const emitEvent = opts.emitEvent !== false;
    const logDashboard = !!opts.logDashboard;
    const limit = Number.isFinite(opts.limit) ? clamp(opts.limit, 1, 50) : 15;

    const { suggestions, sessions } = buildCandidates(c);

    // De-dupe and sort suggestions by score desc
    const deduped = uniqBy(suggestions, (s) => s.id);
    deduped.sort((a, b) => (b.score || 0) - (a.score || 0));

    const out = {
      householdId: c.householdId,
      atISO: toISO(c.now),
      suggestions: deduped.slice(0, limit),
      sessions,
      meta: {
        source: SOURCE,
        counts: {
          rooms: c.rooms.length,
          chores: c.chores.length,
          suggestions: deduped.length,
          sessions: sessions.length,
        },
        prefs: {
          energy: c.prefs.energy,
          defaultSessionMinutes: c.prefs.defaultSessionMinutes,
          sabbathAware: !!c.prefs.sabbathAware,
        },
        today: isoDateKey(c.now),
      },
    };

    if (emitEvent) {
      tryEmit("cleaning.suggestions.generated", out);
    }

    if (logDashboard && DashboardLog?.log) {
      try {
        const high = out.suggestions.filter(
          (s) => s.severity === "high"
        ).length;
        const warn = out.suggestions.filter(
          (s) => s.severity === "warn"
        ).length;
        const info = out.suggestions.filter(
          (s) => s.severity === "info"
        ).length;
        await DashboardLog.log({
          category: "Cleaning",
          icon: "🧼",
          message: `Cleaning suggestions: ${high} high, ${warn} warn, ${info} info`,
          time: out.atISO,
          meta: {
            householdId: out.householdId,
            counts: { high, warn, info },
            top: out.suggestions.slice(0, 5).map((s) => ({
              title: s.title,
              severity: s.severity,
              score: s.score,
            })),
          },
        });
      } catch {
        /* non-fatal */
      }
    }

    return out;
  },

  /**
   * Convenience: produce a single "best next cleaning session" blueprint-ish
   * object for the planner to adopt.
   */
  async bestNextSession(ctx, options = {}) {
    const res = await CleaningSuggestionService.suggest(ctx, {
      ...options,
      limit: 25,
    });
    return res.sessions?.[0] || null;
  },
};

/* -----------------------------------------------------------------------------
 * ✅ COMPAT EXPORT: suggestCleaningFromIntelligence (Build fix)
 * -----------------------------------------------------------------------------
 * CleaningPlanner.jsx imports:
 *   import { suggestCleaningFromIntelligence } from "../../services/cleaning/CleaningSuggestionService";
 *
 * This project uses an "ImportIntelligenceService" upstream. We keep this
 * wrapper intentionally tolerant:
 *  - If caller passes a full ctx, we use it directly.
 *  - If caller passes { ctx } or { context }, we unwrap it.
 *  - If caller passes { householdId, rooms, chores, logs, inventory, events, prefs },
 *    we treat it as ctx.
 *
 * Returns the same object as CleaningSuggestionService.suggest().
 */
export async function suggestCleaningFromIntelligence(
  intelligence,
  options = {}
) {
  const intel = safeObj(intelligence);

  // common wrappers
  const ctx =
    safeObj(intel.ctx) ||
    safeObj(intel.context) ||
    // sometimes upstream returns { recentImports, householdCtx, ... }
    safeObj(intel.householdCtx) ||
    intel;

  return CleaningSuggestionService.suggest(ctx, options);
}

export default CleaningSuggestionService;
