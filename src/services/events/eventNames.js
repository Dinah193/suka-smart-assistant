// src/services/events/eventNames.js
//
// Central registry for event names across the app.
// - Grouped by domain for readability & discoverability
// - Aliases + deprecations (with metadata)
// - Validation & "did-you-mean" suggestions
// - Helpers: normalize, parse, join, matches (with "**" catch-all parity to eventBus)
// - Lists: listByDomain, all(), flat map, toTitle
// - Canonical resolve(name) used by publishers/consumers
//
// Conventions:
//   • Namespaced with "/" (dot aliases auto-normalize to "/").
//   • Domain-first IA (recipes, mealplan, inventory, calendar, ui, garden, animals, butchery…)
//   • Use verb-noun for commands (requestSession) and past-tense for notifications (draftReady, synced).
//
// Dependency-free. Strictly runtime-safe.

const freeze = Object.freeze;

/* -------------------------------- Utilities -------------------------------- */

export function normalize(name) {
  return String(name || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/\./g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/|\/$/g, "");
}

// Very small Levenshtein (bounded)
function distance(a, b) {
  a = normalize(a); b = normalize(b);
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function freezeDeep(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.values(o).forEach(freezeDeep);
    Object.freeze(o);
  }
  return o;
}

function flatten(obj, prefix = "") {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}/${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && !v.__leaf) {
      Object.assign(out, flatten(v, path));
    } else {
      out[path] = v;
    }
  }
  return out;
}

/* ------------------------------ Match parity ------------------------------- */
/** Segment-wise pattern match supporting "*" per segment and final "**" catch-all. */
export function matches(pattern, event) {
  const p = normalize(pattern).split("/");
  const e = normalize(event).split("/");
  if (p[p.length - 1] === "**") {
    const head = p.slice(0, -1);
    if (head.length > e.length) return false;
    for (let i = 0; i < head.length; i++) {
      if (head[i] === "*") continue;
      if (head[i] !== e[i]) return false;
    }
    return true;
  }
  if (p.length !== e.length) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "*") continue;
    if (p[i] !== e[i]) return false;
  }
  return true;
}

/* ------------------------------- Domains ----------------------------------- */

export const Domains = freeze({
  RECIPES:     "recipes",
  MEALPLAN:    "mealplan",
  INGREDIENTS: "ingredients",
  GROCERY:     "grocery",
  INVENTORY:   "inventory",
  CALENDAR:    "calendar",
  PREFERENCES: "preferences",
  COOKING:     "cooking",
  CLEANING:    "cleaning",
  SESSION:     "session",
  GARDEN:      "garden",
  ANIMALS:     "animals",
  BUTCHERY:    "butchery",
  LABELS:      "labels",
  AUTOMATION:  "automation",
  TEMPLATES:   "templates",
  VISION:      "vision",
  NBA:         "nba",
  UI:          "ui",
  ADS:         "ads",
  PLANNER:     "planner",
  PREP:        "prep",
});

/* --------------------------------- Events ---------------------------------- */
/** Leaves are canonical strings. Keep keys camelCase; values namespaced with "/". */
export const Events = freezeDeep({
  recipes: {
    consolidated: "recipes/consolidated",
    scanned:      "recipes/scanned",
    imported:     "recipes/imported",
  },
  mealplan: {
    updated:        "mealplan/updated",
    rhythmChanged:  "mealplan/rhythmChanged",
    draft: {
      requested:    "mealplan/draft.requested",
      ready:        "mealplan/draft.ready",
    },
  },
  ingredients: {
    indexUpdated: "ingredients/indexUpdated",
  },
  grocery: {
    listReady:  "grocery/listReady",
    requested:  "grocerylist/requested",
    generated:  "grocerylist/generated",
    error:      "grocerylist/error",
  },
  inventory: {
    updated:          "inventory/updated",
    lowSignal:        "inventory/lowSignal",
    shortageDetected: "inventory/shortage.detected",
  },
  calendar: {
    synced: "calendar/synced",
    add:    "calendar/add",
    error:  "calendar/error",
  },
  preferences: {
    changed: "preferences/changed",
  },
  cooking: {
    requestSession:   "cooking/requestSession",
    draftReady:       "cooking/draftReady",
    batchQueueUpdated:"cooking/batchQueueUpdated",
  },
  cleaning: {
    tasksSaved:      "cleaning/tasksSaved",
    requestSession:  "cleaning/requestSession",
    draftReady:      "cleaning/draftReady",
  },
  session: {
    draftReady: "session/draftReady",
    approved:   "session/approved",
    discarded:  "session/discarded",
    error:      "session/error",
  },
  garden: {
    plantingReady: "garden/plantingReady",
    harvestLogged: "garden/harvestLogged",
    queueMerge:    "garden/queue_merge",
    taskComplete:  "garden/task_complete",
  },
  animals: {
    healthUpdated:   "animals/healthUpdated",
    harvestSelected: "animals/harvest.selected",
  },
  butchery: {
    draft: {
      requested: "butchery/draft.requested",
      ready:     "butchery/draft.ready",
      error:     "butchery/draft.error",
    },
    queue: {
      refresh:   "butchery/queue.refresh",
      ready:     "butchery/queue.ready",
      synced:    "butchery/queue.synced",
    },
  },
  labels: {
    print: {
      requested: "labels/print.requested",
      completed: "labels/print.completed",
      error:     "labels/print.error",
    },
  },
  automation: {
    ready: "automation/ready",
    error: "automation/error",
    meal: {
      planGenerated: "meal/planGenerated",
    },
  },
  templates: {
    registered: "templates/registered",
    ran:        "templates/ran",
  },
  planner: {
    conflictDetected: "planner/conflict.detected", // {kind: "time|appliance|weather|biohazard", note}
  },
  prep: {
    tasksRequested: "prep/tasks.requested",
  },
  nba: {
    updated: "nba/updated",
  },
  ui: {
    toast:              "ui/toast",          // {variant,title,message}
    empty:              "ui/empty",          // {context, actions:[{label,event,payload}]}
    progress:           "ui/progress",       // {context, step, total, label?}
    undoOffered:        "ui/undoOffered",    // {label, ttlMs}
    undoTriggered:      "ui/undoTriggered",  // {reason}
    nbaSuggested:       "ui/nbaSuggested",   // {label, route?, params?, hint?}
    modalOpen:          "ui/modalOpen",
    modalClose:         "ui/modalClose",
    audioCue:           "ui/audioCue",
    rightSidebarRefresh:"ui/rightSidebarRefresh",
  },
  ads: {
    refresh: "ads/refresh",
  },
});

/* ---------------------------- Flat & Canonical ------------------------------ */

export const FlatEvents = freeze(
  Object.fromEntries(
    Object.entries(flatten(Events)).map(([k, v]) => [normalize(k), normalize(v)])
  )
);

// Aliases & deprecations → canonical target
// Keep left-hand side as *normalized* strings.
export const Aliases = freeze({
  // dotted variants
  "recipes.consolidated":        "recipes/consolidated",
  "mealplan.rhythmChanged":      "mealplan/rhythmChanged",
  "inventory.lowSignal":         "inventory/lowSignal",

  // historic or alt spellings
  "garden/queue.merge":          "garden/queue_merge",
  "butchery/queueRefresh":       "butchery/queue.refresh",
  "butchery/draftReady":         "butchery/draft.ready",
  "labels/print.complete":       "labels/print.completed",

  // generic “mealplan generated” (older)
  "mealplan/planGenerated":      "meal/planGenerated",
});

/** Deprecations with metadata, helpful for UX copy & lint rules. */
export const Deprecations = freeze({
  "grocery/requested": {
    replaceWith: "grocerylist/requested",
    since: "2025-06",
    note: "Converge on grocerylist/* namespace for clarity.",
  },
});

/* --------------------------------- API ------------------------------------- */

export function resolve(name) {
  const n = normalize(name);
  if (FlatEvents[n]) return FlatEvents[n];
  if (Aliases[n]) return Aliases[n];
  return n; // allow forward-compat custom events; validator will warn if needed
}

export function isKnownEvent(name) {
  const n = normalize(name);
  return !!(FlatEvents[n] || Aliases[n]);
}

export function isDeprecated(name) {
  const n = normalize(name);
  return !!Deprecations[n];
}

/** Assert event exists (or alias), with optional console warning + suggestion. */
export function assertKnownEvent(name, { warn = true } = {}) {
  const n = normalize(name);
  if (isKnownEvent(n)) return true;
  if (!warn) return false;
  const suggestion = suggestSimilar(n);
  const msg = `[eventNames] Unknown event "${n}"${suggestion ? ` — did you mean "${suggestion}"?` : ""}`;
  try { console.warn(msg); } catch {}
  return false;
}

export function suggestSimilar(name) {
  const n = normalize(name);
  let best = null;
  let bestDist = Infinity;
  const keys = Object.keys(FlatEvents);
  for (const k of keys) {
    const d = distance(n, k);
    if (d < bestDist) { bestDist = d; best = k; }
  }
  return bestDist <= 5 ? best : null;
}

export function listByDomain(domain) {
  const d = normalize(domain);
  const out = [];
  for (const k of Object.keys(FlatEvents)) {
    if (k.startsWith(`${d}/`)) out.push(FlatEvents[k]);
  }
  return out;
}

/** Safe builder: make("garden","harvestLogged") → "garden/harvestLogged" (or canonical if in tree). */
export function make(domain, key) {
  const d = normalize(domain), k = normalize(key);
  const maybe = FlatEvents[`${d}/${k}`];
  return maybe || `${d}/${k}`;
}

/** Return all canonical event values as an array. */
export function all() {
  return Object.values(FlatEvents);
}

/** Parse an event into {domain, parts, key}. */
export function parse(event) {
  const ev = normalize(event);
  const parts = ev.split("/");
  const domain = parts[0] || "";
  const key = parts.slice(1).join("/") || "";
  return { domain, parts, key };
}

/** Join parts into canonical string (normalizes dots, trims). */
export function join(...parts) {
  return normalize(parts.filter(Boolean).join("/"));
}

/** Human-friendly title for lists & DevTools (e.g., "Garden / Harvest Logged"). */
export function toTitle(event) {
  const { domain, key } = parse(resolve(event));
  const cap = (s) => s.replace(/(^|[\/._-])([a-z])/g, (_,sep,c)=> (sep ? " / " : "") + c.toUpperCase())
                      .replace(/([A-Z])/g, " $1")
                      .replace(/\s+/g, " ").trim();
  const d = domain.charAt(0).toUpperCase() + domain.slice(1);
  return key ? `${d} / ${cap(key.replace(/\./g, "/"))}` : d;
}

/* ------------------------------- Versioning -------------------------------- */

export const Catalog = freeze({
  version: 3,                      // bump on breaking renames
  updatedAt: "2025-10-25",
  domains: Object.values(Domains),
});

/* ------------------------------ Dev Doc Hook ------------------------------- */
/** Produces a lightweight catalog for a DevTools panel or docs page. */
export function toDocCatalog() {
  return Object.keys(Domains).map((k) => {
    const domain = Domains[k];
    const items = listByDomain(domain).map((ev) => ({
      event: ev,
      title: toTitle(ev),
      deprecated: Deprecations[normalize(ev)] || null,
    }));
    return { domain, items };
  });
}

/* ------------------------------- Quick Tests ------------------------------- */
try {
  if (process && process.env && process.env.NODE_ENV === "development") {
    // sanity: no duplicate values
    const vals = new Set();
    for (const v of Object.values(FlatEvents)) {
      if (vals.has(v)) console.warn("[eventNames] Duplicate event value:", v);
      vals.add(v);
    }
    // sample: ensure alias resolves into canonical
    Object.keys(Aliases).forEach(a => {
      const r = resolve(a);
      if (!isKnownEvent(r)) console.warn("[eventNames] Alias resolves to unknown:", a, "→", r);
    });
  }
} catch { /* noop */ }

export default Events;
