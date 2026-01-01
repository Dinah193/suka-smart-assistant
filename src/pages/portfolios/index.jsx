// src/pages/portfolios/index.jsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import { useVision } from "@/context/VisionContext";
import {
  listPacks,
  recommendPacks,
  formatMatchesHint,
  computeRhythmMaps,
  getPack,
  matchingDaysForPack,
} from "@/data/recipe-packs";
import "@/index.css";

/* -------------------------------- UI Atoms -------------------------------- */
function Section({ title, subtitle, children, className = "" }) {
  return (
    <section className={`card ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="mb-1 text-2xl md:text-3xl font-extrabold">{title}</h2>
          {subtitle ? (
            <p className="text-sm md:text-base text-[hsl(var(--muted-foreground))]">{subtitle}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Chip({ children, title, onClick, active }) {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag
      className={`chip ${active ? "chip--active" : ""}`}
      title={title}
      onClick={onClick}
      style={onClick ? { cursor: "pointer" } : undefined}
    >
      {children}
    </Tag>
  );
}

/* --------------------------- Rhythm Strip (Mon–Sun) ------------------------ */
const GREG_KEYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
const SHORT = { monday:"Mon", tuesday:"Tue", wednesday:"Wed", thursday:"Thu", friday:"Fri", saturday:"Sat", sunday:"Sun" };
const SHORT_TO_KEY = { Mon:"monday", Tue:"tuesday", Wed:"wednesday", Thu:"thursday", Fri:"friday", Sat:"saturday", Sun:"sunday" };

function MiniRhythmStrip({ activeDays = [], className = "", title = "Weekly Flavor Rhythm match" }) {
  const set = new Set(activeDays);
  return (
    <div className={`flex items-center gap-1 ${className}`} aria-label={title}>
      {GREG_KEYS.map((k) => (
        <div
          key={k}
          className={`inline-flex items-center justify-center rounded-[6px] border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums
            ${set.has(k) ? "bg-[hsl(var(--brand))]/10 border-[hsl(var(--brand))] text-[hsl(var(--brand))]" : "bg-[hsl(var(--muted))]/20 border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]"}`}
          title={`${SHORT[k]} ${set.has(k) ? "• matches" : ""}`}
          aria-pressed={set.has(k)}
        >
          {SHORT[k][0]}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------- Favorite hook/store -------------------------- */
const FAV_KEY = "suka:myPortfolios";
function readFavs() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) || "[]"); } catch { return []; }
}
function writeFavs(ids) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(Array.from(new Set(ids)))); } catch {}
}
function useMyPortfolios() {
  const [ids, setIds] = useState(readFavs);
  const add = useCallback((id) => setIds((p) => { const n = Array.from(new Set([...(p||[]), id])); writeFavs(n); return n; }), []);
  const remove = useCallback((id) => setIds((p) => { const n = (p||[]).filter((x) => x !== id); writeFavs(n); return n; }), []);
  const toggle = useCallback((id) => setIds((p) => {
    const s = new Set(p || []);
    if (s.has(id)) { s.delete(id); const n = Array.from(s); writeFavs(n); return n; }
    s.add(id); const n = Array.from(s); writeFavs(n); return n;
  }), []);
  useEffect(() => {
    const onStorage = (e) => { if (e.key === FAV_KEY) setIds(readFavs()); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  return { ids, add, remove, toggle };
}

/* ---------------------------- Portfolio Card ------------------------------- */
function PortfolioCard({ manifest, daysActiveKeys = [], onOpen, onPlan, isFavorite, onToggleFavorite }) {
  const { title, description, tags = [], flavors = [], cover } = manifest || {};
  const primaryTags = tags.filter(t => /^palette:|^batch:|^speed:|^diet:|^light:|^prep:/.test(t)).slice(0, 4);
  return (
    <article className="card hover:shadow-sm transition">
      <div className="space-y-2">
        <div className="relative">
          {cover ? (
            <img className="w-full aspect-[16/9] object-cover rounded-md" src={cover} alt="" />
          ) : (
            <div className="w-full aspect-[16/9] grid place-items-center rounded-md bg-[hsl(var(--muted))]/30 text-lg font-bold">
              {(title || "Pack").split(/\s+/).slice(0,2).map(s=>s[0]?.toUpperCase()).join("")}
            </div>
          )}
          <button
            className={`absolute right-2 top-2 btn sm ${isFavorite ? "primary" : ""}`}
            aria-pressed={!!isFavorite}
            title={isFavorite ? "Remove from My Portfolios" : "Add to My Portfolios"}
            onClick={onToggleFavorite}
          >
            <span aria-hidden>{isFavorite ? "♥" : "♡"}</span>
          </button>
        </div>

        <header className="flex items-start justify-between gap-2">
          <div className="text-base md:text-lg font-bold">{title}</div>
        </header>

        <MiniRhythmStrip daysActiveKeys={daysActiveKeys} activeDays={daysActiveKeys} className="mt-1" />

        {description ? (
          <p className="text-sm text-[hsl(var(--muted-foreground))] line-clamp-3">{description}</p>
        ) : null}

        <div className="flex flex-wrap gap-1.5">
          {primaryTags.map((t) => (
            <Chip key={t} title={t}>{t.replace(/^[a-z]+:/, "")}</Chip>
          ))}
          {flavors.slice(0, 4).map((f) => (
            <Chip key={f} title={`Flavor: ${f}`}>{f}</Chip>
          ))}
          {flavors.length > 4 ? (
            <span className="text-xs text-[hsl(var(--muted-foreground))]">+{flavors.length - 4}</span>
          ) : null}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button className="btn sm primary" onClick={onOpen}><span className="label">Open Pack</span></button>
          <button className="btn sm" onClick={onPlan}><span className="label">Generate Plan</span></button>
        </div>
      </div>
    </article>
  );
}

/* --------------------------------- Page ----------------------------------- */
const DEFAULT_FILTERS = [
  { id: "all", label: "All" },
  { id: "batch", label: "Batch Sunday" },
  { id: "weeknight", label: "Weeknights" },
  { id: "light", label: "Light & Lean" },
  { id: "caribbean", label: "Caribbean" },
  { id: "soul", label: "Soul Food" },
  { id: "curry", label: "Curry Lovers" },
];

export default function PortfoliosPage() {
  const { options: vision = {} } = useVision();
  const { gregMap, weekSet } = useMemo(() => computeRhythmMaps(vision || {}), [vision]);

  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState("all");
  const [manifests, setManifests] = useState([]);
  const [recs, setRecs] = useState([]);
  const [busy, setBusy] = useState(true);

  const { ids: favIds, toggle: toggleFav } = useMyPortfolios();
  const [favManifests, setFavManifests] = useState([]);
  const [favDaysMap, setFavDaysMap] = useState({}); // id -> greg keys array

  /* Load library + recs */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setBusy(true);
        const [all, recommended] = await Promise.all([
          listPacks({ vision }),
          recommendPacks({ vision, query: "" }),
        ]);
        if (!alive) return;
        setManifests(all);
        setRecs(recommended);
      } finally {
        if (alive) setBusy(false);
      }
    })();
    return () => { alive = false; };
  }, [vision]);

  /* Resolve favorites -> manifests + exact day matches */
  useEffect(() => {
    let alive = true;
    (async () => {
      // Build minimal manifest list first (cheap)
      const idSet = new Set(favIds || []);
      const favM = (await listPacks({ vision })).filter((m) => idSet.has(m.id));
      if (!alive) return;
      setFavManifests(favM);

      // Load each pack JSON to compute exact matching days (Mon..Sun keys)
      const pairs = await Promise.all(
        (favIds || []).map(async (id) => {
          try {
            const pack = await getPack(id, { vision, applyRhythm: false });
            const days = gregMap ? matchingDaysForPack(pack, gregMap) : [];
            return [id, days];
          } catch {
            return [id, []];
          }
        })
      );
      if (!alive) return;
      const map = {};
      pairs.forEach(([id, days]) => { map[id] = days; });
      setFavDaysMap(map);
    })();
    return () => { alive = false; };
  }, [favIds, vision, gregMap]);

  /* Filtering + search */
  const lc = (s) => String(s || "").toLowerCase();
  const matchesFilter = (m) => {
    if (activeFilter === "all") return true;
    const tagHay = (m.tags || []).join(" ").toLowerCase();
    const flavorHay = (m.flavors || []).join(" ").toLowerCase();
    switch (activeFilter) {
      case "batch": return /batch:|batch\s*sunday/.test(tagHay);
      case "weeknight": return /speed:weeknight/.test(tagHay);
      case "light": return /light:lean/.test(tagHay);
      case "caribbean": return tagHay.includes("palette:caribbean") || flavorHay.includes("caribbean");
      case "soul": return tagHay.includes("palette:soul-food") || flavorHay.includes("soul food");
      case "curry": return tagHay.includes("palette:curry") || /indian|thai|curry/.test(flavorHay);
      default: return true;
    }
  };
  const matchesText = (m) => {
    if (!query) return true;
    const hay = lc(`${m.title} ${m.description} ${(m.tags || []).join(" ")} ${(m.flavors || []).join(" ")}`);
    return hay.includes(lc(query));
  };

  const filtered = useMemo(
    () => manifests.filter((m) => matchesFilter(m) && matchesText(m)),
    [manifests, activeFilter, query]
  );

  /* Actions */
  const openPack = (id) => {
    window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "RecipePackViewer", params: { id } } }));
  };
  const planWithPack = (manifest) => {
    const flavors = (manifest.flavors || []).slice(0, 5).join(", ");
    const rhythm = weekSet && weekSet.size ? ` Respect weekly flavor rhythm (${Array.from(weekSet).slice(0, 4).join(", ")}).` : "";
    const prompt = `Use recipes from the "${manifest.title}" pack (${flavors}).${rhythm}`;
    window.dispatchEvent(new CustomEvent("mealplanner:generate", {
      detail: { prompt, duration: "7-day", useInventory: true, sourcePack: manifest.id },
    }));
    window.dispatchEvent(new CustomEvent("ui:navigate", {
      detail: { route: "MealPlanningPage", params: { prefillPrompt: prompt } },
    }));
  };

  const daysFromHintToKeys = (hint) => {
    if (!hint) return [];
    const days = hint.replace(/^Matches\s+/i, "").split(/[\/\s+]/).filter(Boolean);
    return days.map((abbr) => SHORT_TO_KEY[abbr]).filter(Boolean);
  };

  /* Layout */
  return (
    <div className="space-y-6 w-full">
      {/* ===================== My Portfolios (favorites) ===================== */}
      <Section
        title="My Portfolios"
        subtitle="Your saved collections at a glance. Mini rhythm strips show which days they fit this week."
      >
        {favIds.length === 0 ? (
          <div className="rounded-lg border p-4 bg-white text-sm text-[hsl(var(--muted-foreground))]">
            You haven’t saved any portfolios yet. Use the ♥ on any card below to add here.
          </div>
        ) : (
          <div
            className="grid gap-3 md:gap-4"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}
          >
            {favManifests.map((m) => (
              <PortfolioCard
                key={m.id}
                manifest={m}
                daysActiveKeys={favDaysMap[m.id] || []}
                isFavorite
                onToggleFavorite={() => toggleFav(m.id)}
                onOpen={() => openPack(m.id)}
                onPlan={() => planWithPack(m)}
              />
            ))}
          </div>
        )}
      </Section>

      {/* ===================== Discovery / Recommended ===================== */}
      <Section title="Portfolios" subtitle="Curated collections that play nicely with your weekly rhythm.">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative grow md:grow-0">
            <input
              className="control"
              placeholder="Search collections…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search portfolios"
              style={{ minWidth: 240 }}
            />
          </div>

          <div className="flex flex-wrap gap-1">
            {DEFAULT_FILTERS.map((f) => (
              <Chip key={f.id} onClick={() => setActiveFilter(f.id)} active={activeFilter === f.id} title={f.label}>
                {f.label}
              </Chip>
            ))}
          </div>

          <div className="ml-auto text-xs text-[hsl(var(--muted-foreground))] flex items-center gap-2">
            <span>Rhythm:</span>
            {weekSet && weekSet.size ? (
              <div className="flex flex-wrap gap-1">
                {Array.from(weekSet).slice(0, 5).map((f) => (
                  <Chip key={`rhythm-${f}`} title={`In weekly rhythm: ${f}`}>{f}</Chip>
                ))}
                {weekSet.size > 5 ? <span className="text-[hsl(var(--muted-foreground))]">+{weekSet.size - 5}</span> : null}
              </div>
            ) : (
              <span className="text-[hsl(var(--muted-foreground))]">not set</span>
            )}
          </div>
        </div>

        {/* Recommended */}
        <div className="mt-4">
          <div className="text-sm font-semibold mb-2">Recommended for your week</div>
          <div
            className="grid gap-3 md:gap-4"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}
          >
            {(busy ? Array.from({ length: 4 }) : recs).map((m, i) => {
              if (busy) {
                return (
                  <article key={`sk-${i}`} className="card">
                    <div className="w-full aspect-[16/9] rounded-md skeleton" />
                    <div className="mt-2 h-5 w-2/3 skeleton rounded" />
                    <div className="mt-2 h-10 w-full skeleton rounded" />
                  </article>
                );
              }
              const activeKeys = daysFromHintToKeys(m.matchesHint);
              const isFavorite = favIds.includes(m.id);
              return (
                <PortfolioCard
                  key={m.id || i}
                  manifest={m}
                  daysActiveKeys={activeKeys}
                  isFavorite={isFavorite}
                  onToggleFavorite={() => toggleFav(m.id)}
                  onOpen={() => openPack(m.id)}
                  onPlan={() => planWithPack(m)}
                />
              );
            })}
          </div>
        </div>

        {/* All collections */}
        <div className="mt-6">
          <div className="text-sm font-semibold mb-2">
            {busy ? "Loading collections…" : `All Collections (${filtered.length})`}
          </div>
          <div
            className="grid gap-3 md:gap-4"
            style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}
          >
            {(busy ? Array.from({ length: 8 }) : filtered).map((m, i) => {
              if (busy) {
                return (
                  <article key={`sk2-${i}`} className="card">
                    <div className="w-full aspect-[16/9] rounded-md skeleton" />
                    <div className="mt-2 h-5 w-2/3 skeleton rounded" />
                    <div className="mt-2 h-10 w-full skeleton rounded" />
                  </article>
                );
              }
              const activeKeys = daysFromHintToKeys(m.matchesHint);
              const isFavorite = favIds.includes(m.id);
              return (
                <PortfolioCard
                  key={m.id || i}
                  manifest={m}
                  daysActiveKeys={activeKeys}
                  isFavorite={isFavorite}
                  onToggleFavorite={() => toggleFav(m.id)}
                  onOpen={() => openPack(m.id)}
                  onPlan={() => planWithPack(m)}
                />
              );
            })}
          </div>
        </div>
      </Section>

      {/* Handy jump actions */}
      <Section title="Jump to Tools" subtitle="Plan, schedule, and shop from your portfolios.">
        <div className="flex flex-wrap gap-2">
          <button
            className="btn"
            onClick={() => window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "MealPlanningPage" } }))}
          >
            <span className="label">Meal Planning Command Center</span>
          </button>
          <button
            className="btn"
            onClick={() => window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "ProcurementReport" } }))}
          >
            <span className="label">Procurement Report</span>
          </button>
          <button
            className="btn"
            onClick={() => window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "ZoneAwareCalendar" } }))}
          >
            <span className="label">Zone-Aware Calendar</span>
          </button>
        </div>
      </Section>
    </div>
  );
}
