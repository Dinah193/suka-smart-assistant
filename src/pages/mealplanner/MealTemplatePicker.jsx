// File: src/pages/mealplanner/MealTemplatePicker.jsx
// SSA — Meal Planner
// Production-ready, dependency-light picker with search, categories, and safe fallbacks.
// Works even if templates are passed in different shapes (array or object map).
//
// Expected props:
// - templates: Array|Object (list of template objects OR map {id: template})
// - value: string|null (selected template id/key)
// - onChange: (nextId: string, template: object|null) => void
// - title: string (optional UI title)
// - description: string (optional UI subtext)
// - allowNone: boolean (default true)
// - disabled: boolean
// - className: string
// - showDetails: boolean (default true)
// - showMetaChips: boolean (default true)
// - maxListHeight: number (default 360)
// - getLabel(template): string (optional)
// - getCategory(template): string (optional)
// - getId(template): string (optional)
//
// Template shape (flexible):
// { id|key|templateId, name|title|label, category|group|cuisine, tags:[], notes, lastUsedAt, macros, ... }
//
// Styling:
// Uses your existing "bridge" style tokens if present: .card .btn .input .chip .muted etc.
// Also includes minimal inline styles for robustness.

import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------ helpers ------------------------------ */

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function normalizeTemplates(templates) {
  if (!templates) return [];
  if (Array.isArray(templates)) return templates.filter(Boolean);
  if (typeof templates === "object") {
    // map of {id: template} OR { templates: [...] }
    if (Array.isArray(templates.templates))
      return templates.templates.filter(Boolean);
    return Object.values(templates).filter(Boolean);
  }
  return [];
}

function defaultGetId(tpl) {
  return (
    tpl?.id ??
    tpl?.templateId ??
    tpl?.key ??
    tpl?.slug ??
    tpl?.code ??
    tpl?.name ??
    tpl?.title ??
    ""
  );
}

function defaultGetLabel(tpl) {
  return (
    tpl?.name ?? tpl?.title ?? tpl?.label ?? defaultGetId(tpl) ?? "Untitled"
  );
}

function defaultGetCategory(tpl) {
  return (
    tpl?.category ?? tpl?.group ?? tpl?.cuisine ?? tpl?.type ?? "Uncategorized"
  );
}

function uniq(arr) {
  const s = new Set();
  const out = [];
  for (const v of arr) {
    const k = safeStr(v).trim();
    if (!k) continue;
    if (s.has(k)) continue;
    s.add(k);
    out.push(k);
  }
  return out;
}

function containsAny(haystack, needles) {
  const h = safeStr(haystack).toLowerCase();
  for (const n of needles) {
    const nn = safeStr(n).toLowerCase();
    if (!nn) continue;
    if (h.includes(nn)) return true;
  }
  return false;
}

function formatWhen(iso) {
  // Keep it simple and resilient: show date only.
  const s = safeStr(iso);
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString();
}

function classNames(...xs) {
  return xs.filter(Boolean).join(" ");
}

/* ------------------------------ component ------------------------------ */

export default function MealTemplatePicker({
  templates,
  value,
  onChange,

  title = "Meal Templates",
  description = "Pick a template to guide this plan’s structure (proteins, sides, rhythm, prep expectations).",

  allowNone = true,
  disabled = false,
  className = "",
  showDetails = true,
  showMetaChips = true,
  maxListHeight = 360,

  getLabel = defaultGetLabel,
  getCategory = defaultGetCategory,
  getId = defaultGetId,
}) {
  const all = useMemo(() => normalizeTemplates(templates), [templates]);

  const normalized = useMemo(() => {
    // Force a stable, clean object shape with derived fields for filtering/sorting.
    const list = [];
    for (const raw of all) {
      const id = safeStr(getId(raw)).trim();
      if (!id) continue;

      const label = safeStr(getLabel(raw)).trim() || id;
      const category = safeStr(getCategory(raw)).trim() || "Uncategorized";

      const tags = Array.isArray(raw?.tags) ? raw.tags.map(safeStr) : [];
      const searchText = [
        id,
        label,
        category,
        safeStr(raw?.subtitle),
        safeStr(raw?.notes),
        safeStr(raw?.description),
        tags.join(" "),
        safeStr(raw?.cuisine),
        safeStr(raw?.theme),
      ]
        .filter(Boolean)
        .join(" • ");

      list.push({
        __id: id,
        __label: label,
        __category: category,
        __tags: uniq(tags),
        __search: searchText,
        raw,
      });
    }

    // Sort: recently used (if any), then label.
    const scoreDate = (t) => {
      const iso =
        t?.raw?.lastUsedAt ||
        t?.raw?.last_used_at ||
        t?.raw?.updatedAt ||
        t?.raw?.updated_at ||
        "";
      const d = new Date(iso);
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    };

    list.sort((a, b) => {
      const da = scoreDate(a);
      const db = scoreDate(b);
      if (da !== db) return db - da;
      return a.__label.localeCompare(b.__label);
    });

    return list;
  }, [all, getCategory, getId, getLabel]);

  const categories = useMemo(() => {
    return [
      "All",
      ...uniq(normalized.map((t) => t.__category)).sort((a, b) =>
        a.localeCompare(b)
      ),
    ];
  }, [normalized]);

  const selected = useMemo(() => {
    const v = safeStr(value).trim();
    if (!v) return null;
    return normalized.find((t) => t.__id === v) || null;
  }, [normalized, value]);

  // UI state
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [compact, setCompact] = useState(false);

  // Keyboard navigation in list
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef(null);
  const queryRef = useRef(null);

  useEffect(() => {
    // Reset active index whenever filters change.
    setActiveIndex(-1);
  }, [query, category]);

  const filtered = useMemo(() => {
    const q = safeStr(query).trim().toLowerCase();
    const tokens = q ? q.split(/\s+/g).filter(Boolean) : [];
    const cat = safeStr(category).trim();

    const list = normalized.filter((t) => {
      if (cat && cat !== "All" && t.__category !== cat) return false;
      if (!tokens.length) return true;
      return containsAny(t.__search, tokens);
    });

    return list;
  }, [normalized, query, category]);

  // Ensure active index stays within bounds
  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(filtered.length - 1);
  }, [activeIndex, filtered.length]);

  function emitChange(nextId) {
    const id = safeStr(nextId).trim();
    const tpl = id ? normalized.find((t) => t.__id === id) || null : null;
    onChange?.(id, tpl?.raw || null);
  }

  function onKeyDown(e) {
    if (disabled) return;

    // If user is typing in inputs, let them type; we only manage arrow/enter when focus isn't in a text field
    const tag = (e.target?.tagName || "").toLowerCase();
    const isTextField =
      tag === "input" || tag === "textarea" || tag === "select";

    // Allow shortcuts when focus is in the query input.
    const isQuery = e.target === queryRef.current;

    if (e.key === "Escape") {
      // Clear query, then category, then selection (if allowNone)
      if (query) {
        setQuery("");
        e.preventDefault();
        return;
      }
      if (category !== "All") {
        setCategory("All");
        e.preventDefault();
        return;
      }
      if (allowNone && value) {
        emitChange("");
        e.preventDefault();
        return;
      }
      return;
    }

    // List navigation: only when not in a select (or when in query input)
    if (!isTextField || isQuery) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        if (activeIndex >= 0 && activeIndex < filtered.length) {
          e.preventDefault();
          emitChange(filtered[activeIndex].__id);
        }
      }
    }
  }

  function scrollActiveIntoView() {
    const el = listRef.current;
    if (!el) return;
    if (activeIndex < 0) return;
    const row = el.querySelector(`[data-index="${activeIndex}"]`);
    if (!row) return;

    const rTop = row.offsetTop;
    const rBot = rTop + row.offsetHeight;
    const vTop = el.scrollTop;
    const vBot = vTop + el.clientHeight;

    if (rTop < vTop) el.scrollTop = rTop;
    else if (rBot > vBot) el.scrollTop = Math.max(0, rBot - el.clientHeight);
  }

  useEffect(() => {
    scrollActiveIntoView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex]);

  const countLabel = useMemo(() => {
    const total = normalized.length;
    const shown = filtered.length;
    if (total === shown) return `${total} templates`;
    return `${shown} / ${total} templates`;
  }, [normalized.length, filtered.length]);

  const hasAny = normalized.length > 0;

  return (
    <section
      className={classNames("card", className)}
      onKeyDown={onKeyDown}
      aria-disabled={disabled ? "true" : "false"}
      style={{
        padding: 14,
        borderRadius: 14,
        border: "1px solid rgba(0,0,0,0.08)",
      }}
    >
      {/* Header */}
      <div
        className="row"
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 10,
        }}
      >
        <div style={{ minWidth: 240 }}>
          <div style={{ fontWeight: 800, fontSize: 16, lineHeight: 1.1 }}>
            {title}
          </div>
          {description ? (
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              {description}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexWrap: "wrap",
          }}
        >
          {showMetaChips ? (
            <span className="chip" style={{ fontSize: 12 }}>
              {countLabel}
            </span>
          ) : null}

          <button
            type="button"
            className="btn"
            disabled={disabled}
            onClick={() => {
              setCompact((v) => !v);
            }}
            title="Toggle compact list"
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.12)",
              background: "rgba(255,255,255,0.8)",
              cursor: disabled ? "not-allowed" : "pointer",
            }}
          >
            {compact ? "Comfort" : "Compact"}
          </button>

          {allowNone ? (
            <button
              type="button"
              className="btn"
              disabled={disabled || !value}
              onClick={() => emitChange("")}
              title="Clear selection"
              style={{
                padding: "8px 10px",
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,0.12)",
                background: "rgba(255,255,255,0.8)",
                cursor: disabled ? "not-allowed" : "pointer",
              }}
            >
              None
            </button>
          ) : null}
        </div>
      </div>

      {/* Controls */}
      <div
        className="row"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 200px",
          gap: 10,
          marginBottom: 10,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label className="muted" style={{ fontSize: 12 }}>
            Search
          </label>
          <input
            ref={queryRef}
            className="input"
            disabled={disabled}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type to filter (name, category, tags)…"
            aria-label="Search meal templates"
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.12)",
              outline: "none",
            }}
          />
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label className="muted" style={{ fontSize: 12 }}>
            Category
          </label>
          <select
            className="input"
            disabled={disabled}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Template category filter"
            style={{
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.12)",
              outline: "none",
              background: "white",
            }}
          >
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Selected summary */}
      {showDetails ? (
        <div
          style={{
            marginBottom: 10,
            padding: 10,
            borderRadius: 12,
            border: "1px dashed rgba(0,0,0,0.18)",
            background: "rgba(0,0,0,0.02)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <div className="muted" style={{ fontSize: 12 }}>
                Selected
              </div>
              <div style={{ fontWeight: 800 }}>
                {selected ? selected.__label : allowNone ? "None" : "—"}
              </div>
              {selected?.raw?.subtitle ? (
                <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                  {safeStr(selected.raw.subtitle)}
                </div>
              ) : null}
            </div>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              {selected?.__category ? (
                <span className="chip" title="Category">
                  {selected.__category}
                </span>
              ) : null}

              {Array.isArray(selected?.__tags) && selected.__tags.length ? (
                selected.__tags.slice(0, 4).map((t) => (
                  <span key={t} className="chip" title="Tag">
                    {t}
                  </span>
                ))
              ) : (
                <span className="muted" style={{ fontSize: 12 }}>
                  {selected ? "No tags" : "Pick a template from the list"}
                </span>
              )}

              {selected?.raw?.lastUsedAt || selected?.raw?.updatedAt ? (
                <span className="chip" title="Last used / updated">
                  {formatWhen(
                    selected.raw.lastUsedAt || selected.raw.updatedAt
                  )}
                </span>
              ) : null}
            </div>
          </div>

          {selected?.raw?.notes || selected?.raw?.description ? (
            <div
              className="muted"
              style={{ fontSize: 12, marginTop: 8, lineHeight: 1.35 }}
            >
              {safeStr(selected.raw.notes || selected.raw.description)}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* List */}
      <div
        ref={listRef}
        role="listbox"
        aria-label="Meal templates"
        aria-activedescendant={
          activeIndex >= 0 ? `mtp-opt-${activeIndex}` : undefined
        }
        style={{
          maxHeight: maxListHeight,
          overflow: "auto",
          borderRadius: 12,
          border: "1px solid rgba(0,0,0,0.10)",
          background: "rgba(255,255,255,0.9)",
        }}
      >
        {!hasAny ? (
          <div style={{ padding: 14 }}>
            <div style={{ fontWeight: 800 }}>No templates found</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Pass a <code>templates</code> array/map into{" "}
              <code>MealTemplatePicker</code>, or create templates in your meal
              planner catalog.
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: 14 }}>
            <div style={{ fontWeight: 800 }}>No matches</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
              Try a different search term, or reset filters (Esc).
            </div>
          </div>
        ) : (
          filtered.map((t, idx) => {
            const isSelected = safeStr(value).trim() === t.__id;
            const isActive = idx === activeIndex;

            return (
              <button
                key={t.__id}
                id={`mtp-opt-${idx}`}
                data-index={idx}
                type="button"
                role="option"
                aria-selected={isSelected ? "true" : "false"}
                disabled={disabled}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => emitChange(t.__id)}
                className={classNames(
                  "btn",
                  isSelected ? "is-selected" : "",
                  isActive ? "is-active" : ""
                )}
                style={{
                  width: "100%",
                  textAlign: "left",
                  border: "none",
                  borderBottom:
                    idx === filtered.length - 1
                      ? "none"
                      : "1px solid rgba(0,0,0,0.06)",
                  padding: compact ? "10px 12px" : "12px 12px",
                  background: isSelected
                    ? "rgba(0,0,0,0.06)"
                    : isActive
                    ? "rgba(0,0,0,0.035)"
                    : "transparent",
                  cursor: disabled ? "not-allowed" : "pointer",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 10,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 850,
                        fontSize: compact ? 13 : 14,
                        lineHeight: 1.2,
                      }}
                    >
                      {t.__label}
                    </div>
                    {!compact && (t.raw?.subtitle || t.raw?.description) ? (
                      <div
                        className="muted"
                        style={{ fontSize: 12, marginTop: 3, lineHeight: 1.25 }}
                      >
                        {safeStr(t.raw.subtitle || t.raw.description)}
                      </div>
                    ) : null}

                    {!compact && Array.isArray(t.__tags) && t.__tags.length ? (
                      <div
                        style={{
                          display: "flex",
                          gap: 6,
                          flexWrap: "wrap",
                          marginTop: 7,
                        }}
                      >
                        {t.__tags.slice(0, 6).map((tag) => (
                          <span
                            key={tag}
                            className="chip"
                            style={{ fontSize: 12 }}
                          >
                            {tag}
                          </span>
                        ))}
                        {t.__tags.length > 6 ? (
                          <span className="muted" style={{ fontSize: 12 }}>
                            +{t.__tags.length - 6} more
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>

                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-end",
                      gap: 6,
                    }}
                  >
                    <span
                      className="chip"
                      title="Category"
                      style={{ fontSize: 12 }}
                    >
                      {t.__category}
                    </span>
                    {t.raw?.lastUsedAt ? (
                      <span
                        className="muted"
                        style={{ fontSize: 12 }}
                        title="Last used"
                      >
                        {formatWhen(t.raw.lastUsedAt)}
                      </span>
                    ) : null}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>

      {/* Footer hints */}
      <div
        className="muted"
        style={{
          fontSize: 12,
          marginTop: 10,
          display: "flex",
          gap: 10,
          flexWrap: "wrap",
        }}
      >
        <span>Tip: Arrow keys + Enter selects. Esc clears filters.</span>
        {allowNone ? <span>Click “None” to clear selection.</span> : null}
      </div>
    </section>
  );
}
