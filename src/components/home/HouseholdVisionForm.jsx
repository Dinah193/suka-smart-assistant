// src/components/home/HouseholdVisionForm.jsx
import React, { useState, useEffect } from "react";
import { useVision } from "@/context/VisionContext"; // you already have this

export default function HouseholdVisionForm() {
  const { vision, setVision } = useVision();
  const [form, setForm] = useState({
    goals: vision?.goals || "",
    constraints: vision?.constraints || "",
    timePerWeek: vision?.timePerWeek || 4,
    budget: vision?.budget || "",
    dietary: vision?.dietary || "",
  });

  useEffect(() => {
    // keep external state in sync if context changes elsewhere
    setForm((f) => ({
      ...f,
      goals: vision?.goals ?? f.goals,
      constraints: vision?.constraints ?? f.constraints,
      timePerWeek: vision?.timePerWeek ?? f.timePerWeek,
      budget: vision?.budget ?? f.budget,
      dietary: vision?.dietary ?? f.dietary,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vision?.goals, vision?.constraints, vision?.timePerWeek, vision?.budget, vision?.dietary]);

  function update(k, v) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function save() {
    setVision({ ...vision, ...form, updatedAt: Date.now() });
  }

  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm">
      <h2 className="mb-1 text-2xl font-bold">Household Vision</h2>
      <p className="mb-4 text-stone-600">
        Tell me what you want your home to feel like. I’ll quietly plan and coordinate.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold">Goals</span>
          <textarea
            className="rounded-xl border p-3"
            rows={4}
            placeholder="E.g., weekly prep on Sundays, zero-waste fridge, garden-to-freezer flow…"
            value={form.goals}
            onChange={(e) => update("goals", e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold">Constraints</span>
          <textarea
            className="rounded-xl border p-3"
            rows={4}
            placeholder="Time, tools, storage, allergies, religious rules…"
            value={form.constraints}
            onChange={(e) => update("constraints", e.target.value)}
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold">Time Available (hrs / week)</span>
          <input
            type="number"
            min={1}
            max={40}
            className="rounded-xl border p-3"
            value={form.timePerWeek}
            onChange={(e) => update("timePerWeek", Number(e.target.value || 0))}
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-semibold">Budget Notes</span>
          <input
            className="rounded-xl border p-3"
            placeholder="Tight, moderate, flexible; monthly cap; bulk-first…"
            value={form.budget}
            onChange={(e) => update("budget", e.target.value)}
          />
        </label>

        <label className="md:col-span-2 flex flex-col gap-2">
          <span className="text-sm font-semibold">Dietary / Preference Tags</span>
          <input
            className="rounded-xl border p-3"
            placeholder="halal, dairy-free, low-sugar, crunchy veg, kids-friendly…"
            value={form.dietary}
            onChange={(e) => update("dietary", e.target.value)}
          />
        </label>
      </div>

      <div className="mt-4 flex gap-2">
        <button className="btn btn-primary" onClick={save}>Save Vision</button>
        <span className="self-center text-xs text-stone-500">
          Auto-plans run after saving.
        </span>
      </div>
    </div>
  );
}
