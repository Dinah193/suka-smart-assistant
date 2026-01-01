// File: src/pages/planning/index.jsx
// Planning Hub — front door for fixed-layer planning
"use client";

import React, { useMemo, useState } from "react";
import PlanningWizard from "../../components/planning/PlanningWizard.jsx";
import PatternPicker from "../../components/planning/PatternPicker.jsx";
import PlanPreview from "../../components/planning/PlanPreview.jsx";

import PlanningOrchestrator from "../../services/planning/PlanningOrchestrator.js";

const orchestrator = new PlanningOrchestrator({ devHotReload: import.meta?.env?.DEV });

const DOMAINS = [
  { key: "meals", label: "Meals" },
  { key: "storehouse", label: "Storehouse" },
  { key: "homestead", label: "Homestead" },
];

export default function PlanningHubPage() {
  const [domain, setDomain] = useState("meals");
  const [userInput, setUserInput] = useState("");
  const [seasonalMode, setSeasonalMode] = useState("default");
  const [culturePrimary, setCulturePrimary] = useState("workflow.hybrid.sacred_agrarian_village");
  const [cultureSecondary, setCultureSecondary] = useState("");
  const [blendMode, setBlendMode] = useState("merge");
  const [leanOptIn, setLeanOptIn] = useState(false);

  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const context = useMemo(() => {
    return {
      seasonalMode,
      culturePrefs: {
        enabled: true,
        primaryId: culturePrimary,
        secondaryId: cultureSecondary || null,
        blendMode,
        weightPrimary: 0.7,
        weightSecondary: 0.3,
      },
      leanOptIn,
      inventorySnapshotAvailable: true, // UI can toggle later
      overrides: { enabled: true },
      maxPatterns: 3,
    };
  }, [seasonalMode, culturePrimary, cultureSecondary, blendMode, leanOptIn]);

  async function runPlan() {
    setBusy(true);
    setErr("");
    try {
      const payload = await orchestrator.buildPlan({ domain, userInput, context });
      setResult(payload);
    } catch (e) {
      setErr(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Planning Hub</h1>
          <p className="text-sm opacity-80">
            Choose a domain, describe what you want, then build session blueprints.
          </p>
        </div>

        <div className="flex gap-2 flex-wrap">
          {DOMAINS.map((d) => (
            <button
              key={d.key}
              className={`px-3 py-2 rounded-xl border text-sm ${
                domain === d.key ? "bg-black text-white" : "bg-white"
              }`}
              onClick={() => setDomain(d.key)}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-4">
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <label className="text-sm font-semibold">Describe what you want</label>
            <textarea
              className="mt-2 w-full min-h-[90px] rounded-xl border p-3 text-sm"
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              placeholder='Examples: "plan week", "pantry reset", "feast prep", "harvest push", "root cellar optimizer"'
            />
            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold opacity-80">Season mode</label>
                <select
                  className="mt-1 w-full rounded-xl border p-2 text-sm"
                  value={seasonalMode}
                  onChange={(e) => setSeasonalMode(e.target.value)}
                >
                  <option value="default">Default</option>
                  <option value="winterize">Winterize</option>
                  <option value="spring_start">Spring Start</option>
                  <option value="harvest_push">Harvest Push</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold opacity-80">Blend mode</label>
                <select
                  className="mt-1 w-full rounded-xl border p-2 text-sm"
                  value={blendMode}
                  onChange={(e) => setBlendMode(e.target.value)}
                >
                  <option value="merge">Merge</option>
                  <option value="weighted">Weighted</option>
                </select>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
              <div>
                <label className="text-xs font-semibold opacity-80">Culture primary</label>
                <select
                  className="mt-1 w-full rounded-xl border p-2 text-sm"
                  value={culturePrimary}
                  onChange={(e) => setCulturePrimary(e.target.value)}
                >
                  <option value="workflow.hybrid.sacred_agrarian_village">Sacred Agrarian Village (Hybrid)</option>
                  <option value="workflow.indigenous.west_african">West African (Indigenous)</option>
                  <option value="workflow.indigenous.israelite_household">Israelite Household (Indigenous)</option>
                  <option value="workflow.diaspora.southern_black_agrarian">Southern Black Agrarian (Diaspora)</option>
                  <option value="workflow.modern.modern_efficiency">Modern Efficiency</option>
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold opacity-80">Culture secondary (optional)</label>
                <select
                  className="mt-1 w-full rounded-xl border p-2 text-sm"
                  value={cultureSecondary}
                  onChange={(e) => setCultureSecondary(e.target.value)}
                >
                  <option value="">None</option>
                  <option value="workflow.indigenous.west_african">West African</option>
                  <option value="workflow.indigenous.israelite_household">Israelite Household</option>
                  <option value="workflow.diaspora.southern_black_agrarian">Southern Black Agrarian</option>
                  <option value="workflow.modern.modern_efficiency">Modern Efficiency</option>
                </select>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <input
                id="leanOptIn"
                type="checkbox"
                checked={leanOptIn}
                onChange={(e) => setLeanOptIn(e.target.checked)}
              />
              <label htmlFor="leanOptIn" className="text-sm">
                Enable Lean recommendations
              </label>
            </div>

            <button
              className="mt-4 w-full rounded-xl bg-black text-white py-2 text-sm font-semibold disabled:opacity-50"
              onClick={runPlan}
              disabled={busy || !userInput.trim()}
            >
              {busy ? "Building plan..." : "Build Plan"}
            </button>

            {err ? <p className="mt-2 text-sm text-red-600">{err}</p> : null}
          </div>

          <div className="mt-4 rounded-2xl border bg-white p-4 shadow-sm">
            <h2 className="text-sm font-bold">Pattern selector</h2>
            <p className="text-xs opacity-70">Browse patterns directly (optional).</p>
            <PatternPicker domain={domain} onPick={(patternId) => setUserInput(patternId)} />
          </div>
        </div>

        <div className="lg:col-span-8">
          <div className="rounded-2xl border bg-white p-4 shadow-sm">
            <h2 className="text-lg font-bold">Guided Planner</h2>
            <p className="text-sm opacity-80">Use the wizard if you want structured input.</p>
            <PlanningWizard
              domain={domain}
              onBuild={(wizardInput) => {
                setUserInput(wizardInput);
                runPlan();
              }}
            />
          </div>

          <div className="mt-4">
            <PlanPreview payload={result} />
          </div>
        </div>
      </div>
    </div>
  );
}
