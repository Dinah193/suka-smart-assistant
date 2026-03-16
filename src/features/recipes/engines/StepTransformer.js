/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\features\recipes\engines\StepTransformer.js
//
// SSA • StepTransformer
// -----------------------------------------------------------------------------
// Purpose:
//   Convert recipe steps (raw/imported/manual) into SSA "adapted steps" plus:
//     - inferred timers
//     - inferred prep/cook/cleanup tasks
//     - required capability hints (equipment/methods)
//     - doneness/target attachment hints
//     - safe, explainable normalization for CookSetupModal + CookPlan compiler
//
// This is a deterministic engine (no AI required) and is designed to be called by:
//   - RecipeAdapterService (during recipe -> variant adaptation)
//   - CookSetupModal (when user edits steps; re-transform quickly)
//   - CookPlan compiler (as a preflight pass)
//
// Input shapes supported:
//   steps: string | string[] | [{text|instruction|step|title, ...}]
//
// Output:
//   {
//     ok: true,
//     adaptedSteps: [AdaptedStep],
//     timers: [Timer],
//     tasks: [Task],
//     report: { warnings, notes, flags, decisions }
//   }
//
// Notes:
//   - This module intentionally does not depend on external NLP libraries.
//   - If you have a richer Task schema elsewhere, you can map our Task objects.
// -----------------------------------------------------------------------------
//
// Optional integration points (supported but not required):
//   - ToolSubstitutionRules.catalog.js stepRewriteHints
//   - DonenessResolver / DonenessTargetsCatalog for attaching targets
//
// -----------------------------------------------------------------------------
// SSA style: production-ready, exhaustive defensive coding (no placeholders).

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

const ENGINE_ID = "features/recipes/engines/StepTransformer";
const ENGINE_VERSION = "1.0.0";

const DEFAULTS = Object.freeze({
  maxSteps: 250,
  maxTimers: 250,
  maxTasks: 500,

  // If true, add a default step when none exist.
  ensureAtLeastOneStep: true,

  // Rewrite hints may replace tool names etc.
  allowStepTextRewrite: true,

  // Timer inference knobs
  allowTimerInference: true,
  allowTimerGuessForImplicitPhases: true, // e.g., "preheat oven" -> timer suggestion

  // Task inference knobs
  allowTaskInference: true,

  // Step kind inference
  defaultMethod: "bake",

  // Safety for step text and notes
  maxTextLen: 8000,
  maxTitleLen: 200,
  maxNotesLen: 2000,
});

/* -------------------------------------------------------------------------- */
/* Utilities                                                                   */
/* -------------------------------------------------------------------------- */

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function safeLower(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : "";
}

function safeString(s, max = 256, fallback = "") {
  if (typeof s !== "string") return fallback;
  const t = s.trim();
  return t ? t.slice(0, max) : fallback;
}

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(arr) ? arr : []) {
    const s = typeof v === "string" ? v.trim() : "";
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  const y = Math.round(x);
  if (y < min) return min;
  if (y > max) return max;
  return y;
}

function clamp01(n, fallback = 0.7) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function nowISO() {
  return new Date().toISOString();
}

function randId(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now()}`;
}

function escapeRegExp(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* -------------------------------------------------------------------------- */
/* Report helpers                                                              */
/* -------------------------------------------------------------------------- */

function createReport(options) {
  return {
    ok: true,
    engine: { id: ENGINE_ID, version: ENGINE_VERSION },
    startedAt: nowISO(),
    finishedAt: null,
    flags: [],
    notes: [],
    warnings: [],
    decisions: [],
    limits: {
      maxSteps: options.maxSteps,
      maxTimers: options.maxTimers,
      maxTasks: options.maxTasks,
    },
  };
}

function addWarning(report, w) {
  if (!report) return;
  if (!Array.isArray(report.warnings)) report.warnings = [];
  if (report.warnings.length >= 200) return;

  if (typeof w === "string") {
    report.warnings.push({
      code: "warning",
      message: w,
      severity: "warn",
      context: {},
    });
    return;
  }

  report.warnings.push({
    code: safeString(w?.code, 128, "warning"),
    message: safeString(w?.message, 2000, "Warning"),
    severity: ["info", "warn", "error"].includes(w?.severity)
      ? w.severity
      : "warn",
    context: isPlainObject(w?.context) ? w.context : {},
  });
}

function note(report, msg) {
  if (!report) return;
  if (!Array.isArray(report.notes)) report.notes = [];
  const m = safeString(msg, 2000, "");
  if (!m) return;
  report.notes.push(m);
}

function decision(report, d) {
  if (!report) return;
  if (!Array.isArray(report.decisions)) report.decisions = [];
  report.decisions.push({ at: nowISO(), ...d });
}

/* -------------------------------------------------------------------------- */
/* Step input normalization                                                    */
/* -------------------------------------------------------------------------- */

function normalizeRawSteps(stepsInput) {
  // Accept string, array, array of objects
  const out = [];

  const pushText = (t) => {
    if (typeof t !== "string") return;
    const s = t.trim();
    if (!s) return;
    out.push(s);
  };

  if (typeof stepsInput === "string") {
    stepsInput
      .split(/\n+/g)
      .map((x) => x.trim())
      .filter(Boolean)
      .forEach((x) => out.push(x));
    return out;
  }

  if (Array.isArray(stepsInput)) {
    for (const it of stepsInput) {
      if (typeof it === "string") pushText(it);
      else if (isPlainObject(it)) {
        const text =
          it.text ??
          it.instruction ??
          it.step ??
          it.direction ??
          it.directions ??
          it.title ??
          it.label ??
          "";
        pushText(String(text || ""));
      }
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Rewrite hints                                                               */
/* -------------------------------------------------------------------------- */

function applyRewriteHints(text, rewriteHints) {
  let out = String(text || "");
  let appended = "";

  for (const h of Array.isArray(rewriteHints) ? rewriteHints : []) {
    if (!isPlainObject(h)) continue;
    const findAny = uniqStrings(h.findAny);
    const replaceWith = typeof h.replaceWith === "string" ? h.replaceWith : "";
    const addNotes = typeof h.addNotes === "string" ? h.addNotes : "";

    if (findAny.length && replaceWith) {
      for (const token of findAny) {
        const re = new RegExp(`\\b${escapeRegExp(token)}\\b`, "i");
        if (re.test(out)) {
          out = out.replace(re, replaceWith);
          break;
        }
      }
    }
    if (addNotes) appended += (appended ? " " : "") + addNotes.trim();
  }

  if (appended) out = `${out}${out.endsWith(".") ? "" : "."} ${appended}`;
  return out.trim();
}

/* -------------------------------------------------------------------------- */
/* Step kind inference                                                         */
/* -------------------------------------------------------------------------- */

function inferKind(text) {
  const t = safeLower(text);
  if (!t) return "cook";

  // prep
  if (
    t.includes("preheat") ||
    t.includes("chop") ||
    t.includes("slice") ||
    t.includes("dice") ||
    t.includes("mince") ||
    t.includes("peel") ||
    t.includes("rinse") ||
    t.includes("wash") ||
    t.includes("mix") ||
    t.includes("whisk") ||
    t.includes("stir together") ||
    t.includes("marinate") ||
    t.includes("season") ||
    t.includes("rub") ||
    t.includes("measure")
  ) {
    return "prep";
  }

  // cook
  if (
    t.includes("bake") ||
    t.includes("roast") ||
    t.includes("broil") ||
    t.includes("grill") ||
    t.includes("sear") ||
    t.includes("saute") ||
    t.includes("sauté") ||
    t.includes("simmer") ||
    t.includes("boil") ||
    t.includes("poach") ||
    t.includes("fry") ||
    t.includes("air fry") ||
    t.includes("air-fry") ||
    t.includes("pressure cook") ||
    t.includes("slow cook") ||
    t.includes("microwave")
  ) {
    return "cook";
  }

  // rest
  if (t.includes("rest") || t.includes("cool") || t.includes("let stand"))
    return "rest";

  // serve
  if (t.includes("serve") || t.includes("plate") || t.includes("garnish"))
    return "serve";

  // cleanup
  if (
    t.includes("clean") ||
    t.includes("wash dishes") ||
    t.includes("wipe") ||
    t.includes("sanitize")
  )
    return "cleanup";

  return "cook";
}

function inferTitle(text, order) {
  const kind = inferKind(text);
  if (kind === "prep") return "Prep";
  if (kind === "rest") return "Rest";
  if (kind === "serve") return "Serve";
  if (kind === "cleanup") return "Cleanup";

  const t = safeLower(text);
  if (t.includes("preheat")) return "Preheat";
  if (t.includes("bake")) return "Bake";
  if (t.includes("roast")) return "Roast";
  if (t.includes("broil")) return "Broil";
  if (t.includes("grill")) return "Grill";
  if (t.includes("sear")) return "Sear";
  if (t.includes("simmer")) return "Simmer";
  if (t.includes("boil")) return "Boil";
  if (t.includes("fry")) return "Fry";

  return `Step ${order}`;
}

/* -------------------------------------------------------------------------- */
/* Requires inference (capability hints)                                       */
/* -------------------------------------------------------------------------- */

function inferRequires(text, methodDefault) {
  const t = safeLower(text);
  const equipmentIds = [];
  const methods = [];

  const pushEq = (k) => {
    if (!k) return;
    if (equipmentIds.includes(k)) return;
    equipmentIds.push(k);
  };
  const pushMethod = (m) => {
    if (!m) return;
    if (methods.includes(m)) return;
    methods.push(m);
  };

  // equipment
  if (
    t.includes("oven") ||
    t.includes("preheat") ||
    t.includes("bake") ||
    t.includes("roast") ||
    t.includes("broil")
  )
    pushEq("appliance:oven");
  if (t.includes("air fry") || t.includes("air-fry"))
    pushEq("appliance:air_fryer");
  if (t.includes("microwave")) pushEq("appliance:microwave");
  if (
    t.includes("stovetop") ||
    t.includes("skillet") ||
    t.includes("pan") ||
    t.includes("burner")
  )
    pushEq("appliance:stovetop");
  if (t.includes("grill") || t.includes("smoker")) pushEq("appliance:grill");
  if (
    t.includes("slow cooker") ||
    t.includes("crockpot") ||
    t.includes("crock pot")
  )
    pushEq("appliance:slow_cooker");
  if (t.includes("pressure cooker") || t.includes("instant pot"))
    pushEq("appliance:pressure_cooker");
  if (t.includes("sous vide")) pushEq("appliance:sous_vide");

  // cookware hints
  if (t.includes("sheet pan") || t.includes("baking sheet"))
    pushEq("cookware:sheet_pan");
  if (t.includes("dutch oven")) pushEq("cookware:dutch_oven");
  if (t.includes("stock pot") || t.includes("stockpot"))
    pushEq("cookware:stock_pot");
  if (t.includes("skillet")) pushEq("cookware:skillet");
  if (t.includes("wok")) pushEq("cookware:wok");

  // utensils
  if (
    t.includes("thermometer") ||
    t.includes("internal temp") ||
    t.includes("°f") ||
    t.includes("degrees")
  )
    pushEq("utensil:instant_read_thermometer");
  if (t.includes("timer")) pushEq("utensil:timer");
  if (t.includes("tongs")) pushEq("utensil:tongs");
  if (t.includes("whisk")) pushEq("utensil:whisk");
  if (t.includes("spatula")) pushEq("utensil:spatula");
  if (t.includes("knife")) pushEq("utensil:knife");
  if (t.includes("cutting board")) pushEq("utensil:cutting_board");

  // infer methods from verbs; else default method
  if (t.includes("bake") || t.includes("roast") || t.includes("broil"))
    pushMethod(
      t.includes("broil") ? "broil" : t.includes("roast") ? "roast" : "bake"
    );
  if (t.includes("air fry") || t.includes("air-fry")) pushMethod("air_fry");
  if (t.includes("grill")) pushMethod("grill");
  if (t.includes("sear")) pushMethod("pan_sear");
  if (t.includes("saute") || t.includes("sauté")) pushMethod("saute");
  if (t.includes("stir-fry") || t.includes("stir fry") || t.includes("wok"))
    pushMethod("stir_fry");
  if (t.includes("boil")) pushMethod("boil");
  if (t.includes("simmer")) pushMethod("simmer");
  if (t.includes("poach")) pushMethod("poach");
  if (t.includes("deep fry") || (t.includes("fry") && t.includes("oil")))
    pushMethod("deep_fry");
  if (t.includes("pressure cook") || t.includes("instant pot"))
    pushMethod("pressure_cook");
  if (t.includes("slow cook") || t.includes("crockpot"))
    pushMethod("slow_cook");
  if (t.includes("microwave")) pushMethod("microwave");
  if (t.includes("sous vide")) pushMethod("sous_vide");

  if (!methods.length)
    pushMethod(safeLower(methodDefault || DEFAULTS.defaultMethod));

  return {
    equipmentIds: uniqStrings(equipmentIds),
    methods: uniqStrings(methods),
  };
}

/* -------------------------------------------------------------------------- */
/* Timer inference                                                             */
/* -------------------------------------------------------------------------- */

function parseDurationSeconds(text) {
  // Extract durations from text.
  // Supports:
  //  - "20 minutes", "1 hour", "90 sec"
  //  - ranges: "20-25 minutes" -> use midpoint
  //  - "1 1/2 hours" (very basic)
  const t = safeLower(text);

  // range: 20-25 minutes
  const range = t.match(
    /(\d+)\s*-\s*(\d+)\s*(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours)\b/
  );
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    const unit = range[3];
    const mid = (a + b) / 2;
    return clampInt(toSeconds(mid, unit), 1, 7 * 24 * 3600, 0);
  }

  // mixed fraction: "1 1/2 hours"
  const mixed = t.match(
    /(\d+)\s+(\d+)\/(\d+)\s*(hr|hrs|hour|hours|min|mins|minute|minutes)\b/
  );
  if (mixed) {
    const whole = Number(mixed[1]);
    const num = Number(mixed[2]);
    const den = Number(mixed[3]) || 1;
    const unit = mixed[4];
    const val = whole + num / den;
    return clampInt(toSeconds(val, unit), 1, 7 * 24 * 3600, 0);
  }

  const hh = t.match(/(\d+)\s*(hr|hrs|hour|hours)\b/);
  const mm = t.match(/(\d+)\s*(min|mins|minute|minutes)\b/);
  const ss = t.match(/(\d+)\s*(sec|secs|second|seconds)\b/);

  let seconds = 0;
  if (hh) seconds += toSeconds(Number(hh[1]), hh[2]);
  if (mm) seconds += toSeconds(Number(mm[1]), mm[2]);
  if (ss) seconds += toSeconds(Number(ss[1]), ss[2]);

  return seconds > 0 ? clampInt(seconds, 1, 7 * 24 * 3600, 0) : 0;
}

function toSeconds(val, unit) {
  const u = safeLower(unit);
  if (u.startsWith("hr") || u.startsWith("hour")) return Math.round(val * 3600);
  if (u.startsWith("min") || u.startsWith("minute"))
    return Math.round(val * 60);
  return Math.round(val);
}

function inferTimerKind(text, stepKind) {
  const t = safeLower(text);
  if (t.includes("rest") || t.includes("cool") || t.includes("let stand"))
    return "rest";
  if (t.includes("preheat") || stepKind === "prep") return "prep";
  if (t.includes("marinate")) return "rest";
  if (
    t.includes("bake") ||
    t.includes("roast") ||
    t.includes("grill") ||
    t.includes("simmer") ||
    stepKind === "cook"
  )
    return "cook";
  return "timer";
}

function inferTimersForStep(step) {
  const seconds = parseDurationSeconds(step.text);
  if (!seconds) return [];

  const kind = inferTimerKind(step.text, step.kind);
  const labelBase =
    kind === "prep"
      ? "Prep timer"
      : kind === "rest"
      ? "Rest timer"
      : kind === "cook"
      ? "Cook timer"
      : "Timer";

  return [
    {
      id: randId("timer"),
      label: `${labelBase}`,
      seconds,
      kind,
      stepId: step.id,
      startsAfterStepId: null,
      notes: "",
    },
  ];
}

function inferImplicitTimers(step) {
  // If no explicit duration, propose a *suggested* timer for common phases.
  const t = safeLower(step.text);
  if (t.includes("preheat")) {
    // default preheat suggestion
    return [
      {
        id: randId("timer"),
        label: "Preheat (suggested)",
        seconds: 10 * 60,
        kind: "prep",
        stepId: step.id,
        startsAfterStepId: null,
        notes: "Suggested timer; adjust based on your appliance.",
        suggested: true,
      },
    ];
  }
  if (t.includes("rest") && !t.match(/\d+/)) {
    return [
      {
        id: randId("timer"),
        label: "Rest (suggested)",
        seconds: 10 * 60,
        kind: "rest",
        stepId: step.id,
        startsAfterStepId: null,
        notes: "Suggested timer; adjust for your cut/size.",
        suggested: true,
      },
    ];
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Task inference                                                              */
/* -------------------------------------------------------------------------- */

function inferTasksForStep(step) {
  // Task objects are SSA-friendly but generic:
  // { id, kind, title, detail, stepId, estSeconds, priority, tags }
  const tasks = [];
  const t = safeLower(step.text);

  const push = (
    kind,
    title,
    detail = "",
    estSeconds = 0,
    priority = 3,
    tags = []
  ) => {
    tasks.push({
      id: randId("task"),
      kind,
      title: safeString(title, 200, title),
      detail: safeString(detail, 2000, ""),
      stepId: step.id,
      estSeconds: clampInt(estSeconds, 0, 7 * 24 * 3600, 0),
      priority: clampInt(priority, 1, 5, 3),
      tags: uniqStrings(tags).map((x) => safeLower(x)),
      createdAt: nowISO(),
      source: ENGINE_ID,
    });
  };

  // Prep tasks
  if (step.kind === "prep") {
    if (t.includes("preheat"))
      push("prep", "Preheat appliance", step.text, 0, 3, ["prep", "heat"]);
    if (
      t.includes("chop") ||
      t.includes("dice") ||
      t.includes("slice") ||
      t.includes("mince")
    )
      push("prep", "Chop / prep ingredients", step.text, 0, 3, ["prep"]);
    if (t.includes("mix") || t.includes("whisk") || t.includes("stir together"))
      push("prep", "Mix ingredients", step.text, 0, 3, ["prep"]);
    if (t.includes("marinate"))
      push("prep", "Marinate", step.text, 0, 2, ["prep", "rest"]);
    if (t.includes("season") || t.includes("rub"))
      push("prep", "Season", step.text, 0, 3, ["prep"]);
  }

  // Cook tasks
  if (step.kind === "cook") {
    if (t.includes("bake"))
      push("cook", "Bake", step.text, 0, 4, ["cook", "oven"]);
    else if (t.includes("roast"))
      push("cook", "Roast", step.text, 0, 4, ["cook", "oven"]);
    else if (t.includes("broil"))
      push("cook", "Broil", step.text, 0, 4, ["cook", "oven"]);
    else if (t.includes("grill"))
      push("cook", "Grill", step.text, 0, 4, ["cook", "grill"]);
    else if (t.includes("sear"))
      push("cook", "Sear", step.text, 0, 4, ["cook", "stovetop"]);
    else if (t.includes("simmer"))
      push("cook", "Simmer", step.text, 0, 4, ["cook", "stovetop"]);
    else if (t.includes("boil"))
      push("cook", "Boil", step.text, 0, 4, ["cook", "stovetop"]);
    else if (t.includes("fry"))
      push("cook", "Fry", step.text, 0, 4, ["cook", "stovetop"]);
    else push("cook", "Cook", step.text, 0, 4, ["cook"]);
  }

  // Rest tasks
  if (step.kind === "rest") {
    push("rest", "Rest / cool", step.text, 0, 2, ["rest"]);
  }

  // Serve tasks
  if (step.kind === "serve") {
    push("serve", "Serve", step.text, 0, 2, ["serve"]);
  }

  // Cleanup tasks
  if (step.kind === "cleanup") {
    push("cleanup", "Cleanup", step.text, 0, 1, ["cleanup"]);
  }

  // Doneness check task if thermometer cues
  if (
    t.includes("thermometer") ||
    t.includes("internal temp") ||
    t.includes("°f") ||
    t.includes("degrees")
  ) {
    push(
      "check",
      "Check doneness (temperature)",
      "Use a thermometer and confirm target.",
      0,
      5,
      ["doneness", "safety"]
    );
  } else if (
    t.includes("until") &&
    (t.includes("golden") ||
      t.includes("tender") ||
      t.includes("done") ||
      t.includes("opaque") ||
      t.includes("flakes"))
  ) {
    push(
      "check",
      "Check doneness (visual/texture)",
      "Confirm cue-based doneness before proceeding.",
      0,
      4,
      ["doneness"]
    );
  }

  return tasks;
}

/* -------------------------------------------------------------------------- */
/* Gate inference                                                              */
/* -------------------------------------------------------------------------- */

function inferGate(text) {
  const t = safeLower(text);
  if (
    t.includes("until") &&
    (t.includes("golden") ||
      t.includes("tender") ||
      t.includes("done") ||
      t.includes("opaque") ||
      t.includes("flakes"))
  ) {
    return {
      required: true,
      prompt: "Confirm doneness cue before continuing.",
    };
  }
  if (
    t.includes("internal") &&
    (t.includes("temp") || t.includes("°f") || t.includes("degrees"))
  ) {
    return {
      required: true,
      prompt: "Confirm internal temperature target before continuing.",
    };
  }
  return { required: false, prompt: "" };
}

/* -------------------------------------------------------------------------- */
/* Main transform                                                              */
/* -------------------------------------------------------------------------- */

function transformSteps(input = {}) {
  const options = normalizeOptions(input.options);
  const report = createReport(options);

  const methodDefault = safeLower(
    input.method || options.defaultMethod || DEFAULTS.defaultMethod
  );

  const rawSteps = normalizeRawSteps(
    input.steps ?? input.rawSteps ?? input.instructions ?? []
  );
  const rewriteHints = collectRewriteHints(
    input.rewriteHints || input.stepRewriteHints || input.toolSubstitutions
  );

  if (!rawSteps.length && options.ensureAtLeastOneStep) {
    rawSteps.push("Follow the recipe steps and monitor doneness targets.");
    report.flags.push("default_step_generated");
    addWarning(report, {
      code: "steps_missing",
      message: "No steps provided; generated a default step.",
      severity: "warn",
    });
  }

  if (rawSteps.length > options.maxSteps) {
    addWarning(report, {
      code: "steps_truncated",
      message: `Steps truncated from ${rawSteps.length} to ${options.maxSteps}.`,
      severity: "warn",
      context: { original: rawSteps.length, max: options.maxSteps },
    });
    report.flags.push("steps_truncated");
  }

  const trimmed = rawSteps.slice(0, options.maxSteps);

  const adaptedSteps = [];
  const timers = [];
  const tasks = [];

  for (let i = 0; i < trimmed.length; i += 1) {
    const original = String(trimmed[i] || "").trim();
    if (!original) continue;

    const rewritten =
      options.allowStepTextRewrite && rewriteHints.length
        ? applyRewriteHints(original, rewriteHints)
        : original;

    const text = safeString(rewritten, options.maxTextLen, "");
    const kind = inferKind(text);
    const title = safeString(
      inferTitle(text, i + 1),
      options.maxTitleLen,
      `Step ${i + 1}`
    );

    const step = {
      id: randId("step"),
      order: adaptedSteps.length + 1,
      kind,
      title,
      text,
      estimatedSeconds: 0, // populated from explicit duration when available
      requires: inferRequires(text, methodDefault),
      notes: "",
      gate: inferGate(text),
      meta: {
        source: ENGINE_ID,
        originalText: safeString(original, 1200, original),
      },
    };

    // Estimate seconds from explicit duration if present
    const explicitSeconds = parseDurationSeconds(text);
    if (explicitSeconds > 0) step.estimatedSeconds = explicitSeconds;

    adaptedSteps.push(step);

    // Timers
    if (options.allowTimerInference) {
      const inferred = inferTimersForStep(step);
      for (const tmr of inferred) {
        if (timers.length >= options.maxTimers) break;
        timers.push(tmr);
      }
      if (!explicitSeconds && options.allowTimerGuessForImplicitPhases) {
        const suggested = inferImplicitTimers(step);
        for (const tmr of suggested) {
          if (timers.length >= options.maxTimers) break;
          timers.push(tmr);
        }
      }
    }

    // Tasks
    if (options.allowTaskInference) {
      const inferredTasks = inferTasksForStep(step);
      for (const tk of inferredTasks) {
        if (tasks.length >= options.maxTasks) break;
        tasks.push(tk);
      }
    }
  }

  // Link timers to steps (step.timers[] ids)
  const timersByStep = new Map();
  for (const tmr of timers) {
    const sid = tmr.stepId;
    if (!sid) continue;
    if (!timersByStep.has(sid)) timersByStep.set(sid, []);
    timersByStep.get(sid).push(tmr.id);
  }

  for (const st of adaptedSteps) {
    const ids = timersByStep.get(st.id) || [];
    st.timers = uniqStrings(ids);
  }

  // Quick sanity and report notes
  if (!adaptedSteps.length) {
    report.ok = false;
    addWarning(report, {
      code: "no_steps",
      message: "No adapted steps could be produced.",
      severity: "error",
    });
  }

  if (timers.length >= options.maxTimers) {
    addWarning(report, {
      code: "timers_truncated",
      message: `Timers truncated to ${options.maxTimers}.`,
      severity: "warn",
    });
    report.flags.push("timers_truncated");
  }

  if (tasks.length >= options.maxTasks) {
    addWarning(report, {
      code: "tasks_truncated",
      message: `Tasks truncated to ${options.maxTasks}.`,
      severity: "warn",
    });
    report.flags.push("tasks_truncated");
  }

  // Decisions summary
  decision(report, {
    type: "transform_summary",
    message: `Adapted ${adaptedSteps.length} step(s), inferred ${timers.length} timer(s), inferred ${tasks.length} task(s).`,
    context: {
      steps: adaptedSteps.length,
      timers: timers.length,
      tasks: tasks.length,
    },
  });

  report.finishedAt = nowISO();

  return {
    ok: report.ok,
    adaptedSteps,
    timers,
    tasks,
    report,
  };
}

/* -------------------------------------------------------------------------- */
/* Rewrite hints collector                                                     */
/* -------------------------------------------------------------------------- */

function collectRewriteHints(source) {
  // source may be:
  //  - array of hint objects
  //  - array of substitutions (each may include stepRewriteHints)
  //  - a single substitution or object with stepRewriteHints
  const hints = [];

  const addHint = (h) => {
    if (!isPlainObject(h)) return;
    const findAny = uniqStrings(h.findAny);
    const replaceWith = typeof h.replaceWith === "string" ? h.replaceWith : "";
    const addNotes = typeof h.addNotes === "string" ? h.addNotes : "";
    if (!findAny.length && !replaceWith && !addNotes) return;
    hints.push({ findAny, replaceWith, addNotes });
  };

  if (Array.isArray(source)) {
    for (const it of source) {
      if (isPlainObject(it) && Array.isArray(it.stepRewriteHints)) {
        for (const h of it.stepRewriteHints) addHint(h);
      } else {
        addHint(it);
      }
    }
  } else if (isPlainObject(source)) {
    if (Array.isArray(source.stepRewriteHints)) {
      for (const h of source.stepRewriteHints) addHint(h);
    } else {
      addHint(source);
    }
  }

  // De-dup by signature
  const seen = new Set();
  const out = [];
  for (const h of hints) {
    const sig = `${(h.findAny || []).join("|")}::${h.replaceWith || ""}::${
      h.addNotes || ""
    }`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(h);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Options                                                                     */
/* -------------------------------------------------------------------------- */

function normalizeOptions(options) {
  const o = isPlainObject(options) ? options : {};
  return {
    maxSteps: clampInt(
      o.maxSteps ?? DEFAULTS.maxSteps,
      1,
      2000,
      DEFAULTS.maxSteps
    ),
    maxTimers: clampInt(
      o.maxTimers ?? DEFAULTS.maxTimers,
      0,
      2000,
      DEFAULTS.maxTimers
    ),
    maxTasks: clampInt(
      o.maxTasks ?? DEFAULTS.maxTasks,
      0,
      5000,
      DEFAULTS.maxTasks
    ),

    ensureAtLeastOneStep:
      typeof o.ensureAtLeastOneStep === "boolean"
        ? o.ensureAtLeastOneStep
        : DEFAULTS.ensureAtLeastOneStep,

    allowStepTextRewrite:
      typeof o.allowStepTextRewrite === "boolean"
        ? o.allowStepTextRewrite
        : DEFAULTS.allowStepTextRewrite,

    allowTimerInference:
      typeof o.allowTimerInference === "boolean"
        ? o.allowTimerInference
        : DEFAULTS.allowTimerInference,

    allowTimerGuessForImplicitPhases:
      typeof o.allowTimerGuessForImplicitPhases === "boolean"
        ? o.allowTimerGuessForImplicitPhases
        : DEFAULTS.allowTimerGuessForImplicitPhases,

    allowTaskInference:
      typeof o.allowTaskInference === "boolean"
        ? o.allowTaskInference
        : DEFAULTS.allowTaskInference,

    defaultMethod: safeLower(o.defaultMethod || DEFAULTS.defaultMethod),

    maxTextLen: clampInt(
      o.maxTextLen ?? DEFAULTS.maxTextLen,
      100,
      20000,
      DEFAULTS.maxTextLen
    ),
    maxTitleLen: clampInt(
      o.maxTitleLen ?? DEFAULTS.maxTitleLen,
      40,
      500,
      DEFAULTS.maxTitleLen
    ),
    maxNotesLen: clampInt(
      o.maxNotesLen ?? DEFAULTS.maxNotesLen,
      200,
      8000,
      DEFAULTS.maxNotesLen
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

const StepTransformer = Object.freeze({
  engine: { id: ENGINE_ID, version: ENGINE_VERSION },
  transformSteps,
  normalizeRawSteps,
  collectRewriteHints,
});

export {
  StepTransformer,
  ENGINE_ID,
  ENGINE_VERSION,
  transformSteps,
  normalizeRawSteps,
  collectRewriteHints,
};
export default StepTransformer;
