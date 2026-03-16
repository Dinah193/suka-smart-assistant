// src/managers/AnimalQueueManager.js
/* eslint-disable no-console */

import DexieDB from "../db";

/**
 * AnimalQueueManager
 * -----------------------------------------------------------------------------
 * Generates animal care & processing tasks from inventory + lifecycle + favorites.
 * Safe to missing tables/services; emits domain-aware events; supports saving plans.
 *
 * Optional Dexie tables:
 * - supplies: { id, name, quantity, threshold, unit?, tags[], location?, meta{} }
 * - animals:  { id, name, species, sex?, stage?, tags[], meta{}, lastMilkISO?, lastEggISO?, lastHeatISO? }
 * - settings: { key, value }
 * - userPlans, favoritePlans
 *
 * Favorites influence (favoritePlans.domain === "animals"):
 *   meta.hints[key] where key is animal name (lowercased) OR species:
 *     {
 *       milkingWindow?: { start:"06:00", end:"08:00" },
 *       eggCollectionsPerDay?: number,
 *       processorPref?: "on-farm" | "state" | "USDA",
 *       processorId?: string,
 *       processorDropoffISO?: string,     // preferred appointment
 *       fastingHours?: number,            // pre-slaughter withdraw feed hours
 *       cutSheetDefaults?: object,        // { steakThickness, grindPct, bones, organs, ... }
 *       sequence?: string[],              // preferred care/processing step order
 *       estMinutesOverride?: number
 *     }
 */

const DOMAIN = "animals";
const NOW = () => new Date();
const iso = (d) =>
  d instanceof Date ? d.toISOString() : new Date(d || Date.now()).toISOString();
const addMinutes = (d, m) => new Date(d.getTime() + m * 60000);
const addHours = (d, h) => addMinutes(d, h * 60);
const addDays = (d, n) => addHours(d, n * 24);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/* ------------------------------- Optional deps ------------------------------ */
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

let PlanStorageRouter = null;
try {
  PlanStorageRouter = require("@/services/plans/PlanStorageRouter");
} catch (_) {}

let pausePolicies = null; // optional freeze/continue/safety windows
try {
  pausePolicies = require("@/services/session/policies/pausePolicies");
} catch (_) {}

let inventoryGuard = null; // optional ensure-available supplies
try {
  inventoryGuard = require("@/services/session/guards/inventoryGuard");
} catch (_) {}

let AnimalPlanTemplates = null; // optional starter templates
try {
  AnimalPlanTemplates = require("@/libraries/AnimalPlanTemplates");
} catch (_) {}

/* --------------------------------- Settings -------------------------------- */
const DEFAULTS = {
  milkCadenceHours: { goat: 24, cow: 24, sheep: 24 },
  eggCollectionPerDay: 1,
  feedLowPct: 0.2,
  breedHeatCycleDays: { goat: 21, sheep: 17, cow: 21, rabbit: 14 },
  processingWindowDays: 7,
  fastingHours: 12, // safe default for pre-slaughter feed withdraw
  estDurationsMin: {
    feed: 10,
    milk: 25,
    eggs: 8,
    breedingCheck: 15,
    processingPrep: 60,
    transport: 40,
    general: 10,
  },
  restockDaysCover: 14,
};

async function getSetting(key, fallback) {
  try {
    const row = await DexieDB.settings?.get?.(key);
    return row?.value ?? fallback;
  } catch {
    return fallback;
  }
}

async function loadAnimalSettings() {
  const [
    milkCadenceHours,
    eggCollectionPerDay,
    breedHeatCycleDays,
    processingWindowDays,
    fastingHours,
  ] = await Promise.all([
    getSetting("milkCadenceHours", DEFAULTS.milkCadenceHours),
    getSetting("eggCollectionPerDay", DEFAULTS.eggCollectionPerDay),
    getSetting("breedHeatCycleDays", DEFAULTS.breedHeatCycleDays),
    getSetting("processingWindowDays", DEFAULTS.processingWindowDays),
    getSetting("fastingHours", DEFAULTS.fastingHours),
  ]);
  return {
    milkCadenceHours,
    eggCollectionPerDay,
    breedHeatCycleDays,
    processingWindowDays,
    fastingHours,
  };
}

/* ------------------------------ Favorites hints ---------------------------- */
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
    return hints; // keys by animal name OR species (lowercased)
  } catch {
    return {};
  }
}

/* --------------------------------- Utilities -------------------------------- */
function hasTag(item, tag) {
  return Array.isArray(item?.tags) && item.tags.includes(tag);
}
function hasAnyTag(item, tags = []) {
  return Array.isArray(item?.tags) && item.tags.some((t) => tags.includes(t));
}
function pickFav(hints, animal) {
  const byName = hints[(animal.name || "").toLowerCase()];
  const bySpecies = hints[(animal.species || "").toLowerCase()];
  return { ...(bySpecies || {}), ...(byName || {}) };
}

/* --------------------------------- Priority -------------------------------- */
function labelFromScore(score) {
  if (score >= 85) return "urgent";
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}
function priorityScore({ base = 10, bump = 0 }) {
  const score = clamp(Math.round(base + bump), 1, 100);
  return { score, label: labelFromScore(score) };
}

/* --------------------------------- Icons ----------------------------------- */
function iconForTask(task) {
  if (/feed/i.test(task)) return "🌾";
  if (/milk/i.test(task)) return "🥛";
  if (/egg|nest/i.test(task)) return "🥚";
  if (/breed|heat|gestation/i.test(task)) return "🧬";
  if (/butcher|process|slaughter|drop[- ]?off/i.test(task)) return "🔪";
  if (/transport/i.test(task)) return "🚚";
  if (/clean/i.test(task)) return "🧹";
  return "🐾";
}

/* ----------------------------- Narration helpers --------------------------- */
function narrationFor(entry) {
  const dueTxt = entry.dueISO
    ? ` by ${new Date(entry.dueISO).toLocaleString()}`
    : "";
  const extra =
    entry.details?.hint ||
    entry.details?.reason ||
    entry.details?.suggestion ||
    "";
  return `Animal task: ${entry.task} — ${entry.name}${
    entry.species ? ` (${entry.species})` : ""
  }${dueTxt}${extra ? ". " + extra : ""}`;
}
function toastMsg(entry) {
  const when = entry.dueISO
    ? "due " + new Date(entry.dueISO).toLocaleTimeString()
    : "queued";
  return `${entry.task} — ${entry.name} (${entry.priority}) • ${when}`;
}

/* --------------------------------- Rules ----------------------------------- */
/** Restock feed from supplies */
function ruleFeedRestock(item, defaults) {
  if (!hasTag(item, "animal-feed")) return null;
  const qty = Number(item.quantity ?? 0);
  const threshold = Number(item.threshold ?? 0);
  if (threshold <= 0) return null;
  if (qty > threshold) return null;

  const pct = threshold ? qty / threshold : 0;
  const urgent = pct <= (item.meta?.feedLowPct ?? defaults.feedLowPct);
  const { score, label } = priorityScore({ base: urgent ? 95 : 55 });

  const suggestedDays =
    item.meta?.restockDaysCover ?? defaults.restockDaysCover;
  const dailyUse = Number(item.meta?.dailyUse ?? 0);
  const suggestedQty = dailyUse > 0 ? dailyUse * suggestedDays : threshold * 2;

  return {
    id: `feed-${item.id}`,
    sourceId: item.id,
    source: "supplies",
    task: "Restock feed",
    name: item.name,
    species: item.meta?.species || item.meta?.for || null,
    priority: label,
    priorityScore: score,
    dueISO: iso(addDays(NOW(), urgent ? 0 : 1)),
    estMinutes: defaults.estDurationsMin.feed,
    details: {
      reason: `At or below threshold (${qty}/${threshold}).`,
      suggestedQty,
      unit: item.unit || "",
    },
    ui: {
      intent: "restock",
      deepLink: { panel: "Inventory", tab: "Feed", id: item.id },
    },
  };
}

/** Milk collection */
function ruleMilkCollection(animal, cadenceHours, fav = {}, defaults) {
  const species = (animal.species || "").toLowerCase();
  const cadence = cadenceHours[species] ?? 24;
  const lastISO = animal.lastMilkISO || animal.meta?.lastMilkISO || null;
  const last = lastISO ? new Date(lastISO) : addHours(NOW(), -cadence - 1);
  const nextDue = addHours(last, cadence);

  if (
    NOW() < nextDue &&
    !hasAnyTag(animal, ["goat-milk", "cow-milk", "sheep-milk"])
  )
    return null;

  const over = NOW() - nextDue > 0 ? 20 : 0;
  const { score, label } = priorityScore({ base: 70, bump: over });

  // Respect preferred milking window if provided by favorite
  let due = new Date(nextDue);
  const win = fav.milkingWindow;
  if (win?.start) {
    const [h, m] = win.start.split(":").map((n) => parseInt(n, 10));
    due.setHours(h || due.getHours(), m || 0, 0, 0);
  }

  // Pause policies (if any)
  if (
    pausePolicies?.shouldPause &&
    pausePolicies.shouldPause({ domain: DOMAIN, when: due })
  ) {
    due = addMinutes(due, 30);
  }

  return {
    id: `milk-${animal.id}`,
    sourceId: animal.id,
    source: "animals",
    task: "Collect milk",
    name: animal.name || animal.meta?.alias || "Unnamed",
    species: animal.species || null,
    priority: label,
    priorityScore: score,
    dueISO: iso(due),
    estMinutes: defaults.estDurationsMin.milk,
    details: {
      reason: `Cadence ${cadence}h.`,
      hint: "Sanitize jars; prep strainer & filter.",
      suggestion: "Route to Dairy → yogurt/cheese if surplus.",
    },
    ui: {
      intent: "milk",
      deepLink: { panel: "Animals", tab: "Dairy", id: animal.id },
      followups: [
        { action: "openForm", target: "MilkLog" },
        { action: "openPlanner", target: "DairyBatch" },
      ],
    },
  };
}

/** Egg collection */
function ruleEggCollection(animal, eggCollectionsPerDay, fav = {}, defaults) {
  const isLayer =
    hasAnyTag(animal, ["poultry", "layer", "chicken", "duck"]) ||
    /chicken|duck|turkey|quail/i.test(animal.species || "");
  if (!isLayer) return null;

  const timesPerDay = Math.max(
    1,
    Number(
      fav.eggCollectionsPerDay ??
        eggCollectionsPerDay ??
        defaults.eggCollectionPerDay
    )
  );
  const gapHours = Math.floor(24 / timesPerDay);
  const lastISO = animal.lastEggISO || animal.meta?.lastEggISO || null;
  const last = lastISO ? new Date(lastISO) : addHours(NOW(), -gapHours - 1);
  const nextDue = addHours(last, gapHours);

  if (NOW() < nextDue) return null;

  const { score, label } = priorityScore({ base: 45 });

  return {
    id: `eggs-${animal.id}`,
    sourceId: animal.id,
    source: "animals",
    task: "Collect eggs",
    name: animal.name || "Flock",
    species: animal.species || "poultry",
    priority: label,
    priorityScore: score,
    dueISO: iso(nextDue),
    estMinutes: defaults.estDurationsMin.eggs,
    details: {
      hint: "Check nesting boxes; candle/storage after collection.",
      suggestion: "Consider water-glassing excess clean eggs.",
    },
    ui: {
      intent: "eggs",
      deepLink: { panel: "Animals", tab: "Eggs", id: animal.id },
      followups: [{ action: "openGuide", target: "WaterGlassing" }],
    },
  };
}

/** Breeding checks */
function ruleBreedingCheck(animal, heatCycleDays, defaults) {
  const species = (animal.species || "").toLowerCase();
  const cycleDays = heatCycleDays[species];
  if (!cycleDays) return null;
  if (!hasAnyTag(animal, ["breeding", "doe", "ewe", "cow"])) return null;

  const lastHeatISO = animal.lastHeatISO || animal.meta?.lastHeatISO || null;
  const lastHeat = lastHeatISO
    ? new Date(lastHeatISO)
    : addDays(NOW(), -cycleDays - 1);
  const start = addDays(lastHeat, cycleDays - 2);
  const end = addDays(lastHeat, cycleDays + 2);

  if (NOW() < start) return null;

  const late = NOW() > end ? 5 : 25;
  const { score, label } = priorityScore({ base: 50, bump: late });

  return {
    id: `breed-${animal.id}`,
    sourceId: animal.id,
    source: "animals",
    task: "Check breeding cycle",
    name: animal.name || "Animal",
    species: animal.species || null,
    priority: label,
    priorityScore: score,
    dueISO: iso(start),
    estMinutes: DEFAULTS.estDurationsMin.breedingCheck,
    details: {
      reason: `Heat cycle ~${cycleDays}d; window ${start.toDateString()}–${end.toDateString()}.`,
    },
    ui: {
      intent: "breeding-check",
      deepLink: { panel: "Animals", tab: "Breeding", id: animal.id },
    },
  };
}

/** Processing (on-farm & red-meat processor drop-off) */
function ruleProcessing(
  animal,
  processingWindowDays,
  fastingHoursDefault,
  fav = {},
  defaults
) {
  const ready =
    hasAnyTag(animal, ["butcher-ready", "slaughter"]) ||
    /butcher-ready|slaughter/i.test(animal.stage || "") ||
    animal.meta?.butcherReadyISO;

  if (!ready) return null;

  const startISO =
    animal.meta?.butcherReadyISO ||
    animal.readyISO ||
    animal.meta?.markISO ||
    iso(NOW());
  const baseDue = addDays(
    new Date(startISO),
    processingWindowDays || DEFAULTS.processingWindowDays
  );

  // Processor preference (favorite can override)
  const processorPref =
    fav.processorPref || animal.meta?.processorPref || "on-farm"; // "on-farm" | "state" | "USDA"
  const processorDropoffISO =
    fav.processorDropoffISO || animal.meta?.processorDropoffISO || null;
  const fastingHours =
    fav.fastingHours ??
    animal.meta?.fastingHours ??
    fastingHoursDefault ??
    DEFAULTS.fastingHours;

  const tasks = [];

  // 1) Fasting (feed withdraw) & water
  const fastingStart = addHours(
    new Date(processorDropoffISO || baseDue),
    -fastingHours
  );
  tasks.push({
    id: `fast-${animal.id}`,
    sourceId: animal.id,
    source: "animals",
    task: "Begin pre-slaughter fasting",
    name: animal.name || "Animal",
    species: animal.species || null,
    priority: labelFromScore(70),
    priorityScore: 70,
    dueISO: iso(fastingStart),
    estMinutes: 10,
    details: {
      hint: `Withdraw feed ~${fastingHours}h before processing; provide water as policy allows.`,
    },
    ui: {
      intent: "processing-fast",
      deepLink: { panel: "Animals", tab: "Processing", id: animal.id },
    },
  });

  // 2) Transport or On-farm Setup
  if (processorPref === "on-farm") {
    const setupDue = processorDropoffISO
      ? new Date(processorDropoffISO)
      : baseDue;
    tasks.push({
      id: `setup-${animal.id}`,
      sourceId: animal.id,
      source: "animals",
      task: "On-farm butchery setup",
      name: animal.name || "Animal",
      species: animal.species || null,
      priority: labelFromScore(85),
      priorityScore: 85,
      dueISO: iso(setupDue),
      estMinutes: defaults.estDurationsMin.processingPrep,
      details: {
        hint: "Prep knives, gambrel/winch, chill space, ice, liners. Confirm helpers and PPE.",
        suggestion: "Create cut sheet + preservation runbook.",
      },
      ui: {
        intent: "processing-setup",
        deepLink: { panel: "Animals", tab: "Processing", id: animal.id },
        followups: [
          { action: "openForm", target: "ButcheryCutSheet" },
          { action: "openPlanner", target: "PreservationSuite" },
        ],
      },
    });
  } else {
    const dropISO = processorDropoffISO || iso(baseDue);
    tasks.push({
      id: `drop-${animal.id}`,
      sourceId: animal.id,
      source: "animals",
      task: `Transport & drop-off (${processorPref})`,
      name: animal.name || "Animal",
      species: animal.species || null,
      priority: labelFromScore(88),
      priorityScore: 88,
      dueISO: dropISO,
      estMinutes: defaults.estDurationsMin.transport,
      details: {
        reason: "Processor appointment window.",
        hint: "Trailer check, paperwork, ear tags, water, calm handling.",
        suggestion: "Confirm cut sheet with processor on arrival.",
      },
      ui: {
        intent: "processing-dropoff",
        deepLink: { panel: "Animals", tab: "Processing", id: animal.id },
        followups: [{ action: "openForm", target: "ButcheryCutSheet" }],
      },
    });
  }

  // 3) Processing prep (generic)
  const { score, label } = priorityScore({
    base: 85,
    bump: NOW() > baseDue ? 15 : 0,
  });
  tasks.push({
    id: `process-${animal.id}`,
    sourceId: animal.id,
    source: "animals",
    task: "Prepare for processing",
    name: animal.name || "Animal",
    species: animal.species || null,
    priority: label,
    priorityScore: score,
    dueISO: iso(baseDue),
    estMinutes: defaults.estDurationsMin.processingPrep,
    details: {
      hint: "Confirm chilling, knives, packaging, sanitation plan.",
      suggestion: "Queue curing/canning tasks after butchering.",
      cutSheetDefaults:
        fav.cutSheetDefaults || animal.meta?.cutSheetDefaults || null,
    },
    ui: {
      intent: "processing",
      deepLink: { panel: "Animals", tab: "Processing", id: animal.id },
      followups: [
        { action: "openForm", target: "ButcheryCutSheet" },
        { action: "openPlanner", target: "PreservationSuite" },
      ],
    },
  });

  return tasks;
}

/** General care as fallback */
function ruleGeneralCare(item, defaults) {
  const { score, label } = priorityScore({ base: 15 });
  return {
    id: `care-${item.id}`,
    sourceId: item.id,
    source: hasAnyTag(item, ["animal-feed", "goat-milk"])
      ? "supplies"
      : "animals",
    task: "General care",
    name: item.name,
    species: item.species || item.meta?.species || null,
    priority: label,
    priorityScore: score,
    dueISO: iso(addDays(NOW(), 1)),
    estMinutes: defaults.estDurationsMin.general,
    details: {},
    ui: {
      intent: "care",
      deepLink: { panel: "Animals", tab: "Tasks", id: item.id },
    },
  };
}

/* --------------------------------- Manager --------------------------------- */
const AnimalQueueManager = {
  /**
   * Build actionable queue.
   * @param {Object} opts
   *  - emitEvents?: boolean (default true)
   *  - useFavorites?: boolean (default true)
   *  - includeGeneralCare?: boolean (default true)
   */
  async generateQueue(opts = {}) {
    const {
      emitEvents = true,
      useFavorites = true,
      includeGeneralCare = true,
    } = opts;

    const settings = await loadAnimalSettings();
    const favorites = useFavorites ? await loadFavoriteHints() : {};

    const supplies = await (DexieDB.supplies?.toArray?.() ?? []);
    const animals = await (DexieDB.animals?.toArray?.() ?? []);

    const queue = [];

    // Supply tasks
    for (const s of supplies) {
      const feed = ruleFeedRestock(s, { ...DEFAULTS, ...settings });
      if (feed) {
        queue.push(feed);
        // emit shortage event
        const qty = Number(s.quantity ?? 0);
        const thr = Number(s.threshold ?? 0);
        if (emitEvents && thr > 0 && qty <= thr) {
          const belowRatio = thr ? qty / thr : 0;
          eventBus.emit("inventory.shortage.detected", {
            domain: DOMAIN,
            item: {
              id: s.id,
              name: s.name,
              quantity: qty,
              threshold: thr,
              tags: s.tags || [],
              location: s.location || null,
            },
            belowRatio,
            recommendedAction: "Restock feed",
            recommendedPlot: null,
          });
        }
      }
      // General care for supply (rare, but keeps parity)
      if (includeGeneralCare && !feed) {
        const gc = ruleGeneralCare(s, { ...DEFAULTS, ...settings });
        if (gc) queue.push(gc);
      }
    }

    // Animal tasks
    for (const a of animals) {
      const fav = pickFav(favorites, a);
      const milk = ruleMilkCollection(a, settings.milkCadenceHours, fav, {
        ...DEFAULTS,
        ...settings,
      });
      if (milk) queue.push(milk);

      const eggs = ruleEggCollection(a, settings.eggCollectionPerDay, fav, {
        ...DEFAULTS,
        ...settings,
      });
      if (eggs) queue.push(eggs);

      const breed = ruleBreedingCheck(a, settings.breedHeatCycleDays, {
        ...DEFAULTS,
        ...settings,
      });
      if (breed) queue.push(breed);

      const processing = ruleProcessing(
        a,
        settings.processingWindowDays,
        settings.fastingHours,
        fav,
        {
          ...DEFAULTS,
          ...settings,
        }
      );
      if (Array.isArray(processing)) queue.push(...processing);

      if (
        includeGeneralCare &&
        !milk &&
        !eggs &&
        !breed &&
        !processing?.length
      ) {
        queue.push(ruleGeneralCare(a, { ...DEFAULTS, ...settings }));
      }
    }

    // Sort by priority desc, due asc
    queue.sort((a, b) => {
      if ((b.priorityScore || 0) !== (a.priorityScore || 0))
        return (b.priorityScore || 0) - (a.priorityScore || 0);
      return new Date(a.dueISO || 0) - new Date(b.dueISO || 0);
    });

    // Attach narration/toast
    const enriched = queue.map((e) => ({
      ...e,
      icon: iconForTask(e.task),
      speak: narrationFor(e),
      toast: toastMsg(e),
    }));

    // Bundle prep request for UI/agents
    if (emitEvents && enriched.length) {
      eventBus.emit("prep.tasks.requested", {
        domain: DOMAIN,
        tasks: enriched.map((e) => ({
          id: e.id,
          name: e.name,
          species: e.species,
          task: e.task,
          dueISO: e.dueISO,
          estMinutes: e.estMinutes,
          priority: e.priority,
        })),
        meta: { source: "AnimalQueueManager" },
      });
    }

    return enriched;
  },

  /* -------------------------- UI / Voice convenience ----------------------- */
  async getQueueFormattedForUI(opts = {}) {
    const queue = await this.generateQueue(opts);
    return queue.map((e) => ({
      id: e.id,
      icon: e.icon,
      name: e.name,
      species: e.species,
      task: e.task,
      priority: e.priority,
      priorityScore: e.priorityScore,
      dueISO: e.dueISO,
      estMinutes: e.estMinutes,
      message: `${e.task} — ${e.name}`,
      hint: e.details?.hint || null,
      deepLink: e.ui?.deepLink || null,
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

  async getCalendarEvents(opts = {}) {
    const q = await this.generateQueue(opts);
    return q.map((e) => ({
      id: `${e.id}:${e.dueISO || "soon"}`,
      title: `${e.icon} ${e.task}: ${e.name}`,
      start: e.dueISO || iso(NOW()),
      end: iso(
        addMinutes(new Date(e.dueISO || Date.now()), e.estMinutes || 15)
      ),
      metadata: {
        source: "animal-queue",
        priority: e.priority,
        priorityScore: e.priorityScore,
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
      console.warn("[AnimalQueueManager] calendar write failed:", err);
      return { ok: false, reason: String(err?.message || err) };
    }
  },

  /* ------------------------------ Save flows ------------------------------- */
  /**
   * Save entire animal queue as a plan (or favorite template).
   * @param {Object} options
   *  - title?: string
   *  - favorite?: boolean
   *  - destination?: "router" | "local"
   *  - queueOpts?: options passed to generateQueue
   *  - exportOpts?: forwarded to PlanStorageRouter.save
   *  - templateId?: use AnimalPlanTemplates.get(templateId, options) if available
   */
  async saveQueueAsPlan(options = {}) {
    const {
      title = `Animal Plan — ${new Date().toLocaleDateString()}`,
      favorite = false,
      destination,
      queueOpts = {},
      exportOpts = {},
      templateId,
      templateOptions = {},
    } = options;

    // Optionally seed from a template and then merge generated queue
    let templateItems = [];
    try {
      if (templateId && AnimalPlanTemplates?.get) {
        const t = await AnimalPlanTemplates.get(templateId, templateOptions);
        templateItems = Array.isArray(t?.items) ? t.items : [];
      }
    } catch (err) {
      console.warn("[AnimalQueueManager] template load failed:", err);
    }

    const queue = await this.generateQueue({ ...queueOpts, emitEvents: false });
    const nowISO = iso(NOW());
    const items = [
      ...templateItems,
      ...queue.map((e) => ({
        id: e.id,
        name: e.name,
        species: e.species,
        task: e.task,
        dueISO: e.dueISO,
        estMinutes: e.estMinutes,
        priority: e.priority,
        meta: {
          sourceId: e.sourceId,
          cutSheetDefaults: e.details?.cutSheetDefaults || null,
        },
      })),
    ];

    const plan = {
      id: `animalplan:${nowISO}`,
      domain: DOMAIN,
      title,
      createdAt: nowISO,
      updatedAt: nowISO,
      status: "draft",
      items,
      meta: { generatedBy: "AnimalQueueManager" },
    };

    const tryRouter = async () => {
      if (!PlanStorageRouter?.save) return false;
      try {
        await PlanStorageRouter.save(plan, { favorite, ...exportOpts });
        return true;
      } catch (err) {
        console.warn(
          "[AnimalQueueManager] PlanStorageRouter.save failed:",
          err
        );
        return false;
      }
    };

    const tryLocal = async () => {
      try {
        if (favorite) {
          // Derive reusable hints from plan items (milking windows, processor pref inferred from tasks)
          const hints = items.reduce((acc, it) => {
            const key = (it.name || it.species || "").toLowerCase();
            if (!key) return acc;
            acc[key] = acc[key] || {};
            if (/Collect milk/i.test(it.task))
              acc[key].milkingWindow = acc[key].milkingWindow || {
                start: "06:00",
                end: "08:00",
              };
            if (/Transport & drop-off/i.test(it.task))
              acc[key].processorPref = acc[key].processorPref || "state";
            if (/On-farm butchery setup/i.test(it.task))
              acc[key].processorPref = acc[key].processorPref || "on-farm";
            if (it.meta?.cutSheetDefaults)
              acc[key].cutSheetDefaults = it.meta.cutSheetDefaults;
            return acc;
          }, {});
          const favRow = {
            id: plan.id,
            domain: DOMAIN,
            title: plan.title,
            createdAt: plan.createdAt,
            meta: { hints },
            items,
          };
          await DexieDB.favoritePlans?.put?.(favRow);
        } else {
          await DexieDB.userPlans?.put?.(plan);
        }
        return true;
      } catch (err) {
        console.warn("[AnimalQueueManager] Local plan save failed:", err);
        return false;
      }
    };

    let saved = false;
    if (destination === "router") saved = await tryRouter();
    else if (destination === "local") saved = await tryLocal();
    else saved = (await tryRouter()) || (await tryLocal());

    // Announce for execution UIs
    try {
      eventBus.emit("prep.tasks.requested", {
        domain: DOMAIN,
        tasks: plan.items.map((it) => ({
          id: it.id,
          name: it.name,
          task: it.task,
          dueISO: it.dueISO,
          estMinutes: it.estMinutes,
          priority: it.priority,
        })),
        meta: {
          planId: plan.id,
          title: plan.title,
          source: "AnimalQueueManager.saveQueueAsPlan",
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

    const key = (e.name || e.species || "").toLowerCase() || "animal";
    const when = new Date(e.dueISO || Date.now());
    const favorite = {
      id: `animalfav:${key}:${Date.now()}`,
      domain: DOMAIN,
      title: `Favorite — ${e.name}${titleSuffix ? ` — ${titleSuffix}` : ""}`,
      createdAt: iso(NOW()),
      meta: {
        hints: {
          [key]: {
            // derive simple reusable hints
            milkingWindow: /Collect milk/i.test(e.task)
              ? {
                  start: `${String(when.getHours()).padStart(2, "0")}:${String(
                    when.getMinutes()
                  ).padStart(2, "0")}`,
                  end: `${String(clamp(when.getHours() + 2, 0, 23)).padStart(
                    2,
                    "0"
                  )}:${String(when.getMinutes()).padStart(2, "0")}`,
                }
              : undefined,
            processorPref: /on-farm butchery setup/i.test(e.task)
              ? "on-farm"
              : /drop-off|transport/i.test(e.task)
              ? "state"
              : undefined,
            estMinutesOverride: e.estMinutes,
          },
        },
      },
      items: [
        {
          id: e.id,
          name: e.name,
          species: e.species,
          task: e.task,
          dueISO: e.dueISO,
          estMinutes: e.estMinutes,
          priority: e.priority,
          meta: { cutSheetDefaults: e.details?.cutSheetDefaults || null },
        },
      ],
    };

    try {
      await DexieDB.favoritePlans?.put?.(favorite);
      return { ok: true, favoriteId: favorite.id };
    } catch (err) {
      console.warn("[AnimalQueueManager] saveEntryAsFavorite failed:", err);
      return { ok: false, reason: String(err?.message || err) };
    }
  },
};

export default AnimalQueueManager;
