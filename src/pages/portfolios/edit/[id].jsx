// src/pages/portfolios/edit/[id].jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useVision } from "@/context/VisionContext";
import { listPacks, getPack, computeRhythmMaps } from "@/data/recipe-packs";
import WeeklyFlavorRhythmPicker from "@/components/profile/WeeklyFlavorRhythmPicker.jsx";
import { suggestFlavorOptions } from "@/types/FlavorRhythm.d";
import "@/index.css";

/* ----------------------------- Local persistence --------------------------- */
const DRAFT_PREFIX = "suka:portfolio:draft:";        // draft store per id
const MARKET_INDEX = "suka:marketplace:index";       // simple published index cache

const loadDraft = (id) => {
  try { return JSON.parse(localStorage.getItem(DRAFT_PREFIX + id) || "null"); } catch { return null; }
};
const saveDraft = (id, data) => {
  try { localStorage.setItem(DRAFT_PREFIX + id, JSON.stringify(data)); } catch {}
};
const deleteDraft = (id) => {
  try { localStorage.removeItem(DRAFT_PREFIX + id); } catch {}
};
const loadMarketIndex = () => {
  try { return JSON.parse(localStorage.getItem(MARKET_INDEX) || "[]"); } catch { return []; }
};
const saveMarketIndex = (records) => {
  try { localStorage.setItem(MARKET_INDEX, JSON.stringify(records)); } catch {}
};

/* ---------------------------------- UI bits -------------------------------- */
function Section({ title, subtitle, children, className = "" }) {
  return (
    <section className={`card ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="mb-1 text-2xl md:text-3xl font-extrabold">{title}</h2>
          {subtitle ? <p className="text-sm md:text-base text-[hsl(var(--muted-foreground))]">{subtitle}</p> : null}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
function Field({ label, hint, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-semibold">{label}</span>
      {hint ? <span className="text-xs text-[hsl(var(--muted-foreground))] -mt-0.5">{hint}</span> : null}
      <div className="mt-1">{children}</div>
    </label>
  );
}
function Segmented({ value, onChange, options = [] }) {
  return (
    <div className="inline-flex rounded-lg border overflow-hidden">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`px-3 py-1.5 text-sm ${value === opt.value ? "bg-[hsl(var(--brand))] text-white" : "bg-white hover:bg-[hsl(var(--muted))]/30"}`}
          onClick={() => onChange(opt.value)}
          title={opt.title || opt.label}
        >
          {opt.icon ? <span aria-hidden className="mr-1">{opt.icon}</span> : null}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------- Editor ---------------------------------- */
const VISIBILITY_OPTIONS = [
  { value: "private", label: "Private", icon: "🔒", title: "Only you can see this portfolio" },
  { value: "family",  label: "Family",  icon: "👪", title: "Shared with Family" },
  { value: "public",  label: "Public",  icon: "🌐", title: "Visible in marketplace" },
];

export default function PortfolioEditorPage() {
  const { id: routeId } = useParams();
  const { options: vision, key: presetKey, presets } = useVision();
  const savingRef = useRef(false);

  // Flavor suggestions (dynamic to your vision/presets)
  const flavorOptions = useMemo(() => {
    try {
      return suggestFlavorOptions({
        presetKey,
        vision: { mode: vision?.mode, goals: vision?.goals, constraints: vision?.constraints, dietary: vision?.dietary },
        presets,
      }).slice(0, 32);
    } catch {
      return ["Caribbean","Soul Food","West African","Cajun","Creole","BBQ","Herb-Garlic","Citrus-Chili","Indian","Thai","Japanese","Mediterranean"];
    }
  }, [presetKey, presets, vision?.mode, vision?.goals, vision?.constraints, vision?.dietary]);

  // Determine initial data: draft > existing pack (read-only baseline) > blank
  const [loading, setLoading] = useState(true);
  const [baseline, setBaseline] = useState(null); // from getPack or null
  const [allPacks, setAllPacks] = useState([]);
  const [form, setForm] = useState(() => ({
    id: routeId,
    title: "",
    description: "",
    cover: "",
    tags: [],
    flavor_profile: [],
    weeklyFlavorRhythm: {},          // NEW: stored on the portfolio
    visibility: "private",           // NEW: "private" | "family" | "public"
    _meta: { updatedAt: Date.now() },
  }));

  // For rhythm conversion or displays if needed later
  const rhythmCtx = useMemo(() => computeRhythmMaps({ weeklyFlavorRhythm: form.weeklyFlavorRhythm }), [form.weeklyFlavorRhythm]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        // Load marketplace inventory & existing packs for uniqueness checks
        const packs = await listPacks({ vision });
        if (!alive) return;
        setAllPacks(packs);

        // Draft first
        const draft = loadDraft(routeId);
        if (draft) {
          setBaseline(null);
          setForm({ ...draft, id: routeId });
          return;
        }
        // Try load an existing pack as baseline (read-only fields will prefill)
        try {
          const pack = await getPack(routeId, { vision, applyRhythm: false });
          if (!alive) return;
          setBaseline(pack);
          // Prefill title/description/tags/flavors if empty
          setForm((p) => ({
            ...p,
            id: routeId,
            title: p.title || pack?.title || routeId,
            description: p.description || pack?.description || "",
            cover: p.cover || pack?.cover || "",
            tags: p.tags?.length ? p.tags : (pack?.tags || []),
            flavor_profile: p.flavor_profile?.length ? p.flavor_profile : (Array.isArray(pack?.flavor_profile) ? pack.flavor_profile : []),
          }));
        } catch {
          // New/blank portfolio
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  // Dirty detection
  const draftRef = useRef(form);
  useEffect(() => { draftRef.current = form; }, [form]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setDirty(true);
    const t = setTimeout(() => {
      if (!savingRef.current) saveDraft(routeId, draftRef.current);
    }, 350);
    return () => clearTimeout(t);
  }, [routeId, form]);

  // Keyboard shortcut save
  useEffect(() => {
    const onKey = (e) => {
      const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault(); doSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  const toast = (type, message) => window.dispatchEvent(new CustomEvent("toast", { detail: { type, message } }));

  /* -------------------------------- Actions -------------------------------- */
  const doSave = () => {
    savingRef.current = true;
    try {
      const payload = { ...form, _meta: { ...(form._meta || {}), updatedAt: Date.now() } };
      saveDraft(routeId, payload);
      setForm(payload);
      setDirty(false);
      toast("success", "Draft saved.");
    } finally {
      savingRef.current = false;
    }
  };

  const doDeleteDraft = () => {
    if (!confirm("Delete this draft? This cannot be undone.")) return;
    deleteDraft(routeId);
    toast("success", "Draft deleted.");
    window.history.back();
  };

  const runUniquenessCheck = (payload) => {
    const market = loadMarketIndex(); // [{id,title,visibility}, ...]
    const titleLC = String(payload.title || "").trim().toLowerCase();
    const idLC = String(payload.id || "").trim().toLowerCase();

    // 1) check against current packs (file-based) by id/title
    const clashes = [];
    allPacks.forEach((m) => {
      if (!m) return;
      if (String(m.id || "").trim().toLowerCase() === idLC) clashes.push({ kind: "id", with: m.id });
      if (String(m.title || "").trim().toLowerCase() === titleLC) clashes.push({ kind: "title", with: m.title });
    });

    // 2) check against marketplace index
    market.forEach((rec) => {
      if (String(rec.id || "").trim().toLowerCase() === idLC) clashes.push({ kind: "id", with: rec.id });
      if (String(rec.title || "").trim().toLowerCase() === titleLC) clashes.push({ kind: "title", with: rec.title });
    });

    return { ok: clashes.length === 0, clashes };
  };

  const doPublish = () => {
    const payload = {
      ...form,
      id: form.id || routeId,
      title: form.title?.trim(),
      visibility: form.visibility,
      weeklyFlavorRhythm: form.weeklyFlavorRhythm || {},
      flavor_profile: form.flavor_profile || [],
      tags: form.tags || [],
      cover: form.cover || "",
      description: form.description || "",
      _meta: { ...(form._meta || {}), updatedAt: Date.now(), source: "editor" },
    };

    if (!payload.title) { toast("error", "Title is required."); return; }

    // visibility gate
    if (payload.visibility !== "public") {
      toast("error", "Set visibility to Public to publish to the marketplace.");
      return;
    }

    // uniqueness
    const { ok, clashes } = runUniquenessCheck(payload);
    if (!ok) {
      const msg = clashes.map(c => (c.kind === "id" ? `ID “${c.with}”` : `Title “${c.with}”`)).join(", ");
      toast("error", `Uniqueness check failed: ${msg}`);
      return;
    }

    // "Publish" = append to marketplace index (demo stub) + emit event hook
    const market = loadMarketIndex();
    const record = {
      id: payload.id,
      title: payload.title,
      visibility: payload.visibility,
      cover: payload.cover || null,
      flavors: payload.flavor_profile || [],
      matchesRhythm: Boolean(Object.values(payload.weeklyFlavorRhythm || {}).some((v) => Array.isArray(v) && v.length)),
      updatedAt: Date.now(),
    };
    saveMarketIndex([record, ...market.filter((r) => r.id !== record.id)]);
    window.dispatchEvent(new CustomEvent("marketplace:publish", { detail: { portfolio: payload } }));
    toast("success", "Published to marketplace.");
    setDirty(false);
  };

  /* --------------------------------- Render -------------------------------- */
  if (loading) {
    return (
      <div className="card">
        <div className="h-6 w-40 skeleton rounded mb-2" />
        <div className="h-10 w-full skeleton rounded" />
        <div className="mt-3 h-48 w-full skeleton rounded" />
      </div>
    );
  }

  return (
    <div className="space-y-6 w-full">
      <Section
        title="Edit Portfolio"
        subtitle="Describe your collection and align it with a weekly flavor rhythm for smarter recommendations."
      >
        <form className="grid gap-4" onSubmit={(e) => e.preventDefault()}>
          {/* Head */}
          <div className="grid gap-3" style={{ gridTemplateColumns: "1.2fr 0.8fr" }}>
            <Field label="Title" hint="Keep it short and distinctive.">
              <input className="control" value={form.title} onChange={(e) => setForm((p) => ({ ...p, title: e.target.value }))} placeholder="e.g., Caribbean Light" />
            </Field>
            <Field label="Visibility" hint="Choose who can discover this portfolio.">
              <Segmented
                value={form.visibility}
                onChange={(v) => setForm((p) => ({ ...p, visibility: v }))}
                options={VISIBILITY_OPTIONS}
              />
            </Field>
          </div>

          <Field label="Description" hint="What’s the goal of this collection?">
            <textarea className="control control--textarea" rows={4} value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} />
          </Field>

          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="Cover Image URL" hint="Optional; square or 16:9 works well.">
              <input className="control" value={form.cover} onChange={(e) => setForm((p) => ({ ...p, cover: e.target.value }))} placeholder="https://…" />
            </Field>
            <div className="flex items-end">
              {form.cover ? (
                <img src={form.cover} alt="" className="h-16 w-28 object-cover rounded border" />
              ) : (
                <div className="h-16 w-28 rounded border grid place-items-center text-xs text-[hsl(var(--muted-foreground))]">No cover</div>
              )}
            </div>
          </div>

          <div className="grid gap-3" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <Field label="Tags (comma separated)" hint="e.g., palette:caribbean, speed:weeknight, diet:no-pork">
              <input
                className="control"
                value={form.tags.join(", ")}
                onChange={(e) => setForm((p) => ({ ...p, tags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }))}
                placeholder="palette:caribbean, speed:weeknight"
              />
            </Field>
            <Field label="Flavor Profile (comma separated)" hint="Broad flavor cues to help recommendations.">
              <input
                className="control"
                value={form.flavor_profile.join(", ")}
                onChange={(e) => setForm((p) => ({ ...p, flavor_profile: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }))}
                placeholder="Caribbean, Citrus-Chili, Herb-Garlic"
              />
            </Field>
          </div>

          {/* Weekly Flavor Rhythm (NEW) */}
          <div className="rounded-xl border p-3 bg-white">
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="text-base font-semibold">Weekly Flavor Rhythm</div>
                <div className="text-xs text-[hsl(var(--muted-foreground))]">Pick flavors for Mon–Sun. Use “Apply to all” inside the picker for quick fill.</div>
              </div>
            </div>
            <WeeklyFlavorRhythmPicker
              value={form.weeklyFlavorRhythm || {}}
              options={flavorOptions}
              onChange={(val) => setForm((p) => ({ ...p, weeklyFlavorRhythm: val }))}
            />
          </div>

          {/* Footer actions */}
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <button type="button" className="btn primary" onClick={doSave} title="Save (Ctrl/Cmd+S)" disabled={!dirty}>
              <span className="label">{dirty ? "Save" : "Saved"}</span>
            </button>
            <button type="button" className="btn" onClick={() => setForm((p) => ({ ...p, visibility: p.visibility === "public" ? "public" : "public" }))}>
              <span className="label">Set Public</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={doPublish}
              title="Publish to Marketplace (performs uniqueness check)"
              disabled={!form.title || form.visibility !== "public"}
            >
              <span className="label">Publish to Marketplace</span>
            </button>
            <button type="button" className="btn subtle" onClick={doDeleteDraft}>
              <span className="label">Delete Draft</span>
            </button>

            <span className="ml-auto text-xs text-[hsl(var(--muted-foreground))]">
              {baseline ? "Based on existing pack: " + (baseline.title || baseline.id) : "New portfolio"}
            </span>
          </div>
        </form>
      </Section>

      {/* Preview helpers */}
      <Section title="Live Preview Helpers" subtitle="Not saved—just a quick peek of how your rhythm reads.">
        <div className="text-sm text-[hsl(var(--muted-foreground))]">
          {Object.values(rhythmCtx.gregMap || {}).some((arr) => (arr || []).length)
            ? "Rhythm set for at least one day."
            : "No flavors selected yet."}
        </div>
      </Section>
    </div>
  );
}
