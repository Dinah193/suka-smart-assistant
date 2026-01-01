/* eslint-disable no-console */
const path = require("path");

// Import libraries (defensive fallbacks so the suite can still run in isolation)
let SafetyRules, NbaCards, StoreCatalog, WeatherGate;
try { SafetyRules = require("../libraries/SafetyRules"); } catch { SafetyRules = require("../../libraries/SafetyRules"); }
try { NbaCards = require("../libraries/NbaCards"); } catch { NbaCards = require("../../libraries/NbaCards"); }
try { StoreCatalog = require("../libraries/StoreCatalog"); } catch { StoreCatalog = require("../../libraries/StoreCatalog"); }
try { WeatherGate = require("../services/WeatherGate"); } catch { WeatherGate = require("../../services/WeatherGate"); }

// Minimal event bus used by the test to simulate orchestration wiring
function createEventBus() {
  const listeners = {};
  return {
    on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); },
    emit(name, payload) { (listeners[name] || []).forEach(fn => fn(payload)); },
    clear() { Object.keys(listeners).forEach(k => delete listeners[k]); }
  };
}

const eventBus = createEventBus();

// --- Helpers used by tests --------------------------------------------------

function generateCleaningDraft({ start = Date.now() } = {}) {
  // A tiny "draft generator" for Cleaning domain:
  // - Task 1: Disinfect barn aisle with bleach (chemical → REI withhold)
  // - Task 2: Pressure wash patio (outdoor → weather risk)
  const fifteen = 15 * 60 * 1000;
  return {
    id: "plan:cleaning:e2e",
    domain: "cleaning",
    items: [
      {
        id: "clean-bleach-aisle",
        title: "Disinfect barn aisle with bleach",
        start,
        durationMin: 30,
        tags: ["chemical", "disinfect"],
        indoor: false, // semi-open barn aisle; treat as outdoor for weather/PPE
        needs: [
          { id: "chem.bleach", qty: 946, unit: "ml", allowSub: false },
          { id: "ppe.kit.clean", qty: 1, unit: "each" }
        ]
      },
      {
        id: "pressure-wash-patio",
        title: "Pressure wash patio",
        start: start + fifteen,
        durationMin: 60,
        tags: ["outdoor", "wash"],
        indoor: false,
        needs: []
      }
    ]
  };
}

// Synthesizes a shortage event payload from StoreCatalog results (pure)
function mkShortageEventFromShoppingLines(lines) {
  return StoreCatalog.buildShortageEventFromPlan(
    lines.map(l => ({
      id: l.canonicalId,
      name: l.label,
      qty: Math.max(0, (l.totalNeededBase || 0) - (l.bestOption?.coverQtyBase || 0)),
      unit: l.baseUnit,
      domain: "cleaning"
    })).filter(x => x.qty > 0)
  );
}

// Simple "decider" that clicks the first primary action on a card (NBA glue)
function invokePrimaryActionOn(card) {
  const primary = (card.actions || []).find(a => a.variant === "primary") || card.actions?.[0];
  if (!primary) return null;
  const res = { emit: primary.emit || null, intent: primary.intent || "cta" };
  // We don't apply patches here (UI-agnostic). We just return the emitted event.
  return res;
}

// --- The suite --------------------------------------------------------------

describe("Cleaning plan flow (E2E-ish orchestration)", () => {
  const TZ = "America/Chicago";
  const LOC = { lat: 33.61, lon: -85.83, name: "TestFarm", tz: TZ };
  const WINDOW = { start: Date.now(), end: Date.now() + 48 * 3600 * 1000 };

  test("draft requested → generated", () => {
    // Simulate: user triggers draft
    const plan = generateCleaningDraft({ start: WINDOW.start });

    // Expectations: plan exists, domain correct, two tasks present
    expect(plan).toBeTruthy();
    expect(plan.domain).toBe("cleaning");
    expect(Array.isArray(plan.items)).toBe(true);
    expect(plan.items.length).toBe(2);

    // Validate minimal shapes used by downstream libs
    const ids = plan.items.map(i => i.id);
    expect(ids).toEqual(expect.arrayContaining(["clean-bleach-aisle", "pressure-wash-patio"]));
  });

  test("grocery/supply list → shortages", () => {
    const plan = generateCleaningDraft({ start: WINDOW.start });

    // Build shopping list recommendations
    const { lines } = StoreCatalog.planToShoppingList(plan.items, { vendor: "local" });

    expect(lines.length).toBeGreaterThan(0);
    // Ensure lines include bleach (ml) and PPE kit (each)
    const labels = lines.map(l => l.label.toLowerCase());
    expect(labels.join(" ")).toMatch(/bleach/);
    expect(labels.join(" ")).toMatch(/ppe/i);

    // Build shortage event (pure; no side-effects here)
    const shortageEvent = mkShortageEventFromShoppingLines(lines);
    // In most cases the "bestOption" covers need already; to exercise the path,
    // we accept zero or more shortages but validate the payload shape.
    expect(shortageEvent.name).toBe("inventory.shortage.detected");
    expect(shortageEvent.payload.domain).toBe("cleaning");
    expect(Array.isArray(shortageEvent.payload.items)).toBe(true);
  });

  test("prep tasks → execution (advisories inform run list)", () => {
    const plan = generateCleaningDraft({ start: WINDOW.start });

    // Safety advisories (PPE + chemical REI) inform prep tasks
    const { advisories, withholds } = SafetyRules.evaluatePlan(plan, {});

    // Expect at least PPE advisory for chemical task and a withhold (REI)
    const hasChemPPE = advisories.some(a => a.kind === "ppe" && a.domain === "cleaning");
    const hasWithhold = withholds.length > 0;

    expect(hasChemPPE).toBe(true);
    expect(hasWithhold).toBe(true);

    // "Prep tasks" can be derived from advisory suggestions. Make a flat list.
    const derivedPrep = advisories
      .flatMap(a => a.suggestions || [])
      .filter(s => s.intent === "option" && s.emit?.name === "prep.tasks.requested");

    // Simulate execution start only after we have at least some prep
    expect(derivedPrep.length).toBeGreaterThan(0);
    const runQueue = plan.items.map(i => ({ id: i.id, status: "pending" }));
    // Start execution (happy path)
    runQueue.forEach(x => { x.status = "running"; });
    expect(runQueue.every(x => x.status === "running")).toBe(true);
  });

  test("conflicts (weather, withhold) → decider resolution", async () => {
    const plan = generateCleaningDraft({ start: WINDOW.start });

    // Weather (provider-agnostic; use built-in devLocal adapter)
    const weather = await WeatherGate.getWeather(LOC, WINDOW, { provider: "devLocal", preferCache: true });
    expect(weather?.hourly?.length || 0).toBeGreaterThan(0);

    // Build synthetic weather conflict for the outdoor task
    const patio = plan.items.find(i => i.id === "pressure-wash-patio");
    const weatherEvent = WeatherGate.buildPlannerWeatherConflictEvent(patio, plan.domain, weather);
    // Safety withholds (REI) from bleach task
    const { withholds } = SafetyRules.evaluatePlan(plan, {});
    // Convert withholds to planner.conflict.detected style (what Conflict/NBA expects)
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
          rationale: w.reason || "Avoid contact until REI ends.",
          score: 65,
          affected: [w.itemId],
          suggestions: [
            {
              title: "Auto-schedule reminder at withhold end",
              autoApply: true,
              intent: "patch",
              emit: null,
              patch: () => ({ targetId: w.itemId, apply: t => ({ ...t, notes: `[REMIND] Resume after REI. ${(t.notes||"")}` }) })
            }
          ]
        }
      }
    }));

    // NBA cards from both weather & withhold conflicts
    const events = [weatherEvent].concat(withholdEvents).filter(Boolean);
    const cards = NbaCards.buildCardsFromEvents(events, { domain: plan.domain, plan });
    const ranked = NbaCards.mergeAndRank(cards);

    // We expect at least one WEATHER and one WITHHOLD card represented
    const hasWeatherCard = ranked.some(c => (c.tags || []).includes("weather"));
    const hasWithholdCard = ranked.some(c => (c.tags || []).includes("withhold"));

    expect(hasWeatherCard).toBe(true);
    expect(hasWithholdCard).toBe(true);

    // "Decider": pick the primary action on the top-ranked card and verify its event intent
    const top = ranked[0];
    const act = invokePrimaryActionOn(top);
    expect(act).toBeTruthy();

    // If it's the weather card, primary is "Find safe window" → planner.schedule.safeWindow.requested
    // If it's the withhold card, primary may be "Resume now" or "Auto-schedule reminder"
    if ((top.tags || []).includes("weather")) {
      expect(act.emit?.name).toBe("planner.schedule.safeWindow.requested");
      expect(act.intent).toMatch(/cta|option/);
    } else if ((top.tags || []).includes("withhold")) {
      // Could be a patch or a session control action, both valid
      expect(["patch", "cta", "option"]).toContain(act.intent);
    }
  });
});
