/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\catalogs\ToolSubstitutionRules.catalog.js
//
// SSA • Tool Substitution Rules Catalog
// -----------------------------------------------------------------------------
// Purpose:
//   Deterministic, explainable substitutions when a recipe requires a tool the
//   household doesn't have, and SSA wants to adapt the plan to available tools.
//
// Used by:
//   - RecipeAdapterService.js (pipeline)
//   - CookSetupModal.jsx (preview + user approvals)
//   - CookPlan compiler (equipment list + step rewrites)
//
// Design goals:
//   - Offline, deterministic, explainable
//   - Safe: never suggest a substitution that changes core safety constraints
//   - Practical: prefer household-available, equivalent functions
//
// Concepts:
//   - Tools are referenced by canonical "tool keys" (strings) matching SSA
//     kitchen capabilities and equipment catalogs.
//   - Substitution rules match on: missingToolKey + (optional) method + tags.
//   - Each rule proposes one or more alternative tool keys and provides:
//       - confidence score (0..1)
//       - friction score (0..1) for UX (extra effort)
//       - required capability tags (so we don't suggest what they can't do)
//       - step rewrite hints (optional) so compiler can tweak instructions
//
// IMPORTANT:
//   - This catalog is intentionally general and does NOT require any other files.
//   - Integrate with your KitchenCapabilities schema by using the same tool keys.
//
// API:
//   resolveToolSubstitutions({ missingToolKey, method, recipeTags, kitchenCaps })
//     -> best candidates + reasoning
//   findToolSubstitution({ missingToolKey, method, recipeTags, kitchenCaps })
//     -> convenience alias (returns same as resolveToolSubstitutions)
//   applyToolSubstitutionsToEquipment({ equipmentRequired, kitchenCaps, ... })
//     -> substitution plan + missing list
//   explainToolSubstitution(resolution) -> human readable explanation
//   listToolSubstitutionRules(filter)   -> debug/UI
//
// Query shape example:
//   const res = resolveToolSubstitutions({
//     missingToolKey: "appliance:oven",
//     method: "bake",
//     recipeTags: ["bread", "yeast"],
//     kitchenCaps: { tools: { "appliance:air_fryer": true, ... }, tags: ["outdoor_ok"] }
//   });
//
// -----------------------------------------------------------------------------
// Catalog ID / Version
const CATALOG_ID = "ssa://catalogs/recipes/tool-substitution-rules#v1";
const CATALOG_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeLower(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(arr) ? arr : []) {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function clamp01(n, fallback = 0) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function normalizeCaps(kitchenCaps) {
  // Expected shape (compatible with your kitchen.capabilities.schema.js):
  // {
  //   tools: { [toolKey]: boolean },
  //   tags: string[]   (capability tags like "outdoor_ok", "ventilation_good")
  // }
  const caps = isPlainObject(kitchenCaps) ? kitchenCaps : {};
  const tools = isPlainObject(caps.tools) ? caps.tools : {};
  const tags = uniqStrings(caps.tags);

  return {
    tools,
    tags,
  };
}

function hasTool(caps, toolKey) {
  const key = String(toolKey || "");
  return !!caps.tools[key];
}

function hasAllTags(caps, reqTags) {
  const need = uniqStrings(reqTags);
  if (!need.length) return true;
  const set = new Set(caps.tags);
  return need.every((t) => set.has(t));
}

function anyTagMatches(haystackTags, needles) {
  const hs = new Set(uniqStrings(haystackTags));
  const ns = uniqStrings(needles);
  if (!ns.length) return false;
  return ns.some((t) => hs.has(t));
}

function deepFreeze(o) {
  if (!o || typeof o !== "object") return o;
  Object.freeze(o);
  for (const k of Object.keys(o)) {
    if (o[k] && typeof o[k] === "object" && !Object.isFrozen(o[k])) {
      deepFreeze(o[k]);
    }
  }
  return o;
}

function clone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

/* -------------------------------------------------------------------------- */
/* Canonical tool keys (conventions)                                           */
/* -------------------------------------------------------------------------- */
/**
 * SSA convention for tool keys (recommended):
 *   appliance:<name>
 *   cookware:<name>
 *   utensil:<name>
 *   container:<name>
 *
 * Examples:
 *   appliance:oven
 *   appliance:air_fryer
 *   cookware:cast_iron_skillet
 *   utensil:instant_read_thermometer
 */
const TOOL_KEY_HINTS = deepFreeze({
  appliances: [
    "appliance:oven",
    "appliance:stovetop",
    "appliance:microwave",
    "appliance:air_fryer",
    "appliance:toaster_oven",
    "appliance:slow_cooker",
    "appliance:pressure_cooker",
    "appliance:sous_vide",
    "appliance:grill",
    "appliance:smoker",
    "appliance:blender",
    "appliance:food_processor",
    "appliance:stand_mixer",
    "appliance:hand_mixer",
    "appliance:immersion_blender",
    "appliance:coffee_grinder",
    "appliance:spice_grinder",
    "appliance:dehydrator",
  ],
  cookware: [
    "cookware:sheet_pan",
    "cookware:roasting_pan",
    "cookware:dutch_oven",
    "cookware:stock_pot",
    "cookware:saucepan",
    "cookware:skillet",
    "cookware:cast_iron_skillet",
    "cookware:wok",
    "cookware:baking_dish",
    "cookware:muffin_tin",
    "cookware:loaf_pan",
    "cookware:saute_pan",
    "cookware:griddle",
  ],
  utensils: [
    "utensil:chef_knife",
    "utensil:paring_knife",
    "utensil:cutting_board",
    "utensil:whisk",
    "utensil:spatula",
    "utensil:tongs",
    "utensil:ladle",
    "utensil:wooden_spoon",
    "utensil:rolling_pin",
    "utensil:measuring_cups",
    "utensil:measuring_spoons",
    "utensil:kitchen_scale",
    "utensil:instant_read_thermometer",
    "utensil:probe_thermometer",
    "utensil:timer",
    "utensil:colander",
    "utensil:grater",
    "utensil:microplane",
    "utensil:peeler",
    "utensil:mortar_pestle",
    "utensil:sifter",
    "utensil:stand_mixer_dough_hook",
  ],
  containers: [
    "container:mixing_bowl",
    "container:heat_safe_bowl",
    "container:jar",
    "container:resealable_bag",
    "container:storage_container",
    "container:sheet_parchment",
    "container:foil",
  ],
});

/* -------------------------------------------------------------------------- */
/* Rule format                                                                 */
/* -------------------------------------------------------------------------- */
/**
 * Rule object:
 * {
 *   id: string,
 *   missingToolKey: string,                 // required
 *   match: { methods?: string[], tagsAny?: string[], tagsAll?: string[] } // optional
 *   candidates: [
 *     {
 *       toolKey: string,
 *       requiresTags?: string[],
 *       confidence: number,  // 0..1
 *       friction: number,    // 0..1 (extra effort or quality loss)
 *       notes?: string,
 *       stepRewriteHints?: [
 *         { findAny?: string[], replaceWith?: string, addNotes?: string }
 *       ]
 *     }
 *   ],
 *   safety: { allowWhenMissingThermometer?: boolean } // optional knobs
 *   notes?: string
 * }
 *
 * Step rewrite hints are intentionally lightweight. Your compiler can:
 *   - replace phrases in step text
 *   - append addNotes
 */

/* -------------------------------------------------------------------------- */
/* Substitution rules                                                          */
/* -------------------------------------------------------------------------- */

const RULES = [
  // ========================= HEAT SOURCES ==================================
  {
    id: "heat:oven->toaster_oven_or_air_fryer",
    missingToolKey: "appliance:oven",
    match: { methods: ["bake", "roast", "broil"] },
    candidates: [
      {
        toolKey: "appliance:toaster_oven",
        confidence: 0.88,
        friction: 0.25,
        notes: "Use toaster oven; reduce batch size; watch browning closely.",
        stepRewriteHints: [
          {
            findAny: ["oven", "bake", "roast", "broil", "preheat"],
            replaceWith: "toaster oven",
            addNotes: "Scale to fit. Start checking 5–10 minutes early.",
          },
        ],
      },
      {
        toolKey: "appliance:air_fryer",
        confidence: 0.82,
        friction: 0.35,
        notes:
          "Use air fryer for small batches; reduce time; shake/turn midway.",
        stepRewriteHints: [
          {
            findAny: ["oven", "bake", "roast", "preheat"],
            replaceWith: "air fryer",
            addNotes: "Cook in smaller batches. Flip/shake halfway.",
          },
        ],
      },
      {
        toolKey: "appliance:grill",
        requiresTags: ["outdoor_ok"],
        confidence: 0.7,
        friction: 0.5,
        notes: "Use grill with indirect heat as an oven substitute.",
        stepRewriteHints: [
          {
            findAny: ["oven", "bake", "roast", "preheat"],
            replaceWith: "grill (indirect heat)",
            addNotes:
              "Use indirect heat and close lid. Monitor temp frequently.",
          },
        ],
      },
    ],
    notes: "Oven substitutions for small batch or outdoor cooking.",
  },
  {
    id: "heat:stovetop->electric_hotplate_or_grill",
    missingToolKey: "appliance:stovetop",
    match: { methods: ["saute", "stir_fry", "simmer", "boil", "pan_sear"] },
    candidates: [
      {
        toolKey: "appliance:grill",
        requiresTags: ["outdoor_ok"],
        confidence: 0.75,
        friction: 0.45,
        notes: "Use grill as heat source for pots/pans.",
        stepRewriteHints: [
          {
            findAny: ["stovetop", "burner"],
            replaceWith: "grill heat",
            addNotes: "Use stable surface; watch flame/heat.",
          },
        ],
      },
      {
        toolKey: "appliance:microwave",
        confidence: 0.55,
        friction: 0.65,
        notes:
          "Microwave can handle steaming/reheating; not ideal for searing.",
        stepRewriteHints: [
          {
            findAny: ["stovetop", "simmer", "boil"],
            replaceWith: "microwave",
            addNotes: "Use microwave-safe bowl; stir frequently.",
          },
        ],
      },
    ],
    notes: "Fallback heat sources when stovetop is not available.",
  },

  // ========================= MIX / PROCESS =================================
  {
    id: "mix:stand_mixer->hand_mixer_or_whisk",
    missingToolKey: "appliance:stand_mixer",
    match: { tagsAny: ["baking", "dessert", "bread"] },
    candidates: [
      {
        toolKey: "appliance:hand_mixer",
        confidence: 0.9,
        friction: 0.25,
        notes:
          "Hand mixer works for batters, creams; not ideal for stiff dough.",
        stepRewriteHints: [
          {
            findAny: ["stand mixer"],
            replaceWith: "hand mixer",
            addNotes: "Mix in a large bowl; avoid overmixing.",
          },
        ],
      },
      {
        toolKey: "utensil:whisk",
        confidence: 0.78,
        friction: 0.55,
        notes: "Whisk + elbow grease for light batters and emulsions.",
        stepRewriteHints: [
          {
            findAny: ["stand mixer"],
            replaceWith: "whisk by hand",
            addNotes: "Expect longer mixing time; rest as needed.",
          },
        ],
      },
    ],
  },
  {
    id: "process:food_processor->knife_grater",
    missingToolKey: "appliance:food_processor",
    match: { tagsAny: ["sauce", "dip", "prep"] },
    candidates: [
      {
        toolKey: "utensil:chef_knife",
        confidence: 0.82,
        friction: 0.6,
        notes: "Chop finely; mash/paste as needed.",
        stepRewriteHints: [
          {
            findAny: ["food processor", "pulse"],
            replaceWith: "finely chop",
            addNotes: "Work in small batches for even texture.",
          },
        ],
      },
      {
        toolKey: "utensil:grater",
        confidence: 0.7,
        friction: 0.65,
        notes: "Grate aromatics/veg to mimic processor texture.",
        stepRewriteHints: [
          {
            findAny: ["food processor", "pulse"],
            replaceWith: "grate and mash",
            addNotes: "Grate on fine holes; mash to paste.",
          },
        ],
      },
    ],
  },
  {
    id: "blend:blender->immersion_blender_or_mash",
    missingToolKey: "appliance:blender",
    match: { tagsAny: ["soup", "sauce", "smoothie"] },
    candidates: [
      {
        toolKey: "appliance:immersion_blender",
        confidence: 0.92,
        friction: 0.18,
        notes: "Immersion blender is the closest substitute for soups/sauces.",
        stepRewriteHints: [
          {
            findAny: ["blender", "blend"],
            replaceWith: "immersion blend",
            addNotes: "Blend in pot carefully; avoid splashing.",
          },
        ],
      },
      {
        toolKey: "utensil:whisk",
        confidence: 0.6,
        friction: 0.75,
        notes: "Whisk + mash for rustic texture (not smooth).",
        stepRewriteHints: [
          {
            findAny: ["blend until smooth"],
            replaceWith: "mash/whisk until combined",
            addNotes: "Texture will be rustic; strain if needed.",
          },
        ],
      },
    ],
  },
  {
    id: "grind:spice_grinder->mortar_pestle_or_microplane",
    missingToolKey: "appliance:spice_grinder",
    match: { tagsAny: ["spices", "marinade", "rub"] },
    candidates: [
      {
        toolKey: "utensil:mortar_pestle",
        confidence: 0.88,
        friction: 0.35,
        notes: "Mortar & pestle for whole spices.",
        stepRewriteHints: [
          {
            findAny: ["grind", "spice grinder"],
            replaceWith: "crush in mortar & pestle",
            addNotes: "Toast first for more aroma if possible.",
          },
        ],
      },
      {
        toolKey: "utensil:microplane",
        confidence: 0.65,
        friction: 0.55,
        notes: "Microplane can grate some spices (nutmeg), garlic, ginger.",
        stepRewriteHints: [
          {
            findAny: ["grind"],
            replaceWith: "grate finely",
            addNotes:
              "Use microplane for hard spices/aromatics where appropriate.",
          },
        ],
      },
    ],
  },

  // ========================= MEASURE / CONTROL =============================
  {
    id: "measure:scale->cups_spoons",
    missingToolKey: "utensil:kitchen_scale",
    match: { tagsAny: ["baking", "bread"] },
    candidates: [
      {
        toolKey: "utensil:measuring_cups",
        confidence: 0.8,
        friction: 0.4,
        notes: "Convert grams to volume; accuracy decreases; adjust by feel.",
        stepRewriteHints: [
          {
            findAny: ["weigh", "grams", "g "],
            replaceWith: "measure by volume",
            addNotes: "Spoon-and-level flour. Adjust hydration as needed.",
          },
        ],
      },
    ],
    notes: "Scale is ideal for baking; cups are acceptable with caution.",
  },
  {
    id: "measure:thermometer->visual_cues_with_safety_warning",
    missingToolKey: "utensil:instant_read_thermometer",
    match: { tagsAny: ["meat", "poultry", "fish"] },
    candidates: [
      {
        toolKey: "utensil:timer",
        confidence: 0.45,
        friction: 0.85,
        requiresTags: ["accept_visual_doneness"],
        notes:
          "Visual cues only; strongly recommend adding a thermometer for safety.",
        stepRewriteHints: [
          {
            findAny: ["°f", "internal temp", "thermometer"],
            replaceWith: "doneness cues",
            addNotes:
              "Thermometer missing: use visual cues + extra time buffer; consider acquiring a thermometer.",
          },
        ],
      },
    ],
    safety: { allowWhenMissingThermometer: true },
    notes:
      "SSA will flag as needs_user_review and potentially raise safety targets if possible.",
  },
  {
    id: "measure:probe_thermometer->instant_read",
    missingToolKey: "utensil:probe_thermometer",
    match: { tagsAny: ["roast", "smoke", "slow_cook"] },
    candidates: [
      {
        toolKey: "utensil:instant_read_thermometer",
        confidence: 0.82,
        friction: 0.35,
        notes:
          "Use instant-read checks at intervals instead of continuous probe.",
        stepRewriteHints: [
          {
            findAny: ["probe", "leave-in thermometer"],
            replaceWith: "instant-read checks",
            addNotes: "Check every 20–30 minutes near finish.",
          },
        ],
      },
    ],
  },

  // ========================= BAKEWARE ======================================
  {
    id: "bakeware:sheet_pan->baking_dish_or_cast_iron",
    missingToolKey: "cookware:sheet_pan",
    match: { methods: ["bake", "roast", "broil"] },
    candidates: [
      {
        toolKey: "cookware:baking_dish",
        confidence: 0.85,
        friction: 0.35,
        notes: "Use baking dish; may change airflow and browning.",
        stepRewriteHints: [
          {
            findAny: ["sheet pan"],
            replaceWith: "baking dish",
            addNotes: "Expect softer bottom; broil briefly to brown if needed.",
          },
        ],
      },
      {
        toolKey: "cookware:cast_iron_skillet",
        confidence: 0.8,
        friction: 0.4,
        notes: "Cast iron can roast/bake small batches.",
        stepRewriteHints: [
          {
            findAny: ["sheet pan"],
            replaceWith: "cast iron skillet",
            addNotes: "Preheat skillet for better browning.",
          },
        ],
      },
    ],
  },
  {
    id: "bakeware:loaf_pan->baking_dish_or_sheet_pan",
    missingToolKey: "cookware:loaf_pan",
    match: { tagsAny: ["bread", "loaf", "meatloaf"] },
    candidates: [
      {
        toolKey: "cookware:baking_dish",
        confidence: 0.8,
        friction: 0.45,
        notes: "Shape loaf freeform or use baking dish as mold.",
        stepRewriteHints: [
          {
            findAny: ["loaf pan"],
            replaceWith: "baking dish",
            addNotes: "Grease well; adjust bake time; check earlier.",
          },
        ],
      },
      {
        toolKey: "cookware:sheet_pan",
        confidence: 0.7,
        friction: 0.55,
        notes: "Freeform loaf on sheet pan (bread/meatloaf).",
        stepRewriteHints: [
          {
            findAny: ["loaf pan"],
            replaceWith: "sheet pan",
            addNotes: "Shape loaf; bake may finish faster; monitor closely.",
          },
        ],
      },
    ],
  },

  // ========================= SPECIALTY =====================================
  {
    id: "special:dutch_oven->stock_pot_with_lid",
    missingToolKey: "cookware:dutch_oven",
    match: { methods: ["braise", "stew"] },
    candidates: [
      {
        toolKey: "cookware:stock_pot",
        confidence: 0.82,
        friction: 0.35,
        notes: "Use heavy pot with lid; manage evaporation.",
        stepRewriteHints: [
          {
            findAny: ["dutch oven"],
            replaceWith: "heavy pot with lid",
            addNotes: "Keep a gentle simmer; add liquid if reducing too fast.",
          },
        ],
      },
    ],
  },
  {
    id: "special:wok->large_skillet",
    missingToolKey: "cookware:wok",
    match: { methods: ["stir_fry"] },
    candidates: [
      {
        toolKey: "cookware:skillet",
        confidence: 0.88,
        friction: 0.3,
        notes: "Use large skillet; cook in batches to avoid steaming.",
        stepRewriteHints: [
          {
            findAny: ["wok"],
            replaceWith: "large skillet",
            addNotes: "Avoid overcrowding; keep heat high; cook in batches.",
          },
        ],
      },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Matching and scoring                                                        */
/* -------------------------------------------------------------------------- */

function ruleMatches(rule, { missingToolKey, method, recipeTags }) {
  if (!rule || !missingToolKey) return false;
  if (String(rule.missingToolKey) !== String(missingToolKey)) return false;

  const m = safeLower(method);
  const tags = uniqStrings(recipeTags).map((t) => safeLower(t));

  const match = isPlainObject(rule.match) ? rule.match : {};
  if (Array.isArray(match.methods) && match.methods.length) {
    const methods = match.methods.map((x) => safeLower(x));
    if (m && !methods.includes(m)) return false;
  }
  if (Array.isArray(match.tagsAll) && match.tagsAll.length) {
    const need = match.tagsAll.map((x) => safeLower(x));
    const set = new Set(tags);
    if (!need.every((t) => set.has(t))) return false;
  }
  if (Array.isArray(match.tagsAny) && match.tagsAny.length) {
    const any = match.tagsAny.map((x) => safeLower(x));
    if (!any.some((t) => tags.includes(t))) return false;
  }

  return true;
}

function candidateScore(candidate) {
  const conf = clamp01(candidate.confidence, 0.5);
  const friction = clamp01(candidate.friction, 0.5);
  // Prefer higher confidence and lower friction
  return conf * 0.75 + (1 - friction) * 0.25;
}

function normalizeCandidate(c) {
  const out = isPlainObject(c) ? { ...c } : {};
  out.toolKey = String(out.toolKey || "").trim();
  out.confidence = clamp01(out.confidence, 0.5);
  out.friction = clamp01(out.friction, 0.5);
  out.requiresTags = uniqStrings(out.requiresTags);
  out.notes = typeof out.notes === "string" ? out.notes : "";
  out.stepRewriteHints = Array.isArray(out.stepRewriteHints)
    ? out.stepRewriteHints
        .filter((h) => isPlainObject(h))
        .map((h) => ({
          findAny: uniqStrings(h.findAny),
          replaceWith: typeof h.replaceWith === "string" ? h.replaceWith : "",
          addNotes: typeof h.addNotes === "string" ? h.addNotes : "",
        }))
    : [];
  return out;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

function resolveToolSubstitutions(query = {}) {
  const missingToolKey = String(query.missingToolKey || "").trim();
  const method = safeLower(query.method);
  const recipeTags = uniqStrings(query.recipeTags);
  const caps = normalizeCaps(query.kitchenCaps);

  if (!missingToolKey) {
    return {
      ok: false,
      reason: "missingToolKey_required",
      missingToolKey: null,
      candidates: [],
      chosen: null,
      ruleIds: [],
      explanation: "No missing tool key provided.",
    };
  }

  const matchingRules = RULES.filter((r) =>
    ruleMatches(r, { missingToolKey, method, recipeTags })
  );

  // If no method/tags match, try looser match: same missingToolKey regardless
  const relaxedRules =
    matchingRules.length > 0
      ? matchingRules
      : RULES.filter((r) => String(r.missingToolKey) === missingToolKey);

  const ruleIds = relaxedRules.map((r) => r.id);

  const candidates = [];
  for (const rule of relaxedRules) {
    const rawCandidates = Array.isArray(rule.candidates) ? rule.candidates : [];
    for (const c0 of rawCandidates) {
      const c = normalizeCandidate(c0);
      if (!c.toolKey) continue;

      const available = hasTool(caps, c.toolKey);
      const tagOk = hasAllTags(caps, c.requiresTags);

      // Candidate is "eligible" if tool exists and capability tags satisfied
      if (!available || !tagOk) {
        candidates.push({
          ...c,
          eligible: false,
          available,
          tagOk,
          fromRuleId: rule.id,
          score: candidateScore(c),
        });
        continue;
      }

      candidates.push({
        ...c,
        eligible: true,
        available,
        tagOk,
        fromRuleId: rule.id,
        score: candidateScore(c),
      });
    }
  }

  // Sort: eligible first, then by score, then by confidence
  candidates.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return (b.confidence || 0) - (a.confidence || 0);
  });

  const chosen = candidates.find((c) => c.eligible) || null;
  const explanation = explainToolSubstitution({
    missingToolKey,
    method,
    recipeTags,
    chosen,
    candidates,
    ruleIds,
  });

  return {
    ok: !!chosen,
    reason: chosen ? "resolved" : "no_eligible_substitution",
    missingToolKey,
    method: method || null,
    recipeTags,
    ruleIds,
    candidates,
    chosen,
    explanation,
  };
}

/**
 * ✅ Added for src/features/recipes/index.js compatibility.
 * Convenience alias that returns the same result as resolveToolSubstitutions().
 */
function findToolSubstitution(query = {}) {
  return resolveToolSubstitutions(query);
}

function applyToolSubstitutionsToEquipment(query = {}) {
  // Input:
  //   equipmentRequired: [{ id, key, label, class, optional, notes }]
  //   kitchenCaps: { tools, tags }
  // Output:
  //   {
  //     ok,
  //     substitutions: [{ missingKey, chosenKey, fromRuleId, confidence, friction, notes }],
  //     stillMissing: [missingKey...],
  //     equipmentResolved: [{ ...original, resolvedKey, resolvedLabel, substituted: bool, substitutionNotes }]
  //   }

  const caps = normalizeCaps(query.kitchenCaps);
  const method = safeLower(query.method);
  const recipeTags = uniqStrings(query.recipeTags);

  const required = Array.isArray(query.equipmentRequired)
    ? query.equipmentRequired
    : [];
  const resolved = [];
  const substitutions = [];
  const stillMissing = [];

  for (const item of required) {
    const key = String(item?.key || "").trim();
    const label =
      typeof item?.label === "string" ? item.label : key || "Equipment";
    const optional = !!item?.optional;

    if (!key) {
      // malformed, keep as missing
      resolved.push({
        ...item,
        resolvedKey: null,
        resolvedLabel: label,
        substituted: false,
        substitutionNotes: "Missing equipment key.",
      });
      if (!optional) stillMissing.push(null);
      continue;
    }

    // If household has it, keep
    if (hasTool(caps, key)) {
      resolved.push({
        ...item,
        resolvedKey: key,
        resolvedLabel: label,
        substituted: false,
        substitutionNotes: "",
      });
      continue;
    }

    // Try substitution
    const sub = resolveToolSubstitutions({
      missingToolKey: key,
      method,
      recipeTags,
      kitchenCaps: caps,
    });

    if (sub.ok && sub.chosen) {
      substitutions.push({
        missingKey: key,
        chosenKey: sub.chosen.toolKey,
        fromRuleId: sub.chosen.fromRuleId,
        confidence: sub.chosen.confidence,
        friction: sub.chosen.friction,
        notes: sub.chosen.notes || "",
        stepRewriteHints: sub.chosen.stepRewriteHints || [],
      });

      resolved.push({
        ...item,
        resolvedKey: sub.chosen.toolKey,
        resolvedLabel: `${label} (using ${sub.chosen.toolKey})`,
        substituted: true,
        substitutionNotes: sub.explanation || sub.chosen.notes || "",
      });
    } else {
      resolved.push({
        ...item,
        resolvedKey: null,
        resolvedLabel: label,
        substituted: false,
        substitutionNotes: sub.explanation || "No eligible substitution found.",
      });
      if (!optional) stillMissing.push(key);
    }
  }

  return {
    ok: stillMissing.length === 0,
    substitutions,
    stillMissing: stillMissing.filter((x) => typeof x === "string" && x),
    equipmentResolved: resolved,
  };
}

function explainToolSubstitution(resolution = {}) {
  const missingToolKey = String(resolution.missingToolKey || "").trim();
  if (!missingToolKey) return "No missing tool specified.";

  const method = resolution.method ? String(resolution.method) : "";
  const tags = uniqStrings(resolution.recipeTags);

  const chosen = resolution.chosen || null;
  const candidates = Array.isArray(resolution.candidates)
    ? resolution.candidates
    : [];
  const ruleIds = uniqStrings(resolution.ruleIds);

  const parts = [];

  parts.push(`Missing tool: "${missingToolKey}".`);
  if (method) parts.push(`Method: ${method}.`);
  if (tags.length) parts.push(`Recipe tags: ${tags.join(", ")}.`);

  if (ruleIds.length) parts.push(`Rules considered: ${ruleIds.join(", ")}.`);

  if (chosen) {
    parts.push(
      `Chosen substitute: "${chosen.toolKey}" (confidence ${Math.round(
        (chosen.confidence || 0) * 100
      )}%, friction ${Math.round((chosen.friction || 0) * 100)}%).`
    );
    if (chosen.notes) parts.push(chosen.notes);
    if (Array.isArray(chosen.requiresTags) && chosen.requiresTags.length) {
      parts.push(`Requires: ${chosen.requiresTags.join(", ")}.`);
    }
  } else {
    const eligible = candidates.filter((c) => c && c.eligible);
    if (!eligible.length) {
      const unavailable = candidates
        .filter((c) => c && !c.eligible)
        .slice(0, 3)
        .map(
          (c) =>
            `${c.toolKey}${c.available ? "" : " (not owned)"}${
              c.tagOk ? "" : " (capability missing)"
            }`
        );
      if (unavailable.length) {
        parts.push(
          `No eligible substitutions found. Top candidates were: ${unavailable.join(
            ", "
          )}.`
        );
      } else {
        parts.push("No substitutions found for this tool.");
      }
    }
  }

  return parts.join(" ");
}

function listToolSubstitutionRules(filter = {}) {
  const missingToolKey = filter.missingToolKey
    ? String(filter.missingToolKey).trim()
    : null;
  const method = filter.method ? safeLower(filter.method) : null;
  const tag = filter.tag ? safeLower(filter.tag) : null;

  return RULES.filter((r) => {
    if (missingToolKey && String(r.missingToolKey) !== missingToolKey)
      return false;
    if (method && r.match?.methods && Array.isArray(r.match.methods)) {
      const ms = r.match.methods.map((x) => safeLower(x));
      if (!ms.includes(method)) return false;
    }
    if (tag) {
      const any = (r.match?.tagsAny || []).map((x) => safeLower(x));
      const all = (r.match?.tagsAll || []).map((x) => safeLower(x));
      if (!(any.includes(tag) || all.includes(tag))) return false;
    }
    return true;
  }).map((r) => ({
    id: r.id,
    missingToolKey: r.missingToolKey,
    match: clone(r.match || {}),
    candidateToolKeys: (Array.isArray(r.candidates) ? r.candidates : []).map(
      (c) => c.toolKey
    ),
    notes: r.notes || "",
  }));
}

/* -------------------------------------------------------------------------- */
/* Catalog export                                                              */
/* -------------------------------------------------------------------------- */

const ToolSubstitutionRulesCatalog = deepFreeze({
  id: CATALOG_ID,
  version: CATALOG_VERSION,
  hints: TOOL_KEY_HINTS,
  rules: RULES.map((r) => clone(r)),
  resolveToolSubstitutions,
  findToolSubstitution,
  applyToolSubstitutionsToEquipment,
  explainToolSubstitution,
  listToolSubstitutionRules,
});

export {
  ToolSubstitutionRulesCatalog,
  // ids
  CATALOG_ID,
  CATALOG_VERSION,
  // helpers/hints
  TOOL_KEY_HINTS,
  // APIs
  resolveToolSubstitutions,
  findToolSubstitution,
  applyToolSubstitutionsToEquipment,
  explainToolSubstitution,
  listToolSubstitutionRules,
};

export default ToolSubstitutionRulesCatalog;
