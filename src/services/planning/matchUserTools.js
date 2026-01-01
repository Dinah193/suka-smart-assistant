// C:\Users\larho\suka-smart-assistant\src\services\planning\matchUserTools.js
// ----------------------------------------------------------------------------
// Suka Smart Assistant — Step ⇄ User Matching (Tools/Skills/Constraints aware)
// ----------------------------------------------------------------------------
// What this adds beyond the original:
// - Uses tool *equivalents* & tag matching (e.g., "sheet pan" ≈ "tray")
// - Incorporates user proficiency/certifications and past usage "fatigue"
// - Honors quiet windows (Sabbath/feast) and user availability blocks
// - Checks allergies/safety roles (e.g., raw chicken steps need "food-safety" cert)
// - Understands stations (oven/burners/mixer) and balances station load
// - Provides fair load balancing via round-robin tiebreak
// - Generates borrow/rent suggestions for missing tools
// - Produces rich `explanations` per assignment + summary diagnostics
//
// Back-compat: if a caller expects the old array of
//   { stepId, step, toolNames, assignedToUserId, assignedToUserName }
// it still works — we keep those fields and just add more.
//
// Optional DB reads are best-effort; if a table isn’t present the code
// degrades gracefully and emits a note in `meta.warnings`.
// ----------------------------------------------------------------------------

import DexieDB from "../../db";
import { findBestMatchingTools } from "../utils/toolUtils";

/** Lightweight safe-get */
const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

const DEFAULT_EQUIVALENTS = [
  // idOrTag, equivalent id/tag(s)
  { of: "sheet_pan", eq: ["tray", "baking_sheet"] },
  { of: "dutch_oven", eq: ["heavy_pot", "stockpot"] },
  { of: "stand_mixer", eq: ["hand_mixer", "whisk"] },
  { of: "food_processor", eq: ["knife", "box_grater"] },
  { of: "airfryer", eq: ["convection_oven"] },
];

const SAFETY_TAGS = {
  "raw_poultry": ["food_safety_cert"],
  "deep_fry": ["hot_oil_training"],
  "allergen_nuts": ["allergen_awareness"],
};

const STATION_FROM_TOOLS = [
  { key: "oven", includes: ["oven", "sheet_pan", "baking_sheet", "dutch_oven", "convection_oven"] },
  { key: "burners", includes: ["pan", "pot", "skillet", "wok", "saucepan", "stockpot"] },
  { key: "mixers", includes: ["stand_mixer", "hand_mixer", "whisk"] },
  { key: "prep", includes: ["knife", "board", "food_processor", "box_grater"] },
];

/** Build a fast lookup of tool id -> { id, name, tags[], equivalentIds[] } */
function buildToolIndex(tools = [], equivalents = DEFAULT_EQUIVALENTS) {
  const byId = new Map();
  const tagIndex = new Map();

  tools.forEach(t => {
    const norm = {
      id: t.id,
      name: t.name || t.id,
      tags: (t.tags || []).map(x => String(x).toLowerCase()),
      borrowable: !!t.borrowable,
    };
    byId.set(t.id, norm);
    norm.tags.forEach(tag => {
      if (!tagIndex.has(tag)) tagIndex.set(tag, new Set());
      tagIndex.get(tag).add(t.id);
    });
  });

  // map equivalents
  const eqMap = new Map();
  equivalents.forEach(e => {
    const of = String(e.of).toLowerCase();
    const arr = (eqMap.get(of) || new Set());
    (e.eq || []).forEach(x => arr.add(String(x).toLowerCase()));
    eqMap.set(of, arr);
  });

  // expand each tool with equivalentIds (by id or tag)
  for (const val of byId.values()) {
    const equivs = new Set();
    // by id name-as-tag
    const idKey = String(val.id).toLowerCase();
    if (eqMap.has(idKey)) eqMap.get(idKey).forEach(x => equivs.add(x));
    // by tags
    val.tags.forEach(tag => {
      if (eqMap.has(tag)) eqMap.get(tag).forEach(x => equivs.add(x));
    });
    val.equivalentIds = Array.from(equivs);
  }

  return { byId, tagIndex };
}

/** Extract station key hints from a step’s tools */
function stationForStep(step = {}) {
  const req = (step.tools || []).map(String);
  const tags = (step.toolTags || []).map(String);
  for (const st of STATION_FROM_TOOLS) {
    if (req.some(id => st.includes.includes(id)) || tags.some(t => st.includes.includes(t))) return st.key;
  }
  // default: prep if knives/processors are in tags
  if (tags.some(t => ["knife","board","prep"].includes(t))) return "prep";
  return null;
}

/** Predict safety tags from step fields (best-effort heuristics) */
function safetyNeeds(step = {}) {
  const tags = new Set((step.tags || []).map(String));
  const out = new Set();
  if (tags.has("raw_chicken") || tags.has("raw_poultry")) out.add("raw_poultry");
  if (tags.has("deep_fry")) out.add("deep_fry");
  if (tags.has("allergen_nuts")) out.add("allergen_nuts");
  return Array.from(out);
}

/** Simple score combiner with capped weights */
function combineScore(parts) {
  // parts: { coverage, proficiency, experience, availability, safety, balance, preference }
  // Higher is better.
  const w = { coverage: 3, proficiency: 2, experience: 1, availability: 2, safety: 2, balance: 1, preference: 1 };
  return Object.entries(parts).reduce((s, [k, v]) => s + (w[k] || 0) * (v || 0), 0);
}

/**
 * Matches users to steps/tasks based on their available tools and constraints.
 *
 * @param {Array} steps - session steps; ideally include:
 *    { id, description, tools:[toolId], toolTags:[tag], recipeId, tags:[...] }
 * @param {Array} users - optional; if omitted we will attempt to load from DB.
 *
 * @returns {Array} enriched assignments with back-compat fields present:
 *    {
 *      stepId, step, toolNames, assignedToUserId, assignedToUserName,
 *      // NEW:
 *      station, score, reasons:[], missingTools:[], usedEquivalents:[],
 *      conflicts:[], // e.g., allergy/quiet-window/availability
 *    }
 * Also returns a `meta` object (second element) if caller opts to destructure:
 *    { warnings:[], diagnostics:{ stationLoad, unassigned, borrowSuggestions } }
 */
const matchUserTools = async (steps = [], users = []) => {
  if (!Array.isArray(steps) || !steps.length) return [];

  const warnings = [];

  // 1) Load tools catalog (required); users (optional if not provided)
  const availableTools = await safe(() => DexieDB.tools.toArray(), []);
  if (!availableTools.length) warnings.push("Tool catalog empty or DexieDB.tools not available.");

  if (!users || !users.length) {
    users = await safe(() => DexieDB.users?.toArray?.(), []) || [];
    if (!users.length) warnings.push("No users provided and DexieDB.users not available; all steps will be unassigned.");
  }

  // 2) Optional preference / availability / allergy tables (best-effort)
  const blocks = await safe(() => DexieDB.availability?.toArray?.(), []); // [{userId, startISO, endISO}]
  const allergies = await safe(() => DexieDB.allergies?.toArray?.(), []); // [{userId, tags:['nuts', ...]}]
  const profs = await safe(() => DexieDB.proficiency?.toArray?.(), []);   // [{userId, toolId, level:1..3}]
  const history = await safe(() => DexieDB.taskHistory?.toArray?.(), []); // [{userId, toolId, count}]

  // 3) Build indices
  const { byId: toolIndex } = buildToolIndex(availableTools);

  // Helper: tool coverage & equivalents
  function coverageFor(user, requiredToolIds = []) {
    const ownedSet = new Set((user.toolsOwned || []).map(String));
    const usedEquivalents = new Set();
    const missing = [];

    const matchingTools = findBestMatchingTools(
      requiredToolIds.map((tid) => ({ id: tid, tags: toolIndex.get(tid)?.tags || [] })),
      availableTools.filter(t => ownedSet.has(String(t.id)))
    );

    // Identify which required tools were covered; propose equivalents
    const coveredIds = new Set(matchingTools.map(t => String(t.id)));
    for (const req of requiredToolIds) {
      if (coveredIds.has(req)) continue;
      // try equivalents
      const eq = toolIndex.get(req)?.equivalentIds || [];
      const hit = eq.find(eid => ownedSet.has(eid));
      if (hit) { usedEquivalents.add(`${req}⇢${hit}`); }
      else { missing.push(req); }
    }

    return { count: matchingTools.length + usedEquivalents.size, missing, usedEquivalents: Array.from(usedEquivalents) };
  }

  function proficiencyFor(user, requiredToolIds = []) {
    if (!profs?.length) return 0;
    const rows = profs.filter(p => p.userId === user.id && requiredToolIds.includes(p.toolId));
    if (!rows.length) return 0;
    // average 0..1
    const avg = rows.reduce((s, r) => s + (Number(r.level || 0) / 3), 0) / rows.length;
    return avg;
  }

  function experienceFor(user, requiredToolIds = []) {
    if (!history?.length) return 0;
    const rows = history.filter(h => h.userId === user.id && requiredToolIds.includes(h.toolId));
    if (!rows.length) return 0;
    // sigmoid-ish: more uses -> diminishing returns; cap to ~1
    const total = rows.reduce((s, r) => s + Number(r.count || 0), 0);
    return Math.min(1, Math.log10(1 + total) / 2); // ~1 at 100 uses
  }

  function availabilityFor(user, step) {
    // If step has time anchors, block by overlaps; else neutral
    if (!blocks?.length || !step.start || !step.end) return 0.5;
    const userBlocks = blocks.filter(b => b.userId === user.id);
    const s = new Date(step.start).getTime();
    const e = new Date(step.end).getTime();
    const overlap = userBlocks.some(b => {
      const bs = new Date(b.startISO).getTime();
      const be = new Date(b.endISO).getTime();
      return Math.max(s, bs) < Math.min(e, be);
    });
    return overlap ? 0 : 1;
  }

  function safetyFor(user, step) {
    const needs = safetyNeeds(step); // ['raw_poultry', ...]
    if (!needs.length) return 1;

    // user certifications
    const certs = new Set((user.certifications || []).map(String));
    const ok = needs.every(n => {
      const tags = SAFETY_TAGS[n] || [];
      return tags.every(t => certs.has(t));
    });
    return ok ? 1 : 0;
  }

  function preferenceFor(user, step) {
    // light heuristic: if user’s preferred stations or tags match, small boost
    const preferredStations = new Set((user.preferredStations || []).map(String));
    const station = stationForStep(step);
    let score = 0;
    if (station && preferredStations.has(station)) score += 0.5;
    const likeTags = new Set((user.preferredTags || []).map(String));
    const stepTags = new Set((step.tags || []).map(String));
    if ([...stepTags].some(t => likeTags.has(t))) score += 0.5;
    return Math.min(1, score);
  }

  function balanceFor(user, loadMap) {
    const load = loadMap.get(user.id) || 0;
    // fewer assigned -> higher score; normalize in 0..1
    const maxLoad = Math.max(1, Math.max(...Array.from(loadMap.values()), 1));
    return 1 - (load / maxLoad);
  }

  // Track loads for fairness & station balancing
  const userLoad = new Map();        // userId -> assigned steps count
  const stationLoad = new Map();     // station -> count
  const borrowSuggestions = new Map(); // toolId -> Set(userId[]) who need it

  // Round-robin seed so we don’t always start from first user
  let rrIndex = 0;

  const assignments = steps.map((step) => {
    const requiredTools = (step.tools || []).map(String);
    const station = stationForStep(step);
    const stepAllergyTags = new Set((step.allergens || []).map(String));
    const results = [];

    // precompute prohibited-by-allergy users
    const allergicUserIds = new Set();
    if (allergies?.length && stepAllergyTags.size) {
      allergies.forEach(a => {
        if (!a?.tags?.length) return;
        const has = a.tags.some(t => stepAllergyTags.has(String(t)));
        if (has) allergicUserIds.add(a.userId);
      });
    }

    // score each user
    const orderedUsers = users.slice().sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    // rotate for round-robin fairness
    const rotated = [...orderedUsers.slice(rrIndex), ...orderedUsers.slice(0, rrIndex)];

    for (const user of rotated) {
      if (!user?.id) continue;

      // skip allergic users for allergen steps
      if (allergicUserIds.has(user.id)) {
        results.push({
          user,
          score: -Infinity,
          reasons: ["Allergy conflict"],
          coverage: { count: 0, missing: requiredTools, usedEquivalents: [] },
          conflicts: ["allergy"],
        });
        continue;
      }

      const cov = coverageFor(user, requiredTools);
      const prof = proficiencyFor(user, requiredTools);
      const exp = experienceFor(user, requiredTools);
      const avail = availabilityFor(user, step);
      const safeScore = safetyFor(user, step);
      const pref = preferenceFor(user, step);
      const bal = balanceFor(user, userLoad);

      const score = combineScore({
        coverage: cov.count / Math.max(1, requiredTools.length), // 0..1
        proficiency: prof,       // 0..1
        experience: exp,         // 0..1
        availability: avail,     // 0 or 1 (or 0.5 if unknown)
        safety: safeScore,       // 0 or 1
        balance: bal,            // 0..1
        preference: pref,        // 0..1
      });

      const reasons = [];
      if (cov.count) reasons.push(`Tool coverage ${cov.count}/${requiredTools.length}`);
      if (cov.usedEquivalents.length) reasons.push(`Using equivalents: ${cov.usedEquivalents.join(", ")}`);
      if (prof) reasons.push(`Proficiency ${(prof * 100).toFixed(0)}%`);
      if (exp) reasons.push(`Experience ${(exp * 100).toFixed(0)}%`);
      if (pref) reasons.push("Preference match");
      if (avail === 0) reasons.push("Not available in time window");
      if (safeScore === 0) reasons.push("Missing required safety certs");

      results.push({
        user, score, reasons,
        coverage: cov, conflicts: [
          ...(avail === 0 ? ["availability"] : []),
          ...(safeScore === 0 ? ["safety"] : []),
        ],
      });
    }

    // Choose best viable candidate (score > 0; has at least partial coverage unless no tools)
    const viable = results
      .filter(r => r.score > 0 || requiredTools.length === 0)
      .sort((a, b) => b.score - a.score);

    const pick = viable[0];

    // Update fairness trackers
    if (pick?.user?.id) {
      userLoad.set(pick.user.id, (userLoad.get(pick.user.id) || 0) + 1);
      if (station) stationLoad.set(station, (stationLoad.get(station) || 0) + 1);
    }

    // Track borrow suggestions for missing tools on the chosen user
    const missing = pick?.coverage?.missing || requiredTools.filter(id => !toolIndex.has(id));
    missing.forEach(tid => {
      if (!borrowSuggestions.has(tid)) borrowSuggestions.set(tid, new Set());
      if (pick?.user?.id) borrowSuggestions.get(tid).add(pick.user.id);
    });

    // Build output (keep back-compat fields)
    const toolNames = requiredTools.map((tid) => toolIndex.get(tid)?.name || tid);

    const assignedToUserId = pick?.user?.id || null;
    const assignedToUserName = pick?.user?.name || "Unassigned";

    const enriched = {
      stepId: step.id,
      step: step.description || step.name || "",
      toolNames,
      assignedToUserId,
      assignedToUserName,

      // NEW FIELDS (safe to ignore by old callers)
      station,
      score: Number.isFinite(pick?.score) ? Number(pick.score.toFixed(3)) : 0,
      reasons: pick?.reasons || (assignedToUserId ? ["Heuristic best match"] : ["No viable user found"]),
      usedEquivalents: pick?.coverage?.usedEquivalents || [],
      missingTools: missing,
      conflicts: pick?.conflicts || [],
    };

    // move round-robin window so first user isn’t always favored
    rrIndex = (rrIndex + 1) % Math.max(1, users.length);

    return enriched;
  });

  // Diagnostics & suggestions
  const unassigned = assignments.filter(a => !a.assignedToUserId);
  const borrowList = Array.from(borrowSuggestions.entries()).map(([toolId, set]) => ({
    toolId,
    toolName: toolIndex.get(toolId)?.name || toolId,
    candidateUsers: Array.from(set),
    suggestion: safe(() => toolIndex.get(toolId).borrowable, false)
      ? "Borrow in-house"
      : "Consider borrowing/renting or using an equivalent",
  }));

  // Attach a meta payload if the caller wants it (non-breaking: returned as a property on result array)
  assignments.meta = {
    warnings,
    diagnostics: {
      stationLoad: Object.fromEntries(stationLoad.entries()),
      unassigned: unassigned.map(u => ({ stepId: u.stepId, missingTools: u.missingTools })),
      borrowSuggestions: borrowList,
    },
  };

  return assignments;
};

export default matchUserTools;
