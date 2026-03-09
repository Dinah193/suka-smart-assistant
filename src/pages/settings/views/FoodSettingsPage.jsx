// src/pages/settings/views/FoodSettingsPage.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { automation, emitProgress } from "@/services/automation/runtime";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard";
import { usePreferencesStore } from "@/store/PreferencesStore"; // optional
import { useFoodStore } from "@/store/FoodStore"; // optional (see Notes)
import { classNames } from "@/utils/css";

/* ----------------------------------------------------------------------------
   UI atoms (consistent with your Settings pages)
---------------------------------------------------------------------------- */
const SectionCard = ({ title, subtitle, right, children, tag }) => (
  <div className="rounded-2xl shadow-md border border-base-200 bg-base-100">
    <div className="flex items-start justify-between p-5 border-b border-base-200">
      <div className="flex items-center gap-3">
        <h3 className="text-lg font-semibold">{title}</h3>
        {tag ? <Chip>{tag}</Chip> : null}
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
    <div className="flex items-center gap-3">{children}</div>
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
  className = "w-80",
  type = "text",
  min,
  max,
  step,
}) => (
  <input
    type={type}
    className={classNames("input input-bordered", className)}
    value={value ?? ""}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    disabled={disabled}
    min={min}
    max={max}
    step={step}
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

/* ----------------------------------------------------------------------------
   Micro components for Nutrition Goals
---------------------------------------------------------------------------- */
const PercentSlider = ({ label, value, onChange, disabled }) => (
  <div className="w-full">
    <div className="flex items-center justify-between">
      <span className="text-sm">{label}</span>
      <span className="text-sm font-semibold">{value}%</span>
    </div>
    <input
      type="range"
      min="0"
      max="100"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(Number(e.target.value))}
      className="range range-primary"
    />
  </div>
);

/* ----------------------------------------------------------------------------
   Undo stack (optimistic updates with revert)
---------------------------------------------------------------------------- */
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

/* ----------------------------------------------------------------------------
   Event-driven glue
---------------------------------------------------------------------------- */
const EVENT_KEYS = [
  "recipe.consolidated", // re-score meal plan, labels, prep/cleanup
  "inventory.updated", // substitutions, shortages, shopping deltas
  "calendar.synced", // surface success
  "preferences.changed", // kitchen hours, units, UI prefs
  "torah.profile.updated", // dietary rule changes cascade to meals/labels
  "nutrition.goals.updated", // recompute macros & labels
  "scanner.config.updated", // refresh capture pipelines
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

/* ----------------------------------------------------------------------------
   Editable Pills (Allergens & Avoid List)
---------------------------------------------------------------------------- */
function PillsEditor({
  items = [],
  placeholder = "Type and press Enter",
  onChange,
  disabled,
}) {
  const [draft, setDraft] = useState("");
  const add = (val) => {
    const v = (val || "").trim();
    if (!v) return;
    const next = Array.from(new Set([...(items || []), v]));
    onChange?.(next);
    setDraft("");
  };
  const remove = (val) => {
    onChange?.((items || []).filter((x) => x !== val));
  };
  return (
    <div className="w-full">
      <div className="flex flex-wrap gap-2 mb-2">
        {(items || []).map((it) => (
          <div
            key={it}
            className="flex items-center gap-1 bg-base-200 rounded-full pl-2 pr-1 py-1"
          >
            <span className="text-xs">{it}</span>
            <button
              className="btn btn-ghost btn-xs"
              onClick={() => remove(it)}
              disabled={disabled}
              aria-label={`Remove ${it}`}
            >
              ✕
            </button>
          </div>
        ))}
        {(!items || items.length === 0) && (
          <div className="rounded-xl border border-dashed border-base-300 p-3 text-sm opacity-70">
            No items yet — add your first below.
          </div>
        )}
      </div>
      <Input
        className="w-full"
        value={draft}
        onChange={setDraft}
        placeholder={placeholder}
        disabled={disabled}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(draft);
          }
        }}
      />
      <div className="mt-2">
        <SubtleButton
          onClick={() => add(draft)}
          disabled={disabled || !draft.trim()}
        >
          Add
        </SubtleButton>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Helpers — USDA default nutrition presets
---------------------------------------------------------------------------- */
const USDA_PRESETS = [
  {
    key: "weightLoss",
    label: "USDA-based: Weight Loss",
    calories: 1800,
    macros: { carbs: 40, protein: 30, fat: 30 },
  },
  {
    key: "maintenance",
    label: "USDA-based: Maintenance",
    calories: 2200,
    macros: { carbs: 50, protein: 20, fat: 30 },
  },
  {
    key: "muscleGain",
    label: "USDA-based: Muscle Gain",
    calories: 2600,
    macros: { carbs: 45, protein: 30, fat: 25 },
  },
  { key: "custom", label: "Custom", calories: null, macros: null },
];

function clamp100(n) {
  if (Number.isNaN(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

/* ----------------------------------------------------------------------------
   Main Page
---------------------------------------------------------------------------- */
export default function FoodSettingsPage() {
  const prefs = usePreferencesStore?.() ?? {};
  const food = useFoodStore?.() ?? {};

  const loading = food.loading || false;
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [banners, setBanners] = useState([]);
  const undo = useUndoStack();

  /* ------------------------------- State --------------------------------- */
  // Dietary rules (Torah-aligned primary; configurable shellfish option)
  const [torahMode, setTorahMode] = useState(food.torahMode ?? true);
  const [allowShellfish, setAllowShellfish] = useState(
    food.allowShellfish ?? false
  );
  const [porkAllowed, setPorkAllowed] = useState(food.porkAllowed ?? false);
  const [mixDairyMeat, setMixDairyMeat] = useState(food.mixDairyMeat ?? true);

  // Allergens / Avoids
  const [allergens, setAllergens] = useState(food.allergens || []);
  const [avoidList, setAvoidList] = useState(food.avoidList || []);

  // Preferences (doneness, tenderness, spice, textures, cuisines)
  const [doneness, setDoneness] = useState(food.doneness ?? "medium"); // rare|med-rare|medium|med-well|well
  const [tenderness, setTenderness] = useState(food.tenderness ?? "normal"); // soft|normal|al-dente|crisp
  const [spice, setSpice] = useState(food.spice ?? "medium"); // mild|medium|hot
  const [textures, setTextures] = useState(food.textures || ["balanced"]); // e.g., crunchy, creamy, chewy
  const [cuisines, setCuisines] = useState(
    food.cuisines || ["American", "Mediterranean"]
  );

  // Meal planning defaults
  const [servings, setServings] = useState(food.servings ?? 4);
  const [mealsPerDay, setMealsPerDay] = useState(food.mealsPerDay ?? 2);
  const [batchDays, setBatchDays] = useState(food.batchDays || ["Sun"]); // ["Sun","Wed"]
  const [autoLabeling, setAutoLabeling] = useState(food.autoLabeling ?? true); // auto-generate prep/clean labels

  // Calendar & background
  const [syncMealsToCalendar, setSyncMealsToCalendar] = useState(
    food.syncMealsToCalendar ?? true
  );
  const [sabbathBlock, setSabbathBlock] = useState(food.sabbathBlock ?? true);

  // Nutrition goals (USDA default + custom macros & calories)
  const [nutritionPreset, setNutritionPreset] = useState(
    food.nutritionPreset ?? "maintenance"
  );
  const [dailyCalories, setDailyCalories] = useState(
    food.dailyCalories ?? 2200
  );
  const [macroCarb, setMacroCarb] = useState(food.macroCarb ?? 50);
  const [macroProtein, setMacroProtein] = useState(food.macroProtein ?? 20);
  const [macroFat, setMacroFat] = useState(food.macroFat ?? 30);

  // Units & capture/scanning
  const [unitSystem, setUnitSystem] = useState(food.unitSystem ?? "US"); // US | Metric
  const [enableBarcodeScan, setEnableBarcodeScan] = useState(
    food.enableBarcodeScan ?? true
  );
  const [enableReceiptOCR, setEnableReceiptOCR] = useState(
    food.enableReceiptOCR ?? false
  );

  // Modes & presentation
  const [enableFusionMode, setEnableFusionMode] = useState(
    food.enableFusionMode ?? true
  );
  const [fusionPair, setFusionPair] = useState(
    food.fusionPair || "Indian ⇄ German"
  );
  const [streetFoodMode, setStreetFoodMode] = useState(
    food.streetFoodMode ?? false
  );
  const [foodTruckMode, setFoodTruckMode] = useState(
    food.foodTruckMode ?? false
  );

  /* -------------------------- Derived helpers ---------------------------- */
  const macroSum = macroCarb + macroProtein + macroFat;
  const macroBalanced = useMemo(
    () =>
      clamp100(macroCarb) + clamp100(macroProtein) + clamp100(macroFat) === 100,
    [macroCarb, macroProtein, macroFat]
  );

  // keep sliders summed to 100 by adjusting the "last touched" neighbor
  const rebalanceMacros = (which, nextVal) => {
    const c = which === "carb" ? clamp100(nextVal) : clamp100(macroCarb);
    const p = which === "protein" ? clamp100(nextVal) : clamp100(macroProtein);
    let f = which === "fat" ? clamp100(nextVal) : clamp100(macroFat);
    const sum = c + p + f;
    if (sum === 100) return { carbs: c, protein: p, fat: f };

    // Adjust the macro not just changed, preferring fat as the buffer, then carbs.
    const delta = sum - 100;
    if (which !== "fat") {
      f = clamp100(f - delta);
    } else if (which !== "carb") {
      // changed fat, adjust carbs
      const newC = clamp100(c - delta);
      return { carbs: newC, protein: p, fat: f };
    } else {
      // changed carb, adjust protein
      const newP = clamp100(p - delta);
      return { carbs: c, protein: newP, fat: f };
    }

    return { carbs: c, protein: p, fat: f };
  };

  /* -------------------------- Event-driven glue -------------------------- */
  useAutomationGlue((event, payload) => {
    if (event === "recipe.consolidated") {
      addBanner({
        key: "recompute-meals",
        tone: "info",
        text: "Recipes consolidated. Re-compute your meal plan & labels.",
        actions: [
          { label: "Rebuild Meal Plan", fn: () => handleGenerate("mealplan") },
          { label: "Rebuild Labels", fn: () => handleGenerate("labels") },
        ],
      });
    }
    if (event === "inventory.updated") {
      addBanner({
        key: "refresh-shopping",
        tone: "warning",
        text: "Inventory changed. Refresh shopping list & preservation queues.",
        actions: [
          { label: "Refresh Shopping", fn: () => handleGenerate("shopping") },
          {
            label: "Recompute Preservation",
            fn: () => handleGenerate("preservation"),
          },
        ],
      });
    }
    if (event === "calendar.synced") {
      addBanner({
        key: "cal-synced",
        tone: "success",
        text: "Calendar sync complete.",
        dismissible: true,
      });
    }
    if (event === "preferences.changed") {
      setToast({
        tone: "info",
        text: "Preferences updated. Kitchen flows will reflect your new defaults.",
      });
    }
    if (event === "torah.profile.updated") {
      addBanner({
        key: "torah-updated",
        tone: "info",
        text: "Dietary profile changed. Consider rebuilding meal suggestions.",
        actions: [
          { label: "Rebuild Meal Plan", fn: () => handleGenerate("mealplan") },
        ],
      });
    }
    if (event === "nutrition.goals.updated") {
      addBanner({
        key: "macros-updated",
        tone: "info",
        text: "Nutrition goals changed. Rebuild labels to reflect macro targets.",
        actions: [
          { label: "Rebuild Labels", fn: () => handleGenerate("labels") },
        ],
      });
    }
    if (event === "scanner.config.updated") {
      setToast({ tone: "success", text: "Scanner configuration updated." });
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

  /* ----------------------------- Persistence ----------------------------- */
  const optimisticSave = async (partial, descr = "Settings") => {
    const prev = {
      // rules
      torahMode,
      allowShellfish,
      porkAllowed,
      mixDairyMeat,
      // lists
      allergens,
      avoidList,
      // prefs
      doneness,
      tenderness,
      spice,
      textures,
      cuisines,
      // planning
      servings,
      mealsPerDay,
      batchDays,
      autoLabeling,
      // calendar
      syncMealsToCalendar,
      sabbathBlock,
      // nutrition
      nutritionPreset,
      dailyCalories,
      macroCarb,
      macroProtein,
      macroFat,
      // units & scanning
      unitSystem,
      enableBarcodeScan,
      enableReceiptOCR,
      // modes
      enableFusionMode,
      fusionPair,
      streetFoodMode,
      foodTruckMode,
    };

    // apply optimistic
    Object.entries(partial).forEach(([k, v]) => {
      switch (k) {
        case "torahMode":
          setTorahMode(v);
          break;
        case "allowShellfish":
          setAllowShellfish(v);
          break;
        case "porkAllowed":
          setPorkAllowed(v);
          break;
        case "mixDairyMeat":
          setMixDairyMeat(v);
          break;

        case "allergens":
          setAllergens(v);
          break;
        case "avoidList":
          setAvoidList(v);
          break;

        case "doneness":
          setDoneness(v);
          break;
        case "tenderness":
          setTenderness(v);
          break;
        case "spice":
          setSpice(v);
          break;
        case "textures":
          setTextures(v);
          break;
        case "cuisines":
          setCuisines(v);
          break;

        case "servings":
          setServings(v);
          break;
        case "mealsPerDay":
          setMealsPerDay(v);
          break;
        case "batchDays":
          setBatchDays(v);
          break;
        case "autoLabeling":
          setAutoLabeling(v);
          break;

        case "syncMealsToCalendar":
          setSyncMealsToCalendar(v);
          break;
        case "sabbathBlock":
          setSabbathBlock(v);
          break;

        case "nutritionPreset":
          setNutritionPreset(v);
          break;
        case "dailyCalories":
          setDailyCalories(v);
          break;
        case "macroCarb":
          setMacroCarb(v);
          break;
        case "macroProtein":
          setMacroProtein(v);
          break;
        case "macroFat":
          setMacroFat(v);
          break;

        case "unitSystem":
          setUnitSystem(v);
          break;
        case "enableBarcodeScan":
          setEnableBarcodeScan(v);
          break;
        case "enableReceiptOCR":
          setEnableReceiptOCR(v);
          break;

        case "enableFusionMode":
          setEnableFusionMode(v);
          break;
        case "fusionPair":
          setFusionPair(v);
          break;
        case "streetFoodMode":
          setStreetFoodMode(v);
          break;
        case "foodTruckMode":
          setFoodTruckMode(v);
          break;
        default:
          break;
      }
    });

    const { undo: revert } = undo.push(() => {
      setTorahMode(prev.torahMode);
      setAllowShellfish(prev.allowShellfish);
      setPorkAllowed(prev.porkAllowed);
      setMixDairyMeat(prev.mixDairyMeat);

      setAllergens(prev.allergens);
      setAvoidList(prev.avoidList);

      setDoneness(prev.doneness);
      setTenderness(prev.tenderness);
      setSpice(prev.spice);
      setTextures(prev.textures);
      setCuisines(prev.cuisines);

      setServings(prev.servings);
      setMealsPerDay(prev.mealsPerDay);
      setBatchDays(prev.batchDays);
      setAutoLabeling(prev.autoLabeling);

      setSyncMealsToCalendar(prev.syncMealsToCalendar);
      setSabbathBlock(prev.sabbathBlock);

      setNutritionPreset(prev.nutritionPreset);
      setDailyCalories(prev.dailyCalories);
      setMacroCarb(prev.macroCarb);
      setMacroProtein(prev.macroProtein);
      setMacroFat(prev.macroFat);

      setUnitSystem(prev.unitSystem);
      setEnableBarcodeScan(prev.enableBarcodeScan);
      setEnableReceiptOCR(prev.enableReceiptOCR);

      setEnableFusionMode(prev.enableFusionMode);
      setFusionPair(prev.fusionPair);
      setStreetFoodMode(prev.streetFoodMode);
      setFoodTruckMode(prev.foodTruckMode);
    }, descr);

    setBusy(true);
    try {
      if (food.saveSettings) {
        await food.saveSettings({ ...prev, ...partial });
      } else {
        await automation.request?.("food.saveSettings", {
          ...prev,
          ...partial,
        });
      }

      setToast({
        tone: "success",
        text: `${descr} saved`,
        action: { label: "Undo", fn: () => revert() },
      });

      // Emit NBA suggestion
      emitProgress?.("settings.saved", {
        scope: "food",
        nextBestAction: suggestNBA(partial),
      });

      // Emit dietary profile update if relevant
      if (
        "torahMode" in partial ||
        "allowShellfish" in partial ||
        "porkAllowed" in partial ||
        "mixDairyMeat" in partial
      ) {
        automation.emit?.("torah.profile.updated", {
          allowShellfish: allowShellfish,
          effectiveDate: new Date().toISOString(),
        });
      }

      // Emit nutrition profile update
      if (
        "nutritionPreset" in partial ||
        "dailyCalories" in partial ||
        "macroCarb" in partial ||
        "macroProtein" in partial ||
        "macroFat" in partial
      ) {
        automation.emit?.("nutrition.goals.updated", {
          calories: dailyCalories,
          macros: { carbs: macroCarb, protein: macroProtein, fat: macroFat },
          effectiveDate: new Date().toISOString(),
        });
      }

      // Emit scanner config update
      if ("enableBarcodeScan" in partial || "enableReceiptOCR" in partial) {
        automation.emit?.("scanner.config.updated", {
          barcode: enableBarcodeScan,
          ocr: enableReceiptOCR,
        });
      }
    } catch (e) {
      revert();
      setToast({ tone: "error", text: `Failed to save ${descr}.` });
    } finally {
      setBusy(false);
    }
  };

  const suggestNBA = (partial) => {
    if (
      "doneness" in partial ||
      "tenderness" in partial ||
      "spice" in partial ||
      "cuisines" in partial
    ) {
      return {
        label: "Rebuild Meal Plan",
        action: () => handleGenerate("mealplan"),
      };
    }
    if ("allergens" in partial || "avoidList" in partial) {
      return {
        label: "Refresh Shopping List",
        action: () => handleGenerate("shopping"),
      };
    }
    if ("autoLabeling" in partial) {
      return {
        label: "Rebuild Labels",
        action: () => handleGenerate("labels"),
      };
    }
    if ("syncMealsToCalendar" in partial) {
      return {
        label: "Sync Meals to Calendar",
        action: () => handleSync("meals"),
      };
    }
    if (
      "torahMode" in partial ||
      "allowShellfish" in partial ||
      "porkAllowed" in partial ||
      "mixDairyMeat" in partial
    ) {
      return {
        label: "Re-score Recipes",
        action: () => handleGenerate("recs"),
      };
    }
    if (
      "nutritionPreset" in partial ||
      "dailyCalories" in partial ||
      "macroCarb" in partial ||
      "macroProtein" in partial ||
      "macroFat" in partial
    ) {
      return {
        label: "Rebuild Labels",
        action: () => handleGenerate("labels"),
      };
    }
    if ("enableFusionMode" in partial || "fusionPair" in partial) {
      return {
        label: "Open Recipe Vault",
        action: () =>
          automation.emit?.("ui.navigate", {
            to: "/tier2/household/meals/recipes",
          }),
      };
    }
    return { label: "Open Meal Planner", action: () => openMealPlanner() };
  };

  /* -------------------------------- Actions ------------------------------- */
  const handleGenerate = async (scope) => {
    const task = async () => {
      setBusy(true);
      try {
        if (food.generate) {
          await food.generate(scope);
        } else {
          await automation.request?.("food.generate", { scope });
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
    // Writing tasks restricted on Sabbath unless allowed
    await sabbathGuard(task, { allowReadOnly: false });
  };

  const handleSync = async (scope = "meals") => {
    const task = async () => {
      try {
        if (food.syncNow) {
          await food.syncNow(scope);
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
          horizonDays: 14,
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
      labels: "labels",
      shopping: "shopping list",
      preservation: "preservation queues",
      recs: "recipe scores",
    }[scope] || scope);

  /* ------------------------------- Lifecycle ------------------------------ */
  useEffect(() => {
    food.fetchSettings?.();
  }, []); // eslint-disable-line

  /* ---------------------------------- UI ---------------------------------- */
  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 lg:px-2 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Food Settings</h1>
          <p className="opacity-70">
            Set dietary rules, preferences, allergens, nutrition goals, and
            meal-planning defaults. Changes save optimistically with Undo.
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

      {/* Dietary Rules */}
      <SectionCard
        title="Dietary Rules"
        subtitle="Your system prioritizes Torah-aligned rules; options are configurable per household."
      >
        {loading ? (
          <Skeleton lines={4} />
        ) : (
          <>
            <Row
              label="Torah Mode (Primary)"
              hint="Enable Torah-aligned filtering as the primary rule set for suggestions, labels, and plans."
            >
              <Toggle
                checked={torahMode}
                onChange={(v) => optimisticSave({ torahMode: v }, "Torah mode")}
                disabled={busy}
              />
            </Row>
            <Row
              label="Shellfish"
              hint="Household choice — if enabled, recipes including shellfish can be suggested and planned."
            >
              <Toggle
                checked={allowShellfish}
                onChange={(v) =>
                  optimisticSave({ allowShellfish: v }, "Shellfish preference")
                }
                disabled={busy}
              />
            </Row>
            <Row
              label="Pork"
              hint="Household choice — allow or exclude pork from suggestions."
            >
              <Toggle
                checked={porkAllowed}
                onChange={(v) =>
                  optimisticSave({ porkAllowed: v }, "Pork preference")
                }
                disabled={busy}
              />
            </Row>
            <Row
              label="Mix Dairy & Meat"
              hint="Household choice — if disabled, recipes mixing dairy & meat will be avoided."
            >
              <Toggle
                checked={mixDairyMeat}
                onChange={(v) =>
                  optimisticSave({ mixDairyMeat: v }, "Dairy/Meat mixing")
                }
                disabled={busy}
              />
            </Row>
            <Divider />
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                onClick={() => handleGenerate("recs")}
                disabled={busy}
              >
                Re-score Recipes
              </PrimaryButton>
              <SubtleButton
                onClick={() => handleGenerate("labels")}
                disabled={busy}
              >
                Rebuild Labels
              </SubtleButton>
            </div>
          </>
        )}
      </SectionCard>

      {/* Allergens & Avoid List */}
      <SectionCard
        title="Allergens & Avoid List"
        subtitle="We’ll filter suggestions and call out risks on labels and shopping lists."
      >
        {loading ? (
          <Skeleton lines={3} />
        ) : (
          <>
            <Row
              label="Allergens"
              hint="Examples: peanut, dairy, gluten, sesame"
            >
              <div className="w-[42rem]">
                <PillsEditor
                  items={allergens}
                  onChange={(v) =>
                    optimisticSave({ allergens: v }, "Allergens")
                  }
                  disabled={busy}
                  placeholder="Type an allergen and press Enter"
                />
              </div>
            </Row>
            <Row
              label="Avoid List"
              hint="Disliked or seasonal avoids (e.g., okra, cilantro, fried foods)"
            >
              <div className="w-[42rem]">
                <PillsEditor
                  items={avoidList}
                  onChange={(v) =>
                    optimisticSave({ avoidList: v }, "Avoid list")
                  }
                  disabled={busy}
                  placeholder="Type an item and press Enter"
                />
              </div>
            </Row>

            {(!allergens || allergens.length === 0) &&
              (!avoidList || avoidList.length === 0) && (
                <div className="rounded-xl border border-dashed border-base-300 p-6 grid place-items-center text-center">
                  <p className="font-medium">No allergens or avoids set</p>
                  <p className="text-sm opacity-70 mt-1">
                    Add items to improve safety and satisfaction in meal
                    suggestions and batch sessions.
                  </p>
                </div>
              )}
          </>
        )}
      </SectionCard>

      {/* Taste & Texture Preferences */}
      <SectionCard
        title="Taste & Texture Preferences"
        subtitle="Fine-tune doneness, tenderness, spice, textures, and cuisines for better suggestions."
      >
        {loading ? (
          <Skeleton lines={4} />
        ) : (
          <>
            <Row
              label="Doneness"
              hint="Used for meats, grains, and bake profiles"
            >
              <Select
                value={doneness}
                onChange={(v) => optimisticSave({ doneness: v }, "Doneness")}
                options={[
                  { value: "rare", label: "Rare" },
                  { value: "med-rare", label: "Medium-Rare" },
                  { value: "medium", label: "Medium" },
                  { value: "med-well", label: "Medium-Well" },
                  { value: "well", label: "Well Done" },
                ]}
                disabled={busy}
              />
            </Row>
            <Row label="Tenderness" hint="Soft vs. crisp/chewy preferences">
              <Select
                value={tenderness}
                onChange={(v) =>
                  optimisticSave({ tenderness: v }, "Tenderness")
                }
                options={[
                  { value: "soft", label: "Soft" },
                  { value: "normal", label: "Normal" },
                  { value: "al-dente", label: "Al Dente" },
                  { value: "crisp", label: "Crisp" },
                ]}
                disabled={busy}
              />
            </Row>
            <Row label="Spice Level" hint="Used to cap heat in suggestions">
              <Select
                value={spice}
                onChange={(v) => optimisticSave({ spice: v }, "Spice level")}
                options={[
                  { value: "mild", label: "Mild" },
                  { value: "medium", label: "Medium" },
                  { value: "hot", label: "Hot" },
                ]}
                disabled={busy}
              />
            </Row>
            <Row label="Textures" hint="e.g., crunchy, creamy, chewy, brothy">
              <Input
                className="w-[32rem]"
                value={textures.join(", ")}
                onChange={(v) =>
                  optimisticSave(
                    {
                      textures: v
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    },
                    "Textures"
                  )
                }
                placeholder="comma-separated (e.g., crunchy, creamy)"
                disabled={busy}
              />
            </Row>
            <Row
              label="Preferred Cuisines"
              hint="Affects meal variety & rotation"
            >
              <Input
                className="w-[32rem]"
                value={cuisines.join(", ")}
                onChange={(v) =>
                  optimisticSave(
                    {
                      cuisines: v
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean),
                    },
                    "Cuisines"
                  )
                }
                placeholder="comma-separated (e.g., Mediterranean, West African, American)"
                disabled={busy}
              />
            </Row>
            <Divider />
            <div className="flex flex-wrap gap-2">
              <PrimaryButton
                onClick={() => handleGenerate("mealplan")}
                disabled={busy}
              >
                Rebuild Meal Plan
              </PrimaryButton>
              <SubtleButton
                onClick={() =>
                  automation.emit?.("ui.navigate", {
                    to: "/tier2/household/meals/recipes",
                  })
                }
              >
                Open Recipe Vault
              </SubtleButton>
            </div>
          </>
        )}
      </SectionCard>

      {/* Nutrition Goals (USDA default + custom macros) */}
      <SectionCard
        title="Nutrition Goals"
        subtitle="USDA-based presets by default, or dial in custom calories and macro percentages."
        tag={nutritionPreset === "custom" ? "custom" : "auto"}
      >
        {loading ? (
          <Skeleton lines={4} />
        ) : (
          <>
            <Row label="Preset" hint="Choose a baseline and tweak as needed">
              <Select
                value={nutritionPreset}
                onChange={(key) => {
                  const preset =
                    USDA_PRESETS.find((p) => p.key === key) || USDA_PRESETS[1];
                  const payload = { nutritionPreset: key };
                  if (preset.calories != null)
                    payload.dailyCalories = preset.calories;
                  if (preset.macros != null) {
                    payload.macroCarb = preset.macros.carbs;
                    payload.macroProtein = preset.macros.protein;
                    payload.macroFat = preset.macros.fat;
                  }
                  optimisticSave(payload, "Nutrition preset");
                }}
                options={USDA_PRESETS.map((p) => ({
                  value: p.key,
                  label: p.label,
                }))}
                disabled={busy}
              />
            </Row>
            <Row
              label="Daily Calories"
              hint="Used to compute per-meal macro targets"
            >
              <Input
                type="number"
                className="w-36"
                value={String(dailyCalories ?? "")}
                onChange={(v) =>
                  optimisticSave(
                    {
                      dailyCalories: Math.max(
                        1000,
                        parseInt(v || "0", 10) || 0
                      ),
                    },
                    "Daily calories"
                  )
                }
                placeholder="2200"
                min={1000}
                step={50}
                disabled={busy}
              />
            </Row>
            <Divider />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <PercentSlider
                label="Carbs %"
                value={macroCarb}
                disabled={busy}
                onChange={(val) => {
                  const next = rebalanceMacros("carb", val);
                  optimisticSave(
                    {
                      macroCarb: next.carbs,
                      macroProtein: next.protein,
                      macroFat: next.fat,
                      nutritionPreset: "custom",
                    },
                    "Macro balance"
                  );
                }}
              />
              <PercentSlider
                label="Protein %"
                value={macroProtein}
                disabled={busy}
                onChange={(val) => {
                  const next = rebalanceMacros("protein", val);
                  optimisticSave(
                    {
                      macroCarb: next.carbs,
                      macroProtein: next.protein,
                      macroFat: next.fat,
                      nutritionPreset: "custom",
                    },
                    "Macro balance"
                  );
                }}
              />
              <PercentSlider
                label="Fat %"
                value={macroFat}
                disabled={busy}
                onChange={(val) => {
                  const next = rebalanceMacros("fat", val);
                  optimisticSave(
                    {
                      macroCarb: next.carbs,
                      macroProtein: next.protein,
                      macroFat: next.fat,
                      nutritionPreset: "custom",
                    },
                    "Macro balance"
                  );
                }}
              />
            </div>
            <div className="mt-2 text-sm opacity-70">
              Sum:{" "}
              <span
                className={
                  macroBalanced
                    ? "text-success font-semibold"
                    : "text-error font-semibold"
                }
              >
                {macroSum}%
              </span>{" "}
              (must be 100%)
            </div>
            <Divider />
            <div className="flex flex-wrap gap-2">
              <SubtleButton
                onClick={() => handleGenerate("labels")}
                disabled={busy}
              >
                Rebuild Labels (apply macros)
              </SubtleButton>
              <SubtleButton
                onClick={() => handleGenerate("mealplan")}
                disabled={busy}
              >
                Rebuild Meal Plan (fit calories)
              </SubtleButton>
            </div>
          </>
        )}
      </SectionCard>

      {/* Units & Capture / Scanning */}
      <SectionCard
        title="Units & Capture"
        subtitle="Choose unit system and enable barcode/receipt scanning for ingredient analysis."
      >
        {loading ? (
          <Skeleton lines={3} />
        ) : (
          <>
            <Row
              label="Unit System"
              hint="Affects labels, recipes, and shopping lists"
            >
              <Select
                value={unitSystem}
                onChange={(v) =>
                  optimisticSave({ unitSystem: v }, "Unit system")
                }
                options={[
                  { value: "US", label: "US Customary" },
                  { value: "Metric", label: "Metric" },
                ]}
                disabled={busy}
              />
            </Row>
            <Row
              label="Barcode Scanning"
              hint="Scan packaged foods and pantry items to auto-import ingredients."
            >
              <Toggle
                checked={enableBarcodeScan}
                onChange={(v) =>
                  optimisticSave({ enableBarcodeScan: v }, "Barcode scanning")
                }
                disabled={busy}
              />
            </Row>
            <Row
              label="Receipt OCR"
              hint="Parse grocery receipts to update inventory and price history."
            >
              <Toggle
                checked={enableReceiptOCR}
                onChange={(v) =>
                  optimisticSave({ enableReceiptOCR: v }, "Receipt OCR")
                }
                disabled={busy}
              />
            </Row>
          </>
        )}
      </SectionCard>

      {/* Modes & Presentation */}
      <SectionCard
        title="Modes & Presentation"
        subtitle="Enable fusion suggestions and special presentation modes."
        tag={streetFoodMode || foodTruckMode ? "manual decor" : "auto decor"}
      >
        {loading ? (
          <Skeleton lines={3} />
        ) : (
          <>
            <Row
              label="Fusion Mode"
              hint="Suggest creative blends between cuisines while respecting rules & allergens."
            >
              <Toggle
                checked={enableFusionMode}
                onChange={(v) =>
                  optimisticSave({ enableFusionMode: v }, "Fusion mode")
                }
                disabled={busy}
              />
              <Input
                className="w-[28rem]"
                value={fusionPair}
                onChange={(v) =>
                  optimisticSave({ fusionPair: v }, "Fusion pair")
                }
                placeholder="e.g., Indian ⇄ German"
                disabled={busy || !enableFusionMode}
              />
            </Row>
            <Row
              label="Street Food Mode"
              hint="Prioritize street-food style recipes and formats."
            >
              <Toggle
                checked={streetFoodMode}
                onChange={(v) =>
                  optimisticSave({ streetFoodMode: v }, "Street food mode")
                }
                disabled={busy}
              />
            </Row>
            <Row
              label="Food Truck Mode"
              hint="Use truck-menu layouts in Menu Preview & Sharing."
            >
              <Toggle
                checked={foodTruckMode}
                onChange={(v) =>
                  optimisticSave({ foodTruckMode: v }, "Food truck mode")
                }
                disabled={busy}
              />
            </Row>
          </>
        )}
      </SectionCard>

      {/* Meal Planning Defaults */}
      <SectionCard
        title="Meal Planning Defaults"
        subtitle="Set servings, daily slots, batch days, and labeling behavior."
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
            </Row>
            <Row
              label="Auto-Generate Labels"
              hint="Build cooking, storage, and cleanup labels after each batch session."
            >
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
          </>
        )}
      </SectionCard>

      {/* Calendar & Sharing */}
      <SectionCard
        title="Calendar & Sharing"
        subtitle="Sync meals to calendar and share menu forecasts."
      >
        {loading ? (
          <Skeleton lines={3} />
        ) : (
          <>
            <Row
              label="Sync Meals to Calendar"
              hint="Create/refresh calendar events for your plan (respects Sabbath guard)."
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
              hint="Avoid creating/editing events during Sabbath. Read-only operations allowed."
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
              label="Share Menu Forecast with Family"
              hint="Send 2-week menus, shopping list deltas, and preservation queues to your family planning channel."
            >
              <SubtleButton
                onClick={() => handleShareMenuForecast()}
                disabled={busy}
              >
                Send Forecast
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
            onClick={() => handleGenerate("preservation")}
            disabled={busy}
          >
            Recompute Preservation
          </SubtleButton>
          <SubtleButton onClick={() => handleSync("meals")} disabled={busy}>
            Sync Meals to Calendar
          </SubtleButton>
          <SubtleButton
            onClick={() =>
              automation.emit?.("ui.navigate", {
                to: "/tier2/household/inventory",
              })
            }
          >
            Review Pantry Inventory
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

/* ----------------------------------------------------------------------------
Notes for integrators

Expected optional FoodStore shape (graceful fallback if missing):
useFoodStore(): {
  loading?: boolean

  // rules
  torahMode?: boolean
  allowShellfish?: boolean
  porkAllowed?: boolean
  mixDairyMeat?: boolean

  // lists
  allergens?: string[]
  avoidList?: string[]

  // prefs
  doneness?: "rare"|"med-rare"|"medium"|"med-well"|"well"
  tenderness?: "soft"|"normal"|"al-dente"|"crisp"
  spice?: "mild"|"medium"|"hot"
  textures?: string[]
  cuisines?: string[]

  // planning
  servings?: number
  mealsPerDay?: 1|2|3
  batchDays?: string[] // e.g., ["Sun","Wed"]
  autoLabeling?: boolean

  // calendar
  syncMealsToCalendar?: boolean
  sabbathBlock?: boolean

  // nutrition
  nutritionPreset?: "weightLoss"|"maintenance"|"muscleGain"|"custom"
  dailyCalories?: number
  macroCarb?: number
  macroProtein?: number
  macroFat?: number

  // units & capture
  unitSystem?: "US"|"Metric"
  enableBarcodeScan?: boolean
  enableReceiptOCR?: boolean

  // modes
  enableFusionMode?: boolean
  fusionPair?: string
  streetFoodMode?: boolean
  foodTruckMode?: boolean

  // methods:
  fetchSettings?: () => Promise<void>
  saveSettings?: (settings) => Promise<void>
  generate?: (scope:"mealplan"|"labels"|"shopping"|"preservation"|"recs") => Promise<void>
  syncNow?: (scope:"meals") => Promise<void>
}

Automation runtime fallbacks (used if store fns are absent):
automation.request("food.saveSettings", payload)
automation.request("food.generate", { scope })
automation.request("calendar.sync", { scope: "meals" })
automation.request("sharing.family.menuForecast", { horizonDays, includeShopping, includePreservation })
automation.on("event", handler)
automation.emit("ui.navigate", { to:"/route" })
automation.emit("calendar.synced", { scope:"meals" })
automation.emit("torah.profile.updated", { allowShellfish, effectiveDate })
automation.emit("nutrition.goals.updated", { calories, macros, effectiveDate })
automation.emit("scanner.config.updated", { barcode, ocr })

Event-driven glue (listens to):
recipe.consolidated  -> suggest rebuild of meal plan & labels
inventory.updated    -> refresh shopping + preservation queues
calendar.synced      -> surface success
preferences.changed  -> subtle info toast
torah.profile.updated-> banner to rebuild meal plan
nutrition.goals.updated -> banner to rebuild labels
scanner.config.updated -> toast success

Undo pattern:
All saves are optimistic and push a revert callback; toast includes an Undo action.

Empty states:
Allergens/Avoid lists show dashed cards until items exist.

Design system:
Tailwind + DaisyUI; buttons & cards match your other Settings views.
---------------------------------------------------------------------------- */
