// src/pages/inventory.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as SupplyInventoryManagerMod from "../managers/SupplyInventoryManager";
import * as InventoryMonitorMod from "../managers/InventoryMonitor";
import ReminderManager from "../managers/ReminderManager";
import { automation } from "@/services/automation/runtime";
import "../index.css";

/* ------------------------ QuickAdd (modal + engine) ------------------------- */
import QuickAddModal from "@/components/quickadd/QuickAddModal";
import QuickAddEngine from "@/services/quickadd/QuickAddEngine";

/* ----------------------- Soft/defensive shared imports ---------------------- */
let eventBus = { emit: () => {}, on: () => () => {}, off: () => {} };
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eb || eventBus;
} catch {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const eb2 = require("@/services/events/eventBus");
    eventBus = eb2?.default || eb2?.eventBus || eb2 || eventBus;
  } catch {
    try {
      // eslint-disable-next-line global-require
      const eb3 = require("../services/events/eventBus");
      eventBus = eb3?.default || eb3?.eventBus || eb3 || eventBus;
    } catch {}
  }
}

let getDb = async () => null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const dbMod = require("@/services/db");
  const db = dbMod?.default || dbMod?.db || dbMod;
  getDb = async () => db;
} catch {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const dbMod2 = require("@/db");
    const db2 = dbMod2?.default || dbMod2?.db || dbMod2;
    getDb = async () => db2;
  } catch {
    try {
      // eslint-disable-next-line global-require
      const dbMod3 = require("../services/db");
      const db3 = dbMod3?.default || dbMod3?.db || dbMod3;
      getDb = async () => db3;
    } catch {}
  }
}

/* ---------------------- Contracts / data shapes (JS) ------------------------ */
/**
 * NutritionTargets (canonical)
 * {
 *   id, householdId, personId,
 *   macros:{ calories, protein_g, carbs_g, fat_g },
 *   micros:{ ...optional },
 *   constraints:{ dietStyle, allergens:[], excludes:[], preferences:[] },
 *   source:{ tool:"macro|micro|bmi", runId },
 *   appliedAt, createdAt
 * }
 *
 * MealPlanDraft
 * { id, householdId, personId, targetsId, createdAt, updatedAt, days:[], notes, status }
 *
 * GroceryDraft
 * { id, householdId, personId, targetsId, mealPlanId, createdAt, updatedAt, items:[], shortages:[], status }
 *
 * SessionDraft
 * { id, householdId, personId, targetsId, mealPlanId, groceryId, createdAt, updatedAt, domain:"cooking",
 *   session:{ title, steps:[{id,text,timerSec,meta}], timers:[...], ingredients:[...], equipment:[...] },
 *   status
 * }
 */

/* ------------------------------ Draft store -------------------------------- */
function makeId(prefix = "id") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function now() {
  return Date.now();
}
function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

const memoryStore = (() => {
  const m = new Map();
  return {
    async get(table, id) {
      return m.get(`${table}:${id}`) || null;
    },
    async put(table, row) {
      if (!row?.id) return null;
      m.set(`${table}:${row.id}`, row);
      return row.id;
    },
    async upsert(table, row) {
      return this.put(table, row);
    },
    async latestBy(table, predicate = () => true) {
      const all = [];
      for (const [k, v] of m.entries()) {
        if (k.startsWith(`${table}:`) && predicate(v)) all.push(v);
      }
      all.sort(
        (a, b) =>
          Number(b.updatedAt || b.createdAt || 0) -
          Number(a.updatedAt || a.createdAt || 0)
      );
      return all[0] || null;
    },
  };
})();

async function upsertRow(tableName, row) {
  try {
    const db = await getDb();
    const table = db?.[tableName];
    if (!table) return memoryStore.upsert(tableName, row);
    // Dexie supports put() for upsert semantics
    if (typeof table.put === "function") {
      await table.put(row);
      return row.id;
    }
    return memoryStore.upsert(tableName, row);
  } catch {
    return memoryStore.upsert(tableName, row);
  }
}

async function getLatestRow(tableName, predicate = () => true) {
  try {
    const db = await getDb();
    const table = db?.[tableName];
    if (!table) return memoryStore.latestBy(tableName, predicate);
    if (typeof table.toArray === "function") {
      const all = await table.toArray();
      const filtered = all.filter(predicate);
      filtered.sort(
        (a, b) =>
          Number(b.updatedAt || b.createdAt || 0) -
          Number(a.updatedAt || a.createdAt || 0)
      );
      return filtered[0] || null;
    }
    return memoryStore.latestBy(tableName, predicate);
  } catch {
    return memoryStore.latestBy(tableName, predicate);
  }
}

/* ------------------------ Generators (standalone) --------------------------- */
function defaultHouseholdId(settings) {
  // keep SSA standalone: no auth assumptions
  return settings?.householdId || "household-default";
}
function defaultPersonId(settings, targets) {
  return targets?.personId || settings?.personId || "person-default";
}

function normalizeTargets(input, settings) {
  const householdId = defaultHouseholdId(settings);
  const personId = defaultPersonId(settings, input);
  const t = input || {};
  const macros = t.macros || t.targets?.macros || t.macroTargets || {};
  const micros = t.micros || t.targets?.micros || t.microTargets || {};
  const constraints = t.constraints ||
    t.dietConstraints || {
      dietStyle: t.dietStyle || "standard",
      allergens: safeArray(t.allergens),
      excludes: safeArray(t.excludes),
      preferences: safeArray(t.preferences),
    };

  return {
    id: t.id || makeId("targets"),
    householdId,
    personId,
    macros: {
      calories: Number(macros.calories ?? macros.kcal ?? 0),
      protein_g: Number(macros.protein_g ?? macros.protein ?? 0),
      carbs_g: Number(macros.carbs_g ?? macros.carbs ?? 0),
      fat_g: Number(macros.fat_g ?? macros.fat ?? 0),
    },
    micros,
    constraints,
    source: t.source || {
      tool: t.tool || "nutrition",
      runId: t.runId || makeId("run"),
    },
    createdAt: Number(t.createdAt || now()),
    appliedAt: Number(t.appliedAt || now()),
  };
}

function generateMealPlanFromTargets(targets) {
  // Minimal, deterministic, standalone draft generator.
  // If you have an engine/template later, it can replace this.
  const kcal = Number(targets?.macros?.calories || 0);
  const style = targets?.constraints?.dietStyle || "standard";
  const excludes = safeArray(targets?.constraints?.excludes).map((s) =>
    String(s).toLowerCase()
  );

  const avoidPork = excludes.some((x) => x.includes("pork"));
  const proteinPick = avoidPork ? "chicken" : "chicken";
  const carbPick = style.includes("low") ? "cauliflower rice" : "rice";
  const vegPick = "mixed vegetables";

  // A very simple 3-day plan stub; your real Meal Planner can overwrite later.
  const days = [
    {
      day: 1,
      meals: [
        { name: `${proteinPick} curry with ${carbPick}`, tags: ["dinner"] },
      ],
    },
    {
      day: 2,
      meals: [{ name: `${proteinPick} bowl with ${vegPick}`, tags: ["lunch"] }],
    },
    {
      day: 3,
      meals: [{ name: `butter ${proteinPick} with naan`, tags: ["dinner"] }],
    },
  ];

  return {
    id: makeId("mealplan"),
    householdId: targets.householdId,
    personId: targets.personId,
    targetsId: targets.id,
    createdAt: now(),
    updatedAt: now(),
    status: "draft",
    notes: kcal ? `Target kcal/day: ${kcal}` : "",
    days,
  };
}

function groceryFromMealPlan(mealPlan, targets) {
  const items = [];
  const add = (name, qty, unit, category = "cooking") => {
    items.push({
      id: makeId("gitem"),
      name,
      qty,
      unit,
      category,
      derivedFrom: { mealPlanId: mealPlan?.id, targetsId: targets?.id },
    });
  };

  // Basic ingredients based on plan strings
  const allMealNames = safeArray(mealPlan?.days)
    .flatMap((d) => safeArray(d.meals))
    .map((m) => String(m.name || "").toLowerCase())
    .join(" | ");

  if (allMealNames.includes("curry")) {
    add("coconut milk", 3, "cans");
    add("curry powder", 1, "jar");
    add("onion", 3, "pcs");
    add("garlic", 1, "bulb");
  }
  if (allMealNames.includes("butter")) add("butter", 2, "sticks");
  if (allMealNames.includes("naan")) add("naan ingredients / naan", 1, "set");
  if (allMealNames.includes("chicken")) add("chicken", 6, "lbs");
  if (allMealNames.includes("rice")) add("rice", 5, "lbs");
  if (allMealNames.includes("vegetable")) add("mixed vegetables", 2, "bags");

  // Honor obvious exclusions/allergens
  const excludes = safeArray(targets?.constraints?.excludes).map((s) =>
    String(s).toLowerCase()
  );
  const allergens = safeArray(targets?.constraints?.allergens).map((s) =>
    String(s).toLowerCase()
  );

  const filtered = items.filter((it) => {
    const n = String(it.name || "").toLowerCase();
    if (excludes.some((x) => x && n.includes(x))) return false;
    if (allergens.some((a) => a && n.includes(a))) return false;
    return true;
  });

  return {
    id: makeId("grocery"),
    householdId: targets.householdId,
    personId: targets.personId,
    targetsId: targets.id,
    mealPlanId: mealPlan.id,
    createdAt: now(),
    updatedAt: now(),
    status: "draft",
    items: filtered,
    shortages: [], // filled by shortage detection
  };
}

function detectShortagesAgainstInventory(groceryDraft, inventory) {
  const inv = safeArray(inventory);
  const byName = new Map(
    inv.map((it) => [String(it.name || "").toLowerCase(), it])
  );
  const shortages = [];

  safeArray(groceryDraft?.items).forEach((g) => {
    const key = String(g.name || "").toLowerCase();
    const have = byName.get(key);
    if (!have) {
      shortages.push({
        id: makeId("short"),
        name: g.name,
        needQty: g.qty,
        needUnit: g.unit,
        haveQty: 0,
        haveUnit: "",
        reason: "missing",
      });
      return;
    }
    const haveQty = Number(have.quantity ?? 0);
    const needQty = Number(g.qty ?? 0);
    // crude compare: if units mismatch, still warn
    const unitMismatch =
      g.unit && have.unit && String(g.unit) !== String(have.unit);
    if (unitMismatch || (Number.isFinite(needQty) && haveQty < needQty)) {
      shortages.push({
        id: makeId("short"),
        name: g.name,
        needQty,
        needUnit: g.unit,
        haveQty,
        haveUnit: have.unit,
        reason: unitMismatch ? "unit_mismatch" : "insufficient",
      });
    }
  });

  return shortages;
}

function sessionFromMealAndGrocery(mealPlan, groceryDraft, targets) {
  // Minimal session steps/timers stub; your CookingSessionEngine can replace later.
  const steps = [];
  const timers = [];

  const pushStep = (text, timerSec = 0, meta = {}) => {
    const id = makeId("step");
    steps.push({ id, text, timerSec, meta });
    if (timerSec > 0)
      timers.push({
        id: makeId("timer"),
        stepId: id,
        label: text,
        seconds: timerSec,
      });
  };

  pushStep("Wash hands, clear workspace, gather ingredients/equipment.", 0, {
    phase: "setup",
  });
  pushStep("Prep: dice onion, mince garlic, measure spices.", 10 * 60, {
    phase: "prep",
  });
  pushStep("Sauté aromatics, toast spices.", 6 * 60, { phase: "cook" });
  pushStep("Add protein and sauce base; simmer.", 20 * 60, { phase: "cook" });
  pushStep("Finish: adjust salt/acid, add butter (if applicable).", 0, {
    phase: "finish",
  });
  pushStep("Serve and log leftovers to inventory.", 0, { phase: "wrap" });

  const ingredients = safeArray(groceryDraft?.items).map((it) => ({
    name: it.name,
    qty: it.qty,
    unit: it.unit,
  }));

  return {
    id: makeId("sessiondraft"),
    householdId: targets.householdId,
    personId: targets.personId,
    targetsId: targets.id,
    mealPlanId: mealPlan.id,
    groceryId: groceryDraft.id,
    createdAt: now(),
    updatedAt: now(),
    domain: "cooking",
    status: "draft",
    session: {
      title: "Cooking Session (Nutrition-aligned)",
      steps,
      timers,
      ingredients,
      equipment: [],
    },
  };
}

/* ----------------------------- UI constants -------------------------------- */
const CATEGORY_TABS = [
  { label: "🍳 Cooking", value: "cooking" },
  { label: "🧼 Cleaning", value: "cleaning" },
  { label: "🐓 Animal Feed", value: "animal" },
  { label: "🌿 Garden Tools", value: "garden" },
];

/* ------------------ Defensive manager helpers ------------------ */
const resolve = (mod) => (mod && mod.default ? mod.default : mod);

async function getAllItemsSafe() {
  const M = resolve(SupplyInventoryManagerMod);
  if (M?.getAll) return await M.getAll();
  if (M?.list) return await M.list();
  if (M?.getAllItems) return await M.getAllItems();
  if (M?.get) {
    const maybe = await M.get("items");
    if (Array.isArray(maybe)) return maybe;
  }
  if (Array.isArray(M?.items)) return M.items;
  return [];
}

async function saveItemSafe(item) {
  const M = resolve(SupplyInventoryManagerMod);
  if (M?.save) return M.save(item);
  if (M?.upsert) return M.upsert(item);
  if (M?.add) return M.add(item);
  // fallback: let agents/templates persist
  automation.emit("event", { type: "inventory/item_added", payload: { item } });
}

async function checkAllForRestockSafe(items) {
  const Mon = resolve(InventoryMonitorMod);
  if (Mon?.checkAllForRestock) return await Mon.checkAllForRestock(items);
  if (Mon?.scanAll) return await Mon.scanAll(items);
  if (Mon?.scan) return await Mon.scan(items);
  // Local fallback using common fields like threshold/restockAt/minQty
  return (items || []).filter((it) => {
    const q = Number(it.quantity ?? 0);
    const t = Number(it.threshold ?? it.restockAt ?? it.minQty ?? NaN);
    return Number.isFinite(t) && q <= t;
  });
}

/* --------------------------- Utils --------------------------- */
function useDebounce(cb, delay = 700) {
  const t = useRef(null);
  return (...args) => {
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => cb(...args), delay);
  };
}

export default function InventoryPage() {
  const qa = useMemo(() => new QuickAddEngine(), []);

  const [inventory, setInventory] = useState([]);
  const [activeCategory, setActiveCategory] = useState("cooking");

  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);

  // Insights state
  const [lastOutput, setLastOutput] = useState(null); // keeps structured results for Insights
  const [lowNow, setLowNow] = useState([]); // latest restock list (array of items)
  const [lastSyncAt, setLastSyncAt] = useState(null); // epoch ms
  const [activity, setActivity] = useState([]); // [{ts, icon, text}]

  // Quick-add
  const [newName, setNewName] = useState("");
  const [newQty, setNewQty] = useState("");
  const [newUnit, setNewUnit] = useState("");

  // Settings that drive background agents
  const [settings, setSettings] = useState({
    householdSize: 2,
    storageLocations: ["Pantry", "Fridge", "Freezer", "Garage"],
    defaultLeadDays: 3,
    autoReorder: false,
    monthlyBudget: 300,
  });

  /* ---------------- Nutrition → MealPlan → Grocery → Session state ---------- */
  const [activeTargets, setActiveTargets] = useState(null); // NutritionTargets
  const [mealPlanDraft, setMealPlanDraft] = useState(null); // MealPlanDraft
  const [groceryDraft, setGroceryDraft] = useState(null); // GroceryDraft
  const [sessionDraft, setSessionDraft] = useState(null); // SessionDraft
  const [draftError, setDraftError] = useState(null);
  const [draftBusy, setDraftBusy] = useState(false);

  const householdId = defaultHouseholdId(settings);
  const personId = defaultPersonId(settings, activeTargets);

  const debouncedRecompute = useDebounce(async (state) => {
    try {
      // 1) Smart sync
      const resSync = await automation.runTemplate("inventory.sync", {
        invokedBy: "ui/inventory",
        known: state.inventory.map((i) => ({
          id: i.id,
          name: i.name,
          category: i.category,
          quantity: i.quantity,
          unit: i.unit,
          location: i.location,
          tags: i.tags,
        })),
        settings: state.settings,
      });
      if (Array.isArray(resSync?.items)) {
        setInventory(resSync.items);
        setLastSyncAt(Date.now());
      }

      // 2) Forecast + restock scan
      const resScan = await automation.runTemplate("inventory.restock.scan", {
        invokedBy: "ui/inventory",
        known: resSync?.items || state.inventory,
        settings: state.settings,
        category: state.activeCategory,
      });

      if (Array.isArray(resScan?.low)) {
        setLowNow(resScan.low);
        try {
          ReminderManager.handleLowInventory?.(resScan.low);
        } catch {}
        if (state.settings.autoReorder) {
          try {
            const orderRes = await automation.runTemplate(
              "inventory.autoreorder",
              {
                items: resScan.low,
                settings: state.settings,
                invokedBy: "ui/inventory",
              }
            );
            setLastOutput((o) => ({ ...(o || {}), autoReorder: orderRes }));
          } catch {}
        }
      } else {
        const lowItems = await checkAllForRestockSafe(
          resSync?.items || state.inventory
        );
        setLowNow(lowItems);
        try {
          ReminderManager.handleLowInventory?.(lowItems);
        } catch {}
      }

      setLastOutput((o) => ({ ...(o || {}), sync: resSync, scan: resScan }));
    } catch {
      // Soft fallback
      const lowItems = await checkAllForRestockSafe(state.inventory);
      setLowNow(lowItems);
      try {
        ReminderManager.handleLowInventory?.(lowItems);
      } catch {}
      automation.emit("event", {
        type: "inventory/background_update",
        payload: { settings: state.settings, category: state.activeCategory },
      });
    }
  }, 700);

  useEffect(() => {
    (async () => {
      await loadInventory();
      debouncedRecompute({ inventory, settings, activeCategory });

      // Hydrate latest drafts (Dexie or memory)
      const lastTargets = await getLatestRow(
        "nutritionTargetsHistory",
        (r) => r?.householdId === householdId
      );
      const lastMeal = await getLatestRow(
        "mealPlanDrafts",
        (r) => r?.householdId === householdId
      );
      const lastGrocery = await getLatestRow(
        "groceryDrafts",
        (r) => r?.householdId === householdId
      );
      const lastSession = await getLatestRow(
        "sessionDrafts",
        (r) => r?.householdId === householdId
      );

      if (lastTargets) setActiveTargets(lastTargets);
      if (lastMeal) setMealPlanDraft(lastMeal);
      if (lastGrocery) setGroceryDraft(lastGrocery);
      if (lastSession) setSessionDraft(lastSession);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (inventory) debouncedRecompute({ inventory, settings, activeCategory });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, activeCategory, inventory.length]);

  // Stream automation events into a tiny activity timeline (most recent 6)
  useEffect(() => {
    const push = (e) => {
      const topic = e?.topic || e?.type || "";
      let icon = "🛈";
      if (topic.includes("restock")) icon = "🛒";
      else if (topic.includes("sync")) icon = "🔄";
      else if (topic.includes("item_added")) icon = "➕";
      else if (topic.includes("template")) icon = "⚙️";
      else if (topic.includes("draft")) icon = "📝";
      else if (topic.includes("nutrition")) icon = "🥗";
      else if (topic.includes("session")) icon = "⏱️";
      setActivity((prev) => {
        const next = [{ ts: e.ts || Date.now(), icon, text: topic }, ...prev];
        return next.slice(0, 6);
      });
    };
    automation.on("event", push);
    automation.on("runtime", push);
    return () => {
      automation.off("event", push);
      automation.off("runtime", push);
    };
  }, []);

  /* -------------------- Event wiring: refresh UI without reload -------------- */
  useEffect(() => {
    // EventBus chain listener(s)
    const offA = eventBus.on?.("nutrition.targets.applied", async (payload) => {
      setDraftError(null);
      setDraftBusy(true);
      try {
        const targets = normalizeTargets(payload?.targets || payload, settings);
        setActiveTargets(targets);

        await upsertRow("nutritionTargetsHistory", targets);

        eventBus.emit?.("nutrition.targets.applied", { ...targets, ts: now() }); // allow fan-out listeners
        automation.emit?.("event", {
          type: "nutrition.targets.applied",
          payload: targets,
        });

        // Meal plan regeneration (standalone; can be replaced by real engine/template)
        let mealDraft = null;
        try {
          const res = await automation.runTemplate?.("mealplan.generate", {
            invokedBy: "event/nutrition.targets.applied",
            targets,
            settings,
          });
          if (res?.draft) mealDraft = res.draft;
        } catch {}

        if (!mealDraft) mealDraft = generateMealPlanFromTargets(targets);
        mealDraft.updatedAt = now();

        setMealPlanDraft(mealDraft);
        await upsertRow("mealPlanDrafts", mealDraft);

        eventBus.emit?.("mealplan.draft.updated", mealDraft);
        automation.emit?.("event", {
          type: "mealplan.draft.updated",
          payload: mealDraft,
        });
      } catch (e) {
        setDraftError(String(e?.message || e || "Failed to apply targets"));
      } finally {
        setDraftBusy(false);
      }
    });

    // If some other page generates/updates mealplan draft, reflect it here
    const offB = eventBus.on?.("mealplan.draft.updated", async (draft) => {
      if (!draft?.id) return;
      if (draft?.householdId && draft.householdId !== householdId) return;
      setMealPlanDraft(draft);
      await upsertRow("mealPlanDrafts", { ...draft, updatedAt: now() });
    });

    // Grocery draft fan-in
    const offC = eventBus.on?.("grocery.draft.generated", async (draft) => {
      if (!draft?.id) return;
      if (draft?.householdId && draft.householdId !== householdId) return;
      setGroceryDraft(draft);
      await upsertRow("groceryDrafts", { ...draft, updatedAt: now() });
    });

    // Session draft fan-in
    const offD = eventBus.on?.("session.draft.created", async (draft) => {
      if (!draft?.id) return;
      if (draft?.householdId && draft.householdId !== householdId) return;
      setSessionDraft(draft);
      await upsertRow("sessionDrafts", { ...draft, updatedAt: now() });
    });

    return () => {
      try {
        offA?.();
        offB?.();
        offC?.();
        offD?.();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId, settings]);

  /* -------- Listen for inventory.item.created to refresh without reload ------ */
  useEffect(() => {
    function onCreated(e) {
      const payload = e?.detail || {};
      const item = payload?.item;
      if (!item) return;

      // ✅ Refresh UI without reload
      // Prefer a full reload to avoid inconsistencies between managers/automation.
      try {
        loadInventory();
      } catch {}

      // Optionally: nudge activity feed
      try {
        automation.emit?.("event", {
          type: "inventory.item.created",
          payload: { item },
        });
      } catch {}
    }

    window.addEventListener("inventory.item.created", onCreated);
    return () =>
      window.removeEventListener("inventory.item.created", onCreated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadInventory() {
    try {
      const allItems = await getAllItemsSafe();
      setInventory(Array.isArray(allItems) ? allItems : []);
    } catch (e) {
      console.error("Failed to load inventory:", e);
      setInventory([]);
    }
  }

  async function scanRestockLocal() {
    try {
      const lowItems = await checkAllForRestockSafe(inventory);
      setLowNow(lowItems);
      try {
        ReminderManager.handleLowInventory?.(lowItems);
      } catch {}
    } catch (e) {
      console.error("Restock scan failed:", e);
    }
  }

  const filteredItems = useMemo(
    () =>
      inventory.filter((item) =>
        String(item.category || "")
          .toLowerCase()
          .includes(activeCategory)
      ),
    [inventory, activeCategory]
  );

  // === Manual triggers ===
  const syncInventory = async () => {
    setBusy(true);
    setOk(false);
    try {
      const res = await automation.runTemplate("inventory.sync", {
        invokedBy: "ui/inventory",
        known: inventory.map((i) => ({
          id: i.id,
          name: i.name,
          category: i.category,
          quantity: i.quantity,
          unit: i.unit,
          location: i.location,
          tags: i.tags,
        })),
        settings,
      });
      if (Array.isArray(res?.items)) setInventory(res.items);
      setLastSyncAt(Date.now());
      setLastOutput((o) => ({ ...(o || {}), sync: res }));
    } catch (e) {
      automation.emit("event", {
        type: "inventory/sync_request",
        payload: { known: inventory, settings },
      });
    } finally {
      setBusy(false);
      setOk(true);
      setTimeout(() => setOk(false), 900);
    }
  };

  const runRestockScan = async () => {
    setBusy(true);
    setOk(false);
    try {
      const res = await automation.runTemplate("inventory.restock.scan", {
        invokedBy: "ui/inventory",
        known: inventory,
        settings,
        category: activeCategory,
      });
      if (Array.isArray(res?.low)) {
        setLowNow(res.low);
        try {
          ReminderManager.handleLowInventory?.(res.low);
        } catch {}
      } else {
        await scanRestockLocal();
      }
      setLastOutput((o) => ({ ...(o || {}), scan: res }));
    } catch (e) {
      await scanRestockLocal();
      automation.emit("event", {
        type: "inventory/restock_scan",
        payload: { category: activeCategory, settings },
      });
    } finally {
      setBusy(false);
      setOk(true);
      setTimeout(() => setOk(false), 900);
    }
  };

  const quickAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    const item = {
      id: `inv-${Date.now()}`,
      name,
      quantity: Number(newQty || 0),
      unit: newUnit || "",
      category: activeCategory,
      location: "Unassigned",
      tags: [],
    };
    setBusy(true);
    try {
      await saveItemSafe(item);
      setNewName("");
      setNewQty("");
      setNewUnit("");
      await loadInventory();
      // soft activity marker
      automation.emit("event", {
        type: "inventory/item_added",
        payload: { name, category: activeCategory },
      });
    } finally {
      setBusy(false);
      setOk(true);
      setTimeout(() => setOk(false), 900);
    }
  };

  /* ---------- helpers for insights actions ---------- */
  const exportShoppingCSV = () => {
    const rows = [["Item", "Qty", "Unit", "Location", "Category"]];
    (lowNow || []).forEach((it) => {
      rows.push([
        it.name ?? "",
        it.quantity ?? "",
        it.unit ?? "",
        it.location ?? "",
        it.category ?? "",
      ]);
    });
    const csv = rows
      .map((r) =>
        r
          .map((v) => String(v).replaceAll('"', '""'))
          .map((v) => `"${v}"`)
          .join(",")
      )
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "shopping-list.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const timeAgo = (ts) => {
    if (!ts) return "never";
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  };

  /* ---------------------- Nutrition pipeline actions ------------------------ */
  const applyTargetsToMealPlanLocal = async (targetsLike) => {
    // This is here as a backup demo action if you want to test without going back to the nutrition pages.
    eventBus.emit?.("nutrition.targets.applied", { targets: targetsLike });
  };

  const generateGroceryDraft = async () => {
    setDraftError(null);
    setDraftBusy(true);
    try {
      if (!activeTargets)
        throw new Error(
          "No Nutrition Targets available. Run macros/micros and Apply to Meal Plan."
        );
      if (!mealPlanDraft)
        throw new Error("No Meal Plan Draft yet. Apply targets first.");

      // Create grocery draft
      let draft = null;
      try {
        const res = await automation.runTemplate?.("grocery.generate", {
          invokedBy: "ui/inventory",
          targets: activeTargets,
          mealPlan: mealPlanDraft,
          settings,
        });
        if (res?.draft) draft = res.draft;
      } catch {}

      if (!draft) draft = groceryFromMealPlan(mealPlanDraft, activeTargets);

      // Detect shortages *before* announcing grocery is ready (required chain)
      const shortages = detectShortagesAgainstInventory(draft, inventory);
      draft.shortages = shortages;
      draft.updatedAt = now();

      setGroceryDraft(draft);
      await upsertRow("groceryDrafts", draft);

      eventBus.emit?.("inventory.shortage.detected", {
        householdId,
        personId,
        targetsId: activeTargets.id,
        mealPlanId: mealPlanDraft.id,
        groceryId: draft.id,
        shortages,
        ts: now(),
      });
      automation.emit?.("event", {
        type: "inventory.shortage.detected",
        payload: { shortages, groceryId: draft.id },
      });

      eventBus.emit?.("grocery.draft.generated", draft);
      automation.emit?.("event", {
        type: "grocery.draft.generated",
        payload: draft,
      });
    } catch (e) {
      setDraftError(
        String(e?.message || e || "Failed to generate grocery draft")
      );
    } finally {
      setDraftBusy(false);
    }
  };

  const startCookingSessionFromDrafts = async () => {
    setDraftError(null);
    setDraftBusy(true);
    try {
      if (!activeTargets) throw new Error("No Nutrition Targets available.");
      if (!mealPlanDraft) throw new Error("No Meal Plan Draft available.");
      if (!groceryDraft)
        throw new Error("No Grocery Draft available. Generate it first.");

      let draft = null;
      try {
        const res = await automation.runTemplate?.(
          "cooking.session.fromDrafts",
          {
            invokedBy: "ui/inventory",
            targets: activeTargets,
            mealPlan: mealPlanDraft,
            grocery: groceryDraft,
            settings,
          }
        );
        if (res?.draft) draft = res.draft;
      } catch {}

      if (!draft)
        draft = sessionFromMealAndGrocery(
          mealPlanDraft,
          groceryDraft,
          activeTargets
        );
      draft.updatedAt = now();

      setSessionDraft(draft);
      await upsertRow("sessionDrafts", draft);

      eventBus.emit?.("session.draft.created", draft);
      automation.emit?.("event", {
        type: "session.draft.created",
        payload: draft,
      });

      // “Start” the session (required chain). Your SessionRunner can pick this up.
      eventBus.emit?.("session.started", {
        id: makeId("session"),
        draftId: draft.id,
        domain: "cooking",
        householdId: draft.householdId,
        personId: draft.personId,
        ts: now(),
      });
      automation.emit?.("event", {
        type: "session.started",
        payload: { draftId: draft.id, domain: "cooking" },
      });
    } catch (e) {
      setDraftError(
        String(e?.message || e || "Failed to start cooking session")
      );
    } finally {
      setDraftBusy(false);
    }
  };

  const resetNutritionPipeline = async () => {
    setDraftError(null);
    setActiveTargets(null);
    setMealPlanDraft(null);
    setGroceryDraft(null);
    setSessionDraft(null);
    eventBus.emit?.("nutrition.pipeline.reset", {
      householdId,
      personId,
      ts: now(),
    });
    automation.emit?.("event", {
      type: "nutrition.pipeline.reset",
      payload: { householdId, personId },
    });
  };

  const lowCount = lowNow?.length || 0;
  const autoReorderOn = !!settings.autoReorder;

  const groceryItemCount = safeArray(groceryDraft?.items).length;
  const shortageCount = safeArray(groceryDraft?.shortages).length;
  const mealDaysCount = safeArray(mealPlanDraft?.days).length;
  const sessionStepCount = safeArray(sessionDraft?.session?.steps).length;

  return (
    <div>
      <h1>📦 Household Inventory</h1>
      <p className="subtitle">
        Track cooking, cleaning, animal feed, and garden supplies across your
        storage locations.
      </p>

      {/* Settings (inputs → background automations) */}
      <SettingsEditor
        settings={settings}
        onChange={(next) => setSettings(next)}
      />

      {/* ================= Nutrition → Meal Plan → Grocery → Session ============ */}
      <div
        className="card"
        style={{ marginBottom: 12, background: "#fff", borderColor: "#e5e7eb" }}
      >
        <div
          className="subtitle"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
          }}
        >
          <strong>
            🥗 Nutrition → 🍽️ Meal Plan → 🛒 Grocery → ⏱️ Cooking Session
          </strong>
          <span className="subtitle" style={{ opacity: 0.85 }}>
            {draftBusy
              ? "Working…"
              : activeTargets
              ? "Targets ready"
              : "Awaiting targets"}
          </span>
        </div>

        {draftError ? (
          <div
            style={{
              marginTop: 8,
              padding: 10,
              borderRadius: 12,
              border: "1px solid rgba(239,68,68,.35)",
              background: "rgba(239,68,68,.08)",
            }}
          >
            <div style={{ fontWeight: 700, color: "var(--danger)" }}>
              Pipeline Error
            </div>
            <div className="subtitle" style={{ opacity: 0.9 }}>
              {draftError}
            </div>
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gap: 10,
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            marginTop: 10,
          }}
        >
          <InsightCard
            title="Targets"
            value={activeTargets ? "Applied" : "—"}
            hint={
              activeTargets
                ? `Person: ${activeTargets.personId}`
                : "Run macros/micros and Apply to Meal Plan"
            }
            tone={activeTargets ? "ok" : "muted"}
          />
          <InsightCard
            title="Meal Plan Draft"
            value={mealPlanDraft ? `${mealDaysCount} days` : "—"}
            hint={
              mealPlanDraft
                ? `Updated ${timeAgo(mealPlanDraft.updatedAt)}`
                : "Generated after targets applied"
            }
            tone={mealPlanDraft ? "ok" : "muted"}
          />
          <InsightCard
            title="Grocery Draft"
            value={groceryDraft ? `${groceryItemCount} items` : "—"}
            hint={
              groceryDraft
                ? `${shortageCount} shortages flagged`
                : "Generate from meal plan"
            }
            tone={groceryDraft ? (shortageCount ? "warn" : "ok") : "muted"}
          />
          <InsightCard
            title="Session Draft"
            value={sessionDraft ? `${sessionStepCount} steps` : "—"}
            hint={
              sessionDraft
                ? "Ready to start SessionRunner"
                : "Create from meal + grocery"
            }
            tone={sessionDraft ? "ok" : "muted"}
          />
        </div>

        <div
          className="flex"
          style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}
        >
          {/* Optional test button (safe): lets you validate pipeline without leaving the page */}
          <button
            className="btn sm"
            aria-busy={draftBusy}
            onClick={() =>
              applyTargetsToMealPlanLocal(
                normalizeTargets(
                  {
                    macros: {
                      calories: 2000,
                      protein_g: 140,
                      carbs_g: 180,
                      fat_g: 70,
                    },
                    constraints: {
                      dietStyle: "standard",
                      allergens: [],
                      excludes: [],
                      preferences: [],
                    },
                    source: { tool: "local-test", runId: makeId("run") },
                  },
                  settings
                )
              )
            }
            title="Dev/Test only: emits nutrition.targets.applied"
          >
            🧪 Test Apply Targets
          </button>

          <button
            className="btn sm primary"
            aria-busy={draftBusy}
            onClick={generateGroceryDraft}
            disabled={!mealPlanDraft}
          >
            🛒 Generate Grocery List
          </button>

          <button
            className="btn sm primary"
            aria-busy={draftBusy}
            onClick={startCookingSessionFromDrafts}
            disabled={!groceryDraft}
          >
            ⏱️ Start Cooking Session
          </button>

          <button className="btn sm" onClick={resetNutritionPipeline}>
            ♻️ Reset Pipeline
          </button>
        </div>

        {/* Editable grocery draft preview (simple, standalone) */}
        {groceryDraft ? (
          <div style={{ marginTop: 12 }}>
            <div className="subtitle" style={{ fontWeight: 700 }}>
              Grocery Draft (editable)
            </div>
            <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
              {safeArray(groceryDraft.items)
                .slice(0, 10)
                .map((it, idx) => (
                  <div
                    key={it.id || idx}
                    className="flex"
                    style={{
                      alignItems: "center",
                      justifyContent: "space-between",
                      border: "1px solid var(--line)",
                      borderRadius: 12,
                      padding: "8px 10px",
                      background: "#fff",
                      gap: 10,
                    }}
                  >
                    <input
                      className="btn"
                      style={{ flex: 1, minWidth: 180 }}
                      value={String(it.name || "")}
                      onChange={async (e) => {
                        const next = { ...(groceryDraft || {}) };
                        const items = safeArray(next.items).slice();
                        items[idx] = {
                          ...(items[idx] || {}),
                          name: e.target.value,
                        };
                        next.items = items;
                        next.updatedAt = now();
                        setGroceryDraft(next);
                        await upsertRow("groceryDrafts", next);
                        eventBus.emit?.("grocery.draft.generated", next); // treat as update
                        automation.emit?.("event", {
                          type: "grocery.draft.generated",
                          payload: next,
                        });
                      }}
                    />
                    <div className="subtitle" style={{ whiteSpace: "nowrap" }}>
                      {String(it.qty ?? "")} {String(it.unit ?? "")}
                    </div>
                  </div>
                ))}
              {safeArray(groceryDraft.items).length > 10 ? (
                <div className="subtitle" style={{ opacity: 0.8 }}>
                  Showing first 10 items… (
                  {safeArray(groceryDraft.items).length} total)
                </div>
              ) : null}
            </div>

            {shortageCount ? (
              <div style={{ marginTop: 12 }}>
                <div className="subtitle" style={{ fontWeight: 700 }}>
                  Shortages Detected
                </div>
                <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
                  {safeArray(groceryDraft.shortages)
                    .slice(0, 8)
                    .map((s) => (
                      <div
                        key={s.id}
                        className="flex"
                        style={{
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 10,
                        }}
                      >
                        <div>
                          <div style={{ fontWeight: 700 }}>{s.name}</div>
                          <div
                            className="subtitle"
                            style={{ fontSize: ".85rem" }}
                          >
                            Need {s.needQty} {s.needUnit || ""} • Have{" "}
                            {s.haveQty} {s.haveUnit || ""}
                          </div>
                        </div>
                        <span
                          className="subtitle"
                          style={{ color: "var(--danger)", fontWeight: 700 }}
                        >
                          ⚠️
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {/* ====================================================================== */}

      {/* Tabs */}
      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          margin: "6px 0 12px",
        }}
      >
        {CATEGORY_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setActiveCategory(tab.value)}
            className={`btn sm ${
              activeCategory === tab.value ? "primary" : ""
            }`}
          >
            <span className="label">{tab.label}</span>
          </button>
        ))}

        <button className="btn sm" aria-busy={busy} onClick={syncInventory}>
          <span className="label">Sync</span>
        </button>

        <button className="btn sm" aria-busy={busy} onClick={runRestockScan}>
          <span className="label">Scan Restock</span>
        </button>

        {/* Quick Add (modal) */}
        <button
          type="button"
          className="btn sm"
          onClick={() => qa.open({ source: "Inventory", initialText: "" })}
          title="Quick Add Item (minimal typing)"
        >
          Quick Add Item
        </button>

        {ok ? (
          <span className="subtitle" style={{ color: "var(--success)" }}>
            ✓ Updated
          </span>
        ) : null}
      </div>

      {/* Quick Add (legacy inline) */}
      <div className="card">
        <div
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "2fr 1fr 1fr auto",
          }}
        >
          <input
            className="btn"
            placeholder={`Add ${activeCategory} item...`}
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && quickAdd()}
          />
          <input
            className="btn"
            placeholder="Qty"
            inputMode="decimal"
            value={newQty}
            onChange={(e) => setNewQty(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && quickAdd()}
          />
          <input
            className="btn"
            placeholder="Unit (e.g., kg, pcs)"
            value={newUnit}
            onChange={(e) => setNewUnit(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && quickAdd()}
          />
          <button
            className="btn primary sm"
            aria-busy={busy}
            onClick={quickAdd}
          >
            <span className="label">Add</span>
          </button>
        </div>
      </div>

      {/* Inventory Table */}
      <div className="card" style={{ marginTop: 12, overflowX: "auto" }}>
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
              <th style={th}>Qty</th>
              <th style={th}>Unit</th>
              <th style={th}>Location</th>
              <th style={th}>Tags</th>
              <th style={th}>Restock</th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((item) => {
              const low =
                typeof item.shouldRestock === "function"
                  ? item.shouldRestock()
                  : (() => {
                      const t = Number(
                        item.threshold ?? item.restockAt ?? item.minQty ?? NaN
                      );
                      if (!Number.isFinite(t)) return false;
                      return Number(item.quantity ?? 0) <= t;
                    })();
              return (
                <tr
                  key={String(item.id)}
                  style={{
                    background: low ? "#fff1f2" : "transparent",
                    borderTop: "1px solid var(--line)",
                  }}
                >
                  <td style={td}>{String(item.name)}</td>
                  <td style={td}>{String(item.quantity ?? "")}</td>
                  <td style={td}>{String(item.unit ?? "")}</td>
                  <td style={td}>{String(item.location ?? "")}</td>
                  <td style={td}>
                    {Array.isArray(item.tags) ? item.tags.join(", ") : ""}
                  </td>
                  <td style={td}>
                    {low ? (
                      <span style={{ color: "var(--danger)", fontWeight: 700 }}>
                        ⚠️ Low
                      </span>
                    ) : (
                      <span style={{ color: "var(--success)" }}>✅ OK</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {filteredItems.length === 0 && (
          <p
            className="subtitle"
            style={{ textAlign: "center", marginTop: 12 }}
          >
            No items found in this category.
          </p>
        )}
      </div>

      {/* ----------------- Inventory Insights (replaces raw JSON) ----------------- */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="flex" style={{ gap: 12, flexWrap: "wrap" }}>
          <InsightCard
            title="Low Items"
            value={lowCount}
            hint={
              lowCount > 0
                ? "Review & export a shopping list"
                : "All good for now"
            }
            tone={lowCount > 0 ? "warn" : "ok"}
          />
          <InsightCard
            title="Auto-Reorder"
            value={autoReorderOn ? "On" : "Off"}
            hint={
              autoReorderOn
                ? "Orders will be suggested automatically"
                : "Enable in Settings to auto-draft orders"
            }
            tone={autoReorderOn ? "ok" : "muted"}
          />
          <InsightCard
            title="Last Sync"
            value={lastSyncAt ? timeAgo(lastSyncAt) : "—"}
            hint="Keeps inventory aligned across modules"
            tone="muted"
          />
        </div>

        {/* Restock candidates */}
        <div className="subtitle" style={{ marginTop: 12, fontWeight: 700 }}>
          Next Up to Restock
        </div>
        {lowCount === 0 ? (
          <div className="subtitle" style={{ opacity: 0.8 }}>
            No immediate restock needs detected.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8, marginTop: 6 }}>
            {lowNow.slice(0, 6).map((it) => (
              <div
                key={String(it.id || it.name)}
                className="flex"
                style={{
                  alignItems: "center",
                  justifyContent: "space-between",
                  border: "1px solid var(--line)",
                  borderRadius: 12,
                  padding: "8px 10px",
                  background: "#fff",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{it.name}</div>
                  <div className="subtitle" style={{ fontSize: ".85rem" }}>
                    {`${it.quantity ?? "?"} ${it.unit ?? ""}`.trim()} •{" "}
                    {it.location || "Unknown"} •{" "}
                    {it.category || "Uncategorized"}
                  </div>
                </div>
                <span className="subtitle" style={{ color: "var(--danger)" }}>
                  ⚠️ Low
                </span>
              </div>
            ))}
          </div>
        )}

        {/* Suggested actions */}
        <div
          className="flex"
          style={{ gap: 8, marginTop: 12, flexWrap: "wrap" }}
        >
          <button className="btn sm" onClick={runRestockScan}>
            🔁 Rescan
          </button>
          <button
            className="btn sm"
            onClick={exportShoppingCSV}
            disabled={lowCount === 0}
          >
            📄 Export Shopping List (CSV)
          </button>
          <button className="btn sm" onClick={() => window.print()}>
            🖨️ Print
          </button>
        </div>

        {/* Activity timeline */}
        <div className="subtitle" style={{ marginTop: 16, fontWeight: 700 }}>
          Recent Activity
        </div>
        {activity.length === 0 ? (
          <div className="subtitle" style={{ opacity: 0.8 }}>
            No recent activity yet.
          </div>
        ) : (
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              display: "grid",
              gap: 6,
            }}
          >
            {activity.map((a, idx) => (
              <li
                key={idx}
                className="flex"
                style={{ gap: 8, alignItems: "center" }}
              >
                <span style={{ width: 22, textAlign: "center" }}>{a.icon}</span>
                <span style={{ fontSize: ".95rem" }}>{a.text}</span>
                <span className="subtitle" style={{ marginLeft: "auto" }}>
                  {timeAgo(a.ts)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* ---------------------------------------------------------------------- */}

      {/* Mount once (page-level is OK; App root is best) */}
      <QuickAddModal />
    </div>
  );
}

// Reusable cell styles
const th = {
  textAlign: "left",
  padding: "10px 12px",
  fontSize: ".8rem",
  textTransform: "uppercase",
  letterSpacing: ".04em",
  borderBottom: "1px solid var(--line)",
};
const td = { padding: "10px 12px", fontSize: ".95rem" };

/* =================== Settings Editor =================== */
function SettingsEditor({ settings, onChange }) {
  const [local, setLocal] = useState(settings);
  useEffect(() => setLocal(settings), [settings]);

  const update = (patch) => {
    const next = { ...local, ...patch };
    setLocal(next);
    onChange(next);
  };

  const updateList = (txt) =>
    txt
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

  return (
    <div
      className="card"
      style={{ marginBottom: 12, background: "#fff", borderColor: "#e5e7eb" }}
    >
      <div className="subtitle">
        <strong>Inventory Settings</strong>
      </div>
      <div
        style={{
          display: "grid",
          gap: 10,
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
        }}
      >
        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>
            Household Size
          </div>
          <input
            type="number"
            className="btn"
            min={1}
            value={local.householdSize}
            onChange={(e) => update({ householdSize: Number(e.target.value) })}
          />
        </label>

        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>
            Default Lead Time (days)
          </div>
          <input
            type="number"
            className="btn"
            min={0}
            value={local.defaultLeadDays}
            onChange={(e) =>
              update({ defaultLeadDays: Number(e.target.value) })
            }
          />
        </label>

        <label className="field">
          <div className="subtitle" style={{ marginBottom: 4 }}>
            Monthly Budget ($)
          </div>
          <input
            type="number"
            className="btn"
            min={0}
            value={local.monthlyBudget}
            onChange={(e) => update({ monthlyBudget: Number(e.target.value) })}
          />
        </label>

        <label
          className="field"
          style={{ display: "flex", alignItems: "center", gap: 8 }}
        >
          <input
            type="checkbox"
            checked={local.autoReorder}
            onChange={(e) => update({ autoReorder: e.target.checked })}
          />
          <span className="subtitle">
            Enable Auto-Reorder (create reminders/orders)
          </span>
        </label>

        <label className="field" style={{ gridColumn: "1 / -1" }}>
          <div className="subtitle" style={{ marginBottom: 4 }}>
            Storage Locations
          </div>
          <input
            className="btn"
            value={local.storageLocations.join(", ")}
            onChange={(e) =>
              update({ storageLocations: updateList(e.target.value) })
            }
            placeholder="Pantry, Fridge, Freezer, Garage"
          />
        </label>
      </div>
    </div>
  );
}

/* =================== Small UI atoms =================== */
function InsightCard({ title, value, hint, tone = "muted" }) {
  const tones = {
    ok: { bg: "rgba(16,185,129,.10)", border: "rgba(16,185,129,.35)" },
    warn: { bg: "rgba(245,158,11,.10)", border: "rgba(245,158,11,.35)" },
    muted: { bg: "rgba(107,114,128,.08)", border: "rgba(107,114,128,.25)" },
  };
  const t = tones[tone] || tones.muted;
  return (
    <div
      className="card"
      style={{
        minWidth: 220,
        background: t.bg,
        borderColor: t.border,
        borderWidth: 1,
        padding: 12,
      }}
    >
      <div className="subtitle" style={{ fontWeight: 700 }}>
        {title}
      </div>
      <div style={{ fontSize: "1.35rem", fontWeight: 800, lineHeight: 1.2 }}>
        {value}
      </div>
      <div className="subtitle" style={{ opacity: 0.85 }}>
        {hint}
      </div>
    </div>
  );
}
