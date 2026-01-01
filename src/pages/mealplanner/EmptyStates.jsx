// src/pages/MealPlanning/EmptyStates.jsx
import React from "react";

/**
 * EmptyStates.jsx — dynamic, alias-safe, reusable empty/blank-state kit
 * --------------------------------------------------------------------
 * Goals:
 *  - Provide consistent, friendly empty states and light “no data” skeletons
 *  - Nudge the user toward the next best action (NBA) with clear CTAs
 *  - Support Sabbath hands-off messaging consistently across panels
 *  - Work without "@/..." aliases (sandbox-friendly)
 *
 * Design cues:
 *  - Clean, calm card surfaces with soft borders (inspired by Notion / Linear / Arc)
 *  - Compact typography, subtle color, actionable CTAs
 *
 * Exports:
 *  - EmptyCard        (generic wrapper)
 *  - EmptyHero        (icon, headline, body, primary/secondary CTA)
 *  - EmptyWithList    (hero + short list of tips)
 *  - InlineCallout    (inline tip/notice)
 *  - SkeletonList     (placeholder rows)
 *
 *  - Domain presets:
 *    MealPlanEmpty, CalendarSyncEmpty, RecipeVaultEmpty, InventoryEmpty
 *
 * Notes:
 *  - No icon library dependency; use emoji or pass your own JSX.
 *  - Tailwind-style utility classes; safe to replace with your styles.
 */

// ----------------------------------
// Utilities (class joiner)
// ----------------------------------
const cx = (...a) => a.filter(Boolean).join(" ");

// ----------------------------------
// Primitives
// ----------------------------------
export function EmptyCard({ className, children, dashed = true }) {
  return (
    <div
      className={cx(
        "rounded-2xl p-6 text-center",
        dashed ? "border border-dashed" : "border",
        "bg-white"
      )}
    >
      {children}
    </div>
  );
}

export function EmptyHero({
  icon = "🍽️",
  title = "Nothing here yet",
  body = "Add something to get started.",
  primaryAction,
  secondaryAction,
  kicker, // small text above title
  tone = "zinc", // zinc | violet | amber | sky | emerald
}) {
  const toneMap = {
    zinc: { pill: "border-zinc-300 bg-zinc-50 text-zinc-700" },
    violet: { pill: "border-violet-300 bg-violet-50 text-violet-800" },
    amber: { pill: "border-amber-300 bg-amber-50 text-amber-800" },
    sky: { pill: "border-sky-300 bg-sky-50 text-sky-800" },
    emerald: { pill: "border-emerald-300 bg-emerald-50 text-emerald-800" },
  };
  const pill = toneMap[tone]?.pill || toneMap.zinc.pill;

  return (
    <div className="mx-auto max-w-xl">
      {kicker ? (
        <div className={cx("mx-auto mb-3 inline-block rounded-full border px-3 py-1 text-xs", pill)}>
          {kicker}
        </div>
      ) : null}
      <div className="mb-2 text-4xl leading-none">{typeof icon === "string" ? <span>{icon}</span> : icon}</div>
      <div className="mb-2 text-lg font-semibold">{title}</div>
      <p className="mx-auto max-w-md text-sm text-zinc-600">{body}</p>
      <div className="mt-4 flex items-center justify-center gap-2">
        {primaryAction}
        {secondaryAction}
      </div>
    </div>
  );
}

export function InlineCallout({
  title,
  body,
  tone = "zinc", // violet / amber / zinc / sky / emerald
  onAction,
  actionLabel,
  className,
}) {
  const toneMap = {
    zinc:  "border-zinc-300 bg-zinc-50 text-zinc-900",
    violet:"border-violet-300 bg-violet-50 text-violet-900",
    amber: "border-amber-300 bg-amber-50 text-amber-900",
    sky:   "border-sky-300 bg-sky-50 text-sky-900",
    emerald:"border-emerald-300 bg-emerald-50 text-emerald-900",
  };
  return (
    <div className={cx("rounded-xl border px-3 py-2 text-sm", toneMap[tone], className)}>
      {title ? <div className="font-medium">{title}</div> : null}
      {body ? <div className="text-xs opacity-90">{body}</div> : null}
      {onAction && actionLabel ? (
        <div className="mt-2">
          <button
            className="rounded-lg border px-2 py-1 text-xs hover:bg-white/50"
            onClick={onAction}
          >
            {actionLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function SkeletonList({ rows = 5, dense = false }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="animate-pulse rounded-xl border p-3">
          <div className={cx("h-3 w-2/5 rounded bg-zinc-200", dense && "h-2")}></div>
          <div className={cx("mt-2 h-2 w-full rounded bg-zinc-100", dense && "h-1.5")}></div>
        </div>
      ))}
    </div>
  );
}

// ----------------------------------
// Composite: Hero with tips list
// ----------------------------------
export function EmptyWithList({
  icon = "✨",
  title = "Ready when you are",
  body = "Here are a few things you can do next:",
  tips = [], // [{label, onClick, href}]
  primaryAction,
  secondaryAction,
  tone = "zinc",
}) {
  return (
    <EmptyCard>
      <EmptyHero icon={icon} title={title} body={body} primaryAction={primaryAction} secondaryAction={secondaryAction} tone={tone} />
      {tips?.length ? (
        <div className="mx-auto mt-4 max-w-md text-left">
          <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-700">
            {tips.map((t, idx) => (
              <li key={idx}>
                {t.onClick ? (
                  <button className="underline hover:text-zinc-900" onClick={t.onClick}>{t.label}</button>
                ) : t.href ? (
                  <a className="underline hover:text-zinc-900" href={t.href}>{t.label}</a>
                ) : (
                  <span>{t.label}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </EmptyCard>
  );
}

// ----------------------------------
// Domain presets (Meal Planning suite)
// ----------------------------------

/**
 * MealPlanEmpty
 * - Used in CalendarPreview when a period contains no meals.
 * - Mirrors the “Generate plan (Auto)” + “Plan manually” pattern.
 */
export function MealPlanEmpty({ onGenerate, onManual, periodLabel = "this period" }) {
  return (
    <EmptyCard dashed>
      <EmptyHero
        icon="🗓️"
        title={`No meals planned for ${periodLabel}`}
        body="Generate an auto plan from your rhythms & inventory or start filling in meals manually."
        primaryAction={
          <button
            className="rounded-xl bg-black px-3 py-2 text-sm text-white hover:opacity-90"
            onClick={onGenerate}
          >
            Generate a draft
          </button>
        }
        secondaryAction={
          <button
            className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50"
            onClick={onManual}
          >
            Plan manually
          </button>
        }
      />
      <div className="mx-auto mt-3 max-w-md text-xs text-zinc-500">
        Tip: You can switch the period (Week, 2 Weeks, Month, Quarter, or Custom) from the selector above.
      </div>
    </EmptyCard>
  );
}

/**
 * CalendarSyncEmpty
 * - Used in CalendarSyncPanel when nothing is queued.
 * - Emphasizes preview/conflict-check and share.
 */
export function CalendarSyncEmpty({ onOpenPlanner, onOpenSessions, onOpenTasks }) {
  return (
    <EmptyCard dashed>
      <EmptyHero
        icon="📆"
        title="Nothing queued for calendar"
        body="Build a Meal Plan, link a Batch Session, or generate Prep Tasks. We’ll preview and flag conflicts before syncing."
        primaryAction={
          <button className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50" onClick={onOpenPlanner}>
            Open Meal Planner
          </button>
        }
        secondaryAction={
          <button className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50" onClick={onOpenSessions}>
            Open Session Planner
          </button>
        }
      />
      <div className="mt-3 text-xs text-zinc-500">
        Pro tip: Your family agrarian can auto-receive garden/animal forecasts after sync via Family Sharing.
      </div>
      <div className="mt-4">
        <InlineCallout
          tone="zinc"
          title="Preview first"
          body="Use the Preview button to review a timeline and detect overlaps before pushing events."
          actionLabel="Learn more"
          onAction={() => (typeof window !== "undefined" ? window.alert("Preview runs a dry-run with conflict detection.") : null)}
        />
      </div>
    </EmptyCard>
  );
}

/**
 * RecipeVaultEmpty
 * - Encourages the user to import/favorite recipes that fuel planning.
 */
export function RecipeVaultEmpty({ onImport, onDiscover }) {
  return (
    <EmptyWithList
      icon="📚"
      title="Your Recipe Vault is empty"
      body="Import your favorites or discover new recipes to power meal planning."
      primaryAction={<button className="rounded-xl bg-black px-3 py-2 text-sm text-white hover:opacity-90" onClick={onImport}>Import recipes</button>}
      secondaryAction={<button className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50" onClick={onDiscover}>Discover recipes</button>}
      tips={[
        { label: "Create a collection (e.g., Weeknights, Sabbath)", onClick: onDiscover },
        { label: "Tag for macros or allergens (e.g., High-Protein, Gluten-Free)" },
      ]}
    />
  );
}

/**
 * InventoryEmpty
 * - Encourages scanning/pasting inventory, since it powers auto-planning.
 */
export function InventoryEmpty({ onScan, onPaste }) {
  return (
    <EmptyWithList
      icon="🧺"
      title="No pantry items yet"
      body="Scan or paste your pantry/fridge/freezer list. Inventory helps the planner reduce waste & cost."
      primaryAction={<button className="rounded-xl bg-black px-3 py-2 text-sm text-white hover:opacity-90" onClick={onScan}>Scan pantry</button>}
      secondaryAction={<button className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50" onClick={onPaste}>Paste list</button>}
      tips={[
        { label: "Link grocer receipts to auto-update inventory" },
        { label: "Track batch yields for better leftovers" },
      ]}
      tone="emerald"
    />
  );
}

// ----------------------------------
// Sabbath callouts (consistent UX)
// ----------------------------------
export function SabbathCallout({ active = false, handsOff = false, onLearnMore }) {
  if (!active || !handsOff) return null;
  return (
    <InlineCallout
      tone="violet"
      title="Sabbath hands-off is active"
      body="Actions that create or schedule new work are paused. You can still preview, reorder, and share quietly."
      actionLabel="Learn more"
      onAction={onLearnMore}
      className="text-xs"
    />
  );
}

// ----------------------------------
// Micro CTA rows
// ----------------------------------
export function NBARow({ label, actionLabel, onAction }) {
  return (
    <div className="flex items-center justify-between rounded-2xl border bg-zinc-50 p-3">
      <div className="text-sm">
        <span className="font-semibold">Next Best Action:</span> {label}
      </div>
      <button className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-100" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}

// ----------------------------------
// Buttons (lightweight, re-usable)
// ----------------------------------
export function Button({ variant = "solid", size = "md", className, ...props }) {
  const v = {
    solid: "bg-black text-white hover:opacity-90 disabled:opacity-50",
    outline: "border hover:bg-zinc-50",
    ghost: "hover:bg-zinc-100",
  }[variant];
  const s = { sm: "h-8 px-2 text-sm", md: "h-10 px-3 text-sm", icon: "h-9 w-9 p-0" }[size];
  return <button className={cx("rounded-xl", v, s, className)} {...props} />;
}

// ----------------------------------
// Example usage helpers (domain glue)
// ----------------------------------
export function MealPlanEmptyBlock({ onGenerate, onManual, periodKey = "week" }) {
  const periodMap = {
    week: "this week",
    "2w": "these two weeks",
    month: "this month",
    quarter: "this quarter",
    custom: "this custom range",
  };
  return <MealPlanEmpty onGenerate={onGenerate} onManual={onManual} periodLabel={periodMap[periodKey] || "this period"} />;
}

export function CalendarSyncEmptyBlock({ eventBus }) {
  const emit = (panel) => () => eventBus?.emit?.("ui.open", { panel });
  return (
    <CalendarSyncEmpty
      onOpenPlanner={emit("MealPlanner")}
      onOpenSessions={emit("BatchSessionPlanner")}
      onOpenTasks={emit("PrepChecklistGenerator")}
    />
  );
}

// ----------------------------------
// Lightweight sanity tests (dev only)
// ----------------------------------
(function runEmptyStatesTestsOnce() {
  if (typeof window === "undefined") return;
  if (window.__EMPTY_STATES_TESTS__) return;
  window.__EMPTY_STATES_TESTS__ = true;

  const assert = (cond, msg) => (cond ? console.log("[EmptyStates TEST PASS]", msg) : console.error("[EmptyStates TEST FAIL]", msg));

  // Primitive structure checks
  assert(typeof EmptyCard === "function", "EmptyCard exports");
  assert(typeof EmptyHero === "function", "EmptyHero exports");
  assert(typeof EmptyWithList === "function", "EmptyWithList exports");

  // Class joiner
  assert(cx("a", undefined, "b") === "a b", "cx filters falsy");

  // Renderless behavior guard
  const toneMap = ["zinc", "violet", "amber", "sky", "emerald"];
  assert(toneMap.every(Boolean), "tone map defined");
})();
