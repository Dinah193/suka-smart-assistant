// C:\Users\larho\suka-smart-assistant\src\components\meals\collector\CollectionsPicker.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * CollectionsPicker.jsx — cross-module boards/collections selector
 * -----------------------------------------------------------------------------
 * Purpose
 *  A unified, dynamic picker for assigning one or more items to a "collection"
 *  (board/list/folder/bundle) across Suka modules — not just meals.
 *
 * Design goals
 *  - Works everywhere (Meals, Shopping, Garden, Animals, Preservation, Projects, Inspiration)
 *  - Search-as-you-type; fuzzy includes; keyboard friendly (↑/↓, Enter, Esc)
 *  - Create new collection inline (with module + privacy + color)
 *  - Shows recents & suggestions (from usage signals or stores if available)
 *  - Supports multiple selection; emits IDs and rich objects
 *  - Sabbath-aware: disables writes when hands-off is active
 *  - Soft integrations: all stores/eventBus are optional; safe fallbacks
 *
 * Props
 *  - value: string | string[] | {id,...} | {id,...}[]
 *  - onChange(next) => void
 *  - scope: "all" | string[]    (module keys to include)
 *  - multiple: boolean           (default false)
 *  - canCreate: boolean          (default true)
 *  - defaultModule: string       (default "inspiration")
 *  - placeholder: string         (input placeholder)
 *  - className: string
 *
 * Events emitted (if eventBus available)
 *  - collections.updated
 *  - collection.created
 *  - ui.open   (to jump users into fuller board managers if needed)
 */

/* -------------------------------- Mini UI primitives -------------------------------- */
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
    { sm: "h-8 px-2 text-sm", md: "h-10 px-3 text-sm", xs: "h-7 px-2 text-xs" }[
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
  <input className="h-9 w-full rounded-xl border px-3 text-sm" {...props} />
);
const Badge = ({ children, tone = "zinc" }) => (
  <span
    className={cx(
      "inline-flex items-center rounded px-2 py-0.5 text-[11px]",
      tone === "zinc" && "bg-zinc-900 text-white",
      tone === "green" && "bg-emerald-100 text-emerald-900",
      tone === "amber" && "bg-amber-100 text-amber-900",
      tone === "blue" && "bg-blue-100 text-blue-900"
    )}
  >
    {children}
  </span>
);

/* -------------------------------- Soft integrations -------------------------------- */
// eventBus (new path then legacy)
let eventBus = { on: () => {}, off: () => {}, emit: () => {} };
try {
  eventBus = require("@/services/events/eventBus");
} catch {
  try {
    eventBus = require("@/services/events/eventBus").eventBus || eventBus;
  } catch {}
}

// Preferences (Sabbath)
let PreferencesStore = {};
try {
  PreferencesStore = require("@/store/PreferencesStore");
} catch {}

// Stores (all optional, each expected to provide list + create)
let BoardsStore = {}; // inspiration boards / generic boards
let RecipeStore = {}; // meal bundles/collections
let ShoppingStore = {}; // shopping lists/collections
let GardenStore = {}; // garden collections
let PreservationStore = {}; // preservation collections
let AnimalsStore = {}; // animals groups
let ProjectsStore = {}; // household projects/folders
try {
  BoardsStore = require("@/store/BoardsStore");
} catch {}
try {
  RecipeStore = require("@/store/RecipeStore");
} catch {}
try {
  ShoppingStore = require("@/store/ShoppingStore");
} catch {}
try {
  GardenStore = require("@/store/GardenStore");
} catch {}
try {
  PreservationStore = require("@/store/PreservationStore");
} catch {}
try {
  AnimalsStore = require("@/store/AnimalsStore");
} catch {}
try {
  ProjectsStore = require("@/store/ProjectsStore");
} catch {}

/* --------------------------------- Helpers --------------------------------- */
const isoNow = () => new Date().toISOString();
const asArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const idOf = (x) => (typeof x === "string" ? x : x?.id);
const normalizeValue = (value) =>
  asArray(value).map((v) => (typeof v === "string" ? { id: v } : v || {}));
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
const colorSwatches = [
  "#0ea5e9",
  "#10b981",
  "#8b5cf6",
  "#f59e0b",
  "#ef4444",
  "#14b8a6",
  "#3b82f6",
  "#a3a3a3",
];

/* -------- Modules we support in the picker (labels & loaders/creators) -------- */
const MODULES = [
  {
    key: "inspiration",
    label: "Inspiration • Boards",
    icon: "📌",
    loader: async () => {
      try {
        return (await BoardsStore.list?.()) || [];
      } catch {
        return [];
      }
    },
    creator: async (payload) => {
      try {
        return await BoardsStore.create?.(payload);
      } catch {
        return null;
      }
    },
  },
  {
    key: "recipes",
    label: "Meals • Bundles",
    icon: "🍽️",
    loader: async () => {
      try {
        return (await RecipeStore.listCollections?.()) || [];
      } catch {
        return [];
      }
    },
    creator: async (payload) => {
      try {
        return await RecipeStore.createCollection?.(payload);
      } catch {
        return null;
      }
    },
  },
  {
    key: "shopping",
    label: "Shopping • Lists",
    icon: "🛒",
    loader: async () => {
      try {
        return (await ShoppingStore.listLists?.()) || [];
      } catch {
        return [];
      }
    },
    creator: async (payload) => {
      try {
        return await ShoppingStore.createList?.(payload);
      } catch {
        return null;
      }
    },
  },
  {
    key: "garden",
    label: "Garden • Collections",
    icon: "🌱",
    loader: async () => {
      try {
        return (await GardenStore.listCollections?.()) || [];
      } catch {
        return [];
      }
    },
    creator: async (payload) => {
      try {
        return await GardenStore.createCollection?.(payload);
      } catch {
        return null;
      }
    },
  },
  {
    key: "animals",
    label: "Animals • Groups",
    icon: "🐓",
    loader: async () => {
      try {
        return (await AnimalsStore.listCollections?.()) || [];
      } catch {
        return [];
      }
    },
    creator: async (payload) => {
      try {
        return await AnimalsStore.createCollection?.(payload);
      } catch {
        return null;
      }
    },
  },
  {
    key: "preservation",
    label: "Preservation • Collections",
    icon: "🥫",
    loader: async () => {
      try {
        return (await PreservationStore.listCollections?.()) || [];
      } catch {
        return [];
      }
    },
    creator: async (payload) => {
      try {
        return await PreservationStore.createCollection?.(payload);
      } catch {
        return null;
      }
    },
  },
  {
    key: "projects",
    label: "Household • Projects",
    icon: "🧰",
    loader: async () => {
      try {
        return (await ProjectsStore.listCollections?.()) || [];
      } catch {
        return [];
      }
    },
    creator: async (payload) => {
      try {
        return await ProjectsStore.createCollection?.(payload);
      } catch {
        return null;
      }
    },
  },
];

/* -------------------------------- Row renderer -------------------------------- */
function Row({ item, active, checked, onToggle, onHover }) {
  return (
    <button
      type="button"
      className={cx(
        "group flex w-full items-center justify-between rounded-xl border p-2 text-left",
        active
          ? "border-zinc-900 bg-zinc-50"
          : "border-zinc-200 hover:bg-zinc-50"
      )}
      onMouseEnter={onHover}
      onClick={onToggle}
      aria-pressed={checked}
    >
      <div className="min-w-0 flex items-center gap-2">
        <div
          className="grid h-6 w-6 place-items-center rounded-lg text-sm"
          style={{ background: item.color || "#111827", color: "#fff" }}
        >
          {item.icon || "•"}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            {item.title || item.name}
          </div>
          {item.path ? (
            <div className="truncate text-[11px] text-zinc-500">
              {item.path}
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {item.privacy ? (
          <Badge tone={item.privacy === "private" ? "amber" : "green"}>
            {item.privacy}
          </Badge>
        ) : null}
        <input
          type="checkbox"
          className="checkbox checkbox-sm"
          readOnly
          checked={!!checked}
        />
      </div>
    </button>
  );
}

/* --------------------------------- Component --------------------------------- */
export default function CollectionsPicker({
  value = null,
  onChange = () => {},
  multiple = false,
  scope = "all",
  canCreate = true,
  defaultModule = "inspiration",
  placeholder = "Search or create a collection…",
  className,
}) {
  const initial = normalizeValue(value);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [selected, setSelected] = useState(
    new Map(initial.map((x) => [x.id, x]))
  );
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const [moduleKey, setModuleKey] = useState(defaultModule);
  const [collections, setCollections] = useState({}); // {moduleKey: [rows]}
  const [recents, setRecents] = useState([]); // array of {id,title,module}

  const inputRef = useRef(null);
  const listRef = useRef(null);

  /* -------- load collections per module -------- */
  const allowedKeys = useMemo(() => {
    if (scope === "all") return MODULES.map((m) => m.key);
    if (Array.isArray(scope)) return scope;
    return [String(scope)];
  }, [scope]);

  const modules = useMemo(
    () => MODULES.filter((m) => allowedKeys.includes(m.key)),
    [allowedKeys]
  );

  const loadAll = useCallback(async () => {
    setBusy(true);
    try {
      const next = {};
      for (const m of modules) {
        try {
          next[m.key] = await m.loader();
        } catch {
          next[m.key] = [];
        }
      }
      setCollections(next);
    } finally {
      setBusy(false);
    }
  }, [modules]);

  useEffect(() => {
    loadAll();
    // listen for external updates
    const refresh = () => loadAll();
    eventBus.on?.("collections.updated", refresh);
    return () => eventBus.off?.("collections.updated", refresh);
  }, [loadAll]);

  // Recents (best-effort)
  useEffect(() => {
    try {
      const raw = JSON.parse(
        localStorage.getItem("suka.collections.recents") || "[]"
      );
      setRecents(Array.isArray(raw) ? raw : []);
    } catch {}
  }, []);

  const commitRecents = useCallback(
    (item) => {
      try {
        const entry = {
          id: item.id,
          title: item.title || item.name,
          module: item.module || moduleKey,
          at: isoNow(),
        };
        const next = [entry, ...recents.filter((r) => r.id !== entry.id)].slice(
          0,
          12
        );
        setRecents(next);
        localStorage.setItem("suka.collections.recents", JSON.stringify(next));
      } catch {}
    },
    [recents, moduleKey]
  );

  /* -------- filtered rows & flatten list for keyboard nav -------- */
  const rowsByModule = useMemo(() => {
    const q = query.trim().toLowerCase();
    const res = {};
    for (const m of modules) {
      const all = collections[m.key] || [];
      const filtered = !q
        ? all
        : all.filter((c) =>
            `${c.title || c.name || ""} ${c.path || ""}`
              .toLowerCase()
              .includes(q)
          );
      res[m.key] = filtered.map((c) => ({
        ...c,
        module: m.key,
        icon: c.icon || m.icon,
        color: c.color,
        privacy: c.privacy || c.visibility,
      }));
    }
    return res;
  }, [query, collections, modules]);

  const flat = useMemo(() => {
    const out = [];
    for (const m of modules) {
      const arr = rowsByModule[m.key] || [];
      if (arr.length)
        out.push({ _header: true, key: m.key, label: m.label, icon: m.icon });
      for (const c of arr) out.push({ ...c });
    }
    return out;
  }, [rowsByModule, modules]);

  useEffect(() => {
    if (activeIndex >= flat.length)
      setActiveIndex(Math.max(0, flat.length - 1));
  }, [flat.length, activeIndex]);

  /* -------- actions -------- */
  const toggle = (item) => {
    setSelected((prev) => {
      const n = new Map(prev);
      if (multiple) {
        if (n.has(item.id)) n.delete(item.id);
        else n.set(item.id, item);
      } else {
        n.clear();
        n.set(item.id, item);
      }
      return n;
    });
    commitRecents(item);
  };

  const commitChange = () => {
    const arr = Array.from(selected.values());
    onChange(multiple ? arr : arr[0] || null);
    eventBus.emit?.("collections.updated", { at: isoNow() });
  };

  const create = async (payload) => {
    if (!canCreate) return;
    if (sabbathBlocked()) {
      setToast({
        kind: "warning",
        text: "Sabbath hands-off is active. Creating new collections is paused.",
      });
      return;
    }
    const mod = MODULES.find((m) => m.key === moduleKey);
    if (!mod?.creator) return;
    setBusy(true);
    try {
      const color =
        payload.color ||
        colorSwatches[Math.floor(Math.random() * colorSwatches.length)];
      const body = {
        title: payload.title,
        color,
        icon: payload.icon || mod.icon,
        privacy: payload.privacy || "private",
      };
      const created = await mod.creator(body);
      if (created?.id) {
        setCollections((prev) => ({
          ...prev,
          [moduleKey]: [created, ...(prev[moduleKey] || [])],
        }));
        const enriched = {
          ...created,
          module: moduleKey,
          color: created.color || color,
          icon: created.icon || mod.icon,
        };
        toggle(enriched);
        commitChange();
        setToast({
          kind: "success",
          text: `Created “${created.title || created.name}”.`,
        });
        eventBus.emit?.("collection.created", {
          at: isoNow(),
          module: moduleKey,
          id: created.id,
        });
      } else {
        setToast({ kind: "error", text: "Could not create collection." });
      }
    } finally {
      setBusy(false);
    }
  };

  /* -------- keyboard -------- */
  useEffect(() => {
    const onKey = (e) => {
      if (!listRef.current) return;
      if (["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key))
        e.preventDefault();
      if (e.key === "ArrowDown")
        setActiveIndex((i) => Math.min(i + 1, flat.length - 1));
      if (e.key === "ArrowUp") setActiveIndex((i) => Math.max(i - 1, 0));
      if (e.key === "Enter") {
        const item = flat[activeIndex];
        if (item && !item._header) toggle(item);
      }
      if (e.key === "Escape") {
        (inputRef.current || document.activeElement)?.blur?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flat, activeIndex]);

  /* -------- Create form local state -------- */
  const [draftTitle, setDraftTitle] = useState("");
  const [draftPrivacy, setDraftPrivacy] = useState("private");
  const [draftColor, setDraftColor] = useState(colorSwatches[0]);

  /* --------------------------------- render --------------------------------- */
  const anySelected = selected.size > 0;

  return (
    <div className={cx("rounded-2xl border p-3 space-y-3 bg-white", className)}>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded bg-zinc-900" />
          <div className="text-sm font-semibold">Collections</div>
          <Badge tone="blue">
            {modules.length} module{modules.length > 1 ? "s" : ""}
          </Badge>
          {anySelected ? (
            <Badge tone="green">{selected.size} selected</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <select
            className="select select-bordered select-sm rounded-lg"
            value={moduleKey}
            onChange={(e) => setModuleKey(e.target.value)}
            aria-label="Module"
            title="Pick module"
          >
            {modules.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            onClick={commitChange}
            disabled={!anySelected}
          >
            Apply
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          placeholder={placeholder}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button size="sm" variant="ghost" onClick={() => setQuery("")}>
          Clear
        </Button>
      </div>

      {/* Recents */}
      {recents?.length ? (
        <div className="rounded-xl border p-2">
          <div className="mb-2 text-xs font-semibold text-zinc-600">Recent</div>
          <div className="flex flex-wrap gap-2">
            {recents.slice(0, 10).map((r) => (
              <button
                key={`${r.module}-${r.id}`}
                className="rounded-lg border px-2 py-1 text-xs hover:bg-zinc-50"
                onClick={() => {
                  const mod = MODULES.find((m) => m.key === r.module);
                  toggle({
                    id: r.id,
                    title: r.title,
                    module: r.module,
                    icon: mod?.icon,
                  });
                }}
              >
                {r.title}
                <span className="ml-1 text-[10px] text-zinc-500">
                  · {r.module}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* List */}
      <div ref={listRef} className="grid grid-cols-1 gap-2">
        {busy ? (
          <div className="rounded-xl border p-6 text-center text-sm text-zinc-600">
            Loading…
          </div>
        ) : flat.length ? (
          flat.map((item, idx) =>
            item._header ? (
              <div
                key={`h-${item.key}`}
                className="mt-2 flex items-center gap-2 text-[11px] font-semibold uppercase text-zinc-500"
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </div>
            ) : (
              <Row
                key={`${item.module}-${item.id}`}
                item={item}
                active={idx === activeIndex}
                checked={selected.has(item.id)}
                onHover={() => setActiveIndex(idx)}
                onToggle={() => toggle(item)}
              />
            )
          )
        ) : (
          <div className="rounded-xl border border-dashed p-6 text-center text-sm text-zinc-600">
            No matches.
          </div>
        )}
      </div>

      {/* Create new */}
      {canCreate ? (
        <div className="rounded-xl border p-3 space-y-2">
          <div className="text-sm font-medium">Create new</div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              placeholder={`New ${
                modules
                  .find((m) => m.key === moduleKey)
                  ?.label.split("•")[1]
                  ?.trim() || "collection"
              } name…`}
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && draftTitle.trim())
                  create({
                    title: draftTitle.trim(),
                    color: draftColor,
                    privacy: draftPrivacy,
                  });
              }}
            />
            <div className="flex items-center gap-2">
              <select
                className="select select-bordered select-sm rounded-lg"
                value={draftPrivacy}
                onChange={(e) => setDraftPrivacy(e.target.value)}
                aria-label="Privacy"
                title="Privacy"
              >
                <option value="private">Private</option>
                <option value="shared">Shared</option>
              </select>
              <div className="flex items-center gap-1">
                {colorSwatches.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={cx(
                      "h-6 w-6 rounded-lg border",
                      draftColor === c ? "ring-2 ring-zinc-900" : "opacity-90"
                    )}
                    style={{ background: c }}
                    onClick={() => setDraftColor(c)}
                    aria-label={`Color ${c}`}
                    title={`Color ${c}`}
                  />
                ))}
              </div>
              <Button
                size="sm"
                variant="solid"
                disabled={!draftTitle.trim() || busy || sabbathBlocked()}
                onClick={() =>
                  create({
                    title: draftTitle.trim(),
                    color: draftColor,
                    privacy: draftPrivacy,
                  })
                }
              >
                {busy ? "Creating…" : "Create"}
              </Button>
            </div>
          </div>
          {sabbathBlocked() ? (
            <div className="text-[11px] text-amber-700">
              Sabbath hands-off: creation is paused.
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Footer */}
      <div className="flex items-center justify-between text-[11px] text-zinc-500">
        <div>↑/↓ to move · Enter to select · Esc to blur</div>
        <button
          className="underline"
          onClick={() =>
            eventBus.emit?.("ui.open", {
              panel: "BoardsManager",
              tab: moduleKey,
            })
          }
        >
          Open manager
        </button>
      </div>

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
    </div>
  );
}

/* ---------------------------- Lightweight self-tests ---------------------------- */
(function runCollectionsPickerTests() {
  if (typeof window === "undefined") return;
  if (window.__COLLECTIONS_PICKER_TEST__) return;
  window.__COLLECTIONS_PICKER_TEST__ = true;

  const ok = (c, m) =>
    c
      ? console.log("[CollectionsPicker TEST PASS]", m)
      : console.error("[CollectionsPicker TEST FAIL]", m);
  ok(Array.isArray(MODULES) && MODULES.length >= 3, "Modules registry present");
  ok(typeof sabbathBlocked === "function", "Sabbath guard available");
})();
