/* eslint-disable no-console */

// Defensive imports so the test can run in isolation from either src/ or project root
let SafetyRules, NbaCards, StoreCatalog, WeatherGate;
try { SafetyRules = require("../libraries/SafetyRules"); } catch { SafetyRules = require("../../libraries/SafetyRules"); }
try { NbaCards = require("../libraries/NbaCards"); } catch { NbaCards = require("../../libraries/NbaCards"); }
try { StoreCatalog = require("../libraries/StoreCatalog"); } catch { StoreCatalog = require("../../libraries/StoreCatalog"); }
try { WeatherGate = require("../services/WeatherGate"); } catch { WeatherGate = require("../../services/WeatherGate"); }

// --- Helpers ----------------------------------------------------------------

const FIXED_NOW = Date.parse("2025-10-28T12:00:00.000Z");

function generateGardenDraft({ start = FIXED_NOW } = {}) {
  // Garden domain draft:
  //  - Task A: Apply pesticide to tomato bed (chemical → REI withhold, PPE)
  //  - Task B: Plant sweet corn block (outdoor → weather risk; needs seed, soil, fertilizer)
  const plus = (m) => start + m * 60 * 1000;

  return {
    id: "plan:garden:e2e",
    domain: "garden",
    items: [
      {
        id: "apply-pesticide-tomato",
        title: "Apply pesticide to tomato bed",
        start,
        durationMin: 20,
        timeWindow: { start, end: plus(20) },
        tags: ["chemical", "pesticide", "outdoor"],
        indoor: false,
        reiHours: 12, // explicit REI to verify withhold path
        needs: [
          // PPE suggested by SafetyRules, but include a kit to drive StoreCatalog list
          { id: "ppe.kit.clean", qty: 1, unit: "each" }
        ]
      },
      {
        id: "plant-sweet-corn",
        title: "Plant sweet corn block (10x10)",
        start: plus(30),
        durationMin: 90,
        timeWindow: { start: plus(30), end: plus(120) },
        tags: ["outdoor", "seed", "planting"],
        indoor: false,
        needs: [
          { id: "seed.corn.sweet", qty: 100, unit: "each" },
          { id: "soil.mix.raisedbed", qty: 90.7, unit: "kg" },        // ~200 lb
          { id: "fert.npk.5.10.10", qty: 4.54, unit: "kg" }          // 10 lb
        ]
      }
    ]
  };
}

// Build a shortage event payload (pure) from StoreCatalog shopping lines
function mkShortageEventFromShoppingLines(lines) {
  return StoreCatalog.buildShortageEventFromPlan(
    lines.map(l => ({
      id: l.canonicalId,
      name: l.label,
      qty: Math.max(0, (l.totalNeededBase || 0) - (l.bestOption?.coverQtyBase || 0)),
      unit: l.baseUnit,
      domain: "garden"
    })).filter(x => x.qty > 0)
  );
}

// Click the first primary action (as the HUD would)
function invokePrimaryActionOn(card) {
  const primary = (card.actions || []).find(a => a.variant === "primary") || card.actions?.[0];
  if (!primary) return null;
  return { emit: primary.emit || null, intent: primary.intent || "cta" };
}

// --- The suite --------------------------------------------------------------

describe("Garden plan flow (E2E-ish orchestration)", () => {
  const TZ = "America/Chicago";
  const LOC = { lat: 33.61, lon: -85.83, name: "TestFarm", tz: TZ };
  const WINDOW = { start: FIXED_NOW, end: FIXED_NOW + 48 * 3600 * 1000 };

  test("draft requested → generated", () => {
    const plan = generateGardenDraft({ start: WINDOW.start });

    expect(plan).toBeTruthy();
    expect(plan.domain).toBe("garden");
    expect(Array.isArray(plan.items)).toBe(true);
    expect(plan.items.length).toBe(2);
    expect(plan.items.map(i => i.id)).toEqual(
      expect.arrayContaining(["apply-pesticide-tomato", "plant-sweet-corn"])
    );
  });

  test("grocery/supply list → shortages", () => {
    const plan = generateGardenDraft({ start: WINDOW.start });

    const { lines } = StoreCatalog.planToShoppingList(plan.items, { vendor: "local" });
    expect(lines.length).toBeGreaterThan(0);

    const labels = lines.map(l => l.label.toLowerCase()).join(" ");
    expect(labels).toMatch(/corn|seed/);
    expect(labels).toMatch(/soil|mix/);
    expect(labels).toMatch(/fertilizer|5-10-10/);

    const shortageEvent = mkShortageEventFromShoppingLines(lines);
    expect(shortageEvent.name).toBe("inventory.shortage.detected");
    expect(shortageEvent.payload.domain).toBe("garden");
    expect(Array.isArray(shortageEvent.payload.items)).toBe(true);
    // Count may be zero if best options cover needs; we validate shape.
  });

  test("prep tasks → execution (advisories inform run list)", () => {
    const plan = generateGardenDraft({ start: WINDOW.start });

    const { advisories, withholds } = SafetyRules.evaluatePlan(plan, { weather: {} });
    // Expect at least one advisory and REI withhold for pesticide task.
    const hasAdvisory = advisories.length > 0;
    const hasWithhold = withholds.length > 0;

    expect(hasAdvisory).toBe(true);
    expect(hasWithhold).toBe(true);

    // Prep tasks derived from advisory suggestions (e.g., hydration breaks, chemical PPE)
    const derivedPrep = advisories
      .flatMap(a => a.suggestions || [])
      .filter(s => s.intent === "option" && s.emit?.name === "prep.tasks.requested");

    expect(derivedPrep.length).toBeGreaterThan(0);

    // Simulate execution queue creation & start
    const runQueue = plan.items.map(i => ({ id: i.id, status: "pending" }));
    runQueue.forEach(x => { x.status = "running"; });
    expect(runQueue.every(x => x.status === "running")).toBe(true);
  });

  test("conflicts (weather, withhold) → decider resolution", async () => {
    const plan = generateGardenDraft({ start: WINDOW.start });

    // Weather via provider-agnostic gate (devLocal adapter)
    const weather = await WeatherGate.getWeather(LOC, WINDOW, { provider: "devLocal", preferCache: true });
    expect(weather?.hourly?.length || 0).toBeGreaterThan(0);

    // WEATHER: planting is outdoor → synthetic conflict for NBA
    const planting = plan.items.find(i => i.id === "plant-sweet-corn");
    const weatherEvent = WeatherGate.buildPlannerWeatherConflictEvent(planting, plan.domain, weather);

    // WITHHOLD: REI from pesticide application
    const { withholds } = SafetyRules.evaluatePlan(plan, {});
    const withholdEvents = withholds.map(w => ({
      name: "planner.conflict.detected",
      payload: {
        kind: "withhold",
        domain: plan.domain,
        conflict: {
          id: `withhold:${w.itemId}:${w.start}`,
          kind: "withhold",
          domain: plan.domain,
          title: "Re-entry interval (REI)",
          rationale: w.reason || "Avoid entry until REI ends.",
          score: 65,
          affected: [w.itemId],
          suggestions: [
            {
              title: "Auto-schedule reminder at REI end",
              autoApply: true,
              intent: "patch",
              emit: null,
              patch: () => ({ targetId: w.itemId, apply: t => ({ ...t, notes: `[REMIND] Resume after REI. ${(t.notes||"")}` }) })
            }
          ]
        }
      }
    }));

    // Build NBA cards from events
    const events = [weatherEvent].concat(withholdEvents).filter(Boolean);
    const cards = NbaCards.buildCardsFromEvents(events, { domain: plan.domain, plan });
    const ranked = NbaCards.mergeAndRank(cards);

    expect(events.length).toBeGreaterThan(0);
    expect(Array.isArray(ranked)).toBe(true);

    // Decider: take primary action of top card
    if (!ranked.length) return;

    const top = ranked[0];
    const act = invokePrimaryActionOn(top);
    expect(act).toBeTruthy();

    if ((top.tags || []).includes("weather")) {
      expect(act.emit?.name).toBe("planner.schedule.safeWindow.requested");
      expect(act.intent).toMatch(/cta|option/);
    } else if ((top.tags || []).includes("withhold")) {
      expect(["patch", "cta", "option"]).toContain(act.intent);
    } else {
      expect(["patch", "cta", "option"]).toContain(act.intent);
    }
  });
});
