// File: src/components/planning/PatternPicker.jsx
"use client";

import React, { useEffect, useMemo, useState } from "react";
import LayerAssetLoader from "../../layers/loaders/LayerAssetLoader.js";

const loader = new LayerAssetLoader({ devHotReload: import.meta?.env?.DEV });

export default function PatternPicker({ domain = "meals", onPick }) {
  const [ready, setReady] = useState(false);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [items, setItems] = useState([]);

  useEffect(() => {
    let mounted = true;
    loader.ensureLoaded().then(() => {
      if (!mounted) return;
      setReady(true);
      // Search all patterns for this domain initially
      const res = loader.searchCatalog?.({ domain, tags: [] }) || [];
      setItems(res);
    });
    return () => (mounted = false);
  }, [domain]);

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    const tagQ = tag.trim().toLowerCase();

    return (items || []).filter((p) => {
      if (!p) return false;
      const title = String(p.title || "").toLowerCase();
      const id = String(p.id || "").toLowerCase();
      const tags = (p.intentTags || []).map((t) => String(t).toLowerCase());

      const qOk = !query || title.includes(query) || id.includes(query);
      const tagOk = !tagQ || tags.some((t) => t.includes(tagQ));
      return qOk && tagOk;
    });
  }, [items, q, tag]);

  return (
    <div className="mt-3">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <input
          className="rounded-xl border p-2 text-sm"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search title or ID…"
        />
        <input
          className="rounded-xl border p-2 text-sm"
          value={tag}
          onChange={(e) => setTag(e.target.value)}
          placeholder="Filter by tag… (time:, difficulty:, equipment:)"
        />
      </div>

      {!ready ? (
        <p className="mt-3 text-xs opacity-70">Loading patterns…</p>
      ) : (
        <div className="mt-3 max-h-[260px] overflow-auto border rounded-xl">
          {(filtered || []).slice(0, 50).map((p) => (
            <button
              key={p.id}
              className="w-full text-left px-3 py-2 border-b last:border-b-0 hover:bg-slate-50"
              onClick={() => onPick?.(p.id)}
            >
              <div className="text-sm font-semibold">{p.title || p.id}</div>
              <div className="text-xs opacity-70">{p.id}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {(p.intentTags || []).slice(0, 6).map((t) => (
                  <span key={t} className="text-[10px] px-2 py-0.5 rounded-full border">
                    {t}
                  </span>
                ))}
              </div>
            </button>
          ))}
          {!filtered?.length ? (
            <div className="p-3 text-xs opacity-70">No patterns match.</div>
          ) : null}
        </div>
      )}
    </div>
  );
}
