// src/components/settings/SettingToggle.jsx
import React, { useEffect, useId, useRef, useState } from "react";

/**
 * SettingToggle
 * -----------------------------------------------------------------------------
 * Compact, accessible toggle with:
 *  - Optimistic updates + rollback on error
 *  - Optional profile auto-binding via `path`
 *  - Consistent tokens (DaisyUI/TW), subtle pending ring & error text
 *  - Event glue: emits ui.toast + ui.undo.offer for Jobs/Automation dock
 *
 * Props:
 *  - label:           string | ReactNode
 *  - hint:            string
 *  - tooltip:         string
 *  - icon:            string | ReactElement | React.ComponentType (emoji/"⚙︎", <Icon/>, Icon)
 *  - checked:         boolean (controlled)
 *  - defaultChecked:  boolean (uncontrolled default)
 *  - onChange:        (next: boolean) => void
 *  - onCommit:        (next: boolean) => Promise<{ undoToken?: string }|void>
 *  - path:            string (dot-path in household profile; auto bind & commit)
 *  - size:            "xs" | "sm" | "md"   (default "sm")
 *  - tone:            "default" | "info" | "warn" | "danger"
 *  - disabled:        boolean
 *  - className:       string
 */

// ---------------------- soft imports (safe if services not present) ----------
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
  Events = require("@/services/automation/events"); // optional bus
} catch {
  Events = { emit: () => {}, on: () => () => {} };
}

// ---------------------- design tokens ----------------------------------------
const TOKENS = {
  wrap: "flex items-start justify-between py-2",
  labelBlock: "pr-3",
  label: "font-medium leading-tight",
  hint: "text-xs opacity-70 mt-0.5",
  toggleBase: "toggle",
  toggleBySize: {
    xs: "toggle-xs",
    sm: "toggle-sm",
    md: "toggle-md",
  },
  toneDot: {
    default: "badge badge-ghost rounded-full",
    info: "badge badge-info rounded-full",
    warn: "badge badge-warning rounded-full",
    danger: "badge badge-error rounded-full",
  },
  pendingRing: "ring-2 ring-offset-2 ring-base-300",
  errorText: "text-xs text-error mt-1",
};

// ---------------------- small helpers ----------------------------------------
const cls = (...xs) => xs.filter(Boolean).join(" ");

const getAt = (obj, path, fallback) => {
  if (!obj || !path) return fallback;
  return path.split(".").reduce((acc, key) => {
    if (acc && Object.prototype.hasOwnProperty.call(acc, key)) return acc[key];
    return undefined;
  }, obj) ?? fallback;
};

function useIsMounted() {
  const ref = useRef(false);
  useEffect(() => {
    ref.current = true;
    return () => { ref.current = false; };
  }, []);
  return () => ref.current;
}

/** Renders emoji/string, React element, or component function safely */
function IconSlot({ icon, className }) {
  if (!icon) return null;
  if (typeof icon === "string") return <span className={className}>{icon}</span>;
  if (React.isValidElement(icon)) {
    return React.cloneElement(icon, {
      className: cls(icon.props.className, className),
      "aria-hidden": true,
    });
  }
  if (typeof icon === "function") {
    const C = icon;
    return <C className={className} size={16} aria-hidden="true" />;
  }
  return null;
}

/**
 * useProfileBinding(path)
 * Subscribes to profile and maps value at dot-path into local state.
 * Returns [value, setValueOptimistic, isProfileAvailable, isBoundReady]
 */
function useProfileBinding(path, fallbackDefault = false) {
  const isMounted = useIsMounted();
  const [value, setValue] = useState(!!fallbackDefault);
  const [boundReady, setBoundReady] = useState(false);
  const profileAvailable = !!Profile?.subscribe;

  useEffect(() => {
    let off = null;
    let alive = true;

    (async () => {
      if (!path || !profileAvailable) return;
      try {
        // initial value
        const p = await Profile.getProfile?.();
        if (alive && isMounted()) {
          setValue(!!getAt(p, path, fallbackDefault));
          setBoundReady(true);
        }
      } catch {
        if (alive && isMounted()) setBoundReady(false);
      }

      // live subscription
      try {
        off = Profile.subscribe?.((p) => {
          if (!alive || !isMounted()) return;
          setValue(!!getAt(p, path, fallbackDefault));
          setBoundReady(true);
        });
      } catch {
        // ignore
      }
    })();

    return () => {
      alive = false;
      if (typeof off === "function") off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, profileAvailable]);

  return [value, setValue, profileAvailable && !!path, boundReady];
}

// ---------------------- component --------------------------------------------
export default function SettingToggle({
  label,
  hint,
  tooltip,
  icon,
  checked,
  defaultChecked = false,
  onChange,
  onCommit,
  path, // if provided, auto bind to household profile
  size = "sm",
  tone = "default",
  disabled = false,
  className = "",
}) {
  const id = useId();
  const isMounted = useIsMounted();

  // Profile binding OR local state
  const [boundValue, setBoundValue, hasProfile, isBoundReady] = useProfileBinding(
    path,
    defaultChecked
  );

  const isControlled = typeof checked === "boolean";
  const [uncontrolled, setUncontrolled] = useState(!!defaultChecked);
  const current = isControlled ? checked : hasProfile ? boundValue : uncontrolled;

  const [pending, setPending] = useState(false);
  const [err, setErr] = useState("");

  const visualSize = TOKENS.toggleBySize[size] || TOKENS.toggleBySize.sm;

  const toast = (kind, message) => {
    // both mechanisms so it works regardless of which bus is active
    try { Events.emit?.("ui.toast", { kind, message }); } catch {}
    try { window.dispatchEvent?.(new CustomEvent("ui.toast", { detail: { kind, message } })); } catch {}
  };

  const offerUndo = (token, labelText) => {
    if (!token) return;
    try {
      const detail = { token, label: labelText || "Undo last change" };
      Events.emit?.("ui.undo.offer", detail);
      window.dispatchEvent?.(new CustomEvent("ui.undo.offer", { detail }));
    } catch {}
  };

  const commitAsync = async (next) => {
    onChange?.(next);
    if (disabled) return;

    setErr("");
    setPending(true);

    const prev = current;

    // Optimistic local state
    if (!isControlled) {
      if (hasProfile) setBoundValue(next);
      else setUncontrolled(next);
    }

    try {
      let result;
      if (path && Profile?.setAtPath) {
        result = await Profile.setAtPath(path, !!next);
      } else if (onCommit) {
        result = await onCommit(!!next);
      }

      toast("success", typeof label === "string" ? `${label}: ${next ? "On" : "Off"}` : "Saved");
      // optional undo token support
      const token = result?.undoToken || result?.undo;
      offerUndo(token, typeof label === "string" ? `Undo ${label}` : "Undo change");
    } catch (e) {
      // Rollback
      if (!isControlled) {
        if (hasProfile) setBoundValue(prev);
        else setUncontrolled(prev);
      }
      setErr("Could not save. Try again.");
      toast("error", "Save failed");
    } finally {
      if (isMounted()) setPending(false);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      commitAsync(!current);
    }
  };

  const hintId = hint ? `${id}-hint` : undefined;

  return (
    <div className={cls(TOKENS.wrap, className)}>
      {/* Left: icon + label + hint */}
      <div className={TOKENS.labelBlock}>
        <div className="flex items-center gap-2">
          <IconSlot icon={icon} className="text-base opacity-80" />
          {tone !== "default" && <span className={TOKENS.toneDot[tone]} aria-hidden>●</span>}
          <label
            htmlFor={id}
            className={TOKENS.label}
            title={tooltip || (typeof label === "string" ? label : undefined)}
          >
            {label}
          </label>
          {!isBoundReady && hasProfile && (
            <span className="badge badge-ghost rounded-full" title="Syncing…">syncing</span>
          )}
        </div>
        {hint ? (
          <div id={hintId} className={TOKENS.hint}>
            {hint}
          </div>
        ) : null}
        {err ? <div className={TOKENS.errorText}>{err}</div> : null}
      </div>

      {/* Right: the switch */}
      <div className="flex items-center">
        <input
          id={id}
          type="checkbox"
          role="switch"
          aria-checked={!!current}
          aria-describedby={hintId}
          className={cls(TOKENS.toggleBase, visualSize, pending && TOKENS.pendingRing)}
          disabled={disabled || pending}
          checked={!!current}
          onChange={(e) => commitAsync(e.target.checked)}
          onKeyDown={onKeyDown}
          title={tooltip || undefined}
        />
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Convenience wrapper when always binding to a profile path:
 *   <ProfileToggle path="torahFood.shellfishAllowed" label="Shellfish Allowed" />
 * ---------------------------------------------------------------------------*/
export function ProfileToggle(props) {
  return <SettingToggle {...props} path={props.path} />;
}
