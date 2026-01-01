/* eslint-disable no-console */

/**
 * InventorySessionService
 * ----------------------------------------------------------------------------- (UNCHANGED HEADER)
 * Facade around the inventory session engine.
 * Gives you a single import for:
 *  - create from scans
 *  - create from storehouse plan
 *  - create from reverse (meals/garden/animals/cleaning → inventory)
 *  - save as favorite (user-owned)
 *  - schedule
 *  - list / complete
 *
 * This is the piece your home page, Tier 2 household dashboards, and
 * Scan • Compare • Trust feature can call easily.
 */

import { getSessionScheduler } from "@/services/scheduling/SessionScheduler";
import { SessionEngineCore } from "@/engines/shared/SessionEngineCore";

/* -------------------------------------------------------------------------- */
/* inventory-specific engine (built on the shared core)                       */
/* -------------------------------------------------------------------------- */

const isBrowser = typeof window !== "undefined";
const genTaskId = () => `inv_task_${Math.random().toString(36).slice(2)}`;

/**
 * Tasks builders just like we did in InventorySessionEngine.js earlier.
 * Kept here so the service is self-contained if you want it this way.
 */
const tasksFromScans = (scannedItems = []) => {
  return scannedItems.map((item) => ({
    id: genTaskId(),
    action: "reconcile", // reconcile|add|adjust|move|inspect
    itemId: item.upc || null,
    name: item.name || "Scanned item",
    qty: item.qty ?? 1,
    unit: item.unit || "ea",
    location: item.location || "pantry",
    tags: item.tags || [],
    source: "scan",
    price: item.price || null,
    notes: item.notes || "",
  }));
};

const tasksFromStorehousePlan = (plan = {}) => {
  const items = Array.isArray(plan.items) ? plan.items : [];
  return items.map((goal) => ({
    id: genTaskId(),
    action: "add",
    itemId: goal.id || null,
    name: goal.name || "Planned item",
    qty: goal.targetQty ?? goal.qty ?? 1,
    unit: goal.unit || "ea",
    location: goal.preferredLocation || "storehouse",
    tags: ["from-storehouse-goal"],
    source: "storehouse",
    notes: goal.notes || "",
  }));
};

const tasksFromReverseDomain = (reversePayload = {}) => {
  const tasks = [];

  // meals → pull ingredients / check inventory
  if (Array.isArray(reversePayload.mealRecipes)) {
    reversePayload.mealRecipes.forEach((recipe) => {
      const ing = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
      ing.forEach((ingredient) => {
        tasks.push({
          id: genTaskId(),
          action: "check-or-pull",
          name: ingredient.name || "Meal ingredient",
          itemId: ingredient.inventoryId || null,
          qty: ingredient.qty ?? 1,
          unit: ingredient.unit || "ea",
          location: ingredient.preferredLocation || "pantry",
          tags: ["from-meal"],
          source: "reverse:meal",
          notes: `For meal: ${recipe.title || recipe.name || "untitled meal"}`,
        });
      });
    });
  }

  // garden → receive harvest
  if (Array.isArray(reversePayload.gardenHarvests)) {
    reversePayload.gardenHarvests.forEach((harvest) => {
      tasks.push({
        id: genTaskId(),
        action: "receive-harvest",
        name: harvest.crop || "Garden harvest",
        qty: harvest.qty ?? 1,
        unit: harvest.unit || "ea",
        location: harvest.storageLocation || "root-cellar",
        tags: ["from-garden"],
        source: "reverse:garden",
        notes: harvest.notes || "",
      });
    });
  }

  // animals → receive meat / milk / eggs
  if (Array.isArray(reversePayload.animalProducts)) {
    reversePayload.animalProducts.forEach((prod) => {
      tasks.push({
        id: genTaskId(),
        action: "receive-livestock-product",
        name: prod.name || "Animal product",
        qty: prod.qty ?? 1,
        unit: prod.unit || "ea",
        location: prod.location || "freezer",
        tags: ["from-animals"],
        source: "reverse:animals",
        notes: prod.notes || "",
      });
    });
  }

  // cleaning → supplies consumed
  if (Array.isArray(reversePayload.cleaningSupplies)) {
    reversePayload.cleaningSupplies.forEach((supply) => {
      tasks.push({
        id: genTaskId(),
        action: "reconcile",
        name: supply.name || "Cleaning supply",
        qty: supply.qtyUsed ? -Math.abs(supply.qtyUsed) : -1,
        unit: supply.unit || "ea",
        location: supply.location || "laundry",
        tags: ["from-cleaning"],
        source: "reverse:cleaning",
        notes: supply.notes || "",
      });
    });
  }

  return tasks;
};

/**
 * Inventory engine that plugs into the shared core.
 * If you already created src/engines/inventory/InventorySessionEngine.js,
 * you can swap this for that import. I’m inlining it here for completeness.
 */
class InventorySessionEngine extends SessionEngineCore {
  constructor(opts = {}) {
    super({
      domainName: "inventory",
      sessionTableName: "inventorySessions",
      ...opts,
    });
  }

  // FORWARD: from source (scans / plans / imports)
  async buildTasksFromSource(sourcePayload = {}) {
    // detect what kind of payload we got
    if (Array.isArray(sourcePayload.scannedItems)) {
      return tasksFromScans(sourcePayload.scannedItems);
    }
    if (
      Array.isArray(sourcePayload.items) ||
      sourcePayload.planType === "storehouse"
    ) {
      return tasksFromStorehousePlan(sourcePayload);
    }
    // fallback: nothing special
    return [];
  }

  // REVERSE: from other domains
  async buildTasksFromReverse(reversePayload = {}) {
    return tasksFromReverseDomain(reversePayload);
  }
}

/* -------------------------------------------------------------------------- */
/* service façade                                                             */
/* -------------------------------------------------------------------------- */
class InventorySessionService {
  constructor() {
    this.engine = new InventorySessionEngine();
    this.scheduler = getSessionScheduler();
  }

  /**
   * Create from SCANS (Scan • Compare • Trust → Inventory)
   *
   * scannedItems: [{ upc, name, qty, unit, location, tags, price }]
   */
  async createSessionFromScans(scannedItems = [], meta = {}) {
    const session = await this.engine.createFromSource(
      { scannedItems },
      {
        source: "scan",
        label: meta.label || "Scanned Inventory Session",
        links: meta.links || {},
        ownedByUser: true,
        ...meta,
      }
    );
    return session;
  }

  /**
   * Create from a STOREHOUSE / goals plan
   */
  async createSessionFromStorehousePlan(plan = {}) {
    const session = await this.engine.createFromSource(
      { ...plan, planType: "storehouse" },
      {
        source: "plan",
        label: plan.label || "Storehouse → Inventory",
        links: { storehouseGoalId: plan.id || null, ...(plan.links || {}) },
        ownedByUser: true,
        meta: plan.meta || {},
      }
    );
    return session;
  }

  /**
   * Create from REVERSE domain (meals / garden / animals / cleaning)
   */
  async createSessionFromReverse(reversePayload = {}, meta = {}) {
    const session = await this.engine.createFromReverse(reversePayload, {
      label: meta.label || "Reverse-generated Inventory Session",
      links: meta.links || {},
      ownedByUser: true,
      ...meta,
    });

    // since inventory is a hub, let other pages refresh
    // note: SessionEngineCore already emits cross-domain refresh,
    // but we can reinforce here for your home page flows:
    if (isBrowser) {
      window.dispatchEvent(
        new CustomEvent("inventory:reverse:created", { detail: { session } })
      );
    }

    return session;
  }

  /**
   * Save as user's favorite
   */
  async saveSessionAsFavorite(session) {
    return this.engine.saveAsFavorite(session);
  }

  /**
   * Schedule an inventory session
   * scheduleDef is same shape as src/services/scheduling/SessionScheduler.js
   */
  async scheduleInventorySession(sessionId, scheduleDef) {
    // 1) let the engine mark the session with schedule + emit automation:schedule:register
    const updated = await this.engine.scheduleSession(sessionId, scheduleDef);

    // 2) and also register directly with the shared scheduler
    await this.scheduler.register({
      ...scheduleDef,
      domain: "inventory",
      sessionId,
      userOwned: updated?.ownedByUser ?? true,
    });

    return updated;
  }

  /**
   * List inventory sessions
   */
  async listSessions(filter = {}) {
    return this.engine.list({ filter });
  }

  /**
   * Mark inventory session complete
   */
  async completeSession(sessionId) {
    return this.engine.updateStatus(sessionId, "done");
  }

  /* ------------------------------------------------------------------------ */
  /* UI-friendly shortcuts                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * Quick helper for Scan • Compare • Trust UI:
   * called right after user finishes scanning a circular or cart.
   */
  async createFromScanResult(scanResult) {
    // scanResult might have { items: [...], store, couponsFound, harmfulIngredients: [...] }
    const items = Array.isArray(scanResult?.items) ? scanResult.items : [];
    return this.createSessionFromScans(items, {
      label: scanResult?.store
        ? `Inventory from ${scanResult.store} scan`
        : "Inventory from scan",
      meta: {
        store: scanResult?.store || null,
        couponsFound: scanResult?.couponsFound || [],
        harmfulIngredients: scanResult?.harmfulIngredients || [],
      },
    });
  }

  /**
   * Quick helper for “harvest → inventory”
   */
  async createFromGardenHarvests(harvests = []) {
    return this.createSessionFromReverse(
      {
        gardenHarvests: harvests,
      },
      {
        label: "Garden harvest → Inventory",
      }
    );
  }

  /**
   * Quick helper for “animal processing → inventory”
   */
  async createFromAnimalProducts(products = []) {
    return this.createSessionFromReverse(
      {
        animalProducts: products,
      },
      {
        label: "Animal products → Inventory",
      }
    );
  }

  /**
   * Quick helper for “cleaning used supplies → inventory reconcile”
   */
  async createFromCleaningUsage(supplies = []) {
    return this.createSessionFromReverse(
      {
        cleaningSupplies: supplies,
      },
      {
        label: "Cleaning supplies → Inventory reconcile",
      }
    );
  }

  /* ======================================================================== */
  /* ✅ RECEIPT-DEFERRED COMMIT (NEW)                                          */
  /* ======================================================================== */

  /**
   * Commit pathway that ONLY runs after receipt reconciliation.
   * Requires receiptId + storeId (SSA rule).
   *
   * matches: [{ candidateId, receiptLineNo, receiptName, receiptQty, receiptUnit, receiptTotal, score }]
   * totals:  { subtotal, tax, discounts, total }
   */
  async commitReceiptConfirmed({
    receiptId,
    storeId,
    householdId,
    userId,
    currency = "USD",
    totals = {},
    matches = [],
    meta = {},
  } = {}) {
    if (!receiptId)
      throw new Error("commitReceiptConfirmed requires receiptId");
    if (!storeId) throw new Error("commitReceiptConfirmed requires storeId");

    const committed = await this.commitReceiptConfirmedToInventoryItems({
      receiptId,
      storeId,
      householdId,
      userId,
      currency,
      matches,
      meta,
    });

    const costUpdates = await this.appendCostHistoryFromReceipt({
      receiptId,
      storeId,
      householdId,
      userId,
      currency,
      totals,
      matches,
      meta,
    });

    // Emit UI refresh hooks (safe)
    try {
      if (isBrowser) {
        window.dispatchEvent(
          new CustomEvent("inventory.updated", {
            detail: {
              source: "receipt",
              receiptId,
              storeId,
              committedCount: committed?.committedCount || 0,
              costUpdates: costUpdates?.costUpdates || 0,
            },
          })
        );
      }
    } catch {}

    return {
      ok: true,
      committedCount: committed?.committedCount || 0,
      costUpdates: costUpdates?.costUpdates || 0,
    };
  }

  async commitReceiptConfirmedToInventoryItems({
    receiptId,
    storeId,
    householdId,
    userId,
    currency,
    matches,
    meta,
  } = {}) {
    const dbMod = await import("@/services/db").catch(() => null);
    const db = dbMod?.db || dbMod?.default?.db || dbMod?.default || dbMod;

    let committedCount = 0;

    // Prefer shopping_candidates -> inventoryItems
    // If inventoryItems table exists, upsert items there.
    if (db?.inventoryItems?.put) {
      for (const m of Array.isArray(matches) ? matches : []) {
        const name = m.receiptName || "Receipt item";
        const qty = Number(m.receiptQty ?? 1);
        const unit = String(m.receiptUnit || "ea").toLowerCase();
        const total = m.receiptTotal != null ? Number(m.receiptTotal) : null;

        const row = {
          id: `inv_${String(m.candidateId || "").slice(
            0,
            12
          )}_${Date.now().toString(36)}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          householdId: householdId || null,
          name,
          qty: Number.isFinite(qty) ? qty : 1,
          unit: unit || "ea",
          storage: "pantry",
          category: "pantry",
          source: "receipt",
          receiptId,
          storeId,
          currency: currency || "USD",
          lastCost: total,
          meta: { ...meta, reconciliationScore: m.score ?? null },
        };

        try {
          await db.inventoryItems.put(row);
          committedCount += 1;
        } catch {
          // non-fatal per row
        }
      }
    }

    return { committedCount };
  }

  async appendCostHistoryFromReceipt({
    receiptId,
    storeId,
    householdId,
    userId,
    currency,
    totals,
    matches,
    meta,
  } = {}) {
    const dbMod = await import("@/services/db").catch(() => null);
    const db = dbMod?.db || dbMod?.default?.db || dbMod?.default || dbMod;

    let costUpdates = 0;

    // 1) Per-item cost history (if table exists)
    if (db?.inventory_cost_history?.bulkPut) {
      const rows = (Array.isArray(matches) ? matches : []).map((m) => ({
        id: `cost_${Date.now().toString(36)}_${Math.random()
          .toString(36)
          .slice(2)}`,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        householdId: householdId || null,
        storeId: storeId || null,
        receiptId,
        candidateId: m.candidateId || null,
        receiptLineNo: m.receiptLineNo ?? null,
        name: m.receiptName || null,
        qty: Number(m.receiptQty ?? 1),
        unit: String(m.receiptUnit || "ea").toLowerCase(),
        total: m.receiptTotal != null ? Number(m.receiptTotal) : null,
        currency: currency || "USD",
        score: m.score ?? null,
        meta: meta || {},
      }));

      try {
        await db.inventory_cost_history.bulkPut(rows);
        costUpdates += rows.length;
      } catch {
        // non-fatal
      }
    }

    // 2) Receipt-level summary (optional table)
    if (db?.receipt_cost_summaries?.put) {
      try {
        await db.receipt_cost_summaries.put({
          id: `rcpt_sum_${receiptId}`,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          householdId: householdId || null,
          storeId: storeId || null,
          receiptId,
          currency: currency || "USD",
          subtotal: totals?.subtotal ?? null,
          tax: totals?.tax ?? null,
          discounts: totals?.discounts ?? null,
          total: totals?.total ?? null,
          meta: meta || {},
        });
      } catch {
        // ignore
      }
    }

    return { costUpdates };
  }
}

/* -------------------------------------------------------------------------- */
/* singleton                                                                  */
/* -------------------------------------------------------------------------- */
let __inventorySessionService;
export const getInventorySessionService = () => {
  if (!__inventorySessionService) {
    __inventorySessionService = new InventorySessionService();
  }
  return __inventorySessionService;
};
