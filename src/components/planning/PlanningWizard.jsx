// File: src/components/planning/PlanningWizard.jsx
"use client";

import React, { useMemo, useState } from "react";

const STEPS = [
  { key: "goal", label: "Goal" },
  { key: "constraints", label: "Constraints" },
  { key: "culture", label: "Culture" },
  { key: "time", label: "Time" },
  { key: "preview", label: "Preview" },
];

export default function PlanningWizard({ domain = "meals", onBuild }) {
  const [stepIdx, setStepIdx] = useState(0);

  const [goal, setGoal] = useState("");
  const [constraints, setConstraints] = useState({
    sabbathSafe: false,
    fastDay: false,
    budgetCap: "",
    timeCap: "",
  });
  const [culture, setCulture] = useState({
    communal: false,
    thrift: true,
    feastFocus: false,
  });

  const [time, setTime] = useState({ minutes: "90", equipment: "standard" });

  const userPhrase = useMemo(() => {
    const parts = [];
    if (goal) parts.push(goal);

    if (constraints.sabbathSafe) parts.push("Sabbath cooking");
    if (constraints.fastDay) parts.push("fast day");
    if (constraints.budgetCap) parts.push(`budget ${constraints.budgetCap}`);
    if (constraints.timeCap) parts.push(`time cap ${constraints.timeCap}`);

    if (culture.communal) parts.push("communal workflow");
    if (culture.thrift) parts.push("thrift");
    if (culture.feastFocus) parts.push("feast prep");

    if (time.minutes) parts.push(`time ${time.minutes} minutes`);
    if (time.equipment) parts.push(time.equipment);

    // Include domain hint for better routing
    parts.push(domain);

    return parts.filter(Boolean).join(", ");
  }, [goal, constraints, culture, time, domain]);

  const step = STEPS[stepIdx];

  function next() { setStepIdx((i) => Math.min(i + 1, STEPS.length - 1)); }
  function back() { setStepIdx((i) => Math.max(i - 1, 0)); }

  function commit() {
    if (typeof onBuild === "function") onBuild(userPhrase);
  }

  return (
    <div className="mt-3">
      <div className="flex gap-2 flex-wrap">
        {STEPS.map((s, i) => (
          <button
            key={s.key}
            className={`px-3 py-1.5 rounded-full border text-xs ${
              i === stepIdx ? "bg-black text-white" : "bg-white"
            }`}
            onClick={() => setStepIdx(i)}
          >
            {i + 1}. {s.label}
          </button>
        ))}
      </div>

      <div className="mt-4 rounded-2xl border p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">{step.label}</h3>
          <span className="text-xs opacity-70">
            Step {stepIdx + 1} / {STEPS.length}
          </span>
        </div>

        {step.key === "goal" ? (
          <div className="mt-3">
            <label className="text-sm font-semibold">What are you trying to accomplish?</label>
            <input
              className="mt-2 w-full rounded-xl border p-2 text-sm"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder='Examples: "plan week", "pantry reset", "harvest push", "feast prep"'
            />
          </div>
        ) : null}

        {step.key === "constraints" ? (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={constraints.sabbathSafe}
                onChange={(e) => setConstraints({ ...constraints, sabbathSafe: e.target.checked })}
              />
              Sabbath-safe / quiet-hours aware
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={constraints.fastDay}
                onChange={(e) => setConstraints({ ...constraints, fastDay: e.target.checked })}
              />
              Fast day
            </label>
            <div>
              <label className="text-xs font-semibold opacity-80">Budget cap</label>
              <input
                className="mt-1 w-full rounded-xl border p-2 text-sm"
                value={constraints.budgetCap}
                onChange={(e) => setConstraints({ ...constraints, budgetCap: e.target.value })}
                placeholder="$"
              />
            </div>
            <div>
              <label className="text-xs font-semibold opacity-80">Time cap</label>
              <input
                className="mt-1 w-full rounded-xl border p-2 text-sm"
                value={constraints.timeCap}
                onChange={(e) => setConstraints({ ...constraints, timeCap: e.target.value })}
                placeholder="e.g., 2 hours/day"
              />
            </div>
          </div>
        ) : null}

        {step.key === "culture" ? (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={culture.communal}
                onChange={(e) => setCulture({ ...culture, communal: e.target.checked })}
              />
              Community sharing emphasis
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={culture.thrift}
                onChange={(e) => setCulture({ ...culture, thrift: e.target.checked })}
              />
              Thrift / low waste
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={culture.feastFocus}
                onChange={(e) => setCulture({ ...culture, feastFocus: e.target.checked })}
              />
              Feast focus
            </label>
          </div>
        ) : null}

        {step.key === "time" ? (
          <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold opacity-80">Available time (minutes)</label>
              <input
                className="mt-1 w-full rounded-xl border p-2 text-sm"
                value={time.minutes}
                onChange={(e) => setTime({ ...time, minutes: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs font-semibold opacity-80">Equipment level</label>
              <select
                className="mt-1 w-full rounded-xl border p-2 text-sm"
                value={time.equipment}
                onChange={(e) => setTime({ ...time, equipment: e.target.value })}
              >
                <option value="standard">Standard</option>
                <option value="limited">Limited</option>
                <option value="advanced">Advanced</option>
                <option value="outdoor">Outdoor / hearth</option>
              </select>
            </div>
          </div>
        ) : null}

        {step.key === "preview" ? (
          <div className="mt-3">
            <p className="text-sm font-semibold">Generated intent phrase</p>
            <div className="mt-2 rounded-xl border p-3 text-sm bg-slate-50">
              {userPhrase || <span className="opacity-60">Fill earlier steps to generate a phrase.</span>}
            </div>
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-between gap-2">
          <button className="px-3 py-2 rounded-xl border text-sm" onClick={back} disabled={stepIdx === 0}>
            Back
          </button>
          <div className="flex gap-2">
            {stepIdx < STEPS.length - 1 ? (
              <button className="px-3 py-2 rounded-xl bg-black text-white text-sm" onClick={next}>
                Next
              </button>
            ) : (
              <button
                className="px-3 py-2 rounded-xl bg-black text-white text-sm disabled:opacity-50"
                onClick={commit}
                disabled={!userPhrase.trim()}
              >
                Build plan from wizard
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
