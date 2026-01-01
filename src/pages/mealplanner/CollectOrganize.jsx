// C:\Users\larho\suka-smart-assistant\src\pages\MealPlanning\CollectOrganize.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * CollectOrganize.jsx — Meal Planning Intake + Organization Hub
 * --------------------------------------------------------------------------------
 * Goals it serves in your system:
 *  - Central "Inbox" to COLLECT recipes from: URL, paste, image (OCR), file, drag-drop.
 *  - ORGANIZE quickly: tag, de-dupe, bucket to Collections, or send to Batch Queue.
 *  - Integrates with: Recipe Vault, BatchSessionLinker, GroceryListPanel, Inventory map.
 *  - Torah Profile guards (Sabbath hands-off banner, shellfish filter hint).
 *  - NBA bar: suggests the next best action ("Link to Batch Session" or "Open Vault").
 *  - Undo pattern for destructive actions.
 *  - Defensive wiring to your event bus, automation runtime, and stores.
 *
 * UI patterns borrowed from well-executed sites:
 *  - Gmail-like triage: Inbox → Quick actions → Archive/Collections
 *  - Notion-like tags, inline editing, and Kanban toggle
 *  - Pinterest-like capture from URL & image drop
 *
 * Soft dependencies (all optional; guarded):
 *  - eventBus (on/off/emit) "@/services/eventBus"
 *  - automation runtime "@/services/automation/runtime" (emitProgress, record)
 *  - stores "@/store/RecipeStore", "@/store/PreferencesStore"
 *  - utils "@/utils/css", "@/utils/format"
 */

// --------------------------- Defensive imports ---------------------------
let eventBus = { on: () => {}, off: () => {}, emit: () => {} };
try {
  eventBus = require("@/services/eventBus").eventBus || eventBus;
} catch {}

let automation = {};
let emitProgress = () => {};
try {
  const rt = require("@/services/automation/runtime");
  automation = rt.automation ?? {};
  emitProgress = rt.emitProgress ?? (() => {});
} catch {}

let RecipeStore = {};
try {
  RecipeStore = require("@/store/RecipeStore");
} catch {}

let PreferencesStore = {};
try {
  PreferencesStore = require("@/store/PreferencesStore");
} catch {}

let css = { cx: (...a) => a.filter(Boolean).join(" ") };
try {
  css = { cx: require("@/utils/css").classNames || ((...a) => a.filter(Boolean).join(" ")) };
} catch {}

let fmt = {
  duration: (min) => `${Math.round(min)} min`,
};
try {
  fmt = { ...fmt, ...(require("@/utils/format")) };
} catch {}

let useBatchQueue = () => ({ queue: [], add: () => {}, clear: () => {} });
try {
  useBatchQueue = require("@/context/BatchQueueContext").useBatchQueue;
} catch {}

// --------------------------- Helpers & Guards ---------------------------
const nowIso = () => new Date().toISOString();
const uid = (p = "r") => `${p}_${Math.random().toString(36).slice(2)}`;

const sabbathBlocked = (profile) => {
  const active = profile?.torahProfile?.sabbath?.isActive;
  const handsOff = profile?.torahProfile?.sabbath?.handsOffCooking === true;
  return !!(active && handsOff);
};

const normalizeCandidate = (raw) => {
  // Accept URL strings, raw HTML, or simple objects (from DnD)
  if (typeof raw === "string") {
    const s = raw.trim();
    if (/^https?:\/\//i.test(s)) {
      return { id: uid("in"), type: "url", url: s, title: "", tags: [], status: "new", at: nowIso() };
    }
    return { id: uid("in"), type: "text", text: s, title: "", tags: [], status: "new", at: nowIso() };
  }
  if (raw && typeof raw === "object") {
    // Possibly {type:"RECIPE_CARD", data:{...}}
    const base = raw.data || raw;
    return {
      id: base.id || uid("in"),
      type: base.type || "recipe",
      title: base.title || base.name || "",
      url: base.url || "",
      ingredients: base.ingredients || [],
      steps: base.steps || [],
      tags: Array.isArray(base.tags) ? base.tags : [],
      status: "new",
      at: nowIso(),
    };
  }
  return null;
};

const removeDupes = (items) => {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const key = (it.url && it.url.toLowerCase()) || (it.title && it.title.toLowerCase()) || it.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
};

// Heuristic tagger (very light)
const autoTag = (item) => {
  const t = new Set(item.tags || []);
  const src = ((item.title || "") + " " + (item.text || "")).toLowerCase();
  if (/lamb|mutton|doner/.test(src)) t.add("lamb");
  if (/goat/.test(src)) t.add("goat");
  if (/chicken/.test(src)) t.add("chicken");
  if (/breakfast|oatmeal|waffle|yogurt/.test(src)) t.add("breakfast");
  if (/snack|granola|bar|yogurt/.test(src)) t.add("snack");
  if (/salad|greens|veg|vegetable|broccoli|kale/.test(src)) t.add("veg-forward");
  return [...t];
};

// Shellfish hint (do not strip here; we only flag for user to decide)
const hasShellfishHint = (item) => {
  const src = [
    item?.title,
    (item?.ingredients || []).map((i) => i?.name).join(" "),
    item?.text,
    item?.url,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /(shrimp|prawn|crab|lobster|clam|oyster|mussel|shellfish)/i.test(src);
};

// Fake OCR / scraper stubs (emit to your workers if available)
const requestScrapeFromUrl = async (url) => {
  emitProgress?.({ id: "recipe.scrape", at: nowIso(), message: `Scraping ${url}...` });
  eventBus.emit("recipe.scrape.requested", { at: nowIso(), url });
  // fallback minimal card
  return {
    id: uid("rx"),
    type: "recipe",
    title: url.replace(/^https?:\/\//, "").slice(0, 42),
    url,
    tags: [],
    status: "fetched",
    at: nowIso(),
  };
};

const requestOcrFromImage = async (file) => {
  emitProgress?.({ id: "recipe.ocr", at: nowIso(), message: `OCR scanning ${file?.name || "image"}...` });
  eventBus.emit("recipe.ocr.requested", { at: nowIso(), fileName: file?.name });
  // fallback minimal card
  return {
    id: uid("rx"),
    type: "text",
    title: file?.name || "Scanned image",
    text: "Detected: ingredients and steps (placeholder)",
    tags: ["scan"],
    status: "fetched",
    at: nowIso(),
  };
};

// --------------------------- Minimal UI primitives ---------------------------
const cx = css.cx;
const Button = ({ variant = "default", size = "md", className, ...props }) => {
  const variants = {
    default: "bg-blue-600 text-white hover:bg-blue-700",
    outline: "border border-zinc-300 hover:bg-zinc-50",
    ghost: "hover:bg-zinc-100",
    danger: "bg-red-600 text-white hover:bg-red-700",
    secondary: "bg-zinc-900 text-white hover:bg-zinc-800",
  };
  const sizes = { sm: "h-8 px-2", md: "h-10 px-3", icon: "h-9 w-9 p-0" };
  return <button className={cx("rounded-md text-sm", variants[variant], sizes[size], className)} {...props} />;
};
const Card = ({ className, ...props }) => <div className={cx("rounded-xl border bg-white shadow-sm", className)} {...props} />;
const CardHeader = ({ className, ...props }) => <div className={cx("px-4 pt-4", className)} {...props} />;
const CardTitle = ({ className, ...props }) => <div className={cx("text-lg font-semibold", className)} {...props} />;
const CardContent = ({ className, ...props }) => <div className={cx("px-4 pb-4", className)} {...props} />;
const Input = (p) => <input className={cx("h-9 w-full rounded-md border border-zinc-300 px-3 text-sm")} {...p} />;
const Badge = ({ children, tone = "zinc" }) => (
  <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs border border-${tone}-300 bg-${tone}-50 text-${tone}-800`}>
    {children}
  </span>
);

// --------------------------- Component ---------------------------
export default function CollectOrganize() {
  const fileInputRef = useRef(null);
  const pasteRef = useRef(null);
  const { add: addToBatch } = useBatchQueue();

  const [prefs, setPrefs] = useState(() => {
    try {
      return PreferencesStore?.getPreferences?.() || {};
    } catch {
      return {};
    }
  });

  const [inbox, setInbox] = useState([]); // candidate items (url/text/recipe)
  const [collections, setCollections] = useState(() => [
    { id: "c_quick", name: "Quick Weeknight", items: [] },
    { id: "c_batch", name: "Batch Friendly", items: [] },
    { id: "c_breakfasts", name: "Breakfasts", items: [] },
  ]);
  const [query, setQuery] = useState("");
  const [kanban, setKanban] = useState(false);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [undoStack, setUndoStack] = useState([]);

  const isSabbath = sabbathBlocked(prefs);

  // --------------------------- Inbox intake ---------------------------
  const addCandidate = useCallback((raw) => {
    const norm = normalizeCandidate(raw);
    if (!norm) return;
    norm.tags = autoTag(norm);
    norm.shellfishHint = hasShellfishHint(norm);
    setInbox((xs) => removeDupes([norm, ...xs]));
  }, []);

  const handleAddUrl = async (url) => {
    if (!url || !/^https?:\/\//i.test(url)) return;
    setBusy(true);
    try {
      const card = await requestScrapeFromUrl(url);
      addCandidate(card);
      setToast({ type: "success", msg: "Imported from URL." });
    } finally {
      setBusy(false);
    }
  };

  const handlePaste = (e) => {
    const text = e?.clipboardData?.getData("text");
    if (text) addCandidate(text);
  };

  const handleFilePick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const card = await requestOcrFromImage(file);
    addCandidate(card);
    e.target.value = "";
    setToast({ type: "info", msg: "Image scanned. Review and tag." });
  };

  // Drag-and-drop intake (URL, RECIPE_CARD JSON, plain text)
  useEffect(() => {
    const el = pasteRef.current;
    if (!el) return;
    const prevent = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    const onDrop = async (ev) => {
      prevent(ev);
      const dt = ev.dataTransfer;
      try {
        if (dt.files && dt.files.length) {
          const file = dt.files[0];
          const card = await requestOcrFromImage(file);
          addCandidate(card);
          return;
        }
        const text = dt.getData("text/plain");
        if (text) {
          try {
            const obj = JSON.parse(text);
            if (obj?.type === "RECIPE_CARD") {
              addCandidate(obj);
            } else {
              addCandidate(text);
            }
          } catch {
            addCandidate(text);
          }
        }
      } catch {}
    };
    ["dragenter", "dragover", "dragleave", "drop"].forEach((t) => el.addEventListener(t, t === "drop" ? onDrop : prevent));
    return () => {
      ["dragenter", "dragover", "dragleave", "drop"].forEach((t) =>
        el.removeEventListener(t, t === "drop" ? onDrop : prevent)
      );
    };
  }, [addCandidate]);

  // --------------------------- Global listeners ---------------------------
  useEffect(() => {
    const refreshPrefs = () => {
      try {
        setPrefs(PreferencesStore?.getPreferences?.() || {});
      } catch {}
    };
    const handlers = [
      ["preferences.changed", refreshPrefs],
      ["recipe.scrape.completed", (p) => p?.card && addCandidate(p.card)],
      ["recipe.ocr.completed", (p) => p?.card && addCandidate(p.card)],
    ];
    handlers.forEach(([e, fn]) => eventBus.on(e, fn));
    return () => handlers.forEach(([e, fn]) => eventBus.off(e, fn));
  }, [addCandidate]);

  // --------------------------- Actions ---------------------------
  const quickSweep = () => {
    // De-dupe + auto-tag everything; update status
    setInbox((xs) => {
      const tagged = xs.map((x) => ({ ...x, tags: autoTag(x), status: x.status === "new" ? "review" : x.status }));
      return removeDupes(tagged);
    });
    setToast({ type: "info", msg: "Quick sweep completed: de-dupliced & tagged." });
  };

  const sendToBatchQueue = (item) => {
    try {
      addToBatch?.({ ...item, from: "CollectOrganize" });
      eventBus.emit("batch.queue.added", { at: nowIso(), recipe: item });
      setToast({ type: "success", msg: "Sent to Batch Queue." });
    } catch {
      setToast({ type: "error", msg: "Could not add to Batch Queue." });
    }
  };

  const archiveToVault = (item) => {
    // Save/minimal upsert into RecipeStore then remove from inbox
    try {
      RecipeStore?.upsert?.({
        id: item.id,
        title: item.title || item.url || "Untitled",
        url: item.url,
        tags: item.tags || [],
        ingredients: item.ingredients || [],
        steps: item.steps || [],
        createdAt: item.at,
      });
      setUndoStack((s) => [...s, { type: "archive", payload: item }]);
      setInbox((xs) => xs.filter((x) => x.id !== item.id));
      setToast({ type: "success", msg: "Saved to Recipe Vault.", actionLabel: "Undo", onAction: () => undo() });
      eventBus.emit("recipe.vault.updated", { at: nowIso(), id: item.id });
    } catch {
      setToast({ type: "error", msg: "Could not save to Recipe Vault." });
    }
  };

  const deleteFromInbox = (item) => {
    setUndoStack((s) => [...s, { type: "delete", payload: item }]);
    setInbox((xs) => xs.filter((x) => x.id !== item.id));
    setToast({ type: "info", msg: "Removed from Inbox.", actionLabel: "Undo", onAction: () => undo() });
  };

  const addToCollection = (item, collectionId) => {
    setCollections((cols) =>
      cols.map((c) => (c.id === collectionId ? { ...c, items: removeDupes([item, ...c.items]) } : c))
    );
    setToast({ type: "success", msg: `Added to ${collections.find((c) => c.id === collectionId)?.name || "Collection"}.` });
  };

  const createCollection = () => {
    const name = typeof window !== "undefined" ? window.prompt("Collection name:") : "";
    if (!name) return;
    const col = { id: uid("col"), name, items: [] };
    setCollections((xs) => [...xs, col]);
    setToast({ type: "success", msg: `Collection "${name}" created.` });
  };

  const undo = () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((s) => s.slice(0, -1));
    if (last.type === "delete") {
      setInbox((xs) => [last.payload, ...xs]);
    } else if (last.type === "archive") {
      // Remove from vault if store supports, then restore to inbox
      try {
        RecipeStore?.remove?.(last.payload.id);
      } catch {}
      setInbox((xs) => [last.payload, ...xs]);
    }
  };

  const importAllToVault = () => {
    if (!inbox.length) return;
    inbox.forEach(archiveToVault);
  };

  // --------------------------- Derived ---------------------------
  const filteredInbox = useMemo(() => {
    if (!query) return inbox;
    const q = query.toLowerCase();
    return inbox.filter(
      (x) =>
        x.title?.toLowerCase().includes(q) ||
        x.url?.toLowerCase().includes(q) ||
        (x.tags || []).some((t) => `${t}`.toLowerCase().includes(q))
    );
  }, [inbox, query]);

  const nba = useMemo(() => {
    if (filteredInbox.length > 0) {
      return { label: "Link to Batch Session", action: () => eventBus.emit("ui.open", { panel: "BatchSessionLinker" }) };
    }
    return { label: "Open Recipe Vault", action: () => eventBus.emit("ui.open", { panel: "RecipeVault" }) };
  }, [filteredInbox.length]);

  // --------------------------- Render shards ---------------------------
  const Toast = () =>
    toast ? (
      <div
        className={cx(
          "fixed bottom-4 right-4 z-50 max-w-sm rounded-xl px-4 py-3 shadow-lg text-white",
          toast.type === "success" && "bg-green-600",
          toast.type === "info" && "bg-zinc-900",
          toast.type === "error" && "bg-red-600"
        )}
      >
        <div className="text-sm">{toast.msg}</div>
        {toast.actionLabel && toast.onAction ? (
          <button
            className="mt-2 rounded-lg border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
            onClick={toast.onAction}
          >
            {toast.actionLabel}
          </button>
        ) : null}
      </div>
    ) : null;

  const InboxItem = ({ item }) => {
    const badgeList = (
      <div className="flex flex-wrap gap-1">
        {item.shellfishHint && <Badge tone="amber">shellfish?</Badge>}
        {(item.tags || []).slice(0, 4).map((t) => (
          <Badge key={t}>{t}</Badge>
        ))}
      </div>
    );
    return (
      <li className="rounded-2xl border p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{item.title || item.url || "Untitled"}</div>
            <div className="text-xs text-zinc-500">{item.url || item.text?.slice(0, 140) || "—"}</div>
            <div className="mt-2">{badgeList}</div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => eventBus.emit("ui.open", { panel: "RecipeEdit", id: item.id, initial: item })}
              >
                Edit
              </Button>
              <Button variant="outline" size="sm" onClick={() => archiveToVault(item)}>
                Save
              </Button>
              <Button variant="outline" size="sm" onClick={() => sendToBatchQueue(item)}>
                Batch
              </Button>
              <Button variant="outline" size="sm" onClick={() => deleteFromInbox(item)}>
                Remove
              </Button>
            </div>
            <div className="flex gap-2">
              <select
                className="h-8 rounded-md border border-zinc-300 bg-white px-2 text-xs"
                onChange={(e) => e.target.value && addToCollection(item, e.target.value)}
                defaultValue=""
              >
                <option value="" disabled>
                  Add to Collection…
                </option>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <Button variant="ghost" size="sm" onClick={createCollection}>
                + New
              </Button>
            </div>
          </div>
        </div>
      </li>
    );
  };

  return (
    <section className="flex flex-col gap-4" ref={pasteRef} onPaste={handlePaste}>
      {/* Toast */}
      <Toast />

      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded bg-zinc-900" />
          <h2 className="text-xl font-semibold">Collect & Organize</h2>
          {isSabbath && <Badge tone="violet">Sabbath hands-off</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <Input placeholder="Search collected…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Button variant="outline" size="sm" onClick={() => setKanban((v) => !v)}>
            {kanban ? "List View" : "Kanban View"}
          </Button>
          {nba && (
            <Button variant="secondary" size="sm" onClick={nba.action}>
              {nba.label}
            </Button>
          )}
        </div>
      </div>

      {/* Intake actions */}
      <Card>
        <CardContent className="py-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-12">
            <div className="md:col-span-5">
              <div className="text-sm font-semibold">Add from URL</div>
              <div className="mt-2 flex gap-2">
                <Input
                  placeholder="https://example.com/recipe"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleAddUrl(e.currentTarget.value);
                  }}
                />
                <Button onClick={(e) => handleAddUrl(e.currentTarget.previousSibling.value)} disabled={busy}>
                  Import
                </Button>
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                We’ll scrape and create a recipe card. Drag a link onto this page, paste text, or drop images to OCR.
              </div>
            </div>

            <div className="md:col-span-4">
              <div className="text-sm font-semibold">Upload Image (OCR)</div>
              <div className="mt-2 flex gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="h-9 w-full cursor-pointer rounded-md border border-zinc-300 px-2 text-sm file:mr-2 file:rounded file:border-0 file:bg-zinc-900 file:px-3 file:py-1.5 file:text-sm file:text-white"
                  onChange={handleFilePick}
                />
              </div>
              <div className="mt-2 text-xs text-zinc-500">Photos of recipes or handwritten notes are fine.</div>
            </div>

            <div className="md:col-span-3">
              <div className="text-sm font-semibold">Bulk</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={quickSweep}
                  title="De-dupe & auto-tag"
                >
                  Quick Sweep
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={importAllToVault}
                  disabled={!inbox.length}
                  title="Save all to Recipe Vault"
                >
                  Save All
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => eventBus.emit("ui.open", { panel: "BatchSessionLinker" })}
                  title="Go link to batch"
                >
                  Link to Batch
                </Button>
              </div>
              <div className="mt-2 text-xs text-zinc-500">
                Use “Quick Sweep” first, then archive to the Vault or link to Batch.
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main: Inbox + Collections */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="lg:col-span-7">
          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle className="text-sm">Inbox</CardTitle>
              <div className="text-xs text-zinc-500">{filteredInbox.length} item(s)</div>
            </CardHeader>
            <CardContent>
              {filteredInbox.length === 0 ? (
                <div className="rounded-xl border border-dashed p-6 text-center text-sm text-zinc-600">
                  Drop a link, paste text, or upload an image to get started.{" "}
                  <button className="underline" onClick={() => eventBus.emit("ui.open", { panel: "RecipeVault" })}>
                    Or open Recipe Vault
                  </button>
                  .
                </div>
              ) : kanban ? (
                // Kanban buckets by quick heuristics
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {["breakfast", "veg-forward", "batch"].map((bucket) => {
                    const items = filteredInbox.filter((it) =>
                      bucket === "batch" ? true : (it.tags || []).includes(bucket)
                    );
                    return (
                      <div key={bucket} className="rounded-2xl border p-3">
                        <div className="mb-2 text-sm font-semibold capitalize">{bucket}</div>
                        <ul className="space-y-2">
                          {items.slice(0, 10).map((it) => (
                            <li key={it.id} className="rounded-xl border p-2">
                              <div className="truncate text-xs font-semibold">{it.title || it.url || "Untitled"}</div>
                              <div className="mt-1 flex gap-1">
                                <Button variant="outline" size="sm" onClick={() => archiveToVault(it)}>
                                  Save
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => sendToBatchQueue(it)}>
                                  Batch
                                </Button>
                              </div>
                            </li>
                          ))}
                        </ul>
                        {items.length === 0 && (
                          <div className="rounded border border-dashed p-3 text-center text-xs text-zinc-500">Empty</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <ul className="space-y-2">
                  {filteredInbox.map((item) => (
                    <InboxItem key={item.id} item={item} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="lg:col-span-5">
          <Card>
            <CardHeader className="flex items-center justify-between">
              <CardTitle className="text-sm">Collections</CardTitle>
              <Button variant="outline" size="sm" onClick={createCollection}>
                + New Collection
              </Button>
            </CardHeader>
            <CardContent>
              {collections.length === 0 ? (
                <div className="rounded-xl border border-dashed p-6 text-center text-sm text-zinc-600">
                  No collections yet. Create one to group recipes by theme or session.
                </div>
              ) : (
                <ul className="space-y-3">
                  {collections.map((c) => (
                    <li key={c.id} className="rounded-2xl border p-3">
                      <div className="mb-1 flex items-center justify-between">
                        <div className="text-sm font-semibold">{c.name}</div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              eventBus.emit("ui.open", {
                                panel: "BatchSessionLinker",
                                seed: c.items,
                              })
                            }
                          >
                            Link as Batch
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              eventBus.emit("grocerylist.requested", {
                                at: nowIso(),
                                context: "collection",
                                items: c.items.flatMap((x) => x.ingredients || []),
                                recipes: c.items,
                              })
                            }
                          >
                            Grocery List
                          </Button>
                        </div>
                      </div>
                      <div className="text-xs text-zinc-500">{c.items.length} item(s)</div>
                      {c.items.length ? (
                        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                          {c.items.slice(0, 8).map((r) => (
                            <li key={r.id} className="rounded-xl border p-2">
                              <div className="truncate text-xs font-semibold">{r.title || r.url || "Untitled"}</div>
                              <div className="mt-1 flex gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => eventBus.emit("ui.open", { panel: "RecipeDetail", id: r.id })}
                                >
                                  View
                                </Button>
                                <Button variant="outline" size="sm" onClick={() => sendToBatchQueue(r)}>
                                  Batch
                                </Button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="mt-2 rounded border border-dashed p-3 text-center text-xs text-zinc-500">
                          Empty — add from Inbox.
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Footer helpers */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-zinc-500">
          Paste text or drop links/images anywhere on this page. We’ll try to auto-detect and tag.
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => eventBus.emit("ui.open", { panel: "RecipeVault" })}>
            Open Recipe Vault
          </Button>
          <Button variant="secondary" size="sm" onClick={() => eventBus.emit("ui.open", { panel: "BatchSessionLinker" })}>
            Go to Batch Session
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => eventBus.emit("ui.open", { panel: "GroceryListPanel" })}
          >
            Grocery List
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => eventBus.emit("ui.open", { panel: "BatchInventoryMap" })}
          >
            Inventory Map
          </Button>
        </div>
      </div>
    </section>
  );
}

/* --------------------------- Lightweight TESTS --------------------------- */
(function runCollectOrganizeTestsOnce() {
  if (typeof window === "undefined") return;
  if (window.__COLLECT_ORG_TESTS__) return;
  window.__COLLECT_ORG_TESTS__ = true;

  const expect = (cond, msg) => (cond ? console.log("[CollectOrganize TEST PASS]", msg) : console.error("[CollectOrganize TEST FAIL]", msg));

  // Normalize candidate (URL)
  const a = normalizeCandidate("https://example.com/x");
  expect(a && a.type === "url" && a.url.includes("example.com"), "normalizeCandidate handles URL");

  // De-dupe
  const list = removeDupes([
    { id: "1", url: "https://a.com" },
    { id: "2", url: "https://a.com" },
    { id: "3", title: "Same" },
    { id: "4", title: "same" },
  ]);
  expect(list.length === 2, "removeDupes collapses same url/title");

  // Auto tag
  const b = autoTag({ title: "Lamb Doner Bowl with Greens" });
  expect(b.includes("lamb") && b.includes("veg-forward"), "autoTag adds lamb + veg-forward");
})();
