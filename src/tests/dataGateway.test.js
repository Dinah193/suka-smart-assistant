// @vitest-environment jsdom
// C:\Users\larho\suka-smart-assistant\src\tests\dataGateway.test.js
// -----------------------------------------------------------------------------
// Tests for the SSA Data Gateway
//
// PURPOSE
// -------
// The Data Gateway is the “one door in, one door out” service for SSA when
// other modules (imports, domain engines, automation) want to **touch household
// data** (inventory, storehouse, garden, animals, preservation, sessions).
//
// In your architecture it sits right in the pipeline:
//
//   imports → intelligence → automation → (optional) hub export
//                     ⤶─────────────── dataGateway
//
// So the gateway must:
//
// 1. Store household records in Dexie (or the abstraction it's given)
// 2. Emit standardized SSA events { type, ts, source, data }
// 3. Optionally export to Hub when familyFundMode=true
// 4. Be defensive: null/empty payloads shouldn’t crash the app
// 5. Allow future domains (preservation, animal, storehouse) without refactoring
//
// This test file assumes you have a module at:
//
//   src/services/dataGateway.js
//
// with at least these exports:
//
//   - saveDomainRecord(domain, record, opts?)
//   - loadDomainRecords(domain, filter?, opts?)
//   - emitEvent(type, data)
//   - exportToHubIfEnabled(payload)
//
// If your actual file name or function name is different, adjust the imports.
// -----------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const legacyFlag = String(process.env.SSA_ENABLE_LEGACY_CONTRACT_TESTS || "").toLowerCase();
const legacyEnabled = legacyFlag === "1" || legacyFlag === "true" || legacyFlag === "yes";
const legacyDescribe = legacyEnabled ? describe : describe.skip;

// 👇 adjust if your alias differs
import * as dataGateway from "@/services/dataGateway";

// We mock Dexie db so the gateway can "write" without real IndexedDB
// In your real code, dataGateway probably imports the db from src/db/index.js
vi.mock("@/db", () => {
  const fakeTable = () => ({
    add: vi.fn(async (row) => row),
    put: vi.fn(async (row) => row),
    where: vi.fn(() => ({
      equals: vi.fn(() => ({
        toArray: vi.fn(async () => []),
      })),
      anyOf: vi.fn(() => ({
        toArray: vi.fn(async () => []),
      })),
      toArray: vi.fn(async () => []),
    })),
    toArray: vi.fn(async () => []),
  });

  return {
    // gateway will do: import { db } from "@/db"
    db: {
      inventory: fakeTable(),
      storehouseGoals: fakeTable(),
      gardenPlans: fakeTable(),
      gardenHarvests: fakeTable(),
      animalAssets: fakeTable(),
      preservationBatches: fakeTable(),
      sessions: fakeTable(),
      imports: fakeTable(),
      events: fakeTable(),
    },
  };
});

// mock Hub pipeline (format + send)
vi.mock("@/services/hub/HubPacketFormatter", () => ({
  default: {
    format: vi.fn((payload) => ({ ...payload, formattedForHub: true })),
  },
}));

vi.mock("@/services/hub/FamilyFundConnector", () => ({
  default: {
    send: vi.fn(async () => ({ ok: true })),
  },
}));

// mock config so we can toggle familyFundMode per-test
vi.mock("@/config", () => ({
  getConfig: vi.fn(() => ({
    featureFlags: {
      familyFundMode: false,
    },
  })),
}));

legacyDescribe("dataGateway", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-10-28T12:00:00.000Z"));

    // fresh mock bus per test
    const emit = vi.fn();
    // @ts-expect-error test env
    window.__suka = {
      eventBus: {
        emit,
      },
    };

    // reset module-level mocks
    const { getConfig } = require("@/config");
    getConfig.mockReturnValue({
      featureFlags: {
        familyFundMode: false,
      },
    });

    const HubPacketFormatter =
      require("@/services/hub/HubPacketFormatter").default;
    const FamilyFundConnector =
      require("@/services/hub/FamilyFundConnector").default;
    HubPacketFormatter.format.mockClear();
    FamilyFundConnector.send.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports the expected functions", () => {
    expect(typeof dataGateway.saveDomainRecord).toBe("function");
    expect(typeof dataGateway.loadDomainRecords).toBe("function");
    expect(typeof dataGateway.emitEvent).toBe("function");
    expect(typeof dataGateway.exportToHubIfEnabled).toBe("function");
  });

  it("emits a standard event shape when saving inventory", async () => {
    const inv = {
      id: "inv_1",
      householdId: "hh_1",
      name: "Lamb sausage",
      quantity: 10,
    };

    const res = await dataGateway.saveDomainRecord("inventory", inv, {
      reason: "test-save",
    });

    // returned record should at least have id
    expect(res).toHaveProperty("id", "inv_1");

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).toHaveBeenCalled();

    // first call should be our standardized event
    const [eventType, payload] = emit.mock.calls[0];

    expect(eventType).toBe("inventory.updated");
    expect(payload).toHaveProperty("type", "inventory.updated");
    expect(payload).toHaveProperty("ts");
    expect(payload).toHaveProperty("source", "dataGateway");
    expect(payload).toHaveProperty("data");
    expect(payload.data).toMatchObject({
      item: {
        id: "inv_1",
        householdId: "hh_1",
        name: "Lamb sausage",
        quantity: 10,
      },
      reason: "test-save",
    });
  });

  it("does NOT call the Hub when familyFundMode=false", async () => {
    const inv = {
      id: "inv_2",
      householdId: "hh_2",
      name: "Goat chops",
      quantity: 4,
    };

    await dataGateway.saveDomainRecord("inventory", inv);

    const HubPacketFormatter =
      require("@/services/hub/HubPacketFormatter").default;
    const FamilyFundConnector =
      require("@/services/hub/FamilyFundConnector").default;

    expect(HubPacketFormatter.format).not.toHaveBeenCalled();
    expect(FamilyFundConnector.send).not.toHaveBeenCalled();
  });

  it("DOES call the Hub when familyFundMode=true", async () => {
    const { getConfig } = require("@/config");
    getConfig.mockReturnValue({
      featureFlags: {
        familyFundMode: true,
      },
    });

    const inv = {
      id: "inv_3",
      householdId: "hh_3",
      name: "Wheat berries",
      quantity: 25,
      minThreshold: 10,
    };

    await dataGateway.saveDomainRecord("inventory", inv);

    const HubPacketFormatter =
      require("@/services/hub/HubPacketFormatter").default;
    const FamilyFundConnector =
      require("@/services/hub/FamilyFundConnector").default;

    expect(HubPacketFormatter.format).toHaveBeenCalled();
    expect(FamilyFundConnector.send).toHaveBeenCalled();
  });

  it("saves storehouse goals and emits storehouse event", async () => {
    const goal = {
      id: "sg_1",
      householdId: "hh_store",
      name: "Olive oil",
      targetQuantity: 3,
      unit: "gal",
      priority: "high",
    };

    await dataGateway.saveDomainRecord("storehouse", goal);

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    const [eventType, payload] = emit.mock.calls[0];

    expect(eventType).toBe("storehouse.goal.created");
    expect(payload.data.goal).toMatchObject({
      id: "sg_1",
      householdId: "hh_store",
    });
  });

  it("saves garden harvest and emits garden.harvest.logged", async () => {
    const harvest = {
      id: "harv_1",
      householdId: "hh_garden",
      crop: "collards",
      quantity: 6,
      unit: "lb",
    };

    await dataGateway.saveDomainRecord("garden-harvest", harvest);

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    const [eventType, payload] = emit.mock.calls[0];

    expect(eventType).toBe("garden.harvest.logged");
    expect(payload.data.harvest.crop).toBe("collards");
  });

  it("saves animal asset and emits animals.asset.created", async () => {
    const animal = {
      id: "an_1",
      householdId: "hh_farm",
      species: "sheep",
      breed: "katahdin",
      status: "active",
    };

    await dataGateway.saveDomainRecord("animal", animal);

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    const [eventType, payload] = emit.mock.calls[0];

    expect(eventType).toBe("animals.asset.created");
    expect(payload.data.asset.species).toBe("sheep");
  });

  it("saves preservation batch and emits preservation.completed", async () => {
    const batch = {
      id: "pres_1",
      householdId: "hh_pres",
      method: "pressure-canning",
      sourceType: "garden",
      outputs: [{ name: "tomatoes (quart)", qty: 10 }],
    };

    await dataGateway.saveDomainRecord("preservation", batch);

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    const [eventType, payload] = emit.mock.calls[0];

    expect(eventType).toBe("preservation.completed");
    expect(payload.data.batch.method).toBe("pressure-canning");
  });

  it("returns early on empty payload", async () => {
    const res = await dataGateway.saveDomainRecord("inventory", null);

    expect(res).toEqual({
      ok: false,
      reason: "EMPTY_PAYLOAD",
    });

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).not.toHaveBeenCalled();
  });

  it("loadDomainRecords should delegate to db and return an array", async () => {
    const records = await dataGateway.loadDomainRecords("inventory", {
      householdId: "hh_x",
    });

    expect(Array.isArray(records)).toBe(true);
  });

  it("exportToHubIfEnabled should fail silently if connector fails", async () => {
    const { getConfig } = require("@/config");
    getConfig.mockReturnValue({
      featureFlags: {
        familyFundMode: true,
      },
    });

    const FamilyFundConnector =
      require("@/services/hub/FamilyFundConnector").default;
    FamilyFundConnector.send.mockImplementationOnce(async () => {
      throw new Error("network down");
    });

    // should not throw
    await expect(
      dataGateway.exportToHubIfEnabled({
        type: "test.event",
        ts: new Date().toISOString(),
        source: "test",
        data: { foo: "bar" },
      })
    ).resolves.not.toThrow();
  });

  it("emitEvent should write to eventBus with correct shape", () => {
    const evt = dataGateway.emitEvent("test.thing", { hello: "world" });

    expect(evt).toHaveProperty("type", "test.thing");
    expect(evt).toHaveProperty("ts");
    expect(evt).toHaveProperty("source", "dataGateway");
    expect(evt).toHaveProperty("data");
    expect(evt.data).toMatchObject({ hello: "world" });

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).toHaveBeenCalledWith("test.thing", evt);
  });
});
