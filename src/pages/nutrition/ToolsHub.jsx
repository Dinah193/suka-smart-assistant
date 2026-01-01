/* eslint-disable no-console */
// src/pages/nutrition/ToolsHub.jsx
//
// Nutrition Tools Hub — SSA
// -----------------------------------------------------------------------------
// Purpose:
//   Single orchestration surface that wires together:
//   - BMI Calculator
//   - Macro Calculator
//   - Micronutrient Targets
//   - Meal Planner preferences
//
// This page is NOT a calculator replacement.
// It coordinates data + persistence + events so all tools stay in sync.
//
// SSA rules followed:
// - No TypeScript
// - Defensive imports
// - Local-first Dexie persistence
// - eventBus emits standardized events
// - No hard dependency on Hub export
// -----------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

/* --------------------------- Defensive imports ------------------------------ */

let db = null;
try {
  // eslint-disable-next-line global-require
  db = require("@/services/db").default ?? require("../../services/db").default;
} catch {
  db = null;
}

let eventBus = { emit: () => {} };
try {
  // eslint-disable-next-line global-require
  const eb =
    require("@/services/events/eventBus.js") ??
    require("../../services/events/eventBus");
  eventBus = eb?.default || eb || eventBus;
} catch {}

/* ------------------------------ Helpers ------------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/* ------------------------- Data Contracts (doc) ----------------------------- */
/**
 * PersonProfile
 * {
 *   id, householdId?, name,
 *   sex, age,
 *   heightCm, weightKg,
 *   activityLevel,
 *   createdAt, updatedAt
 * }
 *
 * NutritionPreferences
 * {
 *   id, personId,
 *   goal: "maintain"|"cut"|"bulk",
 *   dietStyle?, exclusions?,
 *   createdAt, updatedAt
 * }
 *
 * BmiResult
 * { bmi, category }
 *
 * MacroTargets
 * { calories, proteinG, carbsG, fatG }
 *
 * MicroTargets
 * { ironMg, calciumMg, potassiumMg, magnesiumMg, vitaminCMg }
 *
 * ToolRunLog
 * {
 *   id, personId,
 *   tool: "bmi"|"macros"|"micros",
 *   inputSnapshot, outputSnapshot,
 *   createdAt, version
 * }
 */

/* --------------------------- Calculators ----------------------------------- */

function computeBmi(weightKg, heightCm) {
  if (!weightKg || !heightCm) return null;
  const h = heightCm / 100;
  const bmi = +(weightKg / (h * h)).toFixed(1);
  let category = "Normal";
  if (bmi < 18.5) category = "Underweight";
  else if (bmi >= 25 && bmi < 30) category = "Overweight";
  else if (bmi >= 30) category = "Obese";
  return { bmi, category };
}

function computeMacros({ weightKg, activityLevel, goal }) {
  if (!weightKg) return null;
  const baseCalories =
    weightKg *
    (activityLevel === "high" ? 35 : activityLevel === "low" ? 25 : 30);

  const calories =
    goal === "cut"
      ? baseCalories - 300
      : goal === "bulk"
      ? baseCalories + 300
      : baseCalories;

  const proteinG = Math.round(weightKg * 2);
  const fatG = Math.round((calories * 0.25) / 9);
  const carbsG = Math.round((calories - proteinG * 4 - fatG * 9) / 4);

  return { calories, proteinG, carbsG, fatG };
}

function computeMicros(weightKg) {
  if (!weightKg) return null;
  return {
    ironMg: 18,
    calciumMg: 1000,
    potassiumMg: Math.round(weightKg * 50),
    magnesiumMg: 400,
    vitaminCMg: 90,
  };
}

/* --------------------------- Component ------------------------------------- */

export default function ToolsHub() {
  const [people, setPeople] = useState([]);
  const [activePersonId, setActivePersonId] = useState(null);
  const activePerson = useMemo(
    () => people.find((p) => p.id === activePersonId) || null,
    [people, activePersonId]
  );

  const [form, setForm] = useState({
    name: "",
    sex: "female",
    age: "",
    heightCm: "",
    weightKg: "",
    activityLevel: "medium",
    goal: "maintain",
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  /* ------------------------- Load people ---------------------------------- */

  useEffect(() => {
    if (!db?.personProfiles) return;
    db.personProfiles.toArray().then(setPeople);

    db.kv?.get("nutrition.lastPerson").then((r) => {
      if (r?.value) setActivePersonId(r.value);
    });
  }, []);

  useEffect(() => {
    if (!activePerson) return;
    setForm({
      name: activePerson.name,
      sex: activePerson.sex,
      age: activePerson.age,
      heightCm: activePerson.heightCm,
      weightKg: activePerson.weightKg,
      activityLevel: activePerson.activityLevel,
      goal: "maintain",
    });
  }, [activePerson]);

  /* ------------------------ Derived results -------------------------------- */

  const bmiResult = useMemo(
    () => computeBmi(+form.weightKg, +form.heightCm),
    [form.weightKg, form.heightCm]
  );

  const macroTargets = useMemo(
    () =>
      computeMacros({
        weightKg: +form.weightKg,
        activityLevel: form.activityLevel,
        goal: form.goal,
      }),
    [form]
  );

  const microTargets = useMemo(
    () => computeMicros(+form.weightKg),
    [form.weightKg]
  );

  /* ------------------------ Persistence ----------------------------------- */

  async function saveProfile() {
    if (!db?.personProfiles) return;
    setLoading(true);
    try {
      const id = activePerson?.id || makeId("person");
      const record = {
        id,
        ...form,
        createdAt: activePerson?.createdAt || nowIso(),
        updatedAt: nowIso(),
      };
      await db.personProfiles.put(record);
      await db.kv?.put({ key: "nutrition.lastPerson", value: id });
      setActivePersonId(id);
      setPeople((prev) => [...prev.filter((p) => p.id !== id), record]);

      eventBus.emit({
        type: "nutrition.profile.updated",
        ts: nowIso(),
        source: "nutrition.toolsHub",
        data: { personId: id },
      });
    } catch (e) {
      setError("Failed to save profile");
    } finally {
      setLoading(false);
    }
  }

  async function logRun(tool, output) {
    if (!db?.toolRunLogs || !activePerson) return;
    await db.toolRunLogs.add({
      id: makeId("run"),
      personId: activePerson.id,
      tool,
      inputSnapshot: form,
      outputSnapshot: output,
      createdAt: nowIso(),
      version: 1,
    });
  }

  async function sendToMealPlanner() {
    if (!activePerson) return;
    await db.nutritionPreferences.put({
      id: makeId("pref"),
      personId: activePerson.id,
      goal: form.goal,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    eventBus.emit({
      type: "mealplan.preferences.applied",
      ts: nowIso(),
      source: "nutrition.toolsHub",
      data: {
        personId: activePerson.id,
        macros: macroTargets,
        micros: microTargets,
      },
    });
  }

  /* ------------------------------ UI -------------------------------------- */

  return (
    <div className="page">
      <h1>Nutrition Tools Hub</h1>

      {error && <div className="error">{error}</div>}

      <section>
        <h2>Person</h2>
        <select
          value={activePersonId || ""}
          onChange={(e) => setActivePersonId(e.target.value)}
        >
          <option value="">New Person</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        <input
          placeholder="Name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <input
          placeholder="Age"
          value={form.age}
          onChange={(e) => setForm({ ...form, age: e.target.value })}
        />
        <input
          placeholder="Height (cm)"
          value={form.heightCm}
          onChange={(e) => setForm({ ...form, heightCm: e.target.value })}
        />
        <input
          placeholder="Weight (kg)"
          value={form.weightKg}
          onChange={(e) => setForm({ ...form, weightKg: e.target.value })}
        />

        <button disabled={loading} onClick={saveProfile}>
          Save as Default
        </button>
      </section>

      <section>
        <h2>Results</h2>

        {bmiResult && (
          <div>
            <strong>BMI:</strong> {bmiResult.bmi} ({bmiResult.category})
            {logRun("bmi", bmiResult) && null}
          </div>
        )}

        {macroTargets && (
          <div>
            <strong>Macros:</strong> {macroTargets.calories} kcal — P:
            {macroTargets.proteinG}g C:{macroTargets.carbsG}g F:
            {macroTargets.fatG}g{logRun("macros", macroTargets) && null}
          </div>
        )}

        {microTargets && (
          <div>
            <strong>Micros:</strong> Iron {microTargets.ironMg}mg, Calcium{" "}
            {microTargets.calciumMg}mg, Potassium {microTargets.potassiumMg}mg
            {logRun("micros", microTargets) && null}
          </div>
        )}

        <button onClick={sendToMealPlanner}>Send to Meal Planner</button>
      </section>

      <section>
        <h3>Open Tools</h3>
        <Link to="/nutrition/bmi">BMI Calculator</Link> |{" "}
        <Link to="/nutrition/macros">Macro Calculator</Link> |{" "}
        <Link to="/nutrition/micros">Micronutrients</Link>
      </section>
    </div>
  );
}
