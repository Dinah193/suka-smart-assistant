// src/components/meals/decider/DeciderExplainBadge.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try {
  Icons = require("lucide-react");
} catch {}

let eventBus = null;
try {
  eventBus = require("@/services/events/eventBus").eventBus || null;
} catch {}

let automation = null;
try {
  automation = require("@/services/automation/runtime").automation || null;
} catch {}

/* --------------------------------- Utilities --------------------------------- */
const clamp = (n, min = 0, max = 100) => Math.max(min, Math.min(max, n));
const pct = (num, den) => (den ? Math.round((num / den) * 100) : 0);
const asUsd = (v) =>
  typeof v === "number" && !Number.isNaN(v)
    ? v.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      })
    : "—";

const toCompactJson = (obj) => {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return "{}";
  }
};

const badgeColorByScore = (score) => {
  if (score >= 85) return "bg-emerald-600";
  if (score >= 70) return "bg-green-600";
  if (score >= 55) return "bg-yellow-600";
  if (score >= 40) return "bg-orange-600";
  return "bg-rose-600";
};

const trendColor = (delta) =>
  delta > 0
    ? "text-emerald-600"
    : delta < 0
    ? "text-rose-600"
    : "text-gray-500";

/* ----------------------------- Subcomponents (UI) ----------------------------- */
const ProgressBar = ({ value = 0, label, className = "" }) => (
  <div className={`w-full ${className}`}>
    {label ? (
      <div className="flex items-center justify-between text-xs mb-1">
        <span>{label}</span>
        <span>{clamp(value)}%</span>
      </div>
    ) : null}
    <div className="w-full h-2 rounded-full bg-gray-200 overflow-hidden">
      <div
        className="h-2 rounded-full bg-gradient-to-r from-indigo-500 to-blue-500"
        style={{ width: `${clamp(value)}%` }}
      />
    </div>
  </div>
);

const Pill = ({ children, tone = "default", title }) => {
  const toneMap = {
    default: "bg-gray-100 text-gray-800 border border-gray-200",
    ok: "bg-emerald-50 text-emerald-700 border border-emerald-200",
    warn: "bg-amber-50 text-amber-800 border border-amber-200",
    bad: "bg-rose-50 text-rose-700 border border-rose-200",
    info: "bg-blue-50 text-blue-700 border border-blue-200",
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs mr-1.5 mb-1 border ${
        toneMap[tone] || toneMap.default
      }`}
    >
      {children}
    </span>
  );
};

const FactorRow = ({
  icon: IconComp,
  label,
  weight = 1,
  score = 0,
  impact = 0,
  note,
  children,
}) => {
  return (
    <div className="rounded-lg border p-3 mb-2">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            {IconComp ? <IconComp className="w-4 h-4 opacity-80" /> : null}
            <div className="font-medium text-sm">{label}</div>
            <span className="text-[10px] text-gray-500">wt {weight}</span>
          </div>
          {note ? (
            <div className="text-xs text-gray-600 mt-1">{note}</div>
          ) : null}
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold">{clamp(score)}%</div>
          <div className={`text-[10px] ${trendColor(impact)}`}>
            {impact >= 0 ? "+" : ""}
            {impact} impact
          </div>
        </div>
      </div>
      <ProgressBar value={score} className="mt-2" />
      {children}
    </div>
  );
};

/* ------------------------------- Main component ------------------------------- */
/**
 * DeciderExplainBadge
 * Compact badge that opens an explainer sheet for "why this was chosen".
 *
 * Props:
 * - decision: {
 *     id, title, slot, date, totalScore (0-100),
 *     factors: [{ id, label, score, weight, impact, note, icon }],
 *     nutrition: { calories, protein, carbs, fat, macroMatchPct },
 *     inventory: { haveCount, missingCount, matchPct, keyHits: string[] },
 *     budget: { estCost, inBudget: boolean, deltaToBudget: number },
 *     calendar: { fitPct, sabbathGuard: boolean, feastDay?: string, conflictNotes?: string[] },
 *     tags: string[],
 *     nudges?: string[],   // NBA suggestions
 *     blockers?: string[], // hard blockers
 *     warnings?: string[], // soft warnings
 *     provenance?: { source, author, license, url }
 *   }
 * - size: "sm" | "md"
 * - onOpen?: (decision) => void
 * - onClose?: (decision) => void
 */
const DeciderExplainBadge = ({ decision, size = "sm", onOpen, onClose }) => {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  const {
    Info = () => null,
    HelpCircle = () => null,
    ChevronDown = () => null,
    ExternalLink = () => null,
    Salad = () => null,
    UtensilsCrossed = () => null,
    Wallet = () => null,
    CalendarClock = () => null,
    ShieldCheck = () => null,
    TriangleAlert = () => null,
    CheckCircle2 = () => null,
    XCircle = () => null,
    Tag = () => null,
    Copy = () => null,
    Sparkles = () => null,
    Soup = () => null,
    Apple = () => null,
    Drumstick = () => null,
    Sandwich = () => null,
    ClipboardList = () => null,
  } = Icons;

  const totalScore = clamp(decision?.totalScore ?? 0);
  const badgeTone = badgeColorByScore(totalScore);
  const hasIssues =
    (decision?.warnings?.length || 0) + (decision?.blockers?.length || 0) > 0;

  const macroSummary = useMemo(() => {
    const n = decision?.nutrition || {};
    const parts = [];
    if (typeof n.calories === "number")
      parts.push(`${Math.round(n.calories)} kcal`);
    if (typeof n.protein === "number")
      parts.push(`${Math.round(n.protein)}g P`);
    if (typeof n.carbs === "number") parts.push(`${Math.round(n.carbs)}g C`);
    if (typeof n.fat === "number") parts.push(`${Math.round(n.fat)}g F`);
    return parts.join(" • ");
  }, [decision]);

  const handleOpen = () => {
    setOpen(true);
    onOpen?.(decision);
    try {
      eventBus?.emit?.("meals.decider.explain.opened", {
        id: decision?.id,
        ts: Date.now(),
      });
      automation?.runTemplate?.("meals.decider.explain.opened", { decision });
    } catch {}
  };

  const handleClose = () => {
    setOpen(false);
    onClose?.(decision);
    try {
      eventBus?.emit?.("meals.decider.explain.closed", {
        id: decision?.id,
        ts: Date.now(),
      });
    } catch {}
  };

  useEffect(() => {
    const esc = (e) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  useEffect(() => {
    const clickAway = (e) => {
      if (!open) return;
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", clickAway);
    return () => document.removeEventListener("mousedown", clickAway);
  }, [open]);

  const copyJson = async () => {
    try {
      await navigator.clipboard.writeText(toCompactJson(decision));
      // optional toast if you have it globally
      eventBus?.emit?.("toast", {
        level: "success",
        message: "Explanation copied to clipboard.",
      });
    } catch {
      eventBus?.emit?.("toast", {
        level: "error",
        message: "Could not copy explanation.",
      });
    }
  };

  /* --------------------------------- Factors UI -------------------------------- */
  const factors = decision?.factors || [];
  const factorIconMap = {
    Nutrition: Salad,
    Inventory: ClipboardList,
    Budget: Wallet,
    Calendar: CalendarClock,
    Preferences: Tag,
    SabbathGuard: ShieldCheck,
    "Feast Day": ShieldCheck,
  };

  /* --------------------------------- Renderers --------------------------------- */
  const Badge = () => (
    <button
      type="button"
      onClick={handleOpen}
      className={`inline-flex items-center gap-2 text-white ${badgeTone} ${
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3 py-2 text-sm"
      } rounded-full shadow transition hover:opacity-95 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={`decider-explain-${decision?.id || "x"}`}
      title="Why this choice?"
    >
      <HelpCircle className="w-4 h-4 opacity-90" />
      <span className="font-semibold">{totalScore}</span>
      <span className="opacity-90">Why?</span>
      <ChevronDown
        className={`w-4 h-4 ${open ? "rotate-180" : ""} transition-transform`}
      />
    </button>
  );

  const Header = () => (
    <div className="flex items-start justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <UtensilsCrossed className="w-5 h-5" />
          <h3 className="text-lg font-semibold truncate">
            {decision?.title || "Meal choice"}
          </h3>
        </div>
        <div className="text-xs text-gray-600 mt-1">
          Slot: <span className="font-medium">{decision?.slot || "—"}</span>
          {decision?.date ? <> • {decision.date}</> : null}
          {typeof decision?.budget?.estCost === "number" ? (
            <> • Est: {asUsd(decision.budget.estCost)}</>
          ) : null}
        </div>
      </div>
      <div className="text-right">
        <div
          className={`inline-flex items-center px-2 py-0.5 rounded-md text-white ${badgeTone}`}
        >
          Score: <span className="font-semibold ml-1">{totalScore}</span>
        </div>
        <div className="mt-1 text-[10px] text-gray-500">
          Higher = better overall fit
        </div>
      </div>
    </div>
  );

  const NutritionBlock = () => {
    const n = decision?.nutrition || {};
    const MacroIcon = Soup;
    const ProteinIcon = Drumstick;
    const CarbIcon = Apple;
    const FatIcon = Sandwich;
    return (
      <div className="rounded-lg border p-3">
        <div className="flex items-center gap-2 mb-2">
          <MacroIcon className="w-4 h-4" />
          <div className="font-medium">Nutrition</div>
          {typeof n.macroMatchPct === "number" ? (
            <Pill
              tone={
                n.macroMatchPct >= 70
                  ? "ok"
                  : n.macroMatchPct >= 50
                  ? "warn"
                  : "bad"
              }
            >
              Macro match {clamp(n.macroMatchPct)}%
            </Pill>
          ) : null}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
          <div className="flex items-center gap-2">
            <ProteinIcon className="w-4 h-4" />
            {typeof n.protein === "number"
              ? `${Math.round(n.protein)}g protein`
              : "—"}
          </div>
          <div className="flex items-center gap-2">
            <CarbIcon className="w-4 h-4" />
            {typeof n.carbs === "number"
              ? `${Math.round(n.carbs)}g carbs`
              : "—"}
          </div>
          <div className="flex items-center gap-2">
            <FatIcon className="w-4 h-4" />
            {typeof n.fat === "number" ? `${Math.round(n.fat)}g fat` : "—"}
          </div>
          <div className="flex items-center gap-2">
            <Salad className="w-4 h-4" />
            {typeof n.calories === "number"
              ? `${Math.round(n.calories)} kcal`
              : "—"}
          </div>
        </div>
        {typeof n.macroMatchPct === "number" ? (
          <ProgressBar value={n.macroMatchPct} className="mt-2" />
        ) : null}
        {macroSummary ? (
          <div className="text-xs text-gray-600 mt-2">{macroSummary}</div>
        ) : null}
      </div>
    );
  };

  const InventoryBlock = () => {
    const inv = decision?.inventory || {};
    const have = inv.haveCount || 0;
    const miss = inv.missingCount || 0;
    const total = have + miss;
    const m =
      typeof inv.matchPct === "number" ? inv.matchPct : pct(have, total);
    return (
      <div className="rounded-lg border p-3">
        <div className="flex items-center gap-2 mb-2">
          <ClipboardList className="w-4 h-4" />
          <div className="font-medium">Inventory Fit</div>
          <Pill tone={m >= 70 ? "ok" : m >= 50 ? "warn" : "bad"}>
            {clamp(m)}% on hand
          </Pill>
        </div>
        <div className="text-sm text-gray-700">
          You have <span className="font-medium">{have}</span> / {total || "—"}{" "}
          ingredients.
        </div>
        {Array.isArray(inv.keyHits) && inv.keyHits.length ? (
          <div className="mt-2">
            {inv.keyHits.slice(0, 6).map((k) => (
              <Pill key={k} tone="info">
                {k}
              </Pill>
            ))}
            {inv.keyHits.length > 6 ? (
              <span className="text-xs text-gray-500 ml-1">
                +{inv.keyHits.length - 6} more
              </span>
            ) : null}
          </div>
        ) : null}
        <ProgressBar value={m} className="mt-2" />
      </div>
    );
  };

  const BudgetBlock = () => {
    const b = decision?.budget || {};
    const tone = b.inBudget ? "ok" : "bad";
    return (
      <div className="rounded-lg border p-3">
        <div className="flex items-center gap-2 mb-2">
          <Wallet className="w-4 h-4" />
          <div className="font-medium">Budget</div>
          <Pill tone={tone}>
            {b.inBudget ? "Within budget" : "Over budget"}
          </Pill>
        </div>
        <div className="text-sm">
          Estimated cost:{" "}
          <span className="font-medium">{asUsd(b.estCost)}</span>
          {typeof b.deltaToBudget === "number" ? (
            <span className={`ml-2 ${trendColor(-b.deltaToBudget)}`}>
              {b.deltaToBudget > 0
                ? `+${asUsd(b.deltaToBudget)} over`
                : `${asUsd(Math.abs(b.deltaToBudget))} under`}
            </span>
          ) : null}
        </div>
      </div>
    );
  };

  const CalendarBlock = () => {
    const c = decision?.calendar || {};
    const sabbath = !!c.sabbathGuard;
    const tone =
      (c.fitPct ?? 0) >= 70 ? "ok" : (c.fitPct ?? 0) >= 50 ? "warn" : "bad";
    return (
      <div className="rounded-lg border p-3">
        <div className="flex items-center gap-2 mb-2">
          <CalendarClock className="w-4 h-4" />
          <div className="font-medium">Calendar Fit</div>
          {typeof c.fitPct === "number" ? (
            <Pill tone={tone}>{clamp(c.fitPct)}% fit</Pill>
          ) : null}
          {sabbath ? (
            <Pill tone="ok" title="Sabbath guard respects rest window">
              <ShieldCheck className="w-3 h-3 mr-1" />
              Sabbath Guard
            </Pill>
          ) : null}
          {c.feastDay ? (
            <Pill
              tone="info"
              title="Feast day context from your Israelite calendar"
            >
              {c.feastDay}
            </Pill>
          ) : null}
        </div>
        {Array.isArray(c.conflictNotes) && c.conflictNotes.length ? (
          <ul className="text-xs text-amber-700 list-disc ml-4">
            {c.conflictNotes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : (
          <div className="text-xs text-gray-600">
            No time conflicts detected.
          </div>
        )}
        {typeof c.fitPct === "number" ? (
          <ProgressBar value={c.fitPct} className="mt-2" />
        ) : null}
      </div>
    );
  };

  const FactorsBlock = () => (
    <div>
      {(factors.length
        ? factors
        : [
            {
              id: "nutrition",
              label: "Nutrition",
              score: decision?.nutrition?.macroMatchPct ?? 0,
              weight: 3,
              impact: 0,
              note: "Macro & calorie alignment.",
            },
            {
              id: "inventory",
              label: "Inventory",
              score: decision?.inventory?.matchPct ?? 0,
              weight: 3,
              impact: 0,
              note: "What you already have.",
            },
            {
              id: "budget",
              label: "Budget",
              score: decision?.budget?.inBudget ? 100 : 40,
              weight: 2,
              impact: decision?.budget?.inBudget ? +5 : -10,
              note: "Budget conformance.",
            },
            {
              id: "calendar",
              label: "Calendar",
              score: decision?.calendar?.fitPct ?? 0,
              weight: 2,
              impact: 0,
              note: "Time fit, Sabbath guard, feast days.",
            },
          ]
      ).map((f) => {
        const Icon = factorIconMap[f.label] || Info;
        return (
          <FactorRow
            key={f.id || f.label}
            icon={Icon}
            label={f.label}
            weight={f.weight}
            score={f.score}
            impact={typeof f.impact === "number" ? f.impact : 0}
            note={f.note}
          />
        );
      })}
    </div>
  );

  const MetaBar = () => (
    <div className="flex flex-wrap items-center gap-2">
      {(decision?.tags || []).slice(0, 8).map((t) => (
        <Pill key={t} tone="default">
          <Tag className="w-3 h-3 mr-1" />
          {t}
        </Pill>
      ))}
      {decision?.provenance?.source ? (
        <Pill tone="info">
          <Sparkles className="w-3 h-3 mr-1" />
          {decision.provenance.source}
        </Pill>
      ) : null}
      {decision?.provenance?.url ? (
        <a
          href={decision.provenance.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center px-2 py-0.5 rounded-md text-xs bg-white border hover:bg-gray-50"
          title="Open source"
        >
          Open source <ExternalLink className="w-3 h-3 ml-1" />
        </a>
      ) : null}
    </div>
  );

  const Issues = () => (
    <>
      {Array.isArray(decision?.blockers) && decision.blockers.length ? (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3">
          <div className="flex items-center gap-2 text-rose-700 font-medium mb-1">
            <XCircle className="w-4 h-4" /> Blockers
          </div>
          <ul className="list-disc ml-5 text-sm text-rose-800">
            {decision.blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {Array.isArray(decision?.warnings) && decision.warnings.length ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <div className="flex items-center gap-2 text-amber-800 font-medium mb-1">
            <TriangleAlert className="w-4 h-4" /> Warnings
          </div>
          <ul className="list-disc ml-5 text-sm text-amber-900">
            {decision.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {Array.isArray(decision?.nudges) && decision.nudges.length ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
          <div className="flex items-center gap-2 text-emerald-800 font-medium mb-1">
            <CheckCircle2 className="w-4 h-4" /> Next-best actions
          </div>
          <ul className="list-disc ml-5 text-sm text-emerald-900">
            {decision.nudges.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );

  /* ----------------------------------- View ----------------------------------- */
  return (
    <div className="inline-block">
      <Badge />

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          id={`decider-explain-${decision?.id || "x"}`}
          className="fixed inset-0 z-50 flex items-end md:items-center justify-center"
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/30" />

          {/* Panel */}
          <div
            ref={panelRef}
            className="relative z-10 w-full md:max-w-3xl mx-auto bg-white rounded-t-2xl md:rounded-2xl shadow-lg p-4 md:p-6 max-h-[90vh] overflow-auto"
          >
            <div className="flex items-start justify-between">
              <Header />
              <div className="flex items-center gap-2 ml-4">
                <button
                  onClick={copyJson}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs hover:bg-gray-50"
                  title="Copy explanation JSON"
                >
                  <Copy className="w-3.5 h-3.5" /> Copy
                </button>
                <button
                  onClick={handleClose}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border text-xs hover:bg-gray-50"
                  title="Close"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="mt-3">
              <MetaBar />
            </div>

            {/* Snapshot row */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
              <NutritionBlock />
              <div className="grid grid-cols-1 gap-3">
                <InventoryBlock />
                <BudgetBlock />
              </div>
            </div>

            {/* Calendar fit */}
            <div className="mt-3">
              <CalendarBlock />
            </div>

            {/* Weighted factors */}
            <div className="mt-4">
              <div className="flex items-center gap-2 mb-2">
                <Info className="w-4 h-4" />
                <div className="font-medium">Weighted factors</div>
              </div>
              <FactorsBlock />
            </div>

            {/* Issues & Nudges */}
            {hasIssues ? (
              <div className="mt-4">
                <Issues />
              </div>
            ) : null}

            {/* Provenance footer */}
            {decision?.provenance ? (
              <div className="mt-4 text-xs text-gray-500">
                Provenance: {decision.provenance.source || "—"}
                {decision.provenance.author
                  ? ` • by ${decision.provenance.author}`
                  : ""}
                {decision.provenance.license
                  ? ` • ${decision.provenance.license}`
                  : ""}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default DeciderExplainBadge;
