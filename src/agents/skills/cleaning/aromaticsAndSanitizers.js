/**
 * src/agents/skills/cleaning/aromaticsAndSanitizers.js
 *
 * How this fits:
 * - Used by Cleaning compose/planner and SessionRunner to:
 *   • honor household fragrance/irritant preferences (aromatics policy),
 *   • compute sanitizer dilution and EPA-style contact/dwell times,
 *   • prevent dangerous chemical mixes (bleach+ammonia, acids, etc.),
 *   • auto-annotate steps with ventilation/PPE cues and "timer" dwell hints,
 *   • suggest safe substitutions when a product violates policy or is unavailable.
 *
 * Contracts touched:
 * - Accepts Session-like steps (cleaning domain) or plan-like tasks.
 * - Produces sanitized step metadata additions (cueNotes, donenessCue="timer", temp tips N/A).
 * - Emits optional analytics events via eventBus.
 *
 * Extension points:
 * - registerAromaticProfile(name, profile)
 * - registerSanitizer(name, profile)
 * - registerSurfacePolicy(surface, policy)
 * - addCompatibilityRule(fn)
 * - addVentilationAdvisor(fn)
 *
 * Defensive notes:
 * - Never mutates inputs; returns cloned/annotated structures.
 * - Falls back gracefully when unknown products/surfaces are encountered.
 */

import { emit } from "@/services/events/eventBus"; // safe-optional, swallowed if not present

/* --------------------------------- Types ---------------------------------- */
/**
 * @typedef {Object} AromaticsPrefs
 * @property {boolean} [fragranceFree]          // true → remove scents where possible
 * @property {boolean} [avoidAerosols]          // true → prefer pump/squeeze
 * @property {boolean} [asthmaSensitive]        // asthma/COPD sensitivity
 * @property {Array<string>} [disallowedNotes]  // e.g., ["citrus","pine","floral"]
 * @property {Array<string>} [allowedBrands]
 * @property {Array<string>} [disallowedBrands]
 */

/**
 * @typedef {Object} SessionStep
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {number} durationSec
 * @property {Array<string>} blockers
 * @property {{ supplies?: string[], equipment?: string[], outdoor?: boolean, cueNotes?: string, donenessCue?: string }} metadata
 */

/* ---------------------------- Aromatics Registry --------------------------- */
/**
 * Profile: {
 *   family: "citrus"|"pine"|"floral"|"herbal"|"unscented",
 *   volatility: "low"|"medium"|"high",   // for ventilation hints
 *   aerosolOnly?: boolean,               // if primarily sold as aerosol
 *   commonBrands?: string[],             // for brand allow/deny matching
 *   synonyms?: string[]                  // name matching
 * }
 */
const AROMATICS = new Map();

export function registerAromaticProfile(name, profile) {
  const key = norm(name);
  if (!key || !profile) return;
  const cur = AROMATICS.get(key) || {};
  AROMATICS.set(key, { ...cur, ...profile });
}

/* Seed common aromatic families */
registerAromaticProfile("citrus", {
  family: "citrus",
  volatility: "high",
  synonyms: ["lemon", "orange", "lime", "citrus"],
});
registerAromaticProfile("pine", {
  family: "pine",
  volatility: "medium",
  synonyms: ["pine", "conifer", "evergreen"],
});
registerAromaticProfile("floral", { family: "floral", volatility: "medium" });
registerAromaticProfile("herbal", {
  family: "herbal",
  volatility: "low",
  synonyms: ["thyme", "lavender", "tea tree", "eucalyptus"],
});
registerAromaticProfile("unscented", {
  family: "unscented",
  volatility: "low",
});

/* ---------------------------- Sanitizers Registry -------------------------- */
/**
 * Sanitizer profile:
 * {
 *   kind: "bleach"|"quat"|"alcohol"|"peroxide"|"acidic"|"vinegar",
 *   label: "Sodium hypochlorite 5-6%" | ...,
 *   stockConc: number,           // fraction (e.g., 0.055 for 5.5% bleach)
 *   targetConc: number,          // ready-to-use fraction (e.g., 0.0001 = 1000 ppm)
 *   epaDwellSec: number,         // contact time in seconds (heuristic defaults if unknown)
 *   notForSurfaces?: string[],   // e.g., ["natural stone","wool","unfinished wood"]
 *   okForSurfaces?: string[],    // whitelists if desired
 *   minTempF?: number,           // some quats require >60F, alcohol effective >65% v/v
 *   aerosol?: boolean,           // if typical form is an aerosol
 *   notes?: string
 * }
 */
const SANITIZERS = new Map();

export function registerSanitizer(name, profile) {
  const key = norm(name);
  if (!key || !profile) return;
  const cur = SANITIZERS.get(key) || {};
  SANITIZERS.set(key, { ...cur, ...profile });
}

/* Built-in sanitizer heuristics (defaults; adjust to your label data as needed) */
registerSanitizer("bleach", {
  kind: "bleach",
  label: "Sodium hypochlorite ~5.25–6%",
  stockConc: 0.055,
  targetConc: 0.0001, // ~1000 ppm for household disinfection
  epaDwellSec: 60, // 1 min common; some labels longer — override per brand if needed
  notForSurfaces: ["wool", "silk", "unsealed wood", "stone (marble/granite)"],
  notes: "Never mix with ammonia or acids. Rinse food-contact surfaces.",
});

registerSanitizer("quat", {
  kind: "quat",
  label: "Quaternary ammonium compound",
  stockConc: 0.01,
  targetConc: 0.0002, // example 200 ppm
  epaDwellSec: 600, // often 10 min; check label
  notForSurfaces: ["unfinished wood"],
  notes: "Some pathogens require longer dwell; check label.",
});

registerSanitizer("alcohol", {
  kind: "alcohol",
  label: "Ethyl/Isopropyl 70% v/v",
  stockConc: 0.7,
  targetConc: 0.7, // use as sold
  epaDwellSec: 30, // 30-60s typical
  notForSurfaces: ["unfinished wood", "acrylic (crazing risk)"],
  notes: "Highly flammable; ensure ventilation.",
});

registerSanitizer("peroxide", {
  kind: "peroxide",
  label: "Hydrogen peroxide 3%",
  stockConc: 0.03,
  targetConc: 0.03,
  epaDwellSec: 60,
  notForSurfaces: ["unfinished wood"],
  notes: "Do not mix with vinegar; forms peracetic acid.",
});

registerSanitizer("vinegar", {
  kind: "vinegar",
  label: "Acetic acid ~5%",
  stockConc: 0.05,
  targetConc: 0.05,
  epaDwellSec: 0, // not an EPA-registered disinfectant; treat as cleaner only
  notForSurfaces: ["stone (marble/granite)", "egg mess (sets protein)"],
  notes: "Not an EPA-registered disinfectant; avoid with bleach or peroxide.",
});

/* -------------------------- Surface Policy Registry ------------------------ */
/**
 * Surface policy:
 * {
 *   name: "natural stone",
 *   forbid: ["acidic","bleach"],   // sanitizer kinds not allowed
 *   prefer: ["alcohol","quat","peroxide"],
 *   note?: "why"
 * }
 */
const SURFACE_POLICY = new Map();

export function registerSurfacePolicy(surfaceName, policy) {
  const key = norm(surfaceName);
  if (!key || !policy) return;
  const cur = SURFACE_POLICY.get(key) || {};
  SURFACE_POLICY.set(key, { ...cur, ...policy });
}

/* Common surfaces */
registerSurfacePolicy("natural stone", {
  name: "natural stone",
  forbid: ["acidic", "bleach", "vinegar"],
  prefer: ["quat", "alcohol", "peroxide"],
  note: "Acids etch; bleach can discolor.",
});
registerSurfacePolicy("unfinished wood", {
  name: "unfinished wood",
  forbid: ["alcohol", "bleach", "quat"],
  prefer: ["peroxide"],
  note: "Avoid swelling/drying; spot test.",
});
registerSurfacePolicy("food contact", {
  name: "food contact",
  forbid: [],
  prefer: ["bleach", "quat", "peroxide", "alcohol"],
  note: "Rinse if label requires.",
});

/* --------------------------- Compatibility Rules --------------------------- */

const COMPAT_RULES = [];
/**
 * Rule fn signature: (products:string[]) => { ok:boolean, warnings:string[], hazards:string[] }
 */
export function addCompatibilityRule(fn) {
  if (typeof fn === "function") COMPAT_RULES.push(fn);
}

/* Built-ins: dangerous mixes */
addCompatibilityRule((prods) => {
  const L = prods.map(norm);
  const has = (k) => L.some((p) => p.includes(k));
  /** @type {{ok:boolean,warnings:string[],hazards:string[]}} */
  const out = { ok: true, warnings: [], hazards: [] };
  if (has("bleach") && (has("ammonia") || has("quat"))) {
    out.ok = false;
    out.hazards.push(
      "Do NOT mix bleach with ammonia/quats: toxic chloramines."
    );
  }
  if (has("bleach") && (has("vinegar") || has("acid") || has("toilet bowl"))) {
    out.ok = false;
    out.hazards.push(
      "Do NOT mix bleach with acids (vinegar/toilet cleaners): chlorine gas."
    );
  }
  if (has("peroxide") && has("vinegar")) {
    out.ok = false;
    out.hazards.push(
      "Do NOT combine peroxide with vinegar: forms peracetic acid."
    );
  }
  return out;
});

/* --------------------------- Ventilation Advisors -------------------------- */
/**
 * Advisor fn signature:
 * ({ step, aromaticsMatch, sanitizerProfile }) => { cue?:string, ppe?:string[], requireOutdoor?:boolean }
 */
const VENT_ADVISORS = [];

export function addVentilationAdvisor(fn) {
  if (typeof fn === "function") VENT_ADVISORS.push(fn);
}

/* Built-ins */
addVentilationAdvisor(({ aromaticsMatch, sanitizerProfile }) => {
  const out = {};
  if (aromaticsMatch?.volatility === "high") {
    out.cue =
      "Open a window or run exhaust fan while using high-volatility cleaners.";
  }
  if (sanitizerProfile?.kind === "alcohol") {
    out.cue =
      (out.cue ? out.cue + " " : "") +
      "Keep away from flames/heat; allow vapors to disperse.";
  }
  if (
    sanitizerProfile?.kind === "bleach" ||
    sanitizerProfile?.kind === "quat"
  ) {
    out.ppe = ["gloves"];
  }
  return out;
});

/* ----------------------------- Public API ---------------------------------- */

/**
 * Evaluate a fragrance/aromatics policy against a product name.
 * @param {string} productName
 * @param {AromaticsPrefs} prefs
 * @returns {{ allowed:boolean, reason?:string, suggested?:string }}
 */
export function evaluateAromaticsPolicy(productName, prefs = {}) {
  const name = norm(productName);
  if (!name) return { allowed: true };

  // fragrance-free supersedes
  if (prefs.fragranceFree) {
    if (!/unscented|fragrance\s*free/i.test(productName)) {
      return {
        allowed: false,
        reason: "Household is fragrance free",
        suggested: toUnscented(productName),
      };
    }
  }

  // brand allow/deny
  if (
    Array.isArray(prefs.disallowedBrands) &&
    brandMatch(productName, prefs.disallowedBrands)
  ) {
    return { allowed: false, reason: "Brand disallowed" };
  }
  if (
    Array.isArray(prefs.allowedBrands) &&
    !brandMatch(productName, prefs.allowedBrands)
  ) {
    // If allow list exists, deny unmatched scented items unless "unscented"
    if (!/unscented|fragrance\s*free/i.test(productName)) {
      return {
        allowed: false,
        reason: "Brand not on allow-list",
        suggested: toUnscented(productName),
      };
    }
  }

  // aromatic family deny
  const fam = matchAromaticFamily(productName);
  if (
    fam &&
    Array.isArray(prefs.disallowedNotes) &&
    prefs.disallowedNotes.some((n) => fam.family === norm(n))
  ) {
    return {
      allowed: false,
      reason: `Disallowed aromatic note: ${fam.family}`,
      suggested: "unscented",
    };
  }

  // aerosols
  if (
    prefs.avoidAerosols &&
    /aerosol|propellant|spray can/i.test(productName)
  ) {
    return {
      allowed: false,
      reason: "Aerosol avoided by preference",
      suggested: "pump/squeeze bottle variant",
    };
  }

  // asthma sensitivity: prefer low volatility
  if (prefs.asthmaSensitive && fam?.volatility === "high") {
    return {
      allowed: false,
      reason: "High volatility not recommended for asthma",
      suggested: "unscented/low-VOC alternative",
    };
  }

  return { allowed: true };
}

/**
 * Compute sanitizer dilution for making ready-to-use solution.
 * @param {string} sanitizerName  (e.g., "bleach")
 * @param {{ desiredConc?:number, batchVolumeMl?:number }} opts
 * @returns {{ stockMl:number, waterMl:number, targetConc:number, batchVolumeMl:number, note?:string }}
 */
export function computeDilution(sanitizerName, opts = {}) {
  const s = SANITIZERS.get(norm(sanitizerName));
  if (!s)
    return {
      stockMl: 0,
      waterMl: 0,
      targetConc: 0,
      batchVolumeMl: 0,
      note: "Unknown sanitizer",
    };
  const target = Number.isFinite(opts.desiredConc)
    ? opts.desiredConc
    : s.targetConc;
  const batch = Math.max(1, Math.round(Number(opts.batchVolumeMl) || 1000));

  // simple C1V1 = C2V2
  const stockMl = (target / (s.stockConc || 1)) * batch;
  const clampStock = clampNum(stockMl, 0, batch);
  const waterMl = Math.max(0, batch - clampStock);
  return {
    stockMl: round(clampStock, 1),
    waterMl: round(waterMl, 1),
    targetConc: target,
    batchVolumeMl: batch,
    note: s.notes || "",
  };
}

/**
 * Get contact/dwell time for a sanitizer and annotate a step accordingly.
 * @param {string} sanitizerName
 * @param {{ surface?:string, labelOverrideSec?:number }} [opts]
 * @returns {{ dwellSec:number, warnings:string[], surfaceOk:boolean }}
 */
export function getDwellTime(sanitizerName, opts = {}) {
  const s = SANITIZERS.get(norm(sanitizerName));
  if (!s)
    return { dwellSec: 0, warnings: ["Unknown sanitizer"], surfaceOk: true };

  const dwell = Math.max(
    0,
    Math.round(Number(opts.labelOverrideSec || s.epaDwellSec || 0))
  );
  const warn = [];

  if (opts.surface) {
    const surf = SURFACE_POLICY.get(norm(opts.surface));
    if (surf && Array.isArray(surf.forbid) && surf.forbid.includes(s.kind)) {
      warn.push(`Not recommended on ${surf.name || opts.surface}`);
      return { dwellSec: dwell, warnings: warn, surfaceOk: false };
    }
  }
  return { dwellSec: dwell, warnings: warn, surfaceOk: true };
}

/**
 * Check chemical compatibility for a set of products.
 * @param {string[]} productNames
 * @returns {{ ok:boolean, warnings:string[], hazards:string[] }}
 */
export function checkCompatibility(productNames = []) {
  const names = (productNames || []).map(String).filter(Boolean);
  /** @type {{ ok:boolean, warnings:string[], hazards:string[] }} */
  const agg = { ok: true, warnings: [], hazards: [] };
  for (const fn of COMPAT_RULES) {
    const res = safeCall(fn, names) || { ok: true, warnings: [], hazards: [] };
    if (!res.ok) agg.ok = false;
    if (Array.isArray(res.warnings)) agg.warnings.push(...res.warnings);
    if (Array.isArray(res.hazards)) agg.hazards.push(...res.hazards);
  }
  return agg;
}

/**
 * Suggest safe substitutions based on aromatics policy and sanitizer/surface rules.
 * @param {string} productName
 * @param {{ prefs?:AromaticsPrefs, surface?:string }} [opts]
 * @returns {{ name:string, reason?:string }|null}
 */
export function suggestSubstitution(productName, opts = {}) {
  const { prefs = {}, surface } = opts;
  // Aromatics gate first
  const arom = evaluateAromaticsPolicy(productName, prefs);
  if (!arom.allowed) {
    return { name: arom.suggested || "unscented variant", reason: arom.reason };
  }
  // Surface gate: prefer policy "prefer" kinds if current violates
  if (surface) {
    const surf = SURFACE_POLICY.get(norm(surface));
    const s = SANITIZERS.get(norm(productName));
    if (
      surf &&
      s &&
      Array.isArray(surf.forbid) &&
      surf.forbid.includes(s.kind)
    ) {
      const kind = surf.prefer?.[0];
      const alt = kind ? findSanitizerByKind(kind) : null;
      if (alt) return { name: alt.name, reason: `Preferred for ${surf.name}` };
    }
  }
  return null;
}

/**
 * Annotate session steps: adds dwell timers, ventilation/PPE, and warnings.
 * Does NOT mutate; returns new array.
 * @param {SessionStep[]} steps
 * @param {{ prefs?:AromaticsPrefs, surface?:string }} [opts]
 * @returns {{ steps:SessionStep[], notes:string[] }}
 */
export function applyAromaticsAndSanitizersToSteps(steps = [], opts = {}) {
  const prefs = opts.prefs || {};
  const notes = [];
  const out = steps.map((s) => clone(s));

  for (const step of out) {
    const supplies = Array.isArray(step?.metadata?.supplies)
      ? step.metadata.supplies
      : [];
    if (!supplies.length) continue;

    // Compatibility check across all listed supplies in the step
    const comp = checkCompatibility(supplies);
    if (!comp.ok) {
      step.blockers = Array.from(
        new Set([...(step.blockers || []), "equipment"])
      );
      addNote(
        notes,
        `Compatibility hazard in step "${step.title}": ${comp.hazards.join(
          " "
        )}`
      );
    }

    for (const name of supplies) {
      // Fragrance policy
      const arom = evaluateAromaticsPolicy(name, prefs);
      if (!arom.allowed) {
        addNote(
          notes,
          `Fragrance policy: "${name}" → ${arom.reason}. Suggest: ${
            arom.suggested || "unscented"
          }.`
        );
      }

      // Sanitizer dwell & ventilation
      const san = SANITIZERS.get(norm(name));
      const fam = matchAromaticFamily(name);
      const vent = runVentAdvisors({
        step,
        aromaticsMatch: fam,
        sanitizerProfile: san,
      });

      if (san) {
        const dwell = getDwellTime(name, { surface: opts.surface });
        if (dwell.dwellSec > 0) {
          step.metadata = step.metadata || {};
          step.metadata.donenessCue = "timer";
          step.metadata.cueNotes = joinCues(
            step.metadata.cueNotes,
            `Maintain wet contact for ${formatSeconds(dwell.dwellSec)}.`
          );
          step.durationSec = Math.max(step.durationSec || 0, dwell.dwellSec);
        }
        if (!dwell.surfaceOk) {
          addNote(
            notes,
            `Surface caution: ${name} not recommended on ${
              opts.surface || "this surface"
            }.`
          );
        }
      }

      if (vent?.cue) {
        step.metadata = step.metadata || {};
        step.metadata.cueNotes = joinCues(step.metadata.cueNotes, vent.cue);
      }
      if (Array.isArray(vent?.ppe) && vent.ppe.length) {
        step.metadata = step.metadata || {};
        step.metadata.cueNotes = joinCues(
          step.metadata.cueNotes,
          `PPE: ${vent.ppe.join(", ")}`
        );
      }
    }
  }

  // Emit analytics (safe)
  try {
    emit?.({
      type: "cleaning.aromatics.applied",
      ts: new Date().toISOString(),
      source: "cleaning.aromaticsAndSanitizers",
      data: { steps: steps.length, notes: notes.length },
    });
  } catch {}

  return { steps: out, notes };
}

/* ------------------------------ Small Helpers ------------------------------ */

function matchAromaticFamily(productName) {
  const low = norm(productName);
  for (const [key, prof] of AROMATICS) {
    if (low.includes(key)) return prof;
    if (
      Array.isArray(prof.synonyms) &&
      prof.synonyms.some((s) => low.includes(norm(s)))
    )
      return prof;
  }
  return null;
}

function brandMatch(productName, list) {
  const low = productName.toLowerCase();
  return list.some((b) => low.includes(String(b).toLowerCase()));
}

function toUnscented(name) {
  const base = name
    .replace(/\b(lemon|citrus|lavender|pine|floral|fresh)\b/gi, "")
    .trim();
  return `${base} (Unscented)`.replace(/\s+/g, " ").trim();
}

function findSanitizerByKind(kind) {
  for (const [name, s] of SANITIZERS)
    if (s.kind === kind) return { name, profile: s };
  return null;
}

function runVentAdvisors(ctx) {
  let cue = "";
  let ppe = [];
  for (const fn of VENT_ADVISORS) {
    const res = safeCall(fn, ctx);
    if (!res) continue;
    if (res.cue) cue = cue ? `${cue} ${res.cue}` : res.cue;
    if (Array.isArray(res.ppe)) ppe = Array.from(new Set([...ppe, ...res.ppe]));
  }
  return { cue, ppe };
}

function joinCues(prev, next) {
  if (!prev) return next;
  if (!next) return prev;
  return `${prev} ${next}`.trim();
}

function formatSeconds(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/* ------------------------------ Utils / Core ------------------------------- */

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .trim();
}
function addNote(buf, text) {
  if (text) buf.push(text);
}
function clone(v) {
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
}
function clampNum(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(v, min), max);
}
function round(n, places = 0) {
  const p = Math.pow(10, places);
  return Math.round(n * p) / p;
}
function safeCall(fn, ...args) {
  try {
    return fn?.(...args);
  } catch {
    return null;
  }
}

/* --------------------------------- Export ---------------------------------- */

export default {
  // Policy & evaluation
  evaluateAromaticsPolicy,
  suggestSubstitution,
  // Sanitizer math
  computeDilution,
  getDwellTime,
  checkCompatibility,
  // Step annotation
  applyAromaticsAndSanitizersToSteps,
  // Registries
  registerAromaticProfile,
  registerSanitizer,
  registerSurfacePolicy,
  addCompatibilityRule,
  addVentilationAdvisor,
};
