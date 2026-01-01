// C:\Users\larho\suka-smart-assistant\src\analytics\HouseholdAnalytics.jsx
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Household Analytics Dashboard
// -----------------------------------------------------------------------------
// PURPOSE
// Visualization + quick KPI surface for what the household engine is doing:
//
//  imports → intelligence → automation → (optional) hub export
//
// This dashboard listens to the event bus for:
//   - import.parsed
//   - inventory.updated
//   - inventory.shortage.detected
//   - meal.executed
//   - garden.harvest.logged
//   - preservation.completed
//
// Then it aggregates those into domain buckets:
//   meals, garden, animals, storehouse, preservation
//
// It also *estimates* savings/waste from:
//   - prevented shortages
//   - garden → storehouse pipeline
//   - preservation completed
//
// When an analytic action corresponds to a REAL household change
// (e.g. a preservation completed event with payload → actual food retained),
// we also call exportToHubIfEnabled(...) so Hub users can see real-time
// production / household health.
//
// This is forward-thinking:
//  - ready for new domains (energy, water, construction, butchery batches)
//  - ready for dashboards in Tier-2/Tier-3
//  - ready for window.__suka?.eventBus if present
// -----------------------------------------------------------------------------

import React, { useEffect, useState, useMemo } from "react";
import eventBus from "@/services/eventBus.js";
import featureFlags from "@/config/featureFlags.js";

// soft hub deps – optional
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  // eslint-disable-next-line import/no-unresolved, global-require
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter.js");
  // eslint-disable-next-line import/no-unresolved, global-require
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector.js");
} catch (_) {
  // optional
}

const isBrowser = typeof window !== "undefined";

function nowIso() {
  return new Date().toISOString();
}

async function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (_) {
    // silent
  }
}

// simple formatter
function formatCurrency(num) {
  if (typeof num !== "number") return "$0.00";
  return `$${num.toFixed(2)}`;
}

export default function HouseholdAnalytics() {
  const [metrics, setMetrics] = useState(() => ({
    imports: 0,
    importsByDomain: {
      recipe: 0,
      cleaning: 0,
      garden: 0,
      animal: 0,
      storehouse: 0,
      video: 0,
      other: 0,
    },
    mealsExecuted: 0,
    mealWaste: 0, // future: derive from inventory + expiration
    inventoryUpdates: 0,
    inventoryShortages: 0,
    gardenHarvests: 0,
    preservationSessions: 0,
    // high-level “value” estimates
    estimatedSavings: 0,
    estimatedWasteAvoided: 0,
    // keep a few recent events for drilldown
    recent: [],
  }));

  // attach event listeners
  useEffect(() => {
    // in case eventBus is not initialized, fall back to window during dev
    const bus = eventBus || (isBrowser ? window.__suka?.eventBus : null);
    if (!bus) return undefined;

    const handler = async (evt) => {
      // evt: { type, ts, source, data }
      if (!evt || !evt.type) return;

      setMetrics((prev) => {
        const next = { ...prev };
        const ts = evt.ts || nowIso();
        const rec = { type: evt.type, ts, source: evt.source, data: evt.data };

        // keep max 20 recent
        const recent = [rec, ...prev.recent].slice(0, 20);
        next.recent = recent;

        switch (evt.type) {
          case "import.parsed": {
            next.imports += 1;
            const domain = evt.data?.kind || "other";
            const key = normalizeDomain(domain);
            next.importsByDomain = {
              ...next.importsByDomain,
              [key]: (next.importsByDomain[key] || 0) + 1,
            };
            // small bump to “intelligence value”
            next.estimatedSavings += estimateImportValue(evt.data);
            break;
          }
          case "meal.executed": {
            next.mealsExecuted += 1;
            // meals executed → waste avoided (because things got used)
            const saved = estimateMealSavings(evt.data);
            next.estimatedSavings += saved;
            next.estimatedWasteAvoided += saved * 0.5;
            break;
          }
          case "inventory.updated": {
            next.inventoryUpdates += 1;
            next.estimatedSavings += estimateInventorySavings(evt.data);
            break;
          }
          case "inventory.shortage.detected": {
            next.inventoryShortages += 1;
            // shortages lower savings, but also trigger automation
            next.estimatedSavings -= 0.5;
            break;
          }
          case "garden.harvest.logged": {
            next.gardenHarvests += 1;
            const saved = estimateHarvestValue(evt.data);
            next.estimatedSavings += saved;
            // → household data changed, also tell the hub
            exportToHubIfEnabled({
              kind: "garden.harvest.logged",
              at: ts,
              payload: evt.data,
            });
            break;
          }
          case "preservation.completed": {
            next.preservationSessions += 1;
            const saved = estimatePreservationValue(evt.data);
            next.estimatedSavings += saved;
            next.estimatedWasteAvoided += saved;
            // → household data changed
            exportToHubIfEnabled({
              kind: "preservation.completed",
              at: ts,
              payload: evt.data,
            });
            break;
          }
          default:
            break;
        }

        return next;
      });
    };

    bus.on?.(handler);
    return () => {
      bus.off?.(handler);
    };
  }, []);

  // derived cards
  const cards = useMemo(() => {
    return [
      {
        title: "Imports processed",
        value: metrics.imports,
        note: "All domains",
      },
      {
        title: "Meals executed",
        value: metrics.mealsExecuted,
        note: "Cooking sessions that ran",
      },
      {
        title: "Garden harvests",
        value: metrics.gardenHarvests,
        note: "Harvest logged events",
      },
      {
        title: "Preservation sessions",
        value: metrics.preservationSessions,
        note: "Food processed/stored",
      },
      {
        title: "Inventory updates",
        value: metrics.inventoryUpdates,
        note: "Entries added/adjusted",
      },
      {
        title: "Inventory shortages",
        value: metrics.inventoryShortages,
        note: "Triggers for auto-suggest",
      },
    ];
  }, [metrics]);

  const domainBreakdown = useMemo(() => {
    const d = metrics.importsByDomain;
    return [
      { label: "Recipe", value: d.recipe || 0 },
      { label: "Cleaning", value: d.cleaning || 0 },
      { label: "Garden", value: d.garden || 0 },
      { label: "Animal", value: d.animal || 0 },
      { label: "Storehouse", value: d.storehouse || 0 },
      { label: "Video/How-to", value: d.video || 0 },
      { label: "Other", value: d.other || 0 },
    ];
  }, [metrics]);

  return (
    <div className="w-full h-full flex flex-col gap-6 p-4 md:p-6 bg-slate-50/40 dark:bg-slate-950/40">
      {/* HEADER */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-lg md:text-2xl font-semibold text-slate-900 dark:text-slate-100">
            Household Analytics
          </h1>
          <p className="text-xs md:text-sm text-slate-500 dark:text-slate-400">
            Imports → intelligence → automation → (optional) hub export
          </p>
        </div>
        <div className="text-right">
          <div className="text-xs uppercase tracking-wide text-slate-400">Est. savings</div>
          <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
            {formatCurrency(metrics.estimatedSavings)}
          </div>
          <div className="text-[10px] text-slate-400">
            Waste avoided: {formatCurrency(metrics.estimatedWasteAvoided)}
          </div>
        </div>
      </div>

      {/* KPI CARDS */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {cards.map((card) => (
          <div
            key={card.title}
            className="rounded-2xl border border-slate-200/70 dark:border-slate-800/70 bg-white/80 dark:bg-slate-900/40 p-3.5 flex flex-col gap-1 shadow-sm"
          >
            <div className="text-[10px] uppercase tracking-wide text-slate-400">{card.title}</div>
            <div className="text-2xl font-semibold text-slate-900 dark:text-slate-100">
              {card.value}
            </div>
            <div className="text-[10px] text-slate-400">{card.note}</div>
          </div>
        ))}
      </div>

      {/* DOMAIN BREAKDOWN + ACTIVITY */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        {/* domain breakdown */}
        <div className="lg:col-span-2 rounded-2xl border border-slate-200/70 dark:border-slate-800/70 bg-white/80 dark:bg-slate-900/40 p-3.5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Imports by domain
            </h2>
            <span className="text-[10px] text-slate-400">Total {metrics.imports}</span>
          </div>
          <div className="flex flex-col gap-3">
            {domainBreakdown.map((d) => {
              const pct = metrics.imports > 0 ? Math.round((d.value / metrics.imports) * 100) : 0;
              return (
                <div key={d.label}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-slate-600 dark:text-slate-200">{d.label}</span>
                    <span className="text-slate-400">{d.value} ({pct}%)</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-indigo-400/70 dark:bg-indigo-500 transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* recent activity */}
        <div className="rounded-2xl border border-slate-200/70 dark:border-slate-800/70 bg-white/80 dark:bg-slate-900/40 p-3.5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              Recent activity
            </h2>
            <span className="text-[10px] text-slate-400">Newest first</span>
          </div>
          <div className="flex flex-col gap-2 max-h-[240px] overflow-y-auto pr-1">
            {metrics.recent.length === 0 && (
              <div className="text-xs text-slate-400">No events yet.</div>
            )}
            {metrics.recent.map((ev) => (
              <div key={ev.ts + ev.type} className="flex gap-2 items-start">
                <div className="w-6 h-6 flex items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-[10px] text-slate-500 shrink-0">
                  {iconFor(ev.type)}
                </div>
                <div className="flex-1">
                  <div className="text-xs text-slate-800 dark:text-slate-200 leading-tight">
                    {ev.type}
                  </div>
                  <div className="text-[10px] text-slate-400 leading-tight">{ev.ts}</div>
                  {ev.data?.kind && (
                    <div className="text-[10px] text-slate-400 leading-tight">
                      {ev.data.kind}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* FUTURE: chart hooks, seasonal view, hub sync stats */}
      <div className="rounded-2xl border border-dashed border-slate-200/70 dark:border-slate-800/70 bg-slate-50/40 dark:bg-slate-950/10 p-4 text-xs text-slate-400">
        This panel can render time-series charts (per day/week), hub-export health,
        and anomaly detection for waste spikes. Wire to Dexie or server analytics
        store when you’re ready.
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

function normalizeDomain(kind) {
  const k = (kind || "").toLowerCase();
  if (k.includes("recipe") || k === "mealplan") return "recipe";
  if (k.includes("clean")) return "cleaning";
  if (k.includes("garden")) return "garden";
  if (k.includes("animal") || k.includes("butcher")) return "animal";
  if (k.includes("store")) return "storehouse";
  if (k.includes("video")) return "video";
  return "other";
}

// rough heuristics – these are intentionally simple; replace with real calc later
function estimateImportValue(data = {}) {
  // recipes and garden plans are more valuable
  if (data.kind?.includes("recipe")) return 1.5;
  if (data.kind?.includes("garden")) return 1.25;
  if (data.kind?.includes("storehouse")) return 1.0;
  return 0.5;
}

function estimateMealSavings(data = {}) {
  // basic assumption: every cooked meal prevented $3 of waste
  return 3.0;
}

function estimateInventorySavings(data = {}) {
  // if inventory update contains actual items → small bump
  if (Array.isArray(data.items) && data.items.length) {
    return data.items.length * 0.25;
  }
  return 0.25;
}

function estimateHarvestValue(data = {}) {
  // if harvest has weight, we can scale it, else assume $2
  if (typeof data.weight === "number") {
    return Math.max(1.0, data.weight * 1.25);
  }
  if (Array.isArray(data.harvest)) {
    return data.harvest.length * 0.75;
  }
  return 2.0;
}

function estimatePreservationValue(data = {}) {
  // preserved food is more valuable
  if (typeof data.weight === "number") {
    return Math.max(1.5, data.weight * 1.5);
  }
  return 2.5;
}

function iconFor(type) {
  if (!type) return "•";
  if (type.startsWith("import.")) return "↓";
  if (type.startsWith("inventory.")) return "📦";
  if (type.startsWith("meal.")) return "🍽";
  if (type.startsWith("garden.")) return "🌱";
  if (type.startsWith("preservation.")) return "🫙";
  return "•";
}
