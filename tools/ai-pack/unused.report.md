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
- `src/agents/animalAgent.js`
- `src/agents/animalHealthAgent.js`
- `src/agents/animalPlannerAgent.js`
- `src/agents/batchCookingAgent.js`
- `src/agents/breedingAndButcheringAgent.js`
- `src/agents/butcheryAgent.js`
- `src/agents/cleaningAgent.js`
- `src/agents/cleaningRoutineAgent.js`
- `src/agents/companionPlantingAgent.js`
- `src/agents/cookingAgent.js`
- `src/agents/cookingStylesAgent.js`
- `src/agents/cureCalc.js`
- `src/agents/feedOptimizerAgent.js`
- `src/agents/gardenEstimateAgent.js`
- `src/agents/gardenHarvestAgent.js`
- `src/agents/gardenHealthAgent.js`
- `src/agents/gardeningAgent.js`
- `src/agents/gardenPlanAgent.js`
- `src/agents/inventoryAgent.js`
- `src/agents/preservationAgent.js`
- `src/agents/procurementAgent.js`
- `src/agents/recipeConsolidatorAgent.js`
- `src/agents/sababAgent.js`
- `src/agents/sausageAgent.js`
- `src/agents/shoppingAgent.js`

## Unused exports (top 25)
- `src/agents/animalAgent.js` → **AnimalAgent**
- `src/agents/animalAgent.js` → **createAgent**
- `src/agents/animalHealthAgent.js` → **createAgent**
- `src/agents/batchCookingAgent.js` → **createAgent**
- `src/agents/cleaningAgent.js` → **createAgent**
- `src/agents/companionPlantingAgent.js` → **createAgent**
- `src/agents/cookingAgent.js` → **createAgent**
- `src/agents/feedOptimizerAgent.js` → **createAgent**
- `src/agents/storehouseAgent.js` → **createAgent**
- `src/agents/animalHealthAgent.js` → **AnimalHealthAgent**
- `src/agents/batchCookingAgent.js` → **subscribe**
- `src/agents/inventoryAgent.js` → **subscribe**
- `src/agents/procurementAgent.js` → **subscribe**
- `src/agents/sababAgent.js` → **subscribe**
- `src/agents/spiceAgent.js` → **subscribe**
- `src/store/SettingsStore.js` → **subscribe**
- `src/services/profile/householdProfileService.js` → **subscribe**
- `src/agents/batchCookingAgent.js` → **BatchCookingAgent**
- `src/agents/cleaningAgent.js` → **CleaningAgent**
- `src/agents/cleaningRoutineAgent.js` → **suggestMakeBuyActions**
- `src/agents/companionPlantingAgent.js` → **CompanionPlantingAgent**
- `src/agents/cookingAgent.js` → **CookingAgent**
- `src/agents/cookingStylesAgent.js` → **markStepComplete**
- `src/agents/cookingStylesAgent.js` → **buildStyleCards**
- `src/agents/feedOptimizerAgent.js` → **FeedOptimizerAgent**

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
