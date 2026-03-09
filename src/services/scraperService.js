// C:\Users\larho\suka-smart-assistant\src\services\scraperService.js
// Suka Smart Assistant – Unified Scraper Service
// -----------------------------------------------------------------------------
// PURPOSE
// - ONE place to request: “scrape/import this thing from the web / clipboard / bookmarklet / PWA share”
// - Returns a **normalized, SSA-style import payload** that ImportNormalizer + ImportService
//   can consume immediately
// - Honors user-level import settings (auto favorites, auto schedules, reverseMeta)
// - Emits SHARED ORCHESTRATION events in a consistent envelope:
//     { type, ts, source, data }
//   so the rest of the app (automation runtime, relative scheduler, dashboards) can react
// - Supports REVERSE GENERATION by always embedding a `reverseMeta` block
//
// WHERE IT FITS
// imports (URL/HTML/Share) → scraperService.scrape(...) → normalized import
// → ImportQueueManager.enqueue(...) → ImportService (to persist / favorites)
// → eventBus.emit("import.queue.enqueue", {...}) → automation.schedule.request
// → (optional) exportToHubIfEnabled(...) when the content is specifically storehouse/inventory-ish
//
// SOURCES IT HANDLES
// - raw HTML string
// - URL (fetch + light DOM parsing in browser context; CORS-safe fallback)
// - bookmarklet payload (already partially scraped)
// - PWA share payload
// - Pinterest-like payload
// - basic JSON from other accounts (Allrecipes, “here is a recipe JSON from TikTok”, FB post JSON) – best effort
//
// NOTES
// - This is browser-first. For CORS-restricted sites you can add a tiny proxy later.
// - This file is FORWARD-THINKING: we already recognize preservation, animal, storehouse,
//   scan/receipt, and video/how-to domains, not just recipes.
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

const isBrowser = typeof window !== "undefined";

// ------------------------------ Defensive imports ----------------------------
let eventBus = { emit() {}, on() {}, off() {} };
try {
  // eslint-disable-next-line global-require
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {
  // ok – we'll still use window events as a fallback
}

let ImportService = { saveAsFavorite() {} };
try {
  // eslint-disable-next-line global-require
  ImportService = require("@/features/import/ImportService");
} catch (_e) {}

let ImportQueueManager = { enqueue() {} };
try {
  // eslint-disable-next-line global-require
  ImportQueueManager = require("@/features/import/ImportQueueManager");
} catch (_e) {}

let ImportNormalizer = { normalize: (x) => x };
try {
  // eslint-disable-next-line global-require
  ImportNormalizer = require("@/features/import/ImportNormalizer");
} catch (_e) {}

let schemaValidator = null;
try {
  // eslint-disable-next-line global-require
  const sv = require("@/services/schemaValidator");
  schemaValidator = sv.schemaValidator || sv;
} catch (_e) {}

// optional – to export storehouse/inventory-like imports to Hub
let featureFlags = { familyFundMode: false };
try {
  // eslint-disable-next-line global-require
  const ff = require("@/config/featureFlags.json");
  featureFlags = ff || featureFlags;
} catch (_e) {}

let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  // eslint-disable-next-line global-require
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
} catch (_e) {}
try {
  // eslint-disable-next-line global-require
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch (_e) {}

const DEFAULT_IMPORT_PREFS = {
  autoOpenPreview: true,
  autoSaveFavorite: false,
  autoSchedule: false,
  autoScheduleRule: "once+5min",
  reverseMeta: {
    shareTarget: "family-fund-hub",
    includeShare: true,
    format: "json",
  },
};

// -----------------------------------------------------------------------------
// prefs
// -----------------------------------------------------------------------------
function loadImportPrefs() {
  if (!isBrowser) return { ...DEFAULT_IMPORT_PREFS };
  try {
    const raw = window.localStorage.getItem("suka.import.settings.v1");
    return raw
      ? { ...DEFAULT_IMPORT_PREFS, ...JSON.parse(raw) }
      : { ...DEFAULT_IMPORT_PREFS };
  } catch (_e) {
    return { ...DEFAULT_IMPORT_PREFS };
  }
}

// -----------------------------------------------------------------------------
// emit helper – emits BOTH to window and to eventBus in SSA envelope
// -----------------------------------------------------------------------------
function emitSSA(type, data = {}, source = "scraperService") {
  const evt = {
    type,
    ts: new Date().toISOString(),
    source,
    data,
  };

  // app-level bus (preferred)
  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit(type, evt);
    }
  } catch (_e) {}

  // window-level (for PWA/share/bookmarklet / legacy listeners)
  if (isBrowser) {
    try {
      window.dispatchEvent(new CustomEvent(type, { detail: evt }));
    } catch (_e) {}
    try {
      const bus = window.__suka?.eventBus;
      if (bus?.emit) bus.emit(type, evt);
    } catch (_e) {}
  }

  return evt;
}

// -----------------------------------------------------------------------------
// Hub export (optional, silent fail)
// -----------------------------------------------------------------------------
function exportToHubIfEnabled(payload) {
  // Only export if feature flag is on AND we have hub services
  if (!featureFlags || !featureFlags.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const pkt = HubPacketFormatter.toHubPacket(payload);
    FamilyFundConnector.send(pkt);
  } catch (_e) {
    // silent
  }
}

// -----------------------------------------------------------------------------
// core service
// -----------------------------------------------------------------------------
export const scraperService = {
  /**
   * Main entry.
   * @param {Object} opts
   *  - url?: string
   *  - html?: string
   *  - sourceType?: string  ("recipe" | "cleaning" | "garden" | "animal" | "storehouse" | "video" | "scan" | ...)
   *  - payload?: object (bookmarklet / pwa share / already-scraped JSON)
   *  - inferDomain?: boolean (default true)
   *  - saveAsFavorite?: boolean
   *  - schedule?: object | boolean | string
   *  - reverseMeta?: object
   */
  async scrape(opts = {}) {
    const prefs = loadImportPrefs();
    const {
      url,
      html,
      sourceType = "generic",
      payload,
      inferDomain = true,
      saveAsFavorite = prefs.autoSaveFavorite,
      schedule = prefs.autoSchedule ? prefs.autoScheduleRule : false,
      reverseMeta = prefs.reverseMeta,
    } = opts;

    let rawResult;

    // 1) FORMS OF INPUT --------------------------------------------------------
    if (payload && typeof payload === "object") {
      // already partly scraped (bookmarklet, pwa share, linked account)
      rawResult = { ...payload };
    } else if (html) {
      rawResult = scrapeFromHTML(html, url, sourceType);
    } else if (url) {
      rawResult = await scrapeFromURL(url, sourceType);
    } else {
      // super fallback – still give the rest of the pipeline something to work with
      rawResult = {
        title: "Untitled import",
        __importType: "recipe",
        source: { kind: sourceType },
      };
    }

    // 2) DOMAIN INFERENCE ------------------------------------------------------
    if (inferDomain && !rawResult.__importType) {
      rawResult.__importType = inferImportType(rawResult, sourceType);
    }

    // 3) ATTACH USER-LEVEL INSTRUCTIONS ----------------------------------------
    rawResult.saveAsFavorite = !!saveAsFavorite;
    rawResult.reverseMeta = rawResult.reverseMeta || reverseMeta;

    // schedule can be "once+5min" or an object
    if (schedule) {
      rawResult.schedule =
        typeof schedule === "object"
          ? schedule
          : buildSchedule(schedule, rawResult);
    }

    // 4) VALIDATE & NORMALIZE --------------------------------------------------
    // validate to your central validator first – it will auto-inject missing pieces
    let validated = { valid: true, normalized: rawResult, errors: [] };
    if (
      schemaValidator &&
      typeof schemaValidator.validateImport === "function"
    ) {
      validated = schemaValidator.validateImport(rawResult, {
        defaultSaveAsFavorite: prefs.autoSaveFavorite,
      });
    }
    let normalized = validated.normalized || rawResult;

    // Additional normalization from ImportNormalizer (deeper, domain-aware)
    try {
      normalized = ImportNormalizer.normalize(normalized);
    } catch (_e) {
      // still usable
    }

    // 5) PUSH TO QUEUE (best-effort) -------------------------------------------
    try {
      ImportQueueManager.enqueue(sourceType, normalized, {
        saveAsFavorite: normalized.saveAsFavorite,
        schedule: normalized.schedule || null,
        session: normalized.session || null,
        label: normalized.title,
      });

      emitSSA("import.queue.enqueue", {
        sourceType,
        item: normalized,
      });
    } catch (_e) {
      // if queue not ready, we still emit for late listeners
      emitSSA("import.queue.enqueue", {
        sourceType,
        item: normalized,
        queued: false,
      });
    }

    // 6) FAVORITES -------------------------------------------------------------
    if (normalized.saveAsFavorite) {
      try {
        ImportService.saveAsFavorite(normalized);
        emitSSA("import.favorite.saved", { item: normalized });
      } catch (_e) {
        // ignore
      }
    }

    // 7) SCHEDULING / AUTOMATION -----------------------------------------------
    if (normalized.schedule) {
      emitSSA("automation.schedule.request", {
        normalized,
        schedule: normalized.schedule,
        session: normalized.session || {
          domain: normalized.__importType || normalized.type,
          action: "run-imported",
          payload: normalized,
        },
      });
    }

    // 8) UI PREVIEW -------------------------------------------------------------
    if (prefs.autoOpenPreview) {
      emitSSA("import.preview.open", { item: normalized });
    }

    // 9) SERVICE COMPLETED ------------------------------------------------------
    emitSSA("import.service.completed", { normalized });

    // 10) (OPTIONAL) HUB EXPORT for HOUSEHOLD-CHANGING DOMAINS ------------------
    // NOTE: scraping itself does NOT mutate; but some imports (storehouse-stock,
    // inventoryUpdate, butchery-to-storehouse) are effectively data updates, so we
    // offer an auto-forward here.
    if (
      normalized.__importType === "storehouseStock" ||
      normalized.__importType === "inventoryUpdate" ||
      normalized.__importType === "harvestPlan" || // could feed storehouse
      normalized.__importType === "butcherySession"
    ) {
      exportToHubIfEnabled({
        kind: "imported-household-data",
        source: "scraperService",
        payload: normalized,
      });
    }

    return normalized;
  },

  /**
   * Convenience for “reverse generate from url/payload”
   * — wraps scrape() and immediately emits reverse event.
   */
  async scrapeAndReverse(opts = {}) {
    const item = await this.scrape(opts);
    emitSSA("import.preview.reverse", { item, reversed: item });
    return item;
  },
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------
function inferImportType(raw, sourceType) {
  const text = (raw?.title || raw?.text || raw?.url || "").toLowerCase();

  // explicit source hints from SSA project
  if (sourceType === "pinterest") return "mealPlan";
  if (
    sourceType === "garden" ||
    sourceType === "seed" ||
    sourceType === "garden-site"
  )
    return "gardenPlan";
  if (
    sourceType === "cleaning" ||
    text.includes("cleaning") ||
    text.includes("declutter")
  )
    return "cleaningPlan";
  if (
    sourceType === "storehouse" ||
    text.includes("storehouse") ||
    text.includes("pantry goal")
  )
    return "storehouseGoal";
  if (
    sourceType === "storehouse-stock" ||
    text.includes("grocery section") ||
    text.includes("restock")
  )
    return "storehouseStock";
  if (
    sourceType === "animal" ||
    text.includes("animal plan") ||
    text.includes("livestock")
  )
    return "animalPlan";
  if (
    sourceType === "video" ||
    text.includes("youtube.com") ||
    text.includes("youtu.be")
  )
    return "video";

  // preservation / homestead
  if (
    text.includes("canning") ||
    text.includes("dehydrate") ||
    text.includes("ferment") ||
    text.includes("preserve food")
  )
    return "preservationPlan";

  // garden / care / harvest
  if (
    text.includes("garden care") ||
    text.includes("pruning") ||
    text.includes("watering")
  )
    return "gardenCare";
  if (text.includes("harvest") || text.includes("when to pick"))
    return "harvestPlan";

  // animal acquisition / butchery
  if (
    text.includes("animal acquisition") ||
    text.includes("buy goats") ||
    text.includes("buy sheep")
  )
    return "animalAcquisition";
  if (
    text.includes("butchery") ||
    text.includes("slaughter") ||
    text.includes("cut sheet")
  )
    return "butcherySession";

  // scan-ish
  if (
    text.includes("receipt") ||
    text.includes("circular") ||
    text.includes("scan") ||
    text.includes("pdf")
  )
    return "inventoryUpdate";

  // meal planning
  if (
    text.includes("meal plan") ||
    text.includes("weekly menu") ||
    text.includes("batch cook")
  )
    return "mealPlan";

  // recipe fallback
  if (text.includes("recipe") || text.includes("ingredients")) return "recipe";

  return "recipe";
}

/**
 * scrape from HTML string
 */
function scrapeFromHTML(html, url, sourceType) {
  let doc;
  if (isBrowser && typeof DOMParser !== "undefined") {
    doc = new DOMParser().parseFromString(html, "text/html");
  }

  const title =
    (doc &&
      (doc.querySelector("title")?.textContent ||
        doc.querySelector('meta[property="og:title"]')?.content)) ||
    "Imported Page";

  const ogDesc =
    doc?.querySelector('meta[property="og:description"]')?.content || null;
  const list = doc
    ? Array.from(doc.querySelectorAll("li, .ingredient, .ingredients li"))
        .map((el) => el.textContent.trim())
        .filter((t) => t && t.length < 180)
        .slice(0, 60) // 60 to capture cleaning + harvest tasks
    : [];

  const base = {
    __importType: "recipe",
    title,
    url,
    source: {
      kind: sourceType || "html",
      url,
    },
    meta: {
      htmlLength: html.length,
      description: ogDesc,
      scrapedAt: Date.now(),
    },
  };

  const lowerHtml = html.toLowerCase();

  // cleaning blog → cleaningPlan
  if (
    sourceType === "cleaning" ||
    lowerHtml.includes("cleaning") ||
    lowerHtml.includes("declutter")
  ) {
    return {
      ...base,
      __importType: "cleaningPlan",
      tasks: list.map((t) => ({ title: t, area: guessCleaningArea(t) })),
    };
  }

  // garden / seed site
  if (
    sourceType === "garden" ||
    sourceType === "seed" ||
    lowerHtml.includes("seed") ||
    lowerHtml.includes("garden") ||
    lowerHtml.includes("burpee") ||
    lowerHtml.includes("johnny")
  ) {
    return {
      ...base,
      __importType: "gardenPlan",
      seeds: list.map((name) => ({ name })),
      coop: true,
    };
  }

  // harvest / garden care
  if (
    lowerHtml.includes("harvest") ||
    lowerHtml.includes("when to pick") ||
    lowerHtml.includes("succession")
  ) {
    return {
      ...base,
      __importType: "harvestPlan",
      harvestTasks: list.map((t) => ({ title: t })),
    };
  }
  if (
    lowerHtml.includes("prune") ||
    lowerHtml.includes("watering schedule") ||
    lowerHtml.includes("mulch")
  ) {
    return {
      ...base,
      __importType: "gardenCare",
      careTasks: list.map((t) => ({ title: t })),
    };
  }

  // preservation
  if (
    lowerHtml.includes("canning") ||
    lowerHtml.includes("dehydrate") ||
    lowerHtml.includes("ferment") ||
    lowerHtml.includes("preserve food")
  ) {
    return {
      ...base,
      __importType: "preservationPlan",
      steps: list.map((t) => ({ title: t })),
    };
  }

  // storehouse / pantry / grocery sections
  if (
    lowerHtml.includes("storehouse") ||
    lowerHtml.includes("pantry") ||
    lowerHtml.includes("grocery")
  ) {
    return {
      ...base,
      __importType: "storehouseStock",
      sections: groupToGrocerySections(list),
    };
  }

  // animal / butchery
  if (
    lowerHtml.includes("butchery") ||
    lowerHtml.includes("slaughter") ||
    lowerHtml.includes("cut sheet")
  ) {
    return {
      ...base,
      __importType: "butcherySession",
      steps: list,
    };
  }
  if (
    lowerHtml.includes("goat") ||
    lowerHtml.includes("sheep") ||
    lowerHtml.includes("chicken")
  ) {
    return {
      ...base,
      __importType: "animalAcquisition",
      animals: list.map((t) => ({ name: t })),
    };
  }

  // default recipe-ish
  return {
    ...base,
    ingredients: list,
    steps: [],
  };
}

/**
 * scrape from URL by fetching. Will fail CORS on some sites – we detect that
 * and return a best-effort payload (title=url).
 */
async function scrapeFromURL(url, sourceType) {
  if (!isBrowser) {
    return {
      __importType: "recipe",
      title: url,
      url,
      source: { kind: sourceType || "url", url },
      meta: { scrapedAt: Date.now(), fromServer: true },
      ingredients: [],
      steps: [],
    };
  }

  try {
    const res = await fetch(url, { credentials: "include" });
    const text = await res.text();
    return scrapeFromHTML(text, url, sourceType);
  } catch (err) {
    // CORS or network → fallback
    return {
      __importType: "recipe",
      title: url,
      url,
      source: { kind: sourceType || "url", url },
      meta: {
        scrapedAt: Date.now(),
        error: err?.message || "fetch-failed",
      },
      ingredients: [],
      steps: [],
    };
  }
}

/**
 * schedule builder — matches ImportSettings / ShareReceiver logic
 */
function buildSchedule(rule, item) {
  if (rule === "once+5min") {
    return {
      id: `scrape-${item.id || "x"}-once5`,
      frequency: "once",
      runAt: Date.now() + 5 * 60 * 1000,
    };
  }
  if (rule === "daily@9") {
    const now = new Date();
    const runAt = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      9,
      0,
      0
    ).getTime();
    return {
      id: `scrape-${item.id || "x"}-daily9`,
      frequency: "daily",
      runAt,
    };
  }
  // default → 2 minutes
  return {
    id: `scrape-${item.id || "x"}-once`,
    frequency: "once",
    runAt: Date.now() + 2 * 60 * 1000,
  };
}

// -----------------------------------------------------------------------------
// small domain helpers
// -----------------------------------------------------------------------------
function guessCleaningArea(text) {
  const lower = text.toLowerCase();
  if (
    lower.includes("kitchen") ||
    lower.includes("fridge") ||
    lower.includes("stove")
  )
    return "kitchen";
  if (
    lower.includes("bath") ||
    lower.includes("toilet") ||
    lower.includes("shower")
  )
    return "bathroom";
  if (lower.includes("laundry")) return "laundry";
  if (lower.includes("porch") || lower.includes("yard")) return "outdoor";
  return "general";
}

function groupToGrocerySections(items) {
  const result = {
    produce: [],
    meats: [],
    dairy: [],
    dryGoods: [],
    cleaning: [],
    other: [],
  };
  items.forEach((it) => {
    const lower = it.toLowerCase();
    if (
      lower.includes("lettuce") ||
      lower.includes("tomato") ||
      lower.includes("onion") ||
      lower.includes("apple")
    ) {
      result.produce.push(it);
    } else if (
      lower.includes("beef") ||
      lower.includes("lamb") ||
      lower.includes("goat") ||
      lower.includes("chicken") ||
      lower.includes("fish")
    ) {
      result.meats.push(it);
    } else if (
      lower.includes("milk") ||
      lower.includes("cheese") ||
      lower.includes("yogurt") ||
      lower.includes("butter")
    ) {
      result.dairy.push(it);
    } else if (
      lower.includes("soap") ||
      lower.includes("bleach") ||
      lower.includes("detergent")
    ) {
      result.cleaning.push(it);
    } else if (
      lower.includes("rice") ||
      lower.includes("flour") ||
      lower.includes("beans") ||
      lower.includes("pasta")
    ) {
      result.dryGoods.push(it);
    } else {
      result.other.push(it);
    }
  });
  return result;
}

// ✅ Add a default export so imports like:
//   import scraperService from "../../services/scraperService.js";
// work without changing existing named exports.
export default scraperService;
