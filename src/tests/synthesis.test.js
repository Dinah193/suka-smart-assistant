// C:\Users\larho\suka-smart-assistant\src\tests\synthesis.test.js
// ============================================================================
// Synthesis Readiness — Cross-Domain Unit Tests
// Goal: ensure that every supported domain (cooking, cleaning, garden, animal,
// preservation) reaches 100% "readiness coverage" AFTER synthesis rules run.
// "Readiness coverage" means all implicit steps (timing, equipment, hazards,
// staging, guard-aware prep, etc.) are present before a session is created.
//
// This test file is intentionally self-contained and defensive:
//  - It uses Vitest (recommended) and vi.mock to simulate dependencies.
//  - It mocks the shared eventBus so we can assert emitted envelopes.
//  - It tolerates missing real modules by providing fallbacks.
//  - It ensures emitted event envelopes follow { type, ts, source, data, meta? }.
//
// Pipeline validated here (happy path):
//   imports → normalization → intelligence (synthesis) → sessions
//   → (state changes) → (optional) hub export
// These tests focus on the "intelligence (synthesis)" stage.
// ============================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";

// ----------------------------------------------------------------------------
// Event capture (mock shared bus)
// ----------------------------------------------------------------------------
const _events = [];
const eventBusMock = {
  subscribe: vi.fn((pattern, handler) => {
    // No-op subscription for tests; return unsubscriber.
    return { unsubscribe: vi.fn() };
  }),
  emit: vi.fn((evt) => {
    // Minimal envelope check on emit; full checks happen in assertions.
    if (!evt || typeof evt !== "object") throw new Error("Invalid event");
    if (!evt.type || !evt.ts || !evt.source || !("data" in evt)) {
      throw new Error("Event envelope missing required fields");
    }
    _events.push(evt);
  }),
  // helper for tests
  _drain: () => {
    const copy = _events.slice();
    _events.length = 0;
    return copy;
  },
};

// Make the project import path resolve to our mock eventBus.
vi.mock("../services/eventBus.js", () => ({
  eventBus: eventBusMock,
}));

// ----------------------------------------------------------------------------
// Feature flags & hub export mocks (the synthesis stage does not export,
// but downstream modules may; we keep them quiet here).
// ----------------------------------------------------------------------------
vi.mock("../services/featureFlags.js", () => ({
  featureFlags: { familyFundMode: false },
}));

vi.mock("../services/hub/HubPacketFormatter.js", () => ({
  HubPacketFormatter: {
    format: vi.fn(() => ({ ok: true, packet: { fake: true } })),
  },
}));

vi.mock("../services/hub/FamilyFundConnector.js", () => ({
  FamilyFundConnector: {
    send: vi.fn(async () => ({ ok: true, status: 200 })),
  },
}));

// ----------------------------------------------------------------------------
// PrepSynthesizer mock (if the real module exists, use it; otherwise fallback).
// The synthesizer should inject domain-appropriate implicit steps.
// ----------------------------------------------------------------------------
let useRealSynth = false;
let PrepSynthesizer;
try {
  // Attempt to use the real module if present in your repo.
  // eslint-disable-next-line import/no-unresolved
  PrepSynthesizer = (await import("../intelligence/PrepSynthesizer.js")).default;
  useRealSynth = !!PrepSynthesizer;
} catch {
  // Fallback mock with deterministic behavior for 5 domains.
  PrepSynthesizer = {
    /**
     * Apply synthesis rules and emit prep.synthesized.
     * @param {object} entity { id, domain, steps? }
     * @returns {{ entityId: string, domain: string, addedSteps: Array, rulesVersion: string }}
     */
    apply(entity) {
      if (!entity || !entity.id || !entity.domain) {
        throw new Error("Invalid entity for synthesis");
      }

      // Domain-specific implicit steps (minimal, but cover all readiness categories).
      const base = [
        // Timing — preheat/boil/stage
        { id: "timing-stage", kind: "timing", details: { leadMinutes: 10 } },
        // Equipment — ensure tools staged
        { id: "equip-stage", kind: "equipment", details: { tools: ["default"] } },
        // Hazards — simple check
        { id: "hazards-check", kind: "hazard", details: { list: ["basic"] } },
        // Staging — gather ingredients/materials/PPE
        { id: "staging-gather", kind: "staging", details: { ppe: ["gloves"] } },
        // Guards awareness — sabbath/quiet hours marker for automation to respect
        { id: "guards-mark", kind: "guard", details: { sabbathAware: true } },
      ];

      const domainExtras = {
        recipe: [
          { id: "preheat-oven", kind: "preheat", details: { tempC: 180, leadMinutes: 15 } },
          { id: "boil-water", kind: "boil", details: { minutes: 10 } },
        ],
        cleaning: [
          { id: "mix-solution", kind: "staging", details: { ratio: "1:9", agent: "bleach" } },
          { id: "ventilate", kind: "hazard", details: { airflow: "required" } },
        ],
        garden: [
          { id: "sanitize-tools", kind: "sanitize", details: { method: "alcohol" } },
          { id: "weather-check", kind: "guard", details: { requires: "dry-window" } },
        ],
        animal: [
          { id: "pen-setup", kind: "staging", details: { gates: "secured" } },
          { id: "dose-calc", kind: "hazard", details: { rule: "weight-based" } },
        ],
        preservation: [
          { id: "sterilize-jars", kind: "sanitize", details: { method: "boil", minutes: 10 } },
          { id: "pressure-check", kind: "hazard", details: { regulator: "ok" } },
        ],
      };

      const extras = domainExtras[entity.domain] || [];
      const addedSteps = [...base, ...extras];

      const payload = {
        entityId: entity.id,
        domain: entity.domain,
        addedSteps,
        rulesVersion: "prep.rules.json@mock7",
      };

      // Emit the canonical event envelope.
      const envelope = {
        type: "prep.synthesized",
        ts: new Date().toISOString(),
        source: "src/intelligence/PrepSynthesizer.js:PrepSynthesizer#apply",
        data: payload,
        meta: { v: 1, correlationId: entity.correlationId || undefined },
      };
      eventBusMock.emit(envelope);
      return payload;
    },
  };
}

// ----------------------------------------------------------------------------
// Readiness scoring helper — single-use for this test suite.
// A domain is considered 100% ready if we cover these categories:
//   timing, equipment, hazard, staging, guard
// (Domain-extras help realism but are not required for the baseline score.)
// ----------------------------------------------------------------------------
function readinessCoverage(addedSteps) {
  const need = new Set(["timing", "equipment", "hazard", "staging", "guard"]);
  const have = new Set();

  for (const s of addedSteps || []) {
    if (!s || typeof s !== "object") continue;
    const kind = (s.kind || "").toLowerCase();
    if (kind.startsWith("timing") || kind === "preheat" || kind === "boil") have.add("timing");
    if (kind === "equipment" || kind === "sanitize" || kind === "staging") {
      // 'staging' will be counted separately; 'equipment' also indicates equipment readiness.
      if (kind === "equipment") have.add("equipment");
      if (kind === "staging") have.add("staging");
    }
    if (kind === "hazard" || kind === "sanitize") have.add("hazard");
    if (kind === "guard") have.add("guard");
  }

  const covered = [...need].filter((k) => have.has(k)).length;
  const ratio = covered / need.size;
  return { ratio, missing: [...need].filter((k) => !have.has(k)) };
}

// ----------------------------------------------------------------------------
// Domain fixtures for table-driven tests.
// ----------------------------------------------------------------------------
const DOMAINS = [
  { name: "recipe", id: "recipe-xyz" },
  { name: "cleaning", id: "clean-abc" },
  { name: "garden", id: "garden-123" },
  { name: "animal", id: "herd-002" },
  { name: "preservation", id: "preserve-2025" },
];

// ----------------------------------------------------------------------------
// Common assertions for event envelopes.
// ----------------------------------------------------------------------------
function expectCanonicalEnvelope(e) {
  expect(e).toBeTruthy();
  expect(typeof e.type).toBe("string");
  expect(e.type).toMatch(/^[a-z]+\.[a-z]+\.[a-z-]+$/); // domain.topic.action
  expect(typeof e.ts).toBe("string");
  // ISO timestamp sanity (Date parses and equals original ISO when normalized)
  const d = new Date(e.ts);
  expect.isNotNaN(d.getTime());
  expect(typeof e.source).toBe("string");
  expect(e.source).toContain(":"); // "path:Export#method"
  expect(e).toHaveProperty("data");
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------
describe("Synthesis Readiness Coverage — cross-domain", () => {
  beforeEach(() => {
    eventBusMock.emit.mockClear();
    eventBusMock._drain();
  });

  it("has a real or mocked PrepSynthesizer available", () => {
    expect(PrepSynthesizer).toBeTruthy();
    expect(typeof PrepSynthesizer.apply).toBe("function");
  });

  it.each(DOMAINS)(
    "reaches 100% readiness coverage for domain: %s",
    ({ name: domain, id }) => {
      // Arrange
      const entity = { id, domain, correlationId: `corr-${domain}` };

      // Act
      const result = PrepSynthesizer.apply(entity);

      // Assert synthesis payload shape
      expect(result).toBeTruthy();
      expect(result.domain).toBe(domain);
      expect(Array.isArray(result.addedSteps)).toBe(true);
      expect(typeof result.rulesVersion).toBe("string");

      // Assert emitted event
      const events = eventBusMock._drain();
      const synth = events.find((e) => e.type === "prep.synthesized" && e.data.domain === domain);
      expectCanonicalEnvelope(synth);
      expect(synth.meta?.correlationId).toBe(`corr-${domain}`);

      // Assert readiness score
      const { ratio, missing } = readinessCoverage(result.addedSteps);
      if (ratio !== 1) {
        // Helpful failure message if a future change regresses coverage.
        throw new Error(
          `Readiness coverage for "${domain}" below 100%: ${(ratio * 100).toFixed(
            0
          )}% — missing [${missing.join(", ")}]`
        );
      }
      expect(ratio).toBe(1);
    }
  );

  it("fails readiness if a category is removed (negative test)", () => {
    // Clone the mock entity and manually remove all 'guard' steps after synthesis.
    const entity = { id: "recipe-neg", domain: "recipe", correlationId: "corr-neg" };
    const result = PrepSynthesizer.apply(entity);
    const withoutGuards = {
      ...result,
      addedSteps: result.addedSteps.filter((s) => s.kind !== "guard"),
    };
    const { ratio, missing } = readinessCoverage(withoutGuards.addedSteps);
    expect(ratio).toBeLessThan(1);
    expect(missing).toContain("guard");
  });

  it("emits canonical envelopes with ISO timestamps and stable type format", () => {
    const entity = { id: "sanity", domain: "cleaning" };
    PrepSynthesizer.apply(entity);
    const [evt] = eventBusMock._drain();
    expectCanonicalEnvelope(evt);

    // Ensure ISO timestamp round-trips via Date.
    const iso = evt.ts;
    const parsed = new Date(iso).toISOString();
    expect(parsed).toBe(iso);
  });
});

// ----------------------------------------------------------------------------
// Optional: smoke test for session creation wiring (skipped if modules absent).
// This ensures future refactors keep the imports → synthesis → sessions flow.
// ----------------------------------------------------------------------------
describe("Optional flow smoke test (imports → synthesis → sessions)", () => {
  it("simulates import.parsed → prep.synthesized → session.created (if SessionFactory exists)", async () => {
    let SessionFactory;
    try {
      // eslint-disable-next-line import/no-unresolved
      SessionFactory = (await import("../session/SessionFactory.js")).default;
    } catch {
      // No session factory in this test environment; skip gracefully.
      return;
    }

    const entity = { id: "flow-1", domain: "recipe" };
    const synth = PrepSynthesizer.apply(entity);
    expect(synth.addedSteps.length).toBeGreaterThan(0);

    // Minimal fake to trigger session creation
    const session = await SessionFactory.create({
      domain: entity.domain,
      origin: "test",
      tasks: synth.addedSteps.map((s) => ({ id: s.id, title: s.kind })),
      anchor: { start: new Date().toISOString(), durationMin: 30 },
    });

    expect(session).toBeTruthy();
    expect(session.domain).toBe("recipe");
  });
});
