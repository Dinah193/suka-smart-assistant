// src/components/pinboard/PlanTemplateChooser.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try {
  Icons = require("lucide-react");
} catch {
  Icons = {
    LayoutGrid: () => null,
    CalendarDays: () => null,
    Search: () => null,
    Filter: () => null,
    Sparkles: () => null,
    Eye: () => null,
    EyeOff: () => null,
    Check: () => null,
    X: () => null,
    Clock: () => null,
    Tag: () => null,
    UtensilsCrossed: () => null,
    Download: () => null,
    Upload: () => null,
    ChevronRight: () => null,
    ChevronLeft: () => null,
    ChevronDown: () => null,
    ChevronUp: () => null,
    ListChecks: () => null,
    SlidersHorizontal: () => null,
    Bot: () => null,
    CopyPlus: () => null,
    Star: () => null,
    StarOff: () => null,
  };
}

let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  eventBus = require("@/services/eventBus").eventBus || eventBus;
} catch {}

let useMealPlanStore = () => ({
  hydrateFromTemplates: null, // (template, options) => void
});
try {
  useMealPlanStore = require("@/store/MealPlanStore").useMealPlanStore || useMealPlanStore;
} catch {}

let usePersonalFoodStandards = () => ({ standards: {} });
try {
  usePersonalFoodStandards =
    require("@/app/context/HouseholdSettingsContext").usePersonalFoodStandards ||
    usePersonalFoodStandards;
} catch {}

let InventoryMonitor = {
  // optional - used only for preview badges
  estimateCoverageForTemplate: () => ({ status: "unknown", missingCount: 0 }),
};
try {
  InventoryMonitor =
    require("@/managers/InventoryMonitor").default ||
    require("@/managers/InventoryMonitor") ||
    InventoryMonitor;
} catch {}

/* ---------------------------------- Helpers --------------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");
const STORAGE_KEY = "suka.planTemplates.ui.v1";
const safeArr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));

/** lightweight match on standards for a quick badge */
function standardsOK(template = {}, standards = {}) {
  // If template carries tags like ["pork","seafood"], flag quickly
  const tags = new Set(safeArr(template.tags).map((t) => (typeof t === "string" ? t : t?.id)));
  if (standards?.noPork && tags.has("pork")) return { ok: false, reason: "Pork" };
  if (standards?.lambBeefOnly && (tags.has("chicken") || tags.has("fish") || tags.has("seafood")))
    return { ok: false, reason: "Lamb/Beef only" };
  return { ok: true };
}

/* ---------------------------------- Component -------------------------------- */
export default function PlanTemplateChooser({
  /** Array of templates. Minimal shape:
   * { id, title, image?, category?, duration?: 'day'|'week'|'month',
   *   slots?: number,  // how many meal slots it fills
   *   rating?: 0..5,
   *   tags?: string[] | {id,label}[],
   *   description?,
   *   sample?: [{ day:'Mon', slot:'Dinner', recipeTitle:'...' }, ...]  // preview
   * }
   */
  templates = [],
  initialQuery = "",
  categories = [],          // optional e.g. ["Balanced","High Protein","Quick","Family","Budget"]
  defaultDuration = "week", // day|week|month
  /** Optional destinations */
  onApply,                  // (template, options) => void
  onPreview,                // (template) => void
  className,
}) {
  const {
    LayoutGrid, CalendarDays, Search, Filter, Sparkles, Eye, EyeOff, Check, X,
    Clock, Tag, UtensilsCrossed, Download, Upload, ChevronRight, ChevronLeft,
    ChevronDown, ChevronUp, ListChecks, SlidersHorizontal, Bot, CopyPlus,
    Star, StarOff
  } = Icons;

  const ChevronRightIcon = ChevronRight || (() => null);
  const ChevronLeftIcon = ChevronLeft || (() => null);

  const mealPlan = useMealPlanStore();
  const { standards } = usePersonalFoodStandards();

  /* ------------------------------- UI state -------------------------------- */
  const [q, setQ] = useState(initialQuery);
  const [dur, setDur] = useState(defaultDuration || "week");
  const [cat, setCat] = useState("all");
  const [sortKey, setSortKey] = useState("relevance"); // relevance|rating|recent|slots|title
  const [sortDir, setSortDir] = useState("desc");
  const [showPreviewPane, setShowPreviewPane] = useState(true);
  const [selected, setSelected] = useState(null); // template object
  const [page, setPage] = useState(1);

  // Persist some UI
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (saved.sortKey) setSortKey(saved.sortKey);
      if (saved.sortDir) setSortDir(saved.sortDir);
      if (typeof saved.showPreviewPane === "boolean") setShowPreviewPane(saved.showPreviewPane);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ sortKey, sortDir, showPreviewPane })
      );
    } catch {}
  }, [sortKey, sortDir, showPreviewPane]);

  /* ------------------------------- Filter/sort -------------------------------- */
  const filtered = useMemo(() => {
    const needle = (q || "").trim().toLowerCase();
    let arr = templates;

    if (dur !== "all") {
      arr = arr.filter((t) => (t.duration || "week") === dur);
    }
    if (cat !== "all") {
      arr = arr.filter((t) => (t.category || "Other") === cat);
    }
    if (needle) {
      arr = arr.filter((t) => {
        const hay = [
          t.title,
          t.description,
          ...(safeArr(t.tags).map((x) => (typeof x === "string" ? x : x?.label || x?.id))),
          t.category,
          t.duration,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(needle);
      });
    }

    const keyFn = (t) => {
      switch (sortKey) {
        case "rating": return Number(t.rating || 0);
        case "recent": return Number(new Date(t.updatedAt || t.createdAt || 0).getTime());
        case "slots": return Number(t.slots || 0);
        case "title": return (t.title || "").toLowerCase();
        case "relevance":
        default: {
          // quick heuristic: rating + slots + contains search needle near title
          const base = Number(t.rating || 0) * 10 + Number(t.slots || 0);
          if (!needle) return base;
          const score =
            (t.title || "").toLowerCase().includes(needle) ? 25 : 0 +
            (safeArr(t.tags).join(" ").toLowerCase().includes(needle) ? 10 : 0);
          return base + score;
        }
      }
    };

    const sorted = [...arr].sort((a, b) => {
      const av = keyFn(a);
      const bv = keyFn(b);
      if (typeof av === "string" || typeof bv === "string") {
        const cmp = String(av).localeCompare(String(bv));
        return sortDir === "asc" ? cmp : -cmp;
      }
      return sortDir === "asc" ? av - bv : bv - av;
    });

    return sorted;
  }, [templates, q, dur, cat, sortKey, sortDir]);

  useEffect(() => {
    setPage(1);
  }, [q, dur, cat, sortKey, sortDir]);

  const perPage = 18;
  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageItems = filtered.slice((page - 1) * perPage, page * perPage);

  /* --------------------------------- Actions -------------------------------- */
  const applyTemplate = (tpl, options = {}) => {
    try {
      if (typeof mealPlan?.hydrateFromTemplates === "function") {
        mealPlan.hydrateFromTemplates(tpl, options);
      } else if (typeof onApply === "function") {
        onApply(tpl, options);
      }
      eventBus.emit("meals.plan.applyTemplate", {
        templateId: tpl.id,
        title: tpl.title,
        options,
      });
    } catch (e) {
      console.warn("[PlanTemplateChooser] apply failed:", e);
    }
  };

  const previewTemplate = (tpl) => {
    setSelected(tpl);
    if (typeof onPreview === "function") onPreview(tpl);
    eventBus.emit("meals.plan.previewTemplate", { templateId: tpl.id });
  };

  const exportTemplate = (tpl) => {
    try {
      const payload = JSON.stringify(tpl, null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `template-${tpl.id || "export"}.json`;
      link.click();
    } catch (e) {
      console.warn("[PlanTemplateChooser] export failed:", e);
    }
  };

  const importTemplate = async (evt) => {
    const file = evt?.target?.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      eventBus.emit("meals.plan.template.imported", { id: parsed.id, title: parsed.title });
      // We don’t mutate props.templates here; parent should handle adding.
      alert("Template imported. Add it to your template store/list to use.");
    } catch (e) {
      console.warn("[PlanTemplateChooser] import failed:", e);
      alert("Import failed. Check file format.");
    } finally {
      evt.target.value = "";
    }
  };

  /* ---------------------------------- UI bits -------------------------------- */
  const Toolbar = () => (
    <div className="flex flex-col lg:flex-row lg:items-center gap-3 mb-3">
      {/* Search */}
      <div className="relative flex-1">
        <Search className="w-4 h-4 text-gray-500 absolute left-3 top-2.5" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search templates… (title, tags, category)"
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
        />
      </div>

      {/* Duration */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500">Duration</label>
        <select
          value={dur}
          onChange={(e) => setDur(e.target.value)}
          className="px-2 py-1 rounded border border-gray-300 text-sm"
        >
          <option value="all">All</option>
          <option value="day">Day</option>
          <option value="week">Week</option>
          <option value="month">Month</option>
        </select>
      </div>

      {/* Category */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500">Category</label>
        <select
          value={cat}
          onChange={(e) => setCat(e.target.value)}
          className="px-2 py-1 rounded border border-gray-300 text-sm"
        >
          <option value="all">All</option>
          {safeArr(categories).map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </div>

      {/* Sort */}
      <div className="flex items-center gap-2">
        <label className="text-xs text-gray-500">Sort</label>
        <select
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value)}
          className="px-2 py-1 rounded border border-gray-300 text-sm"
        >
          <option value="relevance">Relevance</option>
          <option value="rating">Rating</option>
          <option value="recent">Recent</option>
          <option value="slots">Slots</option>
          <option value="title">Title</option>
        </select>
        <button
          type="button"
          onClick={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-gray-300 text-sm bg-white hover:bg-gray-50"
          title="Toggle sort direction"
        >
          <SlidersHorizontal className="w-4 h-4" />
          {sortDir.toUpperCase()}
        </button>
      </div>

      {/* Preview pane toggle + Import/Export examples */}
      <div className="lg:ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => setShowPreviewPane((v) => !v)}
          className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border bg-white border-gray-300 text-sm"
          title={showPreviewPane ? "Hide preview" : "Show preview"}
        >
          {showPreviewPane ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          {showPreviewPane ? "Preview off" : "Preview on"}
        </button>

        <label className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border bg-white border-gray-300 text-sm cursor-pointer">
          <Upload className="w-4 h-4" />
          Import
          <input type="file" accept="application/json" onChange={importTemplate} className="sr-only" />
        </label>
      </div>
    </div>
  );

  const Card = ({ tpl }) => {
    const ok = standardsOK(tpl, standards);
    const inv = (() => {
      try {
        return InventoryMonitor.estimateCoverageForTemplate?.(tpl) || { status: "unknown", missingCount: 0 };
      } catch {
        return { status: "unknown", missingCount: 0 };
      }
    })();
    const rating = clamp(Number(tpl.rating || 0), 0, 5);

    return (
      <div
        className="group relative rounded-2xl border border-gray-200 bg-white shadow-sm hover:shadow-md transition overflow-hidden"
        role="button"
        tabIndex={0}
        onClick={() => previewTemplate(tpl)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && previewTemplate(tpl)}
        aria-label={`Preview template ${tpl.title}`}
      >
        {/* Media */}
        <div className="h-32 bg-gray-100 overflow-hidden">
          {tpl.image ? (
            <img src={tpl.image} alt="" className="w-full h-full object-cover transition group-hover:scale-[1.02]" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-gray-500">No image</div>
          )}
        </div>

        {/* Body */}
        <div className="p-3">
          <div className="line-clamp-2 font-semibold text-gray-900 text-sm">{tpl.title || "Untitled template"}</div>
          <div className="mt-1 text-[11px] text-gray-600 flex items-center gap-2">
            <CalendarDays className="w-3 h-3" />
            <span className="capitalize">{tpl.duration || "week"}</span>
            <span>•</span>
            <LayoutGrid className="w-3 h-3" />
            <span>{tpl.slots || 0} slots</span>
          </div>

          {/* Badges */}
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {/* rating */}
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-gray-50 border-gray-200">
              {Array.from({ length: 5 }).map((_, i) =>
                i < rating ? <Star key={i} className="w-3 h-3 text-amber-500" /> : <StarOff key={i} className="w-3 h-3 text-gray-300" />
              )}
            </span>
            {/* inventory */}
            {inv.status === "ok" ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-emerald-50 border-emerald-200 text-emerald-700">
                <ListChecks className="w-3 h-3" /> On hand
              </span>
            ) : inv.status === "missing" ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-amber-50 border-amber-200 text-amber-700">
                <ListChecks className="w-3 h-3" /> {inv.missingCount || 1} missing
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-gray-50 border-gray-200 text-gray-600">
                <ListChecks className="w-3 h-3" /> Check inv.
              </span>
            )}

            {/* standards */}
            {ok.ok ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-emerald-50 border-emerald-200 text-emerald-700">
                <Sparkles className="w-3 h-3" /> Fits standards
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] bg-rose-50 border-rose-200 text-rose-700">
                <Sparkles className="w-3 h-3" /> {ok.reason}
              </span>
            )}
          </div>

          {/* Tags */}
          {safeArr(tpl.tags).length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {safeArr(tpl.tags)
                .slice(0, 5)
                .map((t, i) => (
                  <span key={`${tpl.id}-tag-${i}`} className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 bg-gray-50 text-gray-700">
                    {typeof t === "string" ? t : t?.label || t?.id}
                  </span>
                ))}
              {safeArr(tpl.tags).length > 5 ? (
                <span className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 bg-gray-50 text-gray-500">
                  +{safeArr(tpl.tags).length - 5}
                </span>
              ) : null}
            </div>
          ) : null}

          {/* Footer actions */}
          <div className="mt-3 flex items-center justify-between">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                previewTemplate(tpl);
              }}
              className="text-xs inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border bg-white border-gray-300 hover:bg-gray-50"
            >
              <Eye className="w-4 h-4" /> Preview
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  applyTemplate(tpl, { mapping: "auto" });
                }}
                className="text-xs inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border bg-white border-gray-300 hover:bg-gray-50"
                title="Auto-map to your planner slots"
              >
                <UtensilsCrossed className="w-4 h-4" /> Apply
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  exportTemplate(tpl);
                }}
                className="text-xs inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border bg-white border-gray-300 hover:bg-gray-50"
              >
                <Download className="w-4 h-4" /> Export
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const PreviewPane = () => {
    if (!showPreviewPane) return null;
    return (
      <aside className="hidden xl:block w-80 shrink-0">
        <div className="sticky top-[72px] rounded-2xl border border-gray-200 bg-white p-4">
          <div className="flex items-center gap-2 mb-2">
            <Eye className="w-4 h-4 text-gray-600" />
            <h4 className="text-sm font-semibold text-gray-800">Preview</h4>
          </div>
          {!selected ? (
            <div className="text-xs text-gray-500">
              Select a template to see its sample layout.
            </div>
          ) : (
            <>
              <div className="font-medium text-sm text-gray-900">{selected.title}</div>
              <div className="mt-1 text-[11px] text-gray-600 capitalize">{selected.duration || "week"}</div>

              {selected.image ? (
                <div className="mt-2 h-32 rounded-lg overflow-hidden bg-gray-100">
                  <img src={selected.image} alt="" className="w-full h-full object-cover" />
                </div>
              ) : null}

              {/* Sample layout */}
              <div className="mt-3">
                <div className="text-xs text-gray-700 mb-1">Sample layout</div>
                <ul className="space-y-1 max-h-56 overflow-auto pr-1">
                  {safeArr(selected.sample).length ? (
                    safeArr(selected.sample).slice(0, 25).map((row, i) => (
                      <li key={`s-${i}`} className="flex items-center justify-between text-[11px] rounded border bg-gray-50 border-gray-200 px-2 py-1">
                        <span className="text-gray-700 truncate">
                          <span className="font-medium">{row.day || row.date || "Day"}</span> • {row.slot || "Meal"}:
                          &nbsp;{row.recipeTitle || row.title || "Recipe"}
                        </span>
                        {row.time ? (
                          <span className="text-gray-500 ml-2 flex items-center gap-1">
                            <Clock className="w-3 h-3" /> {row.time}
                          </span>
                        ) : null}
                      </li>
                    ))
                  ) : (
                    <li className="text-[11px] text-gray-500">No sample data.</li>
                  )}
                </ul>
              </div>

              {/* Apply with mapping */}
              <div className="mt-3 grid grid-cols-1 gap-2">
                <button
                  type="button"
                  onClick={() => applyTemplate(selected, { mapping: "auto" })}
                  className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border bg-emerald-600 border-emerald-600 text-white text-sm"
                >
                  <Sparkles className="w-4 h-4" />
                  Apply with Auto-Mapping
                </button>
                <button
                  type="button"
                  onClick={() => applyTemplate(selected, { mapping: "manual" })}
                  className="inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg border bg-white border-gray-300 text-gray-800 text-sm hover:bg-gray-50"
                >
                  <SlidersHorizontal className="w-4 h-4" />
                  Choose Slot Mapping…
                </button>
              </div>
            </>
          )}
          <div className="mt-3 text-[11px] text-gray-500">
            Tip: Templates can pre-pin meals, set servings, and add batch sessions.
          </div>
        </div>
      </aside>
    );
  };

  /* ----------------------------------- JSX ----------------------------------- */
  return (
    <section className={cx("w-full", className)} aria-label="Plan template chooser">
      <Toolbar />

      <div className="flex items-start gap-3">
        {/* Grid column */}
        <div className={cx("flex-1", showPreviewPane ? "xl:pr-1" : "")}>
          {/* Header row: count + pager */}
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-gray-600">
              Showing <strong>{filtered.length ? ((page - 1) * perPage + 1) : 0}</strong>–
              <strong>{Math.min(page * perPage, filtered.length)}</strong> of <strong>{filtered.length}</strong>
            </div>
            {totalPages > 1 ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-white border-gray-300 text-sm disabled:opacity-50"
                >
                  <ChevronLeftIcon className="w-4 h-4" />
                  Prev
                </button>
                <div className="text-xs text-gray-700">
                  Page <strong>{page}</strong> / {totalPages}
                </div>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border bg-white border-gray-300 text-sm disabled:opacity-50"
                >
                  Next
                  <ChevronRightIcon className="w-4 h-4" />
                </button>
              </div>
            ) : <div />}
          </div>

          {/* Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3">
            {pageItems.map((tpl) => (
              <Card key={tpl.id || tpl.title} tpl={tpl} />
            ))}
            {pageItems.length === 0 ? (
              <div className="col-span-full rounded-xl border border-dashed p-6 text-center text-sm text-gray-600 bg-white">
                No templates match your search. Try a different category, duration, or keywords.
              </div>
            ) : null}
          </div>

          {/* Tips */}
          <div className="mt-3 text-[11px] text-gray-500 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Filter className="w-3 h-3" />
              Tip: use categories to quickly find themed plans (e.g., “High Protein” or “Budget”).
            </div>
            <div className="hidden sm:flex items-center gap-2">
              <Bot className="w-3 h-3" />
              Want a custom plan? Use the AI Meal Builder and save as a template.
            </div>
          </div>
        </div>

        {/* Preview Pane */}
        <PreviewPane />
      </div>
    </section>
  );
}
