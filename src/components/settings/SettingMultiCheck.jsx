import React, { useEffect, useId, useState } from "react";

/**
 * SettingMultiCheck
 * -----------------------------------------------------------------------------
 * Multi-select checkbox group for profile-driven preferences.
 *
 * Highlights
 * - Auto-binds to householdProfileService (via `path`) with live updates
 * - Optimistic UI with rollback on failure
 * - +Add custom entries (deduped, case-insensitive)
 * - Emits global toasts and Next-Best-Action (NBA) suggestions
 * - Consistent DaisyUI/TW tokens and accessible labels
 *
 * Props
 *  - label, hint, tooltip
 *  - path: string (dot-path in profile, e.g. "torahFood.permittedMeats")
 *  - options: Array<string | {value,label}>
 *  - allowCustom: boolean (default true)
 *  - tone: "default" | "info" | "warn" | "danger"
 *  - size: "xs" | "sm" | "md"    (visual density; currently informational)
 *  - className
 */

// ---------------------- soft imports (safe if missing) ----------------------
let Profile = null;
try {
  Profile = require("@/services/profile/householdProfileService");
} catch {
  Profile = {
    getProfile: async () => ({}),
    setAtPath: async () => {},
    subscribe: () => () => {},
  };
}

let Events = null;
try {
  Events = require("@/services/automation/events");
} catch {
  Events = { emit: () => {}, on: () => () => {} };
}

// ---------------------- tokens ---------------------------------------------
const TOKENS = {
  wrap: "w-full border border-base-200 rounded-2xl p-3 bg-base-100",
  head: "flex items-center justify-between mb-2",
  label: "font-semibold text-sm md:text-base",
  hint: "text-xs opacity-70 mb-2",
  list: "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-1",
  item: "flex items-center gap-2 p-2 rounded-xl hover:bg-base-200/50 transition-colors",
  checkbox: "checkbox checkbox-sm",
  addRow: "mt-2 flex gap-2 items-center",
  addInput: "input input-sm input-bordered rounded-2xl flex-1",
  addBtn: "btn btn-sm btn-outline rounded-2xl",
  clearBtn: "btn btn-ghost btn-xs rounded-2xl",
  toneDot: {
    default: "badge badge-ghost rounded-full",
    info: "badge badge-info rounded-full",
    warn: "badge badge-warning rounded-full",
    danger: "badge badge-error rounded-full",
  },
  errorText: "text-xs text-error mt-1",
};

// ---------------------- helpers --------------------------------------------
const cls = (...xs) => xs.filter(Boolean).join(" ");

const getAt = (obj, path, fallback) => {
  if (!obj || !path) return fallback;
  return path.split(".").reduce((acc, key) => (acc ? acc[key] : undefined), obj) ?? fallback;
};

function useIsMounted() {
  const [m, setM] = useState(false);
  useEffect(() => { setM(true); return () => setM(false); }, []);
  return () => m;
}

function useProfileList(path, fallback = []) {
  const [value, setValue] = useState(fallback);
  const [ready, setReady] = useState(false);
  const isMounted = useIsMounted();

  useEffect(() => {
    let off = null;
    let alive = true;

    (async () => {
      try {
        const p = await Profile.getProfile?.();
        if (!alive || !isMounted()) return;
        const arr = getAt(p, path, fallback);
        setValue(Array.isArray(arr) ? arr : []);
        setReady(true);
      } catch {
        if (alive && isMounted()) setReady(false);
      }

      try {
        off = Profile.subscribe?.((p) => {
          if (!alive || !isMounted()) return;
          const arr = getAt(p, path, fallback);
          setValue(Array.isArray(arr) ? arr : []);
          setReady(true);
        });
      } catch {
        /* no-op */
      }
    })();

    return () => {
      alive = false;
      if (typeof off === "function") off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return [value, setValue, ready];
}

const toast = (kind, message) => {
  try { Events.emit?.("ui.toast", { kind, message }); } catch {}
  try { window.dispatchEvent?.(new CustomEvent("ui.toast", { detail: { kind, message } })); } catch {}
};

const offerUndo = (token, label) => {
  if (!token) return;
  const detail = { token, label: label || "Undo last change" };
  try { Events.emit?.("ui.undo.offer", detail); } catch {}
  try { window.dispatchEvent?.(new CustomEvent("ui.undo.offer", { detail })); } catch {}
};

const suggestNBA = (path, label, href) => {
  const detail = { label, href, cta: "Open" };
  try { Events.emit?.("ui.nba.suggest", detail); } catch {}
  try { window.dispatchEvent?.(new CustomEvent("ui.nba.suggest", { detail })); } catch {}
};

// Provide sensible “next best action” hints based on which area changed
function maybeSuggestNBA(path) {
  if (!path) return;
  if (path.startsWith("torahFood.")) {
    suggestNBA(path, "Rebuild meal filters with new dietary settings", "#/meal-planning");
  } else if (path.startsWith("calendar.")) {
    suggestNBA(path, "Sync calendar with updated observances", "#/calendar");
  } else if (path.startsWith("household.animalTypes")) {
    suggestNBA(path, "Open Animal Care to align tasks & feed", "#/animals");
  } else if (path.startsWith("household.roles")) {
    suggestNBA(path, "Review Roles & Tasks with new household roles", "#/roles");
  }
}

// Case-insensitive dedupe helpers
const norm = (s) => String(s || "").trim();
const existsCI = (arr, v) => arr.some((x) => norm(x).toLowerCase() === norm(v).toLowerCase());

// ---------------------- component ------------------------------------------
export default function SettingMultiCheck({
  label,
  hint,
  tooltip,
  path,
  options = [],
  allowCustom = true,
  tone = "default",
  size = "sm", // reserved for future density tweaks
  className = "",
}) {
  const id = useId();
  const [items, setItems, ready] = useProfileList(path, []);
  const isMounted = useIsMounted();

  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [newItem, setNewItem] = useState("");

  const baseOptions = React.useMemo(
    () =>
      options.map((o) =>
        typeof o === "string" ? { value: o, label: o } : { value: o.value ?? o.label, label: o.label ?? String(o.value) }
      ),
    [options]
  );

  // Ensure any saved values not present in options still appear
  const allOptions = React.useMemo(() => {
    const extras = items
      .filter((v) => !baseOptions.find((b) => norm(b.value) === norm(v)))
      .map((v) => ({ value: v, label: String(v) }));
    return [...baseOptions, ...extras];
  }, [baseOptions, items]);

  const commit = async (nextList, actionLabel = "Updated") => {
    const prev = items;
    setError("");
    setPending(true);
    setItems(nextList); // optimistic

    try {
      const res = await Profile.setAtPath?.(path, nextList);
      toast("success", `${typeof label === "string" ? label : "Preferences"} saved`);
      offerUndo(res?.undoToken || res?.undo, typeof label === "string" ? `Undo ${label}` : "Undo change");
      maybeSuggestNBA(path);
    } catch (e) {
      // rollback
      setItems(prev);
      setError("Could not save. Try again.");
      toast("error", "Save failed");
    } finally {
      if (isMounted()) setPending(false);
    }
  };

  const toggleValue = (val) => {
    const present = existsCI(items, val);
    const next = present
      ? items.filter((v) => norm(v).toLowerCase() !== norm(val).toLowerCase())
      : [...items, val];
    commit(next, present ? "Removed" : "Added");
  };

  const addCustom = () => {
    const v = norm(newItem);
    if (!v) return;
    if (existsCI(items, v)) {
      setNewItem("");
      return;
    }
    const next = [...items, v];
    setNewItem("");
    commit(next, "Added");
  };

  const clearAll = () => {
    if (items.length === 0) return;
    commit([], "Cleared");
  };

  return (
    <div className={cls(TOKENS.wrap, className)} aria-busy={pending ? "true" : "false"}>
      <div className={TOKENS.head}>
        <div className="flex items-center gap-2">
          {tone !== "default" && <span className={TOKENS.toneDot[tone]} aria-hidden>●</span>}
          <label htmlFor={id} className={TOKENS.label} title={tooltip || undefined}>
            {label}
          </label>
          {!ready && <span className="badge badge-ghost rounded-full" title="Syncing…">syncing</span>}
        </div>
        <div className="flex items-center gap-2">
          {pending && <span className="loading loading-spinner loading-xs" aria-label="Saving…" />}
          <button
            type="button"
            className={TOKENS.clearBtn}
            onClick={clearAll}
            disabled={pending || items.length === 0}
            title="Clear all selections"
          >
            Clear
          </button>
        </div>
      </div>

      {hint && <div className={TOKENS.hint}>{hint}</div>}
      {error && <div className={TOKENS.errorText}>{error}</div>}

      <div className={TOKENS.list} role="group" aria-labelledby={id}>
        {allOptions.length > 0 ? (
          allOptions.map((opt) => (
            <label key={String(opt.value)} className={TOKENS.item} title={opt.label}>
              <input
                type="checkbox"
                className={TOKENS.checkbox}
                checked={existsCI(items, opt.value)}
                onChange={() => toggleValue(opt.value)}
                disabled={pending}
              />
              <span className="truncate">{opt.label}</span>
            </label>
          ))
        ) : (
          <div className="col-span-full text-sm opacity-70 italic py-2">
            No options configured. Add one below.
          </div>
        )}
      </div>

      {allowCustom && (
        <div className={TOKENS.addRow}>
          <input
            id={id}
            type="text"
            value={newItem}
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addCustom()}
            className={TOKENS.addInput}
            placeholder="Add custom item"
            disabled={pending}
            aria-label={`Add to ${typeof label === "string" ? label : "list"}`}
          />
          <button
            type="button"
            className={TOKENS.addBtn}
            disabled={pending || !norm(newItem)}
            onClick={addCustom}
          >
            + Add
          </button>
        </div>
      )}
    </div>
  );
}
