// File: src/components/planning/PlanPreview.jsx
"use client";

import React, { useMemo, useState } from "react";

export default function PlanPreview({ payload }) {
  const [expanded, setExpanded] = useState(true);

  const sessions = useMemo(() => payload?.blueprints?.sessions || [], [payload]);
  const why = useMemo(() => payload?.resolution?.why || [], [payload]);
  const leanHints = useMemo(() => payload?.lean?.recommendations?.countermeasureHints || [], [payload]);

  if (!payload) {
    return (
      <div className="rounded-2xl border bg-white p-4 shadow-sm">
        <h2 className="text-lg font-bold">Plan preview</h2>
        <p className="text-sm opacity-70 mt-1">Run a plan to see sessions, shopping deltas, and inventory moves.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">Plan preview</h2>
          <p className="text-sm opacity-70">Payload ID: {payload.id}</p>
        </div>
        <button className="px-3 py-2 rounded-xl border text-sm" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>

      {!expanded ? null : (
        <>
          <section className="mt-4">
            <h3 className="text-sm font-bold">Recommended plan (and why)</h3>
            <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-3">
              {why.slice(0, 4).map((w) => (
                <div key={w.patternId} className="rounded-xl border p-3">
                  <div className="text-sm font-semibold">{w.patternId}</div>
                  <div className="text-xs opacity-70">Score: {Number(w.score || 0).toFixed(2)}</div>
                  <ul className="mt-2 list-disc pl-5 text-xs">
                    {(w.reasons || []).slice(0, 6).map((r, idx) => <li key={idx}>{r}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-4">
            <h3 className="text-sm font-bold">Sessions that will be created</h3>
            <div className="mt-2 grid grid-cols-1 gap-3">
              {sessions.map((s) => (
                <div key={s.id} className="rounded-xl border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold">{s.title}</div>
                      <div className="text-xs opacity-70">{s.domain} • source {s.sourcePatternId}</div>
                    </div>
                    <span className="text-[10px] px-2 py-0.5 rounded-full border">
                      {s.steps?.length || 0} steps
                    </span>
                  </div>

                  <div className="mt-2">
                    <details>
                      <summary className="text-xs cursor-pointer">View steps</summary>
                      <ol className="mt-2 list-decimal pl-5 text-xs">
                        {(s.steps || []).slice(0, 12).map((st) => (
                          <li key={st.id}>
                            <span className="font-semibold">{st.title}</span>
                            {st.etaSec ? <span className="opacity-70"> • ~{Math.round(st.etaSec/60)} min</span> : null}
                          </li>
                        ))}
                      </ol>
                    </details>
                  </div>
                </div>
              ))}
              {!sessions.length ? <p className="text-xs opacity-70">No sessions generated.</p> : null}
            </div>
          </section>

          <section className="mt-4">
            <h3 className="text-sm font-bold">Shopping list delta</h3>
            <div className="mt-2 rounded-xl border p-3 text-xs">
              <pre className="whitespace-pre-wrap">{JSON.stringify(payload?.blueprints?.shoppingDelta || [], null, 2)}</pre>
            </div>
          </section>

          <section className="mt-4">
            <h3 className="text-sm font-bold">Inventory moves</h3>
            <div className="mt-2 rounded-xl border p-3 text-xs">
              <pre className="whitespace-pre-wrap">{JSON.stringify(payload?.blueprints?.inventoryMoves || [], null, 2)}</pre>
            </div>
          </section>

          {leanHints.length ? (
            <section className="mt-4">
              <h3 className="text-sm font-bold">Lean notes (optional)</h3>
              <ul className="mt-2 list-disc pl-5 text-xs">
                {leanHints.slice(0, 8).map((h, idx) => (
                  <li key={idx}>
                    <span className="font-semibold">{h.hintTag}:</span> {h.reason}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="mt-4 flex gap-2 flex-wrap">
            <button className="px-3 py-2 rounded-xl bg-black text-white text-sm font-semibold"
              onClick={() => {
                // Commit hook: in your SSA, this should persist session blueprints + open SessionRunner.
                // Here we emit a DOM event for minimal integration.
                window.dispatchEvent(new CustomEvent("planning.commit", { detail: payload }));
                alert("Commit event emitted: planning.commit (wire to your SessionRunner).");
              }}
            >
              Build Sessions
            </button>
            <button className="px-3 py-2 rounded-xl border text-sm"
              onClick={() => navigator.clipboard?.writeText(JSON.stringify(payload, null, 2))}
            >
              Copy payload
            </button>
          </div>
        </>
      )}
    </div>
  );
}
