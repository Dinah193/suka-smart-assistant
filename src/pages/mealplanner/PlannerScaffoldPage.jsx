import React, { useEffect, useMemo, useState } from "react";
import MealPlanDashboard from "./MealPlanDashboard";
import OutboxObservabilityPanel from "./OutboxObservabilityPanel";
import {
  fetchMealPlannerData,
  saveMealPlannerOutput,
} from "./MealPlannerService";

function normalizeRecommendations(payload) {
  if (Array.isArray(payload?.recommendations)) return payload.recommendations;
  if (!Array.isArray(payload?.meals)) return [];
  return payload.meals.map((meal, idx) => ({
    meal: meal?.title || meal?.name || `Meal ${idx + 1}`,
    explain: { reason: "Derived from planner snapshot" },
  }));
}

export default function PlannerScaffoldPage() {
  const [householdId, setHouseholdId] = useState("default-household");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [payload, setPayload] = useState(null);
  const [preservationTasks, setPreservationTasks] = useState([]);
  const [projectionStatus, setProjectionStatus] = useState(null);
  const [projectionBusy, setProjectionBusy] = useState(false);

  async function refreshProjectionStatus() {
    setProjectionBusy(true);
    try {
      const res = await fetch("/api/planners/projection/status");
      const data = await res.json();
      if (res.ok && data?.ok) {
        setProjectionStatus(data);
      }
    } catch {
      // Keep scaffold dashboard resilient even if projection endpoints are unavailable.
    } finally {
      setProjectionBusy(false);
    }
  }

  async function loadData(nextHouseholdId) {
    setLoading(true);
    setError("");
    try {
      const data = await fetchMealPlannerData(nextHouseholdId);
      setPayload(data || null);
      setPreservationTasks(
        Array.isArray(data?.preservationTasks) ? data.preservationTasks : []
      );
    } catch (e) {
      setError(String(e?.message || e || "Failed to load planner data"));
      setPayload(null);
      setPreservationTasks([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData(householdId);
  }, [householdId]);

  useEffect(() => {
    refreshProjectionStatus();
  }, []);

  const recommendations = useMemo(
    () => normalizeRecommendations(payload),
    [payload]
  );

  return (
    <main className="space-y-4 p-4">
      <header className="rounded-xl border border-emerald-200 bg-white p-4">
        <h1 className="text-2xl font-bold text-emerald-900">
          Meal Planner Scaffold Dashboard
        </h1>
        <p className="mt-1 text-sm text-emerald-700">
          Preservation-aware preview of recommendations and task impact.
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className="rounded-md border border-emerald-300 px-3 py-2 text-sm"
            value={householdId}
            onChange={(e) => setHouseholdId(e.target.value)}
            placeholder="household id"
          />
          <button
            type="button"
            onClick={() => loadData(householdId)}
            className="rounded-md bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={async () => {
              try {
                await saveMealPlannerOutput({
                  id: `scaffold-${Date.now()}`,
                  householdId,
                  title: "Scaffold meal plan",
                  plannerOutput: {
                    meals: recommendations,
                    preservationTasks,
                  },
                  recommendationScore: { total: 0.7 },
                });
              } catch {
                // Keep save action non-blocking in scaffold mode.
              }
            }}
            className="rounded-md border border-emerald-300 bg-white px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
          >
            Save Snapshot
          </button>
        </div>
      </header>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Projection Health</h2>
            <p className="text-sm text-slate-600">
              Durable queue status and quick recovery actions for planner projections.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={refreshProjectionStatus}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
            >
              {projectionBusy ? "Refreshing..." : "Refresh Status"}
            </button>
            <button
              type="button"
              onClick={async () => {
                setProjectionBusy(true);
                try {
                  await fetch("/api/planners/projection/replay", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ householdId, planner: "all", processLimit: 20 }),
                  });
                  await refreshProjectionStatus();
                } finally {
                  setProjectionBusy(false);
                }
              }}
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800 hover:bg-amber-100"
            >
              Replay Failed Jobs
            </button>
            <button
              type="button"
              onClick={async () => {
                setProjectionBusy(true);
                try {
                  await fetch("/api/planners/projection/reconcile", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ householdId, planner: "all", processNow: true }),
                  });
                  await refreshProjectionStatus();
                } finally {
                  setProjectionBusy(false);
                }
              }}
              className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-100"
            >
              Reconcile Household
            </button>
          </div>
        </div>

        <div className="mt-3 grid gap-2 text-sm text-slate-700 sm:grid-cols-3">
          <p>
            <strong>Total Jobs:</strong> {projectionStatus?.queue?.total ?? "-"}
          </p>
          <p>
            <strong>Queued/Retry:</strong>{" "}
            {projectionStatus?.queue
              ? `${projectionStatus.queue.queued}/${projectionStatus.queue.retry}`
              : "-"}
          </p>
          <p>
            <strong>Dead Letter:</strong> {projectionStatus?.queue?.deadLetter ?? "-"}
          </p>
          <p>
            <strong>Processed:</strong> {projectionStatus?.queue?.processed ?? "-"}
          </p>
          <p>
            <strong>Worker Running:</strong>{" "}
            {projectionStatus?.worker?.running ? "yes" : "no"}
          </p>
          <p>
            <strong>Interval:</strong> {projectionStatus?.worker?.intervalMs ?? "-"} ms
          </p>
        </div>
      </section>

      <OutboxObservabilityPanel householdId={householdId} />

      {loading ? <p className="text-sm text-emerald-700">Loading planner data...</p> : null}
      {!loading && error ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      {!loading && !error ? (
        <MealPlanDashboard
          recommendations={recommendations}
          preservationTasks={preservationTasks}
          onCompleteTask={(task) => {
            setPreservationTasks((prev) =>
              prev.filter((x) => (x.id || x.title) !== (task.id || task.title))
            );
          }}
        />
      ) : null}
    </main>
  );
}
