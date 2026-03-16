
// FILE: src/components/cuisine/FeastDayMealSuggestions.jsx
import React, { useEffect, useMemo, useState } from "react";
import { getFeastDaySuggestions } from "@/services/cuisine/FeastDayMealPlanner";

export default function FeastDayMealSuggestions({ householdId = "default", cuisineKey = "aai" }) {
  const [data, setData] = useState(null);
  const [feastKey, setFeastKey] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      const d = await getFeastDaySuggestions({ householdId, cuisineKey, feastKey: null });
      if (!alive) return;
      setData(d);
      setFeastKey(d?.feastsIndex?.[0]?.key || "");
    })();
    return () => { alive = false; };
  }, [householdId, cuisineKey]);

  useEffect(() => {
    let alive = true;
    if (!feastKey) return;
    (async () => {
      const d = await getFeastDaySuggestions({ householdId, cuisineKey, feastKey });
      if (!alive) return;
      setData(d);
    })();
    return () => { alive = false; };
  }, [feastKey, householdId, cuisineKey]);

  const feast = data?.feast;

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold">Feast-day Meal Suggestions</div>
          <div className="text-xs text-[hsl(var(--text-subtle))]">
            Scripture-only refs + meal themes + prep/preservation tie-ins.
          </div>
        </div>
        <select className="border rounded px-2 py-1 text-sm" value={feastKey} onChange={(e) => setFeastKey(e.target.value)}>
          {(data?.feastsIndex || []).map((f) => (
            <option key={f.key} value={f.key}>{f.name}</option>
          ))}
        </select>
      </div>

      {feast ? (
        <div className="mt-3 space-y-3 text-sm">
          <div className="text-xs text-gray-600">{data?.notes || ""}</div>

          <div className="border rounded-lg p-3 bg-white/60">
            <div className="font-semibold">{feast.name}</div>
            <div className="text-xs text-gray-600 mt-1">
              <span className="font-semibold">Scripture refs:</span> {(feast.scriptureRefs || []).join("; ") || "—"}
            </div>
            <div className="text-xs mt-2">
              <span className="font-semibold">Themes:</span> {(feast.themes || []).join(", ") || "—"}
            </div>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <div className="border rounded-lg p-3 bg-white/60">
              <div className="font-semibold">Suggested dishes</div>
              <ul className="list-disc ml-5 mt-2 text-sm">
                {(data?.suggestions || []).map((s) => (
                  <li key={s.key}>
                    {s.name} <span className="text-xs text-gray-600">({s.primaryProtein})</span>
                  </li>
                ))}
              </ul>
              {!data?.suggestions?.length ? <div className="text-sm text-gray-600 mt-2">No dish suggestions found.</div> : null}
            </div>

            <div className="border rounded-lg p-3 bg-white/60">
              <div className="font-semibold">Prep + preservation tie-ins</div>
              <ul className="list-disc ml-5 mt-2 text-sm">
                {(data?.preservationTieIns || []).map((p) => (
                  <li key={p.key}>
                    {p.name} <span className="text-xs text-gray-600">({(p.producedBy || []).join(", ")})</span>
                  </li>
                ))}
              </ul>
              {!data?.preservationTieIns?.length ? <div className="text-sm text-gray-600 mt-2">No preservation tie-ins found.</div> : null}
            </div>
          </div>

          <div className="border rounded-lg p-3 bg-white/60">
            <div className="font-semibold">Prep suggestions</div>
            <ul className="list-disc ml-5 mt-2 text-sm">
              {(data?.prepSuggestions || []).map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
        </div>
      ) : (
        <div className="text-sm text-gray-600 mt-3">Loading…</div>
      )}
    </div>
  );
}
