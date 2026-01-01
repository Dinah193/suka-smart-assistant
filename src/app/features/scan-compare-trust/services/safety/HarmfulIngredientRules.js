/* eslint-disable no-console */
// src/features/scan-compare-trust/services/safety/HarmfulIngredientRules.js
// Dynamic, toggleable curated rules with user overrides + event-driven orchestration.

/**
 * @typedef {Object} Rule
 * @property {string} id                  - Stable id, e.g. "food:trans-fats"
 * @property {string} name                - Human name
 * @property {"food"|"cosmetics"|"household"|"garden"|"baby"|"packaging"} domain
 * @property {"low"|"medium"|"high"|"critical"} severity
 * @property {boolean} defaultEnabled
 * @property {number} scoreImpact         - Integer contribution to aggregate risk (e.g. 10..100)
 * @property {string[]} tags              - e.g. ["allergen","endocrine","colorant","EU-banned"]
 * @property {string[]} patterns          - Case-insensitive literal matches (normalized tokens)
 * @property {RegExp[]} regex             - Regex matchers (already constructed)
 * @property {string[]} synonyms          - Alternate literal strings (normalized)
 * @property {string[]} cas               - CAS registry numbers, e.g. ["7681-93-0"]
 * @property {string[]} enumbers          - E-code additives, e.g. ["E171"]
 * @property {string} rationale           - Short rationale for UI tooltips
 * @property {Array<{label:string,url?:string}>} sources - Optional references to surface in UI
 * @property {Array<{ifIncludes:string[],exemptIfIncludes?:string[]}>} exceptions
 * @property {Array<{region:"US"|"EU"|"CA"|"UK"|"AU", status:"restricted"|"banned"|"warning"}>} regulatory
 */

/**
 * @typedef {Object} MatchHit
 * @property {string} ruleId
 * @property {string} ingredient
 * @property {"pattern"|"regex"|"synonym"|"cas"|"enumber"} via
 * @property {string} matched
 * @property {"low"|"medium"|"high"|"critical"} severity
 * @property {number} scoreImpact
 * @property {string} rationale
 * @property {string[]} tags
 */

/**
 * Factory: creates the Safety Rules service with optional DI.
 *
 * @param {Object} deps
 * @param {Object} [deps.config]    - { get(path:string, fallback:any):any }
 * @param {Object} [deps.eventBus]  - { emit(evt:string, payload:any):void }
 * @param {Object} [deps.analytics] - { track(evt:string, payload:any):void }
 * @param {Object} [deps.prefs]     - { get(key:string):any, set(key:string,val:any):void, subscribe?(fn:Function):Function }
 * @param {Object} [deps.recalls]   - { link(ingredient:string): Array<{id:string,title:string,region?:string,url?:string,dateISO?:string}> }
 */
export function createHarmfulIngredientRules(deps = {}) {
  const {
    config = safeConfig(),
    eventBus = safeBus(),
    analytics = safeAnalytics(),
    prefs = safePrefs(),
    recalls = safeRecalls(),
  } = deps;

  const NAMESPACE = "scanCompareTrust.safety";
  const PREF_KEY = `${NAMESPACE}.rules.v2`;
  const FEATURE_FLAGS = config.get?.("features.safetyRules", {}) || {};

  /** @type {Rule[]} */
  const DEFAULT_RULES = buildDefaultRules();

  // ----- State (in-memory, hydrated from prefs) -----
  let state = hydrateState();

  // ---------- Public API ----------
  return {
    getVersion,
    listRules,
    getRuleById,
    isEnabled,
    toggleRule,
    upsertCustomRule,
    removeCustomRule,
    evaluateIngredients,
    exportProfile,
    importProfile,
    resetToDefaults,
  };

  // ---------- Implementation ----------

  function getVersion() {
    return "2.0.0";
  }

  function normalizeToken(s) {
    return (s || "")
      .toString()
      .toLowerCase()
      .replace(/[._\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenize(ingredient) {
    const base = normalizeToken(ingredient);
    // also generate a variant without spaces (helps with E-codes like E-171 / E171)
    return [base, base.replace(/\s+/g, "")];
  }

  function hydrateState() {
    // prefs snapshot
    const persisted = prefs.get(PREF_KEY);
    /** @type {{ enabled: Record<string, boolean>, custom: Rule[] }} */
    const blank = { enabled: {}, custom: [] };

    // Merge defaults with persisted toggles/custom rules
    const snapshot = { ...blank, ...(persisted || {}) };
    const catalog = [...DEFAULT_RULES, ...(snapshot.custom || [])];

    // Initialize missing toggles from defaults
    const enabled = { ...snapshot.enabled };
    for (const r of catalog) {
      if (typeof enabled[r.id] === "undefined") {
        enabled[r.id] = !!r.defaultEnabled;
      }
    }

    // Optional feature flags can force-enable/disable categories or ids
    applyFeatureFlags(enabled, catalog, FEATURE_FLAGS);

    const s = { enabled, custom: snapshot.custom || [], catalog };
    persist(s);
    return s;
  }

  function persist(s) {
    try {
      prefs.set(PREF_KEY, { enabled: s.enabled, custom: s.custom });
    } catch (err) {
      // localStorage might be quota-limited; fail silently
      console.warn("[SafetyRules] persist failed", err);
    }
  }

  function listRules({ domain, includeDisabled = true } = {}) {
    return state.catalog.filter((r) => {
      if (domain && r.domain !== domain) return false;
      if (!includeDisabled && !isEnabled(r.id)) return false;
      return true;
    });
  }

  function getRuleById(id) {
    return state.catalog.find((r) => r.id === id) || null;
  }

  function isEnabled(id) {
    return !!state.enabled[id];
  }

  function toggleRule(id, enabled) {
    if (!getRuleById(id)) return false;
    state.enabled[id] = !!enabled;
    persist(state);
    eventBus.emit("safety:rule:toggled", { id, enabled: !!enabled, ts: Date.now() });
    analytics.track?.("safety_rule_toggled", { id, enabled: !!enabled });
    return true;
  }

  function upsertCustomRule(rule) {
    if (!rule?.id) throw new Error("Custom rule must include an 'id'.");
    // remove existing with same id
    state.custom = state.custom.filter((r) => r.id !== rule.id);
    // sanitize minimal shape
    const clean = materializeRule(rule);
    state.custom.push(clean);

    // refresh catalog
    state.catalog = [...DEFAULT_RULES, ...state.custom];

    // ensure toggle present
    if (typeof state.enabled[clean.id] === "undefined") {
      state.enabled[clean.id] = !!clean.defaultEnabled;
    }
    persist(state);
    eventBus.emit("safety:rule:upserted", { id: clean.id, ts: Date.now() });
    analytics.track?.("safety_rule_upserted", { id: clean.id });
    return clean.id;
  }

  function removeCustomRule(id) {
    const before = state.custom.length;
    state.custom = state.custom.filter((r) => r.id !== id);
    if (state.custom.length !== before) {
      state.catalog = [...DEFAULT_RULES, ...state.custom];
      delete state.enabled[id];
      persist(state);
      eventBus.emit("safety:rule:removed", { id, ts: Date.now() });
      analytics.track?.("safety_rule_removed", { id });
      return true;
    }
    return false;
  }

  /**
   * Evaluate a list of ingredients against active rules.
   * @param {string[]} ingredientsRaw
   * @param {Object} [ctx]
   * @param {"food"|"cosmetics"|"household"|"garden"|"baby"|"packaging"} [ctx.domain]
   * @param {string} [ctx.region] - "US"|"EU"|...
   * @returns {{ score:number, level:"ok"|"caution"|"avoid"|"critical", hits:MatchHit[], recalls?:any[] }}
   */
  function evaluateIngredients(ingredientsRaw = [], ctx = {}) {
    const domain = ctx.domain || "food";
    const region = ctx.region || "US";
    const ingredients = ingredientsRaw
      .filter(Boolean)
      .map((s) => s.trim())
      .filter((s) => s.length);

    const active = listRules({ domain, includeDisabled: false });
    /** @type {MatchHit[]} */
    const hits = [];

    for (const ing of ingredients) {
      const tokens = tokenize(ing);
      for (const rule of active) {
        if (!ruleAppliesWithExceptions(rule, ingredients)) continue;

        // literal patterns / synonyms
        const literalSets = [
          ["pattern", rule.patterns || []],
          ["synonym", rule.synonyms || []],
        ];
        for (const [via, arr] of literalSets) {
          for (const pat of arr) {
            const p = normalizeToken(pat);
            if (tokens.includes(p) || tokens.includes(p.replace(/\s+/g, ""))) {
              hits.push(toHit(rule, ing, /** @type {any} */ (via), pat));
              break;
            }
          }
        }

        // CAS
        for (const cas of rule.cas || []) {
          const casNorm = cas.replace(/\s+/g, "");
          if (ing.replace(/\s+/g, "").includes(casNorm)) {
            hits.push(toHit(rule, ing, "cas", cas));
            break;
          }
        }

        // E-numbers
        for (const e of rule.enumbers || []) {
          // accept "e171", "E171", "E-171", "E 171"
          const variants = [
            e,
            e.toLowerCase(),
            e.toUpperCase(),
            e.toLowerCase().replace("-", ""),
            e.toUpperCase().replace("-", ""),
            e.toLowerCase().replace(/\s+/g, ""),
          ];
          const ingFold = ing.toLowerCase().replace(/\s+/g, "");
          if (variants.some((v) => ingFold.includes(v.toLowerCase()))) {
            hits.push(toHit(rule, ing, "enumber", e));
            break;
          }
        }

        // regex
        for (const rx of rule.regex || []) {
          if (rx.test(ing)) {
            hits.push(toHit(rule, ing, "regex", rx.toString()));
            break;
          }
        }
      }
    }

    // De-dup same rule/ingredient via priority (keep single, highest-severity occurrence)
    const dedup = deduplicateHits(hits);

    // Aggregate score
    const score = dedup.reduce((acc, h) => acc + (h.scoreImpact || 0), 0);
    const level = scoreToLevel(score);

    // Optional recall linkage (best-effort)
    let recallMatches = [];
    try {
      const uniqTokens = Array.from(new Set(ingredients.map(normalizeToken)));
      recallMatches = uniqTokens.flatMap((t) => recalls.link(t) || []);
    } catch (_) {
      /* no-op */
    }

    const payload = {
      score,
      level,
      hits: dedup,
      ...(recallMatches?.length ? { recalls: recallMatches } : {}),
    };

    eventBus.emit("safety:scan:evaluated", { ...payload, domain, region, ts: Date.now() });
    analytics.track?.("safety_scan_evaluated", { score, level, domain, region, hits: dedup.length });

    return payload;
  }

  function exportProfile() {
    const profile = {
      version: getVersion(),
      enabled: state.enabled,
      custom: state.custom,
      exportedAt: new Date().toISOString(),
    };
    return JSON.parse(JSON.stringify(profile));
  }

  function importProfile(profile) {
    if (!profile || typeof profile !== "object") throw new Error("Invalid profile");
    const enabled = profile.enabled || {};
    const custom = Array.isArray(profile.custom) ? profile.custom.map(materializeRule) : [];
    state.enabled = enabled;
    state.custom = custom;
    state.catalog = [...DEFAULT_RULES, ...state.custom];
    persist(state);
    eventBus.emit("safety:profile:imported", { ts: Date.now() });
    return true;
  }

  function resetToDefaults() {
    state = {
      enabled: {},
      custom: [],
      catalog: [...DEFAULT_RULES],
    };
    // repopulate toggles from defaults
    for (const r of state.catalog) state.enabled[r.id] = !!r.defaultEnabled;
    persist(state);
    eventBus.emit("safety:profile:reset", { ts: Date.now() });
    return true;
  }

  // ---------- helpers ----------

  /**
   * Build curated default rules. You can extend freely.
   * Keep ids stable; changing ids loses user toggles.
   * Minimal sources are provided; your UI can render them if present.
   * Regulatory hints allow region-aware filtering downstream if desired.
   * NOTE: Some items include packaging or garden (seed coatings).
   */
  function buildDefaultRules() {
    /** @type {Rule[]} */
    const rules = [
      {
        id: "food:trans-fats",
        name: "Partially Hydrogenated Oils (Trans Fats)",
        domain: "food",
        severity: "critical",
        defaultEnabled: true,
        scoreImpact: 100,
        tags: ["cardio", "oil", "ultra-processed"],
        patterns: [
          "partially hydrogenated",
          "hydrogenated vegetable oil",
          "hydrogenated palm oil",
        ],
        synonyms: ["trans fat", "trans-fat", "trans fatty acids"],
        regex: [/partially\s+hydrogenated/i],
        cas: [],
        enumbers: [],
        rationale:
          "Trans fats raise LDL and lower HDL; associated with cardiovascular risk.",
        sources: [{ label: "FDA", url: "https://www.fda.gov" }],
        exceptions: [],
        regulatory: [{ region: "US", status: "restricted" }, { region: "EU", status: "banned" }],
      },
      {
        id: "food:nitrites-nitrates",
        name: "Sodium Nitrite/Nitrate in Processed Meats",
        domain: "food",
        severity: "high",
        defaultEnabled: true,
        scoreImpact: 70,
        tags: ["cured-meats", "nitrosamines"],
        patterns: ["sodium nitrite", "sodium nitrate", "potassium nitrite", "potassium nitrate"],
        synonyms: ["naNO2", "naNO3"],
        regex: [],
        cas: ["7632-00-0", "7757-79-1"],
        enumbers: ["E249", "E250", "E251", "E252"],
        rationale:
          "Nitrites/nitrates in processed meats can form nitrosamines during cooking.",
        sources: [{ label: "IARC", url: "https://www.iarc.who.int" }],
        exceptions: [
          { ifIncludes: ["ascorbic acid", "erythorbate"], exemptIfIncludes: [] }, // reduced nitrosation risk
        ],
        regulatory: [{ region: "EU", status: "restricted" }],
      },
      {
        id: "food:artificial-colors-red40-yellow5-6",
        name: "Synthetic Colors (Red 40, Yellow 5, Yellow 6)",
        domain: "food",
        severity: "medium",
        defaultEnabled: true,
        scoreImpact: 45,
        tags: ["colorant", "hyperactivity"],
        patterns: ["red 40", "yellow 5", "yellow 6"],
        synonyms: ["allura red", "tartrazine", "sunset yellow"],
        regex: [/fd&c\s*(red|yellow)\s*\d+/i, /(allura\s*red|tartrazine|sunset\s*yellow)/i],
        cas: [],
        enumbers: ["E129", "E102", "E110"],
        rationale: "Some synthetic colors have behavioral concerns in children and warnings in the EU.",
        sources: [],
        exceptions: [],
        regulatory: [{ region: "EU", status: "warning" }],
      },
      {
        id: "food:red3",
        name: "Erythrosine (Red 3)",
        domain: "food",
        severity: "high",
        defaultEnabled: true,
        scoreImpact: 60,
        tags: ["colorant"],
        patterns: ["red 3", "erythrosine"],
        synonyms: [],
        regex: [/red\s*3/i, /erythrosine/i],
        cas: ["16423-68-0"],
        enumbers: ["E127"],
        rationale: "Restricted/banned for certain uses in various regions.",
        sources: [],
        exceptions: [],
        regulatory: [{ region: "US", status: "restricted" }, { region: "EU", status: "restricted" }],
      },
      {
        id: "food:titanium-dioxide",
        name: "Titanium Dioxide",
        domain: "food",
        severity: "high",
        defaultEnabled: true,
        scoreImpact: 70,
        tags: ["colorant", "nano"],
        patterns: ["titanium dioxide"],
        synonyms: ["tio2"],
        regex: [/titanium\s+dioxide/i],
        cas: ["13463-67-7"],
        enumbers: ["E171"],
        rationale: "EU no longer authorizes TiO₂ as a food additive; potential nano-particle concerns.",
        sources: [],
        exceptions: [],
        regulatory: [{ region: "EU", status: "banned" }],
      },
      {
        id: "food:aspartame",
        name: "Aspartame",
        domain: "food",
        severity: "medium",
        defaultEnabled: true,
        scoreImpact: 40,
        tags: ["sweetener"],
        patterns: ["aspartame"],
        synonyms: ["e951"],
        regex: [/aspartame/i],
        cas: ["22839-47-0"],
        enumbers: ["E951"],
        rationale: "Artificial sweetener; some consumers prefer to avoid.",
        sources: [],
        exceptions: [],
        regulatory: [],
      },
      {
        id: "food:sucralose",
        name: "Sucralose",
        domain: "food",
        severity: "medium",
        defaultEnabled: false,
        scoreImpact: 35,
        tags: ["sweetener"],
        patterns: ["sucralose"],
        synonyms: ["e955"],
        regex: [/sucralose/i],
        cas: ["56038-13-2"],
        enumbers: ["E955"],
        rationale: "Artificial sweetener; toggle according to household preference.",
        sources: [],
        exceptions: [],
        regulatory: [],
      },
      {
        id: "food:carrageenan",
        name: "Carrageenan",
        domain: "food",
        severity: "medium",
        defaultEnabled: false,
        scoreImpact: 30,
        tags: ["stabilizer", "thickener"],
        patterns: ["carrageenan"],
        synonyms: [],
        regex: [/carrageenan/i],
        cas: [],
        enumbers: ["E407", "E407a"],
        rationale: "Emulsifier concerns for sensitive individuals; user-toggle.",
        sources: [],
        exceptions: [],
        regulatory: [],
      },
      {
        id: "food:potassium-bromate",
        name: "Potassium Bromate (Flour Improver)",
        domain: "food",
        severity: "high",
        defaultEnabled: true,
        scoreImpact: 70,
        tags: ["bakery", "flour-improver"],
        patterns: ["potassium bromate"],
        synonyms: [],
        regex: [/potassium\s+bromate/i],
        cas: ["7758-01-2"],
        enumbers: [],
        rationale: "Banned in many countries; residuals in baked goods are a concern.",
        sources: [],
        exceptions: [],
        regulatory: [{ region: "EU", status: "banned" }, { region: "CA", status: "banned" }],
      },
      {
        id: "food:azodicarbonamide",
        name: "Azodicarbonamide (ADA)",
        domain: "food",
        severity: "medium",
        defaultEnabled: true,
        scoreImpact: 50,
        tags: ["bakery", "dough-conditioner"],
        patterns: ["azodicarbonamide"],
        synonyms: ["ada"],
        regex: [/azodicarbonamide/i, /\bADA\b/i],
        cas: ["123-77-3"],
        enumbers: ["E927a"],
        rationale: "Dough conditioner with regional restrictions.",
        sources: [],
        exceptions: [],
        regulatory: [{ region: "EU", status: "banned" }],
      },
      {
        id: "food:sodium-benzoate-benzene-risk",
        name: "Sodium Benzoate + Ascorbic Acid (Benzene Risk)",
        domain: "food",
        severity: "medium",
        defaultEnabled: true,
        scoreImpact: 55,
        tags: ["preservative", "interaction-risk"],
        patterns: ["sodium benzoate", "potassium benzoate", "ascorbic acid", "vitamin c"],
        synonyms: ["e211", "e212", "e300"],
        regex: [],
        cas: ["532-32-1", "582-25-2", "50-81-7"],
        enumbers: ["E211", "E212", "E300"],
        rationale:
          "Combination of benzoates with ascorbic acid may form benzene under certain conditions.",
        sources: [],
        exceptions: [], // We do interaction logic via ruleAppliesWithExceptions
        regulatory: [],
      },
      {
        id: "packaging:bpa-bps",
        name: "BPA/BPS (Packaging)",
        domain: "packaging",
        severity: "medium",
        defaultEnabled: true,
        scoreImpact: 40,
        tags: ["endocrine", "packaging"],
        patterns: ["bisphenol a", "bisphenol s", "bpa", "bps"],
        synonyms: [],
        regex: [/\bBPA\b/i, /\bBPS\b/i, /bisphenol\s+[as]/i],
        cas: ["80-05-7", "80-09-1"],
        enumbers: [],
        rationale: "Endocrine concerns with certain can linings and receipts.",
        sources: [],
        exceptions: [],
        regulatory: [{ region: "EU", status: "restricted" }],
      },
      {
        id: "cosmetics:parabens",
        name: "Parabens (Propyl/Butyl/Isobutyl)",
        domain: "cosmetics",
        severity: "medium",
        defaultEnabled: true,
        scoreImpact: 45,
        tags: ["preservative", "endocrine"],
        patterns: ["propylparaben", "butylparaben", "isobutylparaben"],
        synonyms: [],
        regex: [/propylparaben|butylparaben|isobutylparaben/i],
        cas: [],
        enumbers: [],
        rationale: "Certain parabens have endocrine concerns and regional restrictions.",
        sources: [],
        exceptions: [],
        regulatory: [{ region: "EU", status: "restricted" }],
      },
      {
        id: "cosmetics:formaldehyde-releasers",
        name: "Formaldehyde Releasers",
        domain: "cosmetics",
        severity: "high",
        defaultEnabled: true,
        scoreImpact: 65,
        tags: ["preservative", "sensitizer"],
        patterns: [
          "diazolidinyl urea",
          "imidazolidinyl urea",
          "dmdm hydantoin",
          "quaternium-15",
          "bronopol",
          "2-bromo-2-nitropropane-1,3-diol",
        ],
        synonyms: ["BNPD", "DMHF"],
        regex: [/dmdm\s*hydantoin/i, /quaternium[-\s]*15/i],
        cas: [],
        enumbers: [],
        rationale: "Release formaldehyde over time; allergen/sensitizer concerns.",
        sources: [],
        exceptions: [],
        regulatory: [{ region: "EU", status: "restricted" }],
      },
      {
        id: "household:fragrances-phthalates",
        name: "Fragrance/Phthalates",
        domain: "household",
        severity: "medium",
        defaultEnabled: false,
        scoreImpact: 35,
        tags: ["fragrance", "endocrine", "packaging"],
        patterns: ["fragrance", "parfum", "diethyl phthalate", "dep", "phthalate"],
        synonyms: [],
        regex: [/phthalate/i, /\bfragrance\b|\bparfum\b/i],
        cas: [],
        enumbers: [],
        rationale: "Generic 'fragrance' can mask phthalates; toggle per household preference.",
        sources: [],
        exceptions: [],
        regulatory: [{ region: "EU", status: "restricted" }],
      },
      {
        id: "garden:neonicotinoids-seed-treatment",
        name: "Neonicotinoid Seed Treatments",
        domain: "garden",
        severity: "high",
        defaultEnabled: true,
        scoreImpact: 60,
        tags: ["pollinators", "seed-treatment"],
        patterns: ["imidacloprid", "clothianidin", "thiamethoxam"],
        synonyms: [],
        regex: [/treated\s*seed/i, /neonicotinoid/i],
        cas: ["138261-41-3", "210880-92-5", "153719-23-4"],
        enumbers: [],
        rationale:
          "Pollinator risk. Helpful when scanning seed packs for garden planning.",
        sources: [],
        exceptions: [],
        regulatory: [{ region: "EU", status: "banned" }],
      },
      {
        id: "food:msg",
        name: "Monosodium Glutamate (MSG)",
        domain: "food",
        severity: "low",
        defaultEnabled: false,
        scoreImpact: 20,
        tags: ["flavor enhancer"],
        patterns: ["monosodium glutamate"],
        synonyms: ["msg", "e621"],
        regex: [/\bmsg\b/i],
        cas: ["142-47-2"],
        enumbers: ["E621"],
        rationale: "Flavor enhancer; toggle according to household preference.",
        sources: [],
        exceptions: [],
        regulatory: [],
      },
      {
        id: "food:aluminum-additives",
        name: "Aluminum Additives (Baking Powders, Dyes)",
        domain: "food",
        severity: "medium",
        defaultEnabled: false,
        scoreImpact: 35,
        tags: ["baking", "additive"],
        patterns: [
          "sodium aluminum phosphate",
          "sodium aluminium phosphate",
          "sodium aluminum sulfate",
          "sodium aluminium sulfate",
        ],
        synonyms: [],
        regex: [/sodium\s+alumin(i)?um\s+(phosphate|sulfate)/i],
        cas: [],
        enumbers: [],
        rationale: "Aluminum-containing additives; toggle for aluminum-avoid households.",
        sources: [],
        exceptions: [],
        regulatory: [],
      },
    ];

    // Allow config to append/modify if present
    const extras = Array.isArray(config.get?.("safetyRules.append", null))
      ? config.get("safetyRules.append")
      : [];

    return [...rules, ...extras.map(materializeRule)];
  }

  function materializeRule(r) {
    return {
      id: r.id,
      name: r.name || r.id,
      domain: r.domain || "food",
      severity: r.severity || "medium",
      defaultEnabled: typeof r.defaultEnabled === "boolean" ? r.defaultEnabled : true,
      scoreImpact: Number.isFinite(r.scoreImpact) ? r.scoreImpact : 40,
      tags: Array.isArray(r.tags) ? r.tags : [],
      patterns: (r.patterns || []).map((p) => p.toString()),
      regex: (r.regex || []).map((rx) => (rx instanceof RegExp ? rx : new RegExp(rx, "i"))),
      synonyms: (r.synonyms || []).map((s) => s.toString()),
      cas: (r.cas || []).map((c) => c.toString()),
      enumbers: (r.enumbers || []).map((e) => e.toString().toUpperCase().replace(/\s+/g, "")),
      rationale: r.rationale || "",
      sources: Array.isArray(r.sources) ? r.sources : [],
      exceptions: Array.isArray(r.exceptions) ? r.exceptions : [],
      regulatory: Array.isArray(r.regulatory) ? r.regulatory : [],
    };
  }

  function ruleAppliesWithExceptions(rule, allIngredients) {
    if (!rule?.exceptions?.length) return true;

    const set = new Set(allIngredients.map((s) => normalizeToken(s)));

    for (const ex of rule.exceptions) {
      const includesAll = (ex.ifIncludes || []).every((x) => set.has(normalizeToken(x)));
      if (includesAll) {
        // If there is an "exemptIfIncludes" and it's also present, exemption applies
        if (!ex.exemptIfIncludes || ex.exemptIfIncludes.every((x) => set.has(normalizeToken(x)))) {
          // Exemption cancels the rule
          return false;
        }
      }
    }
    return true;
  }

  /** @returns {MatchHit} */
  function toHit(rule, ingredient, via, matched) {
    return {
      ruleId: rule.id,
      ingredient,
      via,
      matched,
      severity: rule.severity,
      scoreImpact: rule.scoreImpact,
      rationale: rule.rationale,
      tags: rule.tags || [],
    };
  }

  function deduplicateHits(hits) {
    const byKey = new Map();
    for (const h of hits) {
      const key = `${h.ruleId}::${normalizeToken(h.ingredient)}`;
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, h);
      } else {
        // keep the one with higher scoreImpact (proxy for priority)
        if ((h.scoreImpact || 0) > (prev.scoreImpact || 0)) byKey.set(key, h);
      }
    }
    return Array.from(byKey.values());
  }

  function scoreToLevel(score) {
    if (score >= 160) return "critical";
    if (score >= 90) return "avoid";
    if (score >= 45) return "caution";
    return "ok";
  }

  function applyFeatureFlags(enabled, catalog, flags) {
    try {
      if (!flags) return;
      // Example: { forceDisable: ["cosmetics:*"], forceEnable: ["food:red3"] }
      const { forceDisable = [], forceEnable = [] } = flags;
      const disableMatchers = (forceDisable || []).map(toMatcher);
      const enableMatchers = (forceEnable || []).map(toMatcher);

      for (const r of catalog) {
        if (disableMatchers.some((m) => m(r))) enabled[r.id] = false;
        if (enableMatchers.some((m) => m(r))) enabled[r.id] = true;
      }
    } catch (_) {
      /* no-op */
    }

    function toMatcher(expr) {
      // supports "domain:*" or "domain:id"
      const [lhs, rhs] = String(expr).split(":");
      return (rule) => {
        if (!rhs || rhs === "*") return rule.domain === lhs;
        return rule.id === expr;
      };
    }
  }

  // ---------- safe fallback adapters ----------

  function safeBus() {
    return { emit: () => {} };
  }

  function safeAnalytics() {
    return { track: () => {} };
  }

  function safeConfig() {
    return { get: (_p, fb) => fb };
  }

  function safePrefs() {
    let memory = {};
    let lsOk = false;
    try {
      localStorage.setItem("__safety_probe", "1");
      localStorage.removeItem("__safety_probe");
      lsOk = true;
    } catch (_) {
      lsOk = false;
    }
    return {
      get(k) {
        if (lsOk) {
          const raw = localStorage.getItem(k);
          return raw ? JSON.parse(raw) : null;
        }
        return memory[k] || null;
      },
      set(k, v) {
        if (lsOk) {
          localStorage.setItem(k, JSON.stringify(v));
        } else {
          memory[k] = v;
        }
      },
    };
  }

  function safeRecalls() {
    return {
      link: (_ingredient) => [],
    };
  }
}

// ----- Convenience default singleton (optional import pattern) -----

let __singleton;
export function getHarmfulIngredientRulesSingleton(deps) {
  if (!__singleton) __singleton = createHarmfulIngredientRules(deps);
  return __singleton;
}

// ----- Example: quick predicate helpers your UI can use -----

/**
 * @param {{ level:"ok"|"caution"|"avoid"|"critical" }} evalResult
 */
export function isUnsafe(evalResult) {
  return evalResult?.level === "avoid" || evalResult?.level === "critical";
}

/**
 * @param {MatchHit[]} hits
 * @param {string} tag
 */
export function hasTag(hits, tag) {
  return (hits || []).some((h) => h.tags?.includes(tag));
}
