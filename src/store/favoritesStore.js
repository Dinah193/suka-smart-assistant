// src/store/favoritesStore.js
/**
 * Favorites Store
 * ----------------
 * This module holds the user's favorite sessions / plans across domains
 * (cooking, cleaning, garden, animals, preservation, storehouse).
 *
 * HOW IT FITS IN SSA:
 * - imports → intelligence → automation → (optional) hub export
 *
 *   • imports: other shims/engines emit events like "session.favorite.saved"
 *     when a session or template is marked as a favorite.
 *
 *   • intelligence: this store turns those events into a normalized list of
 *     favorites + a "lastSessionHint" snapshot that the UI can render
 *     (Favorites page, right sidebar, etc.).
 *
 *   • automation: favorites are used by SessionRunner + automationRuntime as
 *     templates for quick-start sessions ("Now" buttons, recurring schedules).
 *
 *   • hub export (optional): when familyFundMode is enabled, changes to
 *     favorites can be mirrored to the Suka Village Family Fund Hub so that
 *     household usage patterns are visible at the Hub level. SSA still owns
 *     the data and operates independently.
 */

import React from "react";
import eventBus from "@/services/events/eventBus";

/* -------------------------------------------------------------------------- */
/*  Optional Hub integration (soft requires, safe if missing)                  */
/* -------------------------------------------------------------------------- */

let featureFlags = { familyFundMode: false };
try {
  // Prefer a service wrapper if present
  // eslint-disable-next-line global-require
  const ff = require("@/config/featureFlags");
  featureFlags = ff.default || ff || featureFlags;
} catch {
  try {
    // Fallback to raw JSON config if that exists
    // eslint-disable-next-line global-require
    const ffJson = require("@/config/featureFlags.json");
    featureFlags = ffJson || featureFlags;
  } catch {
    // leave defaults
  }
}

let HubPacketFormatter = null;
try {
  // eslint-disable-next-line global-require
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
} catch {}

let FamilyFundConnector = null;
try {
  // eslint-disable-next-line global-require
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch {}

/**
 * Helper: export a favorites-related payload to the Hub when familyFundMode
 * is enabled. This is intentionally "best effort" and fails silently.
 *
 * @param {string} eventType - logical event name, e.g. "favorites.updated"
 * @param {object} payload   - data to send to the Hub
 */
function exportToHubIfEnabled(eventType, payload) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const packet =
      HubPacketFormatter.format?.(eventType, payload) ||
      HubPacketFormatter?.formatFavorites?.(payload);

    if (!packet) return;

    FamilyFundConnector.send?.(packet);
  } catch {
    // Hub is optional; never break the local app because of Hub issues
  }
}

/* -------------------------------------------------------------------------- */
/*  Storage + core store implementation                                       */
/* -------------------------------------------------------------------------- */

const STORAGE_KEY = "ssa.favorites.v1";

const DEFAULT_STATE = {
  favorites: [],
  // lastSessionHint is used by the Favorites page and other surfaces to show
  // what the runner is doing without having to query the runner directly.
  lastSessionHint: null, // { status, title, domain, sessionId? }
};

/**
 * Load persisted favorites from localStorage (if present).
 */
function loadInitialState() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...(parsed && typeof parsed === "object" ? parsed : {}),
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

/**
 * Persist state to localStorage in a defensive way.
 * @param {object} state
 */
function persistState(state) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore quota or privacy errors; store will still work in-memory
  }
}

// Internal mutable state + listeners for useSyncExternalStore
let internalState = loadInitialState();
const listeners = new Set();

/**
 * Core setState used by all store actions.
 * Accepts either a partial updater function or a full state object.
 */
function setState(updater, source = "favoritesStore") {
  const prev = internalState;
  const next =
    typeof updater === "function"
      ? updater(Object.freeze({ ...prev }))
      : updater;

  // Ensure required keys are present
  internalState = {
    ...DEFAULT_STATE,
    ...(next && typeof next === "object" ? next : {}),
  };

  persistState(internalState);

  // Notify subscribers
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Ignore subscriber errors
    }
  });

  // Optional: send a compact summary to the Hub when favorites change
  try {
    if (prev.favorites !== internalState.favorites) {
      exportToHubIfEnabled("favorites.updated", {
        source,
        favorites: internalState.favorites.map((fav) => ({
          id: fav.id,
          sessionId: fav.sessionId,
          domain: fav.domain,
          kind: fav.kind,
          tags: fav.tags,
          lastUsedAt: fav.lastUsedAt,
        })),
      });
    }
  } catch {
    // ignore
  }
}

/**
 * Simple public store object so non-React code (engines, shims) can interact
 * with favorites without going through React hooks.
 */
export const favoritesStore = {
  getState() {
    return internalState;
  },
  subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/* -------------------------------------------------------------------------- */
/*  Normalization helpers                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalize an incoming favorite payload into the internal favorite shape.
 *
 * Expected minimal fields (additional are allowed):
 * {
 *   id: string,                // stable ID for this favorite entry
 *   sessionId?: string,        // runnable session ID if known
 *   domain?: "cooking" | ...,
 *   title?: string,
 *   subtitle?: string,
 *   notes?: string,
 *   href?: string,             // deep-link back into SSA
 *   kind?: "session" | "template" | "plan" | "tool",
 *   tags?: string[],
 *   lastUsedAt?: string | Date,
 *   templateRef?: string | null,
 *   canGenerateSession?: boolean
 * }
 */
function normalizeFavorite(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = raw.id || raw.sessionId || raw.key;
  if (!id) return null;

  const domain = raw.domain || raw.area || null;

  let lastUsedAt = raw.lastUsedAt || raw.last_used_at || null;
  if (lastUsedAt instanceof Date) {
    lastUsedAt = lastUsedAt.toISOString();
  }

  return {
    id,
    sessionId: raw.sessionId || null,
    domain,
    title: raw.title || raw.name || "Favorite",
    subtitle: raw.subtitle || raw.description || null,
    notes: raw.notes || null,
    href: raw.href || raw.link || null,
    kind: raw.kind || "session",
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    lastUsedAt,
    templateRef: raw.templateRef || null,
    canGenerateSession: Boolean(raw.canGenerateSession),
  };
}

/**
 * Normalize event envelopes coming from eventBus or window CustomEvent.
 */
function normalizeEnvelope(evt) {
  if (!evt) return { type: "", data: {} };

  // CustomEvent from window.dispatchEvent
  if (evt.detail && !evt.data) {
    return evt.detail;
  }

  if (evt.type && evt.data) return evt;

  // Some emitters might send just a data object
  return {
    type: evt.type || "",
    ts: evt.ts || new Date().toISOString(),
    source: evt.source || "unknown",
    data: evt.data || evt,
  };
}

/* -------------------------------------------------------------------------- */
/*  Store actions                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Add or update a favorite.
 * @param {object} favRaw
 * @param {string} [source]
 */
function addOrUpdateFavorite(favRaw, source = "favoritesStore.event") {
  const fav = normalizeFavorite(favRaw);
  if (!fav) return;

  setState((prev) => {
    const existingIdx = prev.favorites.findIndex((f) => f.id === fav.id);
    let favorites;

    if (existingIdx >= 0) {
      favorites = [...prev.favorites];
      favorites[existingIdx] = { ...favorites[existingIdx], ...fav };
    } else {
      favorites = [...prev.favorites, fav];
    }

    return { ...prev, favorites };
  }, source);
}

/**
 * Remove a favorite by id.
 * @param {string} id
 * @param {string} [source]
 */
function removeFavorite(id, source = "favoritesStore.event") {
  if (!id) return;
  setState(
    (prev) => ({
      ...prev,
      favorites: prev.favorites.filter((f) => f.id !== id),
    }),
    source
  );
}

/**
 * Update lastSessionHint to reflect current runner status.
 * @param {object|null} hint
 * @param {string} [source]
 */
function updateLastSessionHint(hint, source = "favoritesStore.event") {
  if (!hint) {
    setState(
      (prev) => ({
        ...prev,
        lastSessionHint: null,
      }),
      source
    );
    return;
  }

  const cleanHint = {
    status: hint.status || "running",
    title: hint.title || hint.name || null,
    domain: hint.domain || null,
    sessionId: hint.sessionId || null,
  };

  setState(
    (prev) => ({
      ...prev,
      lastSessionHint: cleanHint,
    }),
    source
  );
}

/* -------------------------------------------------------------------------- */
/*  EventBus wiring                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Subscribes to key automation / runner events so that favorites stay in sync
 * no matter which surface triggered the change (UI, import router, engines).
 *
 * We intentionally wrap this in a try/catch so that if eventBus is missing or
 * has a different API, SSA still boots and the Favorites UI just uses the
 * in-memory state.
 */
try {
  if (eventBus?.on) {
    // When a session or schedule is marked favorite
    eventBus.on("session.favorite.saved", (evt) => {
      const env = normalizeEnvelope(evt);
      addOrUpdateFavorite(env.data, "event:session.favorite.saved");
    });
    eventBus.on("schedule.favorite.saved", (evt) => {
      const env = normalizeEnvelope(evt);
      addOrUpdateFavorite(env.data, "event:schedule.favorite.saved");
    });

    // When a favorite is removed
    eventBus.on("favorite.removed", (evt) => {
      const env = normalizeEnvelope(evt);
      const id =
        env.data?.id || env.data?.sessionId || env.data?.favoriteId || null;
      if (!id) return;
      removeFavorite(id, "event:favorite.removed");
    });

    // When the SessionRunner changes state, update the hint
    eventBus.on("session.state.changed", (evt) => {
      const env = normalizeEnvelope(evt);
      updateLastSessionHint(env.data?.hint || env.data, "event:session.state");
    });
  }
} catch {
  // No-op; this store will still function manually
}

/* -------------------------------------------------------------------------- */
/*  React hook: useFavoritesStore                                             */
/* -------------------------------------------------------------------------- */

/**
 * React hook wrapper around the favoritesStore.
 *
 * Usage:
 *   const { favorites, lastSessionHint } = useFavoritesStore();
 *   // or with selector:
 *   const favorites = useFavoritesStore(s => s.favorites);
 *
 * We use useSyncExternalStore so that state updates are concurrent-safe and
 * work correctly with React 18.
 */
export function useFavoritesStore(selector = (s) => s) {
  const subscribe = React.useCallback(favoritesStore.subscribe, []);
  const getSnapshot = React.useCallback(
    () => selector(favoritesStore.getState()),
    [selector]
  );
  const getServerSnapshot = React.useCallback(
    () => selector(DEFAULT_STATE),
    [selector]
  );

  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/* -------------------------------------------------------------------------- */
/*  Named exports for engines / shims                                        */
/* -------------------------------------------------------------------------- */

export const favoritesActions = {
  addOrUpdateFavorite,
  removeFavorite,
  updateLastSessionHint,
};
