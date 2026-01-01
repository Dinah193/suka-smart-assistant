
// FILE: src/components/cuisine/CuisineExplainPanel.jsx
import React from "react";

export default function CuisineExplainPanel({ selection }) {
  if (!selection) return null;
  const ex = selection.explain || {};
  const top = ex.topCandidates || [];

  return (
    <div className="card">
      <div className="text-lg font-semibold">Why this meal was selected</div>
      <div className="text-xs text-[hsl(var(--text-subtle))]">
        Traceable selection: rhythm → constraints → rotation → pick.
      </div>

      <div className="mt-3 text-sm">
        <div className="font-semibold">{selection.dishName || "—"}</div>
        <div className="text-xs text-gray-600">
          Mode: {ex.mode || "—"} • Date: {selection.date || "—"}
        </div>
      </div>

      <div className="mt-3 grid md:grid-cols-2 gap-3 text-sm">
        <div className="border rounded-lg p-3 bg-white/60">
          <div className="font-semibold">Constraints</div>
          <div className="text-xs mt-1">
            Diet: <span className="font-semibold">{ex.constraints?.dietMode || "normal"}</span>
          </div>
          <div className="text-xs mt-1">
            Preferred proteins: {(ex.constraints?.preferredProteins || []).join(", ") || "—"}
          </div>
          <div className="text-xs mt-1">
            Dislikes: {(ex.constraints?.dislikedIngredients || []).join(", ") || "—"}
          </div>
        </div>

        <div className="border rounded-lg p-3 bg-white/60">
          <div className="font-semibold">Rotation state</div>
          <div className="text-xs mt-1">Week index: {ex.rotation?.weekIndex ?? "—"}</div>
          <div className="text-xs mt-1">Last protein: {ex.rotation?.proteinLast || "—"}</div>
          <div className="text-xs mt-1">Last technique: {ex.rotation?.techniqueLast || "—"}</div>
          <div className="text-xs mt-1">Last spice: {ex.rotation?.spiceLast || "—"}</div>
        </div>
      </div>

      {ex.rhythm ? (
        <div className="mt-3 border rounded-lg p-3 bg-white/60 text-sm">
          <div className="font-semibold">Rhythm hint</div>
          <div className="text-xs mt-1">
            Technique hint: {ex.rhythm.techniqueHint || "—"} • Tags: {(ex.rhythm.tagsAny || []).join(", ") || "—"}
          </div>
        </div>
      ) : null}

      {top.length ? (
        <div className="mt-3 border rounded-lg p-3 bg-white/60">
          <div className="font-semibold">Top candidates</div>
          <div className="text-xs text-gray-600">Higher score means stronger match.</div>
          <ul className="mt-2 text-sm space-y-1">
            {top.map((t) => (
              <li key={t.key} className="flex items-center justify-between">
                <span className="font-mono text-xs">{t.key}</span>
                <span className="text-xs">{Number(t.score).toFixed(2)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
