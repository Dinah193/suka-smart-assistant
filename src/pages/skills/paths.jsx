// C:\Users\larho\suka-smart-assistant\src\pages\skills\paths.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  ChevronRight,
  Search,
  Filter,
  Target,
  CheckCircle2,
  Circle,
  Sparkles,
  ShieldAlert,
  Clock,
  Tag,
  LayoutGrid,
  List,
  X,
  ExternalLink,
} from "lucide-react";

import KnowledgeHelperPanel from "@/components/knowledgeHelper/KnowledgeHelperPanel";

const DEFAULT_SOURCE = "pages/skills/paths";

const VIEW = Object.freeze({
  GRID: "grid",
  LIST: "list",
});

const DOMAINS = Object.freeze([
  "cooking",
  "cleaning",
  "garden_planning",
  "garden_care",
  "garden_harvest",
  "storehouse",
  "animals_acquisition",
  "animals_care",
  "animals_butchery",
  "preservation",
  "general",
]);

function nowISO() {
  return new Date().toISOString();
}
function normalizeStr(v) {
  if (v == null) return "";
  return String(v).trim();
}
function normalizeArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => normalizeStr(x)).filter(Boolean);
}
function safeUrl(u) {
  const s = normalizeStr(u);
  if (!s) return "";
  try {
    const url = new URL(s, window.location.origin);
    const proto = url.protocol.toLowerCase();
    if (proto === "http:" || proto === "https:") return url.toString();
    return "";
  } catch {
    return "";
  }
}
function randomId(prefix = "sp") {
  const rnd =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Math.random().toString(16).slice(2)}${Math.random()
          .toString(16)
          .slice(2)}`;
  return `${prefix}_${rnd.replace(/-/g, "").slice(0, 18)}`;
}
function formatWhen(iso) {
  const s = normalizeStr(iso);
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Pill({ icon, children }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/70 border border-black/5 px-2 py-0.5 text-xs text-slate-700">
      {icon ? (
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
          {icon}
        </span>
      ) : null}
      {children}
    </span>
  );
}

function IconButton({ onClick, title, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white p-2 text-slate-700 hover:bg-slate-50"
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

function scoreMatch(path, q) {
  const query = normalizeStr(q).toLowerCase();
  if (!query) return 0;

  const hay = [
    normalizeStr(path.title),
    normalizeStr(path.subtitle),
    normalizeStr(path.domain),
    normalizeArray(path.tags).join(" "),
    normalizeArray(path.outcomes).join(" "),
    normalizeArray(path.skills)
      .map((s) => normalizeStr(s.title))
      .join(" "),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  if (normalizeStr(path.title).toLowerCase().includes(query)) score += 5;
  if (normalizeStr(path.subtitle).toLowerCase().includes(query)) score += 3;
  if (normalizeStr(path.domain).toLowerCase().includes(query)) score += 2;
  if (normalizeArray(path.tags).some((t) => t.toLowerCase().includes(query)))
    score += 2;
  if (hay.includes(query)) score += 1;
  return score;
}

function getDefaultPaths() {
  return [
    {
      id: "path_cooking_basics",
      title: "Cooking Basics (Scratch-to-Table)",
      subtitle:
        "Foundations for confident, safe home cooking with real ingredients.",
      domain: "cooking",
      level: "beginner",
      estDays: 7,
      tags: ["knife-skills", "mise-en-place", "food-safety", "timing"],
      outcomes: [
        "Prep ingredients efficiently (mise en place)",
        "Use a chef’s knife safely for common cuts",
        "Cook 3 simple meals with consistent timing",
        "Store leftovers safely and reduce waste",
      ],
      safetyAlerts: [
        {
          id: "cook_safety_knife",
          severity: "high",
          title: "Knife safety",
          summary:
            "Use a stable cutting board, curl fingers, and keep blades sharp.",
          steps: [
            "Use a damp towel under the board to prevent slipping.",
            "Curl fingertips (‘claw’) and cut away from your hand.",
            "If a knife slips, step back—don’t try to catch it.",
          ],
        },
        {
          id: "cook_safety_temp",
          severity: "medium",
          title: "Food temperature basics",
          summary:
            "Use a thermometer for poultry/leftovers; cool food quickly.",
          steps: [
            "Reheat leftovers until steaming hot; use a thermometer when possible.",
            "Cool large batches quickly: shallow containers, stir, refrigerate.",
          ],
        },
      ],
      skills: [
        {
          id: "skill_mise_en_place",
          title: "Mise en place",
          subtitle:
            "Set up ingredients + tools so cooking is smooth and timed.",
          domain: "cooking",
          level: "beginner",
          durationMins: 15,
          description:
            "Mise en place means ‘everything in its place.’ It’s how you prevent scrambling, missing steps, and burning food.",
          outcomes: ["Faster cooking", "Cleaner workflow", "Fewer mistakes"],
          tools: ["Cutting board", "Knife", "Small bowls/containers"],
          steps: [
            {
              title: "Read the recipe top-to-bottom",
              details: "Highlight timing and dependencies.",
            },
            {
              title: "Gather tools",
              details: "Pan, spatula, bowls, thermometer if needed.",
            },
            {
              title: "Measure ingredients",
              details: "Place measured items in bowls.",
            },
            {
              title: "Prep perishables last",
              details: "Cut herbs/produce closer to cook time.",
            },
          ],
          tips: ["Label bowls if you’re new.", "Keep a trash bowl nearby."],
          mistakes: [
            "Prepping everything too early (wilting herbs).",
            "Forgetting salt or acid at the end.",
          ],
        },
        {
          id: "skill_knife_basic_cuts",
          title: "Knife skills: basic cuts",
          subtitle: "Slice, dice, mince—without hurting yourself.",
          domain: "cooking",
          level: "beginner",
          durationMins: 25,
          description:
            "Learn stable grip, claw-hand, and controlled rocking motion.",
          safetyAlerts: [
            {
              id: "knife_alert",
              severity: "high",
              title: "Keep fingers tucked",
              summary:
                "Use the claw grip. Never cut toward exposed fingertips.",
            },
          ],
          steps: [
            {
              title: "Set a non-slip board",
              details: "Damp towel under board; stabilize.",
            },
            {
              title: "Grip the knife",
              details:
                "Pinch the blade near the handle; wrap remaining fingers.",
            },
            {
              title: "Claw your guiding hand",
              details: "Knuckles guide the blade; fingertips tucked.",
            },
            {
              title: "Practice slices",
              details: "Slow and consistent; aim for uniform thickness.",
            },
            {
              title: "Graduate to dice/mince",
              details: "Keep tip on board; rock the knife smoothly.",
            },
          ],
          tips: [
            "Sharp knives are safer than dull ones.",
            "Slow is smooth; smooth becomes fast.",
          ],
          mistakes: [
            "Lifting the knife too high.",
            "Rushing and losing control.",
          ],
        },
      ],
      sources: [
        {
          label: "USDA Food Safety Basics",
          url: "https://www.fsis.usda.gov/food-safety/safe-food-handling-and-preparation",
        },
      ],
    },

    {
      id: "path_cleaning_reset",
      title: "Home Reset (60–90 minutes)",
      subtitle: "A simple cleaning rhythm for fast results without overwhelm.",
      domain: "cleaning",
      level: "beginner",
      estDays: 3,
      tags: ["reset", "declutter", "bathroom", "kitchen"],
      outcomes: [
        "Clear surfaces quickly",
        "Refresh bathroom + kitchen",
        "Build a repeatable routine",
      ],
      skills: [
        {
          id: "skill_reset_5zones",
          title: "5-zone reset",
          subtitle: "Trash → dishes → laundry → surfaces → floors.",
          domain: "cleaning",
          level: "beginner",
          durationMins: 20,
          description:
            "Do the same 5 zones every time to prevent decision fatigue.",
          steps: [
            {
              title: "Trash",
              details: "Walk through with a bag; remove all visible trash.",
            },
            {
              title: "Dishes",
              details: "Load dishwasher or wash; clear sink.",
            },
            { title: "Laundry", details: "Collect and start one load." },
            {
              title: "Surfaces",
              details: "Wipe counters/tables; return items home.",
            },
            { title: "Floors", details: "Quick sweep/vac high-traffic areas." },
          ],
          tips: ["Set a timer per zone.", "Don’t organize—just reset."],
        },
        {
          id: "skill_bathroom_speed",
          title: "Speed-clean bathroom",
          subtitle: "Sink, toilet, mirror, quick floor.",
          domain: "cleaning",
          level: "beginner",
          durationMins: 15,
          safetyAlerts: [
            {
              id: "chem_mix",
              severity: "critical",
              title: "Never mix cleaners",
              summary:
                "Mixing bleach and ammonia/acid can create dangerous gases.",
              steps: [
                "Use one cleaner at a time.",
                "Ventilate well.",
                "Rinse surfaces between products.",
              ],
            },
          ],
          steps: [
            { title: "Ventilate", details: "Open window / run fan." },
            {
              title: "Apply cleaner",
              details: "Toilet bowl + sink; let dwell 3–5 minutes.",
            },
            { title: "Wipe sink + counters", details: "Work top to bottom." },
            {
              title: "Scrub toilet",
              details: "Bowl, seat, exterior; finish with handle.",
            },
            {
              title: "Mirror + quick floor",
              details: "Microfiber for mirror; quick mop/sweep.",
            },
          ],
        },
      ],
    },
  ];
}

async function loadPathsCatalogBestEffort() {
  // Keep page functional even without DB wiring.
  return null;
}

export default function SkillsPathsPage() {
  const pageId = useMemo(() => randomId("skillsPaths"), []);
  const [view, setView] = useState(VIEW.GRID);

  // Safe defaults (wire from household profile later)
  const [householdId] = useState("default");
  const [userId] = useState("anon");

  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("");
  const [level, setLevel] = useState("");
  const [tag, setTag] = useState("");

  const [paths, setPaths] = useState(() => getDefaultPaths());
  const [selectedPathId, setSelectedPathId] = useState(
    () => getDefaultPaths()[0]?.id || ""
  );
  const [panelOpen, setPanelOpen] = useState(false);

  const searchRef = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const loaded = await loadPathsCatalogBestEffort();
        if (!alive) return;
        if (Array.isArray(loaded) && loaded.length) {
          setPaths(loaded);
          setSelectedPathId(loaded[0]?.id || "");
        }
      } catch (e) {
        console.warn("[SkillsPathsPage] loadPathsCatalogBestEffort failed", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const normalizedPaths = useMemo(() => {
    const arr = Array.isArray(paths) ? paths : [];
    return arr
      .map((p) => {
        const id = normalizeStr(p.id) || randomId("path");
        return {
          ...p,
          id,
          title: normalizeStr(p.title) || "Learning Path",
          subtitle: normalizeStr(p.subtitle),
          domain: normalizeStr(p.domain) || "general",
          level: normalizeStr(p.level) || "beginner",
          estDays: Number.isFinite(Number(p.estDays))
            ? Number(p.estDays)
            : null,
          tags: normalizeArray(p.tags),
          outcomes: normalizeArray(p.outcomes),
          skills: Array.isArray(p.skills) ? p.skills : [],
          safetyAlerts: Array.isArray(p.safetyAlerts) ? p.safetyAlerts : [],
          sources: Array.isArray(p.sources) ? p.sources : [],
        };
      })
      .filter(Boolean);
  }, [paths]);

  const allDomains = useMemo(() => {
    const set = new Set(DOMAINS);
    normalizedPaths.forEach((p) => p.domain && set.add(p.domain));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [normalizedPaths]);

  const allTags = useMemo(() => {
    const set = new Set();
    normalizedPaths.forEach((p) => (p.tags || []).forEach((t) => set.add(t)));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [normalizedPaths]);

  const filteredPaths = useMemo(() => {
    const q = normalizeStr(query);
    const d = normalizeStr(domain);
    const lv = normalizeStr(level);
    const tg = normalizeStr(tag);

    let out = normalizedPaths.slice();
    if (d) out = out.filter((p) => normalizeStr(p.domain) === d);
    if (lv) out = out.filter((p) => normalizeStr(p.level) === lv);
    if (tg) out = out.filter((p) => (p.tags || []).includes(tg));

    if (q) {
      out = out
        .map((p) => ({ p, score: scoreMatch(p, q) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.p);
    } else {
      out.sort((a, b) => a.title.localeCompare(b.title));
    }

    return out;
  }, [normalizedPaths, query, domain, level, tag]);

  const selectedPath = useMemo(() => {
    const direct = normalizedPaths.find((p) => p.id === selectedPathId);
    return direct || filteredPaths[0] || normalizedPaths[0] || null;
  }, [normalizedPaths, selectedPathId, filteredPaths]);

  useEffect(() => {
    if (selectedPath?.id && selectedPath.id !== selectedPathId) {
      setSelectedPathId(selectedPath.id);
    }
  }, [selectedPath, selectedPathId]);

  const skillsForPanel = useMemo(() => {
    if (!selectedPath) return [];
    const pathDomain = normalizeStr(selectedPath.domain) || "general";
    const pathTags = normalizeArray(selectedPath.tags);
    return (selectedPath.skills || []).map((s) => {
      const sTags = normalizeArray(s?.tags);
      const mergedTags = Array.from(new Set([...sTags, ...pathTags])).slice(
        0,
        24
      );
      return {
        ...s,
        domain: normalizeStr(s?.domain) || pathDomain,
        tags: mergedTags,
      };
    });
  }, [selectedPath]);

  const safetyForPanel = useMemo(() => {
    if (!selectedPath) return [];
    return Array.isArray(selectedPath.safetyAlerts)
      ? selectedPath.safetyAlerts
      : [];
  }, [selectedPath]);

  function resetFilters() {
    setQuery("");
    setDomain("");
    setLevel("");
    setTag("");
    setTimeout(() => searchRef.current?.focus?.(), 30);
  }

  function openPanel(pathId) {
    if (pathId) setSelectedPathId(pathId);
    setPanelOpen(true);
  }

  return (
    <div className="w-full">
      {/* Header */}
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-slate-900">
                Skills • Learning Paths
              </h1>
              <Pill
                icon={<BookOpen className="h-3.5 w-3.5" aria-hidden="true" />}
              >
                SSA
              </Pill>
              <Pill icon={<Clock className="h-3.5 w-3.5" aria-hidden="true" />}>
                {formatWhen(nowISO())}
              </Pill>
              <span className="text-xs text-slate-500">
                ({DEFAULT_SOURCE} • {pageId})
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Pick a path to learn a skill sequence. Open the Knowledge Helper
              to run steps, troubleshooting, and safety guidance.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <IconButton
              onClick={() =>
                setView((v) => (v === VIEW.GRID ? VIEW.LIST : VIEW.GRID))
              }
              title="Toggle view"
            >
              {view === VIEW.GRID ? (
                <List className="h-4 w-4" />
              ) : (
                <LayoutGrid className="h-4 w-4" />
              )}
            </IconButton>
            <IconButton onClick={resetFilters} title="Reset filters">
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>

        {/* Search + filters */}
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="md:col-span-2 block">
            <span className="text-sm font-medium text-slate-900">
              Search paths
            </span>
            <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
              <Search className="h-4 w-4 text-slate-500" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, outcomes, tags…"
                className="w-full text-sm outline-none"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="rounded-full p-1 hover:bg-slate-100"
                  aria-label="Clear search"
                  title="Clear"
                >
                  <X className="h-4 w-4 text-slate-600" />
                </button>
              ) : null}
            </div>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-900">Results</span>
            <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <Filter className="h-4 w-4 text-slate-500" />
              <span className="text-sm text-slate-800">
                {filteredPaths.length} / {normalizedPaths.length}
              </span>
              <span className="ml-auto text-xs text-slate-500">paths</span>
            </div>
          </label>
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <label className="block">
            <span className="text-sm font-medium text-slate-900">Domain</span>
            <select
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
            >
              <option value="">All</option>
              {allDomains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-900">Level</span>
            <select
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
            >
              <option value="">All</option>
              <option value="beginner">beginner</option>
              <option value="intermediate">intermediate</option>
              <option value="advanced">advanced</option>
            </select>
          </label>

          <label className="block">
            <span className="text-sm font-medium text-slate-900">Tag</span>
            <select
              value={tag}
              onChange={(e) => setTag(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
            >
              <option value="">All</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Main content */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {/* Paths list */}
        <div className="lg:col-span-2">
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
            <div className="flex items-center gap-2">
              <Target className="h-5 w-5 text-slate-900" />
              <h2 className="text-lg font-semibold text-slate-900">Paths</h2>
              <span className="text-xs text-slate-500">
                {filteredPaths.length} shown
              </span>
            </div>

            {!filteredPaths.length ? (
              <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                No paths match your filters.
              </div>
            ) : (
              <div
                className={
                  view === VIEW.GRID
                    ? "mt-3 grid gap-4 md:grid-cols-2"
                    : "mt-3 space-y-3"
                }
              >
                {filteredPaths.map((p) => {
                  const isSelected = selectedPath?.id === p.id;
                  const skillCount = (p.skills || []).length;
                  const safetyCount = (p.safetyAlerts || []).length;

                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setSelectedPathId(p.id)}
                      className={[
                        "text-left rounded-2xl border p-3 hover:bg-slate-50 transition",
                        isSelected
                          ? "border-slate-900 bg-slate-50"
                          : "border-slate-200 bg-white",
                      ].join(" ")}
                      aria-current={isSelected ? "true" : "false"}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-slate-900 truncate">
                              {p.title}
                            </span>
                            <Pill icon={<Tag className="h-3.5 w-3.5" />}>
                              {p.domain}
                            </Pill>
                            <Pill icon={<Sparkles className="h-3.5 w-3.5" />}>
                              {p.level}
                            </Pill>
                            {p.estDays != null ? (
                              <Pill icon={<Clock className="h-3.5 w-3.5" />}>
                                {p.estDays} day(s)
                              </Pill>
                            ) : null}
                          </div>

                          {p.subtitle ? (
                            <p className="mt-1 text-sm text-slate-600 line-clamp-2">
                              {p.subtitle}
                            </p>
                          ) : null}

                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-700">
                            <span className="inline-flex items-center gap-1">
                              <BookOpen className="h-3.5 w-3.5" /> {skillCount}{" "}
                              skills
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <ShieldAlert className="h-3.5 w-3.5" />{" "}
                              {safetyCount} safety
                            </span>
                          </div>

                          {p.tags?.length ? (
                            <div className="mt-2 flex flex-wrap gap-2">
                              {p.tags.slice(0, 6).map((t) => (
                                <span
                                  key={t}
                                  className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-700"
                                >
                                  {t}
                                </span>
                              ))}
                              {p.tags.length > 6 ? (
                                <span className="text-xs text-slate-500">
                                  +{p.tags.length - 6}
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </div>

                        <ChevronRight className="h-5 w-5 text-slate-500" />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Selected path preview */}
        <div className="lg:col-span-1">
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
            {!selectedPath ? (
              <div className="text-sm text-slate-700">
                Select a path to preview.
              </div>
            ) : (
              <>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-lg font-semibold text-slate-900">
                      {selectedPath.title}
                    </h3>
                    {selectedPath.subtitle ? (
                      <p className="mt-1 text-sm text-slate-600">
                        {selectedPath.subtitle}
                      </p>
                    ) : null}

                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Pill icon={<Tag className="h-3.5 w-3.5" />}>
                        {selectedPath.domain}
                      </Pill>
                      <Pill icon={<Sparkles className="h-3.5 w-3.5" />}>
                        {selectedPath.level}
                      </Pill>
                      {selectedPath.estDays != null ? (
                        <Pill icon={<Clock className="h-3.5 w-3.5" />}>
                          {selectedPath.estDays} day(s)
                        </Pill>
                      ) : null}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => openPanel(selectedPath.id)}
                    className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
                    title="Open Knowledge Helper"
                  >
                    <Sparkles className="h-4 w-4" /> Open
                  </button>
                </div>

                {selectedPath.outcomes?.length ? (
                  <div className="mt-4">
                    <h4 className="text-sm font-semibold text-slate-900">
                      Outcomes
                    </h4>
                    <ul className="mt-2 space-y-1 text-sm text-slate-800">
                      {selectedPath.outcomes.map((o) => (
                        <li key={o} className="flex items-start gap-2">
                          <CheckCircle2 className="h-4 w-4 mt-0.5 text-emerald-700" />
                          <span>{o}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="mt-4">
                  <h4 className="text-sm font-semibold text-slate-900">
                    Skills in this path
                  </h4>
                  <div className="mt-2 space-y-2">
                    {(selectedPath.skills || []).map((s, idx) => (
                      <div
                        key={s.id || `${idx}`}
                        className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2"
                      >
                        <div className="flex items-start gap-2">
                          <Circle className="h-4 w-4 mt-0.5 text-slate-500" />
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-900">
                              {idx + 1}. {normalizeStr(s.title) || "Skill"}
                            </div>
                            {s.subtitle ? (
                              <div className="text-xs text-slate-600">
                                {s.subtitle}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {selectedPath.safetyAlerts?.length ? (
                  <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                    <div className="flex items-start gap-2">
                      <ShieldAlert className="h-4 w-4 mt-0.5" />
                      <div>
                        <div className="font-semibold">Safety included</div>
                        <div className="text-xs mt-0.5">
                          This path contains {selectedPath.safetyAlerts.length}{" "}
                          safety note(s). Review them in the panel.
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {selectedPath.sources?.length ? (
                  <div className="mt-4">
                    <h4 className="text-sm font-semibold text-slate-900">
                      Sources
                    </h4>
                    <ul className="mt-2 space-y-2">
                      {selectedPath.sources.map((src, i) => {
                        const url = safeUrl(src?.url);
                        const label = normalizeStr(src?.label) || "Source";
                        return (
                          <li
                            key={`${i}-${label}`}
                            className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2"
                          >
                            <span className="text-sm text-slate-800 truncate">
                              {label}
                            </span>
                            {url ? (
                              <a
                                href={url}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="inline-flex items-center gap-1 text-sm font-medium text-slate-900 hover:underline"
                              >
                                Open <ExternalLink className="h-4 w-4" />
                              </a>
                            ) : (
                              <span className="text-xs text-slate-500">
                                No link
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Knowledge Helper Panel */}
      {panelOpen ? (
        <div className="mt-4 rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-slate-900" />
              <h2 className="text-lg font-semibold text-slate-900">
                Knowledge Helper
              </h2>
              {selectedPath ? (
                <Pill icon={<Tag className="h-3.5 w-3.5" />}>
                  {selectedPath.domain}
                </Pill>
              ) : null}
            </div>

            <IconButton onClick={() => setPanelOpen(false)} title="Close panel">
              <X className="h-4 w-4" />
            </IconButton>
          </div>

          <div className="mt-3">
            <KnowledgeHelperPanel
              householdId={householdId}
              userId={userId}
              domain={selectedPath?.domain || "general"}
              title={
                selectedPath
                  ? `Path: ${selectedPath.title}`
                  : "Knowledge Helper"
              }
              compact={false}
              defaultTab="skills"
              skills={skillsForPanel}
              safetyAlerts={safetyForPanel}
              issueTemplates={null}
              onClose={() => setPanelOpen(false)}
              onSkillAction={(actionId, skill) => {
                try {
                  console.log("[SkillsPathsPage] skill action", {
                    actionId,
                    skillId: skill?.id,
                    title: skill?.title,
                  });
                } catch {
                  // ignore
                }
              }}
              onTroubleshooterCompleted={(payload) => {
                try {
                  console.log(
                    "[SkillsPathsPage] troubleshooter completed",
                    payload
                  );
                } catch {
                  // ignore
                }
              }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
