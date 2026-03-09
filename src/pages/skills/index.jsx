// C:\Users\larho\suka-smart-assistant\src\pages\skills\index.jsx
/* eslint-disable no-console */
import React, { useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Search,
  Filter,
  Sparkles,
  Wrench,
  ShieldAlert,
  ArrowRight,
  LayoutGrid,
  List,
  Tag,
  Clock,
  RefreshCw,
  X,
  ExternalLink,
  Target,
  ChevronRight,
} from "lucide-react";

import KnowledgeHelperPanel from "@/components/knowledgeHelper/KnowledgeHelperPanel";

const DEFAULT_SOURCE = "pages/skills/index";
const PATHS_ROUTE = "/skills/paths";

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
function randomId(prefix = "sk") {
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

function Chip({ active, children, onClick, title }) {
  const cls = [
    "rounded-full px-3 py-1 text-xs font-medium border",
    active
      ? "bg-slate-900 text-white border-slate-900"
      : "bg-white text-slate-800 border-slate-200 hover:bg-slate-50",
  ].join(" ");
  return (
    <button
      type="button"
      onClick={onClick}
      className={cls}
      title={title}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function IconButton({ onClick, title, children, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!!disabled}
      className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white p-2 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

function getDefaultSkills() {
  return [
    {
      id: "skill_mise_en_place",
      title: "Mise en place",
      subtitle: "Set up ingredients + tools so cooking is smooth and timed.",
      domain: "cooking",
      level: "beginner",
      durationMins: 15,
      tags: ["timing", "prep", "workflow"],
      steps: [
        { title: "Read the plan", details: "Scan steps and timing." },
        { title: "Gather tools", details: "Pan, spatula, bowls." },
        { title: "Measure + prep", details: "Pre-measure, chop, and stage." },
      ],
      safetyAlerts: [],
    },
    {
      id: "skill_knife_basic_cuts",
      title: "Knife skills: basic cuts",
      subtitle: "Slice, dice, mince—without hurting yourself.",
      domain: "cooking",
      level: "beginner",
      durationMins: 25,
      tags: ["knife", "safety"],
      safetyAlerts: [
        {
          id: "knife_alert",
          severity: "high",
          title: "Knife safety",
          summary: "Use a stable board and keep fingertips tucked (claw grip).",
          steps: [
            "Damp towel under board.",
            "Curl fingers.",
            "Don’t try to catch a falling knife.",
          ],
        },
      ],
      steps: [
        { title: "Set a non-slip board", details: "Stabilize the board." },
        { title: "Pinch grip", details: "Grip near blade for control." },
        { title: "Claw hand", details: "Knuckles guide, fingertips tucked." },
      ],
    },
    {
      id: "skill_bathroom_speed",
      title: "Speed-clean bathroom",
      subtitle: "Sink, toilet, mirror, quick floor.",
      domain: "cleaning",
      level: "beginner",
      durationMins: 15,
      tags: ["bathroom", "reset", "chemicals"],
      safetyAlerts: [
        {
          id: "chem_mix",
          severity: "critical",
          title: "Never mix cleaners",
          summary: "Bleach + ammonia/acid can create dangerous gases.",
          steps: [
            "Use one product at a time.",
            "Ventilate.",
            "Rinse between products.",
          ],
        },
      ],
      steps: [
        { title: "Ventilate", details: "Run fan/open window." },
        { title: "Apply cleaner + dwell", details: "Let sit 3–5 minutes." },
        { title: "Wipe top-to-bottom", details: "Finish with floor." },
      ],
    },
    {
      id: "skill_label_rotate",
      title: "Label + rotate like a storehouse",
      subtitle: "FIFO rotation + clear labels.",
      domain: "preservation",
      level: "beginner",
      durationMins: 20,
      tags: ["fifo", "labels", "rotation"],
      steps: [
        {
          title: "Choose label format",
          details: "Item • amount • date • batch.",
        },
        { title: "Newest behind", details: "First-in, first-out." },
        { title: "Use-soon bin", details: "Weekly cookdown." },
      ],
    },
  ];
}

function collectSafetyFromSkills(skills) {
  const out = [];
  const seen = new Set();
  (skills || []).forEach((s) => {
    const alerts = Array.isArray(s?.safetyAlerts) ? s.safetyAlerts : [];
    alerts.forEach((a) => {
      const key =
        a?.id || `${normalizeStr(a?.title)}::${normalizeStr(a?.summary)}`;
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(a);
    });
  });
  return out;
}

function scoreSkillMatch(skill, q) {
  const query = normalizeStr(q).toLowerCase();
  if (!query) return 0;

  const hay = [
    normalizeStr(skill.title),
    normalizeStr(skill.subtitle),
    normalizeStr(skill.domain),
    normalizeArray(skill.tags).join(" "),
  ]
    .join(" ")
    .toLowerCase();

  let score = 0;
  if (normalizeStr(skill.title).toLowerCase().includes(query)) score += 5;
  if (normalizeStr(skill.subtitle).toLowerCase().includes(query)) score += 3;
  if (normalizeStr(skill.domain).toLowerCase().includes(query)) score += 2;
  if (normalizeArray(skill.tags).some((t) => t.toLowerCase().includes(query)))
    score += 2;
  if (hay.includes(query)) score += 1;
  return score;
}

export default function SkillsIndexPage() {
  const pageId = useMemo(() => randomId("skillsHub"), []);
  const [view, setView] = useState(VIEW.GRID);

  const [householdId] = useState("default");
  const [userId] = useState("anon");

  const [query, setQuery] = useState("");
  const [domain, setDomain] = useState("");
  const [onlySafety, setOnlySafety] = useState(false);

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelTab, setPanelTab] = useState("skills");
  const [panelDomain, setPanelDomain] = useState("general");

  const searchRef = useRef(null);

  const skills = useMemo(() => getDefaultSkills(), []);
  const safetyAlerts = useMemo(() => collectSafetyFromSkills(skills), [skills]);

  const filteredSkills = useMemo(() => {
    const q = normalizeStr(query);
    const d = normalizeStr(domain);

    let out = skills.slice();
    if (d) out = out.filter((s) => normalizeStr(s.domain) === d);
    if (onlySafety)
      out = out.filter(
        (s) => Array.isArray(s.safetyAlerts) && s.safetyAlerts.length > 0
      );

    if (q) {
      out = out
        .map((s) => ({ s, score: scoreSkillMatch(s, q) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.s);
    } else {
      out.sort((a, b) =>
        normalizeStr(a.title).localeCompare(normalizeStr(b.title))
      );
    }
    return out;
  }, [skills, query, domain, onlySafety]);

  const allDomains = useMemo(() => {
    const set = new Set(DOMAINS);
    skills.forEach((s) => s.domain && set.add(s.domain));
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [skills]);

  function resetFilters() {
    setQuery("");
    setDomain("");
    setOnlySafety(false);
    setTimeout(() => {
      try {
        searchRef.current?.focus?.();
      } catch (err) {
        // ignore
      }
    }, 30);
  }

  function openPanel(opts) {
    const o = opts || {};
    setPanelTab(o.tab || "skills");
    setPanelDomain(o.d || "general");
    setPanelOpen(true);
  }

  const domainTiles = useMemo(() => {
    return [
      {
        domain: "cooking",
        title: "Cooking",
        subtitle: "Prep, timing, safety, and step-by-step workflows.",
        icon: <Sparkles className="h-5 w-5" />,
        defaultTab: "skills",
      },
      {
        domain: "cleaning",
        title: "Cleaning",
        subtitle: "Fast resets, tool checklists, safe chemical usage.",
        icon: <Wrench className="h-5 w-5" />,
        defaultTab: "skills",
      },
      {
        domain: "preservation",
        title: "Preservation",
        subtitle: "Labeling, freezing, dehydrating, storage rotation.",
        icon: <BookOpen className="h-5 w-5" />,
        defaultTab: "skills",
      },
      {
        domain: "general",
        title: "Troubleshoot",
        subtitle: "Diagnose issues and follow safe, practical steps.",
        icon: <Wrench className="h-5 w-5" />,
        defaultTab: "troubleshoot",
      },
      {
        domain: "general",
        title: "Safety",
        subtitle: "Review critical alerts and safe handling notes.",
        icon: <ShieldAlert className="h-5 w-5" />,
        defaultTab: "safety",
      },
    ];
  }, []);

  const quickTilesBlock = (
    <div className="mt-4 grid gap-3 md:grid-cols-3">
      {domainTiles.map((t, idx) => (
        <button
          key={`${t.title}-${idx}`}
          type="button"
          onClick={() => openPanel({ tab: t.defaultTab, d: t.domain })}
          className="rounded-2xl border border-slate-200 bg-white p-3 text-left hover:bg-slate-50 transition"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 text-slate-900">
                  {t.icon}
                </span>
                <div className="text-sm font-semibold text-slate-900">
                  {t.title}
                </div>
              </div>
              <div className="mt-2 text-sm text-slate-600">{t.subtitle}</div>
            </div>
            <ChevronRight className="h-5 w-5 text-slate-400 mt-2" />
          </div>
        </button>
      ))}
    </div>
  );

  const skillCardsBlock =
    filteredSkills.length === 0 ? (
      <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
        No skills match your search/filters.
      </div>
    ) : (
      <div
        className={
          view === VIEW.GRID
            ? "mt-3 grid gap-4 md:grid-cols-2"
            : "mt-3 space-y-3"
        }
      >
        {filteredSkills.map((s) => {
          const safetyCount = Array.isArray(s.safetyAlerts)
            ? s.safetyAlerts.length
            : 0;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() =>
                openPanel({ tab: "skills", d: s.domain || "general" })
              }
              className="text-left rounded-2xl border border-slate-200 bg-white p-3 hover:bg-slate-50 transition"
              title="Open helper (skills tab) for this domain"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900 truncate">
                      {s.title}
                    </span>
                    <Pill icon={<Tag className="h-3.5 w-3.5" />}>
                      {s.domain}
                    </Pill>
                    <Pill icon={<Clock className="h-3.5 w-3.5" />}>
                      {Number.isFinite(Number(s.durationMins))
                        ? `${s.durationMins} min`
                        : "—"}
                    </Pill>
                    {s.level ? (
                      <Pill icon={<Sparkles className="h-3.5 w-3.5" />}>
                        {s.level}
                      </Pill>
                    ) : null}
                    {safetyCount ? (
                      <Pill icon={<ShieldAlert className="h-3.5 w-3.5" />}>
                        {safetyCount} safety
                      </Pill>
                    ) : null}
                  </div>

                  {s.subtitle ? (
                    <p className="mt-1 text-sm text-slate-600 line-clamp-2">
                      {s.subtitle}
                    </p>
                  ) : null}

                  {Array.isArray(s.tags) && s.tags.length ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {normalizeArray(s.tags)
                        .slice(0, 8)
                        .map((t) => (
                          <span
                            key={t}
                            className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-xs text-slate-700"
                          >
                            {t}
                          </span>
                        ))}
                      {normalizeArray(s.tags).length > 8 ? (
                        <span className="text-xs text-slate-500">
                          +{normalizeArray(s.tags).length - 8}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <ArrowRight className="h-5 w-5 text-slate-400 mt-1" />
              </div>
            </button>
          );
        })}
      </div>
    );

  const panelBlock = panelOpen ? (
    <div className="mt-4 rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-slate-900" />
          <h2 className="text-lg font-semibold text-slate-900">
            Knowledge Helper
          </h2>
          <Pill icon={<Tag className="h-3.5 w-3.5" />}>{panelDomain}</Pill>
          <Pill icon={<BookOpen className="h-3.5 w-3.5" />}>hub</Pill>
        </div>

        <IconButton onClick={() => setPanelOpen(false)} title="Close panel">
          <X className="h-4 w-4" />
        </IconButton>
      </div>

      <div className="mt-3">
        <KnowledgeHelperPanel
          householdId={householdId}
          userId={userId}
          domain={panelDomain || "general"}
          title="Knowledge Helper"
          compact={false}
          defaultTab={panelTab}
          skills={skills}
          safetyAlerts={safetyAlerts}
          issueTemplates={null}
          onClose={() => setPanelOpen(false)}
          onSkillAction={(actionId, skill) => {
            try {
              console.log("[SkillsIndexPage] skill action", {
                actionId,
                skillId: skill?.id,
                title: skill?.title,
              });
            } catch (err) {
              // ignore
            }
          }}
          onTroubleshooterCompleted={(payload) => {
            try {
              console.log(
                "[SkillsIndexPage] troubleshooter completed",
                payload
              );
            } catch (err) {
              // ignore
            }
          }}
        />
      </div>

      <div className="mt-3 text-xs text-slate-600 flex flex-wrap items-center gap-2">
        <span>Want guided sequences?</span>
        <a
          href={PATHS_ROUTE}
          className="inline-flex items-center gap-1 text-slate-900 hover:underline"
          title="Go to Learning Paths"
        >
          Learning Paths <ExternalLink className="h-3.5 w-3.5" />
        </a>
        <span className="ml-auto text-slate-500">
          Panel uses Dexie persistence best-effort (if available).
        </span>
      </div>
    </div>
  ) : null;

  return (
    <div className="w-full">
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-slate-900">Skills</h1>
              <Pill icon={<BookOpen className="h-3.5 w-3.5" />}>SSA</Pill>
              <Pill icon={<Clock className="h-3.5 w-3.5" />}>
                {formatWhen(nowISO())}
              </Pill>
              <span className="text-xs text-slate-500">
                ({DEFAULT_SOURCE} • {pageId})
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-600">
              Learn household skills, follow checklists, troubleshoot issues,
              and review safety notes. Use Learning Paths for guided sequences.
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
              <RefreshCw className="h-4 w-4" />
            </IconButton>

            <a
              href={PATHS_ROUTE}
              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
              title="Open Learning Paths"
            >
              <Target className="h-4 w-4" />
              Learning Paths
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>

        {quickTilesBlock}

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <label className="md:col-span-2 block">
            <span className="text-sm font-medium text-slate-900">
              Search skills
            </span>
            <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
              <Search className="h-4 w-4 text-slate-500" />
              <input
                ref={searchRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, tags, domain…"
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
            <span className="text-sm font-medium text-slate-900">Filters</span>
            <div className="mt-1 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
              <Filter className="h-4 w-4 text-slate-500" />
              <span className="text-sm text-slate-800">
                {filteredSkills.length} / {skills.length}
              </span>
              <span className="ml-auto text-xs text-slate-500">skills</span>
            </div>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 text-sm">
            <span className="text-sm font-medium text-slate-900">Domain</span>
            <select
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-slate-400"
            >
              <option value="">All</option>
              {allDomains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>

          <Chip
            active={onlySafety}
            onClick={() => setOnlySafety((v) => !v)}
            title="Show skills that include safety alerts"
          >
            <span className="inline-flex items-center gap-2">
              <ShieldAlert className="h-4 w-4" /> Safety only
            </span>
          </Chip>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Chip
              active={false}
              onClick={() =>
                openPanel({ tab: "troubleshoot", d: domain || "general" })
              }
              title="Open troubleshooter"
            >
              <span className="inline-flex items-center gap-2">
                <Wrench className="h-4 w-4" /> Troubleshoot
              </span>
            </Chip>
            <Chip
              active={false}
              onClick={() =>
                openPanel({ tab: "safety", d: domain || "general" })
              }
              title="Open safety"
            >
              <span className="inline-flex items-center gap-2">
                <ShieldAlert className="h-4 w-4" /> Safety
              </span>
            </Chip>
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-slate-200 bg-white shadow-sm p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Tag className="h-5 w-5 text-slate-900" />
            <h2 className="text-lg font-semibold text-slate-900">
              Skills Library (Preview)
            </h2>
            <span className="text-xs text-slate-500">
              {filteredSkills.length} shown
            </span>
          </div>

          <button
            type="button"
            onClick={() => openPanel({ tab: "skills", d: domain || "general" })}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-800"
            title="Open Knowledge Helper"
          >
            <Sparkles className="h-4 w-4" />
            Open Helper
          </button>
        </div>

        {skillCardsBlock}

        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          <div className="flex flex-wrap items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-slate-700" />
            <span className="font-medium text-slate-900">
              Safety alerts available:
            </span>
            <span>{safetyAlerts.length}</span>
            <span className="ml-auto text-xs text-slate-500">
              {DEFAULT_SOURCE}
            </span>
          </div>
        </div>
      </div>

      {panelBlock}
    </div>
  );
}
