// src/services/mealplanning/mealPlanDiff.js
/**
 * mealPlanDiff (v1)
 * ---------------------------------------------------------------------------
 * Compute precise diffs between two meal plans and generate:
 *  - structural ops (add/update/remove slots, add/remove/move recipes)
 *  - nutrition deltas vs. daily targets (from NutritionGoalsStore if present)
 *  - inventory reservation deltas (items to reserve or release)
 *  - actionable suggestions for UI (NBA toolbar)
 *
 * Works with MealPlanStore v2 data shape:
 *   mealPlan = { "YYYY-MM-DD": [ {slotId,label,type,start,end,dietTag,recipes[],status} ... ] }
 */

const toISO = (d) => {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d + "T00:00:00") : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const normId = (x) => String(x ?? "").trim();
const shallowEq = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
};
const clone = (x) => JSON.parse(JSON.stringify(x || null));

/* ---------------------------------------------------------------------------
   Optional dynamic imports
--------------------------------------------------------------------------- */
async function optional(storePathCandidates) {
  for (const p of storePathCandidates) {
    try {
      // @vite-ignore
      const mod = await import(p);
      return mod?.default || mod;
    } catch {}
  }
  return null;
}
async function MealPlanStore() {
  return await optional(["@/store/MealPlanStore"]);
}
async function NutritionGoalsStore() {
  return await optional(["@/store/NutritionGoalsStore"]);
}
async function InventoryStore() {
  return await optional(["@/store/InventoryStore"]);
}
async function PreferencesStore() {
  return await optional(["@/store/PreferencesStore"]);
}

/* ---------------------------------------------------------------------------
   Nutrition helpers
--------------------------------------------------------------------------- */
function sumRecipeNutrition(recipes = []) {
  const sum = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, netCarbs: 0 };
  for (const r of recipes) {
    const n = r?.nutrition || {};
    sum.kcal += n.kcal || 0;
    sum.protein += n.protein || 0;
    sum.carbs += n.carbs || 0;
    sum.fat += n.fat || 0;
    sum.fiber += n.fiber || 0;
    if (n.netCarbs != null) sum.netCarbs += n.netCarbs;
  }
  for (const k of Object.keys(sum)) sum[k] = Math.round(sum[k]);
  return sum;
}
function dayNutrition(entries = []) {
  const out = { kcal: 0, protein: 0, carbs: 0, fat: 0, fiber: 0, netCarbs: 0 };
  for (const e of entries) {
    if (e.type === "fast") continue;
    const s = sumRecipeNutrition(e.recipes || []);
    out.kcal += s.kcal;
    out.protein += s.protein;
    out.carbs += s.carbs;
    out.fat += s.fat;
    out.fiber += s.fiber;
    out.netCarbs += s.netCarbs;
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k]);
  return out;
}

async function getTargets(dateIso) {
  const NG = await NutritionGoalsStore();
  if (NG?.useNutritionGoalsStore) {
    try {
      const store = NG.useNutritionGoalsStore.getState();
      const fromNG = store?.getTargetsForDate?.(dateIso);
      if (fromNG) return fromNG;
    } catch {}
  }
  // Fallback to Preferences
  const Pref = await PreferencesStore();
  // Handle both default export (with getState) and named export `preferencesStore`
  const st = Pref?.getState?.() || Pref?.preferencesStore?.getState?.();

  const ft = st?.foodTargets || st?.nutrition?.dailyGoals;
  if (ft) {
    return {
      calories: Number(ft.calories || 0),
      protein: Number(ft.protein || 0),
      carbs: Number(ft.carbs || 0),
      fat: Number(ft.fat || 0),
    };
  }
  return null;
}

/* ---------------------------------------------------------------------------
   Inventory helpers (best effort)
--------------------------------------------------------------------------- */
function ingredientsFromDay(entries = []) {
  const lines = [];
  for (const e of entries) {
    if (!Array.isArray(e?.recipes)) continue;
    for (const r of e.recipes) {
      const L = Array.isArray(r?.ingredients) ? r.ingredients : [];
      for (const ing of L) {
        if (!ing?.name) continue;
        lines.push({
          name: ing.name,
          qty: ing.qty,
          unit: ing.unit,
          meta: { recipeId: r.id, title: r.title || r.name },
        });
      }
    }
  }
  return lines;
}

/* ---------------------------------------------------------------------------
   Diff core
--------------------------------------------------------------------------- */
function indexBySlotId(entries = []) {
  const m = new Map();
  for (const e of entries) m.set(e.slotId, e);
  return m;
}
function recipeIndex(recipes = []) {
  const m = new Map();
  for (let i = 0; i < (recipes?.length || 0); i++)
    m.set(normId(recipes[i].id), { i, r: recipes[i] });
  return m;
}
function pick(obj, keys) {
  const out = {};
  for (const k of keys) out[k] = obj?.[k];
  return out;
}

/**
 * Compute diff between two day arrays (slots/fasts).
 * Returns ops you can apply and human-friendly summary.
 */
function diffDay(oldEntries = [], newEntries = [], { dateIso }) {
  const ops = [];
  const a = indexBySlotId(oldEntries);
  const b = indexBySlotId(newEntries);

  // Removed / updated
  for (const [slotId, oldSlot] of a.entries()) {
    if (!b.has(slotId)) {
      ops.push({ kind: "slot.remove", dateIso, slotId, before: oldSlot });
      continue;
    }
    const next = b.get(slotId);
    // slot meta changes
    const metaKeys = ["label", "type", "start", "end", "dietTag"];
    const metaChanged = metaKeys.some(
      (k) => (oldSlot?.[k] || null) !== (next?.[k] || null)
    );
    if (metaChanged) {
      ops.push({
        kind: "slot.update",
        dateIso,
        slotId,
        before: pick(oldSlot, metaKeys),
        after: pick(next, metaKeys),
      });
    }
    if ((oldSlot?.status || "planned") !== (next?.status || "planned")) {
      ops.push({
        kind: "slot.status",
        dateIso,
        slotId,
        before: oldSlot?.status || "planned",
        after: next?.status || "planned",
      });
    }

    // recipe-level diffs
    const A = recipeIndex(oldSlot.recipes || []);
    const B = recipeIndex(next.recipes || []);
    for (const [rid, { r }] of A.entries()) {
      if (!B.has(rid)) {
        ops.push({
          kind: "recipe.remove",
          dateIso,
          slotId,
          recipeId: rid,
          recipe: r,
        });
      } else {
        const { r: nr } = B.get(rid);
        const metaKeysR = ["title", "name", "nutrition"];
        if (!shallowEq(pick(r, metaKeysR), pick(nr, metaKeysR))) {
          ops.push({
            kind: "recipe.update",
            dateIso,
            slotId,
            recipeId: rid,
            before: pick(r, metaKeysR),
            after: pick(nr, metaKeysR),
          });
        }
      }
    }
    // additions
    for (const [rid, { r }] of B.entries()) {
      if (!A.has(rid))
        ops.push({
          kind: "recipe.add",
          dateIso,
          slotId,
          recipeId: rid,
          recipe: r,
        });
    }

    // movements within the same slot (order change)
    const oldOrder = (oldSlot.recipes || []).map((x) => normId(x.id));
    const newOrder = (next.recipes || []).map((x) => normId(x.id));
    if (
      oldOrder.length &&
      newOrder.length &&
      JSON.stringify(oldOrder) !== JSON.stringify(newOrder)
    ) {
      ops.push({
        kind: "recipe.reorder",
        dateIso,
        slotId,
        before: oldOrder,
        after: newOrder,
      });
    }
  }

  // Added slots
  for (const [slotId, next] of b.entries()) {
    if (!a.has(slotId)) {
      ops.push({ kind: "slot.add", dateIso, slotId, slot: next });
    }
  }

  return ops;
}

/**
 * Diff two entire mealPlan objects: { dateIso: DayEntries[] }
 */
export function diffMealPlans(oldPlan = {}, newPlan = {}) {
  const ops = [];
  const dates = new Set(
    [...Object.keys(oldPlan || {}), ...Object.keys(newPlan || {})].map(toISO)
  );
  for (const dateIso of Array.from(dates).sort()) {
    const oldEntries = oldPlan?.[dateIso] || [];
    const newEntries = newPlan?.[dateIso] || [];
    ops.push(...diffDay(oldEntries, newEntries, { dateIso }));
  }
  return ops;
}

/* ---------------------------------------------------------------------------
   Nutrition + Inventory rollups for a given date
--------------------------------------------------------------------------- */
export async function analyzeDay(plan = {}, dateIso) {
  const iso = toISO(dateIso);
  const entries = clone(plan?.[iso] || []);
  const totals = dayNutrition(entries);
  const targets = await getTargets(iso);

  // deltas (if targets are available)
  const delta = targets
    ? {
        calories: Math.round((targets.calories || 0) - (totals.kcal || 0)),
        protein: Math.round((targets.protein || 0) - (totals.protein || 0)),
        carbs: Math.round((targets.carbs || 0) - (totals.carbs || 0)),
        fat: Math.round((targets.fat || 0) - (totals.fat || 0)),
      }
    : null;

  // Inventory lines (non-normalized; IngredientsIndex can transform later)
  const ingredients = ingredientsFromDay(entries);

  return { dateIso: iso, totals, targets, delta, ingredients };
}

/* ---------------------------------------------------------------------------
   High-level analysis & suggestions
--------------------------------------------------------------------------- */
export async function analyzeDiff(oldPlan = {}, newPlan = {}) {
  const ops = diffMealPlans(oldPlan, newPlan);

  // group ops by date
  const perDate = {};
  for (const op of ops) {
    perDate[op.dateIso] = perDate[op.dateIso] || { ops: [] };
    perDate[op.dateIso].ops.push(op);
  }

  const results = [];
  for (const dateIso of Object.keys(perDate).sort()) {
    const day = await analyzeDay(newPlan, dateIso);
    results.push({
      dateIso,
      ops: perDate[dateIso].ops,
      nutrition: day,
      suggestions: buildSuggestionsFromAnalysis(day, perDate[dateIso].ops),
      reservations: buildReservationPlan(perDate[dateIso].ops),
    });
  }
  return { ops, byDate: results };
}

function buildReservationPlan(ops) {
  // What ingredients to add/remove reservations for (coarse: recipe-level)
  const reserve = [];
  const release = [];

  for (const op of ops) {
    if (op.kind === "recipe.add")
      reserve.push({
        key: op.recipeId,
        slotId: op.slotId,
        dateIso: op.dateIso,
      });
    if (op.kind === "recipe.remove")
      release.push({
        key: op.recipeId,
        slotId: op.slotId,
        dateIso: op.dateIso,
      });
    // Note: recipe.update might trigger re-reserve if ingredients changed; left to Orchestrator
  }
  return { reserve, release };
}

function buildSuggestionsFromAnalysis(day, ops) {
  const s = [];
  const d = day.delta || {};
  const totals = day.totals || {};
  const targets = day.targets || null;

  // Nutrition nudges
  if (targets) {
    if (d.protein > 20)
      s.push({
        type: "macro",
        text: `Add ~${d.protein}g protein (e.g., eggs, chicken, beans).`,
        severity: "info",
        macro: "protein",
      });
    if (
      d.calories > 250 &&
      (totals.kcal > 0 ? totals.protein / totals.kcal : 0) < 0.2
    )
      s.push({
        type: "macro",
        text: "Calories low with protein lagging—consider a protein-forward snack.",
        severity: "info",
      });
    if (d.carbs < -50)
      s.push({
        type: "macro",
        text: "Carbs trending high—swap one carb-heavy side for greens.",
        severity: "warn",
        macro: "carbs",
      });
    if (d.fat < -30)
      s.push({
        type: "macro",
        text: "Fat trending high—choose leaner prep (grill/steam).",
        severity: "warn",
        macro: "fat",
      });
  }

  // Ops-driven suggestions
  const added = ops.filter((o) => o.kind === "recipe.add").length;
  const removed = ops.filter((o) => o.kind === "recipe.remove").length;
  if (added && !removed)
    s.push({
      type: "inventory",
      text: "Reserve ingredients for newly added recipes.",
      severity: "action",
      action: "reserve",
    });
  if (removed)
    s.push({
      type: "inventory",
      text: "Release any reserved ingredients for removed recipes.",
      severity: "action",
      action: "release",
    });

  // Rhythm/fasting awareness—if large deficit, suggest refeed
  if (targets && day.totals.kcal < Math.max(800, targets.calories * 0.5)) {
    s.push({
      type: "strategy",
      text: "Large calorie gap—consider a refeed meal or denser sides.",
      severity: "info",
      action: "refeed",
    });
  }

  return s;
}

/* ---------------------------------------------------------------------------
   Apply ops to MealPlanStore (best effort, idempotent)
--------------------------------------------------------------------------- */
export async function applyOps(ops = []) {
  if (!ops?.length) return { ok: true, applied: 0 };
  const M = await MealPlanStore();
  if (!M?.useMealPlanStore)
    return { ok: false, reason: "MealPlanStore not available" };
  const api = M.useMealPlanStore.getState();

  let applied = 0;
  for (const op of ops) {
    try {
      switch (op.kind) {
        case "slot.add":
          api.upsertSlotForDay?.(op.dateIso, op.slot);
          applied++;
          break;
        case "slot.update":
          api.upsertSlotForDay?.(op.dateIso, {
            slotId: op.slotId,
            ...op.after,
          });
          applied++;
          break;
        case "slot.remove": {
          const entries = api.getDayEntries?.(op.dateIso) || [];
          const next = entries.filter((e) => e.slotId !== op.slotId);
          api.updateMealPlanForDay?.(op.dateIso, next);
          applied++;
          break;
        }
        case "slot.status":
          api.setSlotStatus?.(op.dateIso, op.slotId, op.after);
          applied++;
          break;
        case "recipe.add":
          api.addRecipeToDay?.(op.dateIso, op.recipe, op.slotId);
          applied++;
          break;
        case "recipe.remove":
          api.removeRecipeFromDay?.(op.dateIso, op.recipeId);
          applied++;
          break;
        case "recipe.update":
          // Replace by remove+add for simplicity if nutrition/title changed
          api.removeRecipeFromDay?.(op.dateIso, op.recipeId);
          api.addRecipeToDay?.(
            op.dateIso,
            {
              id: op.recipeId,
              ...(op.after?.title ? { title: op.after.title } : {}),
            },
            op.slotId
          );
          applied++;
          break;
        case "recipe.reorder": {
          const entries = api.getDayEntries?.(op.dateIso) || [];
          const idx = entries.findIndex((e) => e.slotId === op.slotId);
          if (idx >= 0) {
            const slot = clone(entries[idx]);
            const byId = new Map(
              (slot.recipes || []).map((r) => [normId(r.id), r])
            );
            slot.recipes = op.after.map((rid) => byId.get(rid)).filter(Boolean);
            entries[idx] = slot;
            api.updateMealPlanForDay?.(op.dateIso, entries);
            applied++;
          }
          break;
        }
        default:
          break;
      }
    } catch {
      // continue applying remaining ops
    }
  }
  return { ok: true, applied };
}

/* ---------------------------------------------------------------------------
   Inventory reservations based on diff (optional)
--------------------------------------------------------------------------- */
export async function enactInventoryReservations(reservationPlan) {
  const Inv = await InventoryStore();
  if (!Inv?.useInventoryStore)
    return { ok: false, reason: "InventoryStore not available" };

  const api = Inv.useInventoryStore.getState();
  let holdId = null;

  // Build ingredient lines from current MealPlan state
  const M = await MealPlanStore();
  const mapi = M?.useMealPlanStore?.getState?.();

  if (reservationPlan?.reserve?.length) {
    const lines = [];
    for (const r of reservationPlan.reserve) {
      const dayEntries = mapi?.getDayEntries?.(r.dateIso) || [];
      const slot = dayEntries.find((e) => e.slotId === r.slotId);
      const recipe = (slot?.recipes || []).find(
        (x) => normId(x.id) === normId(r.key)
      );
      if (!recipe) continue;
      const ings = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
      for (const ing of ings) {
        if (!ing?.name) continue;
        lines.push({
          name: ing.name,
          qty: ing.qty,
          unit: ing.unit,
          meta: { dateIso: r.dateIso, slotId: r.slotId, recipeId: recipe.id },
        });
      }
    }
    if (lines.length) {
      const res = await api.reserveForIngredients?.(lines, {
        scale: 1,
        reason: "meal-plan",
      });
      holdId = res?.id || holdId;
    }
  }

  // Release handling can be orchestrated at a higher level if per-recipe holds are tracked
  return { ok: true, holdId };
}

/* ---------------------------------------------------------------------------
   Pretty printer
--------------------------------------------------------------------------- */
export function summarizeOps(ops = []) {
  const out = [];
  for (const op of ops) {
    switch (op.kind) {
      case "slot.add":
        out.push(`${op.dateIso}: Added slot ${op.slotId} (${op.slot?.label})`);
        break;
      case "slot.update":
        out.push(`${op.dateIso}: Updated slot ${op.slotId}`);
        break;
      case "slot.remove":
        out.push(`${op.dateIso}: Removed slot ${op.slotId}`);
        break;
      case "slot.status":
        out.push(`${op.dateIso}: ${op.slotId} → status ${op.after}`);
        break;
      case "recipe.add":
        out.push(
          `${op.dateIso}: + Recipe ${op.recipe?.title || op.recipeId} to ${
            op.slotId
          }`
        );
        break;
      case "recipe.remove":
        out.push(
          `${op.dateIso}: − Recipe ${op.recipe?.title || op.recipeId} from ${
            op.slotId
          }`
        );
        break;
      case "recipe.update":
        out.push(`${op.dateIso}: ~ Recipe ${op.recipeId} updated`);
        break;
      case "recipe.reorder":
        out.push(`${op.dateIso}: Reordered recipes in ${op.slotId}`);
        break;
      default:
        break;
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
   High-level orchestrator: compare, apply, analyze
--------------------------------------------------------------------------- */
/**
 * planReconcile(oldPlan, newPlan, { apply = true, reserve = true })
 * - Computes ops, applies them to MealPlanStore (if apply)
 * - Returns nutrition & suggestions per date
 * - Optionally triggers inventory reservations
 */
export async function planReconcile(
  oldPlan,
  newPlan,
  { apply = true, reserve = false } = {}
) {
  const analysis = await analyzeDiff(oldPlan, newPlan);
  if (apply) await applyOps(analysis.ops);
  if (reserve) {
    for (const d of analysis.byDate) {
      if (d.reservations?.reserve?.length || d.reservations?.release?.length) {
        await enactInventoryReservations(d.reservations);
      }
    }
  }
  return analysis;
}

/* ---------------------------------------------------------------------------
   Convenience: diff single day arrays
--------------------------------------------------------------------------- */
export function diffDayArrays(oldEntries = [], newEntries = [], dateIso) {
  return diffDay(oldEntries, newEntries, { dateIso: toISO(dateIso) });
}

/* ---------------------------------------------------------------------------
   ✅ Compatibility export expected by mealPlanEngine.js
   It imports:  import { diffPlans } from "@/services/mealplanning/mealPlanDiff";
--------------------------------------------------------------------------- */
/**
 * diffPlans(oldPlan, newPlan)
 * Alias for diffMealPlans() to keep legacy import stable.
 */
export function diffPlans(oldPlan = {}, newPlan = {}) {
  return diffMealPlans(oldPlan, newPlan);
}

/* ---------------------------------------------------------------------------
   ✅ Default export for consumers that do `import diff from ...`
--------------------------------------------------------------------------- */
const MealPlanDiffModule = {
  diffMealPlans,
  diffPlans,
  analyzeDay,
  analyzeDiff,
  applyOps,
  enactInventoryReservations,
  summarizeOps,
  planReconcile,
  diffDayArrays,
};

export default MealPlanDiffModule;
