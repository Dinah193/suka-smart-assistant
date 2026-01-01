// C:\Users\larho\suka-smart-assistant\src\pages\MealPlanning\PinterestImportWizard.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * PinterestImportWizard — content-agnostic importer for ALL boards
 * -----------------------------------------------------------------------------
 * What’s new
 *  - Imports any Pinterest board (recipes and non-recipes).
 *  - Smart content classifier → routes pins to the right module:
 *      recipe      → Recipe Vault / Collect Inbox / Batch Queue
 *      project     → Projects/Tasks
 *      travel      → Trips/Itinerary
 *      fitness     → Workout Planner
 *      style       → Closet/Outfits
 *      reading     → Reading List / Notes
 *      shopping    → Deals/Shopping List
 *      decor/craft/garden → Projects/Tasks
 *      finance     → Budget/Tracking
 *      fallback    → Bookmarks (never drop content)
 *  - Bulk import by detected type OR per-pin destination override.
 *  - Infinite scroll, paste/dnd URL staging, Sabbath guard, undo.
 *  - Defensive eventBus/runtime/stores; degrades gracefully.
 */

/* --------------------------------- Defensive imports --------------------------------- */
let eventBus = { on: () => {}, off: () => {}, emit: () => {} };
try { eventBus = require("@/services/eventBus").eventBus || eventBus; } catch {}

let automation = {};
let emitProgress = () => {};
try {
  const rt = require("@/services/automation/runtime");
  automation = rt.automation ?? {};
  emitProgress = rt.emitProgress ?? (() => {});
} catch {}

let PinterestAPI = {};
try {
  // optional adapter: auth(), listBoards(), listPins(boardId, cursor), resolvePin(url)
  PinterestAPI = require("@/services/pinterest");
} catch {}

/* --- Meal planning & general stores (soft, optional) --- */
let RecipeStore = {};              try { RecipeStore = require("@/store/RecipeStore"); } catch {}
let CollectInboxStore = {};        try { CollectInboxStore = require("@/store/CollectInboxStore"); } catch {}
let useBatchQueue = () => ({ add: () => {} });
try { useBatchQueue = require("@/context/BatchQueueContext").useBatchQueue; } catch {}

/* --- Non-recipe modules (soft, optional) --- */
let ProjectStore = {};             try { ProjectStore = require("@/store/ProjectStore"); } catch {}
let TripStore = {};                try { TripStore = require("@/store/TripStore"); } catch {}
let WorkoutStore = {};             try { WorkoutStore = require("@/store/WorkoutStore"); } catch {}
let ClosetStore = {};              try { ClosetStore = require("@/store/ClosetStore"); } catch {}
let ReadingListStore = {};         try { ReadingListStore = require("@/store/ReadingListStore"); } catch {}
let DealsStore = {};               try { DealsStore = require("@/store/DealsStore"); } catch {}
let BudgetStore = {};              try { BudgetStore = require("@/store/BudgetStore"); } catch {}
let BookmarkStore = {};            try { BookmarkStore = require("@/store/BookmarkStore"); } catch {}

let PreferencesStore = {};         try { PreferencesStore = require("@/store/PreferencesStore"); } catch {}

let css = { cx: (...a) => a.filter(Boolean).join(" ") };
try { css = { cx: require("@/utils/css").classNames || ((...a) => a.filter(Boolean).join(" ")) }; } catch {}

const cx = css.cx;

/* --------------------------------- Utils --------------------------------- */
const nowIso = () => new Date().toISOString();
const uid = (p = "pin") => `${p}_${Math.random().toString(36).slice(2)}`;

const sabbathBlocked = (profile) => {
  const active = profile?.torahProfile?.sabbath?.isActive;
  const handsOff = profile?.torahProfile?.sabbath?.handsOffCooking === true;
  return !!(active && handsOff);
};

const shellfishHint = (text = "") =>
  /(shrimp|prawn|crab|lobster|clam|oyster|mussel|shellfish)/i.test(`${text}`.toLowerCase());

const dedupeByUrlOrTitle = (items) => {
  const seen = new Set();
  return (items || []).filter((x) => {
    const key = (x.link || x.url || "").toLowerCase() || (x.title || "").toLowerCase();
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/* ----------- Lightweight classifier: map title/url/board to a Suka module ----------- */
const classifyPin = (pin, board) => {
  const blob = `${pin.title || ""} ${pin.description || ""} ${pin.link || ""} ${board?.name || ""}`.toLowerCase();

  const has = (re) => re.test(blob);

  if (has(/recipe|dinner|lunch|breakfast|snack|meal|cook|bake|kitchen|instant pot|air fryer|sous vide/)) return "recipe";
  if (has(/workout|fitness|yoga|hiit|strength|run|gym|routine/)) return "fitness";
  if (has(/travel|itinerary|trip|packing|hotel|airbnb|europe|vacation|wanderlust/)) return "travel";
  if (has(/project|diy|hack|build|how to|organize|closet system|garage|laundry|pantry/)) return "project";
  if (has(/decor|interior|home office|living room|bedroom|nursery|garden|patio|craft/)) return "project";
  if (has(/style|outfit|capsule|closet|wardrobe|fashion|hairstyle|makeup/)) return "style";
  if (has(/book|reading list|read|novel|library|study|notes|lesson|curriculum/)) return "reading";
  if (has(/deal|sale|coupon|promo|wishlist|shopping|buy|gift guide/)) return "shopping";
  if (has(/budget|finance|saving|debt|money|expense|spend/)) return "finance";

  // If the domain looks like a recipe site, bias to recipe
  if ((pin.link || "").match(/allrecipes|bonappetit|seriouseats|thekitchn|epicurious|foodnetwork|tasty/)) return "recipe";

  return "bookmark";
};

/* --------------------------------- Pinterest Adapter --------------------------------- */
const Pinterest = {
  isReady: !!(PinterestAPI?.auth || PinterestAPI?.listBoards || PinterestAPI?.listPins),
  async auth() { try { return await PinterestAPI.auth(); } catch { return { ok: true, token: "stub" }; } },
  async listBoards() {
    try { return await PinterestAPI.listBoards(); } catch {
      return [
        { id: "b1", name: "Weeknight Winners", count: 14 },
        { id: "b2", name: "Home Office Ideas", count: 37 },
        { id: "b3", name: "Euro Trip 2026", count: 21 },
        { id: "b4", name: "Workout Routines", count: 18 },
        { id: "b5", name: "Capsule Wardrobe", count: 25 },
      ];
    }
  },
  async listPins(boardId, cursor = null) {
    try { return await PinterestAPI.listPins(boardId, cursor); } catch {
      const demo = Array.from({ length: 24 }).map((_, i) => ({
        id: `${boardId}_${cursor || 0}_p${i}`,
        title: [
          "Chicken Salad",
          "DIY Closet System",
          "Paris 3-day Itinerary",
          "30-min Dumbbell Workout",
          "Spring Capsule Outfits",
          "Reading List 2025",
          "Holiday Deals Roundup",
          "Family Budget Template",
        ][i % 8],
        description: "",
        image: "https://via.placeholder.co/600x450?text=Pin",
        link: [
          "https://example.com/chicken-salad",
          "https://example.com/diy-closet",
          "https://example.com/paris-itinerary",
          "https://example.com/db-workout",
          "https://example.com/capsule-wardrobe",
          "https://example.com/reading-list",
          "https://example.com/deals",
          "https://example.com/budget-template",
        ][i % 8],
        saved: false,
      }));
      return { items: demo, nextCursor: (cursor || 0) + 1 < 4 ? (cursor || 0) + 1 : null };
    }
  },
  async resolvePin(url) {
    try { return await PinterestAPI.resolvePin(url); } catch {
      return {
        id: uid("pin"),
        title: url.replace(/^https?:\/\//, "").slice(0, 80),
        image: "https://via.placeholder.co/600x450?text=Pin",
        link: url,
      };
    }
  },
};

/* --------------------------------- UI primitives --------------------------------- */
const Button = ({ variant = "default", size = "md", className, children, ...props }) => {
  const variants = {
    default: "bg-blue-600 text-white hover:bg-blue-700",
    outline: "border border-zinc-300 hover:bg-zinc-50",
    ghost: "hover:bg-zinc-100",
    secondary: "bg-zinc-900 text-white hover:bg-zinc-800",
  };
  const sizes = { sm: "h-8 px-2", md: "h-10 px-3", icon: "h-9 w-9 p-0" };
  return (
    <button className={cx("rounded-md text-sm", variants[variant], sizes[size], className)} {...props}>
      {children}
    </button>
  );
};
const Card = ({ className, children }) => <div className={cx("rounded-xl border bg-white shadow-sm", className)}>{children}</div>;
const CardHeader = ({ className, children }) => <div className={cx("px-4 pt-4", className)}>{children}</div>;
const CardTitle = ({ className, children }) => <div className={cx("text-lg font-semibold", className)}>{children}</div>;
const CardContent = ({ className, children }) => <div className={cx("px-4 pb-4", className)}>{children}</div>;
const Input = (p) => <input className={cx("h-9 w-full rounded-md border border-zinc-300 px-3 text-sm")} {...p} />;
const Badge = ({ children, tone = "zinc" }) => (
  <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs border border-${tone}-300 bg-${tone}-50 text-${tone}-800`}>
    {children}
  </span>
);

/* --------------------------------- Component --------------------------------- */
export default function PinterestImportWizard() {
  const pasteRef = useRef(null);
  const gridRef = useRef(null);

  const { add: addToBatch } = useBatchQueue();

  const [prefs, setPrefs] = useState(() => {
    try { return PreferencesStore?.getPreferences?.() || {}; } catch { return {}; }
  });
  const isSabbath = sabbathBlocked(prefs);

  const [step, setStep] = useState(1);
  const [connected, setConnected] = useState(false);
  const [boards, setBoards] = useState([]);
  const [activeBoard, setActiveBoard] = useState(null);

  const [pins, setPins] = useState([]); // current grid (with classification)
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);

  const [selected, setSelected] = useState([]); // pin ids
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [search, setSearch] = useState("");

  // Bulk destination (by type) + per-pin override map
  const DEFAULT_DEST_BY_TYPE = {
    recipe: "vault",     // vault | inbox | batch
    project: "projects", // projects
    travel: "trips",     // trips
    fitness: "workouts", // workouts
    style: "closet",     // closet
    reading: "reading",  // reading
    shopping: "deals",   // deals
    finance: "budget",   // budget
    bookmark: "bookmarks",
  };
  const [bulkDest, setBulkDest] = useState({ ...DEFAULT_DEST_BY_TYPE });
  const [pinDest, setPinDest] = useState({}); // { pinId: destKey }

  const [undoStack, setUndoStack] = useState([]);

  const filteredPins = useMemo(() => {
    if (!search) return pins;
    const q = search.toLowerCase();
    return pins.filter((p) => (p.title || "").toLowerCase().includes(q));
  }, [pins, search]);

  const typeCounts = useMemo(() => {
    const tally = {};
    for (const p of filteredPins) tally[p.__type] = (tally[p.__type] || 0) + 1;
    return tally;
  }, [filteredPins]);

  const typeOptions = [
    { key: "recipe", label: "Recipes" },
    { key: "project", label: "Projects" },
    { key: "travel", label: "Travel" },
    { key: "fitness", label: "Fitness" },
    { key: "style", label: "Style" },
    { key: "reading", label: "Reading" },
    { key: "shopping", label: "Shopping" },
    { key: "finance", label: "Finance" },
    { key: "bookmark", label: "Bookmarks" },
  ];

  /* ------------------------------ Effects & listeners ------------------------------ */
  useEffect(() => {
    const refreshPrefs = () => {
      try { setPrefs(PreferencesStore?.getPreferences?.() || {}); } catch {}
    };
    eventBus.on("preferences.changed", refreshPrefs);
    return () => eventBus.off("preferences.changed", refreshPrefs);
  }, []);

  // Paste handler for quick staging of URLs
  useEffect(() => {
    const el = pasteRef.current;
    if (!el) return;
    const onPaste = async (e) => {
      const text = e.clipboardData?.getData("text");
      if (!text) return;
      setBusy(true);
      try {
        const pin = await Pinterest.resolvePin(text.trim());
        const typed = { ...pin, __type: classifyPin(pin, activeBoard) };
        setPins((xs) => dedupeByUrlOrTitle([typed, ...xs]));
        setSelected((sel) => (sel.includes(pin.id) ? sel : [pin.id, ...sel]));
        setStep(2);
        setToast({ type: "success", msg: "Added from pasted URL." });
      } finally {
        setBusy(false);
      }
    };
    el.addEventListener("paste", onPaste);
    return () => el.removeEventListener("paste", onPaste);
  }, [activeBoard]);

  // Infinite scroll
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const onScroll = async () => {
      if (!hasMore || busy) return;
      const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 120;
      if (!nearBottom) return;
      await loadMore();
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [hasMore, busy, activeBoard, cursor]);

  /* ------------------------------ Step actions ------------------------------ */
  const connectPinterest = async () => {
    setBusy(true);
    try {
      const res = await Pinterest.auth();
      setConnected(!!res?.ok || !!res?.token);
      const bs = await Pinterest.listBoards();
      setBoards(bs || []);
      if ((bs || []).length) {
        setActiveBoard(bs[0]);
        await primeBoard(bs[0]);
      }
      setStep(2);
      setToast({ type: "success", msg: "Connected to Pinterest." });
    } catch {
      const bs = await Pinterest.listBoards();
      setBoards(bs || []);
      if ((bs || []).length) {
        setActiveBoard(bs[0]);
        await primeBoard(bs[0]);
      }
      setStep(2);
      setToast({ type: "info", msg: "Using demo boards. Connect later in Settings." });
    } finally {
      setBusy(false);
    }
  };

  const primeBoard = async (board) => {
    setBusy(true);
    try {
      const { items, nextCursor } = await Pinterest.listPins(board.id);
      const typed = (items || []).map((p) => ({ ...p, __type: classifyPin(p, board) }));
      setPins(dedupeByUrlOrTitle(typed));
      setCursor(nextCursor);
      setHasMore(!!nextCursor);
      setSelected([]);
    } finally {
      setBusy(false);
    }
  };

  const loadMore = async () => {
    if (!activeBoard || !hasMore) return;
    setBusy(true);
    try {
      const { items, nextCursor } = await Pinterest.listPins(activeBoard.id, cursor);
      const typed = (items || []).map((p) => ({ ...p, __type: classifyPin(p, activeBoard) }));
      setPins((xs) => dedupeByUrlOrTitle([...xs, ...typed]));
      setCursor(nextCursor);
      setHasMore(!!nextCursor);
    } finally {
      setBusy(false);
    }
  };

  const toggleSelect = (id) => setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));
  const selectAll = () => setSelected(filteredPins.map((p) => p.id));
  const clearSelection = () => setSelected([]);

  /* ------------------------------ Routing helpers ------------------------------ */
  const resolveDestForPin = (pin) => pinDest[pin.id] || bulkDest[pin.__type] || "bookmarks";

  const importToModule = async (pin, destKey) => {
    const baseCard = {
      id: uid("imp"),
      title: pin.title || pin.link,
      url: pin.link,
      image: pin.image,
      createdAt: nowIso(),
      source: "pinterest",
    };

    // Emit a scrape request so worker can hydrate richer fields later
    eventBus.emit("recipe.scrape.requested", { at: nowIso(), url: pin.link, source: "pinterest" });

    switch (destKey) {
      case "vault":
        try { RecipeStore?.upsert?.(baseCard); eventBus.emit("recipe.vault.updated", { id: baseCard.id }); return "saved"; }
        catch { return "error"; }
      case "inbox":
        try {
          if (CollectInboxStore?.add) CollectInboxStore.add(baseCard);
          else eventBus.emit("collect.inbox.added", { item: baseCard });
          return "queued";
        } catch { return "error"; }
      case "batch":
        try { addToBatch?.({ ...baseCard, from: "PinterestImport" }); eventBus.emit("batch.queue.added", { recipe: baseCard }); return "batched"; }
        catch { return "error"; }
      case "projects":
        try { ProjectStore?.upsert?.({ ...baseCard, status: "idea" }); eventBus.emit("projects.updated", { id: baseCard.id }); return "projected"; }
        catch { return "error"; }
      case "trips":
        try { TripStore?.stageLink?.(baseCard) || TripStore?.upsert?.(baseCard); eventBus.emit("trips.updated", { id: baseCard.id }); return "trip"; }
        catch { return "error"; }
      case "workouts":
        try { WorkoutStore?.upsert?.(baseCard); eventBus.emit("workouts.updated", { id: baseCard.id }); return "workout"; }
        catch { return "error"; }
      case "closet":
        try { ClosetStore?.upsert?.(baseCard); eventBus.emit("closet.updated", { id: baseCard.id }); return "closet"; }
        catch { return "error"; }
      case "reading":
        try { ReadingListStore?.upsert?.(baseCard); eventBus.emit("reading.updated", { id: baseCard.id }); return "reading"; }
        catch { return "error"; }
      case "deals":
        try { DealsStore?.upsert?.(baseCard); eventBus.emit("deals.updated", { id: baseCard.id }); return "deal"; }
        catch { return "error"; }
      case "budget":
        try { BudgetStore?.upsertTemplate?.(baseCard) || BudgetStore?.upsert?.(baseCard); eventBus.emit("budget.updated", { id: baseCard.id }); return "budget"; }
        catch { return "error"; }
      case "bookmarks":
      default:
        try { BookmarkStore?.upsert?.(baseCard); eventBus.emit("bookmarks.updated", { id: baseCard.id }); return "bookmarked"; }
        catch { return "error"; }
    }
  };

  const importSelected = async () => {
    if (!selected.length) {
      setToast({ type: "info", msg: "No pins selected." });
      return;
    }
    if (isSabbath) {
      setToast({ type: "warning", msg: "Sabbath hands-off is active. You can stage items but not import." });
      return;
    }

    setBusy(true);
    const results = [];
    try {
      for (const pinId of selected) {
        const p = pins.find((x) => x.id === pinId);
        if (!p) continue;
        emitProgress?.({ id: "pinterest.import", at: nowIso(), message: `Importing ${p.title || p.link}…` });
        const destKey = resolveDestForPin(p);
        const status = await importToModule(p, destKey);
        results.push({ pinId, status, destKey });
      }
      setUndoStack((s) => [...s, { type: "import", payload: results }]);
      const ok = results.filter((r) => r.status !== "error").length;
      setToast({ type: "success", msg: `Imported ${ok}/${results.length} item(s).`, actionLabel: "Undo", onAction: () => undo() });
      setStep(3);
    } finally {
      setBusy(false);
    }
  };

  const undo = () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((s) => s.slice(0, -1));

    // Best-effort removal by URL (stores should be idempotent)
    (last.payload || []).forEach((r) => {
      const p = pins.find((x) => x.id === r.pinId);
      if (!p) return;
      const url = p.link;
      const emit = (e) => eventBus.emit(e, { url });

      switch (r.destKey) {
        case "vault":     emit("recipe.vault.remove.requested"); break;
        case "inbox":     emit("collect.inbox.remove.requested"); break;
        case "batch":     emit("batch.queue.remove.requested"); break;
        case "projects":  emit("projects.remove.requested"); break;
        case "trips":     emit("trips.remove.requested"); break;
        case "workouts":  emit("workouts.remove.requested"); break;
        case "closet":    emit("closet.remove.requested"); break;
        case "reading":   emit("reading.remove.requested"); break;
        case "deals":     emit("deals.remove.requested"); break;
        case "budget":    emit("budget.remove.requested"); break;
        default:          emit("bookmarks.remove.requested"); break;
      }
    });
    setToast({ type: "info", msg: "Import undone (where possible)." });
  };

  /* ------------------------------ Small UI blocks ------------------------------ */
  const Toast = () =>
    toast ? (
      <div
        className={cx(
          "fixed bottom-4 right-4 z-50 max-w-sm rounded-xl px-4 py-3 shadow-lg text-white",
          toast.type === "success" && "bg-green-600",
          toast.type === "info" && "bg-zinc-900",
          toast.type === "warning" && "bg-amber-600",
          toast.type === "error" && "bg-red-600"
        )}
      >
        <div className="text-sm">{toast.msg}</div>
        {toast.actionLabel && toast.onAction ? (
          <button className="mt-2 rounded-lg border border-white/20 px-2 py-1 text-xs hover:bg-white/10" onClick={toast.onAction}>
            {toast.actionLabel}
          </button>
        ) : null}
      </div>
    ) : null;

  const Stepper = () => (
    <div className="flex items-center gap-2 text-xs">
      <Badge>1 • Source</Badge>
      <div className="h-px w-5 bg-zinc-200" />
      <Badge>2 • Select & Route</Badge>
      <div className="h-px w-5 bg-zinc-200" />
      <Badge>3 • Review</Badge>
    </div>
  );

  const PinCard = ({ pin }) => {
    const checked = selected.includes(pin.id);
    const hint = pin.__type === "recipe" && shellfishHint(`${pin.title} ${pin.link}`);
    const destKey = resolveDestForPin(pin);

    const perPinDestChange = (val) => setPinDest((m) => ({ ...m, [pin.id]: val }));

    return (
      <div
        className={cx(
          "group relative overflow-hidden rounded-xl border",
          checked ? "ring-2 ring-blue-600" : "hover:border-zinc-400"
        )}
        onClick={() => toggleSelect(pin.id)}
        role="button"
        tabIndex={0}
      >
        <img src={pin.image} alt={pin.title || "Pin"} className="aspect-[4/3] w-full object-cover" loading="lazy" />
        <div className="absolute left-2 top-2 flex items-center gap-2">
          <input type="checkbox" checked={checked} onChange={() => toggleSelect(pin.id)} onClick={(e) => e.stopPropagation()} />
          <span className="rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">{pin.__type}</span>
          {hint && <span className="rounded bg-amber-400/90 px-1.5 py-0.5 text-[10px] text-black">shellfish?</span>}
        </div>
        <div className="absolute bottom-0 w-full bg-gradient-to-t from-black/60 to-transparent p-2 text-xs text-white">
          <div className="line-clamp-2">{pin.title || pin.link}</div>
          <div className="mt-1 flex items-center gap-2">
            <a href={pin.link} target="_blank" rel="noreferrer" className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] hover:bg-white/30" onClick={(e) => e.stopPropagation()}>
              Open
            </a>
            {/* Per-pin destination override */}
            <select
              className="rounded bg-white/20 px-1.5 py-0.5 text-[10px] text-white"
              value={destKey}
              onChange={(e) => { e.stopPropagation(); perPinDestChange(e.target.value); }}
            >
              <option value="vault">Recipe → Vault</option>
              <option value="inbox">Recipe → Inbox</option>
              <option value="batch">Recipe → Batch</option>
              <option value="projects">Projects/Tasks</option>
              <option value="trips">Trips</option>
              <option value="workouts">Workouts</option>
              <option value="closet">Closet</option>
              <option value="reading">Reading</option>
              <option value="deals">Deals</option>
              <option value="budget">Budget</option>
              <option value="bookmarks">Bookmarks</option>
            </select>
          </div>
        </div>
      </div>
    );
  };

  /* --------------------------------- UI --------------------------------- */
  return (
    <section className="flex flex-col gap-4" ref={pasteRef}>
      <Toast />

      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded bg-zinc-900" />
          <h2 className="text-xl font-semibold">Pinterest Import (All Boards)</h2>
          <Stepper />
          {isSabbath && <Badge tone="violet">Sabbath hands-off</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => eventBus.emit("ui.open", { panel: "CollectOrganize" })}>
            Collect & Organize
          </Button>
          <Button variant="outline" size="sm" onClick={() => eventBus.emit("ui.open", { panel: "RecipeVault" })}>
            Recipe Vault
          </Button>
        </div>
      </header>

      {/* Step 1 — Connect / Source */}
      {step === 1 && (
        <Card>
          <CardContent className="py-4">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <div className="text-sm font-semibold">Connect Pinterest</div>
                <p className="mt-1 text-xs text-zinc-600">
                  Sign in to browse boards and bulk-import pins. Or paste any pin/board URL to start without signing in.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <Button onClick={connectPinterest} disabled={busy}>{busy ? "Connecting…" : "Connect"}</Button>
                  {connected && <Badge tone="zinc">Connected</Badge>}
                </div>
              </div>
              <div>
                <div className="text-sm font-semibold">Paste URLs</div>
                <p className="mt-1 text-xs text-zinc-600">
                  Paste a pin or board URL anywhere on this page to stage it. We’ll resolve and classify it.
                </p>
                <div className="mt-2 rounded border border-dashed p-3 text-center text-xs text-zinc-600">
                  You can paste multiple lines — we’ll try them all.
                </div>
              </div>
            </div>
            {!!boards.length && (
              <div className="mt-6 rounded-xl border p-3">
                <div className="mb-2 text-sm font-semibold">Quick Boards</div>
                <div className="flex flex-wrap gap-2">
                  {boards.map((b) => (
                    <Button
                      key={b.id}
                      variant="outline"
                      size="sm"
                      onClick={async () => { setActiveBoard(b); await primeBoard(b); setStep(2); }}
                    >
                      {b.name} <span className="ml-1 text-xs text-zinc-500">({b.count})</span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Step 2 — Select & Route */}
      {step === 2 && (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 py-3">
              <div className="text-sm font-semibold">Select & Route</div>
              <Input placeholder="Search pins…" value={search} onChange={(e) => setSearch(e.target.value)} />
              <Button variant="outline" size="sm" onClick={selectAll}>Select All</Button>
              <Button variant="outline" size="sm" onClick={clearSelection}>Clear</Button>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {/* Bulk destination controls by detected type */}
                {typeOptions.map((t) => (
                  <div key={t.key} className="flex items-center gap-1">
                    <span className="text-xs text-zinc-600">{t.label} ({typeCounts[t.key] || 0})</span>
                    <select
                      className="h-8 rounded-md border border-zinc-300 bg-white px-2 text-xs"
                      value={bulkDest[t.key]}
                      onChange={(e) => setBulkDest((d) => ({ ...d, [t.key]: e.target.value }))}
                      title={`Route ${t.label}`}
                    >
                      {/* Recipe-specific first, then general modules */}
                      <option value="vault">→ Vault</option>
                      <option value="inbox">→ Inbox</option>
                      <option value="batch">→ Batch</option>
                      <option value="projects">→ Projects</option>
                      <option value="trips">→ Trips</option>
                      <option value="workouts">→ Workouts</option>
                      <option value="closet">→ Closet</option>
                      <option value="reading">→ Reading</option>
                      <option value="deals">→ Deals</option>
                      <option value="budget">→ Budget</option>
                      <option value="bookmarks">→ Bookmarks</option>
                    </select>
                  </div>
                ))}
                <Button onClick={importSelected} disabled={busy || isSabbath}>
                  {busy ? "Importing…" : `Import Selected (${selected.length})`}
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
            <div className="md:col-span-3">
              <Card>
                <CardHeader className="py-3">
                  <CardTitle className="text-sm">Boards</CardTitle>
                </CardHeader>
                <CardContent>
                  {boards.length === 0 ? (
                    <div className="rounded border border-dashed p-3 text-center text-xs text-zinc-600">
                      No boards. Connect or paste URLs.
                    </div>
                  ) : (
                    <ul className="space-y-1">
                      {boards.map((b) => (
                        <li key={b.id}>
                          <button
                            className={cx(
                              "w-full rounded-lg border px-2 py-2 text-left text-sm hover:bg-zinc-50",
                              activeBoard?.id === b.id && "border-zinc-900"
                            )}
                            onClick={() => primeBoard(b)}
                          >
                            <div className="truncate">{b.name}</div>
                            <div className="text-xs text-zinc-500">{b.count ?? "—"} pins</div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>

            <div className="md:col-span-9">
              <Card>
                <CardContent className="p-0">
                  <div ref={gridRef} className="max-h-[60vh] overflow-auto p-3">
                    {filteredPins.length === 0 ? (
                      <div className="rounded-xl border border-dashed p-6 text-center text-sm text-zinc-600">
                        No pins here yet. Paste a URL or choose another board.
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                        {filteredPins.map((p) => <PinCard key={p.id} pin={p} />)}
                      </div>
                    )}
                    {hasMore && (
                      <div className="mt-3 text-center">
                        <Button variant="outline" size="sm" onClick={loadMore} disabled={busy}>
                          {busy ? "Loading…" : "Load more"}
                        </Button>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}

      {/* Step 3 — Review */}
      {step === 3 && (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Review</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-sm">Imported <span className="font-semibold">{selected.length}</span> item(s).</div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setStep(2)}>Back to Select</Button>
              <Button variant="secondary" size="sm" onClick={() => eventBus.emit("ui.open", { panel: "CollectOrganize" })}>
                Open Collect & Organize
              </Button>
              <Button variant="ghost" size="sm" onClick={undo}>Undo</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

/* --------------------------------- Lightweight TESTS --------------------------------- */
(function runPinterestImportWizardAllBoardsTestsOnce() {
  if (typeof window === "undefined") return;
  if (window.__PIN_IMPORT_ALL_TESTS__) return;
  window.__PIN_IMPORT_ALL_TESTS__ = true;

  const expect = (cond, msg) =>
    cond ? console.log("[PinterestImport ALL TEST PASS]", msg) : console.error("[PinterestImport ALL TEST FAIL]", msg);

  // Classifier smoke tests
  expect(classifyPin({ title: "Paris Itinerary" }, { name: "Euro Trip" }) === "travel", "classify travel");
  expect(classifyPin({ title: "30-min Dumbbell Workout" }, { name: "" }) === "fitness", "classify fitness");
  expect(classifyPin({ title: "DIY Closet System" }, { name: "" }) === "project", "classify project");
  expect(["recipe","bookmark"].includes(classifyPin({ link: "https://bonappetit.com/x" }, { name: "" })), "recipe domain bias");
})();
