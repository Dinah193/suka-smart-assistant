// File: C:\Users\larho\suka-smart-assistant\src\reasoner\prompts\builder.js
/**
 * Reasoner Prompt Builder (Browser-safe)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Build a high-signal prompt for a given Reasoner "mode" using:
 *      • mode configuration (schema/constraints)
 *      • user input (freshInput)
 *      • Dexie-derived context (domain context)
 *      • runtime flags (budget, freshness, verbosity)
 *
 * Design goals (SSA)
 *  - Deterministic, low-AI / "fixed" feel: prompt is structured + repeatable.
 *  - Browser safe (Vite): no fs/path/node:* imports.
 *  - Resilient: works even if mode registry is incomplete.
 *
 * Export
 *  - buildPromptForMode({ mode, input, context, runtime }) -> string
 *
 * Notes
 *  - Your shims sometimes import a different builder path under /agents/runtime.
 *    This file exists under /src/reasoner/prompts so older imports won’t break.
 *  - If you ALSO have /src/agents/runtime/reasoner/prompts/builder.js, keep both:
 *    this one can act as the public "compat" builder used by /src/reasoner.
 */

import { getModeConfig } from "@/reasoner/modes/registry";
import {
  sanitizeForPrompt,
  stableStringify,
} from "@/reasoner/utils/promptUtils";

/**
 * @typedef {Object} BuildPromptArgs
 * @property {string} mode
 * @property {any} input
 * @property {any} context
 * @property {any} runtime
 */

/**
 * @param {BuildPromptArgs} args
 * @returns {Promise<string>}
 */
export async function buildPromptForMode(args) {
  const mode = String(args?.mode || "").trim();
  const input = args?.input ?? {};
  const context = args?.context ?? {};
  const runtime = args?.runtime ?? {};

  const cfg = safeGetModeConfig(mode);

  // System instruction: stable, safety + deterministic formatting.
  const system = buildSystemInstruction(cfg, runtime);

  // Mode card: what the mode is, goals, output schema, and constraints.
  const modeCard = buildModeCard(mode, cfg, runtime);

  // Context card: only the bits we want the model to consider.
  const contextCard = buildContextCard(mode, context, runtime);

  // Input card: user request / shim input.
  const inputCard = buildInputCard(input, runtime);

  // Output contract: strict JSON-only response.
  const outputContract = buildOutputContract(mode, cfg, runtime);

  // Add SSA "fixed" reasoning rubric: deterministic steps for repeatable outputs.
  const rubric = buildReasoningRubric(cfg, runtime);

  // Compose final prompt
  const prompt = [
    system,
    "",
    modeCard,
    "",
    contextCard,
    "",
    inputCard,
    "",
    rubric,
    "",
    outputContract,
  ]
    .filter(Boolean)
    .join("\n");

  return prompt;
}

export default buildPromptForMode;

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

function safeGetModeConfig(mode) {
  try {
    const cfg = getModeConfig?.(mode);
    return cfg && typeof cfg === "object" ? cfg : {};
  } catch {
    return {};
  }
}

function buildSystemInstruction(cfg, runtime) {
  const now = new Date().toISOString();
  const verbosity = runtime?.verbosity || cfg?.verbosity || "balanced";

  const style = [
    "You are the SSA Reasoner (structured planner) embedded in a household stewardship system.",
    "You must respond with STRICT JSON only (no markdown, no prose outside JSON).",
    "Be deterministic: prefer stable, repeatable outputs over creative variance.",
    "If information is missing, ask for it using the response schema's 'questions' field (if available) or include warnings and assumptions.",
    "Never hallucinate external facts (prices, weather, dates, laws, product specs) unless explicitly provided in input/context.",
    "Prefer actionable steps that can be executed by household workflows (calendar, inventory, storehouse, tasks).",
  ];

  if (verbosity === "concise") {
    style.push("Keep fields minimal and avoid long explanations.");
  } else if (verbosity === "detailed") {
    style.push(
      "Provide more detail in recommendations and logs while staying within schema."
    );
  }

  if (runtime?.strictJson !== false) {
    style.push("Return JSON that can be parsed by JSON.parse without error.");
  }

  // Optional: include model-side constraints (token budget hints)
  const budgetLine =
    runtime?.budget?.maxTokens || cfg?.budget?.maxTokens
      ? `Budget: keep response under ~${
          runtime?.budget?.maxTokens || cfg?.budget?.maxTokens
        } tokens if possible.`
      : "";

  return ["SYSTEM", `Timestamp: ${now}`, ...style, budgetLine]
    .filter(Boolean)
    .join("\n");
}

function buildModeCard(mode, cfg, runtime) {
  const title = cfg?.title || mode;
  const description = cfg?.description || "No description available.";
  const goals = Array.isArray(cfg?.goals) ? cfg.goals : [];
  const constraints = Array.isArray(cfg?.constraints) ? cfg.constraints : [];
  const hints = Array.isArray(cfg?.hints) ? cfg.hints : [];

  const schema = cfg?.schema ? safeSchemaSummary(cfg.schema) : null;

  const lines = ["MODE_CARD", `mode: ${title}`, `description: ${description}`];

  if (goals.length) {
    lines.push("goals:");
    goals.forEach((g) => lines.push(`- ${String(g)}`));
  }

  if (constraints.length) {
    lines.push("constraints:");
    constraints.forEach((c) => lines.push(`- ${String(c)}`));
  }

  // Runtime toggles can tighten constraints
  if (runtime?.freshness?.required) {
    lines.push("freshness:");
    lines.push(`- required: ${String(runtime.freshness.required)}`);
    if (runtime.freshness.maxAgeDays != null) {
      lines.push(`- maxAgeDays: ${Number(runtime.freshness.maxAgeDays)}`);
    }
  }

  if (hints.length) {
    lines.push("hints:");
    hints.forEach((h) => lines.push(`- ${String(h)}`));
  }

  if (schema) {
    lines.push("output_schema_summary:");
    lines.push(schema);
  }

  return lines.join("\n");
}

function buildContextCard(mode, context, runtime) {
  // Keep context safe + not enormous.
  const maxChars = Number(runtime?.contextMaxChars || 8000);

  // Common SSA pattern: context includes inventory, preferences, calendar, etc.
  // We keep "shape" + important numbers, but avoid dumping giant collections.
  const curated = curateContextForPrompt(mode, context);

  const raw = stableStringify(curated, 2);
  const clipped = clip(raw, maxChars);

  return ["CONTEXT", clipped].join("\n");
}

function buildInputCard(input, runtime) {
  const maxChars = Number(runtime?.inputMaxChars || 8000);
  const sanitized = sanitizeForPrompt(input);
  const raw = stableStringify(sanitized, 2);
  const clipped = clip(raw, maxChars);
  return ["INPUT", clipped].join("\n");
}

function buildReasoningRubric(cfg, runtime) {
  const steps = [
    "REASONING_RUBRIC",
    "Follow these deterministic steps:",
    "1) Identify the user intent and required outputs per schema.",
    "2) Extract relevant constraints from context (inventory, calendar, preferences, sabbath/quiet hours).",
    "3) If missing critical inputs, include questions and proceed with minimal safe assumptions.",
    "4) Generate recommendations as small, executable items (task-like) with clear fields.",
    "5) Ensure every array field exists (empty arrays allowed) and every required field is present.",
    "6) Add logs for assumptions, uncertainties, and why certain choices were made.",
  ];

  if (runtime?.avoidAiFlavor || cfg?.avoidAiFlavor) {
    steps.push(
      "7) Prefer fixed, catalog-based options (methods/recipes) referenced by IDs when possible."
    );
  }

  return steps.join("\n");
}

function buildOutputContract(mode, cfg, runtime) {
  // If cfg.schema exists, instruct to follow it.
  // Otherwise provide a safe default "envelope" that matches many SSA shims.
  const schema = cfg?.schema || null;

  if (!schema) {
    return [
      "OUTPUT_CONTRACT",
      "Return STRICT JSON only with this shape (fallback):",
      stableStringify(
        {
          ok: true,
          timestamp: "ISO-8601",
          summary: "short string",
          recommendations: [],
          calendarEvents: [],
          gardenUpdates: [],
          storehouseUpdates: [],
          mealPlanningHooks: [],
          logs: [],
          warnings: [],
          questions: [],
        },
        2
      ),
      "Rules:",
      "- Do not include markdown.",
      "- Do not include trailing commas.",
      "- Use ISO-8601 for timestamp/date fields.",
    ].join("\n");
  }

  // Provide schema-guided instruction without dumping huge schema.
  const schemaSummary = safeSchemaSummary(schema);

  const strict = runtime?.strictJson !== false ? "STRICT JSON ONLY." : "JSON.";
  return [
    "OUTPUT_CONTRACT",
    `Return ${strict} Conform to the mode schema.`,
    "Schema summary:",
    schemaSummary,
    "Rules:",
    "- Output must validate against the schema (types, required fields, enums).",
    "- Prefer stable IDs and deterministic ordering (sort by priority/date).",
    "- If uncertain, add warnings and questions rather than inventing facts.",
  ].join("\n");
}

function curateContextForPrompt(mode, context) {
  // Defensive clone with selective extraction.
  const ctx = context && typeof context === "object" ? context : {};

  const out = {};

  // Common SSA buckets
  if (ctx.preferences) out.preferences = shallowTrim(ctx.preferences, 50);
  if (ctx.household) out.household = shallowTrim(ctx.household, 50);
  if (ctx.calendar) out.calendar = shallowTrim(ctx.calendar, 50);

  // Inventory: keep counts and a small sample if huge.
  if (ctx.inventory) {
    out.inventory = summarizeCollection(ctx.inventory, {
      maxItems: 25,
      keepKeys: ["id", "name", "qty", "unit", "location", "expiresAt"],
    });
  }

  // Garden context for garden modes
  if (mode.startsWith("garden.") && ctx.garden) {
    out.garden = summarizeCollection(ctx.garden, {
      maxItems: 25,
      keepKeys: [
        "id",
        "name",
        "variety",
        "stage",
        "plantedAt",
        "expectedHarvest",
      ],
    });
  }

  // Recent logs / signals
  if (ctx.signals) out.signals = shallowTrim(ctx.signals, 50);
  if (ctx.metrics) out.metrics = shallowTrim(ctx.metrics, 50);

  // If context is already a small object, include remaining keys (trimmed)
  const keys = Object.keys(ctx);
  if (keys.length && Object.keys(out).length === 0) {
    return shallowTrim(ctx, 80);
  }

  return out;
}

function shallowTrim(obj, maxKeys) {
  if (!obj || typeof obj !== "object") return obj;
  const out = Array.isArray(obj) ? [] : {};
  const keys = Array.isArray(obj)
    ? obj.map((_, i) => String(i))
    : Object.keys(obj);
  const take = keys.slice(0, Math.max(0, Number(maxKeys) || 0));
  if (Array.isArray(obj)) {
    for (let i = 0; i < take.length; i++) out.push(obj[i]);
    return out;
  }
  for (const k of take) out[k] = obj[k];
  if (keys.length > take.length)
    out.__trimmed__ = { totalKeys: keys.length, kept: take.length };
  return out;
}

function summarizeCollection(value, { maxItems = 25, keepKeys = [] } = {}) {
  // Supports array or keyed object
  if (!value || typeof value !== "object") return value;

  const isArr = Array.isArray(value);
  const items = isArr ? value : Object.values(value);

  const total = items.length;
  const kept = items.slice(0, maxItems).map((it) => pickKeys(it, keepKeys));

  const summary = {
    total,
    sample: kept,
  };

  if (total > maxItems) summary.__trimmed__ = { total, kept: maxItems };

  return summary;
}

function pickKeys(obj, keys) {
  if (!obj || typeof obj !== "object") return obj;
  if (!Array.isArray(keys) || !keys.length) return obj;
  const out = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  }
  return out;
}

function safeSchemaSummary(schema) {
  try {
    // If schema is big, create a compact summary:
    // - required fields
    // - top-level properties
    // - enums for properties (shallow)
    const required = Array.isArray(schema.required) ? schema.required : [];
    const props =
      schema.properties && typeof schema.properties === "object"
        ? schema.properties
        : {};
    const propKeys = Object.keys(props);

    const propSummary = {};
    for (const k of propKeys.slice(0, 40)) {
      const p = props[k] || {};
      const entry = {};
      if (p.type) entry.type = p.type;
      if (Array.isArray(p.enum)) entry.enum = p.enum.slice(0, 25);
      if (p.items && p.items.type) entry.itemsType = p.items.type;
      propSummary[k] = entry;
    }

    const out = {
      type: schema.type || "object",
      required,
      properties: propSummary,
    };

    if (propKeys.length > 40)
      out.__trimmed__ = {
        propertiesTotal: propKeys.length,
        propertiesKept: 40,
      };
    return stableStringify(out, 2);
  } catch {
    return "(schema summary unavailable)";
  }
}

function clip(str, maxChars) {
  const s = String(str ?? "");
  const m = Number(maxChars);
  if (!Number.isFinite(m) || m <= 0) return s;
  if (s.length <= m) return s;
  return `${s.slice(0, m)}\n/*…clipped…*/`;
}
