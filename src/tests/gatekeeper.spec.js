// File: C:\Users\larho\suka-smart-assistant\src\tests\gatekeeper.spec.js
/**
 * Gatekeeper tests — T−x readiness & contingencies
 * -----------------------------------------------------------------------------
 * Scope
 *  - Verifies pre-start readiness (“T−x”) status computation and gating logic.
 *  - Verifies quiet hours / Sabbath policy enforcement and allowed overrides.
 *  - Verifies inventory shortages, resource conflicts, and contingency proposals.
 *
 * Context in SSA
 *  - The gatekeeper runs during **gate** (after compile, before control):
 *    it determines if a session may start now (or soon), and which actions
 *    could safely resolve any blocks. It does NOT mutate plan data; it
 *    emits decisions/events to the automation bridge.
 *
 * Assumed module under test (MUT)
 *  - src/runtime/gatekeeper.js exporting:
 *      computeTx(session, nowISO, { thresholds }) -> {
 *        status: 'green'|'amber'|'red',
 *        tMinusMin: number,
 *        window: { greenMin:number, amberMin:number, redMin:number }
 *      }
 *      evaluateReadiness({ session, nowISO, policies, inventory, resources, overrides }) -> {
 *        ok: boolean,                       // true if allowed to start now
 *        risk: 'green'|'amber'|'red',       // visual health indicator
 *        reasons: string[],                 // human-readable reasons
 *        blocks: Array<{ kind:string, hard:boolean, details?:object }>,
 *        contingencies: Array<{ action:string, data?:object }>,
 *        allowedActions: string[],          // e.g., ['start','autofit','split']
 *        etaStartISO?: string               // when it will be allowed if blocked
 *      }
 *
 * If your signatures differ, adapt imports & assertions accordingly.
 */

import { computeTx, evaluateReadiness } from "../runtime/gatekeeper";

// ------------------------------
// Helpers / fixtures
// ------------------------------
const ISO = (y, m, d, hh, mm = 0) =>
  new Date(Date.UTC(y, m - 1, d, hh, mm)).toISOString();

const addMinISO = (iso, min) => new Date(new Date(iso).getTime() + min * 60000).toISOString();

const basePolicies = {
  quietHours: { startLocalHour: 22, endLocalHour: 7 },
  sabbathGuard: {
    enabled: true,
    startHint: "Fri 18:00",
    endHint: "Sat 21:00",
  },
  // Keep consistency with docs/policies.md soft/hard semantics:
  safetyHard: true,
};

function makeSession(partial = {}) {
  return {
    id: "sess_A",
    domain: "cooking",
    title: "Batch cook beans",
    startISO: ISO(2025, 11, 9, 16, 0),
    endISO: ISO(2025, 11, 9, 17, 0),
    priorityBand: "P2",
    flags: { safety: false },
    resource: { id: "oven-1", type: "device", name: "Kitchen Oven" },
    requiredItems: [
      { itemId: "sku_beans", qty: 1, unit: "can", substitutable: false },
      { itemId: "sku_onion", qty: 1, unit: "pc", substitutable: true },
    ],
    ...partial,
  };
}

function makeInventory(overrides = {}) {
  return {
    items: {
      sku_beans: 1,
      sku_onion: 0, // missing but substitutable
    },
    ...overrides,
  };
}

function makeResources(overrides = {}) {
  return {
    devices: {
      "oven-1": { busy: false },
      "oven-2": { busy: false },
    },
    people: {},
    spaces: {},
    ...overrides,
  };
}

// ------------------------------
// T−x readiness computations
// ------------------------------
describe("computeTx() — T−x readiness bands", () => {
  const thresholds = { greenMin: 30, amberMin: 10, redMin: 0 };

  it("returns GREEN when T−x >= green threshold", () => {
    const now = ISO(2025, 11, 9, 15, 0); // start at 16:00 → T−60
    const session = makeSession();
    const r = computeTx(session, now, { thresholds });
    expect(r.status).toBe("green");
    expect(r.tMinusMin).toBe(60);
    expect(r.window).toEqual(thresholds);
  });

  it("returns AMBER when greenMin > T−x >= amberMin", () => {
    const now = ISO(2025, 11, 9, 15, 50); // T−10
    const session = makeSession();
    const r = computeTx(session, now, { thresholds });
    expect(r.status).toBe("amber");
    expect(r.tMinusMin).toBe(10);
  });

  it("returns RED when T−x < amberMin", () => {
    const now = ISO(2025, 11, 9, 15, 55); // T−5
    const session = makeSession();
    const r = computeTx(session, now, { thresholds });
    expect(r.status).toBe("red");
    expect(r.tMinusMin).toBe(5);
  });
});

// ------------------------------
// Quiet hours & Sabbath policy gating
// ------------------------------
describe("evaluateReadiness() — quiet hours & Sabbath gating", () => {
  it("blocks non-safety work during quiet hours", () => {
    // Quiet hours 22:00–07:00; start at 22:05
    const session = makeSession({
      startISO: ISO(2025, 11, 9, 22, 5),
      endISO: ISO(2025, 11, 9, 23, 0),
      priorityBand: "P2",
      flags: { safety: false },
    });
    const now = ISO(2025, 11, 9, 22, 4);
    const inventory = makeInventory();
    const resources = makeResources();

    const r = evaluateReadiness({ session, nowISO: now, policies: basePolicies, inventory, resources, overrides: {} });
    expect(r.ok).toBe(false);
    expect(r.blocks.some(b => b.kind === "quietHours" && b.hard)).toBe(true);
    expect(r.etaStartISO).toBeDefined(); // should point to 07:00 boundary or later
    expect(r.contingencies.map(c => c.action)).toEqual(expect.arrayContaining(["move_to_morning", "reassign_resource", "autofit"]));
  });

  it("allows P0 (safety) sessions during quiet hours", () => {
    const session = makeSession({
      startISO: ISO(2025, 11, 9, 22, 5),
      endISO: ISO(2025, 11, 9, 23, 0),
      priorityBand: "P0",
      flags: { safety: true },
    });
    const now = ISO(2025, 11, 9, 22, 0);
    const r = evaluateReadiness({
      session, nowISO: now, policies: basePolicies, inventory: makeInventory(), resources: makeResources(), overrides: {}
    });
    expect(r.ok).toBe(true);
    expect(r.blocks.every(b => b.kind !== "quietHours")).toBe(true);
    expect(r.allowedActions).toContain("start");
  });

  it("blocks during Sabbath window unless explicitly overridden", () => {
    // Assume Sat 19:00 is within Sabbath (Fri 18:00 → Sat 21:00)
    const session = makeSession({
      startISO: ISO(2025, 11, 8, 19, 0),  // 2025-11-08 is a Saturday
      endISO: ISO(2025, 11, 8, 20, 0),
      flags: { safety: false },
    });
    const now = ISO(2025, 11, 8, 18, 55);
    const r = evaluateReadiness({
      session, nowISO: now, policies: basePolicies, inventory: makeInventory(), resources: makeResources(), overrides: {}
    });
    expect(r.ok).toBe(false);
    expect(r.blocks.some(b => b.kind === "sabbath" && b.hard)).toBe(true);

    // With an override scoped to this session, it should be allowed.
    const r2 = evaluateReadiness({
      session, nowISO: now, policies: basePolicies, inventory: makeInventory(), resources: makeResources(),
      overrides: { policyOverrides: [{ scope: "sabbath", sessionId: session.id, expiresISO: ISO(2025, 11, 8, 21, 5) }] }
    });
    expect(r2.ok).toBe(true);
    expect(r2.reasons.join(" ")).toMatch(/override/i);
  });
});

// ------------------------------
// Inventory & resource checks
// ------------------------------
describe("evaluateReadiness() — inventory shortages and substitutes", () => {
  it("blocks when non-substitutable item is missing and proposes contingencies", () => {
    const session = makeSession();
    const inv = makeInventory({ items: { sku_beans: 0, sku_onion: 0 } }); // beans missing (non-substitutable)
    const r = evaluateReadiness({
      session, nowISO: ISO(2025, 11, 9, 15, 40), policies: basePolicies, inventory: inv, resources: makeResources(), overrides: {}
    });

    expect(r.ok).toBe(false);
    expect(r.blocks.some(b => b.kind === "inventory.shortage")).toBe(true);
    const actions = r.contingencies.map(c => c.action);
    expect(actions).toEqual(expect.arrayContaining(["generate_buy_list", "defer_low_priority"]));
    // Because onion is substitutable, suggestion should include substitute
    expect(actions).toContain("substitute_ingredient");
  });
});

describe("evaluateReadiness() — resource conflicts and reassignment", () => {
  it("blocks when required device is busy and suggests reassign", () => {
    const session = makeSession();
    const resources = makeResources({ devices: { "oven-1": { busy: true }, "oven-2": { busy: false } } });

    const r = evaluateReadiness({
      session, nowISO: ISO(2025, 11, 9, 15, 40), policies: basePolicies, inventory: makeInventory(), resources, overrides: {}
    });

    expect(r.ok).toBe(false);
    expect(r.blocks.some(b => b.kind === "resource.exclusive")).toBe(true);
    const reassign = r.contingencies.find(c => c.action === "reassign_resource");
    expect(reassign).toBeTruthy();
    expect(reassign.data?.to).toBe("oven-2");
  });
});

// ------------------------------
// Overrides
// ------------------------------
describe("evaluateReadiness() — explicit quiet-hours override", () => {
  it("permits start when an override exists for this session", () => {
    const session = makeSession({
      startISO: ISO(2025, 11, 9, 22, 15),
      endISO: ISO(2025, 11, 9, 22, 45)
    });
    const overrides = {
      policyOverrides: [{ scope: "quietHours", sessionId: session.id, expiresISO: ISO(2025, 11, 10, 0, 0) }]
    };
    const r = evaluateReadiness({
      session, nowISO: ISO(2025, 11, 9, 22, 10), policies: basePolicies, inventory: makeInventory(), resources: makeResources(), overrides
    });
    expect(r.ok).toBe(true);
    expect(r.allowedActions).toContain("start");
    expect(r.reasons.join(" ")).toMatch(/override/i);
  });
});

// ------------------------------
// Idempotency / immutability
// ------------------------------
describe("evaluateReadiness() — does not mutate inputs", () => {
  it("keeps session/inventory/resources immutable", () => {
    const session = makeSession();
    const inventory = makeInventory();
    const resources = makeResources();

    const frozenSession = JSON.stringify(session);
    const frozenInventory = JSON.stringify(inventory);
    const frozenResources = JSON.stringify(resources);

    const _ = evaluateReadiness({ session, nowISO: ISO(2025, 11, 9, 15, 0), policies: basePolicies, inventory, resources, overrides: {} });

    expect(JSON.stringify(session)).toBe(frozenSession);
    expect(JSON.stringify(inventory)).toBe(frozenInventory);
    expect(JSON.stringify(resources)).toBe(frozenResources);
  });
});

// ------------------------------
// Contingencies catalog consistency
// ------------------------------
describe("evaluateReadiness() — contingency catalog contains expected actions", () => {
  it("surfaces a stable set of known actions under typical blocks", () => {
    const session = makeSession({
      startISO: ISO(2025, 11, 9, 22, 15), // Quiet hours
      endISO: ISO(2025, 11, 9, 22, 45),
    });
    const resources = makeResources({ devices: { "oven-1": { busy: true }, "oven-2": { busy: false } } });
    const inv = makeInventory({ items: { sku_beans: 0, sku_onion: 0 } });

    const r = evaluateReadiness({
      session, nowISO: ISO(2025, 11, 9, 22, 10), policies: basePolicies, inventory: inv, resources, overrides: {}
    });

    const actions = new Set(r.contingencies.map(c => c.action));
    // From policies.md & docs: expect these to appear when applicable
    ["move_to_morning", "reassign_resource", "autofit", "defer_low_priority", "generate_buy_list", "substitute_ingredient"].forEach(a =>
      expect(actions.has(a)).toBe(true)
    );
  });
});
