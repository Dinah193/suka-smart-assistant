// src/pages/calculators/index.jsx

/**
 * Suka Smart Assistant (SSA) – Calculators Dashboard
 * ---------------------------------------------------------------------------
 * HOW THIS FITS
 * - Central landing page for all calculators (Health, StorehouseMeals, Garden, etc.).
 * - Uses the calculators registry to list tools by domain.
 * - Provides:
 *    - Search
 *    - Domain filter
 *    - "Open Calculator" navigation
 *    - "Start Session Now" CTA that asks the SessionRunner to spin up a session
 *
 * SESSIONRUNNER INTEGRATION
 * - This page does NOT render the SessionRunner modal itself.
 * - Instead, it emits a `session.request.start` event on the global eventBus:
 *      eventBus.emit({
 *        type: "session.request.start",
 *        ts: new Date().toISOString(),
 *        source: "CalculatorsDashboard",
 *        data: { ... }
 *      });
 * - The SessionRunner root component (mounted in App.jsx) listens for this
 *   event, resolves the session details, and opens its own full-screen modal
 *   that can survive route changes and run in the background.
 */

import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import calculatorsRegistry, {
  CALCULATOR_DOMAINS,
  getCalculatorsGroupedByDomain,
  listAllCalculators,
  getCalculatorDomainForNodeId
} from "../../features/calculators";

import eventBus from "../../services/eventBus";

/**
 * Simple metadata for displaying domains in a friendly way on this page.
 * This mirrors (but does not depend on) Planning Graph domain config.
 */
const DOMAIN_META = {
  [CALCULATOR_DOMAINS.HEALTH]: {
    label: "Health & Nutrition",
    description: "Body-level health, energy, and micronutrient coverage.",
    accentClass: "from-purple-500/10 to-purple-500/5 border-purple-400/40",
    pillClass:
      "bg-purple-500/10 text-purple-300 ring-1 ring-purple-500/40 border border-purple-500/40"
  },
  [CALCULATOR_DOMAINS.STOREHOUSE_MEALS]: {
    label: "Storehouse & Meals",
    description: "Pantry depth, meat breakdown, and months of cover.",
    accentClass: "from-amber-500/10 to-amber-500/5 border-amber-400/40",
    pillClass:
      "bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/40 border border-amber-500/40"
  },
  [CALCULATOR_DOMAINS.GARDEN]: {
    label: "Garden & Production",
    description: "Seed viability, harvest projections, and garden-to-storehouse flow.",
    accentClass: "from-emerald-500/10 to-emerald-500/5 border-emerald-400/40",
    pillClass:
      "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/40 border border-emerald-500/40"
  },
  [CALCULATOR_DOMAINS.ANIMALS]: {
    label: "Animals",
    description: "Feed support and livestock-planning helpers.",
    accentClass: "from-sky-500/10 to-sky-500/5 border-sky-400/40",
    pillClass:
      "bg-sky-500/10 text-sky-300 ring-1 ring-sky-500/40 border border-sky-500/40"
  },
  [CALCULATOR_DOMAINS.PRESERVATION]: {
    label: "Preservation",
    description: "Plan canning, drying, freezing, and long-term storage.",
    accentClass: "from-rose-500/10 to-rose-500/5 border-rose-400/40",
    pillClass:
      "bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/40 border border-rose-500/40"
  },
  [CALCULATOR_DOMAINS.CALENDAR]: {
    label: "Calendar & Rhythm",
    description:
      "Meal coverage, batch density, sabbath & feast alignment, cleaning and garden rhythm.",
    accentClass: "from-cyan-500/10 to-cyan-500/5 border-cyan-400/40",
    pillClass:
      "bg-cyan-500/10 text-cyan-300 ring-1 ring-cyan-500/40 border border-cyan-500/40"
  },
  [CALCULATOR_DOMAINS.STABILITY]: {
    label: "Household Stability",
    description:
      "Income stability, utility resilience, storehouse strength, and external dependency.",
    accentClass: "from-slate-500/10 to-slate-500/5 border-slate-400/40",
    pillClass:
      "bg-slate-500/10 text-slate-300 ring-1 ring-slate-500/40 border border-slate-500/40"
  },
  [CALCULATOR_DOMAINS.UTILITIES]: {
    label: "Utilities & Infrastructure",
    description: "Power, water, and other backbone systems.",
    accentClass: "from-indigo-500/10 to-indigo-500/5 border-indigo-400/40",
    pillClass:
      "bg-indigo-500/10 text-indigo-300 ring-1 ring-indigo-500/40 border border-indigo-500/40"
  },
  [CALCULATOR_DOMAINS.OTHER]: {
    label: "Other Tools",
    description: "Miscellaneous calculators that don’t fit other buckets.",
    accentClass: "from-zinc-500/10 to-zinc-500/5 border-zinc-400/40",
    pillClass:
      "bg-zinc-500/10 text-zinc-300 ring-1 ring-zinc-500/40 border border-zinc-500/40"
  }
};

/**
 * Map calculator domain → SessionRunner domain (for the "Start Session Now" CTA).
 * This is intentionally simple and can be refined later if you want more nuance.
 */
const DOMAIN_TO_SESSION_DOMAIN = {
  [CALCULATOR_DOMAINS.HEALTH]: "cooking",
  [CALCULATOR_DOMAINS.STOREHOUSE_MEALS]: "storehouse",
  [CALCULATOR_DOMAINS.GARDEN]: "garden",
  [CALCULATOR_DOMAINS.ANIMALS]: "animals",
  [CALCULATOR_DOMAINS.PRESERVATION]: "preservation",
  [CALCULATOR_DOMAINS.CALENDAR]: "cleaning",
  [CALCULATOR_DOMAINS.STABILITY]: "storehouse",
  [CALCULATOR_DOMAINS.UTILITIES]: "storehouse",
  [CALCULATOR_DOMAINS.OTHER]: "storehouse"
};

/**
 * Emit a session.request.start event so the root SessionRunner can open
 * its modal and construct a session around the calculator’s domain.
 */
function requestSessionFromCalculator(calculatorConfig) {
  if (!calculatorConfig) return;

  const ts = new Date().toISOString();
  const sessionDomain =
    DOMAIN_TO_SESSION_DOMAIN[calculatorConfig.domain] || "storehouse";

  try {
    eventBus?.emit?.({
      type: "session.request.start",
      ts,
      source: "CalculatorsDashboard",
      data: {
        requestedBy: "calculatorDashboard",
        sessionHint: {
          domain: sessionDomain,
          title: `Plan with ${calculatorConfig.label}`,
          origin: "calculator",
          calculatorId: calculatorConfig.id,
          nodeId: calculatorConfig.nodeId || null
        }
      }
    });
  } catch {
    // Soft-fail; SessionRunner is an enhancement, not required here.
  }
}

/**
 * Main calculators index / dashboard component.
 */
const CalculatorsIndexPage = () => {
  const navigate = useNavigate();

  const [search, setSearch] = useState("");
  const [activeDomainFilter, setActiveDomainFilter] = useState("all");

  const groupedByDomain = useMemo(() => getCalculatorsGroupedByDomain(), []);
  const allCalculators = useMemo(() => listAllCalculators(), []);

  const filteredByDomain = useMemo(() => {
    if (activeDomainFilter === "all") return groupedByDomain;
    const filtered = {};
    if (groupedByDomain[activeDomainFilter]) {
      filtered[activeDomainFilter] = groupedByDomain[activeDomainFilter];
    }
    return filtered;
  }, [groupedByDomain, activeDomainFilter]);

  const finalGroups = useMemo(() => {
    if (!search.trim()) return filteredByDomain;

    const q = search.trim().toLowerCase();
    const matchesById = {};
    allCalculators.forEach((calc) => {
      const haystack = `${calc.label} ${calc.id} ${calc.domain} ${
        calc.description || ""
      }`.toLowerCase();
      if (haystack.includes(q)) {
        if (!matchesById[calc.domain]) matchesById[calc.domain] = [];
        matchesById[calc.domain].push(calc);
      }
    });
    return matchesById;
  }, [filteredByDomain, search, allCalculators]);

  const hasAnyResults = useMemo(
    () =>
      Object.values(finalGroups).some(
        (arr) => Array.isArray(arr) && arr.length > 0
      ),
    [finalGroups]
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
        {/* Header */}
        <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50 md:text-3xl">
              Calculators & Planning Tools
            </h1>
            <p className="mt-1 text-sm text-slate-300">
              Jump into health, storehouse, garden, animals, and stability
              calculators. Use them alone or pair them with a running session.
            </p>
          </div>

          {/* Search */}
          <div className="mt-3 w-full md:mt-0 md:w-80">
            <label className="mb-1 block text-xs font-medium uppercase tracking-wide text-slate-400">
              Search calculators
            </label>
            <div className="relative">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, domain, or purpose..."
                className="w-full rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-50 placeholder:text-slate-500 shadow-sm outline-none ring-1 ring-transparent transition focus:border-cyan-500/60 focus:ring-cyan-500/60"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="absolute inset-y-0 right-2 flex items-center text-xs text-slate-400 hover:text-slate-200"
                >
                  ✕
                </button>
              )}
            </div>
          </div>
        </header>

        {/* Domain filters */}
        <section className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setActiveDomainFilter("all")}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              activeDomainFilter === "all"
                ? "border-cyan-400 bg-cyan-500/20 text-cyan-100 shadow-md shadow-cyan-500/30"
                : "border-slate-700 bg-slate-900/70 text-slate-300 hover:border-cyan-400/60 hover:text-cyan-100"
            }`}
          >
            All domains
          </button>

          {Object.values(CALCULATOR_DOMAINS).map((domainId) => {
            const meta = DOMAIN_META[domainId];
            if (!meta) return null;
            return (
              <button
                key={domainId}
                type="button"
                onClick={() => setActiveDomainFilter(domainId)}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                  activeDomainFilter === domainId
                    ? meta.pillClass
                    : "border-slate-700 bg-slate-900/70 text-slate-300 hover:border-slate-400/60"
                }`}
              >
                {meta.label}
              </button>
            );
          })}
        </section>

        {/* Content */}
        {!hasAnyResults ? (
          <div className="mt-8 flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 px-6 py-12 text-center">
            <div className="mb-2 text-lg font-medium text-slate-100">
              No calculators match your filters yet
            </div>
            <p className="max-w-md text-sm text-slate-400">
              Try clearing the search box or selecting a different domain.
              Calculators will appear here as you add more tools to Suka Smart
              Assistant.
            </p>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-6">
            {Object.entries(finalGroups).map(([domainId, calculators]) => {
              if (!calculators || calculators.length === 0) return null;
              const meta =
                DOMAIN_META[domainId] ||
                DOMAIN_META[CALCULATOR_DOMAINS.OTHER];

              return (
                <section
                  key={domainId}
                  className={`rounded-3xl border bg-gradient-to-br ${meta.accentClass} px-4 py-4 md:px-5 md:py-5`}
                >
                  <header className="mb-3 flex flex-col gap-1 md:flex-row md:items-center md:justify-between">
                    <div>
                      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-100">
                        {meta.label}
                      </h2>
                      <p className="text-xs text-slate-300">
                        {meta.description}
                      </p>
                    </div>
                    <div className="mt-2 md:mt-0">
                      <span className="inline-flex items-center rounded-full bg-slate-900/60 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-slate-300 ring-1 ring-slate-600/60">
                        {calculators.length} tool
                        {calculators.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                  </header>

                  <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                    {calculators.map((calc) => (
                      <article
                        key={calc.id}
                        className="flex flex-col justify-between rounded-2xl border border-slate-800/80 bg-slate-950/80 p-3 shadow-sm shadow-black/40 backdrop-blur-sm transition hover:border-cyan-500/70 hover:shadow-cyan-500/25"
                      >
                        <div className="flex-1">
                          <div className="mb-1 flex items-center justify-between gap-2">
                            <h3 className="text-sm font-semibold text-slate-50">
                              {calc.label}
                            </h3>
                            {calc.icon && (
                              <span className="text-xs text-slate-400">
                                {/* icon token; plug into your icon system as needed */}
                                {calc.icon}
                              </span>
                            )}
                          </div>
                          {calc.description && (
                            <p className="text-xs text-slate-400">
                              {calc.description}
                            </p>
                          )}
                          {calc.nodeId && (
                            <p className="mt-1 text-[10px] font-mono text-slate-500">
                              {calc.nodeId}
                            </p>
                          )}
                        </div>

                        <div className="mt-3 flex items-center justify-between gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              calc.route ? navigate(calc.route) : null
                            }
                            className="inline-flex flex-1 items-center justify-center rounded-xl bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 shadow-sm shadow-black/40 transition hover:bg-slate-700 hover:text-cyan-100"
                          >
                            Open Calculator
                          </button>

                          <button
                            type="button"
                            onClick={() => requestSessionFromCalculator(calc)}
                            className="inline-flex items-center justify-center rounded-xl bg-cyan-600/90 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-950 shadow-sm shadow-cyan-500/40 transition hover:bg-cyan-500"
                            title="Start a planning session using this calculator’s domain"
                          >
                            <span className="mr-1.5 text-[10px]">▶</span>
                            Start Session
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default CalculatorsIndexPage;
