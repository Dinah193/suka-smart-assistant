import React, { useEffect, useMemo, useRef, useState } from "react";
import SettingToggle from "@/components/settings/SettingToggle.jsx";
import SettingMultiCheck from "@/components/settings/SettingMultiCheck.jsx";

/**
 * AdvancedSettingsPage
 * ---------------------------------------------------------------------------
 * Power-user & developer options. Safe by default, undoable when risky.
 * Patterns:
 *  - Clear IA: sections (Performance, Developer, Data & Reset, Agents)
 *  - Interaction flow: obvious steps, low-friction commits, NBA after success
 *  - Consistency: Tailwind/Daisy classes, card pattern, skeletons, toasts
 *  - Event glue: listens to recipe.consolidated, inventory.updated,
 *                calendar.synced, preferences.changed, garden.updated, animal.updated
 *  - Undo instead of confirm: clear caches & reset use an undo token
 *  - “Next Best Action” nudges after each success
 */

// ----------------------- soft imports (defensive) ---------------------------
let Profile = null;
try {
  Profile = require("@/services/profile/householdProfileService");
} catch {
  Profile = {
    getProfile: async () => ({}),
    subscribe: () => () => {},
    setAtPath: async () => {},
    getAtPath: (_p, d) => d,
    merge: async () => {},
  };
}

let Jobs = null;
try {
  Jobs = require("@/services/jobs/engine");
} catch {
  Jobs = { on: () => () => {}, emit: () => {} };
}

// ----------------------- small helpers -------------------------------------
const cls = (...xs) => xs.filter(Boolean).join(" ");

const Section = ({ title, description, children }) => (
  <div className="card bg-base-100 border border-base-200 shadow-sm rounded-2xl">
    <div className="card-body">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="card-title text-lg md:text-xl">{title}</h2>
          {description && <p className="text-sm opacity-70 mt-1">{description}</p>}
        </div>
      </div>
      <div className="mt-4 grid gap-4">{children}</div>
    </div>
  </div>
);

function useIsMounted() {
  const r = useRef(false);
  useEffect(() => { r.current = true; return () => { r.current = false; }; }, []);
  return () => r.current;
}

function useProfile() {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();

  useEffect(() => {
    let unsub = () => {};
    (async () => {
      try {
        const p = await Profile.getProfile();
        if (isMounted()) setProfile(p || {});
      } finally {
        if (isMounted()) setLoading(false);
      }
    })();
    try { unsub = Profile.subscribe?.((p) => isMounted() && setProfile(p)); } catch {}
    return () => unsub && unsub();
  }, []);

  // cross-domain nudges → gentle re-render
  useEffect(() => {
    const events = [
      "preferences.changed",
      "recipe.consolidated",
      "inventory.updated",
      "calendar.synced",
      "garden.updated",
      "animal.updated",
    ];
    const bump = () => setProfile((p) => ({ ...(p || {}) }));
    events.forEach((ev) => window.addEventListener(ev, bump));
    return () => events.forEach((ev) => window.removeEventListener(ev, bump));
  }, []);

  return { profile, loading };
}

// NBA helper
function suggestNBA(detail) {
  window.dispatchEvent(new CustomEvent("ui.nba.suggest", { detail }));
}

// Toast helper
function toast(kind, message) {
  window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind, message } }));
}

// Offer Undo helper
function offerUndo(label, token, onPerform) {
  // Register a one-off listener for this token
  const handler = (e) => {
    if (e?.detail?.token !== token) return;
    try { onPerform?.(); } finally {
      window.removeEventListener("jobs.undo.perform", handler);
      toast("warning", "Undo applied");
    }
  };
  window.addEventListener("jobs.undo.perform", handler, { once: true });

  window.dispatchEvent(new CustomEvent("ui.undo.offer", {
    detail: { label, token },
  }));
}

// ----------------------- components ----------------------------------------
function NumberField({ path, label, hint, min = 1, max = 8, step = 1, defaultValue = 2 }) {
  const [val, setVal] = useState(() => Number(Profile.getAtPath?.(path, defaultValue)) || defaultValue);
  const [pending, setPending] = useState(false);
  const id = React.useId();

  useEffect(() => {
    const unsub = Profile.subscribe?.(() => {
      try {
        const v = Number(Profile.getAtPath?.(path, defaultValue));
        if (!Number.isNaN(v)) setVal(v);
      } catch {}
    });
    return () => unsub && unsub();
  }, [path]);

  const commit = async (next) => {
    const n = Math.max(min, Math.min(max, Number(next)));
    if (Number.isNaN(n)) return;
    setPending(true);
    try {
      await Profile.setAtPath?.(path, n);
      toast("success", `${label}: ${n}`);
      suggestNBA({
        label: "Apply new concurrency to running jobs",
        cta: "Restart Jobs Engine",
        onClick: (e) => {
          e?.preventDefault?.();
          try { Jobs.emit?.("engine.restart", {}); } catch {}
        },
      });
    } catch {
      toast("error", "Save failed");
    } finally { setPending(false); }
  };

  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="font-medium leading-tight">{label}</label>
      {hint && <div className="text-xs opacity-70">{hint}</div>}
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        className="input input-sm input-bordered rounded-2xl w-40"
        value={val}
        disabled={pending}
        onChange={(e) => setVal(e.target.value)}
        onBlur={() => commit(val)}
        onKeyDown={(e) => e.key === "Enter" && (e.currentTarget.blur(), e.preventDefault())}
      />
    </div>
  );
}

function DataToolsCard() {
  const fileRef = useRef(null);

  const exportProfile = async () => {
    const p = await Profile.getProfile?.();
    const blob = new Blob([JSON.stringify(p || {}, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "suka-household-profile.json";
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    toast("success", "Profile exported");
  };

  const importProfile = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const json = JSON.parse(text);
      // Prefer merge if available; fallback to set at root path
      if (Profile.merge) await Profile.merge(json);
      else await Profile.setAtPath?.("*", json); // optional convention in your service
      window.dispatchEvent(new CustomEvent("preferences.changed", { detail: { scope: "profile" } }));
      toast("success", "Profile imported");
      suggestNBA({ label: "Review imported profile", cta: "Open Profile", href: "#/settings/profile" });
    } catch (e) {
      toast("error", "Import failed — invalid JSON");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // Clear caches (localStorage-based) with UNDO
  const clearLocalCaches = async () => {
    try {
      const snapshot = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        // only snapshot our app's keys (prefix if you have one)
        if (/^(suka|suka:|suka-)/i.test(k) || k.startsWith("persist:")) {
          snapshot[k] = localStorage.getItem(k);
        }
      }
      const token = `adv-clear-${Date.now()}`;
      // perform clear
      Object.keys(snapshot).forEach((k) => localStorage.removeItem(k));
      toast("success", "Local caches cleared");

      // Offer undo that restores previous keys
      offerUndo("Cleared local caches", token, () => {
        Object.entries(snapshot).forEach(([k, v]) => {
          try {
            if (v == null) localStorage.removeItem(k);
            else localStorage.setItem(k, v);
          } catch {}
        });
      });

      suggestNBA({ label: "Reload to apply clean state", cta: "Reload", onClick: () => location.reload() });
    } catch {
      toast("error", "Could not clear caches");
    }
  };

  const resetAdvancedOnly = async () => {
    // minimal set to defaults (undoable)
    const defaults = {
      "performance.prefetchRoutes": false,
      "performance.enableBackgroundIndexing": true,
      "performance.concurrentJobsLimit": 2,
      "developer.devMode": false,
      "developer.showDebugToasts": false,
      "developer.logging": "warn",
      "developer.flags": [],
      "ui.compactMode": false,
      "ui.animations": true,
      "labels.withTorahBadges": true,
      "agents.sausage.surfaceShellfishChips": true,
    };

    const before = {};
    Object.keys(defaults).forEach((path) => {
      try { before[path] = Profile.getAtPath?.(path, undefined); } catch {}
    });

    try {
      // commit defaults
      await Promise.all(
        Object.entries(defaults).map(([path, val]) => Profile.setAtPath?.(path, val))
      );
      toast("success", "Advanced settings reset");
      const token = `adv-reset-${Date.now()}`;
      offerUndo("Reset advanced settings", token, () => {
        Object.entries(before).forEach(([path, val]) => {
          try { Profile.setAtPath?.(path, val); } catch {}
        });
      });
      suggestNBA({ label: "Open Settings Profile", cta: "Review", href: "#/settings/profile" });
    } catch {
      toast("error", "Reset failed");
    }
  };

  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="card bg-base-100 border border-base-200 rounded-2xl">
        <div className="card-body">
          <h3 className="font-semibold">Export / Import Profile</h3>
          <p className="text-sm opacity-70">Download your household profile JSON, or import a saved one.</p>
          <div className="mt-3 flex gap-2">
            <button className="btn btn-outline btn-sm rounded-2xl" onClick={exportProfile}>Export JSON</button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="file-input file-input-sm file-input-bordered rounded-2xl"
              onChange={(e) => importProfile(e.target.files?.[0])}
            />
          </div>
        </div>
      </div>

      <div className="card bg-base-100 border border-base-200 rounded-2xl">
        <div className="card-body">
          <h3 className="font-semibold">Local Data & Reset</h3>
          <p className="text-sm opacity-70">Clear cached data or reset advanced settings. Undo is offered for both.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className="btn btn-outline btn-sm rounded-2xl" onClick={clearLocalCaches}>
              Clear Local Caches
            </button>
            <button className="btn btn-ghost btn-sm rounded-2xl" onClick={resetAdvancedOnly}>
              Reset Advanced to Defaults
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ----------------------- page ----------------------------------------------
export default function AdvancedSettingsPage() {
  const { profile, loading } = useProfile();

  const shellfishOn = !!(profile?.torahFood?.shellfishAllowed);

  if (loading) {
    return (
      <div className="p-4 md:p-6 w-full max-w-5xl mx-auto">
        <div className="animate-pulse h-6 w-48 bg-base-200 rounded-2xl mb-3" />
        <div className="animate-pulse h-28 bg-base-200 rounded-2xl mb-3" />
        <div className="animate-pulse h-28 bg-base-200 rounded-2xl mb-3" />
        <div className="animate-pulse h-32 bg-base-200 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 w-full max-w-5xl mx-auto grid gap-6">
      {/* PERFORMANCE */}
      <Section
        title="Performance"
        description="Keep things responsive under heavy usage. Safe defaults; tweak if you know what you’re doing."
      >
        <SettingToggle
          path="performance.prefetchRoutes"
          label="Prefetch route chunks on idle"
          hint="Preloads major pages after first paint so navigation feels instant."
          tone="info"
        />
        <SettingToggle
          path="performance.enableBackgroundIndexing"
          label="Background indexing"
          hint="Index inventory/recipes in the background so searches are faster."
        />
        <NumberField
          path="performance.concurrentJobsLimit"
          label="Concurrent jobs limit"
          hint="Max number of tasks the Jobs engine can run at once (1–8)."
          min={1} max={8} defaultValue={2}
        />
      </Section>

      {/* DEVELOPER */}
      <Section
        title="Developer Options"
        description="Diagnostics and flags. Leave off for normal use."
      >
        <SettingToggle
          path="developer.devMode"
          label="Developer mode"
          hint="Shows extra debug panels and verbose errors."
          tone="warn"
        />
        <SettingToggle
          path="developer.showDebugToasts"
          label="Debug toasts"
          hint="Surface low-level events as toasts (noisy)."
          tone="warn"
        />
        {/* simple select for logging level */}
        <LoggingLevelSelect />
        <SettingMultiCheck
          path="developer.flags"
          label="Feature flags"
          hint="Enable experimental features (takes effect immediately)."
          options={[
            { value: "sausageAgentV2", label: "Sausage Agent v2" },
            { value: "calendarSmartSync", label: "Calendar Smart Sync" },
            { value: "storehousePredictor", label: "Storehouse Predictor" },
          ]}
        />
      </Section>

      {/* AGENTS & LABELS (ties to Sausage Agent updates) */}
      <Section
        title="Agent & Label Behavior"
        description="Fine-grained switches used by specific agents and UI labels."
      >
        <SettingToggle
          path="labels.withTorahBadges"
          label="Show Torah alignment badges on labels"
          hint="Adds “Torah-aligned (household profile)” on printed/preview labels."
        />
        <SettingToggle
          path="agents.sausage.surfaceShellfishChips"
          label="Surface ‘Contains Shellfish’ chips in simulations"
          hint="When shellfish are included and allowed, show chips prominently."
          disabled={!shellfishOn}
          tone={shellfishOn ? "default" : "info"}
        />
      </Section>

      {/* DATA & RESET */}
      <Section
        title="Data & Reset"
        description="Export/import profile; clear caches; reset advanced settings (all undoable)."
      >
        <DataToolsCard />
      </Section>
    </div>
  );
}

/* --------- local sub-component: logging level select (profile-bound) ------- */
function LoggingLevelSelect() {
  const id = React.useId();
  const [val, setVal] = useState(() => {
    try { return Profile.getAtPath?.("developer.logging", "warn") ?? "warn"; } catch { return "warn"; }
  });
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const unsub = Profile.subscribe?.(() => {
      try { setVal(Profile.getAtPath?.("developer.logging", "warn") ?? "warn"); } catch {}
    });
    return () => unsub && unsub();
  }, []);

  const save = async (next) => {
    setPending(true);
    try {
      await Profile.setAtPath?.("developer.logging", next);
      toast("success", `Logging: ${next}`);
    } catch {
      toast("error", "Save failed");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="font-medium leading-tight">Logging level</label>
      <div className="text-xs opacity-70">Affects diagnostics verbosity across the app.</div>
      <select
        id={id}
        className="select select-sm select-bordered rounded-2xl w-48"
        value={val}
        disabled={pending}
        onChange={(e) => { setVal(e.target.value); save(e.target.value); }}
      >
        <option value="off">off</option>
        <option value="warn">warn</option>
        <option value="info">info</option>
        <option value="debug">debug</option>
      </select>
    </div>
  );
}
