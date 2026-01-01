/**
 * src/agents/skills/cooking/cues.js
 *
 * How this fits:
 * - Used by cooking session composition and the SessionRunner "cues/tips" pane.
 * - Provides a single source of truth for doneness cues and safe probe temperatures.
 * - Parses freeform instruction text to infer cues (timer/texture/smell/probeTemp).
 * - Formats short and detailed tips for UI + speech (Web Speech).
 *
 * Contracts touched:
 * - Step.metadata: { tempTargetF?: number, donenessCue?: "color"|"texture"|"probeTemp"|"timer"|"smell", cueNotes?: string }
 *
 * Extension points:
 * - registerFoodProfile(name, profile) to add/override temp guidance.
 * - addCuePattern(patternFn) to teach new regex-based cue detectors.
 * - setDefaultOptions({ torahSafe: boolean }) to relax/enable Torah-safe filtering.
 * - setDonenessResolver(customFn) to override doneness → temp selection logic.
 */

/* ------------------------------- Defaults --------------------------------- */

const DEFAULTS = {
  torahSafe: true, // hide/ignore unclean items by default
};

/** Allow app-level override of defaults */
export function setDefaultOptions(opts = {}) {
  Object.assign(DEFAULTS, sanitizeObject(opts));
}

/* ----------------------------- Safe Temp Table ----------------------------- */
/**
 * FOOD_PROFILES structure:
 * {
 *   key: {
 *     label: string,
 *     torahSafe: boolean,
 *     probe: {
 *       safeMinF?: number, // food safety minimum
 *       cuts?: {
 *         [cutKey]: {
 *           safeMinF?: number,
 *           doneness?: {
 *             rare?: number, mediumRare?: number, medium?: number, mediumWell?: number, well?: number
 *           }
 *         }
 *       }
 *     },
 *     texture?: string[], // optional non-probe cues
 *   }
 * }
 *
 * Notes:
 * - Values reflect common culinary guidance; safety minimums are conservative.
 * - Keep pork/shellfish entries out (Torah-safe). They can be registered app-side if needed.
 */
const FOOD_PROFILES = new Map();

// Beef / Lamb / Goat (steaks/roasts/chops)
registerFoodProfile("beef", {
  label: "Beef",
  torahSafe: true,
  probe: {
    safeMinF: 145, // serve-after-rest minimum for intact whole-muscle cuts
    cuts: {
      steak: { doneness: { rare: 120, mediumRare: 130, medium: 140, mediumWell: 150, well: 160 } },
      roast: { doneness: { mediumRare: 130, medium: 140, mediumWell: 150, well: 160 } },
      brisket: { doneness: { well: 200 } }, // collagen breakdown target for tenderness
    },
  },
});

registerFoodProfile("lamb", {
  label: "Lamb",
  torahSafe: true,
  probe: {
    safeMinF: 145,
    cuts: {
      chop: { doneness: { mediumRare: 130, medium: 140, mediumWell: 150 } },
      leg: { doneness: { medium: 140, mediumWell: 150 } },
      shoulder: { doneness: { well: 195 } },
    },
  },
});

registerFoodProfile("goat", {
  label: "Goat",
  torahSafe: true,
  probe: {
    safeMinF: 145,
    cuts: {
      stew: { doneness: { well: 190 } },
      leg: { doneness: { medium: 140, mediumWell: 150 } },
    },
  },
});

// Ground meats (beef/lamb/goat): higher safety target
registerFoodProfile("ground meat", {
  label: "Ground Meat",
  torahSafe: true,
  probe: { safeMinF: 160 },
});

// Poultry
registerFoodProfile("chicken", {
  label: "Chicken",
  torahSafe: true,
  probe: { safeMinF: 165 },
});
registerFoodProfile("turkey", {
  label: "Turkey",
  torahSafe: true,
  probe: { safeMinF: 165 },
});

// Fish (scaled generic; visual cue often preferred)
registerFoodProfile("fish", {
  label: "Fish",
  torahSafe: true,
  probe: { safeMinF: 145 }, // internal opaque & flakes easily
  texture: ["Opaque throughout", "Flakes with gentle pressure", "No translucent center"],
});

// Eggs / Bakes (internal targets for structure set)
registerFoodProfile("eggs", {
  label: "Eggs (custard/egg dishes)",
  torahSafe: true,
  probe: { safeMinF: 160 },
});
registerFoodProfile("bread", {
  label: "Bread",
  torahSafe: true,
  probe: { safeMinF: 190 }, // lean loaves ~190–205°F; enriched a bit lower
  texture: ["Hollow sound when tapped", "Deep golden crust"],
});
registerFoodProfile("cake", {
  label: "Cake",
  torahSafe: true,
  probe: { safeMinF: 200 }, // typical range 200–210°F
  texture: ["Skewer/toothpick comes out with few crumbs", "Springs back lightly"],
});

/* --------------------------- Registration API ----------------------------- */

/**
 * Register or override a food profile.
 * @param {string} name - canonical key (lowercase)
 * @param {object} profile - see structure above
 */
export function registerFoodProfile(name, profile) {
  const key = canonical(name);
  if (!key || !profile) return;
  const merged = mergeDeep(FOOD_PROFILES.get(key) || {}, profile);
  FOOD_PROFILES.set(key, merged);
}

/** Lookup by canonical key; returns undefined if not found or filtered out by Torah-safe mode. */
function getFoodProfile(key, { torahSafe = DEFAULTS.torahSafe } = {}) {
  const k = canonical(key);
  const prof = FOOD_PROFILES.get(k);
  if (!prof) return undefined;
  if (torahSafe && prof.torahSafe === false) return undefined;
  return prof;
}

/* ----------------------------- Doneness Logic ----------------------------- */

let customDonenessResolver = null;
/**
 * Optional override for doneness resolution.
 * @param {(ctx:{food:string, cut?:string, doneness?:string}) => number|undefined} fn
 */
export function setDonenessResolver(fn) {
  if (typeof fn === "function") customDonenessResolver = fn;
}

/**
 * Resolve a probe target temperature.
 * @param {string} foodKey - e.g., "lamb", "beef", "ground meat", "chicken", "fish", "bread", "cake"
 * @param {{ cut?: string, doneness?: "rare"|"mediumRare"|"medium"|"mediumWell"|"well", torahSafe?: boolean }} [opts]
 * @returns {number|undefined} tempF
 */
export function getProbeTargetF(foodKey, opts = {}) {
  const opt = Object.assign({ torahSafe: DEFAULTS.torahSafe }, sanitizeObject(opts));
  if (customDonenessResolver) {
    const r = Number(customDonenessResolver({ food: foodKey, cut: opt.cut, doneness: opt.doneness }));
    if (Number.isFinite(r)) return r;
  }
  const prof = getFoodProfile(foodKey, opt);
  if (!prof || !prof.probe) return undefined;

  const cutKey = canonical(opt.cut || "");
  const doneness = canonical(opt.doneness || "");
  const cuts = prof.probe.cuts || {};

  if (doneness && cutKey && cuts[cutKey]?.doneness?.[doneness] != null) {
    return clampInt(cuts[cutKey].doneness[doneness], 80, 250);
  }
  if (doneness && !cutKey) {
    // Search all cuts for a doneness match
    for (const c of Object.values(cuts)) {
      if (c?.doneness?.[doneness] != null) return clampInt(c.doneness[doneness], 80, 250);
    }
  }
  // Fallback to safe minimum if present
  if (prof.probe.safeMinF != null) return clampInt(prof.probe.safeMinF, 80, 250);
  return undefined;
}

/* ---------------------------- Cue Pattern Engine --------------------------- */

/**
 * Cue detector functions receive text and return:
 *   { tempTargetF?, donenessCue?, cueNotes? } or null
 */
const cuePatternFns = [];

/** Public: add a custom cue detector (regex/ML/etc.) */
export function addCuePattern(fn) {
  if (typeof fn === "function") cuePatternFns.push(fn);
}

/* Built-in detectors */
addCuePattern((text) => {
  const t = (text || "").toLowerCase();
  // Explicit internal temp mention
  const tm = t.match(/(\d{2,3})\s*°?\s*f\b.*(internal|center|probe|therm)/i);
  if (tm) {
    const tf = clampInt(parseInt(tm[1], 10), 80, 250);
    return { tempTargetF: tf, donenessCue: "probeTemp", cueNotes: `Cook to internal ${tf}°F` };
  }
  return null;
});
addCuePattern((text) => {
  const t = (text || "").toLowerCase();
  // Color/texture
  if (/until.*(golden|deep\s+golden|brown|mahogany|crisp|crusty|opaque|set|springy|thickened)/i.test(t)) {
    return { donenessCue: "texture", cueNotes: "Watch color/texture change" };
  }
  return null;
});
addCuePattern((text) => {
  const t = (text || "").toLowerCase();
  // Aroma
  if (/until.*(fragrant|aroma|aromatic|smell)/i.test(t)) {
    return { donenessCue: "smell", cueNotes: "Follow aroma development" };
  }
  return null;
});
addCuePattern((text) => {
  const t = (text || "").toLowerCase();
  // Time-only
  const d = parseDurationSec(t);
  if (d) {
    const mins = Math.max(1, Math.round(d / 60));
    return { donenessCue: "timer", cueNotes: `About ${mins} min` };
  }
  return null;
});

/**
 * Infer cues from free text; returns {} if none.
 * @param {string} text
 * @returns {{ tempTargetF?: number, donenessCue?: "color"|"texture"|"probeTemp"|"timer"|"smell", cueNotes?: string }}
 */
export function inferCuesFromText(text) {
  const info = {};
  for (const fn of cuePatternFns) {
    const res = safeCall(fn, text);
    if (res && typeof res === "object") Object.assign(info, res);
  }
  return info;
}

/* ------------------------------- UI Builders ------------------------------- */

/**
 * Build human-friendly tips for a step based on its metadata and optional food context.
 * @param {{ title?:string, desc?:string, metadata?:{ tempTargetF?:number, donenessCue?:string, cueNotes?:string } }} step
 * @param {{ food?: string, cut?: string, doneness?: string, torahSafe?: boolean }} [ctx]
 * @returns {string[]} ordered tips (short phrases)
 */
export function cueTipsForStep(step = {}, ctx = {}) {
  const tips = [];
  const md = step.metadata || {};

  // Probe temperature comes first if present or derivable
  const probeTarget =
    Number.isFinite(md.tempTargetF) ? md.tempTargetF : getProbeTargetF(ctx.food || "", ctx);

  if (probeTarget) tips.push(`Target internal: ${probeTarget}°F (${fToC(probeTarget)}°C)`);

  // Doneness cue label
  if (md.donenessCue) {
    const label = cueLabel(md.donenessCue);
    if (label) tips.push(`Doneness cue: ${label}`);
  }

  // Free notes
  if (md.cueNotes) tips.push(md.cueNotes);

  // If fish/bread/cake have texture guidance and no metadata provided, add defaults
  const prof = ctx.food ? getFoodProfile(ctx.food, ctx) : null;
  if (prof?.texture && !md.cueNotes) {
    for (const t of prof.texture) tips.push(t);
  }

  // Compact default if we have nothing
  if (!tips.length) {
    const inf = inferCuesFromText(step.desc || step.title || "");
    if (inf.tempTargetF) tips.push(`Target internal: ${inf.tempTargetF}°F`);
    if (inf.donenessCue) tips.push(`Doneness cue: ${cueLabel(inf.donenessCue)}`);
    if (inf.cueNotes) tips.push(inf.cueNotes);
  }

  return dedupeStr(tips);
}

/**
 * Very short single-line cue summary for headers/toasts.
 * @param {{ metadata?: { tempTargetF?:number, donenessCue?:string, cueNotes?:string }}} step
 * @returns {string}
 */
export function cueSummaryShort(step = {}) {
  const md = step.metadata || {};
  if (Number.isFinite(md.tempTargetF)) return `→ ${md.tempTargetF}°F`;
  if (md.donenessCue) return cueLabel(md.donenessCue);
  if (md.cueNotes) return md.cueNotes.length > 48 ? `${md.cueNotes.slice(0, 45)}…` : md.cueNotes;
  return "Follow cues";
}

/**
 * Build TTS-friendly speech text for the step cues.
 * @param {{ title?:string, desc?:string, metadata?:{ tempTargetF?:number, donenessCue?:string, cueNotes?:string } }} step
 * @param {{ food?:string, cut?:string, doneness?:string }} [ctx]
 * @returns {string}
 */
export function cueSpeech(step = {}, ctx = {}) {
  const tips = cueTipsForStep(step, ctx);
  const title = (step.title || "").trim();
  const lead = title ? `${title}. ` : "";
  // Keep speech concise; join the first 2–3 tips.
  return lead + tips.slice(0, 3).join(". ") + (tips.length ? "." : "");
}

/* ------------------------------ Public Helpers ----------------------------- */

export function fToC(f) {
  const c = (Number(f) - 32) * (5 / 9);
  return Math.round(c);
}

/**
 * Quick validator/sanitizer for step metadata; ensures keys align with contract.
 * @param {any} metadata
 * @returns {{ tempTargetF?: number, donenessCue?: "color"|"texture"|"probeTemp"|"timer"|"smell", cueNotes?: string }}
 */
export function normalizeStepCues(metadata) {
  const md = sanitizeObject(metadata);
  const out = {};
  if (Number.isFinite(md.tempTargetF)) out.tempTargetF = clampInt(md.tempTargetF, 80, 250);
  if (["color", "texture", "probeTemp", "timer", "smell"].includes(md.donenessCue)) out.donenessCue = md.donenessCue;
  if (typeof md.cueNotes === "string") out.cueNotes = md.cueNotes.trim();
  return out;
}

/**
 * Export minimal read-only snapshot of the internal table (for debugging/UI).
 * @returns {Record<string, any>}
 */
export function snapshotFoodProfiles() {
  const obj = {};
  for (const [k, v] of FOOD_PROFILES.entries()) obj[k] = clone(v);
  return obj;
}

/* -------------------------------- Internals -------------------------------- */

function cueLabel(key) {
  switch (key) {
    case "probeTemp": return "Use thermometer";
    case "texture": return "Texture/color";
    case "timer": return "Timer";
    case "smell": return "Aroma";
    case "color": return "Color";
    default: return "Cues";
  }
}

function parseDurationSec(text) {
  if (!text) return 0;
  const t = (text || "").toLowerCase();
  const hr = t.match(/(\d+(?:\.\d+)?)\s*(hour|hr|hrs)\b/);
  const mn = t.match(/(\d+(?:\.\d+)?)\s*(minute|min|mins)\b/);
  const sc = t.match(/(\d+(?:\.\d+)?)\s*(second|sec|secs)\b/);
  const rg = t.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–|—)\s*(\d+(?:\.\d+)?)/);
  let total = 0;
  if (hr) total += parseFloat(hr[1]) * 3600;
  if (mn) total += parseFloat(mn[1]) * 60;
  if (sc) total += parseFloat(sc[1]);
  if (!hr && !mn && !sc && rg) {
    const avg = (parseFloat(rg[1]) + parseFloat(rg[2])) / 2;
    total += avg * 60;
  }
  return total ? clampInt(total, 10, 8 * 3600) : 0;
}

function canonical(s) {
  return String(s || "").toLowerCase().trim();
}

function clampInt(n, min, max) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return undefined;
  return Math.max(min, Math.min(v, max));
}

function sanitizeObject(obj) {
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function mergeDeep(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return clone(patch);
  if (!base || typeof base !== "object") return clone(patch);
  const out = { ...base };
  for (const k of Object.keys(patch || {})) {
    const pv = patch[k];
    const bv = base[k];
    if (pv && typeof pv === "object" && !Array.isArray(pv)) out[k] = mergeDeep(bv || {}, pv);
    else out[k] = clone(pv);
  }
  return out;
}

function clone(v) {
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

function dedupeStr(arr) {
  return Array.from(new Set(arr.filter(Boolean).map((s) => String(s).trim()))).filter(Boolean);
}

/* --------------------------------- Exports -------------------------------- */

export default {
  // profiles / temps
  registerFoodProfile,
  getProbeTargetF,
  snapshotFoodProfiles,
  setDonenessResolver,
  // cues
  inferCuesFromText,
  cueTipsForStep,
  cueSummaryShort,
  cueSpeech,
  normalizeStepCues,
  // patterns & defaults
  addCuePattern,
  setDefaultOptions,
  // utils
  fToC,
};
