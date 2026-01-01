// src/pages/marketplace/index.jsx
import React, { useEffect, useMemo, useState } from "react";
import { useVision } from "@/context/VisionContext";
import { usePortfolios } from "@/store/PortfolioStore";
import "@/index.css";

/* ----------------------------- Calendar helpers ---------------------------- */
const GREG_KEYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
const SHORT = { monday:"Mon", tuesday:"Tue", wednesday:"Wed", thursday:"Thu", friday:"Fri", saturday:"Sat", sunday:"Sun" };
const HEB = ["yom_rishon","yom_sheni","yom_shelishi","yom_revi_i","yom_chamishi","yom_shishi","shabbat"];
const CRE = ["day_one","day_two","day_three","day_five","day_five","day_six","sabbath"]; // note: corrected below

const detectCal = (m={}) =>
  HEB.some(k=>Array.isArray(m[k])) ? "hebrew" :
  ["day_one","day_two","day_three","day_four","day_five","day_six","sabbath"].some(k=>Array.isArray(m[k])) ? "creation" :
  "gregorian";

const normTo = (keys, src={}) => keys.reduce((a,k)=>(a[k]=Array.isArray(src[k])?[...src[k]]:[],a),{});

function rhythmToGreg(map={}) {
  const cal = detectCal(map);
  if (cal==="gregorian") return normTo(GREG_KEYS,map);
  if (cal==="hebrew") {
    const src = normTo(HEB, map);
    const out={}; for (let i=0;i<7;i++) out[GREG_KEYS[i]] = [...(src[HEB[i]]||[])];
    return out;
  }
  // creation calendar
  const CRE_KEYS = ["day_one","day_two","day_three","day_four","day_five","day_six","sabbath"];
  const src = normTo(CRE_KEYS, map);
  const out={}; for (let i=0;i<7;i++) out[GREG_KEYS[i]] = [...(src[CRE_KEYS[i]]||[])];
  return out;
}

/* -------------------------------- UI atoms --------------------------------- */
function Section({ title, subtitle, children, className="" }) {
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
function Toggle({ label, checked, onChange }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e)=>onChange(e.target.checked)} /> {label}
    </label>
  );
}
function MiniRhythmStrip({ daysActiveKeys=[], className="" }) {
  const set = new Set(daysActiveKeys);
  return (
    <div className={`flex items-center gap-1 ${className}`} aria-label="Weekly Flavor Rhythm coverage">
      {GREG_KEYS.map((k)=>(
        <div key={k}
          className={`inline-flex items-center justify-center rounded-[6px] border px-1.5 py-0.5 text-[10px] font-semibold
            ${set.has(k) ? "bg-[hsl(var(--brand))]/10 border-[hsl(var(--brand))] text-[hsl(var(--brand))]" : "bg-[hsl(var(--muted))]/20 border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]"}`}
          title={`${SHORT[k]} ${set.has(k) ? "• set" : ""}`}
        >{SHORT[k][0]}</div>
      ))}
    </div>
  );
}

/* ------------------------------- Facet helpers ----------------------------- */
const lc = (s) => String(s||"").toLowerCase();

function extractFacets(records=[]) {
  const flavorSet = new Set();
  const tagSet = new Set();
  const equipSet = new Set();
  const dietSet = new Set();
  const seasonSet = new Set();

  for (const r of records) {
    [...(r.flavors || r.flavor_profile || [])].forEach(f => f && flavorSet.add(String(f)));
    const greg = rhythmToGreg(r.weeklyFlavorRhythm || {});
    Object.values(greg).forEach(arr => (arr||[]).forEach(f => f && flavorSet.add(String(f))));

    (r.tags || []).forEach((t) => {
      if (!t) return;
      tagSet.add(String(t));
      const m = lc(t);
      if (m.startsWith("equipment:")) equipSet.add(t);
      if (m.startsWith("diet:")) dietSet.add(t);
      if (m.startsWith("season:")) seasonSet.add(t);
    });
  }

  return {
    flavors: Array.from(flavorSet).sort((a,b)=>a.localeCompare(b)),
    tags: Array.from(tagSet).sort((a,b)=>a.localeCompare(b)),
    equipment: Array.from(equipSet).sort((a,b)=>a.localeCompare(b)),
    diets: Array.from(dietSet).sort((a,b)=>a.localeCompare(b)),
    seasons: Array.from(seasonSet).sort((a,b)=>a.localeCompare(b)),
  };
}

/* ------------------------------ Marketplace Card --------------------------- */
function MarketplaceCard({ rec, onOpen }) {
  const rhythm = rhythmToGreg(rec.weeklyFlavorRhythm || {});
  const activeKeys = GREG_KEYS.filter((k)=>Array.isArray(rhythm[k]) && rhythm[k].length);
  const tagView = (rec.tags || []).slice(0,4);
  const flavorsView = (rec.flavors || rec.flavor_profile || []).slice(0,4);

  return (
    <article className="card hover:shadow-sm transition">
      <div className="space-y-2">
        <div className="relative">
          {rec.cover ? (
            <img className="w-full aspect-[16/9] object-cover rounded-md" src={rec.cover} alt="" />
          ) : (
            <div className="w-full aspect-[16/9] grid place-items-center rounded-md bg-[hsl(var(--muted))]/30 text-lg font-bold">
              {(rec.title || "Portfolio").split(/\s+/).slice(0,2).map(s=>s[0]?.toUpperCase()).join("")}
            </div>
          )}
          <span className="absolute left-2 top-2 rounded-full bg-white/90 border px-2 py-0.5 text-[10px] font-semibold">
            {rec.visibility || "public"}
          </span>
        </div>

        <header className="flex items-start justify-between gap-2">
          <div className="text-base md:text-lg font-bold line-clamp-1">{rec.title}</div>
          {typeof rec.uniquenessScore === "number" ? (
            <span className="text-xs text-[hsl(var(--muted-foreground))]" title="Uniqueness score">
              {Math.round(rec.uniquenessScore)}%
            </span>
          ) : null}
        </header>

        <MiniRhythmStrip daysActiveKeys={activeKeys} className="mt-1" />

        {rec.description ? (
          <p className="text-sm text-[hsl(var(--muted-foreground))] line-clamp-3">{rec.description}</p>
        ) : null}

        <div className="flex flex-wrap gap-1.5">
          {tagView.map((t)=> <Chip key={t} title={t}>{t.replace(/^[a-z]+:/,"")}</Chip>)}
          {flavorsView.map((f)=> <Chip key={f} title={`Flavor: ${f}`}>{f}</Chip>)}
        </div>

        <div className="flex items-center gap-2 pt-1">
          <button className="btn sm primary" onClick={onOpen}><span className="label">Open</span></button>
        </div>
      </div>
    </article>
  );
}

/* ----------------------------------- Page ---------------------------------- */
export default function MarketplacePage() {
  const { options: vision = {} } = useVision();

  // Source of truth: PortfolioStore marketplace; fallback to localStorage
  const storeMarket = usePortfolios((s)=>s.marketplace || []);
  const [records, setRecords] = useState(storeMarket);
  useEffect(()=> {
    if (storeMarket && storeMarket.length) { setRecords(storeMarket); return; }
    try {
      const raw = localStorage.getItem("suka:marketplace:index");
      setRecords(raw ? JSON.parse(raw) : []);
    } catch { setRecords([]); }
  }, [storeMarket]);

  /* ------------------------------- Facets state ---------------------------- */
  const [query, setQuery] = useState("");
  const [flavorsSel, setFlavorsSel] = useState([]);    // multi
  const [daysSel, setDaysSel] = useState([]);          // greg keys
  const [tagsSel, setTagsSel] = useState([]);          // multi
  const [equipSel, setEquipSel] = useState([]);        // multi (equipment:* tags)
  const [dietsSel, setDietsSel] = useState([]);        // multi (diet:* tags)
  const [seasonsSel, setSeasonsSel] = useState([]);    // multi (season:* tags)

  const [matchMyRhythm, setMatchMyRhythm] = useState(true);
  const [sortBy, setSortBy] = useState("relevance");   // relevance|uniqueness|recent

  // Build facet universes
  const facets = useMemo(()=>extractFacets(records), [records]);

  // User rhythm context (for matchMyRhythm)
  const userGreg = useMemo(()=>rhythmToGreg(vision?.weeklyFlavorRhythm || {}), [vision]);
  const userDayFlavorMap = useMemo(()=> {
    const m={}; GREG_KEYS.forEach(k => m[k] = new Set((userGreg[k]||[]).map(s=>lc(s))));
    return m;
  }, [userGreg]);

  const toggleSel = (setter, value) => setter(prev => {
    const s = new Set(prev || []); s.has(value) ? s.delete(value) : s.add(value); return Array.from(s);
  });
  const toggleDay = (k) => toggleSel(setDaysSel, k);

  /* ------------------------------- Filtering ------------------------------- */
  const filtered = useMemo(()=> {
    const q = lc(query);
    const fLC = new Set((flavorsSel||[]).map(lc));
    const tLC = new Set((tagsSel||[]).map(lc));
    const eLC = new Set((equipSel||[]).map(lc));
    const dLC = new Set((dietsSel||[]).map(lc));
    const sLC = new Set((seasonsSel||[]).map(lc));
    const daySel = new Set(daysSel||[]);

    return (records||[]).filter(rec => {
      if (rec.visibility && rec.visibility !== "public") return false;

      // text
      if (q) {
        const hay = lc(`${rec.title||""} ${rec.description||""} ${(rec.tags||[]).join(" ")} ${(rec.flavors||rec.flavor_profile||[]).join(" ")}`);
        if (!hay.includes(q)) return false;
      }

      // flavors (AND across selected)
      if (fLC.size) {
        const own = new Set([...(rec.flavors||rec.flavor_profile||[])].map(lc));
        const greg = rhythmToGreg(rec.weeklyFlavorRhythm || {});
        Object.values(greg).forEach(arr => (arr||[]).forEach(f => own.add(lc(f))));
        for (const f of fLC) if (!own.has(f)) return false;
      }

      // tags / equipment / diets / seasons
      if (tLC.size || eLC.size || dLC.size || sLC.size) {
        const tags = new Set((rec.tags||[]).map(lc));
        for (const t of tLC) if (!tags.has(t)) return false;
        for (const e of eLC) if (!tags.has(e)) return false;
        for (const d of dLC) if (!tags.has(d)) return false;
        for (const s of sLC) if (!tags.has(s)) return false;
      }

      // day rhythm filter
      if (daySel.size) {
        const greg = rhythmToGreg(rec.weeklyFlavorRhythm || {});
        if (matchMyRhythm) {
          let ok=false;
          GREG_KEYS.forEach(k=>{
            if (!daySel.has(k)) return;
            const mine=(greg[k]||[]).map(lc);
            const user=userDayFlavorMap[k];
            if (mine.some(f=>user.has(f))) ok=true;
          });
          if (!ok) return false;
        } else {
          let ok=false;
          GREG_KEYS.forEach(k=>{ if (daySel.has(k) && (greg[k]||[]).length) ok=true; });
          if (!ok) return false;
        }
      }

      return true;
    });
  }, [records, query, flavorsSel, tagsSel, equipSel, dietsSel, seasonsSel, daysSel, matchMyRhythm, userDayFlavorMap]);

  /* -------------------------------- Sorting -------------------------------- */
  const sorted = useMemo(()=> {
    const arr = [...filtered];
    const byTitle = (a,b)=> (a.title||"").localeCompare(b.title||"");
    switch (sortBy) {
      case "uniqueness": return arr.sort((a,b)=>(b.uniquenessScore||0)-(a.uniquenessScore||0) || byTitle(a,b));
      case "recent":     return arr.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0) || byTitle(a,b));
      default:           return arr.sort(byTitle);
    }
  }, [filtered, sortBy]);

  /* -------------------------------- Actions -------------------------------- */
  const openPortfolio = (rec) => {
    window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "PortfolioViewer", params: { id: rec.id } } }));
  };

  /* --------------------------------- Render -------------------------------- */
  return (
    <div className="space-y-6 w-full">
      <Section
        title="Marketplace"
        subtitle="Discover public portfolios. Filter by flavors, rhythm days, tags, diet, equipment, and season. No macros or time needed."
      >
        {/* Toolbar: search & sort */}
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="control"
            placeholder="Search portfolios…"
            value={query}
            onChange={(e)=>setQuery(e.target.value)}
            aria-label="Search portfolios"
            style={{ minWidth: 260 }}
          />
          <select className="control" value={sortBy} onChange={(e)=>setSortBy(e.target.value)} title="Sort by">
            <option value="relevance">A–Z</option>
            <option value="uniqueness">Uniqueness</option>
            <option value="recent">Most Recent</option>
          </select>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Toggle label="Match my rhythm flavors" checked={matchMyRhythm} onChange={setMatchMyRhythm} />
            <div className="flex items-center gap-1">
              {GREG_KEYS.map((k)=>(
                <button key={k}
                  className={`px-2 py-1 rounded-md border text-xs font-semibold ${daysSel.includes(k) ? "bg-[hsl(var(--brand))]/10 border-[hsl(var(--brand))] text-[hsl(var(--brand))]" : "bg-[hsl(var(--muted))]/20 border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]"}`}
                  onClick={()=>toggleDay(k)} title={`Filter day: ${SHORT[k]}`}
                >{SHORT[k]}</button>
              ))}
            </div>
          </div>
        </div>

        {/* Facet rows (lean set) */}
        <div className="mt-3 grid gap-2">
          {/* Flavors */}
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs font-semibold text-[hsl(var(--muted-foreground))]">Flavors:</span>
            {facets.flavors.slice(0, 18).map((f)=>(
              <Chip key={f} onClick={()=>toggleSel(setFlavorsSel,f)} active={flavorsSel.includes(f)} title={`Flavor: ${f}`}>{f}</Chip>
            ))}
            {facets.flavors.length > 18 && <span className="text-xs text-[hsl(var(--muted-foreground))]">+{facets.flavors.length-18}</span>}
          </div>

          {/* Tags */}
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs font-semibold text-[hsl(var(--muted-foreground))]">Tags:</span>
            {facets.tags.slice(0, 18).map((t)=>(
              <Chip key={t} onClick={()=>toggleSel(setTagsSel,t)} active={tagsSel.includes(t)} title={t}>
                {t.replace(/^[a-z]+:/,"")}
              </Chip>
            ))}
          </div>

          {/* Diet & Equipment & Season */}
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs font-semibold text-[hsl(var(--muted-foreground))]">Diet:</span>
            {facets.diets.map((t)=>(
              <Chip key={t} onClick={()=>toggleSel(setDietsSel,t)} active={dietsSel.includes(t)} title={t}>
                {t.replace(/^diet:/,"")}
              </Chip>
            ))}

            <span className="text-xs font-semibold text-[hsl(var(--muted-foreground))] ml-3">Equipment:</span>
            {facets.equipment.map((t)=>(
              <Chip key={t} onClick={()=>toggleSel(setEquipSel,t)} active={equipSel.includes(t)} title={t}>
                {t.replace(/^equipment:/,"")}
              </Chip>
            ))}

            <span className="text-xs font-semibold text-[hsl(var(--muted-foreground))] ml-3">Season:</span>
            {facets.seasons.map((t)=>(
              <Chip key={t} onClick={()=>toggleSel(setSeasonsSel,t)} active={seasonsSel.includes(t)} title={t}>
                {t.replace(/^season:/,"")}
              </Chip>
            ))}
          </div>
        </div>

        {/* Results */}
        <div className="mt-4">
          <div className="text-sm font-semibold mb-2">{sorted.length} portfolio{sorted.length===1?"":"s"}</div>
          <div className="grid gap-3 md:gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            {(sorted.length ? sorted : Array.from({ length: 6 })).map((rec, i) => {
              if (!sorted.length) {
                return (
                  <article key={`sk-${i}`} className="card">
                    <div className="w-full aspect-[16/9] rounded-md skeleton" />
                    <div className="mt-2 h-5 w-2/3 skeleton rounded" />
                    <div className="mt-2 h-10 w-full skeleton rounded" />
                  </article>
                );
              }
              return <MarketplaceCard key={rec.id || i} rec={rec} onOpen={()=>openPortfolio(rec)} />;
            })}
          </div>
        </div>
      </Section>
    </div>
  );
}
