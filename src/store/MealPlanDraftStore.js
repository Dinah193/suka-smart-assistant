// src/store/MealPlanDraftStore.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant — Meal Plan Draft Store
// Goals: intuitive UX (drafts separate from current), fast operations, safe
// persistence, strong typing via JSDoc, and clean integration with MealPlanStore.
// -----------------------------------------------------------------------------
// Exports:
//   - default: useMealPlanDraftStore (Zustand hook)
//   - named helpers: saveDraft, deleteDraft, publishDraft, duplicateDraft, etc.
//   - convenience: updateMeta, markDirty, upsertDraft
// -----------------------------------------------------------------------------

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
// import { devtools } from "zustand/middleware"; // optional if you use devtools

/* -----------------------------------------------------------------------------*
 * Types (JSDoc)
 *-----------------------------------------------------------------------------*/

/**
 * @typedef {Object} MealIngredient
 * @property {string} name
 * @property {number} [qty]
 * @property {string|null} [unit]
 */

/**
 * @typedef {Object} MealEntry
 * @property {string} title
 * @property {"breakfast"|"lunch"|"dinner"|"snack"|string} [time]
 * @property {MealIngredient[]} [ingredients]
 * @property {string[]} [steps]
 * @property {string[]} [donenessTips]
 * @property {{name:string, qty:number, unit?:string|null}[]} [inventoryDelta]
 * @property {{calories?:number, protein_g?:number, carbs_g?:number, fat_g?:number}} [macros]
 */

/**
 * @typedef {Object} PlanDay
 * @property {number} day
 * @property {string} [label]
 * @property {string} [date]  // ISO
 * @property {MealEntry[]} meals
 * @property {{calories?:number, protein_g?:number, carbs_g?:number, fat_g?:number}} [macrosDay]
 * @property {{protein_pct?:number, carbs_pct?:number, fat_pct?:number}} [macrosPctDay]
 */

/**
 * @typedef {Object} MealPlanShape
 * @property {string} [summary]
 * @property {number} [days]
 * @property {PlanDay[]} plan
 * @property {Array<{name:string, qty:number, unit?:string|null, category?:string}>} [groceryList]
 * @property {Array<{name:string, qty:number, unit?:string|null}>} [inventoryDeltas]
 * @property {Array<{title:string, datetime:string, notes?:string}>} [prepSchedule]
 * @property {string[]} [notes]
 * @property {any} [_macroSummary]
 * @property {any} [_nutritionFlags]
 * @property {any} [_calendarEvents]
 */

/**
 * @typedef {Object} DraftMeta
 * @property {string} [duration]
 * @property {string} [createdBy]
 * @property {string} [source]       // "llm" | "bundle" | "draft" | etc.
 * @property {string} [zone]
 * @property {number} [people]
 * @property {Record<string, any>} [extras]
 */

/**
 * @typedef {Object} DraftRecord
 * @property {string} id
 * @property {string} title
 * @property {string} slug
 * @property {MealPlanShape} plan
 * @property {DraftMeta} meta
 * @property {string[]} tags
 * @property {boolean} dirty
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/* -----------------------------------------------------------------------------*
 * Utilities
 *-----------------------------------------------------------------------------*/

const nowISO = () => new Date().toISOString();

const safeUUID = () => {
  if (typeof crypto !== "undefined" && crypto?.randomUUID) return crypto.randomUUID();
  return "d_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
};

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "draft";

/** Very light validation for the expected meal plan shape */
function validatePlanShape(plan) {
  if (!plan || typeof plan !== "object") return false;
  if (!Array.isArray(plan.plan)) return false;
  for (const d of plan.plan) {
    if (!d || typeof d !== "object") return false;
    if (!Array.isArray(d.meals)) return false;
  }
  return true;
}

function deepClone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

/* -----------------------------------------------------------------------------*
 * Store shape
 *-----------------------------------------------------------------------------*/

/**
 * @typedef {Object} MealPlanDraftState
 * @property {Record<string, DraftRecord>} drafts
 * @property {string[]} order     // most-recent first
 * @property {string|null} selectedDraftId
 * @property {string|null} lastSyncAt
 * @property {number} count
 * @property {(plan:MealPlanShape, opts?:{id?:string, title?:string, meta?:Partial<DraftMeta>, tags?:string[]}) => Promise<string>} saveDraft
 * @property {(id:string, plan:MealPlanShape) => void} setDraftPlan
 * @property {(id:string, title:string) => void} renameDraft
 * @property {(id:string, tags:string[]|((old:string[])=>string[])) => void} setTags
 * @property {(id:string, tag:string) => void} addTag
 * @property {(id:string, tag:string) => void} removeTag
 * @property {(id:string, patch:Partial<DraftMeta>) => void} updateMeta
 * @property {(id:string, dirty?:boolean) => void} markDirty
 * @property {(rec:Partial<DraftRecord> & {id?:string, plan:MealPlanShape}) => string|null} upsertDraft
 * @property {(id:string) => string|null} duplicateDraft
 * @property {(id:string) => void} deleteDraft
 * @property {() => void} clearAllDrafts
 * @property {(id:string) => DraftRecord|null} getDraft
 * @property {() => DraftRecord[]} listDrafts
 * @property {(query?:string, tagFilter?:string[]) => DraftRecord[]} searchDrafts
 * @property {(id:string) => void} selectDraft
 * @property {() => DraftRecord|null} getSelectedDraft
 * @property {(id:string, opts?:{keep?:boolean, annotateMeta?:Record<string, any>}) => Promise<{ok:boolean, error?:string}>} publishDraft
 * @property {(id:string) => string|null} exportDraftJSON
 * @property {(raw:string) => {ok:boolean, id?:string, error?:string}} importDraftJSON
 * @property {(ids:string[]) => void} reorder
 */

/* -----------------------------------------------------------------------------*
 * Persistence + migration
 *-----------------------------------------------------------------------------*/

const STORAGE_KEY = "meal-plan-drafts";
const STORAGE_VERSION = 2;

const migrate = (persistedState, version) => {
  if (version < 2) {
    const s = persistedState || {};
    const drafts = s.drafts || {};
    for (const [id, d] of Object.entries(drafts)) {
      if (!d.slug) d.slug = slugify(d.title || "draft");
      if (!Array.isArray(d.tags)) d.tags = [];
      if (typeof d.dirty !== "boolean") d.dirty = false;
      if (!d.meta) d.meta = {};
    }
    if (!("selectedDraftId" in s)) s.selectedDraftId = null;
    return { ...s, drafts };
  }
  return persistedState;
};

const storageSafeLocal = createJSONStorage(() => {
  try {
    return localStorage;
  } catch {
    // SSR / non-browser safety
    let memory = {};
    return {
      getItem: (k) => (k in memory ? memory[k] : null),
      setItem: (k, v) => { memory[k] = v; },
      removeItem: (k) => { delete memory[k]; },
    };
  }
});

/* -----------------------------------------------------------------------------*
 * Store
 *-----------------------------------------------------------------------------*/

// const baseCreate = devtools ? (...a) => devtools(create(...a)) : create;
const baseCreate = create;

/** @type {import('zustand').UseBoundStore<import('zustand').StoreApi<MealPlanDraftState>>} */
export const useMealPlanDraftStore = baseCreate(
  persist(
    (set, get) => ({
      drafts: /** @type {Record<string, DraftRecord>} */ ({}),
      order: /** @type {string[]} */ ([]),
      selectedDraftId: null,
      lastSyncAt: null,

      // --------- Computed ----------
      get count() {
        return get().order.length;
      },

      // --------- Actions ----------
      async saveDraft(plan, opts = {}) {
        if (!validatePlanShape(plan)) {
          throw new Error("Invalid plan shape for draft: plan.plan[] missing or malformed.");
        }
        const cleanPlan = deepClone(plan);
        const id = opts.id || safeUUID();
        const title = String(opts.title || cleanPlan?.summary || "Untitled draft").trim();
        const slug = slugify(title);
        const now = nowISO();

        const prev = get().drafts[id];
        const baseMeta = prev?.meta || {};
        const meta = { ...baseMeta, ...(opts.meta || {}), updatedAt: now };

        const draft = /** @type {DraftRecord} */ ({
          id,
          title,
          slug,
          plan: cleanPlan,
          meta,
          tags: Array.isArray(opts.tags)
            ? [...new Set(opts.tags.map((t) => t.trim()).filter(Boolean))]
            : prev?.tags || [],
          dirty: false,
          createdAt: prev?.createdAt || now,
          updatedAt: now,
        });

        set((s) => ({
          drafts: { ...s.drafts, [id]: draft },
          order: [id, ...s.order.filter((x) => x !== id)],
          selectedDraftId: id,
          lastSyncAt: now,
        }));

        return id;
      },

      /** Replace plan content for a draft (marks clean) */
      setDraftPlan(id, plan) {
        if (!validatePlanShape(plan)) return;
        set((s) => {
          const d = s.drafts[id];
          if (!d) return {};
          const updated = {
            ...d,
            plan: deepClone(plan),
            dirty: false,
            updatedAt: nowISO(),
          };
          return {
            drafts: { ...s.drafts, [id]: updated },
            order: [id, ...s.order.filter((x) => x !== id)],
            lastSyncAt: nowISO(),
          };
        });
      },

      renameDraft(id, title) {
        set((s) => {
          const d = s.drafts[id];
          if (!d) return {};
          const t = (title || "").trim();
          const updated = {
            ...d,
            title: t || d.title,
            slug: slugify(t || d.title),
            dirty: d.dirty || t !== d.title,
            updatedAt: nowISO(),
          };
          return {
            drafts: { ...s.drafts, [id]: updated },
            order: [id, ...s.order.filter((x) => x !== id)],
          };
        });
      },

      setTags(id, tags) {
        set((s) => {
          const d = s.drafts[id];
          if (!d) return {};
          const nextTags =
            typeof tags === "function"
              ? tags(d.tags || [])
              : (Array.isArray(tags) ? tags : [])
                  .map((t) => t.trim())
                  .filter(Boolean);
          const unique = [...new Set(nextTags)];
          const updated = {
            ...d,
            tags: unique,
            dirty: d.dirty || JSON.stringify(unique) !== JSON.stringify(d.tags || []),
            updatedAt: nowISO(),
          };
          return { drafts: { ...s.drafts, [id]: updated } };
        });
      },

      addTag(id, tag) {
        if (!tag) return;
        get().setTags(id, (old) => [...new Set([...(old || []), tag.trim()])]);
      },

      removeTag(id, tag) {
        if (!tag) return;
        get().setTags(
          id,
          (old) => (old || []).filter((t) => t.toLowerCase() !== tag.toLowerCase())
        );
      },

      /** Update meta fields */
      updateMeta(id, patch) {
        set((s) => {
          const d = s.drafts[id];
          if (!d) return {};
          const updated = {
            ...d,
            meta: { ...(d.meta || {}), ...(patch || {}) },
            dirty: true,
            updatedAt: nowISO(),
          };
          return { drafts: { ...s.drafts, [id]: updated } };
        });
      },

      /** Explicitly mark draft dirty/clean */
      markDirty(id, dirty = true) {
        set((s) => {
          const d = s.drafts[id];
          if (!d) return {};
          return {
            drafts: { ...s.drafts, [id]: { ...d, dirty, updatedAt: nowISO() } },
          };
        });
      },

      /** Upsert convenience — create or update in one call */
      upsertDraft(rec) {
        const id = rec.id || safeUUID();
        if (!validatePlanShape(rec.plan)) return null;
        const now = nowISO();
        const title = (rec.title || rec.plan?.summary || "Draft").trim();
        const merged = /** @type {DraftRecord} */ ({
          id,
          title,
          slug: slugify(title),
          plan: deepClone(rec.plan),
          meta: { ...(rec.meta || {}), updatedAt: now },
          tags: Array.isArray(rec.tags) ? [...new Set(rec.tags)] : [],
          dirty: !!rec.dirty,
          createdAt: rec.createdAt || now,
          updatedAt: now,
        });
        set((s) => ({
          drafts: { ...s.drafts, [id]: merged },
          order: [id, ...s.order.filter((x) => x !== id)],
          selectedDraftId: id,
          lastSyncAt: now,
        }));
        return id;
      },

      duplicateDraft(id) {
        const src = get().drafts[id];
        if (!src) return null;
        const copyId = safeUUID();
        const baseTitle = src.title || "Draft";
        const title = `${baseTitle} (Copy)`;
        const now = nowISO();
        const copy = /** @type {DraftRecord} */ ({
          ...deepClone(src),
          id: copyId,
          title,
          slug: slugify(title),
          createdAt: now,
          updatedAt: now,
          dirty: true,
        });
        set((s) => ({
          drafts: { ...s.drafts, [copyId]: copy },
          order: [copyId, ...s.order.filter((x) => x !== copyId)],
          selectedDraftId: copyId,
          lastSyncAt: now,
        }));
        return copyId;
      },

      deleteDraft(id) {
        set((s) => {
          if (!s.drafts[id]) return {};
          const nextDrafts = { ...s.drafts };
          delete nextDrafts[id];
          const nextOrder = s.order.filter((x) => x !== id);
          const nextSelected =
            s.selectedDraftId === id ? nextOrder[0] ?? null : s.selectedDraftId;
          return {
            drafts: nextDrafts,
            order: nextOrder,
            selectedDraftId: nextSelected,
            lastSyncAt: nowISO(),
          };
        });
      },

      clearAllDrafts() {
        set(() => ({
          drafts: {},
          order: [],
          selectedDraftId: null,
          lastSyncAt: nowISO(),
        }));
      },

      getDraft(id) {
        return get().drafts[id] || null;
      },

      listDrafts() {
        const s = get();
        return s.order.map((id) => s.drafts[id]).filter(Boolean);
      },

      searchDrafts(query = "", tagFilter = []) {
        const needle = query.trim().toLowerCase();
        const tags = (tagFilter || []).map((t) => t.toLowerCase());
        const matchesTags = (d) =>
          !tags.length || tags.every((t) => (d.tags || []).some((x) => x.toLowerCase() === t));
        const s = get();
        return s.order
          .map((id) => s.drafts[id])
          .filter(Boolean)
          .filter((d) => {
            if (!matchesTags(d)) return false;
            if (!needle) return true;
            const hay = [
              d.title,
              d.slug,
              d.meta?.duration,
              d.meta?.source,
              ...(d.tags || []),
              d.plan?.summary || "",
            ].join(" ").toLowerCase();
            return hay.includes(needle);
          });
      },

      selectDraft(id) {
        const s = get();
        if (!s.drafts[id]) return;
        set({ selectedDraftId: id });
      },

      getSelectedDraft() {
        const s = get();
        return s.selectedDraftId ? s.drafts[s.selectedDraftId] || null : null;
      },

      async publishDraft(id, opts = {}) {
        const d = get().drafts[id];
        if (!d) return { ok: false, error: "Draft not found." };
        try {
          const storeMod = await import("@/store/MealPlanStore");
          const useMealPlanStore = storeMod?.useMealPlanStore || storeMod?.default || null;

          // Prefer setPlan if available; otherwise saveMealPlan; otherwise named export function.
          const st =
            typeof useMealPlanStore === "function"
              ? useMealPlanStore.getState
                ? useMealPlanStore.getState()
                : useMealPlanStore()
              : null;

          const meta = {
            createdAt: nowISO(),
            source: "draft",
            draftId: id,
            ...(opts.annotateMeta || {}),
          };

          if (st?.setPlan) {
            st.setPlan(d.plan, meta);
          } else if (st?.saveMealPlan) {
            await st.saveMealPlan(d.plan, meta);
          } else if (typeof storeMod?.saveMealPlan === "function") {
            await storeMod.saveMealPlan(d.plan, meta);
          } else {
            console.warn("[MealPlanDraftStore] publishDraft: MealPlanStore has no setPlan/saveMealPlan.");
          }

          if (!opts.keep) {
            get().deleteDraft(id);
          }
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e?.message || String(e) };
        }
      },

      exportDraftJSON(id) {
        const d = get().drafts[id];
        if (!d) return null;
        try {
          const payload = { version: STORAGE_VERSION, exportedAt: nowISO(), draft: d };
          return JSON.stringify(payload, null, 2);
        } catch {
          return null;
        }
      },

      importDraftJSON(raw) {
        try {
          const parsed = JSON.parse(String(raw || "{}"));
          const draft = parsed?.draft;
          if (!draft || !validatePlanShape(draft.plan)) {
            return { ok: false, error: "Invalid draft file." };
          }
          const id = safeUUID();
          const now = nowISO();
          const title = (draft.title || "Imported draft").trim();
          const normalized = /** @type {DraftRecord} */ ({
            id,
            title,
            slug: slugify(title),
            plan: deepClone(draft.plan),
            meta: { ...(draft.meta || {}), importedFrom: parsed?.exportedAt || "external" },
            tags: Array.isArray(draft.tags) ? [...new Set(draft.tags)] : [],
            dirty: true,
            createdAt: now,
            updatedAt: now,
          });
          set((s) => ({
            drafts: { ...s.drafts, [id]: normalized },
            order: [id, ...s.order],
            selectedDraftId: id,
            lastSyncAt: now,
          }));
          return { ok: true, id };
        } catch (e) {
          return { ok: false, error: e?.message || "Failed to parse JSON." };
        }
      },

      reorder(ids) {
        if (!Array.isArray(ids) || !ids.length) return;
        set((s) => {
          const valid = ids.filter((id) => !!s.drafts[id]);
          if (!valid.length) return {};
          return { order: valid };
        });
      },
    }),
    {
      name: STORAGE_KEY,
      version: STORAGE_VERSION,
      storage: storageSafeLocal,
      migrate,
      // partialize: (s) => ({ drafts: s.drafts, order: s.order, selectedDraftId: s.selectedDraftId }) // customize if needed
    }
  )
);

/* -----------------------------------------------------------------------------*
 * Named helpers (ergonomic re-exports)
 *-----------------------------------------------------------------------------*/

export function listDrafts() { return useMealPlanDraftStore.getState().listDrafts(); }
export function getDraft(id) { return useMealPlanDraftStore.getState().getDraft(id); }
export async function saveDraft(plan, opts) { return await useMealPlanDraftStore.getState().saveDraft(plan, opts); }
export function deleteDraft(id) { return useMealPlanDraftStore.getState().deleteDraft(id); }
export async function publishDraft(id, opts) { return await useMealPlanDraftStore.getState().publishDraft(id, opts); }
export function renameDraft(id, title) { return useMealPlanDraftStore.getState().renameDraft(id, title); }
export function duplicateDraft(id) { return useMealPlanDraftStore.getState().duplicateDraft(id); }
export function selectDraft(id) { return useMealPlanDraftStore.getState().selectDraft(id); }
export function getSelectedDraft() { return useMealPlanDraftStore.getState().getSelectedDraft(); }
export function exportDraftJSON(id) { return useMealPlanDraftStore.getState().exportDraftJSON(id); }
export function importDraftJSON(raw) { return useMealPlanDraftStore.getState().importDraftJSON(raw); }
export function updateMeta(id, patch) { return useMealPlanDraftStore.getState().updateMeta(id, patch); }
export function markDirty(id, dirty = true) { return useMealPlanDraftStore.getState().markDirty(id, dirty); }
export function upsertDraft(rec) { return useMealPlanDraftStore.getState().upsertDraft(rec); }

/* default export for compatibility with code that does:
   import useMealPlanDraftStore from ".../MealPlanDraftStore" */
export default useMealPlanDraftStore;

/* -----------------------------------------------------------------------------
 UX inspiration notes:
 - Show Drafts as a dedicated list (chips/tags & quick search), like Notion/Figma.
 - Inline rename on title click; optimistic updates; “Publish” promotes to MealPlanStore.
 - One-click Duplicate for A/B scenarios; Export/Import JSON for collaboration.
 - Tag filters (“keto”, “budget”, “family of 4”), and recency ordering.
 -----------------------------------------------------------------------------*/
