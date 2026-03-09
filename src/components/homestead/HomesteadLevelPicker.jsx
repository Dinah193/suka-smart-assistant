// C:\Users\larho\suka-smart-assistant\src\components\homestead\HomesteadLevelPicker.jsx
//
// HomesteadLevelPicker
// --------------------
// Deterministic, production-ready level picker UI for SSA Homestead Planner.
// - Reads level catalog + unlock rules via HomesteadLevelService
// - Persists selection via HomesteadOnboardingService.selectLevel()
// - Optional "first-run" guidance via HomesteadOnboardingService.getGuidance()
// - Integrates visibility "dont show again" via HomesteadOnboardingService.dontShowAgain()
//
// Props:
// - householdId?: string (recommended)
// - value?: string (current selected levelKey)
// - onChange?: (levelKey: string, result: { profile, guidance? }) => void
// - onClose?: () => void
// - variant?: "inline" | "modal"  (default "inline")
// - showIntro?: boolean (default true) - shows short description of what changing level does
// - allowOff?: boolean (default true) - allow turning off Homestead features (level "off")
// - compact?: boolean (default false) - tighter layout
// - className?: string
//
// Notes:
// - This component is "UI only"; it does not assume a specific modal library.
// - If variant="modal", it renders an overlay + dialog. If you already have a Modal,
//   wrap this component and use variant="inline".
//
// Tailwind: used lightly; should match your SSA style conventions.
//

import React, { useEffect, useMemo, useState } from "react";
import HomesteadLevelService from "@/services/homestead/HomesteadLevelService";
import HomesteadOnboardingService from "@/services/homestead/HomesteadOnboardingService";

// Optional helper: if you have a central toast system, you can wire it here.
// This component falls back to inline status text.
function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

const DEFAULT_LEVEL_ORDER = [
  "off",
  "pantry",
  "scratch",
  "homestead",
  "village",
];

/**
 * Safe UI label fallback
 */
function labelFor(levelMeta, key) {
  return levelMeta?.label || levelMeta?.name || key;
}

function descFor(levelMeta) {
  return (
    levelMeta?.description ||
    levelMeta?.summary ||
    levelMeta?.blurb ||
    "Choose what SSA should emphasize and which panels/tools should be visible."
  );
}

function badgeFor(levelKey) {
  switch (String(levelKey)) {
    case "off":
      return { text: "Minimal", tone: "neutral" };
    case "pantry":
      return { text: "Quick wins", tone: "good" };
    case "scratch":
      return { text: "Scratch cooking", tone: "good" };
    case "homestead":
      return { text: "Full planner", tone: "strong" };
    case "village":
      return { text: "Advanced", tone: "strong" };
    default:
      return { text: "Custom", tone: "neutral" };
  }
}

function toneClass(tone) {
  if (tone === "strong") return "bg-black/80 text-white";
  if (tone === "good") return "bg-emerald-700 text-white";
  return "bg-zinc-700 text-white";
}

function lockReasonText(reason) {
  if (!reason) return "";
  if (typeof reason === "string") return reason;
  if (Array.isArray(reason)) return reason.filter(Boolean).join(" • ");
  if (typeof reason === "object") {
    // common patterns: { missing:[], note:"" }
    const parts = [];
    if (Array.isArray(reason.missing) && reason.missing.length)
      parts.push(`Missing: ${reason.missing.join(", ")}`);
    if (reason.note) parts.push(String(reason.note));
    return parts.join(" • ");
  }
  return String(reason);
}

function Card({ children, className }) {
  return (
    <div
      className={cx(
        "rounded-xl border border-black/10 bg-white shadow-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

function Button({
  children,
  className,
  onClick,
  disabled,
  variant = "primary",
  type = "button",
}) {
  const base =
    "inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-black/20";
  const variants = {
    primary: "bg-black text-white hover:bg-black/90 disabled:bg-black/40",
    ghost: "bg-transparent text-black hover:bg-black/5 disabled:text-black/40",
    subtle: "bg-zinc-100 text-black hover:bg-zinc-200 disabled:bg-zinc-100/50",
    danger: "bg-red-600 text-white hover:bg-red-600/90 disabled:bg-red-600/40",
  };
  return (
    <button
      type={type}
      className={cx(base, variants[variant], className)}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function Tag({ text, tone = "neutral" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
        toneClass(tone),
      )}
    >
      {text}
    </span>
  );
}

function MiniList({ items }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <ul className="mt-2 list-disc pl-5 text-sm text-black/70">
      {items.slice(0, 6).map((x) => (
        <li key={String(x)} className="leading-relaxed">
          {String(x)}
        </li>
      ))}
      {items.length > 6 ? (
        <li className="text-black/50">…and {items.length - 6} more</li>
      ) : null}
    </ul>
  );
}

/**
 * Extract feature list from unlock or level meta in a UI-safe way.
 * This is intentionally conservative because your HomesteadLevelService may vary.
 */
function extractHighlights({ levelMeta, unlock }) {
  const highlights = [];

  // Prefer explicit highlights if provided by catalog
  if (Array.isArray(levelMeta?.highlights) && levelMeta.highlights.length) {
    return levelMeta.highlights.map(String);
  }

  // Otherwise infer from unlock maps
  const domains =
    unlock?.domains && typeof unlock.domains === "object" ? unlock.domains : {};
  const features =
    unlock?.features && typeof unlock.features === "object"
      ? unlock.features
      : {};

  if (features.estimator || features.baselines)
    highlights.push("Estimator: food security + savings");
  if (domains.farm_to_table) highlights.push("Farm-to-Table planning targets");
  if (features.components || features.batchCooking || domains.meals)
    highlights.push("Scratch + batch cooking support");
  if (domains.garden) highlights.push("Garden planning integration");
  if (domains.animals) highlights.push("Animals planning integration");
  if (domains.preservation)
    highlights.push("Preservation + storehouse workflow");

  return highlights;
}

/**
 * Build level cards list from HomesteadLevelService.
 * We try a few shapes to remain compatible with your service implementation.
 */
async function loadLevelsForHousehold(householdId) {
  // Expected: service provides catalog list + meta
  // We will attempt:
  // - HomesteadLevelService.listLevels()
  // - HomesteadLevelService.getAllLevels()
  // - fallback to DEFAULT_LEVEL_ORDER and getLevelMeta(key)
  let keys = [];

  try {
    if (typeof HomesteadLevelService.listLevels === "function") {
      const out = await HomesteadLevelService.listLevels();
      if (Array.isArray(out))
        keys = out
          .map((x) => (typeof x === "string" ? x : x?.key))
          .filter(Boolean);
    } else if (typeof HomesteadLevelService.getAllLevels === "function") {
      const out = await HomesteadLevelService.getAllLevels();
      if (Array.isArray(out))
        keys = out
          .map((x) => (typeof x === "string" ? x : x?.key))
          .filter(Boolean);
    }
  } catch {
    // ignore
  }

  if (!keys.length) keys = DEFAULT_LEVEL_ORDER.slice();

  // Normalize keys via service
  keys = keys.map((k) => HomesteadLevelService.normalizeHomesteadLevel(k));

  // Build display model with unlock info per level (deterministic)
  const items = [];
  for (const key of keys) {
    const meta = HomesteadLevelService.getLevelMeta(key);
    let unlock = null;

    try {
      if (typeof HomesteadLevelService.getUiGateMap === "function") {
        unlock = await HomesteadLevelService.getUiGateMap(
          householdId || "anonymous",
          {
            profile: { householdId: householdId || "anonymous", level: key },
            fallbackLevel: key,
          },
        );
      }
    } catch {
      unlock = null;
    }

    // Optional: lock info / requirements
    // If your service offers "canSelectLevel" or similar, use it; else assume selectable.
    let availability = { allowed: true, reason: "" };
    try {
      if (typeof HomesteadLevelService.canSelectLevel === "function") {
        const res = await HomesteadLevelService.canSelectLevel(
          householdId || "anonymous",
          key,
        );
        if (res && typeof res === "object") {
          availability = {
            allowed: Boolean(res.allowed !== false),
            reason: res.reason || "",
          };
        } else if (typeof res === "boolean") {
          availability = { allowed: res, reason: res ? "" : "Locked by rules" };
        }
      } else if (unlock && unlock.locked === true) {
        availability = {
          allowed: false,
          reason: unlock.reason || "Locked by rules",
        };
      }
    } catch {
      // ignore
    }

    items.push({
      key,
      meta,
      unlock,
      availability,
      badge: badgeFor(key),
      highlights: extractHighlights({ levelMeta: meta, unlock }),
    });
  }

  // Deterministic order: by rank if available else by DEFAULT_LEVEL_ORDER
  items.sort((a, b) => {
    const ra = Number(a?.meta?.rank ?? DEFAULT_LEVEL_ORDER.indexOf(a.key));
    const rb = Number(b?.meta?.rank ?? DEFAULT_LEVEL_ORDER.indexOf(b.key));
    return ra - rb;
  });

  return items;
}

export default function HomesteadLevelPicker({
  householdId,
  value,
  onChange,
  onClose,
  variant = "inline",
  showIntro = true,
  allowOff = true,
  compact = false,
  className,
}) {
  const hId = (householdId || "anonymous").toString();

  const [levels, setLevels] = useState([]);
  const [current, setCurrent] = useState(
    HomesteadLevelService.normalizeHomesteadLevel(value || "off"),
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState("");
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [includeGuidance, setIncludeGuidance] = useState(true);

  // Keep internal selection synced with prop value
  useEffect(() => {
    setCurrent(HomesteadLevelService.normalizeHomesteadLevel(value || current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErrorText("");
    (async () => {
      try {
        const items = await loadLevelsForHousehold(hId);
        const filtered = allowOff
          ? items
          : items.filter((x) => x.key !== "off");
        if (alive) {
          setLevels(filtered);
          // Ensure current is valid
          const exists = filtered.some((x) => x.key === current);
          if (!exists && filtered.length) setCurrent(filtered[0].key);
        }
      } catch (err) {
        if (alive) setErrorText(String(err?.message || err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hId, allowOff]);

  const selectedItem = useMemo(
    () => levels.find((x) => x.key === current) || null,
    [levels, current],
  );

  async function handleApply() {
    if (!selectedItem) return;
    if (saving) return;

    setSaving(true);
    setStatusText("");
    setErrorText("");

    try {
      const key = selectedItem.key;

      // Persist level selection
      const profile = await HomesteadOnboardingService.selectLevel(hId, key, {
        source: "HomesteadLevelPicker",
        ui: { variant, compact },
      });

      // Optional: dont show again for the picker itself (visibility key)
      if (dontShowAgain) {
        // This key should match your VisibilityRulesEngine panel keys
        await HomesteadOnboardingService.dontShowAgain(
          hId,
          "homestead.level_picker",
        );
      }

      // Optional: provide first-run guidance payload to caller/UI
      let guidance = null;
      if (includeGuidance) {
        try {
          guidance = await HomesteadOnboardingService.getGuidance(hId, {
            levelOverride: key,
          });
        } catch {
          guidance = null;
        }
      }

      setStatusText(`Saved level: ${labelFor(selectedItem.meta, key)}`);

      if (typeof onChange === "function") {
        onChange(key, { profile, guidance });
      }

      if (typeof onClose === "function") onClose();
    } catch (err) {
      setErrorText(String(err?.message || err));
    } finally {
      setSaving(false);
    }
  }

  function LevelRow({ item }) {
    const isActive = item.key === current;
    const locked = item.availability?.allowed === false;

    return (
      <button
        type="button"
        disabled={locked}
        onClick={() => setCurrent(item.key)}
        className={cx(
          "w-full text-left rounded-xl border transition",
          isActive
            ? "border-black bg-black/[0.03]"
            : "border-black/10 bg-white hover:bg-black/[0.02]",
          locked ? "opacity-60 cursor-not-allowed" : "cursor-pointer",
          compact ? "p-3" : "p-4",
        )}
        aria-pressed={isActive}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div
                className={cx(
                  "font-semibold text-base",
                  compact ? "text-sm" : "text-base",
                )}
              >
                {labelFor(item.meta, item.key)}
              </div>
              <Tag text={item.badge.text} tone={item.badge.tone} />
              {locked ? (
                <span className="text-xs font-semibold text-red-700">
                  Locked
                </span>
              ) : null}
            </div>
            <div
              className={cx(
                "mt-1 text-sm text-black/70",
                compact ? "text-xs" : "text-sm",
              )}
            >
              {descFor(item.meta)}
            </div>

            {isActive ? (
              <div className="mt-2 text-xs text-black/60">
                <span className="font-semibold text-black/70">Includes:</span>
                <MiniList items={item.highlights} />
              </div>
            ) : null}

            {locked && item.availability?.reason ? (
              <div className="mt-2 text-xs text-red-700">
                {lockReasonText(item.availability.reason)}
              </div>
            ) : null}
          </div>

          <div className="pt-0.5">
            <span
              className={cx(
                "inline-flex h-5 w-5 items-center justify-center rounded-full border",
                isActive
                  ? "border-black bg-black text-white"
                  : "border-black/20 bg-white",
              )}
            >
              {isActive ? "✓" : ""}
            </span>
          </div>
        </div>
      </button>
    );
  }

  const body = (
    <Card className={cx("w-full", className)}>
      <div className={cx("border-b border-black/10", compact ? "p-3" : "p-4")}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className={cx("font-bold", compact ? "text-base" : "text-lg")}>
              Homestead Level
            </div>
            {showIntro ? (
              <div
                className={cx(
                  "mt-1 text-black/70",
                  compact ? "text-xs" : "text-sm",
                )}
              >
                Your level controls what tools and guidance SSA shows—so you can
                homestead without feeling overwhelmed.
              </div>
            ) : null}
          </div>

          {typeof onClose === "function" ? (
            <Button
              variant="ghost"
              onClick={onClose}
              className={cx(compact ? "px-2 py-1" : "")}
            >
              ✕
            </Button>
          ) : null}
        </div>
      </div>

      <div className={cx(compact ? "p-3" : "p-4")}>
        {loading ? (
          <div className="text-sm text-black/60">Loading levels…</div>
        ) : errorText ? (
          <div className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
            {errorText}
          </div>
        ) : (
          <>
            <div className={cx("grid gap-3", compact ? "gap-2" : "gap-3")}>
              {levels.map((item) => (
                <LevelRow key={item.key} item={item} />
              ))}
            </div>

            <div className="mt-4 rounded-xl border border-black/10 bg-zinc-50 p-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold">Selection summary</div>
                  <div className="mt-1 text-sm text-black/70">
                    {selectedItem ? (
                      <>
                        <span className="font-semibold text-black">
                          {labelFor(selectedItem.meta, selectedItem.key)}
                        </span>
                        {" — "}
                        {descFor(selectedItem.meta)}
                      </>
                    ) : (
                      "Choose a level to see what it enables."
                    )}
                  </div>

                  {selectedItem?.highlights?.length ? (
                    <div className="mt-2 text-sm text-black/70">
                      <div className="font-semibold text-black/70">
                        Highlights
                      </div>
                      <MiniList items={selectedItem.highlights} />
                    </div>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <label className="inline-flex items-center gap-2 text-xs text-black/70">
                      <input
                        type="checkbox"
                        checked={includeGuidance}
                        onChange={(e) => setIncludeGuidance(e.target.checked)}
                      />
                      Include first-run guidance payload
                    </label>

                    <label className="inline-flex items-center gap-2 text-xs text-black/70">
                      <input
                        type="checkbox"
                        checked={dontShowAgain}
                        onChange={(e) => setDontShowAgain(e.target.checked)}
                      />
                      Don’t show this picker again
                    </label>
                  </div>
                </div>
              </div>
            </div>

            {statusText ? (
              <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-800">
                {statusText}
              </div>
            ) : null}

            {errorText ? (
              <div className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">
                {errorText}
              </div>
            ) : null}

            <div className="mt-4 flex items-center justify-between gap-3">
              <Button
                variant="subtle"
                onClick={() => {
                  setStatusText("");
                  setErrorText("");
                  // Soft reset selection to prop value if present
                  setCurrent(
                    HomesteadLevelService.normalizeHomesteadLevel(
                      value || current,
                    ),
                  );
                }}
                disabled={saving}
              >
                Reset
              </Button>

              <div className="flex items-center gap-2">
                {typeof onClose === "function" ? (
                  <Button variant="ghost" onClick={onClose} disabled={saving}>
                    Cancel
                  </Button>
                ) : null}

                <Button
                  variant="primary"
                  onClick={handleApply}
                  disabled={
                    saving ||
                    loading ||
                    !selectedItem ||
                    selectedItem.availability?.allowed === false ||
                    HomesteadLevelService.normalizeHomesteadLevel(
                      value || "",
                    ) === current
                  }
                >
                  {saving ? "Saving…" : "Apply level"}
                </Button>
              </div>
            </div>

            <div className="mt-3 text-xs text-black/50">
              Tip: If you feel overwhelmed, choose Pantry or Scratch first. SSA
              will hide advanced panels until you’re ready.
            </div>
          </>
        )}
      </div>
    </Card>
  );

  if (variant !== "modal") return body;

  // Simple modal wrapper (no external dependency)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-2xl">{body}</div>
    </div>
  );
}
