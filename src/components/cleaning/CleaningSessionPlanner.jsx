// src/components/cleaning/CleaningSessionPlanner.jsx
import React, { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import {
  Sparkles,
  SlidersHorizontal,
  CalendarDays,
  Plus,
  Wand2,
  Clock,
  Save,
  Play,
  Info,
} from "lucide-react";
import { automation } from "@/services/automation/runtime";
import { getPacks, materializePacks } from "@/data/cleaningTemplates";

/* ===========================================================================
   CleaningSessionPlanner (DECLUTTERED + PREVIEW)
   - Two modes: Auto ✨ and Manual ✋
   - After Generate, renders a compact "Session Preview" with time estimates:
     per-task min–max, zone totals, overall total.
   - Resilient to missing templates (local draft generation).
   - De-duplicates tasks, normalizes cadences, and sorts for readability.
   ========================================================================== */

const CADENCES = [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "quarterly",
  "biannually",
  "annually",
];
const DEEP_CLEAN_CADENCES = new Set([
  "monthly",
  "quarterly",
  "biannually",
  "annually",
]);
const today = () => dayjs().startOf("day");
const getName = (x) =>
  !x ? "" : typeof x === "string" ? x : String(x.name ?? x.title ?? x.task ?? "");

/* ------------------------- cadence + nextDue utils ------------------------ */
function normalizeCadence(c) {
  if (!c) return null;
  const s = String(c).toLowerCase();
  if (s === "biannual" || s === "bi-annually" || s === "bi-annual")
    return "biannually";
  if (s === "every year" || s === "yearly") return "annually";
  if (s === "twice a month") return "biweekly";
  return s;
}
function computeNextDue(lastDone, cadence = "weekly") {
  const base = lastDone ? dayjs(lastDone) : today();
  const c = normalizeCadence(cadence);
  switch (c) {
    case "daily":
      return base.add(lastDone ? 1 : 0, "day").toISOString();
    case "biweekly":
      return base.add(lastDone ? 2 : 0, "week").toISOString();
    case "monthly":
      return base.add(lastDone ? 1 : 0, "month").toISOString();
    case "quarterly":
      return base.add(lastDone ? 3 : 0, "month").toISOString();
    case "biannually":
      return base.add(lastDone ? 6 : 0, "month").toISOString();
    case "annually":
      return base.add(lastDone ? 12 : 0, "month").toISOString();
    case "weekly":
    default:
      return base.add(lastDone ? 1 : 0, "week").toISOString();
  }
}
function toTask(def) {
  const name = getName(def);
  const rawCad = typeof def === "object" ? def.cadence : null;
  const cadence = CADENCES.includes(normalizeCadence(rawCad))
    ? normalizeCadence(rawCad)
    : "weekly";
  return {
    name,
    cadence,
    lastDone: null,
    nextDue: computeNextDue(null, cadence),
    time: def?.time ?? null,
    remind: !!def?.remind,
  };
}
function ensureNextDue(list) {
  return (list || []).map((t) => {
    const cadence = normalizeCadence(t.cadence) || "weekly";
    return { ...t, cadence, nextDue: t.nextDue || computeNextDue(t.lastDone, cadence) };
  });
}
function mergeSuggestions(existingList, suggestions) {
  const byKey = new Map(
    (existingList || []).map((t) => [getName(t).toLowerCase(), t])
  );
  (suggestions || []).forEach((s) => {
    const nm = getName(s);
    if (!nm) return;
    const key = nm.toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, toTask(s));
    } else {
      const cur = byKey.get(key);
      const cand = normalizeCadence(typeof s === "object" ? s.cadence : null);
      const cad = CADENCES.includes(cand) ? cand : cur.cadence;
      byKey.set(key, { ...cur, cadence: cad });
    }
  });
  return Array.from(byKey.values());
}

/* --------------------------- Home snapshot (safe) ------------------------- */
async function getHomeSelectionsSnapshot() {
  try {
    const res = await automation.runTemplate("home.selections.snapshot", {
      invokedBy: "ui/cleaning/planner",
    });
    if (res && typeof res === "object") return normalizeHomeSelections(res);
  } catch {}
  // Fallbacks if template not registered
  return normalizeHomeSelections({
    familySize: 2,
    roomsCount: 4,
    defaultZones: ["Kitchen", "Bathroom", "Living Room", "Bedroom"],
    cleaningPrefs: {
      schedule: "weekly",
      quietHours: { start: "20:00", end: "08:00" },
      pets: 0,
    },
  });
}
function normalizeHomeSelections(raw = {}) {
  const zones =
    (raw.defaultZones && Array.isArray(raw.defaultZones) && raw.defaultZones.length
      ? raw.defaultZones
      : raw.zones) || [];
  return {
    familySize: Number(raw.familySize) || 2,
    roomsCount: Number(raw.roomsCount) || zones.length || 4,
    defaultZones:
      zones.length
        ? zones
        : ["Kitchen", "Bathroom", "Living Room", "Bedroom"].slice(
            0,
            Number(raw.roomsCount) || 4
          ),
    cleaningPrefs: {
      schedule: raw.cleaningPrefs?.schedule || raw.schedule || "weekly",
      quietHours:
        raw.cleaningPrefs?.quietHours || raw.quietHours || {
          start: "20:00",
          end: "08:00",
        },
      pets: raw.cleaningPrefs?.pets || raw.pets || 0,
    },
  };
}

/* ---------------------- Fallback templates by zone ------------------------ */
const FALLBACK_ZONE_TASKS = {
  Kitchen: [
    { name: "Clear & sanitize counters", cadence: "daily" },
    { name: "Dishes: wash/load/unload", cadence: "daily" },
    { name: "Wipe stove & appliances", cadence: "weekly" },
    { name: "Microwave inside", cadence: "weekly" },
    { name: "Deep clean fridge shelves", cadence: "monthly" },
    { name: "Sweep & mop floor", cadence: "weekly" },
    { name: "Empty trash & replace liner", cadence: "daily" },
  ],
  Bathroom: [
    { name: "Scrub toilet, sink, tub/shower", cadence: "weekly" },
    { name: "Disinfect high-touch areas", cadence: "daily" },
    { name: "Mirror & fixtures polish", cadence: "weekly" },
    { name: "Sweep & mop floor", cadence: "weekly" },
    { name: "Restock TP & soap", cadence: "weekly" },
    { name: "Descale showerhead", cadence: "monthly" },
  ],
  "Living Room": [
    { name: "Declutter surfaces", cadence: "daily" },
    { name: "Dust (high→low) incl. baseboards", cadence: "weekly" },
    { name: "Vacuum carpets/upholstery", cadence: "weekly" },
    { name: "Spot clean glass", cadence: "weekly" },
    { name: "Rotate cushions", cadence: "monthly" },
  ],
  Bedroom: [
    { name: "Make bed / change linens", cadence: "weekly" },
    { name: "Declutter surfaces", cadence: "daily" },
    { name: "Dust (high→low)", cadence: "weekly" },
    { name: "Vacuum or sweep & mop", cadence: "weekly" },
    { name: "Mattress flip/rotate", cadence: "quarterly" },
  ],
};
async function getTemplateTasksForZone(zone, context) {
  try {
    const mod = await import("@/data/cleaningTemplates");
    if (typeof mod.getRoutineTemplates === "function") {
      const out = mod.getRoutineTemplates({ zone, ...context });
      const arr = Array.isArray(out?.tasks) ? out.tasks : Array.isArray(out) ? out : [];
      if (arr.length) return arr;
    }
  } catch {}
  const base =
    FALLBACK_ZONE_TASKS[zone] || [
      { name: "Declutter", cadence: "weekly" },
      { name: "Dust", cadence: "weekly" },
      { name: "Floors", cadence: "weekly" },
      { name: "Trash", cadence: "daily" },
    ];
  const pets = Number(context?.cleaningPrefs?.pets || 0);
  const extra = pets > 0 ? [{ name: "Quick de-fur (lint/vacuum)", cadence: "daily" }] : [];
  return [...base, ...extra];
}

/* --------------------- Time Estimates (deterministic) --------------------- */
/** Heuristics return {min,max, tag} minutes */
function estimateTaskMinutes(taskName, zone = "") {
  const s = `${taskName}`.toLowerCase();
  const z = `${zone}`.toLowerCase();

  // Keyword buckets
  if (/dishes|sink/.test(s)) return { min: 8, max: 15, tag: "quick" };
  if (/counter|surface|wipe|sanitize/.test(s)) return { min: 6, max: 12, tag: "quick" };
  if (/toilet|shower|tub|bath/.test(s)) return { min: 10, max: 20, tag: "core" };
  if (/mirror|glass|fixtures/.test(s)) return { min: 4, max: 8, tag: "quick" };
  if (/vacuum|sweep/.test(s)) return { min: 8, max: 18, tag: "core" };
  if (/mop|floor/.test(s)) return { min: 8, max: 15, tag: "core" };
  if (/fridge|freezer/.test(s)) return { min: 12, max: 25, tag: "deep" };
  if (/microwave/.test(s)) return { min: 5, max: 10, tag: "quick" };
  if (/laundry|washer|dryer|lint|filter/.test(s)) return { min: 8, max: 18, tag: "core" };
  if (/dust/.test(s)) return { min: 6, max: 12, tag: "quick" };
  if (/declutter|reset/.test(s)) return { min: 6, max: 12, tag: "quick" };
  if (/window/.test(s)) return { min: 8, max: 16, tag: "core" };
  if (/descale|deep|baseboard|rotate|mattress/.test(s))
    return { min: 12, max: 25, tag: "deep" };

  // Zone nudge
  if (/kitchen/.test(z)) return { min: 8, max: 16, tag: "core" };
  if (/bath/.test(z)) return { min: 8, max: 18, tag: "core" };

  // Default
  return { min: 6, max: 12, tag: "quick" };
}
function sumRange(arr, pick) {
  return arr.reduce((acc, x) => acc + (x?.[pick] || 0), 0);
}

/* ------------------------------- Small UI -------------------------------- */
const Chip = ({ active, onClick, children, className = "" }) => (
  <button className={`btn xs ${active ? "primary" : ""} ${className}`} onClick={onClick}>
    {children}
  </button>
);
const Field = ({ label, children }) => (
  <label className="field" style={{ display: "grid", gap: 6 }}>
    {label ? <div className="subtitle">{label}</div> : null}
    {children}
  </label>
);

/* =============================== COMPONENT =============================== */
export default function CleaningSessionPlanner({
  defaultTitle = "Cleaning Routine",
  onPlanChange, // (plan) => void
  onSave, // optional (plan) => Promise|void
  onStart, // optional (plan) => Promise|void
}) {
  /* --------- state -------- */
  const [home, setHome] = useState(null);
  const [planName, setPlanName] = useState(defaultTitle);
  const [mode, setMode] = useState("auto"); // "auto" | "manual"
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const [zones, setZones] = useState([]);
  const [tasksByZone, setTasksByZone] = useState({});

  // Preview state (condensed)
  const [preview, setPreview] = useState(null);

  // Auto inputs
  const [windowStart, setWindowStart] = useState(dayjs().startOf("week").format("YYYY-MM-DD"));
  const [windowEnd, setWindowEnd] = useState(dayjs().endOf("week").format("YYYY-MM-DD"));
  const [preset, setPreset] = useState("Balanced");
  const [includeTags, setIncludeTags] = useState(["Daily reset", "Floors", "Dusting"]);
  const [avoidLoud, setAvoidLoud] = useState(false);
  const [avoidFragrance, setAvoidFragrance] = useState(false);
  const [includeAppliances, setIncludeAppliances] = useState(true);
  const [bugTargets, setBugTargets] = useState([]);

  const plan = useMemo(
    () => ({ name: planName, zones, tasks: tasksByZone, environment: "focus" }),
    [planName, zones, tasksByZone]
  );

  /* -------------------------- seed from Home ------------------------------ */
  useEffect(() => {
    (async () => {
      const snap = await getHomeSelectionsSnapshot();
      setHome(snap);
      const initialZones =
        snap.defaultZones?.length
          ? snap.defaultZones
          : ["Kitchen", "Bathroom", "Living Room", "Bedroom"].slice(
              0,
              snap.roomsCount || 4
            );
      setZones(initialZones);
      const seeded = {};
      for (const z of initialZones) {
        // eslint-disable-next-line no-await-in-loop
        const defs = await getTemplateTasksForZone(z, snap);
        seeded[z] = ensureNextDue(defs.map(toTask));
      }
      setTasksByZone(seeded);
    })();
  }, []);

  // Bubble plan up
  useEffect(() => {
    onPlanChange?.(plan);
  }, [JSON.stringify(plan)]); // stable enough for this page

  /* ------------------------------- actions -------------------------------- */
  const coerceDeep = (t) => {
    const nc = normalizeCadence(t.cadence);
    const cadence = DEEP_CLEAN_CADENCES.has(nc) ? nc : "monthly";
    return { ...t, cadence, nextDue: computeNextDue(t.lastDone, cadence) };
    // (keeps consistent deep-clean windows)
  };

  const buildPreview = (zonesOrder, byZone) => {
    // 1) order zones, 2) build rows with estimates, 3) calc totals
    const zoneSummaries = zonesOrder.map((z) => {
      const rows = (byZone[z] || [])
        .map((t) => {
          const e = estimateTaskMinutes(getName(t), z);
          return {
            name: getName(t),
            cadence: normalizeCadence(t.cadence) || "weekly",
            min: e.min,
            max: e.max,
            tag: e.tag,
            time: t.time || null,
          };
        })
        .sort((a, b) => a.min - b.min); // light→heavy
      return {
        zone: z,
        rows,
        minTotal: sumRange(rows, "min"),
        maxTotal: sumRange(rows, "max"),
      };
    });
    const min = sumRange(zoneSummaries, "minTotal");
    const max = sumRange(zoneSummaries, "maxTotal");
    setPreview({ zones: zoneSummaries, minTotal: min, maxTotal: max });
  };

  const generateAuto = async () => {
    if (!home) return;
    setBusy(true);
    setNote("");

    // Packs (appliances + bug shield)
    const selectedPacks = getPacks({
      targetBugs: bugTargets,
      includeAppliances,
      fragranceFree: avoidFragrance,
      avoidLoud,
    });
    const extraByZone = materializePacks(selectedPacks);

    try {
      const res = await automation.runTemplate("cleaning.session.generate", {
        title: planName || defaultTitle,
        preset,
        window: { start: windowStart, end: windowEnd },
        includeTags,
        constraints: { avoidFragrance, avoidLoud },
        packs: selectedPacks.map((p) => p.id),
        household: home,
        invokedBy: "ui/cleaning/planner/auto",
      });

      let nextZones = zones.slice();
      let nextTasks = { ...tasksByZone };

      if (res?.zones?.length) nextZones = Array.from(new Set([...nextZones, ...res.zones]));
      const byZone = res?.tasksByZone || res?.tasks || {};
      for (const [z, list] of Object.entries(byZone)) {
        let mapped = ensureNextDue((list || []).map(toTask));
        if (preset === "Deep Clean Focus") mapped = mapped.map(coerceDeep);
        nextTasks[z] = mapped;
      }
      // merge packs
      for (const [z, list] of Object.entries(extraByZone)) {
        const existing = nextTasks[z] || [];
        let merged = ensureNextDue(mergeSuggestions(existing, list));
        if (preset === "Deep Clean Focus") merged = merged.map(coerceDeep);
        nextTasks[z] = merged;
        if (!nextZones.includes(z)) nextZones.push(z);
      }

      setZones(nextZones);
      setTasksByZone(nextTasks);
      buildPreview(nextZones, nextTasks);
      setMode("manual"); // switch to manual for quick edits
      setNote("✨ Routine generated. Preview ready below.");
    } catch {
      // graceful local draft from packs + defaults
      const mergedZones = Array.from(new Set([...zones, ...Object.keys(extraByZone)]));
      const mergedTasks = { ...tasksByZone };
      for (const z of Object.keys(extraByZone)) {
        let merged = ensureNextDue(mergeSuggestions(mergedTasks[z] || [], extraByZone[z]));
        if (preset === "Deep Clean Focus") merged = merged.map(coerceDeep);
        mergedTasks[z] = merged;
      }
      setZones(mergedZones);
      setTasksByZone(mergedTasks);
      buildPreview(mergedZones, mergedTasks);
      setMode("manual");
      setNote("✨ Routine drafted locally. Preview ready below.");
    } finally {
      setBusy(false);
    }
  };

  /* ------------------------------ render bits ----------------------------- */
  const addZone = async (name) => {
    const z = String(name || "").trim();
    if (!z) return;
    if (!zones.includes(z)) {
      const defs = await getTemplateTasksForZone(z, home || {});
      const nextZones = [...zones, z];
      const nextTasks = { ...tasksByZone, [z]: ensureNextDue(defs.map(toTask)) };
      setZones(nextZones);
      setTasksByZone(nextTasks);
      // keep preview fresh
      buildPreview(nextZones, nextTasks);
    }
  };

  const suggestZone = async (zone) => {
    const existing = tasksByZone[zone] || [];
    try {
      const res = await automation.runTemplate("cleaning.tasks.suggest", {
        zone,
        home,
        existingTasks: existing,
        invokedBy: "ui/cleaning/planner",
      });
      const list =
        (Array.isArray(res?.tasks) && res.tasks) || (Array.isArray(res) && res) || [];
      let merged = ensureNextDue(
        mergeSuggestions(
          existing,
          list.length ? list : await getTemplateTasksForZone(zone, home || {})
        )
      );
      if (preset === "Deep Clean Focus") merged = merged.map(coerceDeep);
      const next = { ...tasksByZone, [zone]: merged };
      setTasksByZone(next);
      buildPreview(zones, next);
    } catch {
      const defs = await getTemplateTasksForZone(zone, home || {});
      let merged = ensureNextDue(mergeSuggestions(existing, defs));
      if (preset === "Deep Clean Focus") merged = merged.map(coerceDeep);
      const next = { ...tasksByZone, [zone]: merged };
      setTasksByZone(next);
      buildPreview(zones, next);
    }
  };

  const patchTask = (zone, idx, patch) => {
    setTasksByZone((prev) => {
      const list = Array.isArray(prev[zone]) ? prev[zone].slice() : [];
      if (!list[idx]) return prev;
      let merged = { ...list[idx], ...patch };
      if (merged.cadence) merged.cadence = normalizeCadence(merged.cadence);
      merged = ensureNextDue([merged])[0];
      const next = { ...prev, [zone]: [...list.slice(0, idx), merged, ...list.slice(idx + 1)] };
      // keep preview fresh
      buildPreview(zones, next);
      return next;
    });
  };
  const removeTask = (zone, idx) => {
    setTasksByZone((prev) => {
      const list = Array.isArray(prev[zone]) ? prev[zone].slice() : [];
      if (!list[idx]) return prev;
      list.splice(idx, 1);
      const next = { ...prev, [zone]: list };
      buildPreview(zones, next);
      return next;
    });
  };

  /* --------------------------------- UI ---------------------------------- */
  const zoneSummary = useMemo(
    () => zones.map((z) => ({ z, count: (tasksByZone[z] || []).length })),
    [zones, tasksByZone]
  );

  return (
    <div className="card" style={{ display: "grid", gap: 16 }}>
      {/* Header */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>Generate Cleaning Routine</h2>
        </div>
        <div className="btn-group">
          <button className={`btn sm ${mode === "auto" ? "primary" : ""}`} onClick={() => setMode("auto")}>
            ✨ Auto
          </button>
          <button className={`btn sm ${mode === "manual" ? "primary" : ""}`} onClick={() => setMode("manual")}>
            ✋ Manual
          </button>
        </div>
      </div>

      {/* Plan title */}
      <Field label="Routine title">
        <input
          className="btn"
          value={planName}
          onChange={(e) => setPlanName(e.target.value)}
          placeholder="e.g., Weekly Reset + Floors"
        />
      </Field>

      {/* --- AUTO MODE --- */}
      {mode === "auto" && (
        <div className="card" style={{ background: "#fff", display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
            <Field label="Window start">
              <div className="btn" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <CalendarDays size={16} />
                <input
                  type="date"
                  className="naked"
                  value={windowStart}
                  onChange={(e) => setWindowStart(e.target.value)}
                />
              </div>
            </Field>
            <Field label="Window end">
              <div className="btn" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <CalendarDays size={16} />
                <input
                  type="date"
                  className="naked"
                  value={windowEnd}
                  onChange={(e) => setWindowEnd(e.target.value)}
                />
              </div>
            </Field>
          </div>

          <Field label="Preset">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {["Balanced", "Quiet-hours aware", "Pet shedding", "Freezer fill (laundry/linens)", "Deep Clean Focus"].map(
                (p) => (
                  <Chip key={p} active={preset === p} onClick={() => setPreset(p)}>
                    {p}
                  </Chip>
                )
              )}
            </div>
          </Field>

          <Field label="Include tags">
            <TagPicker
              value={includeTags}
              options={[
                "Daily reset",
                "Floors",
                "Dusting",
                "Bathrooms",
                "Kitchen",
                "Bedrooms",
                "Windows",
                "Laundry/linens",
              ]}
              onChange={setIncludeTags}
            />
          </Field>

          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
            <div className="card" style={{ background: "#fafafa" }}>
              <div className="subtitle" style={{ marginBottom: 6 }}>
                <SlidersHorizontal size={14} style={{ verticalAlign: "-2px" }} /> Constraints
              </div>
              <Toggle label="Fragrance-free only" checked={avoidFragrance} onChange={setAvoidFragrance} />
              <Toggle label="Avoid loud equipment" checked={avoidLoud} onChange={setAvoidLoud} />
            </div>
            <div className="card" style={{ background: "#fafafa" }}>
              <div className="subtitle" style={{ marginBottom: 6 }}>Packs</div>
              <Toggle label="Include appliance care" checked={includeAppliances} onChange={setIncludeAppliances} />
              <div className="subtitle" style={{ marginTop: 6 }}>Bug Shield targets</div>
              <TagPicker value={bugTargets} options={["ants", "roaches", "pantry", "flies", "closet-moths"]} onChange={setBugTargets} />
            </div>
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button className="btn primary" onClick={generateAuto} aria-busy={busy}>
              <Sparkles size={16} style={{ marginRight: 6 }} /> Generate
            </button>
            <span className="subtitle" style={{ opacity: 0.8 }}>
              I’ll create a clean draft and show a **condensed preview** with time estimates.
            </span>
          </div>

          {/* Compact “what will I get?” preview */}
          {zoneSummary.length ? (
            <div className="card" style={{ background: "#f8fafc" }}>
              <div className="subtitle" style={{ marginBottom: 6 }}>
                Current seed (before generation)
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {zoneSummary.map(({ z, count }) => (
                  <span key={z} className="chip">
                    {z} • {count}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}

      {/* --- MANUAL MODE --- */}
      {mode === "manual" && (
        <div className="card" style={{ background: "#fff", display: "grid", gap: 12 }}>
          {/* Condensed preview always sits on top in Manual */}
          {preview ? <PreviewPanel preview={preview} planName={planName} /> : null}

          <AddZoneRow onAdd={addZone} />
          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
            }}
          >
            {zones.map((zone) => (
              <ZoneCard
                key={zone}
                zone={zone}
                tasks={tasksByZone[zone] || []}
                onAddTask={(name, cadence) => {
                  const list = (tasksByZone[zone] || []).slice();
                  if (!list.some((x) => getName(x).toLowerCase() === name.toLowerCase())) {
                    list.push(toTask({ name, cadence }));
                  }
                  const next = { ...tasksByZone, [zone]: ensureNextDue(list) };
                  setTasksByZone(next);
                  buildPreview(zones, next);
                }}
                onSuggest={() => suggestZone(zone)}
                onPatch={(idx, patch) => patchTask(zone, idx, patch)}
                onRemove={(idx) => removeTask(zone, idx)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Footer actions (delegated to the page via props) */}
      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
        <span className="subtitle" style={{ color: "var(--muted)" }}>
          {note}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => onSave?.(plan)} aria-busy={busy}>
            <Save size={16} style={{ marginRight: 6 }} /> Save
          </button>
          <button className="btn primary" onClick={() => onStart?.(plan)} aria-busy={busy}>
            <Play size={16} style={{ marginRight: 6 }} /> Start Session
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Subcomponents ----------------------------- */
function AddZoneRow({ onAdd }) {
  const [val, setVal] = useState("");
  return (
    <div style={{ display: "grid", gap: 8, gridTemplateColumns: "minmax(0,1fr) auto" }}>
      <input
        className="btn"
        placeholder="Add a zone… e.g., Kitchen"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (onAdd(val), setVal(""))}
      />
      <button className="btn" onClick={() => { onAdd(val); setVal(""); }}>
        <Plus size={16} style={{ marginRight: 6 }} /> Add Zone
      </button>
    </div>
  );
}

function ZoneCard({ zone, tasks, onSuggest, onAddTask, onPatch, onRemove }) {
  const [tName, setTName] = useState("");
  const [cad, setCad] = useState("weekly");

  return (
    <div className="card" style={{ background: "#fffaf0", borderColor: "#fde68a" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>{zone}</h3>
        <button className="btn xs" onClick={onSuggest}>
          <Wand2 size={14} style={{ marginRight: 6 }} /> Suggest
        </button>
      </div>

      {/* quick add row */}
      <div style={{ display: "grid", gap: 6, gridTemplateColumns: "minmax(0,1fr) 140px 40px" }}>
        <input
          className="btn"
          placeholder="e.g., Sweep"
          value={tName}
          onChange={(e) => setTName(e.target.value)}
          onKeyDown={(e) =>
            e.key === "Enter" && tName.trim() && (onAddTask(tName, cad), setTName(""))
          }
        />
        <select className="btn" value={cad} onChange={(e) => setCad(normalizeCadence(e.target.value))}>
          {CADENCES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => tName.trim() && (onAddTask(tName, cad), setTName(""))}>
          <Plus size={14} />
        </button>
      </div>

      {/* task list (still editable) */}
      <ul style={{ listStyle: "none", paddingLeft: 0, marginTop: 8, display: "grid", gap: 6 }}>
        {tasks.map((t, i) => {
          const est = estimateTaskMinutes(getName(t), zone);
          return (
            <li key={`${getName(t)}-${i}`} className="card" style={{ padding: 8 }}>
              <div style={{ display: "grid", gap: 8, gridTemplateColumns: "minmax(0,1fr) 120px 120px auto" }}>
                <div>
                  <div style={{ fontWeight: 600 }}>{getName(t)}</div>
                  <div className="subtitle">
                    next: {t.nextDue ? dayjs(t.nextDue).format("MMM D") : "—"} • {est.min}–{est.max}m
                  </div>
                </div>

                <div title="Start time (optional)" style={{ alignSelf: "center" }}>
                  <div className="btn" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Clock size={14} />
                    <input
                      type="time"
                      className="naked"
                      value={t.time || ""}
                      onChange={(e) => onPatch(i, { time: e.target.value || null })}
                      style={{ width: 90 }}
                    />
                  </div>
                </div>

                <select
                  className="btn"
                  value={normalizeCadence(t.cadence) || "weekly"}
                  onChange={(e) => onPatch(i, { cadence: e.target.value })}
                >
                  {CADENCES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, alignItems: "center" }}>
                  <label className="field" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={!!t.remind}
                      onChange={(e) => onPatch(i, { remind: e.target.checked })}
                    />
                    <span className="subtitle">Text me 10m before</span>
                  </label>
                  <button className="btn xs" onClick={() => onRemove(i)}>
                    ✕
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="field" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange?.(e.target.checked)} />
      <span className="subtitle">{label}</span>
    </label>
  );
}

function TagPicker({ value = [], options = [], onChange }) {
  const toggle = (opt) => {
    const has = value.includes(opt);
    onChange?.(has ? value.filter((x) => x !== opt) : [...value, opt]);
  };
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {options.map((opt) => (
        <Chip key={opt} active={value.includes(opt)} onClick={() => toggle(opt)}>
          {opt}
        </Chip>
      ))}
    </div>
  );
}

/* -------------------------- Condensed Preview UI ------------------------- */
function PreviewPanel({ preview, planName }) {
  const total = `${preview.minTotal}–${preview.maxTotal} min`;
  return (
    <div className="card" style={{ borderColor: "#e5e7eb", background: "#f9fafb" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Info size={16} />
          <div style={{ fontWeight: 600 }}>{planName}</div>
          <div className="chip">Preview</div>
        </div>
        <div className="subtitle"><strong>Total:</strong> {total}</div>
      </div>

      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
        {preview.zones.map((z) => (
          <div key={z.zone} className="card" style={{ padding: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <div style={{ fontWeight: 700 }}>{z.zone}</div>
              <div className="subtitle">
                {z.minTotal}–{z.maxTotal}m
              </div>
            </div>
            <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0, display: "grid", gap: 6 }}>
              {z.rows.map((r, i) => (
                <li key={`${r.name}-${i}`} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    • {r.name}
                    <span className="subtitle"> — {r.cadence}</span>
                  </span>
                  <span className="subtitle">{r.min}–{r.max}m</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
