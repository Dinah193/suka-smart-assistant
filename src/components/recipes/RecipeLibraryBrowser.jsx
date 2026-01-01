// src/components/recipes/RecipeLibraryBrowser.jsx
import React, { useMemo, useState } from "react";
import { useVision } from "@/context/VisionContext";

/* -------------------------------------------------------------------------- */
/* Calendars & helpers (gregorian + hebrew + creation)                        */
/* -------------------------------------------------------------------------- */
const CAL_GREG = "gregorian";
const CAL_HEB = "hebrew";
const CAL_CRE = "creation";

const GREG_KEYS = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"];
const HEB_KEYS  = ["yom_rishon","yom_sheni","yom_shelishi","yom_revi_i","yom_chamishi","yom_shishi","shabbat"];
const CRE_KEYS  = ["day_one","day_two","day_three","day_four","day_five","day_six","sabbath"];

const POS = {
  [CAL_GREG]: GREG_KEYS,     // Mon..Sun
  [CAL_HEB]:  HEB_KEYS,      // Sun..Sat
  [CAL_CRE]:  CRE_KEYS,      // Day1..Sabbath
};
const SHORT_GREG = { monday:"Mon", tuesday:"Tue", wednesday:"Wed", thursday:"Thu", friday:"Fri", saturday:"Sat", sunday:"Sun" };

function detectCalendar(map = {}) {
  const has = (ks) => ks.some((k) => Array.isArray(map[k]));
  if (has(HEB_KEYS)) return CAL_HEB;
  if (has(CRE_KEYS)) return CAL_CRE;
  return CAL_GREG;
}
function normalizeTo(calendar, src = {}) {
  const out = {};
  POS[calendar].forEach((k) => { out[k] = Array.isArray(src[k]) ? [...src[k]] : []; });
  return out;
}
function convertCalendar(srcMap = {}, srcCal, dstCal) {
  if (srcCal === dstCal) return normalizeTo(dstCal, srcMap);
  const out = {};
  const srcKeys = POS[srcCal];
  const dstKeys = POS[dstCal];
  for (let i = 0; i < 7; i++) {
    const sk = srcKeys[i];
    const dk = dstKeys[i];
    out[dk] = Array.isArray(srcMap[sk]) ? [...srcMap[sk]] : [];
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Flavor helpers                                                             */
/* -------------------------------------------------------------------------- */
function extractPackFlavors(pack) {
  // Accepts recipe pack, collection, or single recipe-like object
  const out = new Set();

  // 1) pack.flavor_profile: string | string[]
  const fp = pack?.flavor_profile;
  if (typeof fp === "string" && fp.trim()) out.add(fp.trim());
  if (Array.isArray(fp)) fp.filter(Boolean).forEach((t) => out.add(String(t).trim()));

  // 2) pack.tags: ["flavor:Caribbean", ...]
  const tags = Array.isArray(pack?.tags) ? pack.tags : [];
  tags.forEach((t) => {
    const m = String(t).match(/^flavor\s*:\s*(.+)$/i);
    if (m && m[1]) out.add(m[1].trim());
  });

  // 3) If pack contains items/recipes with flavor_profile/tags, pull those too
  const items = Array.isArray(pack?.items) ? pack.items : Array.isArray(pack?.recipes) ? pack.recipes : [];
  items.forEach((it) => {
    const sub = extractPackFlavors(it);
    sub.forEach((f) => out.add(f));
  });

  return Array.from(out);
}

function computeRhythmMaps(vision = {}) {
  // Read weeklyFlavorRhythm in any schema → return:
  // - gregMap: { monday: string[] ... }
  // - dayFlavorSet: Set of ALL flavors across the week
  const r = vision?.weeklyFlavorRhythm || {};
  const srcCal = detectCalendar(r);
  const normSrc = normalizeTo(srcCal, r);
  const gregMap = srcCal === CAL_GREG ? normSrc : convertCalendar(normSrc, srcCal, CAL_GREG);
  const dayFlavorSet = new Set();
  Object.values(gregMap).forEach((arr) => (arr || []).forEach((f) => f && dayFlavorSet.add(String(f).trim())));
  return { gregMap, dayFlavorSet };
}

function matchingDaysForPack(pack, gregMap) {
  // Which Mon..Sun keys have intersection between their flavors and pack flavors?
  const pf = new Set(extractPackFlavors(pack).map((s) => String(s).trim().toLowerCase()));
  const days = [];
  GREG_KEYS.forEach((dk) => {
    const dayFlavors = (gregMap[dk] || []).map((s) => String(s).trim().toLowerCase());
    if (dayFlavors.some((f) => pf.has(f))) days.push(dk);
  });
  return days;
}

function formatMatchesHint(days) {
  if (!days?.length) return "";
  // "Wed/Thu" or "Mon/Wed/Fri" with cap
  const parts = days.map((k) => SHORT_GREG[k]);
  const cap = 3;
  if (parts.length <= cap) return `Matches ${parts.join("/")}`;
  const first = parts.slice(0, cap).join("/");
  return `Matches ${first} +${parts.length - cap}`;
}

/* -------------------------------------------------------------------------- */
/* Small UI Atoms                                                             */
/* -------------------------------------------------------------------------- */
function ChipTiny({ label, title }) {
  if (!label) return null;
  return (
    <span className="chip chip--tiny" title={title || label}>
      {label}
    </span>
  );
}

function PackCard({ pack, matchesHint }) {
  const title = pack?.title || pack?.name || "Recipe Pack";
  const desc = pack?.description || pack?.summary || "";
  const flavors = extractPackFlavors(pack);

  return (
    <article className="card hover:shadow-sm transition">
      <header className="flex items-start justify-between gap-2">
        <div className="text-base md:text-lg font-bold">{title}</div>
        {matchesHint ? (
          <span
            className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-semibold"
            style={{ borderColor: "hsl(var(--brand))", background: "hsl(var(--brand))/0.08" }}
            title={matchesHint}
          >
            <span aria-hidden>🎯</span> {matchesHint}
          </span>
        ) : null}
      </header>

      {desc ? (
        <p className="mt-1 text-sm text-[hsl(var(--muted-foreground))]">{desc}</p>
      ) : null}

      {/* Flavor chips */}
      {flavors.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {flavors.slice(0, 8).map((f) => (
            <ChipTiny key={`pf-${title}-${f}`} label={f} />
          ))}
          {flavors.length > 8 ? (
            <span className="text-xs text-[hsl(var(--muted-foreground))]">+{flavors.length - 8}</span>
          ) : null}
        </div>
      )}

      {/* CTA row — wire up as your app expects */}
      <div className="mt-3 flex items-center gap-2">
        {typeof pack?.onSelect === "function" ? (
          <button className="btn sm primary" onClick={() => pack.onSelect(pack)}>
            <span className="label">Open</span>
          </button>
        ) : null}
        {pack?.link ? (
          <a className="btn sm" href={pack.link}>
            <span className="label">Details</span>
          </a>
        ) : null}
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------------- */
/* Main Browser                                                                */
/* -------------------------------------------------------------------------- */
export default function RecipeLibraryBrowser({
  packs = [],              // [{ id, title, description, tags, flavor_profile, items? }, ...]
  initialQuery = "",
  className = "",
  showMatchesHint = true,
}) {
  const { options: vision = {} } = useVision();
  const [query, setQuery] = useState(initialQuery);
  const [sort, setSort] = useState("recommended"); // recommended | A–Z | Z–A

  // Build rhythm flavor maps
  const { gregMap, dayFlavorSet } = useMemo(() => computeRhythmMaps(vision || {}), [vision]);

  // For ranking: precompute lowercase flavor universe from rhythm
  const rhythmFlavors = useMemo(() => {
    const s = new Set();
    dayFlavorSet.forEach((f) => s.add(String(f).trim().toLowerCase()));
    return s;
  }, [dayFlavorSet]);

  // Text matcher
  const lc = (x) => String(x || "").toLowerCase();
  const matchesText = (pack) => {
    if (!query) return 1;
    const q = lc(query);
    const hay =
      [pack?.title, pack?.name, pack?.description, pack?.summary]
        .filter(Boolean)
        .map(lc)
        .join(" ");
    return hay.includes(q) ? 1 : 0;
  };

  // Score: rhythm-aware + text + (optional) popularity
  const scorePack = (pack) => {
    // Rhythm intersections across *any* day
    const pFlavors = extractPackFlavors(pack).map((s) => lc(s));
    const rhythmHits = pFlavors.filter((f) => rhythmFlavors.has(f));
    const rhythmScore = rhythmHits.length > 0 ? 3 + Math.min(2, rhythmHits.length - 1) : 0; // 3..5

    // Specific day matches give a bit extra (encourages “Matches Wed/Thu” packs)
    const dayMatches = matchingDaysForPack(pack, gregMap).length;
    const dayScore = dayMatches > 0 ? Math.min(3, dayMatches) : 0;

    // Text relevance
    const textScore = matchesText(pack) ? 2 : 0;

    // Popularity / rating if present
    const pop = Number(pack?.popularity || pack?.rating || 0); // 0..5?
    const popScore = isFinite(pop) ? Math.min(2, pop / 2.5) : 0;

    return rhythmScore + dayScore + textScore + popScore;
  };

  // Filter & sort
  const filtered = useMemo(() => {
    const base = Array.isArray(packs) ? packs : [];
    if (!query) return base.slice();
    return base.filter((p) => matchesText(p));
  }, [packs, query]);

  const sorted = useMemo(() => {
    const arr = filtered.slice();
    if (sort === "A–Z") return arr.sort((a, b) => lc(a?.title || a?.name).localeCompare(lc(b?.title || b?.name)));
    if (sort === "Z–A") return arr.sort((a, b) => lc(b?.title || b?.name).localeCompare(lc(a?.title || a?.name)));
    // recommended
    return arr.sort((a, b) => scorePack(b) - scorePack(a));
  }, [filtered, sort]);

  return (
    <div className={className}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <div className="relative">
          <input
            className="control"
            placeholder="Search recipes & packs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search recipes and packs"
          />
        </div>
        <select className="control control--select" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="recommended">Recommended</option>
          <option value="A–Z">A–Z</option>
          <option value="Z–A">Z–A</option>
        </select>

        {/* Rhythm summary (compact, optional visual nudge) */}
        {dayFlavorSet.size > 0 && (
          <div className="ml-auto hidden md:flex items-center gap-2 text-xs text-[hsl(var(--muted-foreground))]">
            <span>Weekly Flavor Rhythm in play</span>
            <span className="inline-flex">
              {/* show a few chips from the weekly set */}
              {Array.from(dayFlavorSet).slice(0, 4).map((f) => (
                <ChipTiny key={`rhythm-chip-${f}`} label={f} title={`Weekly rhythm: ${f}`} />
              ))}
              {dayFlavorSet.size > 4 ? <span className="ml-1">+{dayFlavorSet.size - 4}</span> : null}
            </span>
          </div>
        )}
      </div>

      {/* Cards Grid */}
      <div className="grid gap-3 md:gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        {sorted.map((pack, idx) => {
          const days = matchingDaysForPack(pack, gregMap);
          const hint = showMatchesHint ? formatMatchesHint(days) : "";
          return <PackCard key={pack?.id || pack?.title || idx} pack={pack} matchesHint={hint} />;
        })}
      </div>
    </div>
  );
}
