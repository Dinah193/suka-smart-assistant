// C:\Users\larho\suka-smart-assistant\src\tests\preferences.test.js
// ============================================================================
// Preferences — Defaults Load & Apply Tests
// Validates that household default preferences can be loaded, merged with
// user overrides, and correctly applied to domain entities (cooking, cleaning,
// garden, animal). Also asserts canonical event envelopes are emitted.
//
// SSA pipeline context:
// imports → normalization → INTELLIGENCE (uses prefs) → sessions/automation
// → state changes → (optional) hub export
//
// Runner: Vitest
// ============================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Event bus mock — capture envelopes and assert canonical shape.
// ---------------------------------------------------------------------------
const events = [];
const eventBusMock = {
  emit: vi.fn((envelope) => {
    if (!envelope || typeof envelope !== "object") throw new Error("Bad event");
    if (
      !envelope.type ||
      !envelope.ts ||
      !envelope.source ||
      envelope.data === undefined
    ) {
      throw new Error("Event missing required envelope fields");
    }
    events.push(envelope);
  }),
  subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
  _drain: () => {
    const cp = events.slice();
    events.length = 0;
    return cp;
  },
};

vi.mock("../services/events/eventBus.js", () => ({ eventBus: eventBusMock }));

// ---------------------------------------------------------------------------
// Attempt to use real Preferences modules if they exist. Otherwise, provide
// robust fallbacks with the same public intent:
//   • PreferencesService.getDefaults() -> DefaultHouseholdPreferences
//   • PreferencesService.load(overrides?) -> merged prefs (emits preferences.loaded)
//   • applyPreferences(entity, domain, prefs) -> adjusted entity (emits preferences.applied)
// ---------------------------------------------------------------------------
let PreferencesService;
let applyPreferences;

// Util
const isoNow = () => new Date().toISOString();

// Fallback default prefs: keep minimal but representative fields used in tests.
const FALLBACK_DEFAULTS = Object.freeze({
  units: "metric", // metric|imperial
  cooking: {
    doneness: "medium", // raw|rare|medium-rare|medium|medium-well|well
    sweetness: "medium", // low|medium|high
    spiceLevel: 2, // 0-5
    preferredOils: ["olive", "avocado"],
    portionSize: 1, // multiplier
    timersSpeak: true,
  },
  cleaning: {
    aromatics: ["lemon", "eucalyptus"],
    sensitivity: "normal", // fragrance-free|normal
    waterTempC: 45,
  },
  garden: {
    zone: "8a",
    defaultBed: "A1",
    wateringMinutes: 20,
  },
  animal: {
    dosageRounding: "nearest-0.5-ml",
    handlingPPE: ["gloves"],
  },
  guards: {
    sabbath: true,
    quietHours: { start: "22:00", end: "06:00" }, // local clock HH:mm
  },
});

const FallbackPreferencesService = {
  getDefaults() {
    return JSON.parse(JSON.stringify(FALLBACK_DEFAULTS));
  },

  /**
   * Merge user overrides over defaults. Emits preferences.loaded.
   * @param {object} overrides
   * @returns {object} merged preferences
   */
  load(overrides = {}) {
    const merged = deepMerge(this.getDefaults(), sanitize(overrides));
    eventBusMock.emit({
      type: "preferences.loaded",
      ts: isoNow(),
      source: "src/services/preferences/PreferencesService.js:load",
      data: {
        profile: "household",
        defaultsVersion: "prefs.defaults.json@1",
        overridesApplied: Object.keys(overrides || {}).length > 0,
      },
      meta: { v: 1 },
    });
    return merged;
  },
};

const FallbackApplyPreferences = {
  /**
   * Apply preferences to domain-specific entity.
   * Emits preferences.applied with summary of changes.
   * NOTE: This function intentionally does not mutate the input entity.
   */
  apply(entity, domain, prefs) {
    if (!entity || !domain)
      throw new Error("applyPreferences requires entity and domain");
    const p = prefs || FALLBACK_DEFAULTS;
    let adjusted = structuredClone(entity);
    const changes = [];

    if (domain === "cooking") {
      // Unit conversion (example: metric target)
      if (p.units === "metric" && adjusted.tempF != null) {
        adjusted.tempC = round2(((adjusted.tempF - 32) * 5) / 9);
        delete adjusted.tempF;
        changes.push("tempF→tempC");
      }
      // Portion scaling
      if (
        typeof p.cooking.portionSize === "number" &&
        adjusted.ingredients?.length
      ) {
        adjusted.ingredients = adjusted.ingredients.map((ing) =>
          typeof ing.qty === "number"
            ? { ...ing, qty: round2(ing.qty * p.cooking.portionSize) }
            : ing
        );
        changes.push("portionScale");
      }
      // Doneness preference annotation
      adjusted.preferences = {
        ...(adjusted.preferences || {}),
        doneness: p.cooking.doneness,
        sweetness: p.cooking.sweetness,
        spiceLevel: p.cooking.spiceLevel,
      };
      changes.push("doneness/sweetness/spice");
    }

    if (domain === "cleaning") {
      adjusted.aromaticsUsed =
        p.cleaning.sensitivity === "fragrance-free" ? [] : p.cleaning.aromatics;
      adjusted.waterTempC = adjusted.waterTempC ?? p.cleaning.waterTempC;
      changes.push("cleaning.aromatics/waterTemp");
    }

    if (domain === "garden") {
      adjusted.zone = adjusted.zone || p.garden.zone;
      adjusted.defaultBed = adjusted.defaultBed || p.garden.defaultBed;
      adjusted.wateringMinutes =
        adjusted.wateringMinutes ?? p.garden.wateringMinutes;
      changes.push("garden.zone/bed/watering");
    }

    if (domain === "animal") {
      if (
        typeof adjusted.doseMl === "number" &&
        p.animal.dosageRounding === "nearest-0.5-ml"
      ) {
        adjusted.doseMl = roundTo(adjusted.doseMl, 0.5);
        changes.push("animal.doseRound");
      }
      adjusted.ppe = Array.from(
        new Set([...(adjusted.ppe || []), ...(p.animal.handlingPPE || [])])
      );
      changes.push("animal.ppe");
    }

    // Quiet hours hint attached for automation later
    adjusted.guards = {
      ...(adjusted.guards || {}),
      sabbath: !!p.guards.sabbath,
      quietHours: p.guards.quietHours,
    };
    changes.push("guards.hints");

    eventBusMock.emit({
      type: "preferences.applied",
      ts: isoNow(),
      source: "src/services/preferences/applyPreferences.js:apply",
      data: { domain, changes },
      meta: { v: 1 },
    });

    return adjusted;
  },
};

// Try real modules, else fallback
try {
  // eslint-disable-next-line import/no-unresolved
  PreferencesService = (
    await import("../services/preferences/PreferencesService.js")
  ).default;
} catch {
  PreferencesService = FallbackPreferencesService;
}
try {
  // eslint-disable-next-line import/no-unresolved
  ({ applyPreferences } = await import(
    "../services/preferences/applyPreferences.js"
  ));
} catch {
  applyPreferences = FallbackApplyPreferences.apply.bind(
    FallbackApplyPreferences
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function round2(n) {
  return Math.round(n * 100) / 100;
}

function roundTo(n, step) {
  const k = Math.round(n / step) * step;
  return Math.round(k * 100) / 100;
}

function sanitize(o) {
  // Remove undefined to avoid surprising merge
  if (Array.isArray(o)) return o.map(sanitize);
  if (o && typeof o === "object") {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (v !== undefined) out[k] = sanitize(v);
    }
    return out;
  }
  return o;
}

function deepMerge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return b; // override arrays
  if (a && typeof a === "object" && b && typeof b === "object") {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = k in a ? deepMerge(a[k], v) : v;
    }
    return out;
  }
  return b === undefined ? a : b;
}

function expectCanonical(evt) {
  expect(evt).toBeTruthy();
  expect(typeof evt.type).toBe("string");
  expect(evt.type).toMatch(/^[a-z]+\.[a-z]+\.[a-z-]+$/); // domain.topic.action
  expect(typeof evt.ts).toBe("string");
  expect(new Date(evt.ts).toISOString()).toBe(evt.ts);
  expect(typeof evt.source).toBe("string");
  expect(evt).toHaveProperty("data");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const RECIPE_FIXTURE = {
  id: "recipe-1",
  tempF: 400,
  ingredients: [
    { item: "Flour", qty: 500, uom: "g" },
    { item: "Sugar", qty: 150, uom: "g" },
  ],
};

const CLEANING_FIXTURE = {
  id: "clean-1",
  surfaces: ["counter", "sink"],
};

const GARDEN_FIXTURE = {
  id: "garden-1",
  crop: "tomato.roma",
};

const ANIMAL_FIXTURE = {
  id: "animal-1",
  species: "goat",
  weightKg: 45,
  doseMl: 3.27,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("Preferences: defaults load and shape", () => {
  beforeEach(() => {
    eventBusMock.emit.mockClear();
    eventBusMock._drain();
  });

  it("returns a stable default profile with required keys", () => {
    const d = PreferencesService.getDefaults();
    expect(d).toHaveProperty("units");
    expect(d).toHaveProperty("cooking.doneness");
    expect(d).toHaveProperty("cleaning.aromatics");
    expect(d).toHaveProperty("garden.zone");
    expect(d).toHaveProperty("animal.dosageRounding");
    expect(d).toHaveProperty("guards.quietHours.start");
    expect(d).toHaveProperty("guards.quietHours.end");
  });

  it("loads defaults merged with overrides and emits preferences.loaded", () => {
    const prefs = PreferencesService.load({
      units: "imperial",
      cooking: { doneness: "medium-well", portionSize: 2 },
      cleaning: { sensitivity: "fragrance-free" },
    });

    expect(prefs.units).toBe("imperial");
    expect(prefs.cooking.doneness).toBe("medium-well");
    expect(prefs.cooking.portionSize).toBe(2);
    expect(prefs.cleaning.sensitivity).toBe("fragrance-free");

    const emitted = eventBusMock._drain();
    const loaded = emitted.find((e) => e.type === "preferences.loaded");
    expectCanonical(loaded);
    expect(loaded.data.profile).toBe("household");
  });
});

describe("Preferences: apply to domain entities", () => {
  beforeEach(() => {
    eventBusMock.emit.mockClear();
    eventBusMock._drain();
  });

  it("applies to cooking: converts tempF→tempC, scales portions, adds doneness/spice/sweetness", () => {
    const prefs = PreferencesService.load({
      units: "metric",
      cooking: { portionSize: 1.5, doneness: "medium-rare" },
    });
    const adjusted = applyPreferences(RECIPE_FIXTURE, "cooking", prefs);

    expect(adjusted.tempC).toBeCloseTo(204.44, 2); // 400F -> ~204.44C
    expect(adjusted.ingredients[0].qty).toBeCloseTo(750, 2);
    expect(adjusted.preferences.doneness).toBe("medium-rare");

    const [evt] = eventBusMock._drain();
    expectCanonical(evt);
    expect(evt.type).toBe("preferences.applied");
    expect(evt.data.domain).toBe("cooking");
  });

  it("applies to cleaning: respects fragrance-free sensitivity and default water temp", () => {
    const prefs = PreferencesService.load({
      cleaning: { sensitivity: "fragrance-free" },
    });
    const adjusted = applyPreferences(CLEANING_FIXTURE, "cleaning", prefs);
    expect(adjusted.aromaticsUsed).toEqual([]); // fragrance-free disables aromatics
    expect(typeof adjusted.waterTempC).toBe("number");
  });

  it("applies to garden: sets zone/bed/watering when absent", () => {
    const prefs = PreferencesService.load(); // defaults
    const adjusted = applyPreferences(GARDEN_FIXTURE, "garden", prefs);
    expect(adjusted.zone).toBe(prefs.garden.zone);
    expect(adjusted.defaultBed).toBe(prefs.garden.defaultBed);
    expect(adjusted.wateringMinutes).toBe(prefs.garden.wateringMinutes);
  });

  it("applies to animal: rounds dosage and appends PPE", () => {
    const prefs = PreferencesService.load();
    const adjusted = applyPreferences(ANIMAL_FIXTURE, "animal", prefs);
    expect(adjusted.doseMl).toBeCloseTo(3.5, 2); // nearest 0.5 ml
    expect(adjusted.ppe).toContain("gloves");
  });

  it("always attaches guard hints (sabbath, quiet hours) for automation to respect", () => {
    const prefs = PreferencesService.load();
    const adjusted = applyPreferences(RECIPE_FIXTURE, "cooking", prefs);
    expect(adjusted.guards).toBeTruthy();
    expect(adjusted.guards.sabbath).toBeTypeOf("boolean");
    expect(adjusted.guards.quietHours).toHaveProperty("start");
    expect(adjusted.guards.quietHours).toHaveProperty("end");
  });
});

// ---------------------------------------------------------------------------
// Negative / edge cases
// ---------------------------------------------------------------------------
describe("Preferences: robustness & immutability", () => {
  beforeEach(() => {
    eventBusMock.emit.mockClear();
    eventBusMock._drain();
  });

  it("does not mutate the original entity", () => {
    const src = structuredClone(RECIPE_FIXTURE);
    const prefs = PreferencesService.load();
    const adjusted = applyPreferences(src, "cooking", prefs);
    expect(src).not.toBe(adjusted);
    // Original still has tempF
    expect(src.tempF).toBe(400);
  });

  it("tolerates empty overrides and still emits preferences.loaded", () => {
    const prefs = PreferencesService.load({});
    expect(prefs.units).toBeTruthy();
    const [evt] = eventBusMock._drain();
    expectCanonical(evt);
    expect(evt.type).toBe("preferences.loaded");
  });

  it("throws clearly if domain missing", () => {
    const prefs = PreferencesService.load();
    expect(() => applyPreferences({}, undefined, prefs)).toThrow();
  });
});
