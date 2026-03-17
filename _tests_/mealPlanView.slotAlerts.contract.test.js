import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("meal plan slot alert panel contract", () => {
  it("keeps slot-level missing ingredient and substitution panel wiring", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/pages/mealplanner/MealPlanView.jsx"),
      "utf8"
    );

    expect(source).toContain("buildSlotIngredientAlerts");
    expect(source).toContain("missingIngredients");
    expect(source).toContain("suggestedSubstitutions");
    expect(source).toContain("Missing ingredients & substitutions");
    expect(source).toContain("missing ingredient and substitution alerts");
    expect(source).toContain("Substitutions:");
  });
});
