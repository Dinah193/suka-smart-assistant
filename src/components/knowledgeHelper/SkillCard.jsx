// C:\Users\larho\suka-smart-assistant\src\components\knowledgeHelper\SkillCard.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  GraduationCap,
  CheckCircle2,
  Circle,
  Star,
  Sparkles,
  Timer,
  ClipboardList,
  ShieldAlert,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Flame,
  Tag,
  X,
  Play,
} from "lucide-react";
import SafetyAlertCard from "./SafetyAlertCard";

/**
 * SSA • Knowledge Helper • SkillCard
 * -----------------------------------------------------------------------------
 * A production-ready, self-contained card for teaching a skill with:
 *  - overview + time/level + tools + safety
 *  - step checklist with progress
 *  - expandable "why it matters" + tips + troubleshooting
 *  - optional sources + action buttons (start session, save, etc.)
 *
 * Works standalone (no DB required). If you pass onSave/onStart, you can wire it
 * to Dexie/session runner from the calling page.
 *
 * -----------------------------------------------------------------------------
 * Props
 *  - skill: object (recommended shape below; partial is ok)
 *      {
 *        id?: string,
 *        title?: string,
 *        subtitle?: string,
 *        domain?: string,           // cooking|cleaning|garden|...
 *        level?: "beginner"|"intermediate"|"advanced",
 *        durationMins?: number,
 *        description?: string,
 *        outcomes?: string[],
 *        prerequisites?: string[],
 *        tools?: string[],
 *        materials?: string[],
 *        safetyAlerts?: Array<alert>, // compatible with SafetyAlertCard
 *        steps?: Array<{ id?:string, title:string, details?:string, estMins?:number, optional?:boolean }>,
 *        tips?: string[],
 *        mistakes?: string[],
 *        troubleshooting?: Array<{ symptom:string, likelyCauses?:string[], fixes?:string[] }>,
 *        sources?: Array<{ label:string, url?:string }>,
 *        tags?: string[],
 *        updatedAt?: string,
 *        createdAt?: string,
 *      }
 *  - compact: boolean
 *  - defaultExpanded: boolean
 *  - defaultStepsExpanded: boolean
 *  - showSources: boolean
 *  - showSafety: boolean
 *  - showTags: boolean
 *  - showMeta: boolean (domain/level/time)
 *  - allowProgress: boolean (interactive checklist)
 *  - initialProgress: { [stepIdOrIndex]: boolean } (optional)
 *  - onProgressChange: (nextProgress, skill) => void
 *  - actions: Array<{ id, label, variant?: "primary"|"secondary"|"ghost", icon?: ReactNode }>
 *  - onAction: (actionId, skill) => void
 *  - onDismiss: (skill) => void (optional; shows an X button)
 *
 * Notes
 *  - No HTML injection; safe URL handling.
 *  - Accessible: keyboard toggles, aria labels.
 */

const DEFAULT_SOURCE = "components/knowledgeHelper/SkillCard";

const LEVEL_META = Object.freeze({
  beginner: {
    label: "Beginner",
    icon: GraduationCap,
    badge: "bg-emerald-100 text-emerald-900",
  },
  intermediate: {
    label: "Intermediate",
    icon: Sparkles,
    badge: "bg-amber-100 text-amber-900",
  },
  advanced: {
    label: "Advanced",
    icon: Flame,
    badge: "bg-rose-100 text-rose-900",
  },
});

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
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
function clampNum(v, min, max, fallback = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
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
function randomId(prefix = "skill") {
  const rnd =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Math.random().toString(16).slice(2)}${Math.random()
          .toString(16)
          .slice(2)}`;
  return `${prefix}_${rnd.replace(/-/g, "").slice(0, 18)}`;
}
function variantBtn(variant) {
  switch (variant) {
    case "primary":
      return "bg-slate-900 text-white hover:bg-slate-800";
    case "secondary":
      return "bg-white text-slate-900 border border-slate-200 hover:bg-slate-50";
    case "ghost":
    default:
      return "bg-transparent text-slate-900 hover:bg-slate-100";
  }
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

function Section({ title, children, compact }) {
  return (
    <div className={compact ? "mt-3" : "mt-4"}>
      <h4 className="text-sm font-semibold text-slate-900">{title}</h4>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function DotList({ items }) {
  const arr = normalizeArray(items);
  if (!arr.length) return null;
  return (
    <ul className="list-disc pl-5 space-y-1 text-sm text-slate-800">
      {arr.map((t, i) => (
        <li key={`${i}-${t.slice(0, 18)}`}>{t}</li>
      ))}
    </ul>
  );
}

function Collapsible({
  id,
  title,
  subtitle,
  expanded,
  setExpanded,
  children,
  compact,
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={[
          "w-full flex items-center justify-between gap-3 text-left",
          compact ? "p-3" : "p-4",
        ].join(" ")}
        aria-expanded={expanded}
        aria-controls={id}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-900">{title}</span>
            {subtitle ? (
              <span className="text-xs text-slate-600">{subtitle}</span>
            ) : null}
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-slate-700" />
        ) : (
          <ChevronDown className="h-4 w-4 text-slate-700" />
        )}
      </button>
      <div
        id={id}
        className={expanded ? (compact ? "px-3 pb-3" : "px-4 pb-4") : "hidden"}
      >
        {children}
      </div>
    </div>
  );
}

export default function SkillCard({
  skill,
  compact = false,
  defaultExpanded = false,
  defaultStepsExpanded = true,
  showSources = true,
  showSafety = true,
  showTags = true,
  showMeta = true,
  allowProgress = true,
  initialProgress = null,
  onProgressChange,
  actions = [],
  onAction,
  onDismiss,
}) {
  const s = isObj(skill) ? skill : {};
  const skillId = normalizeStr(s.id) || randomId("skill");
  const title = normalizeStr(s.title) || "Skill";
  const subtitle = normalizeStr(s.subtitle);
  const domain = normalizeStr(s.domain) || "";
  const levelKey = normalizeStr(s.level).toLowerCase() || "beginner";
  const level = LEVEL_META[levelKey] ? levelKey : "beginner";
  const levelMeta = LEVEL_META[level];

  const durationMins = clampNum(s.durationMins, 0, 60 * 24, null);
  const description = normalizeStr(s.description);

  const outcomes = normalizeArray(s.outcomes);
  const prerequisites = normalizeArray(s.prerequisites);
  const tools = normalizeArray(s.tools);
  const materials = normalizeArray(s.materials);
  const tips = normalizeArray(s.tips);
  const mistakes = normalizeArray(s.mistakes);
  const tags = normalizeArray(s.tags);

  const updatedAt = normalizeStr(s.updatedAt || "");
  const createdAt = normalizeStr(s.createdAt || "");
  const when = updatedAt
    ? formatWhen(updatedAt)
    : createdAt
    ? formatWhen(createdAt)
    : "";

  const sources = useMemo(() => {
    const src = Array.isArray(s.sources) ? s.sources : [];
    return src
      .map((x) => ({
        label: normalizeStr(x?.label) || "Source",
        url: safeUrl(x?.url),
      }))
      .filter((x) => x.label || x.url);
  }, [s.sources]);

  const troubleshooting = useMemo(() => {
    const arr = Array.isArray(s.troubleshooting) ? s.troubleshooting : [];
    return arr
      .map((t) => ({
        symptom: normalizeStr(t?.symptom),
        likelyCauses: normalizeArray(t?.likelyCauses),
        fixes: normalizeArray(t?.fixes),
      }))
      .filter((t) => t.symptom);
  }, [s.troubleshooting]);

  const safetyAlerts = useMemo(() => {
    const arr = Array.isArray(s.safetyAlerts) ? s.safetyAlerts : [];
    // do not assume shape; SafetyAlertCard sanitizes. Keep as-is.
    return arr.filter(Boolean);
  }, [s.safetyAlerts]);

  const steps = useMemo(() => {
    const arr = Array.isArray(s.steps) ? s.steps : [];
    return arr
      .map((st, idx) => {
        const id = normalizeStr(st?.id) || `${skillId}_step_${idx + 1}`;
        return {
          id,
          title: normalizeStr(st?.title) || `Step ${idx + 1}`,
          details: normalizeStr(st?.details),
          estMins: clampNum(st?.estMins, 0, 600, null),
          optional: !!st?.optional,
        };
      })
      .filter(Boolean);
  }, [s.steps, skillId]);

  // Expansion states
  const [expanded, setExpanded] = useState(!!defaultExpanded);
  const [stepsExpanded, setStepsExpanded] = useState(!!defaultStepsExpanded);

  const [progressMap, setProgressMap] = useState(() => {
    // key by step.id; fall back to indices if provided that way
    const base = {};
    if (isObj(initialProgress)) {
      for (const [k, v] of Object.entries(initialProgress))
        base[String(k)] = !!v;
    }
    // normalize to step.id keys
    const out = {};
    steps.forEach((st, i) => {
      const v = base[st.id] ?? base[String(i)] ?? base[String(i + 1)] ?? false;
      out[st.id] = !!v;
    });
    return out;
  });

  useEffect(() => {
    // if steps change (rare), ensure keys exist
    setProgressMap((prev) => {
      const next = { ...prev };
      let changed = false;
      steps.forEach((st) => {
        if (!(st.id in next)) {
          next[st.id] = false;
          changed = true;
        }
      });
      // remove stale keys
      for (const k of Object.keys(next)) {
        if (!steps.some((st) => st.id === k)) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [steps]);

  const progress = useMemo(() => {
    const total = steps.length;
    const done = steps.filter((st) => !!progressMap[st.id]).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const mins = steps.reduce(
      (sum, st) => sum + (Number.isFinite(st.estMins) ? st.estMins : 0),
      0
    );
    return { total, done, pct, estTotalMins: mins || null };
  }, [steps, progressMap]);

  const titleRef = useRef(null);

  useEffect(() => {
    if (defaultExpanded && titleRef.current) {
      if (document.activeElement === document.body)
        titleRef.current.focus({ preventScroll: true });
    }
  }, [defaultExpanded]);

  const dismissible = typeof onDismiss === "function";
  const actionList = Array.isArray(actions)
    ? actions.filter((a) => a && a.id && a.label)
    : [];

  function toggleStep(stepId) {
    if (!allowProgress) return;
    setProgressMap((prev) => {
      const next = { ...prev, [stepId]: !prev[stepId] };
      try {
        onProgressChange?.(next, s);
      } catch (e) {
        console.warn("[SkillCard] onProgressChange failed", e);
      }
      return next;
    });
  }

  function handleAction(actionId) {
    try {
      onAction?.(actionId, s);
    } catch (e) {
      console.warn("[SkillCard] onAction failed", e);
    }
  }

  const LevelIcon = levelMeta.icon;

  const headerPad = compact ? "p-3" : "p-4";
  const bodyPad = compact ? "px-3 pb-3" : "px-4 pb-4";

  const expandable =
    !!description ||
    outcomes.length ||
    prerequisites.length ||
    tools.length ||
    materials.length ||
    steps.length ||
    tips.length ||
    mistakes.length ||
    troubleshooting.length ||
    (showSources && sources.length) ||
    (showSafety && safetyAlerts.length) ||
    actionList.length;

  return (
    <section className="w-full">
      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
        {/* Header */}
        <div className={`${headerPad} flex items-start justify-between gap-3`}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3
                ref={titleRef}
                tabIndex={-1}
                className="min-w-0 truncate text-lg font-semibold text-slate-900"
                title={title}
              >
                {title}
              </h3>

              {showMeta ? (
                <>
                  <Pill
                    icon={
                      <LevelIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    }
                  >
                    {levelMeta.label}
                  </Pill>

                  {domain ? (
                    <Pill
                      icon={<Tag className="h-3.5 w-3.5" aria-hidden="true" />}
                    >
                      {domain}
                    </Pill>
                  ) : null}

                  {durationMins != null ? (
                    <Pill
                      icon={
                        <Timer className="h-3.5 w-3.5" aria-hidden="true" />
                      }
                    >
                      {durationMins} min
                    </Pill>
                  ) : progress.estTotalMins != null &&
                    progress.estTotalMins > 0 ? (
                    <Pill
                      icon={
                        <Timer className="h-3.5 w-3.5" aria-hidden="true" />
                      }
                    >
                      ~{progress.estTotalMins} min
                    </Pill>
                  ) : null}

                  {when ? (
                    <Pill
                      icon={
                        <Timer className="h-3.5 w-3.5" aria-hidden="true" />
                      }
                    >
                      Updated {when}
                    </Pill>
                  ) : null}
                </>
              ) : null}

              {allowProgress && steps.length ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-800">
                  <Star className="h-3.5 w-3.5" aria-hidden="true" />
                  {progress.done}/{progress.total} ({progress.pct}%)
                </span>
              ) : null}
            </div>

            {subtitle ? (
              <p className="mt-1 text-sm text-slate-600">{subtitle}</p>
            ) : null}

            {showTags && tags.length ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {tags.slice(0, 12).map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center rounded-full bg-white border border-slate-200 px-2 py-0.5 text-xs text-slate-700"
                  >
                    {t}
                  </span>
                ))}
                {tags.length > 12 ? (
                  <span className="text-xs text-slate-600">
                    +{tags.length - 12}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            {expandable ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                aria-expanded={expanded}
                aria-controls={`skill_${skillId}_body`}
              >
                {expanded ? (
                  <>
                    <ChevronUp className="h-4 w-4" aria-hidden="true" />
                    Hide
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                    Show
                  </>
                )}
              </button>
            ) : null}

            {dismissible ? (
              <button
                type="button"
                onClick={() => {
                  try {
                    onDismiss?.(s);
                  } catch (e) {
                    console.warn("[SkillCard] onDismiss failed", e);
                  }
                }}
                className="inline-flex items-center justify-center rounded-xl border border-slate-200 bg-white p-2 text-slate-700 hover:bg-slate-50"
                aria-label="Dismiss skill card"
                title="Dismiss"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        {/* Body */}
        {expanded ? (
          <div id={`skill_${skillId}_body`} className={bodyPad}>
            {description ? (
              <p className="text-sm text-slate-800 leading-6">{description}</p>
            ) : null}

            {/* Safety */}
            {showSafety && safetyAlerts.length ? (
              <Section title="Safety" compact={compact}>
                <div className="space-y-3">
                  {safetyAlerts.map((al, idx) => (
                    <SafetyAlertCard
                      key={al.id || `${skillId}_alert_${idx}`}
                      alert={al}
                      compact={compact}
                      defaultExpanded={
                        al?.severity === "high" || al?.severity === "critical"
                      }
                    />
                  ))}
                </div>
              </Section>
            ) : null}

            {/* Outcomes & prerequisites */}
            {outcomes.length ? (
              <Section title="You’ll be able to" compact={compact}>
                <DotList items={outcomes} />
              </Section>
            ) : null}

            {prerequisites.length ? (
              <Section title="Prerequisites" compact={compact}>
                <DotList items={prerequisites} />
              </Section>
            ) : null}

            {/* Tools & materials */}
            {tools.length || materials.length ? (
              <div
                className={
                  compact
                    ? "mt-3 grid gap-3 md:grid-cols-2"
                    : "mt-4 grid gap-4 md:grid-cols-2"
                }
              >
                {tools.length ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center gap-2">
                      <BookOpen
                        className="h-4 w-4 text-slate-900"
                        aria-hidden="true"
                      />
                      <span className="text-sm font-semibold text-slate-900">
                        Tools
                      </span>
                    </div>
                    <div className="mt-2">
                      <DotList items={tools} />
                    </div>
                  </div>
                ) : null}

                {materials.length ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center gap-2">
                      <ClipboardList
                        className="h-4 w-4 text-slate-900"
                        aria-hidden="true"
                      />
                      <span className="text-sm font-semibold text-slate-900">
                        Materials
                      </span>
                    </div>
                    <div className="mt-2">
                      <DotList items={materials} />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Steps */}
            {steps.length ? (
              <div className={compact ? "mt-3" : "mt-4"}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <ClipboardList
                      className="h-5 w-5 text-slate-900"
                      aria-hidden="true"
                    />
                    <h4 className="text-sm font-semibold text-slate-900">
                      Steps
                    </h4>
                    {allowProgress ? (
                      <span className="text-xs text-slate-600">
                        {progress.done}/{progress.total} complete
                      </span>
                    ) : (
                      <span className="text-xs text-slate-600">Checklist</span>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => setStepsExpanded((v) => !v)}
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50"
                    aria-expanded={stepsExpanded}
                  >
                    {stepsExpanded ? (
                      <>
                        <ChevronUp className="h-4 w-4" aria-hidden="true" />{" "}
                        Collapse
                      </>
                    ) : (
                      <>
                        <ChevronDown className="h-4 w-4" aria-hidden="true" />{" "}
                        Expand
                      </>
                    )}
                  </button>
                </div>

                {stepsExpanded ? (
                  <div className="mt-3 space-y-2">
                    {steps.map((st, idx) => {
                      const done = !!progressMap[st.id];
                      return (
                        <div
                          key={st.id}
                          className={[
                            "rounded-2xl border px-3 py-2",
                            done
                              ? "border-emerald-200 bg-emerald-50"
                              : "border-slate-200 bg-white",
                          ].join(" ")}
                        >
                          <div className="flex items-start gap-3">
                            <button
                              type="button"
                              disabled={!allowProgress}
                              onClick={() => toggleStep(st.id)}
                              className={[
                                "mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-xl border",
                                allowProgress
                                  ? "hover:bg-slate-50"
                                  : "opacity-70 cursor-default",
                                done
                                  ? "border-emerald-300 bg-white"
                                  : "border-slate-200 bg-white",
                              ].join(" ")}
                              aria-label={
                                allowProgress
                                  ? done
                                    ? "Mark step incomplete"
                                    : "Mark step complete"
                                  : "Step"
                              }
                              title={
                                allowProgress
                                  ? done
                                    ? "Undo"
                                    : "Complete"
                                  : undefined
                              }
                            >
                              {done ? (
                                <CheckCircle2
                                  className="h-5 w-5 text-emerald-700"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Circle
                                  className="h-5 w-5 text-slate-500"
                                  aria-hidden="true"
                                />
                              )}
                            </button>

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="text-sm font-semibold text-slate-900">
                                  {idx + 1}. {st.title}
                                </span>
                                {st.optional ? (
                                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                                    Optional
                                  </span>
                                ) : null}
                                {st.estMins != null ? (
                                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                                    ~{st.estMins} min
                                  </span>
                                ) : null}
                              </div>
                              {st.details ? (
                                <p className="mt-1 text-sm text-slate-700 leading-6 whitespace-pre-line">
                                  {st.details}
                                </p>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Tips & mistakes */}
            {tips.length || mistakes.length ? (
              <div
                className={
                  compact
                    ? "mt-3 grid gap-3 md:grid-cols-2"
                    : "mt-4 grid gap-4 md:grid-cols-2"
                }
              >
                {tips.length ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center gap-2">
                      <Sparkles
                        className="h-4 w-4 text-slate-900"
                        aria-hidden="true"
                      />
                      <span className="text-sm font-semibold text-slate-900">
                        Tips
                      </span>
                    </div>
                    <div className="mt-2">
                      <DotList items={tips} />
                    </div>
                  </div>
                ) : null}

                {mistakes.length ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
                    <div className="flex items-center gap-2">
                      <ShieldAlert
                        className="h-4 w-4 text-slate-900"
                        aria-hidden="true"
                      />
                      <span className="text-sm font-semibold text-slate-900">
                        Common mistakes
                      </span>
                    </div>
                    <div className="mt-2">
                      <DotList items={mistakes} />
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Troubleshooting */}
            {troubleshooting.length ? (
              <Section title="Troubleshooting" compact={compact}>
                <div className="space-y-2">
                  {troubleshooting.map((t, idx) => (
                    <div
                      key={`${idx}-${t.symptom}`}
                      className="rounded-2xl border border-slate-200 bg-white p-3"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900">
                          {t.symptom}
                        </span>
                      </div>

                      {t.likelyCauses.length ? (
                        <div className="mt-2">
                          <span className="text-xs font-medium text-slate-700">
                            Likely causes
                          </span>
                          <ul className="mt-1 list-disc pl-5 text-sm text-slate-800 space-y-1">
                            {t.likelyCauses.map((c, i) => (
                              <li key={`${i}-${c.slice(0, 18)}`}>{c}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {t.fixes.length ? (
                        <div className="mt-2">
                          <span className="text-xs font-medium text-slate-700">
                            Fixes
                          </span>
                          <ul className="mt-1 list-disc pl-5 text-sm text-slate-800 space-y-1">
                            {t.fixes.map((f, i) => (
                              <li key={`${i}-${f.slice(0, 18)}`}>{f}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </Section>
            ) : null}

            {/* Sources */}
            {showSources && sources.length ? (
              <Section title="Sources" compact={compact}>
                <ul className="space-y-2">
                  {sources.map((src, idx) => (
                    <li
                      key={`${idx}-${src.label}`}
                      className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2"
                    >
                      <span className="min-w-0 truncate text-sm text-slate-800">
                        {src.label}
                      </span>
                      {src.url ? (
                        <a
                          href={src.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex items-center gap-1 text-sm font-medium text-slate-900 hover:underline"
                        >
                          Open{" "}
                          <ExternalLink
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                        </a>
                      ) : (
                        <span className="text-xs text-slate-600">No link</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}

            {/* Actions */}
            {actionList.length || allowProgress ? (
              <div className={compact ? "mt-3" : "mt-4"}>
                <div className="flex flex-wrap items-center gap-2">
                  {/* Helpful default action for run/start if caller passes */}
                  {actionList.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => handleAction(a.id)}
                      className={[
                        "inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium",
                        variantBtn(a.variant),
                      ].join(" ")}
                    >
                      {a.icon ? (
                        <span className="inline-flex h-4 w-4 items-center justify-center">
                          {a.icon}
                        </span>
                      ) : null}
                      {a.label}
                    </button>
                  ))}

                  {/* Optional progress quick controls */}
                  {allowProgress && steps.length ? (
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          const next = {};
                          steps.forEach((st) => (next[st.id] = true));
                          setProgressMap(next);
                          try {
                            onProgressChange?.(next, s);
                          } catch (e) {
                            console.warn(
                              "[SkillCard] onProgressChange failed",
                              e
                            );
                          }
                        }}
                        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                        title="Mark all steps complete"
                      >
                        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                        Complete all
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          const next = {};
                          steps.forEach((st) => (next[st.id] = false));
                          setProgressMap(next);
                          try {
                            onProgressChange?.(next, s);
                          } catch (e) {
                            console.warn(
                              "[SkillCard] onProgressChange failed",
                              e
                            );
                          }
                        }}
                        className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 hover:bg-slate-50"
                        title="Reset step progress"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                        Reset
                      </button>
                    </div>
                  ) : null}
                </div>

                {/* Optional “start” hint if no actions passed */}
                {!actionList.length ? (
                  <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                    <span className="inline-flex items-center gap-2">
                      <Play className="h-4 w-4" aria-hidden="true" />
                      Wire this card to your SessionRunner by passing an action
                      like{" "}
                      <code className="rounded bg-white px-1 py-0.5">
                        Start session
                      </code>
                      .
                    </span>
                    <span className="sr-only">{DEFAULT_SOURCE}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* If collapsed: tiny helper summary */}
      {!expanded && (description || steps.length || safetyAlerts.length) ? (
        <div className="mt-2 text-xs text-slate-600">
          {description ? "Overview available. " : ""}
          {steps.length ? `${steps.length} step(s). ` : ""}
          {showSafety && safetyAlerts.length
            ? `${safetyAlerts.length} safety note(s).`
            : ""}
        </div>
      ) : null}
    </section>
  );
}
