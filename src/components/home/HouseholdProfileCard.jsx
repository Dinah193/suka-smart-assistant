// src/components/home/HouseholdProfileCard.jsx
import React from "react";
import SectionCard from "@/components/ui/SectionCard";
import { useVision } from "@/context/VisionContext";

/* ------------------------------- Small helpers ------------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");
const isObjCustom = (v) => v && typeof v === "object" && v.kind === "custom";
const fmt = (v) => {
  if (Array.isArray(v)) return v.length ? v.join(", ") : "—";
  if (isObjCustom(v)) return v.value || "—";
  return v || "—";
};
const arraysEqual = (a = [], b = []) =>
  Array.isArray(a) &&
  Array.isArray(b) &&
  a.length === b.length &&
  a.every((x, i) => String(x) === String(b[i]));

/* ------------------------------- Inputs (scoped) ----------------------------- */
function FieldRow({ label, children, className = "" }) {
  return (
    <label className={cx("flex flex-col gap-2 w-full", className)}>
      <span className="text-lg md:text-xl font-semibold text-stone-800">{label}</span>
      {children}
    </label>
  );
}

/* Multi-select + Custom (chips below input) */
function MultiSelectWithCustom({
  value = [],
  onChange,
  options = [],
  placeholder = "Choose…",
  customType = "text",
  textareaRows = 3,
  name,
}) {
  const [custom, setCustom] = React.useState("");
  const add = (v) => {
    const val = String(v || "").trim();
    if (!val) return;
    if ((value || []).includes(val)) return;
    onChange([...(value || []), val]);
  };
  const remove = (v) => onChange((value || []).filter((x) => x !== v));
  const handleSelect = (e) => {
    const v = e.target.value;
    if (v && v !== "__custom__") {
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
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-stone-500" aria-hidden>
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
                <button
                  type="button"
                  className="x"
                  onClick={() => remove(v)}
                  aria-label={`Remove ${v}`}
                  title="Remove"
                >
                  ×
                </button>
              </span>
            ))
          ) : (
            <span className="text-sm text-stone-500">No selections yet.</span>
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

/* Select + Custom (custom field below input) */
function SelectWithCustom({ value, onChange, options = [], placeholder = "Choose…", name }) {
  const isCustom = isObjCustom(value);
  const currentVal = isCustom ? "__custom__" : value ?? "";
  const handleSelect = (e) => {
    const v = e.target.value;
    if (v === "__custom__") onChange({ kind: "custom", value: "" });
    else onChange(v);
  };
  return (
    <div className="field-stack w-full">
      <div className="field-input">
        <div className="relative">
          <select
            className="control control--select"
            value={currentVal}
            onChange={handleSelect}
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
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-stone-500" aria-hidden>
            ▾
          </span>
        </div>
      </div>

      <div className="field-selected">
        {isCustom && (
          <input
            className="control"
            placeholder="Enter custom value…"
            value={value.value}
            onChange={(e) => onChange({ kind: "custom", value: e.target.value })}
            name={name ? `${name}-custom` : undefined}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------ Main component ----------------------------- */
export default function HouseholdProfileCard({ className = "" }) {
  const { options, setOptions } = useVision();
  const saved = options || {};
  const collapsed = !!saved.collapsedHome;

  // Local editable snapshot so we can track dirty vs saved
  const [form, setForm] = React.useState(() => ({
    mode: saved.mode ?? [],
    goals: saved.goals ?? [],
    constraints: saved.constraints ?? [],
    dietary: saved.dietary ?? [],
    weeklyHrs: saved.weeklyHrs ?? "",
    budget: saved.budget ?? "",
  }));

  // Re-hydrate local state if context changes externally (e.g., demo loader)
  React.useEffect(() => {
    setForm({
      mode: saved.mode ?? [],
      goals: saved.goals ?? [],
      constraints: saved.constraints ?? [],
      dietary: saved.dietary ?? [],
      weeklyHrs: saved.weeklyHrs ?? "",
      budget: saved.budget ?? "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.mode, saved.goals, saved.constraints, saved.dietary, saved.weeklyHrs, saved.budget]);

  const update = (partial) =>
    setForm((prev) => ({ ...prev, ...(typeof partial === "function" ? partial(prev) : partial) }));

  const dirty =
    !arraysEqual(form.mode, saved.mode ?? []) ||
    !arraysEqual(form.goals, saved.goals ?? []) ||
    !arraysEqual(form.constraints, saved.constraints ?? []) ||
    !arraysEqual(form.dietary, saved.dietary ?? []) ||
    JSON.stringify(form.weeklyHrs) !== JSON.stringify(saved.weeklyHrs ?? "") ||
    JSON.stringify(form.budget) !== JSON.stringify(saved.budget ?? "");

  // Completion score (simple 6-field measure)
  const completion = React.useMemo(() => {
    let pts = 0;
    if ((form.mode || []).length) pts++;
    if ((form.goals || []).length) pts++;
    if ((form.constraints || []).length) pts++;
    if ((form.dietary || []).length) pts++;
    if (form.weeklyHrs && (typeof form.weeklyHrs === "string" || isObjCustom(form.weeklyHrs))) pts++;
    if (form.budget && (typeof form.budget === "string" || isObjCustom(form.budget))) pts++;
    return Math.round((pts / 6) * 100);
  }, [form]);

  // Save + collapse (emits global event for onboarding)
  function saveAndCollapse() {
    setOptions((prev) => ({ ...(prev || {}), ...form, collapsedHome: true }));
    window.dispatchEvent(new CustomEvent("vision:updated"));
  }
  function uncollapse() {
    setOptions((prev) => ({ ...(prev || {}), collapsedHome: false }));
  }

  // Ctrl/Cmd+S to save
  React.useEffect(() => {
    const onKey = (e) => {
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) saveAndCollapse();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty]);

  /* Presets — aligned with earlier chats */
  const modeOptions = [
    "Balanced Hybrid",
    "Pantry-First",
    "Garden-Heavy",
    "Takeout-Light (prep focused)",
    "Batch-Cooking Focus",
  ];
  const goalsOptions = [
    "Cook 5 nights; dehydrate garden surplus weekly; keep cleaning ≤ 90 min.",
    "Batch cook 2×/wk; freeze meals; keep weekdays light.",
    "Low-sugar, high-protein; quick breakfasts.",
  ];
  const constraintOptions = [
    "Small kitchen, 2 burners only",
    "School nights (no timers past 8pm)",
    "Allergy: gluten-free",
    "Minimal dishes; 1 pan preferred",
  ];
  const dietaryOptions = [
    "Torah Dietary Compliant",
    "Halal",
    "Low Sugar",
    "Gluten Free",
    "Dairy Free",
    "Nut Free",
    "No Pork",
    "Vegan",
  ];
  const hourOptions = ["0", "1", "2", "3", "4", "5", "7", "10", "12", "15", "20"];
  const budgetOptions = ["$80", "$100", "$120", "$160", "$200", "$250", "$300"];

  return (
    <SectionCard
      title="Household Profile"
      subtitle="Your vision powers planning across meals, cleaning, garden, and calendar."
      collapsible={false}
      className={className}
      actions={
        collapsed
          ? [{ label: "Edit", icon: "✏️", kind: "subtle", onClick: uncollapse }]
          : [
              {
                label: "Suggest Rhythm",
                icon: "⏱️",
                intent: "mealPlan/rhythm/suggest",
                busyLabel: "Suggesting…",
              },
            ]
      }
    >
      {/* Collapsed summary */}
      {collapsed ? (
        <div className="space-y-3">
          <div className="rounded-xl border p-4 bg-white">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-lg font-bold">Saved Setup</h3>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-stone-500">Completion</span>
                <div className="w-28 h-2 bg-stone-200 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[hsl(var(--brand))] transition-all"
                    style={{ width: `${completion}%` }}
                    aria-label={`Household profile completion ${completion}%`}
                  />
                </div>
                <span className="font-semibold">{completion}%</span>
              </div>
            </div>
            <ul className="text-sm home-grid mt-2">
              <li><span className="font-semibold">Household Profile:</span> {fmt(saved.mode)}</li>
              <li><span className="font-semibold">Goals / Vision:</span> {fmt(saved.goals)}</li>
              <li><span className="font-semibold">Constraints:</span> {fmt(saved.constraints)}</li>
              <li><span className="font-semibold">Dietary Notes:</span> {fmt(saved.dietary)}</li>
              <li><span className="font-semibold">Weekly Time Budget:</span> {fmt(saved.weeklyHrs)}{saved.weeklyHrs ? " hrs" : ""}</li>
              <li><span className="font-semibold">Budget:</span> {fmt(saved.budget)}</li>
            </ul>
          </div>
          <div className="flex gap-2">
            <button className="btn subtle" onClick={uncollapse}>Edit</button>
          </div>
        </div>
      ) : (
        <form className="home-grid form-scope" onSubmit={(e) => e.preventDefault()}>
          {/* Row 1 */}
          <FieldRow label="Household Profile (select one or more)">
            <MultiSelectWithCustom
              value={form.mode}
              onChange={(v) => update({ mode: v })}
              options={modeOptions}
              placeholder="Choose one or more…"
              name="household-profile"
            />
          </FieldRow>

          <FieldRow label="Your goals / vision">
            <MultiSelectWithCustom
              value={form.goals}
              onChange={(v) => update({ goals: v })}
              options={goalsOptions}
              placeholder="Choose goals or add custom…"
              customType="textarea"
              textareaRows={3}
              name="goals"
            />
          </FieldRow>

          {/* Row 2 */}
          <FieldRow label="Constraints">
            <MultiSelectWithCustom
              value={form.constraints}
              onChange={(v) => update({ constraints: v })}
              options={constraintOptions}
              placeholder="Choose constraints or add custom…"
              customType="textarea"
              textareaRows={2}
              name="constraints"
            />
          </FieldRow>

          <FieldRow label="Dietary notes">
            <MultiSelectWithCustom
              value={form.dietary}
              onChange={(v) => update({ dietary: v })}
              options={dietaryOptions}
              placeholder="Choose dietary notes or add custom…"
              name="dietary"
            />
          </FieldRow>

          {/* Row 3 */}
          <FieldRow label="Weekly time budget (hrs)">
            <SelectWithCustom
              value={form.weeklyHrs}
              onChange={(v) => update({ weeklyHrs: v })}
              options={hourOptions}
              placeholder="Choose hours or Custom…"
              name="weekly-hours"
            />
          </FieldRow>

          <FieldRow label="Budget ($/wk)">
            <SelectWithCustom
              value={form.budget}
              onChange={(v) => update({ budget: v })}
              options={budgetOptions}
              placeholder="Choose a budget or Custom…"
              name="budget"
            />
          </FieldRow>

          {/* Actions */}
          <div className="span-2 flex items-center gap-3">
            <button
              className="btn primary"
              onClick={saveAndCollapse}
              disabled={!dirty}
              aria-disabled={!dirty}
              title={dirty ? "Save Vision (Ctrl+S)" : "No changes to save"}
            >
              Save Vision
            </button>
            <span className="text-sm text-stone-500">
              {dirty ? "Unsaved changes" : "Saved globally. Press Ctrl+S to save anytime."}
            </span>
          </div>
        </form>
      )}
    </SectionCard>
  );
}
