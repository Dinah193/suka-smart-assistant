
// FILE: src/components/cuisine/SpiceFlavorMatrixView.jsx
import React, { useEffect, useMemo, useState } from "react";
import { loadCuisineCatalogs } from "@/services/cuisine/CuisineCatalogLoader";

export default function SpiceFlavorMatrixView({ cuisineKey = "aai" }) {
  const [catalogs, setCatalogs] = useState(null);
  const [q, setQ] = useState("");
  const [heat, setHeat] = useState("any");

  useEffect(() => {
    let alive = true;
    (async () => {
      const c = await loadCuisineCatalogs({ cuisineKey });
      if (!alive) return;
      setCatalogs(c);
    })();
    return () => { alive = false; };
  }, [cuisineKey]);

  const blends = catalogs?.spiceMatrix?.blends || [];
  const filtered = useMemo(() => {
    const qq = String(q || "").toLowerCase().trim();
    return blends.filter((b) => {
      if (heat !== "any" && b.heat !== heat) return false;
      if (!qq) return true;
      const hay = `${b.name} ${b.key} ${(b.ingredients || []).join(" ")} ${(b.notes || "")}`.toLowerCase();
      return hay.includes(qq);
    });
  }, [blends, q, heat]);

  return (
    <div className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-lg font-semibold">Spice & Flavor Matrix</div>
          <div className="text-xs text-[hsl(var(--text-subtle))]">
            Browse fixed blends and see recommended proteins, techniques, and sides.
          </div>
        </div>
        <div className="flex gap-2">
          <input
            className="border rounded px-2 py-1 text-sm"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search blends…"
          />
          <select className="border rounded px-2 py-1 text-sm" value={heat} onChange={(e) => setHeat(e.target.value)}>
            <option value="any">Any heat</option>
            <option value="none">none</option>
            <option value="mild">mild</option>
            <option value="medium">medium</option>
            <option value="hot">hot</option>
          </select>
        </div>
      </div>

      <div className="mt-3 grid md:grid-cols-2 gap-3">
        {filtered.map((b) => (
          <div key={b.key} className="border rounded-lg p-3 bg-white/60">
            <div className="flex items-center justify-between">
              <div className="font-semibold">{b.name}</div>
              <span className="text-xs px-2 py-1 rounded-full border">{b.heat}</span>
            </div>
            {b.notes ? <div className="text-xs text-gray-600 mt-1">{b.notes}</div> : null}
            <div className="text-xs mt-2">
              <div><span className="font-semibold">Ingredients:</span> {(b.ingredients || []).join(", ")}</div>
              <div className="mt-1"><span className="font-semibold">Proteins:</span> {(b.affinities?.proteins || []).join(", ") || "—"}</div>
              <div className="mt-1"><span className="font-semibold">Techniques:</span> {(b.affinities?.techniques || []).join(", ") || "—"}</div>
              <div className="mt-1"><span className="font-semibold">Sides:</span> {(b.affinities?.sides || []).join(", ") || "—"}</div>
              <div className="mt-1"><span className="font-semibold">Sauces:</span> {(b.affinities?.sauces || []).join(", ") || "—"}</div>
            </div>
          </div>
        ))}
      </div>

      {!filtered.length ? (
        <div className="text-sm text-gray-600 mt-3">No blends match your filter.</div>
      ) : null}
    </div>
  );
}
