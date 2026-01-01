// C:\Users\larho\suka-smart-assistant\src\tests\calculators\storehouseMeals\StorehouseRefillCalculator.test.js
// -----------------------------------------------------------------------------
// Unit tests for StorehouseRefillCalculator logic.
//
// ASSUMED PUBLIC API (implement your logic file to match this shape):
//
//   import { calculateStorehouseRefill } from
//     "@/features/calculators/storehouseMeals/StorehouseRefillCalculator.logic.js";
//
//   const result = calculateStorehouseRefill(config);
//
// Where `config` looks like:
//
//   {
//     horizonDays: number,           // planning horizon, e.g. 30
//     items: [
//       {
//         id?: string,
//         name: string,
//         unit: string,              // e.g. "lb", "kg", "can", "jar"
//         dailyUse: number,          // expected consumption / day
//         currentQty: number,        // on-hand quantity in `unit`
//         minDaysOnHand?: number,    // safety threshold, e.g. 14 days
//         maxDaysOnHand?: number,    // overstock threshold, e.g. 90 days
//         packSize?: number,         // preferred purchase increment, e.g. 12 cans
//         critical?: boolean         // mark as "must have"
//       }
//     ]
//   }
//
// And `calculateStorehouseRefill(config)` returns:
//
//   {
//     horizonDays: number,
//     items: [
//       {
//         id?: string,
//         name: string,
//         unit: string,
//         dailyUse: number,
//         currentQty: number,
//         requiredQty: number,       // dailyUse * horizonDays
//         deltaQty: number,          // requiredQty - currentQty
//         purchaseQty: number,       // what we actually plan to buy (>= 0),
//         daysOnHand: number,        // currentQty / dailyUse (or Infinity if dailyUse <= 0)
//         minDaysOnHand?: number,
//         maxDaysOnHand?: number,
//         status: "ok" | "low" | "critical" | "overstock",
//         notes?: string[]
//       }
//     ],
//     totals: {
//       purchaseUnits: number,      // sum of purchaseQty
//       criticalItems: number,      // count where critical === true and status !== "ok"
//       lowItems: number,           // count where status === "low"
//       overstockedItems: number    // count where status === "overstock"
//     },
//     warnings?: string[]
//   }
//
// These tests focus on:
//   * Correct requiredQty / delta / purchaseQty math
//   * minDaysOnHand / maxDaysOnHand classification
//   * packSize rounding
//   * critical vs non-critical labeling
//   * sane behavior on invalid inputs
//
// You can extend the implementation as long as these guarantees hold
// for SSA Planning Graph + SessionRunner integration.
// -----------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { calculateStorehouseRefill } from "@/features/calculators/storehouseMeals/StorehouseRefillCalculator.logic.js";

const BASE_CONFIG = Object.freeze({
  horizonDays: 30,
  items: [
    {
      name: "Rice",
      unit: "lb",
      dailyUse: 0.5,        // 0.5 lb/day => 15 lb required over 30 days
      currentQty: 5,        // 5 lb on hand
      minDaysOnHand: 14,    // want at least 14 days
      maxDaysOnHand: 90,    // max 90 days stock
      packSize: 5,          // buy in 5 lb bags
      critical: true
    },
    {
      name: "Beans",
      unit: "lb",
      dailyUse: 0.25,       // 0.25 lb/day => 7.5 lb required over 30 days
      currentQty: 10,       // already more than required
      minDaysOnHand: 30,
      maxDaysOnHand: 120,
      packSize: 5,
      critical: false
    },
    {
      name: "Salt",
      unit: "lb",
      dailyUse: 0.01,       // 0.01 lb/day => 0.3 lb over 30 days
      currentQty: 1,        // more than required, long-term
      minDaysOnHand: 60,
      maxDaysOnHand: 365,
      packSize: 1,
      critical: true
    }
  ]
});

function byName(items, name) {
  return items.find((i) => i.name === name);
}

describe("StorehouseRefillCalculator.calculateStorehouseRefill – basic structure", () => {
  it("returns expected top-level fields", () => {
    const result = calculateStorehouseRefill(BASE_CONFIG);

    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");

    expect(result.horizonDays).toBe(BASE_CONFIG.horizonDays);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(BASE_CONFIG.items.length);

    expect(result.totals).toBeTruthy();
    expect(typeof result.totals.purchaseUnits).toBe("number");
    expect(typeof result.totals.criticalItems).toBe("number");
    expect(typeof result.totals.lowItems).toBe("number");
    expect(typeof result.totals.overstockedItems).toBe("number");
  });

  it("mirrors key per-item fields and computes derived quantities", () => {
    const result = calculateStorehouseRefill(BASE_CONFIG);

    result.items.forEach((item, idx) => {
      const input = BASE_CONFIG.items[idx];

      expect(item.name).toBe(input.name);
      expect(item.unit).toBe(input.unit);
      expect(item.dailyUse).toBeCloseTo(input.dailyUse, 6);
      expect(item.currentQty).toBeCloseTo(input.currentQty, 6);

      expect(typeof item.requiredQty).toBe("number");
      expect(typeof item.deltaQty).toBe("number");
      expect(typeof item.purchaseQty).toBe("number");
      expect(typeof item.daysOnHand).toBe("number");
      expect(typeof item.status).toBe("string");
    });
  });
});

describe("StorehouseRefillCalculator.calculateStorehouseRefill – core math", () => {
  it("computes requiredQty as dailyUse * horizonDays", () => {
    const result = calculateStorehouseRefill(BASE_CONFIG);

    BASE_CONFIG.items.forEach((input) => {
      const item = byName(result.items, input.name);
      const expectedRequired = input.dailyUse * BASE_CONFIG.horizonDays;
      expect(item.requiredQty).toBeCloseTo(expectedRequired, 6);
    });
  });

  it("calculates deltaQty as requiredQty - currentQty", () => {
    const result = calculateStorehouseRefill(BASE_CONFIG);

    BASE_CONFIG.items.forEach((input) => {
      const item = byName(result.items, input.name);
      const expectedRequired = input.dailyUse * BASE_CONFIG.horizonDays;
      const expectedDelta = expectedRequired - input.currentQty;
      const diff = Math.abs(item.deltaQty - expectedDelta);

      expect(diff).toBeLessThan(1e-6);
    });
  });

  it("computes daysOnHand as currentQty / dailyUse, handling small values", () => {
    const result = calculateStorehouseRefill(BASE_CONFIG);

    BASE_CONFIG.items.forEach((input) => {
      const item = byName(result.items, input.name);

      if (input.dailyUse > 0) {
        const expectedDays = input.currentQty / input.dailyUse;
        expect(item.daysOnHand).toBeCloseTo(expectedDays, 6);
      } else {
        // When dailyUse <= 0, we allow implementation to treat as infinite or 0.
        // Test only that it's finite or infinity, and >= 0.
        expect(item.daysOnHand).toBeGreaterThanOrEqual(0);
      }
    });
  });
});

describe("StorehouseRefillCalculator.calculateStorehouseRefill – packSize behavior", () => {
  it("rounds purchaseQty up to packSize increments for positive deltas", () => {
    const config = {
      horizonDays: 30,
      items: [
        {
          name: "Canned tomatoes",
          unit: "can",
          dailyUse: 1,         // 1 can/day => 30 cans required
          currentQty: 13,      // currently 13 cans => delta 17
          minDaysOnHand: 30,
          maxDaysOnHand: 90,
          packSize: 6,         // buy in 6-packs
          critical: true
        }
      ]
    };

    const result = calculateStorehouseRefill(config);
    const tomatoes = byName(result.items, "Canned tomatoes");

    // Required = 30; delta = 17. If we buy only 17, we break packSize.
    // With packSize 6, expect 18 (3 packs) or something >= 17 and divisible by 6.
    expect(tomatoes.deltaQty).toBeCloseTo(30 - 13, 6);
    expect(tomatoes.purchaseQty).toBeGreaterThanOrEqual(17 - 1e-6);
    if (tomatoes.purchaseQty > 0) {
      const remainder = tomatoes.purchaseQty % 6;
      expect(remainder === 0 || remainder > 5.9999 || remainder < 1e-6).toBe(true);
    }
  });

  it("does not force additional purchase if delta <= 0, even with packSize", () => {
    const config = {
      horizonDays: 30,
      items: [
        {
          name: "Oats",
          unit: "lb",
          dailyUse: 0.25,   // 7.5 lb required
          currentQty: 15,   // already 2x required quantity
          minDaysOnHand: 30,
          maxDaysOnHand: 90,
          packSize: 5,
          critical: false
        }
      ]
    };

    const result = calculateStorehouseRefill(config);
    const oats = byName(result.items, "Oats");

    expect(oats.deltaQty).toBeLessThanOrEqual(0);
    expect(oats.purchaseQty).toBe(0);
  });
});

describe("StorehouseRefillCalculator.calculateStorehouseRefill – status classification", () => {
  it("marks items as 'critical' when below minDaysOnHand and flagged critical", () => {
    const config = {
      horizonDays: 30,
      items: [
        {
          name: "Rice",
          unit: "lb",
          dailyUse: 1,       // 30 lb required
          currentQty: 5,     // 5 lb => daysOnHand = 5
          minDaysOnHand: 14, // threshold 14 days
          maxDaysOnHand: 90,
          critical: true
        }
      ]
    };

    const result = calculateStorehouseRefill(config);
    const rice = byName(result.items, "Rice");

    expect(rice.daysOnHand).toBeCloseTo(5, 6);
    expect(rice.status === "critical" || rice.status === "low").toBe(true);

    // Implementation detail: Many implementations will mark critical + low
    // as "critical" to bubble them to the top for the user.
  });

  it("marks items as 'low' when below minDaysOnHand and not critical", () => {
    const config = {
      horizonDays: 30,
      items: [
        {
          name: "Beans",
          unit: "lb",
          dailyUse: 0.5,   // 15 lb required
          currentQty: 2,   // 4 days on hand
          minDaysOnHand: 14,
          maxDaysOnHand: 90,
          critical: false
        }
      ]
    };

    const result = calculateStorehouseRefill(config);
    const beans = byName(result.items, "Beans");

    expect(beans.daysOnHand).toBeCloseTo(4, 6);
    expect(beans.status).toBe("low");
  });

  it("marks items as 'overstock' when daysOnHand exceeds maxDaysOnHand", () => {
    const config = {
      horizonDays: 30,
      items: [
        {
          name: "Sugar",
          unit: "lb",
          dailyUse: 0.1,    // 3 lb required for 30 days
          currentQty: 50,   // 500 days on hand
          minDaysOnHand: 30,
          maxDaysOnHand: 365,
          critical: false
        }
      ]
    };

    const result = calculateStorehouseRefill(config);
    const sugar = byName(result.items, "Sugar");

    expect(sugar.daysOnHand).toBeGreaterThan(365 - 1e-6);
    expect(sugar.status).toBe("overstock");
    expect(sugar.purchaseQty).toBe(0);
  });

  it("marks items as 'ok' when daysOnHand is between min/max and delta <= 0", () => {
    const config = {
      horizonDays: 30,
      items: [
        {
          name: "Pasta",
          unit: "lb",
          dailyUse: 0.3,       // 9 lb required
          currentQty: 15,      // 50 days on hand
          minDaysOnHand: 30,   // 30 days
          maxDaysOnHand: 90,   // 90 days
          critical: false
        }
      ]
    };

    const result = calculateStorehouseRefill(config);
    const pasta = byName(result.items, "Pasta");

    expect(pasta.daysOnHand).toBeGreaterThanOrEqual(30 - 1e-6);
    expect(pasta.daysOnHand).toBeLessThanOrEqual(90 + 1e-6);
    expect(pasta.deltaQty).toBeLessThanOrEqual(0);
    expect(pasta.purchaseQty).toBe(0);
    expect(pasta.status).toBe("ok");
  });
});

describe("StorehouseRefillCalculator.calculateStorehouseRefill – totals & counts", () => {
  it("aggregates purchaseUnits and counts for critical/low/overstocked items", () => {
    const config = {
      horizonDays: 30,
      items: [
        {
          name: "Rice",
          unit: "lb",
          dailyUse: 1,
          currentQty: 5,
          minDaysOnHand: 14,
          maxDaysOnHand: 365,
          critical: true
        },
        {
          name: "Beans",
          unit: "lb",
          dailyUse: 0.5,
          currentQty: 10,
          minDaysOnHand: 60,
          maxDaysOnHand: 365,
          critical: false
        },
        {
          name: "Sugar",
          unit: "lb",
          dailyUse: 0.1,
          currentQty: 50,
          minDaysOnHand: 30,
          maxDaysOnHand: 90,
          critical: false
        }
      ]
    };

    const result = calculateStorehouseRefill(config);

    const rice = byName(result.items, "Rice");
    const beans = byName(result.items, "Beans");
    const sugar = byName(result.items, "Sugar");

    const sumPurchase =
      rice.purchaseQty + beans.purchaseQty + sugar.purchaseQty;

    expect(result.totals.purchaseUnits).toBeCloseTo(sumPurchase, 6);

    // Check classification logic is coherent with totals:
    const criticalCount = result.items.filter(
      (i) => i.critical && i.status !== "ok"
    ).length;

    const lowCount = result.items.filter((i) => i.status === "low").length;
    const overstockCount = result.items.filter(
      (i) => i.status === "overstock"
    ).length;

    expect(result.totals.criticalItems).toBe(criticalCount);
    expect(result.totals.lowItems).toBe(lowCount);
    expect(result.totals.overstockedItems).toBe(overstockCount);
  });
});

describe("StorehouseRefillCalculator.calculateStorehouseRefill – invalid input handling", () => {
  it("throws or produces clearly invalid result when horizonDays <= 0", () => {
    const badConfigs = [
      { horizonDays: 0, items: BASE_CONFIG.items },
      { horizonDays: -10, items: BASE_CONFIG.items }
    ];

    badConfigs.forEach((config) => {
      let threw = false;
      let result = undefined;

      try {
        result = calculateStorehouseRefill(config);
      } catch (err) {
        threw = true;
      }

      if (!threw) {
        const looksValid =
          result &&
          typeof result === "object" &&
          typeof result.horizonDays === "number" &&
          result.horizonDays > 0;

        expect(looksValid).toBe(false);
      }
    });
  });

  it("handles empty items array gracefully", () => {
    const config = {
      horizonDays: 30,
      items: []
    };

    const result = calculateStorehouseRefill(config);

    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.length).toBe(0);
    expect(result.totals.purchaseUnits).toBe(0);
    expect(result.totals.criticalItems).toBe(0);
    expect(result.totals.lowItems).toBe(0);
    expect(result.totals.overstockedItems).toBe(0);
  });

  it("ignores null/undefined items defensively", () => {
    const config = {
      horizonDays: 30,
      items: [
        {
          name: "Rice",
          unit: "lb",
          dailyUse: 0.5,
          currentQty: 5,
          minDaysOnHand: 14,
          maxDaysOnHand: 365,
          critical: true
        },
        null,
        undefined
      ]
    };

    const result = calculateStorehouseRefill(config);
    expect(result.items.length).toBe(1);

    const rice = byName(result.items, "Rice");
    expect(rice).toBeTruthy();
    expect(rice.requiredQty).toBeCloseTo(0.5 * 30, 6);
  });
});

describe("StorehouseRefillCalculator.calculateStorehouseRefill – warnings and notes", () => {
  it("can emit warnings when items are extremely overstocked or misconfigured", () => {
    const config = {
      horizonDays: 30,
      items: [
        {
          name: "Salt",
          unit: "lb",
          dailyUse: 0.001,
          currentQty: 1000,        // enormous overstock
          minDaysOnHand: 30,
          maxDaysOnHand: 365,
          critical: true
        }
      ]
    };

    const result = calculateStorehouseRefill(config);
    const salt = byName(result.items, "Salt");

    expect(salt.daysOnHand).toBeGreaterThan(365);
    expect(salt.status).toBe("overstock");

    if (result.warnings) {
      expect(Array.isArray(result.warnings)).toBe(true);
      result.warnings.forEach((w) => expect(typeof w).toBe("string"));
    }
  });

  it("keeps derived quantities stable for downstream SessionRunner + Planning Graph", () => {
    const config = {
      horizonDays: 60,
      items: [
        {
          name: "Flour",
          unit: "lb",
          dailyUse: 0.8,   // 48 lb required
          currentQty: 10,
          minDaysOnHand: 30,
          maxDaysOnHand: 120,
          critical: true
        }
      ]
    };

    const result = calculateStorehouseRefill(config);
    const flour = byName(result.items, "Flour");

    const expectedRequired = 0.8 * 60;
    expect(flour.requiredQty).toBeCloseTo(expectedRequired, 6);

    const expectedDelta = expectedRequired - 10;
    expect(flour.deltaQty).toBeCloseTo(expectedDelta, 6);

    // purchaseQty should be >= max(deltaQty, 0)
    expect(flour.purchaseQty).toBeGreaterThanOrEqual(
      Math.max(expectedDelta, 0) - 1e-6
    );
  });
});
