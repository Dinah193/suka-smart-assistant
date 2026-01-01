// C:\Users\larho\suka-smart-assistant\src\services\importAnalyticsService.js
// -----------------------------------------------------------------------------
// Import Analytics Service
// -----------------------------------------------------------------------------
// PURPOSE
// 1. Watch all imports coming through ImportRouter / ImportService / Bookmarklet
//    and classify them into your household domains:
//      • meals
//      • cleaning
//      • garden (plan, care, harvest)
//      • storehouse (stock planning, grocery sections, co-op/shared goals)
//      • animals (acquisition, care, butchery)
// 2. Produce ANALYTICS that your dashboards/components can ask for, so you can
//    show “what’s being imported lately?” alongside “what should we do next?”
// 3. Allow USER-OWNED favorites, sessions, and schedules to be surfaced back to
//    the analytics layer (not just system sessions).
// 4. Support REVERSE GENERATION:
//      • import → session/plan (normal direction)
//      • existing session/plan → “what imports would make this real?”
// 5. Emit events so the automation runtime can schedule or fan out
//    (cleaning sessions, garden tasks, animal care, storehouse restock, meals).
//
// This file DOES NOT render UI.
// It’s a pure service you can import anywhere (home.jsx, dashboards, engines).
//
// Dependencies (loosely assumed):
// - window.__suka?.eventBus (optional)
// - window.__suka?.db (Dexie, optional; we guard for missing)
// - src/services/automation/runtime.js (listens for our events)
// - src/services/schemaValidator.js (optional data checks, we guard)
// -----------------------------------------------------------------------------

/* ────────────────────────────── helpers ─────────────────────────────── */

const isBrowser = typeof window !== "undefined";

const getBus = () => {
  if (!isBrowser) return null;
  return window.__suka?.eventBus ?? null;
};

const getDB = () => {
  if (!isBrowser) return null;
  return window.__suka?.db ?? null;
};

const safeValidate = (schemaName, payload) => {
  try {
    const validator = isBrowser ? window.__suka?.schemaValidator : null;
    if (validator?.validate) {
      return validator.validate(schemaName, payload);
    }
  } catch {
    /* noop */
  }
  // if no validator, just accept
  return { valid: true, errors: [] };
};

const emit = (type, detail = {}) => {
  const bus = getBus();
  if (bus?.emit) {
    bus.emit(type, detail);
  }
  // also dispatch DOM event for pages that don’t use the bus
  if (isBrowser) {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  }
};

const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/* -------------------------------------------------------------------------- */
/* domain classifiers                                                         */
/* -------------------------------------------------------------------------- */
/**
 * Very important: your imports can be recipes, Pinterest boards, garden templates,
 * seed packs, cleaning lists, butchery cut sheets, store flyers, etc.
 * We normalize to a SMALL SET OF DOMAINS so dashboards stay clean.
 */
const DOMAIN = {
  MEALS: "meals",
  CLEANING: "cleaning",
  GARDEN: "garden",
  STOREHOUSE: "storehouse",
  ANIMALS: "animals",
  UNKNOWN: "unknown",
};

/**
 * Tries to map any raw import meta to a domain.
 * You can make this smarter over time (use source hostname, path, tags).
 */
function classifyDomain(raw = {}) {
  const { type, source, tags = [], category, origin } = raw;

  // explicit incoming types from your ImportRouter
  if (type === "recipe" || type === "meal-plan" || tags.includes("food")) {
    return DOMAIN.MEALS;
  }
  if (type === "cleaning" || tags.includes("cleaning") || tags.includes("laundry") || category === "cleaning") {
    return DOMAIN.CLEANING;
  }
  if (type === "garden" || tags.includes("garden") || tags.includes("seed") || tags.includes("harvest")) {
    return DOMAIN.GARDEN;
  }
  if (type === "storehouse" || tags.includes("storehouse") || tags.includes("pantry") || tags.includes("stock")) {
    return DOMAIN.STOREHOUSE;
  }
  if (type === "animal" || type === "butchery" || tags.includes("animal") || tags.includes("livestock")) {
    return DOMAIN.ANIMALS;
  }

  // source host hints
  if (typeof source === "string") {
    const s = source.toLowerCase();
    if (s.includes("allrecipes") || s.includes("loveandlemons") || s.includes("pinterest")) {
      return DOMAIN.MEALS;
    }
    if (s.includes("seed") || s.includes("backyard") || s.includes("grow")) {
      return DOMAIN.GARDEN;
    }
  }

  // origin hints (from bookmarklet / mobile share sheet)
  if (typeof origin === "string") {
    const o = origin.toLowerCase();
    if (o.includes("pinterest")) return DOMAIN.MEALS;
    if (o.includes("youtube") && tags.includes("garden")) return DOMAIN.GARDEN;
  }

  return DOMAIN.UNKNOWN;
}

/* -------------------------------------------------------------------------- */
/* store / analytics snapshot                                                 */
/* -------------------------------------------------------------------------- */

const ImportAnalyticsService = (() => {
  // in-memory cache (can be re-hydrated from Dexie)
  const _state = {
    imports: [], // {id, domain, source, raw, createdAt, userOwned?, planId?, scheduleId?}
    byDomain: {
      [DOMAIN.MEALS]: [],
      [DOMAIN.CLEANING]: [],
      [DOMAIN.GARDEN]: [],
      [DOMAIN.STOREHOUSE]: [],
      [DOMAIN.ANIMALS]: [],
      [DOMAIN.UNKNOWN]: [],
    },
    // user-owned favorites and schedules coming from other parts of the app
    favorites: {
      // keyed by domain -> [favorite]
      [DOMAIN.MEALS]: [],
      [DOMAIN.CLEANING]: [],
      [DOMAIN.GARDEN]: [],
      [DOMAIN.STOREHOUSE]: [],
      [DOMAIN.ANIMALS]: [],
    },
  };

  /* ------------------ persistence to Dexie when available ------------------ */
  async function persistImport(rec) {
    const db = getDB();
    if (!db?.imports) return;
    try {
      await db.imports.put(rec);
    } catch (err) {
      console.warn("[ImportAnalyticsService] failed to persist import", err);
    }
  }

  async function persistFavorite(domain, fav) {
    const db = getDB();
    if (!db?.userFavorites) return;
    try {
      await db.userFavorites.put({ ...fav, domain });
    } catch (err) {
      console.warn("[ImportAnalyticsService] failed to persist favorite", err);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: record a new import                                              */
  /* ------------------------------------------------------------------------ */
  async function recordImport(rawImport) {
    // rawImport should already have what ImportService / ImportRouter captured
    // but we will normalize it
    const domain = classifyDomain(rawImport);
    const rec = {
      id: rawImport.id || genId(),
      domain,
      source: rawImport.source || rawImport.url || rawImport.origin || "unknown",
      raw: rawImport,
      createdAt: Date.now(),
      userOwned: !!rawImport.userOwned,
      planId: rawImport.planId || null,
      scheduleId: rawImport.scheduleId || null,
    };

    // schema check (optional, defensive)
    const { valid } = safeValidate("import.record", rec);
    if (!valid) {
      console.warn("[ImportAnalyticsService] invalid import record, saving anyway for debugging", rec);
    }

    _state.imports.unshift(rec);
    if (_state.byDomain[domain]) {
      _state.byDomain[domain].unshift(rec);
    } else {
      _state.byDomain[DOMAIN.UNKNOWN].unshift(rec);
    }

    // persist
    persistImport(rec);

    // fan-out so automation runtime can schedule domain sessions
    // ----------------------------------------------------------
    // meals → batch cooking / meal plan session
    if (domain === DOMAIN.MEALS) {
      emit("import.meals.detected", {
        importId: rec.id,
        payload: rawImport,
        suggestedAction: "generate-meal-plan-session",
      });
    }
    // cleaning
    if (domain === DOMAIN.CLEANING) {
      emit("import.cleaning.detected", {
        importId: rec.id,
        payload: rawImport,
        suggestedAction: "generate-cleaning-session",
      });
    }
    // garden: plan OR care OR harvest (we can check rawImport.subtype)
    if (domain === DOMAIN.GARDEN) {
      emit("import.garden.detected", {
        importId: rec.id,
        payload: rawImport,
        suggestedAction: rawImport.subtype === "harvest" ? "generate-harvest-session" : "generate-garden-plan",
      });
    }
    // storehouse: grocery sections for inspiration
    if (domain === DOMAIN.STOREHOUSE) {
      emit("import.storehouse.detected", {
        importId: rec.id,
        payload: rawImport,
        suggestedAction: "update-storehouse-goal-engine",
      });
    }
    // animals: acquisition, care, butchery (reverse from recipes)
    if (domain === DOMAIN.ANIMALS) {
      emit("import.animals.detected", {
        importId: rec.id,
        payload: rawImport,
        suggestedAction: rawImport.subtype || "generate-animal-care-plan",
      });
    }

    return rec;
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: get analytics snapshot                                           */
  /* ------------------------------------------------------------------------ */
  function getAnalytics(opts = {}) {
    const { limit = 50, domain = null } = opts;
    if (domain) {
      return {
        domain,
        recent: _state.byDomain[domain].slice(0, limit),
        totals: {
          imports: _state.byDomain[domain].length,
          favorites: _state.favorites[domain]?.length || 0,
        },
      };
    }

    return {
      recent: _state.imports.slice(0, limit),
      totals: {
        meals: _state.byDomain[DOMAIN.MEALS].length,
        cleaning: _state.byDomain[DOMAIN.CLEANING].length,
        garden: _state.byDomain[DOMAIN.GARDEN].length,
        storehouse: _state.byDomain[DOMAIN.STOREHOUSE].length,
        animals: _state.byDomain[DOMAIN.ANIMALS].length,
        unknown: _state.byDomain[DOMAIN.UNKNOWN].length,
      },
      favorites: _state.favorites,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: allow user to FAVORITE a session/plan that came from an import   */
  /* ------------------------------------------------------------------------ */
  async function favoriteFromImport(importId, meta = {}) {
    const found = _state.imports.find((r) => r.id === importId);
    if (!found) return null;

    const fav = {
      id: genId(),
      importId,
      domain: found.domain,
      label: meta.label || found.raw?.title || `Favorite ${found.domain}`,
      createdAt: Date.now(),
      // allow users to attach own schedule ref (their schedule, not system’s)
      userScheduleId: meta.userScheduleId || null,
      // allow shared/collab planning
      sharedWith: Array.isArray(meta.sharedWith) ? meta.sharedWith : [],
      // allow fee / sell-to-community later
      sellable: !!meta.sellable,
    };

    if (!_state.favorites[found.domain]) {
      _state.favorites[found.domain] = [];
    }
    _state.favorites[found.domain].unshift(fav);
    await persistFavorite(found.domain, fav);

    // let automation runtime know
    emit("user.favorite.created", {
      domain: found.domain,
      favorite: fav,
      source: "import-analytics",
    });

    return fav;
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: REVERSE GENERATION                                               */
  /* ------------------------------------------------------------------------ */
  /**
   * reverseGenerate({ domain, plan })
   * Lets you say:
   *  - “I have a meal plan, give me the imports I should go pull”
   *  - “I have a garden co-op target, tell me what seed/planting templates to import”
   *  - “I have butchery this weekend, tell me what animal/butchery guides to import”
   *
   * This does NOT actually go out to the web; it emits events the Import router
   * / bookmarklet UI can listen to and present quick actions.
   */
  function reverseGenerate({ domain, plan }) {
    const payload = { domain, plan, requestedAt: Date.now() };

    switch (domain) {
      case DOMAIN.MEALS: {
        // e.g. meal plan has recipes w/o source → ask to import matched recipes
        emit("import.reverse.meals.requested", payload);
        break;
      }
      case DOMAIN.CLEANING: {
        emit("import.reverse.cleaning.requested", payload);
        break;
      }
      case DOMAIN.GARDEN: {
        // garden co-op: “we need more tomatoes” → ask for tomato templates
        emit("import.reverse.garden.requested", payload);
        break;
      }
      case DOMAIN.STOREHOUSE: {
        // storehouse: “I want grocery sections to inspire stock planning”
        emit("import.reverse.storehouse.requested", payload);
        break;
      }
      case DOMAIN.ANIMALS: {
        // animals: “this meal plan needs 3 lambs and 1 goat” → import animal plans
        emit("import.reverse.animals.requested", payload);
        break;
      }
      default: {
        emit("import.reverse.unknown.requested", payload);
      }
    }

    return { ok: true };
  }

  /* ------------------------------------------------------------------------ */
  /* PUBLIC: bootstrap from Dexie (optional)                                  */
  /* ------------------------------------------------------------------------ */
  async function hydrateFromDB() {
    const db = getDB();
    if (!db) return;

    // imports
    if (db.imports) {
      try {
        const rows = await db.imports.reverse().toArray();
        _state.imports = rows;
        // rebuild byDomain
        _state.byDomain = {
          [DOMAIN.MEALS]: [],
          [DOMAIN.CLEANING]: [],
          [DOMAIN.GARDEN]: [],
          [DOMAIN.STOREHOUSE]: [],
          [DOMAIN.ANIMALS]: [],
          [DOMAIN.UNKNOWN]: [],
        };
        rows.forEach((r) => {
          const d = r.domain || DOMAIN.UNKNOWN;
          if (!_state.byDomain[d]) _state.byDomain[d] = [];
          _state.byDomain[d].push(r);
        });
      } catch (err) {
        console.warn("[ImportAnalyticsService] failed to hydrate imports", err);
      }
    }

    // favorites
    if (db.userFavorites) {
      try {
        const favs = await db.userFavorites.reverse().toArray();
        favs.forEach((f) => {
          if (!_state.favorites[f.domain]) _state.favorites[f.domain] = [];
          _state.favorites[f.domain].push(f);
        });
      } catch (err) {
        console.warn("[ImportAnalyticsService] failed to hydrate favorites", err);
      }
    }
  }

  // public api
  return {
    recordImport,
    getAnalytics,
    favoriteFromImport,
    reverseGenerate,
    hydrateFromDB,
    DOMAIN,
  };
})();

export default ImportAnalyticsService;
