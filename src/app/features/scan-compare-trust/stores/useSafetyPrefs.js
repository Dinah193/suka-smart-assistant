/* eslint-disable no-console */
// src/features/scan-compare-trust/stores/useSafetyPrefs.js
// Avoid lists, allergens, diet/faith flags + profiles, overrides, and product evaluation.
// Style: dependency-light, offline-first, event-driven, ESM-safe.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* -------------------------------- safe deps -------------------------------- */
let eventBus = { emit() {}, on() {}, off() {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eb || eventBus;
} catch (_e) {}

let DexieDB = null;
try {
  DexieDB = require("@/db")?.default || require("@/db");
} catch (_e) {}

let useAuth = () => ({ user: null, householdId: null });
try {
  useAuth = require("@/hooks/useAuth")?.default || useAuth;
} catch (_e) {}

let useQuietHours = () => ({ enabled: false });
try {
  useQuietHours = require("@/hooks/useQuietHours")?.default || useQuietHours;
} catch (_e) {}

let toast = null;
try {
  toast = require("@/components/toast")?.toast || null;
} catch (_e) {}

let nanoid = (len = 8) =>
  Math.random()
    .toString(36)
    .slice(2, 2 + len);
try {
  nanoid = require("nanoid").nanoid || nanoid;
} catch (_e) {}

const nowISO = () => new Date().toISOString();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const toStr = (v) => (v == null ? "" : String(v)).trim().toLowerCase();

/* ------------------------------- local stores ------------------------------ */
const LS_PREFS = "safety:prefs:v1";
const LS_PROFILES = "safety:profiles:v1";

function lsGet(key, fb) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fb;
  } catch {
    return fb;
  }
}
function lsSet(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {}
}

/* --------------------------- default preferences --------------------------- */
function defaultPrefs() {
  return {
    version: 1,
    scope: "user", // "user" | "household" (presentation hint)
    allergens: [
      // { tag:"peanut", severity:"avoid"|"caution", anaphylaxis?:true }
    ],
    avoid: {
      ingredients: [
        /* "sorbitol", "aspartame", ... */
      ],
      additives: [
        /* "bht", "bha", "tbhq", "red 40", "e129" */
      ],
      categories: [
        /* "ultra-processed", "energy drink" */
      ],
      eNumbers: [
        /* "e120", "e621" */
      ],
    },
    diet: {
      vegetarian: false,
      vegan: false,
      pescatarian: false,
      keto: false,
      paleo: false,
      lowFODMAP: false,
      glutenFree: false,
      dairyFree: false,
      nutFree: false,
      eggFree: false,
      sugarFree: false,
      noAddedSugar: true,
    },
    faith: {
      halal: false,
      kosher: false,
      torahClean: false, // avoid pork, shellfish, blood, carrion derivatives
      passoverUnleavenedMode: false, // temporary "no leaven" mode (session/seasonal)
    },
    crossContact: {
      warnOn: [
        "may contain",
        "manufactured in",
        "processed on shared equipment",
      ],
    },
    recalls: {
      autoCheck: true, // if a recall adapter is wired in your safety step
    },
    sessionOverrides: {}, // transient patch per sessionId
    updatedISO: nowISO(),
  };
}

/* ------------------------------ Dexie helpers ------------------------------ */
// Optional tables we’ll use if present:
// - DexieDB.kv (space="safety")  -> persisted prefs blob by key "prefs:<userId|householdId>"
// - DexieDB.favorites            -> for profile favorites (type="safety.profile")
// - DexieDB.safetyProfiles       -> { id, ownerId, name, payload, createdAt, updatedAt }

async function dbLoadPrefs(ownerKey) {
  if (!DexieDB?.kv) return null;
  try {
    return await DexieDB.kv.get({ space: "safety", key: `prefs:${ownerKey}` });
  } catch {
    return null;
  }
}
async function dbSavePrefs(ownerKey, prefs) {
  if (!DexieDB?.kv) return;
  try {
    await DexieDB.kv.put({
      space: "safety",
      key: `prefs:${ownerKey}`,
      value: prefs,
      updatedAt: Date.now(),
    });
  } catch {}
}

async function dbListProfiles(ownerId) {
  if (!DexieDB?.safetyProfiles) return null;
  try {
    return await DexieDB.safetyProfiles
      .where("ownerId")
      .equals(ownerId)
      .reverse()
      .limit(200)
      .toArray();
  } catch {
    return null;
  }
}
async function dbSaveProfile(row) {
  if (!DexieDB?.safetyProfiles) return null;
  try {
    await DexieDB.safetyProfiles.put(row);
    return row.id;
  } catch {
    return null;
  }
}
async function dbDeleteProfile(id) {
  if (!DexieDB?.safetyProfiles) return;
  try {
    await DexieDB.safetyProfiles.delete(id);
  } catch {}
}
async function favSaveProfile(userId, key, payload) {
  if (!DexieDB?.favorites) return;
  try {
    await DexieDB.favorites.put({
      userId: userId || "anon",
      type: "safety.profile",
      key,
      payload,
      createdAt: Date.now(),
    });
  } catch {}
}
async function favRemoveProfile(userId, key) {
  if (!DexieDB?.favorites) return;
  try {
    const row = await DexieDB.favorites
      .where({ userId: userId || "anon", type: "safety.profile", key })
      .first();
    if (row?.id) await DexieDB.favorites.delete(row.id);
  } catch {}
}

/* --------------------------------- synonyms -------------------------------- */
// Lightweight map for common ingredient synonyms, E-numbers, and category inference.
const SYN = {
  // allergens → normalized tags
  peanut: ["peanut", "groundnut", "arachis hypogaea"],
  tree_nut: [
    "almond",
    "walnut",
    "cashew",
    "pecan",
    "hazelnut",
    "pistachio",
    "macadamia",
    "brazil nut",
    "pine nut",
  ],
  dairy: ["milk", "casein", "whey", "lactose", "butterfat", "ghee"],
  egg: ["egg", "albumen", "ovum", "ovalbumin"],
  soy: ["soy", "soya", "soybean", "edamame", "tofu", "lecithin (soy)"],
  gluten: [
    "wheat",
    "barley",
    "rye",
    "triticale",
    "spelt",
    "malt",
    "semolina",
    "farina",
    "seitan",
    "gluten",
  ],
  shellfish: [
    "shrimp",
    "prawn",
    "crab",
    "lobster",
    "crayfish",
    "krill",
    "shellfish",
  ],
  fish: ["anchovy", "salmon", "tuna", "cod", "tilapia", "fish"],
  sesame: ["sesame", "tahini", "benne"],
  sulfite: [
    "sulfite",
    "sulphite",
    "e220",
    "e221",
    "e222",
    "e223",
    "e224",
    "e226",
    "e227",
    "e228",
  ],
  pork: ["pork", "bacon", "ham", "prosciutto", "gelatin (pork)", "lard"],
  alcohol: [
    "alcohol",
    "ethanol",
    "rum",
    "brandy",
    "wine",
    "beer",
    "cooking wine",
    "vanilla extract (alcohol)",
  ],

  // additives → normalized tags
  aspartame: ["aspartame", "e951"],
  sucralose: ["sucralose", "e955"],
  acesulfamek: ["acesulfame k", "acesulfame-k", "e950"],
  red40: ["red 40", "allura red", "e129"],
  yellow5: ["yellow 5", "tartrazine", "e102"],
  msg: ["msg", "monosodium glutamate", "e621"],

  // leavening detection
  leaven: [
    "yeast",
    "sourdough",
    "baking powder",
    "baking soda",
    "ammonium bicarbonate",
  ],

  // animal-derived gelling
  gelatin: ["gelatin", "gelatine", "e441"],

  // “may contain” signals
  mayContain: ["may contain", "processed in a facility", "shared equipment"],
};

const CATEGORY_HINTS = {
  "ultra-processed": [
    "maltodextrin",
    "artificial flavor",
    "artificial color",
    "modified starch",
    "emulsifier",
    "stabilizer",
  ],
  "energy drink": ["taurine", "caffeine", "guarana", "niacin (b3)"],
};

/* ------------------------------ normalization ------------------------------ */
function normalizeList(arr = []) {
  return Array.from(new Set(arr.map(toStr).filter(Boolean)));
}
function flatSynMatch(tag, term) {
  const list = SYN[tag] || [];
  const t = toStr(term);
  return list.some((s) => t.includes(toStr(s)));
}
function anyIncludes(hay = "", needles = []) {
  const h = toStr(hay);
  return needles.some((n) => h.includes(toStr(n)));
}

/* ---------------------------- evaluation engine ---------------------------- */
function baseResult() {
  return { ok: true, score: 100, violations: [], warnings: [], notes: [] };
}
function pushViolation(res, type, tag, reason) {
  res.ok = false;
  res.score = clamp(res.score - 25, 0, 100);
  res.violations.push({ type, tag, reason });
}
function pushWarning(res, type, tag, reason) {
  res.score = clamp(res.score - 8, 0, 100);
  res.warnings.push({ type, tag, reason });
}

/**
 * evaluateProduct(product, prefs, opts)
 * product: { ingredients[], rawLabelText?, categories[], upc?, brand?, store? }
 */
export function evaluateProduct(
  product = {},
  prefs = defaultPrefs(),
  opts = {}
) {
  const res = baseResult();
  const ingredients = normalizeList(product.ingredients || []);
  const label = toStr(product.rawLabelText || ingredients.join(", "));
  const cats = normalizeList(product.categories || []);

  // 1) Recalls (delegated): orchestration will call external adapters and emit events.
  if (prefs.recalls?.autoCheck && opts?.recalls?.flagged) {
    pushViolation(
      res,
      "recall",
      "recall-flag",
      "Product is under an active recall."
    );
  }

  // 2) Allergens
  for (const a of prefs.allergens || []) {
    const tag = toStr(a.tag);
    if (!tag) continue;
    // direct match or synonyms list detection
    const hit =
      ingredients.some((i) => toStr(i).includes(tag)) ||
      Object.values(SYN).some(
        (list) =>
          list.includes(tag) &&
          ingredients.some((i) => toStr(i).includes(list[0]))
      );
    if (hit) {
      if (a.severity === "avoid")
        pushViolation(res, "allergen", tag, "Declared allergen on label.");
      else pushWarning(res, "allergen", tag, "Allergen present (caution).");
    }
  }

  // 3) Avoid lists
  const avoidIng = normalizeList(prefs.avoid?.ingredients);
  const avoidAdd = normalizeList(prefs.avoid?.additives);
  const avoidEN = normalizeList(prefs.avoid?.eNumbers);

  for (const i of ingredients) {
    if (avoidIng.includes(toStr(i)))
      pushViolation(res, "avoid:ingredient", i, "In personal avoid list.");
    if (avoidAdd.some((a) => toStr(i).includes(a)))
      pushViolation(res, "avoid:additive", i, "Avoided additive.");
    if (avoidEN.some((en) => toStr(i).includes(en)))
      pushViolation(res, "avoid:e-number", i, "Avoided E-number.");
  }

  // category hints
  for (const [cat, needles] of Object.entries(CATEGORY_HINTS)) {
    if (anyIncludes(label, needles))
      pushWarning(res, "category", cat, "Heuristic suggests this category.");
  }
  // explicit category avoid
  const avoidCats = normalizeList(prefs.avoid?.categories);
  for (const c of cats)
    if (avoidCats.includes(toStr(c)))
      pushViolation(res, "avoid:category", c, "Avoided category.");

  // 4) Diet flags
  const d = prefs.diet || {};
  const containsMeat = [
    "beef",
    "pork",
    "chicken",
    "turkey",
    "lamb",
    "goat",
    "duck",
    "venison",
  ].some((m) => label.includes(m));
  const containsFish = flatSynMatch("fish", label);
  const containsShellfish = flatSynMatch("shellfish", label);
  const containsDairy = flatSynMatch("dairy", label);
  const containsEgg = flatSynMatch("egg", label);
  const hasGelatin = flatSynMatch("gelatin", label);
  const hasSugar = /sugar|glucose|fructose|corn syrup|dextrose/.test(label);
  const highCarb = /wheat|rice|corn|oat|maltodextrin/.test(label);

  if (
    d.vegan &&
    (containsMeat ||
      containsFish ||
      containsShellfish ||
      containsDairy ||
      containsEgg ||
      hasGelatin)
  ) {
    pushViolation(res, "diet", "vegan", "Contains animal-derived ingredients.");
  } else if (
    d.vegetarian &&
    (containsMeat || containsShellfish || hasGelatin)
  ) {
    pushViolation(
      res,
      "diet",
      "vegetarian",
      "Contains meat/shellfish/gelatin."
    );
  } else if (d.pescatarian && containsMeat && !containsFish) {
    pushViolation(res, "diet", "pescatarian", "Contains non-fish meat.");
  }

  if (d.keto && (hasSugar || (highCarb && !containsMeat && !containsFish))) {
    pushWarning(
      res,
      "diet",
      "keto",
      "Likely higher net carbs or added sugars."
    );
  }
  if (d.glutenFree && flatSynMatch("gluten", label))
    pushViolation(res, "diet", "glutenFree", "Contains gluten sources.");
  if (d.dairyFree && containsDairy)
    pushViolation(res, "diet", "dairyFree", "Contains dairy.");
  if (
    d.nutFree &&
    (flatSynMatch("peanut", label) || anyIncludes(label, SYN.tree_nut))
  )
    pushViolation(res, "diet", "nutFree", "Contains nuts/peanuts.");
  if (d.eggFree && containsEgg)
    pushViolation(res, "diet", "eggFree", "Contains egg.");
  if (
    d.lowFODMAP &&
    anyIncludes(label, ["inulin", "chicory root", "fructo-oligosaccharide"])
  ) {
    pushWarning(res, "diet", "lowFODMAP", "May be high-FODMAP.");
  }
  if (d.noAddedSugar && hasSugar)
    pushWarning(res, "diet", "noAddedSugar", "Added sugars detected.");

  // 5) Faith flags
  const f = prefs.faith || {};
  if (f.torahClean) {
    if (flatSynMatch("pork", label))
      pushViolation(res, "faith", "torahClean", "Pork-derived ingredient.");
    if (containsShellfish)
      pushViolation(res, "faith", "torahClean", "Shellfish detected.");
    if (anyIncludes(label, ["blood", "blood meal", "blood plasma"]))
      pushViolation(res, "faith", "torahClean", "Blood-derived ingredient.");
  }
  if (f.halal) {
    if (flatSynMatch("alcohol", label))
      pushViolation(res, "faith", "halal", "Alcohol present.");
    if (hasGelatin && !/halal gelatin/.test(label))
      pushWarning(res, "faith", "halal", "Gelatin likely non-halal.");
  }
  if (f.kosher) {
    if (hasGelatin && !/kosher gelatin/.test(label))
      pushWarning(res, "faith", "kosher", "Gelatin likely non-kosher.");
    // Full kosher logic is complex; we keep a light heuristic.
  }
  if (f.passoverUnleavenedMode) {
    if (flatSynMatch("leaven", label))
      pushViolation(
        res,
        "faith",
        "passover",
        "Leavening detected during unleavened mode."
      );
  }

  // 6) Cross-contact warnings
  for (const phrase of prefs.crossContact?.warnOn || []) {
    if (label.includes(toStr(phrase)))
      pushWarning(
        res,
        "cross-contact",
        phrase,
        "Label indicates potential cross-contact."
      );
  }

  // scoring floor/ceiling.
  res.score = clamp(res.score, res.ok ? 50 : 0, 100);

  return res;
}

/* ------------------------------ the React hook ----------------------------- */
/**
 * useSafetyPrefs({ ownerScope="user"|"household", sessionId? })
 * returns {
 *   status, error, prefs, setPrefs, update, reset,
 *   evaluateProduct(product, opts),
 *   setSessionOverride(patch), clearSessionOverride(),
 *   profiles: { list, save(name), load(idOrName), del(id), favorite(id), unfavorite(id), active },
 *   exportPrefs(), importPrefs(payload)
 * }
 */
export default function useSafetyPrefs(opts = {}) {
  const { ownerScope = "user", sessionId = null } = opts;
  const { user, householdId } = useAuth();
  const { enabled: quietHours } = useQuietHours();

  const ownerKey = useMemo(() => {
    if (ownerScope === "household") return `house:${householdId || "default"}`;
    return `user:${user?.id || "anon"}`;
  }, [ownerScope, user?.id, householdId]);

  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [prefs, setPrefs] = useState(() => {
    // seed from Dexie/LS if possible (sync happens after mount)
    return lsGet(LS_PREFS, defaultPrefs());
  });

  const [profileList, setProfileList] = useState([]); // [{id,name,updatedAt}]
  const [activeProfile, setActiveProfile] = useState(null);

  // initial load
  useEffect(() => {
    (async () => {
      setStatus("loading");
      setError(null);
      try {
        const db = await dbLoadPrefs(ownerKey);
        const next = db?.value || lsGet(LS_PREFS, null) || defaultPrefs();
        setPrefs(next);
        setStatus("ok");
      } catch (e) {
        setStatus("error");
        setError(e);
      }
      // load profiles
      const rows = (await dbListProfiles(ownerKey)) || lsGet(LS_PROFILES, []);
      setProfileList(
        rows.map((r) => ({
          id: r.id,
          name: r.name,
          updatedAt: r.updatedAt || r.createdAt,
        }))
      );
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownerKey]);

  const persist = useCallback(
    async (next) => {
      const payload = { ...next, updatedISO: nowISO() };
      setPrefs(payload);
      lsSet(LS_PREFS, payload);
      await dbSavePrefs(ownerKey, payload);
      eventBus.emit("safety:prefs:updated", { ownerKey, prefs: payload });
    },
    [ownerKey]
  );

  const update = useCallback(
    async (patch = {}) => {
      await persist({ ...prefs, ...patch });
      if (!quietHours && toast) toast("Safety preferences updated.");
    },
    [prefs, persist, quietHours]
  );

  const reset = useCallback(async () => {
    await persist(defaultPrefs());
    if (!quietHours && toast) toast("Safety preferences reset.");
  }, [persist, quietHours]);

  /* ------------------------------ evaluation ------------------------------ */
  const withOverrides = useCallback(() => {
    if (!sessionId) return prefs;
    const ov = prefs.sessionOverrides?.[sessionId];
    return ov ? deepMerge(prefs, ov) : prefs;
  }, [prefs, sessionId]);

  const evaluate = useCallback(
    (product, extra = {}) => {
      const effective = withOverrides();
      const result = evaluateProduct(product, effective, extra);
      eventBus.emit("safety:check:result", {
        sessionId,
        ownerKey,
        upc: product?.upc || null,
        result,
      });
      return result;
    },
    [withOverrides, sessionId, ownerKey]
  );

  /* ------------------------------ overrides API --------------------------- */
  const setSessionOverride = useCallback(
    async (patch = {}) => {
      if (!sessionId) return;
      const next = {
        ...prefs,
        sessionOverrides: {
          ...(prefs.sessionOverrides || {}),
          [sessionId]: deepMerge(
            prefs.sessionOverrides?.[sessionId] || {},
            patch
          ),
        },
      };
      await persist(next);
    },
    [prefs, sessionId, persist]
  );

  const clearSessionOverride = useCallback(async () => {
    if (!sessionId) return;
    const next = {
      ...prefs,
      sessionOverrides: { ...(prefs.sessionOverrides || {}) },
    };
    delete next.sessionOverrides[sessionId];
    await persist(next);
  }, [prefs, sessionId, persist]);

  /* -------------------------------- profiles ------------------------------ */
  const listProfiles = useCallback(async () => {
    const rows = (await dbListProfiles(ownerKey)) || lsGet(LS_PROFILES, []);
    setProfileList(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        updatedAt: r.updatedAt || r.createdAt,
      }))
    );
    return rows;
  }, [ownerKey]);

  const saveProfile = useCallback(
    async (name) => {
      const row = {
        id: `prof-${ownerKey}-${Date.now()}-${nanoid(4)}`,
        ownerId: ownerKey,
        name: String(name || "My Safety Profile"),
        payload: prefs,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      if (DexieDB?.safetyProfiles) {
        await dbSaveProfile(row);
        await favSaveProfile(user?.id, row.id, { name: row.name });
      } else {
        const ls = lsGet(LS_PROFILES, []);
        ls.unshift(row);
        lsSet(LS_PROFILES, ls);
      }
      await listProfiles();
      setActiveProfile({ id: row.id, name: row.name });
      eventBus.emit("safety:profile:saved", {
        ownerKey,
        id: row.id,
        name: row.name,
      });
      if (!useQuietHours().enabled && toast) toast("Safety profile saved.");
      return row.id;
    },
    [ownerKey, prefs, listProfiles, user?.id]
  );

  const loadProfile = useCallback(
    async (idOrName) => {
      let row = null;
      if (DexieDB?.safetyProfiles) {
        const rows = (await dbListProfiles(ownerKey)) || [];
        row =
          rows.find((r) => r.id === idOrName || r.name === idOrName) || null;
      } else {
        const rows = lsGet(LS_PROFILES, []);
        row =
          rows.find((r) => r.id === idOrName || r.name === idOrName) || null;
      }
      if (!row) return false;
      await persist(row.payload);
      setActiveProfile({ id: row.id, name: row.name });
      eventBus.emit("safety:profile:loaded", {
        ownerKey,
        id: row.id,
        name: row.name,
      });
      if (!useQuietHours().enabled && toast)
        toast(`Loaded profile: ${row.name}`);
      return true;
    },
    [ownerKey, persist]
  );

  const deleteProfile = useCallback(
    async (id) => {
      if (DexieDB?.safetyProfiles) await dbDeleteProfile(id);
      else {
        const rows = lsGet(LS_PROFILES, []).filter((r) => r.id !== id);
        lsSet(LS_PROFILES, rows);
      }
      await favRemoveProfile(user?.id, id);
      await listProfiles();
      if (activeProfile?.id === id) setActiveProfile(null);
      eventBus.emit("safety:profile:deleted", { ownerKey, id });
      if (!quietHours && toast) toast("Deleted safety profile.");
    },
    [activeProfile?.id, ownerKey, user?.id, listProfiles, quietHours]
  );

  const favoriteProfile = useCallback(
    async (id) => {
      await favSaveProfile(user?.id, id, {
        name: profileList.find((p) => p.id === id)?.name || "Profile",
      });
      eventBus.emit("safety:profile:favorited", { ownerKey, id });
      if (!quietHours && toast) toast("Profile added to favorites.");
    },
    [user?.id, profileList, ownerKey, quietHours]
  );

  const unfavoriteProfile = useCallback(
    async (id) => {
      await favRemoveProfile(user?.id, id);
      eventBus.emit("safety:profile:unfavorited", { ownerKey, id });
      if (!quietHours && toast) toast("Profile removed from favorites.");
    },
    [user?.id, ownerKey, quietHours]
  );

  /* ------------------------------- export/import --------------------------- */
  const exportPrefs = useCallback(
    () => ({
      version: 1,
      exportedAt: nowISO(),
      ownerKey,
      prefs,
      profiles: DexieDB?.safetyProfiles ? null : lsGet(LS_PROFILES, []),
    }),
    [ownerKey, prefs]
  );

  const importPrefs = useCallback(
    async (payload) => {
      if (!payload?.prefs) return false;
      await persist(payload.prefs);
      if (!DexieDB?.safetyProfiles && Array.isArray(payload.profiles)) {
        lsSet(LS_PROFILES, payload.profiles);
        setProfileList(
          payload.profiles.map((r) => ({
            id: r.id,
            name: r.name,
            updatedAt: r.updatedAt || r.createdAt,
          }))
        );
      }
      if (!quietHours && toast) toast("Imported safety preferences.");
      return true;
    },
    [persist, quietHours]
  );

  /* ------------------------- orchestration glue ---------------------------- */
  // Run safety check automatically when a scan item finishes
  useEffect(() => {
    const onProcessed = ({ result }) => {
      // Expected: result.ingredients[], result.rawLabelText, upc/store/brand/categories etc.
      if (!result) return;
      const r = evaluate(result, {
        recalls: { flagged: result?.recallFlag || false },
      });
      eventBus.emit("scan:safety:evaluated", {
        upc: result.upc,
        ok: r.ok,
        score: r.score,
        violations: r.violations,
      });
      // NBA: if violation + user has a saved “clean label” shopping session template
      if (!r.ok) {
        eventBus.emit("nba:hint", {
          domain: "shopping",
          kind: "safety-violation",
          message: "This item violates your safety preferences.",
          score: 75,
        });
      }
    };
    eventBus.on?.("scanqueue:item:success", onProcessed);
    return () => eventBus.off?.("scanqueue:item:success", onProcessed);
  }, [evaluate]);

  return {
    status,
    error,
    prefs,
    setPrefs: persist,
    update,
    reset,
    evaluateProduct: evaluate,
    setSessionOverride,
    clearSessionOverride,
    profiles: {
      list: profileList,
      active: activeProfile,
      save: saveProfile,
      load: loadProfile,
      del: deleteProfile,
      favorite: favoriteProfile,
      unfavorite: unfavoriteProfile,
    },
    exportPrefs,
    importPrefs,
  };
}

/* --------------------------------- helpers -------------------------------- */
function deepMerge(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = Array.isArray(a) ? [...a] : { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (v && typeof v === "object" && !Array.isArray(v))
      out[k] = deepMerge(a[k], v);
    else out[k] = v;
  }
  return out;
}
