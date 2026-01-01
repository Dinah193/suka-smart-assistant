// src/components/home/HouseholdProfile.jsx
import React, { useEffect, useMemo, useState } from "react";
import { useVision } from "@/context/VisionContext";
import WeeklyFlavorRhythmPicker from "@/components/profile/WeeklyFlavorRhythmPicker";

/* ---------------------------------- data ---------------------------------- */
let suggestFlavorOptions;
try {
  // eslint-disable-next-line import/no-unresolved
  ({ suggestFlavorOptions } = require("@/types/FlavorRhythm.d"));
} catch {
  suggestFlavorOptions = () => [
    "Soul Food",
    "Caribbean",
    "West African",
    "Cajun",
    "Creole",
    "Mediterranean",
    "BBQ",
    "Herb-Garlic",
    "Citrus-Chili",
    "Asian Fusion",
    "Tex-Mex",
    "Nigerian",
    "Ghanaian",
    "Ethiopian",
    "Levantine",
    "Indian",
    "Thai",
    "Korean",
    "Japanese Home",
    "Simple Comfort",
    "Low-Sugar",
    "High-Protein",
    "Garden-Fresh",
    "Pantry-First",
  ];
}

/* legacy week helpers (for summary/completion only) */
const GREG = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const CREATION = ["day_one", "day_two", "day_three", "day_four", "day_five", "day_six", "sabbath"];
function rhythmToGregorianView(rhythm) {
  const r = rhythm && typeof rhythm === "object" ? rhythm : {};
  const looksGregorian = GREG.some((k) => Array.isArray(r[k]));
  const out = {};
  if (looksGregorian) {
    GREG.forEach((k) => (out[k] = Array.isArray(r[k]) ? r[k] : []));
    return out;
  }
  GREG.forEach((gKey, i) => (out[gKey] = Array.isArray(r[CREATION[i]]) ? r[CREATION[i]] : []));
  return out;
}

const arraysEqual = (a = [], b = []) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => String(x) === String(b[i]));
const join = (arr) => (Array.isArray(arr) && arr.length ? arr.join(", ") : "");

/* --------------------------------- atoms ---------------------------------- */
function MultiSelectWithCustom({
  value = [],
  onChange,
  options = [],
  placeholder = "Choose…",
  name,
  customType = "text",
  textareaRows = 3,
}) {
  const [custom, setCustom] = useState("");
  const add = (v) => {
    const val = (v || "").trim();
    if (!val) return;
    if ((value || []).includes(val)) return;
    onChange([...(value || []), val]);
  };
  const remove = (v) => onChange((value || []).filter((x) => x !== v));
  const handleSelect = (e) => {
    const v = e.target.value;
    if (!v) return;
    if (v !== "__custom__") {
      add(v);
      e.target.value = "";
    }
  };

  return (
    <div className="field-stack w-full">
      <div className="field-input">
        <div className="relative">
          <select
            className="control control--select"
            defaultValue=""
            onChange={handleSelect}
            name={name ? `${name}-picker` : undefined}
          >
            <option value="">{placeholder}</option>
            {options.map((opt) => (
              <option key={String(opt)} value={opt}>
                {opt}
              </option>
            ))}
            <option value="__custom__">Custom… (use field below)</option>
          </select>
          <span
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]"
            aria-hidden
          >
            ▾
          </span>
        </div>
      </div>

      <div className="field-selected stack-sm">
        <div className="chips">
          {(value || []).length ? (
            (value || []).map((v) => (
              <span key={v} className="chip">
                {v}
                <button type="button" className="x" onClick={() => remove(v)} aria-label={`Remove ${v}`} title="Remove">
                  ×
                </button>
              </span>
            ))
          ) : (
            <span className="text-sm text-[hsl(var(--muted-foreground))]">No selections yet.</span>
          )}
        </div>

        <div className="flex items-start gap-2">
          {customType === "textarea" ? (
            <textarea
              className="control control--textarea"
              rows={textareaRows}
              placeholder="Enter custom value…"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              name={name ? `${name}-custom` : undefined}
            />
          ) : (
            <input
              className="control"
              placeholder="Enter custom value…"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              name={name ? `${name}-custom` : undefined}
            />
          )}
          <button
            type="button"
            className="btn subtle"
            onClick={() => {
              add(custom);
              setCustom("");
            }}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function SelectWithCustom({ value, onChange, options = [], placeholder = "Choose…", name }) {
  const isCustom = value && typeof value === "object" && value.kind === "custom";
  const currentVal = isCustom ? "__custom__" : value ?? "";
  return (
    <div className="field-stack w-full">
      <div className="field-input">
        <div className="relative">
          <select
            className="control control--select"
            value={currentVal}
            onChange={(e) =>
              e.target.value === "__custom__" ? onChange({ kind: "custom", value: "" }) : onChange(e.target.value)
            }
            name={name}
          >
            <option value="">{placeholder}</option>
            {options.map((opt) => (
              <option key={String(opt)} value={opt}>
                {opt}
              </option>
            ))}
            <option value="__custom__">Custom…</option>
          </select>
          <span
            className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))]"
            aria-hidden
          >
            ▾
          </span>
        </div>
      </div>
      {isCustom && (
        <div className="field-selected">
          <input
            className="control"
            placeholder="Enter custom value…"
            value={value.value}
            onChange={(e) => onChange({ kind: "custom", value: e.target.value })}
            name={name ? `${name}-custom` : undefined}
          />
        </div>
      )}
    </div>
  );
}

/* Raised tile — accepts style for fixed width */
function HpTile({ label, summary, open, onToggle, children, className = "", style }) {
  return (
    <div
      className={`rounded-2xl border bg-white shadow-md ring-1 ring-black/5 overflow-hidden transition-shadow hover:shadow-lg ${className}`}
      style={style}
    >
      <button
        type="button"
        className="btn subtle w-full flex items-center justify-between !py-3"
        onClick={onToggle}
        aria-expanded={open}
        title={open ? "Collapse" : "Expand"}
      >
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-xl bg-[hsl(var(--brand)/0.08)] grid place-items-center text-[hsl(var(--brand))] text-xs font-bold">
            {label
              .split(" ")
              .map((w) => w[0])
              .join("")
              .slice(0, 3)}
          </div>
          <div className="text-left">
            <div className="text-[11px] uppercase tracking-wide opacity-90">{label}</div>
            <div className={`text-sm font-semibold ${summary ? "" : "italic opacity-80"}`}>
              {summary || "Not set yet — click to add"}
            </div>
          </div>
        </div>
        <span aria-hidden className="ml-3">{open ? "▴" : "▾"}</span>
      </button>
      {open && <div className="border-t p-4">{children}</div>}
    </div>
  );
}

/* --------------------------------- main ----------------------------------- */
export default function HouseholdProfile() {
  const { options, setOptions, key: presetKey, presets } = useVision();
  const o = options || {};

  useEffect(() => {
    if (typeof o.hpCollapsed === "undefined") setOptions((prev) => ({ ...(prev || {}), hpCollapsed: true }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const syncFromHash = () => {
      const h = (window.location.hash || "").toLowerCase();
      if (h.includes("open-hp")) setOptions((p) => ({ ...(p || {}), hpCollapsed: false }));
      if (h.includes("close-hp")) setOptions((p) => ({ ...(p || {}), hpCollapsed: true }));
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [setOptions]);

  const collapsed = o.hpCollapsed ?? true;
  const setCollapsed = (v) => setOptions((p) => ({ ...(p || {}), hpCollapsed: v }));

  const [form, setForm] = useState(() => ({
    mode: o.mode ?? [],
    goals: o.goals ?? [],
    constraints: o.constraints ?? [],
    dietary: o.dietary ?? [],
    weeklyHrs: o.weeklyHrs ?? "",
    budget: o.budget ?? "",
    weeklyFlavorRhythm: o.weeklyFlavorRhythm ?? {}, // now supports pool shape
  }));
  useEffect(() => {
    setForm({
      mode: o.mode ?? [],
      goals: o.goals ?? [],
      constraints: o.constraints ?? [],
      dietary: o.dietary ?? [],
      weeklyHrs: o.weeklyHrs ?? "",
      budget: o.budget ?? "",
      weeklyFlavorRhythm: o.weeklyFlavorRhythm ?? {},
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.mode, o.goals, o.constraints, o.dietary, o.weeklyHrs, o.budget, o.weeklyFlavorRhythm]);

  const flavorOptions = useMemo(() => {
    try {
      return suggestFlavorOptions({
        presetKey,
        vision: { mode: o.mode, goals: o.goals, constraints: o.constraints, dietary: o.dietary },
        presets,
      }).slice(0, 24);
    } catch {
      return suggestFlavorOptions();
    }
  }, [presetKey, presets, o.mode, o.goals, o.constraints, o.dietary]);

  const fmtMaybeCustom = (v, suffix = "") =>
    !v && v !== 0
      ? "—"
      : typeof v === "object" && v.kind === "custom"
      ? v.value
        ? `${v.value}${suffix}`
        : "—"
      : `${v}${suffix}`;

  /* ----------------------------- progress & dirty ---------------------------- */
  const hasFlavorRhythm = useMemo(() => {
    const v = o.weeklyFlavorRhythm ?? form.weeklyFlavorRhythm ?? {};
    if (v && typeof v === "object" && ("pool" in v || "varietyPerWeek" in v)) {
      return Object.keys(v.pool || {}).length > 0;
    }
    const r = rhythmToGregorianView(v);
    return Object.values(r).some((arr) => (arr || []).length);
  }, [o.weeklyFlavorRhythm, form.weeklyFlavorRhythm]);

  const completion = useMemo(() => {
    let pts = 0;
    if ((o.mode || form.mode).length) pts++;
    if ((o.goals || form.goals).length) pts++;
    if ((o.constraints || form.constraints).length) pts++;
    if ((o.dietary || form.dietary).length) pts++;
    if (o.weeklyHrs || form.weeklyHrs) pts++;
    if (o.budget || form.budget) pts++;
    if (hasFlavorRhythm) pts++;
    return Math.round((pts / 7) * 100);
  }, [o, form, hasFlavorRhythm]);

  // Dirty: compare raw JSON so both pool + week shapes are supported
  const dirty =
    !arraysEqual(form.mode, o.mode ?? []) ||
    !arraysEqual(form.goals, o.goals ?? []) ||
    !arraysEqual(form.constraints, o.constraints ?? []) ||
    !arraysEqual(form.dietary, o.dietary ?? []) ||
    JSON.stringify(form.weeklyHrs) !== JSON.stringify(o.weeklyHrs ?? "") ||
    JSON.stringify(form.budget) !== JSON.stringify(o.budget ?? "") ||
    JSON.stringify(form.weeklyFlavorRhythm ?? {}) !== JSON.stringify(o.weeklyFlavorRhythm ?? {});

  const saveVision = () => {
    setOptions((prev) => ({ ...(prev || {}), ...form }));
    window.dispatchEvent(new CustomEvent("vision:updated", { detail: { ...form } }));
  };

  useEffect(() => {
    const onKey = (e) => {
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) saveVision();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, form]);

  /* --------------------------- rhythm summary text --------------------------- */
  const rhythmSummary = useMemo(() => {
    const v = o.weeklyFlavorRhythm ?? form.weeklyFlavorRhythm ?? {};
    if (v && typeof v === "object" && ("pool" in v || "varietyPerWeek" in v)) {
      const count = Object.keys(v.pool || {}).length;
      if (!count) return "";
      const varPer = v.varietyPerWeek ?? 5;
      return `${count} cuisines • variety ${varPer}/wk`;
    }
    const r = rhythmToGregorianView(v);
    const daysWith = GREG.filter((k) => (r[k] || []).length > 0).length;
    if (!daysWith) return "";
    return daysWith === 7 ? "Set for all 7 days" : `Set for ${daysWith} day${daysWith === 1 ? "" : "s"}`;
  }, [o.weeklyFlavorRhythm, form.weeklyFlavorRhythm]);

  const [openTile, setOpenTile] = useState(null);
  const toggle = (key) => setOpenTile((k) => (k === key ? null : key));

  /* ---------------------------------- UI ----------------------------------- */
  return (
    <div className="w-full">
      {/* Header */}
      <div className="rounded-2xl border bg-white shadow-md ring-1 ring-black/5 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3 p-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="btn primary"
              onClick={() => setCollapsed(!collapsed)}
              aria-expanded={!collapsed}
              title={collapsed ? "Expand" : "Collapse"}
            >
              {collapsed ? "Open" : "Close"} Household Profile
            </button>

            <div className="hidden sm:flex items-center gap-2 text-sm">
              <span className="text-stone-500">Completion</span>
              <div className="w-28 h-2 bg-stone-200 rounded-full overflow-hidden" aria-hidden>
                <div className="h-full bg-[hsl(var(--brand))] transition-all" style={{ width: `${completion}%` }} />
              </div>
              <span className="font-semibold tabular-nums">{completion}%</span>
            </div>
          </div>

          {collapsed ? (
            <button type="button" className="btn subtle" onClick={() => setCollapsed(false)} title="Open full editor">
              Open full editor
            </button>
          ) : (
            <button className="btn primary" onClick={saveVision} disabled={!dirty} aria-disabled={!dirty} title="Save (Ctrl+S)">
              Save
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="mx-auto max-w-[1600px] px-2">
          {/* HORIZONTAL ROW (scrollable) */}
          <div style={{ overflowX: "auto", paddingBottom: 8 }}>
            <div style={{ display: "flex", gap: 16, paddingRight: 16 }}>
              <HpTile
                label="Household Profile"
                summary={join(o.mode ?? form.mode ?? [])}
                open={openTile === "mode"}
                onToggle={() => toggle("mode")}
                className="snap-start"
                style={{ width: 340, flex: "0 0 auto" }}
              >
                <MultiSelectWithCustom
                  value={form.mode}
                  onChange={(v) => setForm((p) => ({ ...p, mode: v }))}
                  options={[
                    "Balanced Hybrid",
                    "Pantry-First",
                    "Garden-Heavy",
                    "Takeout-Light (prep focused)",
                    "Batch-Cooking Focus",
                  ]}
                  placeholder="Choose one or more…"
                  name="household-profile"
                />
              </HpTile>

              <HpTile
                label="Goals / Vision"
                summary={join(o.goals ?? form.goals ?? [])}
                open={openTile === "goals"}
                onToggle={() => toggle("goals")}
                className="snap-start"
                style={{ width: 340, flex: "0 0 auto" }}
              >
                <MultiSelectWithCustom
                  value={form.goals}
                  onChange={(v) => setForm((p) => ({ ...p, goals: v }))}
                  options={[
                    "Cook 5 nights; dehydrate garden surplus weekly; keep cleaning ≤ 90 min.",
                    "Batch cook 2×/wk; freeze meals; keep weekdays light.",
                    "Low-sugar, high-protein; quick breakfasts.",
                    "Observe rhythm-based meal cycles.",
                  ]}
                  placeholder="Choose goals or add custom…"
                  customType="textarea"
                  textareaRows={3}
                  name="goals"
                />
              </HpTile>

              <HpTile
                label="Constraints"
                summary={join(o.constraints ?? form.constraints ?? [])}
                open={openTile === "constraints"}
                onToggle={() => toggle("constraints")}
                className="snap-start"
                style={{ width: 340, flex: "0 0 auto" }}
              >
                <MultiSelectWithCustom
                  value={form.constraints}
                  onChange={(v) => setForm((p) => ({ ...p, constraints: v }))}
                  options={[
                    "Small kitchen, 2 burners only",
                    "School nights (no timers past 8pm)",
                    "Allergy: gluten-free",
                    "Minimal dishes; 1 pan preferred",
                  ]}
                  placeholder="Choose constraints or add custom…"
                  customType="textarea"
                  textareaRows={2}
                  name="constraints"
                />
              </HpTile>

              <HpTile
                label="Dietary Notes"
                summary={join(o.dietary ?? form.dietary ?? [])}
                open={openTile === "dietary"}
                onToggle={() => toggle("dietary")}
                className="snap-start"
                style={{ width: 340, flex: "0 0 auto" }}
              >
                <MultiSelectWithCustom
                  value={form.dietary}
                  onChange={(v) => setForm((p) => ({ ...p, dietary: v }))}
                  options={[
                    "Torah Dietary Compliant",
                    "Halal",
                    "Low Sugar",
                    "Gluten Free",
                    "Dairy Free",
                    "Nut Free",
                    "No Pork",
                    "Vegan",
                  ]}
                  placeholder="Choose dietary notes or add custom…"
                  name="dietary"
                />
              </HpTile>

              <HpTile
                label="Weekly Time Budget"
                summary={fmtMaybeCustom(o.weeklyHrs ?? form.weeklyHrs, " hrs")}
                open={openTile === "hours"}
                onToggle={() => toggle("hours")}
                className="snap-start"
                style={{ width: 340, flex: "0 0 auto" }}
              >
                <SelectWithCustom
                  value={form.weeklyHrs}
                  onChange={(v) => setForm((p) => ({ ...p, weeklyHrs: v }))}
                  options={["0", "1", "2", "3", "4", "5", "7", "10", "12", "15", "20"]}
                  placeholder="Choose hours or Custom…"
                  name="weekly-hours"
                />
              </HpTile>

              <HpTile
                label="Budget"
                summary={fmtMaybeCustom(o.budget ?? form.budget)}
                open={openTile === "budget"}
                onToggle={() => toggle("budget")}
                className="snap-start"
                style={{ width: 340, flex: "0 0 auto" }}
              >
                <SelectWithCustom
                  value={form.budget}
                  onChange={(v) => setForm((p) => ({ ...p, budget: v }))}
                  options={["$80", "$100", "$120", "$160", "$200", "$250", "$300"]}
                  placeholder="Choose a budget or Custom…"
                  name="budget"
                />
              </HpTile>

              {/* -------------------- NEW: Pool-based Weekly Flavor Rhythm -------------------- */}
              <HpTile
                label="Weekly Flavor Rhythm"
                summary={rhythmSummary}
                open={openTile === "rhythm"}
                onToggle={() => toggle("rhythm")}
                className="snap-start"
                style={{ width: 640, flex: "0 0 auto" }}
              >
                <WeeklyFlavorRhythmPicker
                  value={form.weeklyFlavorRhythm}
                  onChange={(next) => setForm((p) => ({ ...p, weeklyFlavorRhythm: next }))}
                  options={flavorOptions}
                  layout="pool"            // ← force pool view (no weekdays)
                  showAgentButtons={true}
                  allowCustom={true}
                />
              </HpTile>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
