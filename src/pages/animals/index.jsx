// src/pages/animals/index.jsx
/* eslint-disable no-console */
import React, {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import "../../styles/household.css";

/**
 * Animals — Dashboard (resilient build) + “Now” Session launcher
 * ----------------------------------------------------------------------------
 * How this fits:
 * - Adds a prominent “▶ Now” button in the header that resolves the next
 *   runnable ANIMALS session from the Dexie-backed SessionsRepo (soft import).
 * - If multiple candidates exist, we show a small, user-friendly swap modal to
 *   pick which to run (it’s just a selector; the real SessionRunner modal is
 *   mounted at the app root and stays alive across navigation).
 * - Emits cataloged events via automation.emit and eventBus:
 *   session.started        (from global runner; we also listen and mirror state)
 *   session.step.changed   (listen-only)
 *   session.paused / session.resumed      (listen-only)
 *   session.completed / session.aborted   (listen-only)
 *   session.exported       (listen-only)
 *   session.open.requested (we emit to ask the app-root runner to open)
 * - If SessionsRepo is unavailable, we synthesize a minimal session from
 *   queued Animal tasks so users can “just press play.”
 * - Defensive checks everywhere, graceful fallbacks, and zero hard deps.
 *
 * Extensions added in this version:
 * - Users can mark **favorite sessions** (their own, not just system picks).
 * - Users can save **favorite schedules** from the projections/preservation
 *   plan (e.g., a winter butchery + preservation cadence).
 * - Cross-domain export: animals projections can be sent to Task Board,
 *   Calendar, Inventory, Meal Plan, Grocery Plan, and Butchery Plan so that
 *   Cleaning, Garden, Storehouse, and Meal Planning domains can orchestrate
 *   around the same data via shared events.
 *
 * New in this update:
 * - “Generate Animal Care Session” flow:
 *   • Fetches domain="animals" artifacts from the ArtifactVault.
 *   • Merges their StepGraphs into daily/weekly care sessions
 *     (feeding, watering, mucking, checks, meds, etc.).
 *   • Persists the generated session via SessionsRepo (when available).
 *   • Emits session.generated events and (optionally) exports to the Hub.
 *
 * NEW (Interactive module upgrade):
 * - Adds a persistent “Barn Tasks (Saved)” module backed by Dexie:
 *   • create / edit / delete
 *   • search + filter + sort
 *   • mark complete
 *   • optimistic UI updates + error states
 *   • emits standardized eventBus events on every mutation
 */

/** =============================================================================
 * 1) USER FLOWS (exactly what users can do on this page)
 * =============================================================================
 * Sessions ("Now"):
 * - Click ▶ Now: resolve next runnable animals session; if many, pick one.
 * - Favorite (☆/★) sessions in the picker; favorites show in "Your Favorites".
 * - Generate Daily/Weekly Care Session from ArtifactVault protocols.
 *
 * Planner:
 * - Enter household inputs, estimate animals, sync tasks to queue, recalc projections.
 * - Save projections as “Favorite Schedule”, export schedule to Calendar.
 *
 * Queue tasks (manager-backed):
 * - View pending animal tasks; mark tasks ✅ Done (delegates to AnimalQueueManager).
 *
 * Barn Tasks (Saved) (Dexie-backed, NEW):
 * - Add a saved barn task (title/category/due/priority/notes/tags).
 * - Edit an existing saved barn task.
 * - Delete a saved barn task.
 * - Search by text; filter by status/category; sort by due/updated/priority.
 * - Mark a saved barn task complete/incomplete.
 * - (Optional convenience) “Queue for today” → pushes a task into AnimalQueueManager.
 */

/** =============================================================================
 * 2) DATA CONTRACT (record schema this module reads/writes)
 * =============================================================================
 * Dexie table: animalCareItems
 *
 * AnimalCareItem {
 *   id: string,                 // primary key (uuid-like)
 *   householdId: string,         // partition key; defaults to "default"
 *   title: string,
 *   notes: string,
 *   category: "feeding"|"watering"|"mucking"|"checks"|"meds"|"general"|string,
 *   status: "open"|"done",
 *   priority: number,            // 1..3 (1 = high)
 *   dueAt: string|null,          // ISO timestamp
 *   tags: string[],              // lightweight labels
 *   source: { kind: string, refId: string|null }|null,
 *   createdAt: string,           // ISO timestamp
 *   updatedAt: string            // ISO timestamp
 * }
 */

/** =============================================================================
 * 3) STATE MODEL (local + derived + validation + optimistic + error)
 * =============================================================================
 * Local state:
 * - careItems[], careLoading, careError
 * - careForm (draft fields), careEditingId
 * - careQuery { search, status, category, sort }
 * - careSaving (mutation in flight)
 *
 * Derived state:
 * - careFilteredSorted (applies search/filter/sort)
 * - careCategories (from items)
 * - counts: open/done
 *
 * Validation:
 * - title required (min 2 chars)
 * - priority coerced to 1..3
 * - dueAt optional, must parse as date if present
 *
 * Optimistic UI:
 * - create: insert temp record (tmp_*) then replace or rollback on failure
 * - update: patch in place then rollback on failure
 * - delete: remove immediately then rollback on failure
 */

const noop = () => {};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// RFC3339/ISO ts maker
const iso = () => new Date().toISOString();

// Simple id generator (no deps)
function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 9)}`;
}

function safeJsonParse(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function getHouseholdId() {
  // best-effort; SSA can be single-household and still be correct
  try {
    return (
      localStorage.getItem("ssa.householdId") ||
      localStorage.getItem("householdId") ||
      "default"
    );
  } catch {
    return "default";
  }
}

/** ---------------------------------- Shims ---------------------------------- */

function createLocalBus() {
  const listeners = {};
  return {
    on(evt, cb) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(cb);
      return () =>
        (listeners[evt] = (listeners[evt] || []).filter((f) => f !== cb));
    },
    emit(evt, payload) {
      (listeners[evt] || []).forEach((cb) => {
        try {
          cb(payload);
        } catch (e) {
          console.warn("eventBus listener error:", e);
        }
      });
    },
  };
}

const safeAutomation = {
  runTemplate: async () => {
    throw new Error("automation runtime unavailable");
  },
  emit: noop,
};

/** ----------------------------- Dynamic loaders ----------------------------- */

// Generic dynamic importer that tries multiple candidate paths
async function tryImport(paths = []) {
  for (const p of paths) {
    try {
      const mod = await import(/* @vite-ignore */ p);
      if (mod) return mod;
    } catch (_) {
      /* keep trying */
    }
  }
  return null;
}

async function loadAutomation() {
  const mod = await tryImport([
    "@/services/automation/runtime",
    "../../services/automation/runtime",
    "../../../services/automation/runtime",
    "../../services/automation/index.js",
  ]);
  if (mod && mod.automation) return mod.automation;
  if (typeof window !== "undefined" && window.automation)
    return window.automation;
  return safeAutomation;
}

async function loadAQM() {
  const mod = await tryImport([
    "../../managers/AnimalQueueManager",
    "../../../managers/AnimalQueueManager",
    "@/managers/AnimalQueueManager",
    "../../managers/AnimalQueueManager/index.js",
  ]);
  return (mod && mod.default) || mod || null;
}

async function loadReminderManager() {
  const mod = await tryImport([
    "../../managers/ReminderManager",
    "../../../managers/ReminderManager",
    "@/managers/ReminderManager",
  ]);
  return (mod && mod.default) || mod || null;
}

async function loadInventoryMonitor() {
  const mod = await tryImport([
    "../../managers/InventoryMonitor",
    "../../../managers/InventoryMonitor",
    "@/managers/InventoryMonitor",
  ]);
  return (mod && mod.default) || mod || null;
}

/**
 * REQUIRED PATHS (new):
 * - "@/services/events/eventBus.js"
 * - "../../services/events/eventBus"
 *
 * Keep legacy fallbacks:
 * - "../../services/eventBus.js"
 * - "@/services/eventBus.js"
 */
async function loadEventBusOrShim() {
  const mod = await tryImport([
    "@/services/events/eventBus.js",
    "../../services/events/eventBus",
    "../../services/events/eventBus.js",
    "../../../services/events/eventBus",
    "../../services/eventBus.js",
    "../../../services/eventBus.js",
    "@/services/eventBus.js",
  ]);

  const candidate =
    (mod && (mod.eventBus || mod.default || mod)) || createLocalBus();

  // normalize shape to { on, emit }
  if (
    candidate &&
    typeof candidate.on === "function" &&
    typeof candidate.emit === "function"
  ) {
    return candidate;
  }
  if (
    candidate &&
    typeof candidate.addListener === "function" &&
    typeof candidate.emit === "function"
  ) {
    return {
      on: (evt, cb) => {
        candidate.addListener(evt, cb);
        return () => candidate.removeListener?.(evt, cb);
      },
      emit: (evt, payload) => candidate.emit(evt, payload),
    };
  }
  return createLocalBus();
}

async function loadNBAInvoker() {
  const mod = await tryImport([
    "../../services/nbaOrchestrator.js",
    "../../../services/nbaOrchestrator.js",
    "@/services/nbaOrchestrator.js",
  ]);
  return (mod && mod.invokeNBA) || noop;
}

async function loadSessionsRepo() {
  const mod = await tryImport([
    "@/data/SessionsRepo",
    "../../data/SessionsRepo",
    "../../../data/SessionsRepo",
    "@/services/SessionsRepo",
    "../../services/SessionsRepo",
  ]);
  return (mod && (mod.default || mod)) || null;
}

/**
 * NEW: Dexie db soft-import
 * We only READ/WRITE animalCareItems here. If db is missing or table absent,
 * we fall back to localStorage (still interactive; emits events; warns).
 */
async function loadDbSoft() {
  const mod = await tryImport([
    "@/db",
    "@/db/index.js",
    "../../db",
    "../../db/index.js",
    "../../../db",
    "../../../db/index.js",
    "@/services/db",
    "../../services/db",
  ]);
  const db =
    (mod && (mod.db || mod.default || mod)) ||
    (typeof window !== "undefined" && window.db) ||
    null;

  return db || null;
}

// LocalStorage fallback store (scoped by householdId)
const LS_CARE_KEY = (hid) => `animals.careItems.v1.${hid}`;

function lsReadCare(hid) {
  try {
    return safeJsonParse(localStorage.getItem(LS_CARE_KEY(hid)), []);
  } catch {
    return [];
  }
}
function lsWriteCare(hid, items) {
  try {
    localStorage.setItem(LS_CARE_KEY(hid), JSON.stringify(items || []));
    return true;
  } catch {
    return false;
  }
}

function hasDexieTable(db, name) {
  try {
    if (!db || !Array.isArray(db.tables)) return false;
    return db.tables.some((t) => t && t.name === name);
  } catch {
    return false;
  }
}

function getTable(db, name) {
  try {
    if (!db || typeof db.table !== "function") return null;
    return db.table(name);
  } catch {
    return null;
  }
}

async function safeListCareItems({ db, householdId }) {
  const TABLE = "animalCareItems";
  try {
    if (db && hasDexieTable(db, TABLE)) {
      const t = getTable(db, TABLE);
      if (!t) throw new Error("table accessor missing");
      const rows = await t.where("householdId").equals(householdId).toArray();
      return Array.isArray(rows) ? rows : [];
    }
  } catch (e) {
    console.warn("[Animals] Dexie list failed; falling back to LS:", e);
  }
  return lsReadCare(householdId);
}

async function safePutCareItem({ db, householdId, record }) {
  const TABLE = "animalCareItems";
  const next = { ...record, householdId };
  try {
    if (db && hasDexieTable(db, TABLE)) {
      const t = getTable(db, TABLE);
      await t.put(next);
      return next;
    }
  } catch (e) {
    console.warn("[Animals] Dexie put failed; falling back to LS:", e);
  }

  // LS fallback
  const rows = lsReadCare(householdId);
  const idx = rows.findIndex((r) => r && r.id === next.id);
  if (idx >= 0) rows[idx] = next;
  else rows.unshift(next);
  lsWriteCare(householdId, rows);
  return next;
}

async function safeDeleteCareItem({ db, householdId, id }) {
  const TABLE = "animalCareItems";
  try {
    if (db && hasDexieTable(db, TABLE)) {
      const t = getTable(db, TABLE);
      await t.delete(id);
      return true;
    }
  } catch (e) {
    console.warn("[Animals] Dexie delete failed; falling back to LS:", e);
  }

  const rows = lsReadCare(householdId).filter((r) => r && r.id !== id);
  lsWriteCare(householdId, rows);
  return true;
}

async function seedCareItemsIfEmpty({ db, householdId }) {
  // “seed handling if table missing”:
  // - if Dexie table exists but empty, seed there
  // - if Dexie table missing, seed localStorage fallback so module stays usable
  const seeds = [
    {
      id: uid("care"),
      householdId,
      title: "AM feed + water check",
      notes: "Walk line: feeders, waterers, quick health scan.",
      category: "feeding",
      status: "open",
      priority: 2,
      dueAt: null,
      tags: ["daily"],
      source: { kind: "seed", refId: null },
      createdAt: iso(),
      updatedAt: iso(),
    },
    {
      id: uid("care"),
      householdId,
      title: "PM lock-up + predator check",
      notes: "Close coop/barn, check latches, quick perimeter scan.",
      category: "checks",
      status: "open",
      priority: 2,
      dueAt: null,
      tags: ["daily"],
      source: { kind: "seed", refId: null },
      createdAt: iso(),
      updatedAt: iso(),
    },
  ];

  const TABLE = "animalCareItems";
  try {
    if (db && hasDexieTable(db, TABLE)) {
      const t = getTable(db, TABLE);
      const count = await t.where("householdId").equals(householdId).count();
      if (count === 0) {
        await t.bulkPut(seeds);
        return { seeded: true, via: "dexie", count: seeds.length };
      }
      return { seeded: false, via: "dexie", count };
    }
  } catch (e) {
    console.warn("[Animals] Dexie seed failed; falling back to LS:", e);
  }

  const rows = lsReadCare(householdId);
  if (!rows || rows.length === 0) {
    lsWriteCare(householdId, seeds);
    return { seeded: true, via: "localStorage", count: seeds.length };
  }
  return { seeded: false, via: "localStorage", count: rows.length };
}

/**
 * Load animal-care artifacts from the ArtifactVault.
 * We keep this defensive and tolerant of different repo APIs.
 */
async function loadAnimalArtifacts() {
  const mod = await tryImport([
    "@/services/artifacts/ArtifactVaultRepo",
    "../../services/artifacts/ArtifactVaultRepo",
    "../../../services/artifacts/ArtifactVaultRepo",
  ]);
  if (!mod) return [];

  const repo =
    (mod.default || mod) && (mod.default || mod).loadArtifactsFromVault
      ? mod.default || mod
      : mod;

  const fn =
    repo.loadArtifactsFromVault ||
    repo.listArtifacts ||
    repo.listByDomain ||
    repo.getByDomain;

  if (typeof fn !== "function") return [];

  try {
    const res = await fn({ domain: "animals" });
    if (Array.isArray(res)) return res;
    if (Array.isArray(res?.items)) return res.items;
    return [];
  } catch (e) {
    console.warn("[Animals] loadAnimalArtifacts failed:", e);
    return [];
  }
}

/** ------------------------------ Hub export helper -------------------------- */

/**
 * exportToHubIfEnabled
 * - Used when this page generates sessions (household data).
 * - Respects featureFlags.familyFundMode.
 * - Uses HubPacketFormatter + FamilyFundConnector if available.
 * - Fails silently on any error.
 *
 * This is the final stage of the pipeline:
 * imports → intelligence → automation → (optional) hub export
 */
let hubDepsLoaded = false;
let hubFeatureFlags = null;
let hubFormatter = null;
let hubConnector = null;

async function ensureHubDepsLoaded() {
  if (hubDepsLoaded) return;
  try {
    const [ffMod, fmtMod, connMod] = await Promise.all([
      tryImport([
        "@/services/featureFlags",
        "../../services/featureFlags",
        "../../../services/featureFlags",
      ]),
      tryImport([
        "@/services/hub/HubPacketFormatter",
        "../../services/hub/HubPacketFormatter",
        "../../../services/hub/HubPacketFormatter",
      ]),
      tryImport([
        "@/services/hub/FamilyFundConnector",
        "../../services/hub/FamilyFundConnector",
        "../../../services/hub/FamilyFundConnector",
      ]),
    ]);

    const ff = ffMod && (ffMod.featureFlags || ffMod.default || ffMod);
    hubFeatureFlags = ff || { familyFundMode: false };

    hubFormatter = (fmtMod && (fmtMod.default || fmtMod)) || null;
    hubConnector = (connMod && (connMod.default || connMod)) || null;
  } catch (e) {
    console.warn("[Animals] ensureHubDepsLoaded failed:", e);
    hubFeatureFlags = hubFeatureFlags || { familyFundMode: false };
  } finally {
    hubDepsLoaded = true;
  }
}

async function exportToHubIfEnabled(payload) {
  try {
    await ensureHubDepsLoaded();
    if (!hubFeatureFlags?.familyFundMode) return;
    if (!hubFormatter || !hubConnector) return;

    const formatterFn =
      hubFormatter.formatSession ||
      hubFormatter.format ||
      hubFormatter.default ||
      hubFormatter;
    const connectorFn =
      hubConnector.send ||
      hubConnector.export ||
      hubConnector.default ||
      hubConnector;

    if (
      typeof formatterFn !== "function" ||
      typeof connectorFn !== "function"
    ) {
      return;
    }

    const packet = formatterFn(payload);
    await connectorFn(packet);
  } catch (e) {
    console.warn("[Animals] exportToHubIfEnabled failed:", e);
  }
}

/** ------------------------------ Safe wrappers ------------------------------ */

function resolveAQM(mod) {
  return mod && mod.default ? mod.default : mod;
}

async function getQueueSafe(AQM) {
  const M = resolveAQM(AQM) || {};
  try {
    if (typeof M.getQueue === "function") return await M.getQueue();
    if (typeof M.get === "function") return (await M.get("queue")) || [];
    if (Array.isArray(M.queue)) return M.queue;
  } catch (e) {
    console.warn("AnimalQueueManager getQueue failed:", e);
  }
  return [];
}

async function addTasksSafe(AQM, tasks = []) {
  const M = resolveAQM(AQM) || {};
  try {
    if (typeof M.addTasks === "function") return await M.addTasks(tasks);
  } catch (e) {
    console.warn("AnimalQueueManager addTasks failed:", e);
  }
  return [];
}

async function completeTaskSafe(AQM, taskId) {
  const M = resolveAQM(AQM) || {};
  try {
    if (typeof M.completeTask === "function")
      return await M.completeTask(taskId);
    if (typeof M.complete === "function") return await M.complete(taskId);
    if (typeof M.markDone === "function") return await M.markDone(taskId);
  } catch (e) {
    console.warn("AnimalQueueManager complete failed:", e);
  }
}

async function runTemplateSafe(
  automation,
  name,
  payload,
  { timeoutMs = 12000, retry = 1 } = {}
) {
  const runOnce = () =>
    Promise.race([
      automation.runTemplate && automation.runTemplate(name, payload),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error("timeout")), timeoutMs)
      ),
    ]);

  try {
    return await runOnce();
  } catch (e) {
    if (retry > 0) {
      try {
        return await runOnce();
      } catch {}
    }
    throw e;
  }
}

/** ------------------------------ Fallback math ----------------------------- */

function deriveAnimals({ plan, tasks = [] }) {
  const out = [];

  if (plan && Array.isArray(plan.animals)) {
    plan.animals.forEach((a) => {
      const type = String(
        (a && a.type) || (a && a.breed) || (a && a.name) || "animal"
      ).toLowerCase();
      const count = Number(
        (a && a.count) || (a && a.qty) || (a && a.headcount) || 0
      );
      if (count > 0) out.push({ type, count });
    });
  }

  tasks.forEach((t) => {
    const text = [t && t.name, t && t.description].filter(Boolean).join(" ");
    const m = String(text).match(
      /(\d+)\s+(chickens?|hens?|layers?|broilers?|ducks?|goats?|cows?|rabbits?)/i
    );
    if (m) out.push({ type: m[2].toLowerCase(), count: Number(m[1]) });
  });

  const map = new Map();
  out.forEach(({ type, count }) => {
    const key =
      type.indexOf("layer") >= 0 ||
      type.indexOf("hen") >= 0 ||
      type.indexOf("chicken") >= 0
        ? "chicken"
        : type.indexOf("broiler") >= 0
        ? "broiler"
        : type.indexOf("duck") >= 0
        ? "duck"
        : type.indexOf("goat") >= 0
        ? "goat"
        : type.indexOf("cow") >= 0
        ? "cow"
        : type.indexOf("rabbit") >= 0
        ? "rabbit"
        : type;
    map.set(key, (map.get(key) || 0) + count);
  });

  return Array.from(map, ([type, count]) => ({ type, count }));
}

function simpleProduction(animals) {
  const weekly = { eggs: 0, milkL: 0, meatKg: 0 };
  animals.forEach(({ type, count }) => {
    if (!count) return;
    if (type === "chicken") weekly.eggs += count * 5;
    if (type === "duck") weekly.eggs += count * 4;
    if (type === "goat") weekly.milkL += count * 14; // ~2 L/day
    if (type === "cow") weekly.milkL += count * 84; // ~12 L/day
    if (type === "broiler") weekly.meatKg += count * 0.5;
    if (type === "rabbit") weekly.meatKg += count * 0.2;
  });
  return weekly;
}

function offSeasonWeeks(animals) {
  const hasLayers = animals.some(
    (a) => a.type === "chicken" || a.type === "duck"
  );
  return hasLayers ? 12 : 8;
}

function compareToDemand(weeklyOut, demand, householdSize) {
  const need = {
    eggs:
      (Number(demand.eggsPerPersonPerDay) || 0) *
      (Number(householdSize) || 0) *
      7,
    milkL:
      (Number(demand.milkLPerPersonPerWeek) || 0) *
      (Number(householdSize) || 0),
    meatKg:
      (Number(demand.meatKgPerPersonPerWeek) || 0) *
      (Number(householdSize) || 0),
  };

  const delta = {
    eggs: weeklyOut.eggs - need.eggs,
    milkL: weeklyOut.milkL - need.milkL,
    meatKg: weeklyOut.meatKg - need.meatKg,
  };

  return { need, delta };
}

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(100, n);
}

function applyCollectionLosses(weeklyOut, collectionLoss) {
  const eggsEff = 1 - clampPct(collectionLoss.eggsLossPct) / 100;
  const milkEff = 1 - clampPct(collectionLoss.milkLossPct) / 100;
  const meatEff = 1 - clampPct(collectionLoss.meatLossPct) / 100;
  return {
    eggs: weeklyOut.eggs * eggsEff,
    milkL: weeklyOut.milkL * milkEff,
    meatKg: weeklyOut.meatKg * meatEff,
  };
}

function preservationPlan(
  weeklyOutEffective,
  need,
  winterWeeks,
  preservationLoss
) {
  const presEff = {
    eggs: 1 - clampPct(preservationLoss.eggsLossPct) / 100,
    milkL: 1 - clampPct(preservationLoss.milkLossPct) / 100,
    meatKg: 1 - clampPct(preservationLoss.meatLossPct) / 100,
  };

  const plan = [];

  const surplus = {
    eggs: Math.max(0, weeklyOutEffective.eggs - need.eggs),
    milkL: Math.max(0, weeklyOutEffective.milkL - need.milkL),
    meatKg: Math.max(0, weeklyOutEffective.meatKg - need.meatKg),
  };

  if (surplus.eggs > 0) {
    plan.push({
      item: "eggs",
      perWeekToPutUp: Math.min(surplus.eggs, need.eggs) * presEff.eggs,
      weeksToCover: winterWeeks,
      methods: ["water-glass (lime)", "freeze raw (beaten)", "freeze-dry"],
      note: "Water-glassed eggs hold ~6–8 months in cool, dark storage.",
    });
  }

  if (surplus.milkL > 0) {
    plan.push({
      item: "milk",
      perWeekToPutUp: Math.min(surplus.milkL, need.milkL) * presEff.milkL,
      weeksToCover: winterWeeks,
      methods: [
        "hard cheese",
        "yogurt",
        "clarified butter (ghee)",
        "pressure-canned milk*",
      ],
      note: "Prefer cultured/hard cheeses for long storage; follow safe canning guidance.",
    });
  }

  if (surplus.meatKg > 0) {
    plan.push({
      item: "meat",
      perWeekToPutUp: Math.min(surplus.meatKg, need.meatKg) * presEff.meatKg,
      weeksToCover: winterWeeks,
      methods: ["freeze", "pressure-can", "jerky/biltong", "confits/rillettes"],
      note: "Rotate frozen stocks (FIFO). Pressure-canned shelf-stable meats are great for outages.",
    });
  }

  return { surplus, plan };
}

function mergeAnimals(a = [], b = []) {
  const map = new Map();
  [...a, ...b].forEach(({ type, count }) => {
    if (!type || !Number(count)) return;
    const key = String(type).toLowerCase().trim();
    map.set(key, (map.get(key) || 0) + Number(count));
  });
  return Array.from(map, ([type, count]) => ({ type, count }));
}

/** ---------------------------- Session helpers (NEW) ------------------------ */

/**
 * Filter sessions that are runnable given lightweight guards.
 * (Extend with Sabbath/QuietHours/Weather guards if needed.)
 */
function filterRunnable(sessions = []) {
  return (sessions || []).filter((s) => {
    if (!s || s.domain !== "animals") return false;
    if (!Array.isArray(s.steps) || s.steps.length === 0) return false;
    if (
      s.status &&
      s.status !== "pending" &&
      s.status !== "paused" &&
      s.status !== "running"
    )
      return false;
    return true;
  });
}

/** Build a synthetic session from queued animal tasks when no saved session exists. */
function buildSynthSession(tasks = []) {
  const steps = (tasks || []).slice(0, 6).map((t, idx) => ({
    id: String(t?.id ?? `step_${idx + 1}`),
    title: String(t?.name ?? "Animal care task"),
    desc: String(t?.description ?? ""),
    durationSec: Number(t?.durationSec ?? 300),
    blockers: Array.isArray(t?.blockers) ? t.blockers : ["inventory"],
    metadata: {
      tempTargetF: 0,
      donenessCue: "timer",
      cueNotes: "",
    },
  }));

  const now = iso();

  return {
    id: `synth-animals-${now}`,
    domain: "animals",
    title: "Animal Care (Quick Run)",
    source: { type: "manual", refId: null },
    steps,
    prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: { skippedSteps: [], adjustments: [] },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Classify a normalized animal-care step based on its text.
 * Used when merging StepGraphs from animal-care protocols.
 */
function classifyAnimalStepCategory(text = "") {
  const t = text.toLowerCase();
  if (/(feed|grain|pellet|ration|hay|pasture)/i.test(t)) return "feeding";
  if (/(water|trough|bucket|drink)/i.test(t)) return "watering";
  if (/(muck|shovel|bedding|manure|deep clean|clean stall)/i.test(t))
    return "mucking";
  if (/(check|inspect|observe|walk|monitor|look over)/i.test(t))
    return "checks";
  if (/(med|vaccine|vaccinate|worm|dose|treat|drug)/i.test(t)) return "meds";
  return "general";
}

/**
 * Merge StepGraphs from domain="animals" artifacts into a care session.
 * - cadence = "daily" focuses on feeding, watering, checks, meds.
 * - cadence = "weekly" includes mucking/deep-clean and heavier tasks.
 */
function buildCareSessionFromArtifacts(artifacts = [], cadence = "daily") {
  const allSteps = [];

  (artifacts || []).forEach((artifact) => {
    if (!artifact) return;

    const graphs = [];
    if (Array.isArray(artifact.stepGraphs)) graphs.push(...artifact.stepGraphs);
    if (artifact.stepGraph) graphs.push(artifact.stepGraph);
    if (Array.isArray(artifact.steps)) graphs.push(artifact.steps);

    graphs.forEach((graph) => {
      if (!Array.isArray(graph)) return;
      graph.forEach((rawStep, idx) => {
        if (!rawStep) return;

        const title =
          rawStep.title || rawStep.label || rawStep.name || "Animal care step";
        const desc = rawStep.desc || rawStep.description || "";
        const baseId =
          rawStep.id ||
          `${artifact.id || artifact._id || "artifact"}_${idx}_${title}`;
        const textForCat =
          (title || "") +
          " " +
          (desc || "") +
          " " +
          (rawStep.category || "") +
          " " +
          (rawStep.kind || "");

        const category = classifyAnimalStepCategory(textForCat);

        const normalized = {
          id: String(baseId),
          title: String(title),
          desc: String(desc),
          durationSec: Number(
            rawStep.durationSec ||
              rawStep.estimatedSeconds ||
              rawStep.estimatedDurationSec ||
              300
          ),
          blockers: Array.isArray(rawStep.blockers)
            ? rawStep.blockers
            : ["inventory"],
          metadata: {
            category,
            cadenceHint: rawStep.cadence || rawStep.frequency || null,
            sourceArtifactId: artifact.id || artifact._id || null,
          },
        };

        allSteps.push(normalized);
      });
    });
  });

  if (!allSteps.length) return null;

  const dailyCategories = new Set(["feeding", "watering", "checks", "meds"]);

  const filteredSteps =
    cadence === "daily"
      ? allSteps.filter((s) => dailyCategories.has(s.metadata.category))
      : allSteps;

  if (!filteredSteps.length) return null;

  const now = iso();

  return {
    id: `animals-${cadence}-${now}`,
    domain: "animals",
    title: cadence === "daily" ? "Daily Barn Run" : "Weekly Barn Deep Care",
    source: { type: "animals.vault", refId: null },
    steps: filteredSteps.map((s, i) => ({
      ...s,
      order: i,
    })),
    prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null,
    },
    analytics: { skippedSteps: [], adjustments: [] },
    createdAt: now,
    updatedAt: now,
  };
}

/** ---------------------------- hooks & helpers ---------------------------- */

const LS_KEY = "animals.dashboard.inputs.v3"; // bumped to avoid old drafts
// NEW: local storage keys for user favorites
const FAV_SESS_KEY = "animals.favorite.sessions.v1";
const FAV_SCHED_KEY = "animals.favorite.schedules.v1";

function loadDraft() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadFavSessionIds() {
  try {
    const raw = localStorage.getItem(FAV_SESS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function loadFavSchedules() {
  try {
    const raw = localStorage.getItem(FAV_SCHED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function useDebouncedAutosave(valueMap, delayMs = 300) {
  const vRef = useRef(valueMap);

  useEffect(() => {
    vRef.current = valueMap;
  }, [valueMap]);

  useEffect(() => {
    const id = setTimeout(() => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(vRef.current));
      } catch {}
    }, delayMs);
    return () => clearTimeout(id);
  }, [valueMap, delayMs]);
}

function useKey(key, handler) {
  useEffect(() => {
    const fn = (e) => {
      if ((e.key || "").toLowerCase() === key.toLowerCase()) handler(e);
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [key, handler]);
}

/** -------------------------------- UI atoms -------------------------------- */

function Field({ label, children, hint }) {
  return (
    <label className="sv-field">
      {label ? <span className="sv-field__label">{label}</span> : null}
      {children}
      {hint ? <span className="sv-caption">{hint}</span> : null}
    </label>
  );
}

function Chip({ children, onRemove }) {
  return (
    <span className="sv-chip">
      <span>{children}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          className="sv-btn sv-btn--ghost sv-btn--sm"
          aria-label="remove"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

function Toast({ toast, onUndo, onClose }) {
  if (!toast) return null;
  return (
    <div className="sv-toastWrap">
      <div className="sv-toast sv-toast--info" role="status">
        <div className="sv-toast__content">
          <div className="sv-strong">{toast.title}</div>
          <div className="sv-caption">{toast.message}</div>
        </div>
        <div className="sv-row sv-gap">
          {toast.canUndo ? (
            <button
              className="sv-btn sv-btn--outline sv-btn--sm"
              onClick={() => onUndo && onUndo(toast)}
            >
              Undo
            </button>
          ) : null}
          <button
            className="sv-btn sv-btn--ghost sv-btn--sm"
            aria-label="close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}

function Skeleton({ className = "" }) {
  return <div className={`sv-skeleton ${className}`} />;
}

/** ----------------------- Swap modal (session selector) ---------------------- */

function SessionSwapModal({
  open,
  onClose,
  sessions = [],
  onPick,
  isFavorite = () => false,
  onToggleFavorite = () => {},
}) {
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="sv-modal"
      style={{ zIndex: 90 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="sv-card sv-pad" style={{ width: 520, maxWidth: "92vw" }}>
        <div className="sv-row sv-justify-between sv-align-center sv-gap-sm">
          <div className="sv-strong">Choose a session to run</div>
          <button
            className="sv-btn sv-btn--ghost sv-btn--sm"
            onClick={onClose}
            aria-label="close"
          >
            ×
          </button>
        </div>

        <p className="sv-caption" style={{ marginTop: 4 }}>
          Your sessions will keep running in the background if you navigate
          away. You can reopen the control HUD anytime.
        </p>

        <ul
          className="sv-stack"
          style={{ marginTop: 12, maxHeight: "50vh", overflow: "auto" }}
        >
          {sessions.map((s) => {
            const fav = isFavorite(s);
            return (
              <li
                key={s.id}
                className="sv-row sv-justify-between sv-align-center sv-card sv-pad"
                style={{ borderRadius: 12 }}
              >
                <div>
                  <div className="sv-row sv-gap-sm sv-align-center">
                    <div className="sv-strong">
                      {s.title || "Animal Session"}
                    </div>
                    <button
                      type="button"
                      className="sv-btn sv-btn--ghost sv-btn--sm"
                      onClick={() => onToggleFavorite(s)}
                      title={
                        fav
                          ? "Remove from favorites"
                          : "Save as favorite routine"
                      }
                    >
                      {fav ? "★" : "☆"}
                    </button>
                  </div>
                  <div className="sv-caption">
                    {Array.isArray(s.steps)
                      ? `${s.steps.length} step(s)`
                      : "No steps"}{" "}
                    · {s.status || "pending"}
                  </div>
                </div>

                <button
                  className="sv-btn sv-btn--primary sv-btn--sm"
                  onClick={() => onPick?.(s)}
                >
                  Play
                </button>
              </li>
            );
          })}
        </ul>

        <div className="sv-caption" style={{ marginTop: 8 }}>
          Tip: Use hardware media buttons (Next/Pause) if supported, or keyboard
          shortcuts in the runner (Space/N/P).
        </div>
      </div>
    </div>
  );
}

/** ---------------------------- “Now” HUD (mini) ----------------------------- */

function SessionHud({ active, onPause, onNext, onOpen }) {
  if (!active) return null;
  return (
    <div className="sv-hud">
      <div className="sv-card sv-pad">
        <div className="sv-caption caps">Session running</div>
        <div className="sv-strong sv-ellipsis">
          {active.title || "Animal Session"}
        </div>
        <div className="sv-caption">
          Step {Number(active.progress?.currentStepIndex ?? 0) + 1} /{" "}
          {Array.isArray(active.steps) ? active.steps.length : 0}
        </div>
        <div className="sv-row sv-gap-sm" style={{ marginTop: 8 }}>
          <button
            className="sv-btn sv-btn--outline sv-btn--sm"
            onClick={onOpen}
          >
            Open Controls
          </button>
          <button
            className="sv-btn sv-btn--outline sv-btn--sm"
            onClick={onPause}
          >
            Pause/Resume
          </button>
          <button
            className="sv-btn sv-btn--outline sv-btn--sm"
            onClick={onNext}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}

/** -------------------------------- Component ------------------------------- */

export default function AnimalDashboard() {
  const saved = loadDraft();

  const householdId = useMemo(() => getHouseholdId(), []);

  // Dynamic modules
  const [automation, setAutomation] = useState(safeAutomation);
  const AQMRef = useRef(null);
  const reminderRef = useRef(null);
  const inventoryRef = useRef(null);
  const [eventBus, setEventBus] = useState(createLocalBus());
  const [invokeNBA, setInvokeNBA] = useState(() => noop);
  const sessionsRepoRef = useRef(null);

  // NEW: Dexie db ref for this module
  const dbRef = useRef(null);

  // NEW: cached sessions list so we can show + favorite "routines"
  const [savedSessions, setSavedSessions] = useState([]);

  // Load optional modules
  useEffect(() => {
    (async () => {
      const [auto, aqm, rem, inv, bus, nba, srepo, db] = await Promise.all([
        loadAutomation().catch(() => safeAutomation),
        loadAQM().catch(() => null),
        loadReminderManager().catch(() => null),
        loadInventoryMonitor().catch(() => null),
        loadEventBusOrShim().catch(() => createLocalBus()),
        loadNBAInvoker().catch(() => noop),
        loadSessionsRepo().catch(() => null),
        loadDbSoft().catch(() => null),
      ]);

      setAutomation(auto || safeAutomation);
      AQMRef.current = aqm;
      reminderRef.current = rem;
      inventoryRef.current = inv;
      setEventBus(bus || createLocalBus());
      setInvokeNBA(() => nba || noop);
      sessionsRepoRef.current = srepo;

      dbRef.current = db || null;

      // After core services are loaded, try to pull a first sessions snapshot
      try {
        const repo = sessionsRepoRef.current;
        let sessions = [];
        if (repo?.listByDomain) {
          const list = await repo.listByDomain("animals");
          sessions = filterRunnable(list || []);
        } else if (repo?.getNextRunnableSession) {
          const s = await repo.getNextRunnableSession("animals");
          sessions = s ? [s] : [];
        }

        if (!sessions.length) {
          const queue = await getQueueSafe(AQMRef.current);
          if (Array.isArray(queue) && queue.length) {
            sessions = [buildSynthSession(queue)];
          }
        }

        setSavedSessions(Array.isArray(sessions) ? sessions : []);
      } catch {
        setSavedSessions([]);
      }
    })();
  }, []);

  const [animalTasks, setAnimalTasks] = useState([]);
  const [animalReminders, setAnimalReminders] = useState([]);
  const [lowSupplies, setLowSupplies] = useState([]);

  // Planner inputs
  const [householdSize, setHouseholdSize] = useState(saved?.householdSize ?? 4);
  const [landArea, setLandArea] = useState(saved?.landArea ?? "0.5");
  const [outputsWanted, setOutputsWanted] = useState(
    saved?.outputsWanted ?? ["eggs", "milk", "meat"]
  );
  const [constraints, setConstraints] = useState(saved?.constraints ?? "");
  const [notes, setNotes] = useState(saved?.notes ?? "");
  const [demand, setDemand] = useState(
    saved?.demand ?? {
      eggsPerPersonPerDay: 1,
      milkLPerPersonPerWeek: 2,
      meatKgPerPersonPerWeek: 0.3,
    }
  );
  const [collectionLoss, setCollectionLoss] = useState(
    saved?.collectionLoss ?? {
      eggsLossPct: 8,
      milkLossPct: 5,
      meatLossPct: 10,
    }
  );
  const [preservationLoss, setPreservationLoss] = useState(
    saved?.preservationLoss ?? {
      eggsLossPct: 10,
      milkLossPct: 8,
      meatLossPct: 5,
    }
  );
  const [quickAnimals, setQuickAnimals] = useState(saved?.quickAnimals ?? []);
  const quickDraftRef = useRef("");
  const [stockingPlan, setStockingPlan] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [lastOutput, setLastOutput] = useState(null);
  const [projections, setProjections] = useState(null);
  const [projDebug, setProjDebug] = useState(null);

  // NEW: user favorites
  const [favoriteSessionIds, setFavoriteSessionIds] = useState(
    loadFavSessionIds()
  );
  const [favoriteSchedules, setFavoriteSchedules] = useState(
    loadFavSchedules()
  );

  // Toasts
  const [toast, setToast] = useState(null);
  const raiseToast = (title, message, canUndo = false) =>
    setToast({
      id: `t_${Math.random()}`,
      title,
      message,
      canUndo,
    });
  const dismissToast = () => setToast(null);

  const undoLastQuick = () => {
    setQuickAnimals((prev) => prev.slice(0, -1));
    dismissToast();
  };

  // Load initial data
  useEffect(() => {
    (async () => {
      const tasks = await getQueueSafe(AQMRef.current);
      let reminders = [];
      let low = [];
      try {
        reminders = await (reminderRef.current?.getAnimalReminders?.() || []);
      } catch {}
      try {
        low = await (inventoryRef.current?.getLowAnimalInventory?.() || []);
      } catch {}
      setAnimalTasks(Array.isArray(tasks) ? tasks : []);
      setAnimalReminders(Array.isArray(reminders) ? reminders : []);
      setLowSupplies(Array.isArray(low) ? low : []);
    })();
  }, [automation]);

  // Autosave (inputs)
  useDebouncedAutosave(
    {
      householdSize,
      landArea,
      outputsWanted,
      constraints,
      notes,
      demand,
      collectionLoss,
      preservationLoss,
      quickAnimals,
    },
    400
  );

  // Autosave favorites
  useEffect(() => {
    try {
      localStorage.setItem(FAV_SESS_KEY, JSON.stringify(favoriteSessionIds));
    } catch {}
  }, [favoriteSessionIds]);

  useEffect(() => {
    try {
      localStorage.setItem(FAV_SCHED_KEY, JSON.stringify(favoriteSchedules));
    } catch {}
  }, [favoriteSchedules]);

  /** ---------------------------- Runner integration ------------------------- */

  const [swapOpen, setSwapOpen] = useState(false);
  const [swapSessions, setSwapSessions] = useState([]);
  const [activeSession, setActiveSession] = useState(null); // mirror of the currently running animals session

  // Listen to session lifecycle from the global SessionRunner (mounted at app root)
  useEffect(() => {
    const off1 = eventBus.on("session.started", (e) => {
      const s = e && (e.data || e.payload);
      if (s && s.domain === "animals") setActiveSession(s);
    });

    const off2 = eventBus.on("session.step.changed", (e) => {
      const s = e && (e.data || e.payload);
      if (s && s.domain === "animals")
        setActiveSession((prev) =>
          prev && prev.id === s.id ? { ...prev, progress: s.progress } : prev
        );
    });

    const off3 = eventBus.on("session.paused", () => {});
    const off4 = eventBus.on("session.resumed", () => {});
    const off5 = eventBus.on("session.completed", (e) => {
      const s = e && (e.data || e.payload);
      if (s && s.domain === "animals") setActiveSession(null);
    });
    const off6 = eventBus.on("session.aborted", (e) => {
      const s = e && (e.data || e.payload);
      if (s && s.domain === "animals") setActiveSession(null);
    });

    return () => {
      off1();
      off2();
      off3();
      off4();
      off5();
      off6();
    };
  }, [eventBus]);

  // Ask SessionsRepo for candidates, else synthesize from queue
  const resolveNowCandidates = useCallback(async () => {
    const repo = sessionsRepoRef.current;
    let sessions = [];
    try {
      if (repo?.listByDomain) {
        const list = await repo.listByDomain("animals");
        sessions = filterRunnable(list || []);
      } else if (repo?.getNextRunnableSession) {
        const s = await repo.getNextRunnableSession("animals");
        sessions = s ? [s] : [];
      }
    } catch (e) {
      console.warn("SessionsRepo not available or failed:", e);
    }

    if (sessions.length === 0) {
      // Build a synthetic one from current animal tasks
      const queue = await getQueueSafe(AQMRef.current);
      if (Array.isArray(queue) && queue.length) {
        const synth = buildSynthSession(queue);
        sessions = [synth];
      }
    }

    return sessions;
  }, []);

  const refreshSessionsList = useCallback(async () => {
    try {
      const sessions = await resolveNowCandidates();
      setSavedSessions(Array.isArray(sessions) ? sessions : []);
    } catch {
      setSavedSessions([]);
    }
  }, [resolveNowCandidates]);

  const handleNowClick = useCallback(async () => {
    try {
      automation.emit?.("event", {
        type: "animals/now_clicked",
        ts: iso(),
        source: "ui/animals",
        data: {},
      });

      const candidates = await resolveNowCandidates();
      setSavedSessions(Array.isArray(candidates) ? candidates : []);

      if (!candidates || candidates.length === 0) {
        raiseToast("Nothing to run", "No animal sessions or tasks found.");
        return;
      }

      if (candidates.length === 1) {
        // Direct open
        const s = candidates[0];
        eventBus.emit("session.open.requested", {
          type: "session.open.requested",
          ts: iso(),
          source: "ui/animals",
          data: s,
        });

        automation.emit?.("event", {
          type: "session.open.requested",
          ts: iso(),
          source: "ui/animals",
          data: s,
        });

        invokeNBA?.({
          reason: "session_open_requested",
          context: { domain: "animals" },
        });
      } else {
        setSwapSessions(candidates);
        setSwapOpen(true);
      }
    } catch (e) {
      console.warn("Now flow failed:", e);
      raiseToast("Error", "Could not start session.");
    }
  }, [automation, resolveNowCandidates, eventBus, invokeNBA]);

  const pickAndPlay = useCallback(
    (session) => {
      setSwapOpen(false);
      if (!session) return;

      eventBus.emit("session.open.requested", {
        type: "session.open.requested",
        ts: iso(),
        source: "ui/animals",
        data: session,
      });

      automation.emit?.("event", {
        type: "session.open.requested",
        ts: iso(),
        source: "ui/animals",
        data: session,
      });

      invokeNBA?.({
        reason: "session_open_requested",
        context: { domain: "animals" },
      });
    },
    [automation, eventBus, invokeNBA]
  );

  // HUD controls proxy to global runner
  const hudPauseResume = () => {
    if (!activeSession) return;
    eventBus.emit("session.control.requested", {
      type: "session.control.requested",
      ts: iso(),
      source: "ui/animals",
      data: { id: activeSession.id, action: "togglePause" },
    });
  };

  const hudNext = () => {
    if (!activeSession) return;
    eventBus.emit("session.control.requested", {
      type: "session.control.requested",
      ts: iso(),
      source: "ui/animals",
      data: { id: activeSession.id, action: "next" },
    });
  };

  const hudOpen = () => {
    if (!activeSession) return;
    eventBus.emit("session.open.byId", {
      type: "session.open.byId",
      ts: iso(),
      source: "ui/animals",
      data: { id: activeSession.id },
    });
  };

  /** ----------------------------- Favorites logic ------------------------- */

  const isSessionFavorite = useCallback(
    (s) => !!(s && s.id && favoriteSessionIds.includes(s.id)),
    [favoriteSessionIds]
  );

  const toggleFavoriteSession = useCallback(
    (s) => {
      if (!s || !s.id) return;
      setFavoriteSessionIds((prev) => {
        const exists = prev.includes(s.id);
        const next = exists
          ? prev.filter((id) => id !== s.id)
          : [...prev, s.id];

        try {
          automation.emit?.("event", {
            type: "animals/session_favorite_toggled",
            ts: iso(),
            source: "ui/animals",
            data: { sessionId: s.id, favorite: !exists },
          });
        } catch {}

        const title = s.title || "Routine";
        const msg = exists
          ? `${title} removed from favorites.`
          : `${title} saved as favorite.`;
        raiseToast("Favorite updated", msg);

        return next;
      });
    },
    [automation]
  );

  /** ----------------------------- Projections ----------------------------- */

  const runProjections = useCallback(async () => {
    const inferred = deriveAnimals({ plan: stockingPlan, tasks: animalTasks });
    const merged = mergeAnimals(inferred, quickAnimals);

    // Try automation template first (gives room for richer butchery / grocery / menu logic)
    try {
      const res = await runTemplateSafe(
        automation,
        "animals.projections",
        {
          animals: merged,
          householdSize: Number(householdSize) || 1,
          demand,
          collectionLoss,
          preservationLoss,
          invokedBy: "ui/animals",
        },
        { timeoutMs: 12000, retry: 1 }
      );
      if (res && res.weekly) {
        setProjections(res);
        setProjDebug({ via: "template" });
        return;
      }
    } catch {}

    // Fallback math
    const weeklyRaw = simpleProduction(merged);
    const weekly = applyCollectionLosses(weeklyRaw, collectionLoss);
    const cmp = compareToDemand(weekly, demand, Number(householdSize) || 1);
    const winter = offSeasonWeeks(merged);
    const preserve = preservationPlan(
      weekly,
      cmp.need,
      winter,
      preservationLoss
    );

    setProjections({
      animals: merged,
      weekly,
      need: cmp.need,
      delta: cmp.delta,
      winterWeeks: winter,
      preserve,
      notes: "Fallback estimates using simple heuristics + loss adjustments.",
      meta: { weeklyRaw },
      selfSufficiency: {
        eggs:
          weekly.eggs >= cmp.need.eggs
            ? "year-round with surplus (preserve for winter)"
            : "shortfall",
        milk:
          weekly.milkL >= cmp.need.milkL
            ? "year-round with surplus (preserve for winter)"
            : "shortfall",
        meat:
          weekly.meatKg >= cmp.need.meatKg
            ? "steady with periodic harvests"
            : "shortfall",
      },
    });
    setProjDebug({ via: "fallback" });
  }, [
    automation,
    animalTasks,
    stockingPlan,
    householdSize,
    demand,
    collectionLoss,
    preservationLoss,
    quickAnimals,
  ]);

  useEffect(() => {
    if (animalTasks.length || stockingPlan || quickAnimals.length) {
      runProjections();
    }
  }, [
    animalTasks.length,
    stockingPlan,
    quickAnimals.length,
    householdSize,
    demand,
    collectionLoss,
    preservationLoss,
    runProjections,
  ]);

  /** -------------------------- AI flows (estimate/sync) --------------------- */

  const estimateStocking = async () => {
    setBusy(true);
    setOk(false);
    setLastOutput(null);

    try {
      const res = await runTemplateSafe(
        automation,
        "animal.stocking.estimate",
        {
          householdSize: Number(householdSize) || 1,
          land: { acres: Number(landArea) || 0 },
          outputs: outputsWanted,
          constraints,
          notes,
          invokedBy: "ui/animals",
        },
        { timeoutMs: 15000, retry: 1 }
      );

      const plan = res && (res.plan || res);
      setStockingPlan(plan || null);
      setLastOutput({ via: "template", res });

      try {
        invokeNBA &&
          invokeNBA({
            reason: "animal_stocking_estimated",
            context: { size: householdSize, outputs: outputsWanted },
          });
      } catch {}

      raiseToast("Estimated", "Draft stocking plan created.");
      refreshSessionsList();
    } catch (e) {
      automation.emit &&
        automation.emit("event", {
          type: "animals/stocking_estimate_request",
          payload: {
            householdSize: Number(householdSize) || 1,
            land: { acres: Number(landArea) || 0 },
            outputsWanted,
            constraints,
            notes,
          },
        });

      setLastOutput({
        via: "event",
        emitted: true,
        error: e && e.message,
      });
      raiseToast("Queued", "Request sent to background agent.");
    } finally {
      setBusy(false);
      setOk(true);
      setTimeout(() => setOk(false), 900);
    }
  };

  const acceptPlanAndSyncQueue = async () => {
    if (!stockingPlan) return;
    setBusy(true);
    setOk(false);

    try {
      const planToQueue = await runTemplateSafe(
        automation,
        "animal.queue.sync",
        { plan: stockingPlan, invokedBy: "ui/animals" },
        { timeoutMs: 15000, retry: 1 }
      );

      const tasks = Array.isArray(planToQueue && planToQueue.tasks)
        ? planToQueue.tasks
        : [];
      if (tasks.length) {
        await addTasksSafe(AQMRef.current, tasks);
        automation.emit &&
          automation.emit("event", {
            type: "animals/queue_merge",
            payload: { tasks },
          });
      }

      const q = await getQueueSafe(AQMRef.current);
      setAnimalTasks(Array.isArray(q) ? q : []);
      setLastOutput((prev) => ({ ...(prev || {}), queueSync: planToQueue }));

      try {
        invokeNBA &&
          invokeNBA({
            reason: "animal_queue_synced_from_plan",
            context: { tasks: tasks.length },
          });
      } catch {}

      raiseToast("Synced", `Added ${tasks.length} task(s) to Animal Queue.`);
      refreshSessionsList();
    } catch (e) {
      automation.emit &&
        automation.emit("event", {
          type: "animals/queue_sync_request",
          payload: { plan: stockingPlan },
        });

      setLastOutput({
        via: "event",
        emitted: true,
        error: e && e.message,
      });
      raiseToast("Queued", "Sync requested; will apply when ready.");
    } finally {
      setBusy(false);
      setOk(true);
      setTimeout(() => setOk(false), 900);
    }
  };

  const resyncQueue = async () => {
    setBusy(true);
    setOk(false);
    try {
      const res = await runTemplateSafe(
        automation,
        "animals.queue.refresh",
        { invokedBy: "ui/animals" },
        { timeoutMs: 12000, retry: 1 }
      );
      const refreshed = Array.isArray(res && res.tasks)
        ? res.tasks
        : await getQueueSafe(AQMRef.current);
      setAnimalTasks(refreshed);
      setLastOutput({ via: "template", res });
      raiseToast("Queue refreshed", `${refreshed.length} task(s) loaded.`);
      refreshSessionsList();
    } catch (e) {
      automation.emit &&
        automation.emit("event", {
          type: "animals/queue_refresh_request",
          payload: {},
        });

      setLastOutput({
        via: "event",
        emitted: true,
        error: e && e.message,
      });
      raiseToast("Queued", "Queue refresh requested.");
    } finally {
      setBusy(false);
      setOk(true);
      setTimeout(() => setOk(false), 900);
    }
  };

  // ✅ FIX: Keyboard shortcuts moved BELOW handler definitions to avoid TDZ/ReferenceError
  // "/" focus quick add; e=estimate; r=recalc; q=queue refresh; n=Now
  useKey("/", () => quickDraftRef.current?.focus?.());
  useKey("e", () => estimateStocking());
  useKey("r", () => runProjections());
  useKey("q", () => resyncQueue());
  useKey("n", () => handleNowClick());

  /**
   * Generate Animal Care Session
   * - Fetch domain="animals" artifacts from the vault.
   * - Merge their StepGraphs into a daily/weekly care session.
   * - Persist via SessionsRepo where available.
   * - Emit session.generated and (optionally) export to Hub.
   */
  const generateCareSession = useCallback(
    async (cadence = "daily") => {
      setBusy(true);
      try {
        const artifacts = await loadAnimalArtifacts();
        if (!artifacts || !artifacts.length) {
          raiseToast(
            "No protocols",
            "Add animal care protocols to your vault before generating a session."
          );
          return;
        }

        const session = buildCareSessionFromArtifacts(artifacts, cadence);
        if (
          !session ||
          !Array.isArray(session.steps) ||
          !session.steps.length
        ) {
          raiseToast(
            "Nothing to generate",
            "Could not derive steps from your animal care protocols."
          );
          return;
        }

        let savedSession = session;
        const repo = sessionsRepoRef.current;

        // Persist to SessionsRepo if possible
        try {
          if (repo?.saveSession) {
            savedSession = (await repo.saveSession(session)) || session;
          } else if (repo?.upsert) {
            savedSession = (await repo.upsert(session)) || session;
          } else if (repo?.save) {
            savedSession = (await repo.save(session)) || session;
          }
        } catch (e) {
          console.warn(
            "[Animals] saving generated care session to SessionsRepo failed:",
            e
          );
        }

        // Update local sessions list (dedupe by id)
        setSavedSessions((prev) => {
          const next = [savedSession, ...prev];
          const seen = new Set();
          return next.filter((s) => {
            if (!s || !s.id) return false;
            if (seen.has(s.id)) return false;
            seen.add(s.id);
            return true;
          });
        });

        const evtData = {
          domain: "animals",
          cadence,
          session: savedSession,
        };

        // Session generated event → automation runtime + eventBus
        eventBus.emit("session.generated", {
          type: "session.generated",
          ts: iso(),
          source: "ui/animals",
          data: evtData,
        });

        automation.emit?.("event", {
          type: "session.generated",
          ts: iso(),
          source: "ui/animals",
          data: evtData,
        });

        // Optional Hub export (SSA remains source of truth)
        exportToHubIfEnabled({
          type: "animals.session.generated",
          domain: "animals",
          cadence,
          session: savedSession,
        });

        raiseToast(
          "Session generated",
          `Created ${cadence} animal care session from your protocols.`
        );
      } catch (e) {
        console.warn("[Animals] generateCareSession failed:", e);
        raiseToast("Error", "Could not generate animal care session.");
      } finally {
        setBusy(false);
      }
    },
    [automation, eventBus]
  );

  // Export helpers (Calendar / Task Board / Inventory / Meal Plan / Grocery / Butchery)
  const sendTo = (target) => {
    const payload = {
      kind: "animals-dashboard",
      domain: "animals",
      target,
      inputs: {
        householdSize,
        landArea,
        outputsWanted,
        constraints,
        notes,
        demand,
        collectionLoss,
        preservationLoss,
        quickAnimals,
      },
      projection: projections,
      at: Date.now(),
    };

    // Generic export event for shared orchestration
    eventBus.emit("export.requested", payload);

    // Give downstream automation a richer signal for cross-domain orchestration
    try {
      automation.emit?.("event", {
        type: "animals/export_requested",
        ts: iso(),
        source: "ui/animals",
        data: payload,
      });
    } catch {}

    // And a specific cross-domain hint (e.g. meals, storehouse, butchery)
    eventBus.emit("animals.crossDomain.export", {
      type: "animals.crossDomain.export",
      ts: iso(),
      source: "ui/animals",
      data: payload,
    });

    raiseToast(
      "Sent",
      `Animals data exported to ${target}. Linked domains can now react.`
    );

    try {
      invokeNBA &&
        invokeNBA({
          reason: "animals_export",
          context: { target },
        });
    } catch {}
  };

  // Save projections/preservation as a favorite schedule
  const saveFavoriteSchedule = () => {
    if (!projections) {
      raiseToast(
        "Nothing to save",
        "Calculate projections before saving a schedule."
      );
      return;
    }

    const id = `sched_${Date.now()}`;
    const label = `Animals • ${householdSize} ppl • ${projections.winterWeeks} wk`;
    const schedule = {
      id,
      label,
      createdAt: iso(),
      householdSize,
      demand,
      collectionLoss,
      preservationLoss,
      projections,
    };

    setFavoriteSchedules((prev) => [...prev, schedule]);

    try {
      automation.emit?.("event", {
        type: "animals/schedule_favorite_saved",
        ts: iso(),
        source: "ui/animals",
        data: schedule,
      });
    } catch {}

    raiseToast("Saved", "Favorite animal schedule created.");
  };

  const removeFavoriteSchedule = (id) => {
    setFavoriteSchedules((prev) => prev.filter((s) => s.id !== id));
  };

  const exportFavoriteScheduleToCalendar = (sched) => {
    if (!sched) return;
    const payload = {
      type: "animals.favoriteSchedule.export",
      ts: iso(),
      source: "ui/animals",
      data: {
        schedule: sched,
        target: "Calendar",
        domain: "animals",
      },
    };
    eventBus.emit("animals.favoriteSchedule.export", payload);
    try {
      automation.emit?.("event", payload);
    } catch {}
    raiseToast("Sent", "Favorite schedule sent to Calendar.");
  };

  // Plan preview
  const planSummary = useMemo(() => {
    if (!stockingPlan) return null;
    const animals = Array.isArray(stockingPlan.animals)
      ? stockingPlan.animals
      : [];

    const lines = animals.map((a, i) => {
      const parts = [
        a && a.count != null ? `${a.count}×` : null,
        (a && (a.breed || a.type)) || "Animal",
      ].filter(Boolean);
      return (
        <li key={`${(a && (a.type || a.breed)) || "animal"}-${i}`}>
          {parts.join(" ")}
        </li>
      );
    });

    return (
      <div className="sv-card sv-pad">
        <div className="sv-strong" style={{ marginBottom: 6 }}>
          Suggested Stocking
        </div>
        <ul className="sv-list">{lines}</ul>

        {stockingPlan && stockingPlan.feed ? (
          <div className="sv-caption" style={{ marginTop: 8 }}>
            <span className="sv-strong">Feed/Hay:</span>{" "}
            {String(stockingPlan.feed)}
          </div>
        ) : null}

        {stockingPlan && stockingPlan.housing ? (
          <div className="sv-caption">
            <span className="sv-strong">Housing:</span>{" "}
            {String(stockingPlan.housing)}
          </div>
        ) : null}
      </div>
    );
  }, [stockingPlan]);

  const th = {
    textAlign: "left",
    padding: "10px 12px",
    fontSize: ".8rem",
    textTransform: "uppercase",
    letterSpacing: ".04em",
    borderBottom: "1px solid var(--line)",
  };
  const td = { padding: "10px 12px", fontSize: ".95rem" };

  // Helper: mark animal task complete via manager
  const markTaskComplete = async (taskId) => {
    if (!taskId) return;
    await completeTaskSafe(AQMRef.current, taskId);
    const q = await getQueueSafe(AQMRef.current);
    setAnimalTasks(Array.isArray(q) ? q : []);
    refreshSessionsList();
  };

  // Derived list of favorite sessions as actual session objects
  const favoriteSessionsFull = useMemo(
    () =>
      savedSessions.filter(
        (s) => s && s.id && favoriteSessionIds.includes(s.id)
      ),
    [savedSessions, favoriteSessionIds]
  );

  /** =============================================================================
   * 4) PERSISTENCE (Dexie CRUD + seed handling) — NEW MODULE STATE
   * ============================================================================= */
  const [careItems, setCareItems] = useState([]);
  const [careLoading, setCareLoading] = useState(true);
  const [careError, setCareError] = useState(null);
  const [careSaving, setCareSaving] = useState(false);

  const [careQuery, setCareQuery] = useState({
    search: "",
    status: "open", // open | done | all
    category: "all",
    sort: "due", // due | updated | priority
  });

  const [careEditingId, setCareEditingId] = useState(null);
  const [careForm, setCareForm] = useState({
    title: "",
    category: "feeding",
    dueAt: "",
    priority: 2,
    notes: "",
    tagsText: "daily",
  });

  const careOptimisticBackupRef = useRef(null);

  const emitAnimalMutation = useCallback(
    (type, data) => {
      // REQUIRED: eventBus emit on every mutation
      const payload = {
        type,
        ts: iso(),
        source: "ui/animals",
        data,
      };
      try {
        eventBus.emit(type, payload);
      } catch {}

      // keep existing pattern: also notify automation runtime (optional)
      try {
        automation.emit?.("event", payload);
      } catch {}
    },
    [eventBus, automation]
  );

  const validateCareForm = useCallback((draft) => {
    const title = String(draft.title || "").trim();
    if (title.length < 2) return { ok: false, error: "Title is required." };

    const priority = Math.max(1, Math.min(3, Number(draft.priority) || 2));

    let dueAt = null;
    const dueRaw = String(draft.dueAt || "").trim();
    if (dueRaw) {
      const d = new Date(dueRaw);
      if (Number.isNaN(d.getTime())) {
        return { ok: false, error: "Due date/time is invalid." };
      }
      dueAt = d.toISOString();
    }

    const tags = String(draft.tagsText || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 12);

    return {
      ok: true,
      value: {
        title,
        category: String(draft.category || "general"),
        dueAt,
        priority,
        notes: String(draft.notes || "").trim(),
        tags,
      },
    };
  }, []);

  const reloadCareItems = useCallback(async () => {
    setCareLoading(true);
    setCareError(null);
    try {
      // seed if empty (Dexie table OR LS fallback)
      const seeded = await seedCareItemsIfEmpty({
        db: dbRef.current,
        householdId,
      });

      const rows = await safeListCareItems({
        db: dbRef.current,
        householdId,
      });

      setCareItems(Array.isArray(rows) ? rows : []);

      // friendly warning if Dexie table missing and we seeded LS
      if (seeded?.via === "localStorage" && dbRef.current) {
        // db exists but table likely missing
        if (!hasDexieTable(dbRef.current, "animalCareItems")) {
          emitAnimalMutation("animals.db.table.missing", {
            table: "animalCareItems",
            householdId,
            action: "fallback_to_localStorage",
          });
        }
      }
    } catch (e) {
      console.warn("[Animals] reloadCareItems failed:", e);
      setCareError(e?.message || "Failed to load saved barn tasks.");
    } finally {
      setCareLoading(false);
    }
  }, [householdId, emitAnimalMutation]);

  useEffect(() => {
    // load on mount + whenever household changes
    reloadCareItems();
  }, [reloadCareItems]);

  const careCategories = useMemo(() => {
    const set = new Set(["feeding", "watering", "mucking", "checks", "meds"]);
    (careItems || []).forEach((r) => {
      if (r && r.category) set.add(String(r.category));
    });
    return Array.from(set).sort();
  }, [careItems]);

  const careCounts = useMemo(() => {
    let open = 0;
    let done = 0;
    (careItems || []).forEach((r) => {
      if (!r) return;
      if (r.status === "done") done += 1;
      else open += 1;
    });
    return { open, done, total: (careItems || []).length };
  }, [careItems]);

  const careFilteredSorted = useMemo(() => {
    const q = careQuery || {};
    const search = String(q.search || "")
      .toLowerCase()
      .trim();
    const status = q.status || "open";
    const category = q.category || "all";
    const sort = q.sort || "due";

    let rows = [...(careItems || [])].filter(Boolean);

    if (status !== "all") {
      rows = rows.filter((r) =>
        status === "done" ? r.status === "done" : r.status !== "done"
      );
    }

    if (category !== "all") {
      rows = rows.filter(
        (r) =>
          String(r.category || "").toLowerCase() ===
          String(category).toLowerCase()
      );
    }

    if (search) {
      rows = rows.filter((r) => {
        const hay = `${r.title || ""} ${r.notes || ""} ${(r.tags || []).join(
          " "
        )} ${r.category || ""}`.toLowerCase();
        return hay.includes(search);
      });
    }

    const toTs = (s) => {
      const d = s ? new Date(s) : null;
      const t = d && !Number.isNaN(d.getTime()) ? d.getTime() : 0;
      return t;
    };

    rows.sort((a, b) => {
      if (sort === "priority") {
        const ap = Number(a.priority || 2);
        const bp = Number(b.priority || 2);
        if (ap !== bp) return ap - bp; // 1 high first
        return toTs(b.updatedAt) - toTs(a.updatedAt);
      }

      if (sort === "updated") {
        return toTs(b.updatedAt) - toTs(a.updatedAt);
      }

      // sort === "due": earliest due first; nulls last
      const ad = a.dueAt ? toTs(a.dueAt) : Number.POSITIVE_INFINITY;
      const bd = b.dueAt ? toTs(b.dueAt) : Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad - bd;
      return toTs(b.updatedAt) - toTs(a.updatedAt);
    });

    return rows;
  }, [careItems, careQuery]);

  const startEditCareItem = (r) => {
    if (!r) return;
    setCareEditingId(r.id);
    setCareForm({
      title: r.title || "",
      category: r.category || "general",
      dueAt: r.dueAt ? new Date(r.dueAt).toISOString().slice(0, 16) : "",
      priority: Number(r.priority || 2),
      notes: r.notes || "",
      tagsText: Array.isArray(r.tags) ? r.tags.join(", ") : "",
    });
  };

  const resetCareForm = () => {
    setCareEditingId(null);
    setCareForm({
      title: "",
      category: "feeding",
      dueAt: "",
      priority: 2,
      notes: "",
      tagsText: "daily",
    });
  };

  const upsertCareItem = useCallback(
    async (mode) => {
      const v = validateCareForm(careForm);
      if (!v.ok) {
        raiseToast("Fix required", v.error || "Invalid input.");
        return;
      }

      const now = iso();
      const base = v.value;

      // optimistic update
      setCareSaving(true);
      setCareError(null);

      let nextRecord;
      let optimisticId = null;

      try {
        if (mode === "edit" && careEditingId) {
          const existing = careItems.find((x) => x && x.id === careEditingId);
          if (!existing) {
            raiseToast("Not found", "That record no longer exists.");
            setCareSaving(false);
            return;
          }

          nextRecord = {
            ...existing,
            ...base,
            updatedAt: now,
          };

          // backup for rollback
          careOptimisticBackupRef.current = { type: "update", prev: existing };

          setCareItems((prev) =>
            prev.map((x) => (x && x.id === careEditingId ? nextRecord : x))
          );

          await safePutCareItem({
            db: dbRef.current,
            householdId,
            record: nextRecord,
          });

          emitAnimalMutation("animals.careItem.updated", {
            record: nextRecord,
            householdId,
          });

          raiseToast("Updated", "Saved barn task updated.");
          resetCareForm();
        } else {
          optimisticId = uid("tmp");
          nextRecord = {
            id: optimisticId,
            householdId,
            title: base.title,
            notes: base.notes,
            category: base.category,
            status: "open",
            priority: base.priority,
            dueAt: base.dueAt,
            tags: base.tags,
            source: { kind: "ui", refId: null },
            createdAt: now,
            updatedAt: now,
          };

          careOptimisticBackupRef.current = {
            type: "create",
            id: optimisticId,
          };

          setCareItems((prev) => [nextRecord, ...(prev || [])]);

          // persist with a stable id (prefer non-tmp)
          const persisted = { ...nextRecord, id: uid("care") };

          await safePutCareItem({
            db: dbRef.current,
            householdId,
            record: persisted,
          });

          // replace tmp with persisted
          setCareItems((prev) =>
            (prev || []).map((x) =>
              x && x.id === optimisticId ? persisted : x
            )
          );

          emitAnimalMutation("animals.careItem.created", {
            record: persisted,
            householdId,
          });

          raiseToast("Added", "Saved barn task created.");
          resetCareForm();
        }
      } catch (e) {
        console.warn("[Animals] upsertCareItem failed:", e);

        // rollback optimistic changes
        const b = careOptimisticBackupRef.current;
        if (b?.type === "update" && b.prev) {
          setCareItems((prev) =>
            (prev || []).map((x) => (x && x.id === b.prev.id ? b.prev : x))
          );
        } else if (b?.type === "create" && b.id) {
          setCareItems((prev) =>
            (prev || []).filter((x) => x && x.id !== b.id)
          );
        }

        setCareError(e?.message || "Save failed.");
        raiseToast("Error", "Could not save. Check storage/db.");
      } finally {
        careOptimisticBackupRef.current = null;
        setCareSaving(false);
      }
    },
    [
      careForm,
      careEditingId,
      careItems,
      householdId,
      validateCareForm,
      emitAnimalMutation,
    ]
  );

  const deleteCareItem = useCallback(
    async (id) => {
      if (!id) return;

      const existing = careItems.find((x) => x && x.id === id);
      if (!existing) return;

      setCareSaving(true);
      setCareError(null);

      // optimistic remove
      careOptimisticBackupRef.current = { type: "delete", prev: existing };
      setCareItems((prev) => (prev || []).filter((x) => x && x.id !== id));

      try {
        await safeDeleteCareItem({ db: dbRef.current, householdId, id });

        emitAnimalMutation("animals.careItem.deleted", {
          id,
          householdId,
          prev: existing,
        });

        raiseToast("Deleted", "Saved barn task removed.");
      } catch (e) {
        console.warn("[Animals] deleteCareItem failed:", e);
        // rollback
        const b = careOptimisticBackupRef.current;
        if (b?.type === "delete" && b.prev) {
          setCareItems((prev) => [b.prev, ...(prev || [])]);
        }
        setCareError(e?.message || "Delete failed.");
        raiseToast("Error", "Could not delete. Check storage/db.");
      } finally {
        careOptimisticBackupRef.current = null;
        setCareSaving(false);
      }
    },
    [careItems, householdId, emitAnimalMutation]
  );

  const toggleCareDone = useCallback(
    async (id) => {
      const existing = careItems.find((x) => x && x.id === id);
      if (!existing) return;

      const next = {
        ...existing,
        status: existing.status === "done" ? "open" : "done",
        updatedAt: iso(),
      };

      setCareSaving(true);
      setCareError(null);
      careOptimisticBackupRef.current = { type: "update", prev: existing };

      // optimistic
      setCareItems((prev) =>
        (prev || []).map((x) => (x && x.id === id ? next : x))
      );

      try {
        await safePutCareItem({
          db: dbRef.current,
          householdId,
          record: next,
        });

        emitAnimalMutation("animals.careItem.updated", {
          record: next,
          householdId,
        });
      } catch (e) {
        console.warn("[Animals] toggleCareDone failed:", e);
        // rollback
        setCareItems((prev) =>
          (prev || []).map((x) => (x && x.id === id ? existing : x))
        );
        setCareError(e?.message || "Update failed.");
        raiseToast("Error", "Could not update status.");
      } finally {
        careOptimisticBackupRef.current = null;
        setCareSaving(false);
      }
    },
    [careItems, householdId, emitAnimalMutation]
  );

  const queueCareItemForToday = useCallback(
    async (r) => {
      if (!r) return;

      const task = {
        id: uid("aqm"),
        name: r.title || "Barn task",
        description: r.notes || "",
        assignedRole: "Animals",
        durationSec: 300,
        blockers: ["inventory"],
        createdAt: iso(),
        updatedAt: iso(),
      };

      try {
        await addTasksSafe(AQMRef.current, [task]);
        const q = await getQueueSafe(AQMRef.current);
        setAnimalTasks(Array.isArray(q) ? q : []);

        emitAnimalMutation("animals.careItem.queued", {
          householdId,
          careItemId: r.id,
          task,
        });

        raiseToast("Queued", "Added to Animal Queue for today.");
      } catch (e) {
        console.warn("[Animals] queueCareItemForToday failed:", e);
        raiseToast("Error", "Could not queue this item.");
      }
    },
    [householdId, emitAnimalMutation]
  );

  /** ----------------------------- Favorites logic (unchanged below) ------------------------- */

  return (
    <div className="sv-container">
      {/* Header / Hero */}
      <div className="sv-hero sv-pad">
        <div className="sv-row sv-justify-between sv-align-center sv-wrap">
          <div className="sv-row sv-align-center sv-gap-sm">
            <span className="sv-emoji">🐓</span>
            <h1 className="sv-pageTitle">Animal Care</h1>
          </div>
          <div className="sv-row sv-gap-sm sv-wrap">
            <button
              className="sv-btn sv-btn--primary"
              onClick={handleNowClick}
              title="Start the next animal session now"
            >
              ▶ Now
            </button>

            <button
              className="sv-btn sv-btn--outline sv-btn--sm"
              onClick={() => sendTo("Task Board")}
            >
              Send → Task Board
            </button>
            <button
              className="sv-btn sv-btn--outline sv-btn--sm"
              onClick={() => sendTo("Calendar")}
            >
              Send → Calendar
            </button>
            <button
              className="sv-btn sv-btn--outline sv-btn--sm"
              onClick={() => sendTo("Inventory")}
            >
              Send → Inventory
            </button>
            <button
              className="sv-btn sv-btn--outline sv-btn--sm"
              onClick={() => sendTo("Meal Plan")}
            >
              Send → Meal Plan
            </button>
            <button
              className="sv-btn sv-btn--outline sv-btn--sm"
              onClick={() => sendTo("Grocery Plan")}
            >
              Send → Grocery Plan
            </button>
            <button
              className="sv-btn sv-btn--outline sv-btn--sm"
              onClick={() => sendTo("Butchery Plan")}
            >
              Send → Butchery Plan
            </button>
          </div>
        </div>

        <p className="sv-muted" style={{ marginTop: 8 }}>
          Plan animals for self-sufficiency, queue care tasks, and run
          hands-free sessions that sync with your storehouse, meals, and
          preservation work.
        </p>
      </div>

      {/* FAVORITES STRIP */}
      <section className="sv-card sv-pad sv-block">
        <div className="sv-row sv-wrap sv-justify-between sv-gap">
          <div>
            <h2 className="sv-sectionTitle">⭐ Your Favorites</h2>
            <p className="sv-caption">
              Save your own animal routines & seasonal schedules. They’ll show
              up here and in the SessionRunner’s favorites views.
            </p>
          </div>
          <div className="sv-row sv-gap-sm sv-caption">
            <span>
              Sessions: <strong>{favoriteSessionsFull.length}</strong>
            </span>
            <span>
              Schedules: <strong>{favoriteSchedules.length}</strong>
            </span>
          </div>
        </div>

        <div className="sv-grid-2 sv-gap" style={{ marginTop: 12 }}>
          <div>
            <div className="sv-caption caps" style={{ marginBottom: 4 }}>
              Favorite Routines
            </div>
            {favoriteSessionsFull.length ? (
              <ul className="sv-stack-sm sv-text-sm">
                {favoriteSessionsFull.map((s) => (
                  <li
                    key={s.id}
                    className="sv-card sv-pad sv-row sv-justify-between sv-align-center"
                  >
                    <div>
                      <div className="sv-strong sv-ellipsis">
                        {s.title || "Animal session"}
                      </div>
                      <div className="sv-caption">
                        {Array.isArray(s.steps)
                          ? `${s.steps.length} step(s)`
                          : "No steps"}
                      </div>
                    </div>

                    <div className="sv-stack-sm sv-align-end">
                      <button
                        className="sv-btn sv-btn--primary sv-btn--sm"
                        onClick={() => pickAndPlay(s)}
                      >
                        ▶ Run
                      </button>
                      <button
                        className="sv-btn sv-btn--ghost sv-btn--sm"
                        onClick={() => toggleFavoriteSession(s)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sv-caption">
                When you open the “Now” picker, tap ☆ to save a routine here.
              </p>
            )}
          </div>

          <div>
            <div className="sv-row sv-justify-between sv-align-center sv-gap-sm">
              <div className="sv-caption caps">Favorite Schedules</div>
              <button
                className="sv-btn sv-btn--outline sv-btn--sm"
                onClick={saveFavoriteSchedule}
              >
                Save current as favorite
              </button>
            </div>

            {favoriteSchedules.length ? (
              <ul className="sv-stack-sm sv-text-sm" style={{ marginTop: 8 }}>
                {favoriteSchedules.map((sched) => (
                  <li
                    key={sched.id}
                    className="sv-card sv-pad sv-row sv-justify-between sv-align-center"
                  >
                    <div>
                      <div className="sv-strong sv-ellipsis">{sched.label}</div>
                      <div className="sv-caption">
                        Saved:{" "}
                        {sched.createdAt
                          ? new Date(sched.createdAt).toLocaleDateString()
                          : "—"}
                      </div>
                    </div>
                    <div className="sv-stack-sm sv-align-end">
                      <button
                        className="sv-btn sv-btn--outline sv-btn--sm"
                        onClick={() => exportFavoriteScheduleToCalendar(sched)}
                      >
                        → Calendar
                      </button>
                      <button
                        className="sv-btn sv-btn--ghost sv-btn--sm"
                        onClick={() => removeFavoriteSchedule(sched.id)}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="sv-caption" style={{ marginTop: 8 }}>
                Use projections to plan a season, then “Save current as
                favorite” to pin it.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Planner inputs -> AI Templates */}
      <section className="sv-card sv-pad sv-block">
        <h2 className="sv-sectionTitle">📐 Self-Sufficiency Planner</h2>
        <p className="sv-caption" style={{ marginBottom: 12 }}>
          Tell the AI about your household and goals. SSA will draft the animals
          you need, then project outputs and plan preservation for off-season.
        </p>

        <div className="sv-grid-2 sv-gap">
          <Field label="Household size">
            <input
              className="sv-input"
              inputMode="numeric"
              value={householdSize}
              onChange={(e) => setHouseholdSize(e.target.value)}
              placeholder="e.g., 4"
              name="householdSize"
            />
          </Field>

          <Field label="Available land (acres)">
            <input
              className="sv-input"
              inputMode="decimal"
              value={landArea}
              onChange={(e) => setLandArea(e.target.value)}
              placeholder="e.g., 0.5"
              name="landArea"
            />
          </Field>

          <Field label="Desired outputs">
            <div className="sv-row sv-wrap sv-gap-sm">
              {["eggs", "milk", "meat", "fiber", "manure"].map((k) => {
                const on = outputsWanted.includes(k);
                return (
                  <button
                    key={k}
                    type="button"
                    className={`sv-btn sv-btn--sm ${
                      on ? "sv-btn--primary" : "sv-btn--outline"
                    }`}
                    onClick={() =>
                      setOutputsWanted((prev) =>
                        prev.includes(k)
                          ? prev.filter((x) => x !== k)
                          : [...prev, k]
                      )
                    }
                    aria-pressed={on}
                  >
                    {k}
                  </button>
                );
              })}
            </div>
          </Field>

          <Field label="Constraints (zoning, HOA, predators, climate…)">
            <input
              className="sv-input"
              value={constraints}
              onChange={(e) => setConstraints(e.target.value)}
              placeholder="e.g., hens only, winter lows −10°C"
              name="constraints"
            />
          </Field>

          <Field label="Notes / preferences (breeds, rotations, schedule)">
            <textarea
              className="sv-input"
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g., heritage breeds, mobile chicken tractors"
              name="notes"
            />
          </Field>
        </div>

        {/* Household consumption tuning */}
        <div className="sv-grid-3 sv-gap" style={{ marginTop: 16 }}>
          <Field label="Eggs / person / day">
            <input
              className="sv-input"
              inputMode="decimal"
              value={demand.eggsPerPersonPerDay}
              onChange={(e) =>
                setDemand((d) => ({
                  ...d,
                  eggsPerPersonPerDay: Number(e.target.value) || 0,
                }))
              }
            />
          </Field>

          <Field label="Milk L / person / week">
            <input
              className="sv-input"
              inputMode="decimal"
              value={demand.milkLPerPersonPerWeek}
              onChange={(e) =>
                setDemand((d) => ({
                  ...d,
                  milkLPerPersonPerWeek: Number(e.target.value) || 0,
                }))
              }
            />
          </Field>

          <Field label="Meat kg / person / week">
            <input
              className="sv-input"
              inputMode="decimal"
              value={demand.meatKgPerPersonPerWeek}
              onChange={(e) =>
                setDemand((d) => ({
                  ...d,
                  meatKgPerPersonPerWeek: Number(e.target.value) || 0,
                }))
              }
            />
          </Field>
        </div>

        {/* Loss controls */}
        <div className="sv-grid-2 sv-gap" style={{ marginTop: 16 }}>
          <div className="sv-card sv-pad">
            <div className="sv-strong" style={{ marginBottom: 8 }}>
              Collection / Processing Loss
            </div>
            <div className="sv-grid-3 sv-gap">
              <Field label="Eggs %" hint="breakage/dirty">
                <input
                  className="sv-input"
                  inputMode="decimal"
                  value={collectionLoss.eggsLossPct}
                  onChange={(e) =>
                    setCollectionLoss((l) => ({
                      ...l,
                      eggsLossPct: clampPct(e.target.value),
                    }))
                  }
                />
              </Field>
              <Field label="Milk %" hint="spills/filter">
                <input
                  className="sv-input"
                  inputMode="decimal"
                  value={collectionLoss.milkLossPct}
                  onChange={(e) =>
                    setCollectionLoss((l) => ({
                      ...l,
                      milkLossPct: clampPct(e.target.value),
                    }))
                  }
                />
              </Field>
              <Field label="Meat %" hint="trim/bone">
                <input
                  className="sv-input"
                  inputMode="decimal"
                  value={collectionLoss.meatLossPct}
                  onChange={(e) =>
                    setCollectionLoss((l) => ({
                      ...l,
                      meatLossPct: clampPct(e.target.value),
                    }))
                  }
                />
              </Field>
            </div>
          </div>

          <div className="sv-card sv-pad">
            <div className="sv-strong" style={{ marginBottom: 8 }}>
              Preservation Loss
            </div>
            <div className="sv-grid-3 sv-gap">
              <Field label="Eggs %" hint="storage failure">
                <input
                  className="sv-input"
                  inputMode="decimal"
                  value={preservationLoss.eggsLossPct}
                  onChange={(e) =>
                    setPreservationLoss((l) => ({
                      ...l,
                      eggsLossPct: clampPct(e.target.value),
                    }))
                  }
                />
              </Field>
              <Field label="Milk %" hint="cheese yield">
                <input
                  className="sv-input"
                  inputMode="decimal"
                  value={preservationLoss.milkLossPct}
                  onChange={(e) =>
                    setPreservationLoss((l) => ({
                      ...l,
                      milkLossPct: clampPct(e.target.value),
                    }))
                  }
                />
              </Field>
              <Field label="Meat %" hint="freezer burn/etc">
                <input
                  className="sv-input"
                  inputMode="decimal"
                  value={preservationLoss.meatLossPct}
                  onChange={(e) =>
                    setPreservationLoss((l) => ({
                      ...l,
                      meatLossPct: clampPct(e.target.value),
                    }))
                  }
                />
              </Field>
            </div>
          </div>
        </div>

        <div className="sv-row sv-gap sv-wrap" style={{ marginTop: 16 }}>
          <button
            className="sv-btn sv-btn--primary sv-btn--sm"
            aria-busy={busy}
            onClick={estimateStocking}
          >
            Estimate Animals
          </button>
          <button
            className="sv-btn sv-btn--outline sv-btn--sm"
            aria-busy={busy}
            onClick={acceptPlanAndSyncQueue}
            disabled={!stockingPlan}
          >
            Accept Plan & Sync Tasks
          </button>
          <button
            className="sv-btn sv-btn--outline sv-btn--sm"
            aria-busy={busy}
            onClick={runProjections}
          >
            Recalculate Projections
          </button>
          <button
            className="sv-btn sv-btn--outline sv-btn--sm"
            aria-busy={busy}
            onClick={resyncQueue}
          >
            Re-Sync Queue
          </button>
          {/* New: build care sessions directly from animal-care protocols */}
          <button
            className="sv-btn sv-btn--outline sv-btn--sm"
            aria-busy={busy}
            onClick={() => generateCareSession("daily")}
          >
            Generate Daily Care Session
          </button>
          <button
            className="sv-btn sv-btn--outline sv-btn--sm"
            aria-busy={busy}
            onClick={() => generateCareSession("weekly")}
          >
            Generate Weekly Care Session
          </button>
          {ok ? (
            <span className="sv-caption" style={{ color: "var(--success)" }}>
              ✓ Updated
            </span>
          ) : null}
        </div>

        {planSummary && <div style={{ marginTop: 16 }}>{planSummary}</div>}
      </section>

      {/* BARN TASKS (SAVED) — NEW Dexie-backed interactive module */}
      <section className="sv-card sv-pad sv-block">
        <div className="sv-row sv-justify-between sv-align-center sv-wrap sv-gap">
          <div>
            <h2 className="sv-sectionTitle">🧰 Barn Tasks (Saved)</h2>
            <p className="sv-caption">
              Persistent routines stored per household. Search, filter, mark
              done, and queue for today.
              {dbRef.current &&
              !hasDexieTable(dbRef.current, "animalCareItems") ? (
                <span style={{ marginLeft: 8, color: "var(--warning)" }}>
                  (Dexie table missing — using localStorage fallback)
                </span>
              ) : null}
            </p>
          </div>

          <div className="sv-row sv-gap-sm sv-caption">
            <span>
              Open: <strong>{careCounts.open}</strong>
            </span>
            <span>
              Done: <strong>{careCounts.done}</strong>
            </span>
            <span>
              Total: <strong>{careCounts.total}</strong>
            </span>
          </div>
        </div>

        {/* Query controls */}
        <div className="sv-row sv-wrap sv-gap" style={{ marginTop: 10 }}>
          <input
            className="sv-input"
            placeholder="Search saved barn tasks…"
            value={careQuery.search}
            onChange={(e) =>
              setCareQuery((q) => ({ ...q, search: e.target.value }))
            }
            style={{ minWidth: 220 }}
          />

          <select
            className="sv-input"
            value={careQuery.status}
            onChange={(e) =>
              setCareQuery((q) => ({ ...q, status: e.target.value }))
            }
            style={{ maxWidth: 160 }}
          >
            <option value="open">Open</option>
            <option value="done">Done</option>
            <option value="all">All</option>
          </select>

          <select
            className="sv-input"
            value={careQuery.category}
            onChange={(e) =>
              setCareQuery((q) => ({ ...q, category: e.target.value }))
            }
            style={{ maxWidth: 200 }}
          >
            <option value="all">All categories</option>
            {careCategories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>

          <select
            className="sv-input"
            value={careQuery.sort}
            onChange={(e) =>
              setCareQuery((q) => ({ ...q, sort: e.target.value }))
            }
            style={{ maxWidth: 180 }}
          >
            <option value="due">Sort: Due</option>
            <option value="updated">Sort: Updated</option>
            <option value="priority">Sort: Priority</option>
          </select>

          <button
            className="sv-btn sv-btn--outline sv-btn--sm"
            onClick={reloadCareItems}
            aria-busy={careLoading}
          >
            Refresh
          </button>
        </div>

        {/* Form */}
        <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
          <div className="sv-row sv-justify-between sv-align-center sv-wrap sv-gap-sm">
            <div className="sv-strong">
              {careEditingId ? "Edit saved task" : "Add saved task"}
            </div>
            {careEditingId ? (
              <button
                className="sv-btn sv-btn--ghost sv-btn--sm"
                onClick={resetCareForm}
              >
                Cancel edit
              </button>
            ) : null}
          </div>

          <div className="sv-grid-2 sv-gap" style={{ marginTop: 10 }}>
            <Field label="Title (required)">
              <input
                className="sv-input"
                value={careForm.title}
                onChange={(e) =>
                  setCareForm((f) => ({ ...f, title: e.target.value }))
                }
                placeholder="e.g., Refill waterers + quick health scan"
              />
            </Field>

            <Field label="Category">
              <select
                className="sv-input"
                value={careForm.category}
                onChange={(e) =>
                  setCareForm((f) => ({ ...f, category: e.target.value }))
                }
              >
                {[
                  "feeding",
                  "watering",
                  "mucking",
                  "checks",
                  "meds",
                  "general",
                ].map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>

            <Field label="Due (optional)" hint="Local time">
              <input
                className="sv-input"
                type="datetime-local"
                value={careForm.dueAt}
                onChange={(e) =>
                  setCareForm((f) => ({ ...f, dueAt: e.target.value }))
                }
              />
            </Field>

            <Field label="Priority">
              <select
                className="sv-input"
                value={careForm.priority}
                onChange={(e) =>
                  setCareForm((f) => ({ ...f, priority: e.target.value }))
                }
              >
                <option value={1}>1 (High)</option>
                <option value={2}>2 (Normal)</option>
                <option value={3}>3 (Low)</option>
              </select>
            </Field>

            <Field label="Notes">
              <textarea
                className="sv-input"
                rows={3}
                value={careForm.notes}
                onChange={(e) =>
                  setCareForm((f) => ({ ...f, notes: e.target.value }))
                }
                placeholder="Steps, checks, meds, where supplies are stored…"
              />
            </Field>

            <Field label="Tags" hint="Comma-separated">
              <input
                className="sv-input"
                value={careForm.tagsText}
                onChange={(e) =>
                  setCareForm((f) => ({ ...f, tagsText: e.target.value }))
                }
                placeholder="daily, winter, goats"
              />
            </Field>
          </div>

          <div className="sv-row sv-gap sv-wrap" style={{ marginTop: 12 }}>
            <button
              className="sv-btn sv-btn--primary sv-btn--sm"
              aria-busy={careSaving}
              onClick={() => upsertCareItem(careEditingId ? "edit" : "create")}
            >
              {careEditingId ? "Save changes" : "Add saved task"}
            </button>
            <button
              className="sv-btn sv-btn--outline sv-btn--sm"
              onClick={resetCareForm}
              disabled={careSaving}
            >
              Reset
            </button>

            {careError ? (
              <span className="sv-caption" style={{ color: "var(--danger)" }}>
                {String(careError)}
              </span>
            ) : null}
          </div>
        </div>

        {/* List */}
        <div style={{ marginTop: 12 }}>
          {careLoading ? (
            <div className="sv-grid-3 sv-gap">
              <Skeleton className="sv-card" />
              <Skeleton className="sv-card" />
              <Skeleton className="sv-card" />
            </div>
          ) : careFilteredSorted.length ? (
            <ul className="sv-stack">
              {careFilteredSorted.map((r) => {
                const due =
                  r.dueAt && !Number.isNaN(new Date(r.dueAt).getTime())
                    ? new Date(r.dueAt).toLocaleString()
                    : "—";
                const tags = Array.isArray(r.tags) ? r.tags : [];
                return (
                  <li
                    key={r.id}
                    className="sv-card sv-pad sv-row sv-justify-between sv-align-start"
                    style={{ gap: 12 }}
                  >
                    <div style={{ flex: 1, minWidth: 240 }}>
                      <div className="sv-row sv-align-center sv-gap-sm">
                        <button
                          className="sv-btn sv-btn--outline sv-btn--sm"
                          onClick={() => toggleCareDone(r.id)}
                          title="Toggle done"
                        >
                          {r.status === "done" ? "☑" : "☐"}
                        </button>

                        <div style={{ flex: 1 }}>
                          <div
                            className="sv-strong sv-ellipsis"
                            style={{
                              textDecoration:
                                r.status === "done" ? "line-through" : "none",
                              opacity: r.status === "done" ? 0.7 : 1,
                            }}
                          >
                            {r.title || "Untitled"}
                          </div>
                          <div className="sv-caption">
                            {r.category || "general"} · Due: {due} · Priority:{" "}
                            {Number(r.priority || 2)}
                          </div>
                        </div>
                      </div>

                      {r.notes ? (
                        <div className="sv-caption" style={{ marginTop: 6 }}>
                          {String(r.notes)}
                        </div>
                      ) : null}

                      {tags.length ? (
                        <div
                          className="sv-row sv-wrap sv-gap-sm"
                          style={{ marginTop: 8 }}
                        >
                          {tags.map((t) => (
                            <span key={`${r.id}_${t}`} className="sv-chip">
                              {t}
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>

                    <div
                      className="sv-stack-sm sv-align-end"
                      style={{ minWidth: 160 }}
                    >
                      <button
                        className="sv-btn sv-btn--outline sv-btn--sm"
                        onClick={() => queueCareItemForToday(r)}
                      >
                        + Queue today
                      </button>
                      <button
                        className="sv-btn sv-btn--outline sv-btn--sm"
                        onClick={() => startEditCareItem(r)}
                      >
                        Edit
                      </button>
                      <button
                        className="sv-btn sv-btn--ghost sv-btn--sm"
                        onClick={() => deleteCareItem(r.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="sv-caption">
              No saved barn tasks match your filters. Add one above.
            </p>
          )}
        </div>
      </section>

      {/* QUICK ANIMALS PAD */}
      <section className="sv-card sv-pad sv-block">
        <h2 className="sv-sectionTitle">➕ Quick Animals</h2>
        <p className="sv-caption">
          Add simple “type,count” lines (e.g., <code>chicken,12</code> or{" "}
          <code>goat,2</code>) to include in projections.
        </p>

        <div className="sv-row sv-gap" style={{ marginTop: 8 }}>
          <input
            className="sv-input"
            placeholder="type,count (Enter to add)"
            ref={quickDraftRef}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = (e.currentTarget.value || "").trim();
                const m = v.match(/^([a-zA-Z ]+)\s*,\s*(\d+)$/);
                if (m) {
                  const item = {
                    type: m[1].toLowerCase().trim(),
                    count: Number(m[2]),
                  };
                  setQuickAnimals((prev) => [...prev, item]);
                  e.currentTarget.value = "";
                  raiseToast("Added", `${item.count} ${item.type}`, true);
                }
              }
            }}
          />
          <button
            className="sv-btn sv-btn--outline sv-btn--sm"
            onClick={() => setQuickAnimals([])}
          >
            Clear
          </button>
        </div>

        <div className="sv-row sv-wrap sv-gap" style={{ marginTop: 12 }}>
          {quickAnimals.map((a, i) => (
            <Chip
              key={`${a.type}-${i}`}
              onRemove={() =>
                setQuickAnimals((prev) => prev.filter((_, idx) => idx !== i))
              }
            >
              {a.type} • {a.count}
            </Chip>
          ))}
          {!quickAnimals.length ? (
            <span className="sv-caption">No manual entries yet.</span>
          ) : null}
        </div>
      </section>

      {/* PROJECTIONS */}
      <section className="sv-card sv-pad sv-block">
        <div className="sv-row sv-justify-between sv-align-center sv-gap-sm">
          <h2 className="sv-sectionTitle">
            {" "}
            📊 Household Animal Totals & Projections{" "}
          </h2>
          <button
            className="sv-btn sv-btn--outline sv-btn--sm"
            onClick={saveFavoriteSchedule}
          >
            Save as Favorite Schedule
          </button>
        </div>

        {projections ? (
          <>
            {/* Totals */}
            <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
              <div className="sv-strong" style={{ marginBottom: 8 }}>
                Animals on hand (inferred + quick)
              </div>
              <ul className="sv-grid-2 sv-gap sv-text-sm">
                {projections.animals.map((a, i) => (
                  <li key={`${a.type}-${i}`}>
                    <span className="sv-strong">{a.type}:</span> {a.count}
                  </li>
                ))}
                {!projections.animals.length && (
                  <li className="sv-caption">No animals detected yet.</li>
                )}
              </ul>
            </div>

            {/* Weekly output vs need */}
            <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
              <div className="sv-strong" style={{ marginBottom: 8 }}>
                Weekly Output vs Need (after collection loss)
              </div>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "separate",
                  borderSpacing: 0,
                }}
              >
                <thead>
                  <tr
                    style={{
                      background: "var(--brand-weak)",
                      color: "var(--brand-ink)",
                    }}
                  >
                    <th style={th}>Item</th>
                    <th style={th}>Output / wk</th>
                    <th style={th}>Need / wk</th>
                    <th style={th}>Delta</th>
                    <th style={th}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [
                      "Eggs",
                      projections.weekly.eggs,
                      projections.need.eggs,
                      projections.delta.eggs,
                      projections.selfSufficiency &&
                        projections.selfSufficiency.eggs,
                    ],
                    [
                      "Milk (L)",
                      projections.weekly.milkL,
                      projections.need.milkL,
                      projections.delta.milkL,
                      projections.selfSufficiency &&
                        projections.selfSufficiency.milk,
                    ],
                    [
                      "Meat (kg)",
                      projections.weekly.meatKg,
                      projections.need.meatKg,
                      projections.delta.meatKg,
                      projections.selfSufficiency &&
                        projections.selfSufficiency.meat,
                    ],
                  ].map(([label, out, need, dlt, status]) => (
                    <tr
                      key={label}
                      style={{ borderTop: "1px solid var(--line)" }}
                    >
                      <td style={td}>{label}</td>
                      <td style={td}>
                        {Number(out).toFixed(
                          label.indexOf("Eggs") >= 0 ? 0 : 1
                        )}
                      </td>
                      <td style={td}>
                        {Number(need).toFixed(
                          label.indexOf("Eggs") >= 0 ? 0 : 1
                        )}
                      </td>
                      <td
                        style={td}
                        className={
                          dlt >= 0 ? "sv-text-success" : "sv-text-danger"
                        }
                      >
                        {dlt >= 0 ? "＋" : "−"}
                        {Math.abs(Number(dlt)).toFixed(
                          label.indexOf("Eggs") >= 0 ? 0 : 1
                        )}
                      </td>
                      <td style={td}>{status || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="sv-caption" style={{ marginTop: 8 }}>
                Planning for ~{projections.winterWeeks} winter/off-season weeks.
              </div>
              {projections.notes ? (
                <div className="sv-caption">{projections.notes}</div>
              ) : null}
              {projDebug ? (
                <div className="sv-caption" style={{ color: "var(--muted)" }}>
                  via {projDebug.via}
                </div>
              ) : null}
            </div>

            {/* Preservation plan */}
            <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
              <div className="sv-strong" style={{ marginBottom: 8 }}>
                Preservation To-Do (cover off-season)
              </div>
              {projections.preserve &&
              projections.preserve.plan &&
              projections.preserve.plan.length ? (
                <ul className="sv-list sv-text-sm">
                  {projections.preserve.plan.map((p, i) => (
                    <li key={`${p.item}-${i}`}>
                      <strong>{p.item}</strong>: put up{" "}
                      <strong>
                        {Number(p.perWeekToPutUp).toFixed(
                          p.item === "eggs" ? 0 : 1
                        )}
                      </strong>{" "}
                      /wk × {p.weeksToCover} wks. Methods:{" "}
                      {p.methods.join(", ")}
                      {p.note ? ` — ${p.note}` : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="sv-caption">
                  No preservation needed based on current settings.
                </p>
              )}

              {projections.preserve && projections.preserve.surplus ? (
                <div className="sv-caption" style={{ marginTop: 6 }}>
                  Weekly surplus (during season): eggs{" "}
                  {Math.max(0, projections.preserve.surplus.eggs).toFixed(0)},
                  milk{" "}
                  {Math.max(0, projections.preserve.surplus.milkL).toFixed(1)}{" "}
                  L, meat{" "}
                  {Math.max(0, projections.preserve.surplus.meatKg).toFixed(1)}{" "}
                  kg.
                </div>
              ) : null}
            </div>

            {/* If shortfalls exist, suggest actions */}
            <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
              <div className="sv-strong" style={{ marginBottom: 8 }}>
                If You’re Short…
              </div>
              <ul className="sv-list sv-text-sm">
                <li>
                  Add a hatch/raise cycle (incubate or buy pullets to replace
                  aging layers).
                </li>
                <li>
                  Shift to dual-purpose breeds or add a ruminant (goat/cow) for
                  milk.
                </li>
                <li>
                  Schedule harvests to front-load freezer stores; can or
                  freeze-dry extra.
                </li>
                <li>
                  Use the purchase list for gaps you won’t fill with animals
                  this season.
                </li>
              </ul>
            </div>
          </>
        ) : (
          <div style={{ marginTop: 8 }}>
            <p className="sv-caption">
              No projections yet. Estimate animals, add Quick Animals, or
              re-sync your queue.
            </p>
            <div className="sv-grid-3 sv-gap" style={{ marginTop: 12 }}>
              <Skeleton className="sv-card" />
              <Skeleton className="sv-card" />
              <Skeleton className="sv-card" />
            </div>
          </div>
        )}
      </section>

      {/* TASKS */}
      <section className="sv-block">
        <h2 className="sv-sectionTitle">📋 Animal Tasks</h2>
        {animalTasks.length > 0 ? (
          <ul className="sv-stack">
            {animalTasks.map((task) => (
              <li
                key={String((task && task.id) || Math.random())}
                className="sv-card sv-pad sv-row sv-justify-between sv-align-center"
              >
                <div>
                  <p className="sv-strong">
                    {String((task && task.name) || "Unnamed task")}
                  </p>
                  {task && task.description ? (
                    <p className="sv-caption">{String(task.description)}</p>
                  ) : null}
                  <p className="sv-caption">
                    🐾 Role:{" "}
                    {task && task.assignedRole
                      ? String(task.assignedRole)
                      : "Unassigned"}
                  </p>
                </div>
                <button
                  onClick={() => markTaskComplete(task && task.id)}
                  className="sv-btn sv-btn--primary sv-btn--sm"
                >
                  ✅ Done
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="sv-caption">No tasks pending for animals.</p>
        )}
      </section>

      {/* LOW INVENTORY */}
      <section className="sv-block">
        <h2 className="sv-sectionTitle">🧂 Low Animal Inventory</h2>
        {lowSupplies.length > 0 ? (
          <ul className="sv-grid-3 sv-gap sv-text-sm">
            {lowSupplies.map((item) => (
              <li
                key={String((item && item.id) || Math.random())}
                className="sv-card sv-pad"
              >
                <p className="sv-strong">{String(item && item.name)}</p>
                <p className="sv-caption">
                  Qty: {String(item && item.quantity)}
                </p>
                {item && item.threshold != null ? (
                  <p className="sv-caption">
                    Threshold: {String(item.threshold)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="sv-caption">All animal supplies stocked.</p>
        )}
      </section>

      {/* REMINDERS */}
      <section className="sv-block">
        <h2 className="sv-sectionTitle">⏰ Animal Health Reminders</h2>
        {animalReminders.length > 0 ? (
          <ul className="sv-stack sv-text-sm">
            {animalReminders.map((r, idx) => (
              <li key={String((r && r.id) || idx)} className="sv-card sv-pad">
                <p className="sv-strong">{String((r && r.message) || "")}</p>
                {r && r.date ? (
                  <p className="sv-caption">
                    Scheduled: {new Date(r.date).toLocaleDateString()}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="sv-caption">No upcoming animal care reminders.</p>
        )}
      </section>

      {/* Optional: last automation output for debugging */}
      {lastOutput ? (
        <div className="sv-card sv-pad" style={{ marginTop: 16 }}>
          <div className="sv-strong" style={{ marginBottom: 6 }}>
            Last Automation Output
          </div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {JSON.stringify(lastOutput, null, 2)}
          </pre>
        </div>
      ) : null}

      {/* Toast */}
      <Toast toast={toast} onUndo={undoLastQuick} onClose={dismissToast} />

      {/* Swap modal for multiple sessions */}
      <SessionSwapModal
        open={swapOpen}
        onClose={() => setSwapOpen(false)}
        sessions={swapSessions}
        onPick={pickAndPlay}
        isFavorite={isSessionFavorite}
        onToggleFavorite={toggleFavoriteSession}
      />

      {/* Mini HUD */}
      <SessionHud
        active={activeSession}
        onPause={hudPauseResume}
        onNext={hudNext}
        onOpen={hudOpen}
      />
    </div>
  );
}

/** ------------------------------ Self-tests ------------------------------ */

// These run at module load in dev builds and help catch regressions without a full test runner.
try {
  const _a = mergeAnimals(
    [{ type: "Chicken", count: 2 }],
    [{ type: "chicken", count: 3 }]
  );
  console.assert(
    Array.isArray(_a) && _a.find((x) => x.type === "chicken" && x.count === 5),
    "mergeAnimals should merge case-insensitively"
  );

  console.assert(
    clampPct(-10) === 0 && clampPct(250) === 100 && clampPct(37) === 37,
    "clampPct bounds"
  );

  const _d = deriveAnimals({
    plan: {
      animals: [
        { type: "hen", count: 4 },
        { type: "goat", count: 1 },
      ],
    },
    tasks: [{ name: "buy 6 broilers" }],
  });
  const types = _d
    .map((x) => x.type)
    .sort()
    .join(",");

  console.assert(
    types.indexOf("broiler") >= 0 &&
      types.indexOf("chicken") >= 0 &&
      types.indexOf("goat") >= 0,
    "deriveAnimals canonicalizes"
  );

  const prod = simpleProduction([
    { type: "chicken", count: 2 },
    { type: "goat", count: 1 },
  ]);

  console.assert(
    prod.eggs === 10 && prod.milkL === 14,
    "simpleProduction math"
  );

  // NEW: care items seed key format sanity
  console.assert(
    typeof getHouseholdId() === "string" && getHouseholdId().length > 0,
    "getHouseholdId should return a string"
  );
} catch (e) {
  // No-op: self-tests are best-effort and should never break the app
}
