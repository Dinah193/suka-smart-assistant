// C:\Users\larho\suka-smart-assistant\src\tests\importRouter.test.js
// -----------------------------------------------------------------------------
// Tests for the SSA import router.
//
// GOAL
// -----
// Make sure the import router can:
//  - accept multi-domain imports (recipe, cleaning, garden, animal, storehouse, video)
//  - emit the *standard* event shape { type, ts, source, data }
//  - hand off to the correct domain handler
//  - stay defensive on bad input
//  - optionally trigger Hub export when familyFundMode=true
//
// ASSUMPTIONS
// -----------
// We assume there is a file at:
//    src/features/import/ImportRouter.js
// that exports a function:
//
//    routeImport(rawImport, options?)
//
// and (optionally) a named export:
//
//    getDomainFromUrl(url)
//
// and that ImportRouter will:
//    - normalize the domain
//    - emit "import.parsed"
//    - call domain-specific handlers if registered
//
// If your actual file name/location is slightly different, adjust the import
// paths at the top of this test.
//
// TEST STRATEGY
// -------------
// 1. Mock the eventBus (window.__suka.eventBus)
// 2. Mock HubPacketFormatter + FamilyFundConnector so we don't do real network
// 3. Feed the router 1 example for each domain
// 4. Assert the emitted event shape is correct
// 5. Assert hub export is called when familyFundMode=true
// 6. Assert it fails gracefully on garbage input
//
// These tests fit into the imports → intelligence → automation → (optional) hub export
// pipeline by verifying that the *first hop* (the router) is correct.
//
// Test runner: Vitest / Jest-style
// -----------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

// NOTE: adjust if your alias is different
import * as ImportRouter from "@/features/import/ImportRouter";

// We also assume your ImportRouter file looks up these modules, so we mock them
vi.mock("@/services/HubPacketFormatter", () => {
  return {
    default: {
      format: vi.fn((payload) => ({
        ...payload,
        formatted: true,
      })),
    },
  };
});

vi.mock("@/services/FamilyFundConnector", () => {
  return {
    default: {
      send: vi.fn(async () => {
        return { ok: true };
      }),
    },
  };
});

// If your router pulls configuration from @/config, give it a lightweight mock
vi.mock("@/config", () => {
  return {
    getConfig: vi.fn(() => ({
      featureFlags: {
        // we will override in individual tests
      },
    })),
  };
});

describe("ImportRouter", () => {
  // We'll attach a mock bus to window so ImportRouter can emit to it
  beforeEach(() => {
    // vitest runs in jsdom, so we have a window
    const emit = vi.fn();
    // @ts-expect-error test env
    window.__suka = {
      eventBus: {
        emit,
      },
    };
  });

  it("should expose a routeImport function", () => {
    expect(typeof ImportRouter.routeImport).toBe("function");
  });

  it("should emit a standard event when routing a recipe import", async () => {
    const payload = {
      title: "Caramelized Lamb Chops",
      url: "https://example.com/recipes/lamb-chops",
      text: "2 lbs lamb chops",
      source: "bookmarklet",
    };

    const result = await ImportRouter.routeImport(payload, {
      householdId: "hh_test",
      userId: "user_test",
    });

    // event should have been emitted
    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).toHaveBeenCalled();

    const firstCall = emit.mock.calls[0];
    const [eventType, eventPayload] = firstCall;

    expect(eventType).toBe("import.parsed");
    expect(eventPayload).toHaveProperty("type", "import.parsed");
    expect(eventPayload).toHaveProperty("ts");
    expect(eventPayload).toHaveProperty("source", "import.router");
    expect(eventPayload).toHaveProperty("data");
    expect(eventPayload.data).toMatchObject({
      domain: "recipe",
      householdId: "hh_test",
    });

    // Router should give us back a normalized object or at least id/domain
    expect(result).toHaveProperty("domain", "recipe");
    expect(result).toHaveProperty("normalizedPayload");
  });

  it("should detect and route cleaning imports", async () => {
    const payload = {
      title: "Deep Clean Bathroom Checklist",
      url: "https://household.example.com/cleaning/bathroom-checklist",
      text: "Step 1: spray, Step 2: scrub",
      source: "bookmarklet",
    };

    const result = await ImportRouter.routeImport(payload, {
      householdId: "hh_clean",
    });

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).toHaveBeenCalled();

    const [eventType, eventPayload] = emit.mock.calls[0];

    expect(eventType).toBe("import.parsed");
    expect(eventPayload.data.domain).toBe("cleaning");
    expect(result.domain).toBe("cleaning");
  });

  it("should detect and route garden/seed imports", async () => {
    const payload = {
      title: "Heirloom Tomato Seeds",
      url: "https://seed.example.com/tomato/heirloom",
      text: "Plant after last frost. Full sun.",
      source: "bookmarklet",
    };

    const result = await ImportRouter.routeImport(payload, {
      householdId: "hh_garden",
    });

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    const [eventType, eventPayload] = emit.mock.calls[0];

    expect(eventType).toBe("import.parsed");
    expect(eventPayload.data.domain).toBe("garden");
    expect(result.domain).toBe("garden");
  });

  it("should detect and route animal/butchery imports", async () => {
    const payload = {
      title: "How to process a Muscovy duck",
      url: "https://butchery.example.com/duck/muscovy",
      text: "Scald at 150F, pluck, eviscerate...",
      source: "bookmarklet",
    };

    const result = await ImportRouter.routeImport(payload, {
      householdId: "hh_animal",
    });

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    const [eventType, eventPayload] = emit.mock.calls[0];

    expect(eventType).toBe("import.parsed");
    expect(eventPayload.data.domain).toBe("animal");
    expect(result.domain).toBe("animal");
  });

  it("should detect and route storehouse imports", async () => {
    const payload = {
      title: "Things to always keep in your pantry",
      url: "https://prep.example.com/storehouse/always-keep",
      text: "flour, oil, salt, beans...",
      source: "bookmarklet",
    };

    const result = await ImportRouter.routeImport(payload, {
      householdId: "hh_storehouse",
    });

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    const [eventType, eventPayload] = emit.mock.calls[0];

    expect(eventType).toBe("import.parsed");
    expect(eventPayload.data.domain).toBe("storehouse");
    expect(result.domain).toBe("storehouse");
  });

  it("should fall back to video/how-to when the URL looks like video", async () => {
    const payload = {
      title: "Canning Goat Meat",
      url: "https://www.youtube.com/watch?v=abc123",
      text: "",
      source: "bookmarklet",
    };

    const result = await ImportRouter.routeImport(payload, {
      householdId: "hh_video",
    });

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    const [eventType, eventPayload] = emit.mock.calls[0];
    expect(eventType).toBe("import.parsed");
    expect(eventPayload.data.domain).toBe("video");
    expect(result.domain).toBe("video");
  });

  it("should be defensive on bad input and return early", async () => {
    // no url/title
    const payload = null;

    const result = await ImportRouter.routeImport(payload, {
      householdId: "hh_bad",
    });

    // should not crash
    expect(result).toEqual({
      ok: false,
      reason: "EMPTY_IMPORT",
    });

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    // might not have been called
    expect(emit).not.toHaveBeenCalled();
  });

  it("should call Hub export when familyFundMode=true", async () => {
    // re-mock config to enable familyFundMode
    const { getConfig } = await import("@/config");
    getConfig.mockReturnValue({
      featureFlags: {
        familyFundMode: true,
      },
    });

    const payload = {
      title: "Pantry list for the month",
      url: "https://prep.example.com/pantry/monthly",
      text: "things to buy...",
      source: "bookmarklet",
    };

    await ImportRouter.routeImport(payload, {
      householdId: "hh_hub",
    });

    // Hub mocks
    const HubPacketFormatter = (await import("@/services/HubPacketFormatter")).default;
    const FamilyFundConnector = (await import("@/services/FamilyFundConnector")).default;

    expect(HubPacketFormatter.format).toHaveBeenCalled();
    expect(FamilyFundConnector.send).toHaveBeenCalled();
  });

  it("getDomainFromUrl should recognize basic domains", () => {
    if (typeof ImportRouter.getDomainFromUrl !== "function") {
      // router might not export helper, skip
      return;
    }
    expect(ImportRouter.getDomainFromUrl("https://allrecipes.com/foo")).toBe("recipe");
    expect(ImportRouter.getDomainFromUrl("https://youtube.com/watch?v=1")).toBe("video");
    expect(ImportRouter.getDomainFromUrl("https://gardeners.com/seeds/")).toBe("garden");
    expect(ImportRouter.getDomainFromUrl("https://animals.example.com/butchery")).toBe("animal");
  });
});
