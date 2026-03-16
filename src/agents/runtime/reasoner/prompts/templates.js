// C:\Users\larho\suka-smart-assistant\src\agents\runtime\reasoner\prompts\templates.js
/**
 * Reasoner Prompt Templates (runtime)
 * -----------------------------------------------------------------------------
 * PURPOSE:
 * - Provide reusable prompt “template blocks” for Reasoner modes.
 * - Keep shims thin: shims choose a mode, buildPromptForMode() assembles blocks,
 *   templates.js provides safe, consistent text structures.
 *
 * DESIGN GOALS:
 * - No framework dependencies.
 * - Works with either string prompts or chat-style message arrays.
 * - Safe defaults: never throws on missing fields; always returns strings.
 * - Compact but expressive building blocks for SSA domains.
 *
 * NOTE:
 * - This file does NOT call the model; it only builds template strings/objects.
 * - The actual prompt assembly happens in prompts/builder.js (your file).
 */

/* -------------------------------------------------------------------------- */
/* Small utils                                                                */
/* -------------------------------------------------------------------------- */

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

function safeStr(v, fallback = "") {
  if (v === null || typeof v === "undefined") return fallback;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function coerceList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  return [String(v)];
}

function truncate(s, max = 1200) {
  const str = safeStr(s, "");
  if (str.length <= max) return str;
  return `${str.slice(0, max)}…`;
}

function bulletList(items, { prefix = "- ", maxItems = 30 } = {}) {
  const arr = coerceList(items).slice(0, maxItems);
  if (!arr.length) return "";
  return arr.map((x) => `${prefix}${x}`).join("\n");
}

function kvLines(obj, { indent = "", maxKeys = 60 } = {}) {
  if (!isObj(obj)) return "";
  const keys = Object.keys(obj).slice(0, maxKeys);
  if (!keys.length) return "";
  return keys
    .map((k) => {
      const v = obj[k];
      const val =
        typeof v === "string"
          ? v
          : typeof v === "number" || typeof v === "boolean"
          ? String(v)
          : truncate(v, 500);
      return `${indent}${k}: ${val}`;
    })
    .join("\n");
}

function prettyJson(v, maxLen = 5000) {
  const s = safeStr(v, "");
  return truncate(s, maxLen);
}

/* -------------------------------------------------------------------------- */
/* Base template blocks                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Standard header for SSA Reasoner calls.
 * Keeps “household steward” framing consistent across domains.
 */
export function tmplHeader({
  domain,
  intent,
  mode,
  ts,
  source,
  controlLevel,
} = {}) {
  const when = ts || new Date().toISOString();
  const cl = controlLevel ? `\nControlLevel: ${controlLevel}` : "";
  return [
    `# SSA Reasoner Request`,
    `Time: ${when}`,
    `Domain: ${domain || "unknown"}`,
    `Intent: ${intent || "unknown"}`,
    `Mode: ${mode || "unknown"}`,
    source ? `Source: ${source}` : null,
    cl ? cl.trimEnd() : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Instructions block for output discipline.
 * Use this to steer the model to conform to mode schema.
 */
export function tmplOutputRules({
  mustBeJson = true,
  schemaHint,
  noMarkdown = true,
  noExtraKeys = true,
  allowNulls = true,
  notes = [],
} = {}) {
  const bullets = [];

  if (mustBeJson) bullets.push("Return ONLY valid JSON.");
  if (noMarkdown) bullets.push("Do NOT wrap JSON in Markdown fences.");
  if (noExtraKeys) bullets.push("Do NOT invent extra keys beyond the schema.");
  bullets.push(
    allowNulls ? "Use null for unknown values." : "Omit unknown fields."
  );

  if (schemaHint) bullets.push(`Follow the mode schema: ${schemaHint}`);

  const extra = coerceList(notes);
  extra.forEach((n) => bullets.push(String(n)));

  return [`## Output Rules`, bulletList(bullets), ``].join("\n");
}

/**
 * A short “persona/stance” block consistent with SSA:
 * pragmatic, operational, minimal AI, actionable outputs.
 */
export function tmplStewardPersona({ emphasis = [], avoid = [] } = {}) {
  const e = coerceList(emphasis);
  const a = coerceList(avoid);

  const lines = [
    `## Role`,
    `You are SSA's household steward reasoner. Optimize for practicality, clarity, and reuse.`,
    `Prefer fixed catalogs, methods, and deterministic logic over creative invention.`,
  ];

  if (e.length) {
    lines.push(`\n## Emphasize`);
    lines.push(bulletList(e));
  }
  if (a.length) {
    lines.push(`\n## Avoid`);
    lines.push(bulletList(a));
  }

  return lines.join("\n");
}

/**
 * Context block: structured “what we know” from selectors (Dexie).
 */
export function tmplContext({
  title = "Context",
  context,
  maxLen = 9000,
} = {}) {
  if (!context) {
    return `## ${title}\n(no context provided)\n`;
  }
  return `## ${title}\n${truncate(prettyJson(context), maxLen)}\n`;
}

/**
 * Input block: what the user asked (shim input).
 */
export function tmplInput({ title = "User Input", input, maxLen = 6000 } = {}) {
  if (!input) return `## ${title}\n(no input provided)\n`;
  return `## ${title}\n${truncate(prettyJson(input), maxLen)}\n`;
}

/**
 * Constraints / preferences block.
 */
export function tmplConstraints({ constraints = {}, maxLen = 4000 } = {}) {
  const s = truncate(prettyJson(constraints), maxLen);
  return `## Constraints & Preferences\n${s}\n`;
}

/**
 * “Known catalogs/methods” block — reference only.
 */
export function tmplCatalogRefs({
  catalogs = [],
  methods = [],
  maxItems = 50,
} = {}) {
  const c = coerceList(catalogs).slice(0, maxItems);
  const m = coerceList(methods).slice(0, maxItems);

  const parts = [`## Catalog & Method References`];

  parts.push(
    c.length ? `Catalogs:\n${bulletList(c)}` : `Catalogs:\n- (none provided)`
  );
  parts.push(
    m.length ? `Methods:\n${bulletList(m)}` : `Methods:\n- (none provided)`
  );

  return `${parts.join("\n")}\n`;
}

/* -------------------------------------------------------------------------- */
/* Domain helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Storehouse: PAR / refill / maintenance framing.
 */
export function tmplStorehouseBrief({
  intent,
  includeNonFood = false,
  people,
  days,
  dietNotes,
  budget,
  controlLevel,
} = {}) {
  const lines = [
    `## Storehouse Brief`,
    `Objective: plan and maintain a household storehouse using PAR targets, gaps, and actionable steps.`,
    `Intent: ${intent || "unknown"}`,
    controlLevel ? `ControlLevel: ${controlLevel}` : null,
    typeof includeNonFood === "boolean"
      ? `Include non-food supplies: ${includeNonFood ? "yes" : "no"}`
      : null,
    people != null ? `People: ${people}` : null,
    days != null ? `Days of coverage: ${days}` : null,
    dietNotes ? `Diet notes: ${truncate(dietNotes, 800)}` : null,
    budget != null ? `Budget hint: ${truncate(budget, 300)}` : null,
  ].filter(Boolean);

  return `${lines.join("\n")}\n`;
}

/**
 * Preservation: batch, methods, labels, inventory deltas.
 */
export function tmplPreservationBrief({
  intent,
  methodsPreferred,
  storageLocations,
  equipment,
  timeWindow,
} = {}) {
  const lines = [
    `## Preservation Brief`,
    `Objective: plan preservation actions (canning/freezing/dehydrating/fermenting/curing) with labeling and inventory deltas.`,
    `Intent: ${intent || "unknown"}`,
  ];

  if (methodsPreferred) {
    lines.push(`Preferred methods:\n${bulletList(methodsPreferred)}`);
  }
  if (storageLocations) {
    lines.push(`Storage locations:\n${bulletList(storageLocations)}`);
  }
  if (equipment) {
    lines.push(`Available equipment:\n${bulletList(equipment)}`);
  }
  if (timeWindow) {
    lines.push(`Time window: ${truncate(timeWindow, 400)}`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Cleaning: guardrails, rooms, cadence.
 */
export function tmplCleaningBrief({
  intent,
  rooms,
  cadence,
  constraints,
} = {}) {
  const lines = [
    `## Cleaning Brief`,
    `Objective: produce a safe, realistic cleaning plan aligned with household cadence and constraints.`,
    `Intent: ${intent || "unknown"}`,
  ];
  if (rooms) lines.push(`Rooms:\n${bulletList(rooms)}`);
  if (cadence) lines.push(`Cadence: ${truncate(cadence, 600)}`);
  if (constraints)
    lines.push(`Constraints:\n${truncate(prettyJson(constraints), 2000)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Garden: tasks, planting, harvest, seasonality.
 */
export function tmplGardenBrief({
  intent,
  season,
  zone,
  goals,
  constraints,
} = {}) {
  const lines = [
    `## Garden Brief`,
    `Objective: propose garden tasks and plans aligned with seasonality, constraints, and storehouse goals.`,
    `Intent: ${intent || "unknown"}`,
  ];
  if (season) lines.push(`Season: ${season}`);
  if (zone) lines.push(`Zone: ${zone}`);
  if (goals) lines.push(`Goals:\n${bulletList(goals)}`);
  if (constraints)
    lines.push(`Constraints:\n${truncate(prettyJson(constraints), 2000)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * Animals: husbandry tasks, butchery, feed, health checks.
 */
export function tmplAnimalsBrief({ intent, species, constraints, goals } = {}) {
  const lines = [
    `## Animals Brief`,
    `Objective: produce husbandry tasks and planning outputs that support household food, health, and calendar cadence.`,
    `Intent: ${intent || "unknown"}`,
  ];
  if (species) lines.push(`Species:\n${bulletList(species)}`);
  if (goals) lines.push(`Goals:\n${bulletList(goals)}`);
  if (constraints)
    lines.push(`Constraints:\n${truncate(prettyJson(constraints), 2000)}`);
  return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------------------- */
/* Output “shape reminders”                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Provide a compact schema reminder (human readable).
 * Do not treat as authoritative schema; builder.js should reference the actual schema.
 */
export function tmplSchemaReminder({ fields = [], notes = [] } = {}) {
  const f = coerceList(fields);
  const n = coerceList(notes);
  const lines = [`## Schema Reminder`];

  if (f.length) {
    lines.push(`Expected fields:\n${bulletList(f)}`);
  } else {
    lines.push(`Expected fields: (provided by builder via mode schema)`);
  }

  if (n.length) {
    lines.push(`Notes:\n${bulletList(n)}`);
  }

  return `${lines.join("\n")}\n`;
}

/* -------------------------------------------------------------------------- */
/* Message helpers (if you use chat array prompts)                            */
/* -------------------------------------------------------------------------- */

export function asSystemMessage(content) {
  return { role: "system", content: safeStr(content, "") };
}
export function asUserMessage(content) {
  return { role: "user", content: safeStr(content, "") };
}
export function asDeveloperMessage(content) {
  return { role: "developer", content: safeStr(content, "") };
}

/**
 * Combine blocks into a single text prompt.
 * @param {Array<string>} blocks
 */
export function joinBlocks(blocks = []) {
  const parts = coerceList(blocks).filter((s) => String(s).trim().length);
  return parts.join("\n\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Build a default "messages" prompt (system + user) from blocks.
 * Use if callReasoner expects chat messages.
 */
export function buildMessagesPrompt({
  systemBlocks = [],
  userBlocks = [],
  developerBlocks = [],
} = {}) {
  const msgs = [];
  const sys = joinBlocks(systemBlocks);
  const dev = joinBlocks(developerBlocks);
  const usr = joinBlocks(userBlocks);

  if (sys) msgs.push(asSystemMessage(sys));
  if (dev) msgs.push(asDeveloperMessage(dev));
  if (usr) msgs.push(asUserMessage(usr));

  // If nothing, at least return a user message so callers don't crash
  if (!msgs.length)
    msgs.push(asUserMessage("Return valid JSON for the requested mode."));
  return msgs;
}

/**
 * Back-compat export expected by some shims (e.g., preservationShim.js).
 *
 * This is a thin wrapper that returns either:
 * - a single string prompt (default), or
 * - a chat-style messages array when `asMessages: true`.
 *
 * @param {object} params
 * @param {string[]} [params.blocks] convenience: blocks to join into a single prompt
 * @param {string[]} [params.systemBlocks]
 * @param {string[]} [params.userBlocks]
 * @param {string[]} [params.developerBlocks]
 * @param {boolean} [params.asMessages=false]
 * @returns {string|Array<{role:string, content:string}>}
 */
export function buildPrompt(params = {}) {
  const p = params || {};
  const asMessages = !!p.asMessages;

  // Convenience: if caller passes `blocks`, treat them as userBlocks.
  const blocks = Array.isArray(p.blocks) ? p.blocks : null;

  const systemBlocks = Array.isArray(p.systemBlocks) ? p.systemBlocks : [];
  const developerBlocks = Array.isArray(p.developerBlocks)
    ? p.developerBlocks
    : [];
  const userBlocks =
    blocks || (Array.isArray(p.userBlocks) ? p.userBlocks : []);

  if (asMessages) {
    return buildMessagesPrompt({ systemBlocks, developerBlocks, userBlocks });
  }

  // String prompt: join everything (system + developer + user) in a deterministic way.
  return joinBlocks([
    joinBlocks(systemBlocks),
    joinBlocks(developerBlocks),
    joinBlocks(userBlocks),
  ]);
}

/* -------------------------------------------------------------------------- */
/* Back-compat exports expected by prompts/builder.js                          */
/* -------------------------------------------------------------------------- */

/**
 * Back-compat: builder.js expects renderTemplateForMode().
 *
 * This is intentionally flexible:
 * - If you pass { systemBlocks, developerBlocks, userBlocks, asMessages }, it delegates to buildPrompt().
 * - If you pass an array, it treats it as `blocks` (userBlocks) and joins them.
 * - If you pass a string, it returns it.
 *
 * @param {any} templateOrParts
 * @param {any} [maybeParts]
 * @returns {string|Array<{role:string, content:string}>}
 */
export function renderTemplateForMode(templateOrParts, maybeParts) {
  // Common call shapes:
  // 1) renderTemplateForMode({ systemBlocks, userBlocks, ... })
  // 2) renderTemplateForMode(blocksArray)
  // 3) renderTemplateForMode(mode, parts)  -> ignore mode and render parts
  const parts = maybeParts !== undefined ? maybeParts : templateOrParts;

  if (typeof parts === "string") return parts;
  if (Array.isArray(parts)) return joinBlocks(parts);

  if (isObj(parts)) {
    // If it's already a messages array-like wrapper, preserve it.
    if (Array.isArray(parts.messages)) return parts.messages;

    // Delegate to buildPrompt with tolerant defaults.
    return buildPrompt({
      blocks: Array.isArray(parts.blocks) ? parts.blocks : undefined,
      systemBlocks: Array.isArray(parts.systemBlocks) ? parts.systemBlocks : [],
      developerBlocks: Array.isArray(parts.developerBlocks)
        ? parts.developerBlocks
        : [],
      userBlocks: Array.isArray(parts.userBlocks) ? parts.userBlocks : [],
      asMessages: !!parts.asMessages,
    });
  }

  return joinBlocks([safeStr(parts, "")]);
}

/**
 * Back-compat: builder.js expects coerceToMessages().
 * Accepts:
 * - messages array -> returned as-is
 * - string -> [{ role:'user', content:string }]
 * - single { role, content } object -> [obj]
 *
 * @param {any} prompt
 * @returns {Array<{role:string, content:string}>}
 */
export function coerceToMessages(prompt) {
  if (Array.isArray(prompt)) {
    // best-effort normalize
    return prompt.filter(Boolean).map((m) => ({
      role: String(m?.role || "user"),
      content: safeStr(m?.content, ""),
    }));
  }

  if (isObj(prompt) && typeof prompt.role === "string") {
    return [
      { role: String(prompt.role), content: safeStr(prompt.content, "") },
    ];
  }

  const s = safeStr(prompt, "");
  return [{ role: "user", content: s }];
}

/**
 * Back-compat: builder.js expects stringifyForTextPrompt().
 * Turns chat messages into a single deterministic text prompt.
 *
 * @param {any} promptOrMessages
 * @returns {string}
 */
export function stringifyForTextPrompt(promptOrMessages) {
  if (typeof promptOrMessages === "string") return promptOrMessages;

  const msgs = coerceToMessages(promptOrMessages);
  if (!msgs.length) return "";

  // Deterministic render: include role labels
  const lines = [];
  for (const m of msgs) {
    const role = (m.role || "user").toUpperCase();
    const content = safeStr(m.content, "").trim();
    if (!content) continue;
    lines.push(`[${role}]`);
    lines.push(content);
    lines.push(""); // spacer
  }
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim() + "\n"
  );
}

/* -------------------------------------------------------------------------- */
/* Default export: a registry of commonly used templates                       */
/* -------------------------------------------------------------------------- */

const Templates = {
  // base
  tmplHeader,
  tmplOutputRules,
  tmplStewardPersona,
  tmplContext,
  tmplInput,
  tmplConstraints,
  tmplCatalogRefs,
  tmplSchemaReminder,

  // domains
  tmplStorehouseBrief,
  tmplPreservationBrief,
  tmplCleaningBrief,
  tmplGardenBrief,
  tmplAnimalsBrief,

  // helpers
  joinBlocks,
  buildMessagesPrompt,
  buildPrompt,
  renderTemplateForMode,
  coerceToMessages,
  stringifyForTextPrompt,
  asSystemMessage,
  asDeveloperMessage,
  asUserMessage,
};

export default Templates;
