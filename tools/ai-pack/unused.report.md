# Unused / Architecture Report

_Generated: 2025-10-29T18:57:31.198Z_

**Counts**:

- Unreferenced files: 640
- Unused exports: 1023
- Stray deps: 34
- Orphan workers: 3
- Dangling schemas: 0
- Stale fixtures: 0

## Unreferenced files (top 25)

- `src/agents/animalShim.js`
- `src/agents/animalHealthShim.js`
- `src/agents/animalPlannerShim.js`
- `src/agents/batchCookingShim.js`
- `src/agents/breedingAndButcheringShim.js`
- `src/agents/butcheryShim.js`
- `src/agents/cleaningShim.js`
- `src/agents/cleaningRoutineShim.js`
- `src/agents/companionPlantingShim.js`
- `src/agents/cookingShim.js`
- `src/agents/cookingStylesShim.js`
- `src/agents/cureCalc.js`
- `src/agents/feedOptimizerShim.js`
- `src/agents/gardenEstimateShim.js`
- `src/agents/gardenHarvestShim.js`
- `src/agents/gardenHealthShim.js`
- `src/agents/gardeningShim.js`
- `src/agents/gardenPlanShim.js`
- `src/agents/inventoryShim.js`
- `src/agents/preservationShim.js`
- `src/agents/procurementShim.js`
- `src/agents/shims/recipeConsolidatorShim.js`
- `src/agents/sababShim.js`
- `src/agents/sausageShim.js`
- `src/agents/shoppingShim.js`

## Unused exports (top 25)

- `src/agents/animalShim.js` → **AnimalAgent**
- `src/agents/animalShim.js` → **createAgent**
- `src/agents/animalHealthShim.js` → **createAgent**
- `src/agents/batchCookingShim.js` → **createAgent**
- `src/agents/cleaningShim.js` → **createAgent**
- `src/agents/companionPlantingShim.js` → **createAgent**
- `src/agents/cookingShim.js` → **createAgent**
- `src/agents/feedOptimizerShim.js` → **createAgent**
- `src/agents/storehouseShim.js` → **createAgent**
- `src/agents/animalHealthShim.js` → **AnimalHealthAgent**
- `src/agents/batchCookingShim.js` → **subscribe**
- `src/agents/inventoryShim.js` → **subscribe**
- `src/agents/procurementShim.js` → **subscribe**
- `src/agents/sababShim.js` → **subscribe**
- `src/agents/spiceShim.js` → **subscribe**
- `src/store/SettingsStore.js` → **subscribe**
- `src/services/profile/householdProfileService.js` → **subscribe**
- `src/agents/batchCookingShim.js` → **BatchCookingAgent**
- `src/agents/cleaningShim.js` → **CleaningAgent**
- `src/agents/cleaningRoutineShim.js` → **suggestMakeBuyActions**
- `src/agents/companionPlantingShim.js` → **CompanionPlantingAgent**
- `src/agents/cookingShim.js` → **CookingAgent**
- `src/agents/cookingStylesShim.js` → **markStepComplete**
- `src/agents/cookingStylesShim.js` → **buildStyleCards**
- `src/agents/feedOptimizerShim.js` → **FeedOptimizerAgent**

## Stray dependencies

- `@fullcalendar/core`
- `@fullcalendar/daygrid`
- `@fullcalendar/interaction`
- `@fullcalendar/list`
- `@fullcalendar/react`
- `@fullcalendar/timegrid`
- `@headlessui/react`
- `@mdx-js/react`
- `@zxing/browser`
- `@zxing/library`
- `chrono-node`
- `ms`
- `openai`
- `recharts`
- `@babel/parser`
- `@mdx-js/rollup`
- `@tailwindcss/forms`
- `@tailwindcss/postcss`
- `@tailwindcss/typography`
- `@vitejs/plugin-react`
- `autoprefixer`
- `fast-glob`
- `globby`
- `jsonschema`
- `minimatch`
- `picocolors`
- `postcss`
- `rehype-autolink-headings`
- `rehype-slug`
- `remark-frontmatter`
- `remark-gfm`
- `remark-mdx-frontmatter`
- `tailwindcss`
- `vite`

## Orphan workers

- `src/workers/automation.worker.js`
- `src/app/features/scan-compare-trust/services/workers/cycle.worker.js`
- `src/app/features/scan-compare-trust/services/workers/ocr.worker.js`
