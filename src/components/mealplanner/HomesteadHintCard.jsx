// C:\Users\larho\suka-smart-assistant\src\components\mealplanner\HomesteadHintCard.jsx
import React, { useEffect, useMemo, useState } from "react";
import { Leaf, ChevronRight, X, Info } from "lucide-react";
import { NavLink } from "react-router-dom";

/* -----------------------------------------------------------------------------
  HomesteadHintCard
  - Shows ONLY if:
      1) homestead level > 0
      2) user has enabled hints
  - Reads a tiny hint from PlanningDeltaEmitter (does NOT show delta details)
  - Lets user dismiss (clears hint)
  - Soft imports for stores/services to avoid hard coupling
----------------------------------------------------------------------------- */

const cx = (...a) => a.filter(Boolean).join(" ");

function safeGet(obj, path, fallback) {
  try {
    return (
      path.split(".").reduce((acc, k) => (acc ? acc[k] : undefined), obj) ??
      fallback
    );
  } catch {
    return fallback;
  }
}

function safeStr(v, fallback = "") {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

function asBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(t)) return true;
    if (["false", "0", "no", "n", "off"].includes(t)) return false;
  }
  return fallback;
}

function asNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const DEFAULTS = {
  // conservative defaults: hint card stays hidden unless user explicitly enables
  hintsEnabled: false,
  homesteadLevel: 0,
};

function readLocalFlag(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return asBool(raw, fallback);
  } catch {
    return fallback;
  }
}
function readLocalNumber(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return asNum(raw, fallback);
  } catch {
    return fallback;
  }
}

export default function HomesteadHintCard({
  className = "",
  // optional: allow parent to override link destination
  to = "/homestead",
  // optional: allow parent to force hide even when eligible
  disabled = false,
}) {
  const [hintsEnabled, setHintsEnabled] = useState(DEFAULTS.hintsEnabled);
  const [homesteadLevel, setHomesteadLevel] = useState(DEFAULTS.homesteadLevel);
  const [hint, setHint] = useState(null);
  const [dismissed, setDismissed] = useState(false);

  // Resolve household/person (best-effort; optional)
  const [householdId, setHouseholdId] = useState("household");
  const [personId, setPersonId] = useState("person");

  // Load settings from best-available sources (soft imports + localStorage fallback)
  useEffect(() => {
    let alive = true;

    (async () => {
      // 1) Try user prefs/profile stores (soft)
      let got = false;

      try {
        // eslint-disable-next-line no-unused-vars
        const ProfileStoreMod = await import(
          /* @vite-ignore */ "@/store/ProfileStore"
        ).catch(() => null);

        const st = ProfileStoreMod?.useProfile?.getState?.() || {};

        // attempt identity
        const hid =
          st?.householdId ||
          st?.household?.id ||
          st?.profile?.householdId ||
          null;
        const pid = st?.personId || st?.profile?.personId || null;

        // attempt homestead level + hints enabled flags
        const lvl =
          st?.homesteadLevel ||
          st?.profile?.homesteadLevel ||
          st?.homestead?.level ||
          null;

        const he =
          st?.hintsEnabled ??
          st?.profile?.hintsEnabled ??
          st?.ui?.hintsEnabled ??
          st?.preferences?.hintsEnabled ??
          null;

        if (!alive) return;

        if (hid) setHouseholdId(String(hid));
        if (pid) setPersonId(String(pid));

        if (lvl != null) {
          setHomesteadLevel(asNum(lvl, DEFAULTS.homesteadLevel));
          got = true;
        }

        if (he != null) {
          setHintsEnabled(asBool(he, DEFAULTS.hintsEnabled));
          got = true;
        }
      } catch {
        // ignore
      }

      // 2) Try a dedicated settings store if present (optional)
      try {
        const SettingsStoreMod = await import(
          /* @vite-ignore */ "@/store/SettingsStore"
        ).catch(() => null);

        const st2 = SettingsStoreMod?.useSettings?.getState?.() || {};
        const lvl2 =
          st2?.homesteadLevel ||
          st2?.homestead?.level ||
          st2?.profile?.homesteadLevel;
        const he2 =
          st2?.hintsEnabled ??
          st2?.ui?.hintsEnabled ??
          st2?.preferences?.hintsEnabled;

        if (!alive) return;

        if (lvl2 != null) {
          setHomesteadLevel(asNum(lvl2, DEFAULTS.homesteadLevel));
          got = true;
        }
        if (he2 != null) {
          setHintsEnabled(asBool(he2, DEFAULTS.hintsEnabled));
          got = true;
        }
      } catch {
        // ignore
      }

      // 3) Fallback: localStorage (works even if stores don’t exist yet)
      // NOTE: you can standardize these keys later.
      if (!got) {
        const lvlLS =
          readLocalNumber("ssa.homestead.level", null) ??
          readLocalNumber("homestead.level", null) ??
          readLocalNumber("ssa.profile.homesteadLevel", null);

        const hintsLS =
          readLocalFlag("ssa.ui.hintsEnabled", null) ??
          readLocalFlag("ssa.hints.enabled", null) ??
          readLocalFlag("hints.enabled", null);

        if (!alive) return;

        if (lvlLS != null)
          setHomesteadLevel(asNum(lvlLS, DEFAULTS.homesteadLevel));
        if (hintsLS != null)
          setHintsEnabled(asBool(hintsLS, DEFAULTS.hintsEnabled));
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  // Subscribe to the hint event + read initial hint (soft import the emitter)
  useEffect(() => {
    let alive = true;
    let off = () => {};

    (async () => {
      // Don’t do any work if we already know it can’t render
      // (still keep subscription minimal; but skip if disabled prop)
      if (disabled) return;

      let emitter = null;
      let eb = null;

      try {
        const mod = await import(
          /* @vite-ignore */ "@/services/mealplanning/PlanningDeltaEmitter"
        ).catch(() => null);
        emitter = mod?.PlanningDeltaEmitter || mod?.default || mod || null;
      } catch {
        emitter = null;
      }

      try {
        const ebMod = await import(
          /* @vite-ignore */ "@/services/events/eventBus"
        ).catch(() => null);
        eb = ebMod?.default || ebMod?.eventBus || ebMod || null;
      } catch {
        eb = null;
      }

      if (!alive) return;

      // initial read
      try {
        if (emitter?.getHint) {
          const h = emitter.getHint({ householdId, personId });
          if (h) setHint(h);
        }
      } catch {
        // ignore
      }

      // subscribe
      if (eb?.on) {
        off =
          eb.on("homestead.targets.updated.hint", (evt) => {
            try {
              const d = evt?.data || {};
              // best-effort match: if ids present, match them; otherwise accept
              const hid = d?.householdId ? String(d.householdId) : null;
              const pid = d?.personId ? String(d.personId) : null;

              if (hid && hid !== String(householdId)) return;
              if (pid && pid !== String(personId)) return;

              if (!alive) return;

              setHint({
                householdId: hid || String(householdId),
                personId: pid || String(personId),
                message: safeStr(
                  d?.message,
                  "Homestead Planner has updated targets",
                ),
                at: safeStr(d?.at, ""),
                level: safeStr(d?.level, "info"),
                link: safeStr(d?.link, to),
              });

              // If user previously dismissed and new hint arrives, re-show
              setDismissed(false);
            } catch {
              // ignore
            }
          }) || (() => {});
      }
    })();

    return () => {
      alive = false;
      try {
        off();
      } catch {}
    };
    // household/person changes should refresh subscription
  }, [disabled, householdId, personId, to]);

  const canRender = useMemo(() => {
    if (disabled) return false;
    if (dismissed) return false;
    if (!asBool(hintsEnabled, false)) return false;
    if (!(asNum(homesteadLevel, 0) > 0)) return false;
    if (!hint?.message) return false;
    return true;
  }, [disabled, dismissed, hintsEnabled, homesteadLevel, hint?.message]);

  const message = useMemo(() => {
    return safeStr(hint?.message, "Homestead Planner has updated targets");
  }, [hint?.message]);

  const linkTo = useMemo(() => {
    return safeStr(hint?.link, to);
  }, [hint?.link, to]);

  const onDismiss = async () => {
    setDismissed(true);

    // Clear hint in the emitter so it doesn’t reappear on refresh
    try {
      const mod = await import(
        /* @vite-ignore */ "@/services/mealplanning/PlanningDeltaEmitter"
      ).catch(() => null);
      const emitter = mod?.PlanningDeltaEmitter || mod?.default || mod || null;
      emitter?.clearHint?.({ householdId, personId });
    } catch {
      // ignore
    }
  };

  if (!canRender) return null;

  return (
    <div
      className={cx(
        "w-full rounded-2xl border border-emerald-200/40 bg-emerald-50/70",
        "shadow-sm",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <div className="p-4 flex items-start gap-3">
        <div
          className={cx(
            "mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl",
            "bg-emerald-600 text-white shadow-sm",
          )}
          aria-hidden="true"
        >
          <Leaf size={18} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="text-sm font-extrabold text-emerald-900">
                  Homestead hint
                </div>
                <span className="inline-flex items-center gap-1 rounded-full bg-white/70 px-2 py-0.5 text-[11px] font-semibold text-emerald-900 border border-emerald-200/60">
                  <Info size={12} />
                  level {asNum(homesteadLevel, 0)}
                </span>
              </div>

              <div className="mt-1 text-sm text-emerald-900/90 truncate">
                {message}
              </div>
              <div className="mt-1 text-[12px] text-emerald-900/70">
                Tap to review in Homestead Planner (details stay hidden here).
              </div>
            </div>

            <button
              type="button"
              onClick={onDismiss}
              className={cx(
                "shrink-0 rounded-xl p-2",
                "text-emerald-900/70 hover:text-emerald-900",
                "hover:bg-emerald-100/70 transition",
              )}
              aria-label="Dismiss homestead hint"
              title="Dismiss"
            >
              <X size={16} />
            </button>
          </div>

          <div className="mt-3">
            <NavLink
              to={linkTo}
              className={({ isActive }) =>
                cx(
                  "inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-bold",
                  "bg-emerald-600 text-white hover:bg-emerald-700 transition",
                  isActive ? "ring-2 ring-emerald-200" : "",
                )
              }
            >
              Open Homestead Planner <ChevronRight size={16} />
            </NavLink>
          </div>
        </div>
      </div>
    </div>
  );
}
