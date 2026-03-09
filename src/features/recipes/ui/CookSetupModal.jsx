/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\ui\CookSetupModal.jsx
//
// SSA • CookSetupModal
// -----------------------------------------------------------------------------
// User-friendly "adaptation step" before SessionRunner.
//   - Accepts a raw recipe (or imported recipe)
//   - Runs RecipeAdapterService pipeline to produce a persisted RecipeVariant
//   - Matches kitchen capabilities (CapabilityMatcher) and suggests substitutions
//   - Resolves doneness targets (DonenessResolver) and lets user adjust
//   - Transforms steps -> adapted steps + timers + tasks (StepTransformer)
//   - Produces a session-ready CookPlan (from RecipeAdapterService output)
//   - Allows saving variant and starting session
//
// Design constraints from SSA:
//   - Use SSA styling system (household.css + cooking.css etc.), NOT Tailwind.
//   - Browser-safe; no Node APIs.
//   - Deterministic engines; no AI required.
//   - Emit SSA events through eventBus where available (optional).
//
// Expected companion modules (generated earlier in this thread):
//   - engines/RecipeAdapterService.js
//   - engines/DonenessResolver.js
//   - engines/CapabilityMatcher.js
//   - engines/StepTransformer.js
//   - engines/RecipeIntakeParser.js (optional quick signals)
//   - catalogs/ToolSubstitutionRules.catalog.js (used by matcher)
//   - contracts/recipeVariant.schema.js
//   - contracts/cookPlan.schema.js
//   - contracts/doneness.profile.schema.js
//   - contracts/kitchen.capabilities.schema.js
//
// This component is tolerant: it will render usable UI even if some dependencies
// are absent, but will clearly report missing functions.
//
// -----------------------------------------------------------------------------
// API (props):
//   open: boolean
//   onClose: () => void
//
//   recipe: object (raw/imported/manual recipe)
//   recipeId?: string
//   householdId?: string
//
//   kitchenCaps?: object (user's kitchen capabilities)
//   donenessProfile?: object (user doneness profile)
//
//   defaultMode?: "adapt" | "review"  (adapt = run pipeline + allow edits)
//
//   onSavedVariant?: (variant) => void
//   onGeneratedCookPlan?: (cookPlan) => void
//   onStartSession?: (cookPlan) => void
//
// Optional hooks:
//   eventBus?: { emit: (eventName, payload) => void }  // SSA bus
//
// -----------------------------------------------------------------------------
// Persistence:
//   - This modal does NOT assume a Dexie table exists.
//   - If you have a storage layer, pass persistence callbacks via RecipeAdapterService.
//   - The modal supports: RecipeAdapterService.persistVariant / persistCookPlan if present.
//
// -----------------------------------------------------------------------------
// Accessibility:
//   - Esc closes
//   - Focus trap basic
//
// -----------------------------------------------------------------------------
// No placeholders. Defensive coding. Production-ready.

import React, { useEffect, useMemo, useRef, useState } from "react";

import "@/styles/household.css";
import "@/pages/cooking/cooking.css";

import RecipeAdapterService from "@/features/recipes/engines/RecipeAdapterService";
import DonenessResolver from "@/features/recipes/engines/DonenessResolver";
import CapabilityMatcher from "@/features/recipes/engines/CapabilityMatcher";
import StepTransformer from "@/features/recipes/engines/StepTransformer";
import RecipeIntakeParser from "@/features/recipes/engines/RecipeIntakeParser";

/* -------------------------------------------------------------------------- */
/* Small utilities                                                             */
/* -------------------------------------------------------------------------- */

const MODAL_ID = "CookSetupModal";

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeString(s, max = 2000, fallback = "") {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  return t ? t.slice(0, max) : fallback;
}

function safeLower(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  const y = Math.round(x);
  if (y < min) return min;
  if (y > max) return max;
  return y;
}

function nowISO() {
  return new Date().toISOString();
}

function deepClone(obj) {
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return obj;
  }
}

function tryEmit(eventBus, eventName, payload) {
  try {
    if (eventBus && typeof eventBus.emit === "function")
      eventBus.emit(eventName, payload);
  } catch (e) {
    // Non-fatal
    console.warn(`[${MODAL_ID}] eventBus emit failed`, eventName, e);
  }
}

function normalizeStepsToText(steps) {
  if (!steps) return "";
  if (typeof steps === "string") return steps;
  if (Array.isArray(steps)) {
    const out = [];
    for (const it of steps) {
      if (typeof it === "string") out.push(it);
      else if (isPlainObject(it))
        out.push(
          String(it.text ?? it.instruction ?? it.step ?? it.title ?? "")
        );
    }
    return out.filter(Boolean).join("\n");
  }
  return "";
}

function normalizeIngredientsToText(ingredients) {
  if (!ingredients) return "";
  if (typeof ingredients === "string") return ingredients;
  if (Array.isArray(ingredients)) {
    const out = [];
    for (const it of ingredients) {
      if (typeof it === "string") out.push(it);
      else if (isPlainObject(it)) {
        // best effort
        const line =
          it.text ??
          [it.amount, it.unit, it.name]
            .map((x) => (x == null ? "" : String(x)))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        if (line) out.push(line);
      }
    }
    return out.filter(Boolean).join("\n");
  }
  return "";
}

/* -------------------------------------------------------------------------- */
/* UI primitives (SSA-style)                                                   */
/* -------------------------------------------------------------------------- */

function IconCircle({ children }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        borderRadius: 999,
        background: "rgba(0,0,0,0.08)",
        marginRight: 8,
        flex: "0 0 auto",
      }}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

function Pill({ children, tone = "neutral" }) {
  const bg =
    tone === "good"
      ? "rgba(46, 204, 113, 0.18)"
      : tone === "warn"
      ? "rgba(241, 196, 15, 0.18)"
      : tone === "bad"
      ? "rgba(231, 76, 60, 0.18)"
      : "rgba(0,0,0,0.10)";
  const border =
    tone === "good"
      ? "rgba(46, 204, 113, 0.35)"
      : tone === "warn"
      ? "rgba(241, 196, 15, 0.35)"
      : tone === "bad"
      ? "rgba(231, 76, 60, 0.35)"
      : "rgba(0,0,0,0.20)";
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "2px 10px",
        borderRadius: 999,
        background: bg,
        border: `1px solid ${border}`,
        fontSize: 12,
        lineHeight: "18px",
        marginRight: 8,
        marginBottom: 6,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

function Section({ title, subtitle, right, children }) {
  return (
    <div className="sv-card" style={{ marginBottom: 12 }}>
      <div
        className="sv-card-header"
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <div className="sv-card-title" style={{ fontWeight: 700 }}>
            {title}
          </div>
          {subtitle ? <div className="sv-card-subtitle">{subtitle}</div> : null}
        </div>
        {right ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {right}
          </div>
        ) : null}
      </div>
      <div className="sv-card-body">{children}</div>
    </div>
  );
}

function InlineError({ title, message, detail }) {
  return (
    <div
      style={{
        border: "1px solid rgba(231, 76, 60, 0.35)",
        background: "rgba(231, 76, 60, 0.10)",
        borderRadius: 10,
        padding: 10,
        marginTop: 8,
      }}
      role="alert"
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{title}</div>
      <div style={{ opacity: 0.9 }}>{message}</div>
      {detail ? (
        <pre
          style={{
            marginTop: 8,
            whiteSpace: "pre-wrap",
            fontSize: 12,
            opacity: 0.9,
          }}
        >
          {detail}
        </pre>
      ) : null}
    </div>
  );
}

function TextArea({ label, value, onChange, placeholder, rows = 6, help }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 10,
        }}
      >
        <label style={{ fontWeight: 700 }}>{label}</label>
        {help ? (
          <span style={{ fontSize: 12, opacity: 0.75 }}>{help}</span>
        ) : null}
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        style={{
          width: "100%",
          resize: "vertical",
          marginTop: 6,
          padding: 10,
          borderRadius: 10,
          border: "1px solid rgba(0,0,0,0.18)",
          background: "rgba(255,255,255,0.75)",
          fontFamily: "inherit",
          fontSize: 14,
          lineHeight: "20px",
        }}
      />
    </div>
  );
}

function Input({ label, value, onChange, placeholder, help, type = "text" }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 10,
        }}
      >
        <label style={{ fontWeight: 700 }}>{label}</label>
        {help ? (
          <span style={{ fontSize: 12, opacity: 0.75 }}>{help}</span>
        ) : null}
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        type={type}
        style={{
          width: "100%",
          marginTop: 6,
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid rgba(0,0,0,0.18)",
          background: "rgba(255,255,255,0.75)",
          fontFamily: "inherit",
          fontSize: 14,
        }}
      />
    </div>
  );
}

function Select({ label, value, onChange, options, help }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          gap: 10,
        }}
      >
        <label style={{ fontWeight: 700 }}>{label}</label>
        {help ? (
          <span style={{ fontSize: 12, opacity: 0.75 }}>{help}</span>
        ) : null}
      </div>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: "100%",
          marginTop: 6,
          padding: "10px 12px",
          borderRadius: 10,
          border: "1px solid rgba(0,0,0,0.18)",
          background: "rgba(255,255,255,0.75)",
          fontFamily: "inherit",
          fontSize: 14,
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function Button({ children, onClick, disabled, tone = "primary", title }) {
  const bg =
    tone === "primary"
      ? "rgba(52, 152, 219, 0.22)"
      : tone === "danger"
      ? "rgba(231, 76, 60, 0.18)"
      : tone === "ghost"
      ? "rgba(0,0,0,0.05)"
      : "rgba(0,0,0,0.10)";
  const border =
    tone === "primary"
      ? "rgba(52, 152, 219, 0.38)"
      : tone === "danger"
      ? "rgba(231, 76, 60, 0.35)"
      : "rgba(0,0,0,0.18)";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!!disabled}
      title={title}
      className="sv-btn"
      style={{
        padding: "10px 12px",
        borderRadius: 10,
        border: `1px solid ${border}`,
        background: bg,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
        fontWeight: 700,
      }}
    >
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Doneness helpers                                                            */
/* -------------------------------------------------------------------------- */

function buildDonenessUIModel({
  donenessProfile,
  intakeSignals,
  method,
  report,
}) {
  // We expect DonenessResolver.resolveTarget(...) exists.
  // If not, we provide minimal UI with method + generic.
  const out = {
    ok: true,
    resolved: null,
    inputs: {
      proteinCategory: intakeSignals?.primaryProteinCategory || null,
      cutTag: intakeSignals?.proteins?.[0]?.cutTag || null,
      method: method || intakeSignals?.primaryMethod || null,
      tempUnit: "F",
    },
    userOverrides: {
      targetName: "",
      internalTempF: "",
      internalTempC: "",
      notes: "",
    },
    warnings: [],
  };

  if (
    !DonenessResolver ||
    typeof DonenessResolver.resolveUserTarget !== "function"
  ) {
    out.ok = false;
    out.warnings.push(
      "DonenessResolver.resolveUserTarget is not available; showing manual target fields."
    );
    if (report) note(report, out.warnings[out.warnings.length - 1]);
    return out;
  }

  try {
    const resolved = DonenessResolver.resolveUserTarget({
      donenessProfile: donenessProfile || null,
      proteinCategory: out.inputs.proteinCategory,
      cutTag: out.inputs.cutTag,
      method: out.inputs.method,
    });
    out.resolved = resolved || null;

    // Pre-fill overrides if resolver returned a direct internal temp
    if (resolved?.target?.internalTempF)
      out.userOverrides.internalTempF = String(resolved.target.internalTempF);
    if (resolved?.target?.internalTempC)
      out.userOverrides.internalTempC = String(resolved.target.internalTempC);
    if (resolved?.target?.name)
      out.userOverrides.targetName = String(resolved.target.name);

    return out;
  } catch (e) {
    out.ok = false;
    out.warnings.push(`Doneness resolution failed: ${e?.message || String(e)}`);
    if (report)
      warn(
        report,
        "doneness_resolution_failed",
        out.warnings[out.warnings.length - 1],
        { error: String(e) }
      );
    return out;
  }
}

/* -------------------------------------------------------------------------- */
/* Main component                                                              */
/* -------------------------------------------------------------------------- */

export default function CookSetupModal({
  open,
  onClose,
  recipe,
  recipeId,
  householdId,
  kitchenCaps,
  donenessProfile,
  defaultMode = "adapt",
  onSavedVariant,
  onGeneratedCookPlan,
  onStartSession,
  eventBus,
}) {
  const modalRef = useRef(null);
  const firstFocusRef = useRef(null);
  const lastFocusRef = useRef(null);

  // Local working copy for editing (do not mutate prop)
  const initialRecipe = useMemo(() => deepClone(recipe || {}), [recipe]);

  const [mode, setMode] = useState(defaultMode);
  const [busy, setBusy] = useState(false);
  const [fatalError, setFatalError] = useState(null);

  // Editable recipe fields (tolerant)
  const [title, setTitle] = useState(() =>
    safeString(
      initialRecipe?.title || initialRecipe?.name || "Untitled Recipe",
      200,
      "Untitled Recipe"
    )
  );
  const [method, setMethod] = useState(() =>
    safeLower(initialRecipe?.method || initialRecipe?.primaryMethod || "")
  );
  const [ingredientsText, setIngredientsText] = useState(() =>
    normalizeIngredientsToText(
      initialRecipe?.ingredients || initialRecipe?.ingredientLines
    )
  );
  const [stepsText, setStepsText] = useState(() =>
    normalizeStepsToText(
      initialRecipe?.steps ||
        initialRecipe?.instructions ||
        initialRecipe?.directions
    )
  );

  // Results
  const [intake, setIntake] = useState(null); // RecipeIntakeParser result
  const [capReport, setCapReport] = useState(null); // CapabilityMatcher result
  const [donenessUI, setDonenessUI] = useState(null); // UI model
  const [stepOut, setStepOut] = useState(null); // StepTransformer output
  const [adapterOut, setAdapterOut] = useState(null); // RecipeAdapterService output

  // User options
  const [autoSubstituteTools, setAutoSubstituteTools] = useState(true);
  const [autoInferTimers, setAutoInferTimers] = useState(true);
  const [autoInferTasks, setAutoInferTasks] = useState(true);

  // Whether to save variant before starting
  const [saveAsVariant, setSaveAsVariant] = useState(true);

  // Step view toggles
  const [showRaw, setShowRaw] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  // Init / reset whenever opened or recipe changes
  useEffect(() => {
    if (!open) return;

    setMode(defaultMode);
    setBusy(false);
    setFatalError(null);

    const r = deepClone(recipe || {});
    setTitle(
      safeString(
        r?.title || r?.name || "Untitled Recipe",
        200,
        "Untitled Recipe"
      )
    );
    setMethod(safeLower(r?.method || r?.primaryMethod || ""));
    setIngredientsText(
      normalizeIngredientsToText(r?.ingredients || r?.ingredientLines)
    );
    setStepsText(
      normalizeStepsToText(r?.steps || r?.instructions || r?.directions)
    );

    setIntake(null);
    setCapReport(null);
    setDonenessUI(null);
    setStepOut(null);
    setAdapterOut(null);

    setAutoSubstituteTools(true);
    setAutoInferTimers(true);
    setAutoInferTasks(true);
    setSaveAsVariant(true);

    setShowRaw(false);
    setShowEvidence(false);

    tryEmit(eventBus, "recipes.cook_setup.opened", {
      at: nowISO(),
      recipeId: recipeId || r?.id || null,
      householdId: householdId || null,
      source: MODAL_ID,
    });
  }, [open, recipe, recipeId, householdId, defaultMode, eventBus]);

  // Focus management + ESC
  useEffect(() => {
    if (!open) return;

    const el = firstFocusRef.current;
    if (el && typeof el.focus === "function") el.focus();

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (onClose) onClose();
      }

      // Basic focus trap
      if (e.key === "Tab") {
        const root = modalRef.current;
        if (!root) return;
        const focusables = root.querySelectorAll(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const list = Array.from(focusables).filter(
          (n) => !n.disabled && n.offsetParent !== null
        );
        if (!list.length) return;

        const first = list[0];
        const last = list[list.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  const methodOptions = useMemo(() => {
    const base = [
      { value: "", label: "Auto (infer from steps)" },
      { value: "bake", label: "Bake / Oven" },
      { value: "roast", label: "Roast" },
      { value: "broil", label: "Broil" },
      { value: "air_fry", label: "Air Fry" },
      { value: "grill", label: "Grill" },
      { value: "smoke", label: "Smoke" },
      { value: "pan_sear", label: "Pan Sear" },
      { value: "saute", label: "Sauté" },
      { value: "stir_fry", label: "Stir Fry" },
      { value: "boil", label: "Boil" },
      { value: "simmer", label: "Simmer" },
      { value: "steam", label: "Steam" },
      { value: "deep_fry", label: "Deep Fry" },
      { value: "pressure_cook", label: "Pressure Cook" },
      { value: "slow_cook", label: "Slow Cook" },
      { value: "sous_vide", label: "Sous Vide" },
      { value: "microwave", label: "Microwave" },
    ];
    return base;
  }, []);

  const combinedRecipeDraft = useMemo(() => {
    return {
      id: recipeId || recipe?.id || null,
      title,
      method: method || null,
      ingredients: ingredientsText,
      steps: stepsText,
      householdId: householdId || null,
      updatedAt: nowISO(),
      source: MODAL_ID,
      raw: deepClone(recipe || {}),
    };
  }, [
    title,
    method,
    ingredientsText,
    stepsText,
    recipe,
    recipeId,
    householdId,
  ]);

  const intakeSignals = useMemo(() => {
    // Provide a stable "signals" object to downstream; prefer intake.signals if exists.
    if (intake?.signals) return intake.signals;
    return {
      primaryProteinCategory: null,
      primaryMethod: method || null,
      hasOvenTemp: false,
      totalTimeSecondsGuess: null,
    };
  }, [intake, method]);

  const canRunEngines = useMemo(() => {
    const ok = !!combinedRecipeDraft?.title;
    return ok;
  }, [combinedRecipeDraft]);

  /* ------------------------------------------------------------------------ */
  /* Pipeline runners                                                          */
  /* ------------------------------------------------------------------------ */

  async function runParseAndInfer() {
    setFatalError(null);
    if (!canRunEngines) return;

    tryEmit(eventBus, "recipes.cook_setup.parse_requested", {
      at: nowISO(),
      recipeId: combinedRecipeDraft.id,
      householdId: householdId || null,
      source: MODAL_ID,
    });

    // Intake parsing (best effort)
    let intakeOut = null;
    if (
      RecipeIntakeParser &&
      typeof RecipeIntakeParser.parseRecipeIntake === "function"
    ) {
      intakeOut = RecipeIntakeParser.parseRecipeIntake({
        title: combinedRecipeDraft.title,
        ingredients: combinedRecipeDraft.ingredients,
        steps: combinedRecipeDraft.steps,
        recipe: recipe || {},
      });
      setIntake(intakeOut);
    } else {
      setIntake({
        ok: false,
        extracted: {
          proteins: [],
          vegetables: [],
          fats: [],
          methods: [],
          temperatures: [],
          times: [],
        },
        signals: {
          primaryProteinCategory: null,
          primaryMethod: null,
          hasOvenTemp: false,
          totalTimeSecondsGuess: null,
        },
        report: {
          ok: false,
          warnings: [
            {
              code: "missing_engine",
              message: "RecipeIntakeParser not available.",
              severity: "warn",
            },
          ],
          notes: [],
          flags: ["missing_engine"],
          decisions: [],
        },
      });
    }

    // Step transform
    let stepTransOut = null;
    if (
      StepTransformer &&
      typeof StepTransformer.transformSteps === "function"
    ) {
      stepTransOut = StepTransformer.transformSteps({
        steps: combinedRecipeDraft.steps,
        method:
          combinedRecipeDraft.method ||
          intakeOut?.signals?.primaryMethod ||
          null,
        options: {
          allowTimerInference: autoInferTimers,
          allowTaskInference: autoInferTasks,
          allowStepTextRewrite: true,
        },
      });
      setStepOut(stepTransOut);
    } else {
      setStepOut({
        ok: false,
        adaptedSteps: [],
        timers: [],
        tasks: [],
        report: {
          ok: false,
          warnings: [
            {
              code: "missing_engine",
              message: "StepTransformer not available.",
              severity: "warn",
            },
          ],
          notes: [],
          flags: ["missing_engine"],
          decisions: [],
        },
      });
    }

    // Capabilities match (best effort)
    let requiredSpec = null;

    // If adapterOut already exists, use its equipment requirements; else infer from transformed steps
    if (adapterOut?.variant?.equipment) {
      requiredSpec = { equipment: adapterOut.variant.equipment };
    } else if (
      CapabilityMatcher &&
      typeof CapabilityMatcher.buildRequiredSpecFromVariantOrPlan === "function"
    ) {
      requiredSpec = CapabilityMatcher.buildRequiredSpecFromVariantOrPlan({
        variant: { steps: stepTransOut?.adaptedSteps || [] },
      });
    } else {
      // naive: infer from step requires.equipmentIds
      const eq = [];
      for (const st of stepTransOut?.adaptedSteps || []) {
        for (const id of st?.requires?.equipmentIds || []) eq.push(id);
      }
      requiredSpec = { required: Array.from(new Set(eq)) };
    }

    if (
      CapabilityMatcher &&
      typeof CapabilityMatcher.matchCapabilities === "function"
    ) {
      const capOut = CapabilityMatcher.matchCapabilities({
        availableCaps: kitchenCaps || {},
        requiredSpec,
        method:
          combinedRecipeDraft.method ||
          intakeOut?.signals?.primaryMethod ||
          null,
        tags: [],
        options: {
          allowToolSubstitutions: autoSubstituteTools,
          allowMethodFallbacks: true,
        },
      });
      setCapReport(capOut);
    } else {
      setCapReport({
        ok: false,
        missing: [],
        satisfied: [],
        substitutions: [],
        methodFallbacks: [],
        flags: ["missing_engine"],
        notes: ["CapabilityMatcher not available."],
        warnings: [
          {
            code: "missing_engine",
            message: "CapabilityMatcher not available.",
            severity: "warn",
          },
        ],
      });
    }

    // Doneness UI model
    const donenessModel = buildDonenessUIModel({
      donenessProfile,
      intakeSignals: intakeOut?.signals || intakeSignals,
      method:
        combinedRecipeDraft.method || intakeOut?.signals?.primaryMethod || null,
      report: stepTransOut?.report || null,
    });
    setDonenessUI(donenessModel);

    tryEmit(eventBus, "recipes.cook_setup.parse_completed", {
      at: nowISO(),
      recipeId: combinedRecipeDraft.id,
      householdId: householdId || null,
      source: MODAL_ID,
      ok: true,
      counts: {
        steps: stepTransOut?.adaptedSteps?.length || 0,
        timers: stepTransOut?.timers?.length || 0,
        tasks: stepTransOut?.tasks?.length || 0,
      },
    });
  }

  async function runAdapterPipeline() {
    setFatalError(null);
    if (!canRunEngines) return;

    setBusy(true);
    tryEmit(eventBus, "recipes.cook_setup.adapt_requested", {
      at: nowISO(),
      recipeId: combinedRecipeDraft.id,
      householdId: householdId || null,
      source: MODAL_ID,
    });

    try {
      if (
        !RecipeAdapterService ||
        typeof RecipeAdapterService.adaptRecipeToVariant !== "function"
      ) {
        throw new Error(
          "RecipeAdapterService.adaptRecipeToVariant is not available."
        );
      }

      // Prepare "intake" for adapter
      const intakeDraft = {
        id: combinedRecipeDraft.id,
        title: combinedRecipeDraft.title,
        ingredients: combinedRecipeDraft.ingredients,
        steps: combinedRecipeDraft.steps,
        method:
          combinedRecipeDraft.method || intakeSignals?.primaryMethod || null,
        raw: deepClone(recipe || {}),
      };

      // Compose doneness override
      const donenessOverride = donenessUI?.userOverrides
        ? {
            targetName: safeString(
              donenessUI.userOverrides.targetName,
              120,
              ""
            ),
            internalTempF: donenessUI.userOverrides.internalTempF
              ? Number(donenessUI.userOverrides.internalTempF)
              : null,
            internalTempC: donenessUI.userOverrides.internalTempC
              ? Number(donenessUI.userOverrides.internalTempC)
              : null,
            notes: safeString(donenessUI.userOverrides.notes, 400, ""),
          }
        : null;

      const out = await RecipeAdapterService.adaptRecipeToVariant({
        recipe: intakeDraft,
        householdId: householdId || null,
        kitchenCaps: kitchenCaps || null,
        donenessProfile: donenessProfile || null,
        donenessOverride,
        options: {
          allowToolSubstitutions: autoSubstituteTools,
          allowTimerInference: autoInferTimers,
          allowTaskInference: autoInferTasks,
        },
      });

      setAdapterOut(out || null);

      // Optionally rerun parse/infer with adapter info (equipment / step rewrite hints)
      await runParseAndInfer();

      tryEmit(eventBus, "recipes.cook_setup.adapt_completed", {
        at: nowISO(),
        recipeId: combinedRecipeDraft.id,
        householdId: householdId || null,
        source: MODAL_ID,
        ok: true,
        hasVariant: !!out?.variant,
        hasCookPlan: !!out?.cookPlan,
      });

      // If adapter produced cookPlan, notify
      if (out?.cookPlan && onGeneratedCookPlan) {
        try {
          onGeneratedCookPlan(out.cookPlan);
        } catch (e) {
          console.warn(`[${MODAL_ID}] onGeneratedCookPlan failed`, e);
        }
      }
    } catch (e) {
      const msg = e?.message || String(e);
      console.error(`[${MODAL_ID}] Adapt pipeline failed`, e);
      setFatalError(msg);

      tryEmit(eventBus, "recipes.cook_setup.adapt_failed", {
        at: nowISO(),
        recipeId: combinedRecipeDraft.id,
        householdId: householdId || null,
        source: MODAL_ID,
        ok: false,
        error: msg,
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveVariant() {
    setFatalError(null);
    setBusy(true);
    try {
      if (!adapterOut?.variant) {
        // If no variant yet, run adaptation first
        await runAdapterPipeline();
      }

      const variant = adapterOut?.variant;
      if (!variant) throw new Error("No RecipeVariant available to save.");

      // Prefer adapter persistence if present
      let persisted = variant;
      if (
        RecipeAdapterService &&
        typeof RecipeAdapterService.persistVariant === "function"
      ) {
        persisted = await RecipeAdapterService.persistVariant({
          variant,
          householdId: householdId || null,
        });
      }

      tryEmit(eventBus, "recipes.variant.saved", {
        at: nowISO(),
        householdId: householdId || null,
        recipeId: combinedRecipeDraft.id,
        variantId: persisted?.id || null,
        source: MODAL_ID,
      });

      if (onSavedVariant) onSavedVariant(persisted);

      return persisted;
    } catch (e) {
      const msg = e?.message || String(e);
      setFatalError(msg);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function handleStart() {
    setFatalError(null);
    setBusy(true);

    try {
      // Ensure we have cookPlan (adapter should create it)
      if (!adapterOut?.cookPlan || !adapterOut?.variant) {
        await runAdapterPipeline();
      }

      let cookPlan = adapterOut?.cookPlan;
      let variant = adapterOut?.variant;

      if (!cookPlan || !variant)
        throw new Error(
          "CookPlan/Variant not available. Please run Adapt first."
        );

      // Save variant optionally
      if (saveAsVariant) {
        const persisted = await handleSaveVariant();
        if (persisted) variant = persisted;
      }

      // Prefer adapter persistence for cook plan if present
      if (
        RecipeAdapterService &&
        typeof RecipeAdapterService.persistCookPlan === "function"
      ) {
        cookPlan = await RecipeAdapterService.persistCookPlan({
          cookPlan,
          householdId: householdId || null,
        });
      }

      // Notify
      tryEmit(eventBus, "recipes.cook_plan.ready", {
        at: nowISO(),
        householdId: householdId || null,
        recipeId: combinedRecipeDraft.id,
        variantId: variant?.id || null,
        cookPlanId: cookPlan?.id || null,
        source: MODAL_ID,
      });

      if (onGeneratedCookPlan) onGeneratedCookPlan(cookPlan);

      // Start session
      if (onStartSession) onStartSession(cookPlan);

      // Close
      if (onClose) onClose();
    } catch (e) {
      const msg = e?.message || String(e);
      setFatalError(msg);
      tryEmit(eventBus, "recipes.cook_setup.start_failed", {
        at: nowISO(),
        householdId: householdId || null,
        recipeId: combinedRecipeDraft.id,
        source: MODAL_ID,
        error: msg,
      });
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Auto-run parse when open                                                   */
  /* ------------------------------------------------------------------------ */

  useEffect(() => {
    if (!open) return;
    // Initial parse (cheap) so user sees suggestions immediately
    // Do not auto-run full adapter unless in adapt mode and user wants it.
    runParseAndInfer().catch((e) =>
      console.warn(`[${MODAL_ID}] initial parse failed`, e)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const capTone =
    capReport?.ok && !(capReport?.missing || []).some((m) => m?.critical)
      ? "good"
      : (capReport?.missing || []).length
      ? "warn"
      : "neutral";

  const donenessTone = donenessUI?.ok ? "good" : "warn";

  const stepCounts = {
    steps: stepOut?.adaptedSteps?.length || 0,
    timers: stepOut?.timers?.length || 0,
    tasks: stepOut?.tasks?.length || 0,
  };

  const adapterHas = {
    variant: !!adapterOut?.variant,
    cookPlan: !!adapterOut?.cookPlan,
  };

  /* ------------------------------------------------------------------------ */
  /* Render                                                                    */
  /* ------------------------------------------------------------------------ */

  return (
    <div
      className="sv-modal-overlay"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Cook setup"
    >
      <div
        ref={modalRef}
        className="sv-modal"
        style={{
          width: "min(1100px, 96vw)",
          maxHeight: "90vh",
          overflow: "auto",
          background: "rgba(255,255,255,0.95)",
          borderRadius: 16,
          border: "1px solid rgba(0,0,0,0.18)",
          boxShadow: "0 20px 70px rgba(0,0,0,0.35)",
        }}
      >
        {/* Header */}
        <div
          className="sv-modal-header"
          style={{
            padding: 14,
            borderBottom: "1px solid rgba(0,0,0,0.12)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            position: "sticky",
            top: 0,
            background: "rgba(255,255,255,0.96)",
            backdropFilter: "blur(8px)",
            zIndex: 2,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minWidth: 0,
            }}
          >
            <IconCircle>🍳</IconCircle>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontWeight: 800,
                  fontSize: 16,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                Cook Setup
              </div>
              <div
                style={{
                  fontSize: 12,
                  opacity: 0.75,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                Adapt this recipe to your kitchen + doneness preferences before
                you start a session.
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Pill tone={capTone}>
              Kitchen:{" "}
              {capTone === "good"
                ? "Ready"
                : capTone === "warn"
                ? "Review"
                : "—"}
            </Pill>
            <Pill tone={donenessTone}>
              Doneness: {donenessTone === "good" ? "Resolved" : "Manual"}
            </Pill>
            <Pill tone={adapterHas.cookPlan ? "good" : "neutral"}>
              CookPlan: {adapterHas.cookPlan ? "Ready" : "Not yet"}
            </Pill>

            <button
              ref={lastFocusRef}
              type="button"
              onClick={onClose}
              className="sv-btn"
              style={{
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,0.18)",
                background: "rgba(0,0,0,0.05)",
                cursor: "pointer",
                fontWeight: 800,
              }}
              aria-label="Close"
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ padding: 14 }}>
          {/* Mode + actions bar */}
          <div
            className="sv-row"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 10,
              alignItems: "center",
              marginBottom: 12,
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <Button
                tone={mode === "adapt" ? "primary" : "ghost"}
                onClick={() => setMode("adapt")}
                disabled={busy}
                title="Adapt recipe to your kitchen"
              >
                Adapt
              </Button>
              <Button
                tone={mode === "review" ? "primary" : "ghost"}
                onClick={() => setMode("review")}
                disabled={busy}
                title="Review extracted signals"
              >
                Review
              </Button>
            </div>

            <div style={{ flex: "1 1 auto" }} />

            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <Button
                onClick={runParseAndInfer}
                disabled={busy}
                title="Re-parse recipe and re-infer steps/timers/tasks"
              >
                Re-Parse
              </Button>
              <Button
                onClick={runAdapterPipeline}
                disabled={busy}
                title="Run full adaptation pipeline (variant + cook plan)"
              >
                {busy ? "Adapting…" : "Adapt to Kitchen"}
              </Button>
              <Button
                tone="primary"
                onClick={handleStart}
                disabled={busy}
                title="Generate session-ready plan and start SessionRunner"
              >
                Start Session
              </Button>
            </div>
          </div>

          {fatalError ? (
            <InlineError
              title="Something went wrong"
              message={fatalError}
              detail={
                adapterOut?.report
                  ? JSON.stringify(adapterOut.report, null, 2)
                  : ""
              }
            />
          ) : null}

          {/* Main layout */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 360px",
              gap: 12,
              alignItems: "start",
            }}
          >
            {/* Left: editing + steps */}
            <div>
              <Section
                title="Recipe input"
                subtitle="Edit anything that looks off before adapting. Changes re-run parsing and step transforms."
                right={
                  <div
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    <label
                      style={{
                        fontSize: 12,
                        opacity: 0.85,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <input
                        ref={firstFocusRef}
                        type="checkbox"
                        checked={showRaw}
                        onChange={(e) => setShowRaw(e.target.checked)}
                      />
                      show raw blocks
                    </label>
                    <label
                      style={{
                        fontSize: 12,
                        opacity: 0.85,
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={showEvidence}
                        onChange={(e) => setShowEvidence(e.target.checked)}
                      />
                      show evidence
                    </label>
                  </div>
                }
              >
                <Input
                  label="Title"
                  value={title}
                  onChange={setTitle}
                  placeholder="Recipe title"
                  help="Used for saved variants and session titles"
                />

                <Select
                  label="Primary method"
                  value={method}
                  onChange={setMethod}
                  options={methodOptions}
                  help="Leave Auto if your steps already include method cues"
                />

                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 1fr",
                    gap: 12,
                  }}
                >
                  <TextArea
                    label="Ingredients"
                    value={ingredientsText}
                    onChange={setIngredientsText}
                    placeholder="Paste ingredients (one per line)"
                    rows={10}
                    help="Used to extract vegetables/fats/proteins"
                  />
                  <TextArea
                    label="Steps"
                    value={stepsText}
                    onChange={setStepsText}
                    placeholder="Paste steps (one per line)"
                    rows={10}
                    help="Used to infer methods, temps, times, timers and tasks"
                  />
                </div>

                <div
                  style={{
                    display: "flex",
                    gap: 14,
                    flexWrap: "wrap",
                    marginTop: 8,
                  }}
                >
                  <label
                    style={{
                      fontSize: 13,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={autoSubstituteTools}
                      onChange={(e) => setAutoSubstituteTools(e.target.checked)}
                    />
                    Suggest tool substitutions
                  </label>
                  <label
                    style={{
                      fontSize: 13,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={autoInferTimers}
                      onChange={(e) => setAutoInferTimers(e.target.checked)}
                    />
                    Infer timers
                  </label>
                  <label
                    style={{
                      fontSize: 13,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={autoInferTasks}
                      onChange={(e) => setAutoInferTasks(e.target.checked)}
                    />
                    Infer tasks
                  </label>
                  <label
                    style={{
                      fontSize: 13,
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={saveAsVariant}
                      onChange={(e) => setSaveAsVariant(e.target.checked)}
                    />
                    Save as adapted recipe (variant)
                  </label>
                </div>
              </Section>

              <Section
                title="Adapted steps, timers, tasks"
                subtitle="Preview what SessionRunner will run. Edit recipe input above and click Re-Parse."
                right={
                  <div
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    <Pill tone="neutral">Steps: {stepCounts.steps}</Pill>
                    <Pill tone="neutral">Timers: {stepCounts.timers}</Pill>
                    <Pill tone="neutral">Tasks: {stepCounts.tasks}</Pill>
                  </div>
                }
              >
                {!stepOut?.adaptedSteps?.length ? (
                  <div style={{ opacity: 0.8 }}>
                    No adapted steps yet. Click <b>Re-Parse</b> or{" "}
                    <b>Adapt to Kitchen</b>.
                  </div>
                ) : (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 10,
                    }}
                  >
                    {stepOut.adaptedSteps.map((st) => (
                      <div
                        key={st.id}
                        style={{
                          border: "1px solid rgba(0,0,0,0.12)",
                          borderRadius: 12,
                          padding: 10,
                          background: "rgba(0,0,0,0.02)",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 10,
                            alignItems: "baseline",
                          }}
                        >
                          <div style={{ fontWeight: 800 }}>
                            {st.order}. {st.title}{" "}
                            <span
                              style={{
                                fontSize: 12,
                                opacity: 0.7,
                                fontWeight: 700,
                              }}
                            >
                              ({st.kind})
                            </span>
                          </div>
                          <div
                            style={{
                              display: "flex",
                              gap: 8,
                              flexWrap: "wrap",
                              justifyContent: "flex-end",
                            }}
                          >
                            {(st.requires?.methods || [])
                              .slice(0, 2)
                              .map((m) => (
                                <Pill key={m} tone="neutral">
                                  {m}
                                </Pill>
                              ))}
                            {(st.timers || []).length ? (
                              <Pill tone="good">⏱ {st.timers.length}</Pill>
                            ) : (
                              <Pill tone="neutral">⏱ 0</Pill>
                            )}
                            {st.gate?.required ? (
                              <Pill tone="warn">Gate</Pill>
                            ) : null}
                          </div>
                        </div>

                        <div
                          style={{
                            marginTop: 8,
                            whiteSpace: "pre-wrap",
                            lineHeight: "20px",
                          }}
                        >
                          {st.text}
                        </div>

                        {showRaw && st.meta?.originalText ? (
                          <div
                            style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}
                          >
                            <div style={{ fontWeight: 800, marginBottom: 4 }}>
                              Original:
                            </div>
                            <div style={{ whiteSpace: "pre-wrap" }}>
                              {st.meta.originalText}
                            </div>
                          </div>
                        ) : null}

                        {st.requires?.equipmentIds?.length ? (
                          <div style={{ marginTop: 8 }}>
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 800,
                                opacity: 0.85,
                                marginBottom: 6,
                              }}
                            >
                              Requires
                            </div>
                            <div style={{ display: "flex", flexWrap: "wrap" }}>
                              {st.requires.equipmentIds.map((k) => (
                                <Pill key={k} tone="neutral">
                                  {k}
                                </Pill>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {st.gate?.required ? (
                          <div
                            style={{
                              marginTop: 8,
                              fontSize: 12,
                              opacity: 0.85,
                            }}
                          >
                            <b>Gate:</b>{" "}
                            {st.gate.prompt || "Confirm before continuing."}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}

                {/* Timers list */}
                {stepOut?.timers?.length ? (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontWeight: 800, marginBottom: 6 }}>
                      Timers
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                    >
                      {stepOut.timers.slice(0, 30).map((t) => (
                        <div
                          key={t.id}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 10,
                            border: "1px solid rgba(0,0,0,0.10)",
                            borderRadius: 10,
                            padding: "8px 10px",
                            background: "rgba(255,255,255,0.6)",
                          }}
                        >
                          <div style={{ fontWeight: 700 }}>
                            ⏱ {t.label}{" "}
                            {t.suggested ? (
                              <span style={{ fontSize: 12, opacity: 0.7 }}>
                                (suggested)
                              </span>
                            ) : null}
                          </div>
                          <div style={{ fontSize: 13, opacity: 0.85 }}>
                            {formatSeconds(t.seconds)}{" "}
                            <span style={{ opacity: 0.7 }}>• {t.kind}</span>
                          </div>
                        </div>
                      ))}
                      {stepOut.timers.length > 30 ? (
                        <div style={{ fontSize: 12, opacity: 0.7 }}>
                          Showing first 30 timers.
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {/* Tasks list */}
                {stepOut?.tasks?.length ? (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontWeight: 800, marginBottom: 6 }}>
                      Tasks
                    </div>
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                      }}
                    >
                      {stepOut.tasks.slice(0, 40).map((t) => (
                        <div
                          key={t.id}
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 10,
                            border: "1px solid rgba(0,0,0,0.10)",
                            borderRadius: 10,
                            padding: "8px 10px",
                            background: "rgba(255,255,255,0.6)",
                          }}
                        >
                          <div style={{ fontWeight: 700 }}>
                            {t.kind === "check"
                              ? "✅"
                              : t.kind === "cleanup"
                              ? "🧼"
                              : t.kind === "prep"
                              ? "🔪"
                              : "🍲"}{" "}
                            {t.title}
                            {t.detail ? (
                              <div
                                style={{
                                  fontSize: 12,
                                  opacity: 0.75,
                                  marginTop: 2,
                                }}
                              >
                                {t.detail}
                              </div>
                            ) : null}
                          </div>
                          <div
                            style={{
                              fontSize: 12,
                              opacity: 0.8,
                              textAlign: "right",
                            }}
                          >
                            <div>prio {t.priority}</div>
                            {t.estSeconds ? (
                              <div>{formatSeconds(t.estSeconds)}</div>
                            ) : (
                              <div>&nbsp;</div>
                            )}
                          </div>
                        </div>
                      ))}
                      {stepOut.tasks.length > 40 ? (
                        <div style={{ fontSize: 12, opacity: 0.7 }}>
                          Showing first 40 tasks.
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {stepOut?.report?.warnings?.length ? (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontWeight: 800, marginBottom: 6 }}>
                      Step transform warnings
                    </div>
                    {stepOut.report.warnings.slice(0, 8).map((w, idx) => (
                      <Pill
                        key={idx}
                        tone={w.severity === "error" ? "bad" : "warn"}
                      >
                        {w.message}
                      </Pill>
                    ))}
                  </div>
                ) : null}
              </Section>
            </div>

            {/* Right: signals + doneness + capabilities + finalize */}
            <div>
              <Section
                title="Quick signals"
                subtitle="What SSA extracted to guide adaptation. Toggle evidence to see sources."
                right={
                  <div
                    style={{ display: "flex", gap: 8, alignItems: "center" }}
                  >
                    <Pill tone="neutral">
                      {intake?.extracted?.proteins?.length
                        ? "Protein ✓"
                        : "Protein —"}
                    </Pill>
                    <Pill tone="neutral">
                      {intake?.extracted?.methods?.length
                        ? "Method ✓"
                        : "Method —"}
                    </Pill>
                  </div>
                }
              >
                {!intake ? (
                  <div style={{ opacity: 0.8 }}>
                    No signals yet. Click <b>Re-Parse</b>.
                  </div>
                ) : (
                  <>
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontWeight: 800, marginBottom: 6 }}>
                        Primary
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap" }}>
                        <Pill tone="neutral">
                          Protein:{" "}
                          <b style={{ marginLeft: 6 }}>
                            {intake.signals?.primaryProteinCategory || "—"}
                          </b>
                        </Pill>
                        <Pill tone="neutral">
                          Method:{" "}
                          <b style={{ marginLeft: 6 }}>
                            {intake.signals?.primaryMethod || method || "—"}
                          </b>
                        </Pill>
                        <Pill tone="neutral">
                          Total time:{" "}
                          <b style={{ marginLeft: 6 }}>
                            {intake.signals?.totalTimeSecondsGuess
                              ? formatSeconds(
                                  intake.signals.totalTimeSecondsGuess
                                )
                              : "—"}
                          </b>
                        </Pill>
                      </div>
                    </div>

                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontWeight: 800, marginBottom: 6 }}>
                        Vegetables
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap" }}>
                        {(intake.extracted?.vegetables || [])
                          .slice(0, 10)
                          .map((v, idx) => (
                            <Pill key={`${v.item}_${idx}`} tone="neutral">
                              {v.item}
                            </Pill>
                          ))}
                        {!intake.extracted?.vegetables?.length ? (
                          <span style={{ fontSize: 12, opacity: 0.75 }}>—</span>
                        ) : null}
                      </div>
                    </div>

                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontWeight: 800, marginBottom: 6 }}>
                        Fats
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap" }}>
                        {(intake.extracted?.fats || [])
                          .slice(0, 10)
                          .map((f, idx) => (
                            <Pill key={`${f.item}_${idx}`} tone="neutral">
                              {f.item}
                            </Pill>
                          ))}
                        {!intake.extracted?.fats?.length ? (
                          <span style={{ fontSize: 12, opacity: 0.75 }}>—</span>
                        ) : null}
                      </div>
                    </div>

                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontWeight: 800, marginBottom: 6 }}>
                        Temperatures
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap" }}>
                        {(intake.extracted?.temperatures || [])
                          .slice(0, 8)
                          .map((t, idx) => (
                            <Pill
                              key={`${t.context}_${t.value}_${idx}`}
                              tone="neutral"
                            >
                              {t.context}: {t.value}°{t.unit}
                            </Pill>
                          ))}
                        {!intake.extracted?.temperatures?.length ? (
                          <span style={{ fontSize: 12, opacity: 0.75 }}>—</span>
                        ) : null}
                      </div>
                    </div>

                    {showEvidence && intake.report?.warnings?.length ? (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontWeight: 800, marginBottom: 6 }}>
                          Parse warnings
                        </div>
                        {intake.report.warnings.slice(0, 8).map((w, idx) => (
                          <Pill
                            key={idx}
                            tone={w.severity === "error" ? "bad" : "warn"}
                          >
                            {w.message}
                          </Pill>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </Section>

              <Section
                title="Doneness target"
                subtitle="Confirm the doneness target SSA will use for checks and alerts."
                right={
                  <Pill tone={donenessTone}>
                    {donenessTone === "good" ? "Auto" : "Manual"}
                  </Pill>
                }
              >
                {!donenessUI ? (
                  <div style={{ opacity: 0.8 }}>
                    No doneness info yet. Click <b>Re-Parse</b>.
                  </div>
                ) : (
                  <>
                    <div style={{ display: "flex", flexWrap: "wrap" }}>
                      <Pill tone="neutral">
                        Protein: {donenessUI.inputs.proteinCategory || "—"}
                      </Pill>
                      <Pill tone="neutral">
                        Cut: {donenessUI.inputs.cutTag || "—"}
                      </Pill>
                      <Pill tone="neutral">
                        Method: {donenessUI.inputs.method || method || "—"}
                      </Pill>
                    </div>

                    {donenessUI?.resolved?.target ? (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontWeight: 800, marginBottom: 6 }}>
                          Resolved target
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap" }}>
                          {donenessUI.resolved.target.name ? (
                            <Pill tone="good">
                              {donenessUI.resolved.target.name}
                            </Pill>
                          ) : null}
                          {donenessUI.resolved.target.internalTempF ? (
                            <Pill tone="good">
                              {donenessUI.resolved.target.internalTempF}°F
                            </Pill>
                          ) : null}
                          {donenessUI.resolved.target.internalTempC ? (
                            <Pill tone="good">
                              {donenessUI.resolved.target.internalTempC}°C
                            </Pill>
                          ) : null}
                        </div>
                        {donenessUI.resolved?.notes ? (
                          <div
                            style={{ fontSize: 12, opacity: 0.8, marginTop: 6 }}
                          >
                            {donenessUI.resolved.notes}
                          </div>
                        ) : null}
                      </div>
                    ) : null}

                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 800, marginBottom: 6 }}>
                        Override (optional)
                      </div>
                      <Input
                        label="Target name"
                        value={donenessUI.userOverrides.targetName}
                        onChange={(v) =>
                          setDonenessUI((prev) => ({
                            ...prev,
                            userOverrides: {
                              ...(prev?.userOverrides || {}),
                              targetName: v,
                            },
                          }))
                        }
                        placeholder="e.g., Medium, Well, Tender"
                      />
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "1fr 1fr",
                          gap: 10,
                        }}
                      >
                        <Input
                          label="Internal temp (°F)"
                          type="number"
                          value={donenessUI.userOverrides.internalTempF}
                          onChange={(v) =>
                            setDonenessUI((prev) => ({
                              ...prev,
                              userOverrides: {
                                ...(prev?.userOverrides || {}),
                                internalTempF: v,
                              },
                            }))
                          }
                          placeholder="e.g., 165"
                        />
                        <Input
                          label="Internal temp (°C)"
                          type="number"
                          value={donenessUI.userOverrides.internalTempC}
                          onChange={(v) =>
                            setDonenessUI((prev) => ({
                              ...prev,
                              userOverrides: {
                                ...(prev?.userOverrides || {}),
                                internalTempC: v,
                              },
                            }))
                          }
                          placeholder="e.g., 74"
                        />
                      </div>
                      <TextArea
                        label="Notes"
                        value={donenessUI.userOverrides.notes}
                        onChange={(v) =>
                          setDonenessUI((prev) => ({
                            ...prev,
                            userOverrides: {
                              ...(prev?.userOverrides || {}),
                              notes: v,
                            },
                          }))
                        }
                        rows={3}
                        placeholder="Any safety or preference notes…"
                      />
                    </div>

                    {donenessUI?.warnings?.length ? (
                      <div style={{ marginTop: 8 }}>
                        {donenessUI.warnings.map((w, idx) => (
                          <Pill key={idx} tone="warn">
                            {w}
                          </Pill>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </Section>

              <Section
                title="Kitchen capability check"
                subtitle="We compare the recipe’s required tools to what you have available."
                right={
                  <Pill tone={capTone}>
                    {capTone === "good"
                      ? "All good"
                      : capTone === "warn"
                      ? "Needs review"
                      : "—"}
                  </Pill>
                }
              >
                {!capReport ? (
                  <div style={{ opacity: 0.8 }}>
                    No capability report yet. Click <b>Re-Parse</b>.
                  </div>
                ) : (
                  <>
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontWeight: 800, marginBottom: 6 }}>
                        Missing
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap" }}>
                        {(capReport.missing || []).slice(0, 12).map((m) => (
                          <Pill key={m.key} tone={m.critical ? "bad" : "warn"}>
                            {m.key}
                          </Pill>
                        ))}
                        {!capReport.missing?.length ? (
                          <Pill tone="good">None</Pill>
                        ) : null}
                      </div>
                    </div>

                    {(capReport.substitutions || []).length ? (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontWeight: 800, marginBottom: 6 }}>
                          Substitutions
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                          }}
                        >
                          {capReport.substitutions
                            .slice(0, 10)
                            .map((s, idx) => (
                              <div
                                key={`${s.missingKey}_${s.chosenKey}_${idx}`}
                                style={{
                                  border: "1px solid rgba(0,0,0,0.10)",
                                  borderRadius: 10,
                                  padding: "8px 10px",
                                  background: "rgba(255,255,255,0.6)",
                                }}
                              >
                                <div style={{ fontWeight: 800 }}>
                                  {s.missingKey} → {s.chosenKey}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.8 }}>
                                  confidence{" "}
                                  {Math.round((s.confidence ?? 0.7) * 100)}% •
                                  friction{" "}
                                  {Math.round((s.friction ?? 0.5) * 100)}%
                                </div>
                                {showEvidence && s.notes ? (
                                  <div
                                    style={{
                                      fontSize: 12,
                                      opacity: 0.8,
                                      marginTop: 4,
                                    }}
                                  >
                                    {s.notes}
                                  </div>
                                ) : null}
                              </div>
                            ))}
                        </div>
                      </div>
                    ) : null}

                    {(capReport.methodFallbacks || []).length ? (
                      <div style={{ marginBottom: 8 }}>
                        <div style={{ fontWeight: 800, marginBottom: 6 }}>
                          Method fallbacks
                        </div>
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 6,
                          }}
                        >
                          {capReport.methodFallbacks
                            .slice(0, 6)
                            .map((f, idx) => (
                              <div
                                key={`${f.fromMethod}_${f.toMethod}_${idx}`}
                                style={{
                                  border: "1px solid rgba(0,0,0,0.10)",
                                  borderRadius: 10,
                                  padding: "8px 10px",
                                  background: "rgba(255,255,255,0.6)",
                                }}
                              >
                                <div style={{ fontWeight: 800 }}>
                                  {f.fromMethod} → {f.toMethod}
                                </div>
                                <div style={{ fontSize: 12, opacity: 0.8 }}>
                                  {f.reason}
                                </div>
                              </div>
                            ))}
                        </div>
                      </div>
                    ) : null}

                    {capReport?.warnings?.length && showEvidence ? (
                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontWeight: 800, marginBottom: 6 }}>
                          Notes
                        </div>
                        {capReport.warnings.slice(0, 6).map((w, idx) => (
                          <Pill
                            key={idx}
                            tone={w.severity === "error" ? "bad" : "warn"}
                          >
                            {w.message}
                          </Pill>
                        ))}
                      </div>
                    ) : null}
                  </>
                )}
              </Section>

              <Section
                title="Finalize"
                subtitle="Save the adapted recipe (optional) and generate a session-ready plan."
              >
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button
                    onClick={handleSaveVariant}
                    disabled={busy}
                    title="Save the adapted recipe (variant)"
                  >
                    Save variant
                  </Button>
                  <Button
                    onClick={runAdapterPipeline}
                    disabled={busy}
                    title="Generate/refresh variant + cook plan"
                  >
                    Refresh cook plan
                  </Button>
                  <Button
                    tone="primary"
                    onClick={handleStart}
                    disabled={busy}
                    title="Start SessionRunner with this cook plan"
                  >
                    Start session
                  </Button>
                </div>

                {adapterOut?.variant ? (
                  <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
                    <div>
                      <b>Variant:</b> {adapterOut.variant.id || "—"}{" "}
                      <span style={{ opacity: 0.7 }}>
                        •{" "}
                        {adapterOut.variant.title ||
                          adapterOut.variant.name ||
                          "—"}
                      </span>
                    </div>
                    {adapterOut.cookPlan ? (
                      <div>
                        <b>CookPlan:</b> {adapterOut.cookPlan.id || "—"}{" "}
                        <span style={{ opacity: 0.7 }}>
                          • steps{" "}
                          {adapterOut.cookPlan?.timeline?.length ??
                            adapterOut.cookPlan?.steps?.length ??
                            "—"}
                        </span>
                      </div>
                    ) : (
                      <div style={{ opacity: 0.75 }}>
                        CookPlan not generated yet.
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                    No variant yet. Click <b>Adapt to Kitchen</b> to generate
                    one.
                  </div>
                )}

                {adapterOut?.report?.warnings?.length && showEvidence ? (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontWeight: 800, marginBottom: 6 }}>
                      Adapter warnings
                    </div>
                    {adapterOut.report.warnings.slice(0, 10).map((w, idx) => (
                      <Pill
                        key={idx}
                        tone={w.severity === "error" ? "bad" : "warn"}
                      >
                        {w.message}
                      </Pill>
                    ))}
                  </div>
                ) : null}
              </Section>
            </div>
          </div>

          {/* Footer */}
          <div style={{ marginTop: 8, opacity: 0.7, fontSize: 12 }}>
            Tip: if a tool is missing, accept a substitution or choose a method
            fallback, then click <b>Adapt to Kitchen</b> again.
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function formatSeconds(seconds) {
  const s = clampInt(seconds, 0, 7 * 24 * 3600, 0);
  if (!s) return "0s";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (sec && !h) parts.push(`${sec}s`); // hide seconds when hours present
  return parts.join(" ");
}
