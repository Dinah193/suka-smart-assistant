// src/pages/MealPlanning/GroceryListPanel.jsx
/* eslint-disable no-console */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { addDays, startOfWeek } from "date-fns";

/**
 * GroceryListPanel — dynamic, multi-period, planogram-aware
 * ---------------------------------------------------------------------------
 * Includes:
 * - Real-time aisle groups, “short vs have” badges, substitutions
 * - Quantity steppers, per-item notes, unit selector
 * - Store selector (planogram order when available)
 * - Options: Include “have”, Collapse duplicates, Sabbath guard toggle
 * - Pantry-aware subtraction and “Move to pantry” action
 * - Send to Mobile (SMS/Email/Web Share), PDF export (jsPDF or print fallback)
 * - Undo/Toast patterns for mark purchased / remove line
 * - Defensive against missing services (safe fallbacks)
 * ---------------------------------------------------------------------------
 */

const cx = (...a) => a.filter(Boolean).join(" ");
const Btn = ({ variant = "solid", size = "md", className, ...props }) => {
  const v = {
    solid: "bg-black text-white hover:opacity-90 disabled:opacity-50",
    outline: "border hover:bg-zinc-50",
    ghost: "hover:bg-zinc-100",
    subtle: "bg-zinc-100 hover:bg-zinc-200",
  }[variant];
  const s = {
    sm: "h-8 px-2 text-sm",
    md: "h-10 px-3 text-sm",
    icon: "h-9 w-9 p-0",
  }[size];
  return <button className={cx("rounded-xl", v, s, className)} {...props} />;
};
const Tag = ({ children, tone = "zinc" }) => (
  <span
    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium
    border-${tone}-300 text-${tone}-700 bg-${tone}-50`.replaceAll("--", "-")}
  >
    {children}
  </span>
);
const Field = (props) => (
  <input className="h-9 rounded-xl border px-2 text-sm" {...props} />
);

function StatusBadge({ need = 0, have = 0, unit = "" }) {
  const n = Number(need || 0),
    h = Number(have || 0);
  const status = n <= 0 ? "have" : h > 0 && h < n ? "short" : "need";
  const cls =
    status === "have"
      ? "bg-emerald-100 text-emerald-800 border-emerald-200"
      : status === "short"
      ? "bg-amber-100 text-amber-800 border-amber-200"
      : "bg-red-100 text-red-800 border-red-200";
  const label =
    status === "have"
      ? "Have"
      : status === "short"
      ? `Short ${(n - h).toFixed(0)}${unit ? ` ${unit}` : ""}`
      : `Need ${n.toFixed(0)}${unit ? ` ${unit}` : ""}`;
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[11px] rounded-full border ${cls}`}
    >
      {label}
    </span>
  );
}

/* -------------------------- Soft imports (defensive) -------------------------- */
let eventBus = { on: () => {}, off: () => {}, emit: () => {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.emit ? eb : eventBus;
} catch {}

let PreferencesStore = {};
try {
  PreferencesStore = require("@/store/PreferencesStore");
} catch {}

let MealPlanStore = {};
try {
  MealPlanStore = require("@/store/MealPlanStore");
} catch {}

let InventoryStore = {};
try {
  InventoryStore = require("@/store/InventoryStore");
} catch {}

let InventoryMonitor = null;
try {
  InventoryMonitor = require("@/managers/InventoryMonitor").default || null;
} catch {}

let BatchStore = {};
try {
  BatchStore = require("@/store/BatchStore");
} catch {}

let GrocerStore = {};
try {
  GrocerStore = require("@/store/GrocerStore");
} catch {}

let fmt = {
  range: (s, e) =>
    `${new Date(s).toLocaleDateString()} – ${new Date(e).toLocaleDateString()}`,
};
try {
  const f = require("@/utils/format");
  fmt = { ...fmt, ...f };
} catch {}

const nowIso = () => new Date().toISOString();
const arrayify = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/* -------------------------- Period helpers -------------------------- */
const PERIODS = [
  { key: "week", label: "Week", spec: 7 },
  { key: "2w", label: "2 Weeks", spec: 14 },
  { key: "month", label: "Month (Full Calendar)", spec: "month-full" },
  { key: "quarter", label: "Quarter (True Calendar)", spec: "quarter" },
  { key: "custom", label: "Custom", spec: "custom" },
];
function lastDayOfMonth(y, m) {
  return new Date(y, m + 1, 0);
}
function quarterStart(date) {
  const m = date.getMonth();
  const q = Math.floor(m / 3) * 3;
  return new Date(date.getFullYear(), q, 1);
}
function quarterEnd(date) {
  const s = quarterStart(date);
  return new Date(s.getFullYear(), s.getMonth() + 3, 0);
}
function enumerateDates(anchor, spec, custom) {
  if (spec === "custom") return (custom || []).slice().sort((a, b) => a - b);
  if (spec === "month-full") {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = lastDayOfMonth(anchor.getFullYear(), anchor.getMonth());
    const start = startOfWeek(first, { weekStartsOn: 0 });
    const endPad = addDays(last, (6 - last.getDay() + 7) % 7);
    const out = [];
    for (let x = new Date(start); x <= endPad; x = addDays(x, 1))
      out.push(new Date(x));
    return out;
  }
  if (spec === "quarter") {
    const s = quarterStart(anchor),
      e = quarterEnd(anchor);
    const out = [];
    for (let x = new Date(s); x <= e; x = addDays(x, 1)) out.push(new Date(x));
    return out;
  }
  if (typeof spec === "number") {
    const s = startOfWeek(anchor, { weekStartsOn: 0 });
    return Array.from({ length: spec }, (_, i) => addDays(s, i));
  }
  return [];
}

/* -------------------------- Guards & domain helpers -------------------------- */
const sabbathGuard = (prefs) => {
  const active = prefs?.torahProfile?.sabbath?.isActive;
  const handsOff = prefs?.torahProfile?.sabbath?.handsOffCooking === true;
  return !(active && handsOff);
};
function getMealsInRange(range) {
  try {
    return arrayify(MealPlanStore?.getMealsInRange?.(range.start, range.end));
  } catch {
    return [];
  }
}
function getBatchesInRange(range) {
  try {
    return arrayify(
      BatchStore?.getPlannedInRange?.(range.start, range.end) ||
        BatchStore?.getPlanned?.()
    );
  } catch {
    return [];
  }
}
function pantrySnapshot() {
  try {
    return arrayify(InventoryStore?.getAll?.() || []).map((i) => ({
      key: (i.name || i.title || "").toLowerCase().trim(),
      qty: Number(i.qty ?? 0),
      unit: i.unit || "",
    }));
  } catch {
    return [];
  }
}
function guessAisle(name = "") {
  const n = name.toLowerCase();
  if (/(apple|banana|berry|lettuce|tomato|onion|garlic|carrot)/.test(n))
    return "Produce";
  if (/(milk|cheese|yogurt|butter|egg)/.test(n)) return "Dairy";
  if (/(chicken|beef|turkey|pork|steak)/.test(n)) return "Meat";
  if (/(flour|rice|pasta|beans|oats)/.test(n)) return "Dry Goods";
  if (/(soap|detergent|towel|foil|bag)/.test(n)) return "Household";
  if (/(water|juice|cola|coffee|tea)/.test(n)) return "Beverages";
  return "Other";
}
function normalizeIngredient(x = {}) {
  const name = (x.name || x.title || "Item").trim();
  return {
    id: x.id || `ing_${Math.random().toString(36).slice(2)}`,
    name,
    qty: Number(x.qty ?? 1),
    unit: x.unit || "",
    aisle: x.aisle || guessAisle(name),
    storeId: x.storeId || null,
    tags: arrayify(x.tags),
    notes: x.notes || "",
    household: !!x.household,
    price: typeof x.price === "number" ? x.price : null,
  };
}
function buildFromMealsAndBatches({
  meals = [],
  batches = [],
  includeHousehold = true,
  collapse = true,
}) {
  const items = [];
  meals.forEach((m) =>
    arrayify(m.ingredients).forEach((ing) =>
      items.push(normalizeIngredient(ing))
    )
  );
  batches.forEach((b) =>
    arrayify(b.ingredients).forEach((ing) =>
      items.push(normalizeIngredient({ ...ing }))
    )
  );

  const src = includeHousehold ? items : items.filter((i) => !i.household);
  if (!collapse) return src;

  const map = new Map();
  src.forEach((i) => {
    const key = `${i.name.toLowerCase()}|${i.unit}|${i.aisle}`;
    const cur = map.get(key);
    map.set(key, cur ? { ...cur, qty: (cur.qty || 0) + (i.qty || 0) } : i);
  });
  return Array.from(map.values());
}
function applyPantry(list, pantry) {
  const pMap = new Map(pantry.map((p) => [p.key, p]));
  return list.map((i) => {
    const k = i.name.toLowerCase();
    const p = pMap.get(k);
    const need = Math.max(0, (i.qty || 0) - (p?.qty || 0));
    return { ...i, have: Math.min(i.qty || 0, p?.qty || 0), need };
  });
}
function planogramOrder(storeId) {
  try {
    return arrayify(GrocerStore?.getAisleOrder?.(storeId));
  } catch {
    return [];
  }
}
function priceFor(storeId, itemName) {
  try {
    return GrocerStore?.estimatePrice?.(storeId, itemName) ?? null;
  } catch {
    return null;
  }
}
function groupByAisle(list, orderOverride = []) {
  const aisles = {};
  list.forEach((i) => {
    aisles[i.aisle] = aisles[i.aisle] || [];
    aisles[i.aisle].push(i);
  });
  const defaultOrder = [
    "Produce",
    "Meat",
    "Seafood",
    "Dairy",
    "Bakery",
    "Frozen",
    "Dry Goods",
    "Beverages",
    "Household",
    "Other",
  ];
  const order = orderOverride.length ? orderOverride : defaultOrder;
  const sorted = Object.keys(aisles).sort(
    (a, b) => order.indexOf(a) - order.indexOf(b)
  );
  return { aisles, order: sorted };
}
function suggestSubs(item) {
  const n = item.name.toLowerCase();
  if (/yogurt/.test(n)) return ["Skyr (plain)", "Greek yogurt (low-fat)"];
  if (/spinach/.test(n)) return ["Kale", "Arugula"];
  if (/chicken breast/.test(n))
    return ["Turkey breast", "Chicken thighs (trimmed)"];
  if (/rice/.test(n)) return ["Quinoa", "Cauliflower rice"];
  return [];
}
const keyFor = (storeId, range) =>
  `suka:grocery:${storeId}:${new Date(range.start).toDateString()}_${new Date(
    range.end
  ).toDateString()}`;

/* -------------------------- Component -------------------------- */
export default function GroceryListPanel({
  defaultStoreId = "any",
  initialRange,
  include = { meals: true, batches: true, household: true },
  onGenerated = () => {},
}) {
  // Prefs & guards
  const [prefs, setPrefs] = useState(() => {
    try {
      return PreferencesStore?.getPreferences?.() || {};
    } catch {
      return {};
    }
  });
  // Sabbath override: null = follow prefs; true = enforce guard; false = disable guard
  const [sabbathOverrideOn, setSabbathOverrideOn] = useState(null);
  const sabbathBlocked = useMemo(() => {
    const prefer = sabbathGuard(prefs);
    const effective = sabbathOverrideOn === null ? prefer : sabbathOverrideOn;
    return !effective;
  }, [prefs, sabbathOverrideOn]);

  // Period & range
  const today = new Date();
  const [periodKey, setPeriodKey] = useState("week");
  const spec = useMemo(
    () => PERIODS.find((p) => p.key === periodKey)?.spec,
    [periodKey]
  );
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const customDates = useMemo(() => {
    if (spec !== "custom" || !customStart || !customEnd) return [];
    const s = new Date(customStart),
      e = new Date(customEnd);
    if (isNaN(s) || isNaN(e) || s > e) return [];
    const out = [];
    for (let d = new Date(s); d <= e; d = addDays(d, 1)) out.push(new Date(d));
    return out;
  }, [spec, customStart, customEnd]);
  const [anchor, setAnchor] = useState(startOfWeek(today, { weekStartsOn: 0 }));

  const resolvedRange = useMemo(() => {
    if (initialRange?.start && initialRange?.end) return initialRange;
    const days = enumerateDates(anchor, spec, customDates);
    const start = days[0] || anchor;
    const end = days[days.length - 1] || addDays(anchor, 6);
    return { start, end };
  }, [initialRange, anchor, spec, customDates]);

  // Store & options
  const [storeId, setStoreId] = useState(defaultStoreId);
  const storeOptions = useMemo(() => {
    try {
      const xs = arrayify(
        GrocerStore?.getStores?.() || [{ id: "any", name: "Any store" }]
      );
      return xs.map((s) => ({ id: s.id, name: s.name || s.title || "Store" }));
    } catch {
      return [
        { id: "any", name: "Any store" },
        { id: "aldi", name: "Aldi" },
        { id: "costco", name: "Costco" },
      ];
    }
  }, []);

  // State
  const [list, setList] = useState([]);
  const [checked, setChecked] = useState(new Set());
  const [notes, setNotes] = useState({});
  const [includeHave, setIncludeHave] = useState(false);
  const [collapseDuplicates, setCollapseDuplicates] = useState(true);
  const [budget, setBudget] = useState("");
  const [undoStack, setUndoStack] = useState([]);
  const [toast, setToast] = useState(null);

  // Load persisted state
  useEffect(() => {
    const k = keyFor(storeId, resolvedRange);
    try {
      const cached = JSON.parse(localStorage.getItem(k) || "null");
      if (cached?.items) {
        setList(cached.items);
        setNotes(cached.notes || {});
        setChecked(new Set(cached.checked || []));
      }
    } catch {}
  }, [storeId, resolvedRange.start, resolvedRange.end]);

  // Build list
  const rebuild = useCallback(() => {
    const meals = include.meals ? getMealsInRange(resolvedRange) : [];
    const batches = include.batches ? getBatchesInRange(resolvedRange) : [];
    let items = buildFromMealsAndBatches({
      meals,
      batches,
      includeHousehold: !!include.household,
      collapse: collapseDuplicates,
    });
    items = applyPantry(items, pantrySnapshot());
    items = items.map((i) => {
      const price = priceFor(storeId, i.name);
      return {
        ...i,
        storeId: i.storeId || (storeId !== "any" ? storeId : null),
        price: i.price ?? price,
      };
    });
    setList(items);
    setChecked(new Set());
    eventBus.emit("grocerylist.generated", {
      at: nowIso(),
      items,
      range: resolvedRange,
      storeId,
    });
    onGenerated?.({ items, range: resolvedRange, storeId });
  }, [resolvedRange, storeId, include, collapseDuplicates, onGenerated]);
  useEffect(() => {
    rebuild();
  }, [rebuild]);

  // React to external changes
  useEffect(() => {
    const syncPrefs = () => {
      try {
        setPrefs(PreferencesStore?.getPreferences?.() || {});
      } catch {}
    };
    const rerun = () => rebuild();
    const handlers = [
      ["preferences.changed", syncPrefs],
      ["mealplan.updated", rerun],
      ["inventory.updated", rerun],
      ["batch.updated", rerun],
    ];
    handlers.forEach(([e, fn]) => eventBus.on(e, fn));
    return () => handlers.forEach(([e, fn]) => eventBus.off(e, fn));
  }, [rebuild]);

  // Persist
  useEffect(() => {
    const k = keyFor(storeId, resolvedRange);
    try {
      localStorage.setItem(
        k,
        JSON.stringify({ items: list, notes, checked: [...checked] })
      );
    } catch {}
  }, [list, notes, checked, storeId, resolvedRange.start, resolvedRange.end]);

  // Derivations
  const planogram = useMemo(() => planogramOrder(storeId), [storeId]);
  const { aisles, order } = useMemo(
    () => groupByAisle(list, planogram),
    [list, planogram]
  );

  const visibleItems = useMemo(() => {
    if (includeHave) return list;
    return list.filter((i) => (i.need ?? i.qty) > 0);
  }, [list, includeHave]);

  const totals = useMemo(() => {
    const lines = visibleItems.length;
    const needUnits = visibleItems.reduce(
      (acc, i) => acc + (i.need ?? i.qty ?? 0),
      0
    );
    const est = visibleItems.reduce(
      (acc, i) =>
        acc +
        (typeof i.price === "number" ? i.price * (i.need || i.qty || 0) : 0),
      0
    );
    return { lines, needUnits, est: est > 0 ? est : null };
  }, [visibleItems]);

  /* -------------------------- Actions -------------------------- */
  const stepQty = (id, delta) => {
    setList((xs) =>
      xs.map((i) =>
        i.id === id
          ? {
              ...i,
              qty: clamp((i.qty || 0) + delta, 0, 10000),
              need: clamp(((i.need ?? i.qty) || 0) + delta, 0, 10000),
            }
          : i
      )
    );
  };
  const changeUnit = (id, unit) =>
    setList((xs) => xs.map((i) => (i.id === id ? { ...i, unit } : i)));
  const toggleCheck = (id) =>
    setChecked((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  // Remove single line (with undo)
  const removeLine = (id) => {
    const prev = list;
    const next = list.filter((i) => i.id !== id);
    setList(next);
    setUndoStack((s) => [...s, { type: "remove", prev }]);
    setToast({
      type: "success",
      msg: "Removed line.",
      actionLabel: "Undo",
      onAction: () => undo(),
    });
  };

  // Mark purchased (set need=0 for checked)
  const markPurchased = () => {
    if (!checked.size)
      return setToast({ type: "info", msg: "Select items to mark purchased." });
    const prev = list;
    const next = list.map((i) => (checked.has(i.id) ? { ...i, need: 0 } : i));
    setList(next);
    setUndoStack((s) => [...s, { type: "mark", prev }]);
    setChecked(new Set());
    setToast({
      type: "success",
      msg: "Marked purchased.",
      actionLabel: "Undo",
      onAction: () => undo(),
    });
    eventBus.emit("shopping.purchased", {
      at: nowIso(),
      items: next.filter((i) => i.need === 0),
      storeId,
    });
  };

  // Move to pantry (increase inventory and set need=0)
  const moveToPantry = (item) => {
    const qty = item.need ?? item.qty ?? 0;
    if (!qty) return;
    let ok = false;
    try {
      if (InventoryStore?.increment) {
        InventoryStore.increment(item.name, qty, item.unit || "");
        ok = true;
      } else if (InventoryStore?.upsert) {
        const current = arrayify(InventoryStore.getAll?.()).find(
          (x) => (x.name || "").toLowerCase() === item.name.toLowerCase()
        );
        const nextQty = (current?.qty || 0) + qty;
        InventoryStore.upsert({
          name: item.name,
          qty: nextQty,
          unit: item.unit || current?.unit || "",
        });
        ok = true;
      } else if (InventoryStore?.add) {
        InventoryStore.add({ name: item.name, qty, unit: item.unit || "" });
        ok = true;
      }
    } catch {}
    if (!ok && InventoryMonitor?.add) {
      try {
        InventoryMonitor.add({ name: item.name, qty, unit: item.unit || "" });
        ok = true;
      } catch {}
    }
    eventBus.emit("inventory.updated", {
      at: nowIso(),
      method: "moveToPantry",
      name: item.name,
      qty,
      unit: item.unit || "",
    });

    setList((xs) =>
      xs.map((i) =>
        i.id === item.id ? { ...i, have: (i.have || 0) + qty, need: 0 } : i
      )
    );
    setToast({ type: "success", msg: "Moved to pantry." });
  };

  const undo = () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((s) => s.slice(0, -1));
    if (last.type === "mark" || last.type === "remove") setList(last.prev);
    setToast({ type: "info", msg: "Undone." });
  };

  const generateList = () => {
    if (sabbathBlocked)
      return setToast({
        type: "warning",
        msg: "Sabbath hands-off is active. Generation is paused.",
      });
    rebuild();
    setToast({
      type: "success",
      msg: `List ready for ${fmt.range(
        resolvedRange.start,
        resolvedRange.end
      )}.`,
    });
  };

  // Send to shopper (existing in your system)
  const sendToShopper = () => {
    const items = visibleItems;
    if (!items.length)
      return setToast({ type: "info", msg: "Your list is empty." });
    eventBus.emit("sharing.open", {
      panel: "FamilySharing",
      payload: {
        purpose: "shopping",
        storeId,
        range: resolvedRange,
        items,
        budget: budget || null,
      },
    });
    setToast({ type: "success", msg: "Sent to shopper." });
  };

  // Send to Mobile (SMS / Email / Web Share)
  const formatListText = (items) => {
    const lines = items.map(
      (i) =>
        `• ${i.name} — ${i.need ?? i.qty} ${i.unit || ""}${
          notes[i.id] ? ` (${notes[i.id]})` : ""
        }`
    );
    const storeName = storeOptions.find((s) => s.id === storeId)?.name || "Any";
    return [
      `Grocery List — ${fmt.range(resolvedRange.start, resolvedRange.end)}`,
      `Store: ${storeName}`,
      "",
      ...lines,
    ].join("\n");
  };
  const sendToMobileSMS = () => {
    const msg = encodeURIComponent(formatListText(visibleItems));
    if (navigator.share) {
      navigator
        .share({ title: "Grocery List", text: decodeURIComponent(msg) })
        .catch(() => {});
      setToast({ type: "success", msg: "Shared via system sheet." });
      return;
    }
    const smsUrl = `sms:?&body=${msg}`;
    window.open(smsUrl, "_blank");
    setToast({ type: "success", msg: "Opened SMS with your list." });
  };
  const sendToMobileEmail = () => {
    const subject = encodeURIComponent(
      `Grocery List (${fmt.range(resolvedRange.start, resolvedRange.end)})`
    );
    const body = encodeURIComponent(formatListText(visibleItems));
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
    setToast({ type: "success", msg: "Opened email with your list." });
  };

  // Export to PDF (jsPDF if available; fallback to print)
  const exportPDF = async () => {
    const items = visibleItems;
    if (!items.length)
      return setToast({ type: "info", msg: "Nothing to export." });
    let jsPDF = null,
      autoTable = null;
    try {
      jsPDF = require("jspdf").jsPDF || require("jspdf");
      try {
        autoTable = require("jspdf-autotable");
      } catch {}
    } catch {}
    if (!jsPDF) {
      const html = `
        <html>
          <head>
            <title>Grocery List</title>
            <style>
              body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:24px}
              h1{font-size:18px;margin:0 0 12px}
              h2{font-size:14px;margin:16px 0 8px}
              table{width:100%;border-collapse:collapse;font-size:12px}
              th,td{border:1px solid #ddd;padding:6px;text-align:left}
              .muted{color:#666}
            </style>
          </head>
          <body>
            <h1>Grocery List — ${fmt.range(
              resolvedRange.start,
              resolvedRange.end
            )}</h1>
            <div class="muted">Store: ${
              storeOptions.find((s) => s.id === storeId)?.name || "Any"
            }</div>
            ${order
              .map((aisle) => {
                const rows = (aisles[aisle] || []).filter((i) =>
                  visibleItems.includes(i)
                );
                if (!rows.length) return "";
                const trows = rows
                  .map(
                    (r) =>
                      `<tr><td>${r.name}</td><td>${r.need ?? r.qty} ${
                        r.unit || ""
                      }</td><td>${r.have || 0}</td><td>${
                        notes[r.id] || ""
                      }</td></tr>`
                  )
                  .join("");
                return `<h2>${aisle}</h2><table><thead><tr><th>Item</th><th>Need</th><th>Have</th><th>Notes</th></tr></thead><tbody>${trows}</tbody></table>`;
              })
              .join("")}
          </body>
        </html>`;
      const w = window.open("", "print");
      if (w) {
        w.document.open();
        w.document.write(html);
        w.document.close();
        w.focus();
        w.print();
      }
      setToast({
        type: "success",
        msg: "Opened printer dialog (PDF fallback).",
      });
      return;
    }
    const doc = new jsPDF({ unit: "pt", format: "letter" });
    const title = `Grocery List — ${fmt.range(
      resolvedRange.start,
      resolvedRange.end
    )}`;
    doc.setFontSize(14);
    doc.text(title, 40, 40);
    doc.setFontSize(10);
    doc.text(
      `Store: ${storeOptions.find((s) => s.id === storeId)?.name || "Any"}`,
      40,
      58
    );

    let y = 80;
    for (const aisle of order) {
      const rows = (aisles[aisle] || []).filter((i) =>
        visibleItems.includes(i)
      );
      if (!rows.length) continue;
      doc.setFontSize(12);
      doc.text(aisle, 40, y);
      y += 12;

      if (autoTable) {
        autoTable.default?.(doc, {
          startY: y,
          head: [["Item", "Need", "Have", "Notes"]],
          body: rows.map((r) => [
            r.name,
            `${r.need ?? r.qty} ${r.unit || ""}`,
            `${r.have || 0}`,
            `${notes[r.id] || ""}`,
          ]),
          styles: { fontSize: 9 },
          margin: { left: 40, right: 40 },
          theme: "grid",
        });
        y = doc.lastAutoTable.finalY + 16;
      } else {
        rows.forEach((r) => {
          doc.setFontSize(10);
          doc.text(
            `• ${r.name} — ${r.need ?? r.qty} ${r.unit || ""} (have ${
              r.have || 0
            }) ${notes[r.id] ? `— ${notes[r.id]}` : ""}`,
            50,
            y
          );
          y += 14;
          if (y > 720) {
            doc.addPage();
            y = 40;
          }
        });
        y += 12;
      }
    }
    const ts = new Date().toISOString().slice(0, 10);
    doc.save(`grocery-list-${ts}.pdf`);
    setToast({ type: "success", msg: "Exported PDF." });
  };

  const openSubstitutions = (item) => {
    const subs = suggestSubs(item);
    if (!subs.length)
      return setToast({ type: "info", msg: "No suggestions available." });
    const pick =
      typeof window !== "undefined"
        ? window.prompt(
            `Substitute for "${item.name}":\n- ${subs.join(
              "\n- "
            )}\n\nType your choice:`
          )
        : "";
    if (pick) {
      setList((xs) =>
        xs.map((i) => (i.id === item.id ? { ...i, name: pick } : i))
      );
      setToast({
        type: "success",
        msg: `Replaced "${item.name}" → "${pick}".`,
      });
    }
  };

  const jumpPrev = () => {
    const spec = PERIODS.find((p) => p.key === periodKey)?.spec;
    if (spec === "month-full")
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1));
    else if (spec === "quarter")
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() - 3, 1));
    else if (typeof spec === "number") setAnchor(addDays(anchor, -spec));
    else setAnchor(addDays(anchor, -7));
  };
  const jumpNext = () => {
    const spec = PERIODS.find((p) => p.key === periodKey)?.spec;
    if (spec === "month-full")
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1));
    else if (spec === "quarter")
      setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + 3, 1));
    else if (typeof spec === "number") setAnchor(addDays(anchor, spec));
    else setAnchor(addDays(anchor, 7));
  };

  const Toast = () =>
    toast ? (
      <div
        className={cx(
          "fixed bottom-4 right-4 z-50 max-w-sm rounded-xl px-4 py-3 shadow-lg",
          toast.type === "success" && "bg-green-600 text-white",
          toast.type === "warning" && "bg-yellow-600 text-white",
          toast.type === "error" && "bg-red-600 text-white",
          toast.type === "info" && "bg-zinc-900 text-white"
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

  /* -------------------------- Render -------------------------- */
  return (
    <section className="flex flex-col gap-4">
      <Toast />

      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Grocery List</h2>
          <Tag tone="zinc">
            {fmt.range(resolvedRange.start, resolvedRange.end)}
          </Tag>
          {!sabbathBlocked ? null : <Tag tone="violet">Sabbath: hands-off</Tag>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1">
            <Btn
              variant="ghost"
              size="icon"
              onClick={jumpPrev}
              aria-label="Previous period"
            >
              ←
            </Btn>
            <Btn
              variant="ghost"
              size="icon"
              onClick={jumpNext}
              aria-label="Next period"
            >
              →
            </Btn>
          </div>
          <select
            className="rounded-xl border px-2 py-2 text-sm"
            value={periodKey}
            onChange={(e) => setPeriodKey(e.target.value)}
          >
            {PERIODS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>

          {periodKey === "custom" && (
            <div className="flex items-center gap-2">
              <Field
                type="date"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
              <span className="text-sm text-zinc-500">to</span>
              <Field
                type="date"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </div>
          )}

          <select
            className="rounded-xl border px-2 py-2 text-sm"
            value={storeId}
            onChange={(e) => setStoreId(e.target.value)}
          >
            {storeOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>

          <Btn variant="outline" onClick={generateList}>
            Generate
          </Btn>
          <Btn variant="solid" onClick={sendToShopper} disabled={!list.length}>
            Send to shopper
          </Btn>
          <Btn
            variant="outline"
            onClick={sendToMobileSMS}
            disabled={!list.length}
          >
            SMS
          </Btn>
          <Btn
            variant="outline"
            onClick={sendToMobileEmail}
            disabled={!list.length}
          >
            Email
          </Btn>
          <Btn variant="outline" onClick={exportPDF} disabled={!list.length}>
            PDF
          </Btn>
        </div>
      </header>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={includeHave}
            onChange={(e) => setIncludeHave(e.target.checked)}
          />
          Include “have”
        </label>

        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={collapseDuplicates}
            onChange={(e) => setCollapseDuplicates(e.target.checked)}
          />
          Collapse duplicates
        </label>

        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={
              sabbathOverrideOn === null
                ? sabbathGuard(prefs)
                : sabbathOverrideOn
            }
            onChange={(e) => setSabbathOverrideOn(e.target.checked)}
          />
          Sabbath guard
        </label>

        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={!!include.household}
            onChange={() => {}}
            readOnly
          />
          Include household
        </label>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-zinc-500">Budget</span>
          <Field
            placeholder="$…"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
        </div>
      </div>

      {/* Empty State */}
      {!list.length ? (
        <div className="rounded-2xl border border-dashed p-6 text-center">
          <div className="mb-1 text-lg font-semibold">No items yet</div>
          <p className="mx-auto max-w-md text-sm text-zinc-600">
            Generate from your meal plan and sessions for this period. We’ll
            group by aisle and subtract what you already have.
          </p>
          <div className="mt-3">
            <Btn
              variant="outline"
              onClick={() => eventBus.emit("ui.open", { id: "MealPlanner" })}
            >
              Open Meal Planner
            </Btn>
          </div>
        </div>
      ) : (
        <>
          {/* Summary */}
          <div className="flex flex-wrap items-center justify-between rounded-2xl border bg-zinc-50 p-3 text-sm">
            <div className="mb-2 sm:mb-0">
              <span className="font-semibold">{totals.lines}</span> lines •{" "}
              <span className="font-semibold">{totals.needUnits}</span> total
              needed
              {typeof totals.est === "number" ? (
                <>
                  {" "}
                  • Est{" "}
                  <span className="font-semibold">
                    ${totals.est.toFixed(2)}
                  </span>
                </>
              ) : null}
              {budget ? (
                <>
                  {" "}
                  • Budget <span className="font-semibold">{budget}</span>
                </>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <Btn
                variant="outline"
                onClick={markPurchased}
                disabled={!list.some((i) => checked.has(i.id))}
              >
                Mark purchased
              </Btn>
              <Btn
                variant="outline"
                onClick={undo}
                disabled={!undoStack.length}
              >
                Undo
              </Btn>
            </div>
          </div>

          {/* Aisle groups */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            {order.map((aisle) => {
              const items = (aisles[aisle] || []).filter((i) =>
                visibleItems.includes(i)
              );
              if (!items.length) return null;
              return (
                <div key={aisle} className="lg:col-span-6">
                  <div className="rounded-2xl border">
                    <div className="flex items-center justify-between border-b p-3">
                      <div className="text-sm font-semibold">{aisle}</div>
                      <button
                        className="text-xs underline"
                        onClick={() =>
                          eventBus.emit("ui.open", {
                            id: "AisleEditor",
                            aisle,
                            storeId,
                          })
                        }
                      >
                        Edit aisle
                      </button>
                    </div>
                    <ul className="max-h-96 space-y-2 overflow-auto p-3 pr-2">
                      {items.map((i) => {
                        const isChecked = checked.has(i.id);
                        const subs = suggestSubs(i);
                        return (
                          <li
                            key={i.id}
                            className={cx(
                              "rounded-2xl border p-3 text-xs",
                              isChecked && "opacity-60"
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <label className="flex items-center gap-2">
                                <input
                                  type="checkbox"
                                  checked={isChecked}
                                  onChange={() => toggleCheck(i.id)}
                                />
                                <span className="font-medium">{i.name}</span>
                                <StatusBadge
                                  need={i.need ?? i.qty ?? 0}
                                  have={i.have ?? 0}
                                  unit={i.unit || ""}
                                />
                                {typeof i.price === "number" && (
                                  <span className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-[10px] text-zinc-700">
                                    ${i.price.toFixed(2)}/{i.unit || "ea"}
                                  </span>
                                )}
                              </label>
                              <div className="shrink-0 text-zinc-500">
                                {i.unit}
                              </div>
                            </div>

                            <div className="mt-2 flex flex-wrap items-center gap-2">
                              <div className="flex items-center gap-1">
                                <Btn
                                  variant="outline"
                                  size="sm"
                                  onClick={() => stepQty(i.id, -1)}
                                >
                                  -
                                </Btn>
                                <div className="w-10 text-center">
                                  {i.need ?? i.qty}
                                </div>
                                <Btn
                                  variant="outline"
                                  size="sm"
                                  onClick={() => stepQty(i.id, +1)}
                                >
                                  +
                                </Btn>
                              </div>

                              <select
                                className="rounded-xl border px-2 py-1"
                                value={i.unit}
                                onChange={(e) =>
                                  changeUnit(i.id, e.target.value)
                                }
                              >
                                <option value="">unit</option>
                                <option value="g">g</option>
                                <option value="kg">kg</option>
                                <option value="oz">oz</option>
                                <option value="lb">lb</option>
                                <option value="ml">ml</option>
                                <option value="l">l</option>
                                <option value="pcs">pcs</option>
                                <option value="bag">bag</option>
                              </select>

                              {subs.length > 0 && (
                                <button
                                  className="rounded-xl border px-2 py-1 text-xs hover:bg-zinc-50"
                                  onClick={() => openSubstitutions(i)}
                                >
                                  Substitute
                                </button>
                              )}

                              <button
                                className="rounded-xl border px-2 py-1 text-xs hover:bg-zinc-50"
                                onClick={() => moveToPantry(i)}
                                title="Increase inventory and set need=0"
                              >
                                Move to pantry
                              </button>

                              <button
                                className="rounded-xl border px-2 py-1 text-xs hover:bg-zinc-50 text-red-700"
                                onClick={() => removeLine(i.id)}
                                title="Remove line"
                              >
                                Remove
                              </button>

                              <div className="ml-auto flex items-center gap-1">
                                <span className="text-zinc-500">Notes</span>
                                <Field
                                  placeholder="brand, size…"
                                  value={notes[i.id] || ""}
                                  onChange={(e) =>
                                    setNotes((n) => ({
                                      ...n,
                                      [i.id]: e.target.value,
                                    }))
                                  }
                                />
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                </div>
              );
            })}
          </div>

          {/* NBA */}
          <div className="flex flex-wrap items-center justify-between rounded-2xl border bg-zinc-50 p-3">
            <div className="text-sm">
              <span className="font-semibold">Next Best Action:</span> Share or
              export your list.
            </div>
            <div className="flex items-center gap-2">
              <Btn variant="outline" onClick={sendToShopper}>
                Send to shopper
              </Btn>
              <Btn variant="outline" onClick={sendToMobileSMS}>
                SMS
              </Btn>
              <Btn variant="outline" onClick={sendToMobileEmail}>
                Email
              </Btn>
              <Btn variant="outline" onClick={exportPDF}>
                PDF
              </Btn>
            </div>
          </div>
        </>
      )}
    </section>
  );
}

/* ===========================
   Dev-time smoke tests (once)
   =========================== */
(function runGroceryListPanelTestsOnce() {
  if (typeof window === "undefined" || window.__GROCERY_PANEL_TESTS__) return;
  window.__GROCERY_PANEL_TESTS__ = true;

  const expect = (cond, msg) =>
    cond
      ? console.log("[GroceryPanel PASS]", msg)
      : console.error("[GroceryPanel FAIL]", msg);
  const week = enumerateDates(new Date(2025, 0, 14), 7).length;
  expect(week === 7, "Week enumerates 7 days");
  const juneFull = enumerateDates(new Date(2025, 5, 10), "month-full").length;
  expect(juneFull === 35, "Month-full padded grid is consistent");
  const q1 = enumerateDates(new Date(2025, 0, 15), "quarter").length;
  expect(q1 === 90, "Quarter enumerates correctly");

  const demoMeals = [
    {
      ingredients: [
        { name: "Chicken breast", qty: 2, unit: "pcs" },
        { name: "Greek yogurt", qty: 1, unit: "cup" },
      ],
    },
  ];
  const list = buildFromMealsAndBatches({
    meals: demoMeals,
    batches: [],
    includeHousehold: true,
    collapse: true,
  });
  expect(list.length >= 2, "Build list produces items");
  const pantry = [{ key: "chicken breast", qty: 1 }];
  const applied = applyPantry(list, pantry);
  expect(
    (applied.find((i) => /chicken/.test(i.name.toLowerCase()))?.need ?? 0) >= 1,
    "Pantry subtraction works"
  );
})();
