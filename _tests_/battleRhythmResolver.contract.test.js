import { describe, it, expect } from "vitest";

import {
  applyBattleRhythm,
  applyBattleRhythmToRecipe,
  resolveRecipePoolWithBattleRhythm,
} from "../src/services/recipes/battleRhythmResolver.js";

describe("battleRhythmResolver contract", () => {
  it("applies substitutions, seasoning factors, and timing transforms", () => {
    const recipe = {
      id: "r1",
      title: "Weeknight Test",
      tags: ["test"],
      ingredients: [
        { name: "butter", qty: 100, unit: "g" },
        { name: "salt", qty: 2, unit: "g" },
        { name: "sugar", amount: { value: 10, unit: "g" } },
      ],
      time: {
        totalMins: 60,
        activeMins: 20,
        handsOffMins: 40,
      },
    };

    const out = applyBattleRhythmToRecipe(recipe, {
      dayKey: "2026-03-10",
      battleRhythm: {
        enabled: true,
        substitutions: [
          {
            match: "butter",
            replaceWith: "ghee",
            ratio: 1.2,
            priority: 90,
          },
        ],
        seasoning: {
          saltFactor: 0.5,
          sugarFactor: 0.8,
        },
        timing: {
          weeknightTimeFactor: 0.5,
          weekendTimeFactor: 1,
          quickNightMaxMins: 40,
        },
      },
    });

    expect(out).not.toBe(recipe);
    expect(out.ingredients[0].name).toBe("ghee");
    expect(out.ingredients[0].qty).toBeCloseTo(120, 4);
    expect(out.ingredients[1].qty).toBeCloseTo(1, 4);
    expect(out.ingredients[2].amount.value).toBeCloseTo(8, 4);
    expect(out.time.totalMins).toBe(30);
    expect(out.tags).toContain("battle-rhythm-applied");
    expect(out.battleRhythm.applied).toBe(true);
    expect(Array.isArray(out.battleRhythm.trace)).toBe(true);
    expect(out.battleRhythm.trace.length).toBeGreaterThan(0);
  });

  it("returns original recipe unchanged when battle rhythm is disabled", () => {
    const recipe = {
      id: "r2",
      ingredients: [{ name: "salt", qty: 2, unit: "g" }],
      time: { totalMins: 20 },
    };

    const out = applyBattleRhythmToRecipe(recipe, {
      dayKey: "2026-03-10",
      battleRhythm: { enabled: false },
    });

    expect(out).toBe(recipe);
  });

  it("resolves pool and reports transformed counts", async () => {
    const pool = [
      {
        id: "r1",
        ingredients: [{ name: "sugar", qty: 10, unit: "g" }],
        time: { totalMins: 30 },
      },
      {
        id: "r2",
        ingredients: [{ name: "salt", qty: 2, unit: "g" }],
        time: { totalMins: 20 },
      },
    ];

    const res = await resolveRecipePoolWithBattleRhythm(pool, {
      dayKey: "2026-03-10",
      battleRhythm: {
        enabled: true,
        seasoning: { saltFactor: 0.5, sugarFactor: 0.8 },
      },
    });

    expect(res.meta.enabled).toBe(true);
    expect(res.meta.total).toBe(2);
    expect(res.meta.transformed).toBe(2);
    expect(Array.isArray(res.meta.warnings)).toBe(true);
    expect(Array.isArray(res.meta.conflicts)).toBe(true);
    expect(Array.isArray(res.meta.provenanceTrail)).toBe(true);
    expect(res.recipes[0].battleRhythm.applied).toBe(true);
    expect(res.recipes[1].battleRhythm.applied).toBe(true);
  });

  it("applies overrides and returns warnings/conflicts/provenance", async () => {
    const recipe = {
      id: "r3",
      title: "Soup",
      ingredients: [
        { name: "ginger", qty: 5, unit: "g" },
        { name: "salt", qty: 3, unit: "g" },
      ],
      time: { totalMins: 20 },
    };

    const resolved = await applyBattleRhythm(
      recipe,
      {
        enabled: true,
        ingredientRules: { avoid: ["ginger"], boost: ["ginger"] },
      },
      {
        seasoning: { saltFactor: 0.5 },
      },
      { dayKey: "2026-03-10", dayType: "weeknight" }
    );

    expect(resolved.recipe.battleRhythm).toBeDefined();
    expect(Array.isArray(resolved.warnings)).toBe(true);
    expect(Array.isArray(resolved.conflicts)).toBe(true);
    expect(resolved.warnings.length).toBeGreaterThan(0);
    expect(resolved.conflicts.length).toBeGreaterThan(0);
    expect(resolved.provenance).toBeDefined();
    expect(Array.isArray(resolved.provenance.sources)).toBe(true);
    const saltLine = resolved.recipe.ingredients.find((x) => String(x.name).toLowerCase().includes("salt"));
    expect(saltLine.qty).toBeCloseTo(1.5, 4);
  });
});
