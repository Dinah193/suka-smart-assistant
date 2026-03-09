// src/pages/settings/views/MealPlanningSettingsPage.jsx
import React, { useEffect, useRef, useState } from "react";
import { automation, emitProgress } from "@/services/automation/runtime";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard";
import { classNames } from "@/utils/css";

// Optional stores (graceful fallback if absent)
import { useMealPlanningStore } from "@/store/MealPlanningStore"; // optional
import { useFoodStore } from "@/store/FoodStore"; // optional (dietary integration)
import { useInventoryStore } from "@/store/InventoryStore"; // optional (pantry-first)
import { useCalendarStore } from "@/store/CalendarStore"; // optional

/* -------------------------------------------------------------------------- */
/* UI atoms                                                                   */
/* -------------------------------------------------------------------------- */
const SectionCard = ({ title, subtitle, right, children }) => (
  <div className="rounded-2xl shadow-md border border-base-200 bg-base-100">
    <div className="flex items-start justify-between p-5 border-b border-base-200">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        {subtitle ? (
          <p className="text-sm opacity-70 mt-1">{subtitle}</p>
        ) : null}
      </div>
      {right}
    </div>
    <div className="p-5">{children}</div>
  </div>
);

const Row = ({ label, hint, children }) => (
  <div className="flex items-start justify-between py-3">
    <div className="pr-4">
      <p className="font-medium">{label}</p>
      {hint ? <p className="text-sm opacity-70">{hint}</p> : null}
    </div>
    <div className="flex flex-wrap items-center gap-3">{children}</div>
  </div>
);

const Toggle = ({ checked, onChange, disabled }) => (
  <input
    type="checkbox"
    className="toggle toggle-primary"
    checked={!!checked}
    onChange={(e) => onChange(e.target.checked)}
    disabled={disabled}
  />
);

const Select = ({
  value,
  onChange,
  options = [],
  disabled,
  className = "w-56",
}) => (
  <select
    className={classNames("select select-bordered", className)}
    value={value ?? ""}
    onChange={(e) => onChange(e.target.value)}
    disabled={disabled}
  >
    {options.map((o) => (
      <option key={(o.value ?? o) + ""} value={o.value ?? o}>
        {o.label ?? o}
      </option>
    ))}
  </select>
);

const Input = ({
  value,
  onChange,
  placeholder,
  disabled,
  className = "w-64",
  type = "text",
}) => (
  <input
    type={type}
    className={classNames("input input-bordered", className)}
    value={value ?? ""}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    disabled={disabled}
  />
);

const Textarea = ({
  value,
  onChange,
  placeholder,
  disabled,
  className = "w-full",
}) => (
  <textarea
    className={classNames("textarea textarea-bordered", className)}
    value={value ?? ""}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    disabled={disabled}
  />
);

const Chip = ({ children }) => (
  <span className="px-2 py-1 rounded-full text-xs bg-base-200">{children}</span>
);

const GhostButton = (props) => (
  <button
    {...props}
    className={classNames("btn btn-ghost btn-sm", props.className)}
  />
);
const PrimaryButton = (props) => (
  <button
    {...props}
    className={classNames("btn btn-primary", props.className)}
  />
);
const SubtleButton = (props) => (
  <button
    {...props}
    className={classNames("btn btn-outline btn-sm", props.className)}
  />
);
const DangerButton = (props) => (
  <button
    {...props}
    className={classNames("btn btn-error btn-sm", props.className)}
  />
);

const Divider = () => <div className="border-t border-base-200 my-4" />;

const InlineNotice = ({ tone = "info", children }) => {
  const toneClass =
    tone === "success"
      ? "alert-success"
      : tone === "warning"
      ? "alert-warning"
      : tone === "error"
      ? "alert-error"
      : "alert-info";
  return <div className={classNames("alert", toneClass)}>{children}</div>;
};

const Skeleton = ({ lines = 3 }) => (
  <div className="animate-pulse space-y-3">
    {Array.from({ length: lines }).map((_, i) => (
      <div key={i} className="h-4 bg-base-200 rounded" />
    ))}
  </div>
);

/* -------------------------------------------------------------------------- */
/* Undo stack                                                                 */
/* -------------------------------------------------------------------------- */
function useUndoStack() {
  const stack = useRef([]);
  const push = (revert, descr = "Change") => {
    stack.current.push(revert);
    return {
      message: `${descr} applied`,
      undo: () => {
        const fn = stack.current.pop();
        if (fn) fn();
      },
    };
  };
  return { push };
}

/* -------------------------------------------------------------------------- */
/* Event-driven glue                                                          */
/* -------------------------------------------------------------------------- */
const EVENT_KEYS = [
  "recipe.consolidated", // improve plan quality (scores/tags changed)
  "inventory.updated", // pantry-first deltas -> replan or adjust shopping
  "calendar.synced", // surface success
  "preferences.changed", // cross-page updates
  "torah.profile.updated", // dietary rules changed -> re-score/rebuild
];

function useAutomationGlue(onEvent) {
  useEffect(() => {
    const offFns = [];
    EVENT_KEYS.forEach((k) => {
      const off = automation?.on?.(k, (payload) => onEvent?.(k, payload));
      if (off) offFns.push(off);
    });
    return () => offFns.forEach((f) => f?.());
  }, [onEvent]);
}

/* -------------------------------------------------------------------------- */
/* Main Page                                                                  */
/* -------------------------------------------------------------------------- */
export default function MealPlanningSettingsPage() {
  const meal = useMealPlanningStore?.() ?? {};
  const food = useFoodStore?.() ?? {};
  const inventory = useInventoryStore?.() ?? {};
  const calendar = useCalendarStore?.() ?? {};

  const loading = meal.loading || false;
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [banners, setBanners] = useState([]);
  const undo = useUndoStack();

  /* -------------------------------- State --------------------------------- */
  // Household / cadence
  const [servings, setServings] = useState(meal.servings ?? food.servings ?? 4);
  const [mealsPerDay, setMealsPerDay] = useState(
    meal.mealsPerDay ?? food.mealsPerDay ?? 2
  );
  const [planHorizonDays, setPlanHorizonDays] = useState(
    meal.planHorizonDays ?? 14
  );
  const [batchDays, setBatchDays] = useState(
    meal.batchDays ?? food.batchDays ?? ["Sun"]
  );
  const [leftoversPolicy, setLeftoversPolicy] = useState(
    meal.leftoversPolicy || "next-day"
  ); // none|next-day|flex
  const [rotationWindowWeeks, setRotationWindowWeeks] = useState(
    meal.rotationWindowWeeks ?? 6
  );

  // Preferences / cost / health
  const [pantryFirst, setPantryFirst] = useState(meal.pantryFirst ?? true);
  const [seasonality, setSeasonality] = useState(
    meal.seasonality ?? "in-season"
  ); // off|in-season|strict
  const [budgetPerServing, setBudgetPerServing] = useState(
    meal.budgetPerServing ?? 3.5
  );
  const [calorieTargetPerDay, setCalorieTargetPerDay] = useState(
    meal.calorieTargetPerDay ?? 2100
  );
  const [proteinTargetPerDay, setProteinTargetPerDay] = useState(
    meal.proteinTargetPerDay ?? 90
  );
  const [spiceCap, setSpiceCap] = useState(
    meal.spiceCap ?? food.spice ?? "medium"
  ); // mild|medium|hot
  const [cuisineDiversity, setCuisineDiversity] = useState(
    meal.cuisineDiversity ?? "balanced"
  ); // homestyle|balanced|world-tour

  // Dietary / rules (read from Food settings, editable overrides)
  const [respectTorahMode, setRespectTorahMode] = useState(
    meal.respectTorahMode ?? true
  );
  const [honorAllergens, setHonorAllergens] = useState(
    meal.honorAllergens ?? true
  );
  const [honorAvoidList, setHonorAvoidList] = useState(
    meal.honorAvoidList ?? true
  );

  // Labels & automation
  const [autoLabeling, setAutoLabeling] = useState(
    meal.autoLabeling ?? food.autoLabeling ?? true
  );
  const [autoGenerateOnInventory, setAutoGenerateOnInventory] = useState(
    meal.autoGenerateOnInventory ?? true
  );

  // Calendar & sharing
  const [syncMealsToCalendar, setSyncMealsToCalendar] = useState(
    meal.syncMealsToCalendar ?? true
  );
  const [sabbathBlock, setSabbathBlock] = useState(
    meal.sabbathBlock ?? food.sabbathBlock ?? true
  );
  const [shareForecast, setShareForecast] = useState(
    meal.shareForecast ?? true
  );

  // Plan quality diagnostics
  const [minVariety, setMinVariety] = useState(meal.minVariety ?? 5); // unique mains in window
  const [maxRepeat, setMaxRepeat] = useState(meal.maxRepeat ?? 1); // same dish repeat cap
  const [prepTimeBudgetMins, setPrepTimeBudgetMins] = useState(
    meal.prepTimeBudgetMins ?? 45
  );

  /* -------------------------- Event-driven glue --------------------------- */
  useAutomationGlue((event, payload) => {
    if (event === "recipe.consolidated") {
      addBanner({
        key: "improve-quality",
        tone: "info",
        text: "Recipes updated. Improve plan quality to reflect new scores & tags.",
        actions: [
          {
            label: "Improve Plan Quality",
            fn: () => handleGenerate("quality"),
          },
          { label: "Rebuild Labels", fn: () => handleGenerate("labels") },
        ],
      });
    }
    if (event === "inventory.updated") {
      addBanner({
        key: "pantry-first",
        tone: "warning",
        text: "Inventory changed. Refresh shopping list & nudge plan to pantry-first.",
        actions: [
          { label: "Refresh Shopping", fn: () => handleGenerate("shopping") },
          {
            label: "Pantry-First Nudge",
            fn: () => handleGenerate("pantry-nudge"),
          },
        ],
      });
    }
    if (event === "calendar.synced") {
      addBanner({
        key: "cal-synced",
        tone: "success",
        text: "Meal events synced to calendar.",
        dismissible: true,
      });
    }
    if (event === "preferences.changed") {
      setToast({
        tone: "info",
        text: "Preferences updated. Meal planning will honor your new defaults.",
      });
    }
    if (event === "torah.profile.updated") {
      addBanner({
        key: "dietary-alignment",
        tone: "info",
        text: "Dietary profile changed. Consider rebuilding meal suggestions & labels.",
        actions: [
          { label: "Rebuild Meal Plan", fn: () => handleGenerate("mealplan") },
        ],
      });
    }
  });

  function addBanner(b) {
    setBanners((prev) =>
      prev.find((x) => x.key === b.key) ? prev : [...prev, b]
    );
  }
  function dismissBanner(key) {
    setBanners((prev) => prev.filter((b) => b.key !== key));
  }

  /* ------------------------------ Persistence ----------------------------- */
  const optimisticSave = async (partial, descr = "Settings") => {
    const prev = {
      servings,
      mealsPerDay,
      planHorizonDays,
      batchDays,
      leftoversPolicy,
      rotationWindowWeeks,
      pantryFirst,
      seasonality,
      budgetPerServing,
      calorieTargetPerDay,
      proteinTargetPerDay,
      spiceCap,
      cuisineDiversity,
      respectTorahMode,
      honorAllergens,
      honorAvoidList,
      autoLabeling,
      autoGenerateOnInventory,
      syncMealsToCalendar,
      sabbathBlock,
      shareForecast,
      minVariety,
      maxRepeat,
      prepTimeBudgetMins,
    };

    // apply optimistic
    Object.entries(partial).forEach(([k, v]) => {
      switch (k) {
        case "servings":
          setServings(v);
          break;
        case "mealsPerDay":
          setMealsPerDay(v);
          break;
        case "planHorizonDays":
          setPlanHorizonDays(v);
          break;
        case "batchDays":
          setBatchDays(v);
          break;
        case "leftoversPolicy":
          setLeftoversPolicy(v);
          break;
        case "rotationWindowWeeks":
          setRotationWindowWeeks(v);
          break;

        case "pantryFirst":
          setPantryFirst(v);
          break;
        case "seasonality":
          setSeasonality(v);
          break;
        case "budgetPerServing":
          setBudgetPerServing(v);
          break;
        case "calorieTargetPerDay":
          setCalorieTargetPerDay(v);
          break;
        case "proteinTargetPerDay":
          setProteinTargetPerDay(v);
          break;
        case "spiceCap":
          setSpiceCap(v);
          break;
        case "cuisineDiversity":
          setCuisineDiversity(v);
          break;

        case "respectTorahMode":
          setRespectTorahMode(v);
          break;
        case "honorAllergens":
          setHonorAllergens(v);
          break;
        case "honorAvoidList":
          setHonorAvoidList(v);
          break;

        case "autoLabeling":
          setAutoLabeling(v);
          break;
        case "autoGenerateOnInventory":
          setAutoGenerateOnInventory(v);
          break;

        case "syncMealsToCalendar":
          setSyncMealsToCalendar(v);
          break;
        case "sabbathBlock":
          setSabbathBlock(v);
          break;
        case "shareForecast":
          setShareForecast(v);
          break;

        case "minVariety":
          setMinVariety(v);
          break;
        case "maxRepeat":
          setMaxRepeat(v);
          break;
        case "prepTimeBudgetMins":
          setPrepTimeBudgetMins(v);
          break;

        default:
          break;
      }
    });

    const { undo: revert } = undo.push(() => setStateFrom(prev)(), descr);

    setBusy(true);
    try {
      if (meal.saveSettings) {
        await meal.saveSettings({ ...prev, ...partial });
      } else {
        await automation.request?.("mealplan.saveSettings", {
          ...prev,
          ...partial,
        });
      }

      setToast({
        tone: "success",
        text: `${descr} saved`,
        action: { label: "Undo", fn: () => revert() },
      });
      emitProgress?.("settings.saved", {
        scope: "mealplanning",
        nextBestAction: suggestNBA(partial),
      });

      // propagate dietary-impactful changes
      if (
        "respectTorahMode" in partial ||
        "honorAllergens" in partial ||
        "honorAvoidList" in partial
      ) {
        automation.emit?.("torah.profile.updated", {
          effectiveDate: new Date().toISOString(),
        });
      }
    } catch (e) {
      revert();
      setToast({ tone: "error", text: `Failed to save ${descr}.` });
    } finally {
      setBusy(false);
    }
  };

  function setStateFrom(prev) {
    return () => {
      setServings(prev.servings);
      setMealsPerDay(prev.mealsPerDay);
      setPlanHorizonDays(prev.planHorizonDays);
      setBatchDays(prev.batchDays);
      setLeftoversPolicy(prev.leftoversPolicy);
      setRotationWindowWeeks(prev.rotationWindowWeeks);

      setPantryFirst(prev.pantryFirst);
      setSeasonality(prev.seasonality);
      setBudgetPerServing(prev.budgetPerServing);
      setCalorieTargetPerDay(prev.calorieTargetPerDay);
      setProteinTargetPerDay(prev.proteinTargetPerDay);
      setSpiceCap(prev.spiceCap);
      setCuisineDiversity(prev.cuisineDiversity);

      setRespectTorahMode(prev.respectTorahMode);
      setHonorAllergens(prev.honorAllergens);
      setHonorAvoidList(prev.honorAvoidList);

      setAutoLabeling(prev.autoLabeling);
      setAutoGenerateOnInventory(prev.autoGenerateOnInventory);

      setSyncMealsToCalendar(prev.syncMealsToCalendar);
      setSabbathBlock(prev.sabbathBlock);
      setShareForecast(prev.shareForecast);

      setMinVariety(prev.minVariety);
      setMaxRepeat(prev.maxRepeat);
      setPrepTimeBudgetMins(prev.prepTimeBudgetMins);
    };
  }

  const suggestNBA = (partial) => {
    if (
      "batchDays" in partial ||
      "planHorizonDays" in partial ||
      "rotationWindowWeeks" in partial
    )
      return {
        label: "Rebuild Meal Plan",
        action: () => handleGenerate("mealplan"),
      };
    if (
      "pantryFirst" in partial ||
      "seasonality" in partial ||
      "budgetPerServing" in partial
    )
      return {
        label: "Refresh Shopping List",
        action: () => handleGenerate("shopping"),
      };
    if ("autoLabeling" in partial)
      return {
        label: "Rebuild Labels",
        action: () => handleGenerate("labels"),
      };
    if ("syncMealsToCalendar" in partial)
      return { label: "Sync to Calendar", action: () => handleSync("meals") };
    if (
      "minVariety" in partial ||
      "maxRepeat" in partial ||
      "prepTimeBudgetMins" in partial
    )
      return {
        label: "Improve Plan Quality",
        action: () => handleGenerate("quality"),
      };
    if (
      "respectTorahMode" in partial ||
      "honorAllergens" in partial ||
      "honorAvoidList" in partial
    )
      return {
        label: "Re-score Recipes",
        action: () => handleGenerate("recs"),
      };
    return { label: "Open Meal Planner", action: () => openMealPlanner() };
  };

  /* -------------------------------- Actions -------------------------------- */
  const handleGenerate = async (scope) => {
    const task = async () => {
      setBusy(true);
      try {
        if (meal.generate) {
          await meal.generate(scope);
        } else {
          await automation.request?.("mealplan.generate", { scope });
        }
        setToast({
          tone: "success",
          text: `${labelForScope(scope)} generated.`,
        });
      } catch {
        setToast({
          tone: "error",
          text: `Failed to generate ${labelForScope(scope)}.`,
        });
      } finally {
        setBusy(false);
      }
    };
    await sabbathGuard(task, { allowReadOnly: false });
  };

  const handleSync = async (scope = "meals") => {
    const task = async () => {
      try {
        if (meal.syncNow) {
          await meal.syncNow(scope);
        } else {
          await automation.request?.("calendar.sync", { scope });
        }
        automation.emit?.("calendar.synced", { scope });
        setToast({ tone: "success", text: "Meals synced to calendar." });
      } catch {
        setToast({ tone: "error", text: "Calendar sync failed." });
      }
    };
    await sabbathGuard(task, { allowReadOnly: true });
  };

  const handleShareMenuForecast = async () => {
    const task = async () => {
      try {
        await automation.request?.("sharing.family.menuForecast", {
          horizonDays: planHorizonDays,
          includeShopping: true,
          includePreservation: true,
        });
        setToast({
          tone: "success",
          text: "Menu forecast sent to family planners.",
        });
      } catch {
        setToast({ tone: "error", text: "Could not send menu forecast." });
      }
    };
    await sabbathGuard(task, { allowReadOnly: true });
  };

  const openMealPlanner = () =>
    automation.emit?.("ui.navigate", { to: "/tier2/household/meals" });

  const labelForScope = (scope) =>
    ({
      mealplan: "meal plan",
      shopping: "shopping list",
      labels: "labels",
      quality: "plan quality improvements",
      recs: "recipe scores",
      "pantry-nudge": "pantry-first nudge",
    }[scope] || scope);

  /* ------------------------------- Lifecycle ------------------------------ */
  useEffect(() => {
    meal.fetchSettings?.();
  }, []); // eslint-disable-line

  /* ---------------------------------- UI ---------------------------------- */
  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 lg:px-2 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Meal Planning Settings</h1>
          <p className="opacity-70">
            Tune plan horizon, rotation, pantry-first, cost/health goals,
            dietary alignment, and sync/sharing. Changes save optimistically
            with Undo.
          </p>
        </div>
        <div className="flex gap-2">
          <GhostButton onClick={() => handleGenerate("mealplan")}>
            Rebuild Meal Plan
          </GhostButton>
          <PrimaryButton onClick={() => openMealPlanner()}>
            Open Meal Planner
          </PrimaryButton>
        </div>
      </div>

      {/* Event-driven banners */}
      {banners.map((b) => (
        <InlineNotice key={b.key} tone={b.tone}>
          <div className="flex items-center justify-between w-full">
            <span>{b.text}</span>
            <div className="flex items-center gap-2">
              {b.actions?.map((a, i) => (
                <SubtleButton key={i} onClick={a.fn}>
                  {a.label}
                </SubtleButton>
              ))}
              {b.dismissible !== false && (
                <GhostButton onClick={() => dismissBanner(b.key)}>
                  Dismiss
                </GhostButton>
              )}
            </div>
          </div>
        </InlineNotice>
      ))}

      {/* Household & Cadence */}
      <SectionCard
        title="Household & Cadence"
        subtitle="Set servings, daily slots, planning horizon, batch days, and how leftovers are treated."
      >
        {loading ? (
          <Skeleton lines={4} />
        ) : (
          <>
            <Row label="Servings per Meal">
              <Input
                type="number"
                className="w-28"
                value={String(servings)}
                onChange={(v) =>
                  optimisticSave(
                    { servings: Math.max(1, parseInt(v || "1", 10)) },
                    "Servings"
                  )
                }
                placeholder="4"
                disabled={busy}
              />
              <Chip>{mealsPerDay} meals/day</Chip>
            </Row>

            <Row label="Meals per Day">
              <Select
                value={String(mealsPerDay)}
                onChange={(v) =>
                  optimisticSave(
                    { mealsPerDay: parseInt(v, 10) },
                    "Meals per day"
                  )
                }
                options={[
                  { value: "1", label: "1" },
                  { value: "2", label: "2" },
                  { value: "3", label: "3" },
                ]}
                disabled={busy}
              />
            </Row>

            <Row label="Plan Horizon" hint="How many days to plan ahead">
              <Select
                value={String(planHorizonDays)}
                onChange={(v) =>
                  optimisticSave(
                    { planHorizonDays: parseInt(v, 10) },
                    "Plan horizon"
                  )
                }
                options={[7, 10, 14, 21, 28].map((n) => ({
                  value: String(n),
                  label: `${n} days`,
                }))}
                disabled={busy}
              />
            </Row>

            <Row label="Batch Cooking Days" hint="Used by BatchSessionPlanner">
              <Input
                className="w-[28rem]"
                value={batchDays.join(", ")}
                onChange={(v) =>
                  optimisticSave(
                    {
                      batchDays: v
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    },
                    "Batch days"
                  )
                }
                placeholder="Sun, Wed"
                disabled={busy}
              />
              <SubtleButton
                onClick={() => handleGenerate("labels")}
                disabled={busy}
              >
                Rebuild Labels
              </SubtleButton>
            </Row>

            <Row
              label="Leftovers Policy"
              hint="How the planner should schedule and reuse leftovers"
            >
              <Select
                value={leftoversPolicy}
                onChange={(v) =>
                  optimisticSave({ leftoversPolicy: v }, "Leftovers policy")
                }
                options={[
                  { value: "none", label: "Don’t schedule leftovers" },
                  {
                    value: "next-day",
                    label: "Prefer next-day lunches/dinners",
                  },
                  { value: "flex", label: "Flexible reuse within 3 days" },
                ]}
                disabled={busy}
              />
              <RowSpacer />
              <Select
                value={String(rotationWindowWeeks)}
                onChange={(v) =>
                  optimisticSave(
                    { rotationWindowWeeks: parseInt(v, 10) },
                    "Rotation window"
                  )
                }
                options={[4, 6, 8, 10, 12].map((n) => ({
                  value: String(n),
                  label: `${n} week rotation`,
                }))}
                disabled={busy}
              />
            </Row>
          </>
        )}
      </SectionCard>

      {/* Preferences: Pantry, Seasonality, Cost & Health */}
      <SectionCard
        title="Preferences"
        subtitle="Pantry-first planning, seasonality, budget per serving, calories & protein targets, cuisine diversity, spice cap."
      >
        {loading ? (
          <Skeleton lines={5} />
        ) : (
          <>
            <Row
              label="Pantry-First Planning"
              hint="Prefer ingredients already in your pantry/inventory"
            >
              <Toggle
                checked={pantryFirst}
                onChange={(v) =>
                  optimisticSave({ pantryFirst: v }, "Pantry-first")
                }
                disabled={busy}
              />
              <SubtleButton
                onClick={() => handleGenerate("pantry-nudge")}
                disabled={busy}
              >
                Nudge Current Plan
              </SubtleButton>
            </Row>

            <Row
              label="Seasonality"
              hint="Prefer in-season produce; strict avoids out-of-season except pantry items"
            >
              <Select
                value={seasonality}
                onChange={(v) =>
                  optimisticSave({ seasonality: v }, "Seasonality")
                }
                options={[
                  { value: "off", label: "Off" },
                  { value: "in-season", label: "Prefer in-season" },
                  { value: "strict", label: "Strict seasonal" },
                ]}
                disabled={busy}
              />
            </Row>

            <Row
              label="Budget per Serving"
              hint="Used to cap plan & shopping substitutions"
            >
              <Input
                type="number"
                className="w-28"
                value={String(budgetPerServing)}
                onChange={(v) =>
                  optimisticSave(
                    { budgetPerServing: Math.max(0, parseFloat(v || "0")) },
                    "Budget per serving"
                  )
                }
                placeholder="3.50"
                disabled={busy}
              />
              <span className="opacity-60">USD</span>
            </Row>

            <Row
              label="Health Targets"
              hint="Daily targets used to balance plan (approximate)"
            >
              <Input
                type="number"
                className="w-28"
                value={String(calorieTargetPerDay)}
                onChange={(v) =>
                  optimisticSave(
                    {
                      calorieTargetPerDay: Math.max(
                        1200,
                        parseInt(v || "1200", 10)
                      ),
                    },
                    "Calories/day"
                  )
                }
                placeholder="2100"
                disabled={busy}
              />
              <span className="opacity-60">kcal/day</span>
              <Input
                type="number"
                className="w-28"
                value={String(proteinTargetPerDay)}
                onChange={(v) =>
                  optimisticSave(
                    {
                      proteinTargetPerDay: Math.max(
                        20,
                        parseInt(v || "20", 10)
                      ),
                    },
                    "Protein/day"
                  )
                }
                placeholder="90"
                disabled={busy}
              />
              <span className="opacity-60">g protein/day</span>
            </Row>

            <Row label="Spice Cap & Cuisine Diversity">
              <Select
                value={String(spiceCap)}
                onChange={(v) => optimisticSave({ spiceCap: v }, "Spice cap")}
                options={[
                  { value: "mild", label: "Mild" },
                  { value: "medium", label: "Medium" },
                  { value: "hot", label: "Hot" },
                ]}
                disabled={busy}
              />
              <Select
                value={cuisineDiversity}
                onChange={(v) =>
                  optimisticSave({ cuisineDiversity: v }, "Cuisine diversity")
                }
                options={[
                  { value: "homestyle", label: "Homestyle" },
                  { value: "balanced", label: "Balanced" },
                  { value: "world-tour", label: "World tour" },
                ]}
                disabled={busy}
              />
            </Row>
          </>
        )}
      </SectionCard>

      {/* Dietary Integration */}
      <SectionCard
        title="Dietary Integration"
        subtitle="Honor Torah rules, allergens, and avoids from Food settings (can be overridden here)."
      >
        {loading ? (
          <Skeleton lines={3} />
        ) : (
          <>
            <Row label="Respect Torah Mode">
              <Toggle
                checked={respectTorahMode}
                onChange={(v) =>
                  optimisticSave({ respectTorahMode: v }, "Respect Torah mode")
                }
                disabled={busy}
              />
              <SubtleButton
                onClick={() => handleGenerate("recs")}
                disabled={busy}
              >
                Re-score Recipes
              </SubtleButton>
            </Row>
            <Row label="Honor Allergens">
              <Toggle
                checked={honorAllergens}
                onChange={(v) =>
                  optimisticSave({ honorAllergens: v }, "Honor allergens")
                }
                disabled={busy}
              />
            </Row>
            <Row label="Honor Avoid List">
              <Toggle
                checked={honorAvoidList}
                onChange={(v) =>
                  optimisticSave({ honorAvoidList: v }, "Honor avoids")
                }
                disabled={busy}
              />
            </Row>
          </>
        )}
      </SectionCard>

      {/* Labels & Automation */}
      <SectionCard
        title="Labels & Automation"
        subtitle="Auto-generate prep/cleanup/storage labels and react to inventory changes."
      >
        {loading ? (
          <Skeleton lines={3} />
        ) : (
          <>
            <Row label="Auto-Generate Labels">
              <Toggle
                checked={autoLabeling}
                onChange={(v) =>
                  optimisticSave({ autoLabeling: v }, "Auto labeling")
                }
                disabled={busy}
              />
              <SubtleButton
                onClick={() => handleGenerate("labels")}
                disabled={busy}
              >
                Rebuild Now
              </SubtleButton>
            </Row>
            <Row
              label="Auto-Generate on Inventory Changes"
              hint="If pantry changes, nudge plan or rebuild shopping"
            >
              <Toggle
                checked={autoGenerateOnInventory}
                onChange={(v) =>
                  optimisticSave(
                    { autoGenerateOnInventory: v },
                    "Auto-generate on inventory"
                  )
                }
                disabled={busy}
              />
            </Row>
            <Row
              label="Plan Quality Guardrails"
              hint="Ensure variety and limit repeated dishes"
            >
              <Input
                type="number"
                className="w-28"
                value={String(minVariety)}
                onChange={(v) =>
                  optimisticSave(
                    { minVariety: Math.max(1, parseInt(v || "1", 10)) },
                    "Min variety"
                  )
                }
                placeholder="5"
                disabled={busy}
              />
              <span className="opacity-60">min. unique mains / window</span>
              <Input
                type="number"
                className="w-28"
                value={String(maxRepeat)}
                onChange={(v) =>
                  optimisticSave(
                    { maxRepeat: Math.max(0, parseInt(v || "0", 10)) },
                    "Max repeat"
                  )
                }
                placeholder="1"
                disabled={busy}
              />
              <span className="opacity-60">max repeats / dish</span>
              <Input
                type="number"
                className="w-28"
                value={String(prepTimeBudgetMins)}
                onChange={(v) =>
                  optimisticSave(
                    {
                      prepTimeBudgetMins: Math.max(10, parseInt(v || "10", 10)),
                    },
                    "Prep time budget"
                  )
                }
                placeholder="45"
                disabled={busy}
              />
              <span className="opacity-60">mins avg prep</span>
              <SubtleButton
                onClick={() => handleGenerate("quality")}
                disabled={busy}
              >
                Improve Plan Quality
              </SubtleButton>
            </Row>
          </>
        )}
      </SectionCard>

      {/* Calendar & Sharing */}
      <SectionCard
        title="Calendar & Sharing"
        subtitle="Sync the plan to your calendar and share a family-view forecast."
      >
        {loading ? (
          <Skeleton lines={3} />
        ) : (
          <>
            <Row
              label="Sync Meals to Calendar"
              hint="Create/refresh events for your plan (respects Sabbath guard)"
            >
              <Toggle
                checked={syncMealsToCalendar}
                onChange={(v) =>
                  optimisticSave({ syncMealsToCalendar: v }, "Calendar sync")
                }
                disabled={busy}
              />
              <SubtleButton onClick={() => handleSync("meals")} disabled={busy}>
                Sync now
              </SubtleButton>
            </Row>
            <Row
              label="Sabbath Guard"
              hint="Avoid creating/editing events during Sabbath; read-only allowed"
            >
              <Toggle
                checked={sabbathBlock}
                onChange={(v) =>
                  optimisticSave({ sabbathBlock: v }, "Sabbath guard")
                }
                disabled={busy}
              />
            </Row>
            <Row
              label="Share Menu Forecast"
              hint={`Send ${planHorizonDays}-day menus, shopping deltas, and preservation cues`}
            >
              <Toggle
                checked={shareForecast}
                onChange={(v) =>
                  optimisticSave({ shareForecast: v }, "Share forecast")
                }
                disabled={busy}
              />
              <SubtleButton onClick={handleShareMenuForecast} disabled={busy}>
                Send now
              </SubtleButton>
            </Row>
          </>
        )}
      </SectionCard>

      {/* Recommended Next Steps */}
      <SectionCard
        title="Recommended Next Steps"
        subtitle="Keep momentum with one clear action."
      >
        <div className="flex flex-wrap gap-2">
          <PrimaryButton
            onClick={() => handleGenerate("mealplan")}
            disabled={busy}
          >
            Rebuild Meal Plan
          </PrimaryButton>
          <SubtleButton
            onClick={() => handleGenerate("shopping")}
            disabled={busy}
          >
            Refresh Shopping List
          </SubtleButton>
          <SubtleButton
            onClick={() => handleGenerate("labels")}
            disabled={busy}
          >
            Rebuild Labels
          </SubtleButton>
          <SubtleButton
            onClick={() => handleGenerate("quality")}
            disabled={busy}
          >
            Improve Plan Quality
          </SubtleButton>
          <SubtleButton onClick={() => handleGenerate("recs")} disabled={busy}>
            Re-score Recipes
          </SubtleButton>
          <SubtleButton onClick={() => handleSync("meals")} disabled={busy}>
            Sync to Calendar
          </SubtleButton>
        </div>
      </SectionCard>

      {/* Toast */}
      {toast && (
        <div className="toast toast-end z-50">
          <div
            className={classNames(
              "alert",
              toast.tone === "success"
                ? "alert-success"
                : toast.tone === "warning"
                ? "alert-warning"
                : toast.tone === "error"
                ? "alert-error"
                : "alert-info"
            )}
          >
            <div className="flex items-center gap-3">
              <span>{toast.text}</span>
              {toast.action ? (
                <button
                  className="btn btn-xs"
                  onClick={() => toast.action.fn?.()}
                >
                  {toast.action.label}
                </button>
              ) : null}
              <button
                className="btn btn-ghost btn-xs"
                onClick={() => setToast(null)}
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------- Helpers -------------------------------- */
function RowSpacer() {
  return <span className="hidden md:inline-block w-4" />;
}

/* -------------------------------------------------------------------------- */
/* Notes for integrators                                                      */
/*
Optional MealPlanningStore shape (graceful fallback if missing):

  useMealPlanningStore(): {
    loading?: boolean

    // cadence & rotation
    servings?: number
    mealsPerDay?: 1|2|3
    planHorizonDays?: number
    batchDays?: string[]
    leftoversPolicy?: "none"|"next-day"|"flex"
    rotationWindowWeeks?: number

    // prefs / cost / health
    pantryFirst?: boolean
    seasonality?: "off"|"in-season"|"strict"
    budgetPerServing?: number
    calorieTargetPerDay?: number
    proteinTargetPerDay?: number
    spiceCap?: "mild"|"medium"|"hot"
    cuisineDiversity?: "homestyle"|"balanced"|"world-tour"

    // dietary integration
    respectTorahMode?: boolean
    honorAllergens?: boolean
    honorAvoidList?: boolean

    // automation
    autoLabeling?: boolean
    autoGenerateOnInventory?: boolean

    // calendar & sharing
    syncMealsToCalendar?: boolean
    sabbathBlock?: boolean
    shareForecast?: boolean

    // plan quality
    minVariety?: number
    maxRepeat?: number
    prepTimeBudgetMins?: number

    // methods:
    fetchSettings?: () => Promise<void>
    saveSettings?: (settings) => Promise<void>
    generate?: (scope:"mealplan"|"shopping"|"labels"|"quality"|"recs"|"pantry-nudge") => Promise<void>
    syncNow?: (scope:"meals") => Promise<void>
  }

Automation fallbacks used if store fns absent:
  automation.request("mealplan.saveSettings", payload)
  automation.request("mealplan.generate", { scope })
  automation.request("calendar.sync", { scope: "meals" })
  automation.request("sharing.family.menuForecast", { horizonDays, includeShopping, includePreservation })
  automation.on("event", handler)
  automation.emit("ui.navigate", { to:"/tier2/household/meals" })
  automation.emit("calendar.synced", { scope:"meals" })

Event glue listens to:
  recipe.consolidated -> improve plan quality, rebuild labels
  inventory.updated   -> refresh shopping and pantry-first nudge
  calendar.synced     -> success banner
  preferences.changed -> info toast
  torah.profile.updated -> banner to rebuild meal plan

Undo pattern:
  Optimistic saves push a revert callback; toast includes Undo.

Design system:
  Tailwind + DaisyUI; consistent atoms with other Settings views.
*/
