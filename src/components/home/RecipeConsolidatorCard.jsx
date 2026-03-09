// src/components/home/RecipeConsolidatorCard.jsx
import React, { useMemo, useState, useEffect } from "react";
import useRecipeStore from "@/store/RecipeStore";
import { callLLM } from "@/agents/base/AgentCore";
import { recipeFromUrl } from "@/services/ingest/recipeFromUrl";

// (kept for persistence helpers)
import { getSavedUnitSystem } from "@/components/UnitSystemToggle";
import { UnitSystem, convertTextLine } from "@/utils/units";

/* ---------- helpers ---------- */
function upsertRecipe(recipe) {
  const api = useRecipeStore.getState?.() || {};
  if (typeof api.upsertRecipe === "function") return api.upsertRecipe(recipe);
  if (typeof api.addRecipe === "function") return api.addRecipe(recipe);
  useRecipeStore.setState((s) => {
    const existing = (s.recipes || []).filter((r) => r.id !== recipe.id);
    return { ...s, recipes: [...existing, recipe] };
  });
}
function convertMarkdown(md, toSystem) {
  if (!md) return md;
  return md.split(/\r?\n/).map((ln) => convertTextLine(ln, toSystem)).join("\n");
}
const parseManualIngredients = (text) =>
  text.split(/\r?\n/).map((ln) => ln.trim()).filter(Boolean).map((raw, i) => ({ id: `m${i}`, raw, name: raw }));

/* ---------- inline unit toggle (button-styled) ---------- */
function InlineUnitToggle({ value, onChange }) {
  const isMetric = value === UnitSystem.METRIC;
  const next = isMetric ? UnitSystem.STANDARD : UnitSystem.METRIC;
  const label = isMetric ? "Metric — click → Standard (US)" : "Standard (US) — click → Metric";
  return (
    <button type="button" className="btn subtle" onClick={() => onChange(next)} title="Toggle unit system">
      {label}
    </button>
  );
}

/* ---------- component ---------- */
export default function RecipeConsolidatorCard() {
  const recipes = useRecipeStore((s) => s.recipes || []);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState([]);
  const [url, setUrl] = useState("");
  const [showManual, setShowManual] = useState(false);
  const [mName, setMName] = useState("");
  const [mIngr, setMIngr] = useState("");
  const [mInstr, setMInstr] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");

  // unit preference
  const [unitSystem, setUnitSystem] = useState(UnitSystem.STANDARD);
  useEffect(() => { setUnitSystem(getSavedUnitSystem()); }, []);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return !q ? recipes : recipes.filter((r) => r.name?.toLowerCase().includes(q));
  }, [recipes, query]);

  const toggle = (id) => setChosen((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const openFull = () =>
    window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "RecipeConsolidator", params: { selectedIds: chosen } } }));

  async function handleAddUrl() {
    if (!url) return;
    setBusy(true);
    try {
      const rec = await recipeFromUrl(url);
      if (rec?.id) {
        upsertRecipe(rec);
        setChosen((prev) => (prev.includes(rec.id) ? prev : [...prev, rec.id]));
      }
      setUrl("");
      consolidate(true);
    } finally { setBusy(false); }
  }

  async function handleAddManual() {
    if (!mName.trim()) return;
    const rec = {
      id: `manual_${Date.now()}`,
      name: mName.trim(),
      url: "",
      ingredients: parseManualIngredients(mIngr),
      instructions: mInstr || "",
      tags: ["manual"],
    };
    upsertRecipe(rec);
    setChosen((prev) => [...new Set([...prev, rec.id])]);
    setMName(""); setMIngr(""); setMInstr("");
    setShowManual(false);
    consolidate(true);
  }

  async function consolidate(previewOnly = false) {
    if (!chosen.length) return;
    setBusy(true);
    try {
      const selected = recipes.filter((r) => chosen.includes(r.id));
      const condensed = selected.map((r) => ({
        id: r.id, name: r.name, ingredients: r.ingredients, instructions: r.instructions, tags: r.tags || [],
      }));

      const UNIT_SYSTEM_HINT =
        unitSystem === UnitSystem.METRIC ? "METRIC (g, ml, cm, °C)" : "US STANDARD (lb/oz, tsp/tbsp/cup/qt, in, °F)";

      const prompt = `
You are a professional kitchen assistant.

Consolidate the following ${condensed.length} recipes into ONE efficient cooking session.
**Use this unit system consistently throughout**: ${UNIT_SYSTEM_HINT}
- Convert all weights/volumes/lengths/oven temperatures into the unit system above.
- Prefer kitchen-friendly, readable numbers.

Recipes (JSON):
${JSON.stringify(condensed, null, 2)}

Return markdown with:
- Consolidated ingredient list (merged quantities; use the selected unit system)
- Timeline with parallelizable steps
- Visual doneness/texture cues
- Cleanup batching
- Missing-ingredient swaps
- Labels for storage (name, date, reheat)
`;
      const res = await callLLM(prompt, { model: "gpt-4", temperature: 0.3, max_tokens: 1600 });
      const rawMd = typeof res === "string" ? res : JSON.stringify(res, null, 2);
      const md = convertMarkdown(rawMd, unitSystem === UnitSystem.METRIC ? UnitSystem.METRIC : UnitSystem.STANDARD);
      setPreview(md);

      if (!previewOnly) {
        try {
          sessionStorage.setItem("suka.consolidation", JSON.stringify({
            markdown: md, selectedIds: chosen, ts: Date.now(), unitSystem,
          }));
        } catch {}
        window.dispatchEvent(new CustomEvent("ui:navigate", {
          detail: { route: "RecipeConsolidationResult", params: { selectedIds: chosen } },
        }));
      }
    } finally { setBusy(false); }
  }

  return (
    <div className="card rc-scope">
      {/* SCOPED OVERRIDES so inputs look like elsewhere (no black UA borders) */}
      <style>{`
        .rc-scope .control{
          display:block !important;
          width:100% !important;
          padding:10px 14px !important;
          border-radius:12px !important;
          background:#fff !important;
          color:var(--ink) !important;
          border:1px solid var(--line) !important;
          box-shadow: var(--btn-shadow-up) !important;
        }
        .rc-scope .control:focus{
          outline: none !important;
          border-color: color-mix(in oklab, var(--brand) 45%, var(--line)) !important;
          box-shadow: 0 0 0 3px color-mix(in oklab, var(--brand) 20%, transparent) !important;
        }
        .rc-scope .control.control--select{
          appearance:none !important;
          -webkit-appearance:none !important;
          -moz-appearance:none !important;
          padding-right:2.25rem !important;
          background-color:#fff !important;
        }
        .rc-scope input[type="search"]{
          -webkit-appearance: none !important;
          outline: none !important;
          border:1px solid var(--line) !important;
          border-radius:12px !important;
        }
        .rc-scope input[type="search"]::-webkit-search-decoration,
        .rc-scope input[type="search"]::-webkit-search-cancel-button,
        .rc-scope input[type="search"]::-webkit-search-results-button,
        .rc-scope input[type="search"]::-webkit-search-results-decoration { display:none !important; }
        .rc-scope .control.control--textarea{ resize: vertical !important; }
      `}</style>

      {/* Header */}
      <div className="mb-2 flex items-start justify-between gap-3">
        <div>
          <h3 className="subtitle" style={{ fontWeight: 700 }}>Recipe Consolidator</h3>
          <p className="text-sm text-stone-600">
            Add recipes, select them, and I’ll merge the ingredients + build a single cooking session.
          </p>
        </div>
        <InlineUnitToggle value={unitSystem} onChange={setUnitSystem} />
      </div>

      {/* Add by URL */}
      <div className="mb-2" style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
        <input
          className="control"
          placeholder="Paste a recipe URL…"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button className="btn subtle" onClick={handleAddUrl} disabled={!url || busy}>
          Add by URL
        </button>
      </div>

      {/* Add manually */}
      <div className="mb-2">
        <button className="btn subtle" onClick={() => setShowManual((v) => !v)}>
          {showManual ? "Hide manual form" : "Add manually"}
        </button>
        {showManual && (
          <div className="mt-2" style={{ display: "grid", gap: 8 }}>
            <input
              className="control"
              placeholder="Recipe name"
              value={mName}
              onChange={(e) => setMName(e.target.value)}
            />
            <textarea
              className="control control--textarea"
              rows={4}
              placeholder="Ingredients (one per line)"
              value={mIngr}
              onChange={(e) => setMIngr(e.target.value)}
            />
            <textarea
              className="control control--textarea"
              rows={4}
              placeholder="Instructions (optional)"
              value={mInstr}
              onChange={(e) => setMInstr(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary" onClick={handleAddManual} disabled={!mName}>
                Save recipe
              </button>
              <button className="btn" onClick={() => setShowManual(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Search & pick */}
      <input
        className="control"
        placeholder="Search recipes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        type="search"
      />
      <div className="mt-2" style={{ maxHeight: 160, overflow: "auto", display: "grid", gap: 8 }}>
        {list.slice(0, 12).map((r) => (
          <label
            key={r.id}
            className="control"
            style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
          >
            <input type="checkbox" checked={chosen.includes(r.id)} onChange={() => toggle(r.id)} />
            <span className="truncate">{r.name}</span>
          </label>
        ))}
        {!recipes.length && <div className="text-sm text-stone-500">No recipes yet.</div>}
      </div>

      {/* Actions */}
      <div className="mt-3" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn primary" onClick={() => consolidate(false)} disabled={!chosen.length || busy}>
          {busy ? "Consolidating…" : "Consolidate Selected"}
        </button>
        <button className="btn" onClick={openFull} disabled={!chosen.length}>
          Open Full View
        </button>
        <span className="text-xs text-stone-500">
          {chosen.length} selected • Units: {unitSystem === UnitSystem.METRIC ? "Metric" : "Standard (US)"}
        </span>
      </div>

      {/* Live preview */}
      {!!preview && (
        <article className="card" style={{ marginTop: 8, whiteSpace: "pre-wrap" }}>
          {preview}
        </article>
      )}
    </div>
  );
}
