/* eslint-disable no-console */
/**
 * CompareTable — Scan • Compare • Trust
 * -----------------------------------------------------------------------------
 * - Inputs: array of offers (from scan results, manual add, or search)
 * - Normalizes units (weight, volume, count) -> computes unit price
 * - Pack math: supports multi-pack, inner units, size conversions
 * - Highlights cheaper alternatives and price deltas
 * - Surfaces coupons/discount-cycle hints when available
 * - Emits events for orchestration + optional analytics
 * - Integrates with Favorites (sessions/schedules) when hooks exist; falls back to eventBus
 *
 * Offer schema (flexible; best-effort):
 * {
 *   id, upc, name, brand, image, store, aisle,
 *   price: number, currency: 'USD',
 *   pack: { qty: 3, size: { value: 12, unit: 'oz' } }   // e.g., 3 × 12 oz
 *   // OR a single:
 *   size: { value: 1, unit: 'lb' },
 *   // Optional enrichments from upstream/agents:
 *   badges: ['organic','recall','clean_ingredients'],
 *   ingredientsFlags: { harmful: false, allergens: [] },
 *   coupons: [{ source:'StoreApp', value:1.00, type:'instant', expiresISO:'2025-11-10'}],
 *   priceHistory: { avg: 4.99, low: 3.99, lastISO:'2025-10-20' },
 *   meta: { score: 0.0, tags: [] }
 * }
 */

import React, { useEffect, useMemo, useState, useCallback } from "react";

/* --------------------------------- Optional deps (defensive) -------------------------------- */
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

let useFavoriteSessions = null;
let useFavoriteSchedules = null;
try {
  // Your recent favorites hooks; present in other files we added.
  ({ useFavoriteSessions } = require("@/hooks/useFavoriteSessions"));
} catch (_e) {}
try {
  ({ useFavoriteSchedules } = require("@/hooks/useFavoriteSchedules"));
} catch (_e) {}

let couponService = null;
try {
  couponService = require("@/services/coupons/couponService").default;
} catch (_e) {}

let priceCycle = null;
try {
  priceCycle = require("@/services/pricing/priceCycle").default; // identifies discount cycles by store/SKU
} catch (_e) {}

/* ---------------------------------- Small Utilities ---------------------------------- */

const CURRENCY = "USD";
const fmtMoney = (n, currency = CURRENCY) =>
  typeof n === "number"
    ? new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n)
    : "—";

// Base units: weight (g), volume (ml), count (ea)
const UNIT_MAP = {
  // weight
  mg: { kind: "weight", toBase: 0.001 },
  g: { kind: "weight", toBase: 1 },
  kg: { kind: "weight", toBase: 1000 },
  oz: { kind: "weight", toBase: 28.3495 },
  lb: { kind: "weight", toBase: 453.59237 },

  // volume (US)
  ml: { kind: "volume", toBase: 1 },
  l: { kind: "volume", toBase: 1000 },
  tsp: { kind: "volume", toBase: 4.92892 },
  tbsp: { kind: "volume", toBase: 14.7868 },
  floz: { kind: "volume", toBase: 29.5735 },
  cup: { kind: "volume", toBase: 236.588 },
  pint: { kind: "volume", toBase: 473.176 },
  quart: { kind: "volume", toBase: 946.353 },
  gal: { kind: "volume", toBase: 3785.41 },

  // count
  ct: { kind: "count", toBase: 1 },
  ea: { kind: "count", toBase: 1 },
  count: { kind: "count", toBase: 1 },
};

/** Normalize size -> {kind, baseQty} */
function toBase(size) {
  if (!size || typeof size.value !== "number" || !size.unit) return null;
  const key = String(size.unit).toLowerCase();
  const meta = UNIT_MAP[key];
  if (!meta) return null;
  return { kind: meta.kind, baseQty: size.value * meta.toBase };
}

/** Compute total base quantity for an offer (handles multi-pack) */
function totalBaseQty(offer) {
  // Multi-pack case
  if (offer?.pack?.qty && offer?.pack?.size) {
    const base = toBase(offer.pack.size);
    if (base) return base.baseQty * offer.pack.qty;
  }
  // Single-size case
  if (offer?.size) {
    const base = toBase(offer.size);
    if (base) return base.baseQty;
  }
  // Fallback: treat as count=1
  return 1;
}

/** Compute unit price using base units. */
function computeUnitPrice(offer) {
  const totalQty = totalBaseQty(offer);
  const price = Number(offer?.price || 0);
  if (!totalQty || !price) return null;
  return price / totalQty;
}

/** Best unit label to display (for same-kind comparisons). */
function displayUnit(offers) {
  // If all weight -> pick oz if <= 2000g equivalent window; else lb; for volume prefer floz/ml logic.
  const kinds = new Set(
    offers
      .map((o) => {
        const s = o.pack?.size || o.size;
        return s ? UNIT_MAP[String(s.unit).toLowerCase()]?.kind : null;
      })
      .filter(Boolean)
  );
  if (kinds.size !== 1) return "base unit"; // mixed kinds; we’ll just say “base unit”
  const kind = [...kinds][0];
  if (kind === "weight") return "g"; // we’ll print as price per g for objective compare
  if (kind === "volume") return "ml";
  return "ea";
}

/** Convert unit price (per base) to a friendlier unit for display. */
function unitPriceToDisplay(upPerBase, label) {
  if (upPerBase == null) return null;
  const factor =
    label === "g" ? 1 : label === "ml" ? 1 : label === "ea" ? 1 : 1; // we’re already using base
  return upPerBase * factor;
}

/** Rank & annotate offers with unitPrice and savings vs cheapest. */
function annotateOffers(offers) {
  const enriched = offers
    .map((o) => {
      const unitPrice = computeUnitPrice(o);
      return { ...o, unitPrice };
    })
    .filter((o) => o.unitPrice != null)
    .sort((a, b) => a.unitPrice - b.unitPrice);

  if (!enriched.length) return [];

  const cheapest = enriched[0].unitPrice;
  return enriched.map((o) => {
    const delta = o.unitPrice - cheapest;
    const pct = cheapest > 0 ? (delta / cheapest) * 100 : 0;
    return { ...o, isCheapest: delta <= 1e-9, delta, deltaPct: pct };
  });
}

/** Simple harmful/recall badge resolver (best-effort). */
function deriveBadges(offer = {}) {
  const out = new Set(offer.badges || []);
  if (offer?.ingredientsFlags?.harmful) out.add("harmful");
  if (offer?.badges?.includes("recall")) out.add("recall");
  return [...out];
}

/** Coupon hint */
function bestCoupon(offer = {}) {
  const cs = offer.coupons || [];
  if (!cs.length) return null;
  // prefer the largest absolute value
  return cs.slice().sort((a, b) => Number(b.value || 0) - Number(a.value || 0))[0];
}

/** Price cycle hint */
function cycleHint(offer) {
  try {
    if (!priceCycle) return null;
    return priceCycle.getHint({ upc: offer.upc, store: offer.store });
  } catch (_e) {
    return null;
  }
}

/* --------------------------------- Favorites Buttons --------------------------------- */

function SaveToFavoriteSessionButton({ offer }) {
  const favSess = useFavoriteSessions ? useFavoriteSessions() : null;
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const payload = {
      type: "shopping",
      label: `Fav: ${offer?.brand || ""} ${offer?.name || offer?.upc || ""}`.trim(),
      items: [{ upc: offer?.upc, name: offer?.name, price: offer?.price, store: offer?.store }],
      createdAt: Date.now(),
      source: "CompareTable",
    };
    try {
      if (favSess?.add) {
        await favSess.add(payload);
      } else {
        eventBus.emit("favorites:session:add", payload);
      }
      analytics.track("favorite_session_saved", { upc: offer?.upc, store: offer?.store });
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={save}
      disabled={busy}
      className="px-2 py-1 rounded-md border hover:shadow-sm focus:outline-none focus:ring"
      title="Save this as a favorite shopping session"
    >
      {busy ? "Saving…" : "★ Session"}
    </button>
  );
}

function SaveToFavoriteScheduleButton({ offer }) {
  const favSched = useFavoriteSchedules ? useFavoriteSchedules() : null;
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    const payload = {
      label: `Deal watch: ${offer?.brand || ""} ${offer?.name || offer?.upc || ""}`.trim(),
      when: "next_discount_window", // your scheduler can resolve this relative signal
      meta: { upc: offer?.upc, store: offer?.store },
      createdAt: Date.now(),
      source: "CompareTable",
    };
    try {
      if (favSched?.add) {
        await favSched.add(payload);
      } else {
        eventBus.emit("favorites:schedule:add", payload);
      }
      analytics.track("favorite_schedule_saved", { upc: offer?.upc, store: offer?.store });
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={save}
      disabled={busy}
      className="px-2 py-1 rounded-md border hover:shadow-sm focus:outline-none focus:ring"
      title="Save a schedule reminder around this item’s discount cycle"
    >
      {busy ? "Saving…" : "⏰ Schedule"}
    </button>
  );
}

/* --------------------------------- Row Subcomponents --------------------------------- */

function PackMath({ offer }) {
  const total = totalBaseQty(offer);
  const pack = offer?.pack;
  const unit = (pack?.size?.unit || offer?.size?.unit || "ea").toUpperCase();

  if (pack?.qty && pack?.size) {
    return (
      <span className="text-xs text-gray-600">
        {pack.qty} × {pack.size.value}
        {unit} = <strong>{Number.isFinite(total) ? total.toFixed(0) : total}</strong>{" "}
        {UNIT_MAP[String(pack.size.unit).toLowerCase()]?.kind === "count" ? "ea" : unit.toLowerCase()}
      </span>
    );
  }
  if (offer?.size) {
    return (
      <span className="text-xs text-gray-600">
        {offer.size.value}
        {unit}
      </span>
    );
  }
  return <span className="text-xs text-gray-400">—</span>;
}

function Badges({ offer }) {
  const badges = deriveBadges(offer);
  if (!badges.length && !(offer?.coupons?.length)) return null;

  const b = (label, style) => (
    <span
      key={label}
      className={`inline-block text-[10px] px-1.5 py-0.5 rounded-md border ${style}`}
      style={{ marginRight: 6 }}
    >
      {label}
    </span>
  );

  const nodes = badges.map((x) => {
    if (x === "recall") return b("Recall", "border-red-300 text-red-700");
    if (x === "harmful") return b("Harmful", "border-rose-300 text-rose-700");
    if (x === "organic") return b("Organic", "border-green-300 text-green-700");
    return b(x, "border-gray-300 text-gray-700");
  });

  const coupon = bestCoupon(offer);
  if (coupon) nodes.push(b(`Coupon −${fmtMoney(coupon.value)}`, "border-blue-300 text-blue-700"));

  return <div className="flex flex-wrap">{nodes}</div>;
}

/* ------------------------------------- Main ------------------------------------- */

/**
 * @param {Object} props
 * @param {Array}  props.offers
 * @param {string} [props.title]
 */
export default function CompareTable({ offers = [], title = "Compare offers" }) {
  const [sortKey, setSortKey] = useState("unitPrice");
  const [sortDir, setSortDir] = useState("asc"); // 'asc' | 'desc'
  const [selected, setSelected] = useState(new Set());

  const annotated = useMemo(() => annotateOffers(offers), [offers]);
  const unitLabel = useMemo(() => displayUnit(annotated), [annotated]);

  const sorted = useMemo(() => {
    const arr = annotated.slice();
    arr.sort((a, b) => {
      let A = a[sortKey];
      let B = b[sortKey];
      if (typeof A === "string") A = A.toLowerCase();
      if (typeof B === "string") B = B.toLowerCase();
      if (A === B) return 0;
      const res = A > B ? 1 : -1;
      return sortDir === "asc" ? res : -res;
    });
    return arr;
  }, [annotated, sortKey, sortDir]);

  useEffect(() => {
    if (annotated.length) {
      eventBus.emit("compare:rendered", {
        count: annotated.length,
        cheapest: annotated[0]?.upc,
        context: "CompareTable",
      });
    }
  }, [annotated]);

  const toggleSort = (key) => {
    setSortKey((prev) => (prev === key ? prev : key));
    setSortDir((prev) => (sortKey === key ? (prev === "asc" ? "desc" : "asc") : "asc"));
  };

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const addSelectionToSession = () => {
    const items = sorted.filter((o) => selected.has(o.id || o.upc));
    const payload = {
      type: "shopping",
      label: `Picked ${items.length} items (CompareTable)`,
      items: items.map((o) => ({ upc: o.upc, name: o.name, store: o.store, price: o.price })),
      createdAt: Date.now(),
      source: "CompareTable",
    };
    eventBus.emit("favorites:session:add", payload);
    analytics.track("favorite_session_saved_bulk", { count: items.length });
    setSelected(new Set());
  };

  const addSelectionToSchedule = () => {
    const items = sorted.filter((o) => selected.has(o.id || o.upc));
    const payload = {
      label: `Watch ${items.length} items for sale window`,
      when: "next_discount_window",
      meta: { upcs: items.map((o) => o.upc), stores: [...new Set(items.map((o) => o.store))] },
      createdAt: Date.now(),
      source: "CompareTable",
    };
    eventBus.emit("favorites:schedule:add", payload);
    analytics.track("favorite_schedule_saved_bulk", { count: items.length });
    setSelected(new Set());
  };

  const headerCell = (label, key, extra = "") => (
    <th
      scope="col"
      className={`px-3 py-2 text-left text-xs font-semibold text-gray-700 cursor-pointer sticky top-0 bg-white ${extra}`}
      onClick={() => toggleSort(key)}
      title={`Sort by ${label}`}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortKey === key ? (sortDir === "asc" ? "▲" : "▼") : "▵"}
      </span>
    </th>
  );

  const unitHeader = `Unit Price (${unitLabel})`;

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-bold">{title}</h3>
        <div className="flex items-center gap-2">
          <button
            onClick={addSelectionToSession}
            disabled={!selected.size}
            className="px-2 py-1 rounded-md border hover:shadow-sm disabled:opacity-40"
            title="Save selected items as a favorite shopping session"
          >
            ★ Save Selected → Session
          </button>
          <button
            onClick={addSelectionToSchedule}
            disabled={!selected.size}
            className="px-2 py-1 rounded-md border hover:shadow-sm disabled:opacity-40"
            title="Create a favorite schedule to watch these items' discount windows"
          >
            ⏰ Save Selected → Schedule
          </button>
        </div>
      </div>

      <div className="overflow-auto rounded-lg border">
        <table className="min-w-full text-sm">
          <thead>
            <tr>
              <th className="px-2 py-2 sticky top-0 bg-white">
                <span className="sr-only">Select</span>
              </th>
              {headerCell("Product", "name", "min-w-[220px]")}
              {headerCell("Pack", "pack")}
              {headerCell("Price", "price")}
              {headerCell(unitHeader, "unitPrice")}
              {headerCell("Store/Aisle", "store")}
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 sticky top-0 bg-white">
                Labels
              </th>
              <th className="px-3 py-2 text-left text-xs font-semibold text-gray-700 sticky top-0 bg-white">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((o) => {
              const id = o.id || o.upc || `${o.store}:${o.name}`;
              const upDisplay = unitPriceToDisplay(o.unitPrice, unitLabel);
              const isAlt = !o.isCheapest && Number.isFinite(o.deltaPct);
              const coupon = bestCoupon(o);
              const cyc = cycleHint(o);
              const lineThrough =
                coupon && o.price - coupon.value >= 0 ? (
                  <>
                    <span className="text-gray-400 mr-1 line-through">{fmtMoney(o.price)}</span>
                    <span className="text-gray-900">{fmtMoney(o.price - coupon.value)}</span>
                  </>
                ) : (
                  <span className="text-gray-900">{fmtMoney(o.price)}</span>
                );

              return (
                <tr
                  key={id}
                  className={`border-t ${o.isCheapest ? "bg-green-50" : ""} ${
                    selected.has(id) ? "outline outline-1 outline-blue-300" : ""
                  }`}
                >
                  <td className="px-2 py-2 align-top">
                    <input
                      type="checkbox"
                      aria-label="Select row"
                      checked={selected.has(id)}
                      onChange={() => toggleSelect(id)}
                    />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex gap-2">
                      {o.image ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={o.image}
                          alt={o.name || o.brand || "product"}
                          className="w-10 h-10 object-contain rounded"
                          loading="lazy"
                        />
                      ) : null}
                      <div>
                        <div className="font-medium leading-tight">
                          {o.brand ? <span className="text-gray-700">{o.brand} </span> : null}
                          {o.name || o.upc || "Unnamed"}
                        </div>
                        <div className="text-xs text-gray-500">
                          {o.upc ? <span>UPC: {o.upc}</span> : null}
                          {o.meta?.tags?.length ? (
                            <span className="ml-2">• {o.meta.tags.slice(0, 3).join(", ")}</span>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <PackMath offer={o} />
                  </td>
                  <td className="px-3 py-2 align-top whitespace-nowrap">{lineThrough}</td>
                  <td className="px-3 py-2 align-top whitespace-nowrap">
                    {upDisplay != null ? (
                      <span className="font-semibold">
                        {fmtMoney(upDisplay)}/{unitLabel}
                      </span>
                    ) : (
                      "—"
                    )}
                    {isAlt ? (
                      <div className="text-[11px] text-gray-600">
                        {o.delta > 0
                          ? `+${fmtMoney(o.delta)} vs cheapest (${o.deltaPct.toFixed(0)}%)`
                          : `${fmtMoney(o.delta)} vs cheapest`}
                      </div>
                    ) : (
                      <div className="text-[11px] text-green-700 font-medium">Cheapest</div>
                    )}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="text-gray-800">{o.store || "—"}</div>
                    <div className="text-xs text-gray-500">{o.aisle || ""}</div>
                    {cyc ? (
                      <div className="text-[11px] text-indigo-700 mt-1">
                        {cyc.windowLabel || "Sale window soon"}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <Badges offer={o} />
                  </td>
                  <td className="px-3 py-2 align-top">
                    <div className="flex gap-2 flex-wrap">
                      <SaveToFavoriteSessionButton offer={o} />
                      <SaveToFavoriteScheduleButton offer={o} />
                      <button
                        className="px-2 py-1 rounded-md border hover:shadow-sm"
                        title="Add to Shopping List"
                        onClick={() => {
                          eventBus.emit("shopping:list:add", {
                            upc: o.upc,
                            name: o.name,
                            store: o.store,
                            price: o.price,
                            qty: 1,
                            source: "CompareTable",
                          });
                          analytics.track("shopping_list_add", { upc: o.upc, store: o.store });
                        }}
                      >
                        ➕ List
                      </button>
                      <button
                        className="px-2 py-1 rounded-md border hover:shadow-sm"
                        title="Open price history"
                        onClick={() =>
                          eventBus.emit("pricing:history:open", {
                            upc: o.upc,
                            store: o.store,
                            source: "CompareTable",
                          })
                        }
                      >
                        📈 History
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!sorted.length && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-gray-500">
                  No offers yet. Scan a barcode or paste a link to compare.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Subtle footnote explaining units / fairness of compare */}
      <div className="mt-2 text-[11px] text-gray-500">
        Unit prices are normalized per base unit ({unitLabel}) for apples-to-apples comparisons.
        Multi-packs are converted to total quantity. Coupons shown are best-available; additional
        offers may apply at checkout.
      </div>
    </div>
  );
}
