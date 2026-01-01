// src/components/animals/AnimalOutputsCard.jsx
"use client";

import React, { useEffect, useMemo, useState } from "react";

/**
 * AnimalOutputsCard
 * -----------------------------------------------------------------------------
 * Integrates project goals:
 * - Visible, intuitive capture of animal outputs (eggs, milk, manure, wool, meat)
 * - One-click "Collect Now" -> Inventory batches (Make/Preserve routes available)
 * - Smart best-by dates & processing suggestions (freeze, can, cure, ferment, compost)
 * - Hooks to BatchSessionPlanner (send milk/eggs/wool to processing recipes)
 * - Hooks to Calendar (schedule processing) and Labels (print jar/freezer labels)
 * - Sell/Barter quickly (routes to Marketplace with prefilled listing)
 * - Works even if stores/bus aren’t loaded (safe no-ops)
 *
 * Props:
 *  - animal: {
 *      id, name, type, breed?, count? (active producing animals),
 *      outputs?: Array<{
 *        kind: "eggs"|"milk"|"manure"|"wool"|"meat"|"honey"|"other",
 *        unit?: string,           // default unit (e.g., "ct", "L", "lb", "kg")
 *        estPerDay?: number,      // avg per animal per day (or seasonally normalized)
 *        estPerWeek?: number,     // if provided, overrides daily calc
 *        estPerYear?: number,     // for seasonal outputs like wool/honey
 *        shelfLifeDays?: number,  // for best-by estimation
 *        notes?: string
 *      }]
 *    }
 *  - date?: Date (defaults today)
 *  - compact?: boolean (smaller visual)
 *  - onSaved?: (result) => void
 */

/* ------------------------------------------------------------------ */
/* Utilities (no hard deps) */
const iso = (d = new Date()) => new Date(d).toISOString();
const isoDate = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const uid = (p = "id") => `${p}_${Math.random().toString(36).slice(2, 9)}`;

function clamp(n, min, max) {
  const x = Number(n) || 0;
  return Math.min(Math.max(x, min), max);
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

const DEFAULT_UNITS = {
  eggs: "ct",
  milk: "L",
  manure: "lb",
  wool: "lb",
  meat: "lb",
  honey: "lb",
  other: "unit",
};

const UNIT_CONV = {
  // light conversions (expand as needed)
  L_to_gal: 0.264172,
  gal_to_L: 3.78541,
  kg_to_lb: 2.20462,
  lb_to_kg: 0.453592,
};

/* Gentle conversion helper */
function convertQty(qty, from, to) {
  const q = Number(qty) || 0;
  if (from === to) return q;
  const key = `${from}_to_${to}`;
  if (UNIT_CONV[key]) return +(q * UNIT_CONV[key]).toFixed(3);
  return q; // fallback (same)
}

/* Best-by defaults (days) if none provided */
const DEFAULT_SHELFLIFE = {
  eggs: 45,   // refrigerated
  milk: 7,    // raw milk in fridge (short! suggest processing)
  manure: 365,
  wool: 3650, // essentially non-perishable in storage
  meat: 365,  // frozen
  honey: 3650,
  other: 90,
};

const PROCESSING_SUGGESTIONS = {
  eggs: ["Refrigerate", "Pickle Eggs (Canning)", "Powder (Dehydrate)", "Send to Batch Session"],
  milk: ["Cheese (Fresh)", "Yogurt", "Butter/Ghee", "Freeze", "Send to Batch Session"],
  manure: ["Compost (Hot)", "Compost (Cold)", "Vermicompost", "Bokashi"],
  wool: ["Wash/Scour", "Card", "Spin", "Dye", "Sell/Barter"],
  meat: ["Vac-Seal & Freeze", "Cure & Smoke", "Pressure Can", "Jerky (Dehydrate)", "Send to Batch Session"],
  honey: ["Jar & Label", "Infuse", "Sell/Barter", "Gift Pack"],
  other: ["Store", "Process", "Sell/Barter"],
};

/* Safe dynamic imports to avoid hard coupling */
async function _useInventoryStore() {
  try {
    const mod = await import("@/store/InventoryStore");
    const useStore = mod.default || mod.useInventoryStore || null;
    return typeof useStore === "function" ? (useStore.getState ? useStore.getState() : useStore()) : null;
  } catch {
    return null;
  }
}

async function _useAutomationBus() {
  try {
    const mod = await import("@/automation/AutomationBus");
    return mod.emit ? mod : null;
  } catch {
    return null;
  }
}

async function _useRecipeStore() {
  try {
    const mod = await import("@/store/RecipeStore");
    const useStore = mod.default || mod.useRecipeStore || null;
    return typeof useStore === "function" ? (useStore.getState ? useStore.getState() : useStore()) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Small subcomponents */

function Stat({ label, value, sub }) {
  return (
    <div className="flex flex-col p-3 rounded-2xl bg-slate-50 border border-slate-200">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {sub ? <div className="text-xs text-slate-400">{sub}</div> : null}
    </div>
  );
}

function Badge({ children }) {
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Main Component */

export default function AnimalOutputsCard({ animal = {}, date = new Date(), compact = false, onSaved = () => {} }) {
  const [count, setCount] = useState(Number(animal.count) || 1);
  const [unitPrefs, setUnitPrefs] = useState(() =>
    Object.fromEntries((animal.outputs || []).map((o) => [o.kind, o.unit || DEFAULT_UNITS[o.kind] || "unit"]))
  );
  const [collectOpen, setCollectOpen] = useState(false);
  const [collectRows, setCollectRows] = useState(() =>
    (animal.outputs || []).map((o) => ({
      id: uid("row"),
      kind: o.kind,
      qty: "",
      unit: o.unit || DEFAULT_UNITS[o.kind] || "unit",
      processing: "",
    }))
  );

  const dayKey = useMemo(() => isoDate(date), [date]);

  const est = useMemo(() => buildEstimates(animal, count), [animal, count]);

  const suggestedRecipes = useSuggestedRecipes(animal);

  function resetCollectRows() {
    setCollectRows(
      (animal.outputs || []).map((o) => ({
        id: uid("row"),
        kind: o.kind,
        qty: "",
        unit: unitPrefs[o.kind] || o.unit || DEFAULT_UNITS[o.kind] || "unit",
        processing: defaultProcessing(o.kind),
      }))
    );
  }

  useEffect(() => {
    // sync units if animal prop changes
    setUnitPrefs((prev) => {
      const next = { ...prev };
      (animal.outputs || []).forEach((o) => {
        next[o.kind] = next[o.kind] || o.unit || DEFAULT_UNITS[o.kind] || "unit";
      });
      return next;
    });
  }, [animal]);

  /* ------------------------------------------------------------------ */
  /* Actions */

  async function handleCollectNow() {
    setCollectOpen(true);
    resetCollectRows();
  }

  async function confirmCollect() {
    const rows = collectRows
      .map((r) => ({ ...r, qty: Number(r.qty) || 0 }))
      .filter((r) => r.qty > 0);

    if (!rows.length) {
      setCollectOpen(false);
      return;
    }

    // Build batch payload for Inventory
    const batches = rows.map((r) => {
      const shelfDays =
        (animal.outputs || []).find((o) => o.kind === r.kind)?.shelfLifeDays ||
        DEFAULT_SHELFLIFE[r.kind] ||
        DEFAULT_SHELFLIFE.other;

      const bestBy = addDays(date, shelfDays);
      return {
        batchId: uid("batch"),
        source: "animal",
        sourceId: animal.id,
        sourceName: animal.name || animal.type || "Animal",
        outputKind: r.kind,
        qty: r.qty,
        unit: r.unit,
        processing: r.processing || defaultProcessing(r.kind),
        collectedAt: iso(date),
        bestBy: iso(bestBy),
        labels: [`animal:${animal.type || "unknown"}`, `kind:${r.kind}`, `day:${dayKey}`],
        notes: "",
      };
    });

    const inv = await _useInventoryStore();
    const bus = await _useAutomationBus();

    // Attempt to insert via store; else emit on bus; else no-op
    if (inv?.upsertBatches) {
      try {
        inv.upsertBatches(batches);
      } catch (e) {
        // fallback to bus
        if (bus?.emit) {
          bus.emit("inventory/addBatch", { batches });
        }
      }
    } else if (bus?.emit) {
      bus.emit("inventory/addBatch", { batches });
    }

    // Optional: trigger label printing
    if (bus?.emit) {
      bus.emit("labels/print", {
        template: "jar_freezer_basic",
        items: batches.map((b) => ({
          title: `${capitalize(b.outputKind)} — ${animal.name || animal.type || "Animal"}`,
          subtitle: `${b.qty} ${b.unit} • ${isoDate(date)}`,
          footer: `Best by: ${isoDate(new Date(b.bestBy))}`,
          qrData: JSON.stringify({ batchId: b.batchId, outputKind: b.outputKind }),
        })),
      });
    }

    setCollectOpen(false);
    onSaved?.({ ok: true, batches });
  }

  async function scheduleProcessing(kind) {
    const bus = await _useAutomationBus();
    if (!bus?.emit) return;

    const title = `Process ${capitalize(kind)} — ${animal.name || animal.type || ""}`.trim();
    const durationMap = { eggs: 45, milk: 90, meat: 120, wool: 60, honey: 45, manure: 30, other: 45 };
    const mins = durationMap[kind] || 60;

    const start = new Date();
    const end = new Date(start.getTime() + mins * 60000);

    bus.emit("calendar/schedule", {
      source: "AnimalOutputsCard",
      title,
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      description: `Auto-scheduled from AnimalOutputsCard for ${capitalize(kind)} processing.`,
      metadata: { animalId: animal.id, kind },
      requireApproval: true,
    });
  }

  async function sendToBatchSession(kind) {
    // Send to your Batch Session Planner (e.g., cheese/yogurt for milk; recipes using eggs/meat)
    const bus = await _useAutomationBus();
    if (!bus?.emit) return;

    bus.emit("batch/addInputs", {
      source: "AnimalOutputsCard",
      items: [
        {
          id: uid("in"),
          name: `${capitalize(kind)} (${animal.name || animal.type || ""})`,
          tags: ["animal-output", kind],
          // Let downstream UI choose qty; we’re just linking the intent
        },
      ],
    });
  }

  async function listForTrade(kind) {
    // Route to Marketplace with prefill
    const bus = await _useAutomationBus();
    if (!bus?.emit) return;

    bus.emit("marketplace/createListingDraft", {
      source: "AnimalOutputsCard",
      listing: {
        type: "barter/trade",
        title: `${capitalize(kind)} from ${animal.name || animal.type || "animal"}`,
        description: `Fresh ${kind}. Generated on ${isoDate(date)}.`,
        tags: ["animal-output", kind, animal.type || "animal"],
        visibility: "private", // creator can toggle to public
        unit: DEFAULT_UNITS[kind] || "unit",
      },
    });
  }

  /* ------------------------------------------------------------------ */
  /* Render */

  return (
    <div className={`rounded-2xl border shadow-sm bg-white ${compact ? "p-3" : "p-5"} flex flex-col gap-4`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center">
            <span className="text-amber-700 text-lg">
              {animal.type?.slice(0, 1)?.toUpperCase() || "A"}
            </span>
          </div>
          <div>
            <div className="text-base font-semibold">
              {animal.name || capitalize(animal.type) || "Animal"}
            </div>
            <div className="text-xs text-slate-500">
              {animal.breed ? `${animal.breed} • ` : ""}
              {count} {count === 1 ? "animal" : "animals"}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {(animal.outputs || []).map((o) => (
            <Badge key={o.kind}>{capitalize(o.kind)}</Badge>
          ))}
        </div>
      </div>

      {/* Count & Estimations */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="flex items-center justify-between p-3 rounded-2xl bg-slate-50 border border-slate-200">
          <div>
            <div className="text-xs text-slate-500">Producing Animals</div>
            <div className="text-lg font-semibold">{count}</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="px-2 py-1 rounded-xl border bg-white hover:bg-slate-50"
              onClick={() => setCount((c) => Math.max(1, c - 1))}
            >
              −
            </button>
            <button
              className="px-2 py-1 rounded-xl border bg-white hover:bg-slate-50"
              onClick={() => setCount((c) => c + 1)}
            >
              +
            </button>
          </div>
        </div>

        <Stat
          label="Est. Today"
          value={formatEst(est.today)}
          sub={est.today?.length ? "Adjust in Collect modal" : "No outputs configured"}
        />
        <Stat label="Est. This Week" value={formatEst(est.week)} sub="Based on current count" />
      </div>

      {/* Output list */}
      <div className="space-y-2">
        {(animal.outputs || []).map((o) => {
          const u = unitPrefs[o.kind] || o.unit || DEFAULT_UNITS[o.kind] || "unit";
          const perDay = computePerDay(o, count);
          return (
            <div key={o.kind} className="p-3 rounded-2xl border bg-slate-50/70">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium">{capitalize(o.kind)}</div>
                <div className="text-sm text-slate-600">
                  Est. per day: <span className="font-semibold">{fmtQty(perDay, u)}</span>
                </div>
              </div>

              {/* Quick actions */}
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50"
                  onClick={handleCollectNow}
                >
                  Collect Now
                </button>
                <button
                  className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50"
                  onClick={() => scheduleProcessing(o.kind)}
                >
                  Schedule Processing
                </button>
                <button
                  className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50"
                  onClick={() => sendToBatchSession(o.kind)}
                >
                  Send to Batch Session
                </button>
                <button
                  className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50"
                  onClick={() => listForTrade(o.kind)}
                >
                  Sell / Barter
                </button>
              </div>

              {/* Suggestions */}
              <div className="mt-2 text-xs text-slate-500">
                Suggestions: {PROCESSING_SUGGESTIONS[o.kind]?.join(" • ") || "Store / Process / Trade"}
              </div>
            </div>
          );
        })}
      </div>

      {/* Related recipes (intuitive tie-in) */}
      {suggestedRecipes.length ? (
        <div className="mt-1">
          <div className="text-sm font-semibold mb-2">Recipes that use these outputs</div>
          <div className="flex flex-wrap gap-2">
            {suggestedRecipes.slice(0, 8).map((r) => (
              <div key={r.id} className="px-3 py-1.5 rounded-xl border bg-white text-sm">
                {r.title || r.name}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Collect Modal */}
      {collectOpen ? (
        <div className="fixed inset-0 bg-black/20 z-50 flex items-end md:items-center md:justify-center">
          <div className="w-full md:w-[560px] bg-white rounded-t-2xl md:rounded-2xl p-4 shadow-lg border">
            <div className="flex items-center justify-between mb-2">
              <div className="text-base font-semibold">Collect Outputs — {animal.name || capitalize(animal.type)}</div>
              <button
                className="px-2 py-1 rounded-lg border hover:bg-slate-50"
                onClick={() => setCollectOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="space-y-3 max-h-[60vh] overflow-auto pr-1">
              {collectRows.map((row, idx) => (
                <div key={row.id} className="grid grid-cols-12 gap-2 items-center">
                  <div className="col-span-4">
                    <div className="text-xs text-slate-500">Kind</div>
                    <div className="text-sm font-medium">{capitalize(row.kind)}</div>
                  </div>
                  <div className="col-span-3">
                    <div className="text-xs text-slate-500">Qty</div>
                    <input
                      type="number"
                      inputMode="decimal"
                      className="w-full px-2 py-1.5 rounded-xl border"
                      placeholder="0"
                      value={row.qty}
                      onChange={(e) => updateRow(idx, { qty: e.target.value })}
                    />
                  </div>
                  <div className="col-span-2">
                    <div className="text-xs text-slate-500">Unit</div>
                    <select
                      value={row.unit}
                      onChange={(e) => {
                        updateRow(idx, { unit: e.target.value });
                        setUnitPrefs((p) => ({ ...p, [row.kind]: e.target.value }));
                      }}
                      className="w-full px-2 py-1.5 rounded-xl border bg-white"
                    >
                      {unitOptionsFor(row.kind).map((u) => (
                        <option key={u} value={u}>
                          {u}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-3">
                    <div className="text-xs text-slate-500">Processing</div>
                    <select
                      value={row.processing || ""}
                      onChange={(e) => updateRow(idx, { processing: e.target.value })}
                      className="w-full px-2 py-1.5 rounded-xl border bg-white"
                    >
                      <option value="">None</option>
                      {PROCESSING_SUGGESTIONS[row.kind]?.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-3 flex items-center justify-between">
              <div className="text-xs text-slate-500">
                Day: <span className="font-medium">{dayKey}</span>
              </div>
              <div className="flex gap-2">
                <button
                  className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50"
                  onClick={() => setCollectOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="px-3 py-1.5 rounded-xl border bg-emerald-600 text-white hover:bg-emerald-700"
                  onClick={confirmCollect}
                >
                  Save Collection
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );

  /* ------------------------------------------------------------------ */
  /* Local helpers */

  function updateRow(idx, patch) {
    setCollectRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }
}

/* ------------------------------------------------------------------ */
/* Hooks & Helpers */

function useSuggestedRecipes(animal) {
  const [recipes, setRecipes] = useState([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const recipeStore = await _useRecipeStore();
      const all = recipeStore?.recipes || [];
      const kinds = new Set((animal.outputs || []).map((o) => o.kind));
      // naive filter: recipe.ingredients contains keyword matching kind
      const matched = all.filter((r) => {
        const ing = (r.ingredients || []).map((x) => String(x.name || x).toLowerCase());
        return [...kinds].some((k) => ing.some((n) => n.includes(k)));
      });
      if (alive) setRecipes(matched);
    })();
    return () => {
      alive = false;
    };
  }, [animal]);
  return recipes;
}

function buildEstimates(animal, count) {
  const outs = animal.outputs || [];
  const today = outs.map((o) => {
    const u = o.unit || DEFAULT_UNITS[o.kind] || "unit";
    const q = computePerDay(o, count);
    return { kind: o.kind, qty: q, unit: u };
  });
  const week = outs.map((o) => {
    const u = o.unit || DEFAULT_UNITS[o.kind] || "unit";
    const q =
      typeof o.estPerWeek === "number" && o.estPerWeek >= 0
        ? +(o.estPerWeek * (count || 1)).toFixed(2)
        : +(computePerDay(o, count) * 7).toFixed(2);
    return { kind: o.kind, qty: q, unit: u };
  });
  return { today, week };
}

function computePerDay(o, count) {
  const n = clamp(count, 1, 1e6);
  if (typeof o.estPerDay === "number" && o.estPerDay >= 0) {
    return +(o.estPerDay * n).toFixed(2);
  }
  // If only yearly provided (e.g., wool/honey), estimate per day
  if (typeof o.estPerYear === "number" && o.estPerYear >= 0) {
    return +((o.estPerYear / 365) * n).toFixed(2);
  }
  // If weekly provided
  if (typeof o.estPerWeek === "number" && o.estPerWeek >= 0) {
    return +((o.estPerWeek / 7) * n).toFixed(2);
  }
  return 0;
}

function unitOptionsFor(kind) {
  switch (kind) {
    case "eggs":
      return ["ct"];
    case "milk":
      return ["L", "gal"];
    case "manure":
      return ["lb", "kg"];
    case "wool":
      return ["lb", "kg"];
    case "meat":
      return ["lb", "kg"];
    case "honey":
      return ["lb", "kg"];
    default:
      return ["unit", "lb", "kg", "L", "gal", "ct"];
  }
}

function defaultProcessing(kind) {
  const s = PROCESSING_SUGGESTIONS[kind] || [];
  return s[0] || "";
}

function fmtQty(q, u) {
  if (q == null) return `0 ${u || ""}`.trim();
  const n = Number(q);
  if (Number.isNaN(n)) return `${q} ${u || ""}`.trim();
  return `${n % 1 === 0 ? n : n.toFixed(2)} ${u || ""}`.trim();
}

function formatEst(arr = []) {
  if (!arr.length) return "—";
  return arr
    .map((x) => `${x.qty % 1 === 0 ? x.qty : x.qty.toFixed(2)} ${x.unit} ${capitalize(x.kind)}`)
    .join(" • ");
}

function capitalize(s) {
  return (s || "").charAt(0).toUpperCase() + (s || "").slice(1);
}
