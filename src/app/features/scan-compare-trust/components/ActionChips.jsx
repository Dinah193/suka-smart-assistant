/* eslint-disable no-console */
/**
 * ActionChips — Scan • Compare • Trust
 * -----------------------------------------------------------------------------
 * Quick actions for a scanned/computed item/offer:
 *  - Add to Inventory
 *  - Plan Meal
 *  - Plant It
 *  - Watch Price
 *
 * Orchestration:
 *  - Emits events over eventBus (fallback if domain services/hooks absent)
 *  - Analytics hooks (defensive)
 *  - Favorite Sessions (e.g., "Planting session", "Meal plan starter")
 *  - Favorite Schedules (e.g., "Watch price/discount window")
 *
 * Props:
 *  - item: Product/offer-like object (see below)
 *  - compact?: boolean (condense labels)
 *  - size?: 'sm'|'md'|'lg' (default 'md')
 *  - showFavorites?: boolean (default true)
 *  - context?: string (telemetry string)
 *
 * Expected item shape (best-effort):
 * {
 *   id, upc, name, brand, store, aisle, price, currency,
 *   pack?: { qty, size: { value, unit }}, // e.g., 3×12 oz
 *   size?: { value, unit },
 *   category?: 'grocery'|'seeds'|'garden'|string,
 *   meta?: {
 *     edible?: boolean,
 *     seeds?: { variety?:string, maturityDays?: number, season?:'cool'|'warm' },
 *     tags?: string[]
 *   }
 * }
 */

import React, { useMemo, useState } from "react";

/* ----------------------------- Optional Dependencies ----------------------------- */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let analytics = { track: () => {} };
try {
  const a = require("@/services/analytics");
  analytics = (a && (a.default || a.analytics || a)) || analytics;
} catch (_e) {}

let priceCycle = null; // provides hints for discount windows
try {
  priceCycle = require("@/services/pricing/priceCycle").default;
} catch (_e) {}

let useFavoriteSessions = null;
let useFavoriteSchedules = null;
try {
  ({ useFavoriteSessions } = require("@/hooks/useFavoriteSessions"));
} catch (_e) {}
try {
  ({ useFavoriteSchedules } = require("@/hooks/useFavoriteSchedules"));
} catch (_e) {}

/* -------------------------------- Unit helpers (light) ------------------------------- */
const UNIT_MAP = {
  mg: { kind: "weight", toBase: 0.001 }, g: { kind: "weight", toBase: 1 },
  kg: { kind: "weight", toBase: 1000 }, oz: { kind: "weight", toBase: 28.3495 },
  lb: { kind: "weight", toBase: 453.59237 },
  ml: { kind: "volume", toBase: 1 }, l: { kind: "volume", toBase: 1000 },
  floz: { kind: "volume", toBase: 29.5735 }, cup: { kind: "volume", toBase: 236.588 },
  pint: { kind: "volume", toBase: 473.176 }, quart: { kind: "volume", toBase: 946.353 },
  gal: { kind: "volume", toBase: 3785.41 },
  ct: { kind: "count", toBase: 1 }, ea: { kind: "count", toBase: 1 }, count: { kind: "count", toBase: 1 },
};
function toBase(size) {
  if (!size || typeof size.value !== "number") return null;
  const meta = UNIT_MAP[String(size.unit).toLowerCase()];
  if (!meta) return null;
  return { kind: meta.kind, baseQty: size.value * meta.toBase };
}
function totalBaseQty(item) {
  if (item?.pack?.qty && item?.pack?.size) {
    const b = toBase(item.pack.size);
    if (b) return b.baseQty * item.pack.qty;
  }
  if (item?.size) {
    const b = toBase(item.size);
    if (b) return b.baseQty;
  }
  return 1;
}

/* --------------------------------- Chip component ---------------------------------- */
function Chip({ icon, label, title, onClick, disabled, size = "md" }) {
  const sizes = {
    sm: "text-[11px] px-2 py-1 rounded-lg",
    md: "text-xs px-2.5 py-1.5 rounded-xl",
    lg: "text-sm px-3 py-2 rounded-2xl",
  };
  return (
    <button
      className={`inline-flex items-center gap-1 border hover:shadow-sm hover:bg-gray-50 focus:outline-none focus:ring ${sizes[size]}`}
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      aria-label={label}
    >
      <span aria-hidden>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

/* ---------------------------------- Main Export ------------------------------------ */
export default function ActionChips({
  item = {},
  compact = false,
  size = "md",
  showFavorites = true,
  context = "ActionChips",
}) {
  const [busy, setBusy] = useState(null); // 'inv'|'meal'|'plant'|'watch'|'favSession'|'favSchedule'

  const label = useMemo(
    () => `${item.brand ? item.brand + " " : ""}${item.name || item.upc || ""}`.trim(),
    [item]
  );

  const baseQty = useMemo(() => totalBaseQty(item), [item]);
  const canPlant = Boolean(item?.meta?.seeds || String(item?.category || "").toLowerCase().includes("seed"));
  const edible = item?.meta?.edible ?? true;

  const favSessions = useFavoriteSessions ? useFavoriteSessions() : null;
  const favSchedules = useFavoriteSchedules ? useFavoriteSchedules() : null;

  /* -------------------------------- Action handlers -------------------------------- */

  const addToInventory = async () => {
    setBusy("inv");
    try {
      // Emit to your inventory pipeline
      eventBus.emit("inventory:item:add", {
        upc: item.upc, name: item.name, brand: item.brand,
        store: item.store, price: item.price, currency: item.currency || "USD",
        qty: 1,
        pack: item.pack || null,
        size: item.size || null,
        totalBaseQty: baseQty,
        source: context,
      });
      analytics.track("inventory_item_add", { upc: item.upc, baseQty, context });
      // Toast
      eventBus.emit("ui:toast", { type: "success", message: `Added to inventory: ${label}` });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", { type: "error", message: "Could not add to inventory." });
    } finally {
      setBusy(null);
    }
  };

  const planMeal = async () => {
    setBusy("meal");
    try {
      // Lightweight “ingredient” object for your planner
      const ingredient = {
        key: item.upc || item.id || label,
        name: label,
        qtyHint: 1,
        unitHint: item?.size?.unit || "ea",
        price: item.price,
        tags: item?.meta?.tags || [],
      };
      eventBus.emit("mealplanner:ingredient:add", { ingredient, source: context });
      eventBus.emit("mealplanner:panel:open"); // open planner panel
      analytics.track("mealplanner_ingredient_add", { upc: item.upc, context });
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(null);
    }
  };

  const plantIt = async () => {
    setBusy("plant");
    try {
      const seeds = item.meta?.seeds || {};
      const payload = {
        upc: item.upc,
        name: seeds.variety || label,
        maturityDays: seeds.maturityDays || null,
        season: seeds.season || null,
        sourceStore: item.store || null,
        notes: "Added from Scan • Compare • Trust",
      };
      eventBus.emit("garden:plan:fromSeed", { seed: payload, source: context });
      eventBus.emit("garden:panel:open");
      analytics.track("garden_plan_from_seed", { upc: item.upc, context });
      eventBus.emit("ui:toast", { type: "success", message: `Added to garden plan: ${payload.name}` });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", { type: "error", message: "Could not add to garden plan." });
    } finally {
      setBusy(null);
    }
  };

  const watchPrice = async () => {
    setBusy("watch");
    try {
      const hint = priceCycle ? priceCycle.getHint({ upc: item.upc, store: item.store }) : null;
      const labelStr = `Watch price: ${label}`;
      const schedule = {
        label: labelStr,
        when: hint?.rrule || "next_discount_window",
        meta: { upc: item.upc, store: item.store, domain: "pricing" },
        createdAt: Date.now(),
        source: context,
      };
      if (favSchedules?.add) {
        await favSchedules.add(schedule);
      } else {
        eventBus.emit("favorites:schedule:add", schedule);
      }
      analytics.track("pricing_watch_schedule_saved", { upc: item.upc, store: item.store });
      eventBus.emit("ui:toast", { type: "success", message: "We’ll watch this price for you." });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", { type: "error", message: "Could not create price watch." });
    } finally {
      setBusy(null);
    }
  };

  /* ------------------------------ Favorites quick-saves ------------------------------ */
  const saveFavSession = async (type, title, items) => {
    setBusy("favSession");
    try {
      const payload = {
        type,
        label: title,
        items,
        createdAt: Date.now(),
        source: context,
      };
      if (favSessions?.add) await favSessions.add(payload);
      else eventBus.emit("favorites:session:add", payload);
      analytics.track("favorite_session_saved", { type, count: items?.length || 1, context });
      eventBus.emit("ui:toast", { type: "success", message: "Saved as a favorite session." });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", { type: "error", message: "Could not save session." });
    } finally {
      setBusy(null);
    }
  };

  const savePlantingSession = () =>
    saveFavSession("planting", `Planting: ${label}`, [
      { upc: item.upc, name: label, note: "Plant this variety" },
    ]);

  const saveMealSession = () =>
    saveFavSession("mealplan", `Meal plan seed: ${label}`, [
      { upc: item.upc, name: label, note: "Plan meals around this item" },
    ]);

  /* ------------------------------------- UI ------------------------------------- */
  const chips = [];

  chips.push(
    <Chip
      key="inv"
      icon="📦"
      label={compact ? "Inventory" : "Add to Inventory"}
      title="Add to Inventory"
      onClick={addToInventory}
      disabled={busy === "inv"}
      size={size}
    />
  );

  if (edible) {
    chips.push(
      <Chip
        key="meal"
        icon="🍽️"
        label={compact ? "Plan" : "Plan Meal"}
        title="Plan a meal with this item"
        onClick={planMeal}
        disabled={busy === "meal"}
        size={size}
      />
    );
  }

  chips.push(
    <Chip
      key="watch"
      icon="👀"
      label={compact ? "Watch" : "Watch Price"}
      title="Create a schedule to watch for discounts"
      onClick={watchPrice}
      disabled={busy === "watch"}
      size={size}
    />
  );

  if (canPlant) {
    chips.push(
      <Chip
        key="plant"
        icon="🌱"
        label={compact ? "Plant" : "Plant It"}
        title="Add to your garden plan"
        onClick={plantIt}
        disabled={busy === "plant"}
        size={size}
    />
    );
  }

  if (showFavorites) {
    if (canPlant) {
      chips.push(
        <Chip
          key="fav-plant"
          icon="★"
          label={compact ? "Fav Plant" : "Fav Planting Session"}
          title="Save a favorite planting session"
          onClick={savePlantingSession}
          disabled={busy === "favSession"}
          size={size}
        />
      );
    }
    chips.push(
      <Chip
        key="fav-meal"
        icon="★"
        label={compact ? "Fav Meal" : "Fav Meal Session"}
        title="Save a favorite meal-planning session"
        onClick={saveMealSession}
        disabled={busy === "favSession"}
        size={size}
      />
    );
  }

  return <div className="flex flex-wrap gap-2">{chips}</div>;
}
