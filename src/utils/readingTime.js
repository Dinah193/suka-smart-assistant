/* eslint-disable no-console */
// utils/readingTime.js — module-aware reading-time estimator with orchestration hooks
// - Accepts markdown, html, or plain text
// - Medium-style image time (first: 12s, next: 11s … floor 3s)
// - Module-aware weights: recipe steps, checklists, code blocks, tables
// - Emits: "content.readingtime.computed" for badges/analytics
// - Tiny LS cache keyed by content hash + options
// - ESM/CJS friendly

const isBrowser = typeof window !== "undefined";
const DEFAULT_WPM = 225; // conservative average
const SKIM_WPM = 400; // for lists/headers
const CODE_WPM = 160; // slower for code/instructions
const TABLE_PENALTY_FACTOR = 1.15; // tables take longer to parse
const LIST_BONUS_FACTOR = 0.9; // bullet lists are faster to skim
const FIRST_IMAGE_SEC = 12; // Medium convention
const NEXT_IMAGE_SEC = 11; // Medium convention (then -1s each, min 3s)

const safeJSON = {
  parse: (s, f = null) => {
    try {
      return JSON.parse(s);
    } catch {
      return f;
    }
  },
  stringify: (o) => {
    try {
      return JSON.stringify(o);
    } catch {
      return "{}";
    }
  },
};

/* --------------------------- defensive dependencies ------------------------ */
let eventBus = { on() {}, off() {}, emit() {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let PlanStorageRouter = null;
try {
  PlanStorageRouter = require("@/services/plans/PlanStorageRouter").default;
} catch (_e) {}

let useFavoritePlans = null;
try {
  useFavoritePlans = require("@/hooks/useFavoritePlans").default;
} catch (_e) {}

/* ---------------------------------- utils --------------------------------- */
function hash32(str) {
  // tiny non-crypto hash for caching
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function stripHTML(html = "") {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function stripMarkdown(md = "") {
  return String(md)
    .replace(/```[\s\S]*?```/g, " ") // code fences
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/!\[[^\]]*\]\([^)]+\)/g, " ") // images
    .replace(/\[[^\]]*\]\([^)]+\)/g, " ") // links
    .replace(/[*_~`>#-]/g, " ") // md tokens
    .replace(/\|/g, " "); // table bars
}

function tokenize(text = "") {
  return String(text).replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
}

function count(regex, text) {
  const m = String(text).match(new RegExp(regex, "gi"));
  return m ? m.length : 0;
}

/* ------------------------------ core estimator ----------------------------- */
function analyzeStructure(raw, kind = "markdown") {
  const src = String(raw || "");
  const text =
    kind === "html"
      ? stripHTML(src)
      : kind === "markdown"
      ? stripMarkdown(src)
      : src;

  // primitives
  const images =
    kind === "html"
      ? count("<img\\b", src)
      : count("!\\[[^\\]]*\\]\\([^\\)]+\\)", src);

  const codeFences = count("```", src) + count("<code\\b", src);
  const tables = count("^\\|", src) + count("<table\\b", src);
  const headings = count("^\\s*#{1,6}\\s", src) + count("<h[1-6]\\b", src);
  const lists =
    count("^\\s*[-*+]\\s", src) +
    count("^\\s*\\d+\\.\\s", src) +
    count("<li\\b", src);

  // recipe/howto heuristics
  const ingredients = count("^\\s*-\\s", src) + count("^\\s*\\*\\s", src);
  const steps = count("^\\s*\\d+\\.\\s", src);

  const words = tokenize(text).length;

  return {
    words,
    images,
    codeFences,
    tables,
    headings,
    lists,
    ingredients,
    steps,
    plainText: text,
  };
}

function mediumImageSeconds(n) {
  if (!n) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) total += FIRST_IMAGE_SEC;
    else {
      const sec = Math.max(3, NEXT_IMAGE_SEC - (i - 1)); // 11,10,9,...,3
      total += sec;
    }
  }
  return total;
}

function moduleWeights(module = "meals") {
  // Tuned heuristics per module
  switch (module) {
    case "meals":
      return {
        wpm: DEFAULT_WPM,
        stepWpm: 170,
        listWpm: SKIM_WPM,
        imageSecs: 1.0,
        codeFactor: 1.0,
        tableFactor: TABLE_PENALTY_FACTOR,
      };
    case "cleaning":
      return {
        wpm: DEFAULT_WPM,
        stepWpm: 180,
        listWpm: SKIM_WPM,
        imageSecs: 0.8,
        codeFactor: 1.0,
        tableFactor: 1.05,
      };
    case "garden":
      return {
        wpm: 215,
        stepWpm: 175,
        listWpm: 360,
        imageSecs: 1.1,
        codeFactor: 1.0,
        tableFactor: 1.12,
      };
    case "animals":
      return {
        wpm: 210,
        stepWpm: 170,
        listWpm: 350,
        imageSecs: 1.1,
        codeFactor: 1.0,
        tableFactor: 1.12,
      };
    default:
      return {
        wpm: DEFAULT_WPM,
        stepWpm: 185,
        listWpm: SKIM_WPM,
        imageSecs: 1.0,
        codeFactor: 1.0,
        tableFactor: TABLE_PENALTY_FACTOR,
      };
  }
}

function estimateCore(
  textOrHTML,
  {
    kind = "markdown", // "markdown" | "html" | "text"
    module = "meals", // meals | cleaning | garden | animals
    includeImages = true,
    includeTablesPenalty = true,
    includeCodePenalty = true,
    includeListBonus = true,
  } = {}
) {
  const s = analyzeStructure(textOrHTML, kind);
  const weights = moduleWeights(module);

  // words buckets (heuristics)
  const words = s.words;
  const listBonusWords = includeListBonus ? Math.ceil(s.lists * 5) : 0; // lists skim faster → subtract a few words
  const tablePenaltyWords = includeTablesPenalty
    ? Math.ceil(words * (weights.tableFactor - 1))
    : 0;
  const codePenaltyWords = includeCodePenalty
    ? Math.ceil((s.codeFences || 0) * 35 * (DEFAULT_WPM / CODE_WPM))
    : 0;

  // steps (for how-to/recipe): treat each step as mini paragraph
  const stepWords = Math.ceil((s.steps || 0) * 25); // average per numbered line
  const ingredientWords = Math.min(200, Math.ceil((s.ingredients || 0) * 4));

  // base time
  const baseMinutes =
    (words +
      stepWords +
      ingredientWords +
      tablePenaltyWords +
      codePenaltyWords -
      listBonusWords) /
    (weights.wpm * 1.0);

  // images time (Medium-like), scaled by module
  const imageMinutes = includeImages
    ? (mediumImageSeconds(s.images) * weights.imageSecs) / 60
    : 0;

  // round
  const minutes = Math.max(0.2, baseMinutes + imageMinutes);
  const seconds = Math.round(minutes * 60);

  return {
    seconds,
    minutes: minutes,
    minutesRounded: Math.max(1, Math.round(minutes)),
    words,
    tokens: words, // compatible field
    images: s.images,
    steps: s.steps,
    lists: s.lists,
    tables: s.tables,
    codeBlocks: s.codeFences,
  };
}

/* -------------------------------- formatting ------------------------------- */
function formatLabel(rt, { granularity = "range" } = {}) {
  // "5–6 min read" (range) | "5 min read" (tight)
  const m = Math.max(1, Math.round(rt.minutes));
  if (granularity === "tight") return `${m} min read`;
  const low = Math.max(1, Math.floor(rt.minutes));
  const high = Math.max(low + 1, Math.ceil(rt.minutes) + 1);
  return `${low}–${high} min read`;
}

/* ----------------------------------- cache --------------------------------- */
const CACHE_KEY = "suka:readingtime:cache:v1";
function cacheGet(k) {
  if (!isBrowser) return null;
  const all = safeJSON.parse(localStorage.getItem(CACHE_KEY), {});
  return all[k] || null;
}
function cacheSet(k, v) {
  if (!isBrowser) return;
  const all = safeJSON.parse(localStorage.getItem(CACHE_KEY), {});
  all[k] = v;
  localStorage.setItem(CACHE_KEY, safeJSON.stringify(all));
}

/* --------------------------- favorites convenience -------------------------- */
async function saveFavoritePlan(meta, target = "local") {
  try {
    if (PlanStorageRouter?.savePlanFavorite) {
      return await PlanStorageRouter.savePlanFavorite({
        planId: meta.planId || `readingtime-plan:${meta.contentId}`,
        domain: meta.domain,
        source: "ReadingTime",
        target,
        meta,
      });
    }
  } catch (_e) {}
  try {
    if (typeof useFavoritePlans === "function") {
      const st = useFavoritePlans.getState?.();
      st?.addFavorite?.({
        id: meta.planId || `readingtime-plan:${meta.contentId}`,
        domain: meta.domain,
        title: meta.title,
        meta,
      });
      return { ok: true, via: "useFavoritePlans" };
    }
  } catch (_e) {}
  try {
    if (isBrowser) {
      const key = "suka:favorites:plans";
      const prev = safeJSON.parse(localStorage.getItem(key), []);
      prev.push({
        id: meta.planId || `readingtime-plan:${meta.contentId}`,
        domain: meta.domain,
        title: meta.title,
        meta,
      });
      localStorage.setItem(key, safeJSON.stringify(prev));
      return { ok: true, via: "localStorage" };
    }
  } catch (_e) {}
  return { ok: false };
}

/* ------------------------------ public API --------------------------------- */
/**
 * estimate(content, options)
 * @param {string|{markdown?:string, html?:string, text?:string, id?:string, module?:string}} content
 * @param {{kind?:'markdown'|'html'|'text', module?:'meals'|'cleaning'|'garden'|'animals', includeImages?:boolean}} options
 */
function estimate(content, options = {}) {
  const isObj = typeof content === "object" && content;
  const kind =
    options.kind ||
    (isObj &&
      (content.markdown ? "markdown" : content.html ? "html" : "text")) ||
    "markdown";
  const module = options.module || (isObj && content.module) || "meals";
  const src = isObj
    ? content.markdown || content.html || content.text || ""
    : String(content || "");
  const key = hash32(module + "::" + kind + "::" + src.slice(0, 20000)); // cap hash input

  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };

  const rt = estimateCore(src, {
    kind,
    module,
    includeImages: options.includeImages !== false,
  });
  const label = formatLabel(rt, { granularity: "range" });

  const result = { ...rt, label, module, kind, cached: false };

  cacheSet(key, result);

  // Emit for orchestration (badges, analytics)
  eventBus.emit?.("content.readingtime.computed", {
    id: (isObj && content.id) || key,
    module,
    kind,
    seconds: rt.seconds,
    minutes: rt.minutes,
    label,
    images: rt.images,
    steps: rt.steps,
  });

  return result;
}

/**
 * estimateForArticle(frontmatter, bodyMarkdown)
 * Convenience for evergreenArticleTemplate outputs.
 */
function estimateForArticle(frontmatter = {}, bodyMarkdown = "") {
  const module = frontmatter.module || "meals";
  const id = frontmatter.id || hash32(bodyMarkdown.slice(0, 20000));
  const rt = estimate(
    { id, module, markdown: bodyMarkdown },
    { kind: "markdown", module }
  );
  return { id, module, ...rt };
}

/**
 * badgeProps(rt)
 * Returns a minimal object your UI can use to render a compact badge.
 */
function badgeProps(rt) {
  return {
    text: rt.label, // "5–6 min read"
    title: `~${Math.max(1, Math.round(rt.minutes))} minutes (${
      rt.words
    } words, ${rt.images} images)`,
    details: rt,
  };
}

/**
 * saveFavoritePlanFromReading(contentMeta, target)
 * Saves a Favorite Plan tied to the content read-time summary (for "read → plan" UX).
 */
async function saveFavoritePlanFromReading(
  { contentId, title, module = "meals", tags = [] },
  target = "local"
) {
  const res = await saveFavoritePlan(
    {
      contentId,
      title: `Plan: ${title}`,
      domain: module,
      tags,
      createdISO: new Date().toISOString(),
    },
    target
  );
  if (res?.ok) {
    eventBus.emit?.("toast", {
      kind: "success",
      message: "Saved as Favorite Plan",
      tsISO: new Date().toISOString(),
    });
  } else {
    eventBus.emit?.("toast", {
      kind: "error",
      message: "Could not save favorite",
      tsISO: new Date().toISOString(),
    });
  }
  return res;
}

/* --------------------------------- export ---------------------------------- */
const api = {
  estimate,
  estimateForArticle,
  badgeProps,
  saveFavoritePlanFromReading,
  // expose internals for tests/tuning
  _analyze: analyzeStructure,
  _mediumImageSeconds: mediumImageSeconds,
  _moduleWeights: moduleWeights,
};

export default api;

// CJS interop
if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}
