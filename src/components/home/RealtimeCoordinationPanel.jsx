import React, { useMemo, useState } from "react";
import useRealtimeCoordination from "@/hooks/useRealtimeCoordination";

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
  const [domainFilter, setDomainFilter] = useState("all");
  const [assignDrafts, setAssignDrafts] = useState({});

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
        <span className={`chip ${rt.connected ? "chip--brand" : ""}`}>
          {rt.connected ? "Live" : rt.connecting ? "Connecting" : "Offline"}
        </span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
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
          Latest report: {timeAgo(rt.latestReport?.generatedAt)}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span className="chip">Signals 24h: {rt.latestReport?.summary?.signals24h ?? 0}</span>
          <span className="chip">Pending: {rt.latestReport?.summary?.pendingSuggestions ?? rt.queueDepth}</span>
          <span className="chip">
            High priority: {rt.latestReport?.summary?.highPriorityPending ?? 0}
          </span>
        </div>
      </div>

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

        <div style={{ fontWeight: 600, marginBottom: 6 }}>Top Suggestions</div>
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
                    placeholder="Assign user id"
                    value={assignDraftFor(item.id).userId}
                    onChange={(e) => onAssignDraftChange(item.id, { userId: e.target.value })}
                  />
                  <select
                    className="animal-input"
                    style={{ maxWidth: 170, height: 32, padding: "4px 8px" }}
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
