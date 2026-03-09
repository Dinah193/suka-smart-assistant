// src/components/meals/common/AisleGroupList.jsx
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try {
  Icons = require("lucide-react");
} catch {}

let eventBus = null;
try {
  eventBus = require("@/services/events/eventBus").eventBus || null;
} catch {}

let automation = null;
try {
  automation = require("@/services/automation/runtime").automation || null;
} catch {}

let useInventoryStore = () => null;
try {
  const mod = require("@/store/InventoryStore");
  useInventoryStore = mod.useInventoryStore || useInventoryStore;
} catch {}

let toast = {
  success: console.log,
  info: console.log,
  error: console.error,
  warn: console.warn,
};
try {
  toast = require("react-toastify").toast || toast;
} catch {}

/* --------------------------------- Utilities --------------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");
const clamp = (n, a = 0, b = Infinity) =>
  Math.max(a, Math.min(b, Number.isFinite(+n) ? +n : a));
const groupBy = (arr, keyFn) =>
  (arr || []).reduce((acc, x) => ((acc[keyFn(x)] ||= []).push(x), acc), {});
const money = (v) =>
  typeof v === "number" && !Number.isNaN(v)
    ? v.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      })
    : null;

const STATE_KEY = (scope = "default") => `aisleGroup.collapsed.v1.${scope}`;
const loadCollapsed = (scope) => {
  try {
    return JSON.parse(localStorage.getItem(STATE_KEY(scope)) || "{}");
  } catch {
    return {};
  }
};
const saveCollapsed = (scope, obj) => {
  try {
    localStorage.setItem(STATE_KEY(scope), JSON.stringify(obj || {}));
  } catch {}
};

const STATE_COLORS = {
  have: "bg-emerald-50 border-emerald-200 text-emerald-700",
  surplus: "bg-teal-50 border-teal-200 text-teal-700",
  short: "bg-amber-50 border-amber-200 text-amber-800",
  need: "bg-rose-50 border-rose-200 text-rose-700",
};

/* ---------------------------------- Types ------------------------------------
Item (flexible; we handle missing fields gracefully)
{
  id: string
  name: string
  aisle?: string
  qty?: number
  unit?: string
  state?: "have" | "short" | "need" | "surplus"
  price?: number              // per unit estimate
  note?: string
  substitutions?: string[]    // suggested alternates
  sourceRecipes?: Array<{id?:string, title?:string}>
  checked?: boolean
}
----------------------------------------------------------------------------- */

/* ------------------------------- Subcomponents ------------------------------- */
const Pill = ({ tone = "default", children, title }) => {
  const map = {
    default: "bg-gray-50 border-gray-200 text-gray-700",
    info: "bg-blue-50 border-blue-200 text-blue-700",
  };
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center px-2 py-0.5 rounded-md text-[11px] border",
        map[tone] || map.default
      )}
    >
      {children}
    </span>
  );
};

const AisleHeader = ({ title, count, collapsed, onToggle }) => {
  const { ChevronDown = () => null, ShoppingBasket = () => null } = Icons;
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full sticky top-0 z-10 bg-white/90 backdrop-blur border-y py-2 px-2 flex items-center justify-between"
      aria-expanded={!collapsed}
    >
      <div className="flex items-center gap-2">
        <ShoppingBasket className="w-4 h-4 opacity-80" />
        <span className="text-xs font-semibold tracking-wide uppercase">
          {title || "Other"}
        </span>
        <span className="text-[10px] text-gray-500">
          {count} item{count === 1 ? "" : "s"}
        </span>
      </div>
      <ChevronDown
        className={cx(
          "w-4 h-4 transition-transform",
          collapsed && "rotate-180"
        )}
      />
    </button>
  );
};

const QtyEditor = ({ value, unit, onChange }) => {
  const [local, setLocal] = useState(value ?? 1);
  useEffect(() => setLocal(value ?? 1), [value]);
  return (
    <div className="inline-flex items-center border rounded-md overflow-hidden">
      <button
        type="button"
        className="px-2 py-1 text-sm hover:bg-gray-50"
        onClick={() => {
          const next = Math.max(0, clamp(local - 1));
          setLocal(next);
          onChange?.(next);
        }}
        aria-label="Decrease quantity"
      >
        −
      </button>
      <input
        className="w-14 text-center text-sm outline-none py-1"
        value={local}
        onChange={(e) => {
          const n = clamp(e.target.value, 0, 9999);
          setLocal(n);
        }}
        onBlur={() => onChange?.(clamp(local, 0, 9999))}
        inputMode="numeric"
      />
      <span className="px-2 text-xs text-gray-600">{unit || ""}</span>
      <button
        type="button"
        className="px-2 py-1 text-sm hover:bg-gray-50"
        onClick={() => {
          const next = clamp(local + 1);
          setLocal(next);
          onChange?.(next);
        }}
        aria-label="Increase quantity"
      >
        +
      </button>
    </div>
  );
};

/* --------------------------------- Item row ---------------------------------- */
const ItemRow = ({
  item,
  dense,
  onToggle,
  onQtyChange,
  onApplySub,
  onMove,
  onRemove,
  onStateChange,
}) => {
  const {
    CheckSquare = () => null,
    Square = () => null,
    ChefHat = () => null,
    Replace = () => null,
    MoveRight = () => null,
    Trash2 = () => null,
    Package = () => null,
    AlertTriangle = () => null,
  } = Icons;

  const stateTone =
    STATE_COLORS[item?.state] || "bg-gray-50 border-gray-200 text-gray-700";
  const est = money(item?.price && item?.qty ? item.price * item.qty : null);

  return (
    <div className="p-2 border rounded-xl bg-white/80 backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        {/* left: checkbox + name */}
        <div className="flex items-start gap-2 min-w-0">
          <button
            type="button"
            className="mt-0.5"
            onClick={() => onToggle?.(item)}
            aria-label={item?.checked ? "Uncheck item" : "Check item"}
            title={item?.checked ? "Uncheck" : "Check"}
          >
            {item?.checked ? (
              <CheckSquare className="w-5 h-5 text-emerald-600" />
            ) : (
              <Square className="w-5 h-5 text-gray-400" />
            )}
          </button>
          <div className="min-w-0">
            <div
              className={cx(
                "font-medium truncate",
                item?.checked && "line-through text-gray-400"
              )}
            >
              {item?.name || "Item"}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <span
                className={cx(
                  "inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] border",
                  stateTone
                )}
              >
                {item?.state || "need"}
              </span>
              {Array.isArray(item?.sourceRecipes) &&
                item.sourceRecipes.slice(0, 2).map((r, i) => (
                  <Pill
                    key={`${r?.id || r?.title || i}`}
                    tone="info"
                    title="Source recipe"
                  >
                    <ChefHat className="w-3 h-3 mr-1" />
                    {r?.title || "Recipe"}
                  </Pill>
                ))}
              {item?.note ? <Pill>{item.note}</Pill> : null}
              {est ? <Pill tone="info">{est}</Pill> : null}
              {item?.state === "short" ? (
                <span className="inline-flex items-center text-[11px] text-amber-700">
                  <AlertTriangle className="w-3 h-3 mr-1" /> consider sub / buy
                </span>
              ) : null}
            </div>
          </div>
        </div>

        {/* right: qty editor */}
        <QtyEditor
          value={item?.qty ?? 1}
          unit={item?.unit}
          onChange={(v) => onQtyChange?.(item, v)}
        />
      </div>

      {/* footer: actions & substitutions */}
      <div
        className={cx(
          "mt-2 flex flex-wrap items-center gap-1.5",
          dense ? "text-[11px]" : "text-xs"
        )}
      >
        <button
          type="button"
          className="px-2 py-1 rounded-md border hover:bg-gray-50"
          onClick={() =>
            onStateChange?.(item, item?.state === "have" ? "need" : "have")
          }
          title="Toggle have/need"
        >
          <Package className="w-3.5 h-3.5 inline-block mr-1" />
          {item?.state === "have" ? "Mark need" : "Mark have"}
        </button>

        {Array.isArray(item?.substitutions) && item.substitutions.length
          ? item.substitutions.slice(0, 3).map((s, i) => (
              <button
                key={`${s}-${i}`}
                type="button"
                className="px-2 py-1 rounded-md border hover:bg-gray-50"
                onClick={() => onApplySub?.(item, s)}
                title={`Substitute with ${s}`}
              >
                <Replace className="w-3.5 h-3.5 inline-block mr-1" />
                {s}
              </button>
            ))
          : null}

        <span className="flex-1" />

        <button
          type="button"
          className="px-2 py-1 rounded-md border hover:bg-gray-50"
          onClick={() => onMove?.(item, "pantry")}
          title="Move to Pantry (have)"
        >
          <MoveRight className="w-3.5 h-3.5 inline-block mr-1" />
          Pantry
        </button>

        <button
          type="button"
          className="px-2 py-1 rounded-md border hover:bg-gray-50 text-rose-700"
          onClick={() => onRemove?.(item)}
          title="Remove from list"
        >
          <Trash2 className="w-3.5 h-3.5 inline-block mr-1" />
          Remove
        </button>
      </div>
    </div>
  );
};

/* ------------------------------- Main component ------------------------------ */
/**
 * AisleGroupList
 *
 * Props:
 * - items: Item[]       (see type above)
 * - dense?: boolean     (compact spacing)
 * - searchable?: boolean
 * - householdId?: string
 * - onChange?: (nextItems) => void
 * - onEvent?: (type, payload) => void    // after eventBus/automation emits
 *
 * Events emitted (if eventBus exists):
 * - grocery.item.toggled          { id, checked }
 * - grocery.item.qtyChanged       { id, qty }
 * - grocery.item.stateChanged     { id, state }
 * - grocery.item.substituted      { id, substitution }
 * - grocery.item.moved            { id, to }
 * - grocery.item.removed          { id }
 * - grocery.aisle.collapsed       { aisle, collapsed }
 */
const AisleGroupList = ({
  items = [],
  dense = false,
  searchable = true,
  householdId = "default",
  onChange,
  onEvent,
}) => {
  const inv = useInventoryStore ? useInventoryStore() : null;
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(loadCollapsed(householdId));

  useEffect(
    () => saveCollapsed(householdId, collapsed),
    [collapsed, householdId]
  );

  const normalized = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = items.map((x, i) => ({ idx: i, ...x }));
    if (!q) return base;
    return base.filter((x) => {
      const hay = `${x.name || ""} ${x.aisle || ""} ${x.note || ""} ${(
        x.sourceRecipes || []
      )
        .map((r) => r?.title)
        .join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, query]);

  const groups = useMemo(
    () => groupBy(normalized, (x) => x.aisle || "Other"),
    [normalized]
  );
  const aisleKeys = useMemo(
    () => Object.keys(groups).sort((a, b) => a.localeCompare(b)),
    [groups]
  );

  const updateItem = useCallback(
    (idx, patch) => {
      const next = items.slice();
      next[idx] = { ...next[idx], ...patch };
      onChange?.(next);
    },
    [items, onChange]
  );

  const removeItem = useCallback(
    (idx) => {
      const next = items.slice(0, idx).concat(items.slice(idx + 1));
      onChange?.(next);
    },
    [items, onChange]
  );

  /* --------------------------------- Handlers --------------------------------- */
  const emit = (type, payload) => {
    try {
      eventBus?.emit?.(type, payload);
    } catch {}
    try {
      automation?.runTemplate?.(type, payload);
    } catch {}
    onEvent?.(type, payload);
  };

  const handleToggle = (it) => {
    updateItem(it.idx, { checked: !it.checked });
    emit("grocery.item.toggled", {
      id: it.id,
      checked: !it.checked,
      householdId,
    });
  };

  const handleQty = (it, qty) => {
    const safe = clamp(qty, 0, 9999);
    updateItem(it.idx, { qty: safe });
    emit("grocery.item.qtyChanged", { id: it.id, qty: safe, householdId });
  };

  const handleState = (it, state) => {
    updateItem(it.idx, { state });
    emit("grocery.item.stateChanged", { id: it.id, state, householdId });
    if (state === "have") {
      try {
        inv?.markHave?.(it.name, it.unit, it.qty);
      } catch {}
    }
  };

  const handleSub = (it, s) => {
    updateItem(it.idx, { name: s, state: "need" });
    toast.info(`Substituted ${it.name} → ${s}`);
    emit("grocery.item.substituted", {
      id: it.id,
      substitution: s,
      householdId,
    });
  };

  const handleMove = (it, to) => {
    // basic: pantry move === mark have
    if (to === "pantry") {
      handleState(it, "have");
      return;
    }
    emit("grocery.item.moved", { id: it.id, to, householdId });
  };

  const handleRemove = (it) => {
    removeItem(it.idx);
    toast.warn(`Removed ${it.name}`);
    emit("grocery.item.removed", { id: it.id, householdId });
  };

  const toggleAisle = (aisle) => {
    const next = {
      ...collapsed,
      [aisle || "Other"]: !collapsed[aisle || "Other"],
    };
    setCollapsed(next);
    emit("grocery.aisle.collapsed", {
      aisle: aisle || "Other",
      collapsed: next[aisle || "Other"],
      householdId,
    });
  };

  /* ----------------------------------- UI ------------------------------------ */
  const {
    Search = () => null,
    RefreshCcw = () => null,
    CheckSquare = () => null,
  } = Icons;

  const Toolbar = () => (
    <div className="mb-2 flex items-center gap-2">
      {searchable ? (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md border flex-1 min-w-[220px] bg-white/80">
          <Search className="w-4 h-4 opacity-70" />
          <input
            className="w-full text-sm outline-none bg-transparent"
            placeholder="Search items, aisles, recipes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}

      <button
        type="button"
        className="px-3 py-2 rounded-md border hover:bg-gray-50 text-sm"
        onClick={() => {
          const next = items.map((x) => ({ ...x, checked: true }));
          onChange?.(next);
          emit("grocery.items.checkAll", { count: next.length, householdId });
        }}
        title="Check all"
      >
        <CheckSquare className="w-4 h-4 inline-block mr-1" />
        Check all
      </button>

      <button
        type="button"
        className="px-3 py-2 rounded-md border hover:bg-gray-50 text-sm"
        onClick={() => {
          setQuery("");
          emit("grocery.search.cleared", { householdId });
        }}
        title="Clear filters"
      >
        <RefreshCcw className="w-4 h-4 inline-block mr-1" />
        Clear
      </button>
    </div>
  );

  return (
    <section className="rounded-2xl border p-3 bg-white/70 backdrop-blur">
      <Toolbar />

      {aisleKeys.length === 0 ? (
        <div className="text-sm text-gray-600 border rounded-xl p-6 text-center bg-white/70">
          No items match. Try clearing filters or importing from your plan.
        </div>
      ) : (
        <div className="space-y-3">
          {aisleKeys.map((k) => {
            const arr = groups[k] || [];
            const isCollapsed = !!collapsed[k];
            return (
              <div key={k} className="rounded-xl border overflow-hidden">
                <AisleHeader
                  title={k}
                  count={arr.length}
                  collapsed={isCollapsed}
                  onToggle={() => toggleAisle(k)}
                />
                {!isCollapsed ? (
                  <div className="p-2 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
                    {arr.map((it) => (
                      <ItemRow
                        key={it.id || `${it.name}-${it.idx}`}
                        item={it}
                        dense={dense}
                        onToggle={handleToggle}
                        onQtyChange={handleQty}
                        onApplySub={handleSub}
                        onMove={handleMove}
                        onRemove={handleRemove}
                        onStateChange={handleState}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};

export default AisleGroupList;
