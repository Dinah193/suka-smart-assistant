<!--
File: src/catalogs/shawarma/docs/regional_variations.md
SSA • Shawarma Catalog Documentation
Purpose:
- Human-readable guide to shawarma regional styles + how SSA's catalogs map to them.
- Keeps the catalog deterministic by describing “what changes” as rules, spice blends, sauces, and build options.
-->

# Shawarma Regional Variations (SSA Guide)

This document summarizes common **regional shawarma styles** and how to recreate them using SSA’s **spice blends**, **marinade bases**, **sauces**, **pickles**, and **rulesets**.

> SSA philosophy: variations are expressed as **deterministic inputs** (protein/target, method, flavor goals, sauce choices) that the planner/adapter can interpret consistently.

---

## Quick Map: SSA Building Blocks

### Spice blends (canonical IDs)

- `shawarma.spice_blends.shawarma_classic_blend` — balanced “generic Levant” profile
- `shawarma.spice_blends.shawarma_chicken_blend` — brighter, more aromatic, often with lighter warm spice
- `shawarma.spice_blends.shawarma_beef_blend` — warmer/deeper, peppery backbone
- `shawarma.spice_blends.shawarma_lamb_blend` — bolder warm spices, lamb-friendly richness
- `shawarma.spice_blends.shawarma_vegetable_blend` — herb/sumac-forward brightness for veg

### Marinade bases (canonical IDs)

- `shawarma.marinades.vinegar_shawarma_base` — vinegar/lemon + garlic + aromatics; “bright and sharp”
- `shawarma.marinades.yogurt_shawarma_base` — yogurt + lemon + garlic; “creamy tenderizing cling”

### Sauces (canonical)

- `shawarma.sauces.spicy_garlic_pepper_sauce` — garlic + heat + pepper “kick”
- `shawarma.sauces.green_herb_shawarma_sauce` — herb-forward “green sauce”
- `shawarma.sauces.creamy_roasted_pepper_sauce` — smoky-sweet roasted pepper cream
- `shawarma.sauces.sweet_heat_shawarma_drizzle` — finishing glaze for sweet-heat lovers

### Condiments

- `shawarma.condiments.pickled_shawarma_vegetables` — pickled turnip/cucumber/onion style mix

### Rulesets (canonical)

- `rulesets.shawarma.acid_fat_balance` — keeps marinades/sauces balanced (acid vs fat, salt guidance)
- `rulesets.shawarma.marinade_by_protein` — selects base + dosing + time by protein/target/method
- `rulesets.shawarma.spice_selection` — selects blend + dosing + heat/smoke/bright adjustments

---

## Regional Styles and How to Recreate Them in SSA

### 1) Levantine / “Classic Street Shawarma” (Jordan/Palestine/Syria/Lebanon vibe)

**Flavor:** warm spice base, garlic, lemon, balanced salt, tangy pickles.  
**Typical build:** meat + garlic sauce + pickles + optional tahini.

**SSA Build**

- **Spice blend:** `shawarma.spice_blends.shawarma_classic_blend`
- **Base:** vinegar base for beef; yogurt base for chicken (common modern approach)
  - Beef: `shawarma.marinades.vinegar_shawarma_base` + `shawarma.spice_blends.shawarma_beef_blend`
  - Chicken: `shawarma.marinades.yogurt_shawarma_base` + `shawarma.spice_blends.shawarma_chicken_blend`
- **Sauces:** choose 1–2
  - Creamy garlic “toum-style” feel: use your creamy sauce slot (or pair `spicy_garlic_pepper_sauce` + a mild creamy component if you create one later)
- **Condiment:** `shawarma.condiments.pickled_shawarma_vegetables`

**SSA knobs**

- For more “bright street” flavor: set `inputs.flavorGoals` include `bright` so the spice rules recommend lemon/sumac finishing guidance.

---

### 2) Lebanese-leaning Garlic-Forward (Toum-heavy)

**Flavor:** strong garlic, airy/creamy, lemony; spice in meat is present but not overpowering.  
**Typical build:** chicken + toum + pickles + fries (optional).

**SSA Build**

- **Chicken:** `shawarma.marinades.yogurt_shawarma_base` + `shawarma.spice_blends.shawarma_chicken_blend`
- **Sauce emphasis:** favor garlic/pepper sauce
  - Primary: `shawarma.sauces.spicy_garlic_pepper_sauce`
  - Secondary: `shawarma.sauces.green_herb_shawarma_sauce` (if you want a “green garlic-herb” companion)
- **Condiment:** `shawarma.condiments.pickled_shawarma_vegetables`

**SSA knobs**

- Add `inputs.flavorGoals: ["bright"]` and `["herby"]` for a greener, sharper finish.
- Keep sweet low; this style is rarely sweet.

---

### 3) Syrian-leaning Warm Spice + Tart Pickle Pop

**Flavor:** warm spice, black pepper, clove/allspice notes, tartness from pickles/lemon.  
**Typical build:** beef/lamb mixes, sometimes heavier warm spices.

**SSA Build**

- **Beef:** `shawarma.marinades.vinegar_shawarma_base` + `shawarma.spice_blends.shawarma_beef_blend`
- **Lamb:** `shawarma.marinades.yogurt_shawarma_base` (or vinegar base) + `shawarma.spice_blends.shawarma_lamb_blend`
- **Condiment:** `shawarma.condiments.pickled_shawarma_vegetables`
- **Sauce:** choose one creamy + one spicy (as desired)
  - `shawarma.sauces.creamy_roasted_pepper_sauce` pairs well with beef/lamb
  - Add `shawarma.sauces.spicy_garlic_pepper_sauce` if heat desired

**SSA knobs**

- For “more warm spice”: set `inputs.flavorGoals` include `warm_spice`.
- For charred edges: use method `method.sear` or `method.broil` so the rules nudge you to cap sugar and manage spice crust.

---

### 4) Turkish Döner-ish Direction (spice restrained, more savory)

**Note:** Döner ≠ shawarma (different lineage and common seasonings), but many households want a “doner-ish shawarma” outcome.

**Flavor:** savory, peppery, sometimes more oregano/thyme notes; less cinnamon/clove vibe.  
**Typical build:** beef/lamb, yogurt sauces, tomato/pepper notes.

**SSA Build**

- Start from: `shawarma.spice_blends.shawarma_beef_blend` but dose modestly.
- Prefer:
  - `shawarma.sauces.creamy_roasted_pepper_sauce` (tomato/pepper energy)
  - `shawarma.sauces.green_herb_shawarma_sauce` (herb lift)
- Base:
  - Beef: vinegar base, but keep acid moderate using `rulesets.shawarma.acid_fat_balance` guidance.
- Condiment: pickles can be lighter/optional.

**SSA knobs**

- Use `inputs.flavorGoals: ["smoky","herby"]` to bias toward paprika/herb finishing guidance.

---

### 5) Egyptian-leaning “More Pepper, More Garlic, More Vinegar”

**Flavor:** sharper vinegar/lemon, strong garlic, pepper heat; can be punchier than Levant.  
**Typical build:** beef, vinegar-based marinade, spicy sauce.

**SSA Build**

- Beef: `shawarma.marinades.vinegar_shawarma_base` + `shawarma.spice_blends.shawarma_beef_blend`
- Sauce: `shawarma.sauces.spicy_garlic_pepper_sauce`
- Optional companion: `shawarma.sauces.green_herb_shawarma_sauce` (for freshness)
- Condiments: `shawarma.condiments.pickled_shawarma_vegetables`

**SSA knobs**

- Set `inputs.flavorGoals: ["heat","bright"]` so the spice rules suggest cayenne/flakes and lemon/sumac finishing.

---

### 6) Gulf / Khaleeji-ish “Warmer, Sweeter Spices” (home adaptation)

**Note:** Not a strict shawarma canon everywhere, but a common preference: slightly sweeter warm spice direction.

**Flavor:** warm spices pop, sometimes a hint of sweetness; mellow heat.  
**SSA Build**

- Choose Lamb Blend for beef/lamb even if not lamb:
  - `shawarma.spice_blends.shawarma_lamb_blend` (bolder warm spice)
- Sauce:
  - `shawarma.sauces.creamy_roasted_pepper_sauce`
  - Optional finishing: `shawarma.sauces.sweet_heat_shawarma_drizzle`

**SSA knobs**

- Use sweet-heat only as finishing. If cooking at high heat, keep sugar minimal in the marinade (the rulesets already guide this).

---

### 7) “American Weeknight Shawarma” (oven/air-fryer friendly)

**Flavor:** shawarma-adjacent but optimized for home equipment; strong sauces and pickles carry the vibe.

**SSA Build**

- Method: `method.roast`, `method.broil`, or `method.air_fry`
- Protein:
  - Chicken thighs: yogurt base + chicken blend
  - Beef: vinegar base + beef blend
- Sauce combo:
  - `shawarma.sauces.creamy_roasted_pepper_sauce` + `shawarma.sauces.spicy_garlic_pepper_sauce`
- Condiment:
  - `shawarma.condiments.pickled_shawarma_vegetables`

**SSA knobs**

- Set `inputs.method` so `rulesets.shawarma.marinade_by_protein` and `rulesets.shawarma.spice_selection` provide high-heat notes (avoid sugar scorching, avoid powdery spice crust).

---

## Common “Style Switches” (Deterministic Toggles)

Use these as _inputs_ that the planner can interpret:

### Flavor goals (recommended values)

- `bright` — more lemon/sumac finishing guidance
- `heat` — more cayenne/flakes guidance
- `smoky` — smoked paprika guidance
- `herby` — green sauce emphasis; herb-heavy finishing
- `warm_spice` — prefer lamb blend / higher warm spice dosing

### Sauce “profiles”

- **Garlic-forward:** prioritize `spicy_garlic_pepper_sauce`
- **Green/herb-forward:** prioritize `green_herb_shawarma_sauce`
- **Roasted pepper creamy:** prioritize `creamy_roasted_pepper_sauce`
- **Sweet-heat finish:** add `sweet_heat_shawarma_drizzle` (finisher, not primary)

### Acid–fat handling

- If the marinade tastes too sharp, follow `rulesets.shawarma.acid_fat_balance` guidance:
  - add fat/emulsion first (oil/yogurt), then recheck salt, add sweet last

---

## Suggested “Regional Presets” (for UI later)

These can become future SSA preset objects (not implemented here):

1. **Levant Classic**
   - goals: `["bright"]`
   - sauces: creamy + pickled veg
   - blend: classic/chicken/beef by protein

2. **Lebanese Garlic**
   - goals: `["bright","herby"]`
   - sauces: garlic-forward + pickled veg
   - blend: chicken blend

3. **Syrian Warm Spice**
   - goals: `["warm_spice"]`
   - sauces: roasted pepper + pickled veg
   - blend: lamb for lamb; beef blend for beef

4. **Weeknight Oven Shawarma**
   - method: `method.roast` + `method.broil` finish
   - sauces: roasted pepper + garlic
   - goals: `["smoky","bright"]`

---

## Notes on Authenticity vs Preference

- Many “authentic” street variations are driven by **local ingredients** and **shop signatures**.
- SSA’s catalog aims to preserve **core shawarma invariants**:
  - warm spice backbone
  - garlic + acid balance
  - strong condiments (pickles)
  - sauce-driven customization

**In SSA terms:** authenticity is achieved by controlling **blend**, **base**, **acid/fat**, **method**, and **build**—not by one “correct” recipe.

---

## Related SSA Files (for maintainers)

- Spice blends:
  - `src/catalogs/shawarma/spice_blends/*.json`
- Marinades:
  - `src/catalogs/shawarma/marinades/*.json`
- Sauces:
  - `src/catalogs/shawarma/sauces/*.json`
- Condiments:
  - `src/catalogs/shawarma/condiments/*.json`
- Rules:
  - `src/catalogs/shawarma/rules/*.ruleset.json`

If you add new regions/styles, prefer adding them as:

- **new sauce/spice blend docs** (human guidance)
- **new ruleset rules** (deterministic selection + guidance)
- **optional UI presets** (later), referencing canonical IDs only
