import React, { useMemo, useState } from "react";

const EDITABLE_THRESHOLD_KEYS = [
  "pendingAgeWarnMs",
  "pendingAgeCritMs",
  "deadLetterWarnCount",
  "deadLetterCritCount",
  "staleLeaseWarnCount",
  "staleLeaseCritCount",
  "retryRateWarn",
  "retryRateCrit",
];

function formatNumber(value, digits = 3) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "-";
  return Number(num.toFixed(digits));
}

export default function OutboxObservabilityPanel({ householdId = "default-household" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState(null);
  const [deliveries, setDeliveries] = useState([]);
  const [windowMs, setWindowMs] = useState(300000);
  const [form, setForm] = useState({});

  const thresholds = snapshot?.thresholds || {};
  const alerts = snapshot?.alerts?.alerts || [];

  const effectiveWindowMs = useMemo(() => {
    const parsed = Number(windowMs);
    if (!Number.isFinite(parsed) || parsed <= 0) return 300000;
    return parsed;
  }, [windowMs]);

  async function refreshObservability() {
    setBusy(true);
    setError("");
    try {
      const [obsRes, historyRes] = await Promise.all([
        fetch(
          `/api/planners/operational/outbox/observability?householdId=${encodeURIComponent(
            householdId
          )}&windowMs=${effectiveWindowMs}&eventsLimit=20`
        ),
        fetch(`/api/planners/operational/outbox/alert-deliveries?limit=10`),
      ]);

      const [obs, history] = await Promise.all([obsRes.json(), historyRes.json()]);
      if (!obsRes.ok || !obs?.ok) {
        throw new Error(obs?.error || "Failed to load outbox observability");
      }
      if (!historyRes.ok || !history?.ok) {
        throw new Error(history?.error || "Failed to load delivery history");
      }

      setSnapshot(obs);
      setDeliveries(Array.isArray(history.items) ? history.items : []);
      setForm(obs.thresholds || {});
    } catch (nextError) {
      setError(String(nextError?.message || nextError || "Failed to load observability"));
    } finally {
      setBusy(false);
    }
  }

  async function saveThresholds() {
    setBusy(true);
    setError("");
    try {
      const payload = {
        thresholds: EDITABLE_THRESHOLD_KEYS.reduce((acc, key) => {
          if (form[key] == null || form[key] === "") return acc;
          const parsed = Number(form[key]);
          if (!Number.isFinite(parsed)) return acc;
          acc[key] = parsed;
          return acc;
        }, {}),
      };

      const res = await fetch(`/api/planners/operational/outbox/alert-thresholds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Failed to save thresholds");
      }

      await refreshObservability();
    } catch (nextError) {
      setError(String(nextError?.message || nextError || "Failed to save thresholds"));
      setBusy(false);
    }
  }

  async function resetThresholds() {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/planners/operational/outbox/alert-thresholds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reset: true }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Failed to reset thresholds");
      }

      await refreshObservability();
    } catch (nextError) {
      setError(String(nextError?.message || nextError || "Failed to reset thresholds"));
      setBusy(false);
    }
  }

  async function dispatchAlerts(force = false) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/planners/operational/outbox/alerts/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ householdId, windowMs: effectiveWindowMs, force }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Failed to dispatch alerts");
      }

      await refreshObservability();
    } catch (nextError) {
      setError(String(nextError?.message || nextError || "Failed to dispatch alerts"));
      setBusy(false);
    }
  }

  const hasSnapshot = !!snapshot;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Outbox Observability</h2>
          <p className="text-sm text-slate-600">
            Monitor outbox health, tune thresholds, and review alert delivery hooks.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <input
            className="w-32 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            value={windowMs}
            onChange={(e) => setWindowMs(e.target.value)}
            placeholder="window ms"
          />
          <button
            type="button"
            onClick={refreshObservability}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
          >
            {busy ? "Working..." : "Refresh"}
          </button>
          <button
            type="button"
            onClick={() => dispatchAlerts(false)}
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-semibold text-amber-800 hover:bg-amber-100"
            disabled={!hasSnapshot || busy}
          >
            Dispatch Alerts
          </button>
          <button
            type="button"
            onClick={() => dispatchAlerts(true)}
            className="rounded-md border border-rose-300 bg-rose-50 px-3 py-1.5 text-sm font-semibold text-rose-800 hover:bg-rose-100"
            disabled={!hasSnapshot || busy}
          >
            Force Dispatch
          </button>
        </div>
      </div>

      {error ? (
        <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700">{error}</p>
      ) : null}

      {!hasSnapshot ? (
        <p className="mt-3 text-sm text-slate-600">Load observability data to populate this panel.</p>
      ) : null}

      {hasSnapshot ? (
        <div className="mt-4 space-y-4">
          <div className="grid gap-2 text-sm text-slate-700 sm:grid-cols-3">
            <p><strong>Pending:</strong> {snapshot?.outbox?.pending ?? 0}</p>
            <p><strong>Retry:</strong> {snapshot?.outbox?.retry ?? 0}</p>
            <p><strong>Dead Letter:</strong> {snapshot?.outbox?.deadLetter ?? 0}</p>
            <p><strong>Oldest Pending Age (ms):</strong> {snapshot?.health?.oldestPendingAgeMs ?? 0}</p>
            <p><strong>Stale Processing:</strong> {snapshot?.health?.staleProcessingCount ?? 0}</p>
            <p><strong>Retry Rate:</strong> {formatNumber(snapshot?.metrics?.window?.retryRate)}</p>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-slate-900">Active Alerts</h3>
            <ul className="mt-2 space-y-2 text-sm">
              {alerts.map((alert, idx) => (
                <li
                  key={`${alert.key}-${idx}`}
                  className={`rounded-md border p-2 ${
                    alert.severity === "critical"
                      ? "border-rose-300 bg-rose-50 text-rose-800"
                      : "border-amber-300 bg-amber-50 text-amber-800"
                  }`}
                >
                  <div className="font-medium">{alert.key} ({alert.severity})</div>
                  <div>{alert.message}</div>
                </li>
              ))}
              {!alerts.length ? (
                <li className="rounded-md border border-emerald-200 bg-emerald-50 p-2 text-emerald-800">
                  No active alerts for the selected window.
                </li>
              ) : null}
            </ul>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-slate-900">Thresholds</h3>
            <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {EDITABLE_THRESHOLD_KEYS.map((key) => (
                <label key={key} className="text-xs text-slate-700">
                  <span className="mb-1 block font-medium">{key}</span>
                  <input
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
                    value={form[key] ?? ""}
                    onChange={(e) =>
                      setForm((prev) => ({
                        ...prev,
                        [key]: e.target.value,
                      }))
                    }
                  />
                </label>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={saveThresholds}
                className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-800 hover:bg-emerald-100"
                disabled={busy}
              >
                Save Thresholds
              </button>
              <button
                type="button"
                onClick={resetThresholds}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-800 hover:bg-slate-50"
                disabled={busy}
              >
                Reset Defaults
              </button>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-slate-900">Delivery History</h3>
            <div className="mt-2 overflow-x-auto rounded-md border border-slate-200">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-left text-slate-700">
                  <tr>
                    <th className="px-2 py-1.5">Time</th>
                    <th className="px-2 py-1.5">Household</th>
                    <th className="px-2 py-1.5">Delivered/Attempted</th>
                    <th className="px-2 py-1.5">Alerts</th>
                    <th className="px-2 py-1.5">Force</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveries.map((item, idx) => (
                    <tr key={`${item.dedupeKey || "delivery"}-${idx}`} className="border-t border-slate-100">
                      <td className="px-2 py-1.5">{item.ts || "-"}</td>
                      <td className="px-2 py-1.5">{item.householdId || "global"}</td>
                      <td className="px-2 py-1.5">{item.delivered || 0}/{item.attempted || 0}</td>
                      <td className="px-2 py-1.5">{item.alertCount || 0}</td>
                      <td className="px-2 py-1.5">{item.force ? "yes" : "no"}</td>
                    </tr>
                  ))}
                  {!deliveries.length ? (
                    <tr>
                      <td className="px-2 py-2 text-slate-600" colSpan={5}>
                        No alert deliveries recorded yet.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
