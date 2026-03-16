// src/store/StorehousePlannerStore.js
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { shallow } from "zustand/shallow";
import { eventBus } from "@/services/events/eventBus";

/* ----------------------------------------------------------------------------
   Types (informal)
   - Need: {
       id, name, qty?, unit?, category?, priority?, tags?, neededBy?, source?, notes?
       linkedRecipeId?, aisle?
     }
   - PreservationTask: {
       id, produce, method, quantity, unit, dueDate?, durationMin?, vesselSize?,
       batchCount?, status: "planned"|"prepped"|"done"|"skipped",
       linkedInventoryIds?, notes?
     }
---------------------------------------------------------------------------- */

const VERSION = 4;
const LS_KEY = "suka.storehousePlanner.v" + VERSION;

/* --------------------------------- utils ---------------------------------- */
const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const norm = (s) => String(s ?? "").trim();
const isObj = (x) => x && typeof x === "object";
const toDateISO = (d) => {
  try {
    const x = typeof d === "string" ? new Date(d) : d;
    if (!(x instanceof Date) || Number.isNaN(x.getTime())) return undefined;
    return new Date(x.getTime() - x.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 10);
  } catch {
    return undefined;
  }
};

function arraysShallowEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
    return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function mapNeedIn(n) {
  if (!isObj(n)) return null;
  const id = norm(n.id || uid());
  const name = norm(n.name);
  if (!name) return null;
  const qty =
    n.qty != null ? Number(n.qty) : n.total != null ? Number(n.total) : undefined;
  const unit = n.unit ? norm(n.unit) : undefined;
  const category = n.category ? norm(n.category) : undefined;
  const priority = n.priority != null ? Number(n.priority) : undefined; // 1 (highest) … 5 (lowest)
  const tags = Array.isArray(n.tags) ? n.tags.filter(Boolean).map(norm) : [];
  const neededBy = n.neededBy ? toDateISO(n.neededBy) : undefined;
  const source = n.source ? norm(n.source) : undefined; // "plan", "recipe", "manual"
  const aisle = n.aisle ? norm(n.aisle) : undefined;
  return {
    id,
    name,
    qty,
    unit,
    category,
    priority,
    tags,
    neededBy,
    source,
    aisle,
    linkedRecipeId: n.linkedRecipeId ? norm(n.linkedRecipeId) : undefined,
    notes: n.notes ? norm(n.notes) : undefined,
  };
}

function normalizePlannerEstimateInputsPayload(payload = {}) {
  const data =
    payload && typeof payload === "object" && payload.type && payload.data
      ? payload.data
      : payload;

  const estimateInputs =
    isObj(data?.estimateInputs)
      ? data.estimateInputs
      : isObj(data) && /^planner\.estimate-inputs\./.test(norm(data?.contractVersion))
      ? data
      : null;

  return {
    estimateInputs,
  };
}

function normalizePlannerGapsPayload(payload = {}) {
  const data =
    payload && typeof payload === "object" && payload.type && payload.data
      ? payload.data
      : payload;

  const plannerGaps =
    isObj(data?.plannerGaps)
      ? data.plannerGaps
      : isObj(data) && (Array.isArray(data?.gaps) || isObj(data?.summary))
      ? data
      : null;

  return { plannerGaps };
}

function mapHardGapsToStorehouseNeeds(plannerGaps = {}) {
  const hard = Array.isArray(plannerGaps?.gaps)
    ? plannerGaps.gaps.filter((g) => String(g?.severity || "").toLowerCase() === "hard")
    : [];

  return hard
    .map((gap, idx) => {
      const name = norm(gap?.name || gap?.label || gap?.key);
      if (!name) return null;
      const qty = Number(gap?.missingQty ?? gap?.qty ?? 0);
      const unit = norm(gap?.unit || "unit") || "unit";
      const topSource = Array.isArray(gap?.recommendedSourcing)
        ? gap.recommendedSourcing[0]
        : null;
      const sourceTier = norm(topSource?.sourceTier || "community") || "community";
      return {
        id: `gap-${idx + 1}-${name.toLowerCase()}-${unit}`,
        name,
        qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
        unit,
        category: "hard-gap",
        priority: 1,
        tags: ["planner-gap", "hard", `source-tier:${sourceTier}`],
        source: "planner-gaps",
        neededBy: gap?.dueDate || undefined,
        notes: `Hard gap escalated for sourcing. Priority order: community marketplace, then outside sources.`,
      };
    })
    .filter(Boolean);
}

function titleCaseWords(v = "") {
  return norm(v)
    .split(/\s|-/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mapEstimateInputsToStorehouseNeeds(estimateInputs = {}) {
  const needs = [];

  const produceDemand = Array.isArray(estimateInputs?.garden?.produceDemand)
    ? estimateInputs.garden.produceDemand
    : [];

  for (const p of produceDemand) {
    const name = norm(p?.name);
    const qty = Number(p?.qty || 0);
    if (!name || qty <= 0) continue;
    needs.push({
      id: `need-garden-${name.toLowerCase()}-${norm(p?.unit || "unit")}`,
      name,
      qty,
      unit: norm(p?.unit) || "unit",
      category: "garden-input",
      priority: 2,
      tags: ["planner-estimate", "garden", "auto-forward"],
      source: "planner-estimate",
      notes: "Inferred from planner produce demand.",
    });
  }

  const proteinDemandByType = isObj(estimateInputs?.animal?.proteinDemandByType)
    ? estimateInputs.animal.proteinDemandByType
    : {};

  for (const [type, rawDemand] of Object.entries(proteinDemandByType)) {
    const demand = Number(rawDemand || 0);
    if (demand <= 0) continue;
    const label = titleCaseWords(type || "other");

    needs.push({
      id: `need-protein-${norm(type || "other")}`,
      name: `${label} protein supply`,
      qty: demand,
      unit: "serving",
      category: "animal-protein",
      priority: 2,
      tags: ["planner-estimate", "animal", "protein"],
      source: "planner-estimate",
      notes: "Inferred from meal-plan protein demand by type.",
    });

    needs.push({
      id: `need-feed-${norm(type || "other")}`,
      name: `${label} feed ration`,
      qty: Math.max(1, Math.ceil(demand * 0.5)),
      unit: "unit",
      category: "animal-feed",
      priority: 2,
      tags: ["planner-estimate", "animal", "feed", "sustainability"],
      source: "planner-estimate",
      notes: "Heuristic feed reserve aligned to projected protein demand.",
    });
  }

  return needs;
}

function mapTaskIn(t) {
  if (!isObj(t)) return null;
  const id = norm(t.id || uid());
  const produce = norm(t.produce || t.name || "");
  if (!produce) return null;
  const method = norm(t.method || "pressure");
  const quantity = t.quantity != null ? Number(t.quantity) : undefined;
  const unit = t.unit ? norm(t.unit) : undefined;
  const dueDate = t.dueDate ? toDateISO(t.dueDate) : undefined;
  const durationMin = t.durationMin != null ? Number(t.durationMin) : undefined;
  const vesselSize = t.vesselSize ? norm(t.vesselSize) : undefined; // 'pint' | 'quart' | 'halfPint'
  const batchCount = t.batchCount != null ? Number(t.batchCount) : 1;
  const status = ["planned", "prepped", "done", "skipped"].includes(t.status)
    ? t.status
    : "planned";
  const linkedInventoryIds = Array.isArray(t.linkedInventoryIds)
    ? t.linkedInventoryIds.map(norm)
    : [];
  return {
    id,
    produce,
    method,
    quantity,
    unit,
    dueDate,
    durationMin,
    vesselSize,
    batchCount,
    status,
    linkedInventoryIds,
    notes: t.notes ? norm(t.notes) : undefined,
  };
}

/* Optional dynamic imports (graceful if not present) */
async function getSettings() {
  try {
    const S = await import("@/store/SettingsStore");
    return S;
  } catch {
    return null;
  }
}
async function getInventory() {
  try {
    const I = await import("@/store/InventoryStore");
    return I;
  } catch {
    return null;
  }
}

/* ------------------------------ Zustand store ------------------------------ */
export const useStorehousePlannerStore = create(
  persist(
    (set, get) => ({
      /* -------------------- core state (BC) -------------------- */
      storehouseNeeds: [],
      preservationQueue: [],
      plannerSignals: {
        lastReadiness: null,
        lastReadinessAt: null,
        lastPlannerGaps: null,
        lastPlannerGapsAt: null,
      },

      /* ------------------------ BC setters --------------------- */
      setStorehouseNeeds: (next) => {
        const value =
          typeof next === "function" ? next(get().storehouseNeeds) : next;
        const safe = Array.isArray(value)
          ? value.map(mapNeedIn).filter(Boolean)
          : [];
        const prev = get().storehouseNeeds;
        if (arraysShallowEqual(prev, safe)) return;
        set({ storehouseNeeds: safe });
      },

      setPreservationQueue: (next) => {
        const value =
          typeof next === "function" ? next(get().preservationQueue) : next;
        const safe = Array.isArray(value)
          ? value.map(mapTaskIn).filter(Boolean)
          : [];
        const prev = get().preservationQueue;
        if (arraysShallowEqual(prev, safe)) return;
        set({ preservationQueue: safe });
      },

      // ---------- Helpers (BC) ----------
      addNeed: (item) => {
        const mapped = mapNeedIn(item);
        if (!mapped) return;
        const prev = get().storehouseNeeds;
        // de-dupe by name + unit (and optional category)
        if (
          prev.some(
            (x) =>
              x.name.toLowerCase() === mapped.name.toLowerCase() &&
              (x.unit || "") === (mapped.unit || "") &&
              (x.category || "") === (mapped.category || "")
          )
        ) {
          return;
        }
        set({ storehouseNeeds: [...prev, mapped] });
      },

      removeNeed: (predicate) => {
        const prev = get().storehouseNeeds;
        const next =
          typeof predicate === "function"
            ? prev.filter((x) => !predicate(x))
            : [];
        if (arraysShallowEqual(prev, next)) return;
        set({ storehouseNeeds: next });
      },

      clearNeeds: () => {
        if (get().storehouseNeeds.length === 0) return;
        set({ storehouseNeeds: [] });
      },

      addPreservationTask: (task) => {
        const mapped = mapTaskIn(task);
        if (!mapped) return;
        set({ preservationQueue: [...get().preservationQueue, mapped] });
      },

      removePreservationTask: (predicate) => {
        const prev = get().preservationQueue;
        const next =
          typeof predicate === "function"
            ? prev.filter((x) => !predicate(x))
            : [];
        if (arraysShallowEqual(prev, next)) return;
        set({ preservationQueue: next });
      },

      clearPreservationQueue: () => {
        if (get().preservationQueue.length === 0) return;
        set({ preservationQueue: [] });
      },

      /* ---------------- New non-breaking APIs ------------------ */

      /** Bulk upsert needs; merges quantities when same (name, unit, category). */
      upsertNeeds: (items = []) => {
        const incoming = items.map(mapNeedIn).filter(Boolean);
        if (!incoming.length) return;
        const index = new Map(
          get().storehouseNeeds.map((n) => [
            `${n.name.toLowerCase()}|${n.unit || ""}|${n.category || ""}`,
            n,
          ])
        );
        for (const it of incoming) {
          const key = `${it.name.toLowerCase()}|${it.unit || ""}|${
            it.category || ""
          }`;
          if (index.has(key)) {
            const cur = index.get(key);
            index.set(key, {
              ...cur,
              qty:
                cur.qty != null || it.qty != null
                  ? Number(cur.qty || 0) + Number(it.qty || 0)
                  : undefined,
              tags: Array.from(
                new Set([...(cur.tags || []), ...(it.tags || [])])
              ),
              priority: Math.min(cur.priority ?? 3, it.priority ?? 3),
              neededBy: cur.neededBy || it.neededBy,
              notes: cur.notes || it.notes,
            });
          } else {
            index.set(key, it);
          }
        }
        set({ storehouseNeeds: Array.from(index.values()) });
      },

      /** Bulk upsert preservation tasks (merge by produce+method+vesselSize+dueDate). */
      upsertPreservationTasks: (tasks = []) => {
        const incoming = tasks.map(mapTaskIn).filter(Boolean);
        if (!incoming.length) return;
        const prev = get().preservationQueue;
        const keyFor = (t) =>
          `${t.produce.toLowerCase()}|${t.method}|${t.vesselSize || ""}|${
            t.dueDate || ""
          }`;
        const map = new Map(prev.map((t) => [keyFor(t), t]));
        for (const t of incoming) {
          const k = keyFor(t);
          if (map.has(k)) {
            const cur = map.get(k);
            map.set(k, {
              ...cur,
              quantity:
                cur.quantity != null || t.quantity != null
                  ? Number(cur.quantity || 0) + Number(t.quantity || 0)
                  : undefined,
              batchCount: Math.max(
                Number(cur.batchCount || 1),
                Number(t.batchCount || 1)
              ),
              durationMin: Math.max(
                Number(cur.durationMin || 0),
                Number(t.durationMin || 0)
              ),
              status: cur.status === "done" ? "done" : t.status,
              linkedInventoryIds: Array.from(
                new Set([
                  ...(cur.linkedInventoryIds || []),
                  ...(t.linkedInventoryIds || []),
                ])
              ),
              notes: cur.notes || t.notes,
            });
          } else {
            map.set(k, t);
          }
        }
        set({ preservationQueue: Array.from(map.values()) });
      },

      /** Import from JSON; returns { addedNeeds, addedTasks }. */
      importJson: (json) => {
        try {
          const obj = typeof json === "string" ? JSON.parse(json) : json;
          const needs = Array.isArray(obj?.storehouseNeeds)
            ? obj.storehouseNeeds
            : [];
          const tasks = Array.isArray(obj?.preservationQueue)
            ? obj.preservationQueue
            : [];
          const beforeN = get().storehouseNeeds.length;
          const beforeT = get().preservationQueue.length;
          get().upsertNeeds(needs);
          get().upsertPreservationTasks(tasks);
          return {
            addedNeeds: get().storehouseNeeds.length - beforeN,
            addedTasks: get().preservationQueue.length - beforeT,
          };
        } catch {
          return { addedNeeds: 0, addedTasks: 0 };
        }
      },

      /** Export current state to JSON string. */
      exportJson: (pretty = true) => {
        const data = {
          storehouseNeeds: get().storehouseNeeds,
          preservationQueue: get().preservationQueue,
        };
        return JSON.stringify(data, null, pretty ? 2 : 0);
      },

      /** Summaries for UI: totals by category/aisle/priority & workload minutes. */
      getSummaries: () => {
        const needs = get().storehouseNeeds;
        const tasks = get().preservationQueue;

        const byCategory = {};
        const byAisle = {};
        const byPriority = {};
        let needsCount = 0;

        for (const n of needs) {
          needsCount++;
          if (n.category)
            byCategory[n.category] = (byCategory[n.category] || 0) + 1;
          if (n.aisle) byAisle[n.aisle] = (byAisle[n.aisle] || 0) + 1;
          const p = n.priority ?? 3;
          byPriority[p] = (byPriority[p] || 0) + 1;
        }

        const workloadMin = tasks.reduce(
          (sum, t) =>
            sum + Number(t.durationMin || 0) * Number(t.batchCount || 1),
          0
        );
        const tasksByStatus = tasks.reduce((acc, t) => {
          acc[t.status] = (acc[t.status] || 0) + 1;
          return acc;
        }, {});

        return {
          needsCount,
          byCategory,
          byAisle,
          byPriority,
          tasksCount: tasks.length,
          tasksByStatus,
          workloadMin,
        };
      },

      /** Suggest preservation tasks from InventoryStore surplus. */
      suggestFromInventory: async () => {
        const inv = await getInventory();
        if (!inv || !inv.getInventoryItems) return [];
        const items = await inv.getInventoryItems(); // expected: [{ id, name, qty, unit, perishBy?, category? }, ...]
        const soon = new Date();
        soon.setDate(soon.getDate() + 5);
        const soonISO = soon.toISOString().slice(0, 10);

        const suggestions = [];
        for (const it of items) {
          const perish = it.perishBy ? toDateISO(it.perishBy) : undefined;
          const isSoon = perish && perish <= soonISO;
          const qty = Number(it.qty || 0);
          if (qty <= 0) continue;

          // naive heuristics → map produce to method & vessel
          let method = "waterbath";
          let vesselSize = "pint";
          if (/meat|broth|stock|beans/i.test(it.name)) method = "pressure";
          if (/quart/i.test(it.unit || "")) vesselSize = "quart";

          if (isSoon) {
            suggestions.push(
              mapTaskIn({
                produce: it.name,
                method,
                quantity: qty,
                unit: it.unit || "unit",
                dueDate: perish,
                durationMin: /pressure/.test(method) ? 90 : 50,
                vesselSize,
                batchCount: Math.max(1, Math.ceil(qty / 8)),
                linkedInventoryIds: [it.id],
              })
            );
          }
        }
        return suggestions.filter(Boolean);
      },

      /** Generate a weekend preservation plan respecting capacity & observance. */
      generateWeekendPlan: async () => {
        const settings = await getSettings();
        const cannerType =
          settings?.get("preservation.cannerType", "pressure") || "pressure";
        const capacity = settings?.get("preservation.capacity", {
          pint: 8,
          quart: 7,
          halfPint: 10,
        }) || { pint: 8, quart: 7, halfPint: 10 };
        const sabbathAware = !!settings?.get("observance.sabbathAware", true);

        // Choose target day: Sunday default
        const today = new Date();
        const dow = today.getDay();
        const sunDelta = (0 - dow + 7) % 7;
        const sundayISO = toDateISO(
          new Date(
            today.getFullYear(),
            today.getMonth(),
            today.getDate() + sunDelta
          )
        );
        const targetISO = sabbathAware ? sundayISO : sundayISO;

        // Pull suggestions & fold into a plan with batch sizing
        const suggestions = await get().suggestFromInventory();
        if (!suggestions.length) return [];

        const planned = [];
        suggestions.forEach((s) => {
          const cap = capacity[s.vesselSize || "pint"] || 8;
          const unitsPerBatch = cap; // jars per batch ~ capacity
          const batches = Math.max(
            1,
            Math.ceil(Number(s.quantity || 0) / unitsPerBatch)
          );
          planned.push(
            mapTaskIn({
              ...s,
              method: cannerType === "pressure" ? s.method : s.method, // keep suggestion's method; UI can highlight mismatch
              dueDate: targetISO,
              batchCount: batches,
            })
          );
        });

        return planned.filter(Boolean);
      },

      /** Commit generated tasks into the queue (append). */
      commitGeneratedTasks: (tasks = []) => {
        const mapped = tasks.map(mapTaskIn).filter(Boolean);
        if (!mapped.length) return;
        get().upsertPreservationTasks(mapped);
      },

      /** Mark task status by id. */
      setTaskStatus: (id, status) => {
        const allowed = new Set(["planned", "prepped", "done", "skipped"]);
        if (!allowed.has(status)) return;
        const prev = get().preservationQueue;
        const next = prev.map((t) => (t.id === id ? { ...t, status } : t));
        if (!arraysShallowEqual(prev, next)) set({ preservationQueue: next });
      },

      /** Lightweight selectors (pure reads) */
      getNeedsByCategory: () => {
        const list = get().storehouseNeeds;
        const map = {};
        list.forEach((n) => {
          const k = n.category || "uncategorized";
          (map[k] ||= []).push(n);
        });
        return map;
      },
      getUrgentNeeds: () => {
        const todayISO = toDateISO(new Date());
        return get().storehouseNeeds.filter(
          (n) =>
            (n.priority != null && n.priority <= 2) ||
            (n.neededBy && todayISO && n.neededBy <= todayISO)
        );
      },
      getTasksForDate: (iso) => {
        const key = toDateISO(iso);
        return get().preservationQueue.filter((t) => (t.dueDate || "") === key);
      },

      /** Consume planner estimate-inputs contracts and upsert actionable needs/tasks. */
      ingestPlannerEstimateInputsUpdated: (payload, meta = {}) => {
        const { estimateInputs } = normalizePlannerEstimateInputsPayload(payload);
        if (!estimateInputs) return { ok: false, error: "estimate_inputs_missing" };

        const mappedNeeds = mapEstimateInputsToStorehouseNeeds(estimateInputs);
        const mappedTasks = Array.isArray(estimateInputs?.preservation?.tasks)
          ? estimateInputs.preservation.tasks
          : [];

        if (mappedNeeds.length) {
          get().upsertNeeds(mappedNeeds);
        }
        if (mappedTasks.length) {
          get().upsertPreservationTasks(mappedTasks);
        }

        void meta;
        return {
          ok: true,
          needsCount: mappedNeeds.length,
          tasksCount: mappedTasks.length,
        };
      },

      /** Consume unified readiness and reprioritize urgent storehouse needs when prep is low. */
      ingestPlannerReadinessUpdated: (payload, meta = {}) => {
        const data =
          payload && typeof payload === "object" && payload.type && payload.data
            ? payload.data
            : payload;
        const readiness = isObj(data?.readiness) ? data.readiness : data;
        const score = Number(readiness?.score || 0);
        const status = norm(readiness?.status).toLowerCase();
        if (!Number.isFinite(score) && !status) {
          return { ok: false, error: "readiness_missing" };
        }

        set((prev) => ({
          ...prev,
          plannerSignals: {
            ...(isObj(prev?.plannerSignals) ? prev.plannerSignals : {}),
            lastReadiness: readiness,
            lastReadinessAt: new Date().toISOString(),
          },
        }));

        if (score < 45 || status === "needs prep") {
          set((prev) => ({
            ...prev,
            storehouseNeeds: (Array.isArray(prev.storehouseNeeds)
              ? prev.storehouseNeeds
              : []
            ).map((n) => {
              const category = norm(n?.category).toLowerCase();
              const source = norm(n?.source).toLowerCase();
              const shouldEscalate =
                source === "meal-planner" ||
                source === "planner-estimate" ||
                category === "garden-input" ||
                category === "animal-feed" ||
                category === "meal-planner";
              if (!shouldEscalate) return n;
              return {
                ...n,
                priority: 1,
                notes: n?.notes
                  ? `${n.notes} | Priority escalated from readiness signal.`
                  : "Priority escalated from readiness signal.",
              };
            }),
          }));
        }

        void meta;
        return { ok: true };
      },

      /** Consume planner gap contracts and promote hard deficits to actionable needs. */
      ingestPlannerGapsUpdated: (payload, meta = {}) => {
        const { plannerGaps } = normalizePlannerGapsPayload(payload);
        if (!plannerGaps) return { ok: false, error: "planner_gaps_missing" };

        const hardNeeds = mapHardGapsToStorehouseNeeds(plannerGaps);
        if (hardNeeds.length) {
          get().upsertNeeds(hardNeeds);
        }

        set((prev) => ({
          ...prev,
          plannerSignals: {
            ...(isObj(prev?.plannerSignals) ? prev.plannerSignals : {}),
            lastPlannerGaps: plannerGaps,
            lastPlannerGapsAt: new Date().toISOString(),
          },
        }));

        void meta;
        return {
          ok: true,
          hardGapCount: hardNeeds.length,
        };
      },
    }),
    {
      name: LS_KEY,
      version: VERSION,
      storage: createJSONStorage(() => localStorage),
      migrate: (persisted, ver) => {
        if (!persisted) return persisted;
        if (ver < 2) {
          const nn = Array.isArray(persisted.storehouseNeeds)
            ? persisted.storehouseNeeds
            : [];
          const pq = Array.isArray(persisted.preservationQueue)
            ? persisted.preservationQueue
            : [];
          persisted.storehouseNeeds = nn.map(mapNeedIn).filter(Boolean);
          persisted.preservationQueue = pq.map(mapTaskIn).filter(Boolean);
        }
        if (ver < 3) {
          persisted.plannerSignals = {
            lastReadiness: null,
            lastReadinessAt: null,
          };
        }
        if (ver < 4) {
          persisted.plannerSignals = {
            ...(persisted.plannerSignals || {}),
            lastPlannerGaps: null,
            lastPlannerGapsAt: null,
          };
        }
        return persisted;
      },
      partialize: (s) => ({
        storehouseNeeds: s.storehouseNeeds,
        preservationQueue: s.preservationQueue,
        plannerSignals: s.plannerSignals,
      }),
    }
  )
);

let _storehousePlannerEstimateInputsOff = null;
let _storehousePlannerReadinessOff = null;
let _storehousePlannerGapsOff = null;

export function initializeStorehousePlannerIngestors() {
  if (
    _storehousePlannerEstimateInputsOff &&
    _storehousePlannerReadinessOff &&
    _storehousePlannerGapsOff
  ) {
    return () => {
      try {
        _storehousePlannerEstimateInputsOff?.();
      } catch {
        // no-op
      }
      try {
        _storehousePlannerReadinessOff?.();
      } catch {
        // no-op
      }
      try {
        _storehousePlannerGapsOff?.();
      } catch {
        // no-op
      }
      _storehousePlannerEstimateInputsOff = null;
      _storehousePlannerReadinessOff = null;
      _storehousePlannerGapsOff = null;
    };
  }

  _storehousePlannerEstimateInputsOff = eventBus?.on?.(
    "planner.estimateInputs.updated",
    (payload) => {
      try {
        useStorehousePlannerStore
          .getState()
          .ingestPlannerEstimateInputsUpdated(payload, {
            source: "eventBus:planner.estimateInputs.updated",
          });
      } catch (e) {
        console.warn("[storehousePlannerStore] estimate-inputs ingest failed", e);
      }
    }
  );

  _storehousePlannerReadinessOff = eventBus?.on?.(
    "planner.readiness.updated",
    (payload) => {
      try {
        useStorehousePlannerStore.getState().ingestPlannerReadinessUpdated(payload, {
          source: "eventBus:planner.readiness.updated",
        });
      } catch (e) {
        console.warn("[storehousePlannerStore] readiness ingest failed", e);
      }
    }
  );

  _storehousePlannerGapsOff = eventBus?.on?.(
    "planner.gaps.updated",
    (payload) => {
      try {
        useStorehousePlannerStore.getState().ingestPlannerGapsUpdated(payload, {
          source: "eventBus:planner.gaps.updated",
        });
      } catch (e) {
        console.warn("[storehousePlannerStore] planner gaps ingest failed", e);
      }
    }
  );

  return () => {
    try {
      _storehousePlannerEstimateInputsOff?.();
    } catch {
      // no-op
    }
    try {
      _storehousePlannerReadinessOff?.();
    } catch {
      // no-op
    }
    try {
      _storehousePlannerGapsOff?.();
    } catch {
      // no-op
    }
    _storehousePlannerEstimateInputsOff = null;
    _storehousePlannerReadinessOff = null;
    _storehousePlannerGapsOff = null;
  };
}

if (typeof window !== "undefined") {
  try {
    initializeStorehousePlannerIngestors();
  } catch {
    // no-op: keep store usable if event bus is unavailable
  }
}

/* ---------------------------------------------
   Lean selectors for components (BC)
---------------------------------------------- */
export const useStorehouseNeeds = () =>
  useStorehousePlannerStore((s) => s.storehouseNeeds, shallow);

export const usePreservationQueue = () =>
  useStorehousePlannerStore((s) => s.preservationQueue, shallow);

export const useStorehousePlannerActions = () =>
  useStorehousePlannerStore(
    (s) => ({
      // BC actions
      setStorehouseNeeds: s.setStorehouseNeeds,
      setPreservationQueue: s.setPreservationQueue,
      addNeed: s.addNeed,
      removeNeed: s.removeNeed,
      clearNeeds: s.clearNeeds,
      addPreservationTask: s.addPreservationTask,
      removePreservationTask: s.removePreservationTask,
      clearPreservationQueue: s.clearPreservationQueue,
      // New optional actions
      upsertNeeds: s.upsertNeeds,
      upsertPreservationTasks: s.upsertPreservationTasks,
      importJson: s.importJson,
      exportJson: s.exportJson,
      getSummaries: s.getSummaries,
      suggestFromInventory: s.suggestFromInventory,
      generateWeekendPlan: s.generateWeekendPlan,
      commitGeneratedTasks: s.commitGeneratedTasks,
      setTaskStatus: s.setTaskStatus,
      getNeedsByCategory: s.getNeedsByCategory,
      getUrgentNeeds: s.getUrgentNeeds,
      getTasksForDate: s.getTasksForDate,
    }),
    shallow
  );

/* -------------------------------------------------------------------------- */
/* Compatibility exports (used by preservation templates)                      */
/* -------------------------------------------------------------------------- */

/**
 * addLotRecord
 * Generic hook for templates to record a completed/pending preservation lot.
 * Internally we store these as preservationQueue entries.
 */
export function addLotRecord(lot = {}) {
  const s = useStorehousePlannerStore.getState();
  const method = lot.method || lot.methodKey || lot.type || "preservation";
  return s.addPreservationTask({ ...lot, method });
}

/** Record curing/smoking lots */
export function addCureLot(lot = {}) {
  return addLotRecord({ ...lot, method: lot.method || "curing" });
}

/** Record dehydrating lots */
export function addDehydratedLot(lot = {}) {
  return addLotRecord({ ...lot, method: lot.method || "dehydrating" });
}

/** Record frozen items (can be a single lot or an array of items) */
export function addFrozenItems(items = [], meta = {}) {
  const list = Array.isArray(items) ? items : [items];
  const ids = [];
  list.forEach((it) => {
    ids.push(
      addLotRecord({
        ...meta,
        ...it,
        method: it.method || meta.method || "freezing",
      })
    );
  });
  return ids;
}

/* -------------------------------------------------------------------------- */
/* ✅ Named export required by src/ai/context/index.js                         */
/* -------------------------------------------------------------------------- */

export const StorehousePlannerStore = {
  useStorehousePlannerStore,
  useStorehouseNeeds,
  usePreservationQueue,
  useStorehousePlannerActions,

  // template helpers
  addLotRecord,
  addCureLot,
  addDehydratedLot,
  addFrozenItems,
};
