// src/utils/extractPrepTasks.js
/**
 * Prep Task Extraction (Cross-Domain)
 * -----------------------------------------------------------------------------
 * Problem being fixed:
 * - Some templates (e.g., guidedCookZen.js) import a DEFAULT export:
 *     import extractPrepTasks from "@/utils/extractPrepTasks";
 *   but this file only exported a named function, so Vite fails:
 *     '"default" is not exported ...'
 *
 * Solution:
 * - Provide a default export `extractPrepTasks(...)` (back-compat).
 * - Keep (and expand) named exports for explicit usage.
 *
 * Goal:
 * - Extract "prep tasks" across SSA domains where it makes sense:
 *   cooking, cleaning, garden, animals, preservation, storehouse.
 *
 * Notes:
 * - This utility is intentionally schema-tolerant: it tries multiple field names
 *   (prepSteps, prep, steps, tasks, checklist, etc.).
 * - It never throws; returns a normalized array.
 */

/**
 * @typedef {'cooking'|'cleaning'|'garden'|'animals'|'preservation'|'storehouse'|'unknown'} Domain
 */

/**
 * @typedef {Object} PrepTask
 * @property {string} id
 * @property {string} label
 * @property {Domain} domain
 * @property {string} [sourceId]
 * @property {string} [sourceType]
 * @property {string} [sourceName]
 * @property {number} [estimatedMin]
 * @property {string} [dueISO]
 * @property {number} [priority]
 * @property {Object} [meta]
 */

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

/**
 * DEFAULT EXPORT (what templates expect).
 *
 * Accepts either:
 * - Array input (assumed to be "sources" for the given domain), OR
 * - Object input with a flexible envelope.
 *
 * Examples:
 *   extractPrepTasks(recipes, { domain: 'cooking' })
 *   extractPrepTasks({ domain: 'cleaning', plan })
 *   extractPrepTasks({ session }) // attempts to infer from session.domain
 *
 * @param {any} input
 * @param {{ domain?: Domain, now?: Date, prefixLabel?: string }} [options]
 * @returns {PrepTask[]}
 */
export default function extractPrepTasks(input, options = {}) {
  try {
    const resolvedDomain = normalizeDomain(
      options.domain ||
        input?.domain ||
        input?.session?.domain ||
        input?.plan?.domain ||
        "unknown"
    );

    // Common “envelopes”
    const session = input?.session || null;
    const plan = input?.plan || input?.mealPlan || input?.cleaningPlan || null;

    // If array passed, treat as sources directly
    if (Array.isArray(input)) {
      return extractPrepTasksForDomain(resolvedDomain, input, options);
    }

    // If session has steps, extract step-level prep tasks (works for any domain)
    if (session && Array.isArray(session.steps)) {
      return extractPrepTasksFromSession(session, options);
    }

    // Domain-specific plan shapes
    if (plan) {
      return extractPrepTasksFromPlan(plan, {
        ...options,
        domain: resolvedDomain,
      });
    }

    // Otherwise, try extracting from "recipes" or "items" fields
    const recipes = Array.isArray(input?.recipes) ? input.recipes : null;
    if (recipes) {
      return extractPrepTasksForDomain("cooking", recipes, options);
    }

    const items = Array.isArray(input?.items)
      ? input.items
      : Array.isArray(input?.sources)
      ? input.sources
      : null;

    if (items) {
      return extractPrepTasksForDomain(resolvedDomain, items, options);
    }

    return [];
  } catch {
    return [];
  }
}

/**
 * Back-compat: original named export expected by older call sites.
 * (Kept, but now delegates to the new engine.)
 *
 * @param {Array} recipes
 * @returns {PrepTask[]}
 */
export function extractPrepTasksFromRecipes(recipes = []) {
  return extractPrepTasksForDomain("cooking", recipes, {});
}

/**
 * Extract prep tasks for a specific domain from a list of "sources"
 * (recipes, tasks, plan items, etc.).
 *
 * @param {Domain} domain
 * @param {any[]} sources
 * @param {{ now?: Date, prefixLabel?: string }} [options]
 * @returns {PrepTask[]}
 */
export function extractPrepTasksForDomain(domain, sources = [], options = {}) {
  const d = normalizeDomain(domain);
  const now = options.now instanceof Date ? options.now : new Date();

  const tasks = [];
  const seen = new Set();

  for (let i = 0; i < sources.length; i += 1) {
    const src = sources[i];
    const extracted = extractFromSourceByDomain(d, src, { now });

    for (const t of extracted) {
      const labeled = options.prefixLabel
        ? { ...t, label: `${options.prefixLabel} ${t.label}`.trim() }
        : t;

      const key =
        labeled.id ||
        `${labeled.domain}:${labeled.sourceId || "x"}:${labeled.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push(labeled);
    }
  }

  // Stable sort: priority desc, due asc, label asc
  tasks.sort((a, b) => {
    const pa = Number.isFinite(a.priority) ? a.priority : 0;
    const pb = Number.isFinite(b.priority) ? b.priority : 0;
    if (pb !== pa) return pb - pa;

    const da = a.dueISO ? Date.parse(a.dueISO) : Number.POSITIVE_INFINITY;
    const db = b.dueISO ? Date.parse(b.dueISO) : Number.POSITIVE_INFINITY;
    if (da !== db) return da - db;

    return String(a.label || "").localeCompare(String(b.label || ""));
  });

  return tasks;
}

/**
 * Extract prep tasks from an SSA session object (cross-domain).
 * - Uses session.domain if present.
 * - Pulls from session.steps[].metadata/prep/tasks/checklist when available.
 *
 * @param {any} session
 * @param {{ now?: Date }} [options]
 * @returns {PrepTask[]}
 */
export function extractPrepTasksFromSession(session, options = {}) {
  const domain = normalizeDomain(session?.domain || "unknown");
  const now = options.now instanceof Date ? options.now : new Date();

  const steps = Array.isArray(session?.steps) ? session.steps : [];
  const sessionId = session?.id || null;
  const sessionTitle = session?.title || null;

  const out = [];
  const seen = new Set();

  for (let idx = 0; idx < steps.length; idx += 1) {
    const step = steps[idx] || {};
    const stepId = step.id || `step-${idx}`;
    const stepTitle = step.title || step.name || `Step ${idx + 1}`;

    // Prefer explicit prep/task lists if present
    const candidateLists = [
      step.prepTasks,
      step.prep,
      step.tasks,
      step.checklist,
      step.todo,
      step.metadata?.prepTasks,
      step.metadata?.prep,
      step.metadata?.tasks,
    ].filter(Array.isArray);

    if (candidateLists.length) {
      for (const list of candidateLists) {
        for (let j = 0; j < list.length; j += 1) {
          const raw = list[j];
          const task = normalizeTask(raw, {
            domain,
            sourceType: "sessionStep",
            sourceId: sessionId || undefined,
            sourceName: sessionTitle || undefined,
            fallbackId: `${sessionId || "session"}:${stepId}:${j}`,
            fallbackLabel: `${stepTitle}: ${
              raw?.label || raw?.title || raw?.name || "Prep"
            }`,
            meta: { stepId, stepIndex: idx },
            now,
          });

          const key =
            task.id || `${task.domain}:${task.sourceId || "x"}:${task.label}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(task);
        }
      }
      continue;
    }

    // If no explicit prep list, treat *some* domains as having implicit prep
    // when a step is marked as setup/prep.
    const kind = String(step.kind || step.type || "").toLowerCase();
    const tag = String(step.tag || step.category || "").toLowerCase();

    const looksLikePrep =
      kind.includes("prep") ||
      kind.includes("setup") ||
      tag.includes("prep") ||
      tag.includes("setup") ||
      /mise|chop|slice|measure|sanitize|gather/i.test(String(stepTitle));

    if (looksLikePrep) {
      const task = normalizeTask(
        {
          label: stepTitle,
          estimatedMin: secondsToMin(step.durationSec),
        },
        {
          domain,
          sourceType: "sessionStep",
          sourceId: sessionId || undefined,
          sourceName: sessionTitle || undefined,
          fallbackId: `${sessionId || "session"}:${stepId}:implicit`,
          fallbackLabel: stepTitle,
          meta: { stepId, stepIndex: idx, implicit: true },
          now,
        }
      );

      const key =
        task.id || `${task.domain}:${task.sourceId || "x"}:${task.label}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(task);
      }
    }
  }

  return out;
}

/**
 * Extract prep tasks from a domain plan object (cross-domain).
 * Supports:
 * - cooking mealPlan (meals/recipes)
 * - cleaning plan (rooms/zoneTasks/checklists)
 * - garden plan (beds/tasks/harvest/prep)
 * - animals (rotations/tasks/checklists)
 * - preservation/storehouse (batches/moves/checklists)
 *
 * @param {any} plan
 * @param {{ domain?: Domain, now?: Date }} [options]
 * @returns {PrepTask[]}
 */
export function extractPrepTasksFromPlan(plan, options = {}) {
  const domain = normalizeDomain(options.domain || plan?.domain || "unknown");
  const now = options.now instanceof Date ? options.now : new Date();

  // Cooking: plan.meals[] or plan.recipes[]
  if (domain === "cooking") {
    const meals = Array.isArray(plan?.meals) ? plan.meals : [];
    const recipes = Array.isArray(plan?.recipes) ? plan.recipes : [];
    const sources = recipes.length ? recipes : meals;
    return extractPrepTasksForDomain("cooking", sources, { now });
  }

  // Cleaning: plan.rooms[], plan.zones[], plan.tasks[]
  if (domain === "cleaning") {
    const rooms = Array.isArray(plan?.rooms) ? plan.rooms : [];
    const zones = Array.isArray(plan?.zones) ? plan.zones : [];
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const sources = rooms.length ? rooms : zones.length ? zones : tasks;
    return extractPrepTasksForDomain("cleaning", sources, { now });
  }

  // Garden: plan.beds[], plan.tasks[], plan.chores[]
  if (domain === "garden") {
    const beds = Array.isArray(plan?.beds) ? plan.beds : [];
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const chores = Array.isArray(plan?.chores) ? plan.chores : [];
    const sources = beds.length ? beds : tasks.length ? tasks : chores;
    return extractPrepTasksForDomain("garden", sources, { now });
  }

  // Animals: plan.animals[], plan.tasks[], plan.rotations[]
  if (domain === "animals") {
    const animals = Array.isArray(plan?.animals) ? plan.animals : [];
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const rotations = Array.isArray(plan?.rotations) ? plan.rotations : [];
    const sources = tasks.length
      ? tasks
      : rotations.length
      ? rotations
      : animals;
    return extractPrepTasksForDomain("animals", sources, { now });
  }

  // Preservation: plan.batches[], plan.tasks[]
  if (domain === "preservation") {
    const batches = Array.isArray(plan?.batches) ? plan.batches : [];
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const sources = batches.length ? batches : tasks;
    return extractPrepTasksForDomain("preservation", sources, { now });
  }

  // Storehouse: plan.moves[], plan.tasks[], plan.checklist[]
  if (domain === "storehouse") {
    const moves = Array.isArray(plan?.moves) ? plan.moves : [];
    const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
    const checklist = Array.isArray(plan?.checklist) ? plan.checklist : [];
    const sources = moves.length ? moves : tasks.length ? tasks : checklist;
    return extractPrepTasksForDomain("storehouse", sources, { now });
  }

  // Unknown: best-effort on common fields
  const genericSources = Array.isArray(plan?.tasks)
    ? plan.tasks
    : Array.isArray(plan?.items)
    ? plan.items
    : [];
  return extractPrepTasksForDomain(domain, genericSources, { now });
}

/* -----------------------------------------------------------------------------
 * Domain-specific extraction
 * -------------------------------------------------------------------------- */

/**
 * @param {Domain} domain
 * @param {any} src
 * @param {{ now: Date }} ctx
 * @returns {PrepTask[]}
 */
function extractFromSourceByDomain(domain, src, ctx) {
  switch (domain) {
    case "cooking":
      return extractFromRecipeLike(src, ctx);
    case "cleaning":
      return extractFromCleaningLike(src, ctx);
    case "garden":
      return extractFromGardenLike(src, ctx);
    case "animals":
      return extractFromAnimalsLike(src, ctx);
    case "preservation":
      return extractFromPreservationLike(src, ctx);
    case "storehouse":
      return extractFromStorehouseLike(src, ctx);
    default:
      return extractGenericTasks(src, { ...ctx, domain });
  }
}

function extractFromRecipeLike(recipe, { now }) {
  const id = recipe?.id || recipe?.key || recipe?.recipeId || undefined;
  const name = recipe?.name || recipe?.title || recipe?.label || "Recipe";

  // Prefer explicit prepSteps
  const prepSteps =
    arrayish(recipe?.prepSteps) ||
    arrayish(recipe?.prep) ||
    arrayish(recipe?.prepTasks);

  if (prepSteps.length) {
    return prepSteps.map((step, idx) =>
      normalizeTask(step, {
        domain: "cooking",
        sourceType: "recipe",
        sourceId: id,
        sourceName: name,
        fallbackId: `${id || "recipe"}:${step?.id || idx}`,
        fallbackLabel: `[${name}] ${
          step?.label || step?.title || step?.name || "Prep"
        }`,
        meta: { recipeId: id },
        now,
      })
    );
  }

  // Fallback: if recipe has "steps" and some are marked prep/setup
  const steps = arrayish(recipe?.steps);
  const implicit = steps
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => {
      const t = String(s?.title || s?.label || s?.name || "").toLowerCase();
      const k = String(s?.kind || s?.type || "").toLowerCase();
      return (
        k.includes("prep") ||
        k.includes("setup") ||
        t.includes("prep") ||
        t.includes("mise")
      );
    })
    .map(({ s, idx }) =>
      normalizeTask(
        {
          label: s?.title || s?.label || s?.name || `Prep Step ${idx + 1}`,
          estimatedMin: secondsToMin(s?.durationSec),
        },
        {
          domain: "cooking",
          sourceType: "recipe",
          sourceId: id,
          sourceName: name,
          fallbackId: `${id || "recipe"}:implicit:${idx}`,
          fallbackLabel: `[${name}] ${
            s?.title || s?.label || s?.name || "Prep"
          }`,
          meta: { recipeId: id, implicit: true },
          now,
        }
      )
    );

  return implicit;
}

function extractFromCleaningLike(roomOrTask, { now }) {
  const id =
    roomOrTask?.id || roomOrTask?.key || roomOrTask?.roomId || undefined;
  const name =
    roomOrTask?.name || roomOrTask?.title || roomOrTask?.label || "Cleaning";

  const taskLists = [
    roomOrTask?.prepTasks,
    roomOrTask?.prep,
    roomOrTask?.tasks,
    roomOrTask?.checklist,
    roomOrTask?.steps,
  ]
    .map(arrayish)
    .filter((a) => a.length);

  if (!taskLists.length) return [];

  const out = [];
  let n = 0;

  for (const list of taskLists) {
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      out.push(
        normalizeTask(t, {
          domain: "cleaning",
          sourceType: "cleaningPlan",
          sourceId: id,
          sourceName: name,
          fallbackId: `${id || "clean"}:${n}`,
          fallbackLabel: `[${name}] ${
            t?.label || t?.title || t?.name || "Task"
          }`,
          meta: { roomId: id },
          now,
        })
      );
      n += 1;
    }
  }
  return out;
}

function extractFromGardenLike(bedOrTask, { now }) {
  const id = bedOrTask?.id || bedOrTask?.key || bedOrTask?.bedId || undefined;
  const name =
    bedOrTask?.name || bedOrTask?.title || bedOrTask?.label || "Garden";

  const lists = [
    bedOrTask?.prepTasks,
    bedOrTask?.prep,
    bedOrTask?.tasks,
    bedOrTask?.chores,
    bedOrTask?.steps,
    bedOrTask?.checklist,
  ]
    .map(arrayish)
    .filter((a) => a.length);

  if (!lists.length) return [];

  const out = [];
  let n = 0;
  for (const list of lists) {
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      out.push(
        normalizeTask(t, {
          domain: "garden",
          sourceType: "gardenPlan",
          sourceId: id,
          sourceName: name,
          fallbackId: `${id || "garden"}:${n}`,
          fallbackLabel: `[${name}] ${
            t?.label || t?.title || t?.name || "Task"
          }`,
          meta: { bedId: id },
          now,
        })
      );
      n += 1;
    }
  }
  return out;
}

function extractFromAnimalsLike(animalOrTask, { now }) {
  const id =
    animalOrTask?.id ||
    animalOrTask?.key ||
    animalOrTask?.animalId ||
    undefined;
  const name =
    animalOrTask?.name ||
    animalOrTask?.title ||
    animalOrTask?.label ||
    "Animals";

  const lists = [
    animalOrTask?.prepTasks,
    animalOrTask?.tasks,
    animalOrTask?.checklist,
    animalOrTask?.steps,
    animalOrTask?.rotation,
    animalOrTask?.rotations,
  ]
    .map(arrayish)
    .filter((a) => a.length);

  if (!lists.length) return [];

  const out = [];
  let n = 0;
  for (const list of lists) {
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      out.push(
        normalizeTask(t, {
          domain: "animals",
          sourceType: "animalTask",
          sourceId: id,
          sourceName: name,
          fallbackId: `${id || "animal"}:${n}`,
          fallbackLabel: `[${name}] ${
            t?.label || t?.title || t?.name || "Task"
          }`,
          meta: { animalId: id },
          now,
        })
      );
      n += 1;
    }
  }
  return out;
}

function extractFromPreservationLike(batchOrTask, { now }) {
  const id =
    batchOrTask?.id || batchOrTask?.key || batchOrTask?.batchId || undefined;
  const name =
    batchOrTask?.name ||
    batchOrTask?.title ||
    batchOrTask?.label ||
    "Preservation";

  const lists = [
    batchOrTask?.prepTasks,
    batchOrTask?.prep,
    batchOrTask?.tasks,
    batchOrTask?.steps,
    batchOrTask?.checklist,
  ]
    .map(arrayish)
    .filter((a) => a.length);

  if (!lists.length) return [];

  const out = [];
  let n = 0;
  for (const list of lists) {
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      out.push(
        normalizeTask(t, {
          domain: "preservation",
          sourceType: "preservationBatch",
          sourceId: id,
          sourceName: name,
          fallbackId: `${id || "preserve"}:${n}`,
          fallbackLabel: `[${name}] ${
            t?.label || t?.title || t?.name || "Task"
          }`,
          meta: { batchId: id },
          now,
        })
      );
      n += 1;
    }
  }
  return out;
}

function extractFromStorehouseLike(moveOrTask, { now }) {
  const id =
    moveOrTask?.id || moveOrTask?.key || moveOrTask?.moveId || undefined;
  const name =
    moveOrTask?.name || moveOrTask?.title || moveOrTask?.label || "Storehouse";

  const lists = [
    moveOrTask?.prepTasks,
    moveOrTask?.tasks,
    moveOrTask?.steps,
    moveOrTask?.checklist,
    moveOrTask?.items,
  ]
    .map(arrayish)
    .filter((a) => a.length);

  if (!lists.length) return [];

  const out = [];
  let n = 0;
  for (const list of lists) {
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      out.push(
        normalizeTask(t, {
          domain: "storehouse",
          sourceType: "storehouse",
          sourceId: id,
          sourceName: name,
          fallbackId: `${id || "store"}:${n}`,
          fallbackLabel: `[${name}] ${
            t?.label || t?.title || t?.name || "Task"
          }`,
          meta: { moveId: id },
          now,
        })
      );
      n += 1;
    }
  }
  return out;
}

function extractGenericTasks(src, { now, domain }) {
  const id = src?.id || src?.key || undefined;
  const name = src?.name || src?.title || src?.label || "Item";

  const lists = [
    src?.prepTasks,
    src?.prep,
    src?.tasks,
    src?.steps,
    src?.checklist,
    src?.todo,
  ]
    .map(arrayish)
    .filter((a) => a.length);

  if (!lists.length) return [];

  const out = [];
  let n = 0;
  for (const list of lists) {
    for (let i = 0; i < list.length; i += 1) {
      const t = list[i];
      out.push(
        normalizeTask(t, {
          domain: normalizeDomain(domain),
          sourceType: "generic",
          sourceId: id,
          sourceName: name,
          fallbackId: `${id || "src"}:${n}`,
          fallbackLabel: `[${name}] ${
            t?.label || t?.title || t?.name || "Task"
          }`,
          meta: {},
          now,
        })
      );
      n += 1;
    }
  }
  return out;
}

/* -----------------------------------------------------------------------------
 * Normalization helpers
 * -------------------------------------------------------------------------- */

function normalizeDomain(domain) {
  const d = String(domain || "unknown").toLowerCase();
  if (d === "cook" || d === "cooks" || d === "kitchen") return "cooking";
  if (d === "clean" || d === "housekeeping") return "cleaning";
  if (d === "farm" || d === "garden" || d === "plants") return "garden";
  if (d === "animal" || d === "livestock") return "animals";
  if (d === "preserve" || d === "preservation" || d === "canning")
    return "preservation";
  if (d === "pantry" || d === "store" || d === "storehouse")
    return "storehouse";
  if (
    d === "cooking" ||
    d === "cleaning" ||
    d === "garden" ||
    d === "animals" ||
    d === "preservation" ||
    d === "storehouse"
  ) {
    return d;
  }
  return "unknown";
}

function arrayish(v) {
  return Array.isArray(v) ? v : [];
}

function secondsToMin(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.max(1, Math.round(n / 60));
}

/**
 * Normalize a task-like input to PrepTask.
 *
 * Accepts:
 * - string label
 * - { label/title/name, estimatedMin/estimatedTime/durationMin/durationSec, dueISO/dueAt, priority, ... }
 *
 * @param {any} raw
 * @param {{
 *  domain: Domain,
 *  sourceType?: string,
 *  sourceId?: string,
 *  sourceName?: string,
 *  fallbackId: string,
 *  fallbackLabel: string,
 *  meta?: Object,
 *  now: Date,
 * }} ctx
 * @returns {PrepTask}
 */
function normalizeTask(raw, ctx) {
  const isString = typeof raw === "string";
  const obj = isString
    ? { label: raw }
    : raw && typeof raw === "object"
    ? raw
    : {};

  const label = String(
    obj.label || obj.title || obj.name || ctx.fallbackLabel || "Prep"
  ).trim();

  const id = String(
    obj.id || obj.taskId || obj.key || ctx.fallbackId || `${Date.now()}`
  ).trim();

  const est = toNumberOrUndefined(
    obj.estimatedMin ??
      obj.estimatedTime ??
      obj.durationMin ??
      (Number.isFinite(obj.durationSec)
        ? Math.round(obj.durationSec / 60)
        : undefined)
  );

  const dueISO =
    typeof obj.dueISO === "string"
      ? obj.dueISO
      : typeof obj.dueAt === "string"
      ? obj.dueAt
      : typeof obj.due === "string"
      ? obj.due
      : undefined;

  const priority = toNumberOrUndefined(obj.priority ?? obj.rank ?? obj.order);

  return {
    id,
    label,
    domain: ctx.domain,
    sourceId: ctx.sourceId,
    sourceType: ctx.sourceType,
    sourceName: ctx.sourceName,
    estimatedMin: est,
    dueISO,
    priority,
    meta: {
      ...(ctx.meta || {}),
      raw: obj && typeof obj === "object" ? safeShallowRaw(obj) : undefined,
      extractedAt: ctx.now.toISOString(),
    },
  };
}

function toNumberOrUndefined(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// Avoid stuffing huge objects in meta.raw (just a shallow pick)
function safeShallowRaw(obj) {
  try {
    const out = {};
    const keys = Object.keys(obj || {}).slice(0, 20);
    for (const k of keys) {
      const val = obj[k];
      // keep primitive-ish only
      if (
        val == null ||
        typeof val === "string" ||
        typeof val === "number" ||
        typeof val === "boolean"
      ) {
        out[k] = val;
      }
    }
    return out;
  } catch {
    return undefined;
  }
}
