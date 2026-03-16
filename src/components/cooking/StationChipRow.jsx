// src/components/cooking/StationChipRow.jsx
import React, { useMemo } from "react";

/**
 * StationChipRow — scrollable, thumb-friendly station filter chips.
 * - Renders an "All" chip plus one per station.
 * - Emits play.station.filter.changed with { selectedKey } using the shared eventBus.
 * - Optional hubSync uses HubPacketFormatter + FamilyFundConnector when familyFundMode is on.
 *
 * SSA pipeline note:
 * This component lives at the "execution UI" layer. It does not mutate imports,
 * but it steers which subset of steps/timers are shown/controlled in Play/Overlay.
 * Its event payloads keep automation and remote controllers in sync.
 */

let eventBus = {
  emit: (...a) => console.debug("[StationChipRow:eventBus.emit]", ...a),
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = {};
try {
  featureFlags = require("@/config/featureFlags.json");
} catch {}

/* Optional Hub modules (fail-safe if absent) */
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter").default;
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector").default;
} catch {}

/* ------------------------------ helpers ------------------------------ */
const isoNow = () => new Date().toISOString();

function emitEvent(type, data = {}) {
  const payload = {
    type,
    ts: isoNow(),
    source: "components.cooking.StationChipRow",
    data,
  };
  eventBus.emit?.(type, payload);
  return payload;
}

async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    // silent fail by design
  }
}

/** Normalize incoming stations into safe list: [{ key, label, count? }] */
function normalizeStations(stations = []) {
  if (!Array.isArray(stations)) return [];
  return stations
    .map((s, i) => {
      if (!s) return null;
      const key = String(s.key ?? s.id ?? s.label ?? `station-${i}`).trim();
      const label = String(s.label ?? s.name ?? key).trim();
      if (!key || !label) return null;
      return {
        key,
        label,
        count: Number.isFinite(s.count) ? Number(s.count) : undefined,
      };
    })
    .filter(Boolean);
}

/* ------------------------------- component ------------------------------- */
export default function StationChipRow({
  stations, // array of { key, label, count? }
  value = "all", // current selected key ("all" | station.key)
  onChange, // fn(nextKey)
  includeAll = true, // show the "All" chip
  compact = false, // slightly smaller paddings
  showCounts = true, // render small numeric badges when provided
  room = null, // optional rtc/WS room context for envelopes
  sessionId = null, // optional session context
  hubSync = false, // also attempt hub export if familyFundMode
  onControlSend = null, // optional: upstream real-time envelope sender
  "aria-label": ariaLabel = "Filter by station",
}) {
  const list = useMemo(() => normalizeStations(stations), [stations]);
  const selectedKey = value || "all";

  const vibrate = (pattern = 12) => {
    try {
      if ("vibrate" in navigator) navigator.vibrate(pattern);
    } catch {}
  };

  const sendEnvelope = (key) => {
    const env = {
      kind: "station.filter",
      ts: isoNow(),
      room,
      sessionId,
      selectedKey: key,
    };
    eventBus.emit?.("play.control", {
      type: "play.control",
      ts: env.ts,
      source: "StationChipRow",
      data: env,
    });
    try {
      onControlSend?.(env);
    } catch {}
  };

  const handleSelect = (key) => {
    if (!key) key = "all";
    if (key === selectedKey) return;
    vibrate();
    sendEnvelope(key);
    const e = emitEvent("play.station.filter.changed", {
      sessionId,
      room,
      selectedKey: key,
    });
    try {
      onChange?.(key);
    } catch (err) {
      console.warn("[StationChipRow] onChange error:", err);
    }
    if (hubSync) exportToHubIfEnabled(e);
  };

  const chipClass = `sv-chip${compact ? " sv-chip--sm" : ""}`;

  return (
    <div
      className="sv-cardRow"
      role="tablist"
      aria-label={ariaLabel}
      style={{ paddingTop: 4, paddingBottom: 4 }}
    >
      {includeAll && (
        <button
          type="button"
          className={`${chipClass} ${selectedKey === "all" ? "is-active" : ""}`}
          onClick={() => handleSelect("all")}
          role="tab"
          aria-selected={selectedKey === "all"}
          title="Show all stations"
        >
          All
        </button>
      )}

      {list.map((s) => (
        <button
          key={s.key}
          type="button"
          className={`${chipClass} ${selectedKey === s.key ? "is-active" : ""}`}
          onClick={() => handleSelect(s.key)}
          role="tab"
          aria-selected={selectedKey === s.key}
          title={s.label}
        >
          <span className="sv-strong">{s.label}</span>
          {showCounts && Number.isFinite(s.count) ? (
            <span className="sv-badge" style={{ marginLeft: 8 }}>
              {s.count}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
