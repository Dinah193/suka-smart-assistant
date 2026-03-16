// C:\Users\larho\suka-smart-assistant\src\pages\knowledge.jsx
/* eslint-disable no-console */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

/**
 * Household Knowledge Base
 * -----------------------------------------------------------------------------
 * ROLE IN PIPELINE
 * - Imports → Intelligence → Automation → (optional) Hub export
 * - Central hub for: articles, reference catalogs, tools, and "How Suka works".
 * - Provides orchestration controls (open panels, simulate events) and
 *   reverse-generation triggers across ALL domains (meals, cleaning, garden,
 *   animals, preservation, storehouse, couponing/scan-compare-trust).
 *
 * WHAT THIS PAGE DOES
 * - Renders locally (no server fetch required).
 * - Emits consistent envelopes { type, ts, source, data } via shared eventBus.
 * - Navigates to the actual pages for panels/tools/links while emitting events.
 *
 * If a quick action is likely to change household data, we also call
 * exportToHubIfEnabled(payload). Hub export is best-effort and fails silently.
 */

// ---------------------------- Route wiring (single source of truth) -------------
/** Adjust these to match your router.jsx if needed. */
const ROUTES = {
  // Tools
  macroCalc: "/tools/macro-calculator",
  bmiCalc: "/tools/bmi-calculator",
  timerPanel: "/tools/multi-timer",
  scanExtreme: "/scan/extreme",

  // Domains
  meals: "/cooking",
  cleaning: "/cleaning",
  garden: "/garden",
  animals: "/animals",
  preservation: "/storehouse/preserve-queue",
  storehouse: "/storehouse/auto-fill",
  couponing: "/scan/extreme",

  // Knowledge sections
  knowledgeDocs: "/knowledge/docs",
};

const PANEL_ROUTES = {
  eventCatalog: "/knowledge/events",
  yieldCurves: "/knowledge/yield-curves",
  inventoryRules: "/knowledge/rules",
  importSettings: "/import/settings",
  docs: ROUTES.knowledgeDocs,
};

// ---------------------------- Defensive soft imports ----------------------------
let featureFlags = {};
try {
  featureFlags =
    require("@/config").default ??
    require("@/config/index.js").default ??
    require("@/config/featureFlags.json");
} catch {
  // optional
}

let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  // new paths
  HubPacketFormatter =
    require("@/services/hub/HubPacketFormatter.js").default ??
    require("@/services/hub/HubPacketFormatter").default;
  FamilyFundConnector =
    require("@/services/hub/FamilyFundConnector.js").default ??
    require("@/services/hub/FamilyFundConnector").default;
} catch {
  try {
    // legacy hub/* paths
    HubPacketFormatter = require("@/services/hub/HubPacketFormatter").default;
    FamilyFundConnector = require("@/services/hub/FamilyFundConnector").default;
  } catch {
    /* optional */
  }
}

let bus = null;
try {
  bus = require("@/services/events/eventBus").default;
} catch {
  // optional
}

// --------------------------------- Emit helper ---------------------------------
function emit(type, data = {}, source = "pages/knowledge") {
  const payload = { type, ts: new Date().toISOString(), source, data };
  try {
    if (bus?.emit) bus.emit(type, payload);
    window.dispatchEvent(new CustomEvent(type, { detail: payload }));
    // also forward to shared bus if present
    window.__suka?.eventBus?.emit?.(type, payload);
  } catch {
    // silent by design
  }
  return payload;
}

// ------------------------------ Hub export helper -------------------------------
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const pkt = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(pkt);
  } catch {
    // best-effort; fail silent
  }
}

// -------------------------------- Local favorites --------------------------------
const FAV_KEY = "knowledge.articles.favs.v1";
function getFavs() {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) || "[]");
  } catch {
    return [];
  }
}
function setFavsLocal(next) {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(next));
  } catch {
    // quota?
  }
}

// ----------------------------- Reference panels catalog --------------------------
const PANELS = [
  {
    id: "eventCatalog",
    title: "Event Catalog",
    blurb: "Envelope schema + domain events for automation and analytics.",
  },
  {
    id: "yieldCurves",
    title: "Yield Curves",
    blurb: "Meat/preservation yield curves for butchery and planning.",
  },
  {
    id: "inventoryRules",
    title: "Substitutions & Inventory Rules",
    blurb: "Torah-clean substitutions, units, and mapping rules.",
  },
  {
    id: "importSettings",
    title: "Import Settings",
    blurb: "Web Share/iOS/Bookmarklet/Scanner and post-import behavior.",
  },
  {
    id: "docs",
    title: "How-to & Docs",
    blurb:
      "Guides: batch cooking, garden care, preservation, animal workflows.",
  },
];

// ----------------------------------- Tools catalog --------------------------------
const TOOLS_CATALOG = [
  {
    id: "macroCalc",
    title: "Macro Calculator",
    description: "Plan protein/carb/fat targets for meal sessions.",
    routeKey: "macroCalc",
  },
  {
    id: "bmiCalc",
    title: "BMI Calculator",
    description: "Quick BMI with US/metric toggles.",
    routeKey: "bmiCalc",
  },
  {
    id: "timerPanel",
    title: "Multi-Timer Panel",
    description: "Session timers for batch cooking/cleaning.",
    routeKey: "timerPanel",
  },
  {
    id: "scanCompareTrust",
    title: "Scan • Compare • Trust",
    description: "Extreme couponing aides, PPU, cycle insights.",
    routeKey: "scanExtreme",
  },
];

// ------------------------------------ Articles ------------------------------------
const ARTICLES = [
  {
    id: "how-suka-works",
    title:
      "How Suka Works: Imports → Intelligence → Automation → Hub (optional)",
    tags: ["overview", "architecture", "automation"],
    panel: "docs",
  },
  {
    id: "import-stack",
    title: "Import Stack: Normalizer, Service, Queue, and Preview",
    tags: ["imports", "data"],
    panel: "importSettings",
  },
  {
    id: "events-and-guards",
    title: "Events and Guards: Sabbath, Quiet Hours, Weather",
    tags: ["automation", "events", "guards"],
    panel: "eventCatalog",
  },
  {
    id: "yield-curves-intro",
    title: "Yield Curves for Butchery & Preservation",
    tags: ["animals", "preservation", "storehouse"],
    panel: "yieldCurves",
  },
  {
    id: "substitutions-torah",
    title: "Torah-Clean Substitutions & Unit Mapping",
    tags: ["inventory", "rules", "dietary"],
    panel: "inventoryRules",
  },
  {
    id: "reverse-generation",
    title: "Reverse Generation: From Goals Back to Actions",
    tags: ["reverse", "planning", "nba"],
    panel: "docs",
  },
];

// ------------------------------ Reverse intent builder ---------------------------
function buildReverseIntent(domain) {
  const ts = new Date().toISOString();
  switch (domain) {
    case "meals":
      return {
        domain,
        intent: "reverse.from.recipes_or_macros",
        ts,
        params: { targetServings: "week", considerInventory: true },
      };
    case "cleaning":
      return {
        domain,
        intent: "reverse.from.declutter_goals",
        ts,
        params: { scope: "whole_home", respectGuards: true },
      };
    case "garden":
      return {
        domain,
        intent: "reverse.from.harvest_targets",
        ts,
        params: { season: "current", planPreservation: true },
      };
    case "animals":
      return {
        domain,
        intent: "reverse.from.cut_targets",
        ts,
        params: { proteinGoalLbs: 40, includeBreeding: true },
      };
    case "preservation":
      return {
        domain,
        intent: "reverse.from.store_or_harvest_inflow",
        ts,
        params: { queueFrom: ["harvests", "bulkBuys"] },
      };
    case "storehouse":
      return {
        domain,
        intent: "reverse.from.pantry_targets",
        ts,
        params: { reconcileWithInventory: true },
      };
    case "couponing":
      return {
        domain,
        intent: "reverse.from.shopping_targets",
        ts,
        params: { stackCoupons: true, storeMatchups: true },
      };
    default:
      return { domain: "unknown", intent: "noop", ts, params: {} };
  }
}

// ----------------------------------- UI atoms ------------------------------------
function Pill({ children }) {
  return (
    <span className="px-2 py-0.5 rounded-full border text-xs">{children}</span>
  );
}

function Section({ title, children, subtitle }) {
  return (
    <section className="card bg-base-100 border border-base-200 rounded-2xl shadow-sm">
      <div className="card-body">
        <h2 className="card-title">{title}</h2>
        {subtitle && <p className="text-sm opacity-80">{subtitle}</p>}
        {children}
      </div>
    </section>
  );
}

// ----------------------------------- Component -----------------------------------
export default function KnowledgeBasePage() {
  const nav = useNavigate();
  const [query, setQuery] = useState("");
  const [favs, setFavs] = useState(getFavs);

  useEffect(() => {
    emit("page.view", { page: "knowledge" });
  }, []);

  // Articles: search + favorites
  const filteredArticles = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? ARTICLES.filter(
          (a) =>
            a.title.toLowerCase().includes(q) ||
            (a.tags || []).some((t) => t.toLowerCase().includes(q))
        )
      : ARTICLES;
    // Sort: favorites first, then title
    return base.slice().sort((a, b) => {
      const af = favs.includes(a.id) ? -1 : 1;
      const bf = favs.includes(b.id) ? -1 : 1;
      return af - bf || a.title.localeCompare(b.title);
    });
  }, [query, favs]);

  const toggleFav = useCallback((id) => {
    setFavs((curr) => {
      const next = curr.includes(id)
        ? curr.filter((x) => x !== id)
        : [...curr, id];
      setFavsLocal(next);
      emit("knowledge.article.favorite.toggle", {
        id,
        active: !curr.includes(id),
      });
      return next;
    });
  }, []);

  // Small nav helpers that also emit orchestration events
  const go = useCallback(
    (path, eventType, data = {}) => {
      const payload = emit(eventType, data);
      // For navigation-only actions, Hub export not needed.
      nav(path);
      return payload;
    },
    [nav]
  );

  const openPanel = useCallback(
    (panelId) => {
      const path = PANEL_ROUTES[panelId] || ROUTES.knowledgeDocs;
      return go(path, "knowledge.panel.request", { panel: panelId, path });
    },
    [go]
  );

  const openTool = useCallback(
    (routeKey, toolId) => {
      const path = ROUTES[routeKey];
      if (!path) return;
      return go(path, "knowledge.tool.open", { toolId, path });
    },
    [go]
  );

  const openQuickLink = useCallback(
    (path, target) => go(path, "knowledge.quicklink.open", { target, path }),
    [go]
  );

  const simulateImportEvent = useCallback(() => {
    const payload = emit("import.parsed", {
      kind: "article.demo",
      meta: { note: "Triggered from Knowledge page demo" },
    });
    exportToHubIfEnabled(payload);
  }, []);

  const requestReverse = useCallback(
    async (domain) => {
      const intent = buildReverseIntent(domain);
      const payload = emit("reverse.generate.request", { domain, intent });
      await exportToHubIfEnabled(payload);
      // Navigate to a sensible default screen for the domain
      const path =
        ROUTES[domain] ??
        (domain === "couponing" ? ROUTES.scanExtreme : ROUTES.knowledgeDocs);
      if (path) nav(path);
    },
    [nav]
  );

  return (
    <div className="p-4 md:p-6">
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">Household Knowledge Base</h1>
        <p className="text-sm text-base-content/70">
          Reference data, tools, and guides that power imports, intelligence,
          automation, and (optionally) Hub export. Everything here is safe to
          open offline.
        </p>
      </div>

      {/* How it works */}
      <Section
        title="How Suka Works"
        subtitle="Imports → Intelligence → Automation → (optional) Hub export"
      >
        <div className="prose max-w-none text-sm">
          <ul className="list-disc pl-5">
            <li>
              <strong>Imports:</strong> Recipes, cleaning routines,
              seeds/packets, animal cut sheets, videos/how-to, pricebooks &
              coupons. Routed by ImportRouter → normalized into structured
              records.
            </li>
            <li>
              <strong>Intelligence:</strong> Substitutions, unit mapping, yield
              curves, equipment, seasonality, and ingredient patterns are
              applied.
            </li>
            <li>
              <strong>Automation:</strong> Engines schedule sessions and emit
              events like <code>inventory.updated</code>,{" "}
              <code>meal.executed</code>, <code>garden.harvest.logged</code>,
              and <code>preservation.completed</code>. Guards (Sabbath, Quiet
              Hours, Weather) are respected.
            </li>
            <li>
              <strong>Hub export (optional):</strong> If{" "}
              <code>featureFlags.familyFundMode</code> is true, envelopes are
              formatted and sent best-effort to the Suka Village Family Fund
              Hub.
            </li>
          </ul>
        </div>
        <div className="flex flex-wrap gap-2 mt-3">
          <button
            className="btn btn-outline rounded-2xl"
            onClick={simulateImportEvent}
          >
            Simulate import.parsed
          </button>
          <button
            className="btn btn-ghost rounded-2xl"
            onClick={() => openPanel("eventCatalog")}
          >
            Open Event Catalog
          </button>
        </div>
      </Section>

      {/* Reference panels */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 mt-4">
        {PANELS.map((p) => (
          <Section key={p.id} title={p.title} subtitle={p.blurb}>
            <button
              className="btn btn-primary rounded-2xl"
              onClick={() => openPanel(p.id)}
            >
              Open {p.title}
            </button>
          </Section>
        ))}
      </div>

      {/* Tools */}
      <h2 className="text-lg font-semibold mt-8 mb-2">Tools</h2>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {TOOLS_CATALOG.map((t) => (
          <Section key={t.id} title={t.title} subtitle={t.description}>
            <button
              className="btn btn-outline rounded-2xl"
              onClick={() => openTool(t.routeKey, t.id)}
            >
              Open Tool
            </button>
          </Section>
        ))}
      </div>

      {/* Articles */}
      <h2 className="text-lg font-semibold mt-8 mb-2">Articles & Guides</h2>
      <div className="flex items-center gap-2 mb-3">
        <input
          type="search"
          className="input input-bordered rounded-2xl w-full md:w-96"
          placeholder="Search articles by title or tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          className="btn btn-ghost rounded-2xl"
          onClick={() => setQuery("")}
        >
          Clear
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filteredArticles.map((a) => (
          <section
            key={a.id}
            className="card bg-base-100 border border-base-200 rounded-2xl shadow-sm"
          >
            <div className="card-body">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold">{a.title}</h3>
                <button
                  className={`btn btn-sm rounded-2xl ${
                    favs.includes(a.id) ? "btn-warning" : "btn-ghost"
                  }`}
                  onClick={() => toggleFav(a.id)}
                >
                  {favs.includes(a.id) ? "★" : "☆"}
                </button>
              </div>

              <div className="flex gap-1 flex-wrap mt-1">
                {(a.tags || []).map((t) => (
                  <Pill key={`${a.id}-${t}`}>{t}</Pill>
                ))}
              </div>

              <div className="flex flex-wrap gap-2 mt-3">
                <button
                  className="btn btn-primary btn-sm rounded-2xl"
                  onClick={() => openPanel(a.panel || "docs")}
                >
                  Open
                </button>
                <button
                  className="btn btn-outline btn-sm rounded-2xl"
                  onClick={() =>
                    emit("knowledge.article.view", {
                      id: a.id,
                      via: "preview",
                    })
                  }
                >
                  Preview
                </button>
              </div>
            </div>
          </section>
        ))}
      </div>

      {/* Reverse generation triggers */}
      <h2 className="text-lg font-semibold mt-8 mb-2">Reverse Generation</h2>
      <p className="text-sm text-base-content/70 mb-3">
        Start from goals/targets and let engines compute the best path back to
        actions.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[
          "meals",
          "cleaning",
          "garden",
          "animals",
          "preservation",
          "storehouse",
          "couponing",
        ].map((d) => (
          <button
            key={d}
            className="btn rounded-2xl border"
            onClick={() => requestReverse(d)}
          >
            Reverse-generate: {d}
          </button>
        ))}
      </div>

      {/* Quick links */}
      <h2 className="text-lg font-semibold mt-8 mb-2">Quick Links</h2>
      <div className="flex flex-wrap gap-2">
        <button
          className="btn btn-ghost btn-sm rounded-2xl"
          onClick={() => openQuickLink(ROUTES.scanExtreme, "couponing")}
        >
          Extreme Couponing
        </button>
        <button
          className="btn btn-ghost btn-sm rounded-2xl"
          onClick={() => openQuickLink(ROUTES.garden, "garden")}
        >
          Garden
        </button>
        <button
          className="btn btn-ghost btn-sm rounded-2xl"
          onClick={() => openQuickLink(ROUTES.animals, "animals")}
        >
          Animal Care
        </button>
        <button
          className="btn btn-ghost btn-sm rounded-2xl"
          onClick={() => openQuickLink(ROUTES.meals, "cooking")}
        >
          Cooking
        </button>
        <button
          className="btn btn-ghost btn-sm rounded-2xl"
          onClick={() => openQuickLink(ROUTES.cleaning, "cleaning")}
        >
          Cleaning
        </button>
        <button
          className="btn btn-ghost btn-sm rounded-2xl"
          onClick={() =>
            openQuickLink(ROUTES.storehouse, "storehouse.autoFill")
          }
        >
          Storehouse Auto-Fill
        </button>
        <button
          className="btn btn-ghost btn-sm rounded-2xl"
          onClick={() =>
            openQuickLink(ROUTES.preservation, "preservation.queue")
          }
        >
          Preservation Queue
        </button>
      </div>
    </div>
  );
}
