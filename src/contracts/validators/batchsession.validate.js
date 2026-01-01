// src/contracts/validators/batchsession.validate.js
// Validator + semantic inspector for batchsession.contract.json
// Goals:
// - Fast, cached schema validation (draft-07 to avoid $dynamicRef warnings)
// - Clear, actionable error messages for UI toasts / InlineToastAnchor
// - Domain integrity checks: steps ↔ timers ↔ inventory, dependency cycles,
//   label templates present, Sabbath guard hints, etc.

import Ajv from "ajv";
import addFormats from "ajv-formats";
// Vite/CRA support JSON imports out of the box. If your bundler requires it, add: assert { type: "json" }
import schema from "../../data/contracts/batchsession.contract.json";

// ---------- AJV base (draft-07) ----------
const ajv = new Ajv({
  allErrors: true,
  strict: false,            // allow vendor extensions like x-*
  allowUnionTypes: true,
  coerceTypes: true,        // coerces "5" -> 5 for numeric fields
  useDefaults: true         // applies defaults from schema
});
addFormats(ajv);

let _validate;
function getValidator() {
  if (!_validate) {
    _validate = ajv.compile(schema);
  }
  return _validate;
}

// ---------- Public API ----------
/**
 * Validate shape with AJV, then run semantic checks.
 * @param {any} doc
 * @returns {{ ok: boolean, errors: Array, warnings: Array }}
 */
export function validateBatchSession(doc) {
  const validate = getValidator();
  const isSchemaOk = validate(doc);
  const errors = isSchemaOk ? [] : normalizeAjvErrors(validate.errors || []);
  const { errors: sErrors, warnings } = semanticValidate(doc);

  return {
    ok: isSchemaOk && sErrors.length === 0,
    errors: [...errors, ...sErrors],
    warnings
  };
}

/**
 * Throw if invalid. Convenience for tests/guards.
 * @param {any} doc
 */
export function assertBatchSession(doc) {
  const res = validateBatchSession(doc);
  if (!res.ok) {
    const msg = prettyPrint(res.errors, res.warnings);
    const err = new Error("Invalid BatchSession\n" + msg);
    err.errors = res.errors;
    err.warnings = res.warnings;
    throw err;
  }
  return true;
}

/**
 * Pretty string for toasts/logging.
 */
export function prettyPrint(errors = [], warnings = []) {
  const e = errors.map(e => `❌ ${e.path} — ${e.message}`).join("\n");
  const w = warnings.map(w => `⚠️  ${w.path} — ${w.message}`).join("\n");
  return [e, w].filter(Boolean).join("\n");
}

// ---------- AJV error shaping ----------
function normalizeAjvErrors(ajvErrors) {
  return ajvErrors.map((e) => {
    const path = e.instancePath || e.schemaPath || "";
    let msg = e.message || "Invalid value";
    if (e.keyword === "enum" && e.params && e.params.allowedValues) {
      msg = `Must be one of: ${e.params.allowedValues.join(", ")}`;
    }
    return { path: path || "(root)", message: msg, kind: "schema" };
  });
}

// ---------- Semantic validation ----------
function semanticValidate(doc) {
  const out = {
    errors: [],
    warnings: []
  };

  if (!doc || typeof doc !== "object") return out;

  // Version check (keeps contract drift explicit)
  if (doc.version && doc.version !== "1.0.0") {
    out.warnings.push({
      path: "/version",
      message: `Unexpected contract version "${doc.version}". Expected "1.0.0".`,
      kind: "version"
    });
  }

  const session = doc.session || {};
  const steps = Array.isArray(doc.prepSteps) ? doc.prepSteps : [];
  const timers = doc.timers || {};
  const inv = Array.isArray(doc.inventorySyncPlan) ? doc.inventorySyncPlan : [];

  // Build indexes for referential integrity
  const stepIds = new Set();
  const timerIds = new Set(Object.keys(timers));
  const invIds = new Set();
  const dupes = {
    steps: new Set(),
    inv: new Set()
  };

  for (const s of steps) {
    if (!s || !s.id) continue;
    if (stepIds.has(s.id)) dupes.steps.add(s.id);
    stepIds.add(s.id);
  }
  for (const i of inv) {
    if (!i || !i.id) continue;
    if (invIds.has(i.id)) dupes.inv.add(i.id);
    invIds.add(i.id);
  }

  // Duplicate IDs
  if (dupes.steps.size > 0) {
    for (const id of dupes.steps) {
      out.errors.push({
        path: "/prepSteps",
        message: `Duplicate step id "${id}". Step ids must be unique.`,
        kind: "duplicate-id"
      });
    }
  }
  if (dupes.inv.size > 0) {
    for (const id of dupes.inv) {
      out.errors.push({
        path: "/inventorySyncPlan",
        message: `Duplicate inventory plan id "${id}". Plan ids must be unique.`,
        kind: "duplicate-id"
      });
    }
  }

  // preSteps referential check
  const preSteps = (session.schedule && Array.isArray(session.schedule.preSteps)) ? session.schedule.preSteps : [];
  for (const p of preSteps) {
    if (!p.linkedStepId) {
      out.errors.push({
        path: "/session/schedule/preSteps",
        message: `Pre-step "${p.id || "(unnamed)"}" missing linkedStepId.`,
        kind: "prestep-link"
      });
      continue;
    }
    if (!stepIds.has(p.linkedStepId)) {
      out.errors.push({
        path: "/session/schedule/preSteps",
        message: `Pre-step "${p.id || "(unnamed)"}" references missing step "${p.linkedStepId}".`,
        kind: "prestep-link"
      });
    }
    if (p.offset && p.offset.relation === "absolute" && !p.offset.absoluteAt) {
      out.errors.push({
        path: `/session/schedule/preSteps/${p.id || "unknown"}/offset`,
        message: `relation="absolute" requires "absoluteAt" date-time.`,
        kind: "prestep-offset"
      });
    }
  }

  // Step → timer links and timer actions referencing stepIds
  for (const s of steps) {
    if (s.timerId && !timerIds.has(s.timerId)) {
      out.errors.push({
        path: `/prepSteps/${s.id}/timerId`,
        message: `Timer "${s.timerId}" not found in /timers.`,
        kind: "timer-missing"
      });
    }
    // inventoryImpacts -> planId exists
    if (Array.isArray(s.inventoryImpacts)) {
      for (const imp of s.inventoryImpacts) {
        if (imp && imp.planId && !invIds.has(imp.planId)) {
          out.errors.push({
            path: `/prepSteps/${s.id}/inventoryImpacts`,
            message: `References missing inventory plan "${imp.planId}".`,
            kind: "inventory-plan-missing"
          });
        }
      }
    }

    // Resource duplicates within a step (kind+id)
    if (Array.isArray(s.resources)) {
      const seen = new Set();
      for (const r of s.resources) {
        const key = `${r.kind || "?"}::${r.id || "?"}`;
        if (seen.has(key)) {
          out.warnings.push({
            path: `/prepSteps/${s.id}/resources`,
            message: `Duplicate resource "${key}" referenced in same step.`,
            kind: "resource-dup"
          });
        }
        seen.add(key);
      }
    }

    // Chill chain guard: passive > maxMinutesOut
    if (s.safety && s.safety.flags && s.safety.flags.includes("raw-meat")) {
      const passive = (s.durationEstimate && s.durationEstimate.passiveMinutes) || 0;
      const maxOut = (s.safety.chillChain && s.safety.chillChain.maxMinutesOut) || null;
      if (maxOut != null && passive > maxOut) {
        out.warnings.push({
          path: `/prepSteps/${s.id}/safety/chillChain`,
          message: `Passive time (${passive}m) exceeds chillChain.maxMinutesOut (${maxOut}m).`,
          kind: "chillchain"
        });
      }
    }

    // Labels: require templateId (schema enforces) + warn if copies unset
    if (Array.isArray(s.labels)) {
      for (const l of s.labels) {
        if (l && !("copies" in l)) {
          out.warnings.push({
            path: `/prepSteps/${s.id}/labels`,
            message: `Label "${l.templateId}" has no 'copies' specified. Using default=1.`,
            kind: "labels-copies"
          });
        }
      }
    }
  }

  // Timer completeActions referencing stepId / payload sanity
  for (const [tid, t] of Object.entries(timers)) {
    const actions = t?.bindings?.completeActions;
    if (Array.isArray(actions)) {
      for (const a of actions) {
        if (a?.kind === "print-labels") {
          const sid = a?.payload?.stepId;
          if (sid && !stepIds.has(sid)) {
            out.errors.push({
              path: `/timers/${tid}/bindings/completeActions`,
              message: `Timer action "print-labels" references missing step "${sid}".`,
              kind: "timer-action-step-missing"
            });
          }
        }
      }
    }
  }

  // Inventory plans: intent-based sanity
  for (const p of inv) {
    if (p.intent === "produce") {
      if (!p.destination && !p.preservation) {
        out.warnings.push({
          path: `/inventorySyncPlan/${p.id}`,
          message: `intent="produce" should specify destination and/or preservation.`,
          kind: "inventory-produce-destination"
        });
      }
    }
    if (!p.item || typeof p.item.quantity !== "number") {
      out.errors.push({
        path: `/inventorySyncPlan/${p.id || "(no-id)"}/item`,
        message: `Missing item or quantity.`,
        kind: "inventory-item"
      });
    }
  }

  // Dependencies acyclicity
  const depGraph = new Map();
  for (const s of steps) {
    depGraph.set(s.id, (s.dependencies || []).filter(Boolean));
  }
  const cycles = findCycles(depGraph);
  for (const cyc of cycles) {
    out.errors.push({
      path: "/prepSteps/dependencies",
      message: `Cyclic dependency detected: ${cyc.join(" → ")} → ${cyc[0]}`,
      kind: "cycle"
    });
  }

  // UX hints: primaryPanel in showPanels
  const ux = session["x-uxHints"] || doc["x-uxHints"] || {};
  if (ux.primaryPanel && Array.isArray(ux.showPanels) && !ux.showPanels.includes(ux.primaryPanel)) {
    out.warnings.push({
      path: "/session/x-uxHints/primaryPanel",
      message: `primaryPanel "${ux.primaryPanel}" not found in showPanels; UI may not auto-focus correctly.`,
      kind: "ux-hint"
    });
  }

  // Sabbath guard hints
  const sg = session?.schedule?.sabbathGuard;
  if (sg?.enabled && (!Array.isArray(sg.windows) || sg.windows.length === 0)) {
    out.warnings.push({
      path: "/session/schedule/sabbathGuard",
      message: "Sabbath guard is enabled but has no windows defined.",
      kind: "sabbath-guard"
    });
  }

  return out;
}

// ---------- Helpers ----------
function findCycles(graph) {
  // graph: Map<node, string[]>
  const visited = new Set();
  const stack = new Set();
  const cycles = [];

  function dfs(node, path) {
    if (stack.has(node)) {
      // found a cycle; slice to cycle start
      const idx = path.indexOf(node);
      cycles.push(path.slice(idx));
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);

    const next = graph.get(node) || [];
    for (const n of next) dfs(n, [...path, n]);

    stack.delete(node);
  }

  for (const node of graph.keys()) {
    if (!visited.has(node)) dfs(node, [node]);
  }
  return cycles;
}

export default {
  validateBatchSession,
  assertBatchSession,
  prettyPrint
};
