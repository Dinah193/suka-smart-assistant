/* eslint-disable no-console */
// src/features/scan-compare-trust/services/safety/AllergenMatcher.js
// Dynamic, profile-aware allergen matcher with curated defaults + custom entries.

/**
 * @typedef {"direct"|"may_contain"|"facility"|"cross_contact"} EvidenceLevel
 * @typedef {"low"|"medium"|"high"|"critical"} Severity
 *
 * @typedef {Object} Allergen
 * @property {string} id                - canonical id, e.g., "allergen:peanut"
 * @property {string} name              - Human name
 * @property {string[]} synonyms        - tokens/phrases (normalized)
 * @property {string[]} includes        - sub-terms (e.g., "casein","ghee" -> milk)
 * @property {("food"|"cosmetics"|"household")} domain
 * @property {Severity} defaultSeverity - baseline severity if user enables it
 *
 * @typedef {Object} ProfileEntry
 * @property {string} allergenId
 * @property {boolean} enabled
 * @property {Severity} severity
 *
 * @typedef {Object} Profile
 * @property {string} id
 * @property {string} label               - e.g., "Rhonda — Severe Peanut/Gluten"
 * @property {"food"|"cosmetics"|"household"} domain
 * @property {Record<string, ProfileEntry>} entries  - keyed by allergenId
 * @property {string[]} customTokens       - user custom tokens to flag
 * @property {boolean} respectAdvisories   - count "may contain"/"facility" as hits
 * @property {boolean} highlightCrossContact
 * @property {boolean} glutenAsCritical    - escalate gluten group to critical
 * @property {boolean} sesameEnabledByDefault
 *
 * @typedef {Object} MatchHit
 * @property {string} allergenId
 * @property {string} allergenName
 * @property {string} matchedToken
 * @property {EvidenceLevel} evidence
 * @property {Severity} severity
 * @property {string} ingredient
 * @property {string} via                - "synonym" | "include" | "custom" | "advisory"
 * @property {string[]} tags             - e.g., ["top9","gluten-group","tree-nut"]
 * @property {number} scoreImpact
 *
 * @typedef {Object} EvaluateResult
 * @property {number} score
 * @property {"ok"|"caution"|"avoid"|"critical"} level
 * @property {MatchHit[]} hits
 * @property {string} profileId
 * @property {string} profileLabel
 */

export function createAllergenMatcher(deps = {}) {
  const {
    config = safeConfig(),
    prefs = safePrefs(),
    eventBus = safeBus(),
    analytics = safeAnalytics(),
  } = deps;

  const NS = "scanCompareTrust.allergens";
  const PREF_KEY = `${NS}.profiles.v2`;
  const ACTIVE_KEY = `${NS}.activeProfileId.v2`;

  /** @type {Allergen[]} */
  const CATALOG = buildCuratedAllergens(config);

  /** @type {{ profiles: Record<string, Profile>, activeId: string|null }} */
  let state = hydrate();

  return {
    // Profile lifecycle
    listProfiles,
    getActiveProfile,
    setActiveProfile,
    upsertProfile,
    removeProfile,
    exportProfiles,
    importProfiles,
    duplicateProfileAsFavorite,

    // Allergen catalog
    listCatalog,
    getAllergenById,
    toggleAllergen,
    setAllergenSeverity,
    addCustomToken,
    removeCustomToken,

    // Evaluation
    evaluate,
    getVersion,
  };

  // -------- impl

  function getVersion() {
    return "2.0.0";
  }

  function normalize(s) {
    return (s || "")
      .toString()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "") // strip diacritics
      .replace(/[._\-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function tokenizeLine(line) {
    const base = normalize(line);
    return [
      base,
      base.replace(/\s+/g, ""), // joinwords
    ];
  }

  function hydrate() {
    const stored = prefs.get(PREF_KEY) || {};
    const profiles = stored.profiles || {};
    let activeId = prefs.get(ACTIVE_KEY) || null;

    // If none exist, seed with a sensible default household profile
    if (!Object.keys(profiles).length) {
      const pid = `profile:household-default`;
      profiles[pid] = defaultProfile(pid);
      activeId = pid;
      persist({ profiles, activeId });
    }

    // Ensure catalog entries exist in each profile
    for (const pid of Object.keys(profiles)) {
      const p = profiles[pid];
      p.entries ||= {};
      for (const a of CATALOG) {
        if (!p.entries[a.id]) {
          p.entries[a.id] = {
            allergenId: a.id,
            enabled: false,
            severity: a.defaultSeverity,
          };
        }
      }
      // Sesame default flag (US recent change)
      if (p.sesameEnabledByDefault && p.entries["allergen:sesame"]) {
        p.entries["allergen:sesame"].enabled = true;
      }
    }

    // Fallback for missing active
    if (!activeId) activeId = Object.keys(profiles)[0] || null;

    return { profiles, activeId };
  }

  function persist(s) {
    try {
      prefs.set(PREF_KEY, { profiles: s.profiles });
      prefs.set(ACTIVE_KEY, s.activeId);
    } catch (e) {
      console.warn("[AllergenMatcher] persist failed", e);
    }
  }

  function listCatalog({ domain } = {}) {
    return CATALOG.filter((a) => (domain ? a.domain === domain : true));
  }

  function listProfiles() {
    return Object.values(state.profiles);
  }

  function getActiveProfile() {
    return state.profiles[state.activeId] || null;
  }

  function setActiveProfile(profileId) {
    if (!state.profiles[profileId]) return false;
    state.activeId = profileId;
    persist(state);
    eventBus.emit("allergen:profile:activated", { profileId, ts: Date.now() });
    return true;
  }

  function upsertProfile(profile) {
    if (!profile?.id) throw new Error("Profile requires an id");
    const mat = materializeProfile(profile);
    state.profiles[mat.id] = mat;
    // Backfill entries for new allergens
    for (const a of CATALOG) {
      if (!mat.entries[a.id]) {
        mat.entries[a.id] = {
          allergenId: a.id,
          enabled: false,
          severity: a.defaultSeverity,
        };
      }
    }
    // Keep active if first/only
    if (!state.activeId) state.activeId = mat.id;
    persist(state);
    eventBus.emit("allergen:profile:upserted", { profileId: mat.id, ts: Date.now() });
    return mat.id;
  }

  function removeProfile(profileId) {
    if (!state.profiles[profileId]) return false;
    const wasActive = state.activeId === profileId;
    delete state.profiles[profileId];
    if (wasActive) {
      state.activeId = Object.keys(state.profiles)[0] || null;
    }
    persist(state);
    eventBus.emit("allergen:profile:removed", { profileId, ts: Date.now() });
    return true;
  }

  function duplicateProfileAsFavorite(profileId, newLabel) {
    const base = state.profiles[profileId];
    if (!base) return null;
    const id = `profile:fav:${Date.now()}`;
    const copy = JSON.parse(JSON.stringify(base));
    copy.id = id;
    copy.label = newLabel || `${base.label} ★ Favorite`;
    state.profiles[id] = copy;
    persist(state);
    eventBus.emit("allergen:profile:duplicated", { from: profileId, to: id, ts: Date.now() });
    return id;
  }

  function exportProfiles() {
    const payload = {
      version: getVersion(),
      exportedAt: new Date().toISOString(),
      activeId: state.activeId,
      profiles: state.profiles,
    };
    return JSON.parse(JSON.stringify(payload));
  }

  function importProfiles(bundle) {
    if (!bundle || typeof bundle !== "object") throw new Error("Invalid profile bundle");
    const { profiles = {}, activeId = null } = bundle;
    // Sanitize incoming
    const cleaned = {};
    for (const pid of Object.keys(profiles)) {
      cleaned[pid] = materializeProfile(profiles[pid]);
    }
    state.profiles = cleaned;
    state.activeId = activeId && cleaned[activeId] ? activeId : Object.keys(cleaned)[0] || null;
    // Backfill for new catalog entries
    for (const p of Object.values(state.profiles)) {
      p.entries ||= {};
      for (const a of CATALOG) {
        if (!p.entries[a.id]) {
          p.entries[a.id] = {
            allergenId: a.id,
            enabled: false,
            severity: a.defaultSeverity,
          };
        }
      }
    }
    persist(state);
    eventBus.emit("allergen:profile:imported", { ts: Date.now() });
    return true;
  }

  function toggleAllergen(profileId, allergenId, enabled) {
    const p = state.profiles[profileId];
    const a = getAllergenById(allergenId);
    if (!p || !a) return false;
    p.entries[allergenId] ||= { allergenId, enabled: false, severity: a.defaultSeverity };
    p.entries[allergenId].enabled = !!enabled;
    persist(state);
    const payload = { profileId, allergenId, enabled: !!enabled, ts: Date.now() };
    eventBus.emit("allergen:entry:toggled", payload);
    analytics.track?.("allergen_entry_toggled", payload);
    return true;
  }

  function setAllergenSeverity(profileId, allergenId, severity) {
    const p = state.profiles[profileId];
    const a = getAllergenById(allergenId);
    if (!p || !a) return false;
    p.entries[allergenId] ||= { allergenId, enabled: false, severity: a.defaultSeverity };
    p.entries[allergenId].severity = severity;
    persist(state);
    eventBus.emit("allergen:entry:severity", { profileId, allergenId, severity, ts: Date.now() });
    return true;
  }

  function addCustomToken(profileId, token) {
    const p = state.profiles[profileId];
    if (!p) return false;
    const t = normalize(token);
    p.customTokens ||= [];
    if (!p.customTokens.includes(t)) p.customTokens.push(t);
    persist(state);
    eventBus.emit("allergen:custom:add", { profileId, token: t, ts: Date.now() });
    return true;
  }

  function removeCustomToken(profileId, token) {
    const p = state.profiles[profileId];
    if (!p) return false;
    const t = normalize(token);
    p.customTokens = (p.customTokens || []).filter((x) => x !== t);
    persist(state);
    eventBus.emit("allergen:custom:remove", { profileId, token: t, ts: Date.now() });
    return true;
  }

  function getAllergenById(id) {
    return CATALOG.find((a) => a.id === id) || null;
  }

  /**
   * Evaluate ingredient lists + label advisories.
   * @param {string[]} ingredientsRaw - raw ingredient lines or tokens
   * @param {Object} [ctx]
   * @param {string} [ctx.profileId]       - fallback to active
   * @param {"food"|"cosmetics"|"household"} [ctx.domain]
   * @param {string} [ctx.labelText]       - full label text (advisories)
   * @returns {EvaluateResult}
   */
  function evaluate(ingredientsRaw = [], ctx = {}) {
    const profile = state.profiles[ctx.profileId] || getActiveProfile();
    if (!profile) {
      return { score: 0, level: "ok", hits: [], profileId: "", profileLabel: "" };
    }
    const domain = ctx.domain || profile.domain || "food";
    const enabledIds = Object.values(profile.entries)
      .filter((e) => e.enabled)
      .map((e) => e.allergenId);

    const enabledAllergens = CATALOG.filter(
      (a) => a.domain === domain && enabledIds.includes(a.id)
    );

    const ingredients = (ingredientsRaw || [])
      .filter(Boolean)
      .map((s) => s.trim())
      .filter((s) => s.length);

    /** @type {MatchHit[]} */
    const hits = [];

    // Direct token matches (synonyms/includes/custom)
    for (const line of ingredients) {
      const toks = tokenizeLine(line);
      for (const a of enabledAllergens) {
        // synonyms
        for (const syn of a.synonyms || []) {
          const n = normalize(syn);
          if (toks.includes(n) || toks.includes(n.replace(/\s+/g, ""))) {
            hits.push(toHit(profile, a, line, "synonym", syn, "direct"));
            break;
          }
        }
        // includes (sub-ingredients that imply the allergen)
        for (const inc of a.includes || []) {
          const n = normalize(inc);
          if (toks.includes(n) || toks.includes(n.replace(/\s+/g, ""))) {
            hits.push(toHit(profile, a, line, "include", inc, "direct"));
            break;
          }
        }
      }

      // custom tokens
      for (const c of profile.customTokens || []) {
        if (toks.includes(c) || toks.includes(c.replace(/\s+/g, ""))) {
          hits.push({
            allergenId: "custom",
            allergenName: "Custom Flag",
            matchedToken: c,
            evidence: "direct",
            severity: "medium",
            ingredient: line,
            via: "custom",
            tags: ["custom"],
            scoreImpact: 35,
          });
        }
      }
    }

    // Advisory parsing (“Contains:”, “May contain:”, “Manufactured in a facility…”)
    const label = normalize(ctx.labelText || "");
    if (label && (profile.respectAdvisories || profile.highlightCrossContact)) {
      const advisoryBlocks = parseAdvisories(label);
      for (const a of enabledAllergens) {
        if (advisoryBlocks.contains.has(a.id)) {
          hits.push(toHit(profile, a, "label", "advisory", "contains", "direct"));
        }
        if (profile.respectAdvisories) {
          if (advisoryBlocks.mayContain.has(a.id)) {
            hits.push(toHit(profile, a, "label", "advisory", "may_contain", "may_contain"));
          }
        }
        if (profile.highlightCrossContact && advisoryBlocks.facility.has(a.id)) {
          hits.push(toHit(profile, a, "label", "advisory", "facility", "facility"));
        }
      }
    }

    // Deduplicate by allergen + ingredient/evidence keeping highest impact
    const dedup = dedupe(hits);

    // Gluten escalation if configured
    if (profile.glutenAsCritical) {
      for (const h of dedup) {
        if (h.tags.includes("gluten-group")) h.severity = "critical";
      }
    }

    // Aggregate score
    const score = dedup.reduce((acc, h) => acc + (h.scoreImpact || 0), 0);
    const level = scoreToLevel(score);

    const result = {
      score,
      level,
      hits: dedup,
      profileId: profile.id,
      profileLabel: profile.label,
    };

    eventBus.emit("safety:allergen:evaluated", {
      ...result,
      domain,
      ts: Date.now(),
    });
    analytics.track?.("allergen_scan_evaluated", {
      score,
      level,
      hits: dedup.length,
      domain,
    });

    return result;
  }

  // ---- helpers

  /** @returns {MatchHit} */
  function toHit(profile, allergen, ingredient, via, matchedToken, evidence) {
    const entry = profile.entries[allergen.id] || { severity: allergen.defaultSeverity };
    const sev = entry.severity || allergen.defaultSeverity;
    const tags = collectTags(allergen.id);
    const impact = severityToImpact(sev, evidence);
    return {
      allergenId: allergen.id,
      allergenName: allergen.name,
      matchedToken: matchedToken,
      evidence: /** @type {EvidenceLevel} */ (evidence),
      severity: sev,
      ingredient: typeof ingredient === "string" ? ingredient : "",
      via,
      tags,
      scoreImpact: impact,
    };
  }

  function collectTags(id) {
    if (TOP9.has(id)) return ["top9"];
    if (GLUTEN_IDS.has(id)) return ["gluten-group"];
    if (TREE_NUT_IDS.has(id)) return ["tree-nut"];
    if (SHELLFISH_IDS.has(id)) return ["shellfish"];
    return [];
  }

  function severityToImpact(sev, evidence) {
    const base = { low: 20, medium: 40, high: 65, critical: 90 }[sev] || 40;
    const mod =
      evidence === "direct" ? 1.0 :
      evidence === "may_contain" ? 0.6 :
      evidence === "facility" ? 0.45 :
      evidence === "cross_contact" ? 0.5 : 1.0;
    return Math.round(base * mod);
  }

  function dedupe(hits) {
    const map = new Map();
    for (const h of hits) {
      const key = `${h.allergenId}::${h.matchedToken}::${h.evidence}`;
      const prev = map.get(key);
      if (!prev || h.scoreImpact > prev.scoreImpact) map.set(key, h);
    }
    return Array.from(map.values());
  }

  function scoreToLevel(score) {
    if (score >= 160) return "critical";
    if (score >= 90) return "avoid";
    if (score >= 45) return "caution";
    return "ok";
  }

  function parseAdvisories(labelNorm) {
    // Build alias → allergenId lookup
    const byAlias = new Map();
    for (const a of CATALOG) {
      for (const tok of [...a.synonyms, ...a.includes]) {
        byAlias.set(normalize(tok), a.id);
        byAlias.set(normalize(tok).replace(/\s+/g, ""), a.id);
      }
    }

    const contains = new Set();
    const mayContain = new Set();
    const facility = new Set();

    // Extract segments after advisory cues
    const cues = [
      { rx: /\bcontains\s*:?\s*([^.;\n]+)/i, bucket: contains },
      { rx: /\bmay\s*contain\s*:?\s*([^.;\n]+)/i, bucket: mayContain },
      {
        rx: /\b(manufactured|processed|made)\s+in\s+(a\s+)?(facility|plant).{0,20}\bwith\b\s*([^.;\n]+)/i,
        bucket: facility,
      },
    ];

    for (const { rx, bucket } of cues) {
      const m = labelNorm.match(rx);
      if (m && m[1]) {
        const seg = normalize(m[1]);
        const pieces = seg.split(/[,/]|and|&/).map((s) => normalize(s)).filter(Boolean);
        for (const p of pieces) {
          const p2 = p.replace(/\s+/g, "");
          const id = byAlias.get(p) || byAlias.get(p2);
          if (id) bucket.add(id);
        }
      }
    }

    return { contains, mayContain, facility };
  }

  // ---- materializers

  function materializeProfile(p) {
    const id = p.id || `profile:${Date.now()}`;
    const out = {
      id,
      label: p.label || "Untitled Profile",
      domain: p.domain || "food",
      entries: p.entries || {},
      customTokens: (p.customTokens || []).map((t) => normalize(t)),
      respectAdvisories: !!p.respectAdvisories,
      highlightCrossContact: !!p.highlightCrossContact,
      glutenAsCritical: !!p.glutenAsCritical,
      sesameEnabledByDefault: !!p.sesameEnabledByDefault,
    };
    return out;
  }

  function defaultProfile(id) {
    /** @type {Profile} */
    return {
      id,
      label: "Household Default",
      domain: "food",
      entries: {}, // hydrated later
      customTokens: [],
      respectAdvisories: true,
      highlightCrossContact: true,
      glutenAsCritical: true,
      sesameEnabledByDefault: true,
    };
  }

  // ---- curated catalog

  const TOP9 = new Set([
    "allergen:milk",
    "allergen:egg",
    "allergen:peanut",
    "allergen:tree-nut",
    "allergen:wheat",
    "allergen:soy",
    "allergen:fish",
    "allergen:crustacean-shellfish",
    "allergen:sesame",
  ]);

  const TREE_NUT_IDS = new Set([
    "allergen:tree-nut",
  ]);

  const SHELLFISH_IDS = new Set([
    "allergen:crustacean-shellfish",
    "allergen:mollusk-shellfish",
  ]);

  const GLUTEN_IDS = new Set([
    "allergen:wheat",
    "allergen:gluten",
    "allergen:barley",
    "allergen:rye",
    "allergen:oats-contamination",
  ]);

  function buildCuratedAllergens(cfg) {
    /** @type {Allergen[]} */
    const base = [
      {
        id: "allergen:milk",
        name: "Milk",
        domain: "food",
        defaultSeverity: "high",
        synonyms: ["milk", "dairy"],
        includes: ["casein", "caseinate", "whey", "lactose", "ghee", "butterfat", "curds"],
      },
      {
        id: "allergen:egg",
        name: "Egg",
        domain: "food",
        defaultSeverity: "high",
        synonyms: ["egg", "eggs"],
        includes: ["albumen", "ovalbumin", "lysozyme"],
      },
      {
        id: "allergen:peanut",
        name: "Peanut",
        domain: "food",
        defaultSeverity: "critical",
        synonyms: ["peanut", "groundnut", "arachis hypogaea"],
        includes: ["peanut flour", "peanut oil (unrefined)", "peanut butter"],
      },
      {
        id: "allergen:tree-nut",
        name: "Tree Nut (Group)",
        domain: "food",
        defaultSeverity: "critical",
        synonyms: [
          "almond", "walnut", "pecan", "pistachio", "cashew", "hazelnut", "filbert",
          "brazil nut", "macadamia", "pine nut", "pignolia", "chestnut",
        ],
        includes: [
          "praline", "nut butter", "marzipan", "frangipane", "nut paste",
          "gianduja", "nougat",
        ],
      },
      {
        id: "allergen:wheat",
        name: "Wheat",
        domain: "food",
        defaultSeverity: "high",
        synonyms: ["wheat"],
        includes: ["durum", "semolina", "spelt", "farina", "farro", "graham"],
      },
      {
        id: "allergen:gluten",
        name: "Gluten (Group)",
        domain: "food",
        defaultSeverity: "high",
        synonyms: ["gluten"],
        includes: ["malt", "malt extract", "malt syrup", "brewer's yeast", "seitan"],
      },
      {
        id: "allergen:barley",
        name: "Barley",
        domain: "food",
        defaultSeverity: "high",
        synonyms: ["barley"],
        includes: ["hordeum", "malt", "malted barley", "maltodextrin (barley)"],
      },
      {
        id: "allergen:rye",
        name: "Rye",
        domain: "food",
        defaultSeverity: "high",
        synonyms: ["rye"],
        includes: ["secale"],
      },
      {
        id: "allergen:oats-contamination",
        name: "Oats (Cross-Contact Risk)",
        domain: "food",
        defaultSeverity: "medium",
        synonyms: ["oat", "oats"],
        includes: ["avenin"],
      },
      {
        id: "allergen:soy",
        name: "Soy",
        domain: "food",
        defaultSeverity: "high",
        synonyms: ["soy", "soya", "soybean"],
        includes: ["soy lecithin", "edamame", "tofu", "tempeh", "textured vegetable protein"],
      },
      {
        id: "allergen:fish",
        name: "Fish",
        domain: "food",
        defaultSeverity: "high",
        synonyms: [
          "fish", "salmon", "tuna", "cod", "haddock", "tilapia", "anchovy", "sardine",
          "trout", "mackerel", "halibut", "pollock",
        ],
        includes: ["fish oil", "omega-3 (fish)", "anchovy paste", "fish sauce"],
      },
      {
        id: "allergen:crustacean-shellfish",
        name: "Crustacean Shellfish",
        domain: "food",
        defaultSeverity: "critical",
        synonyms: ["shrimp", "prawn", "crab", "lobster", "crayfish", "krill"],
        includes: ["chitosan (crustacean)"],
      },
      {
        id: "allergen:mollusk-shellfish",
        name: "Mollusk Shellfish",
        domain: "food",
        defaultSeverity: "high",
        synonyms: ["clam", "oyster", "mussel", "scallop", "abalone", "snail", "whelk"],
        includes: [],
      },
      {
        id: "allergen:sesame",
        name: "Sesame",
        domain: "food",
        defaultSeverity: "high",
        synonyms: ["sesame", "tahini", "til"],
        includes: ["benne", "gingelly"],
      },
      {
        id: "allergen:mustard",
        name: "Mustard",
        domain: "food",
        defaultSeverity: "medium",
        synonyms: ["mustard"],
        includes: ["allyl isothiocyanate", "mustard flour"],
      },
      {
        id: "allergen:sulfites",
        name: "Sulfites",
        domain: "food",
        defaultSeverity: "medium",
        synonyms: ["sulfite", "sulphite"],
        includes: [
          "sodium metabisulfite", "potassium metabisulfite", "sulfur dioxide",
          "sodium bisulfite", "potassium bisulfite",
        ],
      },
      // Cosmetics examples (profile domain "cosmetics")
      {
        id: "allergen:fragrance-mix",
        name: "Fragrance Mix (Cosmetics)",
        domain: "cosmetics",
        defaultSeverity: "medium",
        synonyms: ["fragrance", "parfum"],
        includes: ["cinnamic aldehyde", "isoeugenol", "oak moss"],
      },
      {
        id: "allergen:lanolin",
        name: "Lanolin",
        domain: "cosmetics",
        defaultSeverity: "medium",
        synonyms: ["lanolin", "wool fat"],
        includes: [],
      },
    ];

    const extras = Array.isArray(cfg.get?.("allergens.append")) ? cfg.get("allergens.append") : [];
    return [...base, ...extras.map(materializeAllergen)];
  }

  function materializeAllergen(a) {
    return {
      id: a.id,
      name: a.name || a.id,
      domain: a.domain || "food",
      defaultSeverity: a.defaultSeverity || "high",
      synonyms: (a.synonyms || []).map((s) => normalize(s)),
      includes: (a.includes || []).map((s) => normalize(s)),
    };
  }

  // ---- safe adapters

  function safeBus() {
    return { emit: () => {} };
  }
  function safeConfig() {
    return { get: (_p, fb) => fb };
  }
  function safeAnalytics() {
    return { track: () => {} };
  }
  function safePrefs() {
    let mem = {};
    let ok = false;
    try {
      localStorage.setItem("__allergen_probe", "1");
      localStorage.removeItem("__allergen_probe");
      ok = true;
    } catch (_) {}
    return {
      get(k) {
        if (ok) {
          const raw = localStorage.getItem(k);
          return raw ? JSON.parse(raw) : null;
        }
        return mem[k] || null;
      },
      set(k, v) {
        if (ok) localStorage.setItem(k, JSON.stringify(v));
        else mem[k] = v;
      },
    };
  }
}

// ---- singleton convenience
let __allergenSingleton;
export function getAllergenMatcherSingleton(deps) {
  if (!__allergenSingleton) __allergenSingleton = createAllergenMatcher(deps);
  return __allergenSingleton;
}

// Small helpers your UI may want
export function isAllergenUnsafe(res) {
  return res?.level === "avoid" || res?.level === "critical";
}
