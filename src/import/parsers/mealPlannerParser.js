// src/import/parsers/mealPlannerParser.js
// Minimal parser bridge used by import pages and CI browser smoke.

function normalizeMeal(meal) {
  if (!meal || typeof meal !== "object") {
    return {
      mealType: "other",
      title: "Imported meal",
      servings: null,
      recipes: [],
      notes: null,
    };
  }

  const recipes = Array.isArray(meal.recipes)
    ? meal.recipes.map((r) => ({
        title: String(r?.title || r?.name || "Recipe"),
        sourceUrl: r?.sourceUrl ? String(r.sourceUrl) : null,
      }))
    : [];

  return {
    mealType: String(meal.mealType || "other"),
    title: String(meal.title || meal.name || "Imported meal"),
    servings: Number.isFinite(Number(meal.servings)) ? Number(meal.servings) : null,
    recipes,
    notes: meal.notes ? String(meal.notes) : null,
  };
}

function normalizeDay(day) {
  if (!day || typeof day !== "object") {
    return {
      date: null,
      label: "Day",
      meals: [],
    };
  }
  const meals = Array.isArray(day.meals) ? day.meals.map(normalizeMeal) : [];
  return {
    date: day.date ? String(day.date) : null,
    label: day.label ? String(day.label) : null,
    meals,
  };
}

async function parse(raw = {}, meta = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const days = Array.isArray(source.days) ? source.days.map(normalizeDay) : [];

  return {
    type: "mealplanner_import",
    domain: "mealplanner",
    title: String(meta.title || source.title || "Imported meal plan"),
    summary: String(source.summary || "Meal planner import"),
    days,
    constraints: source.constraints && typeof source.constraints === "object" ? source.constraints : {},
    groceryItems: Array.isArray(source.groceryItems) ? source.groceryItems : [],
    notes: source.notes ? String(source.notes) : null,
  };
}

const mealPlannerParser = {
  parse,
  parseMealPlanner: parse,
};

export default mealPlannerParser;
