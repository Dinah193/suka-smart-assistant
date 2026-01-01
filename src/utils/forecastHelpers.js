export function estimateFoodProduction(plannedCrops, gardenArea) {
  return Object.entries(plannedCrops).map(([item, config]) => {
    const areaUsed = config.area || 0;
    const yieldPerSqFt = config.yieldPerSqFt || 0;
    return {
      item,
      projectedYield: parseFloat((areaUsed * yieldPerSqFt).toFixed(2)),
    };
  });
}

export function matchToMealPlans(production = [], recipes = []) {
  const demandMap = {};

  recipes.forEach((recipe) => {
    recipe.ingredients?.forEach((ing) => {
      const name = ing.name.toLowerCase();
      demandMap[name] = (demandMap[name] || 0) + (ing.amount || 1);
    });
  });

  const forecast = production.map((prod) => {
    const name = prod.item.toLowerCase();
    return {
      ...prod,
      mealPlanDemand: parseFloat((demandMap[name] || 0).toFixed(2)),
    };
  });

  const recommendations = forecast.flatMap(({ item, projectedYield, mealPlanDemand }) => {
    if (projectedYield < mealPlanDemand) {
      return `🌱 Plant more ${item} (short by ${mealPlanDemand - projectedYield} lbs)`;
    } else if (projectedYield > mealPlanDemand * 1.5) {
      return `🫙 Plan to preserve or barter excess ${item} (surplus of ${projectedYield - mealPlanDemand} lbs)`;
    }
    return [];
  });

  return { forecast, recommendations };
}
