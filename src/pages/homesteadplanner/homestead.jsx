/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\pages\homestead.jsx
import React, { useCallback, useEffect, useMemo, useState, useId } from "react";
import "@/styles/bridge.scan.css";

/**
 * Homestead Planner — seasonal goals → domain sessions
 * Imports → Intelligence → Automation → (optional) Hub Export
 */

// ----------------------------- Soft Imports ---------------------------------
let eventBus = null;
try {
  // eslint-disable-next-line global-require
  eventBus =
    require("@/services/eventBus").default ?? require("@/services/eventBus");
} catch {}

let Config = { get: (_k, fb) => fb };
try {
  // eslint-disable-next-line global-require
  Config = require("@/config").default ?? require("@/config");
} catch {}

let HubPacketFormatter = null;
try {
  // eslint-disable-next-line global-require
  HubPacketFormatter =
    require("@/services/hub/HubPacketFormatter").default ??
    require("@/services/hub/HubPacketFormatter");
} catch {}

let FamilyFundConnector = null;
try {
  // eslint-disable-next-line global-require
  FamilyFundConnector =
    require("@/services/hub/FamilyFundConnector").default ??
    require("@/services/hub/FamilyFundConnector");
} catch {}

let db = null;
try {
  // eslint-disable-next-line global-require
  db = require("@/db").default ?? require("@/db");
} catch {}

let StorehouseService = null;
try {
  // eslint-disable-next-line global-require
  StorehouseService =
    require("@/domain/storehouse/StorehouseService").default ??
    require("@/domain/storehouse/StorehouseService");
} catch {}

let MealSessionEngine = null;
try {
  // eslint-disable-next-line global-require
  MealSessionEngine =
    require("@/domain/meals/MealSessionGenerator").default ??
    require("@/domain/meals/MealSessionGenerator");
} catch {}

let CleaningSessionEngine = null;
try {
  // eslint-disable-next-line global-require
  CleaningSessionEngine =
    require("@/domain/cleaning/CleaningSessionEngine").default ??
    require("@/domain/cleaning/CleaningSessionEngine");
} catch {}

let GardenSessionEngine = null;
try {
  // eslint-disable-next-line global-require
  GardenSessionEngine =
    require("@/domain/garden/GardenSessionEngine").default ??
    require("@/domain/garden/gardenSessionEngine");
} catch {}

let AnimalSessionEngine = null;
try {
  // eslint-disable-next-line global-require
  AnimalSessionEngine =
    require("@/domain/animals/AnimalSessionEngine").default ??
    require("@/domain/animals/AnimalSessionEngine");
} catch {}

let PreservationEngine = null;
try {
  // eslint-disable-next-line global-require
  PreservationEngine =
    require("@/features/preservation/PreservationSessionEngine").default ??
    require("@/features/preservation/PreservationSessionEngine");
} catch {}

let InventoryRules = null;
try {
  // eslint-disable-next-line global-require
  InventoryRules =
    require("@/domain/inventory/InventoryRules").default ??
    require("@/domain/inventory/InventoryRules");
} catch {}

// ------------------------------ Utilities -----------------------------------
const NOW_ISO = () => new Date().toISOString();

function emit(type, source, data) {
  const payload = { type, ts: NOW_ISO(), source, data };
  try {
    eventBus?.emit?.(type, payload);
    window?.dispatchEvent?.(new CustomEvent(type, { detail: payload }));
  } catch (e) {
    if (process.env.NODE_ENV !== "production")
      console.debug("[homestead] emit failed:", e);
  }
  return payload;
}

async function exportToHubIfEnabled(payload) {
  try {
    const flags = Config.get?.("featureFlags", {}) ?? {};
    if (!flags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format?.(payload);
    if (!packet) return;
    await FamilyFundConnector.send?.(packet);
  } catch (e) {
    if (process.env.NODE_ENV !== "production")
      console.debug("[homestead] hub export ignored:", e);
  }
}

/**
 * HOOK: Hub export wrapper (keeps the page clean and avoids repeating flag checks).
 * Safe no-op when feature flags or hub services are unavailable.
 */
function useHubExport({ source = "HomesteadPlanner" } = {}) {
  const familyFundMode = useMemo(() => {
    try {
      const flags = Config.get?.("featureFlags", {}) ?? {};
      return !!flags.familyFundMode;
    } catch {
      return false;
    }
  }, []);

  const exportToHub = useCallback(
    async (payload) => {
      try {
        if (!familyFundMode) return;
        if (!payload) return;
        if (!HubPacketFormatter || !FamilyFundConnector) return;
        const packet = HubPacketFormatter.format?.(payload);
        if (!packet) return;
        await FamilyFundConnector.send?.(packet);
      } catch (e) {
        if (process.env.NODE_ENV !== "production")
          console.debug(`[homestead] hub export ignored (${source}):`, e);
      }
    },
    [familyFundMode, source]
  );

  return { familyFundMode, exportToHub };
}

function isNumber(x) {
  return Number.isFinite(+x);
}

function currentSeason(d = new Date()) {
  const m = d.getMonth();
  if (m <= 1 || m === 11) return "winter";
  if (m <= 4) return "spring";
  if (m <= 7) return "summer";
  return "fall";
}

function setAtPath(obj, path, value) {
  const parts = path.split(".");
  const next = structuredClone(obj);
  let cur = next;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return next;
}

async function suggestSessions(goals) {
  const suggestions = [];

  if (MealSessionEngine?.suggestBatchFromInventory) {
    try {
      const meals = await MealSessionEngine.suggestBatchFromInventory({
        servingsTarget: goals?.meals?.servingsTarget ?? 12,
        batchDaysPerWeek: goals?.meals?.batchDaysPerWeek ?? 2,
      });
      if (meals?.length)
        suggestions.push(...meals.map((s) => ({ domain: "meals", ...s })));
    } catch {}
  }

  if (CleaningSessionEngine?.generate) {
    try {
      const clean = await CleaningSessionEngine.generate({
        mode: "zone-blitz",
        zones: goals?.cleaning?.zones ?? ["kitchen", "pantry"],
        minutes: 45,
      });
      if (clean) suggestions.push({ domain: "cleaning", ...clean });
    } catch {}
  }

  if (GardenSessionEngine?.buildFromPlan && goals?.garden) {
    try {
      const g = await GardenSessionEngine.buildFromPlan(goals.garden);
      if (g) suggestions.push({ domain: "garden", ...g });
    } catch {}
  }

  if (AnimalSessionEngine?.buildFromTargets && goals?.animals) {
    try {
      const a = await AnimalSessionEngine.buildFromTargets(goals.animals);
      if (a) suggestions.push({ domain: "animals", ...a });
    } catch {}
  }

  if (PreservationEngine?.planFromTargets && goals?.preservation) {
    try {
      const p = await PreservationEngine.planFromTargets(goals.preservation);
      if (p) suggestions.push({ domain: "preservation", ...p });
    } catch {}
  }

  return suggestions;
}

async function savePlan(plan) {
  if (StorehouseService?.saveHomesteadPlan)
    return StorehouseService.saveHomesteadPlan(plan);
  if (db?.homesteadPlans?.put) return db.homesteadPlans.put(plan);
  return null;
}

async function loadLastPlan() {
  if (StorehouseService?.getLastHomesteadPlan)
    return StorehouseService.getLastHomesteadPlan();
  if (db?.homesteadPlans?.orderBy) {
    const rec = await db.homesteadPlans.orderBy("updatedAt").last();
    return rec ?? null;
  }
  return null;
}

// ------------------------------- Component -----------------------------------
export default function HomesteadPlannerPage() {
  const [plan, setPlan] = useState(() => ({
    id: `plan-${Math.random().toString(36).slice(2, 8)}`,
    season: currentSeason(),
    meals: { servingsTarget: 12, batchDaysPerWeek: 2 },
    preservation: { canningJars: 24, dehydrateTrays: 8, freezerSpaceCuFt: 4 },
    garden: {
      beds: 6,
      priorityCrops: ["greens", "onions", "garlic"],
      compostCft: 8,
    },
    animals: {
      estimatedTotal: 8,
      livestockMix: "layers, meat birds, rabbits",
      butcheryTargets: [],
    },
    storehouse: { flour_5lb: 4, rice_10lb: 2, beans_10lb: 2, salt_lb: 5 },
    cleaning: { zones: ["kitchen", "pantry"] },
    notes: "",
    createdAt: NOW_ISO(),
    updatedAt: NOW_ISO(),
  }));
  const [suggested, setSuggested] = useState([]);
  const [status, setStatus] = useState({ kind: "idle", msg: "" });

  const { exportToHub } = useHubExport({ source: "HomesteadPlanner" });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const last = await loadLastPlan();
        if (alive && last) setPlan((p) => ({ ...p, ...last }));
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, []);

  const kpis = useMemo(() => {
    const mealsPerWeek = isNumber(plan?.meals?.batchDaysPerWeek)
      ? +plan.meals.batchDaysPerWeek
      : 0;
    const jars = isNumber(plan?.preservation?.canningJars)
      ? +plan.preservation.canningJars
      : 0;
    const beds = isNumber(plan?.garden?.beds) ? +plan.garden.beds : 0;
    const animals =
      (plan?.animals?.estimatedTotal && +plan.animals.estimatedTotal) ||
      (plan?.animals?.chickens?.layers || 0) +
        (plan?.animals?.rabbits?.breedPairs || 0) * 2 +
        (plan?.animals?.goats?.does || 0);
    return { mealsPerWeek, jars, beds, animals };
  }, [plan]);

  const onSuggest = useCallback(async () => {
    try {
      const list = await suggestSessions(plan);
      setSuggested(list);
      const payload = emit(
        "homestead.plan.sessions.suggested",
        "HomesteadPlanner",
        {
          count: list.length,
          season: plan.season,
        }
      );
      exportToHub(payload);
      setStatus({
        kind: "ok",
        msg: `Suggested ${list.length} milestone session(s).`,
      });
      return payload;
    } catch {
      setStatus({ kind: "error", msg: "Could not generate suggestions." });
    }
  }, [plan, exportToHub]);

  const onCommit = useCallback(async () => {
    try {
      const record = { ...plan, updatedAt: NOW_ISO() };
      await savePlan(record);
      setPlan(record);

      const payload = emit("homestead.plan.updated", "HomesteadPlanner", {
        id: record.id,
        season: record.season,
      });
      exportToHub(payload);

      if (InventoryRules?.mapGoalsToInventoryDeltas) {
        const deltas = await InventoryRules.mapGoalsToInventoryDeltas(
          record.storehouse || {}
        );
        if (Array.isArray(deltas) && deltas.length) {
          const invPayload = emit("inventory.updated", "HomesteadPlanner", {
            deltas,
          });
          exportToHub(invPayload);
        }
      }

      setStatus({ kind: "ok", msg: "Plan saved and signals emitted." });
    } catch {
      setStatus({ kind: "error", msg: "Save failed." });
    }
  }, [plan, exportToHub]);

  const onExportJSON = useCallback(() => {
    try {
      const blob = new Blob([JSON.stringify(plan, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ssa-homestead-plan-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {}
  }, [plan]);

  const update = (path, value) => {
    setPlan((p) => setAtPath(p, path, value));
  };

  // ------------------------------- Render -----------------------------------
  return (
    <div className="scan-bridge min-h-screen w-full bg-gradient-to-br from-slate-50 via-white to-slate-100 dark:from-gray-900 dark:to-gray-800">
      <main className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-6 md:py-8 space-y-6 md:space-y-8">
        {/* HEADER */}
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="flex items-center gap-2 text-2xl md:text-3xl font-semibold text-[hsl(var(--text-primary))]">
              <span role="img" aria-label="homestead">
                🏡
              </span>
              Homestead Planner
            </h1>
            <p className="mt-1 text-sm text-[hsl(var(--text-subtle))] max-w-3xl">
              Turn seasonal goals into milestones and concrete sessions across
              cooking, cleaning, garden, animals, and preservation. SSA will
              cross-check meal plans, recipes, and cooking sessions whenever
              they&apos;re available.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn" onClick={onSuggest}>
              Suggest milestone sessions
            </button>
            <button type="button" className="btn btn--ghost" onClick={onCommit}>
              Save season plan
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={onExportJSON}
            >
              Export JSON
            </button>
          </div>
        </header>

        {/* TOP SNAPSHOT ROW – 4 SMALL SQUARE CARDS */}
        <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <EditableKpiCard
            label="Meals / week"
            value={plan.meals.batchDaysPerWeek}
            onChange={(v) => update("meals.batchDaysPerWeek", v)}
            hint="SSA maps this to batch cooking sessions."
          />
          <EditableKpiCard
            label="Canning jars target"
            value={plan.preservation.canningJars}
            onChange={(v) => update("preservation.canningJars", v)}
            hint="Total jars you’d like filled by end of season."
          />
          <EditableKpiCard
            label="Garden beds"
            value={plan.garden.beds}
            onChange={(v) => update("garden.beds", v)}
            hint="Beds in rotation this season."
          />
          <EditableKpiCard
            label="Animals (est.)"
            value={plan.animals.estimatedTotal}
            onChange={(v) => update("animals.estimatedTotal", v)}
            hint="Derived from your livestock goals below."
          />
        </section>

        {/* SEASON OVERVIEW */}
        <section>
          <Card
            title="Season overview & notes"
            subtitle="High-level context for this plan."
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <LabeledInput
                label="Season"
                value={plan.season}
                onChange={(v) => update("season", v)}
              />
              <div className="md:col-span-2">
                <LabeledInput
                  label="Notes"
                  value={plan.notes}
                  onChange={(v) => update("notes", v)}
                  placeholder="Family goals, constraints, reminders…"
                />
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <MiniKpi label="Meals / week" value={kpis.mealsPerWeek} />
              <MiniKpi label="Canning jars" value={kpis.jars} />
              <MiniKpi label="Beds in rotation" value={kpis.beds} />
              <MiniKpi label="Animals (est.)" value={kpis.animals} />
            </div>
          </Card>
        </section>

        {/* DOMAIN TARGETS */}
        <section>
          <h2 className="text-lg font-semibold text-[hsl(var(--text-primary))]">
            Domain targets
          </h2>
          <p className="mt-1 text-sm text-[hsl(var(--text-subtle))]">
            Tune milestones and recurring tasks for each domain this season. SSA
            will cross-check meal plans, recipes, and generated cooking sessions
            to make smart suggestions.
          </p>

          <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* Cooking */}
            <Card
              title="🥘 Cooking milestones"
              subtitle="Meal sessions & batch days for your kitchen rhythm."
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <LabeledInput
                  label="Servings per batch"
                  type="number"
                  value={plan.meals.servingsTarget}
                  onChange={(v) => update("meals.servingsTarget", v)}
                />
                <LabeledInput
                  label="Batch cooking days / week"
                  type="number"
                  value={plan.meals.batchDaysPerWeek}
                  onChange={(v) => update("meals.batchDaysPerWeek", v)}
                  hint="Drives how many cooking sessions the engine will try to generate."
                />
              </div>
            </Card>

            {/* Garden */}
            <Card
              title="🌱 Garden planner"
              subtitle="Beds, compost, and priority crops tied to tasks & work sessions."
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <LabeledInput
                  label="Beds"
                  type="number"
                  value={plan.garden.beds}
                  onChange={(v) => update("garden.beds", v)}
                />
                <LabeledInput
                  label="Compost (cu ft)"
                  type="number"
                  value={plan.garden.compostCft}
                  onChange={(v) => update("garden.compostCft", v)}
                />
                <div className="md:col-span-2">
                  <LabeledInput
                    label="Priority crops (comma-sep)"
                    value={(plan.garden.priorityCrops || []).join(", ")}
                    onChange={(v) =>
                      update(
                        "garden.priorityCrops",
                        v
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean)
                      )
                    }
                    hint="SSA will prioritize tasks and harvest milestones for these crops."
                  />
                </div>
              </div>
            </Card>

            {/* Preservation */}
            <Card
              title="🫙 Preservation milestones"
              subtitle="Canning, dehydrating, and freezer capacity targets."
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <LabeledInput
                  label="Canning jars (qt/pt total)"
                  type="number"
                  value={plan.preservation.canningJars}
                  onChange={(v) => update("preservation.canningJars", v)}
                />
                <LabeledInput
                  label="Dehydrate trays"
                  type="number"
                  value={plan.preservation.dehydrateTrays}
                  onChange={(v) => update("preservation.dehydrateTrays", v)}
                />
                <LabeledInput
                  label="Freezer space (cu ft)"
                  type="number"
                  value={plan.preservation.freezerSpaceCuFt}
                  onChange={(v) => update("preservation.freezerSpaceCuFt", v)}
                />
              </div>
            </Card>

            {/* Animals */}
            <Card
              title="🐓 Animal planner"
              subtitle="Acquisition, care, and butchery milestones for all livestock."
            >
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <LabeledInput
                  label="Animals (estimated total)"
                  type="number"
                  value={plan.animals.estimatedTotal}
                  onChange={(v) => update("animals.estimatedTotal", v)}
                />
                <LabeledInput
                  label="Livestock mix & notes"
                  value={plan.animals.livestockMix || ""}
                  onChange={(v) => update("animals.livestockMix", v)}
                  hint="Example: '12 layers, 25 meat birds, 4 grow-out rabbits, 2 dairy goats'."
                />
                <div className="md:col-span-2">
                  <LabeledInput
                    label="Butchery targets (comma-sep)"
                    value={(plan.animals.butcheryTargets || []).join(", ")}
                    onChange={(v) =>
                      update(
                        "animals.butcheryTargets",
                        v
                          .split(",")
                          .map((x) => x.trim())
                          .filter(Boolean)
                      )
                    }
                    hint="For example: '8 broilers, 4 rabbits, 1 goat'."
                  />
                </div>
              </div>
            </Card>
          </div>
        </section>

        {/* STOREHOUSE TARGETS */}
        <section>
          <Card
            title="🏷️ Storehouse targets"
            subtitle="Translate seasonal milestones into pantry quantities."
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
              {Object.entries(plan.storehouse).map(([k, val]) => (
                <LabeledInput
                  key={k}
                  type="number"
                  label={k.replace(/_/g, " ")}
                  value={val}
                  onChange={(v) => update(`storehouse.${k}`, v)}
                />
              ))}
            </div>
          </Card>
        </section>

        {/* SUGGESTED SESSIONS */}
        <section>
          <Card
            title="✨ Suggested milestone sessions"
            subtitle="SSA uses your goals plus any existing meal plans, recipes, and cooking sessions to propose concrete tasks."
          >
            {suggested.length === 0 ? (
              <div className="text-sm text-[hsl(var(--text-subtle))]">
                No suggestions yet. Click <em>Suggest milestone sessions</em> at
                the top of the page.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {suggested.map((s, idx) => (
                  <div key={idx} className="card p-3">
                    <div className="mb-1 text-xs">
                      <span className="chip chip--brand capitalize">
                        {s.domain}
                      </span>
                      {s.title ? (
                        <span className="ml-2 text-[hsl(var(--text-primary))]">
                          {s.title}
                        </span>
                      ) : null}
                    </div>
                    <pre className="max-h-40 overflow-auto rounded-lg bg-slate-50 p-2 text-xs">
                      {JSON.stringify(s, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </section>

        {/* PIPELINE DOCS */}
        <section>
          <Card title="How this fits the pipeline">
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
              <li>
                <strong>Goals → Intelligence:</strong> Seasonal targets become
                inventory deltas and domain workload.
              </li>
              <li>
                <strong>Automation:</strong> Cooking, cleaning, garden, animals,
                and preservation engines consume emitted events to queue /
                schedule sessions and tasks.
              </li>
              <li>
                <strong>Hub (optional):</strong> With familyFundMode on,
                mutations are formatted and sent to the Hub so milestones appear
                in the wider family view.
              </li>
            </ul>
          </Card>
        </section>

        {status.kind !== "idle" && (
          <div
            className={
              "fixed bottom-4 right-4 z-20 rounded-xl border px-3 py-2 text-xs shadow-lg bg-white " +
              (status.kind === "ok"
                ? "border-lime-300 text-lime-900"
                : status.kind === "error"
                ? "border-rose-300 text-rose-900"
                : "border-slate-200 text-slate-800")
            }
          >
            {status.msg}
          </div>
        )}
      </main>
    </div>
  );
}

// ------------------------------- UI Bits ------------------------------------
function Card({ title, subtitle, children }) {
  return (
    <div className="card p-4 md:p-5">
      {(title || subtitle) && (
        <div className="mb-2">
          {title && (
            <div className="text-sm font-semibold text-[hsl(var(--text-primary))]">
              {title}
            </div>
          )}
          {subtitle && (
            <div className="text-xs text-[hsl(var(--text-subtle))]">
              {subtitle}
            </div>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

function MiniKpi({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 flex flex-col">
      <div className="text-[11px] text-[hsl(var(--text-subtle))]">{label}</div>
      <div className="tabular-nums text-lg font-semibold text-[hsl(var(--text-primary))]">
        {value ?? 0}
      </div>
    </div>
  );
}

function EditableKpiCard({ label, value, onChange, hint }) {
  const autoId = useId();
  const inputId = `kpi-${autoId}`;
  const descId = hint ? `${inputId}-hint` : undefined;

  return (
    <div className="card p-3 md:p-4 flex flex-col justify-between">
      <label
        htmlFor={inputId}
        className="mb-1 text-xs font-medium text-[hsl(var(--text-primary))]"
      >
        {label}
      </label>
      <input
        id={inputId}
        type="number"
        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-center text-2xl tabular-nums font-semibold text-slate-900 outline-none focus:border-[hsl(var(--suka-brand-600))] focus:ring-2 focus:ring-[hsla(var(--suka-brand)/0.35)]"
        value={value ?? 0}
        onChange={(e) => onChange?.(Number(e.target.value))}
        aria-describedby={descId}
      />
      {hint && (
        <div
          id={descId}
          className="mt-1 text-[11px] text-[hsl(var(--text-subtle))]"
        >
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * Accessible input with programmatic label association.
 */
function LabeledInput({
  id,
  label,
  value,
  onChange,
  type = "text",
  className = "",
  hint,
  placeholder,
}) {
  const autoId = useId();
  const inputId = id || `hs-${autoId}`;
  const descId = hint ? `${inputId}-hint` : undefined;

  return (
    <div className={className}>
      <label
        className="mb-1 block text-xs font-medium text-[hsl(var(--text-primary))]"
        htmlFor={inputId}
      >
        {label}
      </label>
      <input
        id={inputId}
        type={type}
        className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none ring-0 placeholder-slate-400 focus:border-[hsl(var(--suka-brand-600))] focus:ring-2 focus:ring-[hsla(var(--suka-brand)/0.35)]"
        value={value ?? (type === "number" ? 0 : "")}
        onChange={(e) =>
          onChange?.(
            type === "number" ? Number(e.target.value) : e.target.value
          )
        }
        aria-describedby={descId}
        placeholder={placeholder ?? String(label)}
      />
      {hint && (
        <div
          id={descId}
          className="mt-1 text-[11px] text-[hsl(var(--text-subtle))]"
        >
          {hint}
        </div>
      )}
    </div>
  );
}
