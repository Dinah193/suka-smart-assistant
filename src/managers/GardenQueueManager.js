// src/managers/GardenQueueManager.js
/* eslint-disable no-console */

/**
 * GardenQueueManager — “Plant It” bridge (seed → plan)
 * -----------------------------------------------------------------------------
 * Builds a garden action queue from inventory + season/zone heuristics.
 * Adds:
 *  • User-owned favorites and schedule templates (not just system).
 *  • Calendar hint for a Plant Session (after-work window, Sabbath-aware).
 *  • Action consumers for scanner→seed, plant-now, and favorite-apply flows.
 *  • Idempotent updates to supplies (add seeds, consume on planting).
 *  • Best-effort orchestration: EventBus, TierSync, Automation nudge.
 *
 * Tables (all optional; defensive):
 * - DexieDB.supplies:      { id, name, quantity, threshold, unit?, location?, tags[], meta{} }
 * - DexieDB.settings:      usdaZone, lastFrostISO, firstFrostISO, gardenBedMap
 * - DexieDB.userPlans:     user-saved draft plans (any domain)
 * - DexieDB.favoritePlans: favorite templates/hints (any domain)
 *
 * Events (existing names where possible; add domain in payload):
 * - inventory.shortage.detected  (domain="garden")
 * - prep.tasks.requested         (domain="garden")
 * - general.plan.favorite.requested   ({ plan, favoriteKey, options })
 * - schedule.template.save.requested  ({ template })
 * - schedule.event.write.requested    ({ title, startTimeLocal, recurrence })
 *
 * Action Consumers (new helpers here):
 * - scanner.seed.accepted           -> add seed packet to supplies, queue→plan (optional)
 * - garden.queue.generate.requested -> regenerate queue
 * - garden.plan.save.requested      -> save current queue as plan / favorite
 * - garden.task.completed           -> consume supplies (qty--)
 */

const DOMAIN = "garden";
const NOW = () => new Date();
const iso = (d) =>
  d instanceof Date ? d.toISOString() : new Date(d || Date.now()).toISOString();
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const safeNumber = (v, fb = 0) => (Number.isFinite(Number(v)) ? Number(v) : fb);

// ---------- Lazy ESM optional imports (browser-safe) ----------
const _cache = new Map();
async function lazy(path) {
  if (_cache.has(path)) return _cache.get(path);
  try {
    const mod = await import(/* @vite-ignore */ path);
    const val = mod?.default ?? mod;
    _cache.set(path, val);
    return val;
  } catch {
    _cache.set(path, null);
    return null;
  }
}

// Dexie (explicit import remains)
import DexieDB from "../db";

// Event bus (fallback noop, then hydrate)
let eventBus = (typeof window !== "undefined" && window.__suka_eventBus__) || {
  emit() {},
  on() {},
  off() {},
};
lazy("@/services/events/eventBus").then((eb) => {
  const bus = eb?.eventBus || eb || eventBus;
  if (typeof window !== "undefined") window.__suka_eventBus__ = bus;
  eventBus = bus;
});

// TierSync / Automation / CalendarSync / Storage Router (optional)
let tierSync = { publish() {} };
let automation = null;
let calendarSync = null;
let PlanStorageRouter = null;
let SettingsStore = null;

Promise.all([
  lazy("@/services/sync/tierSync").then(
    (m) => (tierSync = m?.default || m || tierSync)
  ),
  lazy("@/services/automation/runtime").then(
    (m) => (automation = m?.automation || m?.default || null)
  ),
  lazy("@/services/calendar/calendarSync").then(
    (m) => (calendarSync = m?.default || m || null)
  ),
  lazy("@/services/plans/PlanStorageRouter").then(
    (m) => (PlanStorageRouter = m?.default || m || null)
  ),
  lazy("@/store/SettingsStore").then(
    (m) => (SettingsStore = m?.default || m || null)
  ),
]);

// ---------- Settings ----------
function getSettingsSnapshot() {
  try {
    const get = SettingsStore?.get || SettingsStore?.default?.get;
    if (!get) return {};
    return {
      sabbathAware: !!get("observance.sabbathAware", true),
      sabbathDayRule: get("observance.sabbathDayRule", "hebrew_day7"),
      quietRespect: !!get("notifications.quietHours.respectObservance", true),
      defaultDestination: get("favorites.defaultDestination", "local"),
      plantSessionWindowStart: get("sessions.itemRuntimePanel.compact", false)
        ? "18:30"
        : "17:30",
      defaultScheduleName: get("scheduler.defaultScheduleName", "Household"),
    };
  } catch {
    return {};
  }
}

async function getSetting(key, fallback) {
  try {
    const row = await DexieDB.settings?.get?.(key);
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

async function loadGardenSettings() {
  const [zone, lastFrostISO, firstFrostISO, bedMap] = await Promise.all([
    getSetting("usdaZone", "7b"),
    getSetting("lastFrostISO", null),
    getSetting("firstFrostISO", null),
    getSetting("gardenBedMap", {
      root: "Root Bed",
      leafy: "Shade Bed",
      herb: "Herb Spiral",
      fruiting: "Main Row",
    }),
  ]);
  return { zone, lastFrostISO, firstFrostISO, bedMap };
}

// ---------- Favorite hints ----------
async function loadFavoriteHints() {
  try {
    const all =
      (await DexieDB.favoritePlans
        ?.where?.("domain")
        ?.equals?.(DOMAIN)
        ?.toArray?.()) ??
      (await DexieDB.favoritePlans?.toArray?.()) ??
      [];
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

// ---------- Heuristics ----------
function hasTag(item, tag) {
  return Array.isArray(item?.tags) && item.tags.includes(tag);
}
function hasAnyTag(item, tags = []) {
  return Array.isArray(item?.tags) && item.tags.some((t) => tags.includes(t));
}
function monthInWindow(monthIdx /*0-11*/, win) {
  if (!win?.startMonth || !win?.endMonth) return true;
  const s = clamp((win.startMonth | 0) - 1, 0, 11);
  const e = clamp((win.endMonth | 0) - 1, 0, 11);
  if (s <= e) return monthIdx >= s && monthIdx <= e;
  return monthIdx >= s || monthIdx <= e;
}
function isCoolMonth(date) {
  const m = date.getMonth();
  return (m >= 1 && m <= 3) || (m >= 8 && m <= 10);
}
function defaultWindowForTags(item) {
  if (hasTag(item, "cool")) return { startMonth: 2, endMonth: 4 }; // Mar–Apr
  if (hasTag(item, "warm")) return { startMonth: 5, endMonth: 7 }; // Jun–Jul
  return null;
}
function daysUntil(date) {
  const ms = new Date(date) - NOW();
  return Math.round(ms / 86400000);
}

// ---------- Priority ----------
function priorityScore({
  belowRatio,
  timePressureDays,
  viabilityRisk,
  categoryBump = 0,
}) {
  let base =
    belowRatio <= 0.1
      ? 80
      : belowRatio <= 0.25
      ? 60
      : belowRatio <= 0.5
      ? 35
      : 15;

  if (Number.isFinite(timePressureDays)) {
    if (timePressureDays <= 0) base += 25;
    else if (timePressureDays <= 7) base += 18;
    else if (timePressureDays <= 21) base += 10;
  }

  if (viabilityRisk === "urgent") base += 20;
  else if (viabilityRisk === "soon") base += 8;

  base += categoryBump;
  const score = clamp(Math.round(base), 1, 100);

  let label = "low";
  if (score >= 85) label = "urgent";
  else if (score >= 60) label = "high";
  else if (score >= 30) label = "medium";

  return { label, score };
}

// ---------- Icons/UI helpers ----------
function iconFor(entry) {
  const t = entry.task || "";
  const name = entry.name?.toLowerCase() || "";
  if (/transplant/i.test(t)) return "🪴";
  if (/direct|sow/i.test(t)) return "🌱";
  if (/trellis|stake/i.test(t) || name.includes("tomato")) return "🪜";
  if (/harvest/i.test(t)) return "🧺";
  if (/mulch|water/i.test(t)) return "💧";
  return "🌿";
}
function suggestPlot(item, bedMap) {
  if (item.meta?.bedHint) return item.meta.bedHint;
  if (hasTag(item, "root")) return bedMap.root || "Root Bed";
  if (hasTag(item, "leafy")) return bedMap.leafy || "Shade Bed";
  if (hasTag(item, "herb")) return bedMap.herb || "Herb Spiral";
  if (hasTag(item, "fruiting")) return bedMap.fruiting || "Main Row";
  return "Main Row";
}

// ---------- Task builders ----------
function buildPlantingTask(item, ctx, favoriteHints = {}) {
  const { bedMap, lastFrostISO, firstFrostISO } = ctx;
  const now = NOW();
  const mIdx = now.getMonth();

  const key = (item.name || "").toLowerCase();
  const fav = favoriteHints[key] || {};

  const windowPrefUser = fav.plantingWindow || null;
  const windowPrefTags =
    item.meta?.plantingWindow || defaultWindowForTags(item);
  const windowPref = windowPrefUser || windowPrefTags;

  const inWindow = monthInWindow(mIdx, windowPref);
  const frostSoon = lastFrostISO ? daysUntil(lastFrostISO) : null;
  const beforeLastFrost = frostSoon != null && frostSoon > 0;

  const sowing =
    item.meta?.sowing || (hasTag(item, "root") ? "direct" : "transplant");
  let task = inWindow
    ? sowing === "transplant"
      ? "Transplant seedlings"
      : "Direct sow"
    : sowing === "transplant"
    ? "Up-pot & harden off"
    : "Start indoors";

  if (hasTag(item, "warm") && beforeLastFrost && sowing !== "transplant") {
    task = "Start indoors (warm crop)";
  }

  const preferredPlot = fav.preferredPlot || null;
  const recommendedPlot = preferredPlot || suggestPlot(item, bedMap);

  const belowRatio = (item.quantity ?? 0) / Math.max(1, item.threshold ?? 1);

  let timePressureDays = null;
  if (windowPref) {
    const endMonthIdx = clamp((windowPref.endMonth || mIdx + 1) - 1, 0, 11);
    const endDate = new Date(now.getFullYear(), endMonthIdx, 28, 18, 0, 0);
    timePressureDays = daysUntil(endDate);
  } else if (hasTag(item, "warm") && firstFrostISO) {
    timePressureDays = daysUntil(firstFrostISO);
  }

  let viabilityRisk = null;
  if (item.meta?.viabilityExpiresISO) {
    const d = daysUntil(item.meta.viabilityExpiresISO);
    if (d <= 0) viabilityRisk = "urgent";
    else if (d <= 30) viabilityRisk = "soon";
  }

  const categoryBump = hasTag(item, "root")
    ? 10
    : hasTag(item, "leafy")
    ? 5
    : hasTag(item, "herb")
    ? 3
    : hasTag(item, "fruiting")
    ? 12
    : 0;

  const { label, score } = priorityScore({
    belowRatio,
    timePressureDays,
    viabilityRisk,
    categoryBump,
  });

  const estMinutes = /Transplant/i.test(task)
    ? 25
    : /Direct sow|Start indoors/i.test(task)
    ? 15
    : /Up-pot|harden/i.test(task)
    ? 20
    : 12;

  const due = (() => {
    if (timePressureDays != null) {
      const pad = score >= 85 ? 0 : score >= 60 ? 2 : 5;
      return addDays(now, Math.max(0, timePressureDays - pad));
    }
    if (belowRatio <= 0.25) return addDays(now, 0);
    if (belowRatio <= 0.5) return addDays(now, 3);
    return addDays(now, 7);
  })();

  const companions = Array.isArray(item.meta?.companions)
    ? item.meta.companions
    : [];

  return {
    id: item.id,
    sourceId: item.id,
    source: "supplies",
    name: item.name,
    quantity: item.quantity,
    threshold: item.threshold,
    location: item.location || "unknown",
    recommendedPlot,
    priority: label,
    priorityScore: score,
    dueISO: iso(due),
    estMinutes,
    task,
    details: {
      sowing,
      companions,
      window: windowPref || null,
      viabilityExpiresISO: item.meta?.viabilityExpiresISO || null,
      variety: item.meta?.variety || null,
      successionsPerSeason:
        fav.successionsPerSeason ?? item.meta?.successionsPerSeason ?? null,
    },
    ui: {
      intent: "garden-plant",
      deepLink: { panel: "Garden", tab: "Planner", id: item.id },
      followups: [
        companions.length
          ? {
              action: "openGuide",
              target: "CompanionPlanting",
              data: companions,
            }
          : null,
      ].filter(Boolean),
    },
    speak: `Garden reminder: ${task} ${item.name} in the ${recommendedPlot}.`,
  };
}

function buildHarvestOrSupportTask(item, ctx) {
  if (!hasAnyTag(item, ["fruiting", "trellis"])) return null;

  const name = item.name || "Plant";
  const supportNeeded = hasAnyTag(item, ["trellis", "tomato", "cucumber"]);
  const task = supportNeeded ? "Trellis / stake support" : "Harvest & prune";

  const priority = item.quantity > (item.threshold || 0) ? "medium" : "low";
  const score = priority === "medium" ? 40 : 20;

  return {
    id: `supp-${item.id}`,
    sourceId: item.id,
    source: "supplies",
    name,
    quantity: item.quantity,
    threshold: item.threshold,
    location: item.location || "unknown",
    recommendedPlot: suggestPlot(item, ctx.bedMap),
    priority,
    priorityScore: score,
    dueISO: iso(addDays(NOW(), priority === "medium" ? 2 : 5)),
    estMinutes: supportNeeded ? 20 : 15,
    task,
    details: {},
    ui: {
      intent: supportNeeded ? "garden-support" : "garden-harvest",
      deepLink: { panel: "Garden", tab: "Tasks", id: item.id },
    },
    speak: `Garden reminder: ${task} for ${name}.`,
  };
}

// ---------- Plan builder (favorite-able + schedule-able) ----------
function buildPlantSessionPlan(queue, { title, startTimeLocal }) {
  const stores = new Set(queue.map((e) => e.recommendedPlot || "Garden"));
  const plan = {
    $id: `plan:garden:plant:${Date.now()}`,
    $schema: "urn:suka:contracts:workplan",
    type: "garden",
    slug: "garden:plant-session",
    meta: {
      title: title || "Garden — Plant Session",
      subtitle: `${queue.length} tasks · ${Array.from(stores).join(", ")}`,
      domain: DOMAIN,
      version: "1.1.0",
      favoriteable: true,
      exportable: true,
      defaultFavoriteKey: "garden:plant-session",
      icon: "leaf",
      tags: ["garden", "plant", "queue"],
    },
    params: { domain: DOMAIN, generatedAt: iso(NOW()) },
    schedule: {
      recurrence: null,
      startTimeLocal: startTimeLocal || "17:30",
      calendar: { write: true, title: "Garden — Plant Session" },
      favoriteableSchedule: {
        suggestedName: "My Evening Planting",
        suggestedDomain: DOMAIN,
      },
    },
    steps: queue.map((e) => ({
      id: `plant-${e.id}`,
      title: `${e.task} — ${e.name}`,
      description: `Plot: ${e.recommendedPlot || "Garden"} · Est ${
        e.estMinutes || 12
      } min`,
      kind: "garden",
      plot: e.recommendedPlot || null,
      durationMs: (e.estMinutes || 12) * 60000,
      startOffset: 0,
      actions: [
        {
          type: "consume-supplies",
          label: "Mark seed used",
          data: {
            sourceId: e.sourceId,
            qty: 1,
            unit: e.details?.sowing === "transplant" ? "seedling" : "packet",
            idempotencyKey: `consume:${e.sourceId}:${e.id}`,
          },
        },
      ],
    })),
  };

  // Calendar hint
  eventBus?.emit?.("schedule.event.write.requested", {
    domain: DOMAIN,
    planId: plan.$id,
    title: plan.schedule.calendar.title || plan.meta.title,
    recurrence: plan.schedule.recurrence,
    startTimeLocal: plan.schedule.startTimeLocal,
  });

  // Allow user to save a schedule template for themselves
  eventBus?.emit?.("schedule.template.save.requested", {
    source: "GardenQueueManager",
    planId: plan.$id,
    template: {
      name: plan.schedule.favoriteableSchedule.suggestedName,
      domain: DOMAIN,
      schedule: {
        startTimeLocal: plan.schedule.startTimeLocal,
        recurrence: null,
      },
      favoriteKey: "user:schedule:garden:plant",
    },
  });

  return plan;
}

// ---------- Action idempotency ----------
const _actionSeen = new Set();
function seenOrRemember(key) {
  if (!key) return false;
  if (_actionSeen.has(key)) return true;
  _actionSeen.add(key);
  if (_actionSeen.size > 1000) {
    const it = _actionSeen.values().next();
    if (!it.done) _actionSeen.delete(it.value);
  }
  return false;
}

// ---------- Supplies adjustments ----------
async function upsertSupply(row) {
  try {
    const put = DexieDB.supplies?.put;
    if (!put) return false;
    await put(row);
    return true;
  } catch (e) {
    console.warn("[GardenQueueManager] upsertSupply failed:", e);
    return false;
  }
}
async function adjustSupplyQty(id, delta) {
  try {
    const get = DexieDB.supplies?.get;
    const put = DexieDB.supplies?.put;
    if (!get || !put) return false;
    const item = await get(id);
    if (!item) return false;
    const next = {
      ...item,
      quantity: safeNumber(item.quantity, 0) + safeNumber(delta, 0),
    };
    await put(next);
    eventBus?.emit?.("inventory:changed", {
      reason: "garden-consume",
      itemId: id,
    });
    tierSync?.publish?.("garden.supplies.adjusted", { id, delta });
    return true;
  } catch (e) {
    console.warn("[GardenQueueManager] adjustSupplyQty failed:", e);
    return false;
  }
}

// ---------- Core Manager ----------
const GardenQueueManager = {
  /**
   * Analyze inventory and generate garden actions.
   * @param {Object} opts
   *   - emitEvents?: boolean (default true)
   *   - useFavorites?: boolean (default true)
   *   - includeSupportHarvest?: boolean (default true)
   */
  async generateQueue(opts = {}) {
    const {
      emitEvents = true,
      useFavorites = true,
      includeSupportHarvest = true,
    } = opts;

    const settings = await loadGardenSettings();
    const favoriteHints = useFavorites ? await loadFavoriteHints() : {};
    const supplies = (await DexieDB.supplies?.toArray?.()) ?? [];

    const candidates = supplies.filter((item) => {
      const gardenish = hasAnyTag(item, [
        "garden",
        "growable",
        "seed",
        "seedling",
        "root",
        "leafy",
        "herb",
        "fruiting",
      ]);
      const isBelowThreshold = (item.quantity ?? 0) <= (item.threshold ?? 0);
      return (
        gardenish &&
        (isBelowThreshold || hasAnyTag(item, ["fruiting", "trellis"]))
      );
    });

    const queue = [];
    for (const item of candidates) {
      const planting = buildPlantingTask(item, settings, favoriteHints);
      if (planting) {
        queue.push(planting);
        const belowRatio =
          (item.quantity ?? 0) / Math.max(1, item.threshold ?? 1);
        if (emitEvents && belowRatio <= 1) {
          eventBus.emit("inventory.shortage.detected", {
            domain: DOMAIN,
            item: {
              id: item.id,
              name: item.name,
              quantity: item.quantity ?? 0,
              threshold: item.threshold ?? 0,
              tags: item.tags || [],
              location: item.location || null,
            },
            belowRatio,
            recommendedAction: planting.task,
            recommendedPlot: planting.recommendedPlot,
          });
        }
      }
      if (includeSupportHarvest) {
        const support = buildHarvestOrSupportTask(item, settings);
        if (support) queue.push(support);
      }
    }

    queue.sort((a, b) => {
      if ((b.priorityScore || 0) !== (a.priorityScore || 0))
        return (b.priorityScore || 0) - (a.priorityScore || 0);
      return new Date(a.dueISO || 0) - new Date(b.dueISO || 0);
    });

    if (emitEvents && queue.length) {
      eventBus.emit("prep.tasks.requested", {
        domain: DOMAIN,
        tasks: queue.map((e) => ({
          id: e.id,
          name: e.name,
          task: e.task,
          dueISO: e.dueISO,
          estMinutes: e.estMinutes,
          priority: e.priority,
          plot: e.recommendedPlot,
        })),
        meta: { source: "GardenQueueManager" },
      });
    }

    tierSync?.publish?.("garden.queue.generated", {
      count: queue.length,
      top: queue[0]?.name || null,
    });

    return queue.map((entry) => ({
      id: entry.id,
      name: entry.name,
      quantity: entry.quantity,
      threshold: entry.threshold,
      location: entry.location,
      recommendedPlot: entry.recommendedPlot,
      priority: entry.priority,
      task: entry.task,
      priorityScore: entry.priorityScore,
      dueISO: entry.dueISO,
      estMinutes: entry.estMinutes,
      details: entry.details,
      ui: entry.ui,
      speak: entry.speak ?? `Garden reminder: plant more ${entry.name}.`,
    }));
  },

  // ----- UI, Voice, Grouped -----
  async getQueueFormattedForUI(opts = {}) {
    const queue = await this.generateQueue(opts);
    return queue.map((entry) => ({
      icon: iconFor(entry),
      name: entry.name,
      message: entry.task
        ? `${entry.task} — ${entry.name} in ${entry.recommendedPlot}.`
        : `Low on ${entry.name}. Recommend planting in ${entry.recommendedPlot}.`,
      priority: entry.priority,
      dueISO: entry.dueISO,
      estMinutes: entry.estMinutes,
      deepLink: entry.ui?.deepLink || null,
      cta: [
        { action: "saveAsPlan", label: "Save as Plan", id: entry.id },
        { action: "saveAsFavorite", label: "⭐ Favorite", id: entry.id },
      ],
    }));
  },

  async getVoiceQueue(opts = {}) {
    const queue = await this.generateQueue(opts);
    return queue.map((entry) => entry.speak);
  },

  async getGroupedQueue(opts = {}) {
    const q = await this.generateQueue(opts);
    const groups = { urgent: [], high: [], medium: [], low: [] };
    for (const e of q) groups[e.priority]?.push(e);
    return groups;
  },

  // ----- Calendar -----
  async getCalendarEvents(opts = {}) {
    const q = await this.generateQueue(opts);
    return q.map((e) => ({
      id: `${e.id}:${e.dueISO || "soon"}`,
      title: `${iconFor(e)} ${e.task || "Plant"} — ${e.name}`,
      start: e.dueISO || iso(NOW()),
      end: iso(
        new Date(
          new Date(e.dueISO || Date.now()).getTime() +
            (e.estMinutes || 12) * 60000
        )
      ),
      metadata: {
        source: "garden-queue",
        priority: e.priority,
        priorityScore: e.priorityScore || 0,
        plot: e.recommendedPlot || null,
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
      console.warn("[GardenQueueManager] calendar write failed:", err);
      return { ok: false, reason: String(err?.message || err) };
    }
  },

  // ----- Save as plan / favorite (user-owned) -----
  async saveQueueAsPlan(options = {}) {
    const settingsSnap = getSettingsSnapshot();
    const {
      title = `Garden Plan — ${new Date().toLocaleDateString()}`,
      favorite = false,
      destination,
      queueOpts = {},
      exportOpts = {},
      emitFavoritePlanEvent = true,
    } = options;

    const queue = await this.generateQueue(queueOpts);
    const nowISO = iso(NOW());

    // Build a work plan with steps & schedule
    const plan = buildPlantSessionPlan(queue, {
      title,
      startTimeLocal: settingsSnap.plantSessionWindowStart || "17:30",
    });

    // Also save a raw plan object for Dexie history
    const rawPlan = {
      id: plan.$id,
      domain: DOMAIN,
      title,
      createdAt: nowISO,
      updatedAt: nowISO,
      status: "draft",
      items: queue.map((e) => ({
        id: e.id,
        name: e.name,
        task: e.task,
        plot: e.recommendedPlot,
        dueISO: e.dueISO,
        estMinutes: e.estMinutes,
        priority: e.priority,
        meta: {
          sourceId: e.sourceId,
          window: e.details?.window || null,
          companions: e.details?.companions || [],
          sowing: e.details?.sowing || null,
          successionsPerSeason: e.details?.successionsPerSeason || null,
        },
      })),
      meta: {
        generatedBy: "GardenQueueManager",
        settings: await loadGardenSettings(),
      },
    };

    // Prefer PlanStorageRouter
    const tryRouter = async () => {
      if (!PlanStorageRouter?.save) return false;
      try {
        await PlanStorageRouter.save(rawPlan, { favorite, ...exportOpts });
        return true;
      } catch (err) {
        console.warn(
          "[GardenQueueManager] PlanStorageRouter.save failed:",
          err
        );
        return false;
      }
    };
    const tryLocal = async () => {
      try {
        if (favorite) {
          const row = {
            id: rawPlan.id,
            domain: DOMAIN,
            title: rawPlan.title,
            createdAt: rawPlan.createdAt,
            meta: {
              hints: rawPlan.items.reduce((acc, it) => {
                const k = (it.name || "").toLowerCase();
                acc[k] = acc[k] || {};
                if (it.plot) acc[k].preferredPlot = it.plot;
                if (it.meta?.window) acc[k].plantingWindow = it.meta.window;
                if (it.meta?.successionsPerSeason)
                  acc[k].successionsPerSeason = it.meta.successionsPerSeason;
                return acc;
              }, {}),
            },
            items: rawPlan.items,
          };
          await DexieDB.favoritePlans?.put?.(row);
        } else {
          await DexieDB.userPlans?.put?.(rawPlan);
        }
        return true;
      } catch (err) {
        console.warn("[GardenQueueManager] Local plan save failed:", err);
        return false;
      }
    };

    let saved = false;
    if (destination === "router") saved = await tryRouter();
    else if (destination === "local") saved = await tryLocal();
    else saved = (await tryRouter()) || (await tryLocal());

    // Fire plan-created events
    eventBus?.emit?.("prep.tasks.requested", {
      domain: DOMAIN,
      tasks: rawPlan.items.map((it) => ({
        id: it.id,
        name: it.name,
        task: it.task,
        dueISO: it.dueISO,
        estMinutes: it.estMinutes,
        priority: it.priority,
      })),
      meta: {
        planId: rawPlan.id,
        title: rawPlan.title,
        source: "GardenQueueManager.saveQueueAsPlan",
      },
    });

    // Emit favorite-able plan save for user-owned flows (save modal/export)
    if (emitFavoritePlanEvent) {
      eventBus?.emit?.("general.plan.favorite.requested", {
        domain: DOMAIN,
        plan,
        options: {
          source: "GardenQueueManager",
          destination: settingsSnap.defaultDestination || "local",
        },
        favoriteKey: plan.meta.defaultFavoriteKey || "garden:plant-session",
      });
    }

    // Nudge UI
    automation?.nudge?.({
      scope: DOMAIN,
      kind: "plan_saved",
      payload: {
        planId: rawPlan.id,
        favorite,
        items: rawPlan.items.length,
        title: rawPlan.title,
      },
    });

    return { ok: saved, plan, rawPlan };
  },

  async saveEntryAsFavorite(entryId, titleSuffix = "") {
    const queue = await this.generateQueue({ emitEvents: false });
    const e = queue.find((x) => x.id === entryId);
    if (!e) return { ok: false, reason: "entry not found" };

    const nameKey = (e.name || "").toLowerCase();
    const fav = {
      id: `gardenfav:${nameKey}:${Date.now()}`,
      domain: DOMAIN,
      title: `Favorite — ${e.name}${titleSuffix ? ` — ${titleSuffix}` : ""}`,
      createdAt: iso(NOW()),
      meta: {
        hints: {
          [nameKey]: {
            preferredPlot: e.recommendedPlot || null,
            plantingWindow: e.details?.window || null,
            successionsPerSeason: e.details?.successionsPerSeason || null,
          },
        },
      },
      items: [
        {
          id: e.id,
          name: e.name,
          task: e.task,
          plot: e.recommendedPlot,
          dueISO: e.dueISO,
          estMinutes: e.estMinutes,
          priority: e.priority,
          meta: e.details || {},
        },
      ],
    };

    try {
      await DexieDB.favoritePlans?.put?.(fav);
      return { ok: true, favoriteId: fav.id };
    } catch (err) {
      console.warn("[GardenQueueManager] saveEntryAsFavorite failed:", err);
      return { ok: false, reason: String(err?.message || err) };
    }
  },

  // ----- Action Consumers (scanner → seed; plant-now; plan-save; task-complete) -----
  registerActionConsumers() {
    const handlers = [];

    // scanner.seed.accepted: { name, qty?, unit?, tags?, meta? }
    const onSeedAccepted = async (evt) => {
      const p = evt?.payload || evt || {};
      const key = p.idempotencyKey || `seed:${p.name}:${p.qty || 1}`;
      if (seenOrRemember(key)) return;

      // Upsert a seed/packet supply row
      const row = {
        id: p.id || `seed:${(p.name || "Unknown").toLowerCase()}`,
        name: p.name || "Unknown Seed",
        quantity: safeNumber(p.qty, 1),
        threshold: safeNumber(p.threshold, 1),
        unit: p.unit || "packet",
        location: p.location || "Seed Box",
        tags: Array.isArray(p.tags)
          ? p.tags
          : ["garden", "seed", ...(p.tags ? [p.tags] : [])],
        meta: { ...(p.meta || {}) },
      };
      await upsertSupply(row);

      // Generate a quick queue and auto-build a plan (no favorite unless UI asks)
      const queue = await this.generateQueue({
        emitEvents: true,
        useFavorites: true,
      });
      const settingsSnap = getSettingsSnapshot();
      const plan = buildPlantSessionPlan(queue.slice(0, 12), {
        title: `Plant It — ${p.name || "Seeds"}`,
        startTimeLocal: settingsSnap.plantSessionWindowStart || "17:30",
      });

      // Offer save modal/export
      eventBus?.emit?.("general.plan.favorite.requested", {
        domain: DOMAIN,
        plan,
        options: {
          source: "GardenQueueManager.onSeedAccepted",
          destination: settingsSnap.defaultDestination || "local",
        },
        favoriteKey: plan.meta.defaultFavoriteKey || "garden:plant-session",
      });
    };

    // garden.queue.generate.requested
    const onQueueGenerateRequested = async () => {
      await this.generateQueue({
        emitEvents: true,
        useFavorites: true,
        includeSupportHarvest: true,
      });
    };

    // garden.plan.save.requested: { title?, favorite?, destination? }
    const onPlanSaveRequested = async (evt) => {
      const p = evt?.payload || evt || {};
      await this.saveQueueAsPlan({
        title: p.title,
        favorite: !!p.favorite,
        destination: p.destination,
        emitFavoritePlanEvent: true,
      });
    };

    // garden.task.completed: { sourceId, consumeQty?, idempotencyKey? }
    const onTaskCompleted = async (evt) => {
      const p = evt?.payload || evt || {};
      const key =
        p.idempotencyKey || `taskdone:${p.sourceId}:${p.consumeQty || 1}`;
      if (seenOrRemember(key)) return;
      if (p.sourceId) {
        await adjustSupplyQty(
          p.sourceId,
          -Math.abs(safeNumber(p.consumeQty, 1))
        );
      }
    };

    try {
      eventBus.on?.("scanner.seed.accepted", onSeedAccepted);
      handlers.push(["scanner.seed.accepted", onSeedAccepted]);
      eventBus.on?.(
        "garden.queue.generate.requested",
        onQueueGenerateRequested
      );
      handlers.push([
        "garden.queue.generate.requested",
        onQueueGenerateRequested,
      ]);
      eventBus.on?.("garden.plan.save.requested", onPlanSaveRequested);
      handlers.push(["garden.plan.save.requested", onPlanSaveRequested]);
      eventBus.on?.("garden.task.completed", onTaskCompleted);
      handlers.push(["garden.task.completed", onTaskCompleted]);
    } catch (e) {
      console.warn("[GardenQueueManager] registerActionConsumers failed:", e);
    }

    return () => {
      try {
        for (const [evt, fn] of handlers) eventBus.off?.(evt, fn);
      } catch {}
    };
  },
};

export default GardenQueueManager;
