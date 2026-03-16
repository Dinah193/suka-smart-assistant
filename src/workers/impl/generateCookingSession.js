// src/workers/impl/generateCookingSession.js
// Dynamic cooking session generator for Suka Smart Assistant
// - Consolidates recipes from MealPlan or selected IDs
// - Integrated Task Parser merges cross-recipe prep (chop onions once, etc.)
// - Multi-timers with dependencies + voice-alert hints
// - Stations plan (Prep, Stove, Oven, Canning, Dehydrate, Labeling)
// - Inventory & tools pull with resupply list; optional auto-sync hints
// - Specialty tracks: pressure canning, sausage, dehydrating, winemaking
// - Rhythm-aware (meal windows, intermittent fasting)
// - Optional Sabbath-sunset awareness for session cutoffs
// - Emits rich, editable draft for SessionDraftDetail modal
// - CalendarSync ONLY after approval (handled by main thread)

/* --------------------------------- Guards ---------------------------------- */
const IS_BROWSER = typeof self !== "undefined";

/* --------------------------------- Utils ----------------------------------- */
const uid = (p = "cook") =>
  `${p}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const toISO = (d) => (d ? new Date(d).toISOString() : null);
const minutes = (n) => n * 60 * 1000;

const deepClone = (obj) => {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return obj;
  }
};

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/* ---------------------------- Lazy/Dynamic Imports -------------------------- */
async function lazyImports() {
  const out = {};
  try {
    out.RecipeStore = (
      await import(/* @vite-ignore */ "@/store/RecipeStore.js")
    ).default;
  } catch {}
  try {
    out.MealPlanStore = (
      await import(/* @vite-ignore */ "@/store/MealPlanStore.js")
    ).default;
  } catch {}
  try {
    out.InventoryStore = (
      await import(/* @vite-ignore */ "@/store/InventoryStore.js")
    ).default;
  } catch {}
  try {
    out.IngredientsIndex = (
      await import(/* @vite-ignore */ "@/store/IngredientsIndex.js")
    ).default;
  } catch {}
  try {
    out.CookingStore = (
      await import(/* @vite-ignore */ "@/store/CookingStore.js")
    ).default;
  } catch {}
  try {
    out.EventBus = (
      await import(/* @vite-ignore */ "@/services/events/eventBus.js")
    ).default;
  } catch {}
  try {
    out.CalendarUtils = await import(/* @vite-ignore */ "@/utils/timeUtils.js");
  } catch {}
  try {
    out.SabbathTemplate = await import(
      /* @vite-ignore */ "@/services/templates/sabbathSunsetAwareMealPrep.js"
    );
  } catch {}
  // Optional agents (used if present)
  try {
    out.recipeConsolidator = (
      await import(
        /* @vite-ignore */ "@/agents/shims/recipeConsolidatorShim.js"
      )
    )?.default;
  } catch {}
  try {
    out.batchCookingAgent = (
      await import(/* @vite-ignore */ "@/agents/shims/batchCookingShim.js")
    )?.default;
  } catch {}
  return out;
}

/* ------------------------------- Rhythm Helpers ----------------------------- */
/**
 * rhythm example:
 *   {
 *     type: "time-restricted", // "alternate-day" | "custom"
 *     windows: [{ start: "11:30", end: "19:30" }],
 *     fastingPattern: "16:8" // optional label
 *   }
 */
function isWithinMealWindow(rhythm, when = new Date()) {
  if (!rhythm || !Array.isArray(rhythm.windows) || !rhythm.windows.length)
    return true;
  const hhmm = (d) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(
      2,
      "0"
    )}`;
  const now = hhmm(when);
  return rhythm.windows.some((w) => {
    const s = w.start,
      e = w.end;
    return s <= now && now <= e;
  });
}

function nextMealWindowStart(rhythm, ref = new Date()) {
  if (!rhythm || !Array.isArray(rhythm.windows) || !rhythm.windows.length)
    return null;
  const today = new Date(ref);
  const toDate = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date(today);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const nowMs = today.getTime();
  const candidates = rhythm.windows
    .map((w) => toDate(w.start))
    .map((d) =>
      d.getTime() < nowMs ? new Date(d.getTime() + 24 * 3600 * 1000) : d
    )
    .sort((a, b) => a.getTime() - b.getTime());
  return candidates[0] || null;
}

/* ------------------------------ Inventory Pulls ----------------------------- */
function computeInventoryNeeds(inventoryStore, recipeItems) {
  // recipeItems: [{ key, qty, unit, label, category }]
  const pulls = [];
  const missing = [];
  let score = 1;

  recipeItems.forEach((it) => {
    const have = inventoryStore?.getQuantity
      ? inventoryStore.getQuantity(it.key) ?? 0
      : 0;
    const need = it.qty ?? 0;
    const delta = have - need;
    const rec = {
      key: it.key,
      label: it.label || it.key,
      need,
      have,
      unit: it.unit || "",
      category: it.category || "general",
      short: delta < 0 ? Math.abs(delta) : 0,
    };
    if (rec.short > 0) missing.push(rec);
    else pulls.push({ ...rec, pullQty: need });
  });

  const total = recipeItems.length || 1;
  const ok = total - missing.length;
  score = clamp(ok / total, 0, 1);

  return { pulls, missing, stockScore: score };
}

/* ----------------------- Integrated Task Parser (ITP) ----------------------- */
function normalizeStep(s) {
  return {
    id: uid("step"),
    label: s.label || s.title || "Step",
    estMin: s.estMin ?? s.estimate ?? 3,
    timer: s.timer ?? null, // seconds
    heat: s.heat ?? null, // "low" | "med" | "high" | temp number
    station: s.station ?? null, // "Stove" | "Oven" | "Prep" | "Canning" | ...
    tools: s.tools ?? [],
    hazards: s.hazards ?? [],
    dependsOn: s.dependsOn ?? [], // array of step ids
    done: false,
  };
}

/**
 * Merge common prep across recipes: group by (technique + ingredient)
 * Technique inference is simple heuristic based on step labels.
 */
function integrateTasks(recipes) {
  const all = [];
  recipes.forEach((r) => {
    (r.steps || []).forEach((s) => {
      const ns = normalizeStep(s);
      ns.recipeId = r.id;
      ns.recipeName = r.name;
      all.push(ns);
    });
  });

  // Group "prep" tasks by keyword
  const prepMap = new Map();
  const prepRegex =
    /(chop|dice|mince|slice|julienne|peel|wash|rinse|measure|mix|whisk|marinate)/i;

  const getKey = (label) => {
    const low = label.toLowerCase();
    const match = low.match(prepRegex)?.[1] || "prep";
    // crude ingredient token pick: first noun-like word
    const token = low.split(/\s+/).find((w) => w.length > 3) || "misc";
    return `${match}:${token}`;
  };

  const merged = [];
  const keep = [];

  for (const st of all) {
    if (prepRegex.test(st.label)) {
      const key = getKey(st.label);
      const bucket = prepMap.get(key) || {
        id: uid("prep"),
        label: st.label,
        members: [],
        estMin: 0,
        tools: new Set(),
        hazards: new Set(),
      };
      bucket.members.push(st);
      bucket.estMin += st.estMin || 2;
      st.tools?.forEach((t) => bucket.tools.add(t));
      st.hazards?.forEach((h) => bucket.hazards.add(h));
      prepMap.set(key, bucket);
    } else {
      keep.push(st);
    }
  }

  for (const [, b] of prepMap) {
    merged.push({
      id: b.id,
      label: `Prep: ${b.members
        .map((m) => m.label)
        .join(" + ")
        .slice(0, 120)}`,
      estMin: Math.ceil(b.estMin * 0.65), // merging saves time
      timer: null,
      heat: null,
      station: "Prep",
      tools: Array.from(b.tools),
      hazards: Array.from(b.hazards),
      dependsOn: [],
      done: false,
      mergedFrom: b.members.map((m) => m.id),
    });
  }

  return { integrated: merged.concat(keep), original: all };
}

/* ------------------------------- Stations Plan ------------------------------ */
function buildStations(recipes) {
  // Base stations; will be filtered if unused
  const base = [
    {
      key: "Prep",
      label: "Prep Station",
      surfaces: ["counter"],
      tools: ["cutting board", "chef knife", "bowls"],
    },
    {
      key: "Stove",
      label: "Stove / Range",
      surfaces: [],
      tools: ["skillet", "saucepan"],
    },
    {
      key: "Oven",
      label: "Oven / Bake",
      surfaces: [],
      tools: ["sheet pan", "dutch oven"],
    },
    {
      key: "Canning",
      label: "Pressure Canning",
      surfaces: [],
      tools: ["pressure canner", "jar lifter", "rings/lids"],
    },
    {
      key: "Dehydrate",
      label: "Dehydrating",
      surfaces: [],
      tools: ["dehydrator", "trays"],
    },
    {
      key: "Label",
      label: "Labeling & Storage",
      surfaces: [],
      tools: ["labels", "marker"],
    },
  ];

  const needed = new Set(["Prep"]);
  recipes.forEach((r) => {
    (r.steps || []).forEach((s) => {
      const lab = (s.label || "").toLowerCase();
      if (lab.includes("bake") || lab.includes("oven")) needed.add("Oven");
      if (
        lab.includes("simmer") ||
        lab.includes("boil") ||
        lab.includes("stir") ||
        lab.includes("stove")
      )
        needed.add("Stove");
      if (
        lab.includes("can ") ||
        lab.includes("canning") ||
        lab.includes("jar")
      )
        needed.add("Canning");
      if (lab.includes("dehydrate")) needed.add("Dehydrate");
      if (lab.includes("label") || lab.includes("store")) needed.add("Label");
    });
  });

  return base.filter((s) => needed.has(s.key));
}

/* ------------------------------- Timers Builder ----------------------------- */
function buildTimers(steps) {
  // Create timers for any step with timer seconds and generate labels
  // Add cross-recipe schedule hints (stagger bake times, overlap simmer/roast)
  const timers = [];
  steps.forEach((s) => {
    if (s.timer && !Number.isNaN(Number(s.timer))) {
      timers.push({
        id: uid("tmr"),
        stepId: s.id,
        label: s.label,
        seconds: Number(s.timer),
        voiceAlerts: true, // SessionDraftDetail can toggle toasts/voice
        station: s.station || null,
      });
    }
  });
  return timers;
}

/* ------------------------------- Equipment Pull ----------------------------- */
function buildEquipmentList(recipes) {
  const items = new Map();
  const add = (name, qty = 1) => items.set(name, (items.get(name) || 0) + qty);

  recipes.forEach((r) => {
    (r.equipment || []).forEach((eq) => add(eq, 1));
    (r.steps || []).forEach((s) => {
      (s.tools || []).forEach((t) => add(t, 1));
      if ((s.label || "").toLowerCase().includes("bake")) add("sheet pan", 1);
      if ((s.label || "").toLowerCase().includes("saute")) add("skillet", 1);
      if ((s.label || "").toLowerCase().includes("boil")) add("saucepan", 1);
      if ((s.label || "").toLowerCase().includes("can"))
        add("pressure canner", 1);
      if ((s.label || "").toLowerCase().includes("dehydrate"))
        add("dehydrator", 1);
    });
  });

  return Array.from(items.entries()).map(([label, qty]) => ({ label, qty }));
}

/* ------------------------------ Specialty Tracks ---------------------------- */
function detectSpecialties(recipes) {
  // Check if any recipes belong to specialty workflows
  const flags = {
    pressureCanning: false,
    sausageMaking: false,
    dehydrating: false,
    winemaking: false,
    smoking: false,
    distilling: false,
  };
  recipes.forEach((r) => {
    const tags = (r.tags || []).map((t) => t.toLowerCase());
    const name = (r.name || "").toLowerCase();
    const check = (key) => tags.includes(key) || name.includes(key);
    flags.pressureCanning =
      flags.pressureCanning || check("canning") || check("pressure canning");
    flags.sausageMaking = flags.sausageMaking || check("sausage");
    flags.dehydrating =
      flags.dehydrating || check("dehydrate") || check("dehydrating");
    flags.winemaking = flags.winemaking || check("wine") || check("winemaking");
    flags.smoking = flags.smoking || check("smoke") || check("smoking");
    flags.distilling =
      flags.distilling || check("distill") || check("distilling");
  });
  return flags;
}

/* --------------------------- Sabbath Sunset Awareness ----------------------- */
async function applySabbathAwareness(draft, imports, locationPref) {
  // If sabbath template/util is present, annotate draft with latest safe cutoff window
  try {
    const { SabbathTemplate, CalendarUtils } = imports;
    const calc = SabbathTemplate?.default || SabbathTemplate;
    if (!calc || !CalendarUtils) return draft;
    const hint = await (async () => {
      try {
        const mod = calc; // sabbathSunsetAwareMealPrep.js exposes helpers
        if (typeof mod?.getUpcomingSabbathWindow === "function") {
          return await mod.getUpcomingSabbathWindow(locationPref || null);
        }
      } catch (_) {}
      return null;
    })();

    if (hint?.start && hint?.end) {
      draft.sabbathGuard = {
        enabled: true,
        window: { start: hint.start, end: hint.end },
        note: "Avoid active cooking across sundown per Sabbath setting.",
      };
    }
    return draft;
  } catch {
    return draft;
  }
}

/* --------------------------- Consolidation (from plan) ---------------------- */
async function consolidateFromPlan(imports, opts) {
  const { MealPlanStore, RecipeStore, recipeConsolidator } = imports;
  const {
    planId = null,
    window = null, // { start, end }
    includeTags = ["Breakfast", "Lunch", "Dinner", "Snack"],
    selectedRecipeIds = null,
    servingsOverride = null,
  } = opts || {};

  // Priority: explicit selectedRecipeIds → consolidator agent → fallback store query
  if (Array.isArray(selectedRecipeIds) && selectedRecipeIds.length) {
    const recipes = selectedRecipeIds
      .map((rid) => RecipeStore?.getById?.(rid))
      .filter(Boolean);
    return { items: [], groupedByMeal: {}, recipes, servingsOverride };
  }

  if (typeof recipeConsolidator === "function") {
    const out = await recipeConsolidator(
      { planId, window, includeTags, servingsOverride },
      { onProgress: () => {} }
    );
    // agent should return { items, groupedByMeal, recipes? }
    if (out?.recipes?.length) return out;
    // else fallthrough combine from items
    const recipes = (out?.items || [])
      .map((i) => RecipeStore?.getById?.(i.recipeId))
      .filter(Boolean);
    return { ...(out || {}), recipes };
  }

  // Fallback: basic MealPlanStore extraction
  const plans = MealPlanStore?.getRange
    ? MealPlanStore.getRange(window?.start, window?.end)
    : [];
  const planMeals = (plans || []).flatMap((p) => p.meals || []);
  const filtered = planMeals.filter((m) =>
    includeTags.includes(m.mealType || m.tag)
  );
  const recipes = filtered
    .map((m) => RecipeStore?.getById?.(m.recipeId))
    .filter(Boolean);

  return { items: filtered, groupedByMeal: {}, recipes, servingsOverride };
}

/* ------------------------------ Draft Composer ------------------------------ */
function composeDraft({
  recipes,
  inventory,
  rhythm,
  titleHint,
  servingsOverride,
}) {
  const stations = buildStations(recipes);
  const specialties = detectSpecialties(recipes);

  // Integrated Task Parser
  const itp = integrateTasks(recipes);
  const timers = buildTimers(itp.integrated);
  const equipment = buildEquipmentList(recipes);

  // Build inventory pulls (aggregate ingredient lines across recipes)
  const ingredientLines = [];
  recipes.forEach((r) => {
    (r.ingredients || []).forEach((ing) => {
      // Expect RecipeStore normalization: { key, qty, unit, label, category }
      ingredientLines.push({
        key: ing.key || ing.label || ing.name,
        qty: servingsOverride
          ? Math.ceil(((ing.qty || 0) * servingsOverride) / (r.servings || 1))
          : ing.qty || 0,
        unit: ing.unit || "",
        label: ing.label || ing.name || ing.key || "item",
        category: ing.category || "general",
      });
    });
  });
  const inv = computeInventoryNeeds(inventory, ingredientLines);

  // Flow hints: order stations, suggest overlaps (stove simmer while oven bakes)
  const flow = {
    sequence: stations.map((s) => s.key),
    overlaps: [
      { with: ["Stove", "Oven"], note: "Simmer sauces while roasting/baking." },
      {
        with: ["Prep", "Canning"],
        note: "Sterilize jars while finishing last saute.",
      },
    ],
    multitimer: {
      enabled: true,
      timersCount: timers.length,
      voiceAlerts: true,
    },
    labeling:
      specialties.pressureCanning ||
      specialties.dehydrating ||
      specialties.winemaking,
  };

  // Metrics
  const estMinutes = itp.integrated.reduce((m, s) => m + (s.estMin || 3), 0);
  const draftId = uid("cookDraft");

  const draft = {
    id: draftId,
    type: "cooking",
    title: titleHint || "Cooking Session",
    createdAt: new Date().toISOString(),
    approvals: { status: "draft" },
    rhythm: rhythm || null,

    specialties,
    stations,
    equipment,
    timers,
    steps: itp.integrated, // flat ordered steps; UI can group by station/recipe
    recipes: recipes.map((r) => ({
      id: r.id,
      name: r.name,
      servings: servingsOverride || r.servings || null,
      tags: r.tags || [],
    })),

    inventory: {
      pulls: inv.pulls,
      missing: inv.missing,
      stockScore: inv.stockScore,
      autoSyncHint: {
        enabled: true,
        mode: "prompt", // UI: ask to sync down on approval
        decrementOnStart: false, // leave true/false to UI setting
      },
    },

    flow,

    safety: {
      allergens: [...new Set(recipes.flatMap((r) => r.allergens || []))],
      knifeWork: itp.integrated.some((s) =>
        /chop|dice|mince|slice/i.test(s.label)
      ),
      heatSources: itp.integrated.some((s) =>
        /bake|boil|simmer|saute|roast/i.test(s.label)
      ),
      ventilationRecommended: true,
    },

    metrics: {
      totalRecipes: recipes.length,
      totalSteps: itp.integrated.length,
      estMinutes,
    },

    // Integrations set by main app upon approval
    integrations: {
      calendarSync: {
        enabled: false,
        calendarId: null,
        reminders: [{ offsetMinutes: 10, type: "notification" }],
      },
      telemetry: { event: "draft.cooking.generated" },
      printing: {
        labels:
          specialties.pressureCanning ||
          specialties.dehydrating ||
          specialties.winemaking,
      },
    },
  };

  // If rhythm suggests delaying outside window, hint suggested start
  if (draft.rhythm && !isWithinMealWindow(draft.rhythm, new Date())) {
    const nextStart = nextMealWindowStart(draft.rhythm);
    if (nextStart) {
      draft.schedulingHint = {
        reason: "Outside meal window",
        suggestedStart: nextStart.toISOString(),
      };
    }
  }

  return draft;
}

/* ------------------------------ Public API ---------------------------------- */
/**
 * Generate a cooking session draft.
 *
 * @param {Object} input
 *   - planId?: string
 *   - window?: { start: string|Date, end: string|Date }
 *   - includeTags?: string[] (e.g., ["Breakfast","Lunch","Dinner","Snack"])
 *   - selectedRecipeIds?: string[]
 *   - servingsOverride?: number (applies proportionally)
 *   - title?: string
 *   - rhythm?: { type, windows:[{start,end}], fastingPattern? }
 *   - sabbathAware?: boolean
 *   - locationPref?: { lat:number, lon:number } // optional for sunset calc
 * @param {Object} ctx
 *   - onProgress?: (phase, pct) => void
 *   - signal?: AbortSignal
 * @returns {Promise<{ draft: Object, meta: Object }>}
 */
export default async function generateCookingSession(input = {}, ctx = {}) {
  const {
    planId = null,
    window = null,
    includeTags = ["Breakfast", "Lunch", "Dinner"],
    selectedRecipeIds = null,
    servingsOverride = null,
    title = null,
    rhythm = null,
    sabbathAware = false,
    locationPref = null,
  } = input;

  const { onProgress, signal } = ctx;
  const progress = (phase, pct) => {
    if (typeof onProgress === "function") onProgress(phase, pct);
  };

  progress("init", 3);
  const imports = await lazyImports();

  if (signal?.aborted) throw new Error("aborted");

  progress("consolidate", 12);
  const consolidation = await consolidateFromPlan(imports, {
    planId,
    window,
    includeTags,
    selectedRecipeIds,
    servingsOverride,
  });

  const recipes = consolidation.recipes || [];
  if (!recipes.length) {
    return {
      draft: {
        id: uid("cookDraft"),
        type: "cooking",
        approvals: { status: "draft" },
        title: "Cooking Session (No recipes found)",
        createdAt: new Date().toISOString(),
        steps: [],
        recipes: [],
        inventory: { pulls: [], missing: [], stockScore: 1 },
        stations: [],
        timers: [],
        metrics: { totalRecipes: 0, totalSteps: 0, estMinutes: 0 },
        integrations: { calendarSync: { enabled: false, reminders: [] } },
        notices: [
          {
            type: "empty",
            message: "No recipes were found in the selected window or list.",
          },
        ],
      },
      meta: { consolidated: false, reason: "no_recipes" },
    };
  }

  if (signal?.aborted) throw new Error("aborted");

  progress("compose", 35);
  const draft = composeDraft({
    recipes,
    inventory: imports.InventoryStore,
    rhythm,
    titleHint: title || "Cooking Session",
    servingsOverride,
  });

  // Label printing hint for canning/dehydrating/winemaking
  if (
    draft.specialties.pressureCanning ||
    draft.specialties.dehydrating ||
    draft.specialties.winemaking
  ) {
    draft.labels = {
      enabled: true,
      fields: ["Product", "Batch", "Date", "Ingredients", "Net Wt/Vol"],
      suggestedFormat: "Product - Date - Batch",
    };
  }

  if (signal?.aborted) throw new Error("aborted");

  // Optional Sabbath awareness
  if (sabbathAware) {
    progress("sabbath-awareness", 55);
    await applySabbathAwareness(draft, imports, locationPref);
  }

  // Announce in the event bus (non-blocking)
  try {
    imports.EventBus?.emit?.("draft.cooking.ready", deepClone(draft));
  } catch {}

  progress("finalize", 92);

  // Meta for SessionDraftDetail to show context chips
  const meta = {
    consolidated: true,
    planWindow: window
      ? { start: toISO(window.start), end: toISO(window.end) }
      : null,
    includeTags,
    selectedCount: Array.isArray(selectedRecipeIds)
      ? selectedRecipeIds.length
      : null,
    rhythm: rhythm || null,
    sabbathAware: !!sabbathAware,
  };

  progress("done", 100);
  return { draft, meta };
}

/* --------------------------------- Notes ------------------------------------
Usage from agentsWorker.js:

  import generateCookingSession from "@/workers/impl/generateCookingSession.js";

  const { draft, meta } = await generateCookingSession({
    planId,
    window: { start, end },
    includeTags: ["Breakfast","Lunch","Dinner","Snack"],
    selectedRecipeIds, // optional
    servingsOverride: 8, // optional
    rhythm: {
      type: "time-restricted",
      windows: [{ start: "11:00", end: "19:00" }],
      fastingPattern: "16:8"
    },
    sabbathAware: true,
    locationPref: { lat: 33.435, lon: -86.105 } // optional
  }, {
    onProgress: (phase, pct) =>
      postMessage({ type: "PROGRESS", data: { phase: `draft:cooking:${phase}`, pct } }),
    signal
  });

Then emit to UI:
  postMessage({ type: "DRAFT_READY", data: { draft, draftType: "cooking" } });

On approval in SessionDraftDetail:
  - Toggle draft.approvals.status = "approved"
  - Set draft.integrations.calendarSync.enabled = true
  - Persist & fire CalendarSync hook (agentsWorker already requests this).
------------------------------------------------------------------------------- */
