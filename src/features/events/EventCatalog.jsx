/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\events\EventCatalog.jsx
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";

/**
 * EventCatalog.jsx
 * -----------------------------------------------------------------------------
 * PURPOSE
 * A production-ready, forward-thinking event explorer for SSA's shared event bus.
 *
 * PIPELINE CONTEXT
 * - IMPORTS → INTELLIGENCE → AUTOMATION → (optional) HUB EXPORT
 * - This component listens to the shared eventBus (src/services/events/eventBus.js),
 *   validates/normalizes events into a consistent shape, renders them with
 *   filters, and (optionally) can emit test events.
 * - When events represent state-changing actions (inventory/storehouse/sessions),
 *   we opportunistically forward a formatted packet to the Hub if familyFundMode
 *   is enabled via `exportToHubIfEnabled`.
 *
 * ASSUMPTIONS
 * - event payload shape: { type, ts, source, data }
 *   • type:        string (e.g., "import.parsed", "inventory.updated")
 *   • ts:          ISO timestamp string
 *   • source:      string identifier (e.g., "ImportService", "GardenSessionEngine")
 *   • data:        free-form object; MAY include domain details
 *
 * RESILIENCE & DEFENSIVE DESIGN
 * - All external modules are soft-imported to avoid hard runtime failures.
 * - Input validation and early returns on bad data.
 * - The UI survives if the bus is missing (shows a warning banner).
 *
 * EXTENSION POINTS
 * - New domains/types require no code changes; filters are dynamic.
 * - Add custom renderers per event.type inside `renderersByType` if you want
 *   richer detail cards for specific types later.
 */

// ----------------------------- Soft Imports ---------------------------------
let eventBus = null;
try {
  // Expected to expose: on(typeOrWildcard, handler) and emit(event)
  // and ideally onAny(handler) for wildcard listening (we'll feature-detect).
  eventBus =
    require("@/services/events/eventBus").default ??
    require("@/services/events/eventBus");
} catch (e) {
  // Leave null; UI will degrade gracefully.
}

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
  // Quick check — Date parsing fallback if needed
  const d = new Date(s);
  return !Number.isNaN(d.valueOf());
}

function ensureISO(ts) {
  return isISO(ts) ? ts : NOW_ISO();
}

function nanoid(len = 12) {
  // Small, dependency-free ID (not cryptographically strong)
  const alphabet =
    "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < len; i++)
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function validateEvent(evt) {
  if (!evt || typeof evt !== "object") return false;
  if (typeof evt.type !== "string" || !evt.type.trim()) return false;
  // ts/source are optional but strongly recommended; we will normalize them.
  return true;
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

// Heuristic: forward only if event represents household state changes
function isHouseholdMutation(evtType) {
  return (
    evtType.startsWith("inventory.") ||
    evtType.startsWith("storehouse.") ||
    evtType.startsWith("meal.") ||
    evtType.startsWith("garden.") ||
    evtType.startsWith("animal.") ||
    evtType.endsWith(".completed") ||
    evtType.endsWith(".updated") ||
    evtType.endsWith(".created")
  );
}

/**
 * exportToHubIfEnabled
 * 1) Checks featureFlags.familyFundMode
 * 2) Uses HubPacketFormatter + FamilyFundConnector to send
 * 3) Fails silently (logs debug) on any problem
 */
async function exportToHubIfEnabled(eventPayload) {
  try {
    const flags = Config.get?.("featureFlags", {}) ?? {};
    if (!flags.familyFundMode) return;

    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const packet = HubPacketFormatter.format?.(eventPayload);
    if (!packet) return;

    await FamilyFundConnector.send?.(packet);
  } catch (err) {
    // Silent failure by design; keep SSA UX snappy even if Hub is unavailable
    if (process.env.NODE_ENV !== "production") {
      console.debug("[EventCatalog] Hub export failed (ignored):", err);
    }
  }
}

// ------------------------------ Hook: Stream --------------------------------
/**
 * useEventStream
 * Listens to all events from eventBus. If the bus supports onAny, we use it.
 * Otherwise, we attach per-known-type handlers the first time we see them by
 * intercepting the bus.emit (only if it safely exposes it). If neither are
 * available, we can't live-listen.
 */
function useEventStream({ enabled }) {
  const [events, setEvents] = useState([]);
  const knownTypesRef = useRef(new Set());
  const unsubRef = useRef([]);

  const appendEvent = useCallback((evt) => {
    try {
      if (!validateEvent(evt)) return;
      const n = normalizeEvent(evt);
      setEvents((prev) => [n, ...prev].slice(0, 1000)); // keep last 1000 to bound memory
      if (isHouseholdMutation(n.type)) {
        // opportunistic export
        // NOTE: we don't await; we don't want to block UI
        exportToHubIfEnabled(n);
      }
    } catch (e) {
      // swallow
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (!eventBus) return;

    const localUnsubs = [];

    // Prefer onAny if available
    if (typeof eventBus.onAny === "function") {
      const off = eventBus.onAny((e) => appendEvent(e));
      localUnsubs.push(() => off?.());
    } else if (typeof eventBus.on === "function") {
      // Fallback: subscribe to a small core set and also monkey-listen via emit interception
      const coreTypes = [
        "import.parsed",
        "inventory.updated",
        "inventory.shortage.detected",
        "meal.executed",
        "garden.harvest.logged",
        "preservation.completed",
      ];
      coreTypes.forEach((t) => {
        if (knownTypesRef.current.has(t)) return;
        const off = eventBus.on(t, (e) => appendEvent({ ...e, type: t }));
        localUnsubs.push(() => off?.());
        knownTypesRef.current.add(t);
      });

      // Intercept emit (DEFENSIVE: only if it's our bus and we can safely wrap)
      if (!eventBus.__emitWrapped && typeof eventBus.emit === "function") {
        const originalEmit = eventBus.emit.bind(eventBus);
        eventBus.emit = (e) => {
          try {
            appendEvent(e);
          } catch {}
          return originalEmit(e);
        };
        eventBus.__emitWrapped = true;
        localUnsubs.push(() => {
          // Best-effort restore
          try {
            eventBus.emit = originalEmit;
            eventBus.__emitWrapped = false;
          } catch {}
        });
      }
    } else if (typeof window !== "undefined") {
      // LAST RESORT: listen to DOM-level bus if provided (window.__suka.eventBus)
      const domBus = window.__suka?.eventBus;
      if (domBus?.onAny) {
        const off = domBus.onAny((e) => appendEvent(e));
        localUnsubs.push(() => off?.());
      }
    }

    unsubRef.current = localUnsubs;
    return () => {
      unsubRef.current.forEach((fn) => {
        try {
          fn?.();
        } catch {}
      });
      unsubRef.current = [];
    };
  }, [appendEvent, enabled]);

  return { events, clear: () => setEvents([]), appendEvent };
}

// ---------------------------- Render Helpers --------------------------------
const DefaultRow = React.memo(function DefaultRow({ e }) {
  return (
    <div className="rounded-2xl border p-3 md:p-4 mb-3 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs px-2 py-1 rounded-full border">
            {e.type}
          </span>
          <span className="text-xs text-neutral-500">{e.source}</span>
        </div>
        <time className="text-xs tabular-nums text-neutral-600">
          {new Date(e.ts).toLocaleString()}
        </time>
      </div>
      {e.data && Object.keys(e.data).length > 0 ? (
        <pre className="mt-2 text-xs overflow-auto max-h-48 rounded-lg bg-neutral-50 p-2 dark:bg-neutral-900">
          {JSON.stringify(e.data, null, 2)}
        </pre>
      ) : null}
      <details className="mt-2">
        <summary className="text-xs text-neutral-600 cursor-pointer">
          Raw
        </summary>
        <pre className="mt-1 text-[11px] overflow-auto max-h-48 rounded-lg bg-neutral-50 p-2 dark:bg-neutral-900">
          {JSON.stringify(e.__raw, null, 2)}
        </pre>
      </details>
    </div>
  );
});

// Slot for future specialized renderers per type (optional)
const renderersByType = {
  // "inventory.updated": InventoryUpdatedRow,
  // "garden.harvest.logged": HarvestRow,
};

// ------------------------------- Component -----------------------------------
export default function EventCatalog() {
  const [live, setLive] = useState(true);
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const { events, clear, appendEvent } = useEventStream({ enabled: live });

  // Derived filters
  const { types, sources } = useMemo(() => {
    const t = new Set();
    const s = new Set();
    events.forEach((e) => {
      t.add(e.type);
      if (e.source) s.add(e.source);
    });
    return { types: Array.from(t).sort(), sources: Array.from(s).sort() };
  }, [events]);

  const filtered = useMemo(() => {
    return events.filter((e) => {
      if (typeFilter !== "all" && e.type !== typeFilter) return false;
      if (sourceFilter !== "all" && e.source !== sourceFilter) return false;

      if (dateFrom) {
        const fromMs = new Date(dateFrom).getTime();
        if (new Date(e.ts).getTime() < fromMs) return false;
      }
      if (dateTo) {
        const toMs = new Date(dateTo).getTime();
        if (new Date(e.ts).getTime() > toMs) return false;
      }

      if (q) {
        const needle = q.toLowerCase();
        const hay = `${e.type} ${e.source} ${e.ts} ${JSON.stringify(
          e.data ?? {}
        )}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }

      return true;
    });
  }, [events, typeFilter, sourceFilter, dateFrom, dateTo, q]);

  const onEmitTest = useCallback(
    (kind) => {
      const test = {
        type: kind,
        ts: NOW_ISO(),
        source: "EventCatalog",
        data:
          kind === "inventory.updated"
            ? { sku: "FLOUR-AP-5LB", delta: -1, reason: "test" }
            : kind === "import.parsed"
            ? { domain: "recipe", items: 3, origin: "sample.url" }
            : kind === "preservation.completed"
            ? { method: "dehydrate", item: "apples", qty: "4 trays" }
            : { echo: true },
      };

      // Try the actual bus first
      if (eventBus?.emit) {
        try {
          eventBus.emit(test);
        } catch (e) {
          console.warn(
            "[EventCatalog] Bus emit failed; falling back to local append",
            e
          );
          appendEvent(test);
        }
      } else {
        appendEvent(test);
      }
    },
    [appendEvent]
  );

  const emptyState = (
    <div className="text-sm text-neutral-600 border rounded-2xl p-6 text-center">
      {eventBus
        ? "No events yet. Trigger an action in SSA or emit a test event below."
        : "eventBus not available. Ensure '@/services/events/eventBus' is exported. You can still emit local test events below."}
    </div>
  );

  return (
    <div className="p-4 md:p-6">
      <header className="mb-4 md:mb-6">
        <h1 className="text-xl md:text-2xl font-semibold">Event Catalog</h1>
        <p className="text-sm text-neutral-600">
          Live view of SSA&apos;s event pipeline — imports → intelligence →
          automation → (optional) hub export.
        </p>
        {!eventBus && (
          <div className="mt-3 text-xs border border-amber-300 bg-amber-50 text-amber-800 rounded-lg p-2">
            ⚠️ eventBus not detected. The catalog will still capture locally
            emitted test events.
          </div>
        )}
      </header>

      {/* Controls */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3 md:gap-4 mb-4">
        <div className="md:col-span-2">
          <label className="block text-xs text-neutral-600 mb-1">Live</label>
          <button
            className={`w-full rounded-xl border px-3 py-2 text-sm ${
              live ? "bg-green-50 border-green-300" : "bg-neutral-50"
            }`}
            onClick={() => setLive((v) => !v)}
            aria-pressed={live}
          >
            {live ? "Streaming" : "Paused"}
          </button>
        </div>

        <div className="md:col-span-3">
          <label className="block text-xs text-neutral-600 mb-1">Type</label>
          <select
            className="w-full rounded-xl border px-3 py-2 text-sm bg-white"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="all">All types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-3">
          <label className="block text-xs text-neutral-600 mb-1">Source</label>
          <select
            className="w-full rounded-xl border px-3 py-2 text-sm bg-white"
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
          >
            <option value="all">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-4">
          <label className="block text-xs text-neutral-600 mb-1">Search</label>
          <input
            className="w-full rounded-xl border px-3 py-2 text-sm"
            placeholder="Find by text, type, source, or data"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="md:col-span-3">
          <label className="block text-xs text-neutral-600 mb-1">From</label>
          <input
            type="datetime-local"
            className="w-full rounded-xl border px-3 py-2 text-sm"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
        </div>

        <div className="md:col-span-3">
          <label className="block text-xs text-neutral-600 mb-1">To</label>
          <input
            type="datetime-local"
            className="w-full rounded-xl border px-3 py-2 text-sm"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>

        <div className="md:col-span-2 flex items-end">
          <button
            className="w-full rounded-xl border px-3 py-2 text-sm hover:shadow"
            onClick={clear}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Emit test events */}
      <section className="mb-4">
        <div className="text-xs text-neutral-600 mb-2">Emit test events</div>
        <div className="flex flex-wrap gap-2">
          {[
            "import.parsed",
            "inventory.updated",
            "inventory.shortage.detected",
            "meal.executed",
            "garden.harvest.logged",
            "preservation.completed",
          ].map((k) => (
            <button
              key={k}
              className="rounded-xl border px-3 py-2 text-xs hover:shadow"
              onClick={() => onEmitTest(k)}
              title={`Emit ${k}`}
            >
              {k}
            </button>
          ))}
        </div>
      </section>

      {/* Event list */}
      <section>
        {filtered.length === 0 ? (
          emptyState
        ) : (
          <div>
            {filtered.map((e) => {
              const Renderer = renderersByType[e.type] || DefaultRow;
              return <Renderer key={e.id} e={e} />;
            })}
          </div>
        )}
      </section>
    </div>
  );
}
