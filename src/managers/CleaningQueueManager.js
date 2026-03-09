// src/managers/CleaningQueueManager.js
/* eslint-disable no-console */

/**
 * CleaningQueueManager
 * -----------------------------------------------------------------------------
 * Builds a cleaning action queue by blending:
 *  • Room signals (lastCleanedISO, recurrence, dirtinessScore, allergens)
 *  • Supply readiness (detergent/cleaner/tools thresholds)
 *  • Favorite plan hints (preferred day, sequence, products)
 *  • Quiet hours / withhold windows (optional schedule helpers)
 *
 * Emits domain-aware events and supports:
 *  • saveQueueAsPlan({ favorite, destination }) -> Dexie or PlanStorageRouter
 *  • saveEntryAsFavorite(entryId) -> favoritePlans with reusable hints
 *  • writeCalendar() -> calendarSync if available
 *
 * Optional tables (all defensive):
 *  - DexieDB.rooms: {
 *      id, name, zone?, lastCleanedISO?, recurrenceDays?, dirtinessScore?(0-100),
 *      allergens?: boolean, meta?: { petArea?, moisture?, highTouch? }
 *    }
 *  - DexieDB.supplies: { id, name, quantity, threshold, tags[], location?, meta{} }
 *    Useful tags for cleaning: "cleaning", "detergent", "disinfectant", "floors", "bathroom",
 *    "kitchen", "glass", "laundry", "tool:vacuum", "tool:mop", "tool:brush"
 *  - DexieDB.settings: {
 *      quietHours?: { start:"22:00", end:"07:00" },
 *      sabbathWindow?: { startISO, endISO },
 *      householdPolicy?: { fragranceFree?: boolean }
 *    }
 *  - DexieDB.userPlans, DexieDB.favoritePlans (shared plan stores)
 */

import DexieDB from "../db";

const DOMAIN = "cleaning";
const NOW = () => new Date();
const iso = (d) =>
  d instanceof Date ? d.toISOString() : new Date(d || Date.now()).toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const addMinutes = (d, m) => new Date(d.getTime() + m * 60000);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

/* --------------------------------- Optional deps --------------------------- */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_) {}

let automation = null;
try {
  const mod = require("@/services/automation/runtime");
  automation = (mod && (mod.automation || mod.default)) || null;
} catch (_) {}

let calendarSync = null;
try {
  calendarSync = require("@/services/calendar/calendarSync");
} catch (_) {}

let scheduleHelpers = null; // reminders for PPE, weather, withhold times
try {
  scheduleHelpers = require("@/services/session/scheduleHelpers");
} catch (_) {}

let pausePolicies = null; // freeze/continue/safety policies
try {
  pausePolicies = require("@/services/session/policies/pausePolicies");
} catch (_) {}

let inventoryGuard = null; // ensure items on hand for a task
try {
  inventoryGuard = require("@/services/session/guards/inventoryGuard");
} catch (_) {}

let PlanStorageRouter = null; // cloud/Drive/file export
try {
  PlanStorageRouter = require("@/services/plans/PlanStorageRouter");
} catch (_) {}

/* ---------------------------------- Settings ------------------------------- */
async function getSetting(key, fallback) {
  try {
    const row = await DexieDB.settings?.get?.(key);
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

async function loadHouseSettings() {
  const [quietHours, sabbathWindow, householdPolicy] = await Promise.all([
    getSetting("quietHours", { start: "22:00", end: "07:00" }),
    getSetting("sabbathWindow", null),
    getSetting("householdPolicy", { fragranceFree: false }),
  ]);
  return { quietHours, sabbathWindow, householdPolicy };
}

/* ----------------------------- Favorite Plan Hints ------------------------- */
/**
 * favoritePlans for cleaning can store:
 *  meta.hints[roomName.toLowerCase()] = {
 *    preferredDay?: 0-6 (Sun=0) | string ("Mon"...),
 *    preferredWindow?: { start:"09:00", end:"11:00" },
 *    sequence?: string[] (ordered steps e.g. ["Declutter","Dust","Vacuum","Mop"]),
 *    requiredSupplies?: string[] (supply names or tags),
 *    estMinutesOverride?: number
 *  }
 */
async function loadFavoriteHints() {
  try {
    const all = await (DexieDB.favoritePlans
      ?.where?.("domain")
      ?.equals?.(DOMAIN)
      ?.toArray?.() ??
      DexieDB.favoritePlans?.toArray?.() ??
      []);
    const hints = {};
    for (const fav of all || []) {
      if (fav?.domain !== DOMAIN) continue;
      const map = fav?.meta?.hints || {};
      for (const k of Object.keys(map)) {
        hints[k.toLowerCase()] = {
          ...(hints[k.toLowerCase()] || {}),
          ...map[k],
        };
      }
    }
    return hints;
  } catch {
    return {};
  }
}

/* --------------------------------- Helpers --------------------------------- */
function daysSince(isoStr) {
  if (!isoStr) return Infinity;
  const then = new Date(isoStr).getTime();
  return Math.floor((Date.now() - then) / 86400000);
}
function toDowIndex(day) {
  if (typeof day === "number") return clamp(day, 0, 6);
  const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  return map[
    String(day || "")
      .slice(0, 3)
      .toLowerCase()
  ];
}
function inQuietHours(date, quiet) {
  if (!quiet?.start || !quiet?.end) return false;
  const toMin = (t) => {
    const [h, m] = String(t)
      .split(":")
      .map((x) => parseInt(x || "0", 10));
    return h * 60 + (m || 0);
  };
  const cur = date.getHours() * 60 + date.getMinutes();
  const s = toMin(quiet.start),
    e = toMin(quiet.end);
  // if window crosses midnight (e < s)
  if (e < s) return cur >= s || cur < e;
  return cur >= s && cur < e;
}
function inISOWindow(date, win) {
  if (!win?.startISO || !win?.endISO) return false;
  const t = date.getTime();
  return (
    t >= new Date(win.startISO).getTime() && t <= new Date(win.endISO).getTime()
  );
}

/* --------------------------------- Priority -------------------------------- */
function priorityScore({
  overdueDays,
  dirtinessScore = 0,
  allergen,
  blockedBySupplies,
}) {
  // Base on overdue & room dirtiness
  let base =
    (overdueDays > 21
      ? 60
      : overdueDays > 14
      ? 45
      : overdueDays > 7
      ? 30
      : 10) + Math.round(clamp(dirtinessScore, 0, 100) * 0.25);

  if (allergen) base += 15; // allergies bump
  if (blockedBySupplies) base -= 20; // can't do it now

  base = clamp(base, 1, 100);
  let label = "low";
  if (base >= 85) label = "urgent";
  else if (base >= 60) label = "high";
  else if (base >= 30) label = "medium";
  return { label, score: base };
}

/* --------------------------------- Icons ----------------------------------- */
function iconFor(entry) {
  const t = entry.task || "";
  if (/bath/i.test(entry.room || "")) return "🛁";
  if (/kitchen/i.test(entry.room || "")) return "🍽️";
  if (/laundry/i.test(t)) return "🧺";
  if (/vacuum|sweep/i.test(t)) return "🧹";
  if (/mop/i.test(t)) return "🧽";
  if (/dust/i.test(t)) return "🪶";
  if (/disinfect/i.test(t)) return "🧴";
  return "🏠";
}

/* --------------------------------- Supplies -------------------------------- */
function needsSuppliesFor(room, tagsNeeded = []) {
  return async (supplies = []) => {
    const reqs = tagsNeeded.length
      ? supplies.filter((s) =>
          (s.tags || []).some((t) => tagsNeeded.includes(t))
        )
      : [];
    const missing = reqs.filter((s) => (s.quantity ?? 0) <= (s.threshold ?? 0));
    return { required: reqs, missing };
  };
}

/* --------------------------- Task Builder (per room) ----------------------- */
function buildRoomTask(room, ctx, favoriteHints, supplyCheck, supplies) {
  const now = NOW();

  const days = daysSince(room.lastCleanedISO);
  const recDays = room.recurrenceDays || 7;
  const overdueDays = Math.max(0, days - recDays);
  const allergen = !!room.allergens;

  // Suggested sequence: favorites > smart default
  const fav = favoriteHints[(room.name || "").toLowerCase()] || {};
  const sequence =
    Array.isArray(fav.sequence) && fav.sequence.length
      ? fav.sequence
      : room.meta?.highTouch
      ? ["Declutter", "Disinfect high-touch", "Dust", "Vacuum", "Mop"]
      : ["Declutter", "Dust", "Vacuum", "Mop"];

  const estMinutes =
    fav.estMinutesOverride ||
    15 +
      (sequence.includes("Mop") ? 10 : 0) +
      (sequence.includes("Disinfect high-touch") ? 8 : 0);

  // Supplies
  const tagsByRoom = /bath/i.test(room.name || "")
    ? ["bathroom", "disinfectant", "tool:brush"]
    : /kitchen/i.test(room.name || "")
    ? ["kitchen", "disinfectant", "tool:mop"]
    : ["cleaning", "tool:vacuum"];
  const supplyTags =
    fav.requiredSupplies && fav.requiredSupplies.length
      ? fav.requiredSupplies
      : tagsByRoom;

  const missingInfo = supplyCheck
    ? supplyCheck(supplies)
    : needsSuppliesFor(room, supplyTags)(supplies);
  // support both direct and curried forms
  const requiredSupplies = missingInfo.required || [];
  const missingSupplies = missingInfo.missing || [];

  const blockedBySupplies = missingSupplies.length > 0;

  const { label, score } = priorityScore({
    overdueDays,
    dirtinessScore: room.dirtinessScore || 0,
    allergen,
    blockedBySupplies,
  });

  // When to do: aim for next non-quiet hour, outside sabbath, prefer favored day/time
  let due = new Date(now);
  // Prefer favorite day/time
  const preferredDow = toDowIndex(fav.preferredDay);
  const preferredWin = fav.preferredWindow; // {start,end}
  if (Number.isInteger(preferredDow)) {
    const delta = (preferredDow - now.getDay() + 7) % 7;
    due = addDays(due, delta);
  }
  // preferred window or default morning window
  const [startH, startM] = (preferredWin?.start || "09:00")
    .split(":")
    .map((x) => parseInt(x, 10));
  due.setHours(startH || 9, startM || 0, 0, 0);

  // respect quiet hours
  if (ctx.quietHours && inQuietHours(due, ctx.quietHours)) {
    // push to end of quiet window
    const [qhEndH, qhEndM] = (ctx.quietHours.end || "07:00")
      .split(":")
      .map((x) => parseInt(x, 10));
    due.setHours(qhEndH || 7, qhEndM || 0, 0, 0);
  }
  // respect sabbath window
  if (ctx.sabbathWindow && inISOWindow(due, ctx.sabbathWindow)) {
    // move to sabbath end
    due = new Date(ctx.sabbathWindow.endISO);
  }
  // safety/policy pause windows (optional)
  if (
    pausePolicies?.shouldPause &&
    pausePolicies.shouldPause({ domain: DOMAIN, when: due })
  ) {
    // push an hour (or let your policy return a new time)
    due = addMinutes(due, 60);
  }

  const step = sequence[0] || "General Clean";
  const task = `${step} — ${room.name}`;

  const deepLink = { panel: "Cleaning", tab: "Tasks", id: room.id };

  return {
    id: room.id,
    room: room.name,
    zone: room.zone || null,
    priority: label,
    priorityScore: score,
    task,
    sequence,
    dueISO: iso(due),
    estMinutes,
    supplies: {
      required: requiredSupplies.map((s) => ({ id: s.id, name: s.name })),
      missing: missingSupplies.map((s) => ({ id: s.id, name: s.name })),
    },
    ui: {
      intent: "clean-room",
      deepLink,
      followups: missingSupplies.length
        ? [
            {
              action: "openShoppingList",
              target: "CleaningSupplies",
              data: missingSupplies.map((s) => s.name),
            },
          ]
        : [],
    },
    speak: `Cleaning reminder: ${task}.`,
  };
}

/* --------------------------------- Manager --------------------------------- */
const CleaningQueueManager = {
  /**
   * Generate cleaning queue.
   * @param {Object} opts
   *  - emitEvents?: boolean (default true)
   *  - useFavorites?: boolean (default true)
   *  - includeBlocked?: boolean (default true; include items even if supplies missing)
   */
  async generateQueue(opts = {}) {
    const {
      emitEvents = true,
      useFavorites = true,
      includeBlocked = true,
    } = opts;

    const { quietHours, sabbathWindow, householdPolicy } =
      await loadHouseSettings();
    const favoriteHints = useFavorites ? await loadFavoriteHints() : {};
    const [rooms, supplies] = await Promise.all([
      DexieDB.rooms?.toArray?.() ?? [],
      DexieDB.supplies?.toArray?.() ?? [],
    ]);

    const queue = [];

    for (const room of rooms) {
      const check = (suppliesList) => needsSuppliesFor(room, [])(suppliesList); // tags decided inside builder
      const entry = buildRoomTask(
        room,
        { quietHours, sabbathWindow, householdPolicy },
        favoriteHints,
        check,
        supplies
      );

      // Optionally skip tasks blocked by missing supplies
      const blocked = (entry.supplies?.missing || []).length > 0;
      if (!blocked || includeBlocked) queue.push(entry);

      // Emit shortages for cleaning supplies tied to this room
      if (emitEvents && blocked) {
        for (const miss of entry.supplies.missing) {
          const raw = supplies.find((s) => s.id === miss.id);
          const belowRatio =
            (raw?.quantity ?? 0) / Math.max(1, raw?.threshold ?? 1);
          eventBus.emit("inventory.shortage.detected", {
            domain: DOMAIN,
            item: {
              id: raw?.id,
              name: raw?.name || miss.name,
              quantity: raw?.quantity ?? 0,
              threshold: raw?.threshold ?? 0,
              tags: raw?.tags || [],
              location: raw?.location || null,
            },
            belowRatio,
            recommendedAction: `Re-stock to clean ${room.name}`,
            recommendedPlot: null,
          });
        }
      }
    }

    // Sort: priority desc, due asc
    queue.sort((a, b) => {
      if ((b.priorityScore || 0) !== (a.priorityScore || 0))
        return (b.priorityScore || 0) - (a.priorityScore || 0);
      return new Date(a.dueISO || 0) - new Date(b.dueISO || 0);
    });

    // Emit bundle prep request for cleaning tasks
    if (emitEvents && queue.length) {
      eventBus.emit("prep.tasks.requested", {
        domain: DOMAIN,
        tasks: queue.map((e) => ({
          id: e.id,
          name: e.room,
          task: e.task,
          dueISO: e.dueISO,
          estMinutes: e.estMinutes,
          priority: e.priority,
          sequence: e.sequence,
        })),
        meta: { source: "CleaningQueueManager" },
      });
    }

    return queue;
  },

  /* ------------------------- UI formatting + voice ------------------------- */
  async getQueueFormattedForUI(opts = {}) {
    const queue = await this.generateQueue(opts);
    return queue.map((e) => ({
      icon: iconFor(e),
      name: e.room,
      message: `${e.task}`,
      priority: e.priority,
      dueISO: e.dueISO,
      estMinutes: e.estMinutes,
      deepLink: e.ui?.deepLink || null,
      blockers: (e.supplies?.missing || []).map((x) => x.name),
      cta: [
        { action: "saveAsPlan", label: "Save as Plan", id: e.id },
        { action: "saveAsFavorite", label: "⭐ Favorite", id: e.id },
      ],
    }));
  },

  async getVoiceQueue(opts = {}) {
    const queue = await this.generateQueue(opts);
    return queue.map((e) => e.speak);
  },

  async getGroupedQueue(opts = {}) {
    const q = await this.generateQueue(opts);
    const groups = { urgent: [], high: [], medium: [], low: [] };
    for (const e of q) groups[e.priority]?.push(e);
    return groups;
  },

  /* ------------------------------- Calendar -------------------------------- */
  async getCalendarEvents(opts = {}) {
    const q = await this.generateQueue(opts);
    return q.map((e) => ({
      id: `${e.id}:${e.dueISO || "soon"}`,
      title: `${iconFor(e)} ${e.task}`,
      start: e.dueISO || iso(NOW()),
      end: iso(
        addMinutes(new Date(e.dueISO || Date.now()), e.estMinutes || 20)
      ),
      metadata: {
        source: "cleaning-queue",
        priority: e.priority,
        priorityScore: e.priorityScore || 0,
        domain: DOMAIN,
      },
    }));
  },

  async writeCalendar(opts = {}) {
    const events = await this.getCalendarEvents(opts);
    if (!calendarSync?.writeEvents)
      return {
        ok: false,
        reason: "calendarSync not present",
        eventsCount: events.length,
      };
    try {
      await calendarSync.writeEvents(events, { domain: DOMAIN });
      return { ok: true, eventsCount: events.length };
    } catch (err) {
      console.warn("[CleaningQueueManager] calendar write failed:", err);
      return { ok: false, reason: String(err?.message || err) };
    }
  },

  /* --------------------------- Save as (plan/favorite) --------------------- */
  /**
   * Save the current cleaning queue as a plan (or favorite template).
   * @param {Object} options
   *  - title?: string
   *  - favorite?: boolean
   *  - destination?: "router" | "local"
   *  - queueOpts?: options passed to generateQueue
   *  - exportOpts?: forwarded to PlanStorageRouter.save
   */
  async saveQueueAsPlan(options = {}) {
    const {
      title = `Cleaning Plan — ${new Date().toLocaleDateString()}`,
      favorite = false,
      destination,
      queueOpts = {},
      exportOpts = {},
    } = options;

    const queue = await this.generateQueue({ ...queueOpts, emitEvents: false });
    const nowISO = iso(NOW());

    const plan = {
      id: `cleanplan:${nowISO}`,
      domain: DOMAIN,
      title,
      createdAt: nowISO,
      updatedAt: nowISO,
      status: "draft",
      items: queue.map((e) => ({
        id: e.id,
        room: e.room,
        zone: e.zone,
        task: e.task,
        sequence: e.sequence,
        dueISO: e.dueISO,
        estMinutes: e.estMinutes,
        priority: e.priority,
        meta: {
          suppliesMissing: (e.supplies?.missing || []).map((x) => x.name),
          suppliesRequired: (e.supplies?.required || []).map((x) => x.name),
        },
      })),
      meta: {
        generatedBy: "CleaningQueueManager",
        settings: await loadHouseSettings(),
      },
    };

    const tryRouter = async () => {
      if (!PlanStorageRouter?.save) return false;
      try {
        await PlanStorageRouter.save(plan, { favorite, ...exportOpts });
        return true;
      } catch (err) {
        console.warn(
          "[CleaningQueueManager] PlanStorageRouter.save failed:",
          err
        );
        return false;
      }
    };

    const tryLocal = async () => {
      try {
        if (favorite) {
          const fav = {
            id: plan.id,
            domain: DOMAIN,
            title: plan.title,
            createdAt: plan.createdAt,
            meta: {
              hints: plan.items.reduce((acc, it) => {
                const k = (it.room || "").toLowerCase();
                acc[k] = acc[k] || {};
                // derive hintable preferences
                acc[k].sequence = it.sequence;
                // store a gentle preferred window of the due time
                const d = new Date(it.dueISO || Date.now());
                const h = d.getHours().toString().padStart(2, "0");
                const m = d.getMinutes().toString().padStart(2, "0");
                acc[k].preferredDay = d.getDay();
                acc[k].preferredWindow = {
                  start: `${h}:${m}`,
                  end: `${clamp(h * 1 + 2, 0, 23)
                    .toString()
                    .padStart(2, "0")}:${m}`,
                };
                return acc;
              }, {}),
            },
            items: plan.items,
          };
          await DexieDB.favoritePlans?.put?.(fav);
        } else {
          await DexieDB.userPlans?.put?.(plan);
        }
        return true;
      } catch (err) {
        console.warn("[CleaningQueueManager] Local plan save failed:", err);
        return false;
      }
    };

    let saved = false;
    if (destination === "router") saved = await tryRouter();
    else if (destination === "local") saved = await tryLocal();
    else saved = (await tryRouter()) || (await tryLocal());

    // Announce plan tasks for execution UI
    try {
      eventBus.emit("prep.tasks.requested", {
        domain: DOMAIN,
        tasks: plan.items.map((it) => ({
          id: it.id,
          name: it.room,
          task: it.task,
          dueISO: it.dueISO,
          estMinutes: it.estMinutes,
          priority: it.priority,
        })),
        meta: {
          planId: plan.id,
          title: plan.title,
          source: "CleaningQueueManager.saveQueueAsPlan",
        },
      });
    } catch (_) {}

    try {
      automation?.nudge?.({
        scope: DOMAIN,
        kind: "plan_saved",
        payload: {
          planId: plan.id,
          favorite,
          items: plan.items.length,
          title: plan.title,
        },
      });
    } catch (_) {}

    return { ok: saved, plan };
  },

  async saveEntryAsFavorite(entryId, titleSuffix = "") {
    const queue = await this.generateQueue({ emitEvents: false });
    const e = queue.find((x) => x.id === entryId);
    if (!e) return { ok: false, reason: "entry not found" };

    const k = (e.room || "").toLowerCase();
    const when = new Date(e.dueISO || Date.now());
    const favorite = {
      id: `cleanfav:${k}:${Date.now()}`,
      domain: DOMAIN,
      title: `Favorite — ${e.room}${titleSuffix ? ` — ${titleSuffix}` : ""}`,
      createdAt: iso(NOW()),
      meta: {
        hints: {
          [k]: {
            sequence: e.sequence,
            preferredDay: when.getDay(),
            preferredWindow: {
              start: `${String(when.getHours()).padStart(2, "0")}:${String(
                when.getMinutes()
              ).padStart(2, "0")}`,
              end: `${String(clamp(when.getHours() + 2, 0, 23)).padStart(
                2,
                "0"
              )}:${String(when.getMinutes()).padStart(2, "0")}`,
            },
            requiredSupplies: (e.supplies?.required || []).map((x) => x.name),
            estMinutesOverride: e.estMinutes,
          },
        },
      },
      items: [
        {
          id: e.id,
          room: e.room,
          task: e.task,
          sequence: e.sequence,
          dueISO: e.dueISO,
          estMinutes: e.estMinutes,
          priority: e.priority,
          meta: {
            requiredSupplies: (e.supplies?.required || []).map((x) => x.name),
          },
        },
      ],
    };

    try {
      await DexieDB.favoritePlans?.put?.(favorite);
      return { ok: true, favoriteId: favorite.id };
    } catch (err) {
      console.warn("[CleaningQueueManager] saveEntryAsFavorite failed:", err);
      return { ok: false, reason: String(err?.message || err) };
    }
  },
};

export default CleaningQueueManager;
