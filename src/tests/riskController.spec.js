// File: C:\Users\larho\suka-smart-assistant\src\tests\riskController.spec.js
/**
 * Risk Controller tests — triggers & actions
 * -----------------------------------------------------------------------------
 * Scope
 *  - Validates risk evaluation (green/amber/red) from runtime signals:
 *      • ETA drift, timer overruns, resource conflicts, inventory shortages,
 *        and safety conditions.
 *  - Validates action selection and emitted events payload shape.
 *
 * Context in SSA
 *  - During **control**, the risk controller turns telemetry into actionable
 *    nudges or guards (e.g., extend buffer, autofit, reschedule, pause).
 *  - It must emit normalized events with the envelope:
 *      { type, ts, source, data }
 *
 * Assumed module under test (MUT)
 *  - src/runtime/riskController.js exporting:
 *      evaluateRisk({ session, metrics, conflicts, shortages, policies }) -> {
 *        level: 'green'|'amber'|'red',
 *        reasons: string[],
 *        indicators: { overrunMs?:number, driftMs?:number, conflictCount?:number, shortageCount?:number, safety?:boolean }
 *      }
 *      decideActions({ session, risk, policies }) -> Array<{ key:string, data?:object }>
 *      processEvent(event, ctx) -> {
 *        risk: { level:string, reasons:string[] },
 *        actions: Array<{ key:string, data?:object }>,
 *        emits: Array<{ type:string, ts:string, source:string, data:object }>
 *      }
 *
 * If your signatures differ, adjust the imports/expectations accordingly.
 */

import { evaluateRisk, decideActions, processEvent } from "../runtime/riskController";

// ---------------------------------
// Helpers / fixtures
// ---------------------------------
const ISO = (y, m, d, hh, mm = 0, ss = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm, ss)).toISOString();

function makeSession(overrides = {}) {
  return {
    id: "sess_A",
    title: "Batch cook beans",
    domain: "cooking",
    priorityBand: "P2",
    startISO: ISO(2025, 11, 9, 16, 0),
    endISO: ISO(2025, 11, 9, 17, 0),
    buffers: { softMin: 10 * 60 * 1000, hardMin: 0 }, // ms
    flags: { safety: false },
    resource: { id: "oven-1", type: "device" },
    requiredItems: [
      { itemId: "sku_beans", qty: 1, substitutable: false },
      { itemId: "sku_onion", qty: 1, substitutable: true },
    ],
    ...overrides,
  };
}

const basePolicies = {
  eta: { driftThresholdMin: 5 },
  actions: {
    allowAutoDeferralBands: ["P2", "P3"],
    allowAutoDeferralForSafety: false,
  },
};

// Quick ISO sanity matcher
const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

function hasEnvelope(ev) {
  expect(ev).toHaveProperty("type");
  expect(ev).toHaveProperty("ts");
  expect(ev).toHaveProperty("source");
  expect(ev).toHaveProperty("data");
  expect(typeof ev.type).toBe("string");
  expect(typeof ev.source).toBe("string");
  expect(typeof ev.data).toBe("object");
  expect(ev.ts).toMatch(isoRegex);
}

// ---------------------------------
// evaluateRisk()
// ---------------------------------
describe("evaluateRisk — green path", () => {
  it("returns green when there is no drift, overrun, conflict, or shortage", () => {
    const session = makeSession();
    const risk = evaluateRisk({
      session,
      policies: basePolicies,
      metrics: { overrunMs: 0, driftMs: 0 },
      conflicts: [],
      shortages: [],
    });
    expect(risk.level).toBe("green");
    expect(risk.reasons.length).toBe(0);
    expect(risk.indicators.conflictCount).toBe(0);
    expect(risk.indicators.shortageCount).toBe(0);
  });
});

describe("evaluateRisk — ETA drift & overrun", () => {
  it("becomes amber when drift >= threshold", () => {
    const session = makeSession();
    const risk = evaluateRisk({
      session,
      policies: basePolicies,
      metrics: { driftMs: 6 * 60 * 1000, overrunMs: 0 },
      conflicts: [],
      shortages: [],
    });
    expect(risk.level).toBe("amber");
    expect(risk.reasons.join(" ")).toMatch(/drift/i);
  });

  it("escalates to red on repeated overrun beyond soft buffer", () => {
    const session = makeSession();
    // Simulate a second-tick overrun: overrun exceeds softMin
    const risk = evaluateRisk({
      session,
      policies: basePolicies,
      metrics: { driftMs: 0, overrunMs: session.buffers.softMin + 60 * 1000 },
      conflicts: [],
      shortages: [],
    });
    expect(risk.level).toBe("red");
    expect(risk.reasons.join(" ")).toMatch(/overrun/i);
  });
});

describe("evaluateRisk — conflicts & shortages", () => {
  it("is red when a non-substitutable shortage exists", () => {
    const session = makeSession();
    const shortages = [
      { itemId: "sku_beans", neededQty: 1, substitutable: false },
    ];
    const risk = evaluateRisk({
      session,
      policies: basePolicies,
      metrics: { driftMs: 0, overrunMs: 0 },
      conflicts: [],
      shortages,
    });
    expect(risk.level).toBe("red");
    expect(risk.reasons.join(" ")).toMatch(/shortage/i);
  });

  it("is amber when device conflict exists but alternative resource is available", () => {
    const session = makeSession();
    const conflicts = [
      { kind: "resource.exclusive", resourceId: "oven-1", alternatives: ["oven-2"] },
    ];
    const risk = evaluateRisk({
      session,
      policies: basePolicies,
      metrics: { driftMs: 0, overrunMs: 0 },
      conflicts,
      shortages: [],
    });
    expect(risk.level).toBe("amber");
    expect(risk.reasons.join(" ")).toMatch(/resource/i);
  });
});

describe("evaluateRisk — safety is always red if at risk", () => {
  it("is red for safety-tagged sessions with conflicts", () => {
    const session = makeSession({ flags: { safety: true }, priorityBand: "P0" });
    const conflicts = [{ kind: "resource.exclusive", resourceId: "pressure-canner" }];
    const risk = evaluateRisk({
      session, policies: basePolicies, metrics: { driftMs: 0, overrunMs: 0 }, conflicts, shortages: []
    });
    expect(risk.level).toBe("red");
    expect(risk.indicators.safety).toBe(true);
  });
});

// ---------------------------------
// decideActions()
// ---------------------------------
describe("decideActions — suggestions by risk band", () => {
  it("suggests nothing on green", () => {
    const session = makeSession();
    const risk = { level: "green", reasons: [] };
    const actions = decideActions({ session, risk, policies: basePolicies });
    expect(actions).toEqual([]);
  });

  it("suggests extend buffer & autofit on amber drift", () => {
    const session = makeSession();
    const risk = { level: "amber", reasons: ["eta.drift"] };
    const actions = decideActions({ session, risk, policies: basePolicies }).map(a => a.key);
    expect(actions).toEqual(expect.arrayContaining(["extend_buffer_+5m", "autofit_window", "nudge_+5m"]));
  });

  it("suggests reschedule on red overrun for P2/P3 but not auto-defers safety/P0", () => {
    // Non-safety P2
    const s1 = makeSession({ priorityBand: "P2", flags: { safety: false } });
    const a1 = decideActions({ session: s1, risk: { level: "red", reasons: ["overrun"] }, policies: basePolicies }).map(a => a.key);
    expect(a1).toEqual(expect.arrayContaining(["autofit_defer_low_priority", "reschedule_item"]));

    // Safety P0
    const s2 = makeSession({ priorityBand: "P0", flags: { safety: true } });
    const a2 = decideActions({ session: s2, risk: { level: "red", reasons: ["overrun"] }, policies: basePolicies }).map(a => a.key);
    expect(a2).not.toEqual(expect.arrayContaining(["autofit_defer_low_priority"]));
    expect(a2).toEqual(expect.arrayContaining(["pause_after_task", "summon_user_attention"]));
  });

  it("suggests buy-list and substitute on shortages", () => {
    const session = makeSession();
    const risk = { level: "red", reasons: ["inventory.shortage"] };
    const actions = decideActions({ session, risk, policies: basePolicies }).map(a => a.key);
    expect(actions).toEqual(expect.arrayContaining(["generate_buy_list", "substitute_ingredient_or_skip_optional"]));
  });

  it("suggests reassign_resource when conflict with alternatives", () => {
    const session = makeSession();
    const risk = { level: "amber", reasons: ["resource.conflict:oven-1"], alternatives: ["oven-2"] };
    const actions = decideActions({ session, risk, policies: basePolicies });
    const reassign = actions.find(a => a.key === "reassign_resource");
    expect(reassign).toBeTruthy();
    expect(reassign.data?.to).toBe("oven-2");
  });
});

// ---------------------------------
// processEvent() end-to-end
// ---------------------------------
describe("processEvent — normalized events & actions", () => {
  it("handles eta.updated → amber drift and emits schedule.reschedule_item suggestion", () => {
    const event = {
      type: "eta.updated",
      ts: ISO(2025, 11, 9, 16, 10, 0),
      source: "worker.eta",
      data: { sessionId: "sess_A", domain: "cooking", remainingMs: 35 * 60 * 1000, etaISO: ISO(2025, 11, 9, 17, 10, 0), confidence: 0.82 }
    };

    const session = makeSession();
    const ctx = {
      getSession: () => session,
      getConflicts: () => [],
      getShortages: () => [],
      policies: basePolicies,
    };

    const out = processEvent(event, ctx);
    expect(out.risk.level).toBe("amber");
    expect(out.actions.map(a => a.key)).toEqual(expect.arrayContaining(["reschedule_item", "nudge_+5m", "extend_buffer_+5m"]));
    // There should be at least one normalized emit
    expect(out.emits.length).toBeGreaterThan(0);
    out.emits.forEach(hasEnvelope);
    // Look specifically for reschedule suggestion
    const resched = out.emits.find(e => e.type === "schedule.reschedule_item");
    expect(resched).toBeTruthy();
    expect(resched.data.sessionId).toBe(session.id);
    // Must include an ISO ETA in the suggestion context when available
    expect(resched.data.etaISO).toMatch(isoRegex);
  });

  it("handles schedule.overrun.detected → red and emits schedule.autofit for P2", () => {
    const event = {
      type: "schedule.overrun.detected",
      ts: ISO(2025, 11, 9, 16, 30, 0),
      source: "runtime.executor",
      data: { sessionId: "sess_A", overrunMs: 12 * 60 * 1000 }
    };
    const session = makeSession({ priorityBand: "P2" });

    const ctx = {
      getSession: () => session,
      getConflicts: () => [],
      getShortages: () => [],
      policies: basePolicies,
    };

    const out = processEvent(event, ctx);
    expect(out.risk.level).toBe("red");
    const keys = out.actions.map(a => a.key);
    expect(keys).toEqual(expect.arrayContaining(["autofit_defer_low_priority", "reschedule_item"]));
    // Emitted autofit should have strategy string per docs
    const auto = out.emits.find(e => e.type === "schedule.autofit");
    expect(auto).toBeTruthy();
    expect(auto.data.strategy).toMatch(/compress_neighbors|defer_low_priority/);
  });

  it("handles inventory.shortage.detected → red and emits generate_buy_list", () => {
    const event = {
      type: "inventory.shortage.detected",
      ts: ISO(2025, 11, 9, 15, 30, 0),
      source: "planner.stock",
      data: { items: [{ itemId: "sku_beans", neededQty: 1, substitutable: false }] }
    };
    const session = makeSession();

    const ctx = {
      getSession: () => session,
      getConflicts: () => [],
      getShortages: () => event.data.items,
      policies: basePolicies,
    };

    const out = processEvent(event, ctx);
    expect(out.risk.level).toBe("red");
    expect(out.actions.map(a => a.key)).toEqual(expect.arrayContaining(["generate_buy_list"]));
    const buy = out.emits.find(e => e.type === "grocerylist.generate.requested");
    expect(buy).toBeTruthy();
    hasEnvelope(buy);
  });

  it("respects safety: no auto-deferral for P0 safety sessions", () => {
    const event = {
      type: "schedule.overrun.detected",
      ts: ISO(2025, 11, 9, 16, 30, 0),
      source: "runtime.executor",
      data: { sessionId: "sess_A", overrunMs: 15 * 60 * 1000 }
    };
    const session = makeSession({ priorityBand: "P0", flags: { safety: true } });

    const ctx = {
      getSession: () => session,
      getConflicts: () => [],
      getShortages: () => [],
      policies: basePolicies,
    };

    const out = processEvent(event, ctx);
    expect(out.risk.level).toBe("red");
    const keys = out.actions.map(a => a.key);
    expect(keys).not.toContain("autofit_defer_low_priority");
    // Emits should include a summon/attention or pause-after-task request
    const attn = out.emits.find(e => e.type === "ui.attention.requested" || e.type === "session.pause.request");
    expect(attn).toBeTruthy();
    hasEnvelope(attn);
  });
});
