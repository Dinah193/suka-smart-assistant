/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\ui\EquipmentChecklist.jsx
//
// SSA • EquipmentChecklist
// -----------------------------------------------------------------------------
// Purpose:
//   Display and manage a required/selected tools list for an adapted recipe or
//   cooking session plan. Used by CookSetupModal to:
//     - Show "required equipment" inferred from steps/method
//     - Compare against available kitchen capabilities (optional input)
//     - Show missing items + suggested substitutions (optional input)
//     - Allow user to check/uncheck tools they will use
//     - Emit a clean "selectedEquipmentIds" list back to the modal
//
// Key design points:
//   - SSA style friendly (household.css), no Tailwind.
//   - Works even if you don't have a full catalog; you can pass a catalog map.
//   - Deterministic; no external calls.
//   - Robust normalization + safe rendering.
//
// Props:
//   requiredEquipmentIds?: string[]             // what the recipe needs
//   selectedEquipmentIds?: string[]             // what the user currently selected
//   availableEquipmentIds?: string[]            // what user has (from kitchenCaps inventory)
//   equipmentCatalog?: Record<string, {         // optional metadata for nicer labels
//     id: string,
//     label?: string,
//     category?: string,
//     aliases?: string[],
//     icon?: string,                            // emoji or short text
//   }>
//
//   substitutions?: Array<{                    // tool substitution suggestions
//     missingKey: string,
//     chosenKey: string,
//     confidence?: number,
//     friction?: number,
//     notes?: string,
//   }>
//
//   showCategories?: boolean                    // default true
//   showMissing?: boolean                       // default true
//   showAvailable?: boolean                     // default true
//   showSubstitutions?: boolean                 // default true
//   allowSelection?: boolean                    // default true
//   allowAddCustom?: boolean                    // default true
//   disabled?: boolean
//   compact?: boolean                           // default false (reduces padding)
//   header?: string
//   subheader?: string
//
//   onChangeSelected?: (nextIds: string[], meta: { added?: string[], removed?: string[], source?: string }) => void
//   onRequestAddToCapabilities?: (equipmentId: string) => void   // optional "I have this now" action
//
// -----------------------------------------------------------------------------
// Notes:
//   - It never mutates props; always emits new arrays.
//   - It treats equipment IDs as stable keys.
//   - It will include required items in selection by default if selected is empty
//     (caller can override by passing an explicit selectedEquipmentIds).
//
// No placeholders. Production-ready.

import React, { useEffect, useMemo, useRef, useState } from "react";

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeString(s, max = 200, fallback = "") {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  return t ? t.slice(0, max) : fallback;
}

function safeLower(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function clamp01(n, fallback = 0.7) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function uniq(arr) {
  return Array.from(
    new Set(
      (Array.isArray(arr) ? arr : [])
        .map((x) => safeString(String(x), 120, ""))
        .filter(Boolean)
    )
  );
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

function normalizeCatalog(equipmentCatalog) {
  const cat = isPlainObject(equipmentCatalog) ? equipmentCatalog : {};
  const out = {};
  for (const [k, v] of Object.entries(cat)) {
    const id = safeString((v && v.id) || k, 120, "");
    if (!id) continue;
    out[id] = {
      id,
      label: safeString(v?.label || id, 140, id),
      category: safeString(v?.category || "", 80, "") || "Other",
      icon: safeString(v?.icon || "", 12, ""),
      aliases: Array.isArray(v?.aliases)
        ? v.aliases.map((a) => safeString(a, 120, "")).filter(Boolean)
        : [],
    };
  }
  return out;
}

function normalizeSubstitutions(substitutions) {
  const arr = Array.isArray(substitutions) ? substitutions : [];
  const out = [];
  for (const s of arr) {
    if (!s) continue;
    const missingKey = safeString(s.missingKey || "", 120, "");
    const chosenKey = safeString(s.chosenKey || "", 120, "");
    if (!missingKey || !chosenKey) continue;
    out.push({
      missingKey,
      chosenKey,
      confidence: clamp01(s.confidence, 0.7),
      friction: clamp01(s.friction, 0.5),
      notes: safeString(s.notes || "", 500, ""),
    });
  }
  return out;
}

function labelFor(id, catalog) {
  const item = catalog?.[id];
  if (item?.label) return item.label;
  // prettify fallback
  return safeString(String(id).replace(/[_-]+/g, " "), 140, id);
}

function iconFor(id, catalog) {
  const item = catalog?.[id];
  if (item?.icon) return item.icon;
  return "";
}

function categoryFor(id, catalog) {
  const item = catalog?.[id];
  if (item?.category) return item.category;
  return "Other";
}

function groupByCategory(ids, catalog) {
  const groups = {};
  for (const id of ids) {
    const c = categoryFor(id, catalog);
    if (!groups[c]) groups[c] = [];
    groups[c].push(id);
  }
  const orderedCats = Object.keys(groups).sort((a, b) => a.localeCompare(b));
  return { groups, orderedCats };
}

function sortByLabel(ids, catalog) {
  return ids
    .slice()
    .sort((a, b) => labelFor(a, catalog).localeCompare(labelFor(b, catalog)));
}

export default function EquipmentChecklist({
  requiredEquipmentIds,
  selectedEquipmentIds,
  availableEquipmentIds,
  equipmentCatalog,
  substitutions,

  showCategories = true,
  showMissing = true,
  showAvailable = true,
  showSubstitutions = true,
  allowSelection = true,
  allowAddCustom = true,

  disabled = false,
  compact = false,

  header = "Equipment checklist",
  subheader = "Confirm the tools you’ll use. Missing items can be substituted or added to your kitchen capabilities.",

  onChangeSelected,
  onRequestAddToCapabilities,
}) {
  const catalog = useMemo(
    () => normalizeCatalog(equipmentCatalog),
    [equipmentCatalog]
  );
  const required = useMemo(
    () => uniq(requiredEquipmentIds),
    [requiredEquipmentIds]
  );
  const available = useMemo(
    () => uniq(availableEquipmentIds),
    [availableEquipmentIds]
  );
  const subs = useMemo(
    () => normalizeSubstitutions(substitutions),
    [substitutions]
  );

  // If caller didn't pass selection, default to required.
  const [internalSelected, setInternalSelected] = useState(() => {
    const initial = uniq(selectedEquipmentIds);
    return initial.length ? initial : required;
  });

  // Sync internal selection when prop changes (controlled/uncontrolled hybrid)
  const prevSelectedProp = useRef(null);
  useEffect(() => {
    const prop = uniq(selectedEquipmentIds);
    const prev = prevSelectedProp.current;
    const same =
      prev &&
      prop.length === prev.length &&
      prop.every((x, i) => x === prev[i]);

    prevSelectedProp.current = prop;

    if (selectedEquipmentIds != null && !same) {
      setInternalSelected(prop.length ? prop : required);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEquipmentIds]);

  // Ensure required are always visible even if not selected
  const selected = internalSelected;

  const missingRequired = useMemo(() => {
    if (!showMissing) return [];
    const availSet = new Set(available);
    return required.filter((id) => !availSet.has(id));
  }, [required, available, showMissing]);

  const satisfiedRequired = useMemo(() => {
    const availSet = new Set(available);
    return required.filter((id) => availSet.has(id));
  }, [required, available]);

  const allDisplayIds = useMemo(() => {
    // We display required + selected + (optional) available-only (if showAvailable)
    const base = new Set([...required, ...selected]);
    if (showAvailable) {
      for (const id of available) base.add(id);
    }
    return Array.from(base);
  }, [required, selected, available, showAvailable]);

  const categorized = useMemo(() => {
    const ids = sortByLabel(allDisplayIds, catalog);
    return groupByCategory(ids, catalog);
  }, [allDisplayIds, catalog]);

  const counts = useMemo(() => {
    const selectedSet = new Set(selected);
    const requiredSet = new Set(required);
    const availableSet = new Set(available);
    return {
      required: required.length,
      selected: selected.length,
      missingRequired: missingRequired.length,
      satisfiedRequired: satisfiedRequired.length,
      selectedMissing: selected.filter((id) => !availableSet.has(id)).length,
      requiredSelected: selected.filter((id) => requiredSet.has(id)).length,
    };
  }, [required, selected, available, missingRequired, satisfiedRequired]);

  const [customId, setCustomId] = useState("");

  function emitChange(next, meta) {
    if (typeof onChangeSelected === "function")
      onChangeSelected(next, meta || {});
  }

  function toggle(id) {
    if (!allowSelection || disabled) return;
    const set = new Set(selected);
    const had = set.has(id);
    if (had) set.delete(id);
    else set.add(id);

    const next = Array.from(set);
    setInternalSelected(next);
    emitChange(next, {
      added: had ? [] : [id],
      removed: had ? [id] : [],
      source: "toggle",
    });
  }

  function selectAllRequired() {
    if (!allowSelection || disabled) return;
    const set = new Set(selected);
    const before = new Set(selected);
    for (const id of required) set.add(id);
    const next = Array.from(set);
    setInternalSelected(next);

    const added = next.filter((x) => !before.has(x));
    emitChange(next, { added, removed: [], source: "select_all_required" });
  }

  function clearNonRequired() {
    if (!allowSelection || disabled) return;
    const reqSet = new Set(required);
    const next = selected.filter((id) => reqSet.has(id));
    const removed = selected.filter((id) => !reqSet.has(id));
    setInternalSelected(next);
    emitChange(next, { added: [], removed, source: "clear_non_required" });
  }

  function applySubstitution(missingKey, chosenKey) {
    if (!allowSelection || disabled) return;
    const set = new Set(selected);
    const removed = [];
    const added = [];

    if (set.has(missingKey)) {
      set.delete(missingKey);
      removed.push(missingKey);
    }
    if (!set.has(chosenKey)) {
      set.add(chosenKey);
      added.push(chosenKey);
    }

    const next = Array.from(set);
    setInternalSelected(next);
    emitChange(next, { added, removed, source: "apply_substitution" });
  }

  function addCustom() {
    if (!allowAddCustom || disabled) return;
    const id = safeLower(customId).replace(/\s+/g, "_");
    if (!id) return;

    // Add to selection
    const set = new Set(selected);
    if (!set.has(id)) set.add(id);
    const next = Array.from(set);

    setInternalSelected(next);
    emitChange(next, { added: [id], removed: [], source: "add_custom" });

    // Optional: notify parent to persist into kitchen capabilities
    if (typeof onRequestAddToCapabilities === "function") {
      try {
        onRequestAddToCapabilities(id);
      } catch (e) {
        console.warn(
          "[EquipmentChecklist] onRequestAddToCapabilities failed",
          e
        );
      }
    }

    setCustomId("");
  }

  const pad = compact ? 8 : 12;

  return (
    <div
      style={{
        border: "1px solid rgba(0,0,0,0.12)",
        borderRadius: 14,
        padding: pad,
        background: "rgba(0,0,0,0.02)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 12,
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ fontWeight: 900 }}>{header}</div>
          {subheader ? (
            <div style={{ fontSize: 13, opacity: 0.8, marginTop: 2 }}>
              {subheader}
            </div>
          ) : null}
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          <span style={pillStyle("neutral")}>required {counts.required}</span>
          <span style={pillStyle("neutral")}>selected {counts.selected}</span>
          {showMissing ? (
            <span style={pillStyle(counts.missingRequired ? "warn" : "good")}>
              missing {counts.missingRequired}
            </span>
          ) : null}
          {showAvailable ? (
            <span style={pillStyle("neutral")}>
              available {available.length}
            </span>
          ) : null}
        </div>
      </div>

      {/* Quick actions */}
      {allowSelection ? (
        <div
          style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}
        >
          <button
            type="button"
            onClick={selectAllRequired}
            disabled={disabled}
            className="sv-btn"
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.18)",
              background: "rgba(52, 152, 219, 0.12)",
              cursor: disabled ? "not-allowed" : "pointer",
              fontWeight: 800,
              opacity: disabled ? 0.65 : 1,
            }}
          >
            Select required
          </button>

          <button
            type="button"
            onClick={clearNonRequired}
            disabled={disabled}
            className="sv-btn"
            style={{
              padding: "8px 10px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.18)",
              background: "rgba(0,0,0,0.05)",
              cursor: disabled ? "not-allowed" : "pointer",
              fontWeight: 800,
              opacity: disabled ? 0.65 : 1,
            }}
          >
            Clear extras
          </button>
        </div>
      ) : null}

      {/* Missing + substitutions */}
      {showMissing && missingRequired.length ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>
            Missing required tools
          </div>
          <div style={{ display: "flex", flexWrap: "wrap" }}>
            {missingRequired.slice(0, 14).map((id) => (
              <span key={id} style={pillStyle("warn")}>
                {labelFor(id, catalog)}
              </span>
            ))}
          </div>

          {showSubstitutions && subs.length ? (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 900, marginBottom: 6 }}>
                Suggested substitutions
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {subs.slice(0, 10).map((s, idx) => (
                  <div
                    key={`${s.missingKey}_${s.chosenKey}_${idx}`}
                    style={{
                      border: "1px solid rgba(0,0,0,0.10)",
                      borderRadius: 12,
                      padding: 10,
                      background: "rgba(255,255,255,0.6)",
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ minWidth: 220 }}>
                      <div style={{ fontWeight: 900 }}>
                        {labelFor(s.missingKey, catalog)} →{" "}
                        {labelFor(s.chosenKey, catalog)}
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.8 }}>
                        confidence {Math.round((s.confidence ?? 0.7) * 100)}% •
                        friction {Math.round((s.friction ?? 0.5) * 100)}%
                      </div>
                      {s.notes ? (
                        <div
                          style={{ fontSize: 12, opacity: 0.8, marginTop: 4 }}
                        >
                          {s.notes}
                        </div>
                      ) : null}
                    </div>

                    {allowSelection ? (
                      <button
                        type="button"
                        onClick={() =>
                          applySubstitution(s.missingKey, s.chosenKey)
                        }
                        disabled={disabled}
                        className="sv-btn"
                        style={{
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: "1px solid rgba(0,0,0,0.18)",
                          background: "rgba(52, 152, 219, 0.12)",
                          cursor: disabled ? "not-allowed" : "pointer",
                          fontWeight: 900,
                          opacity: disabled ? 0.65 : 1,
                        }}
                      >
                        Apply
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Add custom tool */}
      {allowAddCustom ? (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 900, marginBottom: 6 }}>Add a tool</div>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              flexWrap: "wrap",
            }}
          >
            <input
              value={customId}
              onChange={(e) => setCustomId(e.target.value)}
              placeholder="e.g., cast_iron_skillet"
              disabled={disabled}
              style={{
                flex: "1 1 240px",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,0.18)",
                background: "rgba(255,255,255,0.75)",
                fontFamily: "inherit",
                fontSize: 14,
                opacity: disabled ? 0.65 : 1,
              }}
              aria-label="Add equipment id"
            />
            <button
              type="button"
              onClick={addCustom}
              disabled={disabled || !safeString(customId, 200, "")}
              className="sv-btn"
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,0.18)",
                background: "rgba(0,0,0,0.05)",
                cursor: disabled ? "not-allowed" : "pointer",
                fontWeight: 900,
                opacity: disabled || !safeString(customId, 200, "") ? 0.6 : 1,
              }}
            >
              Add
            </button>
          </div>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6 }}>
            Use snake_case IDs. If you hook this to kitchen capabilities, you
            can add tools permanently.
          </div>
        </div>
      ) : null}

      {/* Checklist */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontWeight: 900, marginBottom: 8 }}>Tools</div>

        {showCategories ? (
          categorized.orderedCats.map((catName) => (
            <CategoryBlock
              key={catName}
              category={catName}
              ids={categorized.groups[catName] || []}
              catalog={catalog}
              required={required}
              selected={selected}
              available={available}
              allowSelection={allowSelection}
              disabled={disabled}
              onToggle={toggle}
              onRequestAddToCapabilities={onRequestAddToCapabilities}
              showAvailable={showAvailable}
              compact={compact}
            />
          ))
        ) : (
          <CategoryBlock
            category=""
            ids={sortByLabel(allDisplayIds, catalog)}
            catalog={catalog}
            required={required}
            selected={selected}
            available={available}
            allowSelection={allowSelection}
            disabled={disabled}
            onToggle={toggle}
            onRequestAddToCapabilities={onRequestAddToCapabilities}
            showAvailable={showAvailable}
            compact={compact}
          />
        )}
      </div>
    </div>
  );
}

function CategoryBlock({
  category,
  ids,
  catalog,
  required,
  selected,
  available,
  allowSelection,
  disabled,
  onToggle,
  onRequestAddToCapabilities,
  showAvailable,
  compact,
}) {
  const reqSet = useMemo(() => new Set(required), [required]);
  const selSet = useMemo(() => new Set(selected), [selected]);
  const availSet = useMemo(() => new Set(available), [available]);

  const pad = compact ? 8 : 10;

  if (!ids.length) return null;

  return (
    <div style={{ marginBottom: 12 }}>
      {category ? (
        <div style={{ fontWeight: 900, marginBottom: 6, opacity: 0.9 }}>
          {category}
        </div>
      ) : null}

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {ids.map((id) => {
          const isReq = reqSet.has(id);
          const isSel = selSet.has(id);
          const isAvail = availSet.has(id);

          const tone =
            isReq && !isAvail
              ? "warn"
              : isReq && isAvail
              ? "good"
              : isAvail
              ? "neutral"
              : "neutral";

          return (
            <div
              key={id}
              style={{
                border: "1px solid rgba(0,0,0,0.10)",
                borderRadius: 12,
                padding: pad,
                background: "rgba(255,255,255,0.60)",
                display: "flex",
                justifyContent: "space-between",
                gap: 10,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <label
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  cursor: allowSelection && !disabled ? "pointer" : "default",
                }}
              >
                {allowSelection ? (
                  <input
                    type="checkbox"
                    checked={isSel}
                    onChange={() => onToggle(id)}
                    disabled={disabled}
                    style={{ transform: "scale(1.05)" }}
                    aria-label={`Select ${labelFor(id, catalog)}`}
                  />
                ) : (
                  <span aria-hidden="true">{isSel ? "✅" : "▫️"}</span>
                )}

                <div>
                  <div
                    style={{
                      fontWeight: 900,
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    {iconFor(id, catalog) ? (
                      <span aria-hidden="true">{iconFor(id, catalog)}</span>
                    ) : null}
                    <span>{labelFor(id, catalog)}</span>
                  </div>

                  <div
                    style={{ display: "flex", flexWrap: "wrap", marginTop: 4 }}
                  >
                    {isReq ? (
                      <span style={pillStyle(tone)}>
                        {isAvail ? "required" : "required (missing)"}
                      </span>
                    ) : null}
                    {showAvailable ? (
                      <span style={pillStyle(isAvail ? "good" : "neutral")}>
                        {isAvail ? "available" : "not in kitchen"}
                      </span>
                    ) : null}
                    {!isReq && isSel ? (
                      <span style={pillStyle("neutral")}>selected</span>
                    ) : null}
                  </div>
                </div>
              </label>

              {!isAvail && typeof onRequestAddToCapabilities === "function" ? (
                <button
                  type="button"
                  onClick={() => onRequestAddToCapabilities(id)}
                  disabled={disabled}
                  className="sv-btn"
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid rgba(0,0,0,0.18)",
                    background: "rgba(0,0,0,0.05)",
                    cursor: disabled ? "not-allowed" : "pointer",
                    fontWeight: 900,
                    opacity: disabled ? 0.65 : 1,
                  }}
                  title="Add this tool to your kitchen capabilities"
                >
                  I have this
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
