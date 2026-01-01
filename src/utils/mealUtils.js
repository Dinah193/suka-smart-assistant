// src/utils/mealUtils.js

import { format } from "date-fns";

/**
 * Expand meal plan cycle over a longer time range (e.g., 1 week to 2 years)
 * @param {Object} mealCycle - { Day 1: [recipes], Day 2: [recipes], ... }
 * @param {Number} totalDays - total number of days to expand to (default 365)
 */
export function generateExtendedMealPlan(mealCycle, totalDays = 365) {
  const expanded = {};
  const cycleDays = Object.keys(mealCycle).length;

  for (let i = 0; i < totalDays; i++) {
    const dayIndex = i % cycleDays;
    const label = `Day ${i + 1}`;
    const sourceDay = `Day ${dayIndex + 1}`;
    expanded[label] = mealCycle[sourceDay] || [];
  }

  return expanded;
}

/**
 * Convert a day number (e.g. 1–730) to an actual date, assuming a start date
 */
export function labelMealPlanWithDates(startDate, mealPlanObj) {
  const datedPlan = {};

  Object.keys(mealPlanObj).forEach((dayKey, i) => {
    const label = format(
      new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000),
      "yyyy-MM-dd"
    );
    datedPlan[label] = mealPlanObj[dayKey];
  });

  return datedPlan;
}

/**
 * Extract a flattened list of all recipe IDs from the full meal plan
 */
export function extractAllRecipesFromPlan(mealPlan = {}) {
  const all = new Map();

  Object.values(mealPlan).forEach((recipes) => {
    recipes.forEach((r) => {
      all.set(r.id, r); // avoids duplicates
    });
  });

  return Array.from(all.values());
}

/**
 * Count the total number of appearances per recipe across a plan
 */
export function countRecipeUsage(mealPlan = {}) {
  const usage = {};

  Object.values(mealPlan).forEach((recipes) => {
    recipes.forEach((r) => {
      if (!usage[r.name]) usage[r.name] = 0;
      usage[r.name] += 1;
    });
  });

  return usage;
}

/**
 * Get a date range subset from a long meal plan
 */
export function filterMealPlanByDateRange(mealPlan = {}, fromDate, toDate) {
  const filtered = {};

  const from = new Date(fromDate).getTime();
  const to = new Date(toDate).getTime();

  Object.keys(mealPlan).forEach((dateKey) => {
    const date = new Date(dateKey).getTime();
    if (date >= from && date <= to) {
      filtered[dateKey] = mealPlan[dateKey];
    }
  });

  return filtered;
}

/**
 * Group all ingredient needs by date for reporting/forecasting
 */
export function getIngredientForecastByDate(datedMealPlan) {
  const forecast = {};

  Object.entries(datedMealPlan).forEach(([date, recipes]) => {
    const dailyMap = {};

    recipes.forEach((recipe) => {
      recipe.ingredients?.forEach((ing) => {
        const key = `${ing.name}_${ing.unit}`;
        if (!dailyMap[key]) {
          dailyMap[key] = {
            name: ing.name,
            unit: ing.unit,
            quantity: 0,
          };
        }
        dailyMap[key].quantity += ing.quantity;
      });
    });

    forecast[date] = Object.values(dailyMap);
  });

  return forecast;
}
