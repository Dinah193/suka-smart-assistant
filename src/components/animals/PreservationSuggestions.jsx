// src/components/animals/PreservationSuggestions.jsx
"use client";

import React, { useEffect, useMemo, useState } from "react";

/**
 * PreservationSuggestions
 * -----------------------------------------------------------------------------
 * Purpose:
 *  Turn fresh outputs (eggs, milk, meat, wool, honey, produce, etc.) into
 *  actionable preservation plans that connect to Tier-2 Preservation Suite.
 *
 * Project-integrated features:
 *  - Suggest methods per kind (pressure can, water-bath, ferment, dehydrate,
 *    freeze, cure/smoke, sausage, winemaking, beer brewing, distilling).
 *  - Check Inventory for required supplies (jars, lids, salt, sugar, vinegar,
 *    pink cure #1, casings, rennet, cultures, starter grains, etc.) and flag shortages.
 *  - Provide Make/Buy actions (emit to shopping list or “Make Supplies” if DIY).
 *  - Route to BatchSessionPlanner with inputs & chosen methods.
 *  - One-click Schedule on Calendar (approval required).
 *  - Print labels (freezer/jar) with QR payloads for batch tracking.
 *  - Visible plan JSON for edit/approval in UI.
 *
 * Props:
 *  - items: Array<{
 *      id?, source?, sourceId?, name?, kind, qty, unit,
 *      bestBy?: ISO string, notes?
 *    }>
 *  - compact?: boolean
 *  - defaultWindowMin?: number   // suggested working window
 *  - onPlanned?: (result) => void
 */

/* ------------------------------------------------------------------ */
/* Utilities */
const iso = (d = new Date()) => new Date(d).toISOString();
const isoDate = (d = new Date()) => new Date(d).toISOString().slice(0, 10);
const uid = (p = "id") => `${p}_${Math.random().toString(36).slice(2, 10)}`;
const clamp = (n, min, max) => Math.min(Math.max(Number(n) || 0, min), max);

const METHOD_ICONS = {
  freeze: "🧊",
  "pressure-canning": "🫙",
  "water-bath": "💧",
  dehydrate: "🌬️",
  ferment: "🫧",
  cure: "🥓",
  smoke: "🔥",
  sausage: "🌭",
  "beer-brew": "🍺",
  "wine-make": "🍷",
  distill: "⚗️",
  other: "🛠️",
};

const DEFAULT_METHODS_BY_KIND = {
  eggs: ["refrigerate", "dehydrate", "ferment", "pickle-eggs", "freeze"],
  milk: ["cheese-fresh", "yogurt", "butter-ghee", "freeze"],
  meat: ["vac-freeze", "cure", "smoke", "sausage", "pressure-canning", "dehydrate"],
  honey: ["jar-label", "infuse", "gift-pack"],
  wool: ["wash-scour", "card", "spin", "dye", "sell-barter"],
  manure: ["compost-hot", "compost-cold", "vermicompost", "bokashi"],
  produce: ["pressure-canning", "water-bath", "dehydrate", "ferment", "freeze"],
  other: ["store", "process", "freeze"],
};

const METHOD_TO_MODULE = {
  "pressure-canning": "pressureCanning", // Tier-2 tracker
  "water-bath": "canning",
  dehydrate: "dehydrating",
  ferment: "fermenting",
  freeze: "freezing",
  "vac-freeze": "freezing",
  cure: "curing",
  smoke: "curing",
  sausage: "sausageMaking",
  "cheese-fresh": "cheeseMaking",
  yogurt: "cheeseMaking",
  "butter-ghee": "cheeseMaking",
  "beer-brew": "beerBrewing",
  "wine-make": "winemaking",
  distill: "distilling",
  "pickle-eggs": "canning",
  "jar-label": "labels",
  "gift-pack": "labels",
  "wash-scour": "fiberProcessing",
  card: "fiberProcessing",
  spin: "fiberProcessing",
  dye: "fiberProcessing",
  "compost-hot": "composting",
  "compost-cold": "composting",
  vermicompost: "composting",
  bokashi: "composting",
  store: "inventory",
  process: "misc",
};

/* Supplies needed per method (simplified starter set; extend as needed) */
const SUPPLIES_BY_METHOD = {
  "pressure-canning": ["mason_jar_pint", "lid_ring_set", "pressure_canner", "jar_lifter", "salt_kosher"],
  "water-bath": ["mason_jar_quart", "lid_ring_set", "water_bath_canner", "jar_lifter", "vinegar_white"],
  dehydrate: ["dehydrator", "parchment", "containers_airtight"],
  ferment: ["mason_jar_quart", "airlock_lid", "salt_kosher"],
  freeze: ["freezer_bags", "vacuum_sealer_bags"],
  "vac-freeze": ["vacuum_sealer", "vacuum_sealer_bags"],
  cure: ["salt_kosher", "pink_cure_1", "sugar", "spices_basic"],
  smoke: ["smoker", "fuel_wood", "thermometer_probe"],
  sausage: ["meat_grinder", "sausage_stuffer", "casings_natural"],
  "cheese-fresh": ["rennet", "cheese_culture_mesophilic", "thermometer_dairy", "cheesecloth"],
  yogurt: ["yogurt_starter", "thermometer_dairy", "jars"],
  "butter-ghee": ["butter_churn_or_mixer", "cheesecloth", "jars"],
  "beer-brew": ["brew_kettle", "fermenter", "airlock", "bottles_caps"],
  "wine-make": ["carboy", "airlock", "yeast_wine", "sanitizer"],
  distill: ["still_unit", "hydrometer", "sanitizer"],
  "pickle-eggs": ["mason_jar_quart", "vinegar_white", "salt_kosher", "spices_pickling"],
  "jar-label": ["labels", "marker"],
  "gift-pack": ["labels", "gift_wrap"],
  "wash-scour": ["soap_scour", "tubs", "gloves"],
  card: ["carders"],
  spin: ["spinning_wheel_or_drop_spindle"],
  dye: ["dye_natural", "mordant_alum"],
  "compost-hot": ["compost_bin", "thermometer_compost"],
  "compost-cold": ["compost_bin"],
  vermicompost: ["worm_bin", "bedding"],
  bokashi: ["bokashi_bucket", "bokashi_bran"],
  store: [],
  process: [],
};

/* ------------------------------------------------------------------ */
/* Dynamic imports to avoid hard coupling */
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
/* Component */

export default function PreservationSuggestions({
  items = [],
  compact = false,
  defaultWindowMin = 90,
  onPlanned = () => {},
}) {
  const [selected, setSelected] = useState(() =>
    items.map((it) => ({
      ...it,
      rowId: uid("row"),
      method: suggestDefaultMethod(it.kind),
      module: METHOD_TO_MODULE[suggestDefaultMethod(it.kind)] || "inventory",
      windowMin: defaultWindowMin,
      notes: it.notes || "",
    }))
  );
  const [shortages, setShortages] = useState([]);
  const [planJSONOpen, setPlanJSONOpen] = useState(false);

  const dayKey = useMemo(() => isoDate(), []);

  /* Build supply needs & shortages when selection changes */
  useEffect(() => {
    let alive = true;
    (async () => {
      const inv = await _useInventoryStore();
      const inventory = inv?.inventory || [];
      const needs = aggregateSupplyNeeds(selected);
      const s = computeShortages(needs, inventory);
      if (alive) setShortages(s);
    })();
    return () => {
      alive = false;
    };
  }, [selected]);

  /* Suggested downstream recipes (batch-ready) */
  const suggestedRecipes = useSuggestedRecipes(selected);

  /* Actions */
  async function sendToBatchSession() {
    const bus = await _useAutomationBus();
    if (!bus?.emit) return;

    const payload = {
      source: "PreservationSuggestions",
      items: selected.map((s) => ({
        id: s.id || uid("in"),
        name: s.name || `${capitalize(s.kind)} ${s.qty}${s.unit}`,
        kind: s.kind,
        qty: Number(s.qty) || 0,
        unit: s.unit,
        method: s.method,
        module: s.module,
        notes: s.notes || "",
        tags: ["preservation", s.method, s.kind],
      })),
      shortages,
    };

    bus.emit("batch/addInputs", payload);

    onPlanned?.({ ok: true, routed: "batch", payload });
  }

  async function scheduleOnCalendar() {
    const bus = await _useAutomationBus();
    if (!bus?.emit) return;

    const mins = selected.reduce((sum, s) => sum + (Number(s.windowMin) || 0), 0) || defaultWindowMin;
    const start = new Date();
    const end = new Date(start.getTime() + mins * 60000);

    bus.emit("calendar/schedule", {
      source: "PreservationSuggestions",
      title: "Preservation Session",
      startISO: start.toISOString(),
      endISO: end.toISOString(),
      description: "Auto-scheduled from PreservationSuggestions. Approve/adjust as needed.",
      requireApproval: true,
      metadata: {
        items: selected.map((s) => ({ kind: s.kind, qty: s.qty, unit: s.unit, method: s.method })),
      },
    });

    onPlanned?.({ ok: true, routed: "calendar" });
  }

  async function printLabels() {
    const bus = await _useAutomationBus();
    if (!bus?.emit) return;

    const labelItems = selected.map((s) => {
      const title = labelTitleFor(s);
      const bb = s.bestBy ? isoDate(new Date(s.bestBy)) : "";
      return {
        title,
        subtitle: `${s.qty} ${s.unit} • ${capitalize(s.method.replace("-", " "))}`,
        footer: bb ? `Best by: ${bb}` : `Batch: ${dayKey}`,
        qrData: JSON.stringify({
          kind: s.kind,
          method: s.method,
          date: dayKey,
          qty: s.qty,
          unit: s.unit,
          sourceId: s.sourceId || null,
        }),
      };
    });

    bus.emit("labels/print", {
      template: "jar_freezer_basic",
      items: labelItems,
    });

    onPlanned?.({ ok: true, routed: "labels" });
  }

  async function resolveShortages() {
    const bus = await _useAutomationBus();
    if (!bus?.emit || !shortages.length) return;

    // Emit to shopping list with quantities (1 per missing item if unknown)
    bus.emit("shopping/addItems", {
      source: "PreservationSuggestions",
      items: shortages.map((s) => ({
        name: s.name,
        qty: s.missing > 0 ? s.missing : 1,
        unit: s.unit || "unit",
        tags: ["preservation-supplies", ...s.methods],
        note: `Needed for: ${s.methods.join(", ")}`,
      })),
    });

    // Also emit Make Supplies (for DIY vinegar, cultures, lids if in-house)
    bus.emit("supplies/makeDrafts", {
      source: "PreservationSuggestions",
      drafts: shortages
        .filter((s) => DIY_ALTERNATIVES[s.key])
        .map((s) => ({
          title: `Make ${DIY_ALTERNATIVES[s.key].name}`,
          steps: DIY_ALTERNATIVES[s.key].steps,
          tags: ["make-supplies", s.key],
        })),
    });

    onPlanned?.({ ok: true, routed: "shopping" });
  }

  function updateRow(rowId, patch) {
    setSelected((rows) => rows.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)));
  }

  /* Render */
  const planJSON = useMemo(
    () =>
      JSON.stringify(
        {
          date: isoDate(),
          items: selected.map((s) => ({
            kind: s.kind,
            qty: s.qty,
            unit: s.unit,
            method: s.method,
            windowMin: s.windowMin,
            bestBy: s.bestBy || null,
            notes: s.notes || "",
          })),
          suppliesShortages: shortages,
        },
        null,
        2
      ),
    [selected, shortages]
  );

  return (
    <div className={`rounded-2xl border bg-white shadow-sm ${compact ? "p-3" : "p-5"} flex flex-col gap-4`}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <div className="text-base font-semibold">Preservation Suggestions</div>
          <div className="text-xs text-slate-500">
            {selected.length} item{selected.length === 1 ? "" : "s"} • {isoDate()}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50" onClick={() => setPlanJSONOpen(true)}>
            View Plan JSON
          </button>
        </div>
      </div>

      {/* Shortages banner */}
      {shortages.length ? (
        <div className="p-3 rounded-xl border bg-amber-50 text-amber-800">
          <div className="font-medium">Supplies needed before you start</div>
          <ul className="list-disc ml-5 text-sm mt-1">
            {shortages.slice(0, 6).map((s) => (
              <li key={s.key}>
                {s.name} — need {s.need} {s.unit || ""}, have {s.have} {s.unit || ""} • for: {s.methods.join(", ")}
              </li>
            ))}
          </ul>
          {shortages.length > 6 ? <div className="text-xs mt-1">+ {shortages.length - 6} more…</div> : null}
          <div className="mt-2">
            <button className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50" onClick={resolveShortages}>
              Resolve Shortages (Add to Shopping / Make)
            </button>
          </div>
        </div>
      ) : null}

      {/* Rows */}
      <div className="space-y-3">
        {selected.map((row) => {
          const methods = methodsForKind(row.kind);
          const supplies = suppliesForMethod(row.method);
          return (
            <div key={row.rowId} className="p-3 rounded-2xl border bg-slate-50/70">
              <div className="grid grid-cols-12 gap-2">
                <div className="col-span-12 md:col-span-4">
                  <div className="text-xs text-slate-500">Item</div>
                  <div className="font-medium">
                    {row.name || `${capitalize(row.kind)} • ${row.qty} ${row.unit}`}
                  </div>
                  <div className="text-xs text-slate-500">
                    {row.bestBy ? `Best by: ${isoDate(new Date(row.bestBy))}` : "No best-by set"}
                  </div>
                </div>

                <div className="col-span-6 md:col-span-3">
                  <div className="text-xs text-slate-500">Method</div>
                  <select
                    value={row.method}
                    onChange={(e) =>
                      updateRow(row.rowId, {
                        method: e.target.value,
                        module: METHOD_TO_MODULE[e.target.value] || "inventory",
                      })
                    }
                    className="w-full px-2 py-1.5 rounded-xl border bg-white"
                  >
                    {methods.map((m) => (
                      <option key={m} value={m}>
                        {METHOD_ICONS[m] ? `${METHOD_ICONS[m]} ` : ""}{capitalize(m.replace("-", " "))}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="col-span-3 md:col-span-2">
                  <div className="text-xs text-slate-500">Time (min)</div>
                  <input
                    type="number"
                    inputMode="numeric"
                    className="w-full px-2 py-1.5 rounded-xl border"
                    value={row.windowMin}
                    onChange={(e) => updateRow(row.rowId, { windowMin: clamp(e.target.value, 10, 600) })}
                  />
                </div>

                <div className="col-span-3 md:col-span-3">
                  <div className="text-xs text-slate-500">Notes</div>
                  <input
                    type="text"
                    className="w-full px-2 py-1.5 rounded-xl border"
                    placeholder="Optional…"
                    value={row.notes}
                    onChange={(e) => updateRow(row.rowId, { notes: e.target.value })}
                  />
                </div>

                <div className="col-span-12">
                  <div className="mt-2 text-xs text-slate-500">Supplies for this method</div>
                  <div className="mt-1 flex flex-wrap gap-2">
                    {supplies.map((s) => (
                      <span key={s} className="px-2 py-0.5 rounded-full border text-xs bg-white">
                        {prettySupplyName(s)}
                      </span>
                    ))}
                    {!supplies.length ? <span className="text-xs text-slate-400">No special supplies required</span> : null}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Suggested recipes (friendly) */}
      {suggestedRecipes.length ? (
        <div>
          <div className="text-sm font-semibold mb-1">Recipes that match your picks</div>
          <div className="flex flex-wrap gap-2">
            {suggestedRecipes.slice(0, 10).map((r) => (
              <div key={r.id} className="px-3 py-1.5 rounded-xl border bg-white text-sm">
                {r.title || r.name}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 justify-end">
        <button className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50" onClick={sendToBatchSession}>
          Add to Batch Session
        </button>
        <button className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50" onClick={scheduleOnCalendar}>
          Schedule on Calendar
        </button>
        <button className="px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50" onClick={printLabels}>
          Print Labels
        </button>
      </div>

      {/* Plan JSON modal */}
      {planJSONOpen ? (
        <div className="fixed inset-0 bg-black/20 z-50 flex items-end md:items-center md:justify-center">
          <div className="w-full md:w-[700px] h-[70vh] bg-white rounded-t-2xl md:rounded-2xl p-4 shadow-lg border flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <div className="text-base font-semibold">Preservation Plan JSON</div>
              <button className="px-2 py-1 rounded-lg border hover:bg-slate-50" onClick={() => setPlanJSONOpen(false)}>
                ✕
              </button>
            </div>
            <pre className="flex-1 overflow-auto text-xs bg-slate-50 rounded-xl p-3 border">{planJSON}</pre>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Hooks & helpers */

function methodsForKind(kind = "other") {
  return DEFAULT_METHODS_BY_KIND[kind] || DEFAULT_METHODS_BY_KIND.other;
}

function suppliesForMethod(method) {
  return SUPPLIES_BY_METHOD[method] || [];
}

function prettySupplyName(key) {
  const dict = {
    mason_jar_pint: "Mason Jars (Pint)",
    mason_jar_quart: "Mason Jars (Quart)",
    lid_ring_set: "Lids & Rings",
    pressure_canner: "Pressure Canner",
    water_bath_canner: "Water Bath Canner",
    jar_lifter: "Jar Lifter",
    vinegar_white: "White Vinegar",
    salt_kosher: "Kosher Salt",
    sugar: "Sugar",
    pink_cure_1: "Pink Cure #1",
    spices_basic: "Spices (Basic)",
    spices_pickling: "Pickling Spices",
    dehydrator: "Dehydrator",
    parchment: "Parchment",
    containers_airtight: "Airtight Containers",
    airlock_lid: "Airlock Lids",
    freezer_bags: "Freezer Bags",
    vacuum_sealer: "Vacuum Sealer",
    vacuum_sealer_bags: "Vacuum Bags",
    smoker: "Smoker",
    fuel_wood: "Smoking Wood",
    thermometer_probe: "Probe Thermometer",
    meat_grinder: "Meat Grinder",
    sausage_stuffer: "Sausage Stuffer",
    casings_natural: "Natural Casings",
    rennet: "Rennet",
    cheese_culture_mesophilic: "Mesophilic Culture",
    thermometer_dairy: "Dairy Thermometer",
    cheesecloth: "Cheesecloth",
    yogurt_starter: "Yogurt Starter",
    jars: "Jars",
    brew_kettle: "Brew Kettle",
    fermenter: "Fermenter",
    airlock: "Airlock",
    bottles_caps: "Bottles & Caps",
    carboy: "Carboy",
    yeast_wine: "Wine Yeast",
    sanitizer: "Sanitizer",
    still_unit: "Still",
    hydrometer: "Hydrometer",
    labels: "Labels",
    gift_wrap: "Gift Wrap",
    soap_scour: "Scouring Soap",
    tubs: "Tubs/Bins",
    gloves: "Gloves",
    carders: "Carders",
    spinning_wheel_or_drop_spindle: "Spinning Wheel/Spindle",
    dye_natural: "Natural Dyes",
    mordant_alum: "Mordant (Alum)",
    compost_bin: "Compost Bin",
    thermometer_compost: "Compost Thermometer",
    worm_bin: "Worm Bin",
    bedding: "Bedding",
    bokashi_bucket: "Bokashi Bucket",
    bokashi_bran: "Bokashi Bran",
  };
  return dict[key] || key.replace(/_/g, " ");
}

function suggestDefaultMethod(kind = "other") {
  const arr = methodsForKind(kind);
  return arr[0] || "process";
}

function aggregateSupplyNeeds(rows = []) {
  // Summarize supply counts per method (rough 1 unit per method as a starter).
  const needMap = new Map();
  rows.forEach((r) => {
    const supplies = suppliesForMethod(r.method);
    supplies.forEach((s) => {
      const prev = needMap.get(s) || { key: s, need: 0, unit: "unit", methods: new Set() };
      prev.need += 1;
      prev.methods.add(r.method);
      needMap.set(s, prev);
    });
  });
  // Format
  return [...needMap.values()].map((v) => ({
    key: v.key,
    need: v.need,
    unit: v.unit,
    methods: [...v.methods],
  }));
}

function computeShortages(needs = [], inventory = []) {
  const invMap = new Map(
    inventory.map((i) => [i.key || i.id, { have: Number(i.qty) || 0, unit: i.unit || "unit", name: i.name || i.key }])
  );
  const out = [];
  needs.forEach((n) => {
    const inv = invMap.get(n.key);
    const have = inv?.have || 0;
    const missing = Math.max(0, n.need - have);
    if (missing > 0) {
      out.push({
        key: n.key,
        name: inv?.name || prettySupplyName(n.key),
        need: n.need,
        have,
        missing,
        unit: inv?.unit || n.unit || "unit",
        methods: n.methods,
      });
    }
  });
  return out;
}

const DIY_ALTERNATIVES = {
  vinegar_white: {
    name: "Homemade Vinegar",
    steps: ["Collect wine/cider", "Add vinegar mother", "Ferment 2–6 weeks", "Strain, bottle, label"],
  },
  sanitizer: { name: "Sanitizer (Starsan alt.)", steps: ["Boil water", "Add peracetic source", "Dilute to ppm", "Label"] },
  labels: { name: "Printable Labels", steps: ["Open Label Template", "Enter batch details", "Print on label stock"] },
};

function useSuggestedRecipes(rows) {
  const [recipes, setRecipes] = useState([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      const recipeStore = await _useRecipeStore();
      const all = recipeStore?.recipes || [];
      const kinds = new Set(rows.map((r) => r.kind));
      const methods = new Set(rows.map((r) => r.method));
      const matched = all.filter((r) => {
        const tags = new Set((r.tags || []).map((t) => String(t).toLowerCase()));
        const m1 = [...kinds].some((k) => tags.has(k.toLowerCase()));
        const m2 = [...methods].some((m) => tags.has(m.toLowerCase()));
        return m1 || m2;
      });
      if (alive) setRecipes(matched);
    })();
    return () => {
      alive = false;
    };
  }, [rows]);
  return recipes;
}

function labelTitleFor(s) {
  const base = s.name || `${capitalize(s.kind)} ${s.qty}${s.unit}`;
  const m = s.method ? ` — ${capitalize(s.method.replace("-", " "))}` : "";
  return `${base}${m}`;
}

function capitalize(x = "") {
  return x.charAt(0).toUpperCase() + x.slice(1);
}
