/**
 * onWorkPlanDraftRequested.js
 *
 * Builds a draft work plan from a selected template (cleaning, garden, barn),
 * hydrates placeholders, merges vocab defaults, enforces guards (quiet hours,
 * PHI/withhold, ventilation re-entry), and returns supply rollups + NBA nudges.
 *
 * Inputs (event payload shape, typical):
 * {
 *   planType: "cleaning" | "garden" | "barn",
 *   templateId?: string,           // optional explicit template $id
 *   startISO: "2025-11-03T00:00:00Z",
 *   endISO?: string,
 *   timezone?: "America/New_York",
 *   householdId?: string,
 *   gardenId?: string,
 *   farmId?: string,
 *   settings?: {
 *     quietHours?: { startHour: number, endHour: number },
 *     phiGuard?: boolean,
 *     withholdGuard?: boolean,
 *     beeSafe?: boolean
 *   },
 *   params?: { [key: string]: string } // placeholder values like BED_TOMATO, etc.
 * }
 */

const fs = require("fs");
const path = require("path");

// ------------------------------- File helpers -------------------------------

function readJSON(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function resolveTemplatePath(planType, explicitId) {
  // Allow explicit $id override if provided
  const base = path.resolve(__dirname, "..", "..", "data", "planning", "templates");
  if (explicitId) {
    // Map common IDs we used in the vocab/templates drops
    const map = {
      "urn:suka:templates:7day_cleaning_reset": "7day_cleaning_reset.json",
      "urn:suka:templates:garden_7day_tasks": "garden_7day_tasks.json",
      "urn:suka:templates:barn_weekly_care": "barn_weekly_care.json"
    };
    const file = map[explicitId];
    if (!file) throw new Error(`Unknown templateId: ${explicitId}`);
    return path.join(base, file);
  }

  const defaults = {
    cleaning: "7day_cleaning_reset.json",
    garden: "garden_7day_tasks.json",
    barn: "barn_weekly_care.json"
  };
  const file = defaults[planType];
  if (!file) throw new Error(`Unknown planType: ${planType}`);
  return path.join(base, file);
}

function loadVocabs(planType) {
  const vocabBase = path.resolve(__dirname, "..", "..", "data", "vocab");

  if (planType === "cleaning") {
    return {
      domain: "cleaning",
      tasks: readJSON(path.join(vocabBase, "cleaning.tasks.json")),
      // zones file can be consulted by your placement rules if needed
      zones: safeRead(path.join(vocabBase, "cleaning.zones.json"))
    };
  }

  if (planType === "garden") {
    return {
      domain: "garden",
      actions: readJSON(path.join(vocabBase, "garden.actions.json")),
      crops: readJSON(path.join(vocabBase, "garden.crops.json"))
    };
  }

  if (planType === "barn") {
    return {
      domain: "animals",
      tasks: readJSON(path.join(vocabBase, "animal.tasks.json")),
      species: readJSON(path.join(vocabBase, "animal.species.json"))
    };
  }

  throw new Error(`Unsupported planType for vocab load: ${planType}`);
}

function safeRead(filePath) {
  try {
    return readJSON(filePath);
  } catch {
    return null;
  }
}

// ----------------------------- Time calculations ----------------------------

function dayOffsetISO(startISO, days) {
  const base = new Date(startISO);
  const dt = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return dt.toISOString().slice(0, 10); // YYYY-MM-DD
}

function replaceDayPlaceholders(str, startISO) {
  // Supports tokens like {{DAY_OFFSET 3 from {{START_ISO}}}}
  if (!str || typeof str !== "string") return str;
  // Replace nested {{START_ISO}}
  const withStart = str.replaceAll("{{START_ISO}}", startISO);

  // Replace {{DAY_OFFSET N from {{START_ISO}}}}
  return withStart.replace(
    /\{\{DAY_OFFSET\s+(-?\d+)\s+from\s+\{\{START_ISO\}\}\}\}/g,
    (_, n) => dayOffsetISO(startISO, Number(n))
  );
}

function replaceAllPlaceholders(obj, startISO, params = {}) {
  const json = JSON.stringify(obj);
  // Replace template-wide placeholders for D1..D7 that already use DAY_OFFSET
  let s = json.replaceAll("{{START_ISO}}", startISO);

  // Replace any remaining DAY_OFFSET occurrences defensive
  s = s.replace(
    /\{\{DAY_OFFSET\s+(-?\d+)\s+from\s+\{\{START_ISO\}\}\}\}/g,
    (_, n) => dayOffsetISO(startISO, Number(n))
  );

  // Replace arbitrary params like {{BED_TOMATO}} etc.
  for (const [key, val] of Object.entries(params)) {
    s = s.replaceAll(`{{${key}}}`, String(val));
  }

  return JSON.parse(s);
}

function withinQuietHours(dateISO, quiet) {
  if (!quiet) return false;
  const d = new Date(dateISO);
  const hour = d.getUTCHours(); // using Z times in templates; adjust if you localize
  // quiet window may cross midnight
  const { startHour, endHour } = quiet;
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  } else {
    // e.g., 21→07
    return hour >= startHour || hour < endHour;
  }
}

function shiftOutOfQuietHours(dateISO, quiet) {
  if (!quiet) return dateISO;
  const d = new Date(dateISO);
  const hour = d.getUTCHours();
  const { startHour, endHour } = quiet;

  if (!withinQuietHours(dateISO, quiet)) return dateISO;

  // push to endHour the same day (UTC) if current hour in quiet window
  const shifted = new Date(d);
  const currentDayStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0));
  let target = new Date(currentDayStart);
  target.setUTCHours(endHour, shifted.getUTCMinutes(), shifted.getUTCSeconds(), 0);

  // If endHour already passed (e.g., it's 23 and end is 7 next day), move to next day endHour
  if (target <= shifted) {
    target = new Date(target.getTime() + 24 * 60 * 60 * 1000);
  }

  return target.toISOString();
}

// ----------------------------- Merging vocab data ----------------------------

function indexById(arr, key = "id") {
  const map = new Map();
  for (const item of arr || []) map.set(item[key], item);
  return map;
}

function mergeTaskWithVocab(task, vocabEntry, domain) {
  if (!vocabEntry) return task;
  const merged = { ...vocabEntry, ...task }; // task wins on conflicts

  // Normalize: we only carry across sensible defaults; avoid clobbering title/id/etc.
  const keep = [
    "id", "title", "kind", "scheduledAt", "durationMin", "zoneId", "bedId", "bedIds",
    "cropSpecies", "species", "optional", "dependencies", "notes", "flags", "planWide"
  ];
  const result = {};
  for (const k of Object.keys(merged)) {
    if (keep.includes(k)) result[k] = merged[k];
  }

  // Merge structural defaults
  if (vocabEntry.tools && !task.tools) result.tools = vocabEntry.tools;
  if (vocabEntry.supplies && !task.supplies) result.supplies = vocabEntry.supplies;
  if (vocabEntry.ppe && !task.ppe) result.ppe = vocabEntry.ppe;

  // Safety/time
  if (vocabEntry.dwellTimeMin && !task.dwellTimeMin) result.dwellTimeMin = vocabEntry.dwellTimeMin;
  if (vocabEntry.ventilation && !task.ventilation) result.ventilation = vocabEntry.ventilation;

  // Garden action-specific
  if (domain === "garden") {
    if (vocabEntry.phiDays && !task.phiDays) result.phiDays = vocabEntry.phiDays;
    if (vocabEntry.irrigation && !task.irrigation) result.irrigation = vocabEntry.irrigation;
  }

  // Animal task-specific (resources/withhold defaults)
  if (domain === "animals") {
    if (vocabEntry.resources && !task.resources) result.resources = vocabEntry.resources;
    if (vocabEntry.defaultWithhold && !task.withhold) result.withhold = vocabEntry.defaultWithhold;
  }

  // Cleaning quiet/sound hints
  if (domain === "cleaning") {
    if (typeof vocabEntry.noise === "number" && task.quietHoursSensitive == null) {
      result.quietHoursSensitive = vocabEntry.noise > 0;
    }
  }

  return result;
}

// ----------------------------- Guards & holds --------------------------------

function applyVentilationHold(task) {
  if (!task.ventilation || !task.ventilation.required || !task.scheduledAt) return null;
  const offsetMin = Number(task.ventilation.reentryOffsetMin || 0);
  const start = new Date(task.scheduledAt);
  const end = new Date(start.getTime() + (Number(task.durationMin || 0) * 60000));
  const reentry = new Date(end.getTime() + offsetMin * 60000).toISOString();
  task.reentryAt = reentry;
  return { type: "reentry_hold", taskId: task.id, until: reentry, label: "Ventilation re-entry hold" };
}

function applyPHIHold(task) {
  if (!task.phiDays || !task.scheduledAt) return null;
  const start = new Date(task.scheduledAt);
  const until = new Date(start.getTime() + Number(task.phiDays) * 24 * 60 * 60 * 1000).toISOString();
  return { type: "phi_hold", taskId: task.id, until, days: task.phiDays, label: `Harvest hold (${task.phiDays}d PHI)` };
}

function applyWithhold(task) {
  // For animal tasks that set withhold (e.g., deworm), elevate to concrete until date when scheduled.
  if (!task.withhold || !task.scheduledAt) return null;
  const { days, product } = task.withhold;
  if (!days || !product) return null;
  const until = new Date(new Date(task.scheduledAt).getTime() + Number(days) * 86400000).toISOString();
  task.withhold.until = until;
  return { type: "withhold", taskId: task.id, until, product, days, label: `Withhold ${product} until ${until}` };
}

function shiftQuietHoursIfNeeded(task, quiet) {
  if (!task.scheduledAt || !quiet) return null;
  // Trigger shift if task is noisy OR task.quietHoursSensitive is true
  const isSensitive = task.quietHoursSensitive === true || ["vacuum", "laundry"].includes(task.kind);
  if (!isSensitive) return null;
  if (!withinQuietHours(task.scheduledAt, quiet)) return null;

  const original = task.scheduledAt;
  const shifted = shiftOutOfQuietHours(original, quiet);
  task.scheduledAt = shifted;
  return { type: "quiet_shift", taskId: task.id, from: original, to: shifted, label: "Moved out of quiet hours" };
}

// ------------------------------- Supply rollups ------------------------------

function rollupSupplies(tasks) {
  const map = new Map(); // key: supply name
  for (const t of tasks) {
    for (const s of t.supplies || []) {
      const key = s.name;
      if (!key) continue;
      if (!map.has(key)) map.set(key, { name: key, count: 0, examples: new Set() });
      const entry = map.get(key);
      entry.count += 1; // heuristically count uses; amounts vary
      if (s.amount) entry.examples.add(s.amount);
    }
  }
  return Array.from(map.values()).map(e => ({
    name: e.name,
    uses: e.count,
    amountExamples: Array.from(e.examples)
  }));
}

// --------------------------------- Nudges ------------------------------------

function buildNBA(tasks, guards) {
  const nudges = [];

  // Quiet-hours shifts
  for (const g of guards.filter(g => g?.type === "quiet_shift")) {
    nudges.push({ code: "avoid_quiet_hours", severity: "info", taskId: g.taskId, label: "Rescheduled to avoid quiet hours" });
  }

  // PHI holds
  for (const g of guards.filter(g => g?.type === "phi_hold")) {
    nudges.push({ code: "phi_guard", severity: "warn", taskId: g.taskId, label: `Harvest locked for ${g.days} days` });
  }

  // Ventilation
  for (const g of guards.filter(g => g?.type === "reentry_hold")) {
    nudges.push({ code: "ensure_ventilation", severity: "warn", taskId: g.taskId, label: "Area locked until re-entry time" });
  }

  // Withhold
  for (const g of guards.filter(g => g?.type === "withhold")) {
    nudges.push({ code: "check_withholds", severity: "warn", taskId: g.taskId, label: `Withhold active until ${g.until}` });
  }

  // Sequencing hints (lightweight)
  const kitchenChain = sequencePresent(tasks, ["dishes", "maintenance", "sanitize", "vacuum", "mop"]);
  if (kitchenChain) nudges.push({ code: "sequence_ok", severity: "info", label: "Kitchen chain sequenced correctly" });

  return nudges;
}

function sequencePresent(tasks, kinds) {
  const present = kinds.map(k => tasks.findIndex(t => t.kind === k)).filter(i => i >= 0);
  if (present.length < kinds.length) return false;
  // ensure ordering is ascending
  return present.every((v, i, arr) => i === 0 || v > arr[i - 1]);
}

// ------------------------------ Main entry point -----------------------------

/**
 * Builds and returns:
 * {
 *   draft: <hydrated plan object>,
 *   supplies: <rollup[]>,
 *   guards: <applied holds/shifts>,
 *   nudges: <NBA[]>
 * }
 */
async function onWorkPlanDraftRequested(event) {
  const {
    planType,
    templateId,
    startISO,
    endISO,
    timezone,
    householdId,
    gardenId,
    farmId,
    settings = {},
    params = {}
  } = event || {};

  if (!planType) throw new Error("planType is required");
  if (!startISO) throw new Error("startISO is required");

  // 1) Load template + vocabs
  const templatePath = resolveTemplatePath(planType, templateId);
  const template = readJSON(templatePath);
  const vocabs = loadVocabs(planType);

  // 2) Hydrate top-level IDs if caller provided
  if (householdId) template.householdId = householdId;
  if (gardenId) template.gardenId = gardenId;
  if (farmId) template.farmId = farmId;

  // 3) Compute default end if missing
  const finalEndISO =
    endISO ||
    new Date(new Date(startISO).getTime() + 6 * 86400000).toISOString();

  template.period = { start: startISO, end: finalEndISO };

  // 4) Replace placeholders (START_ISO, DAY_OFFSET, custom params like BED_TOMATO)
  let hydrated = replaceAllPlaceholders(template, startISO, params);

  // 5) Expand vocab refs into task defaults
  let tasks = hydrated.tasks || [];
  const guards = [];

  if (planType === "garden") {
    const idxActions = indexById(vocabs.actions.actions || [], "id");
    tasks = tasks.map(task => {
      const ref = task.vocabActionId ? idxActions.get(task.vocabActionId) : null;
      const merged = mergeTaskWithVocab(task, ref, "garden");
      return merged;
    });
  } else if (planType === "barn") {
    const idxTasks = indexById(vocabs.tasks.tasks || [], "id");
    tasks = tasks.map(task => {
      const ref = task.vocabTaskId ? idxTasks.get(task.vocabTaskId) : null;
      return mergeTaskWithVocab(task, ref, "animals");
    });
  } else if (planType === "cleaning") {
    const idxTasks = indexById(vocabs.tasks.tasks || [], "id");
    tasks = tasks.map(task => {
      // try to match by kind first, else by explicit vocabTaskId if present
      const byKind = Array.from(idxTasks.values()).find(v => v.kind === task.kind);
      const ref = task.vocabTaskId ? idxTasks.get(task.vocabTaskId) : byKind;
      return mergeTaskWithVocab(task, ref, "cleaning");
    });
  }

  // 6) Enforce safety & etiquette guards
  const qh = settings.quietHours || hydrated.settings?.quietHours;
  const phiGuard = settings.phiGuard ?? hydrated.settings?.phiGuard ?? (planType === "garden");
  const withholdGuard = settings.withholdGuard ?? hydrated.settings?.withholdGuard ?? (planType === "barn");

  for (const t of tasks) {
    // Quiet hours
    const shift = shiftQuietHoursIfNeeded(t, qh);
    if (shift) guards.push(shift);

    // Ventilation re-entry holds
    const hold = applyVentilationHold(t);
    if (hold) guards.push(hold);

    // PHI
    if (phiGuard && t.kind === "pesticide") {
      const phi = applyPHIHold(t);
      if (phi) guards.push(phi);
    }

    // Withhold
    if (withholdGuard && t.withhold) {
      const wh = applyWithhold(t);
      if (wh) guards.push(wh);
    }
  }

  // 7) Reassign back to hydrated plan
  hydrated.tasks = tasks;

  // 8) Supplies rollup
  const supplies = rollupSupplies(tasks);

  // 9) NBA nudges
  const nudges = buildNBA(tasks, guards);

  // 10) Return result
  return {
    ok: true,
    draft: hydrated,
    supplies,
    guards,
    nudges,
    meta: {
      templatePath,
      planType,
      generatedAt: new Date().toISOString()
    }
  };
}

module.exports = {
  onWorkPlanDraftRequested
};
