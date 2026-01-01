/* eslint-disable no-console */
// src/pages/animals/FeedWaterPanel.jsx
//
// FeedWaterPanel — Daily rations, water checks, shortages bridge
// --------------------------------------------------------------------------------------
// Purpose-built control room for feed + water routines.
// • Batch-feed by group/pen/species; inline ration calc (BW × %DM or per-head)
// • Water checks by pen; alerts for freeze/heat and low-consumption patterns
// • Shortage glance (feed + minerals + electrolytes) → “Add to Grocery” / “Jump to Grocery”
// • Quick task creation to the unified Task Board
// • Sabbath Guard aware with “welfare override” (feeding/watering always permitted)
//
// Inspirations: Linear (clean actions), Notion (simple sections), FarmOS (domain cues)

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { format, parseISO } from "date-fns";

// ---------------- Defensive service/context imports ----------------
let eventBus;
try {
  eventBus = require("../../services/eventBus").default;
} catch {
  eventBus = {
    emit: (...args) => console.debug("[FeedWaterPanel:eventBus.emit]", ...args),
    on: () => () => {},
  };
}

let SettingsContext;
try {
  SettingsContext = require("../../components/context/SettingsContext").SettingsContext;
} catch {
  SettingsContext = React.createContext({
    sabbathGuard: false,
    sabbathWindow: { startDow: 5, startHour: 18, endDow: 6, endHour: 19 },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    allowWelfareDuringSabbath: true,
    climate: { freezeF: 32, heatF: 90 }, // simple reminders
  });
}

let useMilestoneState;
try {
  useMilestoneState = require("../../app/hooks/useMilestoneState").default;
} catch {
  useMilestoneState = () => ({ recordMilestone: () => {} });
}

let estimateEngine;
try {
  estimateEngine = require("../../engines/estimates/estimateEngine.js");
} catch {
  estimateEngine = { estimate: () => ({ timeMinutes: 10, cost: null }) };
}

let scheduleHelpers = {};
try {
  scheduleHelpers = require("../../engines/scheduling/scheduleHelpers.js");
} catch {
  scheduleHelpers = {
    // Optional hooks your app may provide
    getWeatherNow: () => ({ tempF: 70 }),
  };
}

// ---------------- Utilities ----------------
const withinSabbath = (now = new Date(), window = { startDow: 5, startHour: 18, endDow: 6, endHour: 19 }) => {
  const dow = now.getDay();
  const hr = now.getHours();
  if (dow === window.startDow && hr >= window.startHour) return true;
  if (dow === window.endDow && hr < window.endHour) return true;
  return false;
};

const speciesDefaults = {
  sheep:   { rationType: "perHead", perHead: 2.5, unit: "lb", dmPct: 90, waterGalPerHead: 1.5 }, // maintenance hay (lb)
  goat:    { rationType: "perHead", perHead: 2.5, unit: "lb", dmPct: 90, waterGalPerHead: 2.0 },
  cattle:  { rationType: "dmPctBW", dmPctBW: 2.2, unit: "%BW", dmPct: 90, waterGalPerHead: 10 },
  horse:   { rationType: "dmPctBW", dmPctBW: 2.0, unit: "%BW", dmPct: 90, waterGalPerHead: 8 },
  pig:     { rationType: "perHead", perHead: 5.0, unit: "lb", dmPct: 90, waterGalPerHead: 3.5 },
  chicken: { rationType: "perHead", perHead: 0.25, unit: "lb", dmPct: 90, waterGalPerHead: 0.1 },
  duck:    { rationType: "perHead", perHead: 0.3, unit: "lb", dmPct: 90, waterGalPerHead: 0.2 },
};

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function calcRation({ species, headcount, avgBWlb, custom }) {
  const d = speciesDefaults[species?.toLowerCase?.()] || speciesDefaults.sheep;
  const use = { ...d, ...(custom || {}) };
  if (use.rationType === "dmPctBW") {
    const dm = (use.dmPctBW / 100) * avgBWlb; // lb DM per head
    const asFed = dm / (use.dmPct / 100);     // lb as-fed per head
    return { perHeadLb: round2(asFed), totalLb: round2(asFed * headcount), unit: "lb" };
  }
  // perHead
  return { perHeadLb: round2(use.perHead), totalLb: round2(use.perHead * headcount), unit: "lb" };
}

function calcWater({ species, headcount, weatherF }) {
  const base = (speciesDefaults[species?.toLowerCase?.()] || speciesDefaults.sheep).waterGalPerHead;
  // very simple adjustment: +50% if > 90F, +25% if 80-90F
  let mult = 1;
  if (weatherF >= 90) mult = 1.5;
  else if (weatherF >= 80) mult = 1.25;
  return { perHeadGal: round2(base * mult), totalGal: round2(base * mult * headcount) };
}

const SUBDOMAIN = {
  FEED: "feed",
  WATER: "water",
};

// ---------------- Component ----------------
export default function FeedWaterPanel({
  herds = [],   // [{id, group:"ewes", species:"sheep", pen:"A", headcount:34, avgBWlb:150}]
  waterers = [],// [{id, pen:"A", type:"trough|nipple|bucket", capacityGal:100}]
  shortages = [], // optional preload shortages -> [{name, domain:"animal", qty, unit}]
}) {
  const { sabbathGuard, sabbathWindow, allowWelfareDuringSabbath, climate } = React.useContext(SettingsContext);
  const { recordMilestone } = useMilestoneState();

  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState(() => new Set());       // herd IDs and waterer IDs
  const [shorts, setShorts] = useState(shortages);
  const [store, setStore] = useState("Local Co-op");

  // subscribe to external shortage updates
  useEffect(() => {
    const off = eventBus.on?.("supplies.shortages.update", (payload) => {
      const list = Array.isArray(payload?.items) ? payload.items : [];
      const animalNeeds = list.filter((r) => r.domain === "animal");
      setShorts(animalNeeds);
    });
    return () => off?.();
  }, []);

  const weatherNow = scheduleHelpers.getWeatherNow?.() ?? { tempF: 70 };

  const filteredHerds = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (herds || []).filter((h) => {
      if (!q) return true;
      const hay = [h.group, h.species, h.pen, String(h.headcount)].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [herds, query]);

  const filteredWaterers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (waterers || []).filter((w) => {
      if (!q) return true;
      const hay = [w.pen, w.type, String(w.capacityGal)].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [waterers, query]);

  const shortagesCount = shorts.length;
  const feedShortage = shorts.filter((s) => /hay|feed|grain|pellet|corn|alfalfa/i.test(s.name || "")).length;
  const mineralShortage = shorts.filter((s) => /mineral|salt/i.test(s.name || "")).length;
  const medShortage = shorts.filter((s) => /electrolyte|deworm|antibiotic|vaccine/i.test(s.name || "")).length;

  const disabledBySabbath = sabbathGuard && withinSabbath(new Date(), sabbathWindow) && !allowWelfareDuringSabbath;

  // --------------- Actions ---------------
  const toggleSelect = (kind, id) =>
    setSelection((prev) => {
      const key = `${kind}:${id}`;
      const n = new Set(prev);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const addFeedTasks = () => {
    const now = new Date();
    const tasks = [];
    for (const h of filteredHerds) {
      const key = `herd:${h.id}`;
      if (!selection.has(key)) continue;
      const r = calcRation({ species: h.species, headcount: h.headcount, avgBWlb: h.avgBWlb });
      const title = `Feed ${h.group} • ${r.totalLb} lb`;
      tasks.push(buildTask({ title, subdomain: SUBDOMAIN.FEED, pen: h.pen, group: h.group, estMinutes: 10 }));
    }
    if (!tasks.length) return;
    eventBus.emit("tasks.addMany", { tasks });
    eventBus.emit("ui.toast", { variant: "success", message: `Added ${tasks.length} feed task(s)` });
    recordMilestone?.({ key: "animal_feed_tasks_add", meta: { count: tasks.length } });
  };

  const addWaterTasks = () => {
    const tasks = [];
    for (const w of filteredWaterers) {
      const key = `waterer:${w.id}`;
      if (!selection.has(key)) continue;
      const title = `Check water • Pen ${w.pen}`;
      tasks.push(buildTask({ title, subdomain: SUBDOMAIN.WATER, pen: w.pen, estMinutes: 5 }));
    }
    if (!tasks.length) return;
    eventBus.emit("tasks.addMany", { tasks });
    eventBus.emit("ui.toast", { variant: "success", message: `Added ${tasks.length} water task(s)` });
    recordMilestone?.({ key: "animal_water_tasks_add", meta: { count: tasks.length } });
  };

  const quickAddShortagesToGrocery = () => {
    if (!shorts.length) return;
    const items = shorts.slice(0, 30).map((s, i) => ({
      id: `short:${i}:${s.name}`,
      name: s.name,
      qty: Number(s.qty || 1),
      unit: s.unit || "ea",
      domain: "animal",
      tags: ["feed-water"],
      aisle: "Animal Feed",
      store,
    }));
    eventBus.emit("grocery.addItems", { items, store, at: new Date().toISOString() });
    eventBus.emit("ui.toast", { variant: "success", message: `Added ${items.length} item(s) to Grocery` });
    recordMilestone?.({ key: "animal_shortages_to_grocery", meta: { count: items.length } });
  };

  const jumpToGrocery = () => {
    eventBus.emit("ui.navigate", { panel: "GroceryListPanel" });
    eventBus.emit("ui.panel.open", { id: "GROCERY_LIST" });
  };

  const openSupplies = () => {
    eventBus.emit("ui.navigate", { panel: "SuppliesPanel" });
    eventBus.emit("ui.panel.open", { id: "SUPPLIES" });
  };

  // --------------- Render ---------------
  return (
    <div className="w-full max-w-7xl mx-auto p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Feed & Water</h1>
          <p className="text-gray-600">
            Batch-create chores, check waterers, and bridge shortages. Weather {weatherNow?.tempF ?? "—"}°F.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <select
            value={store}
            onChange={(e) => setStore(e.target.value)}
            className="rounded-xl border px-3 py-2 text-sm bg-white"
            title="Preferred store for shortages"
          >
            <option>Local Co-op</option>
            <option>Tractor Supply</option>
            <option>Rural King</option>
            <option>Agway</option>
          </select>

          <button
            type="button"
            onClick={openSupplies}
            className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
          >
            Supplies {shortagesCount ? `(${shortagesCount})` : ""}
          </button>
          <button
            type="button"
            onClick={jumpToGrocery}
            className="rounded-xl border border-black bg-gray-900 text-white px-3 py-2 text-sm hover:opacity-90"
          >
            Jump to Grocery
          </button>
        </div>
      </div>

      {/* Shortages glance */}
      <section className="mt-4 grid grid-cols-1 md:grid-cols-4 gap-4">
        <InfoCard label="Animal shortages" value={shortagesCount} tone={shortagesCount ? "amber" : "slate"} />
        <InfoCard label="Feed/grain" value={feedShortage} />
        <InfoCard label="Minerals/salt" value={mineralShortage} />
        <InfoCard label="Meds/electrolytes" value={medShortage} />
      </section>

      {/* Search + actions */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search group, species, pen…"
          className="w-72 rounded-xl border px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={() => setSelection(new Set())}
          className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
        >
          Clear selection
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={quickAddShortagesToGrocery}
            className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
            disabled={!shortagesCount}
          >
            Add shortages to Grocery
          </button>
          <WelfareBadge enabled={allowWelfareDuringSabbath} sabbathGuard={sabbathGuard} />
        </div>
      </div>

      {/* Main grid */}
      <section className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Herds / Feed */}
        <div className="lg:col-span-2 rounded-2xl border p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500">Feed — Herds</h2>
            <button
              type="button"
              onClick={addFeedTasks}
              className={[
                "rounded-xl border px-3 py-2 text-sm",
                disabledBySabbath
                  ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
                  : "bg-gray-900 text-white border-black hover:opacity-90",
              ].join(" ")}
              title={disabledBySabbath ? "Sabbath guard active (welfare override disabled)" : "Create feed tasks"}
              disabled={disabledBySabbath}
            >
              Create feed tasks
            </button>
          </div>

          <ul className="mt-3 grid gap-3">
            {filteredHerds.length ? (
              filteredHerds.map((h) => {
                const sel = selection.has(`herd:${h.id}`);
                const ration = calcRation({ species: h.species, headcount: h.headcount, avgBWlb: h.avgBWlb });
                return (
                  <li key={h.id} className="rounded-xl border p-3 bg-white">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-gray-900 truncate">{h.group}</h3>
                          <Badge>{(h.species || "").toLowerCase()}</Badge>
                          <Badge>Pen {h.pen}</Badge>
                          <Badge>{h.headcount} head</Badge>
                        </div>
                        <div className="mt-1 text-sm text-gray-600 flex flex-wrap gap-3">
                          <span>Ration: <strong>{ration.totalLb} lb</strong> ({ration.perHeadLb} lb/head)</span>
                          {Number(h.avgBWlb) ? <span>• BW ~ {h.avgBWlb} lb</span> : null}
                        </div>
                      </div>

                      <label className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          checked={sel}
                          onChange={() => toggleSelect("herd", h.id)}
                        />
                        Select
                      </label>
                    </div>

                    {/* Inline adjuster */}
                    <RationAdjuster
                      species={h.species}
                      headcount={h.headcount}
                      avgBWlb={h.avgBWlb}
                      onPreview={(custom) => {
                        const r = calcRation({ species: h.species, headcount: h.headcount, avgBWlb: h.avgBWlb, custom });
                        eventBus.emit("ui.toast", { variant: "info", message: `${h.group}: ${r.totalLb} lb (${r.perHeadLb}/hd)` });
                      }}
                    />
                  </li>
                );
              })
            ) : (
              <li className="rounded-xl border border-dashed p-8 text-center text-gray-600">
                No herds configured. Add groups in Animals → Herd Manager.
              </li>
            )}
          </ul>
        </div>

        {/* Waterers */}
        <div className="rounded-2xl border p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium uppercase tracking-wider text-gray-500">Water — Pens</h2>
            <button
              type="button"
              onClick={addWaterTasks}
              className={[
                "rounded-xl border px-3 py-2 text-sm",
                disabledBySabbath
                  ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
                  : "bg-gray-900 text-white border-black hover:opacity-90",
              ].join(" ")}
              title={disabledBySabbath ? "Sabbath guard active (welfare override disabled)" : "Create water tasks"}
              disabled={disabledBySabbath}
            >
              Create water tasks
            </button>
          </div>

          <ul className="mt-3 grid gap-3">
            {filteredWaterers.length ? (
              filteredWaterers.map((w) => {
                const sel = selection.has(`waterer:${w.id}`);
                return (
                  <li key={w.id} className="rounded-xl border p-3 bg-white">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-gray-900 truncate">Pen {w.pen}</h3>
                          <Badge>{w.type}</Badge>
                          <Badge>{w.capacityGal} gal</Badge>
                        </div>
                        <div className="mt-1 text-sm text-gray-600">
                          {adviceForWater(weatherNow?.tempF, climate)}
                        </div>
                      </div>

                      <label className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          checked={sel}
                          onChange={() => toggleSelect("waterer", w.id)}
                        />
                        Select
                      </label>
                    </div>

                    {/* Consumption guide (rough) */}
                    <WaterNeedHint herds={herds.filter((h) => h.pen === w.pen)} tempF={weatherNow?.tempF ?? 70} />
                  </li>
                );
              })
            ) : (
              <li className="rounded-xl border border-dashed p-8 text-center text-gray-600">
                No waterers configured. Add pens in Animals → Pens & Waterers.
              </li>
            )}
          </ul>
        </div>
      </section>

      {/* Footer actions */}
      <footer className="mt-6 flex items-center justify-between flex-wrap gap-2">
        <div className="text-xs text-gray-500">
          Updated {format(new Date(), "PPpp")}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={openSupplies}
            className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
          >
            Review Supplies
          </button>
          <button
            type="button"
            onClick={quickAddShortagesToGrocery}
            className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
            disabled={!shortagesCount}
          >
            Add shortages to Grocery
          </button>
          <button
            type="button"
            onClick={jumpToGrocery}
            className="rounded-xl border border-black bg-gray-900 text-white px-3 py-2 text-sm hover:opacity-90"
          >
            Jump to Grocery
          </button>
        </div>
      </footer>
    </div>
  );

  // ---- helpers ----
  function buildTask({ title, subdomain, pen, group, estMinutes = 10 }) {
    const start = new Date();
    return {
      id: `${subdomain}:${pen || group || "task"}:${start.getTime()}`,
      title,
      domain: "animal",
      subdomain,
      date: format(start, "yyyy-MM-dd"),
      start: format(start, "yyyy-MM-dd'T'HH:mm:ss"),
      estMinutes,
      pen,
      group,
      tags: ["feed-water"],
      priority: "high", // feeding/water is welfare
    };
  }
}

// ---------------- Subcomponents ----------------
function InfoCard({ label, value, tone = "slate", onClick }) {
  const toneMap = {
    slate: "bg-slate-50 text-slate-900 border-slate-200",
    amber: "bg-amber-50 text-amber-900 border-amber-200",
    rose: "bg-rose-50 text-rose-900 border-rose-200",
    sky: "bg-sky-50 text-sky-900 border-sky-200",
    emerald: "bg-emerald-50 text-emerald-900 border-emerald-200",
  };
  return (
    <button type="button" onClick={onClick} className={`rounded-2xl border p-4 text-left ${toneMap[tone] || toneMap.slate}`}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </button>
  );
}

function Badge({ children }) {
  return (
    <span className="inline-flex items-center rounded-full bg-gray-100 text-gray-700 border border-gray-200 px-2 py-0.5 text-xs">
      {children}
    </span>
  );
}

function WelfareBadge({ enabled, sabbathGuard }) {
  if (!sabbathGuard) return null;
  return (
    <span className="inline-flex items-center rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 text-xs" title="Sabbath guard is ON">
      Sabbath Guard
      {enabled ? " • welfare override enabled" : " • essential actions paused"}
    </span>
  );
}

function RationAdjuster({ species, headcount, avgBWlb, onPreview }) {
  const defaults = speciesDefaults[species?.toLowerCase?.()] || speciesDefaults.sheep;
  const [mode, setMode] = useState(defaults.rationType);
  const [perHead, setPerHead] = useState(defaults.perHead ?? 2.5);
  const [dmPctBW, setDmPctBW] = useState(defaults.dmPctBW ?? 2.2);
  const [dmPct, setDmPct] = useState(defaults.dmPct ?? 90);

  return (
    <div className="mt-3 rounded-xl border p-3 bg-gray-50">
      <div className="text-xs font-medium text-gray-600">Adjust ration</div>
      <div className="mt-2 grid grid-cols-1 sm:grid-cols-4 gap-2">
        <div className="sm:col-span-1">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="w-full rounded-xl border px-3 py-2 text-sm bg-white"
          >
            <option value="perHead">Per head (lb)</option>
            <option value="dmPctBW">% BW (DM)</option>
          </select>
        </div>

        {mode === "perHead" ? (
          <>
            <div>
              <input
                type="number"
                step="0.1"
                value={perHead}
                onChange={(e) => setPerHead(Number(e.target.value))}
                className="w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="lb/head"
              />
            </div>
            <div className="sm:col-span-2 flex items-center justify-end">
              <button
                type="button"
                onClick={() => onPreview?.({ rationType: "perHead", perHead, dmPct })}
                className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
              >
                Preview total
              </button>
            </div>
          </>
        ) : (
          <>
            <div>
              <input
                type="number"
                step="0.1"
                value={dmPctBW}
                onChange={(e) => setDmPctBW(Number(e.target.value))}
                className="w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="% BW (DM)"
              />
            </div>
            <div>
              <input
                type="number"
                step="1"
                value={dmPct}
                onChange={(e) => setDmPct(Number(e.target.value))}
                className="w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="DM %"
              />
            </div>
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={() => onPreview?.({ rationType: "dmPctBW", dmPctBW, dmPct })}
                className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
              >
                Preview total
              </button>
            </div>
          </>
        )}
      </div>

      <div className="mt-2 text-xs text-gray-500">
        Headcount {headcount}{Number(avgBWlb) ? ` • Avg BW ${avgBWlb} lb` : ""} • Switch mode for quick adjustments.
      </div>
    </div>
  );
}

function WaterNeedHint({ herds = [], tempF = 70 }) {
  if (!herds.length) return null;
  const rows = herds.map((h) => {
    const per = calcWater({ species: h.species, headcount: h.headcount, weatherF: tempF });
    return { group: h.group, totalGal: per.totalGal, perHead: per.perHeadGal };
  });

  const total = round2(rows.reduce((acc, r) => acc + r.totalGal, 0));
  return (
    <div className="mt-2 text-xs text-gray-700">
      Expected need: <strong>{total} gal</strong>{" "}
      <span className="text-gray-500">(at {tempF}°F)</span>
      <ul className="mt-1 space-y-0.5">
        {rows.map((r) => (
          <li key={r.group} className="text-gray-600">
            {r.group}: {r.totalGal} gal ({r.perHead}/hd)
          </li>
        ))}
      </ul>
    </div>
  );
}

function adviceForWater(tempF, climate = { freezeF: 32, heatF: 90 }) {
  if (typeof tempF !== "number") return "—";
  if (tempF <= climate.freezeF) return "Freeze risk — check heaters & ice.";
  if (tempF >= climate.heatF) return "Heat risk — top off; consider electrolytes.";
  if (tempF >= 80) return "Warm — increase checks.";
  return "Normal conditions.";
}

/**
 * Integration Notes:
 * • Selection keys: "herd:<id>" and "waterer:<id>" for batch actions.
 * • Task creation:
 *     eventBus.emit("tasks.addMany", { tasks: [...] })
 *   Each task shape is compatible with TaskPlanView (domain:"animal", subdomain:"feed|water").
 *
 * • Shortages:
 *     Listens on `supplies.shortages.update` with {items:[...]} where item.domain === "animal".
 *     Sends to Grocery:
 *       eventBus.emit("grocery.addItems", { items, store, at: ISO })
 *
 * • Navigation:
 *     Supplies: eventBus.emit("ui.navigate", { panel: "SuppliesPanel" }); eventBus.emit("ui.panel.open", { id:"SUPPLIES" })
 *     Grocery : eventBus.emit("ui.navigate", { panel: "GroceryListPanel" }); eventBus.emit("ui.panel.open", { id:"GROCERY_LIST" })
 *
 * • Weather:
 *     Optionally provide engines/scheduling/scheduleHelpers.getWeatherNow() → {tempF}
 *
 * • Extend:
 *     - Persist ration adjustments per group; integrate with inventory decrement on completion
 *     - Show last fed/last watered timestamps and responsible user
 *     - Add “mix sheet” print view for grains/minerals
 */
