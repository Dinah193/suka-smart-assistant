// C:\Users\larho\suka-smart-assistant\src\components\estimators\EstimatorWhyThis.jsx
/* eslint-disable react/prop-types */
import React, { useMemo, useState } from "react";

/**
 * EstimatorWhyThis
 * -----------------------------------------------------------------------------
 * Plain-language "Why am I seeing this?" explainer for SSA estimators.
 *
 * Designed for:
 * - Food security estimator (coverage days, pantry gap, homestead level)
 * - Cost delta estimator (budget reduction from scratch cooking/homesteading)
 * - Other future estimators (water, energy, cleaning supply, etc.)
 *
 * Works with arbitrary payloads. You can pass either:
 * - `details` (preferred) – the estimator run payload
 * - `estimator` – catalog/meta payload
 * - `context` – UI context (what screen, what user selected, etc.)
 *
 * Props
 * - details?: object
 * - estimator?: object
 * - context?: object
 * - variant?: "card" | "inline" (default "card")
 * - compact?: boolean (default false)
 * - defaultOpen?: boolean (default false) (for expandable sections)
 * - onRequestOpenDetails?: () => void (hook to open EstimatorDetailsDrawer)
 */
export default function EstimatorWhyThis({
  details = null,
  estimator = null,
  context = null,
  variant = "card",
  compact = false,
  defaultOpen = false,
  onRequestOpenDetails = null,
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));

  const model = useMemo(
    () => buildWhyModel({ details, estimator, context }),
    [details, estimator, context],
  );

  // If everything is empty, render nothing (avoid clutter).
  if (!model?.title && !model?.bullets?.length && !model?.cta?.label)
    return null;

  if (variant === "inline") {
    return (
      <div
        className={
          compact ? "text-xs text-neutral-600" : "text-sm text-neutral-700"
        }
      >
        <div className="font-medium text-neutral-900">
          {model.title || "Why this estimate?"}
        </div>
        {model.subtitle ? <div className="mt-1">{model.subtitle}</div> : null}
        {model.bullets?.length ? (
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {model.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        ) : null}
        {model.cta?.label ? (
          <div className="mt-2">
            <button
              type="button"
              onClick={() => model.cta.onClick?.()}
              className="underline decoration-neutral-400 underline-offset-4 hover:text-neutral-900"
            >
              {model.cta.label}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  // Default: Card (collapsible)
  return (
    <section className="rounded-xl border border-neutral-200 bg-white">
      <div className="flex items-start justify-between gap-3 border-b border-neutral-200 px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-neutral-900">
            {model.title || "Why this estimate?"}
          </div>
          {model.subtitle ? (
            <div
              className={
                compact
                  ? "mt-0.5 text-xs text-neutral-600"
                  : "mt-1 text-sm text-neutral-600"
              }
            >
              {model.subtitle}
            </div>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {model.cta?.label ? (
            <button
              type="button"
              onClick={() => model.cta.onClick?.()}
              className="rounded-md border border-neutral-200 bg-white px-3 py-2 text-xs font-medium text-neutral-900 hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-400"
            >
              {model.cta.label}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="rounded-md bg-neutral-900 px-3 py-2 text-xs font-medium text-white hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-400"
            aria-expanded={open}
          >
            {open ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {open ? (
        <div className="px-4 py-3">
          {model.bullets?.length ? (
            <ul className="list-disc space-y-2 pl-5 text-sm text-neutral-800">
              {model.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          ) : null}

          {model.notes?.length ? (
            <div className="mt-3 rounded-lg bg-neutral-50 px-3 py-2">
              <div className="text-xs font-semibold text-neutral-800">
                Notes
              </div>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-neutral-700">
                {model.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* =============================================================================
   Why Model Builder
============================================================================= */

function buildWhyModel({ details, estimator, context }) {
  const meta = details?.meta || estimator?.meta || {};
  const type = meta?.type || details?.type || estimator?.type || "estimator";
  const id = meta?.id || details?.id || estimator?.id || null;

  // What screen / feature triggered it (optional)
  const screen = context?.screen || context?.route || context?.origin || null;
  const userMode = context?.mode || context?.plannerMode || null; // e.g., "meal_planner", "homestead_planner"
  const homesteadLevel =
    context?.homesteadLevel ??
    details?.inputs?.homesteadLevel ??
    details?.run?.inputs?.homesteadLevel;

  // Common run components
  const inputs = details?.inputs || details?.run?.inputs || null;
  const assumptions = details?.assumptions || details?.run?.assumptions || null;
  const outputs =
    details?.outputs || details?.run?.outputs || details?.result || null;

  const hasInventory = truthyish(
    context?.hasInventory ??
      inputs?.hasInventory ??
      details?.flags?.hasInventory,
  );
  const hasMealPlan = truthyish(
    context?.hasMealPlan ?? inputs?.hasMealPlan ?? details?.flags?.hasMealPlan,
  );
  const hasGarden = truthyish(
    context?.hasGarden ?? inputs?.hasGarden ?? details?.flags?.hasGarden,
  );
  const hasAnimals = truthyish(
    context?.hasAnimals ?? inputs?.hasAnimals ?? details?.flags?.hasAnimals,
  );
  const hasPrices = truthyish(
    context?.hasPrices ?? inputs?.hasPrices ?? details?.flags?.hasPrices,
  );

  // Derive some friendly KPIs if present (we do not assume schema)
  const coverageDays = firstNumber(
    outputs?.coverageDays,
    outputs?.foodSecurityDays,
    outputs?.daysCovered,
    outputs?.kpis?.coverageDays,
  );
  const weeklySavings = firstNumber(
    outputs?.weeklySavings,
    outputs?.savingsWeekly,
    outputs?.kpis?.weeklySavings,
  );
  const monthlySavings = firstNumber(
    outputs?.monthlySavings,
    outputs?.savingsMonthly,
    outputs?.kpis?.monthlySavings,
  );
  const confidence = outputs?.confidence ?? outputs?.kpis?.confidence;

  // Heuristic: detect specific estimator flavors.
  const flavor = detectEstimatorFlavor({ id, type, outputs });

  const title =
    flavor === "food_security"
      ? "Why you’re seeing a Food Security estimate"
      : flavor === "cost_delta"
        ? "Why you’re seeing a Cost & Savings estimate"
        : "Why you’re seeing this estimate";

  const subtitle = pickFirstString(
    meta?.description,
    context?.subtitle,
    flavor === "food_security"
      ? "This helps you understand how long your household can stay fed with what you have (and what to do next)."
      : flavor === "cost_delta"
        ? "This estimates how much your budget can shift when you cook more from scratch or homestead more."
        : "This explains what triggered the estimate and what data it used.",
  );

  const bullets = [];

  // 1) Trigger / reason
  bullets.push(triggerBullet({ screen, userMode, flavor }));

  // 2) What it uses (data sources)
  bullets.push(
    dataUsedBullet({
      hasInventory,
      hasMealPlan,
      hasGarden,
      hasAnimals,
      hasPrices,
      flavor,
      assumptions,
    }),
  );

  // 3) What it *does* with the data (plain-language)
  bullets.push(processBullet({ flavor, homesteadLevel }));

  // 4) What to trust / limitations
  bullets.push(
    limitationsBullet({ hasInventory, hasPrices, assumptions, confidence }),
  );

  // Add friendly KPI summary bullets if available
  const kpiBullets = buildKpiBullets({
    flavor,
    coverageDays,
    weeklySavings,
    monthlySavings,
    confidence,
  });
  bullets.push(...kpiBullets);

  const notes = [];
  if (!hasInventory)
    notes.push(
      "No inventory data was detected, so the estimator leaned on defaults and/or recipe averages.",
    );
  if (flavor === "cost_delta" && !hasPrices)
    notes.push(
      "No local price data was detected, so costs are approximate until prices are added.",
    );
  if (assumptions && typeof assumptions === "object") {
    const assumptionCount = Object.keys(assumptions).length;
    if (assumptionCount > 0)
      notes.push(
        "Assumptions were applied (portion sizes, yields, waste %, substitution rates, etc.).",
      );
  }

  const cta = makeCta({ onRequestOpenDetails, id, flavor });

  return {
    title,
    subtitle,
    bullets: bullets.filter(Boolean),
    notes: notes.filter(Boolean),
    cta,
  };
}

/* =============================================================================
   Bullet builders
============================================================================= */

function triggerBullet({ screen, userMode, flavor }) {
  // Keep it plain-language and non-technical.
  if (userMode === "homestead_planner") {
    if (flavor === "food_security") {
      return "You’re in the Homestead Planner, so SSA is estimating how much food security you gain as you start producing more at home.";
    }
    if (flavor === "cost_delta") {
      return "You’re in the Homestead Planner, so SSA is estimating how your spending changes as you replace store-bought food with home production.";
    }
    return "You’re in the Homestead Planner, so SSA is running a supporting estimate to guide your next steps.";
  }

  if (userMode === "meal_planner") {
    if (flavor === "food_security") {
      return "You’re planning meals, so SSA is checking whether your current pantry and plan can cover your household’s needs.";
    }
    if (flavor === "cost_delta") {
      return "You’re planning meals, so SSA is estimating how your recipe choices affect your grocery budget.";
    }
    return "You’re planning meals, so SSA is running a supporting estimate to keep your plan realistic.";
  }

  if (screen) {
    return `This estimate was triggered by where you are in the app (${humanize(screen)}). It helps SSA explain “what’s driving the numbers” instead of just showing results.`;
  }

  // Fallback
  if (flavor === "food_security") {
    return "SSA shows this estimate to answer a simple question: “How long can we stay fed with what we have—and what’s missing?”";
  }
  if (flavor === "cost_delta") {
    return "SSA shows this estimate to answer a simple question: “If we cook more at home, what changes in cost—and where do the savings come from?”";
  }
  return "SSA shows this estimate to explain the “why” behind the numbers and to make next steps clearer.";
}

function dataUsedBullet({
  hasInventory,
  hasMealPlan,
  hasGarden,
  hasAnimals,
  hasPrices,
  flavor,
  assumptions,
}) {
  const sources = [];

  if (hasInventory) sources.push("your pantry / inventory");
  if (hasMealPlan) sources.push("your planned meals / recipes");
  if (hasGarden) sources.push("your garden plan or harvest history");
  if (hasAnimals) sources.push("your animals / butchery / protein pipeline");
  if (hasPrices) sources.push("your price data");

  // Assumptions are always a "source" of estimation.
  if (
    assumptions &&
    typeof assumptions === "object" &&
    Object.keys(assumptions).length
  ) {
    sources.push(
      "SSA defaults (portion sizes, yields, waste %, substitutions)",
    );
  } else {
    // Still note defaults in a friendly way.
    sources.push("SSA defaults for missing details");
  }

  if (!sources.length) {
    if (flavor === "food_security") {
      return "It uses SSA’s default serving sizes and pantry assumptions because there wasn’t enough household data to calculate from your inventory yet.";
    }
    if (flavor === "cost_delta") {
      return "It uses SSA’s default costs and cooking assumptions because there wasn’t enough household data to calculate from your prices yet.";
    }
    return "It uses SSA’s defaults because there wasn’t enough household data to calculate from yet.";
  }

  // Turn list into a readable sentence.
  return `It uses ${joinHuman(sources)} to produce an estimate that stays readable and practical.`;
}

function processBullet({ flavor, homesteadLevel }) {
  const levelText =
    homesteadLevel !== undefined && homesteadLevel !== null
      ? ` based on your current homesteading level (${String(homesteadLevel)})`
      : "";

  if (flavor === "food_security") {
    return `SSA converts your food sources into “servings over time”${levelText}, then highlights gaps (what you’ll run out of first) and the easiest ways to close them.`;
  }
  if (flavor === "cost_delta") {
    return `SSA compares two paths${levelText}: (1) buying more finished food, versus (2) making more from scratch / homesteading. Then it shows the cost difference and what creates the savings.`;
  }
  return `SSA turns your inputs into a simple “what you have → what you need → what’s missing” model${levelText}, then summarizes it in plain language.`;
}

function limitationsBullet({
  hasInventory,
  hasPrices,
  assumptions,
  confidence,
}) {
  const limits = [];

  if (!hasInventory)
    limits.push(
      "Inventory is missing or incomplete, so coverage is less precise.",
    );
  if (!hasPrices)
    limits.push(
      "Price data is missing or incomplete, so savings are approximate.",
    );
  if (
    assumptions &&
    typeof assumptions === "object" &&
    Object.keys(assumptions).length
  ) {
    limits.push(
      "Assumptions were used to fill gaps (portion sizes, yields, waste %, substitutions).",
    );
  } else {
    limits.push("Defaults may be used until your household data is richer.");
  }

  const c = typeof confidence === "number" ? confidence : null;
  if (c !== null && Number.isFinite(c)) {
    if (c < 0.35)
      limits.push(
        "Confidence is low right now—add inventory/prices for tighter results.",
      );
    else if (c < 0.7)
      limits.push(
        "Confidence is moderate—results are useful for direction, not exact accounting.",
      );
    else
      limits.push(
        "Confidence is strong—results should be close to reality if your data is current.",
      );
  }

  return `What to keep in mind: ${limits.join(" ")}`;
}

function buildKpiBullets({
  flavor,
  coverageDays,
  weeklySavings,
  monthlySavings,
  confidence,
}) {
  const out = [];

  if (
    flavor === "food_security" &&
    typeof coverageDays === "number" &&
    Number.isFinite(coverageDays)
  ) {
    out.push(
      `Right now, your estimated coverage is about **${formatNumber(coverageDays)} day(s)** based on what SSA can see.`,
    );
  }

  if (flavor === "cost_delta") {
    const ms =
      typeof monthlySavings === "number" && Number.isFinite(monthlySavings)
        ? monthlySavings
        : null;
    const ws =
      typeof weeklySavings === "number" && Number.isFinite(weeklySavings)
        ? weeklySavings
        : null;

    if (ms !== null)
      out.push(
        `Your estimated savings could be around **${formatCurrency(ms)}/month** (directional until prices are locked in).`,
      );
    else if (ws !== null)
      out.push(
        `Your estimated savings could be around **${formatCurrency(ws)}/week** (directional until prices are locked in).`,
      );
  }

  if (typeof confidence === "number" && Number.isFinite(confidence)) {
    out.push(
      `Confidence: **${Math.round(confidence * 100)}%** (higher = more based on your real household data).`,
    );
  }

  return out;
}

function makeCta({ onRequestOpenDetails, id, flavor }) {
  if (!onRequestOpenDetails) return null;
  const label =
    flavor === "food_security"
      ? "See what data was used"
      : flavor === "cost_delta"
        ? "See assumptions & math"
        : "Open full details";

  return {
    label,
    onClick: () => onRequestOpenDetails?.({ id, flavor }),
  };
}

/* =============================================================================
   Flavor detection + small utilities
============================================================================= */

function detectEstimatorFlavor({ id, type, outputs }) {
  const s = String(id || type || "").toLowerCase();

  if (
    s.includes("food_security") ||
    s.includes("foodsecurity") ||
    s.includes("coverage")
  )
    return "food_security";
  if (
    s.includes("cost_delta") ||
    s.includes("costdelta") ||
    s.includes("savings") ||
    s.includes("budget")
  )
    return "cost_delta";

  // Heuristic via outputs
  if (outputs && typeof outputs === "object") {
    const keys = Object.keys(outputs).map((k) => k.toLowerCase());
    if (
      keys.some(
        (k) =>
          k.includes("coverage") ||
          k.includes("foodsecurity") ||
          k.includes("dayscovered"),
      )
    )
      return "food_security";
    if (
      keys.some(
        (k) =>
          k.includes("savings") ||
          k.includes("costdelta") ||
          k.includes("monthly") ||
          k.includes("weekly"),
      )
    )
      return "cost_delta";
  }

  // Fallback on generic type
  const t = String(type || "").toLowerCase();
  if (t.includes("food")) return "food_security";
  if (t.includes("cost") || t.includes("budget")) return "cost_delta";
  return "generic";
}

function pickFirstString(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function truthyish(v) {
  return v === true || v === 1 || v === "true" || v === "yes";
}

function firstNumber(...vals) {
  for (const v of vals) {
    const n =
      typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function joinHuman(arr) {
  const a = (arr || []).filter(Boolean);
  if (a.length <= 1) return a[0] || "";
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(", ")}, and ${a[a.length - 1]}`;
}

function humanize(s) {
  return String(s)
    .replace(/[_\-]+/g, " ")
    .trim();
}

function formatNumber(n) {
  try {
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return String(n);
  }
}

function formatCurrency(n) {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `$${Math.round(Number(n) || 0)}`;
  }
}
