// src/components/cleaning/ToolChecklistPanel.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  CheckCircle,
  XCircle,
  PlusCircle,
  Zap,
  Bot,
  // Broom, // ❌ not exported by your lucide-react build
  Wrench,
  Search,
  Filter,
  X,
  AlertTriangle,
  ShoppingCart,
  Handshake,
  Hammer,
  CalendarDays,
  Info,
  Brush, // ✅ replace Broom with Brush (exists in lucide-react builds)
} from "lucide-react";

/**
 * ToolChecklistPanel — equipment-aware, borrow/buy smart, Sabbath-friendly
 * -------------------------------------------------------------------------
 * Drop-in replacement; no required props.
 *
 * Optional props (all safe to omit):
 *  - initialTools?: Array<{ id:string, name:string, type:'manual'|'electric'|'smart'|'custom', status?:'available'|'missing'|'borrow'|'repair', qty?:number, tags?:string[] }>
 *  - equipmentInventory?: Array<{ key|id:string, qty?:number }>
 *  - preferences?: { toolAcquireMode?:'buy'|'borrow', toolSubstitutions?: Record<string,string[]> }
 *  - saturdayAsSabbath?: boolean
 *  - hebrewDayOfWeek?: (Date)=>number
 *  - onChange?: (tools)=>void
 *  - onExport?: (payload)=>void                 // fires when resolve actions run
 *
 * Status flow (toggle):
 *  available → missing → borrow → repair → available
 */

// ---------------- Utilities ----------------
const pretty = (s = "") =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const keyOf = (x) => (x && (x.key || x.id)) || "";
const setFrom = (arr = []) => {
  const s = new Set();
  arr.forEach((x) => s.add(keyOf(x)));
  return s;
};
const iso = (d = new Date()) => new Date(d).toISOString();

function isSabbath(
  dateObj,
  { saturdayAsSabbath = false, hebrewDayOfWeek } = {}
) {
  if (saturdayAsSabbath) return dateObj.getDay() === 6; // Saturday
  if (typeof hebrewDayOfWeek === "function")
    return hebrewDayOfWeek(dateObj) === 7; // Hebrew Day-7
  return false;
}

// Sandbox-safe AutomationBus shim
async function _useAutomationBus() {
  return { emit: () => {}, invoke: async () => {} };
}

// ---------------- Fallback tool templates ----------------
const FALLBACK_TOOLS = [
  {
    id: "tl_mop_bucket",
    name: "Mop & Bucket",
    type: "manual",
    status: "available",
    tags: ["floors"],
  },
  {
    id: "tl_scrub_brush",
    name: "Scrub Brush",
    type: "manual",
    status: "available",
    tags: ["scrub"],
  },
  {
    id: "tl_vacuum",
    name: "Vacuum Cleaner",
    type: "electric",
    status: "missing",
    tags: ["carpet"],
  },
  {
    id: "tl_steam_cleaner",
    name: "Steam Cleaner",
    type: "electric",
    status: "missing",
    tags: ["bath", "kitchen"],
  },
  {
    id: "tl_robot_vac",
    name: "Robot Vacuum (Roomba)",
    type: "smart",
    status: "missing",
    tags: ["automation"],
  },
  {
    id: "tl_microfiber",
    name: "Microfiber Cloths",
    type: "manual",
    status: "available",
    tags: ["dust", "glass"],
    qty: 6,
  },
  {
    id: "tl_squeegee",
    name: "Squeegee",
    type: "manual",
    status: "missing",
    tags: ["glass"],
  },
];

// ---------------- Component ----------------
export default function ToolChecklistPanel({
  initialTools,
  equipmentInventory = [],
  preferences = { toolAcquireMode: "buy", toolSubstitutions: {} },
  saturdayAsSabbath = false,
  hebrewDayOfWeek,
  onChange,
  onExport,
}) {
  // Seed & persistence
  const [tools, setTools] = useState(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("toolChecklist.v1") || "null"
      );
      if (Array.isArray(saved)) return saved;
    } catch {}
    const seed = initialTools || FALLBACK_TOOLS;
    // normalize ids to strings
    return seed.map((t) => ({
      id: String(t.id),
      name: t.name,
      type: t.type || "custom",
      status: t.status || "available",
      qty: t.qty,
      tags: t.tags || [],
    }));
  });

  // UI state
  const [filter, setFilter] = useState(() => {
    try {
      return localStorage.getItem("toolChecklist.filter") || "all";
    } catch {
      return "all";
    }
  });
  const [q, setQ] = useState(() => {
    try {
      return localStorage.getItem("toolChecklist.q") || "";
    } catch {
      return "";
    }
  });
  const [customInput, setCustomInput] = useState("");
  const [qtyInput, setQtyInput] = useState("");

  // Persist
  useEffect(() => {
    try {
      localStorage.setItem("toolChecklist.v1", JSON.stringify(tools));
    } catch {}
  }, [tools]);
  useEffect(() => {
    try {
      localStorage.setItem("toolChecklist.filter", filter);
    } catch {}
  }, [filter]);
  useEffect(() => {
    try {
      localStorage.setItem("toolChecklist.q", q);
    } catch {}
  }, [q]);
  useEffect(() => {
    try {
      onChange && onChange(tools);
    } catch {}
  }, [tools, onChange]);

  // Derived
  const invSet = useMemo(
    () => setFrom(equipmentInventory),
    [equipmentInventory]
  );
  const sabbathActive = useMemo(
    () => isSabbath(new Date(), { saturdayAsSabbath, hebrewDayOfWeek }),
    [saturdayAsSabbath, hebrewDayOfWeek]
  );

  const filteredTools = useMemo(() => {
    const text = q.trim().toLowerCase();
    return tools.filter((t) => {
      if (filter !== "all" && t.type !== filter) return false;
      if (!text) return true;
      const hay = [t.name, t.type, ...(t.tags || [])].join(" ").toLowerCase();
      return hay.includes(text);
    });
  }, [tools, filter, q]);

  const counts = useMemo(() => {
    const all = tools.length;
    const manual = tools.filter((t) => t.type === "manual").length;
    const electric = tools.filter((t) => t.type === "electric").length;
    const smart = tools.filter((t) => t.type === "smart").length;
    const available = tools.filter((t) => t.status === "available").length;
    const missing = tools.filter((t) => t.status === "missing").length;
    const borrow = tools.filter((t) => t.status === "borrow").length;
    const repair = tools.filter((t) => t.status === "repair").length;
    return { all, manual, electric, smart, available, missing, borrow, repair };
  }, [tools]);

  // Helpers
  const cycleStatus = useCallback((s) => {
    if (s === "available") return "missing";
    if (s === "missing") return "borrow";
    if (s === "borrow") return "repair";
    return "available";
  }, []);

  const toggleStatus = useCallback(
    (id) => {
      setTools((list) =>
        list.map((t) =>
          t.id === id ? { ...t, status: cycleStatus(t.status) } : t
        )
      );
    },
    [cycleStatus]
  );

  const handleAddCustom = useCallback(() => {
    if (!customInput.trim()) return;
    const id = customInput.trim().toLowerCase().replace(/\s+/g, "_");
    setTools((list) => [
      ...list,
      {
        id,
        name: customInput.trim(),
        type: "custom",
        status: "available",
        qty: qtyInput ? Number(qtyInput) : undefined,
      },
    ]);
    setCustomInput("");
    setQtyInput("");
  }, [customInput, qtyInput]);

  const markAll = useCallback((next) => {
    setTools((list) => list.map((t) => ({ ...t, status: next })));
  }, []);

  // Resolve actions
  async function resolveMissing() {
    const bus = await _useAutomationBus();
    const acqMode = preferences?.toolAcquireMode || "buy";
    const missing = tools.filter((t) => t.status === "missing");
    if (!missing.length) return;

    if (acqMode === "borrow") {
      const payload = {
        source: "ToolChecklistPanel",
        createdAt: iso(),
        tools: missing.map((t) => ({
          key: t.id,
          name: t.name,
          qty: t.qty || 1,
        })),
      };
      try {
        bus.emit && bus.emit("tools/requestBorrow", payload);
      } catch {}
      try {
        onExport && onExport({ type: "borrow", payload });
      } catch {}
    } else {
      const payload = {
        source: "ToolChecklistPanel",
        createdAt: iso(),
        items: missing.map((t) => ({
          name: t.name,
          qty: t.qty || 1,
          unit: "item",
          tags: ["cleaning-tools"],
          note: "Tool required",
        })),
      };
      try {
        bus.emit && bus.emit("shopping/addItems", payload);
      } catch {}
      try {
        onExport && onExport({ type: "shopping", payload });
      } catch {}
    }
  }
  async function resolveBorrow() {
    const bus = await _useAutomationBus();
    const list = tools.filter((t) => t.status === "borrow");
    if (!list.length) return;
    const payload = {
      source: "ToolChecklistPanel",
      createdAt: iso(),
      tools: list.map((t) => ({ key: t.id, name: t.name })),
    };
    try {
      bus.emit && bus.emit("tools/requestBorrow", payload);
    } catch {}
    try {
      onExport && onExport({ type: "borrow", payload });
    } catch {}
  }
  async function resolveRepair() {
    const bus = await _useAutomationBus();
    const list = tools.filter((t) => t.status === "repair");
    if (!list.length) return;
    const payload = {
      source: "ToolChecklistPanel",
      createdAt: iso(),
      items: list.map((t) => ({
        title: `Repair: ${t.name}`,
        metadata: { toolId: t.id },
      })),
    };
    try {
      bus.emit && bus.emit("tools/scheduleRepairIntake", payload);
    } catch {}
    try {
      onExport && onExport({ type: "repair", payload });
    } catch {}
  }

  return (
    <div className="bg-white border border-blue-300 rounded-lg p-5 shadow">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold text-blue-700">🧰 Tool Checklist</h2>
        <div className="flex flex-wrap gap-2 items-center">
          {isSabbath(new Date(), { saturdayAsSabbath, hebrewDayOfWeek }) ? (
            <span className="text-[11px] text-emerald-700 inline-flex items-center gap-1">
              <CalendarDays size={14} /> Sabbath-friendly: prep/borrow/repair
            </span>
          ) : null}
          <button
            onClick={() => setFilter("all")}
            className={`px-3 py-1 rounded ${
              filter === "all"
                ? "bg-blue-500 text-white"
                : "bg-blue-100 text-blue-700"
            }`}
          >
            All ({counts.all})
          </button>
          <button
            onClick={() => setFilter("manual")}
            className={`px-3 py-1 rounded flex items-center gap-1 ${
              filter === "manual"
                ? "bg-blue-500 text-white"
                : "bg-blue-100 text-blue-700"
            }`}
          >
            <Brush size={16} /> Manual ({counts.manual})
          </button>
          <button
            onClick={() => setFilter("electric")}
            className={`px-3 py-1 rounded flex items-center gap-1 ${
              filter === "electric"
                ? "bg-yellow-500 text-white"
                : "bg-yellow-100 text-yellow-700"
            }`}
          >
            <Zap size={16} /> Electric ({counts.electric})
          </button>
          <button
            onClick={() => setFilter("smart")}
            className={`px-3 py-1 rounded flex items-center gap-1 ${
              filter === "smart"
                ? "bg-indigo-500 text-white"
                : "bg-indigo-100 text-indigo-700"
            }`}
          >
            <Bot size={16} /> Smart ({counts.smart})
          </button>
        </div>
      </div>

      {/* Search + bulk */}
      <div className="flex flex-wrap gap-2 items-center mb-4">
        <label
          className="relative flex-1 min-w-[200px]"
          aria-label="Search tools"
        >
          <Search
            size={14}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"
            aria-hidden
          />
          <input
            type="text"
            placeholder="Search by name or tag…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full pl-7 pr-6 py-2 text-sm rounded border border-slate-300"
          />
          {q ? (
            <button
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
              onClick={() => setQ("")}
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          ) : null}
        </label>

        <div className="flex items-center gap-2 text-xs">
          <button
            className="px-2.5 py-1 rounded border bg-white hover:bg-slate-50"
            onClick={() => markAll("available")}
          >
            Mark all Available
          </button>
          <button
            className="px-2.5 py-1 rounded border bg-white hover:bg-slate-50"
            onClick={() => markAll("missing")}
          >
            Mark all Missing
          </button>
          <button
            className="px-2.5 py-1 rounded border bg-white hover:bg-slate-50"
            onClick={() => markAll("borrow")}
          >
            Mark all Borrow
          </button>
          <button
            className="px-2.5 py-1 rounded border bg-white hover:bg-slate-50"
            onClick={() => markAll("repair")}
          >
            Mark all Repair
          </button>
        </div>
      </div>

      {/* Checklist */}
      <ul className="space-y-3 mb-6">
        {filteredTools.map((tool) => {
          const present = invSet.has(tool.id);
          const needsBadge = !present && tool.status !== "available";
          return (
            <li
              key={tool.id}
              className={`flex items-center justify-between px-4 py-3 border rounded
                ${
                  tool.status === "available"
                    ? "border-blue-400 bg-blue-50"
                    : tool.status === "borrow"
                    ? "border-indigo-300 bg-indigo-50"
                    : tool.status === "repair"
                    ? "border-amber-300 bg-amber-50"
                    : "border-stone-300 bg-stone-50"
                }`}
            >
              <div className="min-w-0 pr-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-stone-800 truncate">
                    {tool.name}
                  </span>
                  {Array.isArray(tool.tags) && tool.tags.length ? (
                    <span className="text-[10px] px-1 py-0.5 rounded bg-slate-50 text-slate-600 border border-slate-200 truncate max-w-[140px]">
                      {tool.tags.slice(0, 2).join(" • ")}
                      {tool.tags.length > 2
                        ? " +" + (tool.tags.length - 2)
                        : ""}
                    </span>
                  ) : null}
                  {typeof tool.qty === "number" ? (
                    <span
                      className="text-[11px] px-1.5 py-0.5 rounded bg-white border border-slate-200 text-slate-600"
                      title="Quantity"
                    >
                      x{tool.qty}
                    </span>
                  ) : null}
                  {needsBadge ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-amber-700">
                      <AlertTriangle size={12} /> not in inventory
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2 mt-1 flex-wrap text-[11px] text-slate-600">
                  <StatusPill status={tool.status} />
                  {present ? (
                    <span className="inline-flex items-center gap-1">
                      <CheckCircle size={12} className="text-emerald-600" />{" "}
                      Present
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <XCircle size={12} className="text-amber-600" /> Not
                      present
                    </span>
                  )}
                  {preferences?.toolSubstitutions?.[tool.id]?.length ? (
                    <span
                      className="inline-flex items-center gap-1"
                      title="Substitutions available"
                    >
                      <Info size={12} /> Alt:{" "}
                      {preferences.toolSubstitutions[tool.id]
                        .map(pretty)
                        .slice(0, 2)
                        .join(", ")}
                      {preferences.toolSubstitutions[tool.id].length > 2
                        ? " +" +
                          (preferences.toolSubstitutions[tool.id].length - 2)
                        : ""}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => toggleStatus(tool.id)}
                  className="px-2.5 py-1 rounded border bg-white hover:bg-slate-50 text-sm"
                  aria-label={`Toggle status for ${tool.name}`}
                  title="Toggle status (Available → Missing → Borrow → Repair)"
                >
                  Toggle
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Add Custom Tool */}
      <div className="flex gap-3 items-center">
        <input
          type="text"
          placeholder="Add custom tool..."
          value={customInput}
          onChange={(e) => setCustomInput(e.target.value)}
          className="flex-1 border border-stone-300 px-3 py-2 rounded"
        />
        <input
          type="number"
          placeholder="qty"
          min={0}
          value={qtyInput}
          onChange={(e) => setQtyInput(e.target.value)}
          className="w-[90px] border border-stone-300 px-3 py-2 rounded"
        />
        <button
          onClick={handleAddCustom}
          className="bg-blue-500 hover:bg-blue-600 text-white px-3 py-2 rounded flex items-center gap-1"
        >
          <PlusCircle size={16} /> Add
        </button>
      </div>

      {/* Resolvers */}
      <div className="mt-6 grid gap-3 md:grid-cols-3">
        <ResolverCard
          title="Resolve Missing"
          subtitle="Send missing tools to Shopping (or Borrow, per preference)."
          icon={ShoppingCart}
          actionLabel={
            preferences?.toolAcquireMode === "borrow"
              ? "Request Borrow"
              : "Add to Shopping"
          }
          onAction={resolveMissing}
        />
        <ResolverCard
          title="Resolve Borrow"
          subtitle="Create/refresh borrow requests for tools marked Borrow."
          icon={Handshake}
          actionLabel="Request Borrow"
          onAction={resolveBorrow}
        />
        <ResolverCard
          title="Resolve Repair"
          subtitle="Schedule repair intake tasks for tools marked Repair."
          icon={Hammer}
          actionLabel="Schedule Repair Intake"
          onAction={resolveRepair}
        />
      </div>
    </div>
  );
}

// ---------------- UI bits ----------------
function StatusPill({ status }) {
  const map = {
    available: {
      cls: "bg-blue-600 text-white",
      icon: CheckCircle,
      label: "Available",
    },
    missing: {
      cls: "bg-stone-300 text-black",
      icon: XCircle,
      label: "Missing",
    },
    borrow: {
      cls: "bg-indigo-600 text-white",
      icon: Handshake,
      label: "Borrow",
    },
    repair: { cls: "bg-amber-600 text-white", icon: Wrench, label: "Repair" },
  };
  const m = map[status] || map.available;
  const Icon = m.icon;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] ${m.cls}`}
    >
      <Icon size={12} /> {m.label}
    </span>
  );
}

function ResolverCard({ title, subtitle, icon: Icon, actionLabel, onAction }) {
  return (
    <div className="p-3 rounded border bg-slate-50">
      <div className="font-medium mb-1 flex items-center gap-2">
        <Icon size={16} /> {title}
      </div>
      <p className="text-sm text-slate-700">{subtitle}</p>
      <button
        onClick={onAction}
        className="mt-2 inline-flex items-center gap-2 px-3 py-1.5 rounded-xl border bg-white hover:bg-slate-50"
      >
        {actionLabel}
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tiny self-tests (run once in dev-like environments) */
(function runSelfTests() {
  try {
    // Status cycle
    const cycle = (s) =>
      s === "available"
        ? "missing"
        : s === "missing"
        ? "borrow"
        : s === "borrow"
        ? "repair"
        : "available";
    console.assert(
      cycle("available") === "missing",
      "[TEST] available → missing"
    );
    console.assert(cycle("missing") === "borrow", "[TEST] missing → borrow");
    console.assert(cycle("borrow") === "repair", "[TEST] borrow → repair");
    console.assert(
      cycle("repair") === "available",
      "[TEST] repair → available"
    );

    // Filtering/search
    const list = [
      { id: "tl_mop_bucket", name: "Mop & Bucket", type: "manual" },
      {
        id: "tl_robot_vac",
        name: "Robot Vacuum (Roomba)",
        type: "smart",
        tags: ["automation"],
      },
    ];
    const q = "robot";
    const filtered = list.filter((t) =>
      [t.name, t.type, ...(t.tags || [])].join(" ").toLowerCase().includes(q)
    );
    console.assert(
      filtered.length === 1 && filtered[0].id === "tl_robot_vac",
      "[TEST] search filter by keyword"
    );

    // Sabbath logic checks
    const sat = new Date("2025-10-11T12:00:00Z");
    console.assert(
      isSabbath(sat, { saturdayAsSabbath: true }) === true,
      "[TEST] saturdayAsSabbath true on Sat"
    );
    console.assert(
      isSabbath(sat, { hebrewDayOfWeek: () => 7 }) === true,
      "[TEST] Hebrew DOW = 7 true"
    );
  } catch (e) {
    if (typeof console !== "undefined")
      console.warn(
        "ToolChecklistPanel self-tests skipped/failed:",
        e?.message || e
      );
  }
})();
