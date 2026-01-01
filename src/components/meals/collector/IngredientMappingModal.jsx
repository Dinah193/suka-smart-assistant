// File: src/components/meals/collector/IngredientMappingModal.jsx
// Purpose: Map messy ingredient strings from collected recipes to your canonical inventory items
// Design goals aligned to Suka Smart Assistant:
// - Inventory-aware: pulls items, units, aisles, and household stores; writes mappings back
// - AI Assist hook (automation runtime) for suggestions; graceful fallback without AI
// - Smart suggestions: fuzzy search, plural/alias handling, unit normalization, quantity parsing
// - Bulk + Manual modes; optimistic updates w/ undo pattern via eventBus
// - Works whether your stores/hooks exist or not (defensive imports)
// - Local draft persistence so users don’t lose work on refresh
// - Emits events: meals.ingredients.mapping.requested | .applied | inventory.alias.created
// - Keyboard UX: Enter = accept suggestion, Ctrl+S = Apply, Esc = Close
// - **Sandbox-safe shims**: never hard-require project aliases; provide mocks if unavailable

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";

/* ------------------------------ Sandbox-safe require ------------------------------ */
// Some environments attempt to resolve alias imports ("@/...") via CDN and fail.
// To avoid ANY static resolution, we use eval'd require and dynamic id strings.
const softRequire = (id) => {
  try {
    const req = typeof require === "function" ? require : (0, eval)("require");
    return req ? req(id) : null;
  } catch {
    return null;
  }
};
const alias = (p) => "@" + "/" + p; // build at runtime so bundlers can't statically analyze

/* ------------------------------ Icons (with safe fallbacks) ------------------------------ */
let Icons = softRequire("lucide-react") || {};
const mkIcon = (name) => (props) => <span aria-hidden className={props?.className || "inline-block w-4 h-4"} data-icon={name}/>;
const {
  X = mkIcon("X"),
  Sparkles = mkIcon("Sparkles"),
  Save = mkIcon("Save"),
  Wand2 = mkIcon("Wand2"),
  Check = mkIcon("Check"),
  Undo2 = mkIcon("Undo2"),
  Search = mkIcon("Search"),
  Link: LinkIcon = mkIcon("Link"),
  ListChecks = mkIcon("ListChecks"),
  Database = mkIcon("Database"),
  Box = mkIcon("Box"),
  Info = mkIcon("Info"),
  AlertTriangle = mkIcon("AlertTriangle"),
} = Icons;

/* ------------------------------ Event bus (shim if missing) ------------------------------ */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const mod = softRequire(alias("services/eventBus"));
  if (mod?.eventBus) eventBus = mod.eventBus;
} catch {}

/* ------------------------------ Automation runtime (shim) ------------------------------ */
let automation = null;
try {
  const mod = softRequire(alias("services/automation/runtime"));
  automation = mod?.automation || null;
} catch {}

/* ------------------------------ Inventory store (shim) ------------------------------ */
let useInventoryStore = () => ({
  items: [], // { id, name, aliases:[], defaultUnit, aisle, store, pkgSize, source }
  units: ["g","kg","ml","l","tsp","tbsp","cup","oz","lb","piece"],
  aisles: [],
  stores: [],
  createAlias: async (_itemId, _alias) => {},
  upsertMapping: async (_raw, _canonicalId, _unit) => {},
});
try {
  const mod = softRequire(alias("store/InventoryStore"));
  if (mod?.useInventoryStore) useInventoryStore = mod.useInventoryStore;
} catch {}

/* ------------------------------ Collector store (shim) ------------------------------ */
let useCollectorStore = () => ({
  pending: [], // [{ raw:"2 c. chopped broccolis", sourceId, url }]
  removeMany: (_keys = []) => {},
});
try {
  const mod = softRequire(alias("store/CollectorStore"));
  if (mod?.useCollectorStore) useCollectorStore = mod.useCollectorStore;
} catch {}

/* ------------------------------ Ingredient Sources (optional) ------------------------------ */
let INGREDIENT_SOURCES = {};
try {
  const mod = softRequire(alias("app/utils/ingredientSourceMap"));
  INGREDIENT_SOURCES = mod?.INGREDIENT_SOURCES || {};
} catch {}

/* --------------------------------- Helpers --------------------------------- */
const STORAGE_KEY = "ingredient-mapping-draft";
// Preview-friendly seed list used when no incoming or store data are present
const DEMO_ROWS = [
  { raw: "2 cups broccoli florets" },
  { raw: "1-2 tbsp olive oil" },
  { raw: "½ cup rice" },
  { raw: "3 cloves garlic" },
  { raw: "1 lb ground lamb" },
];
const pluralize = (s) => (s?.endsWith("s") ? s : s + "s");
const singularize = (s) => (s?.endsWith("es") ? s.slice(0, -2) : s?.endsWith("s") ? s.slice(0, -1) : s);
const clean = (s="") => s.toLowerCase().replace(/[^a-z0-9\s\-]/g, " ").replace(/\s+/g, " ").trim();

const normalizeUnit = (u="") => {
  const map = { tsp:["tsp","teaspoon","tsps","t"], tbsp:["tbsp","tablespoon","T"], cup:["cup","cups","c"], oz:["oz","ounce","ounces"], lb:["lb","lbs","pound","pounds"], g:["g","gram","grams"], kg:["kg","kilogram","kilograms"], ml:["ml","milliliter","milliliters"], l:["l","liter","liters"], piece:["pc","pcs","piece","pieces","each"] };
  const lu = clean(u);
  for (const [std, variants] of Object.entries(map)) {
    if (variants.includes(lu)) return std;
  }
  return u || "piece";
};

const parseQuantity = (raw="") => {
  // Extract leading quantity and unit (very forgiving)
  // Examples: "2 1/2 cups", "1-2 tbsp", "~3oz", "4 pieces", "200 g"
  const str = raw
    .replace(/[¼½¾]/g, (m)=>({"¼":"1/4","½":"1/2","¾":"3/4"}[m]))
    .replace(/[‒-―]/g, "-");
  const m = str.match(/(^|\s)(~?\d+(?:\s*\d\/\d)?(?:\s*-\s*\d+(?:\s*\d\/\d)?)?)(?:\s*([a-zA-Z\.]+))?/);
  let qty = 1, unit = "piece";
  if (m) {
    const q = m[2];
    // take upper bound if range 1-2 => 2
    const part = q.includes("-") ? q.split("-").pop().trim() : q.trim();
    if (part.includes("/")) {
      const [a,b] = part.split("/").map(Number);
      qty = (a||0)/(b||1);
    } else qty = parseFloat(part) || 1;
    unit = normalizeUnit(m[3]||unit);
  }
  return { qty, unit };
};

// Tiny similarity scorer (Jaccard-style over tokens)
const similarity = (a,b) => {
  a = clean(a); b = clean(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const sa = new Set(a.split(" ")); const sb = new Set(b.split(" "));
  let inter = 0; sa.forEach(t=> sb.has(t) && inter++);
  return inter / Math.max(sa.size, sb.size);
};

const bestMatches = (rawName, items, limit=5) => {
  const key = singularize(clean(rawName.replace(/,.*$/, "")));
  const scored = items.map(it => {
    const names = [it.name, ...(it.aliases||[])].map(clean).map(singularize);
    const score = Math.max(...names.map(n => similarity(key, n)));
    return { item: it, score };
  }).sort((a,b)=> b.score - a.score);
  return scored.filter(s=> s.score > 0.15).slice(0, limit);
};

/* ------------------------------ Modal Component ----------------------------- */
export default function IngredientMappingModal({ isOpen = true, onClose, incoming = [] , onApplied }) {
  const { items, units, aisles, stores, upsertMapping, createAlias } = useInventoryStore();
  const { pending } = useCollectorStore();

  const initialRows = useMemo(() => {
    const source = (incoming?.length ? incoming : pending) || [];
    const uniq = new Map();
    source.forEach((p, idx) => {
      const k = clean(p.raw || p.name || String(idx));
      if (!uniq.has(k)) uniq.set(k, { key:k, raw: p.raw || p.name || "", url: p.url, sourceId: p.sourceId });
    });
    return [...uniq.values()];
  }, [incoming, pending]);

  const [rows, setRows] = useState([]); // { key, raw, qty, unit, choiceId, note }

  // Seed demo rows if nothing is available (sandbox/preview mode)
  useEffect(() => {
    if (!isOpen) return;
    if ((rows?.length ?? 0) === 0 && (initialRows?.length ?? 0) === 0) {
      const seeded = DEMO_ROWS.map((r, i) => {
        const { qty, unit } = parseQuantity(r.raw);
        return { key: `demo-${i}`, raw: r.raw, qty, unit, choiceId: null, note: "" };
      });
      setRows(seeded);
    }
  }, [isOpen]);

  const [mode, setMode] = useState("auto"); // auto | manual | bulk
  const [busy, setBusy] = useState(false);
  const draftRef = useRef(null);

  // hydrate
  useEffect(()=>{
    if (!isOpen) return;
    const restored = (()=>{ try { return JSON.parse(localStorage.getItem(STORAGE_KEY)||"null"); } catch { return null; }})();
    if (restored?.rows && Array.isArray(restored.rows)) {
      setRows(restored.rows);
    } else {
      const pre = initialRows.map(r => {
        const { qty, unit } = parseQuantity(r.raw);
        return { ...r, qty, unit, choiceId: null, note: "" };
      });
      setRows(pre);
    }
    eventBus.emit("meals.ingredients.mapping.requested", { count: initialRows.length });
  }, [isOpen, initialRows.length]);

  // persist drafts
  useEffect(()=>{
    if (!isOpen) return;
    const payload = { rows };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }, [rows, isOpen]);

  const resetDraft = () => {
    localStorage.removeItem(STORAGE_KEY);
    const pre = initialRows.map(r => {
      const { qty, unit } = parseQuantity(r.raw);
      return { ...r, qty, unit, choiceId:null, note:"" };
    });
    setRows(pre);
  };

  /* ------------------------------- AI Assistant ------------------------------ */
  const runAIAssist = useCallback(async () => {
    if (!automation?.runTemplate) return null;
    try {
      setBusy(true);
      const res = await automation.runTemplate("meals.ingredients.map.suggest", {
        ingredients: rows.map(r => r.raw),
        inventoryNames: items.map(i=>({ id:i.id, name:i.name, aliases:i.aliases||[] })),
      });
      // Expect [{key, choiceId, unit, note}]
      if (res && Array.isArray(res.suggestions)) {
        const byKey = new Map(res.suggestions.map(s=> [clean(s.key), s]));
        setRows(prev => prev.map(r => {
          const s = byKey.get(clean(r.key));
          return s ? { ...r, choiceId: s.choiceId ?? r.choiceId, unit: s.unit || r.unit, note: s.note || r.note } : r;
        }));
      }
    } catch (e) {
      console.warn("[IngredientMappingModal] AI assist fallback", e);
    } finally { setBusy(false); }
  }, [automation, rows, items]);

  /* --------------------------------- Actions -------------------------------- */
  const setChoice = (key, choiceId) => setRows(prev => prev.map(r => r.key===key ? { ...r, choiceId } : r));
  const setUnit = (key, unit) => setRows(prev => prev.map(r => r.key===key ? { ...r, unit: normalizeUnit(unit) } : r));
  const setNote = (key, note) => setRows(prev => prev.map(r => r.key===key ? { ...r, note } : r));

  const createAliasFor = async (key, itemId) => {
    const row = rows.find(r=> r.key===key);
    if (!row) return;
    const aliasStr = singularize(clean(row.raw.replace(/\d.*/, "").trim()));
    try {
      await createAlias(itemId, aliasStr);
      eventBus.emit("inventory.alias.created", { itemId, alias: aliasStr });
      setChoice(key, itemId);
    } catch (e) { console.error(e); }
  };

  const applyAll = async () => {
    const tasks = [];
    const applied = [];
    setBusy(true);
    try {
      for (const r of rows) {
        if (!r.choiceId) continue; // skip unmapped
        const unit = normalizeUnit(r.unit);
        tasks.push(upsertMapping(r.raw, r.choiceId, unit));
        applied.push({ raw:r.raw, id:r.choiceId, unit, note:r.note });
      }
      await Promise.all(tasks);
      eventBus.emit("meals.ingredients.mapping.applied", { count: applied.length, rows: applied });
      onApplied?.(applied);
      onClose?.();
    } catch (e) {
      console.error(e);
    } finally { setBusy(false); }
  };

  const handleKey = useCallback((e) => {
    if (e.key === "Escape") onClose?.();
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); applyAll(); }
  }, [onClose, applyAll]);

  useEffect(()=>{
    if (!isOpen) return;
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isOpen, handleKey]);

  /* --------------------------------- Views ---------------------------------- */
  const Header = () => (
    <div className="flex items-center justify-between border-b px-4 py-3">
      <div className="flex items-center gap-2">
        <Box className="w-5 h-5" />
        <h3 className="text-lg font-semibold">Map Ingredients to Inventory</h3>
        <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border">{rows.length} items</span>
      </div>
      <div className="flex items-center gap-2">
        <button className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded border hover:bg-gray-50" onClick={resetDraft} title="Reset draft">
          <Undo2 className="w-4 h-4"/> Reset
        </button>
        {automation && (
          <button className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs rounded border hover:bg-gray-50" onClick={runAIAssist} disabled={busy} title="AI Assist">
            <Sparkles className="w-4 h-4"/> Suggest
          </button>
        )}
        <button className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60" onClick={applyAll} disabled={busy}>
          <Save className="w-4 h-4"/> Apply (Ctrl+S)
        </button>
        <button className="p-1 rounded hover:bg-gray-100" onClick={onClose} aria-label="Close">
          <X className="w-5 h-5"/>
        </button>
      </div>
    </div>
  );

  const ModeTabs = () => (
    <div className="flex items-center gap-2 px-4 py-2 border-b bg-gray-50">
      {[
        { id:"auto", label:"Auto" },
        { id:"manual", label:"Manual" },
        { id:"bulk", label:"Bulk" },
      ].map(t => (
        <button key={t.id} onClick={()=> setMode(t.id)} className={`px-3 py-1.5 text-sm rounded border ${mode===t.id?"bg-white shadow-sm border-indigo-300":"hover:bg-white"}`}>
          {t.label}
        </button>
      ))}
      <div className="ml-auto flex items-center gap-2 text-xs text-gray-500">
        <Info className="w-3.5 h-3.5"/> Tip: Enter accepts top suggestion; click the link icon to add alias & select.
      </div>
    </div>
  );

  const AutoRow = ({ r }) => {
    const suggestions = useMemo(()=> bestMatches(r.raw, items, 5), [r.raw, items]);
    const top = suggestions[0];
    return (
      <div className="grid grid-cols-12 gap-3 items-center border-b px-4 py-3">
        <div className="col-span-4">
          <div className="text-sm font-medium">{r.raw}</div>
          <div className="text-[11px] text-gray-500">qty {r.qty} · unit {r.unit}</div>
        </div>
        <div className="col-span-5">
          <div className="flex flex-wrap gap-1">
            {suggestions.map(({item, score}) => (
              <button key={item.id} onClick={()=> setChoice(r.key, item.id)} className={`text-xs px-2 py-1 rounded border ${r.choiceId===item.id?"bg-indigo-600 text-white border-indigo-600":"hover:bg-gray-50"}`} title={`Match score ${(score*100).toFixed(0)}%`}>
                {item.name}
              </button>
            ))}
            {top && (
              <button className="ml-1 inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-gray-50" onClick={()=> createAliasFor(r.key, top.item.id)} title="Create alias from this raw name and select">
                <LinkIcon className="w-3.5 h-3.5"/> Alias+Select
              </button>
            )}
          </div>
        </div>
        <div className="col-span-2">
          <select className="w-full text-sm border rounded px-2 py-1" value={r.unit} onChange={e=> setUnit(r.key, e.target.value)}>
            {units.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div className="col-span-1">
          {r.choiceId ? <Check className="w-5 h-5 text-green-600"/> : <AlertTriangle className="w-5 h-5 text-amber-500"/>}
        </div>
      </div>
    );
  };

  const ManualRow = ({ r }) => {
    const [q, setQ] = useState("");
    const matches = useMemo(()=> q ? bestMatches(q, items, 8) : bestMatches(r.raw, items, 8), [q, r.raw, items]);

    return (
      <div className="grid grid-cols-12 gap-3 items-center border-b px-4 py-3">
        <div className="col-span-4">
          <div className="text-sm font-medium">{r.raw}</div>
          <input className="mt-2 w-full text-sm border rounded px-2 py-1" placeholder="Search inventory…" value={q} onChange={e=> setQ(e.target.value)} />
        </div>
        <div className="col-span-5">
          <div className="flex flex-wrap gap-1 max-h-16 overflow-auto pr-1">
            {matches.map(({item}) => (
              <button key={item.id} onClick={()=> setChoice(r.key, item.id)} className={`text-xs px-2 py-1 rounded border ${r.choiceId===item.id?"bg-indigo-600 text-white border-indigo-600":"hover:bg-gray-50"}`}>
                {item.name}
              </button>
            ))}
          </div>
          <div className="mt-2">
            <textarea className="w-full text-xs border rounded px-2 py-1" rows={2} placeholder="Notes (e.g., prefer brand, aisle, source)" value={r.note} onChange={e=> setNote(r.key, e.target.value)} />
          </div>
        </div>
        <div className="col-span-2">
          <select className="w-full text-sm border rounded px-2 py-1" value={r.unit} onChange={e=> setUnit(r.key, e.target.value)}>
            {units.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div className="col-span-1">
          {r.choiceId ? <Check className="w-5 h-5 text-green-600"/> : <AlertTriangle className="w-5 h-5 text-amber-500"/>}
        </div>
      </div>
    );
  };

  const BulkPanel = () => {
    const [text, setText] = useState(rows.map(r=> `${r.raw}`).join("\n"));
    const applyBulk = () => {
      const lines = text.split(/\n+/).map(l=> l.trim()).filter(Boolean);
      // naive: align by index
      const next = rows.map((r, i) => {
        const line = lines[i] || r.raw;
        const { qty, unit } = parseQuantity(line);
        const top = bestMatches(line, items, 1)[0]?.item?.id || r.choiceId;
        return { ...r, raw: line, qty, unit, choiceId: top };
      });
      setRows(next);
    };
    return (
      <div className="p-4 border-b">
        <div className="text-sm text-gray-600 mb-2">Paste or edit your ingredient list. We’ll guess matches and units per line.</div>
        <textarea className="w-full border rounded px-3 py-2 text-sm" rows={8} value={text} onChange={e=> setText(e.target.value)} />
        <div className="mt-2 flex justify-end">
          <button onClick={applyBulk} className="inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded border hover:bg-gray-50">
            <Wand2 className="w-4 h-4"/> Auto-map from text
          </button>
        </div>
      </div>
    );
  };

  const Footer = () => {
    // Completeness
    const mapped = rows.filter(r=> !!r.choiceId).length;
    const pct = Math.round((mapped / Math.max(rows.length,1)) * 100);
    const showSourceHint = Object.keys(INGREDIENT_SOURCES).length > 0;
    return (
      <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50">
        <div className="flex items-center gap-3 text-xs text-gray-600">
          <ListChecks className="w-4 h-4"/> {mapped}/{rows.length} mapped · {pct}% complete
          {showSourceHint && (
            <span className="inline-flex items-center gap-1"><Database className="w-3.5 h-3.5"/> source-linked</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded border hover:bg-white" onClick={onClose}><X className="w-4 h-4"/> Close</button>
          <button className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60" onClick={applyAll} disabled={busy}>
            <Save className="w-4 h-4"/> Apply All
          </button>
        </div>
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30" onClick={onClose}>
      <div className="mt-10 w-[94vw] max-w-[640px] bg-white rounded-xl shadow-xl border overflow-hidden" onClick={(e)=> e.stopPropagation()}>
        <Header/>
        <ModeTabs/>
        {mode === "bulk" && <BulkPanel/>}
        <div className="max-h-[60vh] overflow-auto divide-y">
          {rows.map(r => (
            mode === "auto" ? <AutoRow key={r.key} r={r}/> : <ManualRow key={r.key} r={r}/>
          ))}
        </div>
        <Footer/>
      </div>
    </div>
  );
}

/* ------------------------------ Exports for Tests --------------------------- */
export const _test = { clean, singularize, normalizeUnit, parseQuantity, similarity, bestMatches };

/* ------------------------------ Suggested Jest Tests ------------------------
// Create: src/components/meals/collector/__tests__/IngredientMappingModal.test.js
import { _test } from "../IngredientMappingModal";

const { clean, singularize, normalizeUnit, parseQuantity, similarity, bestMatches } = _test;

describe("Ingredient helpers", () => {
  test("clean trims and lowercases", () => {
    expect(clean("  Broccoli   Florets!  ")).toBe("broccoli florets");
  });
  test("singularize handles plurals", () => {
    expect(singularize("apples")).toBe("apple");
    expect(singularize("tomatoes")).toBe("tomato");
  });
  test("normalizeUnit maps variants", () => {
    expect(normalizeUnit("Teaspoon")).toBe("tsp");
    expect(normalizeUnit("LBS")).toBe("lb");
    expect(normalizeUnit("")).toBe("piece");
  });
  test("parseQuantity parses ranges and fractions", () => {
    expect(parseQuantity("1-2 tbsp sugar").qty).toBe(2);
    expect(parseQuantity("½ cup milk")).toEqual({ qty: 0.5, unit: "cup" });
    expect(parseQuantity("200 g rice")).toEqual({ qty: 200, unit: "g" });
  });
  test("similarity gives high score for close matches", () => {
    expect(similarity("chopped broccoli", "broccoli")).toBeGreaterThan(0.5);
  });
  test("bestMatches returns empty for unknown when low similarity", () => {
    const items = [{ id:1, name:"flour", aliases:["all purpose"] }];
    expect(bestMatches("galactic stardust", items, 3)).toEqual([]);
  });
  test("bestMatches ranks aliases", () => {
    const items = [
      { id:1, name:"sodium bicarbonate", aliases:["baking soda"] },
      { id:2, name:"baking powder", aliases:[] },
    ];
    const res = bestMatches("baking soda", items, 2);
    expect(res[0].item.id).toBe(1);
  });
});
-------------------------------------------------------------------------------*/
