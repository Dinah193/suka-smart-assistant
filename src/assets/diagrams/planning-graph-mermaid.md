```mermaid
graph TD
  %% =========================
  %% CLASS DEFINITIONS / STYLES
  %% =========================
  classDef health fill:#7C3AED,stroke:#312E81,color:#F9FAFB;
  classDef storehouse fill:#F97316,stroke:#7C2D12,color:#0F172A;
  classDef garden fill:#16A34A,stroke:#14532D,color:#F9FAFB;
  classDef calendar fill:#0EA5E9,stroke:#0C4A6E,color:#0F172A;
  classDef stability fill:#475569,stroke:#020617,color:#F9FAFB;

  %% =========================
  %% DOMAINS AS SUBGRAPHS
  %% =========================
  subgraph Health_And_Nutrition["Health & Nutrition"]
    H_BMI["BMI & Body Mass\n(node.health.bmi)"]
    H_Energy["Daily Energy Requirement\n(node.health.dailyEnergyRequirement)"]
    H_Micro["Daily Micronutrient Coverage\n(node.health.dailyMicronutrientRequirement)"]
    H_Hair["Hair Nutrition Score\n(node.health.hairNutritionScore)"]
  end

  subgraph Storehouse_And_Meals["Storehouse & Meals"]
    S_MealsCap["Storehouse Meals Capacity\n(node.storehouse.storehouseMealsCapacity)"]
    S_MeatBreak["Meat Breakdown\n(node.storehouse.meatBreakdownCalculator)"]
    S_MonthsCover["Months of Cover\n(node.storehouse.storehouseMonthsOfCover)"]
    S_PriceBook["Price Book Coverage\n(node.storehouse.priceBookCoverage)"]
    S_Coupon["Coupon Cycle Alignment\n(node.storehouse.couponCycleAlignment)"]
    S_Bulk["Bulk Purchasing Readiness\n(node.storehouse.bulkPurchasingReadiness)"]
  end

  subgraph Garden_And_Production["Garden & Production"]
    G_Seed["Seed Viability\n(node.garden.seedViabilityCalculator)"]
    G_Planner["Garden Planner\n(node.garden.gardenPlanner)"]
    G_Yield["Harvest Yield Projection\n(node.garden.harvestYieldProjection)"]
    G_ToStore["To Storehouse Flow\n(node.garden.toStorehouseFlow)"]
    G_Preserve["Preservation Planner\n(node.garden.preservationPlanner)"]
    G_Feed["Animal Feed Support\n(node.garden.animalFeedSupport)"]
  end

  subgraph Calendar_And_Rhythm["Calendar & Rhythm"]
    C_MealCal["Meal Calendar Coverage\n(node.calendar.mealCalendarCoverage)"]
    C_Batch["Batch Session Density\n(node.calendar.batchSessionDensity)"]
    C_Sabbath["Sabbath & Feast Alignment\n(node.calendar.sabbathAndFeastAlignment)"]
    C_Clean["Cleaning Rhythm Consistency\n(node.calendar.cleaningRhythmConsistency)"]
    C_Garden["Garden Task Rhythm\n(node.calendar.gardenTaskRhythm)"]
    C_Animals["Animal Task Rhythm\n(node.calendar.animalTaskRhythm)"]
  end

  subgraph Household_Stability["Household Stability"]
    ST_Income["Income Stability Index\n(node.stability.incomeStabilityIndex)"]
    ST_Utility["Utility Resilience Index\n(node.stability.utilityResilienceIndex)"]
    ST_StoreStab["Storehouse Stability Index\n(node.stability.storehouseStabilityIndex)"]
    ST_Stress["Homestead Stress Index\n(node.stability.homesteadStressIndex)"]
    ST_Dependency["Dependency on External Food\n(node.stability.dependencyOnExternalFood)"]
    ST_Composite["Planning Graph Composite Score\n(node.stability.planningGraphCompositeScore)"]
  end

  %% =========================
  %% CORE FLOWS BETWEEN DOMAINS
  %% =========================

  %% Health drives meal + storehouse capacity
  H_Energy --> S_MealsCap
  H_Micro --> S_MealsCap
  H_Hair --> S_MealsCap

  %% Garden → Storehouse flows
  G_Seed --> G_Planner --> G_Yield --> G_ToStore --> S_MealsCap
  G_Preserve --> S_MonthsCover
  G_Feed --> S_MeatBreak

  %% Storehouse internals
  S_MealsCap --> S_MonthsCover
  S_MonthsCover --> ST_StoreStab
  S_MeatBreak --> S_MonthsCover
  S_PriceBook --> S_Bulk
  S_Coupon --> S_Bulk

  %% Calendar alignment with food & work
  C_MealCal --> S_MealsCap
  C_Batch --> S_MealsCap
  C_Sabbath --> ST_Composite
  C_Clean --> ST_Stress
  C_Garden --> G_Planner
  C_Animals --> G_Feed

  %% Stability roll-up
  ST_Income --> ST_Composite
  ST_Utility --> ST_Composite
  ST_StoreStab --> ST_Composite
  ST_Stress --> ST_Composite
  ST_Dependency --> ST_Composite

  %% =========================
  %% CLASS ASSIGNMENTS
  %% =========================
  class H_BMI,H_Energy,H_Micro,H_Hair health;
  class S_MealsCap,S_MeatBreak,S_MonthsCover,S_PriceBook,S_Coupon,S_Bulk storehouse;
  class G_Seed,G_Planner,G_Yield,G_ToStore,G_Preserve,G_Feed garden;
  class C_MealCal,C_Batch,C_Sabbath,C_Clean,C_Garden,C_Animals calendar;
  class ST_Income,ST_Utility,ST_StoreStab,ST_Stress,ST_Dependency,ST_Composite stability;