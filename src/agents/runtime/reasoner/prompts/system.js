// C:\Users\larho\suka-smart-assistant\src\agents\runtime\reasoner\prompts\system.js
/**
 * Reasoner System Prompt Builder (browser-safe)
 * -----------------------------------------------------------------------------
 * This file provides a deterministic, domain-aware "system" instruction that
 * shims can use to call the Reasoner in a consistent way.
 *
 * Goals:
 * - Keep prompts stable and predictable (low "AI drift").
 * - Enforce SSA conventions: structured JSON outputs, no hallucinated tools,
 *   no external browsing, respect provided context only.
 * - Allow runtime knobs for strictness, verbosity, schema emphasis, etc.
 *
 * Exports:
 *  - buildSystemText(args) -> string
 *  - buildSystemMessage(args) -> { role:"system", content:string }
 */

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function asBool(v, fallback = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(s)) return true;
    if (["false", "0", "no", "n", "off"].includes(s)) return false;
  }
  if (typeof v === "number") return v !== 0;
  return fallback;
}

function asInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function normalizeStyle(runtime) {
  const r = isObject(runtime) ? runtime : {};
  const strictJson = asBool(r.strictJson, true);
  const noMarkdown = asBool(r.noMarkdown, true);
  const deterministic = asBool(r.deterministic, true);

  const verbosityRaw =
    typeof r.verbosity === "string" ? r.verbosity : String(r.verbosity || "");
  const verbosity = verbosityRaw.trim().toLowerCase() || "concise"; // concise|balanced|verbose

  const maxBullets = clamp(asInt(r.maxBullets, 12), 0, 50);
  const maxWarnings = clamp(asInt(r.maxWarnings, 8), 0, 50);

  const preferTables = asBool(r.preferTables, false);
  const safeAssumptions = asBool(r.safeAssumptions, true);

  const schemaFirst = asBool(r.schemaFirst, true);
  const includeRationale = asBool(r.includeRationale, false);
  const includeDebug = asBool(r.includeDebug, false);

  // Where "contextOnly" means "do not fabricate facts; use only provided context"
  const contextOnly = asBool(r.contextOnly, true);

  // No web / no external calls in the reasoner environment
  const noExternal = asBool(r.noExternal, true);

  return {
    strictJson,
    noMarkdown,
    deterministic,
    verbosity,
    maxBullets,
    maxWarnings,
    preferTables,
    safeAssumptions,
    schemaFirst,
    includeRationale,
    includeDebug,
    contextOnly,
    noExternal,
  };
}

/**
 * Produce a stable system instruction text.
 *
 * @param {Object} args
 * @param {string} args.domain
 * @param {string} args.intent
 * @param {string} args.mode
 * @param {Object} [args.runtime]
 * @returns {string}
 */
export function buildSystemText({ domain, intent, mode, runtime = {} }) {
  const style = normalizeStyle(runtime);

  const lines = [];

  // Identity + mission
  lines.push(
    "You are SSA Reasoner — a deterministic planning & normalization engine.",
    "Your job is to transform PROVIDED input + context into structured outputs for the SSA system.",
    ""
  );

  // Guardrails
  if (style.noExternal) {
    lines.push(
      "CRITICAL: Do not browse the web. Do not call external tools. Do not invent sources.",
      "Use ONLY the provided DATA_PAYLOAD (input/context) and any mode template instructions."
    );
  } else {
    lines.push("Use only the provided payload and mode instructions.");
  }

  if (style.contextOnly) {
    lines.push(
      "CRITICAL: If a required fact is missing, do not fabricate it.",
      "Instead: use safe defaults only when explicitly allowed by the mode; otherwise return a warning and proceed conservatively."
    );
  }

  // Output formatting requirements
  lines.push("");
  if (style.strictJson) {
    lines.push(
      "OUTPUT FORMAT:",
      "- Return a SINGLE JSON value (object or array) and nothing else.",
      "- Do not wrap in markdown fences.",
      "- Do not include commentary outside JSON."
    );
  } else {
    lines.push(
      "OUTPUT FORMAT:",
      "- Prefer JSON. Avoid markdown unless explicitly requested."
    );
  }

  if (style.noMarkdown) {
    lines.push("- Do NOT use markdown formatting in strings unless asked.");
  }

  if (style.deterministic) {
    lines.push(
      "",
      "DETERMINISM:",
      "- Prefer stable, repeatable decisions.",
      "- If multiple valid choices exist, choose the simplest and most standard option unless input says otherwise."
    );
  }

  // Quality constraints
  lines.push(
    "",
    "QUALITY RULES:",
    "- Follow the mode schema and constraints first.",
    "- Keep units consistent; do not mix systems without explicit conversion fields.",
    "- Provide explicit assumptions only when permitted; keep them minimal."
  );

  // Verbosity knobs
  lines.push("");
  if (style.verbosity === "concise") {
    lines.push("VERBOSITY: Keep responses concise. Avoid long narratives.");
  } else if (style.verbosity === "verbose") {
    lines.push(
      "VERBOSITY: Provide detailed structured fields and step-by-step guidance where relevant."
    );
  } else {
    lines.push("VERBOSITY: Balanced detail.");
  }

  // Optional rationale/debug
  if (style.includeRationale) {
    lines.push(
      "",
      "RATIONALE:",
      "- If the schema supports it, include a short rationale field explaining key decisions."
    );
  }
  if (style.includeDebug) {
    lines.push(
      "",
      "DEBUG:",
      "- If the schema supports it, include debug fields (lightweight, no secrets)."
    );
  }

  // Presentation preferences
  if (style.preferTables) {
    lines.push(
      "",
      "PRESENTATION:",
      "- Prefer tabular/row-like structures in JSON (arrays of objects) over long paragraphs."
    );
  }

  // Warnings discipline
  lines.push(
    "",
    "WARNINGS:",
    `- If important data is missing or ambiguous, include warnings (max ${style.maxWarnings}).`,
    "- Warnings should be short, actionable, and specific."
  );

  // Domain/mode header
  lines.push(
    "",
    "REQUEST META:",
    `- domain: ${String(domain || "").trim() || "unknown"}`,
    `- intent: ${String(intent || "").trim() || "unknown"}`,
    `- mode: ${String(mode || "").trim() || "unknown"}`
  );

  // Schema-first reminder
  if (style.schemaFirst) {
    lines.push(
      "",
      "SCHEMA-FIRST:",
      "- The mode's output schema is authoritative. Do not emit extra top-level keys unless the schema allows them.",
      "- If you must include additional notes, put them in schema-approved fields (e.g., warnings, logs)."
    );
  }

  // Safe assumption policy
  if (style.safeAssumptions) {
    lines.push(
      "",
      "SAFE DEFAULTS POLICY:",
      "- Use safe, conservative defaults only when required and only if they do not contradict the payload.",
      "- Never assume user location, prices, allergies, religious rules, or inventory quantities unless provided."
    );
  }

  return lines.join("\n");
}

/**
 * Build a system message for chat-style prompts.
 *
 * @param {Object} args
 * @returns {{role:"system", content:string}}
 */
export function buildSystemMessage(args) {
  return { role: "system", content: buildSystemText(args) };
}

export default buildSystemMessage;
