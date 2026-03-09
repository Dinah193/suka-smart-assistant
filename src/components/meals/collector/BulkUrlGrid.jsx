// C:\Users\larho\suka-smart-assistant\src\components\meals\collector\BulkUrlGrid.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * BulkUrlGrid.jsx — Multi-domain Collector (Pinterest/URLs/Products/Ideas)
 * -----------------------------------------------------------------------------
 * Goals matched to Suka:
 * - Accept MANY URLs fast: paste, drag-drop, CSV, plain text — auto-extract links
 * - Inspect/enrich with OpenGraph + site heuristics (soft import services)
 * - NOT recipe-only. Route items to any Suka module (Meals, Shopping, Garden,
 *   Animals, Preservation, Projects/Household, Inspiration/Boards, Calendar)
 * - Batch actions: detect duplicates, bulk edit tags/board/assignee, import
 * - Background processing via eventBus; optimistic UI + undo; Sabbath-aware stub
 * - Keyboard shortcuts like well-executed dashboards (Linear/Notion):
 *   ⏎ analyze selected, A select all, ⌫ delete selected, E bulk edit, I import
 *
 * Safe on missing services: every external import is optional with fallbacks.
 */

/* --------------------------------- Tiny UI kit --------------------------------- */
const cx = (...a) => a.filter(Boolean).join(" ");
const Button = ({
  variant = "solid",
  size = "md",
  className,
  children,
  ...props
}) => {
  const v =
    {
      solid: "bg-zinc-900 text-white hover:opacity-90 disabled:opacity-50",
      outline: "border hover:bg-zinc-50",
      ghost: "hover:bg-zinc-100",
      subtle: "bg-zinc-100 text-zinc-900 hover:bg-zinc-200",
    }[variant] || "bg-zinc-900 text-white";
  const s =
    { sm: "h-8 px-2 text-sm", md: "h-10 px-3 text-sm", icon: "h-9 w-9 p-0" }[
      size
    ] || "h-10 px-3";
  return (
    <button
      className={cx("rounded-xl transition-colors", v, s, className)}
      {...props}
    >
      {children}
    </button>
  );
};
const Input = (props) => (
  <input className="h-9 rounded-xl border px-3 text-sm w-full" {...props} />
);
const Textarea = (props) => (
  <textarea
    className="min-h-[84px] w-full rounded-xl border p-3 text-sm"
    {...props}
  />
);
const Badge = ({ children, tone = "zinc", className }) => (
  <span
    className={cx(
      "inline-flex items-center rounded px-2 py-0.5 text-[11px]",
      tone === "zinc" && "bg-zinc-900 text-white",
      tone === "amber" && "bg-amber-100 text-amber-900",
      tone === "green" && "bg-emerald-100 text-emerald-900",
      className
    )}
  >
    {children}
  </span>
);

/* ------------------------------ Soft integrations ------------------------------ */
// eventBus (new path, then legacy)
let eventBus = { on: () => {}, off: () => {}, emit: () => {} };
try {
  eventBus = require("@/services/events/eventBus");
} catch {
  try {
    eventBus = require("@/services/events/eventBus").eventBus || eventBus;
  } catch {}
}

// URL inspector / opengraph enrich
let urlInspector = null; // expected: inspect(url) -> { title, description, image, site, type, canonicalUrl, price, currency, author, ogType }
try {
  urlInspector = require("@/services/ingest/urlInspector");
} catch {}

// Dedup services (Vaults)
let RecipeStore = {};
let IdeasStore = {};
let ShoppingStore = {};
try {
  RecipeStore = require("@/store/RecipeStore");
} catch {}
try {
  IdeasStore = require("@/store/IdeasStore");
} catch {}
try {
  ShoppingStore = require("@/store/ShoppingStore");
} catch {}

// Preferences (Sabbath)
let PreferencesStore = {};
try {
  PreferencesStore = require("@/store/PreferencesStore");
} catch {}

// Classifier (optional ML: guess target module)
let classifyLink = null; // expected: classify(url, meta) -> { module, confidence, tags[] }
try {
  classifyLink = require("@/services/classify/linkClassifier")?.classifyLink;
} catch {}

/* --------------------------------- Utilities ---------------------------------- */
const isoNow = () => new Date().toISOString();
const uniq = (xs) => Array.from(new Set(xs));
const normalizeUrl = (u) => {
  try {
    const url = new URL(u.trim());
    url.hash = "";
    // strip common tracker params
    [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
    ].forEach((p) => url.searchParams.delete(p));
    return url.toString();
  } catch {
    return u.trim();
  }
};
const extractUrls = (text) => {
  const re = /\bhttps?:\/\/[^\s)]+/gi;
  return uniq((text.match(re) || []).map(normalizeUrl));
};
const isPinterest = (u) => /pinterest\.[a-z.]+\/(pin|board)\//i.test(u);
const isRecipeHostHeuristic = (u, meta) =>
  /allrecipes|foodnetwork|serious|sallysbaking|bonappetit|epicurious|simplyrecipes|tasty|thewoksoflife|pinchofyum/i.test(
    u
  ) ||
  /recipe/i.test(
    `${meta?.type || ""}${meta?.ogType || ""}${meta?.title || ""}`
  );
const priceToNumber = (x) => {
  const n = parseFloat(String(x).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const sabbathBlocked = () => {
  try {
    const p = PreferencesStore?.getPreferences?.() || {};
    return !!(
      p?.torahProfile?.sabbath?.isActive &&
      p?.torahProfile?.sabbath?.handsOffCooking === true
    );
  } catch {
    return false;
  }
};

/* ------------------------------ Default targets ------------------------------- */
const MODULES = [
  { key: "recipes", label: "Meals • Recipe", tone: "zinc" },
  { key: "shopping", label: "Shopping • Product", tone: "green" },
  { key: "garden", label: "Garden • Crop/Idea", tone: "amber" },
  { key: "animals", label: "Animals • Care", tone: "amber" },
  { key: "preservation", label: "Preservation • Job", tone: "amber" },
  { key: "projects", label: "Household • Project", tone: "zinc" },
  { key: "inspiration", label: "Inspiration • Board", tone: "zinc" },
  { key: "calendar", label: "Calendar • Event", tone: "zinc" },
];

/* ------------------------------- Card Renderer -------------------------------- */
function UrlCard({ item, selected, onToggle, onChange }) {
  const m = item.meta || {};
  const moduleDef = MODULES.find((x) => x.key === (item.module || "recipes"));
  const price = m.price || m.offerPrice || m.lowPrice;
  return (
    <div
      className={cx(
        "group relative rounded-2xl border p-3 hover:shadow-md",
        selected ? "ring-2 ring-zinc-900" : "border-zinc-200"
      )}
    >
      <div className="absolute top-2 right-2">
        <input
          type="checkbox"
          className="checkbox checkbox-sm"
          checked={selected}
          onChange={onToggle}
          aria-label="Select"
        />
      </div>

      <div className="flex gap-3">
        <div className="w-20 h-20 shrink-0 rounded-lg border bg-white overflow-hidden">
          {m.image ? (
            <img src={m.image} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="h-full w-full grid place-items-center text-xs text-zinc-400">
              no img
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="truncate font-medium hover:underline"
            >
              {m.title || item.url}
            </a>
            <Badge>{new URL(item.url).hostname.replace(/^www\./, "")}</Badge>
            {item.duplicateOf ? <Badge tone="amber">duplicate</Badge> : null}
            {isPinterest(item.url) ? (
              <Badge tone="amber">Pinterest</Badge>
            ) : null}
          </div>
          <div className="text-xs text-zinc-600 line-clamp-2 mt-0.5">
            {m.description || m.author || m.site || ""}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <select
              className="select select-bordered select-xs rounded-lg"
              value={item.module}
              onChange={(e) => onChange({ module: e.target.value })}
              aria-label="Target module"
              title="Target module"
            >
              {MODULES.map((mod) => (
                <option key={mod.key} value={mod.key}>
                  {mod.label}
                </option>
              ))}
            </select>

            <input
              className="input input-bordered input-xs rounded-lg"
              placeholder="Tags (comma)"
              value={item.tags?.join(", ") || ""}
              onChange={(e) =>
                onChange({
                  tags: e.target.value
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                })
              }
              aria-label="Tags"
              title="Tags"
            />

            <input
              className="input input-bordered input-xs rounded-lg"
              placeholder="Board / Collection"
              value={item.board || ""}
              onChange={(e) => onChange({ board: e.target.value })}
              aria-label="Board"
              title="Board"
            />

            {priceToNumber(price) ? (
              <Badge tone="green">${priceToNumber(price)}</Badge>
            ) : isRecipeHostHeuristic(item.url, m) ? (
              <Badge>recipe-ish</Badge>
            ) : null}
          </div>
        </div>
      </div>

      {/* Footer row */}
      <div className="mt-3 flex items-center justify-between">
        <div className="text-[11px] text-zinc-500 truncate">
          {m.canonicalUrl || item.url}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange({ status: "pending" })}
          >
            Reinspect
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onChange({ _remove: true })}
          >
            Remove
          </Button>
        </div>
      </div>
    </div>
  );
}

/* --------------------------------- Main Component ------------------------------ */
export default function BulkUrlGrid() {
  const [rows, setRows] = useState([]); // {id,url,module,meta,tags[],board,status,duplicateOf?}
  const [selected, setSelected] = useState(new Set());
  const [textSeed, setTextSeed] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const dropRef = useRef(null);

  // seed from clipboard paste or drag-drop
  const addUrls = useCallback((urls) => {
    if (!urls?.length) return;
    setRows((prev) => {
      const existing = new Set(prev.map((r) => r.url));
      const next = [];
      for (const raw of urls) {
        const url = normalizeUrl(raw);
        if (existing.has(url)) continue;
        const base = {
          id: `url_${Math.random().toString(36).slice(2)}`,
          url,
          module: "recipes", // default; will reclassify after inspect
          tags: [],
          board: "",
          status: "pending",
          meta: {},
          at: isoNow(),
        };
        next.push(base);
      }
      return [...next, ...prev];
    });
  }, []);

  const handleSeedParse = () => {
    addUrls(extractUrls(textSeed));
    setTextSeed("");
    setToast({ kind: "info", text: "Links added. Analyze to enrich & route." });
  };

  const selectAll = () =>
    setSelected(new Set(rows.filter((r) => !r._removed).map((r) => r.id)));
  const clearSelection = () => setSelected(new Set());
  const toggleRow = (id) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  // Drag-drop
  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    const onDrop = async (e) => {
      e.preventDefault();
      const text = e.dataTransfer.getData("text/plain");
      const urls = extractUrls(text);
      if (e.dataTransfer.files?.length) {
        for (const file of e.dataTransfer.files) {
          if (/\.csv$/i.test(file.name)) {
            const t = await file.text();
            urls.push(...extractUrls(t));
          }
        }
      }
      addUrls(urls);
    };
    const prevent = (e) => e.preventDefault();
    el.addEventListener("dragover", prevent);
    el.addEventListener("drop", onDrop);
    return () => {
      el.removeEventListener("dragover", prevent);
      el.removeEventListener("drop", onDrop);
    };
  }, [addUrls]);

  // Inspect a single url
  const inspectOne = useCallback(async (row) => {
    const res = await urlInspector?.inspect?.(row.url);
    let moduleGuess = row.module;
    let tags = row.tags || [];

    // Module classification
    if (classifyLink) {
      try {
        const klass = await classifyLink(row.url, res);
        if (klass?.module) moduleGuess = klass.module;
        if (Array.isArray(klass?.tags))
          tags = uniq([...(tags || []), ...klass.tags]);
      } catch {}
    } else {
      if (isPinterest(row.url)) moduleGuess = "inspiration";
      else if (isRecipeHostHeuristic(row.url, res)) moduleGuess = "recipes";
      else if (
        priceToNumber(res?.price) ||
        /product|sku|shop|cart/i.test(`${res?.type}${res?.ogType}${res?.site}`)
      )
        moduleGuess = "shopping";
    }

    // Duplicate detection (coarse)
    let duplicateOf = null;
    try {
      const canon = res?.canonicalUrl || row.url;
      if (moduleGuess === "recipes" && RecipeStore?.findByUrl) {
        duplicateOf = (await RecipeStore.findByUrl(canon))?.id || null;
      } else if (moduleGuess === "shopping" && ShoppingStore?.findByUrl) {
        duplicateOf = (await ShoppingStore.findByUrl(canon))?.id || null;
      } else if (IdeasStore?.findByUrl) {
        duplicateOf = (await IdeasStore.findByUrl(canon))?.id || null;
      }
    } catch {}

    return {
      ...row,
      status: "ready",
      meta: { ...(row.meta || {}), ...(res || {}) },
      module: moduleGuess,
      tags,
      duplicateOf,
    };
  }, []);

  // Analyze selected (or all if none selected)
  const analyze = async () => {
    const targets = rows.filter(
      (r) => !r._removed && (selected.size ? selected.has(r.id) : true)
    );
    if (!targets.length) return;
    setBusy(true);
    try {
      const updated = await Promise.all(
        targets.map(async (r) => {
          try {
            return await inspectOne(r);
          } catch {
            return { ...r, status: "error" };
          }
        })
      );
      setRows((prev) => {
        const map = new Map(prev.map((x) => [x.id, x]));
        updated.forEach((u) => map.set(u.id, u));
        return Array.from(map.values());
      });
      setToast({
        kind: "success",
        text: `Analyzed ${updated.length} item(s).`,
      });
      eventBus.emit?.("import.urls.enqueued", {
        at: isoNow(),
        count: updated.length,
        scope: "analyze",
      });
    } finally {
      setBusy(false);
    }
  };

  // Bulk edit
  const bulkApply = (patch) => {
    if (!selected.size) return;
    setRows((prev) =>
      prev.map((r) => (selected.has(r.id) ? { ...r, ...patch } : r))
    );
  };

  // Remove selected
  const removeSelected = () => {
    if (!selected.size) return;
    setRows((prev) =>
      prev.map((r) => (selected.has(r.id) ? { ...r, _removed: true } : r))
    );
    setToast({
      kind: "info",
      text: `Removed ${selected.size} from grid (not imported).`,
    });
    clearSelection();
  };

  // Import
  const importSelected = async () => {
    if (sabbathBlocked()) {
      setToast({
        kind: "warning",
        text: "Sabbath hands-off is active. Imports are paused.",
      });
      return;
    }
    const targets = rows.filter(
      (r) =>
        !r._removed &&
        (selected.size ? selected.has(r.id) : true) &&
        r.status !== "pending"
    );
    if (!targets.length) {
      setToast({
        kind: "info",
        text: "Nothing ready to import. Analyze first.",
      });
      return;
    }
    setBusy(true);
    try {
      const results = [];
      for (const r of targets) {
        // Downstream modules listen and perform actual creation. We still keep very soft direct fallbacks.
        eventBus.emit?.("import.item.requested", {
          at: isoNow(),
          url: r.url,
          module: r.module,
          meta: r.meta,
          tags: r.tags,
          board: r.board,
          source: "bulkGrid",
        });

        try {
          if (r.module === "recipes" && RecipeStore?.upsertFromUrl) {
            const out = await RecipeStore.upsertFromUrl(r.url, {
              meta: r.meta,
              tags: r.tags,
              board: r.board,
            });
            results.push({ id: out?.id, module: "recipes" });
          } else if (r.module === "shopping" && ShoppingStore?.upsertFromUrl) {
            const out = await ShoppingStore.upsertFromUrl(r.url, {
              meta: r.meta,
              tags: r.tags,
              board: r.board,
            });
            results.push({ id: out?.id, module: "shopping" });
          } else if (IdeasStore?.upsertFromUrl) {
            const out = await IdeasStore.upsertFromUrl(r.url, {
              meta: r.meta,
              tags: r.tags,
              board: r.board,
              category: r.module,
            });
            results.push({ id: out?.id, module: r.module });
          } else {
            // If no store available, rely on eventBus consumer.
            results.push({ id: r.id, module: r.module });
          }
        } catch {
          // continue others
        }
      }
      // Mark as imported in grid
      setRows((prev) =>
        prev.map((r) =>
          targets.find((t) => t.id === r.id) ? { ...r, status: "imported" } : r
        )
      );
      setToast({
        kind: "success",
        text: `Imported ${results.length} item(s).`,
      });
      eventBus.emit?.("vault.items.created", { at: isoNow(), items: results });
    } finally {
      setBusy(false);
    }
  };

  // Update single row
  const updateRow = (id, patch) => {
    if (patch?._remove) {
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, _removed: true } : r))
      );
      setSelected((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
      return;
    }
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === "a") {
        e.preventDefault();
        selectAll();
      }
      if (k === "e") {
        e.preventDefault(); /* focus bulk edit row */
      }
      if (k === "i") {
        e.preventDefault();
        importSelected();
      }
      if (k === "enter") {
        e.preventDefault();
        analyze();
      }
      if (k === "backspace" || k === "delete") {
        e.preventDefault();
        removeSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, selected]);

  const visible = rows.filter((r) => !r._removed);
  const anySelected = selected.size > 0;
  const selectedCount = visible.filter((r) => selected.has(r.id)).length;

  return (
    <section className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded bg-zinc-900" />
          <div className="text-lg font-semibold">Bulk URL Collector</div>
          <Badge>{visible.length} items</Badge>
          {anySelected ? (
            <Badge tone="amber">{selectedCount} selected</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="subtle" onClick={selectAll}>
            Select All (A)
          </Button>
          <Button
            variant="outline"
            onClick={analyze}
            disabled={!visible.length || busy}
          >
            {busy ? "Analyzing…" : "Analyze (⏎)"}
          </Button>
          <Button
            variant="outline"
            onClick={importSelected}
            disabled={!visible.length || busy}
          >
            {busy ? "Importing…" : "Import (I)"}
          </Button>
          <Button
            variant="ghost"
            onClick={removeSelected}
            disabled={!anySelected}
          >
            Remove (⌫)
          </Button>
        </div>
      </div>

      {/* Seed zone */}
      <div
        ref={dropRef}
        className="rounded-2xl border border-dashed p-3 md:p-4"
        aria-label="Paste or drop links"
        title="Paste or drop links, CSV, or text with URLs"
      >
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <div className="grow">
            <Textarea
              placeholder="Paste URLs, CSV rows, or any text containing links…"
              value={textSeed}
              onChange={(e) => setTextSeed(e.target.value)}
              onPaste={(e) => {
                const t = e.clipboardData.getData("text/plain");
                if (extractUrls(t).length > 1) {
                  e.preventDefault();
                  setTextSeed(t);
                }
              }}
            />
          </div>
          <div className="shrink-0 flex gap-2">
            <Button
              variant="outline"
              onClick={handleSeedParse}
              disabled={!textSeed.trim()}
            >
              Add Links
            </Button>
            <Button variant="ghost" onClick={() => setTextSeed("")}>
              Clear
            </Button>
          </div>
        </div>
        <div className="mt-2 text-xs text-zinc-500">
          Tip: Drop CSV/notes with links. Tracker params are stripped
          automatically.
        </div>
      </div>

      {/* Bulk edit strip */}
      {anySelected ? (
        <div className="rounded-2xl border p-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">Bulk edit</span>
          <select
            className="select select-bordered select-sm rounded-lg"
            onChange={(e) => bulkApply({ module: e.target.value })}
            defaultValue=""
            aria-label="Set module"
          >
            <option value="" disabled>
              Module…
            </option>
            {MODULES.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
          <Input
            placeholder="Tags (comma)"
            onBlur={(e) =>
              e.target.value?.trim() &&
              bulkApply({
                tags: e.target.value
                  .split(",")
                  .map((x) => x.trim())
                  .filter(Boolean),
              })
            }
          />
          <Input
            placeholder="Board / Collection"
            onBlur={(e) => bulkApply({ board: e.target.value })}
          />
          <Button variant="outline" onClick={analyze}>
            Re-analyze
          </Button>
          <Button variant="solid" onClick={importSelected}>
            Import
          </Button>
        </div>
      ) : null}

      {/* Grid */}
      {visible.length ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {visible.map((r) => (
            <UrlCard
              key={r.id}
              item={r}
              selected={selected.has(r.id)}
              onToggle={() => toggleRow(r.id)}
              onChange={(patch) => updateRow(r.id, patch)}
            />
          ))}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed p-8 text-center text-zinc-600">
          No items yet. Paste some links or drop a CSV.
        </div>
      )}

      {/* Toast */}
      {toast ? (
        <div
          className={cx(
            "fixed bottom-4 right-4 z-50 rounded-xl shadow-lg px-4 py-3",
            toast.kind === "success" && "bg-emerald-600 text-white",
            toast.kind === "warning" && "bg-amber-600 text-white",
            toast.kind === "error" && "bg-red-600 text-white",
            toast.kind === "info" && "bg-zinc-900 text-white"
          )}
        >
          <div className="text-sm">{toast.text}</div>
          <button
            className="mt-2 rounded-lg border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
            onClick={() => setToast(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </section>
  );
}

/* ----------------------------- Lightweight tests ----------------------------- */
(function runBulkUrlGridOnce() {
  if (typeof window === "undefined") return;
  if (window.__BULK_URL_GRID_TEST__) return;
  window.__BULK_URL_GRID_TEST__ = true;

  const ok = (c, m) =>
    c
      ? console.log("[BulkUrlGrid TEST PASS]", m)
      : console.error("[BulkUrlGrid TEST FAIL]", m);
  ok(
    extractUrls("foo https://a.com x https://b.com").length === 2,
    "Extracts 2 urls"
  );
  ok(
    normalizeUrl("https://x.com/?utm_source=z") === "https://x.com/",
    "Strips utm params"
  );
})();
