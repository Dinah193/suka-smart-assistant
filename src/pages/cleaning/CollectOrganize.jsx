/* eslint-disable no-console */
// src/components/collect/CollectOrganize.jsx
//
// CollectOrganize — source imports (checklists, websites, videos, PDFs, images, docs)
// ------------------------------------------------------------------------------
// Goals aligned with Suka Smart Assistant:
// • Fast capture from *anywhere*: paste URLs (multi-line), drag-drop files, quick checklist maker
// • Auto-classify (type: pdf, video, article, image, doc, checklist) + tag suggestions
// • Dedupe + merge (by normalized URL/filename) with safe metadata merging
// • Select → “Send to” (Recipe Vault, Task Plan, Docs Vault, Garden/Animal knowledge, etc.)
// • Source attribution preserved (url, author, channel, site)
// • Bulk edit tags/collections, quick filters, and simple previews
// • Defensive against missing services; emits events for downstream modules
//
// Inspiration: Notion Web Clipper, Raindrop.io, Readwise, Linear’s crisp batch UI

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

// -------------------- Defensive imports (contexts/services) --------------------
let eventBus;
try {
  eventBus = require("../../services/eventBus").default;
} catch {
  eventBus = {
    emit: (...args) => console.debug("[CollectOrganize:eventBus.emit]", ...args),
    on: () => () => {},
  };
}

let useMilestoneState;
try {
  useMilestoneState = require("../../app/hooks/useMilestoneState").default;
} catch {
  useMilestoneState = () => ({ recordMilestone: () => {} });
}

let SettingsContext;
try {
  SettingsContext = require("../context/SettingsContext").SettingsContext;
} catch {
  SettingsContext = React.createContext({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sabbathGuard: false,
    sabbathWindow: { startDow: 5, startHour: 18, endDow: 6, endHour: 19 },
  });
}

// Optional helpers if you created these elsewhere in the project:
let TaggingAutoClassifier = { inferTags: (obj) => [] };
try {
  TaggingAutoClassifier = require("../../engines/metadata/taggingAutoClassifier").default;
} catch { /* noop */ }

let CollectionsPicker; // optional nice picker
try {
  CollectionsPicker = require("../meals/collector/CollectionsPicker").default;
} catch {
  CollectionsPicker = ({ value, onChange }) => (
    <input
      value={value || ""}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder="Collection name…"
      className="w-full rounded-xl border px-3 py-2 text-sm"
    />
  );
}

let SendToMenu; // optional “send to” menu already used in Meals Collector
try {
  SendToMenu = require("../meals/collector/SendToMenu").default;
} catch {
  SendToMenu = ({ onSend }) => (
    <button
      type="button"
      onClick={() => onSend?.("docsVault")}
      className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
      title="Send to destination"
    >
      Send to…
    </button>
  );
}

// -------------------- Helpers --------------------
const TYPE_ICONS = {
  article: "📰",
  video: "▶️",
  pdf: "📄",
  image: "🖼️",
  doc: "📄",
  checklist: "✅",
  unknown: "📎",
};

const URL_HOST = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, "");
  } catch {
    return "";
  }
};

const normalizeUrl = (u) => {
  try {
    const url = new URL(u);
    url.hash = "";
    if (url.searchParams && url.searchParams.toString().includes("utm_")) {
      // strip common trackers
      ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((k) =>
        url.searchParams.delete(k)
      );
    }
    return url.toString();
  } catch {
    return (u || "").trim();
  }
};

const guessTypeFromUrl = (u) => {
  const s = String(u || "").toLowerCase();
  if (/youtube\.com|youtu\.be/.test(s)) return "video";
  if (s.endsWith(".pdf")) return "pdf";
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(s)) return "image";
  if (/\.(docx?|pptx?|xlsx?)$/.test(s)) return "doc";
  return "article";
};

const guessTypeFromFile = (name = "", type = "") => {
  const s = name.toLowerCase();
  if (type.includes("pdf") || s.endsWith(".pdf")) return "pdf";
  if (type.includes("image") || /\.(png|jpe?g|gif|webp|svg)$/.test(s)) return "image";
  if (type.includes("video") || /\.(mp4|mov|mkv|webm)$/.test(s)) return "video";
  if (/\.(docx?|pptx?|xlsx?)$/.test(s)) return "doc";
  return "doc";
};

const withinSabbath = (now = new Date(), window = { startDow: 5, startHour: 18, endDow: 6, endHour: 19 }) => {
  const dow = now.getDay();
  const hr = now.getHours();
  if (dow === window.startDow && hr >= window.startHour) return true;
  if (dow === window.endDow && hr < window.endHour) return true;
  return false;
};

const dedupeMerge = (arr) => {
  const map = new Map();
  for (const it of arr) {
    const key = it.url ? `u:${normalizeUrl(it.url)}` : `f:${(it.filename || it.title || "").toLowerCase()}`;
    if (!map.has(key)) {
      map.set(key, { ...it, tags: [...new Set(it.tags || [])] });
      continue;
    }
    const prev = map.get(key);
    map.set(key, {
      ...prev,
      title: prev.title || it.title,
      author: prev.author || it.author,
      channel: prev.channel || it.channel,
      site: prev.site || it.site,
      type: prev.type !== "unknown" ? prev.type : it.type,
      collection: prev.collection || it.collection,
      notes: prev.notes || it.notes,
      tags: [...new Set([...(prev.tags || []), ...(it.tags || [])])],
      // keep both file references if they differ
      file: prev.file || it.file,
    });
  }
  return Array.from(map.values());
};

const inferTags = (item) => {
  try {
    const inferred = TaggingAutoClassifier.inferTags?.(item) || [];
    return inferred.slice(0, 6);
  } catch {
    return [];
  }
};

// -------------------- Component --------------------
export default function CollectOrganize({
  initialItems = [], // Optional: preloaded sources
  defaultCollection = "",
  allowSabbathCapture = true, // capturing notes is allowed; “send to” may be blocked by your app if desired
  onSend, // optional override for send flow: (items, destination, options) => void
}) {
  const { sabbathGuard, sabbathWindow } = React.useContext(SettingsContext);
  const { recordMilestone } = useMilestoneState();

  const [urlsText, setUrlsText] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [items, setItems] = useState(() => dedupeMerge(initialItems));
  const [query, setQuery] = useState("");
  const [collection, setCollection] = useState(defaultCollection);
  const [selected, setSelected] = useState(() => new Set());
  const [filters, setFilters] = useState(() => new Set(["article", "video", "pdf", "image", "doc", "checklist"]));
  const [bulkTags, setBulkTags] = useState("");
  const [newChecklist, setNewChecklist] = useState({ title: "", lines: "" });

  // Listen for external captures (e.g., from a browser extension / bookmarklet emulation)
  useEffect(() => {
    const off = eventBus.on?.("collect.capture", (payload) => {
      if (!payload) return;
      const captured = (Array.isArray(payload) ? payload : [payload]).map(normalizeIncoming);
      addItems(captured);
      recordMilestone?.({ key: "collect_capture", meta: { count: captured.length } });
    });
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disabledBySabbath = sabbathGuard && withinSabbath(new Date(), sabbathWindow) && !allowSabbathCapture;

  function normalizeIncoming(x) {
    // Shape target:
    // { id, type, title, url, site, author, channel, filename, file, tags[], notes, collection, createdAt }
    const base = {
      id: x.id || cryptoSafeId(),
      title: x.title || x.filename || "Untitled",
      tags: Array.isArray(x.tags) ? x.tags : [],
      notes: x.notes || "",
      collection: x.collection || collection || "",
      createdAt: x.createdAt || new Date().toISOString(),
    };
    if (x.url) {
      const t = x.type || guessTypeFromUrl(x.url);
      return {
        ...base,
        url: normalizeUrl(x.url),
        site: x.site || URL_HOST(x.url),
        type: t,
        author: x.author || "",
        channel: x.channel || (t === "video" ? URL_HOST(x.url) : ""),
      };
    }
    if (x.file || x.filename) {
      return {
        ...base,
        filename: x.filename || (x.file?.name ?? "file"),
        file: x.file || null,
        type: x.type || guessTypeFromFile(x.filename || "", x.file?.type || ""),
      };
    }
    if (x.type === "checklist") {
      return { ...base, type: "checklist", items: Array.isArray(x.items) ? x.items : [] };
    }
    return { ...base, type: "unknown" };
  }

  const addItems = (arr) => {
    setItems((prev) => dedupeMerge([...(prev || []), ...arr]));
  };

  // -------- Paste URLs (multi-line) --------
  const handleAddUrls = useCallback(() => {
    if (!urlsText.trim()) return;
    const lines = urlsText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const normalized = lines.map((u) =>
      normalizeIncoming({
        url: u,
        type: guessTypeFromUrl(u),
        title: "",
        tags: inferTags({ url: u }),
      })
    );
    addItems(normalized);
    setUrlsText("");
    recordMilestone?.({ key: "collect_add_urls", meta: { count: normalized.length } });
  }, [urlsText]);

  // -------- Drag & Drop Files --------
  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);

      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) return;

      const mapped = files.map((f) =>
        normalizeIncoming({
          file: f,
          filename: f.name,
          type: guessTypeFromFile(f.name, f.type),
          tags: inferTags({ filename: f.name, type: f.type }),
        })
      );
      addItems(mapped);
      recordMilestone?.({ key: "collect_drop_files", meta: { count: mapped.length } });
    },
    [setDragActive]
  );
  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!dragActive) setDragActive(true);
  };
  const onDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };

  // -------- New checklist --------
  const handleCreateChecklist = useCallback(() => {
    if (!newChecklist.title.trim()) return;
    const lines = newChecklist.lines
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const item = normalizeIncoming({
      type: "checklist",
      title: newChecklist.title.trim(),
      items: lines,
      tags: inferTags({ title: newChecklist.title }),
    });
    addItems([item]);
    setNewChecklist({ title: "", lines: "" });
    recordMilestone?.({ key: "collect_new_checklist", meta: { count: lines.length } });
  }, [newChecklist]);

  // -------- Selection & bulk ops --------
  const toggleSelect = (id) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const selectAll = () => setSelected(new Set(items.map((i) => i.id)));
  const clearSelection = () => setSelected(new Set());

  const applyBulkTags = () => {
    const tags = bulkTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tags.length || selected.size === 0) return;
    setItems((prev) =>
      prev.map((i) => (selected.has(i.id) ? { ...i, tags: [...new Set([...(i.tags || []), ...tags])] } : i))
    );
    setBulkTags("");
  };

  const applyBulkCollection = (val) => {
    if (!val || selected.size === 0) return;
    setItems((prev) => prev.map((i) => (selected.has(i.id) ? { ...i, collection: val } : i)));
    setCollection(val);
  };

  const removeSelected = () => {
    if (selected.size === 0) return;
    setItems((prev) => prev.filter((i) => !selected.has(i.id)));
    setSelected(new Set());
  };

  // -------- Filters / search --------
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items || []).filter((i) => {
      if (filters.size && !filters.has(i.type || "unknown")) return false;
      if (!q) return true;
      const hay = [
        i.title,
        i.url,
        i.site,
        i.author,
        i.channel,
        i.filename,
        i.collection,
        ...(i.tags || []),
        i.notes,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [items, query, filters]);

  // -------- Send to… (emit events) --------
  const handleSend = (destination) => {
    const chosen = items.filter((i) => selected.has(i.id));
    if (!chosen.length) return;

    // Fallback emit if no external handler is passed
    if (onSend) onSend(chosen, destination, { collection });
    else {
      eventBus.emit("library.addSources", {
        items: chosen,
        destination, // e.g., "docsVault" | "recipeVault" | "taskPlan" | "gardenKnowledge" | "animalKnowledge"
        opts: { collection },
      });
      // Helpful UI nav cues
      eventBus.emit("ui.navigate", { panel: "LibraryPanel", destination });
      eventBus.emit("ui.toast", {
        variant: "success",
        message: `Sent ${chosen.length} item(s) to ${prettyDestination(destination)}`,
      });
    }

    recordMilestone?.({ key: "collect_send_to", meta: { count: chosen.length, destination } });
    clearSelection();
  };

  // -------------------- Render --------------------
  const TYPE_ORDER = ["article", "video", "pdf", "image", "doc", "checklist", "unknown"];

  return (
    <div className="w-full max-w-7xl mx-auto p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Collect & Organize</h1>
          <p className="text-gray-600">
            Paste links, drop files, or make checklists. Tag, organize, and send to your vaults and planners.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title, tags, site, file, notes…"
              className="w-72 rounded-xl border px-3 py-2 text-sm"
            />
            <span className="absolute right-2 top-2 text-xs text-gray-400">/</span>
          </div>

          <div className="flex items-center gap-2">
            {TYPE_ORDER.map((t) => {
              const on = filters.has(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() =>
                    setFilters((f) => {
                      const n = new Set(f);
                      if (n.has(t)) n.delete(t);
                      else n.add(t);
                      return n;
                    })
                  }
                  className={[
                    "rounded-full border px-3 py-1.5 text-sm capitalize",
                    on ? "bg-gray-900 text-white border-black" : "bg-white hover:bg-gray-50",
                  ].join(" ")}
                  title={`Toggle ${t}`}
                >
                  {TYPE_ICONS[t] || "📎"} {t}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Capture Row */}
      <section className="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Paste URLs */}
        <div className="rounded-2xl border p-4">
          <h3 className="font-semibold">Paste links</h3>
          <p className="text-sm text-gray-600">One per line. We detect type (YouTube, PDFs, articles, images).</p>
          <textarea
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            placeholder="https://www.allrecipes.com/recipe/…&#10;https://youtu.be/…&#10;https://site.com/file.pdf"
            className="mt-2 w-full h-28 rounded-xl border px-3 py-2 text-sm"
          />
          <div className="mt-2 flex items-center justify-between">
            <CollectionsPicker value={collection} onChange={setCollection} />
            <button
              type="button"
              onClick={handleAddUrls}
              className="rounded-xl border border-black bg-gray-900 text-white px-3 py-2 text-sm hover:opacity-90 disabled:opacity-50"
              disabled={!urlsText.trim()}
            >
              Add URLs
            </button>
          </div>
        </div>

        {/* Drag & Drop Files */}
        <div
          className={[
            "rounded-2xl border p-4 transition",
            dragActive ? "ring-2 ring-black bg-gray-50" : "",
          ].join(" ")}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
        >
          <h3 className="font-semibold">Drop files</h3>
          <p className="text-sm text-gray-600">PDFs, images, videos, docs. We’ll infer a type.</p>
          <div className="mt-3 flex items-center justify-center rounded-xl border border-dashed p-8 text-sm text-gray-600">
            Drag files here…
          </div>
          <div className="mt-2">
            <CollectionsPicker value={collection} onChange={setCollection} />
          </div>
        </div>

        {/* Quick Checklist */}
        <div className="rounded-2xl border p-4">
          <h3 className="font-semibold">Make a checklist</h3>
          <input
            value={newChecklist.title}
            onChange={(e) => setNewChecklist((v) => ({ ...v, title: e.target.value }))}
            placeholder="Checklist title (e.g., 'Deep clean: kitchen')"
            className="mt-2 w-full rounded-xl border px-3 py-2 text-sm"
          />
          <textarea
            value={newChecklist.lines}
            onChange={(e) => setNewChecklist((v) => ({ ...v, lines: e.target.value }))}
            placeholder="- Clear counters&#10;- Degrease stove&#10;- Mop floor"
            className="mt-2 w-full h-24 rounded-xl border px-3 py-2 text-sm"
          />
          <div className="mt-2 flex items-center justify-between">
            <CollectionsPicker value={collection} onChange={setCollection} />
            <button
              type="button"
              onClick={handleCreateChecklist}
              className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
              disabled={!newChecklist.title.trim()}
            >
              Add checklist
            </button>
          </div>
        </div>
      </section>

      {/* Bulk tools */}
      <section className="mt-6 rounded-2xl border p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" onClick={selectAll} className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm">
            Select all
          </button>
          <button type="button" onClick={clearSelection} className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm">
            Clear
          </button>

          <div className="flex items-center gap-2 ml-auto">
            <input
              value={bulkTags}
              onChange={(e) => setBulkTags(e.target.value)}
              placeholder="Bulk add tags: comma,separated"
              className="w-64 rounded-xl border px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={applyBulkTags}
              className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
              disabled={!bulkTags.trim() || selected.size === 0}
            >
              Apply tags
            </button>

            <div className="w-56">
              <CollectionsPicker value={collection} onChange={applyBulkCollection} />
            </div>

            <SendToMenu
              onSend={(dest) => {
                if (disabledBySabbath) {
                  eventBus.emit("ui.toast", {
                    variant: "warning",
                    message: "Sabbath guard active: sending disabled until it ends.",
                  });
                  return;
                }
                handleSend(dest);
              }}
            />
            <button
              type="button"
              onClick={removeSelected}
              className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
              disabled={selected.size === 0}
              title="Remove selected from the staging area (does not delete from vaults)"
            >
              Remove
            </button>
          </div>
        </div>
      </section>

      {/* Items grid */}
      <section className="mt-6">
        {!filtered.length ? (
          <div className="rounded-2xl border border-dashed p-10 text-center text-gray-600">
            <div className="text-lg font-semibold">Nothing here yet.</div>
            <div className="mt-1">Paste a few links or drop files to get started.</div>
          </div>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map((it) => {
              const isSelected = selected.has(it.id);
              const type = it.type || "unknown";
              return (
                <li key={it.id} className="rounded-2xl border bg-white shadow-sm p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span title={type}>{TYPE_ICONS[type] || "📎"}</span>
                        <h3 className="font-semibold text-gray-900 truncate">
                          {it.title || it.filename || "Untitled"}
                        </h3>
                      </div>
                      <div className="mt-1 text-sm text-gray-600 flex flex-wrap gap-3">
                        {it.url ? (
                          <a
                            href={it.url}
                            target="_blank"
                            rel="noreferrer"
                            className="underline decoration-dotted hover:decoration-solid truncate"
                            title={it.url}
                          >
                            {it.site || URL_HOST(it.url)}
                          </a>
                        ) : it.filename ? (
                          <span className="truncate" title={it.filename}>
                            {it.filename}
                          </span>
                        ) : null}
                        {it.author ? <span>• {it.author}</span> : null}
                        {it.channel && !it.author ? <span>• {it.channel}</span> : null}
                        {it.collection ? <span>• 📁 {it.collection}</span> : null}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(it.id)}
                          aria-label="Select"
                        />
                        <span className="sr-only">Select</span>
                      </label>
                    </div>
                  </div>

                  {/* Quick tag editor */}
                  <div className="mt-2 flex flex-wrap gap-1">
                    {(it.tags || []).map((t) => (
                      <span
                        key={`${it.id}-tag-${t}`}
                        className="inline-flex items-center rounded-full bg-gray-50 text-gray-700 border px-2 py-0.5 text-xs"
                      >
                        #{t}
                      </span>
                    ))}
                    <TagAdder
                      onAdd={(tag) =>
                        setItems((prev) =>
                          prev.map((x) =>
                            x.id === it.id ? { ...x, tags: [...new Set([...(x.tags || []), tag])] } : x
                          )
                        )
                      }
                    />
                  </div>

                  {/* Notes */}
                  <textarea
                    value={it.notes || ""}
                    onChange={(e) =>
                      setItems((prev) =>
                        prev.map((x) => (x.id === it.id ? { ...x, notes: e.target.value } : x))
                      )
                    }
                    placeholder="Notes…"
                    className="mt-2 w-full rounded-xl border px-3 py-2 text-sm"
                  />

                  {/* Inline actions */}
                  <div className="mt-3 flex items-center justify-between">
                    <div className="text-xs text-gray-500">
                      {it.createdAt ? new Date(it.createdAt).toLocaleString() : ""}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(new Set([it.id]));
                          if (disabledBySabbath) {
                            eventBus.emit("ui.toast", {
                              variant: "warning",
                              message: "Sabbath guard active: sending disabled until it ends.",
                            });
                            return;
                          }
                          handleSend(defaultDestinationForType(type));
                        }}
                        className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-1.5 text-sm"
                        title="Quick send"
                      >
                        Quick send
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelected((s) => new Set([...s, it.id]))}
                        className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-1.5 text-sm"
                      >
                        Add to selection
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

// -------------------- Small subcomponents --------------------
function TagAdder({ onAdd }) {
  const [val, setVal] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const t = val.trim().replace(/\s+/g, "-");
        if (!t) return;
        onAdd?.(t);
        setVal("");
      }}
      className="inline-flex items-center gap-1"
    >
      <input
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder="+tag"
        className="w-20 rounded-lg border px-2 py-1 text-xs"
      />
    </form>
  );
}

// -------------------- Utils --------------------
function cryptoSafeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2, 10);
}

function prettyDestination(dest) {
  switch (dest) {
    case "recipeVault":
      return "Recipe Vault";
    case "taskPlan":
      return "Task Plan";
    case "docsVault":
      return "Docs Vault";
    case "gardenKnowledge":
      return "Garden Knowledge";
    case "animalKnowledge":
      return "Animal Knowledge";
    default:
      return dest;
  }
}

function defaultDestinationForType(type) {
  if (type === "article" || type === "pdf" || type === "doc") return "docsVault";
  if (type === "video") return "docsVault";
  if (type === "image") return "docsVault";
  if (type === "checklist") return "taskPlan";
  return "docsVault";
}

/**
 * Integration Notes:
 * • External capture:
 *     eventBus.emit("collect.capture", { url, title, tags, author, channel, site })   // single
 *     eventBus.emit("collect.capture", [ {...}, {...} ])                              // batch
 *
 * • Library ingest:
 *     // Fired by handleSend when no onSend prop supplied
 *     eventBus.emit("library.addSources", { items, destination, opts: { collection } })
 *     eventBus.emit("ui.navigate", { panel: "LibraryPanel", destination })
 *     eventBus.emit("ui.toast", { variant: "success", message: "Sent N item(s) to …" })
 *
 * • Tag suggestions:
 *     If you have engines/metadata/taggingAutoClassifier.js, expose default export with inferTags(item): string[]
 *
 * • Collections:
 *     Uses CollectionsPicker if available; falls back to simple input.
 *
 * • Dedupe:
 *     By normalized URL (UTM stripped, no hash) or filename. Safe merge of tags/fields.
 *
 * • Sabbath guard:
 *     Capturing is allowed by default (allowSabbathCapture=true), but “send to” can be blocked by app policy.
 *
 * • Extend:
 *     - Add a tiny previewer for PDFs/videos/images using object URLs (for files) or iframe (for articles, respecting CORS).
 *     - Add a “Clip to Recipe” action that routes recipe pages into your Recipe Scanner/Normalizer pipeline.
 *     - Add importers for Pinterest boards / Allrecipes lists by pasting profile/board URLs (emit collect.capture with parsed links).
 */
