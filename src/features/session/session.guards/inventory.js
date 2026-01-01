/**
 * src/features/session/session.guards/inventory.js
 * -----------------------------------------------------------------------------
 * Inventory Guard
 *
 * Purpose:
 * - Blocks starting/advancing a step when required inventory (ingredients,
 *   supplies, feed, jars, fuel, etc.) is insufficient.
 *
 * How it fits:
 * - The SessionRunner invokes this guard when:
 *    • starting a session that contains steps with "inventory" in blockers, or
 *    • advancing to a step that declares "inventory" in blockers.
 * - Returns a structured GuardResult the runner will render in the UI. The guard
 *   itself only emits debug events; user-facing session.* events are emitted by
 *   the runner.
 *
 * Conventions:
 * - Preferred source of requirements:
 *     step.metadata.requiredInventory?: Array<{
 *       key: string,                // normalized inventory key (e.g., "flour.ap")
 *       qty?: number,               // numeric quantity; default 1
 *       unit?: string|null,         // e.g., "g","kg","oz","lb","ml","l","cup","pcs"
 *       note?: string,              // UI hint
 *       alternatives?: string[]     // fallback keys accepted for this requirement
 *     }>
 *
 * - Fallback (heuristics) if requiredInventory not present:
 *     • Cooking: step.metadata.ingredients?: Array<{ name, amount, unit }>
 *       → normalized into requiredInventory via ctx.normalizers?.ingredientToKey
 *     • Cleaning: step.metadata.supplies?: Array<{ name, amount, unit }>
 *     • Garden/Animals/Preservation can also attach domain lists; we map by name.
 *
 * Integration points (pass in via GuardContext):
 * - inventoryRepo: {
 *     /**
 *      * Return current quantity for a key (base unit), or null if unknown.
 *      * Should be fast; guard will call many times.
 *      *\/
 *     getQty(key: string): Promise<{ qty: number, unit: string }|null>,
 *     /**
 *      * Resolve a human label for UI (optional).
 *      *\/
 *     label?(key: string): string
 *   }
 * - unitConverter: {
 *     /**
 *      * Convert a quantity from srcUnit → dstUnit; return { qty, unit } or null.
 *      * The guard will attempt a few common culinary/household conversions.
 *      *\/
 *     convert(qty: number, srcUnit: string|null, dstUnit: string|null, opts?: any):
 *       { qty: number, unit: string } | null
 *   }
 * - normalizers: {
 *     ingredientToKey?(name: string): string|null,
 *     supplyToKey?(name: string): string|null
 *   }
 *
 * Feature flag:
 * - featureFlags.inventoryGuard (default: enabled if flag missing).
 *
 * Resilience:
 * - If inventoryRepo is missing, we fail-open (allow) unless settings.failClosed.
 * - Unknown units try to pass-through; if conversion fails, we compare same-units
 *   only and otherwise mark as unknown (treated as shortage when failClosed).
 *
 * Typed JSDoc docs inputs/outputs below.
 * -----------------------------------------------------------------------------
 */

import eventBus from "../../../services/eventBus";
import { featureFlags } from "../../../services/featureFlags";

/**
 * @typedef {Object} SessionStep
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {number} durationSec
 * @property {Array<"inventory"|"weather"|"quietHours"|"sabbath"|"equipment">} blockers
 * @property {{
 *   tempTargetF?: number,
 *   donenessCue?: "color"|"texture"|"probeTemp"|"timer"|"smell",
 *   cueNotes?: string,
 *   requiredInventory?: Array<{ key: string, qty?: number, unit?: string|null, note?: string, alternatives?: string[] }>,
 *   ingredients?: Array<{ name: string, amount?: number, unit?: string|null }>,
 *   supplies?: Array<{ name: string, amount?: number, unit?: string|null }>
 * }} [metadata]
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} title
 * @property {{ type: "recipe"|"cleaningPlan"|"gardenPlan"|"animalTask"|"import"|"manual", refId: string|null }} source
 * @property {SessionStep[]} steps
 * @property {{ voiceGuidance?: boolean, haptic?: boolean, autoAdvance?: boolean }} prefs
 * @property {"pending"|"running"|"paused"|"completed"|"aborted"} status
 * @property {{ currentStepIndex: number, elapsedSec: number, startedAt: string|null, pausedAt: string|null }} progress
 * @property {{ skippedSteps: string[], adjustments: Array<any> }} analytics
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} InventoryRepo
 * @property {(key: string) => Promise<{ qty: number, unit: string }|null>} getQty
 * @property {(key: string) => string} [label]
 */

/**
 * @typedef {Object} UnitConverter
 * @property {(qty: number, srcUnit: string|null, dstUnit: string|null, opts?: any) => ({ qty: number, unit: string }|null)} convert
 */

/**
 * @typedef {Object} Normalizers
 * @property {(name: string) => (string|null)} [ingredientToKey]
 * @property {(name: string) => (string|null)} [supplyToKey]
 */

/**
 * @typedef {Object} GuardContext
 * @property {InventoryRepo} [inventoryRepo]
 * @property {UnitConverter} [unitConverter]
 * @property {Normalizers} [normalizers]
 * @property {{
 *   enabled?: boolean,            // default true or feature flag
 *   failClosed?: boolean,         // default false (if repo missing, allow)
 *   defaultUnit?: string|null,    // default unit when omitted (domain-aware later)
 *   allowAlternatives?: boolean,  // default true (accept first available alt)
 *   minFraction?: number          // default 1.0 (require full amount). e.g., 0.9 to allow slight shortfalls
 * }} [settings]
 * @property {(msg: string, data?: any) => void} [logger]
 */

/**
 * @typedef {Object} GuardResult
 * @property {boolean} allowed
 * @property {"inventory"} guard
 * @property {string} [reason]
 * @property {string} [message]
 * @property {string} [retryAt] // typically undefined for inventory guard
 * @property {Array<{
 *   key: string,
 *   needQty: number,
 *   needUnit: string|null,
 *   haveQty: number,
 *   haveUnit: string|null,
 *   usedAlternative?: string|null,
 *   note?: string
 * }>} [missing]
 */

/**
 * Evaluate inventory guard for a given step.
 * @param {Session} session
 * @param {number} stepIndex - Index of the step under consideration (-1 means "session start")
 * @param {GuardContext} [ctx]
 * @returns {Promise<GuardResult>}
 */
export async function evaluateInventoryGuard(session, stepIndex, ctx = {}) {
  const log = ctx.logger || (() => {});

  if (!isGuardEnabled(ctx?.settings)) {
    return { allowed: true, guard: "inventory" };
  }

  const step = resolveStep(session, stepIndex);
  if (!hasBlocker(step, "inventory")) {
    return { allowed: true, guard: "inventory" };
  }

  const settings = withDefaults(ctx.settings);

  // Validate repo
  if (!ctx.inventoryRepo || typeof ctx.inventoryRepo.getQty !== "function") {
    if (!settings.failClosed) {
      safeEmitDebug("guard.inventory.repo.missing", { sessionId: safeId(session) });
      return { allowed: true, guard: "inventory" };
    }
    return {
      allowed: false,
      guard: "inventory",
      reason: "inventory_repo_missing",
      message:
        "Inventory repository unavailable. Unable to verify supplies for this step.",
    };
  }

  // Pull requirements
  const requirements = normalizeRequirements(step, session, ctx);
  if (requirements.length === 0) {
    return { allowed: true, guard: "inventory" };
  }

  const shortages = [];

  for (const req of requirements) {
    // 1) Try primary key, else alternatives if allowed.
    const keysToCheck = [req.key, ...(settings.allowAlternatives ? (req.alternatives || []) : [])]
      .filter(Boolean);

    let satisfied = false;
    let usedAlt = null;

    for (const key of keysToCheck) {
      // eslint-disable-next-line no-await-in-loop
      const snapshot = await ctx.inventoryRepo.getQty(key).catch(() => null);

      // If no record exists, treat as 0 available for this key and try next alt.
      const haveQty = snapshot?.qty ?? 0;
      const haveUnit = snapshot?.unit ?? null;

      const ok = compareQty(
        haveQty,
        haveUnit,
        req.qty,
        req.unit ?? settings.defaultUnit,
        ctx.unitConverter,
        settings.minFraction
      );

      if (ok) {
        satisfied = true;
        usedAlt = key !== req.key ? key : null;
        break;
      }
    }

    if (!satisfied) {
      // Capture the best "have" snapshot for the primary key (for UI).
      const snap = await ctx.inventoryRepo.getQty(req.key).catch(() => null);
      shortages.push({
        key: req.key,
        needQty: toNumberOr(req.qty, 1),
        needUnit: req.unit ?? settings.defaultUnit ?? null,
        haveQty: toNumberOr(snap?.qty, 0),
        haveUnit: snap?.unit ?? null,
        usedAlternative: usedAlt,
        note: req.note,
      });
    }
  }

  if (shortages.length > 0) {
    const msg = buildShortageMessage(shortages, ctx.inventoryRepo);
    safeEmitDebug("guard.inventory.blocked", {
      sessionId: safeId(session),
      stepId: step?.id || null,
      shortages,
    });
    return {
      allowed: false,
      guard: "inventory",
      reason: "inventory_shortage",
      message: msg,
      missing: shortages,
    };
  }

  return { allowed: true, guard: "inventory" };
}

/* --------------------------------- Helpers -------------------------------- */

function isGuardEnabled(settings) {
  const fromSettings =
    typeof settings?.enabled === "boolean" ? settings.enabled : undefined;
  if (typeof fromSettings === "boolean") return fromSettings;

  try {
    if (featureFlags && Object.prototype.hasOwnProperty.call(featureFlags, "inventoryGuard")) {
      return !!featureFlags.inventoryGuard;
    }
  } catch {
    // ignore
  }
  return true; // default ON
}

/**
 * @param {GuardContext["settings"]} s
 */
function withDefaults(s) {
  const d = {
    enabled: true,
    failClosed: false,
    defaultUnit: null,
    allowAlternatives: true,
    minFraction: 1.0,
  };
  return Object.assign({}, d, s || {});
}

/**
 * Build user-friendly shortage message with labels where available.
 * @param {NonNullable<GuardResult["missing"]>} shortages
 * @param {InventoryRepo} repo
 */
function buildShortageMessage(shortages, repo) {
  const lines = shortages.map((sh) => {
    const label = typeof repo?.label === "function" ? repo.label(sh.key) : sh.key;
    const needed = qtyFmt(sh.needQty, sh.needUnit);
    const have = qtyFmt(sh.haveQty, sh.haveUnit);
    return `• ${label}: need ${needed}, have ${have}`;
  });
  return `Not enough inventory:\n${lines.join("\n")}\nAdd items or choose substitutions, then try again.`;
}

function qtyFmt(qty, unit) {
  if (unit) return `${stripTrailingZeros(qty)} ${unit}`;
  return `${stripTrailingZeros(qty)}`;
}

function stripTrailingZeros(n) {
  const s = String(n);
  return s.indexOf(".") >= 0 ? s.replace(/\.?0+$/, "") : s;
}

/**
 * Resolve a step for evaluation.
 * @param {Session} session
 * @param {number} stepIndex
 * @returns {SessionStep|null}
 */
function resolveStep(session, stepIndex) {
  if (!session || !Array.isArray(session.steps) || session.steps.length === 0) return null;
  if (typeof stepIndex === "number" && stepIndex >= 0 && stepIndex < session.steps.length) {
    return session.steps[stepIndex];
  }
  const idx =
    Number.isFinite(session?.progress?.currentStepIndex) && session.progress.currentStepIndex >= 0
      ? session.progress.currentStepIndex
      : 0;
  return session.steps[idx] || null;
}

/**
 * @param {SessionStep|undefined|null} step
 * @param {string} blocker
 */
function hasBlocker(step, blocker) {
  if (!step || !Array.isArray(step.blockers)) return false;
  return step.blockers.includes(blocker);
}

/**
 * Merge multiple possible requirement sources into a single normalized list.
 * @param {SessionStep|null} step
 * @param {Session} session
 * @param {GuardContext} ctx
 * @returns {Array<{ key: string, qty: number, unit: string|null, note?: string, alternatives?: string[] }>}
 */
function normalizeRequirements(step, session, ctx) {
  /** @type {Array<{ key: string, qty: number, unit: string|null, note?: string, alternatives?: string[] }>} */
  const out = [];

  // 1) Preferred: requiredInventory
  const explicit = Array.isArray(step?.metadata?.requiredInventory) ? step.metadata.requiredInventory : [];
  for (const item of explicit) {
    const key = typeof item?.key === "string" ? item.key.trim() : "";
    if (!key) continue;
    out.push({
      key,
      qty: toNumberOr(item.qty, 1),
      unit: item.unit ?? null,
      note: item.note,
      alternatives: Array.isArray(item.alternatives) ? item.alternatives.filter(Boolean) : [],
    });
  }

  // 2) Heuristic by domain-specific lists (ingredients/supplies) — only if nothing explicit provided.
  if (out.length === 0) {
    // Cooking ingredients
    if (Array.isArray(step?.metadata?.ingredients)) {
      for (const ing of step.metadata.ingredients) {
        const k = tryNameToKey(ing?.name, ctx.normalizers?.ingredientToKey);
        if (!k) continue;
        out.push({
          key: k,
          qty: toNumberOr(ing?.amount, 1),
          unit: ing?.unit ?? null,
          note: "ingredient",
        });
      }
    }
    // Cleaning supplies
    if (Array.isArray(step?.metadata?.supplies)) {
      for (const sp of step.metadata.supplies) {
        const k = tryNameToKey(sp?.name, ctx.normalizers?.supplyToKey);
        if (!k) continue;
        out.push({
          key: k,
          qty: toNumberOr(sp?.amount, 1),
          unit: sp?.unit ?? null,
          note: "supply",
        });
      }
    }
  }

  // Dedupe by key+unit (sum quantities)
  return coalesceRequirements(out, ctx.unitConverter);
}

/**
 * Combine duplicate requirements and attempt to unify units.
 * @param {Array<{ key: string, qty: number, unit: string|null }>} list
 * @param {UnitConverter} unitConverter
 */
function coalesceRequirements(list, unitConverter) {
  /** @type {Record<string, { key: string, qty: number, unit: string|null, note?: string, alternatives?: string[] }>} */
  const map = {};
  for (const it of list) {
    const key = it.key;
    const sig = `${key}|${it.unit ?? ""}`;
    if (!map[sig]) {
      map[sig] = { ...it, qty: toNumberOr(it.qty, 1) };
    } else {
      // If same unit, just add.
      if (sameUnit(map[sig].unit, it.unit)) {
        map[sig].qty += toNumberOr(it.qty, 0);
      } else if (unitConverter && it.unit && map[sig].unit) {
        // Try convert incoming to existing unit.
        const conv = unitConverter.convert(toNumberOr(it.qty, 0), it.unit, map[sig].unit);
        if (conv) {
          map[sig].qty += conv.qty;
        } else {
          // Can't convert → create a new bucket
          const altSig = `${key}|${it.unit}`;
          if (!map[altSig]) map[altSig] = { ...it, qty: toNumberOr(it.qty, 1) };
          else map[altSig].qty += toNumberOr(it.qty, 0);
        }
      } else {
        // No converter or units null → add raw
        map[sig].qty += toNumberOr(it.qty, 0);
      }
    }
  }
  return Object.values(map);
}

/**
 * Compare available vs needed with conversion where possible.
 * @param {number} haveQty
 * @param {string|null} haveUnit
 * @param {number} needQty
 * @param {string|null} needUnit
 * @param {UnitConverter} unitConverter
 * @param {number} minFraction
 */
function compareQty(haveQty, haveUnit, needQty, needUnit, unitConverter, minFraction) {
  const need = toNumberOr(needQty, 1);
  const have = toNumberOr(haveQty, 0);

  if (sameUnit(haveUnit, needUnit)) {
    return have >= need * minFraction;
  }

  if (unitConverter && (needUnit || haveUnit)) {
    // Try convert have → needUnit
    if (haveUnit && needUnit) {
      const conv = unitConverter.convert(have, haveUnit, needUnit);
      if (conv) return conv.qty >= need * minFraction;
      // Try opposite direction: convert need → haveUnit
      const conv2 = unitConverter.convert(need, needUnit, haveUnit);
      if (conv2) return have >= conv2.qty * minFraction;
    }
  }

  // Unknown conversion → be conservative: not enough if units don't match
  return false;
}

function sameUnit(a, b) {
  const na = normUnit(a);
  const nb = normUnit(b);
  return na === nb;
}

function normUnit(u) {
  if (!u) return null;
  const s = String(u).trim().toLowerCase();
  // Minimal aliases (extend via real converter)
  switch (s) {
    case "grams": return "g";
    case "kilograms": return "kg";
    case "milliliters": return "ml";
    case "liters": return "l";
    case "ounce":
    case "ounces": return "oz";
    case "pounds":
    case "lb":
    case "lbs": return "lb";
    case "piece":
    case "pieces":
    case "count":
    case "ea":
    case "each": return "pcs";
    default: return s;
  }
}

function toNumberOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function tryNameToKey(name, fn) {
  const s = typeof name === "string" ? name.trim() : "";
  if (!s) return null;
  if (typeof fn === "function") {
    const k = fn(s);
    if (k) return k;
  }
  // Fallback: normalized name
  return s.toLowerCase().replace(/\s+/g, ".").replace(/[^a-z0-9._-]/g, "");
}

function safeId(session) {
  return (session && typeof session.id === "string" && session.id) || null;
}

function safeEmitDebug(type, data) {
  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit({ type, ts: new Date().toISOString(), source: "inventoryGuard", data });
    }
  } catch {
    // no-op
  }
}

/* ----------------------------- Public API Shape ---------------------------- */

/**
 * Convenience for current step (session.progress.currentStepIndex).
 * @param {Session} session
 * @param {GuardContext} [ctx]
 * @returns {Promise<GuardResult>}
 */
export async function evaluateForCurrentStep(session, ctx) {
  const idx = safeStepIndex(session);
  return evaluateInventoryGuard(session, idx, ctx);
}

function safeStepIndex(session) {
  if (!session || !session.progress) return -1;
  const i = Number(session.progress.currentStepIndex);
  return Number.isFinite(i) && i >= 0 ? i : -1;
}

/* --------------------------------- Default -------------------------------- */

const inventoryGuard = {
  id: "inventory",
  evaluate: evaluateInventoryGuard,
  evaluateForCurrentStep,
};

export default inventoryGuard;

/* --------------------------------- Usage -----------------------------------
 * // In SessionRunner (pseudo):
 * import inventoryGuard from "@/features/session/session.guards/inventory";
 *
 * async function guardCheck(session, stepIndex) {
 *   const res = await inventoryGuard.evaluate(session, stepIndex, {
 *     inventoryRepo: {
 *       getQty: (key) => db.inventory.getQtyByKey(key), // implement in your Dexie repo
 *       label: (key) => labelFromCatalog(key),          // optional, for nicer UI
 *     },
 *     unitConverter: {
 *       convert(qty, from, to) {
 *         // Plug your converter here (e.g., "g"↔"kg", "ml"↔"l", "oz"↔"g" (density-free),
 *         // or extend with density maps for flour/sugar/oil if available).
 *         // Return null if unknown.
 *         return simpleUnitConvert(qty, from, to);
 *       }
 *     },
 *     normalizers: {
 *       ingredientToKey: (name) => myIngredientKeyIndex[name.toLowerCase()] || null,
 *       supplyToKey: (name) => mySupplyKeyIndex[name.toLowerCase()] || null,
 *     },
 *     settings: {
 *       // enabled: true,
 *       // failClosed: false,
 *       // defaultUnit: null,
 *       // allowAlternatives: true,
 *       // minFraction: 1.0,
 *     },
 *   });
 *   if (!res.allowed) {
 *     // Show shortages list (res.missing). Offer:
 *     //  - "Open Substitutions" pane (domain-aware),
 *     //  - "Add to Shopping List",
 *     //  - "Adjust Recipe/Plan",
 *     //  - "Retry Check".
 *   }
 * }
 *
 * // Example simple converter (optional) you can place in a shared util:
 * function simpleUnitConvert(qty, from, to) {
 *   const a = (from||"").toLowerCase(); const b = (to||"").toLowerCase();
 *   if (!a || !b || a === b) return { qty, unit: b||a||null };
 *   const map = {
 *     g: { kg: 1/1000, oz: 1/28.3495, lb: 1/453.592 },
 *     kg: { g: 1000, oz: 35.274, lb: 2.20462 },
 *     ml: { l: 1/1000 },
 *     l: { ml: 1000 },
 *     oz: { g: 28.3495, lb: 1/16 },
 *     lb: { g: 453.592, oz: 16 },
 *   };
 *   if (map[a] && map[a][b]) return { qty: qty * map[a][b], unit: b };
 *   return null; // unknown
 * }
 * -------------------------------------------------------------------------- */
