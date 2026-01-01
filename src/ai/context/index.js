// src/ai/context/index.js
// Compose the “one true” context from your existing stores/managers

import { MealPlanStore } from "@/store/MealPlanStore";
import { BatchQueueStore } from "@/store/BatchQueueStore";
import { GardenStore } from "@/store/GardenStore";
import { StorehousePlannerStore } from "@/store/StorehousePlannerStore";
import { SettingsStore } from "@/store/SettingsStore";
import { HouseholdCalendarStore } from "@/store/HouseholdCalendarStore";
import * as timeUtils from "@/utils/timeUtils";
import * as zoneUtils from "@/utils/zoneUtils";
import * as inventoryUtils from "@/utils/inventoryUtils";
import * as recipeUtils from "@/utils/recipeUtils";

export async function getHouseholdContext() {
  // Pull snapshots (no DB writes here)
  const [mealPlan, batchQueue, garden, storehouse, settings, calendar] = await Promise.all([
    MealPlanStore.getSnapshot?.() ?? MealPlanStore,
    BatchQueueStore.getSnapshot?.() ?? BatchQueueStore,
    GardenStore.getSnapshot?.() ?? GardenStore,
    StorehousePlannerStore.getSnapshot?.() ?? StorehousePlannerStore,
    SettingsStore.getSnapshot?.() ?? SettingsStore,
    HouseholdCalendarStore.getSnapshot?.() ?? HouseholdCalendarStore,
  ]);

  const now = new Date();
  const tod = timeUtils.getTimeOfDay?.(now) || "day"; // morning/afternoon/evening
  const energy = SettingsStore?.energyMode ?? "normal"; // optional: low/normal/high
  const zone = garden?.zone || settings?.gardenZone || "7b";

  return {
    now, tod, energy, zone,
    calendar,
    mealPlan,
    batchQueue,
    garden,
    storehouse,
    settings,
    utils: { timeUtils, zoneUtils, inventoryUtils, recipeUtils },
  };
}
