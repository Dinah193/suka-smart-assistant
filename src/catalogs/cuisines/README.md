<!--
File: src/catalogs/cuisines/README.md
SSA • Canonical Cuisines Catalogs

This README documents the folder structure, conventions, and loader expectations
for cuisine catalogs in SSA.
-->

# SSA Cuisines Catalogs

This folder contains SSA’s **canonical cuisine catalogs**. These are “known good” defaults that ship with the app and can be copied into Dexie (user space) for editing, importing, and personalization.

- **Canonical (catalog):** read-only defaults bundled with the app.
- **User (Dexie):** editable copies + imports + user-created cuisines/recipes.

SSA planners should follow this pattern:

1. Read from **Dexie first** (user-edited version).
2. If missing, fall back to **catalog** defaults (this folder).

---

## Folder Layout

Each cuisine lives in its own folder:

src/catalogs/cuisines/
asian_fusion/
bbq/
cajun/
caribbean/
citrus_chili/
creole/
ethiopian/
french_country/
ghanaian/
herb_garlic/
indian/
italian/
japanese/
korean/
levantine/
mediterranean/
mexican/
nigerian/
peruvian/
soul_food/
tex_mex/
thai/
west_african/
index.js
README.md

The **folder name** is the cuisine **slug** (stable identifier).

---

## Cuisine Folder Conventions

A cuisine folder typically contains:

### 1) `cuisine.profile.json` (recommended)

The canonical “front door” file that defines the cuisine identity.

Recommended fields are driven by your cuisine profile schema (see `/src/schemas/cuisine.profile.schema.json`).

Typical examples:

- `meta.id` (e.g., `cuisines.korean`)
- `meta.label` (e.g., `Korean`)
- `meta.description`
- `meta.tags` (SSA tags for filtering/routing)
- optional: spice preferences, staple ingredients, dish families, etc.

> The loader (`src/catalogs/cuisines/index.js`) uses `cuisine.profile.json` as the primary “exists” signal.

### 2) `dishes.catalog.json` (optional)

A curated list of popular dishes/recipes for that cuisine, with tags and IDs.

Useful for:

- baseline recipe libraries
- meal plan generation
- “Most popular” default recommendations

### 3) `ruleset*.json` (optional)

Deterministic cuisine rules for planners and adapters.

Common patterns:

- `ruleset.json`
- `ruleset.v1.json`
- `ruleset.balance.json`

If present, `index.js` can load all `ruleset*.json` files per cuisine.

### 4) `recipes/*.json` (optional)

Canonical recipes belonging to that cuisine.

These should conform to your SSA recipe schema:

- `/src/schemas/recipe.schema.json`

---

## How the Cuisine Loader Works

SSA provides a Vite-friendly loader:

- `src/catalogs/cuisines/index.js`

### What it does

- Eager-loads all `./*/cuisine.profile.json` files for **fast menus** and basic browsing.
- Lazy-loads:
  - `dishes.catalog.json`
  - `ruleset*.json`
  - `recipes/*.json`

### Why it works this way

- Profiles are small and used constantly (menus, filters, onboarding).
- Recipes can be large and should load only when needed.

### Key exports

- `CUISINE_SLUGS` (list of slugs that have profiles)
- `listCuisines()` (menu-ready summaries)
- `loadCuisineBundle(slug, options)` (profile + optional dishes/rules/recipes)

---

## Naming Rules (Stability)

### Cuisine slug

The folder name is the slug:

- ✅ `tex_mex`
- ✅ `french_country`
- ✅ `herb_garlic`
- ❌ `Tex Mex` (spaces)
- ❌ `French-Country` (hyphen is ok in some systems, but SSA conventions favor `_`)

### IDs and meta.id

Prefer stable dot-ids:

- `cuisines.korean`
- `cuisines.west_african`
- `cuisines.tex_mex`

### Tags

Use SSA-style tags:

- `cuisine.korean`
- `flavor.spicy`
- `weeknight.friendly`
- `batch.friendly`

Keep tags lowercase and consistent.

---

## Recommended Minimum for a New Cuisine

To add a new cuisine quickly:

1. Create the folder:
   - `src/catalogs/cuisines/<new_slug>/`

2. Add:
   - `cuisine.profile.json`

Optional but recommended next:

- `dishes.catalog.json`
- `recipes/*.json` (5–10 popular baseline recipes)

---

## Suggested “Baseline Recipes” Standard

When you add baseline recipes for a cuisine:

- Start with **5–10 most popular** dishes (recognizable, representative).
- Include at least:
  - one weeknight-friendly option
  - one special/celebration option
  - one veggie-forward option
  - one staple/starch that defines the cuisine

Use consistent tags and equipment requirements so SSA can:

- adapt recipes to kitchen capabilities
- plan across budgets
- suggest substitutions deterministically

---

## Troubleshooting

### “My cuisine doesn’t show up in menus.”

Most likely:

- missing `cuisine.profile.json`
- profile JSON invalid per schema
- folder name doesn’t match loader assumptions (`./*/cuisine.profile.json`)

### “Recipes aren’t loading.”

Common causes:

- recipe file not in `recipes/` folder
- schema mismatch with `/src/schemas/recipe.schema.json`
- missing `.json` extension

### “Rulesets aren’t loading.”

Check:

- filename starts with `ruleset` and ends with `.json`
  - e.g., `ruleset.json`, `ruleset.balance.json`
- schema compliance with `/src/schemas/ruleset.schema.json`

---

## Where to Put Shared Cuisine Resources

For cross-cuisine maps and shared data, use:

- `src/catalogs/cuisines_shared/`
  - `allergens.map.json`
  - `ingredients.aliases.json`
  - `techniques.glossary.json`
  - `units.map.json`

These are referenced by:

- recipe adapters
- substitution engines
- planners

---

## Design Principle

SSA cuisine catalogs should be:

- **Deterministic:** planners can reason about them without guesswork.
- **Explainable:** “why did SSA recommend this?” is always answerable.
- **Composable:** cuisines can overlay (e.g., Herb & Garlic + Caribbean).
- **Offline-first:** catalogs are local defaults; Dexie stores user edits.

---

## Related

- `src/catalogs/cuisines/index.js` (loader)
- `src/catalogs/cuisines_shared/` (shared maps)
- `src/schemas/cuisine.profile.schema.json`
- `src/schemas/recipe.schema.json`
- `src/schemas/ruleset.schema.json`
