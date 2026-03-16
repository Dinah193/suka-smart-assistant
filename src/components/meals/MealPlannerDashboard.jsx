// src/components/meals/MealPlannerDashboard.jsx

import React from "react";
import { Printer } from "lucide-react";
import { useMealPlanStore } from "@/store/MealPlanStore";

/**
 * SSA • Meal Planner Dashboard
 * -----------------------------------------------------------------------------
 * Uses SSA's existing styling system (index.css + SV styles), NOT Tailwind.
 *
 * Reads:
 *   useMealPlanStore().plan (preferred)
 *   falls back to .mealPlan for legacy
 *
 * Expects:
 *   plan/mealPlan as:
 *     - envelope: { schedule: {...}, shoppingList: [...], prepTasks: [...] }
 *     - OR legacy plain schedule object: { "Day 1": [...], "2026-01-10": [...] }
 */
export default function MealPlannerDashboard() {
  // ✅ read the canonical field dashboards expect
  const plan = useMealPlanStore((s) => s.plan ?? s.mealPlan);

  const envelope = plan && typeof plan === "object" ? plan : null;
  const schedule =
    envelope?.schedule && typeof envelope.schedule === "object"
      ? envelope.schedule
      : envelope && !envelope.shoppingList && !envelope.prepTasks
      ? envelope
      : {};

  const dayKeys = Object.keys(schedule || {});
  const sortedDays = [...dayKeys].sort((a, b) => {
    const ax = Date.parse(a);
    const bx = Date.parse(b);
    if (!Number.isNaN(ax) && !Number.isNaN(bx)) return ax - bx;
    const am = String(a).match(/(\d+)/);
    const bm = String(b).match(/(\d+)/);
    if (am && bm) return Number(am[1]) - Number(bm[1]);
    return String(a).localeCompare(String(b));
  });

  const hasAnyMeals =
    sortedDays.length > 0 &&
    sortedDays.some(
      (k) => Array.isArray(schedule[k]) && schedule[k].length > 0
    );

  const handlePrint = () => {
    const printableContent = [
      "=== Meal Plan ===",
      ...sortedDays.map((day) => {
        const meals = Array.isArray(schedule[day]) ? schedule[day] : [];
        const lines =
          meals.length > 0
            ? meals.map((m) => `  - ${String(m)}`).join("\n")
            : "  (no meals)";
        return `${day}\n${lines}`;
      }),
      "",
      "=== Shopping List ===",
      ...(Array.isArray(envelope?.shoppingList)
        ? envelope.shoppingList
        : []
      ).map((i) => `  - ${String(i)}`),
      "",
      "=== Prep Tasks ===",
      ...(Array.isArray(envelope?.prepTasks) ? envelope.prepTasks : []).map(
        (t) => `  - ${String(t)}`
      ),
      "",
    ].join("\n");

    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(
      `<pre style="font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space: pre-wrap;">${printableContent}</pre>`
    );
    win.document.close();
    win.print();
  };

  return (
    <div className="sv-card sv-pad">
      <div
        className="sv-row sv-wrap"
        style={{ justifyContent: "space-between", gap: 12 }}
      >
        <div>
          <div className="sv-card-title">Meal Planner Dashboard</div>
          <div className="sv-muted">
            Quick view of your current cycle. Print, then jump into prep tasks
            and procurement.
          </div>
        </div>

        <div className="sv-actions">
          <button
            className="sv-btn sv-btn--primary"
            onClick={handlePrint}
            type="button"
          >
            <span className="label">
              <Printer size={16} style={{ marginRight: 8 }} />
              Print Full Plan
            </span>
          </button>
        </div>
      </div>

      {!hasAnyMeals ? (
        <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 800, marginBottom: 6 }}>
            No meal cycle loaded yet
          </div>
          <div className="sv-muted">
            Start by creating one in <b>Meal Cycle Planner</b>, or generate a
            draft below.
          </div>
          <div className="sv-muted" style={{ marginTop: 8 }}>
            Cycle synced with Batch Cooking, Prep Tasks & Procurement.
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div
            className="sv-grid-4"
            style={{
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            }}
          >
            {sortedDays.map((day) => {
              const meals = Array.isArray(schedule[day]) ? schedule[day] : [];
              return (
                <div key={day} className="sv-card sv-pad">
                  <div style={{ fontWeight: 800 }}>{day}</div>
                  {meals.length ? (
                    <ul
                      className="list-disc"
                      style={{ paddingLeft: 18, marginTop: 6 }}
                    >
                      {meals.slice(0, 6).map((m, idx) => (
                        <li key={idx}>{String(m)}</li>
                      ))}
                      {meals.length > 6 ? (
                        <li>…and {meals.length - 6} more</li>
                      ) : null}
                    </ul>
                  ) : (
                    <div className="sv-muted" style={{ marginTop: 6 }}>
                      (no meals)
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {Array.isArray(envelope?.shoppingList) &&
          envelope.shoppingList.length ? (
            <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>
                Shopping List
              </div>
              <ul className="list-disc" style={{ paddingLeft: 18 }}>
                {envelope.shoppingList.slice(0, 12).map((i, idx) => (
                  <li key={idx}>{String(i)}</li>
                ))}
                {envelope.shoppingList.length > 12 ? (
                  <li>…and {envelope.shoppingList.length - 12} more</li>
                ) : null}
              </ul>
            </div>
          ) : null}

          {Array.isArray(envelope?.prepTasks) && envelope.prepTasks.length ? (
            <div className="sv-card sv-pad" style={{ marginTop: 12 }}>
              <div style={{ fontWeight: 800, marginBottom: 6 }}>Prep Tasks</div>
              <ul className="list-disc" style={{ paddingLeft: 18 }}>
                {envelope.prepTasks.slice(0, 12).map((t, idx) => (
                  <li key={idx}>{String(t)}</li>
                ))}
                {envelope.prepTasks.length > 12 ? (
                  <li>…and {envelope.prepTasks.length - 12} more</li>
                ) : null}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
