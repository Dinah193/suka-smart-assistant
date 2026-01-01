// src/components/cleaning/SupplyChecklistPanel.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { CheckCircle, XCircle, PlusCircle, Recycle, Zap, ShoppingCart, Wrench, FlaskConical, Filter, X, AlertTriangle, CalendarDays } from "lucide-react";

/**
 * SupplyChecklistPanel — inventory-aware, DIY-friendly supply manager
 * -------------------------------------------------------------------
 * Drop-in replacement; no required props.
 *
 * Optional props (all safe to omit):
 *  - inventory?: Array<{ key|id:string, qty:number }>
 *  - templates?: Array<{ id:string, name:string, type:'eco'|'power'|'custom', status?:'needed'|'in-stock'|'make', tags?:string[] }>
 *  - recipes?: Array<{ id:string, name:string, yields?:string, ingredients:Array<{key:string, qty:number, unit?:string}> }>
 *  - saturdayAsSabbath?: boolean
 *  - hebrewDayOfWeek?: (Date)=>number
 *  - onChange?: (list)=>void
 *  - onExportShopping?: (payload)=>void          // called when "Resolve Needed"->Shopping
 *  - onExportMakeList?: (payload)=>void          // called when "Make DIY Batch"
 *
 * Status semantics:
 *  - "needed"  : show in Shortage resolver
 *  - "in-stock": satisfied
 *  - "make"    : plan to make DIY (will check ingredient shortages)
 */

// ---------------- Utilities ----------------
const iso = (d = new Date()) => new Date(d).toISOString();
const cap = (s = "") => s.charAt(0).toUpperCase() + s.slice(1);
const keyOf = (x) => (x && (x.key || x.id)) || "";
const setFrom = (list = []) => { const s = new Set(); list.forEach((x) => s.add(keyOf(x))); return s; };
const clamp = (n, min, max) => Math.min(Math.max(Number(n) || 0, min), max);

function prettyKey(k = "") {
  return k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function isSabbath(dateObj, { saturdayAsSabbath = false, hebrewDayOfWeek } = {}) {
  if (saturdayAsSabbath) return dateObj.getDay() === 6; // Saturday
  if (typeof hebrewDayOfWeek === "function") return hebrewDayOfWeek(dateObj) === 7; // Hebrew Day-7
  return false;
}

// Fallback templates (removed brittle external import)
const FALLBACK_TEMPLATES = [
  { id: "white_vinegar",   name: "White Vinegar",      type: "eco",   status: "needed", tags: ["multi"] },
  { id: "castile_soap",    name: "Castile Soap",       type: "eco",   status: "needed", tags: ["surfaces"] },
  { id: "baking_soda",     name: "Baking Soda",        type: "eco",   status: "needed", tags: ["scrub"] },
  { id: "isopropyl_alcohol_70", name: "Isopropyl Alcohol (70%)", type: "eco", status: "needed", tags: ["glass"] },
  { id: "bleach",          name: "Bleach",             type: "power", status: "needed", tags: ["disinfect"] },
  { id: "oven_cleaner",    name: "Oven Cleaner",       type: "power", status: "needed", tags: ["kitchen"] },
  { id: "disinfecting_wipes", name: "Disinfecting Wipes", type: "power", status: "needed", tags: ["quick"] },
];

// Fallback recipes — mirrors DeepCleanSession built-ins
const FALLBACK_RECIPES = [
  {
    id: "sr_all_purpose", name: "All-Purpose Cleaner", yields: "16 oz",
    ingredients: [
      { key: "white_vinegar", qty: 1, unit: "cup" },
      { key: "castile_soap",  qty: 1, unit: "tbsp" },
      { key: "water",         qty: 1, unit: "cup" },
    ],
  },
  {
    id: "sr_glass", name: "Glass Cleaner", yields: "16 oz",
    ingredients: [
      { key: "isopropyl_alcohol_70", qty: 1, unit: "cup" },
      { key: "white_vinegar",        qty: 1, unit: "tbsp" },
      { key: "water",                qty: 1, unit: "cup" },
    ],
  },
  {
    id: "sr_powder_scrub", name: "Powder Scrub", yields: "1 jar",
    ingredients: [
      { key: "baking_soda", qty: 1, unit: "cup" },
    ],
  },
];

// sandbox-safe AutomationBus shim
async function _useAutomationBus() {
  return { emit: () => {}, invoke: async () => {} };
}

function computeIngredientShortages(recipes = [], inventory = []) {
  const invMap = new Map(inventory.map((i) => [keyOf(i), Number(i.qty) || 0]));
  const out = [];
  recipes.forEach((r) => {
    (r.ingredients || []).forEach((ing) => {
      if (!ing?.key) return;
      const have = invMap.get(ing.key) || 0;
      const need = Number(ing.qty) || 0;
      if (need > have) {
        out.push({
          key: ing.key,
          name: prettyKey(ing.key),
          unit: ing.unit || "unit",
          have,
          need,
          missing: Math.max(0, need - have),
          recipe: r.name,
        });
      }
    });
  });
  return out;
}

// ---------------- Component ----------------
export default function SupplyChecklistPanel({
  inventory = [],
  templates,
  recipes,
  saturdayAsSabbath = false,
  hebrewDayOfWeek,
  onChange,
  onExportShopping,
  onExportMakeList,
}) {
  // Merge templates with persisted state
  const seed = useMemo(() => templates || FALLBACK_TEMPLATES, [templates]);
  const [supplies, setSupplies] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("supplyChecklist.v1") || "null");
      if (Array.isArray(saved)) return saved;
    } catch {}
    // normalize IDs/fields
    return seed.map((s) => ({ id: s.id, name: s.name, type: s.type || "custom", status: s.status || "needed", tags: s.tags || [] }));
  });

  // UI state
  const [filter, setFilter] = useState(() => { try { return localStorage.getItem("supplyChecklist.filter") || "all"; } catch { return "all"; } });
  const [q, setQ] = useState(() => { try { return localStorage.getItem("supplyChecklist.q") || ""; } catch { return ""; } });
  const [customInput, setCustomInput] = useState("");
  const [qtyInput, setQtyInput] = useState(""); // single quick quantity for custom

  // Persist
  useEffect(() => { try { localStorage.setItem("supplyChecklist.v1", JSON.stringify(supplies)); } catch {} }, [supplies]);
  useEffect(() => { try { localStorage.setItem("supplyChecklist.filter", filter); } catch {} }, [filter]);
  useEffect(() => { try { localStorage.setItem("supplyChecklist.q", q); } catch {} }, [q]);
  useEffect(() => { try { onChange && onChange(supplies); } catch {} }, [supplies, onChange]);

  // Inventory set for quick presence checks
  const invSet = useMemo(() => setFrom(inventory), [inventory]);

  // Resolved recipes list
  const recipeList = useMemo(() => recipes || FALLBACK_RECIPES, [recipes]);

  // Sabbath hint
  const sabbathActive = useMemo(() => isSabbath(new Date(), { saturdayAsSabbath, hebrewDayOfWeek }), [saturdayAsSabbath, hebrewDayOfWeek]);

  // Derived views
  const filteredSupplies = useMemo(() => {
    const text = q.trim().toLowerCase();
    return supplies.filter((item) => {
      if (filter !== "all" && item.type !== filter) return false;
      if (!text) return true;
      const hay = [item.name, item.type, ...(item.tags || [])].join(" ").toLowerCase();
      return hay.includes(text);
    });
  }, [supplies, filter, q]);

  const counts = useMemo(() => {
    const all = supplies.length;
    const eco = supplies.filter((s) => s.type === "eco").length;
    const power = supplies.filter((s) => s.type === "power").length;
    const needed = supplies.filter((s) => s.status === "needed").length;
    const inStock = supplies.filter((s) => s.status === "in-stock").length;
    const makeCount = supplies.filter((s) => s.status === "make").length;
    return { all, eco, power, needed, inStock, makeCount };
  }, [supplies]);

  // Ingredient shortages for selected DIY ("make") items — aggregate their recipes if matching IDs
  const diyShortages = useMemo(() => {
    const diyIds = new Set(supplies.filter((s) => s.status === "make").map((s) => s.id));
    const diyRecipes = recipeList.filter((r) => diyIds.has(r.id));
    return computeIngredientShortages(diyRecipes, inventory);
  }, [supplies, recipeList, inventory]);

  // Actions
  const toggleStatus = useCallback((id) => {
    setSupplies((list) =>
      list.map((item) =>
        item.id === id
          ? {
              ...item,
              status: item.status === "needed" ? "in-stock"
                    : item.status === "in-stock" ? "make"
                    : "needed", // cycle needed -> in-stock -> make -> needed
            }
          : item
      )
    );
  }, []);

  const handleAddCustom = useCallback(() => {
    if (!customInput.trim()) return;
    const newItem = {
      id: customInput.trim().toLowerCase().replace(/\s+/g, "_"),
      name: customInput.trim(),
      type: "custom",
      status: "needed",
      qty: qtyInput ? clamp(qtyInput, 0, 9999) : undefined,
    };
    setSupplies((list) => [...list, newItem]);
    setCustomInput("");
    setQtyInput("");
  }, [customInput, qtyInput]);

  const markAll = useCallback((next) => {
    setSupplies((list) => list.map((s) => ({ ...s, status: next })));
  }, []);

  async function resolveNeededToShopping() {
    const bus = await _useAutomationBus();
    const needed = supplies.filter((s) => s.status === "needed");
    const items = needed.map((s) => ({
      name: s.name,
      qty: s.qty && Number(s.qty) > 0 ? Number(s.qty) : 1,
      unit: "unit",
      tags: ["cleaning-supplies", s.type || "custom"],
      note: "From SupplyChecklistPanel",
      key: s.id,
    }));
    const payload = { source: "SupplyChecklistPanel", createdAt: iso(), items };
    try { bus.emit && bus.emit("shopping/addItems", payload); } catch {}
    try { onExportShopping && onExportShopping(payload); } catch {}
  }

  async function makeDIYBatch() {
    const bus = await _useAutomationBus();
    const diyIds = new Set(supplies.filter((s) => s.status === "make").map((s) => s.id));
    const chosen = recipeList.filter((r) => diyIds.has(r.id));
    const payload = { source: "SupplyChecklistPanel", createdAt: iso(), recipes: chosen };
    // Emit both a make-list and shopping fallback for missing ingredients
    try { bus.emit && bus.emit("supplies/makeList", payload); } catch {}
    if (diyShortages.length) {
      try {
        bus.emit && bus.emit("shopping/addItems", {
          source: "SupplyChecklistPanel",
          createdAt: iso(),
          items: diyShortages.map((s) => ({
            name: s.name, qty: s.missing || 1, unit: s.unit || "unit",
            tags: ["cleaning-ingredients", "diy"],
            note: `Ingredient for ${s.recipe}`,
          })),
        });
      } catch {}
    }
    try { onExportMakeList && onExportMakeList(payload); } catch {}
  }

  // Render helpers
  function StatusButton({ status }) {
    const map = {
      "in-stock": { cls: "bg-green-600 text-white", icon: CheckCircle, label: "In Stock" },
      "needed":   { cls: "bg-stone-300 text-black", icon: XCircle, label: "Needed" },
      "make":     { cls: "bg-blue-600 text-white", icon: FlaskConical, label: "DIY Make" },
    };
    const m = map[status] || map["needed"];
    const Icon = m.icon;
    return (
      <span className={`flex items-center gap-1 px-3 py-1 rounded text-sm ${m.cls}`}>
        <Icon size={16} /> {m.label}
      </span>
    );
  }

  return (
    <div className="bg-white border border-green-300 rounded-lg p-5 shadow">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-green-700">🧴 Supply Checklist</h2>
        <div className="flex flex-wrap gap-2 items-center">
          {sabbathActive ? (
            <span className="text-[11px] text-emerald-700 inline-flex items-center gap-1">
              <CalendarDays size={14} /> Sabbath-friendly: focus on prep/DIY
            </span>
          ) : null}
          <button
            onClick={() => setFilter("all")}
            className={`px-3 py-1 rounded ${filter === "all" ? "bg-green-500 text-white" : "bg-green-100 text-green-700"}`}
          >
            All ({counts.all})
          </button>
          <button
            onClick={() => setFilter("eco")}
            className={`px-3 py-1 rounded flex items-center gap-1 ${filter === "eco" ? "bg-green-500 text-white" : "bg-green-100 text-green-700"}`}
            title="Eco / low-tox supplies"
          >
            <Recycle size={16} /> Eco ({counts.eco})
          </button>
          <button
            onClick={() => setFilter("power")}
            className={`px-3 py-1 rounded flex items-center gap-1 ${filter === "power" ? "bg-yellow-500 text-white" : "bg-yellow-100 text-yellow-700"}`}
            title="Stronger chemical supplies"
          >
            <Zap size={16} /> Strong ({counts.power})
          </button>
        </div>
      </div>

      {/* Search + bulk */}
      <div className="flex flex-wrap gap-2 items-center mb-4">
        <label className="relative flex-1 min-w-[200px]" aria-label="Search supplies">
          <Filter size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden />
          <input
            type="text"
            placeholder="Search by name or tag…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full pl-7 pr-6 py-2 text-sm rounded border border-slate-300"
          />
          {q ? (
            <button className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600" onClick={() => setQ("")} aria-label="Clear search">
              <X size={14} />
            </button>
          ) : null}
        </label>

        <div className="flex items-center gap-2 text-xs">
          <button className="px-2.5 py-1 rounded border bg-white hover:bg-slate-50" onClick={() => markAll("in-stock")}>
            Mark all In-Stock
          </button>
          <button className="px-2.5 py-1 rounded border bg-white hover:bg-slate-50" onClick={() => markAll("needed")}>
            Mark all Needed
          </button>
          <button className="px-2.5 py-1 rounded border bg-white hover:bg-slate-50" onClick={() => markAll("make")}>
            Mark all DIY
          </button>
        </div>
      </div>

      {/* Checklist */}
      <ul className="space-y-3 mb-6">
        {filteredSupplies.map((item) => {
          const present = invSet.has(item.id);
          const missingBadge = !present && item.status !== "in-stock";
          return (
            <li
              key={item.id}
              className={`flex items-center justify-between px-4 py-3 border rounded
                ${item.status === "in-stock" ? "border-green-400 bg-green-50"
                  : item.status === "make" ? "border-blue-400 bg-blue-50"
                  : "border-stone-300 bg-stone-50"}`}
            >
              <div className="min-w-0 pr-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-stone-800 truncate">{item.name}</span>
                  {/* tiny tags */}
                  {item.tags && item.tags.length ? (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-slate-50 text-slate-600 border border-slate-200 truncate max-w-[140px]">
                      {item.tags.slice(0, 2).join(" • ")}
                      {item.tags.length > 2 ? " +" + (item.tags.length - 2) : ""}
                    </span>
                  ) : null}
                  {/* presence badge */}
                  {missingBadge ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-amber-700">
                      <AlertTriangle size={12} /> not in inventory
                    </span>
                  ) : null}
                </div>
                {/* status & affordances */}
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <StatusButton status={item.status} />
                  {item.status === "make" ? (
                    <span className="text-[11px] inline-flex items-center gap-1 text-blue-700">
                      <Wrench size={12} /> DIY
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => toggleStatus(item.id)}
                  className="px-2.5 py-1 rounded border bg-white hover:bg-slate-50 text-sm"
                  aria-label={`Toggle status for ${item.name}`}
                  title="Toggle status (Needed → In-Stock → DIY)"
                >
                  Toggle
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Add Custom Item */}
      <div className="flex gap-3 items-center">
        <input
          type="text"
          placeholder="Add custom item…"
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          className="flex-1 border border-stone-300 px-3 py-2 rounded"
        />
        <input
          type="number"
          placeholder="qty"
          min={0}
          value={qtyInput}
          onChange={(e) => setQtyInput(e.target.value)}
          className="w-[90px] border border-stone-300 px-3 py-2 rounded"
        />
        <button
          onClick={handleAddCustom}
          className="bg-green-500 hover:bg-green-600 text-white px-3 py-2 rounded flex items-center gap-1"
        >
          <PlusCircle size={16} /> Add
        </button>
      </div>

      {/* Resolvers */}
      <div className="mt-6 grid gap-3 md:grid-cols-2">
        {/* Needed → Shopping */}
        <div className="p-3 rounded border bg-emerald-50">
          <div className="font-medium text-emerald-900 mb-1">Resolve Needed</div>
          <p className="text-sm text-emerald-800">
            Send all <b>Needed</b> items to your shopping list.
          </p>
          <button
            onClick={resolveNeededToShopping}
            className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50"
          >
            <ShoppingCart size={16} /> Add to Shopping
          </button>
        </div>

        {/* DIY Make — ingredient shortages */}
        <div className="p-3 rounded border bg-blue-50">
          <div className="font-medium text-blue-900 mb-1">Make DIY Batch</div>
          <p className="text-sm text-blue-800">
            Builds a make-list for items marked <b>DIY</b>. We’ll also add missing ingredients to Shopping.
          </p>
          {diyShortages.length ? (
            <div className="mt-2 text-[12px] text-blue-900">
              <div className="font-medium mb-1">Missing ingredients:</div>
              <ul className="list-disc ml-5">
                {diyShortages.slice(0, 6).map((s) => (
                  <li key={`${s.key}-${s.recipe}`}>
                    {s.name}: need {s.need} {s.unit}, have {s.have} — for {s.recipe}
                  </li>
                ))}
              </ul>
              {diyShortages.length > 6 ? <div className="mt-1">+ {diyShortages.length - 6} more…</div> : null}
            </div>
          ) : (
            <div className="mt-2 text-[12px] text-blue-900">All ingredients available.</div>
          )}
          <button
            onClick={makeDIYBatch}
            className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50"
          >
            <FlaskConical size={16} /> Make DIY Batch
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tiny self-tests (run once in dev-like environments) */
(function selfTests() {
  try {
    // Status cycle
    let list = [{ id: "white_vinegar", name: "White Vinegar", type: "eco", status: "needed" }];
    const toggle = (id) => { list = list.map((x) => x.id === id ? { ...x, status: x.status === "needed" ? "in-stock" : x.status === "in-stock" ? "make" : "needed" } : x); };
    toggle("white_vinegar"); // needed -> in-stock
    console.assert(list[0].status === "in-stock", "[TEST] status toggles to in-stock");
    toggle("white_vinegar"); // in-stock -> make
    console.assert(list[0].status === "make", "[TEST] status toggles to make");

    // Ingredient shortage calc (matches DeepCleanSession fallbacks)
    const inv = [{ key: "white_vinegar", qty: 0.5 }, { key: "castile_soap", qty: 0 }];
    const shorts = (function testShorts() {
      const r = FALLBACK_RECIPES.filter((r) => r.id === "sr_all_purpose");
      return computeIngredientShortages(r, inv);
    })();
    console.assert(Array.isArray(shorts) && shorts.length >= 1, "[TEST] shortages detected for DIY recipe");
  } catch (e) {
    if (typeof console !== "undefined") console.warn("SupplyChecklistPanel self-tests skipped/failed:", e?.message || e);
  }
})();
