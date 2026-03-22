import React, { useEffect, useMemo, useState } from "react";
import useRealtimeCoordination from "@/hooks/useRealtimeCoordination";
import { emitCanonicalSignal } from "@/services/realtime/canonicalSignalEmitter";

function timeAgo(iso) {
  if (!iso) return "-";
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "-";
  const delta = Math.max(0, Date.now() - ts);
  const min = Math.floor(delta / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

export default function RealtimeCoordinationPanel({ scopeOverrides = {} }) {
  const rt = useRealtimeCoordination(scopeOverrides);
  const [busySuggestionId, setBusySuggestionId] = useState(null);
  const [assigningSuggestionId, setAssigningSuggestionId] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [requestingReport, setRequestingReport] = useState(false);
  const [signaling, setSignaling] = useState(false);
  const [flushBusy, setFlushBusy] = useState(false);
  const [domainFilter, setDomainFilter] = useState("all");
  const [assignDrafts, setAssignDrafts] = useState({});
  const [queuedSignals, setQueuedSignals] = useState([]);
  const [queueNotice, setQueueNotice] = useState("");

  const queueDepth = queuedSignals.length;

  const readiness = useMemo(() => {
    const pending = (rt.suggestions || []).filter((x) => !x.consumedAt);
    const unassigned = pending.filter(
      (x) => !x.assignedToUserId && !x.assignedRole
    ).length;
    const highPriority = pending.filter((x) => Number(x.priorityScore || 0) >= 80).length;
    const staleAssigned = pending.filter((x) => {
      if (!x.assignmentTs) return false;
      const ts = Date.parse(x.assignmentTs);
      return Number.isFinite(ts) ? Date.now() - ts > 6 * 60 * 60 * 1000 : false;
    }).length;
    return {
      total: pending.length,
      unassigned,
      highPriority,
      staleAssigned,
    };
  }, [rt.suggestions]);

  const handoffSignalFor = (kind) => {
    if (kind === "storehouse") {
      return {
        type: "mealUpdated",
        sourceModule: "planner.meal",
        dependencies: ["storehouse", "sessions"],
        urgency: "normal",
        payload: { reason: "manual_handoff", handoffTo: "storehouse.planner" },
      };
    }
    if (kind === "inventory") {
      return {
        type: "inventoryShortage",
        sourceModule: "planner.meal",
        dependencies: ["storehouse", "shopping", "tasks"],
        urgency: "high",
        payload: { reason: "manual_handoff", handoffTo: "storehouse.planner" },
      };
    }
    return {
      type: "taskStarted",
      sourceModule: "planner.meal",
      dependencies: ["sessions", "cleaning"],
      urgency: "normal",
      payload: { reason: "manual_handoff", handoffTo: "task.sessions" },
    };
  };

  const readinessSignal = {
    type: "taskStarted",
    sourceModule: "realtime.coordination",
    dependencies: ["mealplanner", "storehouse", "homestead"],
    urgency: "normal",
    payload: {
      reason: "readiness_ping",
      totals: readiness,
    },
  };

  const conflictSignal = {
    type: "inventoryShortage",
    sourceModule: "realtime.coordination",
    dependencies: ["storehouse", "shopping"],
    urgency: "high",
    payload: {
      reason: "collaboration_conflict",
      unassigned: readiness.unassigned,
      staleAssigned: readiness.staleAssigned,
    },
  };

  const queueSignal = (label, signal) => {
    setQueuedSignals((prev) => [
      ...prev,
      {
        id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        label,
        signal,
        queuedAt: new Date().toISOString(),
      },
    ]);
    setQueueNotice(`${label} queued and will send on reconnect.`);
  };

  const emitOrQueueSignal = async (label, signal, { refresh = false } = {}) => {
    if (!rt.connected) {
      queueSignal(label, signal);
      return { queued: true };
    }

    const res = await emitCanonicalSignal(signal);
    if (refresh) await rt.refreshSuggestions();
    if (res?.ok) {
      setQueueNotice(`${label} sent.`);
      return { queued: false, ok: true };
    }

    queueSignal(label, signal);
    return { queued: true, ok: false };
  };

  useEffect(() => {
    if (!rt.connected || !queuedSignals.length || flushBusy) return;
    let cancelled = false;

    (async () => {
      setFlushBusy(true);
      const pending = queuedSignals;
      let delivered = 0;
      for (const item of pending) {
        if (cancelled) break;
        const res = await emitCanonicalSignal(item.signal);
        if (res?.ok) {
          delivered += 1;
        }
      }

      if (!cancelled) {
        if (delivered > 0) {
          setQueuedSignals((prev) => prev.slice(delivered));
          setQueueNotice(`Sent ${delivered} queued signal${delivered === 1 ? "" : "s"} after reconnect.`);
          await rt.refreshSuggestions();
        }
        setFlushBusy(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [rt.connected, queuedSignals, rt.refreshSuggestions]);

  const domainOf = (item) => {
    const target = String(item?.target || "").trim();
    const signalType = String(item?.metadata?.signalType || "").trim();
    const sourceModule = String(item?.metadata?.sourceModule || "").trim();

    if (target) {
      const seg = target.split(/[.:/]/).find(Boolean);
      if (seg) return seg.toLowerCase();
    }
    if (signalType) {
      const seg = signalType.split(/[._:/-]/).find(Boolean);
      if (seg) return seg.toLowerCase();
    }
    if (sourceModule) {
      const seg = sourceModule.split(/[._:/-]/).find(Boolean);
      if (seg) return seg.toLowerCase();
    }
    return "other";
  };

  const filteredSuggestions = useMemo(() => {
    const pending = (rt.suggestions || []).filter((x) => !x.consumedAt);
    if (domainFilter === "all") return pending;
    return pending.filter((item) => domainOf(item) === domainFilter);
  }, [rt.suggestions, domainFilter]);

  const domainStats = useMemo(() => {
    const stats = new Map();
    for (const item of (rt.suggestions || []).filter((x) => !x.consumedAt)) {
      const d = domainOf(item);
      stats.set(d, (stats.get(d) || 0) + 1);
    }
    return [
      { key: "all", count: (rt.suggestions || []).filter((x) => !x.consumedAt).length },
      ...Array.from(stats.entries())
        .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
        .map(([key, count]) => ({ key, count })),
    ];
  }, [rt.suggestions]);

  const topSuggestions = useMemo(
    () => filteredSuggestions.slice(0, 5),
    [filteredSuggestions]
  );

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await Promise.all([rt.refreshSuggestions(), rt.requestReport()]);
    } finally {
      setRefreshing(false);
    }
  };

  const onConsume = async (id) => {
    setBusySuggestionId(id);
    try {
      await rt.consumeSuggestion(id);
    } finally {
      setBusySuggestionId(null);
    }
  };

  const onRequestReport = async () => {
    setRequestingReport(true);
    try {
      await rt.requestReport();
    } finally {
      setRequestingReport(false);
    }
  };

  const emitPlannerHandoff = async (kind) => {
    setSignaling(true);
    try {
      const label =
        kind === "storehouse"
          ? "Storehouse handoff"
          : kind === "inventory"
            ? "Inventory risk signal"
            : "Prep session signal";
      await emitOrQueueSignal(label, handoffSignalFor(kind), { refresh: true });
    } finally {
      setSignaling(false);
    }
  };

  const assignDraftFor = (id) => {
    const fromState = assignDrafts?.[id];
    if (fromState) return fromState;
    return {
      userId: rt.userId || "",
      role: "",
    };
  };

  const onAssignDraftChange = (id, patch) => {
    setAssignDrafts((prev) => ({
      ...prev,
      [id]: {
        ...assignDraftFor(id),
        ...(patch || {}),
      },
    }));
  };

  const onAssign = async (item) => {
    if (!item?.id) return;
    const d = assignDraftFor(item.id);
    const userId = String(d.userId || "").trim() || null;
    const role = String(d.role || "").trim() || null;
    if (!userId && !role) return;

    setAssigningSuggestionId(item.id);
    try {
      await rt.assignSuggestion({
        suggestionId: item.id,
        assignedToUserId: userId,
        assignedRole: role,
      });
    } finally {
      setAssigningSuggestionId(null);
    }
  };

  const onAssignToMe = async (item) => {
    if (!item?.id || !rt.userId) return;
    setAssigningSuggestionId(item.id);
    try {
      await rt.assignSuggestion({
        suggestionId: item.id,
        assignedToUserId: rt.userId,
        assignedRole: null,
      });
      onAssignDraftChange(item.id, { userId: rt.userId, role: "" });
    } finally {
      setAssigningSuggestionId(null);
    }
  };

  const onUnassign = async (item) => {
    if (!item?.id) return;
    setAssigningSuggestionId(item.id);
    try {
      await rt.assignSuggestion({
        suggestionId: item.id,
        assignedToUserId: null,
        assignedRole: null,
      });
      onAssignDraftChange(item.id, { userId: "", role: "" });
    } finally {
      setAssigningSuggestionId(null);
    }
  };

  return (
    <div className="card" style={{ padding: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ fontWeight: 700 }}>Realtime Coordination</div>
        <span className="chip">Scope: {rt.scope}</span>
        <span className="chip">ID: {rt.scopeId}</span>
        <span className="chip">Queue: {rt.queueDepth}</span>
        <span className={`chip ${rt.connected ? "chip--brand" : ""}`} role="status" aria-live="polite">
          {rt.connected ? "Live" : rt.connecting ? "Connecting" : "Offline"}
        </span>
        <span className={`chip ${queueDepth ? "chip--brand" : ""}`} role="status" aria-live="polite">
          Queued: {queueDepth}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => {
              rt.reconnect?.();
              setQueueNotice("Reconnect requested.");
            }}
            disabled={rt.connected || rt.connecting}
          >
            Reconnect
          </button>
          <button type="button" className="btn btn--ghost" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onRequestReport}
            disabled={requestingReport}
          >
            {requestingReport ? "Generating..." : "Generate Report"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <div className="text-xs home-muted" style={{ marginBottom: 6 }}>
          Planner Handoffs: send a coordination signal so other planners can pick up work.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => emitPlannerHandoff("storehouse")}
            disabled={signaling}
          >
            Handoff to Storehouse
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => emitPlannerHandoff("inventory")}
            disabled={signaling}
          >
            Flag Inventory Risk
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => emitPlannerHandoff("prep")}
            disabled={signaling}
          >
            Request Prep Session
          </button>
        </div>

        <div className="text-xs home-muted" style={{ marginBottom: 6 }}>
          Latest report: {timeAgo(rt.latestReport?.generatedAt)}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className="chip">Signals 24h: {rt.latestReport?.summary?.signals24h ?? 0}</span>
          <span className="chip">Pending: {rt.latestReport?.summary?.pendingSuggestions ?? rt.queueDepth}</span>
          <span className="chip">
            High priority: {rt.latestReport?.summary?.highPriorityPending ?? 0}
          </span>
        </div>

        <div style={{ marginTop: 10 }}>
          <div className="text-xs home-muted" style={{ marginBottom: 6 }}>
            Collaboration readiness
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }} aria-live="polite">
            <span className="chip">Unassigned: {readiness.unassigned}</span>
            <span className="chip">Priority 80+: {readiness.highPriority}</span>
            <span className="chip">Stale assigned: {readiness.staleAssigned}</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => emitOrQueueSignal("Readiness broadcast", readinessSignal)}
            >
              Broadcast readiness
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => emitOrQueueSignal("Collaboration conflict", conflictSignal)}
            >
              Flag collaboration conflict
            </button>
          </div>
        </div>
      </div>

      {queueNotice ? (
        <div className="text-xs home-muted" style={{ marginTop: 8 }} role="status" aria-live="polite">
          {queueNotice}
          {flushBusy ? " Flushing queued signals..." : ""}
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
          {domainStats.map((d) => (
            <button
              key={d.key}
              type="button"
              className={`chip ${domainFilter === d.key ? "chip--brand" : ""}`}
              onClick={() => setDomainFilter(d.key)}
              title={`Show ${d.key} suggestions`}
            >
              {d.key} ({d.count})
            </button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "baseline", marginBottom: 6 }}>
          <div style={{ fontWeight: 600 }}>Top Suggestions</div>
          <div className="text-xs home-muted">
            Showing {topSuggestions.length} of {filteredSuggestions.length} pending
          </div>
        </div>
        {!topSuggestions.length ? (
          <div className="text-xs home-muted">No pending suggestions for this filter.</div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {topSuggestions.map((item) => (
              <div key={item.id} className="card" style={{ padding: 10 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <div style={{ fontWeight: 600 }}>{item.title || item.action}</div>
                  <span className="chip">Score: {item.priorityScore ?? 0}</span>
                  <span className="chip">{item.target || "task"}</span>
                  {item.assignedToUserId ? (
                    <span className="chip chip--brand">Assigned: {item.assignedToUserId}</span>
                  ) : null}
                  {!item.assignedToUserId && item.assignedRole ? (
                    <span className="chip chip--brand">Role: {item.assignedRole}</span>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn--ghost"
                    style={{ marginLeft: "auto" }}
                    onClick={() => onConsume(item.id)}
                    disabled={busySuggestionId === item.id}
                  >
                    {busySuggestionId === item.id ? "Consuming..." : "Consume"}
                  </button>
                </div>
                {item.detail ? (
                  <div className="text-xs home-muted" style={{ marginTop: 6 }}>
                    {item.detail}
                  </div>
                ) : null}

                <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input
                    type="text"
                    className="animal-input"
                    style={{ maxWidth: 220, height: 32, padding: "6px 10px" }}
                    aria-label="Assign user id"
                    placeholder="Assign user id"
                    value={assignDraftFor(item.id).userId}
                    onChange={(e) => onAssignDraftChange(item.id, { userId: e.target.value })}
                  />
                  <select
                    className="animal-input"
                    style={{ maxWidth: 170, height: 32, padding: "4px 8px" }}
                    aria-label="Assign role"
                    value={assignDraftFor(item.id).role}
                    onChange={(e) => onAssignDraftChange(item.id, { role: e.target.value })}
                  >
                    <option value="">Role (optional)</option>
                    <option value="cook">Cook</option>
                    <option value="garden">Garden</option>
                    <option value="animals">Animals</option>
                    <option value="storehouse">Storehouse</option>
                    <option value="cleaning">Cleaning</option>
                    <option value="runner">Runner</option>
                  </select>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => onAssign(item)}
                    disabled={assigningSuggestionId === item.id}
                  >
                    {assigningSuggestionId === item.id ? "Assigning..." : "Assign"}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => onAssignToMe(item)}
                    disabled={assigningSuggestionId === item.id || !rt.userId}
                    title={rt.userId ? `Assign to ${rt.userId}` : "No current user id"}
                  >
                    Assign to me
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => onUnassign(item)}
                    disabled={assigningSuggestionId === item.id}
                  >
                    Unassign
                  </button>
                  {item.assignmentTs ? (
                    <span className="text-xs home-muted">Updated {timeAgo(item.assignmentTs)}</span>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {rt.lastError ? (
        <div className="text-xs" style={{ marginTop: 10, color: "#b91c1c" }}>
          Realtime error: {String(rt.lastError?.message || rt.lastError)}
        </div>
      ) : null}
    </div>
  );
}
