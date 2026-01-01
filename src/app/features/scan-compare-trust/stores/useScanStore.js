/* eslint-disable no-console */
// src/app/features/scan-compare-trust/stores/useScanStore.js

import { create } from "zustand";
import { devtools, subscribeWithSelector, persist } from "zustand/middleware";

/* -------------------------------------------------------------------------- */
/* tiny utils                                                                 */
/* -------------------------------------------------------------------------- */
const isBrowser = typeof window !== "undefined";
const now = () => Date.now();
const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

const fire = (type, detail = {}) => {
  // Canonical DOM custom event
  if (isBrowser) window.dispatchEvent(new CustomEvent(type, { detail }));
  // Optional runtime bus
  try {
    const bus = window.__suka?.eventBus;
    if (bus?.emit) bus.emit(type, detail);
  } catch {
    /* noop */
  }
};

const safeJSON = {
  parse: (s, fb = null) => {
    try {
      return JSON.parse(s);
    } catch {
      return fb;
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

/* -------------------------------------------------------------------------- */
/* Optional Dexie (IndexedDB) hookup                                          */
/* -------------------------------------------------------------------------- */
let db = null;
(async () => {
  try {
    // Prefer project-wide db if present
    if (isBrowser && window.__suka?.db) {
      db = window.__suka.db;
    } else {
      // Lazy import local Dexie wrapper if you have one (defensive)
      // Adjust path if your Dexie wrapper lives elsewhere.
      const mod = await import("../../../db").catch(() => null);
      db = mod?.default || null;
    }

    // Ensure tables exist (defensive “soft migrate”)
    if (db?.version) {
      // No-op if schema already defined in your central Dexie file.
      // This block is safe even if tables already exist.
      try {
        db.version(1).stores?.({
          scans: "++id, sessionId, ts, upc, label, tags",
          scanSessions: "++id, startedAt, endedAt, title, origin, tags",
          favorites: "++id, kind, name, payload, createdAt, tags",
          schedules: "++id, name, rrule, payload, createdAt",
        });
      } catch {
        // ignore if schema already set
      }
    }
  } catch {
    db = null;
  }
})();

/* -------------------------------------------------------------------------- */
/* Event Catalog (aliases to your central events.catalog.js)                  */
/* If you already export constants, feel free to import and replace strings.  */
/* -------------------------------------------------------------------------- */
const EVT = {
  SCAN_STARTED: "scan.started",
  SCAN_ITEM_ADDED: "scan.item.added",
  SCAN_COMPLETED: "scan.completed",
  SCAN_REMOVED: "scan.removed",

  PRODUCT_RESOLVE_REQUESTED: "product.resolve.requested",
  PRODUCT_RESOLVED: "product.resolved",

  PRICING_REQUESTED: "pricing.requested",
  PRICING_RESOLVED: "pricing.resolved",

  COUPONS_REQUESTED: "coupons.requested",
  COUPONS_RESOLVED: "coupons.resolved",

  SAFETY_CHECK_REQUESTED: "safety.check.requested",
  SAFETY_CHECK_RESOLVED: "safety.check.resolved",

  // Domain bridges
  MEALPLAN_DRAFT_REQUESTED: "mealplan.draft.requested",
  GARDEN_PLAN_REQUESTED: "garden.plan.requested",
  ANIMAL_PLAN_REQUESTED: "animal.plan.requested",

  // Automation runtime hooks
  SCHEDULE_SAVED: "automation.schedule.saved",
};

/* -------------------------------------------------------------------------- */
/* Shape helpers                                                              */
/* -------------------------------------------------------------------------- */
const mkSession = (over = {}) => ({
  id: genId(),
  title: over.title || "New Scan Session",
  origin: over.origin || "scanner", // scanner | image | upload | ocr
  intent: over.intent || "compare", // compare | trust | pantry | planning
  startedAt: now(),
  endedAt: null,
  tags: over.tags || [],
  meta: over.meta || {},
  stats: { items: 0 },
});

const mkScanItem = (over = {}) => ({
  id: genId(),
  sessionId: over.sessionId,
  ts: now(),
  // raw capture
  upc: over.upc || null,
  label: over.label || null, // e.g., from OCR or manual entry
  // resolved/derived
  product: over.product || null, // { id, name, brand, size, category, ... }
  pricing: over.pricing || null, // { storePrices[], bestStore, unitPrice, ... }
  coupons: over.coupons || null, // { stackables[], bestCombo, savings }
  safety: over.safety || null, // { recalls[], flags[], harmfulIngredients[] }
  sourceAttribution: over.sourceAttribution || [], // [{provider, weight, dataRef}]
  // cross-domain hints
  intents: over.intents || {
    planMeals: false,
    restock: false,
    gardenSeed: false,
  },
  tags: over.tags || [],
  notes: over.notes || "",
});

/* -------------------------------------------------------------------------- */
/* Persistence bridges                                                        */
/* -------------------------------------------------------------------------- */
const persistToDexie = async (table, payload) => {
  try {
    if (!db?.[table]) return null;
    return await db[table].add(payload);
  } catch (e) {
    console.warn("[useScanStore] Dexie persist failed:", table, e);
    return null;
  }
};

const updateDexie = async (table, key, changes) => {
  try {
    if (!db?.[table]) return null;
    return await db[table].update(key, changes);
  } catch (e) {
    console.warn("[useScanStore] Dexie update failed:", table, e);
    return null;
  }
};

const removeDexie = async (table, key) => {
  try {
    if (!db?.[table]) return null;
    return await db[table].delete(key);
  } catch (e) {
    console.warn("[useScanStore] Dexie delete failed:", table, e);
    return null;
  }
};

/* -------------------------------------------------------------------------- */
/* Zustand Store                                                              */
/* -------------------------------------------------------------------------- */
export const useScanStore = create(
  devtools(
    subscribeWithSelector(
      persist(
        (set, get) => ({
          /* --------------------------------- state -------------------------------- */
          activeSessionId: null,
          sessions: {}, // id -> session
          // In-memory cache keyed by session. History can be pruned/archived to Dexie.
          itemsBySession: {}, // sessionId -> [scanItem]
          // user prefs affecting “Trust”
          prefs: {
            harmfulIngredients: [
              "BHT",
              "BHA",
              "Azodicarbonamide",
              "Potassium Bromate",
              "MSG",
            ],
            recallWatchEnabled: true,
            preferredStores: [], // used for pricing/coupons
          },
          // quick lookup cache to dedupe scans during a live session
          recentUPCSeen: {}, // upc -> ts
          // user-owned favorites (sessions & schedules)
          favorites: {
            sessions: {}, // id -> { id, name, sessionSnapshot, tags, createdAt }
            schedules: {}, // id -> { id, name, rrule, payload, createdAt, tags }
          },
          // simple undo stack (recent destructive actions)
          _undo: [],
          _redo: [],

          /* ------------------------------- selectors ------------------------------- */
          getActiveSession() {
            const id = get().activeSessionId;
            return id ? get().sessions[id] || null : null;
          },
          getItems(sessionId) {
            const sid = sessionId || get().activeSessionId;
            return (sid && get().itemsBySession[sid]) || [];
          },

          /* -------------------------------- actions -------------------------------- */
          startSession(over = {}) {
            const session = mkSession(over);
            set((s) => ({
              activeSessionId: session.id,
              sessions: { ...s.sessions, [session.id]: session },
              itemsBySession: { ...s.itemsBySession, [session.id]: [] },
            }));
            persistToDexie?.("scanSessions", session);
            fire(EVT.SCAN_STARTED, { session });
            return session.id;
          },

          endSession(sessionId, options = {}) {
            const sid = sessionId || get().activeSessionId;
            if (!sid) return;

            const items = get().itemsBySession[sid] || [];
            set((s) => {
              const session = s.sessions[sid];
              if (!session) return {};
              const next = {
                ...s.sessions,
                [sid]: {
                  ...session,
                  endedAt: now(),
                  stats: { items: items.length },
                  meta: { ...session.meta, ...options.meta },
                },
              };
              return { sessions: next };
            });

            // Update Dexie
            updateDexie?.("scanSessions", sid, {
              endedAt: now(),
              stats: { items: items.length },
            });

            fire(EVT.SCAN_COMPLETED, {
              sessionId: sid,
              items,
              options,
            });
          },

          setActiveSession(sessionId) {
            set({ activeSessionId: sessionId || null });
          },

          /* Add a raw capture first, then request downstream enrichments */
          addRawCapture(payload = {}) {
            const sid = payload.sessionId || get().activeSessionId || get().startSession();
            const upc = payload.upc || null;

            // de-dupe within 2 seconds
            const seen = get().recentUPCSeen[upc];
            if (upc && seen && now() - seen < 2000) {
              return null;
            }

            const item = mkScanItem({ ...payload, sessionId: sid });
            set((s) => {
              const arr = s.itemsBySession[sid] || [];
              return {
                itemsBySession: { ...s.itemsBySession, [sid]: [...arr, item] },
                recentUPCSeen: upc
                  ? { ...s.recentUPCSeen, [upc]: now() }
                  : s.recentUPCSeen,
              };
            });

            // Persist item (raw); updates will patch via updateItem
            persistToDexie?.("scans", item);

            fire(EVT.SCAN_ITEM_ADDED, { sessionId: sid, item });

            // downstream orchestrations
            fire(EVT.PRODUCT_RESOLVE_REQUESTED, { sessionId: sid, item });
            if ((get().prefs.preferredStores || []).length) {
              fire(EVT.PRICING_REQUESTED, {
                sessionId: sid,
                item,
                stores: get().prefs.preferredStores,
              });
              fire(EVT.COUPONS_REQUESTED, {
                sessionId: sid,
                item,
                stores: get().prefs.preferredStores,
              });
            }
            if (get().prefs.recallWatchEnabled || (get().prefs.harmfulIngredients || []).length) {
              fire(EVT.SAFETY_CHECK_REQUESTED, {
                sessionId: sid,
                item,
                prefs: get().prefs,
              });
            }

            return item.id;
          },

          /* Patch a scan item with resolved data (product/pricing/coupons/safety) */
          updateItem(sessionId, itemId, patch = {}) {
            const sid = sessionId || get().activeSessionId;
            if (!sid) return;
            set((s) => {
              const arr = s.itemsBySession[sid] || [];
              const idx = arr.findIndex((x) => x.id === itemId);
              if (idx === -1) return {};
              const next = { ...arr[idx], ...patch };
              const updated = arr.slice();
              updated[idx] = next;
              return { itemsBySession: { ...s.itemsBySession, [sid]: updated } };
            });
            // persist patch (best-effort)
            updateDexie?.("scans", itemId, patch);
          },

          removeItem(sessionId, itemId) {
            const sid = sessionId || get().activeSessionId;
            if (!sid) return;
            const prev = get().itemsBySession[sid] || [];
            const idx = prev.findIndex((x) => x.id === itemId);
            if (idx === -1) return;
            const removed = prev[idx];

            set((s) => {
              const copy = prev.slice();
              copy.splice(idx, 1);
              // push undo record
              const undo = [
                ...s._undo,
                { kind: "removeItem", payload: { sessionId: sid, item: removed } },
              ].slice(-50);
              return {
                itemsBySession: { ...s.itemsBySession, [sid]: copy },
                _undo: undo,
                _redo: [],
              };
            });

            removeDexie?.("scans", itemId);
            fire(EVT.SCAN_REMOVED, { sessionId: sid, itemId });
          },

          undo() {
            const stack = get()._undo;
            if (!stack.length) return;
            const last = stack[stack.length - 1];
            if (last.kind === "removeItem") {
              const { sessionId, item } = last.payload;
              set((s) => {
                const arr = s.itemsBySession[sessionId] || [];
                const nextArr = [...arr, item];
                const undo = s._undo.slice(0, -1);
                const redo = [...s._redo, last].slice(-50);
                return {
                  itemsBySession: { ...s.itemsBySession, [sessionId]: nextArr },
                  _undo: undo,
                  _redo: redo,
                };
              });
              persistToDexie?.("scans", item);
            }
          },

          redo() {
            const stack = get()._redo;
            if (!stack.length) return;
            const last = stack[stack.length - 1];
            if (last.kind === "removeItem") {
              const { sessionId, item } = last.payload;
              get().removeItem(sessionId, item.id);
              set((s) => ({ _redo: s._redo.slice(0, -1) }));
            }
          },

          /* -------------------------------- favorites ------------------------------- */
          saveFavoriteSession(sessionId, name, tags = []) {
            const sid = sessionId || get().activeSessionId;
            if (!sid) return null;
            const session = get().sessions[sid];
            const items = get().itemsBySession[sid] || [];
            if (!session) return null;

            const fav = {
              id: genId(),
              kind: "scan-session",
              name: name || session.title || "Scan Favorite",
              createdAt: now(),
              tags,
              payload: {
                session: { ...session },
                items: items.map((i) => ({ ...i })),
              },
            };

            set((s) => ({
              favorites: {
                ...s.favorites,
                sessions: { ...s.favorites.sessions, [fav.id]: fav },
              },
            }));

            persistToDexie?.("favorites", fav);
            return fav.id;
          },

          loadFavoriteSession(favoriteId) {
            const fav = get().favorites.sessions[favoriteId];
            if (!fav) return null;

            const newSession = mkSession({
              title: fav.name + " (copy)",
              origin: "favorite",
              tags: fav.tags,
            });

            set((s) => ({
              activeSessionId: newSession.id,
              sessions: { ...s.sessions, [newSession.id]: newSession },
              itemsBySession: {
                ...s.itemsBySession,
                [newSession.id]: (fav.payload.items || []).map((i) => ({
                  ...i,
                  id: genId(),
                  sessionId: newSession.id,
                  ts: now(),
                })),
              },
            }));

            persistToDexie?.("scanSessions", newSession);
            (get().itemsBySession[newSession.id] || []).forEach((it) =>
              persistToDexie?.("scans", it)
            );

            fire(EVT.SCAN_STARTED, { session: newSession, fromFavorite: favoriteId });
            return newSession.id;
          },

          /* -------------------------------- schedules ------------------------------- */
          saveScheduleForWatchlist({ name, rrule, payload = {}, tags = [] }) {
            // payload could include UPCs, brands, categories, stores, and desired thresholds.
            const sched = {
              id: genId(),
              name: name || "Price/Coupon Watch",
              rrule, // use your automation runtime RRULE or VEVENT
              payload,
              createdAt: now(),
              tags,
            };
            set((s) => ({
              favorites: {
                ...s.favorites,
                schedules: { ...s.favorites.schedules, [sched.id]: sched },
              },
            }));
            persistToDexie?.("schedules", sched);

            // Let your automation runtime pick this up
            fire(EVT.SCHEDULE_SAVED, { schedule: sched, domain: "scan-compare-trust" });
            return sched.id;
          },

          /* --------------------------- cross-domain bridges ------------------------- */
          // For seed packets → garden plan
          requestGardenPlanFromSeeds(sessionId) {
            const sid = sessionId || get().activeSessionId;
            const items = get().getItems(sid);
            const seeds = items.filter((i) => i.intents?.gardenSeed || /seed/i.test(i.label || ""));
            if (!seeds.length) return;
            fire(EVT.GARDEN_PLAN_REQUESTED, {
              sessionId: sid,
              seeds: seeds.map((s) => ({
                label: s.label,
                product: s.product,
                meta: s.meta,
              })),
            });
          },

          // For pantry items → meal plan
          requestMealPlanFromScans(sessionId) {
            const sid = sessionId || get().activeSessionId;
            const items = get().getItems(sid);
            if (!items.length) return;
            fire(EVT.MEALPLAN_DRAFT_REQUESTED, {
              sessionId: sid,
              pantrySnapshot: items.map((i) => ({
                upc: i.upc,
                name: i.product?.name || i.label,
                brand: i.product?.brand || null,
                qty: 1, // could be refined later
                size: i.product?.size || null,
              })),
              // hints could be extended from household profile later
              hints: { avoid: get().prefs.harmfulIngredients },
            });
          },

          // For “Generate Animal Plan from Recipes” (reverse direction)
          requestAnimalPlanFromRecipes(sessionId) {
            const sid = sessionId || get().activeSessionId;
            const items = get().getItems(sid);
            if (!items.length) return;
            fire(EVT.ANIMAL_PLAN_REQUESTED, {
              sessionId: sid,
              // agent will estimate meat animals & breeds by geo (use your location service)
              recipeSignals: items
                .filter((i) => i.product?.category === "recipe" || /recipe/i.test(i.tags?.join(" ") || ""))
                .map((i) => ({
                  name: i.product?.name || i.label,
                  ingredients: i.product?.ingredients || [],
                })),
            });
          },

          /* ------------------------------- preferences ------------------------------ */
          setPreferredStores(stores = []) {
            set((s) => ({ prefs: { ...s.prefs, preferredStores: stores } }));
          },
          setRecallWatchEnabled(enabled) {
            set((s) => ({ prefs: { ...s.prefs, recallWatchEnabled: !!enabled } }));
          },
          setHarmfulIngredients(list = []) {
            set((s) => ({ prefs: { ...s.prefs, harmfulIngredients: list } }));
          },

          /* ------------------------------- housekeeping ----------------------------- */
          pruneSession(sessionId, keepLast = 200) {
            const sid = sessionId || get().activeSessionId;
            if (!sid) return;
            set((s) => {
              const arr = s.itemsBySession[sid] || [];
              if (arr.length <= keepLast) return {};
              const next = arr.slice(-clamp(keepLast, 10, 1000));
              return { itemsBySession: { ...s.itemsBySession, [sid]: next } };
            });
          },

          resetSession(sessionId) {
            const sid = sessionId || get().activeSessionId;
            if (!sid) return;
            const before = get().itemsBySession[sid] || [];
            set((s) => {
              const undo = [
                ...s._undo,
                { kind: "resetSession", payload: { sessionId: sid, before } },
              ].slice(-20);
              return {
                itemsBySession: { ...s.itemsBySession, [sid]: [] },
                _undo: undo,
                _redo: [],
              };
            });
          },

          clearAll() {
            set(() => ({
              activeSessionId: null,
              sessions: {},
              itemsBySession: {},
              favorites: { sessions: {}, schedules: {} },
              _undo: [],
              _redo: [],
            }));
          },
        }),
        {
          name: "suka-scan-store",
          version: 2,
          partialize: (state) => ({
            activeSessionId: state.activeSessionId,
            sessions: state.sessions,
            itemsBySession: state.itemsBySession,
            favorites: state.favorites,
            prefs: state.prefs,
          }),
          migrate: (persisted, version) => {
            // Simple forward migration example
            if (version < 2 && persisted) {
              persisted.prefs = persisted.prefs || {
                harmfulIngredients: [],
                recallWatchEnabled: true,
                preferredStores: [],
              };
            }
            return persisted;
          },
        }
      )
    )
  )
);

/* -------------------------------------------------------------------------- */
/* Bus listeners (optional): attach only once in browser                      */
/* These allow workers/agents to patch items as results arrive.               */
/* -------------------------------------------------------------------------- */
if (isBrowser) {
  const onceKey = "__suka_scan_store_bus_bound__";
  if (!window[onceKey]) {
    window[onceKey] = true;

    // PRODUCT_RESOLVED
    window.addEventListener(
      EVT.PRODUCT_RESOLVED,
      (e) => {
        const { sessionId, itemId, product, sourceAttribution = [] } = e.detail || {};
        if (!sessionId || !itemId) return;
        useScanStore.getState().updateItem(sessionId, itemId, {
          product,
          sourceAttribution: sourceAttribution.length ? sourceAttribution : undefined,
        });
      },
      false
    );

    // PRICING_RESOLVED
    window.addEventListener(
      EVT.PRICING_RESOLVED,
      (e) => {
        const { sessionId, itemId, pricing, sourceAttribution = [] } = e.detail || {};
        if (!sessionId || !itemId) return;
        useScanStore.getState().updateItem(sessionId, itemId, {
          pricing,
          sourceAttribution: sourceAttribution.length
            ? (prev => (prev || []).concat(sourceAttribution))
            : undefined,
        });
      },
      false
    );

    // COUPONS_RESOLVED
    window.addEventListener(
      EVT.COUPONS_RESOLVED,
      (e) => {
        const { sessionId, itemId, coupons, sourceAttribution = [] } = e.detail || {};
        if (!sessionId || !itemId) return;
        useScanStore.getState().updateItem(sessionId, itemId, {
          coupons,
          sourceAttribution: sourceAttribution.length
            ? (prev => (prev || []).concat(sourceAttribution))
            : undefined,
        });
      },
      false
    );

    // SAFETY_CHECK_RESOLVED
    window.addEventListener(
      EVT.SAFETY_CHECK_RESOLVED,
      (e) => {
        const { sessionId, itemId, safety, sourceAttribution = [] } = e.detail || {};
        if (!sessionId || !itemId) return;
        useScanStore.getState().updateItem(sessionId, itemId, {
          safety,
          sourceAttribution: sourceAttribution.length
            ? (prev => (prev || []).concat(sourceAttribution))
            : undefined,
        });
      },
      false
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience hooks for UI components                                        */
/* -------------------------------------------------------------------------- */
export const ScanSelectors = {
  useActiveSession: () => useScanStore((s) => s.getActiveSession()),
  useItems: (sessionId) =>
    useScanStore((s) => s.getItems(sessionId)),
  usePrefs: () => useScanStore((s) => s.prefs),
  useFavorites: () => useScanStore((s) => s.favorites),
};

/* -------------------------------------------------------------------------- */
/* Suggested UI wiring (for reference)                                        */
/*
Scanner.jsx
-----------
const { startSession, addRawCapture, endSession } = useScanStore.getState();
useEffect(() => { startSession({ origin: "scanner", intent: "compare" }); }, []);
onBarcode(data => addRawCapture({ upc: data.code }));
onDone(() => endSession());

ScanSheet.jsx
-------------
const session = ScanSelectors.useActiveSession();
const items = ScanSelectors.useItems(session?.id);
const { saveFavoriteSession, requestMealPlanFromScans, requestGardenPlanFromSeeds } = useScanStore.getState();

SourceAttribution.jsx
---------------------
Read item.sourceAttribution[] to render provider chips.

Coupon/Price Agents
-------------------
Listen for PRODUCT_RESOLVE_REQUESTED / PRICING_REQUESTED / COUPONS_REQUESTED,
do the work, then dispatch PRODUCT_RESOLVED / PRICING_RESOLVED / COUPONS_RESOLVED
with { sessionId, itemId, ... }.
*/
/* -------------------------------------------------------------------------- */
