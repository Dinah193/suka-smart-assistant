// C:\Users\larho\suka-smart-assistant\src\data\SessionsRepo.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant (SSA) – Sessions Repository
// -----------------------------------------------------------------------------
// Purpose:
//   Central persistence + query layer for Session objects used by SessionRunner,
//   agents, and orchestrator.
//
//   - Stores sessions in Dexie (db.sessions) with in-memory fallback.
//   - Handles checkpoint + status updates (pending → running → paused/completed).
//   - Supports domain-aware queries (cooking, cleaning, garden, animals,
//     preservation, storehouse).
//   - Supports favorites & origin (system | user | reverse) for reverse
//     generation and user-curated templates.
//   - Provides helper queries for "next runnable session" lists that feed
//     your skills/orchestrator + swap modal.
//
// NOTE:
//   This module does NOT emit runtime events like session.started/session.completed;
//   those come from SessionRunner. It is storage + query only.
// -----------------------------------------------------------------------------

"use strict";

/**
 * @typedef {import("@/types/agent.contracts").AgentDomain} AgentDomain
 * @typedef {import("@/types/agent.contracts").OriginKind} OriginKind
 * @typedef {import("@/types/agent.contracts").SessionObject} SessionObject
 */

let db = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const dbModule = require("@/services/db");
  db = dbModule.db || dbModule.default || dbModule;
} catch (err) {
  // Dexie is optional; we will gracefully fall back to memory.
  // console.warn("[SessionsRepo] Dexie db not available, using in-memory store only.", err);
}

/**
 * In-memory fallback when Dexie or sessions table is not available.
 * Map<string, SessionObject>
 */
const memorySessions = new Map();

/**
 * Generate a pseudo-random ID (fallback when no ID is provided).
 * This is NOT cryptographically secure – it's just for local/session usage.
 * @returns {string}
 */
function generateId() {
  return `sess_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

/**
 * Ensure we have a valid domain.
 * @param {string} domain
 * @returns {AgentDomain|"unknown"}
 */
function normalizeDomain(domain) {
  if (!domain || typeof domain !== "string") return "unknown";
  const v = domain.toLowerCase();
  const allowed = [
    "cooking",
    "cleaning",
    "garden",
    "animals",
    "preservation",
    "storehouse"
  ];
  if (allowed.includes(v)) {
    return /** @type {AgentDomain} */ (v);
  }
  return "unknown";
}

/**
 * Normalize a raw session object to the minimum viable contract.
 * Adds missing fields, sets createdAt/updatedAt.
 *
 * Domain-specific context hints:
 *  - cleaning:  context.cleaning = { zones, frequency }
 *  - garden:    context.garden = { mode: "planning|care|harvest", beds, crops }
 *  - storehouse:context.storehouse = { sections: ["produce","meat+freezer",...], shortages: [...] }
 *  - meals:     context.meals = { mealWindow, batchSizeMeals, recipeIds }
 *  - animals:   context.animals = { species, stage: "acquisition|care|butchery" }
 *
 * These are not enforced but encouraged for consistent behavior.
 *
 * @param {Partial<SessionObject>} raw
 * @returns {SessionObject}
 */
function normalizeSession(raw) {
  const nowIso = new Date().toISOString();
  const id = raw.id || generateId();
  const domain = normalizeDomain(raw.domain || "cooking");

  /** @type {SessionObject} */
  const normalized = {
    id,
    domain: domain === "unknown" ? "cooking" : domain,
    title: raw.title || "Untitled Session",
    source: raw.source || { type: "manual", refId: null },
    steps: Array.isArray(raw.steps) ? raw.steps.map(normalizeStep) : [],
    prefs: {
      voiceGuidance: raw.prefs?.voiceGuidance ?? true,
      haptic: raw.prefs?.haptic ?? true,
      autoAdvance: raw.prefs?.autoAdvance ?? false
    },
    status: raw.status || "pending",
    progress: {
      currentStepIndex: raw.progress?.currentStepIndex ?? 0,
      elapsedSec: raw.progress?.elapsedSec ?? 0,
      startedAt: raw.progress?.startedAt ?? null,
      pausedAt: raw.progress?.pausedAt ?? null
    },
    analytics: {
      skippedSteps: raw.analytics?.skippedSteps || [],
      adjustments: raw.analytics?.adjustments || []
    },
    createdAt: raw.createdAt || nowIso,
    updatedAt: nowIso,
    tags: raw.tags || [],
    origin: raw.origin || "system",
    isTemplate: raw.isTemplate ?? false,
    isFavorite: raw.isFavorite ?? false,
    favoriteOwnerId: raw.favoriteOwnerId ?? null,
    context: raw.context || {}
  };

  return normalized;
}

/**
 * Normalize a single step to include metadata object.
 * @param {any} step
 * @returns {import("@/types/agent.contracts").SessionStep}
 */
function normalizeStep(step) {
  const metadata = step && typeof step === "object" ? step.metadata : {};
  return {
    id: step?.id || generateId(),
    title: step?.title || "Step",
    desc: step?.desc || "",
    durationSec: Number.isFinite(step?.durationSec) ? step.durationSec : 0,
    blockers: Array.isArray(step?.blockers) ? step.blockers : [],
    metadata: {
      tempTargetF: typeof metadata?.tempTargetF === "number" ? metadata.tempTargetF : null,
      donenessCue: metadata?.donenessCue || "timer",
      cueNotes: metadata?.cueNotes || null,
      storehouseSection: metadata?.storehouseSection,
      inventoryItemIds: Array.isArray(metadata?.inventoryItemIds)
        ? metadata.inventoryItemIds
        : [],
      ...metadata
    }
  };
}

/**
 * Get access to Dexie sessions table if available.
 * @returns {import("dexie").Table<SessionObject, string>|null}
 */
function getSessionsTable() {
  if (!db || !db.sessions) return null;
  return db.sessions;
}

/**
 * Fetch a session by ID from Dexie or memory.
 * @param {string} id
 * @returns {Promise<SessionObject|null>}
 */
async function getSessionById(id) {
  if (!id) return null;

  const table = getSessionsTable();
  if (table) {
    try {
      const session = await table.get(id);
      return session || null;
    } catch (err) {
      // fall through to memory
    }
  }

  const mem = memorySessions.get(id);
  return mem || null;
}

/**
 * Insert or update a session.
 * This always normalizes the object and updates updatedAt.
 *
 * @param {Partial<SessionObject>} raw
 * @returns {Promise<SessionObject>}
 */
async function upsertSession(raw) {
  const normalized = normalizeSession(raw);
  const table = getSessionsTable();

  if (table) {
    try {
      await table.put(normalized);
    } catch (err) {
      // Dexie write failure -> still keep in memory
      // console.error("[SessionsRepo] Failed to write to Dexie, using memory only.", err);
    }
  }

  memorySessions.set(normalized.id, normalized);
  return normalized;
}

/**
 * Save a checkpoint for a session:
 *  - updates progress + analytics
 *  - updates status (if provided)
 *  - sets updatedAt
 *
 * This is intended to be called on:
 *  - every step transition
 *  - every ~10 seconds while running
 *  - on pause/resume
 *
 * @param {string} sessionId
 * @param {Partial<Pick<SessionObject, "status" | "progress" | "analytics">>} patch
 * @returns {Promise<SessionObject|null>}
 */
async function saveCheckpoint(sessionId, patch) {
  if (!sessionId) return null;
  const existing = await getSessionById(sessionId);
  if (!existing) return null;

  const nowIso = new Date().toISOString();
  const updated = {
    ...existing,
    status: patch.status || existing.status,
    progress: {
      ...existing.progress,
      ...(patch.progress || {})
    },
    analytics: {
      ...existing.analytics,
      ...(patch.analytics || {})
    },
    updatedAt: nowIso
  };

  return upsertSession(updated);
}

/**
 * Update only the status (and optional analyticsPatch) of a session.
 * Used when session transitions to running/paused/completed/aborted.
 *
 * @param {string} sessionId
 * @param {"pending"|"running"|"paused"|"completed"|"aborted"} status
 * @param {Partial<SessionObject["analytics"]>} [analyticsPatch]
 * @returns {Promise<SessionObject|null>}
 */
async function updateSessionStatus(sessionId, status, analyticsPatch) {
  const existing = await getSessionById(sessionId);
  if (!existing) return null;

  /** @type {Partial<SessionObject>} */
  const patch = { status };

  if (analyticsPatch && typeof analyticsPatch === "object") {
    patch.analytics = {
      ...existing.analytics,
      ...analyticsPatch
    };
  }

  if (status === "running" && !existing.progress.startedAt) {
    patch.progress = {
      ...existing.progress,
      startedAt: new Date().toISOString()
    };
  }

  if (status === "paused") {
    patch.progress = {
      ...existing.progress,
      pausedAt: new Date().toISOString()
    };
  }

  if (status === "completed" || status === "aborted") {
    patch.progress = {
      ...existing.progress,
      pausedAt: null
    };
  }

  return saveCheckpoint(sessionId, patch);
}

/**
 * Mark or unmark a session as favorite for a given user.
 *
 * NOTE:
 *  - isFavorite is stored per session with favoriteOwnerId.
 *  - Many households may prefer 1:1 mapping, but you can extend this to
 *    multi-user favorites in future (e.g., favoriteOwnerId as array).
 *
 * @param {string} sessionId
 * @param {string} userId
 * @param {boolean} isFavorite
 * @returns {Promise<SessionObject|null>}
 */
async function setSessionFavorite(sessionId, userId, isFavorite) {
  const existing = await getSessionById(sessionId);
  if (!existing) return null;

  const updated = {
    ...existing,
    isFavorite,
    favoriteOwnerId: isFavorite ? userId : null,
    updatedAt: new Date().toISOString()
  };

  return upsertSession(updated);
}

/**
 * Get all sessions for a given domain (and optional user filters).
 *
 * Filters:
 *  - status: e.g. "pending", "running", "completed"
 *  - favoritesOnly: true → only return user favorites
 *  - origin: system | user | reverse (array allowed)
 *
 * @param {AgentDomain} domain
 * @param {object} [opts]
 * @param {string} [opts.userId]
 * @param {("pending"|"running"|"paused"|"completed"|"aborted")[]} [opts.status]
 * @param {boolean} [opts.favoritesOnly]
 * @param {OriginKind[]} [opts.origins]
 * @returns {Promise<SessionObject[]>}
 */
async function listSessionsByDomain(domain, opts = {}) {
  const table = getSessionsTable();
  const filtersStatus = opts.status || null;
  const filtersOrigins = opts.origins || null;
  const favoritesOnly = !!opts.favoritesOnly;
  const userId = opts.userId || null;

  /** @type {SessionObject[]} */
  let all = [];

  if (table) {
    try {
      // If you create an index on "domain" in Dexie, you can replace toArray
      // with where("domain").equals(domain).toArray() for performance.
      const raw = await table.toArray();
      all = raw.filter((s) => s.domain === domain);
    } catch (err) {
      // fall back to memory
    }
  }

  if (!table) {
    // memory-only store: just pick ones with matching domain
    all = Array.from(memorySessions.values()).filter((s) => s.domain === domain);
  }

  return all.filter((s) => {
    if (filtersStatus && filtersStatus.length > 0 && !filtersStatus.includes(s.status)) {
      return false;
    }

    if (favoritesOnly) {
      if (!s.isFavorite) return false;
      if (userId && s.favoriteOwnerId !== userId) return false;
    }

    if (filtersOrigins && filtersOrigins.length > 0 && (!s.origin || !filtersOrigins.includes(s.origin))) {
      return false;
    }

    return true;
  });
}

/**
 * Return the first session with status === "running", if any.
 * Useful for auto-resume on load.
 *
 * If you want per-user, add a userId field to your SessionObject and filter.
 *
 * @returns {Promise<SessionObject|null>}
 */
async function getRunningSession() {
  const table = getSessionsTable();
  if (table) {
    try {
      const raw = await table
        .where("status") // requires Dexie index on "status"
        .equals("running")
        .toArray();

      if (Array.isArray(raw) && raw.length > 0) {
        return raw[0];
      }
    } catch (err) {
      // fall through
    }
  }

  const mem = Array.from(memorySessions.values()).find((s) => s.status === "running");
  return mem || null;
}

/**
 * Convenience query: find candidate sessions for Next/Now button for a domain.
 *
 * This is deliberately simple; the orchestrator / skills layer can apply
 * additional ranking, guards, and swap-modal logic on top.
 *
 * Strategy:
 *  - prefer favorites (user's favorites first)
 *  - fallback to templates (isTemplate) sorted by createdAt (newest first)
 *  - fallback to all pending sessions in createdAt desc order
 *
 * @param {AgentDomain} domain
 * @param {string} [userId]
 * @returns {Promise<SessionObject[]>}
 */
async function findCandidateSessionsForDomain(domain, userId) {
  const all = await listSessionsByDomain(domain, { userId });

  /** @type {SessionObject[]} */
  const favorites = [];
  /** @type {SessionObject[]} */
  const templates = [];
  /** @type {SessionObject[]} */
  const pending = [];

  for (const s of all) {
    if (s.isFavorite && (!userId || s.favoriteOwnerId === userId)) {
      favorites.push(s);
    } else if (s.isTemplate) {
      templates.push(s);
    } else if (s.status === "pending") {
      pending.push(s);
    }
  }

  const sortByCreatedAtDesc = (a, b) =>
    (b.createdAt || "").localeCompare(a.createdAt || "");

  favorites.sort(sortByCreatedAtDesc);
  templates.sort(sortByCreatedAtDesc);
  pending.sort(sortByCreatedAtDesc);

  return [...favorites, ...templates, ...pending];
}

/**
 * Domain-aware convenience to seed a new session skeleton with context hints.
 *
 * This does NOT persist the session; it just builds a normalized object
 * that callers can tweak and then pass to upsertSession().
 *
 * @param {AgentDomain} domain
 * @param {Partial<SessionObject>} [seed]
 * @returns {SessionObject}
 */
function createSessionSkeleton(domain, seed = {}) {
  /** @type {Partial<SessionObject>} */
  const base = {
    domain,
    title: seed.title || getDefaultTitleForDomain(domain),
    source: seed.source || { type: "manual", refId: null },
    steps: seed.steps || [],
    prefs: seed.prefs || { voiceGuidance: true, haptic: true, autoAdvance: false },
    status: seed.status || "pending",
    tags: seed.tags || getDefaultTagsForDomain(domain),
    origin: seed.origin || "user",
    isTemplate: seed.isTemplate ?? true,
    isFavorite: seed.isFavorite ?? false,
    favoriteOwnerId: seed.favoriteOwnerId ?? null,
    context: {
      ...(seed.context || {}),
      ...getDomainDefaultContext(domain)
    }
  };

  return normalizeSession(base);
}

/**
 * Default session title per domain.
 * @param {AgentDomain} domain
 * @returns {string}
 */
function getDefaultTitleForDomain(domain) {
  switch (domain) {
    case "cleaning":
      return "New Cleaning Session";
    case "garden":
      return "New Garden Session";
    case "animals":
      return "New Animal Care Session";
    case "preservation":
      return "New Preservation Session";
    case "storehouse":
      return "New Storehouse Stock Session";
    case "cooking":
    default:
      return "New Cooking Session";
  }
}

/**
 * Default tags per domain, inspired by well-executed apps/sites.
 * @param {AgentDomain} domain
 * @returns {string[]}
 */
function getDefaultTagsForDomain(domain) {
  switch (domain) {
    case "cleaning":
      return ["reset", "home", "cleaning"];
    case "garden":
      return ["garden", "planning", "care"];
    case "animals":
      return ["animals", "care"];
    case "preservation":
      return ["preservation", "storehouse"];
    case "storehouse":
      return ["storehouse", "stock-up", "grocery-sections"];
    case "cooking":
    default:
      return ["cooking", "meal-planning"];
  }
}

/**
 * Suggest a domain-tailored context skeleton.
 * These keys are meant to be used by agents + UI to surface intuitive controls.
 *
 * @param {AgentDomain} domain
 * @returns {Record<string, any>}
 */
function getDomainDefaultContext(domain) {
  switch (domain) {
    case "cleaning":
      return {
        cleaning: {
          zones: [], // e.g. ["kitchen", "bathroom"]
          frequency: "daily" // "daily" | "weekly" | "monthly"
        }
      };

    case "garden":
      return {
        garden: {
          mode: "planning", // "planning" | "care" | "harvest"
          beds: [], // bed IDs or labels
          crops: [] // crop IDs or names
        }
      };

    case "storehouse":
      return {
        storehouse: {
          sections: [
            "produce",
            "meat+freezer",
            "dairy",
            "pantry+baking",
            "frozen",
            "household+cleaning",
            "personalCare"
          ],
          shortages: [] // items we want to restock
        }
      };

    case "animals":
      return {
        animals: {
          species: [], // e.g. ["goats", "sheep", "chickens"]
          stage: "care" // "acquisition" | "care" | "butchery"
        }
      };

    case "preservation":
      return {
        preservation: {
          methods: [], // e.g. ["canning", "dehydrating", "freezing"]
          sourceDomain: null // "cooking" | "garden" | "animals" | "storehouse"
        }
      };

    case "cooking":
    default:
      return {
        meals: {
          mealWindow: "dinner", // "breakfast" | "lunch" | "dinner" | "snacks"
          batchSizeMeals: 1,
          recipeIds: []
        }
      };
  }
}

/**
 * Remove a session entirely (use with care).
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
async function deleteSession(sessionId) {
  if (!sessionId) return;

  const table = getSessionsTable();
  if (table) {
    try {
      await table.delete(sessionId);
    } catch (err) {
      // ignore Dexie errors and still clear memory
    }
  }

  memorySessions.delete(sessionId);
}

module.exports = {
  getSessionById,
  upsertSession,
  saveCheckpoint,
  updateSessionStatus,
  setSessionFavorite,
  listSessionsByDomain,
  getRunningSession,
  findCandidateSessionsForDomain,
  createSessionSkeleton,
  deleteSession
};
