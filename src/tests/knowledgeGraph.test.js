// C:\Users\larho\suka-smart-assistant\src\tests\knowledgeGraph.test.js
// -----------------------------------------------------------------------------
// Tests for the SSA Knowledge Graph service
//
// CONTEXT
// -------
// In your SSA architecture, *every* import must become “context intelligence”.
// One way to keep that intelligence explorable is to store it in a household-
// scoped knowledge graph (KG).
//
// The KG sits right after the import pipeline:
//
//   imports → normalize → knowledgeGraph.enrich(...) → automation
//                      ↘ (optional) hub export
//
// This test suite verifies that the KG service:
//  - can accept nodes from *all* import domains (recipe, cleaning, garden,
//    animal/butchery, storehouse, video/how-to, preservation in future)
//  - emits the standard SSA event shape { type, ts, source, data }
//  - optionally exports to Hub when familyFundMode = true
//  - links nodes together (import → domain → equipment → seasonality)
//  - is defensive for bad/empty input
//
// ASSUMPTIONS
// -----------
// We assume a module at: src/services/knowledgeGraph.js exporting:
//
//   - upsertFromImport(importObj, opts?)
//   - addNode(node, opts?)
//   - addEdge(edge, opts?)
//   - queryByDomain(domain, opts?)
//   - emitEvent(type, data)
//   - exportToHubIfEnabled(payload)
//
// and internally it uses the Dexie db (e.g. db.knowledgeNodes, db.knowledgeEdges)
// created in your v8/v9 schema, or at least mocked here.
//
// If your actual filenames differ, just adjust the import below.
// -----------------------------------------------------------------------------

import { describe, it, expect, beforeEach, vi } from "vitest";

// 👇 adjust alias if needed
import * as knowledgeGraph from "@/services/knowledgeGraph";

// Mock db so the KG can "write"
vi.mock("@/db", () => {
  const fakeTable = () => ({
    add: vi.fn(async (row) => row),
    put: vi.fn(async (row) => row),
    toArray: vi.fn(async () => []),
    where: vi.fn(() => ({
      equals: vi.fn(() => ({
        toArray: vi.fn(async () => []),
      })),
      anyOf: vi.fn(() => ({
        toArray: vi.fn(async () => []),
      })),
      toArray: vi.fn(async () => []),
    })),
  });

  return {
    db: {
      // knowledge graph specific
      knowledgeNodes: fakeTable(),
      knowledgeEdges: fakeTable(),
      // in case KG also writes to events
      events: fakeTable(),
    },
  };
});

// Mock hub formatting/sending
vi.mock("@/services/HubPacketFormatter", () => ({
  default: {
    format: vi.fn((payload) => ({ ...payload, formattedForHub: true })),
  },
}));

vi.mock("@/services/FamilyFundConnector", () => ({
  default: {
    send: vi.fn(async () => ({ ok: true })),
  },
}));

// Config mock for toggling familyFundMode
vi.mock("@/config", () => ({
  getConfig: vi.fn(() => ({
    featureFlags: {
      familyFundMode: false,
    },
  })),
}));

describe("knowledgeGraph service", () => {
  beforeEach(() => {
    // fresh event bus for every test
    const emit = vi.fn();
    // @ts-expect-error test env
    window.__suka = {
      eventBus: {
        emit,
      },
    };

    // reset config
    const { getConfig } = require("@/config");
    getConfig.mockReturnValue({
      featureFlags: {
        familyFundMode: false,
      },
    });

    // reset hub mocks
    const HubPacketFormatter = require("@/services/HubPacketFormatter").default;
    const FamilyFundConnector = require("@/services/FamilyFundConnector").default;
    HubPacketFormatter.format.mockClear();
    FamilyFundConnector.send.mockClear();
  });

  it("exports the expected public functions", () => {
    expect(typeof knowledgeGraph.upsertFromImport).toBe("function");
    expect(typeof knowledgeGraph.addNode).toBe("function");
    expect(typeof knowledgeGraph.addEdge).toBe("function");
    expect(typeof knowledgeGraph.queryByDomain).toBe("function");
    expect(typeof knowledgeGraph.emitEvent).toBe("function");
    expect(typeof knowledgeGraph.exportToHubIfEnabled).toBe("function");
  });

  it("creates a node from a recipe import and emits a standard event", async () => {
    const recipeImport = {
      id: "imp_recipe_1",
      domain: "recipe",
      title: "Lamb & Date Tagine",
      url: "https://example.com/recipes/lamb-tagine",
      normalizedPayload: {
        ingredients: [
          { name: "lamb", qty: "2 lb" },
          { name: "dates", qty: "5" },
        ],
        methods: ["braise"],
        equipment: ["dutch-oven"],
        seasonality: ["fall", "winter"],
      },
      source: "bookmarklet",
      householdId: "hh_kg",
    };

    const node = await knowledgeGraph.upsertFromImport(recipeImport);

    // should return a node-like object
    expect(node).toHaveProperty("id");
    expect(node).toHaveProperty("domain", "recipe");
    expect(node).toHaveProperty("title", "Lamb & Date Tagine");

    // check event
    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).toHaveBeenCalled();

    const [eventType, payload] = emit.mock.calls[0];

    expect(eventType).toBe("kg.node.upserted");
    expect(payload).toHaveProperty("type", "kg.node.upserted");
    expect(payload).toHaveProperty("ts");
    expect(payload).toHaveProperty("source", "knowledgeGraph");
    expect(payload.data).toMatchObject({
      domain: "recipe",
      title: "Lamb & Date Tagine",
      householdId: "hh_kg",
    });
  });

  it("creates/link nodes from a cleaning import (tasks, zone, frequency)", async () => {
    const cleaningImport = {
      id: "imp_clean_1",
      domain: "cleaning",
      title: "Bathroom Deep Clean",
      url: "https://clean.example.com/bathroom/deep",
      normalizedPayload: {
        zone: "bathroom",
        tasks: ["scrub shower", "sanitize toilet", "mop floor"],
        frequency: "weekly",
      },
      householdId: "hh_clean",
      source: "bookmarklet",
    };

    const node = await knowledgeGraph.upsertFromImport(cleaningImport);

    // base node
    expect(node.domain).toBe("cleaning");
    expect(node.tags).toContain("bathroom");

    // the service should have emitted more than once if it makes edges
    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).toHaveBeenCalled();

    const calls = emit.mock.calls.map((c) => c[0]);
    // kg.node.upserted for the base
    expect(calls).toContain("kg.node.upserted");
    // kg.edge.created for zone/task links (at least 1)
    expect(calls.some((c) => c === "kg.edge.created")).toBe(true);
  });

  it("supports garden/seed imports and links to seasonality", async () => {
    const gardenImport = {
      id: "imp_garden_1",
      domain: "garden",
      title: "Heirloom Tomatoes - Seed Packet",
      url: "https://seed.example.com/tomato/heirloom",
      normalizedPayload: {
        crop: "tomatoes",
        seasonality: ["spring", "summer"],
        zone: "raised-bed-1",
      },
      householdId: "hh_garden",
    };

    const node = await knowledgeGraph.upsertFromImport(gardenImport);

    expect(node.domain).toBe("garden");
    expect(node.attributes.crop).toBe("tomatoes");

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    const calls = emit.mock.calls;

    // we should have at least one edge for seasonality
    const edgeCalls = calls.filter(([, payload]) => payload?.type === "kg.edge.created");
    expect(edgeCalls.length).toBeGreaterThan(0);
  });

  it("supports animal/butchery imports and connects to yield curves", async () => {
    const animalImport = {
      id: "imp_animal_1",
      domain: "animal",
      title: "Process Muscovy Duck",
      url: "https://butchery.example.com/duck/muscovy",
      normalizedPayload: {
        species: "duck",
        breed: "muscovy",
        yieldCurveRef: "src/data/yieldCurves/meat/duck_muscovy.json",
      },
      householdId: "hh_animal",
    };

    const node = await knowledgeGraph.upsertFromImport(animalImport);

    expect(node.domain).toBe("animal");
    expect(node.attributes.species).toBe("duck");

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    const edgePayload = emit.mock.calls.find(
      ([, p]) => p?.type === "kg.edge.created" && p?.data?.to?.includes("yieldCurve"),
    );

    // should have created an edge to the yield curve node
    expect(edgePayload).toBeTruthy();
  });

  it("can create storehouse knowledge nodes from preparedness imports", async () => {
    const storehouseImport = {
      id: "imp_store_1",
      domain: "storehouse",
      title: "30 things to keep in pantry",
      url: "https://prep.example.com/pantry/30things",
      normalizedPayload: {
        items: [
          { name: "whole wheat flour", targetQty: 50, unit: "lb" },
          { name: "beans", targetQty: 20, unit: "lb" },
        ],
        priority: "high",
      },
      householdId: "hh_store",
    };

    const node = await knowledgeGraph.upsertFromImport(storehouseImport);

    expect(node.domain).toBe("storehouse");
    expect(node.attributes.priority).toBe("high");
    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).toHaveBeenCalledWith(
      "kg.node.upserted",
      expect.objectContaining({
        type: "kg.node.upserted",
        data: expect.objectContaining({
          domain: "storehouse",
          householdId: "hh_store",
        }),
      }),
    );
  });

  it("is defensive: returns early on empty input", async () => {
    const res = await knowledgeGraph.upsertFromImport(null);

    expect(res).toEqual({
      ok: false,
      reason: "EMPTY_IMPORT",
    });

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).not.toHaveBeenCalled();
  });

  it("queries by domain and returns an array", async () => {
    const results = await knowledgeGraph.queryByDomain("garden", {
      householdId: "hh_garden",
    });

    expect(Array.isArray(results)).toBe(true);
  });

  it("calls Hub export when familyFundMode=true", async () => {
    const { getConfig } = require("@/config");
    getConfig.mockReturnValue({
      featureFlags: {
        familyFundMode: true,
      },
    });

    const recipeImport = {
      id: "imp_recipe_2",
      domain: "recipe",
      title: "Goat stew",
      url: "https://example.com/recipes/goat-stew",
      normalizedPayload: {
        ingredients: [{ name: "goat", qty: "2 lb" }],
      },
      householdId: "hh_hub",
    };

    await knowledgeGraph.upsertFromImport(recipeImport);

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
      throw new Error("hub is down");
    });

    await expect(
      knowledgeGraph.exportToHubIfEnabled({
        type: "kg.node.upserted",
        ts: new Date().toISOString(),
        source: "test",
        data: { id: "n1" },
      }),
    ).resolves.not.toThrow();
  });

  it("addNode emits kg.node.created and does not crash when fields missing", async () => {
    const node = await knowledgeGraph.addNode({
      title: "Unnamed knowledge",
      domain: "misc",
      householdId: "hh_misc",
    });

    expect(node).toHaveProperty("title", "Unnamed knowledge");

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).toHaveBeenCalledWith(
      "kg.node.created",
      expect.objectContaining({
        type: "kg.node.created",
        data: expect.objectContaining({
          title: "Unnamed knowledge",
          domain: "misc",
        }),
      }),
    );
  });

  it("addEdge emits kg.edge.created with from/to", async () => {
    const edge = await knowledgeGraph.addEdge({
      from: "node_recipe_1",
      to: "node_ingredient_lamb",
      rel: "uses-ingredient",
      householdId: "hh_kg",
    });

    expect(edge).toHaveProperty("from", "node_recipe_1");
    expect(edge).toHaveProperty("to", "node_ingredient_lamb");

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).toHaveBeenCalledWith(
      "kg.edge.created",
      expect.objectContaining({
        type: "kg.edge.created",
        data: expect.objectContaining({
          from: "node_recipe_1",
          to: "node_ingredient_lamb",
          rel: "uses-ingredient",
        }),
      }),
    );
  });

  it("emitEvent returns the payload it emits", () => {
    const evt = knowledgeGraph.emitEvent("kg.test", { hello: "world" });

    expect(evt).toHaveProperty("type", "kg.test");
    expect(evt).toHaveProperty("ts");
    expect(evt).toHaveProperty("source", "knowledgeGraph");
    expect(evt.data).toEqual({ hello: "world" });

    // @ts-expect-error test env
    const emit = window.__suka.eventBus.emit;
    expect(emit).toHaveBeenCalledWith("kg.test", evt);
  });
});
