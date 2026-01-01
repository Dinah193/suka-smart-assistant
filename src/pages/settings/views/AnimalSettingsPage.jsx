import React, { useEffect, useMemo, useRef, useState } from "react";
import SettingToggle from "@/components/settings/SettingToggle.jsx";
import SettingMultiCheck from "@/components/settings/SettingMultiCheck.jsx";

/**
 * AnimalSettingsPage
 * ---------------------------------------------------------------------------
 * Goals:
 * - Clear IA: sections for Basics, Husbandry, Health, Automation, Tools
 * - Intuitive flows: guided checklist + visible progress, undo over confirms
 * - Consistency: Daisy/Tailwind cards, states, toasts
 * - Event glue: reacts to preferences.changed, recipe.consolidated,
 *               inventory.updated, calendar.synced, garden.updated, animal.updated
 * - Empty states, Undo patterns, and Next Best Action after success
 */

// --------------------- soft imports (defensive) -----------------------------
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

// --------------------- helpers & tokens -------------------------------------
const cls = (...xs) => xs.filter(Boolean).join(" ");

const Section = ({ title, description, children, right }) => (
  <div className="card bg-base-100 border border-base-200 shadow-sm rounded-2xl">
    <div className="card-body">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="card-title text-lg md:text-xl">{title}</h2>
          {description && <p className="text-sm opacity-70 mt-1">{description}</p>}
        </div>
        {right}
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

function toast(kind, message) {
  window.dispatchEvent(new CustomEvent("ui.toast", { detail: { kind, message } }));
}

function suggestNBA(detail) {
  window.dispatchEvent(new CustomEvent("ui.nba.suggest", { detail }));
}

function offerUndo(label, token, onPerform) {
  const handler = (e) => {
    if (e?.detail?.token !== token) return;
    try { onPerform?.(); } finally {
      window.removeEventListener("jobs.undo.perform", handler);
      toast("warning", "Undo applied");
    }
  };
  window.addEventListener("jobs.undo.perform", handler, { once: true });
  window.dispatchEvent(new CustomEvent("ui.undo.offer", { detail: { label, token } }));
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

  // cross-domain glue
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

// --------------------- static option catalogs -------------------------------
const SPECIES_OPTIONS = [
  "Chickens", "Ducks", "Geese", "Quail", "Turkeys",
  "Goats", "Sheep", "Cattle", "Rabbits",
  "Bees", "Fish",
];

const ENCLOSURE_TYPES = [
  "Coop", "Run", "Pasture", "Barn/Stable", "Hutch", "Apiary", "Pond/Tank",
];

const FEED_TYPES = [
  "Pellets", "Mash", "Pasture", "Hay", "Grain", "Kitchen Scraps", "Insects", "Silage", "Mineral Blocks",
];

const HEALTH_TASKS = [
  "Vaccination", "Deworming", "Hoof Trimming", "Grooming",
  "Wing Check", "Nest Box Refresh", "Brooder Heat Check",
];

const NOTIFICATIONS = [
  "Low Feed", "Water Check", "Health Task Due", "Missing Eggs", "Escape Risk",
];

// --------------------- UI: progress meter -----------------------------------
function SetupProgress({ profile }) {
  const species = (profile?.household?.animalTypes || []).length > 0;
  const enclosures = (profile?.animals?.enclosures || []).length > 0;
  const feeds = (profile?.animals?.feedTypes || []).length > 0;
  const health = (profile?.animals?.healthTasks || []).length > 0;
  const auto = !!profile?.animals?.autoTrackFeed || !!profile?.animals?.autoHealthReminders;

  const count = [species, enclosures, feeds, health, auto].filter(Boolean).length;
  const pct = Math.round((count / 5) * 100);

  return (
    <div className="flex items-center gap-3">
      <div className="radial-progress text-primary" style={{ "--value": pct, "--size": "36px" }} role="progressbar">
        <span className="text-xs">{pct}%</span>
      </div>
      <div className="text-sm opacity-80">Setup progress</div>
    </div>
  );
}

// --------------------- bulk helpers (recommended presets) -------------------
async function quickApplyPresetChickens() {
  // snapshot for undo
  const before = {
    animalTypes: Profile.getAtPath?.("household.animalTypes", []),
    enclosures: Profile.getAtPath?.("animals.enclosures", []),
    feedTypes: Profile.getAtPath?.("animals.feedTypes", []),
    healthTasks: Profile.getAtPath?.("animals.healthTasks", []),
    eggCounting: Profile.getAtPath?.("animals.useEggCounting", false),
    autoTrackFeed: Profile.getAtPath?.("animals.autoTrackFeed", false),
    autoHealthReminders: Profile.getAtPath?.("animals.autoHealthReminders", false),
    notifications: Profile.getAtPath?.("animals.notifications", []),
  };

  const next = {
    "household.animalTypes": Array.from(new Set([...(before.animalTypes || []), "Chickens"])),
    "animals.enclosures": Array.from(new Set([...(before.enclosures || []), "Coop", "Run"])),
    "animals.feedTypes": Array.from(new Set([...(before.feedTypes || []), "Pellets", "Kitchen Scraps"])),
    "animals.healthTasks": Array.from(new Set([...(before.healthTasks || []), "Nest Box Refresh"])),
    "animals.useEggCounting": true,
    "animals.autoTrackFeed": true,
    "animals.autoHealthReminders": true,
    "animals.notifications": Array.from(new Set([...(before.notifications || []), "Low Feed", "Missing Eggs"])),
  };

  // commit
  await Promise.all(Object.entries(next).map(([path, val]) => Profile.setAtPath?.(path, val)));
  toast("success", "Chicken preset applied");

  const token = `animals-preset-chickens-${Date.now()}`;
  offerUndo("Applied Chicken preset", token, () => {
    Object.entries(before).forEach(([k, v]) => {
      const path = ({
        animalTypes: "household.animalTypes",
        enclosures: "animals.enclosures",
        feedTypes: "animals.feedTypes",
        healthTasks: "animals.healthTasks",
        eggCounting: "animals.useEggCounting",
        autoTrackFeed: "animals.autoTrackFeed",
        autoHealthReminders: "animals.autoHealthReminders",
        notifications: "animals.notifications",
      })[k];
      try { Profile.setAtPath?.(path, v); } catch {}
    });
  });

  suggestNBA({ label: "Open Animal Tasks to create daily checklist", cta: "Open Tasks", href: "#/roles" });
}

// --------------------- page -------------------------------------------------
export default function AnimalSettingsPage() {
  const { profile, loading } = useProfile();

  const noSpecies = useMemo(
    () => !(profile?.household?.animalTypes && profile.household.animalTypes.length),
    [profile]
  );

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
      {/* ONBOARDING / EMPTY */}
      {noSpecies && (
        <div className="card bg-base-100 border border-base-200 rounded-2xl">
          <div className="card-body">
            <div className="flex items-start gap-3">
              <div className="avatar placeholder">
                <div className="w-10 h-10 rounded-full bg-base-200 text-base-content">🐓</div>
              </div>
              <div className="flex-1">
                <h2 className="card-title">Let’s set up your animals</h2>
                <p className="text-sm opacity-70">
                  Choose which species you keep, then add enclosures and feed types. We’ll suggest
                  smart defaults and create reminders automatically.
                </p>
              </div>
              <SetupProgress profile={profile} />
            </div>

            <div className="mt-4 grid gap-4">
              <SettingMultiCheck
                path="household.animalTypes"
                label="Species kept"
                hint="Pick all that apply. You can add custom species too."
                options={SPECIES_OPTIONS}
              />
              <div className="flex flex-wrap gap-2">
                <button
                  className="btn btn-primary btn-sm rounded-2xl"
                  onClick={quickApplyPresetChickens}
                >
                  One-click setup for Chickens
                </button>
                <button
                  className="btn btn-ghost btn-sm rounded-2xl"
                  onClick={() => suggestNBA({ label: "Create Animal Tasks", cta: "Open Tasks", href: "#/roles" })}
                >
                  Skip for now
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* BASICS */}
      <Section
        title="Basics"
        description="Define which animals you keep and where they live. These settings inform feed, tasks, and scheduling."
        right={<SetupProgress profile={profile} />}
      >
        <SettingMultiCheck
          path="household.animalTypes"
          label="Species kept"
          hint="Select everything you actively manage."
          options={SPECIES_OPTIONS}
        />
        <SettingMultiCheck
          path="animals.enclosures"
          label="Enclosure types"
          hint="Used by Agents to create chores, inspections, and capacity checks."
          options={ENCLOSURE_TYPES}
        />
      </Section>

      {/* HUSBANDRY */}
      <Section
        title="Husbandry"
        description="Feed options, egg counting and tracking behaviors."
      >
        <SettingMultiCheck
          path="animals.feedTypes"
          label="Feed types"
          hint="We’ll match these to inventory and surface ‘low feed’ alerts."
          options={FEED_TYPES}
        />
        <SettingToggle
          path="animals.useEggCounting"
          label="Track egg production"
          hint="Adds a quick-log widget for egg counts when you keep poultry."
        />
        <SettingToggle
          path="animals.autoTrackFeed"
          label="Auto-deduct feed from inventory"
          hint="Feeding events decrement feed items; surface low-stock toasts."
        />
      </Section>

      {/* HEALTH */}
      <Section
        title="Health & Reminders"
        description="Keep animals healthy — reminders go on your calendar."
      >
        <SettingMultiCheck
          path="animals.healthTasks"
          label="Health tasks to track"
          hint="We’ll schedule reminders at the recommended cadence you set later."
          options={HEALTH_TASKS}
        />
        <SettingToggle
          path="animals.autoHealthReminders"
          label="Auto-create health reminders"
          hint="Creates calendar entries and nudges when tasks are due."
        />
        <SettingMultiCheck
          path="animals.notifications"
          label="Notifications"
          hint="Pick the alerts you want to see."
          options={NOTIFICATIONS}
        />
      </Section>

      {/* AUTOMATION */}
      <Section
        title="Automation"
        description="Let the system connect dots across Inventory and Calendar."
      >
        <SettingToggle
          path="animals.linkInventory"
          label="Link animals to inventory items"
          hint="Uses feed types to predict consumption and reorder nudges."
        />
        <SettingToggle
          path="animals.autoBreedTracking"
          label="Track breeding & due dates"
          hint="Creates calendar estimates and prompts for brooder prep."
        />
        <SettingToggle
          path="animals.harvestPlanner"
          label="Enable harvest/processing planner"
          hint="Plans humane processing windows and resource needs."
        />
      </Section>

      {/* TOOLS */}
      <Section
        title="Tools"
        description="Apply a preset, clear local caches (undo-able), or quickly jump to the next best step."
      >
        <div className="grid gap-3 md:grid-cols-2">
          <div className="card bg-base-100 border border-base-200 rounded-2xl">
            <div className="card-body">
              <h3 className="font-semibold">Quick presets</h3>
              <p className="text-sm opacity-70">
                Apply curated defaults for common setups. You can tweak anything after.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button className="btn btn-outline btn-sm rounded-2xl" onClick={quickApplyPresetChickens}>
                  Chickens
                </button>
                <button
                  className="btn btn-ghost btn-sm rounded-2xl"
                  onClick={() => suggestNBA({ label: "Open Animal Tasks", cta: "Go", href: "#/roles" })}
                >
                  Review Tasks
                </button>
              </div>
            </div>
          </div>

          <LocalDataTools />
        </div>
      </Section>
    </div>
  );
}

// --------------------- Local Data Tools (undo pattern) ----------------------
function LocalDataTools() {
  const clearLocalCaches = async () => {
    try {
      const snapshot = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (/^(suka|suka:|suka-)/i.test(k) || k.startsWith("persist:")) {
          snapshot[k] = localStorage.getItem(k);
        }
      }
      Object.keys(snapshot).forEach((k) => localStorage.removeItem(k));
      toast("success", "Local caches cleared");

      const token = `animals-clear-${Date.now()}`;
      offerUndo("Cleared local caches", token, () => {
        Object.entries(snapshot).forEach(([k, v]) => {
          try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {}
        });
      });

      suggestNBA({ label: "Reload to apply clean state", cta: "Reload", onClick: () => location.reload() });
    } catch {
      toast("error", "Could not clear caches");
    }
  };

  return (
    <div className="card bg-base-100 border border-base-200 rounded-2xl">
      <div className="card-body">
        <h3 className="font-semibold">Local data</h3>
        <p className="text-sm opacity-70">
          Clear cached state if something looks stale. You’ll get an undo option.
        </p>
        <div className="mt-3">
          <button className="btn btn-outline btn-sm rounded-2xl" onClick={clearLocalCaches}>
            Clear Local Caches
          </button>
        </div>
      </div>
    </div>
  );
}
