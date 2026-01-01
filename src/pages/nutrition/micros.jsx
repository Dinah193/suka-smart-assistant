/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\pages\nutrition\micros.jsx
//
// Micros Page (SSA)
// -----------------------------------------------------------------------------
// Shared wiring layer usage demo:
// - Reads active person + canonical prefs/targets from nutritionStore
// - Runs micros computation (stores derivation + updates targets.micros)
// - Reacts to macro changes (MACROS_COMPUTED) without tight coupling
// - Includes "Reset to defaults" flow
//
// SSA rules: JS only; defensive imports; do not break other pages.
// -----------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from "react";

let useNutritionStore = null;
try {
  // eslint-disable-next-line import/no-unresolved
  ({ useNutritionStore } = require("@/services/nutrition/nutritionStore"));
} catch {
  try {
    ({
      useNutritionStore,
    } = require("../../services/nutrition/nutritionStore"));
  } catch {}
}

let NUTRITION_EVENTS = null;
let onNutritionEvent = null;
try {
  // eslint-disable-next-line import/no-unresolved
  ({
    NUTRITION_EVENTS,
    onNutritionEvent,
  } = require("@/services/nutrition/nutritionEvents"));
} catch {
  try {
    ({
      NUTRITION_EVENTS,
      onNutritionEvent,
    } = require("../../services/nutrition/nutritionEvents"));
  } catch {}
}

export default function Micros() {
  const store = useNutritionStore ? useNutritionStore() : null;
  const actions = store?.actions;
  const selectors = store?.selectors;

  const active = selectors?.getActivePerson
    ? selectors.getActivePerson()
    : null;
  const prefs = selectors?.getActivePrefs ? selectors.getActivePrefs() : null;
  const targets = selectors?.getActiveTargets
    ? selectors.getActiveTargets()
    : null;

  const [busy, setBusy] = useState(false);
  const microsEntries = useMemo(() => {
    const m =
      targets?.micros && typeof targets.micros === "object"
        ? targets.micros
        : {};
    return Object.entries(m);
  }, [targets]);

  useEffect(() => {
    if (!actions?.bootstrap || !actions?.wireSubscriptions) return;

    actions.bootstrap();
    const unsubPromise = actions.wireSubscriptions();

    // React if macros change while on micros page (no tight coupling)
    const unsub2Promise =
      onNutritionEvent && NUTRITION_EVENTS?.MACROS_COMPUTED
        ? onNutritionEvent(NUTRITION_EVENTS.MACROS_COMPUTED, async (evt) => {
            try {
              const personId = evt?.data?.personId;
              const activeId = active?.id;
              // If macros computed for the active person, refresh prefs/targets in micros UI
              if (
                personId &&
                activeId &&
                String(personId) === String(activeId)
              ) {
                await actions.refreshPrefs(activeId, {
                  reason: `event:${NUTRITION_EVENTS.MACROS_COMPUTED}`,
                });
              }
            } catch {}
          })
        : Promise.resolve(() => {});

    return () => {
      void unsubPromise.then((unsub) => unsub && unsub());
      void unsub2Promise.then((unsub) => unsub && unsub());
    };
    // intentionally mount-only; store subscriptions handle cross-updates
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onRecomputeMicros() {
    if (!actions?.runMicros) return;
    if (!active?.id) return;
    setBusy(true);
    try {
      await actions.runMicros(active.id);
    } finally {
      setBusy(false);
    }
  }

  async function onResetDefaults() {
    if (!actions?.resetToDefaults) return;
    if (!active?.id) return;
    setBusy(true);
    try {
      await actions.resetToDefaults(active.id);
    } finally {
      setBusy(false);
    }
  }

  // Keep your existing Micros UI: drop it into this container if you already have one.
  return (
    <div style={{ padding: 16 }}>
      <h1 style={{ margin: 0 }}>Micronutrients</h1>

      <div style={{ marginTop: 12, opacity: 0.85 }}>
        <div>
          <strong>Active person:</strong>{" "}
          {active?.name ? `${active.name} (${active.id})` : "None selected"}
        </div>
        <div style={{ marginTop: 6 }}>
          <strong>Goal:</strong> {prefs?.goal || "maintain"}{" "}
          <span style={{ marginLeft: 12 }}>
            <strong>Activity:</strong> {active?.activityLevel || "moderate"}
          </span>
        </div>
      </div>

      <div
        style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}
      >
        <button
          type="button"
          onClick={onRecomputeMicros}
          disabled={busy || !active?.id}
        >
          {busy ? "Working..." : "Recompute Micros"}
        </button>

        <button
          type="button"
          onClick={onResetDefaults}
          disabled={busy || !active?.id}
        >
          Reset to defaults
        </button>
      </div>

      <div style={{ marginTop: 18 }}>
        <h2 style={{ margin: "10px 0" }}>Targets</h2>

        {microsEntries.length === 0 ? (
          <div style={{ opacity: 0.75 }}>
            No micronutrient targets yet. Click{" "}
            <strong>Recompute Micros</strong>.
          </div>
        ) : (
          <div
            style={{
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 8,
              padding: 12,
            }}
          >
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {microsEntries.map(([k, v]) => (
                <li key={k}>
                  <strong>{k}:</strong> {v == null ? "—" : String(v)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Optional debug block (safe in DEV; remove if you want) */}
      {import.meta?.env?.DEV ? (
        <pre style={{ marginTop: 18, fontSize: 12, opacity: 0.75 }}>
          {JSON.stringify(
            {
              activePersonId: active?.id || null,
              derived: selectors?.getDerived ? selectors.getDerived() : null,
            },
            null,
            2
          )}
        </pre>
      ) : null}
    </div>
  );
}
