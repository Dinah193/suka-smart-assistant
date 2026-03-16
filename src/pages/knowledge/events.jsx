/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\pages\knowledge\events.jsx
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  Suspense,
} from "react";

/**
 * knowledge/events.jsx — Events Knowledge Page
 * -----------------------------------------------------------------------------
 * ROLE IN PIPELINE
 * Imports → Intelligence → Automation → (optional) Hub Export
 * - This page is the "knowledge view" for SSA's shared event stream.
 * - It renders KPIs over the live bus, provides export tools, and embeds the
 *   EventCatalog explorer (features/events/EventCatalog.jsx) if available.
 *
 * REQUIREMENTS MET
 * - Forward-thinking: works even if EventCatalog or the bus are unavailable.
 * - Automated: subscribes to src/services/events/eventBus.js and listens for payloads
 *   shaped like { type, ts, source, data } (ISO timestamps).
 * - Efficient/Defensive: soft-imports, guards, memoized aggregations, bounded
 *   in-memory buffers, and early returns on malformed events.
 * - Hub export: whenever we *emit* (e.g., test events) and that event implies
 *   household mutation, we opportunistically forward to Hub via
 *   HubPacketFormatter + FamilyFundConnector if featureFlags.familyFundMode=true.
 */

// ----------------------------- Soft Imports ---------------------------------
let EventCatalog = null;
try {
  EventCatalog = require("@/features/events/EventCatalog.jsx").default;
} catch {}

let eventBus = null;
try {
  eventBus =
    require("@/services/events/eventBus").default ??
    require("@/services/events/eventBus");
} catch {}

let Config = { get: (k, fallback) => fallback };
try {
  Config = require("@/config").default ?? require("@/config");
} catch {}

let HubPacketFormatter = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter").default;
} catch {}

let FamilyFundConnector = null;
try {
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector").default;
} catch {}

// ------------------------------ Utilities -----------------------------------
const NOW_ISO = () => new Date().toISOString();

function isISO(s) {
  if (typeof s !== "string") return false;
  const d = new Date(s);
  return !Number.isNaN(d.valueOf());
}
function ensureISO(ts) {
  return isISO(ts) ? ts : NOW_ISO();
}
function nanoid(len = 10) {
  const a = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < len; i++) out += a[Math.floor(Math.random() * a.length)];
  return out;
}
function validateEvent(evt) {
  return (
    !!evt &&
    typeof evt === "object" &&
    typeof evt.type === "string" &&
    evt.type.trim()
  );
}
function normalizeEvent(evt) {
  return {
    id: evt.id || `${evt.type}:${evt.ts || NOW_ISO()}:${nanoid(6)}`,
    type: String(evt.type),
    ts: ensureISO(evt.ts),
    source:
      typeof evt.source === "string" && evt.source.trim()
        ? evt.source
        : "unknown",
    data: typeof evt.data === "object" && evt.data !== null ? evt.data : {},
    __raw: evt,
  };
}
function isHouseholdMutation(type) {
  return (
    type.startsWith("inventory.") ||
    type.startsWith("storehouse.") ||
    type.startsWith("meal.") ||
    type.startsWith("garden.") ||
    type.startsWith("animal.") ||
    type.endsWith(".completed") ||
    type.endsWith(".updated") ||
    type.endsWith(".created")
  );
}

async function exportToHubIfEnabled(eventPayload) {
  try {
    const flags = Config.get?.("featureFlags", {}) ?? {};
    if (!flags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const packet = HubPacketFormatter.format?.(eventPayload);
    if (!packet) return;

    await FamilyFundConnector.send?.(packet);
  } catch (err) {
    // Silent on purpose; keep SSA UX snappy
    if (process.env.NODE_ENV !== "production") {
      console.debug("[knowledge/events] Hub export failed (ignored):", err);
    }
  }
}

// ---------------------------- Event KPI Stream ------------------------------
/**
 * useEventKPIs
 * - Subscribes to the event bus (onAny preferred) and keeps bounded buffer.
 * - Derives totals, last 60m, last 24h, and per-type counts.
 */
function useEventKPIs({ enabled = true, max = 1000 } = {}) {
  const [events, setEvents] = useState([]);
  const unsubsRef = useRef([]);

  const append = useCallback(
    (evt) => {
      if (!validateEvent(evt)) return;
      const n = normalizeEvent(evt);
      setEvents((prev) => [n, ...prev].slice(0, max));
    },
    [max]
  );

  useEffect(() => {
    if (!enabled || !eventBus) return;
    const localUnsubs = [];

    if (typeof eventBus.onAny === "function") {
      const off = eventBus.onAny((e) => append(e));
      localUnsubs.push(() => off?.());
    } else if (typeof eventBus.on === "function") {
      // Core types as a minimum safety net
      const core = [
        "import.parsed",
        "inventory.updated",
        "inventory.shortage.detected",
        "meal.executed",
        "garden.harvest.logged",
        "preservation.completed",
      ];
      core.forEach((t) => {
        const off = eventBus.on(t, (e) => append({ ...e, type: t }));
        localUnsubs.push(() => off?.());
      });

      // As a best-effort, patch emit to observe all events
      if (!eventBus.__emitWrapped && typeof eventBus.emit === "function") {
        const originalEmit = eventBus.emit.bind(eventBus);
        eventBus.emit = (e) => {
          try {
            append(e);
          } catch {}
          return originalEmit(e);
        };
        eventBus.__emitWrapped = true;
        localUnsubs.push(() => {
          try {
            eventBus.emit = originalEmit;
            eventBus.__emitWrapped = false;
          } catch {}
        });
      }
    }

    unsubsRef.current = localUnsubs;
    return () => {
      unsubsRef.current.forEach((fn) => {
        try {
          fn?.();
        } catch {}
      });
      unsubsRef.current = [];
    };
  }, [enabled, append]);

  const kpis = useMemo(() => {
    const now = Date.now();
    const hr = 60 * 60 * 1000;
    const day = 24 * hr;

    let total = events.length;
    let lastHour = 0;
    let lastDay = 0;
    const perType = new Map();
    const perSource = new Map();

    for (const e of events) {
      const t = new Date(e.ts).getTime();
      if (now - t <= hr) lastHour++;
      if (now - t <= day) lastDay++;

      perType.set(e.type, (perType.get(e.type) ?? 0) + 1);
      perSource.set(e.source, (perSource.get(e.source) ?? 0) + 1);
    }

    const topTypes = Array.from(perType.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);
    const topSources = Array.from(perSource.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    return { total, lastHour, lastDay, topTypes, topSources };
  }, [events]);

  return {
    events,
    kpis,
    clear: () => setEvents([]),
    append,
  };
}

// ---------------------------- Export Utilities ------------------------------
function downloadJSON(filename, obj) {
  try {
    const blob = new Blob([JSON.stringify(obj, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn("[knowledge/events] downloadJSON failed", e);
  }
}

// ----------------------------- Page Component -------------------------------
export default function KnowledgeEventsPage() {
  const [live, setLive] = useState(true);
  const { events, kpis, clear, append } = useEventKPIs({
    enabled: live,
    max: 1000,
  });

  const emitTest = useCallback(
    (type) => {
      const payload = {
        type,
        ts: NOW_ISO(),
        source: "KnowledgeEvents",
        data:
          type === "inventory.updated"
            ? { sku: "TEST-ITEM", delta: +2, reason: "manual.adjustment" }
            : type === "garden.harvest.logged"
            ? { crop: "kale", qty: "1.2 lb", bed: "B2" }
            : type === "meal.executed"
            ? { sessionId: nanoid(8), recipes: 2, servings: 6 }
            : type === "import.parsed"
            ? { domain: "recipe", count: 5, origin: "clipboard" }
            : type === "preservation.completed"
            ? { method: "pressure-canning", item: "broth", jars: 7 }
            : { ok: true },
      };

      // Prefer real bus
      if (eventBus?.emit) {
        try {
          eventBus.emit(payload);
        } catch (e) {
          console.warn(
            "[knowledge/events] bus.emit failed; appending locally",
            e
          );
          append(payload);
        }
      } else {
        append(payload);
      }

      if (isHouseholdMutation(type)) {
        // fire-and-forget
        exportToHubIfEnabled(payload);
      }
    },
    [append]
  );

  const exportAll = useCallback(() => {
    downloadJSON(
      `ssa-events-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      events
    );
  }, [events]);

  const hasBus = !!eventBus;

  return (
    <div className="p-4 md:p-6">
      <header className="mb-5 md:mb-7">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl md:text-2xl font-semibold">Events</h1>
            <p className="text-sm text-neutral-600">
              Live knowledge view of SSA’s event pipeline — imports →
              intelligence → automation → (optional) hub export.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className={`rounded-xl border px-3 py-2 text-sm ${
                live ? "bg-green-50 border-green-300" : "bg-neutral-50"
              }`}
              onClick={() => setLive((v) => !v)}
              aria-pressed={live}
              title={live ? "Pause stream" : "Resume stream"}
            >
              {live ? "Streaming" : "Paused"}
            </button>
            <button
              className="rounded-xl border px-3 py-2 text-sm hover:shadow"
              onClick={clear}
            >
              Clear
            </button>
            <button
              className="rounded-xl border px-3 py-2 text-sm hover:shadow"
              onClick={exportAll}
            >
              Export JSON
            </button>
          </div>
        </div>

        {!hasBus && (
          <div className="mt-2 text-xs border border-amber-300 bg-amber-50 text-amber-800 rounded-lg p-2">
            ⚠️ eventBus not detected. KPIs will reflect only locally emitted
            test events.
          </div>
        )}
      </header>

      {/* KPI Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 mb-6">
        <KpiCard label="Total captured" value={kpis.total} />
        <KpiCard label="Last 60 minutes" value={kpis.lastHour} />
        <KpiCard label="Last 24 hours" value={kpis.lastDay} />
      </section>

      {/* Top Types / Sources */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 mb-6">
        <div className="rounded-2xl border p-3">
          <div className="text-sm font-medium mb-2">Top event types</div>
          {kpis.topTypes?.length ? (
            <div className="flex flex-wrap gap-2">
              {kpis.topTypes.map(([t, c]) => (
                <span key={t} className="text-xs px-2 py-1 rounded-full border">
                  {t} <span className="opacity-60">×{c}</span>
                </span>
              ))}
            </div>
          ) : (
            <div className="text-xs text-neutral-500">No data yet.</div>
          )}
        </div>

        <div className="rounded-2xl border p-3">
          <div className="text-sm font-medium mb-2">Top sources</div>
          {kpis.topSources?.length ? (
            <div className="flex flex-wrap gap-2">
              {kpis.topSources.map(([s, c]) => (
                <span key={s} className="text-xs px-2 py-1 rounded-full border">
                  {s} <span className="opacity-60">×{c}</span>
                </span>
              ))}
            </div>
          ) : (
            <div className="text-xs text-neutral-500">No data yet.</div>
          )}
        </div>
      </section>

      {/* Quick emit panel for verification & demos */}
      <section className="mb-6">
        <div className="rounded-2xl border p-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="text-sm font-medium">Emit test events</div>
            <div className="text-xs text-neutral-500">
              Verifies bus wiring + hub export hook
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              "import.parsed",
              "inventory.updated",
              "inventory.shortage.detected",
              "meal.executed",
              "garden.harvest.logged",
              "preservation.completed",
            ].map((t) => (
              <button
                key={t}
                className="rounded-xl border px-3 py-2 text-xs hover:shadow"
                onClick={() => emitTest(t)}
                title={`Emit ${t}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Event Explorer (from features) */}
      <section className="mb-10">
        <div className="flex items-center justify-between mb-2">
          <div className="text-sm font-medium">Event stream</div>
          {!EventCatalog && (
            <span className="text-xs text-neutral-500">
              EventCatalog component not found. The KPI stream above still
              works.
            </span>
          )}
        </div>

        <div className="rounded-2xl border">
          {EventCatalog ? (
            <Suspense
              fallback={
                <div className="p-4 text-sm text-neutral-600">
                  Loading EventCatalog…
                </div>
              }
            >
              <EventCatalog />
            </Suspense>
          ) : (
            <div className="p-4 text-sm text-neutral-600">
              To enable the full explorer, add{" "}
              <code className="px-1 rounded bg-neutral-100">
                src/features/events/EventCatalog.jsx
              </code>
              .
            </div>
          )}
        </div>
      </section>

      {/* Help / Docs */}
      <section className="mb-8">
        <details className="rounded-2xl border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            How this page fits into SSA
          </summary>
          <ul className="list-disc pl-5 text-sm mt-2 space-y-1">
            <li>
              <strong>Imports →</strong> External data is normalized by
              ImportRouter/ImportService and emitted as{" "}
              <code>import.parsed</code>.
            </li>
            <li>
              <strong>Intelligence →</strong> Engines derive sessions and update
              inventory/storehouse, emitting <code>*.updated</code>,{" "}
              <code>*.created</code>.
            </li>
            <li>
              <strong>Automation →</strong> The runtime schedules sessions;
              completions emit <code>*.completed</code> and domain signals like{" "}
              <code>garden.harvest.logged</code>.
            </li>
            <li>
              <strong>Hub export (optional) →</strong> When familyFundMode is
              enabled, mutation events are formatted and sent to the Hub using
              existing connectors.
            </li>
          </ul>
        </details>
      </section>
    </div>
  );
}

// ------------------------------- UI Bits ------------------------------------
function KpiCard({ label, value }) {
  return (
    <div className="rounded-2xl border p-3 md:p-4">
      <div className="text-xs text-neutral-600 mb-1">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value ?? 0}</div>
    </div>
  );
}
