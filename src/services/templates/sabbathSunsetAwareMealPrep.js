// src/services/templates/sabbathSunsetAwareMealPrep.js

import * as timeUtils from "@/utils/timeUtils";
import ReminderManager from "@/managers/ReminderManager";

// Optional/guarded modules (rename if your app differs)
let MealPlanStore, RecipeStore, CalendarSyncModule, NotificationCenter;
try { MealPlanStore = require("@/store/MealPlanStore"); } catch (_) {}
try { RecipeStore = require("@/store/RecipeStore"); } catch (_) {}
try { CalendarSyncModule = require("@/services/calendar/CalendarSyncModule").default; } catch (_) {}
try { NotificationCenter = require("@/managers/NotificationCenter").default; } catch (_) {}

// ---- Lazy loader so Vite won't hard-scan this dependency ----
async function loadReheatNotesUI() {
  try {
    const mod = await import(/* @vite-ignore */ "@/ui/ReheatNotesPrinter.jsx");
    return mod.default || mod;
  } catch {
    return null;
  }
}

/**
 * Contract-compliant metadata
 */
export const template = {
  id: "sabbath_sunset_aware_meal_prep_v1",
  version: "1.1.0",
  purpose: "Finish cooking before sunset with restful reheat plan.",
  triggers: ["calendar::friday_sunset", "holiday_rules"],
  inputs: {
    // sunsetISO: "YYYY-MM-DDTHH:mm:ssZ" (or local ISO)
    // plannedMeals: [{ recipeId, serves?, target?:'dinner'|'brunch', notes? }]
    // warming: { method:'warming_drawer'|'blech'|'hotplate'|'thermos'|'insulated'|'none', maxTempC?:number, holdMinutes?:number }
    required: ["sunsetISO"],
    optional: ["plannedMeals", "warming"]
  },
  logic: {
    selectors: [
      "MealPlanStore.getDay(friday)",
      "RecipeStore.getById(recipeId)",
      "Back-schedule cook/prep to finish before sunset with a buffer",
      "Create warming windows within constraints"
    ],
    rules: [
      "Finish hot work before sunset minus a safety buffer (>=20 min, adaptive by warming method).",
      "Move to holding/warming with no active timers once start time passes.",
      "Generate reheat/serve notes suitable for the chosen warming method.",
      "If time is insufficient, pivot to cold/no-cook plan."
    ],
    llm_roles: []
  },
  actions: [
    "create:timeline + gentle alerts",
    "open:ReheatNotesPrinter.jsx#print",
    "dispatch:CalendarSyncModule.load(timeline blocks)"
  ],
  outputs: {
    ui: ["ReheatNotesPrinter.jsx", "CalendarSyncModule.jsx"],
    data: ["planTimeline", "reheatNotes", "noTimersAfter"],
    alerts: ["pre_sunset_wrap", "serve_windows"]
  },
  fallbacks: [
    "If running late, suggest a cold meal swap (salads/mezze/sandwich board) or call Quick Suggest (#1) with cold preference."
  ],
  success_message: "Pre-sunset plan set. I added a calm warming window and printed reheat notes.",
  used_by: ["mealPlanningAgent", "cookingAgent"]
};

/** ---------------- Helpers ---------------- **/

const MS = { MIN: 60000, HOUR: 3600000 };

const toDate = (d) => (d instanceof Date ? d : new Date(d));
const addMin = (d, m) =>
  (typeof timeUtils?.addMinutes === "function")
    ? timeUtils.addMinutes(d, m)
    : new Date(d.getTime() + m * MS.MIN);
const addHr = (d, h) =>
  (typeof timeUtils?.addHours === "function")
    ? timeUtils.addHours(d, h)
    : new Date(d.getTime() + h * MS.HOUR);
const toLocalISO = (d) =>
  (typeof timeUtils?.toLocalISODateTime === "function")
    ? timeUtils.toLocalISODateTime(d)
    : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

// Rough duration estimate from recipe
function estimateMinutesFor(recipe) {
  const t = Number(recipe?.totalTime || 0);
  if (t > 0) return Math.min(180, Math.max(15, t));
  const steps = Array.isArray(recipe?.steps) ? recipe.steps.length : 6;
  return Math.min(120, Math.max(20, steps * 4 + 8));
}

// Adaptive safety buffer by warming method (longer for less efficient holding)
function methodBufferMin(warming = {}) {
  const method = String(warming?.method || "none").toLowerCase();
  const user = Number.isFinite(warming?.holdMinutes) ? Math.max(15, Math.min(60, warming.holdMinutes)) : null;
  if (user) return user;
  if (method === "warming_drawer") return 20;
  if (method === "thermos" || method === "insulated") return 20;
  if (method === "blech" || method === "hotplate") return 30;
  return 25; // cold/none
}

// Build reheat/hold instructions by warming method
function buildReheatNotes(recipe, warming = {}) {
  const method = String(warming?.method || "none").toLowerCase();
  const base = { recipeId: recipe.id, name: recipe.name, serveNotes: "" };

  if (method === "warming_drawer") {
    return { ...base,
      hold: "Place covered in warming drawer.",
      temp: `${warming?.maxTempC || 80}°C (≈175°F)`,
      serveNotes: "Open briefly; keep covered to avoid drying.",
      timerWarning: "No active timers after start; just a soft serve window."
    };
  }
  if (method === "blech" || method === "hotplate") {
    return { ...base,
      hold: "Keep covered on low heat-safe surface.",
      temp: "Low setting; avoid simmering.",
      serveNotes: "Rotate pans every 45–60 min if possible.",
      timerWarning: "No timers—use gentle window alerts only."
    };
  }
  if (method === "thermos" || method === "insulated") {
    return { ...base,
      hold: "Preheat thermos with hot water. Fill with near-boiling soup/stew.",
      temp: "Seal immediately.",
      serveNotes: "Do not open until serving to retain heat.",
      timerWarning: "No timers—serve when ready."
    };
  }
  // none / cold
  return { ...base,
    hold: "Chill safely and serve cold.",
    temp: "Keep < 4°C (39°F).",
    serveNotes: "Set out shortly before serving.",
    timerWarning: "No timers—only a serve reminder."
  };
}

/**
 * Back-schedule tasks for each meal so all cooking finishes before sunset-buffer.
 * Returns a timeline array with blocks: { title, start, end, meta }
 */
function backSchedulePlan({ sunset, meals = [], warming = {} }) {
  const bufferMin = methodBufferMin(warming);
  const finishBy = addMin(sunset, -bufferMin); // last hot work must finish here
  let cursor = new Date(finishBy); // schedule backwards

  const blocks = [];
  const notes = [];

  // Order: longest cook first (scheduled earlier)
  const withDur = meals.map((m) => {
    const r = m.recipe;
    return { m, r, min: estimateMinutesFor(r) };
  }).sort((a, b) => b.min - a.min);

  for (const item of withDur) {
    const end = new Date(cursor);
    const start = addMin(end, -item.min);
    blocks.push({
      title: `${item.r.name} — Cook`,
      start,
      end,
      meta: { recipeId: item.r.id, type: "cook" }
    });
    cursor = start; // walk backward

    // Warm/hold window (ends just before sunset)
    const holdStart = end;
    const holdEnd = addMin(sunset, -Math.max(3, Math.min(bufferMin, 20)));
    blocks.push({
      title: `${item.r.name} — Hold/Warm`,
      start: holdStart,
      end: holdEnd,
      meta: { recipeId: item.r.id, type: "hold", method: warming?.method || "none" }
    });

    notes.push(buildReheatNotes(item.r, warming));
  }

  // Sort chronologically for output
  blocks.sort((a, b) => a.start.getTime() - b.start.getTime());
  return { blocks, notes, finishBy, bufferMin };
}

/**
 * If we don't have plannedMeals, pull from Friday/Saturday plan as a hint.
 */
function resolveMeals(plannedMeals) {
  if (Array.isArray(plannedMeals) && plannedMeals.length) return plannedMeals;

  const out = [];
  try {
    const todayISO = timeUtils?.toLocalISODate?.(new Date()) || new Date().toISOString().slice(0, 10);
    const fri = MealPlanStore?.getUpcomingDay?.("Friday") || MealPlanStore?.getDay?.(todayISO);
    const ids = (fri?.recipeIds || []).slice(0, 3);
    ids.forEach((id) => {
      const r = RecipeStore?.getById?.(id);
      if (r) out.push({ recipeId: id, serves: r.servings || 4 });
    });
  } catch (_) {}
  return out;
}

/** ---------------- Execute ---------------- **/

/**
 * Execute the template.
 * @param {Object} payload
 * @param {string} payload.sunsetISO
 * @param {Array<{recipeId:string, serves?:number, target?:string, notes?:string}>} [payload.plannedMeals]
 * @param {{method:string, maxTempC?:number, holdMinutes?:number}} [payload.warming]
 * @param {Object} [ctx]   // { openUI?, runTemplate?, now? }
 * @returns {Promise<{planTimeline:Array, reheatNotes:Array, noTimersAfter:string, message:string}>}
 */
export async function execute(payload = {}, ctx = {}) {
  const { sunsetISO, plannedMeals, warming = {} } = payload;
  const { openUI, runTemplate, now = new Date() } = ctx;

  if (!sunsetISO) {
    throw new Error("sabbathSunsetAwareMealPrep: sunsetISO is required.");
  }

  const sunset = toDate(sunsetISO);

  // Resolve meals & fetch recipes
  const mealsIn = resolveMeals(plannedMeals);
  const withRecipes = mealsIn
    .map((m) => {
      const r = RecipeStore?.getById?.(m.recipeId);
      return r ? { ...m, recipe: r } : null;
    })
    .filter(Boolean);

  // If no recipes resolved, fallback to cold meal swap via Quick Suggest (#1)
  if (withRecipes.length === 0) {
    if (typeof runTemplate === "function") {
      const qs = await runTemplate("quick_suggest_dinner_v1", {
        timeAvailable: 20,
        coldPreferred: true
      });
      return {
        planTimeline: [],
        reheatNotes: [],
        noTimersAfter: toLocalISO(sunset),
        message: qs?.message || "No planned meals found—suggested a cold, no-cook option instead."
      };
    }
    return {
      planTimeline: [],
      reheatNotes: [],
      noTimersAfter: toLocalISO(sunset),
      message: "No planned meals found—consider a cold, no-cook option."
    };
  }

  // Compute total hot time and ensure feasibility
  const totalHotMin = withRecipes.reduce((s, m) => s + estimateMinutesFor(m.recipe), 0);
  const nowToSunsetMin = Math.max(0, Math.round((sunset.getTime() - now.getTime()) / MS.MIN));
  const bufferMin = methodBufferMin(warming);
  const requiredWindow = totalHotMin + bufferMin;

  if (requiredWindow > nowToSunsetMin) {
    // Not enough time → pivot to cold
    if (typeof runTemplate === "function") {
      try {
        const qs = await runTemplate("quick_suggest_dinner_v1", {
          timeAvailable: Math.max(10, nowToSunsetMin - 5),
          coldPreferred: true
        });
        return {
          planTimeline: [],
          reheatNotes: [],
          noTimersAfter: toLocalISO(sunset),
          message: qs?.message || "Time is tight—pivoted to a cold/no-cook plan."
        };
      } catch (_) {
        // fall through to minimal plan if suggest fails
      }
    }
  }

  // Build plan via back-scheduling
  const { blocks, notes, finishBy } = backSchedulePlan({
    sunset,
    meals: withRecipes,
    warming
  });

  // "No more timers" after this moment (start of hold windows)
  const noTimersAfter = toLocalISO(finishBy);

  // Create gentle alerts: wrap-up + serve windows
  try {
    // Final hot-work wrap warning
    ReminderManager.schedule?.({
      at: addMin(finishBy, -5),
      title: "Wrap hot cooking",
      message: "Finish any hot work now; move dishes to warm/hold.",
      tags: ["sabbath", "prep", "wrap"]
    });

    // Serve windows (one per dish, near sunset)
    blocks
      .filter((b) => b.meta?.type === "hold")
      .forEach((b) => {
        ReminderManager.schedule?.({
          at: addMin(b.end, -3),
          title: "Serving window",
          message: `${b.title}: uncover briefly and serve when ready.`,
          tags: ["sabbath", "serve"]
        });
      });

    // Subtle “Shabbat shalom” nudge at sunset
    NotificationCenter?.notify?.({
      title: "Shabbat shalom",
      message: "All set—no active timers. Serve within your warming window.",
      action: "Open"
    });
  } catch (_) {}

  // Sync timeline to calendar (time blocks)
  try {
    const events = blocks.map((b) => ({
      start: b.start,
      end: b.end,
      title: b.title,
      description: b.meta?.type === "cook" ? "Active cooking" : "Hold/Warm—no active timers",
      tags: ["sabbath_prep"]
    }));
    CalendarSyncModule?.load?.(events);
  } catch (_) {}

  // Print/preview reheat notes
  try {
    const payloadNotes = { notes, warming };

    // Try to lazy-load the UI component
    const ReheatNotesPrinterUI = await loadReheatNotesUI();
    if (ReheatNotesPrinterUI) {
      if (typeof openUI === "function") {
        try { openUI(ReheatNotesPrinterUI, payloadNotes); }
        catch { openUI("ReheatNotesPrinter", payloadNotes); }
      } else {
        window.dispatchEvent(new CustomEvent("ui:navigate", {
          detail: { route: "ReheatNotesPrinter", params: payloadNotes }
        }));
      }
    } else {
      if (typeof openUI === "function") openUI("ReheatNotesPrinter", payloadNotes);
      else window.dispatchEvent(new CustomEvent("ui:navigate", {
        detail: { route: "ReheatNotesPrinter", params: payloadNotes }
      }));
    }
  } catch (_) {}

  // Prepare final timeline for outputs (ISO local strings)
  const planTimeline = blocks.map((b) => ({
    title: b.title,
    start: toLocalISO(b.start),
    end: toLocalISO(b.end),
    meta: b.meta
  }));

  return {
    planTimeline,
    reheatNotes: notes,
    noTimersAfter,
    message: template.success_message
  };
}

export default { template, execute };
