// src/store/RecipeStore.js
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { shallow } from "zustand/shallow";

/* ----------------------------------------------------------------------------
   RecipeStore (v4)
   - Household favorites: usageCount, lastUsedAt, favoriteScore
   - StreetFood / FoodTruck flags; fusion suggestions
   - Nutrition/avoid awareness via NutritionGoalsStore (optional)
   - West-African-forward search/recommend
   - Event taps for orchestrators (recipes/*)
   - Undo/redo (local, not persisted)
---------------------------------------------------------------------------- */

const VERSION = 4;
const LS_KEY = "suka.recipes.v" + VERSION;

/* --------------------------------- Utils ---------------------------------- */
const nowIso = () => new Date().toISOString();
const normId = (x) => String(x ?? "").trim();
const normName = (x) => String(x ?? "").trim();
const lower = (s) => String(s || "").toLowerCase();
const arr = (v) => (Array.isArray(v) ? v : v != null ? [v] : []);
const uniq = (a) => Array.from(new Set((a || []).filter(Boolean)));
const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");

function arraysShallowEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
    return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function indexById(list) {
  const m = new Map();
  for (const r of list) m.set(normId(r.id), r);
  return m;
}

function textIncludes(hay, needle) {
  return lower(hay).includes(lower(needle));
}

/* -------------------------- Event/Automation taps ------------------------- */
async function emitEvent(topic, payload) {
  try {
    const mod = await import("@/services/events/eventBus");
    const bus = mod?.eventBus || mod?.default;
    if (bus?.emit) bus.emit(topic, payload);
  } catch (_) {}
  try {
    const rt = await import("@/services/automation/runtime");
    const automation = rt?.automation || rt?.default;
    if (automation?.notify) automation.notify(topic, payload);
  } catch (_) {}
}

async function optionalInventory() {
  try {
    const mod = await import("@/store/InventoryStore");
    return mod;
  } catch {
    return null;
  }
}

async function optionalNutrition() {
  try {
    const mod = await import("@/store/NutritionGoalsStore");
    return mod;
  } catch {
    return null;
  }
}

/* ------------------------ Light cuisine inference ------------------------- */
const CUISINE_PATTERNS = [
  [/(mediterranean|greek|lebanese|levant|levantine)/i, "Mediterranean"],
  [/(soul\s?food|southern\b)/i, "Soul Food"],
  [
    /(west\s*africa|nigerian|ghanaian|senegalese|ivorian|malian)/i,
    "West African",
  ],
  [/\bcajun\b/i, "Cajun"],
  [/\bcreole\b/i, "Creole"],
  [/\b(bbq|barbecue)\b/i, "BBQ"],
  [/(tex-?\s*mex|taco|enchilada|fajita)/i, "Tex-Mex"],
  [/(caribbean|jerk\b|trini|jamaican|haitian)/i, "Caribbean"],
  [/(ethiopian|berbere|wot\b|injera)/i, "Ethiopian"],
  [/(indian|tandoori|masala|dal\b|biryani)/i, "Indian"],
  [/(thai|larb|satay|curry)/i, "Thai"],
  [/(korean|bulgogi|kimchi|gochujang)/i, "Korean"],
  [/(japanese|miso|dashi|teriyaki|onigiri)/i, "Japanese Home"],
  [/(shawarma|tabbouleh|tahini|levantine)/i, "Levantine"],
  [/(suya|jollof|waakye|shito|kelewele|yassa|egusi)/i, "West African"], // reinforce
  [/asian\s*fusion/i, "Asian Fusion"],
  [/(garden|salad|herb|chimichurri)/i, "Garden-Fresh"],
];

function inferCuisines({ name, tags, category }) {
  const hay = `${name || ""} ${(tags || []).join(" ")} ${category || ""}`;
  const hits = new Set();
  for (const [re, label] of CUISINE_PATTERNS) if (re.test(hay)) hits.add(label);
  return Array.from(hits);
}

/* ------------------------------ Normalization ----------------------------- */
function mapRecipeIn(r = {}) {
  // id/name/url/image → many shapes accepted
  const id = normId(
    r?.id ||
      r?.sourceUrl ||
      r?.url ||
      `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  );
  const name = normName(r?.name || r?.title);
  const tags = arr(r?.tags || r?.keywords).map(normName);
  const sourceUrl = r?.sourceUrl || r?.url || undefined;
  const imageCandidate = Array.isArray(r?.imageUrl || r?.image)
    ? (r?.imageUrl || r?.image)[0]
    : r?.imageUrl || r?.image;
  const imageUrl = imageCandidate || undefined;

  const normalized = {
    // core
    id,
    name,
    slug: r?.slug || (name ? slugify(name) : undefined),
    tags,
    category: r?.category,
    cuisines: uniq(arr(r?.cuisines).map(normName)),
    equipment: uniq(arr(r?.equipment).map(normName)),
    prepTimeMin: toNum(r?.prepTimeMin),
    cookTimeMin: toNum(r?.cookTimeMin),
    totalTimeMin: toNum(r?.totalTimeMin),
    ingredients: Array.isArray(r?.ingredients) ? r.ingredients : [],
    instructions: r?.instructions,
    sourceUrl,
    imageUrl,
    nutrition: r?.nutrition || {},
    meta: { ...(r?.meta || {}) },

    // UX/meta
    isSelected: !!r?.isSelected,
    origin: r?.origin || "user", // "user" | "imported" | "scanned"
    usageCount: Number.isFinite(r?.usageCount) ? r.usageCount : 0,
    lastUsedAt: r?.lastUsedAt || null,
    favoriteScore: Number.isFinite(r?.favoriteScore) ? r.favoriteScore : 0,

    // modes
    streetFood: !!r?.streetFood,
    foodTruckReady: !!r?.foodTruckReady, // large format / menu card
    fusionWith: uniq(arr(r?.fusionWith).map(normName)), // ["Indian","German Doner", ...]
    dietTags: uniq(arr(r?.dietTags).map(normName)), // ["keto","dairy-free",...]
    allergens: uniq(arr(r?.allergens).map(normName)),
  };

  // Fill cuisines if missing
  if (!normalized.cuisines?.length) {
    const guess = inferCuisines({ name, tags, category: r?.category });
    if (guess.length) normalized.cuisines = guess;
  }

  // Fill totalTime if missing
  if (normalized.totalTimeMin == null) {
    const p = normalized.prepTimeMin || 0;
    const c = normalized.cookTimeMin || 0;
    const t = p + c;
    if (t > 0) normalized.totalTimeMin = t;
  }

  return normalized;
}

/* ------------------------------ Merge strategy ---------------------------- */
function mergeRecipes(base, incoming) {
  const a = mapRecipeIn(base);
  const b = mapRecipeIn(incoming);
  const choose = (x, y) => (y != null && y !== "" ? y : x);
  const timeChoose = (x, y) => (Number.isFinite(y) ? y : x);

  return {
    ...a,
    name: choose(a.name, b.name),
    slug: choose(a.slug, b.slug),
    category: choose(a.category, b.category),
    sourceUrl: choose(a.sourceUrl, b.sourceUrl),
    imageUrl: choose(a.imageUrl, b.imageUrl),
    nutrition: { ...(a.nutrition || {}), ...(b.nutrition || {}) },

    tags: uniq([...(a.tags || []), ...(b.tags || [])]),
    cuisines: uniq([...(a.cuisines || []), ...(b.cuisines || [])]),
    equipment: uniq([...(a.equipment || []), ...(b.equipment || [])]),
    ingredients: Array.isArray(b.ingredients)
      ? uniq([...(a.ingredients || []), ...b.ingredients])
      : a.ingredients,

    // Instructions: keep array structure if present
    instructions:
      Array.isArray(a.instructions) || Array.isArray(b.instructions)
        ? [...arr(a.instructions), ...arr(b.instructions)]
        : choose(a.instructions, b.instructions),

    prepTimeMin: timeChoose(a.prepTimeMin, b.prepTimeMin),
    cookTimeMin: timeChoose(a.cookTimeMin, b.cookTimeMin),
    totalTimeMin: timeChoose(a.totalTimeMin, b.totalTimeMin),

    // UX/meta (preserve usage, increment if explicitly passed)
    usageCount: Number.isFinite(b.usageCount) ? b.usageCount : a.usageCount,
    lastUsedAt: choose(a.lastUsedAt, b.lastUsedAt),
    favoriteScore: Number.isFinite(b.favoriteScore)
      ? b.favoriteScore
      : a.favoriteScore,
    origin: choose(a.origin, b.origin),
    streetFood: a.streetFood || !!b.streetFood,
    foodTruckReady: a.foodTruckReady || !!b.foodTruckReady,
    fusionWith: uniq([...(a.fusionWith || []), ...(b.fusionWith || [])]),
    dietTags: uniq([...(a.dietTags || []), ...(b.dietTags || [])]),
    allergens: uniq([...(a.allergens || []), ...(b.allergens || [])]),

    isSelected: !!a.isSelected,
    meta: { ...(a.meta || {}), ...(b.meta || {}) },
  };
}

function normalizeRhythmOverrideBlock(block = {}) {
  if (!block || typeof block !== "object") return {};
  const out = {
    substitutions: Array.isArray(block.substitutions) ? block.substitutions : undefined,
    ingredientRules:
      block.ingredientRules && typeof block.ingredientRules === "object"
        ? {
            avoid: Array.isArray(block.ingredientRules.avoid)
              ? block.ingredientRules.avoid
              : undefined,
            boost: Array.isArray(block.ingredientRules.boost)
              ? block.ingredientRules.boost
              : undefined,
          }
        : undefined,
    techniques:
      block.techniques && typeof block.techniques === "object"
        ? { ...block.techniques }
        : undefined,
    scaling:
      block.scaling && typeof block.scaling === "object"
        ? { ...block.scaling }
        : undefined,
    pantryFirst:
      block.pantryFirst && typeof block.pantryFirst === "object"
        ? { ...block.pantryFirst }
        : undefined,
    macroBias:
      block.macroBias && typeof block.macroBias === "object"
        ? { ...block.macroBias }
        : undefined,
    seasoning:
      block.seasoning && typeof block.seasoning === "object"
        ? { ...block.seasoning }
        : undefined,
    timing:
      block.timing && typeof block.timing === "object"
        ? {
            ...block.timing,
            batchDays: Array.isArray(block.timing.batchDays)
              ? block.timing.batchDays
              : undefined,
            quickWeekdays: Array.isArray(block.timing.quickWeekdays)
              ? block.timing.quickWeekdays
              : undefined,
          }
        : undefined,
    meta: block.meta && typeof block.meta === "object" ? { ...block.meta } : undefined,
  };

  return Object.fromEntries(
    Object.entries(out).filter(([, value]) => value !== undefined)
  );
}

/* --------------------------------- Store ---------------------------------- */
export const useRecipeStore = create(
  persist(
    (set, get) => ({
      recipes: [],
      tags: [],
      battleRhythmOverrides: {
        byRecipeId: {},
        byFingerprint: {},
      },

      /* ------------ local undo/redo (not persisted) ------------ */
      _history: [],
      _future: [],
      _pushHistory: (snap) => {
        const hist = get()._history.slice(-49);
        hist.push(snap);
        set({ _history: hist, _future: [] });
      },

      /* ---------------------------- Core CRUD ---------------------------- */
      addRecipe: (recipe) => {
        if (!recipe) return;
        const nextRec = mapRecipeIn(recipe);
        const rid = normId(nextRec.id);
        const prev = get().recipes;

        const exists =
          prev.some((r) => normId(r.id) === rid) ||
          (!!nextRec.name &&
            prev.some(
              (r) =>
                r.name === nextRec.name || (r.slug && r.slug === nextRec.slug)
            )) ||
          (!!nextRec.sourceUrl &&
            prev.some((r) => r.sourceUrl && r.sourceUrl === nextRec.sourceUrl));

        if (exists) return; // no-op (use upsertRecipe to merge)
        get()._pushHistory({ recipes: prev, tags: get().tags });
        const next = [...prev, nextRec];
        set({ recipes: next });
        emitEvent("recipes/added", { recipe: nextRec });
      },

      upsertRecipe: (recipe) => {
        if (!recipe) return;
        const nextRec = mapRecipeIn(recipe);
        const rid = normId(nextRec.id);
        const prev = get().recipes;

        let updated = false;
        const next = prev.map((r) => {
          const same =
            normId(r.id) === rid ||
            (!!nextRec.sourceUrl && r.sourceUrl === nextRec.sourceUrl) ||
            (!!nextRec.name && lower(r.name) === lower(nextRec.name));
          if (!same) return r;
          updated = true;
          return mergeRecipes(r, nextRec);
        });

        if (updated) {
          get()._pushHistory({ recipes: prev, tags: get().tags });
          set({ recipes: next });
          emitEvent("recipes/changed", { recipe: nextRec });
          return;
        }

        // not found → push
        get()._pushHistory({ recipes: prev, tags: get().tags });
        const pushed = [...prev, nextRec];
        set({ recipes: pushed });
        emitEvent("recipes/added", { recipe: nextRec });
      },

      addFromCatalog: (catalogRecipe, opts = {}) => {
        if (!catalogRecipe || typeof catalogRecipe !== "object") return null;

        const sourceRaw = catalogRecipe.raw && typeof catalogRecipe.raw === "object"
          ? catalogRecipe.raw
          : catalogRecipe;

        const rid = normId(
          opts?.id ||
            catalogRecipe.id ||
            sourceRaw?.meta?.id ||
            sourceRaw?.id ||
            `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        );

        const nextRec = mapRecipeIn({
          ...sourceRaw,
          id: rid,
          name:
            catalogRecipe.title ||
            sourceRaw?.meta?.name ||
            sourceRaw?.title ||
            sourceRaw?.name ||
            "Catalog Recipe",
          tags: uniq([
            ...arr(catalogRecipe.tags),
            ...arr(sourceRaw?.tags),
            "catalog-import",
          ]),
          ingredients: Array.isArray(catalogRecipe.ingredients)
            ? catalogRecipe.ingredients
            : sourceRaw?.ingredients,
          nutrition: catalogRecipe.macros || sourceRaw?.nutrition || {},
          origin: "catalog",
          sourceUrl: catalogRecipe.sourceUrl || sourceRaw?.sourceUrl || sourceRaw?.url,
          meta: {
            ...(sourceRaw?.meta || {}),
            catalog: {
              catalogId:
                catalogRecipe.catalogId ||
                sourceRaw?.meta?.id ||
                sourceRaw?.id ||
                rid,
              catalogDomain: catalogRecipe.catalogDomain || sourceRaw?.catalogDomain || null,
              catalogTags: arr(catalogRecipe.catalogTags),
            },
          },
        });

        const prev = get().recipes;
        const existing = prev.find((r) => normId(r.id) === rid);
        if (existing) {
          get().upsertRecipe(nextRec);
        } else {
          get().addRecipe(nextRec);
        }

        emitEvent("recipes/catalogImported", {
          id: rid,
          name: nextRec.name,
          catalogDomain: nextRec?.meta?.catalog?.catalogDomain || null,
        });
        return nextRec;
      },

      removeRecipe: (id) => {
        const rid = normId(id);
        const prev = get().recipes;
        const next = prev.filter((r) => normId(r.id) !== rid);
        if (next.length === prev.length) return;
        get()._pushHistory({ recipes: prev, tags: get().tags });
        set({ recipes: next });
        emitEvent("recipes/removed", { id: rid });
      },

      updateRecipe: (id, updates) => {
        const rid = normId(id);
        if (!updates || typeof updates !== "object") return;
        const prev = get().recipes;
        let changed = false;

        const next = prev.map((r) => {
          if (normId(r.id) !== rid) return r;
          const merged = mergeRecipes(r, { ...updates, id: rid });
          if (JSON.stringify(merged) === JSON.stringify(r)) return r;
          changed = true;
          return merged;
        });

        if (changed) {
          get()._pushHistory({ recipes: prev, tags: get().tags });
          set({ recipes: next });
          emitEvent("recipes/changed", { id: rid, updates });
        }
      },

      setBattleRhythmOverride: ({ recipeId, fingerprint, override } = {}) => {
        const rid = normId(recipeId);
        const fp = normId(fingerprint);
        if (!rid && !fp) return;

        const prev = get().battleRhythmOverrides || {
          byRecipeId: {},
          byFingerprint: {},
        };
        const byRecipeId = { ...(prev.byRecipeId || {}) };
        const byFingerprint = { ...(prev.byFingerprint || {}) };
        const nextOverride = normalizeRhythmOverrideBlock(override || {});

        if (rid) byRecipeId[rid] = nextOverride;
        if (fp) byFingerprint[fp] = nextOverride;

        set({ battleRhythmOverrides: { byRecipeId, byFingerprint } });
      },

      clearBattleRhythmOverride: ({ recipeId, fingerprint } = {}) => {
        const rid = normId(recipeId);
        const fp = normId(fingerprint);
        if (!rid && !fp) return;

        const prev = get().battleRhythmOverrides || {
          byRecipeId: {},
          byFingerprint: {},
        };
        const byRecipeId = { ...(prev.byRecipeId || {}) };
        const byFingerprint = { ...(prev.byFingerprint || {}) };

        if (rid) delete byRecipeId[rid];
        if (fp) delete byFingerprint[fp];

        set({ battleRhythmOverrides: { byRecipeId, byFingerprint } });
      },

      getBattleRhythmOverride: ({ recipeId, fingerprint } = {}) => {
        const rid = normId(recipeId);
        const fp = normId(fingerprint);
        const map = get().battleRhythmOverrides || {
          byRecipeId: {},
          byFingerprint: {},
        };

        if (rid && map.byRecipeId?.[rid]) return map.byRecipeId[rid];
        if (fp && map.byFingerprint?.[fp]) return map.byFingerprint[fp];
        return null;
      },

      /* ------------------- Usage / Favorites hooks ------------------- */
      markUsed: (id, { inc = 1, boost = 0 } = {}) => {
        const rid = normId(id);
        const prev = get().recipes;
        const next = prev.map((r) =>
          normId(r.id) === rid
            ? {
                ...r,
                usageCount: (r.usageCount || 0) + inc,
                lastUsedAt: nowIso(),
                favoriteScore: Math.max(0, (r.favoriteScore || 0) + boost),
              }
            : r
        );
        if (next !== prev) {
          get()._pushHistory({ recipes: prev, tags: get().tags });
          set({ recipes: next });
          emitEvent("recipes/markUsed", { id: rid });
        }
      },

      toggleFavorite: (id, weight = 10) => {
        const rid = normId(id);
        const prev = get().recipes;
        const next = prev.map((r) =>
          normId(r.id) === rid
            ? {
                ...r,
                favoriteScore:
                  (r.favoriteScore || 0) +
                  (r.favoriteScore > 0 ? -weight : weight),
              }
            : r
        );
        if (next !== prev) {
          get()._pushHistory({ recipes: prev, tags: get().tags });
          set({ recipes: next });
          emitEvent("recipes/favoriteToggled", { id: rid });
        }
      },

      /* --------------------------- Selection UX -------------------------- */
      toggleSelectRecipe: (id) => {
        const rid = normId(id);
        const next = get().recipes.map((r) =>
          normId(r.id) === rid ? { ...r, isSelected: !r.isSelected } : r
        );
        set({ recipes: next });
      },
      clearSelections: () => {
        const prev = get().recipes;
        if (!prev.some((r) => r.isSelected)) return;
        set({ recipes: prev.map((r) => ({ ...r, isSelected: false })) });
      },

      /* ------------------------------ Tags ------------------------------- */
      addTag: (name) => {
        const label = normName(name);
        if (!label) return;
        const prev = get().tags;
        if (prev.some((t) => lower(t.name) === lower(label))) return;
        const newTag = { id: Date.now(), name: label };
        set({ tags: [...prev, newTag] });
      },

      addTagToRecipe: (recipeId, tagName) => {
        const rid = normId(recipeId);
        const label = normName(tagName);
        if (!rid || !label) return;

        const prevTags = get().tags;
        const existing = prevTags.find((t) => lower(t.name) === lower(label));
        const ensuredTag = existing || { id: Date.now(), name: label };
        const nextTags = existing ? prevTags : [...prevTags, ensuredTag];

        const prevRecipes = get().recipes;
        let changed = false;
        const nextRecipes = prevRecipes.map((r) => {
          if (normId(r.id) !== rid) return r;
          const tags = Array.isArray(r.tags) ? r.tags : [];
          if (tags.map((x) => lower(x)).includes(lower(label))) return r;
          changed = true;
          return { ...r, tags: [...tags, ensuredTag.name] };
        });

        if (changed || nextTags !== prevTags)
          set({ recipes: nextRecipes, tags: nextTags });
      },

      removeTagFromRecipe: (recipeId, tagName) => {
        const rid = normId(recipeId);
        const label = normName(tagName);
        const prev = get().recipes;
        let changed = false;
        const next = prev.map((r) => {
          if (normId(r.id) !== rid) return r;
          const filtered = (r.tags || []).filter(
            (t) => lower(t) !== lower(label)
          );
          if (filtered.length === (r.tags || []).length) return r;
          changed = true;
          return { ...r, tags: filtered };
        });
        if (changed) set({ recipes: next });
      },

      renameTag: (oldName, newName) => {
        const from = normName(oldName);
        const to = normName(newName);
        if (!from || !to || lower(from) === lower(to)) return;

        const prevTags = get().tags;
        const toExists = prevTags.some((t) => lower(t.name) === lower(to));
        const nextTags = toExists
          ? prevTags.filter((t) => lower(t.name) !== lower(from))
          : prevTags.map((t) =>
              lower(t.name) === lower(from) ? { ...t, name: to } : t
            );

        const nextRecipes = get().recipes.map((r) => {
          const mapped = (r.tags || []).map((t) =>
            lower(t) === lower(from) ? to : t
          );
          return { ...r, tags: uniq(mapped.map(normName)) };
        });

        set({ tags: nextTags, recipes: nextRecipes });
      },

      /* ------------------------------ Lists ------------------------------ */
      getRecipesByCategory: () =>
        [...get().recipes].sort((a, b) =>
          (a.category || "").localeCompare(b.category || "")
        ),
      getSelectedRecipes: () => get().recipes.filter((r) => r.isSelected),

      setRecipes: (newRecipes) => {
        const next = Array.isArray(newRecipes)
          ? newRecipes.map(mapRecipeIn)
          : [];
        const prev = get().recipes;
        if (arraysShallowEqual(prev, next)) return;
        get()._pushHistory({ recipes: prev, tags: get().tags });
        set({ recipes: next });
      },
      resetRecipes: () => {
        if (!get().recipes.length) return;
        get()._pushHistory({ recipes: get().recipes, tags: get().tags });
        set({ recipes: [] });
      },

      /* ------------------------ Import / Export JSON ---------------------- */
      exportJson: () =>
        JSON.stringify({ recipes: get().recipes, tags: get().tags }, null, 2),
      importJson: (json) => {
        try {
          const obj = typeof json === "string" ? JSON.parse(json) : json;
          const list = Array.isArray(obj?.recipes) ? obj.recipes : [];
          const tags = Array.isArray(obj?.tags) ? obj.tags : [];
          get().upsertMany(list);
          const prevTags = get().tags;
          const merged = [...prevTags];
          for (const t of tags) {
            if (
              !merged.some(
                (x) => lower(x.name) === lower(String(t?.name || ""))
              )
            ) {
              merged.push({ id: t?.id || Date.now(), name: normName(t?.name) });
            }
          }
          set({ tags: merged });
          emitEvent("recipes/imported", { count: list.length });
        } catch {
          /* noop */
        }
      },

      /* ---------------------------- Bulk merge ---------------------------- */
      upsertMany: (incoming) => {
        const arrIn = Array.isArray(incoming) ? incoming.map(mapRecipeIn) : [];
        if (!arrIn.length) return;

        const prev = get().recipes;
        const byId = new Map(prev.map((r) => [normId(r.id), r]));
        const keyOf = (r) => `${lower(r.name)}|${r.slug}|${r.sourceUrl || ""}`;
        const mergedMap = new Map(prev.map((r) => [keyOf(r), r]));

        for (const r of arrIn) {
          const idKey = normId(r.id);
          if (byId.has(idKey)) {
            const merged = mergeRecipes(byId.get(idKey), r);
            byId.set(idKey, merged);
            mergedMap.set(keyOf(merged), merged);
            continue;
          }
          const k = keyOf(r);
          if (mergedMap.has(k)) {
            const merged = mergeRecipes(mergedMap.get(k), r);
            mergedMap.set(k, merged);
          } else {
            mergedMap.set(k, r);
          }
        }

        const next = Array.from(mergedMap.values());
        get()._pushHistory({ recipes: prev, tags: get().tags });
        set({ recipes: next });
        emitEvent("recipes/upsertMany", { count: arrIn.length });
      },

      mergeDuplicates: () => {
        const list = get().recipes;
        const seen = new Map(); // key: nameLower|slug|sourceUrl
        const result = [];
        const k = (r) => `${lower(r.name)}|${r.slug}|${r.sourceUrl || ""}`;

        for (const r of list) {
          const key = k(r);
          if (!seen.has(key)) {
            seen.set(key, { ...r, tags: uniq(r.tags || []) });
          } else {
            const base = seen.get(key);
            seen.set(key, mergeRecipes(base, r));
          }
        }
        get()._pushHistory({ recipes: list, tags: get().tags });
        seen.forEach((v) => result.push(v));
        set({ recipes: result });
        emitEvent("recipes/mergedDuplicates", {
          before: list.length,
          after: result.length,
        });
      },

      /* -------------------------- Inventory helper ------------------------ */
      getMissingFromInventory: async (recipeId) => {
        const rid = normId(recipeId);
        const recipe = (get().recipes || []).find((r) => normId(r.id) === rid);
        if (
          !recipe ||
          !Array.isArray(recipe.ingredients) ||
          recipe.ingredients.length === 0
        )
          return [];
        const inv = await optionalInventory();
        if (!inv || !inv.getInventoryItems) return recipe.ingredients; // assume all missing if no inventory
        const items = await inv.getInventoryItems();
        const have = new Set(items.map((x) => lower(x.name)));
        return recipe.ingredients.filter((ing) => !have.has(lower(ing?.name)));
      },

      /* ------------------------------- Search ----------------------------- */
      /**
       * Back-compat:
       *   searchRecipes("chicken")
       * Extended:
       *   searchRecipes({ cuisines:[], maxTime, equipment:[], tags:[], dietTags:[], text:"", limit, streetFood, foodTruckReady })
       * Avoid/Allergen aware when NutritionGoalsStore is available.
       */
      searchRecipes: async (query) => {
        const avoid = (
          await optionalNutrition()
        )?.useNutritionGoalsStore?.getState?.()?.avoidList || {
          allergens: [],
          ingredients: [],
        };
        const avoidSet = new Set([
          ...arr(avoid.allergens).map(lower),
          ...arr(avoid.ingredients).map(lower),
        ]);

        // Text-only search (legacy)
        if (typeof query === "string") {
          const q = normName(query);
          if (!q) return get().recipes;
          const list = get().recipes;
          return list.filter((r) => {
            if (textIncludes(r.name || "", q)) return true;
            if (r.category && textIncludes(r.category, q)) return true;
            if (Array.isArray(r.tags) && r.tags.some((t) => textIncludes(t, q)))
              return true;
            if (
              Array.isArray(r.ingredients) &&
              r.ingredients.some((ing) => textIncludes(ing?.name || "", q))
            )
              return true;
            return false;
          });
        }

        // Structured search
        const q = query || {};
        const wantCuisine = new Set((q.cuisines || []).map(lower));
        const wantEquip = new Set((q.equipment || []).map(lower));
        const wantTags = new Set((q.tags || []).map(lower));
        const wantDiet = new Set((q.dietTags || []).map(lower));
        const text = lower(q.text || "");
        const maxTime = Number.isFinite(q.maxTime) ? q.maxTime : undefined;
        const list = get().recipes;

        let out = list.filter((r) => {
          const cuisines = (r.cuisines || []).map(lower);
          const equip = (r.equipment || []).map(lower);
          const tags = (r.tags || []).map(lower);
          const diets = (r.dietTags || []).map(lower);
          const time = r.totalTimeMin ?? r.cookTimeMin ?? r.prepTimeMin ?? 0;

          // avoid-list filter (ingredients + allergens + tag labels)
          const hasAvoid =
            (r.allergens || []).some((al) => avoidSet.has(lower(al))) ||
            (r.ingredients || []).some((ing) => avoidSet.has(lower(ing?.name)));

          if (hasAvoid) return false;

          const hasCuisine =
            !wantCuisine.size || cuisines.some((c) => wantCuisine.has(c));
          const okTime = !maxTime || time <= maxTime;
          const hasEquip =
            !wantEquip.size || equip.some((e) => wantEquip.has(e));
          const hasTags = !wantTags.size || tags.some((t) => wantTags.has(t));
          const hasDiet = !wantDiet.size || diets.some((d) => wantDiet.has(d));
          const okText =
            !text ||
            lower(r.name || "").includes(text) ||
            (r.ingredients || []).some((i) =>
              lower(i?.name || "").includes(text)
            ) ||
            (r.category && lower(r.category).includes(text));

          const okStreet =
            q.streetFood == null ? true : !!r.streetFood === !!q.streetFood;
          const okTruck =
            q.foodTruckReady == null
              ? true
              : !!r.foodTruckReady === !!q.foodTruckReady;

          return (
            hasCuisine &&
            okTime &&
            hasEquip &&
            hasTags &&
            hasDiet &&
            okText &&
            okStreet &&
            okTruck
          );
        });

        // Rank: favorites & recency first, then time-fit
        out.sort((a, b) => {
          const fav = (b.favoriteScore || 0) - (a.favoriteScore || 0);
          if (fav !== 0) return fav;
          const rec = new Date(b.lastUsedAt || 0) - new Date(a.lastUsedAt || 0);
          if (rec !== 0) return rec;
          const tA = a.totalTimeMin ?? 9999;
          const tB = b.totalTimeMin ?? 9999;
          return tA - tB;
        });

        if (Number.isFinite(q.limit) && q.limit > 0)
          out = out.slice(0, q.limit);
        return out;
      },

      /* --------------------------- Recommend API -------------------------- */
      /**
       * recommend({ count=6, cuisine="West African", dietTag, maxTime, streetFood, foodTruckReady, fusionWith })
       * Returns curated list aligned with household favorites + constraints.
       */
      recommend: async (opts = {}) => {
        const {
          count = 6,
          cuisine = "West African",
          dietTag,
          maxTime,
          streetFood,
          foodTruckReady,
          fusionWith,
        } = opts;

        const base = await get().searchRecipes({
          cuisines: cuisine ? [cuisine] : [],
          dietTags: dietTag ? [dietTag] : [],
          maxTime,
          streetFood,
          foodTruckReady,
        });

        let pool = base;

        // Fusion sprinkle
        if (fusionWith && fusionWith.length) {
          const fusionPool =
            (await get().searchRecipes({ cuisines: fusionWith, limit: 30 })) ||
            [];
          pool = uniq([...pool, ...fusionPool]);
        }

        // Re-rank with heavier favorite bias
        const scored = pool
          .map((r) => ({
            r,
            score:
              (r.favoriteScore || 0) * 2 +
              (r.usageCount || 0) * 0.5 +
              (r.cuisines || []).includes("West African")
                ? 1
                : 0,
          }))
          .sort((a, b) => b.score - a.score)
          .map((x) => x.r);

        const out = scored.slice(0, count);
        emitEvent("recipes/recommendations", {
          count: out.length,
          cuisine,
          dietTag: dietTag || null,
          streetFood: !!streetFood,
          foodTruckReady: !!foodTruckReady,
        });
        return out;
      },

      /* --------------------------- Quick helpers -------------------------- */
      getByTag: (tagName) => {
        const t = normName(tagName);
        return get().recipes.filter((r) =>
          (r.tags || []).some((x) => lower(x) === lower(t))
        );
      },
      getIndexById: () => indexById(get().recipes),

      /* --------------------------- Undo / Redo ---------------------------- */
      undo: () => {
        const hist = get()._history.slice();
        if (!hist.length) return;
        const snap = hist.pop();
        const curr = { recipes: get().recipes, tags: get().tags };
        const future = get()._future.slice();
        future.push(curr);
        set({
          recipes: snap.recipes,
          tags: snap.tags,
          _history: hist,
          _future: future,
        });
        emitEvent("recipes/undo", {});
      },
      redo: () => {
        const future = get()._future.slice();
        if (!future.length) return;
        const next = future.pop();
        const hist = get()._history.slice();
        hist.push({ recipes: get().recipes, tags: get().tags });
        set({
          recipes: next.recipes,
          tags: next.tags,
          _history: hist,
          _future: future,
        });
        emitEvent("recipes/redo", {});
      },
    }),
    {
      name: LS_KEY,
      version: VERSION,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, ver) => {
        if (!persisted) return persisted;

        // v1/2/3 → v4: normalize + add new fields with safe defaults
        if (ver < 4) {
          const oldRecipes = Array.isArray(persisted.recipes)
            ? persisted.recipes
            : [];
          const oldTags = Array.isArray(persisted.tags) ? persisted.tags : [];
          persisted.recipes = oldRecipes.map((r) => {
            const n = mapRecipeIn(r);
            // carry v3 meta times if present
            const t = r?.meta?.times || {};
            n.prepTimeMin = n.prepTimeMin ?? toNum(t.prepTimeMin);
            n.cookTimeMin = n.cookTimeMin ?? toNum(t.cookTimeMin);
            n.totalTimeMin = n.totalTimeMin ?? toNum(t.totalTimeMin);

            // new defaults
            n.usageCount = Number.isFinite(n.usageCount) ? n.usageCount : 0;
            n.lastUsedAt = n.lastUsedAt || null;
            n.favoriteScore = Number.isFinite(n.favoriteScore)
              ? n.favoriteScore
              : 0;
            n.origin = n.origin || "user";
            n.streetFood = !!n.streetFood;
            n.foodTruckReady = !!n.foodTruckReady;
            n.fusionWith = uniq(arr(n.fusionWith).map(normName));
            n.dietTags = uniq(arr(n.dietTags).map(normName));
            n.allergens = uniq(arr(n.allergens).map(normName));
            return n;
          });

          persisted.tags = oldTags
            .map((t) => ({ id: t?.id || Date.now(), name: normName(t?.name) }))
            .filter((t) => !!t.name);
        }

        persisted.battleRhythmOverrides =
          persisted.battleRhythmOverrides &&
          typeof persisted.battleRhythmOverrides === "object"
            ? {
                byRecipeId:
                  persisted.battleRhythmOverrides.byRecipeId &&
                  typeof persisted.battleRhythmOverrides.byRecipeId === "object"
                    ? persisted.battleRhythmOverrides.byRecipeId
                    : {},
                byFingerprint:
                  persisted.battleRhythmOverrides.byFingerprint &&
                  typeof persisted.battleRhythmOverrides.byFingerprint === "object"
                    ? persisted.battleRhythmOverrides.byFingerprint
                    : {},
              }
            : { byRecipeId: {}, byFingerprint: {} };
        return persisted;
      },
      partialize: (s) => ({
        recipes: s.recipes,
        tags: s.tags,
        battleRhythmOverrides: s.battleRhythmOverrides,
      }),
    }
  )
);

export default useRecipeStore;

/* ------------------------------------------------------------------
   Adapters for agents and external modules
------------------------------------------------------------------- */
export function getRecipes() {
  return useRecipeStore.getState().recipes;
}
export function listRecipes() {
  return getRecipes();
}

export function setRecipes(list) {
  return useRecipeStore.getState().setRecipes(list);
}
export function addRecipe(recipe) {
  return useRecipeStore.getState().addRecipe(recipe);
}
export function upsertRecipe(recipe) {
  return useRecipeStore.getState().upsertRecipe(recipe);
}
export function addFromCatalog(catalogRecipe, opts) {
  return useRecipeStore.getState().addFromCatalog(catalogRecipe, opts);
}
export function upsertManyRecipes(list) {
  return useRecipeStore.getState().upsertMany(list);
}
export function getRecipesByCategory() {
  return useRecipeStore.getState().getRecipesByCategory();
}
export function getSelectedRecipes() {
  return useRecipeStore.getState().getSelectedRecipes();
}
export function resetRecipes() {
  return useRecipeStore.getState().resetRecipes();
}

export async function searchRecipes(q) {
  return useRecipeStore.getState().searchRecipes(q);
}
export function getByTag(tagName) {
  return useRecipeStore.getState().getByTag(tagName);
}
export function renameTag(oldName, newName) {
  return useRecipeStore.getState().renameTag(oldName, newName);
}
export function removeTagFromRecipe(id, tag) {
  return useRecipeStore.getState().removeTagFromRecipe(id, tag);
}
export function mergeDuplicateRecipes() {
  return useRecipeStore.getState().mergeDuplicates();
}
export async function getMissingFromInventory(recipeId) {
  return useRecipeStore.getState().getMissingFromInventory(recipeId);
}
export async function recommendRecipes(opts) {
  return useRecipeStore.getState().recommend(opts);
}

export function setBattleRhythmOverride(ref = {}) {
  return useRecipeStore.getState().setBattleRhythmOverride(ref);
}

export function clearBattleRhythmOverride(ref = {}) {
  return useRecipeStore.getState().clearBattleRhythmOverride(ref);
}

export function getBattleRhythmOverride(ref = {}) {
  return useRecipeStore.getState().getBattleRhythmOverride(ref);
}

/* ---------------------------- URL Import helper --------------------------- */
/**
 * Import a recipe by URL via your serverless importer at /api/recipes/import.
 * The endpoint should return a structured JSON object similar to schema.org/Recipe.
 */
export async function addFromUrl(url) {
  if (!url) throw new Error("Missing URL");
  const res = await fetch("/api/recipes/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error(`Import failed: ${res.status}`);
  const data = await res.json();
  if (!data?.recipe) throw new Error("No recipe returned");
  const rec = mapRecipeIn({
    ...data.recipe,
    url: data.recipe.url || url,
    sourceUrl: data.recipe.source || data.recipe.url || url,
    origin: "imported",
  });
  useRecipeStore.getState().upsertRecipe(rec);
  return rec;
}

/* ---------------------------------------------
   Selectors for components
---------------------------------------------- */
export const useRecipes = () => useRecipeStore((s) => s.recipes, shallow);
export const useRecipeTags = () => useRecipeStore((s) => s.tags, shallow);
export const useRecipeActions = () =>
  useRecipeStore(
    (s) => ({
      addRecipe: s.addRecipe,
      upsertRecipe: s.upsertRecipe,
      addFromCatalog: s.addFromCatalog,
      removeRecipe: s.removeRecipe,
      toggleSelectRecipe: s.toggleSelectRecipe,
      clearSelections: s.clearSelections,
      addTag: s.addTag,
      addTagToRecipe: s.addTagToRecipe,
      removeTagFromRecipe: s.removeTagFromRecipe,
      renameTag: s.renameTag,
      updateRecipe: s.updateRecipe,
      setRecipes: s.setRecipes,
      resetRecipes: s.resetRecipes,
      getSelectedRecipes: s.getSelectedRecipes,
      getRecipesByCategory: s.getRecipesByCategory,
      searchRecipes: s.searchRecipes,
      getByTag: s.getByTag,
      upsertMany: s.upsertMany,
      mergeDuplicates: s.mergeDuplicates,
      exportJson: s.exportJson,
      importJson: s.importJson,
      getMissingFromInventory: s.getMissingFromInventory,
      // new
      markUsed: s.markUsed,
      toggleFavorite: s.toggleFavorite,
      recommend: s.recommend,
      setBattleRhythmOverride: s.setBattleRhythmOverride,
      clearBattleRhythmOverride: s.clearBattleRhythmOverride,
      getBattleRhythmOverride: s.getBattleRhythmOverride,
      // undo/redo
      undo: s.undo,
      redo: s.redo,
    }),
    shallow
  );

/* -------------------------------------------------------------------------- */
/* Compatibility exports (used by template builders)                           */
/* -------------------------------------------------------------------------- */

/** Return the full recipe list (snapshot). */
export function getAll() {
  return useRecipeStore.getState().recipes || [];
}

/** Get a recipe by id (or null). */
export function getById(id) {
  if (!id) return null;
  const recipes = useRecipeStore.getState().recipes || [];
  return recipes.find((r) => r?.id === id) || null;
}

/** Alias for getById, historically used by some templates. */
export function getRecipe(id) {
  return getById(id);
}

/**
 * savePreferences
 * Stores per-recipe preference overrides (eg. doneness/texture).
 * This is a light-weight ...
 */
export function savePreferences(recipeId, prefs = {}) {
  if (!recipeId) return false;
  const state = useRecipeStore.getState();
  const recipes = state.recipes || [];
  const idx = recipes.findIndex((r) => r?.id === recipeId);
  if (idx < 0) return false;
  const current = recipes[idx];
  const meta = { ...(current.meta || {}) };
  meta.preferences = { ...(meta.preferences || {}), ...(prefs || {}) };
  state.updateRecipe?.(recipeId, { meta });
  return true;
}

/**
 * getTimerCorrections
 * Returns any per-recipe timer correction map previously saved via
 * savePreferences or other callers. Defaults to {}.
 */
export function getTimerCorrections(recipeId) {
  const r = getById(recipeId);
  return r?.meta?.timerCorrections &&
    typeof r.meta.timerCorrections === "object"
    ? r.meta.timerCorrections
    : r?.meta?.preferences?.timerCorrections &&
      typeof r.meta.preferences.timerCorrections === "object"
    ? r.meta.preferences.timerCorrections
    : {};
}

/* -------------------------------------------------------------------------- */
/* ✅ Namespace export expected by orchestrators (e.g., mealPlanEngine)         */
/* -------------------------------------------------------------------------- */
/**
 * Some orchestrators import `{ Recipes }` from "@/store/RecipeStore".
 * Provide a stable namespace object without changing existing exports.
 */
export const Recipes = {
  // store / hooks
  useRecipeStore,
  useRecipes,
  useRecipeTags,
  useRecipeActions,

  // snapshots / CRUD
  getRecipes,
  listRecipes,
  getAll,
  getById,
  getRecipe,
  setRecipes,
  addRecipe,
  upsertRecipe,
  addFromCatalog,
  upsertManyRecipes,
  removeTagFromRecipe,
  renameTag,
  resetRecipes,

  // lists / selection
  getRecipesByCategory,
  getSelectedRecipes,
  getByTag,

  // operations
  searchRecipes,
  mergeDuplicateRecipes,
  getMissingFromInventory,
  recommendRecipes,
  addFromUrl,
  getBattleRhythmOverride,
  setBattleRhythmOverride,
  clearBattleRhythmOverride,

  // per-recipe preferences helpers
  savePreferences,
  getTimerCorrections,
};
