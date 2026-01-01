// src/ui/AutomationPanel.jsx
import React from "react";
import { automation } from "@/services/automation/runtime";

// Small helpers ---------------------------------------------------------------
const tryListTemplates = () => {
  try {
    const list = Array.from(automation?.templates?.values?.() || []);
    // Normalize: { id, title, description, schema? }
    return list.map((t) => ({
      id: t.id,
      title: t.title || t.id,
      description: t.description || "",
      schema: t.schema || t.inputSchema || null, // support both names
      tags: t.tags || [],
    }));
  } catch {
    return [];
  }
};

const useEvent = (type, handler) => {
  React.useEffect(() => {
    if (!automation?.on) return;
    const maybeUnsub = automation.on(type, handler);
    return () => {
      // Accept either returned unsubscribe function, or .off(type, handler)
      if (typeof maybeUnsub === "function") {
        try { maybeUnsub(); } catch {}
      } else if (automation?.off) {
        try { automation.off(type, handler); } catch {}
      }
    };
  }, [type, handler]);
};

const ProgressBar = ({ value, indeterminate, label }) => {
  const pct = Math.max(0, Math.min(100, Math.round(value ?? 0)));
  return (
    <div
      className="progress"
      data-indeterminate={indeterminate ? "true" : undefined}
      style={{ height: "0.5rem", borderRadius: 9999, marginTop: 4 }}
      aria-label={label || "Progress"}
      role="progressbar"
      aria-valuemin={indeterminate ? undefined : 0}
      aria-valuemax={indeterminate ? undefined : 100}
      aria-valuenow={indeterminate ? undefined : pct}
    >
      {!indeterminate && (
        <div
          className="progress-bar-fill"
          style={{ width: `${pct}%` }}
        />
      )}
    </div>
  );
};

function FormFields({ schema, value, onChange }) {
  if (!schema || typeof schema !== "object") return null;
  // Support JSON-schema-ish: { properties, required, order?, groups? }
  const props = schema.properties || {};
  const order = schema.order || Object.keys(props);
  const required = new Set(schema.required || []);

  const set = (k, v) => onChange({ ...value, [k]: v });

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {order.map((k) => {
        const def = props[k] || {};
        const label = def.title || k;
        const type = def.type || (Array.isArray(def.enum) ? "string" : "string");
        const placeholder = def.description || "";
        const isReq = required.has(k);
        const v = value?.[k];

        if (Array.isArray(def.enum)) {
          return (
            <label key={k} style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                {label} {isReq ? <span aria-hidden="true" style={{ color: "#ef4444" }}>*</span> : null}
              </span>
              <select
                value={v ?? ""}
                onChange={(e) => set(k, e.target.value || undefined)}
                className="input"
              >
                <option value="">{placeholder || "Select…"}</option>
                {def.enum.map((opt) => (
                  <option key={String(opt)} value={opt}>
                    {def.enumNames?.[def.enum.indexOf(opt)] || String(opt)}
                  </option>
                ))}
              </select>
            </label>
          );
        }

        if (type === "boolean") {
          return (
            <label key={k} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={!!v}
                onChange={(e) => set(k, e.target.checked)}
              />
              <span style={{ fontSize: 12, fontWeight: 600 }}>{label}</span>
            </label>
          );
        }

        if (type === "number" || type === "integer") {
          return (
            <label key={k} style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                {label} {isReq ? <span aria-hidden="true" style={{ color: "#ef4444" }}>*</span> : null}
              </span>
              <input
                type="number"
                step={type === "integer" ? 1 : "any"}
                value={v ?? ""}
                placeholder={placeholder}
                onChange={(e) => {
                  const raw = e.target.value;
                  set(k, raw === "" ? undefined : Number(raw));
                }}
                className="input"
              />
            </label>
          );
        }

        if (type === "object") {
          return (
            <label key={k} style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                {label} {isReq ? <span aria-hidden="true" style={{ color: "#ef4444" }}>*</span> : null}
              </span>
              <textarea
                value={v ? JSON.stringify(v, null, 2) : ""}
                placeholder={placeholder || "JSON…"}
                onChange={(e) => {
                  try {
                    const parsed = JSON.parse(e.target.value || "null");
                    set(k, parsed || undefined);
                  } catch {
                    set(k, e.target.value);
                  }
                }}
                className="input"
                rows={4}
                style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
              />
            </label>
          );
        }

        // string / fallback
        return (
          <label key={k} style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>
              {label} {isReq ? <span aria-hidden="true" style={{ color: "#ef4444" }}>*</span> : null}
            </span>
            <input
              type="text"
              value={v ?? ""}
              placeholder={placeholder}
              onChange={(e) => set(k, e.target.value || undefined)}
              className="input"
            />
          </label>
        );
      })}
    </div>
  );
}

// Component -------------------------------------------------------------------
export default function AutomationPanel({
  title = "Automation",
  agents = [],         // [{ id, label, note?, run:(payload?)=>Promise<any> }]
  onEvent,            // optional: (evt) => void
  logLimit = 50,      // keep latest N events
  defaultTemplateFilter = "",
}) {
  const [templates, setTemplates] = React.useState(tryListTemplates());
  const [filter, setFilter] = React.useState(defaultTemplateFilter);
  const [busyId, setBusyId] = React.useState(null);
  const [progress, setProgress] = React.useState({ id: null, pct: 0, indeterminate: false });
  const [output, setOutput] = React.useState(null);
  const [log, setLog] = React.useState([]);

  // Per-template input states
  const [inputs, setInputs] = React.useState({}); // { [templateId]: object }
  const setInput = (id, val) => setInputs((p) => ({ ...p, [id]: val }));

  // Keep registry live
  const refreshTemplates = React.useCallback(() => setTemplates(tryListTemplates()), []);
  useEvent("templates:changed", refreshTemplates);

  // Event log + progress updates
  useEvent("event", (evt) => {
    setLog((l) => [evt, ...l].slice(0, logLimit));
    onEvent?.(evt);
  });

  useEvent("run:update", (evt) => {
    // Expected shape: { id, pct?, indeterminate?, message? }
    if (!evt || evt.id == null) return;
    setProgress({
      id: evt.id,
      pct: typeof evt.pct === "number" ? evt.pct : 0,
      indeterminate: !!evt.indeterminate,
      message: evt.message,
    });
  });

  // Manual refresh (in case runtime doesn't emit)
  const handleRefresh = () => refreshTemplates();

  // Runners -------------------------------------------------------------------
  const runTemplate = async (id) => {
    setBusyId(id);
    setProgress({ id, pct: 0, indeterminate: true });

    const payload = {
      invokedBy: "ui",
      ...(inputs[id] || {}),
    };

    try {
      const fn = automation?.runTemplateWithParams || automation?.runTemplate || automation?.run;
      const res = await fn.call(automation, id, payload);
      setOutput({ kind: "template", id, res, payload });
    } catch (e) {
      setOutput({ kind: "template", id, payload, error: e?.message || String(e) });
    } finally {
      setBusyId(null);
      setProgress((p) => (p.id === id ? { id: null, pct: 0, indeterminate: false } : p));
    }
  };

  const runAgent = async (agent) => {
    setBusyId(agent.id);
    setProgress({ id: agent.id, pct: 0, indeterminate: true });

    try {
      const res = await agent.run?.(inputs[agent.id] || undefined);
      setOutput({ kind: "agent", id: agent.id, res, payload: inputs[agent.id] });
    } catch (e) {
      setOutput({ kind: "agent", id: agent.id, payload: inputs[agent.id], error: e?.message || String(e) });
    } finally {
      setBusyId(null);
      setProgress((p) => (p.id === agent.id ? { id: null, pct: 0, indeterminate: false } : p));
    }
  };

  // Copy / download helpers ---------------------------------------------------
  const copyOutput = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(output, null, 2));
    } catch {}
  };
  const downloadOutput = () => {
    try {
      const blob = new Blob([JSON.stringify(output, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      a.download = `automation-output-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {}
  };

  const visibleTemplates = React.useMemo(() => {
    if (!filter) return templates;
    const f = filter.toLowerCase();
    return templates.filter((t) =>
      t.id.toLowerCase().includes(f) ||
      t.title.toLowerCase().includes(f) ||
      (t.description || "").toLowerCase().includes(f) ||
      (t.tags || []).some((x) => String(x).toLowerCase().includes(f))
    );
  }, [templates, filter]);

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={{ marginTop: 0, marginBottom: 0, flex: 1 }}>{title}</h3>
        <button className="btn sm" onClick={handleRefresh} aria-label="Refresh templates">
          Refresh
        </button>
      </div>

      {/* Search / filter */}
      <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
        <input
          className="input"
          type="search"
          placeholder="Search templates…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Filter templates"
        />
      </div>

      {/* Templates */}
      <div style={{ display: "grid", gap: 10, margin: "12px 0 16px" }}>
        <strong>Automation Templates</strong>
        {visibleTemplates.length === 0 && (
          <div className="subtitle">No templates registered yet.</div>
        )}
        {visibleTemplates.map((t) => {
          const isBusy = busyId === t.id;
          const showProgress = progress.id === t.id;
          return (
            <div key={t.id} className="card" style={{ padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{t.title}</div>
                  {t.description ? (
                    <div className="subtitle" style={{ marginTop: 2 }}>
                      {t.description}
                    </div>
                  ) : null}
                  {t.tags?.length ? (
                    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                      {t.tags.map((tag) => (
                        <span
                          key={tag}
                          className="badge"
                          style={{
                            fontSize: 11,
                            padding: "2px 6px",
                            background: "#eef2ff",
                            color: "#3730a3",
                            borderRadius: 9999,
                          }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
                <button
                  className="btn sm"
                  aria-busy={isBusy}
                  onClick={() => runTemplate(t.id)}
                  disabled={isBusy}
                >
                  <span className="label">{isBusy ? "Running…" : "Run"}</span>
                </button>
              </div>

              {/* Optional input form (schema-driven) */}
              {t.schema ? (
                <div style={{ marginTop: 10 }}>
                  <FormFields
                    schema={t.schema}
                    value={inputs[t.id] || {}}
                    onChange={(v) => setInput(t.id, v)}
                  />
                </div>
              ) : null}

              {/* Inline progress */}
              {showProgress ? (
                <div style={{ marginTop: 8 }}>
                  <ProgressBar
                    value={progress.pct}
                    indeterminate={progress.indeterminate}
                    label="Template progress"
                  />
                  {progress.message ? (
                    <div className="subtitle" style={{ marginTop: 4 }}>
                      {progress.message}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Agents */}
      {!!agents?.length && (
        <div style={{ display: "grid", gap: 10 }}>
          <strong>AI Agents</strong>
          {agents.map((a) => {
            const isBusy = busyId === a.id;
            const showProgress = progress.id === a.id;
            return (
              <div key={a.id} className="card" style={{ padding: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{a.label}</div>
                    {a.note ? <div className="subtitle">{a.note}</div> : null}
                  </div>
                  <button
                    className="btn sm"
                    aria-busy={isBusy}
                    onClick={() => runAgent(a)}
                    disabled={isBusy || typeof a.run !== "function"}
                  >
                    <span className="label">{isBusy ? "Running…" : "Run"}</span>
                  </button>
                </div>

                {/* Optional ad-hoc payload for the agent */}
                <div style={{ marginTop: 10 }}>
                  <label style={{ fontSize: 12, fontWeight: 600, display: "block", marginBottom: 4 }}>
                    Payload (JSON)
                  </label>
                  <textarea
                    rows={3}
                    className="input"
                    style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                    value={
                      inputs[a.id]
                        ? JSON.stringify(inputs[a.id], null, 2)
                        : ""
                    }
                    onChange={(e) => {
                      const text = e.target.value;
                      try {
                        const parsed = JSON.parse(text || "null");
                        setInput(a.id, parsed || undefined);
                      } catch {
                        setInput(a.id, text);
                      }
                    }}
                    placeholder='{"force": true, "limit": 10}'
                  />
                </div>

                {/* Inline progress */}
                {showProgress ? (
                  <div style={{ marginTop: 8 }}>
                    <ProgressBar
                      value={progress.pct}
                      indeterminate={progress.indeterminate}
                      label="Agent progress"
                    />
                    {progress.message ? (
                      <div className="subtitle" style={{ marginTop: 4 }}>
                        {progress.message}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {/* Output */}
      {output && (
        <div className="card" style={{ marginTop: 16, background: "#fafafa" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontWeight: 600, marginBottom: 6, flex: 1 }}>Last Output</div>
            <button className="btn xs" onClick={copyOutput} title="Copy JSON">
              Copy
            </button>
            <button className="btn xs" onClick={downloadOutput} title="Download JSON">
              Download
            </button>
          </div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {JSON.stringify(output, null, 2)}
          </pre>
        </div>
      )}

      {/* Recent bus events */}
      {log.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Latest Events</div>
          <div style={{ display: "grid", gap: 6 }}>
            {log.slice(0, 10).map((l, i) => (
              <pre key={i} style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                {JSON.stringify(l, null, 2)}
              </pre>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
