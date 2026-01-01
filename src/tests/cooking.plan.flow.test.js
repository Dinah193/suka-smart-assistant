/* eslint-disable no-console */

// Defensive imports so the test can run in isolation from either src/ or project root
let SafetyRules, NbaCards, StoreCatalog, WeatherGate;
try { SafetyRules = require("../libraries/SafetyRules"); } catch { SafetyRules = require("../../libraries/SafetyRules"); }
try { NbaCards = require("../libraries/NbaCards"); } catch { NbaCards = require("../../libraries/NbaCards"); }
try { StoreCatalog = require("../libraries/StoreCatalog"); } catch { StoreCatalog = require("../../libraries/StoreCatalog"); }
try { WeatherGate = require("../services/WeatherGate"); } catch { WeatherGate = require("../../services/WeatherGate"); }

// --- Tiny helpers -----------------------------------------------------------

function generateCookingDraft({ start = Date.now() } = {}) {
  // Meals domain draft:
  //  - Task A: Mix & proof dough (withhold: proof; allergens: gluten; fresh-milled friendly)
  //  - Task B: Grill chicken thighs (outdoor → weather risk)
  const plus = (m) => start + m * 60 * 1000;

  return {
    id: "plan:meals:e2e",
    domain: "meals",
    items: [
      {
        id: "mix-proof-dough",
        title: "Mix & proof whole-wheat dough",
        start,
        durationMin: 90,
        timeWindow: { start, end: plus(90) },
        tags: ["proof", "gluten", "baking"],
        indoor: true,
        needs: [
          // Encourage fresh-milled path; StoreCatalog will also offer wheat berries route
          { id: "flour.whole.wheat.fresh", qty: 900, unit: "g" },
          { id: "yeast.instant", qty: 7, unit: "g" },
          { id: "salt.kosher", qty: 18, unit: "g" }
        ]
      },
      {
        id: "grill-chicken-thighs",
        title: "Grill chicken thighs (outdoor)",
        start: plus(60),
        durationMin: 45,
        timeWindow: { start: plus(60), end: plus(105) },
        tags: ["outdoor", "cook", "grill"],
        indoor: false,
        needs: []
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
      domain: "meals"
    })).filter(x => x.qty > 0)
  );
}

// Click the first primary action (like the HUD would)
function invokePrimaryActionOn(card) {
  const primary = (card.actions || []).find(a => a.variant === "primary") || card.actions?.[0];
  if (!primary) return null;
  return { emit: primary.emit || null, intent: primary.intent || "cta" };
}

// --- The suite --------------------------------------------------------------

describe("Cooking plan flow (E2E-ish orchestration)", () => {
  const TZ = "America/Chicago";
  const LOC = { lat: 33.61, lon: -85.83, name: "TestFarm", tz: TZ };
  const WINDOW = { start: Date.now(), end: Date.now() + 48 * 3600 * 1000 };

  test("draft requested → generated", () => {
    const plan = generateCookingDraft({ start: WINDOW.start });

    expect(plan).toBeTruthy();
    expect(plan.domain).toBe("meals");
    expect(Array.isArray(plan.items)).toBe(true);
    expect(plan.items.length).toBe(2);
    expect(plan.items.map(i => i.id)).toEqual(
      expect.arrayContaining(["mix-proof-dough", "grill-chicken-thighs"])
    );
  });

  test("grocery/supply list → shortages", () => {
    const plan = generateCookingDraft({ start: WINDOW.start });

    const { lines } = StoreCatalog.planToShoppingList(plan.items, { vendor: "local" });
    expect(lines.length).toBeGreaterThan(0);

    const labels = lines.map(l => l.label.toLowerCase()).join(" ");
    expect(labels).toMatch(/flour|wheat/);
    expect(labels).toMatch(/yeast/);
    expect(labels).toMatch(/salt/);

    const shortageEvent = mkShortageEventFromShoppingLines(lines);
    expect(shortageEvent.name).toBe("inventory.shortage.detected");
    expect(shortageEvent.payload.domain).toBe("meals");
    expect(Array.isArray(shortageEvent.payload.items)).toBe(true);
    // Can be zero if recommended packs already cover—shape matters more than count here.
  });

  test("prep tasks → execution (advisories inform run list)", () => {
    const plan = generateCookingDraft({ start: WINDOW.start });

    const { advisories, withholds } = SafetyRules.evaluatePlan(plan, {});
    // Expect at least one withhold (proof) and at least one allergen advisory (gluten)
    const hasWithhold = withholds.length > 0;
    const hasGluten = advisories.some(a => a.kind === "allergen" && /gluten/i.test(a.title));

    expect(hasWithhold).toBe(true);
    expect(hasGluten).toBe(true);

    // Prep tasks derived from advisory suggestions (e.g., "gluten first then sanitize")
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
    const plan = generateCookingDraft({ start: WINDOW.start });

    // Weather via provider-agnostic gate (devLocal adapter)
    const weather = await WeatherGate.getWeather(LOC, WINDOW, { provider: "devLocal", preferCache: true });
    expect(weather?.hourly?.length || 0).toBeGreaterThan(0);

    // WEATHER: grill task is outdoor → synthetic conflict for NBA
    const grill = plan.items.find(i => i.id === "grill-chicken-thighs");
    const weatherEvent = WeatherGate.buildPlannerWeatherConflictEvent(grill, plan.domain, weather);

    // WITHHOLD: dough proofing
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
          title: "Dough proofing withhold",
          rationale: w.reason || "Allow dough to proof before proceeding.",
          score: 65,
          affected: [w.itemId],
          suggestions: [
            {
              title: "Auto-schedule reminder at proof end",
              autoApply: true,
              intent: "patch",
              emit: null,
              patch: () => ({ targetId: w.itemId, apply: t => ({ ...t, notes: `[REMIND] Resume after proof. ${(t.notes||"")}` }) })
            }
          ]
        }
      }
    }));

    // Build NBA cards from events
    const events = [weatherEvent].concat(withholdEvents).filter(Boolean);
    const cards = NbaCards.buildCardsFromEvents(events, { domain: plan.domain, plan });
    const ranked = NbaCards.mergeAndRank(cards);

    const hasWeatherCard = ranked.some(c => (c.tags || []).includes("weather"));
    const hasWithholdCard = ranked.some(c => (c.tags || []).includes("withhold"));

    expect(hasWeatherCard).toBe(true);
    expect(hasWithholdCard).toBe(true);

    // Decider: take primary action of top card
    const top = ranked[0];
    const act = invokePrimaryActionOn(top);
    expect(act).toBeTruthy();

    if ((top.tags || []).includes("weather")) {
      expect(act.emit?.name).toBe("planner.schedule.safeWindow.requested");
      expect(act.intent).toMatch(/cta|option/);
    } else if ((top.tags || []).includes("withhold")) {
      expect(["patch", "cta", "option"]).toContain(act.intent);
    }
  });
});
