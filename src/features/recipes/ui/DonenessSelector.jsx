/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\ui\DonenessSelector.jsx
//
// SSA • DonenessSelector
// -----------------------------------------------------------------------------
// A reusable doneness picker for CookSetupModal (or any recipe UI).
// Supports:
//   - Dropdown mode (compact)
//   - Slider mode (friendly "rare → well" scale)
//   - Optional internal temperature override (°F / °C)
//   - Evidence + hints display (from DonenessResolver output)
//
// Styling:
//   - SSA household CSS friendly (no Tailwind)
//   - Self-contained inline styles where needed
//
// Props:
//   value: {
//     targetKey?: string,          // e.g., "rare", "medium", "well"
//     targetName?: string,         // user-friendly label
//     internalTempF?: number|null,
//     internalTempC?: number|null,
//     notes?: string,
//   }
//
//   options: Array<{
//     key: string,                 // unique key
//     label: string,               // display label
//     sliderIndex?: number,        // optional for slider ordering
//     internalTempF?: number|null,
//     internalTempC?: number|null,
//     description?: string,
//     tags?: string[],
//   }>
//
//   mode?: "dropdown" | "slider"   // default "dropdown"
//   tempUnit?: "F" | "C"           // default "F"
//   allowTempOverride?: boolean    // default true
//   allowNotes?: boolean           // default true
//   disabled?: boolean
//
//   context?: {
//     proteinCategory?: string|null,
//     cutTag?: string|null,
//     method?: string|null,
//   }
//
//   resolved?: {
//     target?: { name?: string, internalTempF?: number, internalTempC?: number },
//     notes?: string,
//     confidence?: number,
//     evidence?: any,
//   }   // optional resolver output to show hints
//
//   onChange: (nextValue) => void
//
// -----------------------------------------------------------------------------
// Notes:
//   - This component does NOT import catalogs directly.
//   - It expects the caller to pass the doneness options (likely from DonenessTargets.catalog.js).
//
// -----------------------------------------------------------------------------
// No placeholders. Defensive and production-ready.

import React, { useMemo } from "react";

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeString(s, max = 500, fallback = "") {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  return t ? t.slice(0, max) : fallback;
}

function safeLower(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  const y = Math.round(x);
  if (y < min) return min;
  if (y > max) return max;
  return y;
}

function clamp01(n, fallback = 0.7) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function normalizeValue(value) {
  const v = isPlainObject(value) ? value : {};
  return {
    targetKey: safeString(v.targetKey, 80, ""),
    targetName: safeString(v.targetName, 120, ""),
    internalTempF: v.internalTempF == null ? null : Number(v.internalTempF),
    internalTempC: v.internalTempC == null ? null : Number(v.internalTempC),
    notes: safeString(v.notes, 500, ""),
  };
}

function normalizeOptions(options) {
  const arr = Array.isArray(options) ? options : [];
  const out = [];
  for (const o of arr) {
    if (!o) continue;
    out.push({
      key: safeString(o.key, 80, ""),
      label: safeString(o.label, 120, ""),
      sliderIndex: o.sliderIndex == null ? null : Number(o.sliderIndex),
      internalTempF: o.internalTempF == null ? null : Number(o.internalTempF),
      internalTempC: o.internalTempC == null ? null : Number(o.internalTempC),
      description: safeString(o.description, 400, ""),
      tags: Array.isArray(o.tags)
        ? o.tags.map((t) => safeString(t, 80, "")).filter(Boolean)
        : [],
    });
  }
  return out.filter((o) => o.key && o.label);
}

function pillStyle(tone = "neutral") {
  const bg =
    tone === "good"
      ? "rgba(46, 204, 113, 0.18)"
      : tone === "warn"
      ? "rgba(241, 196, 15, 0.18)"
      : tone === "bad"
      ? "rgba(231, 76, 60, 0.18)"
      : "rgba(0,0,0,0.10)";
  const border =
    tone === "good"
      ? "rgba(46, 204, 113, 0.35)"
      : tone === "warn"
      ? "rgba(241, 196, 15, 0.35)"
      : tone === "bad"
      ? "rgba(231, 76, 60, 0.35)"
      : "rgba(0,0,0,0.20)";
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "2px 10px",
    borderRadius: 999,
    background: bg,
    border: `1px solid ${border}`,
    fontSize: 12,
    lineHeight: "18px",
    marginRight: 8,
    marginBottom: 6,
    whiteSpace: "nowrap",
  };
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
  help,
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 10,
        }}
      >
        <label style={{ fontWeight: 800 }}>{label}</label>
        {help ? (
          <span style={{ fontSize: 12, opacity: 0.75 }}>{help}</span>
        ) : null}
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={type}
        disabled={disabled}
        style={{
          width: "100%",
          marginTop: 6,
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid rgba(0,0,0,0.18)",
          background: "rgba(255,255,255,0.75)",
          fontFamily: "inherit",
          fontSize: 14,
          opacity: disabled ? 0.65 : 1,
        }}
      />
    </div>
  );
}

function TextArea({ label, value, onChange, placeholder, rows = 3, disabled }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ fontWeight: 800 }}>{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        style={{
          width: "100%",
          resize: "vertical",
          marginTop: 6,
          padding: 10,
          borderRadius: 10,
          border: "1px solid rgba(0,0,0,0.18)",
          background: "rgba(255,255,255,0.75)",
          fontFamily: "inherit",
          fontSize: 14,
          lineHeight: "20px",
          opacity: disabled ? 0.65 : 1,
        }}
      />
    </div>
  );
}

export default function DonenessSelector({
  value,
  options,
  mode = "dropdown",
  tempUnit = "F",
  allowTempOverride = true,
  allowNotes = true,
  disabled = false,
  context,
  resolved,
  onChange,
}) {
  const v = useMemo(() => normalizeValue(value), [value]);
  const opts = useMemo(() => normalizeOptions(options), [options]);

  const ctx = useMemo(() => {
    const c = isPlainObject(context) ? context : {};
    return {
      proteinCategory: safeLower(c.proteinCategory) || null,
      cutTag: safeLower(c.cutTag) || null,
      method: safeLower(c.method) || null,
    };
  }, [context]);

  const resolvedHint = useMemo(() => {
    const r = isPlainObject(resolved) ? resolved : null;
    const conf = clamp01(r?.confidence ?? 0.7, 0.7);
    const target = r?.target || null;
    const notes = safeString(r?.notes || "", 400, "");
    return { conf, target, notes };
  }, [resolved]);

  const sliderModel = useMemo(() => {
    // Sort by sliderIndex if provided; else natural option order.
    const base = opts.slice();
    const hasAnyIndex = base.some((o) => Number.isFinite(o.sliderIndex));
    if (hasAnyIndex)
      base.sort((a, b) => (a.sliderIndex ?? 9999) - (b.sliderIndex ?? 9999));

    const indexByKey = {};
    base.forEach((o, idx) => (indexByKey[o.key] = idx));

    // Determine current slider position:
    let currentIndex = 0;
    if (v.targetKey && indexByKey[v.targetKey] != null)
      currentIndex = indexByKey[v.targetKey];
    else if (v.targetName) {
      const hit = base.findIndex(
        (o) => safeLower(o.label) === safeLower(v.targetName)
      );
      if (hit >= 0) currentIndex = hit;
    } else if (resolvedHint?.target?.name) {
      const hit = base.findIndex(
        (o) => safeLower(o.label) === safeLower(resolvedHint.target.name)
      );
      if (hit >= 0) currentIndex = hit;
    }

    currentIndex = clampInt(currentIndex, 0, Math.max(0, base.length - 1), 0);

    return { list: base, indexByKey, currentIndex };
  }, [opts, v.targetKey, v.targetName, resolvedHint]);

  const selectedOption = useMemo(() => {
    const key = v.targetKey;
    if (key) return opts.find((o) => o.key === key) || null;
    if (v.targetName)
      return (
        opts.find((o) => safeLower(o.label) === safeLower(v.targetName)) || null
      );
    return null;
  }, [opts, v.targetKey, v.targetName]);

  function commit(next) {
    if (typeof onChange === "function") onChange(next);
  }

  function setFromOption(opt) {
    if (!opt) return;
    const next = {
      ...v,
      targetKey: opt.key,
      targetName: opt.label,
    };

    // If the option includes temps, set them (but don't wipe user overrides if already set)
    if (
      opt.internalTempF != null &&
      (v.internalTempF == null || Number.isNaN(v.internalTempF))
    )
      next.internalTempF = opt.internalTempF;
    if (
      opt.internalTempC != null &&
      (v.internalTempC == null || Number.isNaN(v.internalTempC))
    )
      next.internalTempC = opt.internalTempC;

    commit(next);
  }

  function onDropdownChange(key) {
    const opt = opts.find((o) => o.key === key) || null;
    if (!opt) {
      commit({ ...v, targetKey: "", targetName: "" });
      return;
    }
    setFromOption(opt);
  }

  function onSliderChange(idxStr) {
    const idx = clampInt(
      idxStr,
      0,
      Math.max(0, sliderModel.list.length - 1),
      0
    );
    const opt = sliderModel.list[idx] || null;
    if (!opt) return;
    setFromOption(opt);
  }

  const showTemp = allowTempOverride;
  const tempHelp =
    tempUnit === "C" ? "Enter °C (optional)" : "Enter °F (optional)";

  return (
    <div>
      {/* Context header */}
      {ctx.proteinCategory || ctx.cutTag || ctx.method ? (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>Context</div>
          <div style={{ display: "flex", flexWrap: "wrap" }}>
            {ctx.proteinCategory ? (
              <span style={pillStyle("neutral")}>
                Protein: {ctx.proteinCategory}
              </span>
            ) : null}
            {ctx.cutTag ? (
              <span style={pillStyle("neutral")}>Cut: {ctx.cutTag}</span>
            ) : null}
            {ctx.method ? (
              <span style={pillStyle("neutral")}>Method: {ctx.method}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Resolver hint */}
      {resolvedHint?.target ? (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>
            Suggested target
          </div>
          <div style={{ display: "flex", flexWrap: "wrap" }}>
            {resolvedHint.target.name ? (
              <span style={pillStyle("good")}>{resolvedHint.target.name}</span>
            ) : null}
            {resolvedHint.target.internalTempF != null ? (
              <span style={pillStyle("good")}>
                {resolvedHint.target.internalTempF}°F
              </span>
            ) : null}
            {resolvedHint.target.internalTempC != null ? (
              <span style={pillStyle("good")}>
                {resolvedHint.target.internalTempC}°C
              </span>
            ) : null}
            <span
              style={pillStyle(resolvedHint.conf >= 0.75 ? "good" : "warn")}
            >
              confidence {Math.round(resolvedHint.conf * 100)}%
            </span>
          </div>
          {resolvedHint.notes ? (
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
              {resolvedHint.notes}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Picker */}
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontWeight: 900, marginBottom: 6 }}>Doneness</div>

        {mode === "slider" && sliderModel.list.length >= 2 ? (
          <div
            style={{
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 12,
              padding: 10,
              background: "rgba(0,0,0,0.02)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
              }}
            >
              <div style={{ fontWeight: 800 }}>
                {sliderModel.list[sliderModel.currentIndex]?.label || "Select…"}
              </div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>
                {renderTempBadge(
                  sliderModel.list[sliderModel.currentIndex],
                  tempUnit
                )}
              </div>
            </div>

            <input
              type="range"
              min={0}
              max={Math.max(0, sliderModel.list.length - 1)}
              value={sliderModel.currentIndex}
              onChange={(e) => onSliderChange(e.target.value)}
              disabled={disabled}
              style={{ width: "100%", marginTop: 10 }}
              aria-label="Doneness slider"
            />

            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginTop: 8,
                fontSize: 12,
                opacity: 0.75,
              }}
            >
              <span>{sliderModel.list[0]?.label || "Low"}</span>
              <span>
                {sliderModel.list[sliderModel.list.length - 1]?.label || "High"}
              </span>
            </div>
          </div>
        ) : (
          <select
            value={v.targetKey || ""}
            onChange={(e) => onDropdownChange(e.target.value)}
            disabled={disabled}
            style={{
              width: "100%",
              padding: "10px 12px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.18)",
              background: "rgba(255,255,255,0.75)",
              fontFamily: "inherit",
              fontSize: 14,
              opacity: disabled ? 0.65 : 1,
            }}
            aria-label="Doneness dropdown"
          >
            <option value="">Auto / not set</option>
            {opts.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        )}

        {/* Selected option details */}
        {selectedOption?.description ? (
          <div style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}>
            {selectedOption.description}
          </div>
        ) : null}

        {selectedOption?.tags?.length ? (
          <div style={{ display: "flex", flexWrap: "wrap", marginTop: 6 }}>
            {selectedOption.tags.slice(0, 10).map((t) => (
              <span key={t} style={pillStyle("neutral")}>
                {t}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      {/* Override temps */}
      {showTemp ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>
            Internal temperature override
          </div>

          {tempUnit === "C" ? (
            <Input
              label="Internal temp (°C)"
              type="number"
              value={v.internalTempC == null ? "" : String(v.internalTempC)}
              onChange={(raw) =>
                commit({
                  ...v,
                  internalTempC: raw === "" ? null : Number(raw),
                  // keep F in sync if possible; do not force conversion (caller can convert)
                })
              }
              placeholder="e.g., 74"
              disabled={disabled}
              help={tempHelp}
            />
          ) : (
            <Input
              label="Internal temp (°F)"
              type="number"
              value={v.internalTempF == null ? "" : String(v.internalTempF)}
              onChange={(raw) =>
                commit({
                  ...v,
                  internalTempF: raw === "" ? null : Number(raw),
                })
              }
              placeholder="e.g., 165"
              disabled={disabled}
              help={tempHelp}
            />
          )}

          <div style={{ fontSize: 12, opacity: 0.75, marginTop: -4 }}>
            If set, SSA can show doneness/safety alerts during the cooking
            session.
          </div>
        </div>
      ) : null}

      {/* Notes */}
      {allowNotes ? (
        <div style={{ marginTop: 10 }}>
          <TextArea
            label="Notes"
            value={v.notes || ""}
            onChange={(txt) => commit({ ...v, notes: txt })}
            placeholder="Optional notes (preferences, safety, reminders)…"
            rows={3}
            disabled={disabled}
          />
        </div>
      ) : null}
    </div>
  );
}

function renderTempBadge(opt, unit) {
  if (!opt) return null;
  if (unit === "C") {
    if (opt.internalTempC != null) return <span>{opt.internalTempC}°C</span>;
    if (opt.internalTempF != null) return <span>{opt.internalTempF}°F</span>;
    return <span>—</span>;
  }
  if (opt.internalTempF != null) return <span>{opt.internalTempF}°F</span>;
  if (opt.internalTempC != null) return <span>{opt.internalTempC}°C</span>;
  return <span>—</span>;
}
