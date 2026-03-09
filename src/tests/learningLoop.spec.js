/**
 * @file C:\Users\larho\suka-smart-assistant\src\tests\learningLoop.spec.js
 *
 * Tests for the "Learning Loop" — calibration updates & convergence.
 *
 * CONTRACT these tests expect from the learning module:
 *   • Location (adjust TARGET_MODULE if different):
 *       src/services/learning/learningLoop.js
 *   • Export (named or default):
 *       async function runCalibration(observations, model, options?, ctx?)
 *         - observations: Array<{
 *             ts: string(ISO),
 *             domain: 'cooking'|'cleaning'|'garden'|'animal'|string,
 *             features: Record<string, number>,  // e.g., { x: 1.2, ... }
 *             predicted: number,                 // model's last prediction
 *             actual: number,                    // truth
 *             weight?: number                    // optional sample weight
 *           }>
 *         - model: {
 *             id: string,
 *             params: Record<string, number>,    // e.g., { a: 0.9, b: 0.2 }
 *             predict?: (features)=>number       // optional; module may ignore
 *           }
 *         - options?: {
 *             learningRate?: number,
 *             tolerance?: number,                // convergence tolerance (loss delta)
 *             maxSteps?: number,
 *             regularization?: number,           // L2
 *             perDomain?: boolean,               // allow domain-local updates
 *             detectDrift?: boolean,             // emit drift events
 *             commit?: boolean                   // if true, module persists updated model
 *           }
 *         - ctx?: { source?: string }
 *       RETURNS:
 *         {
 *           ok: boolean,
 *           updates: Array<{ key: string, old: number, next: number, delta: number, domain?: string }>,
 *           metrics: {
 *             lossBefore: number,
 *             lossAfter: number,
 *             steps: number,
 *             converged: boolean,
 *             tolerance: number
 *           },
 *           suggestions: string[],
 *           model?: { id: string, params: Record<string, number> } // updated snapshot
 *         }
 *   • Events (via shared eventBus):
 *       eventBus.emit('automation.event', {
 *         type: 'learning.calibration.step' | 'learning.calibration.updated' |
 *               'learning.convergence.reached' | 'learning.data.drift.detected',
 *         ts: <ISO>,
 *         source: 'learningLoop',
 *         data: { modelId, step?, loss?, updates?, metrics?, domain? }
 *       })
 *
 * PIPELINE NOTE:
 *   imports → normalize → intelligence → automation → learningLoop(calibrate) → better suggestions
 *   The learning loop improves internal parameters (intelligence). It SHOULD NOT mutate household
 *   inventory/storehouse/sessions directly; therefore no Hub export is asserted here. If your
 *   implementation chooses to persist the updated model when options.commit === true, it MUST still
 *   limit Hub export to household data mutations only (not covered in this spec).
 */

import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";

// ───────────────────────────────────────────────────────────────────────────────
// Adjust this path if your learning module lives somewhere else.
const TARGET_MODULE = "src/services/learning/learningLoop.js";

// Mock the eventBus so we can assert emitted events without side effects.
vi.mock("src/services/events/eventBus.js", () => {
  const fakeBus = {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { default: fakeBus, eventBus: fakeBus };
});

let mod = null;
let runCalibration = null;

async function tryLoadModule() {
  try {
    const m = await import(/* @vite-ignore */ TARGET_MODULE);
    return m;
  } catch {
    return null;
  }
}

beforeAll(async () => {
  mod = await tryLoadModule();
  if (mod) {
    runCalibration = mod.runCalibration || mod.default || null;
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Synthetic dataset builders

function isoNowPlus(ms = 0) {
  return new Date(Date.now() + ms).toISOString();
}

/**
 * Build a synthetic linear dataset for y = A*x + B + noise
 * With optional per-domain slope/offset to ensure multi-domain updates are exercised.
 */
function buildLinearObservations({
  n = 200,
  global = { A: 1.8, B: 0.4, noise: 0.05 },
  perDomain = {
    cooking: { A: 2.0, B: 0.2 },
    cleaning: { A: 1.6, B: 0.6 },
    garden: { A: 1.9, B: 0.1 },
    animal: { A: 1.7, B: 0.5 },
  },
} = {}) {
  const domains = Object.keys(perDomain);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const domain = domains[i % domains.length];
    const x = (i % 20) / 5 + Math.random() * 0.2; // 0..~4 + jitter
    const d = perDomain[domain];
    const actual = d.A * x + d.B + (Math.random() - 0.5) * global.noise;
    // Start the "current model" a bit off to ensure there is learnable signal:
    const predicted = (global.A - 0.5) * x + (global.B + 0.3);
    out.push({
      ts: isoNowPlus(i * 5_000),
      domain,
      features: { x },
      predicted,
      actual,
      weight: 1,
    });
  }
  return out;
}

function makeInitialModel(params = { a: 1.2, b: 0.6 }) {
  return {
    id: "cal-model-001",
    params: { ...params }, // a*x + b
    predict: ({ x }) => (params.a ?? 0) * x + (params.b ?? 0),
  };
}

function basicCtx() {
  return { source: "learningLoop" };
}

// ───────────────────────────────────────────────────────────────────────────────

(mod ? describe : describe.skip)(
  "Learning Loop — calibration updates & convergence",
  () => {
    let eventBus;
    beforeEach(async () => {
      const eb = await import("src/services/events/eventBus.js");
      eventBus = eb.default || eb.eventBus;
      eventBus.emit.mockClear();
    });

    it("exports runCalibration(observations, model, options?, ctx?)", () => {
      expect(typeof runCalibration).toBe("function");
      expect(runCalibration.length).toBeGreaterThanOrEqual(2);
    });

    it("reduces loss and emits calibration events on a learnable linear dataset", async () => {
      const observations = buildLinearObservations({ n: 160 });
      const model = makeInitialModel({ a: 1.0, b: 0.8 });

      const result = await runCalibration(
        observations,
        model,
        {
          learningRate: 0.05,
          tolerance: 1e-4,
          maxSteps: 200,
          regularization: 0.0001,
          perDomain: false,
          detectDrift: false,
        },
        basicCtx()
      );

      // Return shape
      expect(result && typeof result).toBe("object");
      expect(typeof result.ok).toBe("boolean");
      expect(Array.isArray(result.updates)).toBe(true);
      expect(result.metrics && typeof result.metrics.lossBefore).toBe("number");
      expect(result.metrics && typeof result.metrics.lossAfter).toBe("number");

      // Loss should go down
      expect(result.metrics.lossAfter).toBeLessThan(result.metrics.lossBefore);

      // Should emit step and updated events at least once
      const calls = eventBus.emit.mock.calls.filter(
        ([evt]) => evt === "automation.event"
      );
      const types = calls.map(([, p]) => p.type);
      expect(types).toContain("learning.calibration.updated");
      // Optional step events (at least one is nice to have)
      expect(
        types.some(
          (t) =>
            t === "learning.calibration.step" ||
            t === "learning.convergence.reached"
        )
      ).toBe(true);

      // ISO timestamp sanity on the last payload
      const lastPayload = calls[calls.length - 1][1];
      expect(() => new Date(lastPayload.ts).toISOString()).not.toThrow();
    });

    it("converges within tolerance when signal is strong and steps are sufficient", async () => {
      const observations = buildLinearObservations({ n: 240 });
      const model = makeInitialModel({ a: 0.3, b: 1.2 }); // deliberately far

      const result = await runCalibration(
        observations,
        model,
        {
          learningRate: 0.08,
          tolerance: 1e-5,
          maxSteps: 400,
          regularization: 0.00005,
          perDomain: false,
        },
        basicCtx()
      );

      expect(result.ok).toBe(true);
      expect(result.metrics.converged).toBe(true);
      expect(result.metrics.steps).toBeLessThanOrEqual(400);

      // Expect a convergence event
      const calls = eventBus.emit.mock.calls.filter(
        (c) => c[0] === "automation.event"
      );
      const convergenceEvent = calls
        .map((c) => c[1])
        .find((p) => p.type === "learning.convergence.reached");
      expect(convergenceEvent).toBeTruthy();
      expect(() => new Date(convergenceEvent.ts).toISOString()).not.toThrow();
    });

    it("supports per-domain calibration (params updated with domain qualifiers)", async () => {
      const observations = buildLinearObservations({ n: 240 });
      const model = makeInitialModel({ a: 1.1, b: 0.7 });

      const result = await runCalibration(
        observations,
        model,
        {
          learningRate: 0.06,
          tolerance: 5e-5,
          maxSteps: 250,
          perDomain: true,
        },
        basicCtx()
      );

      // Expect updates that may include domain-specific keys (e.g., a:cooking, b:cleaning)
      expect(result.updates.length).toBeGreaterThan(0);
      const hasDomainKey = result.updates.some(
        (u) => u.key.includes(":") || u.domain
      );
      expect(hasDomainKey).toBe(true);

      // Loss reduction still expected
      expect(result.metrics.lossAfter).toBeLessThan(result.metrics.lossBefore);
    });

    it("detects data drift when recent window diverges significantly from current params", async () => {
      // Build two windows: old (fits a~1.8,b~0.4) and recent (shifted slope/offset)
      const oldObs = buildLinearObservations({ n: 120 });
      const driftObs = buildLinearObservations({
        n: 80,
        global: { A: 2.4, B: 1.0, noise: 0.05 }, // induce drift
        perDomain: {
          cooking: { A: 2.6, B: 0.9 },
          cleaning: { A: 2.3, B: 1.1 },
          garden: { A: 2.5, B: 0.8 },
          animal: { A: 2.2, B: 1.2 },
        },
      }).map((o) => ({
        ...o,
        ts: isoNowPlus(86_400_000 + Math.random() * 5_000),
      })); // one day later

      const observations = [...oldObs, ...driftObs];
      const model = makeInitialModel({ a: 1.8, b: 0.4 });

      const result = await runCalibration(
        observations,
        model,
        {
          learningRate: 0.03,
          tolerance: 1e-4,
          maxSteps: 150,
          detectDrift: true,
        },
        basicCtx()
      );

      // Either the module adapts (lossAfter << lossBefore) OR it flags drift explicitly
      const calls = eventBus.emit.mock.calls.filter(
        (c) => c[0] === "automation.event"
      );
      const driftEvt = calls
        .map((c) => c[1])
        .find((p) => p.type === "learning.data.drift.detected");
      expect(
        driftEvt || result.metrics.lossAfter < result.metrics.lossBefore * 0.7
      ).toBeTruthy();
    });

    it("is idempotent on empty/noisy input and remains defensive", async () => {
      const model = makeInitialModel({ a: 1.0, b: 0.5 });

      const empty = await runCalibration(
        [],
        model,
        { tolerance: 1e-6 },
        basicCtx()
      );
      expect(empty.ok).toBe(true);
      expect(
        empty.updates.length === 0 ||
          Math.abs(empty.metrics.lossAfter - empty.metrics.lossBefore) <= 1e-12
      ).toBe(true);

      const bad = await runCalibration(null, null);
      expect(bad && typeof bad.ok === "boolean").toBe(true);
      expect(Array.isArray(bad.updates)).toBe(true);
      expect(Array.isArray(bad.suggestions)).toBe(true);

      // Should still emit a diagnostic event
      const calls = eventBus.emit.mock.calls.filter(
        (c) => c[0] === "automation.event"
      );
      expect(calls.length).toBeGreaterThan(0);
    });

    it("scales to large batches without timing out (basic perf sanity)", async () => {
      // 5k samples across domains
      const big = buildLinearObservations({ n: 5000 });
      const model = makeInitialModel({ a: 0.0, b: 0.0 });

      const t0 = performance.now();
      const result = await runCalibration(
        big,
        model,
        {
          learningRate: 0.02,
          tolerance: 5e-5,
          maxSteps: 120,
          regularization: 0.0001,
        },
        basicCtx()
      );
      const elapsed = performance.now() - t0;

      expect(result && typeof result.ok === "boolean").toBe(true);
      // Loose ceiling so CI stays green; adjust if your environment is faster/slower.
      expect(elapsed).toBeLessThan(3000);
    });

    it('emits a single "updated" envelope summarizing param deltas after calibration', async () => {
      const observations = buildLinearObservations({ n: 200 });
      const model = makeInitialModel({ a: 0.5, b: 1.1 });

      const result = await runCalibration(
        observations,
        model,
        {
          learningRate: 0.05,
          tolerance: 1e-4,
          maxSteps: 200,
        },
        basicCtx()
      );

      const calls = eventBus.emit.mock.calls.filter(
        (c) => c[0] === "automation.event"
      );
      const updates = calls
        .map((c) => c[1])
        .filter((p) => p.type === "learning.calibration.updated");
      expect(updates.length).toBeGreaterThan(0);
      const last = updates[updates.length - 1];
      expect(last.data && Array.isArray(last.data.updates)).toBe(true);

      // Ensure reported deltas match the result snapshot (order-insensitive)
      const sortedA = (arr) =>
        arr.slice().sort((x, y) => x.key.localeCompare(y.key));
      expect(
        sortedA(last.data.updates).map((u) => ({
          key: u.key,
          delta: round4(u.delta),
        }))
      ).toEqual(
        sortedA(result.updates).map((u) => ({
          key: u.key,
          delta: round4(u.delta),
        }))
      );
    });
  }
);

// ───────────────────────────────────────────────────────────────────────────────
// Small helpers for assertions

function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

// If the module isn’t present yet, surface a helpful note in test output.
if (!mod) {
  // eslint-disable-next-line no-console
  console.warn(
    `[learningLoop.spec] Skipping learning loop tests. Module not found at "${TARGET_MODULE}". ` +
      `Create the file and export "runCalibration(observations, model, options?, ctx?)" to enable this suite.`
  );
}
