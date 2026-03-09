// C:\Users\larho\suka-smart-assistant\src\components\homestead\PlannerEmptyState.jsx
/* eslint-disable react/prop-types */
/**
 * SSA • PlannerEmptyState
 * -----------------------------------------------------------------------------
 * Friendly “start here” empty states for Homestead Planner pages:
 *  - no targets yet
 *  - no cuisines selected
 *  - no inventory records
 *  - no batches
 *  - no garden/animal targets
 *  - no preferences / skills, etc.
 *
 * Features
 *  - Presets by `variant`
 *  - Optional primary/secondary actions
 *  - Optional step checklist
 *  - Optional tips + examples
 *  - Browser-safe, no dependencies
 *
 * Usage
 *  <PlannerEmptyState variant="no_targets" onNavigate={(to)=>navigate(to)} />
 *  <PlannerEmptyState
 *     title="No batches yet"
 *     description="Start a preservation batch to log your progress."
 *     primaryAction={{ label:"Start batch", to:"/homesteadplanner/batches?new=1" }}
 *  />
 */

import React, { useMemo } from "react";

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function Icon({ name }) {
  // Minimal inline icon set (no lucide dependency to avoid build errors).
  // Keep it tiny and consistent.
  const map = {
    spark: "✦",
    target: "◎",
    basket: "▣",
    leaf: "❦",
    paw: "❖",
    jar: "◍",
    gear: "⚙",
    book: "⌁",
    wand: "✧",
    check: "✓",
    arrow: "→",
    calendar: "🗓",
    flavor: "♨",
  };
  return <span aria-hidden="true">{map[name] || "✦"}</span>;
}

function Badge({ children, tone = "neutral" }) {
  const cls =
    tone === "success"
      ? "border-green-200 text-green-800 bg-green-50"
      : tone === "warn"
      ? "border-amber-200 text-amber-800 bg-amber-50"
      : tone === "danger"
      ? "border-red-200 text-red-800 bg-red-50"
      : "border-gray-200 text-black bg-white";
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-bold",
        cls
      )}
    >
      {children}
    </span>
  );
}

function ActionButton({
  tone = "primary",
  onClick,
  href,
  children,
  title,
  disabled,
}) {
  const isPrimary = tone === "primary";
  const base =
    "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-black transition border";
  const cls = isPrimary
    ? "bg-black text-white border-black hover:opacity-90"
    : "bg-white text-black border-gray-200 hover:bg-gray-50";

  if (href) {
    return (
      <a
        href={href}
        className={cx(
          base,
          cls,
          disabled ? "pointer-events-none opacity-60" : ""
        )}
        title={title}
        onClick={onClick}
      >
        {children}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={cx(base, cls, disabled ? "opacity-60 cursor-not-allowed" : "")}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function StepsList({ steps = [] }) {
  if (!steps?.length) return null;
  return (
    <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-4">
      <div className="text-xs font-black opacity-70">Start here</div>
      <ul className="mt-3 space-y-2">
        {steps.map((s, idx) => (
          <li key={idx} className="flex items-start gap-3">
            <span className="mt-[2px] inline-flex h-5 w-5 items-center justify-center rounded-full border border-gray-200 bg-white text-[11px] font-black">
              {idx + 1}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-bold">{s.title}</div>
              {s.hint ? (
                <div className="text-xs opacity-70 mt-1">{s.hint}</div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Tips({ tips = [] }) {
  if (!tips?.length) return null;
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      {tips.map((t, i) => (
        <Badge key={i} tone={t.tone || "neutral"}>
          {t.text}
        </Badge>
      ))}
    </div>
  );
}

function Examples({ examples = [] }) {
  if (!examples?.length) return null;
  return (
    <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-4">
      <div className="text-xs font-black opacity-70">Examples</div>
      <ul className="mt-2 space-y-1 text-xs opacity-80 list-disc pl-5">
        {examples.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function resolvePreset(variant, ctx) {
  const base = ctx?.base || "/homesteadplanner";

  const presets = {
    no_targets: {
      icon: "target",
      title: "No provisioning targets yet",
      description:
        "Targets are your “why” for everything else. Add a few staples (grains, fats, proteins, preserved foods) and SSA will derive planting, preservation, and purchasing signals.",
      primaryAction: { label: "Add targets", to: `${base}/targets` },
      secondaryAction: { label: "Browse catalog", to: `${base}/components` },
      steps: [
        {
          title: "Choose 10–20 staples",
          hint: "Think: flour, rice, beans, oils, canned tomatoes, broth, spices.",
        },
        {
          title: "Set quantities + cadence",
          hint: "Per week/month/year—whatever you track most consistently.",
        },
        {
          title: "Review gaps",
          hint: "SSA highlights shortfalls and suggested actions.",
        },
      ],
      tips: [
        { text: "Start small: 10 staples", tone: "neutral" },
        { text: "Use tags to group items", tone: "neutral" },
        { text: "Targets drive garden + animals", tone: "success" },
      ],
      examples: [
        "25 lb rice / month",
        "12 whole chickens / month",
        "24 quarts canned tomatoes / year",
      ],
    },

    no_cuisines: {
      icon: "flavor",
      title: "No cuisines selected",
      description:
        "Cuisine rotation helps SSA choose ingredient profiles, preservation methods, and weekly rhythms that match your household taste.",
      primaryAction: { label: "Pick cuisines", to: `${base}/cuisines` },
      secondaryAction: {
        label: "Set taste preferences",
        to: `${base}/preferences`,
      },
      steps: [
        {
          title: "Pick 1–3 core cuisines",
          hint: "Your default rotation for most weeks.",
        },
        {
          title: "Add 1–2 seasonal cuisines",
          hint: "Rotate by month or feast day cycles.",
        },
        {
          title: "Set heat/salt/sweet preference",
          hint: "Taste cards keep meal plans aligned.",
        },
      ],
      tips: [
        { text: "Rotation prevents burnout", tone: "success" },
        { text: "Use feast-day overrides", tone: "neutral" },
      ],
      examples: [
        "AAI + West African rotation",
        "Mediterranean week every 4 weeks",
        "Feast-day menu templates",
      ],
    },

    no_inventory: {
      icon: "basket",
      title: "No homestead inventory yet",
      description:
        "Inventory connects targets to real life. Add what you have (storehouse, freezer, pantry), and SSA can compute readiness and shelf-life risk.",
      primaryAction: { label: "Open inventory", to: `${base}/inventory` },
      secondaryAction: {
        label: "Add a preservation batch",
        to: `${base}/batches`,
      },
      steps: [
        {
          title: "Add your top 20 items",
          hint: "Staples first: grains, oils, salt, proteins, canned goods.",
        },
        {
          title: "Record best-by or expires-on",
          hint: "Even rough dates help—month/year is fine.",
        },
        {
          title: "Review readiness",
          hint: "KPIs show coverage + due-soon items.",
        },
      ],
      tips: [
        { text: "Start with pantry + freezer", tone: "neutral" },
        { text: "Dates unlock shelf-life warnings", tone: "warn" },
      ],
    },

    no_batches: {
      icon: "jar",
      title: "No preservation batches yet",
      description:
        "Batches help you plan and log preservation work (canning, dehydrating, curing, fermenting). They also drive skill paths and inventory updates.",
      primaryAction: { label: "Start a batch", to: `${base}/batches?new=1` },
      secondaryAction: {
        label: "Browse preservation catalog",
        to: `${base}/components`,
      },
      steps: [
        {
          title: "Choose a method",
          hint: "Canning, dehydrating, freezing, fermenting, curing, smoking.",
        },
        {
          title: "Pick inputs",
          hint: "Harvest, bulk purchase, or storehouse stock.",
        },
        {
          title: "Log yield + storage",
          hint: "So inventory readiness updates automatically.",
        },
      ],
      tips: [
        { text: "Batches become templates", tone: "success" },
        { text: "Good for seasonal harvest waves", tone: "neutral" },
      ],
    },

    no_garden_targets: {
      icon: "leaf",
      title: "No planting targets yet",
      description:
        "Garden targets are derived from your provisioning targets. Once you have targets, SSA can suggest what to plant, when, and in what quantities.",
      primaryAction: {
        label: "Go to garden targets",
        to: `${base}/garden-targets`,
      },
      secondaryAction: {
        label: "Add provisioning targets",
        to: `${base}/targets`,
      },
      steps: [
        {
          title: "Set provisioning targets first",
          hint: "Garden targets are computed from those.",
        },
        {
          title: "Run target derivation",
          hint: "Compute planting targets for your staples.",
        },
        {
          title: "Adjust by season",
          hint: "Modify for climate, space, and crop preference.",
        },
      ],
      tips: [
        { text: "Targets → crops → preservation", tone: "success" },
        { text: "Keep a seasonal rotation", tone: "neutral" },
      ],
    },

    no_animal_targets: {
      icon: "paw",
      title: "No animal targets yet",
      description:
        "Animal targets are derived from provisioning (meat, eggs, dairy) and your household preferences. SSA can suggest breeding/purchase cadence and preservation workload.",
      primaryAction: {
        label: "Go to animal targets",
        to: `${base}/animal-targets`,
      },
      secondaryAction: {
        label: "Add provisioning targets",
        to: `${base}/targets`,
      },
      steps: [
        {
          title: "Confirm protein targets",
          hint: "Chicken, goat, lamb, beef, eggs, etc.",
        },
        {
          title: "Choose acquisition strategy",
          hint: "Buy in bulk, breed, or hybrid plan.",
        },
        {
          title: "Plan processing weeks",
          hint: "Align butchery and preservation capacity.",
        },
      ],
      tips: [
        { text: "Plan around freezer space", tone: "warn" },
        { text: "Schedule processing windows", tone: "neutral" },
      ],
    },

    no_preferences: {
      icon: "wand",
      title: "No household preferences yet",
      description:
        "Preferences let SSA avoid meals your household won’t eat and steer planning toward your taste, budget, and time constraints.",
      primaryAction: { label: "Set preferences", to: `${base}/preferences` },
      secondaryAction: { label: "Pick cuisines", to: `${base}/cuisines` },
      steps: [
        {
          title: "Set taste cards",
          hint: "Heat, salt, sweet, sour, smoke, aromatics.",
        },
        {
          title: "Set constraints",
          hint: "Time, budget, dietary restrictions, ingredient dislikes.",
        },
        {
          title: "Save defaults",
          hint: "Use them to auto-resolve meal plan decisions.",
        },
      ],
      tips: [{ text: "Taste cards keep plans realistic", tone: "success" }],
    },

    no_skills: {
      icon: "book",
      title: "No skill plan yet",
      description:
        "Skills are derived from what you plan next. SSA can recommend short, practical learning paths tied to upcoming batches and seasonal work.",
      primaryAction: { label: "Open skills", to: `${base}/skills` },
      secondaryAction: { label: "Start a batch", to: `${base}/batches?new=1` },
      steps: [
        {
          title: "Plan next 1–2 weeks",
          hint: "Choose a batch or target set to execute.",
        },
        {
          title: "Review suggested skills",
          hint: "Canning safety, dehydration temps, curing ratios, etc.",
        },
        {
          title: "Log completion",
          hint: "Build household capability over time.",
        },
      ],
      tips: [
        { text: "Skills should match the next action", tone: "success" },
        { text: "Keep it practical, not theoretical", tone: "neutral" },
      ],
    },

    generic: {
      icon: "spark",
      title: "Nothing here yet",
      description:
        "Add your first items to unlock planning, targets, and readiness signals.",
      primaryAction: null,
      secondaryAction: null,
      steps: [],
      tips: [],
      examples: [],
    },
  };

  return presets[variant] || presets.generic;
}

/**
 * PlannerEmptyState
 */
export default function PlannerEmptyState({
  variant = "generic",
  base = "/homesteadplanner",

  // Override any preset fields:
  icon,
  title,
  description,

  // Actions can be { label, to } OR { label, onClick } OR both
  primaryAction,
  secondaryAction,

  steps,
  tips,
  examples,

  // Navigation
  onNavigate, // (to) => void, preferred for SPA routing
  className = "",

  // Layout options
  dense = false,
  showExamples = true,
  showSteps = true,
  showTips = true,
}) {
  const preset = useMemo(
    () => resolvePreset(variant, { base }),
    [variant, base]
  );

  const resolved = {
    icon: icon ?? preset.icon,
    title: title ?? preset.title,
    description: description ?? preset.description,
    primaryAction: primaryAction ?? preset.primaryAction,
    secondaryAction: secondaryAction ?? preset.secondaryAction,
    steps: steps ?? preset.steps,
    tips: tips ?? preset.tips,
    examples: examples ?? preset.examples,
  };

  const wrapPad = dense ? "p-5" : "p-6";

  const primary = resolved.primaryAction;
  const secondary = resolved.secondaryAction;

  const runAction = (action) => (e) => {
    if (!action) return;
    if (action.onClick) return action.onClick(e);
    if (action.to) {
      if (onNavigate) return onNavigate(action.to);
      // fallback: hard navigate
      try {
        window.location.href = action.to;
      } catch (err) {}
    }
  };

  const primaryHref = !onNavigate && primary?.to ? primary.to : null;
  const secondaryHref = !onNavigate && secondary?.to ? secondary.to : null;

  return (
    <div
      className={cx(
        "rounded-2xl border border-gray-200 bg-white shadow-sm",
        className
      )}
    >
      <div
        className={cx(
          wrapPad,
          "flex flex-col md:flex-row md:items-start md:justify-between gap-4"
        )}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl border border-gray-200 bg-white text-lg">
              <Icon name={resolved.icon} />
            </span>
            <div className="min-w-0">
              <div className="text-base font-black leading-tight">
                {resolved.title}
              </div>
              <div className="mt-1 text-sm opacity-75">
                {resolved.description}
              </div>
            </div>
          </div>

          {showTips ? <Tips tips={resolved.tips} /> : null}
        </div>

        {primary || secondary ? (
          <div className="shrink-0 flex flex-col sm:flex-row gap-2 md:justify-end">
            {primary ? (
              <ActionButton
                tone="primary"
                onClick={onNavigate ? runAction(primary) : primary.onClick}
                href={primaryHref}
                title={primary?.title}
                disabled={primary?.disabled}
              >
                <Icon name="arrow" />
                {primary.label || "Start"}
              </ActionButton>
            ) : null}

            {secondary ? (
              <ActionButton
                tone="secondary"
                onClick={onNavigate ? runAction(secondary) : secondary.onClick}
                href={secondaryHref}
                title={secondary?.title}
                disabled={secondary?.disabled}
              >
                {secondary.label || "Learn more"}
              </ActionButton>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className={cx("px-6 pb-6", dense ? "pt-0" : "pt-0")}>
        {showSteps ? <StepsList steps={resolved.steps} /> : null}
        {showExamples ? <Examples examples={resolved.examples} /> : null}

        {/* Gentle “what happens next” footer */}
        <div className="mt-4 rounded-2xl border border-gray-200 bg-gray-50 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">
              <Icon name="check" /> SSA tip
            </Badge>
            <div className="text-xs opacity-75">
              Add a little data first—SSA gets dramatically smarter after you’ve
              entered ~10 targets or ~20 inventory items.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
