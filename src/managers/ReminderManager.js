// src/managers/ReminderManager.js
// -------------------------------------------------------------
// Dynamic, defensive reminder facade.
// - Integrates Inventory, Cooking, Cleaning, Garden, and Animal.
// - Optional dynamic imports (no hard crash if modules missing).
// - Priority scores, due timestamps, deep links, speech/toast strings.
// - Stable array identities per type; dedupe + sorting.
// - Sabbath/sunset-aware nudge stays, but we’ll prefer real plan windows.
// -------------------------------------------------------------

/* ----------------------------- Utilities ----------------------------- */
const _now = () => new Date();
const _nowISO = () => _now().toISOString();

const STABLE_EMPTY = [];             // shared identity for "no items"
const STABLE_BY_TYPE = new Map();    // type => stable empty array

const hasWindow = () => typeof window !== "undefined";

function ensureStable(type, list) {
  if (Array.isArray(list) && list.length) return list;
  if (!STABLE_BY_TYPE.has(type)) STABLE_BY_TYPE.set(type, []);
  return STABLE_BY_TYPE.get(type);
}

// Vite-friendly dynamic import
async function tryImport(path) {
  try {
    // eslint-disable-next-line no-undef
    return await import(/* @vite-ignore */ path);
  } catch (_) {
    return null;
  }
}

const ICONS = {
  inventory: "📦",
  cooking: "🍳",
  cleaning: "🧼",
  garden: "🌿",
  animal: "🐄",
  system: "🧠",
};

function toScore(label = "low", fallback = 10) {
  switch (label) {
    case "urgent": return 95;
    case "high":   return 70;
    case "medium": return 40;
    case "low":    return 15;
    default:       return fallback;
  }
}

function normalizeReminder({
  id,
  type = "system",
  icon,
  message,
  speak,
  priority = "low",
  priorityScore,
  dueISO = null,
  deepLink = null,
  meta = {},
}) {
  return {
    id: id || `${type}-${_nowISO()}`,
    type,
    icon: icon || ICONS[type] || ICONS.system,
    message: message || "Reminder",
    speak: speak || message || "",
    priority,
    priorityScore: Number.isFinite(priorityScore) ? priorityScore : toScore(priority),
    dueISO,
    deepLink,
    meta,
  };
}

function sortReminders(list) {
  return [...list].sort((a, b) => {
    // higher score first
    if ((b.priorityScore || 0) !== (a.priorityScore || 0)) {
      return (b.priorityScore || 0) - (a.priorityScore || 0);
    }
    // earlier due first
    if (a.dueISO || b.dueISO) {
      return new Date(a.dueISO || 8640000000000000) - new Date(b.dueISO || 8640000000000000);
    }
    // fallback: message alpha
    return String(a.message).localeCompare(String(b.message));
  });
}

function dedupeById(list) {
  const seen = new Set();
  const out = [];
  for (const r of list) {
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
  }
  return out;
}

/* --------------------------- Sabbath Awareness ------------------------ */
/** Very light sunset-aware hint with optional prefs table. */
async function isSabbathAware() {
  try {
    const db = (await tryImport("../db"))?.default;
    if (db?.settings) {
      const row = await db.settings.get("calendar.sabbathAware");
      return !!(row?.value);
    }
  } catch (_) {}
  return false;
}

/* ------------------------ Inventory Reminders ------------------------- */
/**
 * Uses InventoryMonitor.generateSystemAlerts() (new richer data) when available.
 * Falls back to empty lists if the monitor isn't present.
 */
export async function getInventoryReminders() {
  const invMod = await tryImport("./InventoryMonitor");
  let lowStock = STABLE_EMPTY;
  let autoRestock = STABLE_EMPTY;

  if (invMod?.default?.generateSystemAlerts || invMod?.generateSystemAlerts) {
    try {
      const monitor = invMod.default ?? invMod;
      const { lowStock: ls = STABLE_EMPTY, autoRestock: ar = STABLE_EMPTY } = await monitor.generateSystemAlerts();
      lowStock = ls ?? STABLE_EMPTY;
      autoRestock = ar ?? STABLE_EMPTY;
    } catch (_) {}
  }

  const reminders = [];

  // 🔔 Restock Reminders (now due-aware / deepLink-aware if provided by monitor)
  for (const item of lowStock) {
    if (!item) continue;
    const msg = `Restock: ${item.name} is below threshold (${item.quantity}/${item.threshold}${item.unit ? " " + item.unit : ""})${item.location ? ` — ${item.location}` : ""}`;
    reminders.push(
      normalizeReminder({
        id: `inv-restock-${item.id || item.name}`,
        type: "inventory",
        icon: ICONS.inventory,
        message: `🔁 ${msg}`,
        speak: item.speak || `Inventory alert: ${item.name} is low.`,
        priority: item.priority || "high",
        priorityScore: item.priorityScore ?? toScore(item.priority || "high", 65),
        dueISO: item.dueISO || null,
        deepLink: item.deepLink || null,
        meta: { kind: "restock", item },
      })
    );
  }

  // 📦 Auto-Restock Suggestions
  for (const item of autoRestock) {
    if (!item) continue;
    const amount = (item.amountNeeded ?? null) != null ? `+${item.amountNeeded}` : null;
    const line = [item.name, amount, item.unit].filter(Boolean).join(" ");
    reminders.push(
      normalizeReminder({
        id: `inv-auto-${item.id || item.name}`,
        type: "inventory",
        icon: ICONS.inventory,
        message: `🧠 Auto-restock suggestion: ${line}`,
        speak: `Auto restock suggestion: ${item.name}.`,
        priority: "medium",
        priorityScore: 45,
        dueISO: null,
        deepLink: item.deepLink || null,
        meta: { kind: "autoRestock", item },
      })
    );
  }

  return ensureStable("inventory", sortReminders(dedupeById(reminders)));
}

/* -------------------------- Cooking Reminders ------------------------- */
/**
 * Live cooking signals:
 * - If CookingPlanManager has active/scheduled sessions, surface resume/starts soon
 * - If any recipes are selected (store), nudge to plan prep windows
 * - Sabbath/sunset-aware back-scheduling hint (lightweight)
 */
export async function getCookingReminders() {
  const reminders = [];

  // 1) Sessions from CookingPlanManager (defensive)
  try {
    const cpm = (await tryImport("./CookingPlanManager"))?.default;
    if (cpm?.loadCookingPlans) {
      const plans = await cpm.loadCookingPlans();
      const active = plans.filter((p) => p.status === "active");
      const scheduled = plans.filter((p) => p.status === "scheduled");

      // Active → Resume
      for (const p of active) {
        reminders.push(
          normalizeReminder({
            id: `cook-resume-${p.id}`,
            type: "cooking",
            icon: ICONS.cooking,
            message: `▶️ Resume: ${p.title}`,
            speak: `Cooking session active. Resume ${p.title}.`,
            priority: "high",
            priorityScore: 70,
            dueISO: p.session?.startISO || null,
            deepLink: { panel: "Cooking", tab: "Session", id: p.id },
            meta: { kind: "session-active", plan: p },
          })
        );
      }

      // Scheduled → Starts soon (<= 2h)
      const soonWindowMs = 2 * 60 * 60 * 1000;
      for (const p of scheduled) {
        const start = p.session?.startISO ? new Date(p.session.startISO).getTime() : null;
        if (start && start - Date.now() <= soonWindowMs) {
          reminders.push(
            normalizeReminder({
              id: `cook-start-${p.id}`,
              type: "cooking",
              icon: ICONS.cooking,
              message: `⏰ Starts soon: ${p.title}`,
              speak: `${p.title} starts soon.`,
              priority: "medium",
              priorityScore: 55,
              dueISO: p.session.startISO,
              deepLink: { panel: "Cooking", tab: "Planner", id: p.id },
              meta: { kind: "session-soon", plan: p },
            })
          );
        }
      }
    }
  } catch (_) {}

  // 2) Selected recipes (optional store)
  try {
    const recipeStore = await tryImport("@/store/RecipeStore");
    const useRecipeStore = recipeStore?.default;
    if (typeof useRecipeStore === "function") {
      const state = useRecipeStore.getState?.();
      const hasSelected = !!state?.recipes?.some?.((r) => r?.isSelected);
      if (hasSelected) {
        reminders.push(
          normalizeReminder({
            id: "cook-batch-selected",
            type: "cooking",
            icon: ICONS.cooking,
            message: "🍳 You have recipes selected for batch cooking. Plan prep windows?",
            speak: "You have recipes selected for batch cooking. Plan prep windows?",
            priority: "medium",
            priorityScore: 45,
            meta: { kind: "batchSelected" },
          })
        );
      }
    }
  } catch (_) {}

  // 3) Sabbath-aware nudge
  if (await isSabbathAware()) {
    reminders.push(
      normalizeReminder({
        id: "cook-sabbath-nudge",
        type: "cooking",
        icon: ICONS.cooking,
        message: "🕯️ Sunset-aware prep: consider back-scheduling finish times for tonight.",
        speak: "Sunset-aware prep reminder. Consider back-scheduling your finish times for tonight.",
        priority: "low",
        priorityScore: 20,
        meta: { kind: "sunsetAware" },
      })
    );
  }

  return ensureStable("cooking", sortReminders(dedupeById(reminders)));
}

/* ------------------------- Cleaning Reminders ------------------------- */
/** Surfaces cleaning rotations and due plan occurrences if CleaningPlanManager exists. */
export async function getCleaningReminders() {
  const reminders = [];

  // Plan occurrences (defensive)
  try {
    const cpm = (await tryImport("./CleaningPlanManager"))?.default;
    if (cpm?.getDuePlans) {
      const events = await cpm.getDuePlans({}); // default next 7d in the upgraded manager
      for (const e of events.slice(0, 6)) {
        const firstTask = (e.tasks || [])[0];
        reminders.push(
          normalizeReminder({
            id: `clean-plan-${e.planId}:${e.when}`,
            type: "cleaning",
            icon: ICONS.cleaning,
            message: `🧼 ${e.title} — ${(firstTask?.name || "Tasks")} due`,
            speak: `Cleaning plan due: ${e.title}.`,
            priority: "medium",
            priorityScore: 40,
            dueISO: e.when,
            deepLink: { panel: "Cleaning", tab: "Plans", id: e.planId },
            meta: { kind: "plan", event: e },
          })
        );
      }
    }
  } catch (_) {}

  // Lightweight weekly rotation nudge (always present)
  reminders.push(
    normalizeReminder({
      id: "clean-weekly-rotation",
      type: "cleaning",
      icon: ICONS.cleaning,
      message: "🧽 Weekly rotation: pick a room to quick tidy and sanitize surfaces.",
      speak: "Weekly cleaning rotation reminder. Pick a room to quick tidy and sanitize surfaces.",
      priority: "low",
      priorityScore: 18,
      meta: { kind: "weeklyRotation" },
    })
  );

  return ensureStable("cleaning", sortReminders(dedupeById(reminders)));
}

/* -------------------------- Garden Reminders -------------------------- */
/** Uses InventoryMonitor or GardenQueueManager when present to surface due planting/support tasks. */
export async function getGardenReminders() {
  const reminders = [];

  // Prefer the dedicated GardenQueueManager if available
  let entries = null;
  try {
    const gqm = (await tryImport("./GardenQueueManager"))?.default;
    if (gqm?.generateQueue) {
      entries = await gqm.generateQueue();
    }
  } catch (_) {}

  // Otherwise, pull suggestions via InventoryMonitor
  if (!entries) {
    const invMod = await tryImport("./InventoryMonitor");
    try {
      const monitor = invMod?.default ?? invMod;
      const { gardenQueue = STABLE_EMPTY } = (await monitor?.generateSystemAlerts?.()) || {};
      entries =
        gardenQueue?.map?.((g) => ({ name: g.name, task: "Plan planting", priority: "medium" })) ||
        STABLE_EMPTY;
    } catch (_) {}
  }

  for (const e of entries || STABLE_EMPTY) {
    reminders.push(
      normalizeReminder({
        id: `garden-${e.id || e.name}`,
        type: "garden",
        icon: ICONS.garden,
        message: `${e.task ? "🌱 " + e.task : "🌱 Plan Garden"} — ${e.name}${e.recommendedPlot ? ` (${e.recommendedPlot})` : ""}`,
        speak: e.speak || `Garden task: ${e.task || "plan"} ${e.name}.`,
        priority: e.priority || "medium",
        priorityScore: e.priorityScore ?? toScore(e.priority || "medium", 35),
        dueISO: e.dueISO || null,
        deepLink: e.ui?.deepLink || { panel: "Garden", tab: "Planner", id: e.id },
        meta: { kind: "garden", entry: e },
      })
    );
  }

  // Generic harvest/preservation sync nudge (always safe)
  reminders.push(
    normalizeReminder({
      id: "garden-harvest-preserve",
      type: "garden",
      icon: ICONS.garden,
      message: "🥫 Check upcoming harvests and schedule preservation to avoid waste.",
      speak: "Check upcoming harvests and schedule preservation tasks to avoid waste.",
      priority: "low",
      priorityScore: 16,
      meta: { kind: "harvestPreservationSync" },
    })
  );

  return ensureStable("garden", sortReminders(dedupeById(reminders)));
}

/* -------------------------- Animal Reminders -------------------------- */
/** Use AnimalQueueManager if present; fallback to stable empty. */
export async function getAnimalReminders() {
  try {
    const aqm = (await tryImport("./AnimalQueueManager"))?.default;
    if (aqm?.generateQueue) {
      const entries = await aqm.generateQueue();
      const list = entries.map((e) =>
        normalizeReminder({
          id: `animal-${e.id}`,
          type: "animal",
          icon: ICONS.animal,
          message: `${e.task === "General care" ? "🐾 " : ""}${e.task} — ${e.name}`,
          speak: e.speak || `Animal task: ${e.task} for ${e.name}.`,
          priority: e.priority || "low",
          priorityScore: e.priorityScore ?? toScore(e.priority || "low", 20),
          dueISO: e.dueISO || null,
          deepLink: e.ui?.deepLink || { panel: "Animals", tab: "Tasks", id: e.id },
          meta: { kind: "animal", entry: e },
        })
      );
      return ensureStable("animal", sortReminders(dedupeById(list)));
    }
  } catch (_) {}
  return ensureStable("animal", STABLE_EMPTY);
}

export async function getAnimalInlineReminders() {
  return ensureStable("animal-inline", STABLE_EMPTY);
}
export async function createAnimalReminder(reminder) {
  return { ...reminder, id: reminder?.id ?? `animal-${_nowISO()}` };
}
export async function deleteAnimalReminder(id) {
  return { ok: true, id };
}

/* --------------------------- Aggregated APIs -------------------------- */
export async function getActiveReminders() {
  const [inv, cook, clean, garden, animal] = await Promise.all([
    getInventoryReminders(),
    getCookingReminders(),
    getCleaningReminders(),
    getGardenReminders(),
    getAnimalReminders(),
  ]);

  const all = dedupeById(
    sortReminders([...(inv || []), ...(cook || []), ...(clean || []), ...(garden || []), ...(animal || [])])
  );

  return all.length ? all : STABLE_EMPTY;
}

export async function getRemindersByType(type) {
  const all = await getActiveReminders();
  if (!type || all === STABLE_EMPTY) return all;
  const filtered = all.filter((r) => r?.type === type);
  return filtered.length ? filtered : ensureStable(`filter-${type}`, STABLE_EMPTY);
}

/** Format for UI tiles/panels (keeps old shape + adds due/deepLink if you want it). */
export async function getFormattedForUI() {
  const all = await getActiveReminders();
  if (all === STABLE_EMPTY) return STABLE_EMPTY;

  const formatted = all.map((r) => ({
    icon: r.icon ?? (ICONS[r.type] || ICONS.system),
    message: r.message,
    priority: r.priority ?? "low",
    type: r.type ?? "system",
    id: r.id ?? `${r.type || "sys"}-${_nowISO()}`,
    dueISO: r.dueISO || null,
    deepLink: r.deepLink || null,
  }));

  return formatted.length ? formatted : STABLE_EMPTY;
}

/** Speech-friendly list. */
export async function getSpeechAlerts() {
  const all = await getActiveReminders();
  if (all === STABLE_EMPTY) return STABLE_EMPTY;
  const speech = all.map((r) => r?.speak).filter(Boolean);
  return speech.length ? speech : STABLE_EMPTY;
}

/* ----------------------------- Default Obj ---------------------------- */
const ReminderManager = {
  // Domain-specific
  getInventoryReminders,
  getCookingReminders,
  getCleaningReminders,
  getGardenReminders,
  getAnimalReminders,
  getAnimalInlineReminders,
  createAnimalReminder,
  deleteAnimalReminder,

  // Aggregates
  getActiveReminders,
  getRemindersByType,
  getFormattedForUI,
  getSpeechAlerts,
};

export default ReminderManager;
