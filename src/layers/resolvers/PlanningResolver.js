/**
 * File: src/layers/resolvers/PlanningResolver.js
 * Purpose: intentCandidates + context => ranked planning pattern IDs + reasons
 *
 * Inputs:
 *  - intentCandidates: Array<{ domain?: string, methodId?: string, patternId?: string, tags?: string[], confidence?: number, tokens?: string[] }>
 *  - context: {
 *      inventorySnapshotAvailable?: boolean,
 *      quietHours?: { enabled?: boolean },
 *      fasting?: { enabled?: boolean },
 *      feast?: { active?: boolean, tags?: string[] },
 *      seasonTags?: string[],
 *      cultureTags?: string[],
 *      preferredDomains?: string[],
 *    }
 *
 * Output:
 *  - { ranked: Array<{ id, score, reasons: string[] }>, debug: { reasonsById, signals } }
 *
 * Deterministic and testable. No random behavior.
 */

import { normalizeText, sortRanked, addReason, clamp, safeArray } from "./_resolverUtils.js";

const PATTERNS = Object.freeze({
  meals: {
    weekly_batch: "pat.meals.weekly_batch",
    daily_fresh: "pat.meals.daily_fresh",
    feast_anchored: "pat.meals.feast_anchored",
    fast_day_light: "pat.meals.fast_day_light",
    preservation_first: "pat.meals.preservation_first",
  },
  storehouse: {
    weekly_restock: "pat.storehouse.weekly_restock",
    monthly_cycle_count: "pat.storehouse.monthly_cycle_count",
    feast_buffer_build: "pat.storehouse.feast_buffer_build",
    winter_reserve: "pat.storehouse.winter_reserve",
    root_cellar_optimizer: "pat.storehouse.root_cellar_optimizer",
  },
  homestead: {
    garden_led: "pat.homestead.garden_led",
    animal_led: "pat.homestead.animal_led",
    mixed_subsistence: "pat.homestead.mixed_subsistence",
    urban_homestead: "pat.homestead.urban_homestead",
  },
});

function baseScoresFromContext(context = {}) {
  const scores = {};
  // baseline priors
  scores[PATTERNS.meals.weekly_batch] = 0.35;
  scores[PATTERNS.meals.daily_fresh] = 0.25;
  scores[PATTERNS.meals.preservation_first] = 0.10;

  scores[PATTERNS.storehouse.weekly_restock] = 0.20;
  scores[PATTERNS.storehouse.monthly_cycle_count] = 0.12;

  scores[PATTERNS.homestead.mixed_subsistence] = 0.10;

  // context: inventory snapshot availability strongly helps storehouse + preservation-first patterns
  if (context.inventorySnapshotAvailable) {
    scores[PATTERNS.meals.preservation_first] += 0.12;
    scores[PATTERNS.storehouse.weekly_restock] += 0.10;
    scores[PATTERNS.storehouse.monthly_cycle_count] += 0.08;
  } else {
    // if not available, prefer daily_fresh and defer storehouse-heavy patterns
    scores[PATTERNS.meals.daily_fresh] += 0.08;
    scores[PATTERNS.storehouse.weekly_restock] -= 0.05;
  }

  // quiet hours / Sabbath: prefer make-ahead / batch; avoid noisy complex patterns by default
  if (context?.quietHours?.enabled) {
    scores[PATTERNS.meals.weekly_batch] += 0.08;
    scores[PATTERNS.meals.feast_anchored] += 0.04;
    scores[PATTERNS.meals.daily_fresh] -= 0.03;
  }

  // fasting mode: prefer fast_day pattern
  if (context?.fasting?.enabled) {
    scores[PATTERNS.meals.fast_day_light] += 0.20;
    scores[PATTERNS.meals.weekly_batch] -= 0.05;
  }

  // feast mode / tags
  const feastTags = safeArray(context?.feast?.tags);
  if (context?.feast?.active || feastTags.some(t => String(t).startsWith("feast:"))) {
    scores[PATTERNS.meals.feast_anchored] += 0.22;
    scores[PATTERNS.storehouse.feast_buffer_build] += 0.18;
  }

  // season tags: winter => reserve/root cellar; spring/summer/fall => garden/homestead
  const seasonTags = safeArray(context?.seasonTags);
  if (seasonTags.includes("season:winter")) {
    scores[PATTERNS.storehouse.winter_reserve] += 0.16;
    scores[PATTERNS.storehouse.root_cellar_optimizer] += 0.10;
  }
  if (seasonTags.includes("season:spring")) scores[PATTERNS.homestead.garden_led] = (scores[PATTERNS.homestead.garden_led] || 0) + 0.12;
  if (seasonTags.includes("season:summer") || seasonTags.includes("season:fall")) {
    scores[PATTERNS.meals.preservation_first] += 0.10;
    scores[PATTERNS.homestead.garden_led] = (scores[PATTERNS.homestead.garden_led] || 0) + 0.10;
  }

  // preferredDomains (if user explicitly prefers)
  const prefs = safeArray(context?.preferredDomains).map(normalizeText);
  if (prefs.includes("meals")) scores[PATTERNS.meals.weekly_batch] += 0.06;
  if (prefs.includes("storehouse")) scores[PATTERNS.storehouse.weekly_restock] += 0.06;
  if (prefs.includes("homestead")) scores[PATTERNS.homestead.mixed_subsistence] += 0.06;

  // clamp all
  for (const k of Object.keys(scores)) scores[k] = clamp(scores[k], -1, 2);
  return scores;
}

function interpretCandidate(c) {
  const tags = safeArray(c?.tags).map(String);
  const tokens = safeArray(c?.tokens).map(normalizeText);
  const domain = normalizeText(c?.domain);
  const conf = clamp(Number(c?.confidence ?? 0.5), 0, 1);
  const patternId = c?.patternId ? String(c.patternId) : null;
  const methodId = c?.methodId ? String(c.methodId) : null;
  return { domain, tags, tokens, conf, patternId, methodId };
}

function bump(scores, reasons, id, amount, why) {
  scores[id] = (scores[id] || 0) + amount;
  addReason(reasons, id, why);
}

function handleAmbiguity(scores, reasons, signals) {
  // "preserve" can mean: preservation workflow OR storehouse "preserve stock/buffer"
  const hasPreserve = signals.tokens.has("preserve") || signals.tokens.has("preservation") || signals.tokens.has("ferment") || signals.tokens.has("can");
  const hasStorehouse = signals.tokens.has("pantry") || signals.tokens.has("storehouse") || signals.tokens.has("restock") || signals.tokens.has("fifo") || signals.tokens.has("inventory");
  const hasMeals = signals.tokens.has("cook") || signals.tokens.has("meal") || signals.tokens.has("dinner") || signals.tokens.has("breakfast") || signals.tokens.has("batch");

  if (hasPreserve && hasStorehouse && !hasMeals) {
    bump(scores, reasons, PATTERNS.meals.preservation_first, 0.10, "Ambiguity resolved toward preservation-first due to preservation + storehouse tokens.");
  }
  if (hasPreserve && hasMeals) {
    bump(scores, reasons, PATTERNS.meals.preservation_first, 0.08, "Preservation intent present alongside meals → preservation-first meal planning.");
  }
  if (hasStorehouse && !hasMeals && !hasPreserve) {
    bump(scores, reasons, PATTERNS.storehouse.weekly_restock, 0.08, "Storehouse intent dominates → weekly restock.");
  }
}

export class PlanningResolver {
  /**
   * @param {object} opts
   * @param {object} [opts.patternUniverse] Optional override for tests.
   */
  constructor(opts = {}) {
    this.patterns = opts.patternUniverse || PATTERNS;
  }

  /**
   * Deterministic selection of patterns based on candidate intent + context.
   * @param {Array<object>} intentCandidates
   * @param {object} context
   * @returns {{ ranked: Array<{id:string, score:number, reasons:string[]}>, debug: { reasonsById: object, signals: object } }}
   */
  resolve(intentCandidates = [], context = {}) {
    const reasonsById = {};
    const scores = baseScoresFromContext(context);

    const signals = {
      tokens: new Set(),
      tags: new Set(),
      domains: new Set(),
      explicitPatterns: new Set(),
      methodIds: new Set(),
    };

    for (const raw of safeArray(intentCandidates)) {
      const c = interpretCandidate(raw);
      if (c.patternId) signals.explicitPatterns.add(c.patternId);
      if (c.methodId) signals.methodIds.add(c.methodId);
      for (const t of c.tags) signals.tags.add(t);
      for (const tok of c.tokens) signals.tokens.add(tok);
      if (c.domain) signals.domains.add(c.domain);

      // Direct pattern mention wins strongly
      if (c.patternId) {
        bump(scores, reasonsById, c.patternId, 0.60 * c.conf, `Explicit pattern candidate ${c.patternId} (conf ${c.conf.toFixed(2)}).`);
      }

      // Domain routing
      if (c.domain === "meals") {
        bump(scores, reasonsById, PATTERNS.meals.weekly_batch, 0.20 * c.conf, "Meals domain signal → weekly batch bias.");
        bump(scores, reasonsById, PATTERNS.meals.daily_fresh, 0.12 * c.conf, "Meals domain signal → daily fresh secondary.");
      }
      if (c.domain === "storehouse") {
        bump(scores, reasonsById, PATTERNS.storehouse.weekly_restock, 0.22 * c.conf, "Storehouse domain signal → weekly restock.");
        bump(scores, reasonsById, PATTERNS.storehouse.monthly_cycle_count, 0.10 * c.conf, "Storehouse domain signal → monthly cycle count secondary.");
      }
      if (c.domain === "homestead") {
        bump(scores, reasonsById, PATTERNS.homestead.mixed_subsistence, 0.16 * c.conf, "Homestead domain signal → mixed subsistence.");
        bump(scores, reasonsById, PATTERNS.homestead.garden_led, 0.12 * c.conf, "Homestead domain signal → garden-led secondary.");
      }

      // Token-based intent
      const tok = signals.tokens;
      if (tok.has("plan week") || tok.has("plan week meals") || tok.has("plan weeknight") || tok.has("weekly")) {
        bump(scores, reasonsById, PATTERNS.meals.weekly_batch, 0.18 * c.conf, "Token indicates weekly planning → weekly batch.");
      }
      if (tok.has("batch") || tok.has("batch cook") || tok.has("prep") || tok.has("meal prep")) {
        bump(scores, reasonsById, PATTERNS.meals.weekly_batch, 0.16 * c.conf, "Batch/prep token → weekly batch.");
      }
      if (tok.has("fresh") || tok.has("today") || tok.has("tonight") || tok.has("quick")) {
        bump(scores, reasonsById, PATTERNS.meals.daily_fresh, 0.12 * c.conf, "Fresh/today token → daily fresh.");
      }
      if (tok.has("restock") || tok.has("pantry reset") || tok.has("inventory") || tok.has("fifo") || tok.has("rotate")) {
        bump(scores, reasonsById, PATTERNS.storehouse.weekly_restock, 0.18 * c.conf, "Restock/inventory token → weekly restock.");
        bump(scores, reasonsById, PATTERNS.storehouse.monthly_cycle_count, 0.10 * c.conf, "Rotation/FIFO token → monthly cycle count.");
      }
      if (tok.has("root cellar") || tok.has("rootcellar")) {
        bump(scores, reasonsById, PATTERNS.storehouse.root_cellar_optimizer, 0.22 * c.conf, "Root cellar token → root cellar optimizer.");
      }
      if (tok.has("winterize") || tok.has("winter reserve") || tok.has("reserve")) {
        bump(scores, reasonsById, PATTERNS.storehouse.winter_reserve, 0.22 * c.conf, "Winter reserve token → winter reserve.");
      }
      if (tok.has("harvest") || tok.has("plant") || tok.has("garden") || tok.has("seedling")) {
        bump(scores, reasonsById, PATTERNS.homestead.garden_led, 0.18 * c.conf, "Garden/harvest token → garden-led.");
      }
      if (tok.has("butcher") || tok.has("slaughter") || tok.has("breeding") || tok.has("animals")) {
        bump(scores, reasonsById, PATTERNS.homestead.animal_led, 0.18 * c.conf, "Animals token → animal-led.");
      }
      if (tok.has("feast") || tok.has("feast prep") || tok.has("tabernacles") || tok.has("passover")) {
        bump(scores, reasonsById, PATTERNS.meals.feast_anchored, 0.28 * c.conf, "Feast token → feast-anchored meals.");
        bump(scores, reasonsById, PATTERNS.storehouse.feast_buffer_build, 0.22 * c.conf, "Feast token → feast buffer build.");
      }
      if (tok.has("fast") || tok.has("fast day") || tok.has("atonement")) {
        bump(scores, reasonsById, PATTERNS.meals.fast_day_light, 0.28 * c.conf, "Fast token → fast day/light meals.");
      }
      if (tok.has("preserve") || tok.has("preservation") || tok.has("ferment") || tok.has("dehydrate") || tok.has("can") || tok.has("freeze")) {
        bump(scores, reasonsById, PATTERNS.meals.preservation_first, 0.22 * c.conf, "Preservation token → preservation-first meals.");
      }
    }

    handleAmbiguity(scores, reasonsById, signals);

    // Build ranked list; ensure all known patterns exist in the ranked output (finite universe)
    const allIds = new Set();
    for (const grp of Object.values(PATTERNS)) for (const id of Object.values(grp)) allIds.add(id);
    for (const id of Object.keys(scores)) allIds.add(id);
    for (const id of signals.explicitPatterns) allIds.add(id);

    const ranked = sortRanked(
      [...allIds].map((id) => ({
        id,
        score: clamp(scores[id] ?? 0, -1, 3),
        reasons: reasonsById[id] || [],
      }))
    );

    return { ranked, debug: { reasonsById, signals: {
      tokens: [...signals.tokens],
      tags: [...signals.tags],
      domains: [...signals.domains],
      explicitPatterns: [...signals.explicitPatterns],
      methodIds: [...signals.methodIds],
    }}};
  }
}

export default PlanningResolver;
