// C:\Users\larho\suka-smart-assistant\src\tests\automationRuntime.test.js
// -----------------------------------------------------------------------------
// Tests for the SSA Automation Runtime
//
// ARCH CONTEXT
// -------------
// Your automation runtime sits after imports + intelligence:
//
//   imports → intelligence → **automation** → (optional) hub export
//
// Its job is to LISTEN to the event bus for domain events like:
//
//   - import.parsed
//   - inventory.shortage.detected
//   - garden.harvest.logged
//   - preservation.completed
//
// …and then SUGGEST or SCHEDULE actionable sessions:
//
//   - cleaning.session.generate.requested
//   - garden.plan.generate.requested
//   - storehouse.stockPlan.generate.requested
//   - animals.fromRecipes.generate.requested
//   - preservation.session.generate.requested
//
// PLUS: if `familyFundMode=true`, it should export the same event to the Hub
// using HubPacketFormatter + FamilyFundConnector, failing silently.
//
// This test verifies:
//   1. runtime attaches to window.__suka.eventBus
//   2. runtime reacts to multi-domain events
//   3. runtime emits events in { type, ts, source, data } shape
//   4. runtime can be extended with custom handlers
//   5. hub export is called only when the flag is ON
//
// We assume a module at: src/services/automationRuntime.js exporting:
//
//   - initAutomationRuntime()
//   - handleEvent(evt)
//   - registerHandler(eventType, handlerFn)
//   - exportToHubIfEnabled(payload)
//
// Adjust imports below if your path is slightly different.
// -----------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

// 👇 adjust alias if yours is different
import * as automationRuntime from "@/services/automationRuntime";

// Mock config so we can flip familyFundMode
vi.mock("@/config", () => ({
  getConfig: vi.fn(() => ({
    featureFlags: {
      familyFundMode: false,
      sabbathGuard: false,
      quietHoursGuard: false,
    },
  })),
}));

// Mock Hub formatter + connector
vi.mock("@/services/HubPacketFormatter", () => ({
  default: {
    format: vi.fn((payload) => ({
      ...payload,
      formattedForHub: true,
    })),
  },
}));

vi.mock("@/services/FamilyFundConnector", () => ({
  default: {
    send: vi.fn(async () => ({ ok: true })),
  },
}));

// In case runtime touches Dexie or db, mock a minimal one
vi.mock("@/db", () => ({
  db: {
    // event log table, if runtime wants to write
    events: {
      add: vi.fn(async (row) => row),
    },
  },
}));

describe("automationRuntime", () => {
  beforeEach(() => {
    // fresh event bus for each test
    const emit = vi.fn();
    const on = vi.fn();
    // @ts-expect-error test env
    window.__suka = {
      eventBus: {
        emit,
        on,
      },
    };

    // reset config
    const { getConfig } = require("@/config");
    getConfig.mockReturnValue({
      featureFlags: {
        familyFundMode: false,
        sabbathGuard: false,
        quietHoursGuard: false,
      },
    });

    // reset hub mocks
    const HubPacketFormatter = require("@/services/HubPacketFormatter").default;
    const FamilyFundConnector = require("@/services/FamilyFundConnector").default;
    HubPacketFormatter.format.mockClear();
    FamilyFundConnector.send.mockClear();
  });

  it("exports expected public functions", () => {
    expect(typeof automationRuntime.initAutomationRuntime).toBe("function");
    expect(typeof automationRuntime.handleEvent).toBe("function");
    expect(typeof automationRuntime.registerHandler).toBe("function");
    expect(typeof automationRuntime.exportToHubIfEnabled).toBe("function");
  });

  it("initAutomationRuntime attaches to the shared eventBus", () => {
    automationRuntime.initAutomationRuntime();

    // @ts-expect-error test env
    const on = window.__suka.eventBus.on;
    expect(on).toHaveBeenCalled();
    // should listen to broad imports/topic events
    const eventTypes = on.mock.calls.map((c) => c[0]);
    expect(eventTypes).toContain("import.parsed");
    expect(eventTypes).toContain("inventory.updated");
    expect(eventTypes).toContain("inventory.shortage.detected");
  });

  it("reacts to import.parsed (cleaning) and emits cleaning.session.generate.requested", async () => {
    automationRuntime.initAutomationRuntime();

    const evt = {
      type: "import.parsed",
      ts: new Date().toISOString(),
      source: "import.router",
      data: {
        id: "imp_clean_1",
        domain: "cleaning",
        householdId: "hh_auto",
        normalizedPayload: {
          zone: "kitchen",
          tasks: ["clear counters", "mop floor"],
        },
      },
    };

    await automationRuntime.handleEvent(evt);

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).toHaveBeenCalled();

    const call = emit.mock.calls.find((c) => c[0] === "cleaning.session.generate.requested");
    expect(call).toBeTruthy();

    const [, payload] = call;
    expect(payload).toHaveProperty("type", "cleaning.session.generate.requested");
    expect(payload).toHaveProperty("ts");
    expect(payload).toHaveProperty("source", "automationRuntime");
    expect(payload.data).toMatchObject({
      fromImport: true,
      importId: "imp_clean_1",
      householdId: "hh_auto",
    });
  });

  it("reacts to inventory.shortage.detected and emits storehouse.stockPlan.generate.requested", async () => {
    automationRuntime.initAutomationRuntime();

    const evt = {
      type: "inventory.shortage.detected",
      ts: new Date().toISOString(),
      source: "db.index.inventory",
      data: {
        item: {
          id: "inv_flour_1",
          householdId: "hh_store",
          name: "Whole wheat flour",
          quantity: 2,
          minThreshold: 10,
        },
      },
    };

    await automationRuntime.handleEvent(evt);

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    const call = emit.mock.calls.find(
      (c) => c[0] === "storehouse.stockPlan.generate.requested",
    );
    expect(call).toBeTruthy();

    const [, payload] = call;
    expect(payload.data).toMatchObject({
      shortageItem: {
        name: "Whole wheat flour",
      },
      householdId: "hh_store",
    });
  });

  it("reacts to garden.harvest.logged and emits preservation.session.generate.requested", async () => {
    automationRuntime.initAutomationRuntime();

    const evt = {
      type: "garden.harvest.logged",
      ts: new Date().toISOString(),
      source: "db.index.gardenHarvests",
      data: {
        harvest: {
          id: "harv_1",
          householdId: "hh_garden",
          crop: "tomatoes",
          quantity: 18,
          unit: "lb",
        },
      },
    };

    await automationRuntime.handleEvent(evt);

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    const call = emit.mock.calls.find(
      (c) => c[0] === "preservation.session.generate.requested",
    );
    expect(call).toBeTruthy();

    const [, payload] = call;
    expect(payload).toHaveProperty("type", "preservation.session.generate.requested");
    expect(payload.data.harvest.crop).toBe("tomatoes");
  });

  it("registerHandler lets us add a custom domain handler", async () => {
    automationRuntime.initAutomationRuntime();

    const customHandler = vi.fn();
    automationRuntime.registerHandler("import.parsed::animal", customHandler);

    const evt = {
      type: "import.parsed",
      ts: new Date().toISOString(),
      source: "import.router",
      data: {
        id: "imp_animal_1",
        domain: "animal",
        householdId: "hh_animal",
        normalizedPayload: {
          species: "sheep",
        },
      },
    };

    await automationRuntime.handleEvent(evt);

    expect(customHandler).toHaveBeenCalledWith(evt);
  });

  it("does NOT export to hub when familyFundMode=false", async () => {
    automationRuntime.initAutomationRuntime();

    const evt = {
      type: "inventory.updated",
      ts: new Date().toISOString(),
      source: "db.index.inventory",
      data: {
        item: {
          id: "inv_1",
          householdId: "hh_nohub",
          name: "Olive oil",
        },
      },
    };

    await automationRuntime.handleEvent(evt);

    const HubPacketFormatter = require("@/services/HubPacketFormatter").default;
    const FamilyFundConnector = require("@/services/FamilyFundConnector").default;

    expect(HubPacketFormatter.format).not.toHaveBeenCalled();
    expect(FamilyFundConnector.send).not.toHaveBeenCalled();
  });

  it("exports to hub when familyFundMode=true", async () => {
    const { getConfig } = require("@/config");
    getConfig.mockReturnValue({
      featureFlags: {
        familyFundMode: true,
      },
    });

    automationRuntime.initAutomationRuntime();

    const evt = {
      type: "inventory.updated",
      ts: new Date().toISOString(),
      source: "db.index.inventory",
      data: {
        item: {
          id: "inv_2",
          householdId: "hh_hub",
          name: "Goat sausage",
          quantity: 5,
        },
      },
    };

    await automationRuntime.handleEvent(evt);

    const HubPacketFormatter = require("@/services/HubPacketFormatter").default;
    const FamilyFundConnector = require("@/services/FamilyFundConnector").default;

    expect(HubPacketFormatter.format).toHaveBeenCalled();
    expect(FamilyFundConnector.send).toHaveBeenCalled();
  });

  it("exportToHubIfEnabled fails silently when connector throws", async () => {
    const { getConfig } = require("@/config");
    getConfig.mockReturnValue({
      featureFlags: {
        familyFundMode: true,
      },
    });

    const FamilyFundConnector = require("@/services/FamilyFundConnector").default;
    FamilyFundConnector.send.mockImplementationOnce(async () => {
      throw new Error("hub down");
    });

    await expect(
      automationRuntime.exportToHubIfEnabled({
        type: "test.event",
        ts: new Date().toISOString(),
        source: "test",
        data: { foo: "bar" },
      }),
    ).resolves.not.toThrow();
  });

  it("handleEvent is defensive on empty payload", async () => {
    automationRuntime.initAutomationRuntime();

    // should not throw, should just return early
    await expect(automationRuntime.handleEvent(null)).resolves.not.toThrow();

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).not.toHaveBeenCalled();
  });

  it("emits events with correct shape for derived sessions", async () => {
    automationRuntime.initAutomationRuntime();

    const evt = {
      type: "import.parsed",
      ts: new Date().toISOString(),
      source: "import.router",
      data: {
        id: "imp_storehouse_1",
        domain: "storehouse",
        householdId: "hh_store",
        normalizedPayload: {
          items: [{ name: "salt", targetQty: 10 }],
        },
      },
    };

    await automationRuntime.handleEvent(evt);

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    const call = emit.mock.calls.find(
      (c) => c[0] === "storehouse.stockPlan.generate.requested",
    );

    const [, payload] = call;
    expect(payload).toHaveProperty("type", "storehouse.stockPlan.generate.requested");
    expect(payload).toHaveProperty("ts");
    expect(payload).toHaveProperty("source", "automationRuntime");
    expect(payload.data).toMatchObject({
      fromImport: true,
      importId: "imp_storehouse_1",
    });
  });
});
