
// FILE: src/components/cuisine/TechniqueOverlapView.jsx
import React, { useEffect, useMemo, useState } from "react";
import { loadCuisineCatalogs } from "@/services/cuisine/CuisineCatalogLoader";

export default function TechniqueOverlapView({ cuisineKey = "aai" }) {
  const [catalogs, setCatalogs] = useState(null);
  const [active, setActive] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const c = await loadCuisineCatalogs({ cuisineKey });
      if (!alive) return;
      setCatalogs(c);
      setActive(c?.techniqueOverlap?.overlaps?.[0]?.key || null);
    })();
    return () => { alive = false; };
  }, [cuisineKey]);

  const overlaps = catalogs?.techniqueOverlap?.overlaps || [];
  const item = useMemo(() => overlaps.find((o) => o.key === active) || overlaps[0] || null, [overlaps, active]);

  return (
    <div className="card">
      <div className="text-lg font-semibold">Technique Overlap</div>
      <div className="text-xs text-[hsl(var(--text-subtle))]">
        Fixed technique pairings for variety without randomness.
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {overlaps.map((o) => (
          <button
            key={o.key}
            type="button"
            className={`btn btn--sm ${o.key === active ? "btn--primary" : "btn--ghost"}`}
            onClick={() => setActive(o.key)}
          >
            {o.name}
          </button>
        ))}
      </div>

      {item ? (
        <div className="mt-3 border rounded-lg p-3 bg-white/60">
          <div className="font-semibold">{item.name}</div>
          <div className="text-sm mt-1">{item.why}</div>

          <div className="text-xs mt-3">
            <div><span className="font-semibold">Recommended blends:</span> {(item.recommendedBlends || []).join(", ") || "—"}</div>
            <div className="mt-1"><span className="font-semibold">Best proteins:</span> {(item.bestProteins || []).join(", ") || "—"}</div>
          </div>

          {Array.isArray(item.swapMaps) && item.swapMaps.length ? (
            <div className="text-xs mt-3">
              <div className="font-semibold">Swap map</div>
              <ul className="list-disc ml-5">
                {item.swapMaps.map((s, idx) => (
                  <li key={idx}>
                    <span className="font-semibold">{s.from}</span> → <span className="font-semibold">{s.to}</span> — {s.note}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="text-sm text-gray-600 mt-3">No overlap data found.</div>
      )}
    </div>
  );
}
