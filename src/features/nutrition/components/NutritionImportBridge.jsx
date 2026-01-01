import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * NutritionImportBridge
 * -----------------------------------------------------------------------------
 * What it does
 *  - Accepts CSV/JSON via file upload, paste, or URL
 *  - Detects format and normalizes to Suka structures:
 *      • recipes[]         -> { id, title, ingredients[], steps[], tags[], macros? }
 *      • inventoryItems[]  -> { id, name, qty, unit, location?, category? }
 *      • macroPlan         -> { calories, macrosPct, macrosG, mealsPerDay, ... }
 *  - Shows PREVIEW cards so users can verify before applying.
 *  - On Apply, routes data into connected modules using:
 *      1) callbacks (props.onApply?) if provided
 *      2) window.dispatchEvent CustomEvents for app-wide orchestration:
 *         - "suka:recipesImported"   { recipes }
 *         - "suka:inventoryUpsert"   { items }
 *         - "suka:batchQueueAdd"     { recipeIds }
 *         - "suka:macroPlanApplied"  { plan }
 *         - "suka:groceryListMerge"  { items }
 *  - Persists the last import (localStorage) so users can restore if needed.
 *
 * Props:
 *  - onApply?: (payload) => void
 *  - onError?: (err) => void
 *  - storageKey?: string   // default: "nutritionImportBridge:v1"
 *
 * Notes:
 *  - This component doesn't assume direct store imports; it emits events and
 *    offers callbacks to keep it decoupled from your stores/agents.
 *  - Your existing listeners (Recipe Library, BatchSessionPlanner, GroceryListGenerator,
 *    InventorySyncModal, Meal Planner) can react to these events.
 */

const btnBase =
  "inline-flex items-center justify-center rounded-xl border bg-white px-4 py-2 font-medium shadow-[0_6px_0_rgba(0,0,0,0.2),0_1px_4px_rgba(0,0,0,0.15)] active:translate-y-[4px] active:shadow-[0_2px_0_rgba(0,0,0,0.25),0_1px_2px_rgba(0,0,0,0.25)] transition-all";
const card =
  "rounded-3xl p-5 bg-gradient-to-b from-slate-50 to-slate-200 border border-slate-300 shadow-[0_10px_0_rgba(0,0,0,0.15),0_2px_8px_rgba(0,0,0,0.15)]";
const smallCard = "rounded-2xl p-4 bg-white border";

const uid = () => Math.random().toString(36).slice(2, 9);
const clamp = (n, min, max) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : 0));
const round0 = (n) => Math.round(n);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/* ------------------------- Minimal CSV parser ------------------------- */
/* Handles quoted fields and commas; keeps it lightweight for client use. */
function parseCSV(csv) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  while (i < csv.length) {
    const ch = csv[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        } else {
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        field += ch;
        i++;
        continue;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
        continue;
      }
      if (ch === ",") {
        row.push(field);
        field = "";
        i++;
        continue;
      }
      if (ch === "\n" || ch === "\r") {
        // commit row on line end
        if (field.length || row.length) {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
        }
        // skip \r\n or \n\r pairs
        if ((ch === "\r" && csv[i + 1] === "\n") || (ch === "\n" && csv[i + 1] === "\r")) i++;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  // first line as header if textual
  if (rows.length === 0) return { header: [], data: [] };
  const header = rows[0].map((h) => h.trim());
  const dataRows = rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== ""));
  const data = dataRows.map((r) => {
    const o = {};
    header.forEach((h, idx) => (o[h || `col_${idx}`] = r[idx] ?? ""));
    return o;
  });
  return { header, data };
}

/* ------------------------- DETECTION + NORMALIZERS ------------------------- */

/**
 * detectFormat(buffer, name?)
 * Returns { kind: "recipes" | "inventory" | "macroPlan" | "grocery", format: "json"|"csv", parsed }
 */
function detectFormat(text, name = "") {
  const trimmed = text.trim();
  if (!trimmed) return { kind: null, format: null, parsed: null, reason: "empty" };

  // JSON?
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      // Heuristics
      if (Array.isArray(parsed)) {
        // Array could be recipes or inventory or grocery items
        if (parsed[0] && (parsed[0].ingredients || parsed[0].steps || parsed[0].title || parsed[0].name)) {
          // assume recipes if ingredients or steps present
          if (parsed[0].ingredients || parsed[0].steps || parsed[0].title) {
            return { kind: "recipes", format: "json", parsed };
          }
          // if it looks like inventory/grocery
          if (parsed[0].qty || parsed[0].quantity || parsed[0].unit) {
            return { kind: "inventory", format: "json", parsed };
          }
          // fallback grocery if {name} only
          if (parsed[0].name) return { kind: "grocery", format: "json", parsed };
        }
      } else if (isObj(parsed)) {
        // Might be a Macro Plan export from MacroPercentCalculator
        if (parsed?.targets?.macrosPct && parsed?.targets?.macrosG) {
          return { kind: "macroPlan", format: "json", parsed };
        }
        // Could also be { recipes:[], items:[], macroPlan:{} }
        if (parsed?.recipes || parsed?.inventory || parsed?.grocery || parsed?.macroPlan) {
          // We'll normalize in a combined way later
          return { kind: "bundle", format: "json", parsed };
        }
      }
      // Unknown JSON, let user select later with manual toggles
      return { kind: "unknown", format: "json", parsed };
    } catch (e) {
      return { kind: "unknown", format: "json", parsed: null, reason: "invalid_json" };
    }
  }

  // CSV?
  if (name.toLowerCase().endsWith(".csv") || trimmed.includes(",") || trimmed.includes("\n")) {
    const parsed = parseCSV(trimmed);
    // Header heuristics
    const headerLower = parsed.header.map((h) => h.toLowerCase());
    const isRecipeCSV =
      headerLower.includes("recipe") ||
      headerLower.includes("title") ||
      headerLower.includes("ingredients") ||
      headerLower.includes("directions") ||
      headerLower.includes("steps");
    const isInventoryCSV =
      headerLower.includes("name") && (headerLower.includes("qty") || headerLower.includes("quantity"));
    const isGroceryCSV = headerLower.includes("item") || headerLower.includes("grocery") || headerLower.includes("name");

    if (isRecipeCSV) return { kind: "recipes", format: "csv", parsed };
    if (isInventoryCSV) return { kind: "inventory", format: "csv", parsed };
    if (isGroceryCSV) return { kind: "grocery", format: "csv", parsed };
    return { kind: "unknown", format: "csv", parsed };
  }

  return { kind: "unknown", format: "text", parsed: trimmed };
}

/** Normalize recipes from JSON/CSV guessed shapes into Suka Recipe structure */
function normalizeRecipes(payload) {
  if (!payload) return [];
  const fromCSV = payload.header && payload.data;
  const rows = fromCSV ? payload.data : Array.isArray(payload) ? payload : payload.recipes || [];
  return rows
    .map((r) => {
      const id = r.id || r._id || uid();
      const title = r.title || r.name || r.recipe || "Untitled Recipe";
      const rawIngredients =
        r.ingredients ||
        r.Ingredients ||
        r.ingredientList ||
        r.items ||
        r.itemList ||
        r.components ||
        (fromCSV ? r.ingredients || r.Ingredients : []);
      const ingredients = Array.isArray(rawIngredients)
        ? rawIngredients
        : typeof rawIngredients === "string"
        ? rawIngredients
            .split(/[\n;]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const stepsRaw = r.steps || r.directions || r.instructions || r.method || r.Steps || [];
      const steps = Array.isArray(stepsRaw)
        ? stepsRaw
        : typeof stepsRaw === "string"
        ? stepsRaw
            .split(/[\n;]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const tags =
        r.tags ||
        r.Tag ||
        (typeof r.category === "string" ? [r.category] : r.category) ||
        (typeof r.cuisine === "string" ? [r.cuisine] : r.cuisine) ||
        [];
      const macros = r.macros || r.nutrition || null;

      return { id, title, ingredients, steps, tags: Array.isArray(tags) ? tags : [], macros };
    })
    .filter((x) => x && x.title);
}

/** Normalize inventory/grocery items into a common structure */
function normalizeItems(payload) {
  if (!payload) return [];
  const fromCSV = payload.header && payload.data;
  const rows = fromCSV ? payload.data : Array.isArray(payload) ? payload : payload.items || payload.inventory || [];
  return rows
    .map((r) => {
      const id = r.id || r._id || uid();
      const name = r.name || r.item || r.ingredient || r.food || r.product || "Unnamed Item";
      const qty = Number(r.qty ?? r.quantity ?? r.count ?? 1) || 1;
      const unit = r.unit || r.units || "";
      const location = r.location || r.store || r.pantry || "";
      const category = r.category || r.group || "";
      return { id, name, qty, unit, location, category };
    })
    .filter((x) => x && x.name);
}

/** Normalize a macro plan from a MacroPercentCalculator export or similar */
function normalizeMacroPlan(payload) {
  if (!payload) return null;
  const plan = payload.targets
    ? payload
    : payload.macroPlan
    ? payload.macroPlan
    : isObj(payload) && payload.calories && payload.macrosPct
    ? { targets: payload }
    : null;

  if (!plan) return null;

  const calories = plan.targets?.calories ?? 2000;
  const macrosPct = plan.targets?.macrosPct ?? { protein: 30, fat: 30, carbs: 40 };
  const macrosG = plan.targets?.macrosG ?? { protein: 150, fat: 67, carbs: 200 };
  const mealsPerDay = plan.targets?.mealsPerDay ?? 3;

  return {
    calories,
    macrosPct,
    macrosG,
    mealsPerDay,
    meta: {
      source: plan.meta?.source || "Suka Import",
      timestamp: new Date().toISOString(),
    },
  };
}

/** Try to coerce unknown JSON into a bundle shape {recipes, items, grocery, macroPlan} */
function coerceBundle(parsed) {
  if (!parsed) return { recipes: [], items: [], grocery: [], macroPlan: null };
  if (Array.isArray(parsed)) {
    // guess by row content, keep as recipes if they have ingredients/steps
    const looksLikeRecipe = parsed.some((r) => r.ingredients || r.steps || r.title);
    if (looksLikeRecipe) return { recipes: normalizeRecipes(parsed), items: [], grocery: [], macroPlan: null };
    // else treat as items/grocery
    return { recipes: [], items: normalizeItems(parsed), grocery: [], macroPlan: null };
  }
  return {
    recipes: normalizeRecipes(parsed.recipes || parsed),
    items: normalizeItems(parsed.items || parsed.inventory),
    grocery: normalizeItems(parsed.grocery || []),
    macroPlan: normalizeMacroPlan(parsed.macroPlan || parsed),
  };
}

/* ------------------------- Component ------------------------- */

export default function NutritionImportBridge({
  onApply,
  onError,
  storageKey = "nutritionImportBridge:v1",
}) {
  const fileInputRef = useRef(null);

  const [rawName, setRawName] = useState("");
  const [rawText, setRawText] = useState("");
  const [url, setUrl] = useState("");
  const [detected, setDetected] = useState(null); // { kind, format, parsed }
  const [manualKind, setManualKind] = useState(null); // allow override if detection unknown

  const [recipes, setRecipes] = useState([]);
  const [items, setItems] = useState([]); // inventory/grocery combined normalized
  const [macroPlan, setMacroPlan] = useState(null);

  // post-import routing toggles
  const [routeRecipesToLibrary, setRouteRecipesToLibrary] = useState(true);
  const [routeItemsToInventory, setRouteItemsToInventory] = useState(true);
  const [alsoQueueBatch, setAlsoQueueBatch] = useState(false);
  const [mergeGroceryList, setMergeGroceryList] = useState(true);
  const [applyMacroPlan, setApplyMacroPlan] = useState(true);

  // restore previous session
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const s = JSON.parse(raw);
        setRawName(s.rawName || "");
        setRawText(s.rawText || "");
        setUrl(s.url || "");
        setManualKind(s.manualKind || null);
        setRecipes(Array.isArray(s.recipes) ? s.recipes : []);
        setItems(Array.isArray(s.items) ? s.items : []);
        setMacroPlan(s.macroPlan || null);
        setRouteRecipesToLibrary(s.routeRecipesToLibrary ?? true);
        setRouteItemsToInventory(s.routeItemsToInventory ?? true);
        setAlsoQueueBatch(s.alsoQueueBatch ?? false);
        setMergeGroceryList(s.mergeGroceryList ?? true);
        setApplyMacroPlan(s.applyMacroPlan ?? true);
        setDetected(s.detected || null);
      }
    } catch (e) {
      // ignore
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // persist session
  useEffect(() => {
    try {
      const s = {
        rawName,
        rawText,
        url,
        manualKind,
        recipes,
        items,
        macroPlan,
        routeRecipesToLibrary,
        routeItemsToInventory,
        alsoQueueBatch,
        mergeGroceryList,
        applyMacroPlan,
        detected,
      };
      localStorage.setItem(storageKey, JSON.stringify(s));
    } catch (e) {
      // ignore
    }
  }, [
    rawName,
    rawText,
    url,
    manualKind,
    recipes,
    items,
    macroPlan,
    routeRecipesToLibrary,
    routeItemsToInventory,
    alsoQueueBatch,
    mergeGroceryList,
    applyMacroPlan,
    detected,
    storageKey,
  ]);

  /* ------------------------- Handlers ------------------------- */

  function handleFiles(files) {
    if (!files || !files.length) return;
    const f = files[0];
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      setRawName(f.name);
      setRawText(text);
      runDetection(text, f.name);
    };
    reader.onerror = () => {
      reportError(new Error("Failed to read file."));
    };
    reader.readAsText(f);
  }

  function reportError(err) {
    console.error(err);
    if (typeof onError === "function") onError(err);
    // lightweight toast replacement:
    alert(`Import error: ${err.message || err}`);
  }

  function runDetection(text, name = "") {
    const d = detectFormat(text, name);
    setDetected(d);

    if (d.kind === "recipes") {
      setRecipes(normalizeRecipes(d.parsed));
      setItems([]);
      setMacroPlan(null);
    } else if (d.kind === "inventory" || d.kind === "grocery") {
      setItems(normalizeItems(d.parsed));
      setRecipes([]);
      setMacroPlan(null);
    } else if (d.kind === "macroPlan") {
      setMacroPlan(normalizeMacroPlan(d.parsed));
      setRecipes([]);
      setItems([]);
    } else if (d.kind === "bundle") {
      const b = coerceBundle(d.parsed);
      setRecipes(b.recipes);
      setItems(b.items.concat(b.grocery || []));
      setMacroPlan(b.macroPlan);
    } else {
      // unknown -> let user set manualKind and try to coerce
      setRecipes([]);
      setItems([]);
      setMacroPlan(null);
    }
  }

  async function handleFetchURL() {
    if (!url) return;
    try {
      const res = await fetch(url, { method: "GET" });
      if (!res.ok) throw new Error(`Failed to fetch (${res.status})`);
      const text = await res.text();
      setRawName(url.split("/").pop() || "remote.txt");
      setRawText(text);
      runDetection(text, url);
    } catch (e) {
      reportError(e);
    }
  }

  function handlePasteDetect() {
    if (!rawText.trim()) return;
    runDetection(rawText, rawName || "pasted.txt");
  }

  function applyManualKind(kind) {
    setManualKind(kind);
    if (!rawText.trim()) return;
    // re-parse according to manual choice
    const forced = detectFormat(rawText, rawName || "manual");
    // reuse parsed data but change path
    if (kind === "recipes") {
      if (forced.format === "csv" && forced.parsed) {
        setRecipes(normalizeRecipes(forced.parsed));
      } else {
        // try JSON parse fallback
        try {
          const json = JSON.parse(rawText);
          setRecipes(normalizeRecipes(json));
        } catch {
          // minimal fallback: try line-split as ingredients
          setRecipes(
            rawText
              .split(/\n+/)
              .filter(Boolean)
              .map((line) => ({ id: uid(), title: line.trim(), ingredients: [], steps: [], tags: [] }))
          );
        }
      }
      setItems([]);
      setMacroPlan(null);
    } else if (kind === "inventory" || kind === "grocery") {
      if (forced.format === "csv" && forced.parsed) {
        setItems(normalizeItems(forced.parsed));
      } else {
        try {
          const json = JSON.parse(rawText);
          setItems(normalizeItems(json));
        } catch {
          setItems(
            rawText
              .split(/\n+/)
              .filter(Boolean)
              .map((line) => ({ id: uid(), name: line.trim(), qty: 1, unit: "" }))
          );
        }
      }
      setRecipes([]);
      setMacroPlan(null);
    } else if (kind === "macroPlan") {
      try {
        const json = JSON.parse(rawText);
        setMacroPlan(normalizeMacroPlan(json));
      } catch {
        setMacroPlan(null);
        reportError(new Error("Macro plan must be valid JSON."));
      }
      setRecipes([]);
      setItems([]);
    }
  }

  function dispatchEvent(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (e) {
      // ignore
    }
  }

  function handleApply() {
    const payload = {
      recipes,
      items,
      macroPlan,
      routes: {
        routeRecipesToLibrary,
        routeItemsToInventory,
        alsoQueueBatch,
        mergeGroceryList,
        applyMacroPlan,
      },
      source: { name: rawName, url: url || null, detected: detected?.kind || manualKind || "unknown" },
      timestamp: new Date().toISOString(),
    };

    // 1) dispatch events for decoupled modules
    if (recipes.length && routeRecipesToLibrary) {
      dispatchEvent("suka:recipesImported", { recipes });
    }
    if (items.length && routeItemsToInventory) {
      dispatchEvent("suka:inventoryUpsert", { items });
    }
    if (items.length && mergeGroceryList) {
      dispatchEvent("suka:groceryListMerge", { items });
    }
    if (recipes.length && alsoQueueBatch) {
      dispatchEvent("suka:batchQueueAdd", { recipeIds: recipes.map((r) => r.id), recipes });
    }
    if (macroPlan && applyMacroPlan) {
      dispatchEvent("suka:macroPlanApplied", { plan: macroPlan });
    }

    // 2) optional callback to directly integrate with stores/agents
    if (typeof onApply === "function") onApply(payload);

    // 3) minimal user feedback
    alert("Import applied. Connected modules have been notified.");
  }

  /* ------------------------- UI ------------------------- */

  const dropHandlers = {
    onDragOver: (e) => e.preventDefault(),
    onDrop: (e) => {
      e.preventDefault();
      const files = e.dataTransfer.files;
      handleFiles(files);
    },
  };

  const detectedLabel = useMemo(() => {
    if (!detected) return null;
    const k = detected.kind || manualKind || "unknown";
    const f = detected.format || "unknown";
    return `${k} (${f})`;
  }, [detected, manualKind]);

  return (
    <div className={`${card} max-w-5xl mx-auto`}>
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="text-2xl font-extrabold tracking-tight">Nutrition Import Bridge</h2>
        <div className="flex gap-2">
          <button
            className={`${btnBase}`}
            onClick={() => {
              // Clear session but keep UI
              setRecipes([]);
              setItems([]);
              setMacroPlan(null);
              setDetected(null);
              setManualKind(null);
            }}
          >
            Clear Preview
          </button>
          <button className={`${btnBase} bg-indigo-600 text-white border-indigo-700`} onClick={handleApply}>
            Apply Import
          </button>
        </div>
      </div>

      {/* Import methods */}
      <div className="grid md:grid-cols-3 gap-4 mb-6">
        {/* Upload */}
        <div className={smallCard}>
          <div className="font-semibold mb-2">Upload File (CSV/JSON)</div>
          <div
            className="rounded-xl border border-dashed p-6 text-center cursor-pointer bg-slate-50"
            {...dropHandlers}
            onClick={() => fileInputRef.current?.click()}
            title="Click or drop a file"
          >
            <div className="mb-1">Drop file here</div>
            <div className="text-xs text-slate-600">or click to choose</div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.json,.txt"
              className="hidden"
              onChange={(e) => handleFiles(e.target.files)}
            />
          </div>
          {rawName ? <div className="mt-2 text-xs text-slate-600">Loaded: {rawName}</div> : null}
        </div>

        {/* Paste */}
        <div className={smallCard}>
          <div className="font-semibold mb-2">Paste (CSV or JSON)</div>
          <textarea
            className="w-full h-36 rounded-xl border px-3 py-2 text-sm"
            placeholder='Paste CSV or JSON here. Examples:
[{"title":"Meal","ingredients":["Eggs","Millet"],"steps":["Cook"]}]'
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
          />
          <div className="flex items-center gap-2 mt-2">
            <input
              type="text"
              className="flex-1 rounded-xl border px-3 py-2 text-sm"
              placeholder="Optional name (e.g., pasted.json)"
              value={rawName}
              onChange={(e) => setRawName(e.target.value)}
            />
            <button className={btnBase} onClick={handlePasteDetect}>
              Detect
            </button>
          </div>
        </div>

        {/* URL */}
        <div className={smallCard}>
          <div className="font-semibold mb-2">Fetch from URL</div>
          <input
            type="text"
            className="w-full rounded-xl border px-3 py-2 text-sm"
            placeholder="https://example.com/data.json or .csv"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className={`${btnBase} mt-2 w-full`} onClick={handleFetchURL}>
            Fetch
          </button>
          <div className="text-xs text-slate-600 mt-2">
            Must allow CORS. For private files, download and use Upload/Paste.
          </div>
        </div>
      </div>

      {/* Detection + Manual override */}
      <div className={`${smallCard} mb-6`}>
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold">Detected Format</div>
            <div className="text-sm text-slate-700">{detectedLabel || "—"}</div>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-sm">Manual override:</div>
            <select
              className="rounded-xl border px-2 py-1"
              value={manualKind || ""}
              onChange={(e) => applyManualKind(e.target.value || null)}
            >
              <option value="">Auto</option>
              <option value="recipes">Recipes</option>
              <option value="inventory">Inventory</option>
              <option value="grocery">Grocery List</option>
              <option value="macroPlan">Macro Plan</option>
            </select>
          </div>
        </div>
      </div>

      {/* Preview */}
      <div className="grid md:grid-cols-2 gap-4 mb-6">
        {/* Recipes preview */}
        <div className={smallCard}>
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">Recipes Preview</div>
            <label className="text-sm inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={routeRecipesToLibrary}
                onChange={(e) => setRouteRecipesToLibrary(e.target.checked)}
              />
              <span>Add to Recipe Library</span>
            </label>
          </div>
          {recipes?.length ? (
            <div className="space-y-3 max-h-72 overflow-auto pr-1">
              {recipes.slice(0, 25).map((r) => (
                <div key={r.id} className="p-3 border rounded-xl">
                  <div className="font-medium">{r.title}</div>
                  <div className="text-xs text-slate-600">
                    {r.tags?.length ? `Tags: ${r.tags.join(", ")}` : "No tags"}
                  </div>
                  <div className="mt-1 text-sm">
                    <span className="font-semibold">Ingredients:</span>{" "}
                    {r.ingredients?.slice(0, 5).join("; ")}
                    {r.ingredients?.length > 5 ? " …" : ""}
                  </div>
                  {r.steps?.length ? (
                    <div className="mt-1 text-xs text-slate-700">
                      <span className="font-semibold">Steps:</span> {r.steps.slice(0, 3).join(" | ")}
                      {r.steps.length > 3 ? " …" : ""}
                    </div>
                  ) : null}
                </div>
              ))}
              {recipes.length > 25 ? (
                <div className="text-xs text-slate-600">+ {recipes.length - 25} more…</div>
              ) : null}
            </div>
          ) : (
            <div className="text-sm text-slate-600">No recipes detected.</div>
          )}

          {recipes?.length ? (
            <label className="mt-3 inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={alsoQueueBatch}
                onChange={(e) => setAlsoQueueBatch(e.target.checked)}
              />
              <span>Also add to Batch Session queue</span>
            </label>
          ) : null}
        </div>

        {/* Items/Grocery preview */}
        <div className={smallCard}>
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">Inventory / Grocery Preview</div>
            <div className="flex items-center gap-4">
              <label className="text-sm inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={routeItemsToInventory}
                  onChange={(e) => setRouteItemsToInventory(e.target.checked)}
                />
                <span>Sync to Inventory</span>
              </label>
              <label className="text-sm inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={mergeGroceryList}
                  onChange={(e) => setMergeGroceryList(e.target.checked)}
                />
                <span>Merge into Grocery List</span>
              </label>
            </div>
          </div>
          {items?.length ? (
            <div className="space-y-2 max-h-72 overflow-auto pr-1">
              {items.slice(0, 40).map((it) => (
                <div key={it.id} className="p-2 border rounded-lg text-sm flex items-center justify-between">
                  <div className="flex-1">
                    <div className="font-medium">{it.name}</div>
                    <div className="text-xs text-slate-600">
                      {it.qty} {it.unit} {it.location ? `• ${it.location}` : ""}{" "}
                      {it.category ? `• ${it.category}` : ""}
                    </div>
                  </div>
                </div>
              ))}
              {items.length > 40 ? (
                <div className="text-xs text-slate-600">+ {items.length - 40} more…</div>
              ) : null}
            </div>
          ) : (
            <div className="text-sm text-slate-600">No items detected.</div>
          )}
        </div>
      </div>

      {/* Macro Plan preview */}
      <div className={`${smallCard} mb-6`}>
        <div className="flex items-center justify-between">
          <div className="font-semibold">Macro Plan Preview</div>
          <label className="text-sm inline-flex items-center gap-2">
            <input
              type="checkbox"
              checked={applyMacroPlan}
              onChange={(e) => setApplyMacroPlan(e.target.checked)}
            />
            <span>Apply Macro Plan</span>
          </label>
        </div>
        {macroPlan ? (
          <div className="mt-2 grid md:grid-cols-3 gap-4">
            <div className="p-3 border rounded-xl">
              <div className="text-sm">Calories</div>
              <div className="text-xl font-bold">{macroPlan.calories}</div>
            </div>
            <div className="p-3 border rounded-xl">
              <div className="text-sm">Percents</div>
              <div className="text-sm">
                P {round0(macroPlan.macrosPct.protein)}% • F {round0(macroPlan.macrosPct.fat)}% • C{" "}
                {round0(macroPlan.macrosPct.carbs)}%
              </div>
            </div>
            <div className="p-3 border rounded-xl">
              <div className="text-sm">Grams / day</div>
              <div className="text-sm">
                P {round0(macroPlan.macrosG.protein)}g • F {round0(macroPlan.macrosG.fat)}g • C{" "}
                {round0(macroPlan.macrosG.carbs)}g
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm text-slate-600">No macro plan detected.</div>
        )}
        <div className="mt-2 text-xs text-slate-600">
          Tip: You can export a plan from the Macro Percent Calculator and import it here to seed the Meal Planner.
        </div>
      </div>

      {/* Footer actions */}
      <div className="flex flex-wrap gap-2">
        <button className={`${btnBase} bg-indigo-600 text-white border-indigo-700`} onClick={handleApply}>
          Apply Import
        </button>
        <a href="/tier2/household/meals" className={btnBase}>
          Open Meals Dashboard
        </a>
        <a href="/tier2/household/batch" className={btnBase}>
          Open Batch Session Planner
        </a>
        <a href="/tier2/household/inventory" className={btnBase}>
          Open Inventory
        </a>
      </div>
    </div>
  );
}
