<!--
File: src/catalogs/shawarma/docs/shawarma_flavor_logic.md
SSA • Shawarma Catalog Documentation

Purpose:
- Define deterministic “flavor logic” for shawarma in SSA terms:
  (protein/target + method + goals + sauce choice) -> blend/base/dose/finish guidance.
- Serves as the human-readable reference for:
  - rulesets.shawarma.acid_fat_balance
  - rulesets.shawarma.marinade_by_protein
  - rulesets.shawarma.spice_selection
- Keeps the system explainable: users can see “what changed and why.”
-->

# Shawarma Flavor Logic (SSA Reference)

This document explains the **deterministic flavor logic** SSA uses to produce consistent shawarma outcomes—across proteins, cook methods, and preference styles—without relying on “mystery intuition.”

SSA models shawarma flavor as a small set of **balance levers**:

1. **Warm Spice Backbone** (the blend)
2. **Acid–Fat Balance** (marinade/sauce structure)
3. **Aromatics + Salt** (garlic/onion/salt target)
4. **Heat/Smoke/Bright Finish** (user-controlled preference knobs)
5. **Condiment Contrast** (pickles and fresh elements)
6. **Cook Method Effects** (browning vs scorching risk)

> SSA principle: the “correct” shawarma is the one that hits the intended **balance targets** for the selected protein and method.

---

## The SSA Inputs That Drive Flavor

SSA expects a (potential) evaluation context with the following keys (conventions):

- `$.inputs.target`
  - `"vegetables"` or `"meat"` (or other targets you add later)

- `$.inputs.protein`
  - `"chicken" | "chicken_thigh" | "chicken_breast" | "beef" | "beef_lean" | "lamb" | ...`

- `$.inputs.method`
  - `"method.roast" | "method.broil" | "method.sear" | "method.grill" | "method.air_fry" | "method.smoke"`

- `$.inputs.proteinMassG` and/or `$.inputs.vegMassG`
  - Used for dose scaling

- `$.inputs.flavorGoals` (array)
  - Example: `["bright","heat","smoky","herby","warm_spice"]`

- `$.signals.taste` (array)
  - Example: `["too_tangy","needs_salt","needs_more_fat"]`

- `$.signals.texture` (array)
  - Example: `["broken","thin"]` for sauces

SSA rulesets write outputs into:

- `$.recommendations.marinade.*`
- `$.recommendations.spiceBlend.*`
- `$.recommendations.finish.*`
- plus events `ruleset.guidance` for UI explanations

---

## Core Model: The Shawarma “Balance Quadrant”

SSA uses a simple quadrant model:

### A) Acid (brightness, tang, lift)

- lemon juice
- vinegar
- pickles (as “external acid”)

### B) Fat (roundness, cling, tenderness perception)

- oil
- yogurt / mayo / tahini (emulsifiers)
- chicken fat / lamb fat (intrinsic)

### C) Salt (definition, savory clarity)

- kosher salt
- salty condiments (brined pickles)

### D) Aroma + Warm Spice (identity)

- garlic, onion
- cumin, coriander, paprika, cinnamon/allspice (blend-dependent)

**Shawarma feels “right” when:**

- acid doesn’t bite harshly
- fat doesn’t feel greasy
- salt is present but not briny
- warm spice reads as “shawarma” not “random curry”

---

## Deterministic Decision Tree (What SSA Does)

### Step 1 — Choose a spice blend (identity)

Rule driver: `rulesets.shawarma.spice_selection`

**Primary selectors:**

- If `target = vegetables` → use `shawarma.spice_blends.shawarma_vegetable_blend`
- If `protein = chicken_*` → use `shawarma.spice_blends.shawarma_chicken_blend`
- If `protein = beef*` → use `shawarma.spice_blends.shawarma_beef_blend`
- If `protein = lamb` → use `shawarma.spice_blends.shawarma_lamb_blend`
- Otherwise → fallback `shawarma.spice_blends.shawarma_classic_blend`

**Dosing is scaled per kg** and adjusted by lean/fatty proteins:

- Vegetables: ~10–26 g/kg (ideal ~16)
- Meat default: ~12–28 g/kg (ideal ~18)
- Lamb: ~14–32 g/kg (ideal ~22)
- Breast/lean: moderate dosing to avoid “powdery” dryness

> SSA rationale: the spice blend is the _identity anchor_; sauces and pickles customize the experience.

---

### Step 2 — Choose marinade structure (acid + fat strategy)

Rule driver: `rulesets.shawarma.marinade_by_protein`

**Base choices:**

- **Yogurt base** (`shawarma.marinades.yogurt_shawarma_base`)
  - best for chicken (especially thighs), and often lamb
  - provides cling + tenderizing feel
- **Vinegar base** (`shawarma.marinades.vinegar_shawarma_base`)
  - best for beef, and quick vegetable marinades
  - gives bright “street” punch

**Time window logic:**

- Vegetables: 20–60 min (up to ~6h)
- Chicken thighs: 2–24h (ideal ~6–10h)
- Chicken breast: 1–12h (ideal ~4–8h)
- Beef: 2–24h (ideal ~6–10h)
- Lamb: 4–24h (ideal ~8–12h)

> SSA rationale: marination time is a _texture variable_, not just flavor.

---

### Step 3 — Maintain acid–fat balance (prevent harshness or greasiness)

Rule driver: `rulesets.shawarma.acid_fat_balance`

SSA keeps a target ratio for marinades:

- typical balance: acid ≈ 0.45–0.9 of oil (by volume proxy)
- lean proteins: lower acid ratio + more emulsifier/fat
- fatty proteins: can carry brighter acid if fat stays adequate

**Taste correction order (important):**

1. If “too tangy”: add fat/emulsifier first
2. Then recheck salt
3. Add sweet last (unless it’s a finishing drizzle)

> SSA rationale: sweetness hides imbalance; fat and salt fix structure first.

---

### Step 4 — Apply user “style knobs” (heat, smoke, bright, herby)

Rule driver: `rulesets.shawarma.spice_selection` + guidance actions

SSA applies small, deterministic adjustments:

- `heat`: adds cayenne / pepper flakes guidance
- `smoky`: adds smoked paprika guidance
- `bright`: encourages lemon/sumac finishing instead of over-acidifying marinade
- `herby`: biases toward green sauce and herb finishing
- `warm_spice`: biases toward lamb blend or heavier warm spice dosing

> SSA rationale: “style” is mostly finishers + sauce choice; keep the core blend stable.

---

### Step 5 — Cook method constraints (browning vs scorching)

Rule drivers: `rulesets.shawarma.marinade_by_protein` and `rulesets.shawarma.spice_selection`

**High heat methods** (sear/grill/broil/air-fry):

- cap sugar in marinades (avoid burn)
- avoid overly thick spice crust (avoid bitterness)
- ensure adequate fat for cling
- pat off excess wet marinade before cooking

**Oven roast**:

- aromatics mellow; slightly more garlic/onion is welcome
- finish with lemon/sumac for freshness

> SSA rationale: the same marinade behaves differently at different heat intensities.

---

## How SSA Thinks About Sauces (Not Optional “Extras”)

In shawarma, sauces are often where **preference** lives.

SSA treats sauces as:

- **a balancing layer**
- **a texture layer**
- **a “regional identity” layer**

### Canonical sauce roles in SSA

- **Heat + Garlic:** `shawarma.sauces.spicy_garlic_pepper_sauce`
  - adds bite, heat, pepper “snap”
- **Herb + Freshness:** `shawarma.sauces.green_herb_shawarma_sauce`
  - pushes “green” brightness; complements fatty meats and roasted veg
- **Smoky Creamy Sweet:** `shawarma.sauces.creamy_roasted_pepper_sauce`
  - softens acidity; gives roasted pepper sweetness/smoke
- **Finishing Sweet-Heat:** `shawarma.sauces.sweet_heat_shawarma_drizzle`
  - intentionally sweet; used _as a finisher_, not primary sauce

### Sauce pairing logic (simple and deterministic)

- **Lean protein** → prefer creamy sauce to prevent dryness perception
- **Fatty protein** → green/herb and bright sauces cut richness
- **High heat char** → roasted pepper sauce “matches” char notes
- **Heat lovers** → garlic-pepper + optional sweet-heat finish
- **Bright lovers** → green sauce + lemon/sumac finish

---

## Condiment Logic: Pickles Are the “External Acid”

`shawarma.condiments.pickled_shawarma_vegetables` is not just garnish.

Pickles:

- add crunch and contrast
- add acid that lets marinades stay less harsh
- add salt that can reduce the need for over-salting meat

**Deterministic guidance:**

- if pickles are included, you can often use the **lower end** of salt targets in marinades
- if pickles are omitted, sauce choice should carry the contrast (green sauce or extra lemon finish)

---

## Canonical Dosing Targets (Human Reference)

SSA rulesets store the exact targets, but here’s the readable form.

### Spice blend dose (per 1 kg)

- Vegetables: 10–26 g (ideal ~16 g)
- Chicken / Beef: 12–28 g (ideal ~18 g)
- Lamb: 14–32 g (ideal ~22 g)
- Lean breast/lean beef: keep to the lower-middle of the range

### Marinade structure (per 1 kg, typical)

- Yogurt base: 160–300 g (ideal ~220 g)
- Oil: 20–60 ml (ideal ~35 ml)
- Acid: 20–55 ml (ideal ~35 ml)
- Salt: 6–12 g (ideal ~9 g)

> These are “SSA default heuristics” meant to scale cleanly.

---

## Troubleshooting Map (Signals → Fixes)

SSA supports user-driven taste/texture signals. The deterministic correction order matters.

### If it tastes too tangy / sharp

1. Add fat/emulsifier (oil/yogurt/mayo/tahini)
2. Recheck salt
3. Add sweet only if still harsh

### If it tastes flat / dull

1. Add salt first (small increments)
2. Add acid (lemon/vinegar) second
3. Add aroma (garlic/onion) third

### If it tastes greasy

1. Add acid/brightness (lemon/sumac)
2. Add pickles
3. Reduce oil next time; keep emulsifier moderate

### If sauce breaks / turns thin

1. Reduce acid
2. Increase emulsifier (yogurt/mayo/tahini)
3. Add acid slowly while whisking

### If spice tastes bitter (high heat)

1. Reduce dry spice dose next time
2. Ensure fat for cling (prevents scorching dust)
3. Pat excess wet marinade; cook hot but not too long

---

## How This Maps to SSA Rulesets

### `rulesets.shawarma.spice_selection`

- chooses blend by protein/target
- sets dose ranges
- adds adjustments for `heat`, `smoky`, `bright`
- adds method guidance for high heat

### `rulesets.shawarma.marinade_by_protein`

- chooses vinegar vs yogurt base
- sets dosing targets and time windows per protein
- adds method-specific finishing guidance (roast vs high heat)

### `rulesets.shawarma.acid_fat_balance`

- sets acid-to-fat ratio targets
- sets salt target guidance
- defines deterministic correction order (fat → salt → sweet)

---

## Recommended “Explain to User” Summary (UI copy pattern)

When SSA adapts a recipe or suggests a build, it should be able to show:

- **Blend selected:** `X` (because protein/target is `Y`)
- **Marinade base:** `Yogurt` or `Vinegar` (because protein is `Z`)
- **Dose guidance:** spice `A g/kg`, salt `B g/kg`, acid `C ml/kg`, oil `D ml/kg`
- **Time window:** `min–ideal–max` hours
- **Method notes:** sugar cap / spice crust / finish lemon/sumac
- **Sauce pairing:** 1–2 options to hit the user’s goals

This makes the system transparent and repeatable.

---

## Related Files

- Regional overview:
  - `src/catalogs/shawarma/docs/regional_variations.md`

- Rulesets:
  - `src/catalogs/shawarma/rules/shawarma_acid_fat_balance.ruleset.json`
  - `src/catalogs/shawarma/rules/shawarma_marinade_by_protein.ruleset.json`
  - `src/catalogs/shawarma/rules/shawarma_spice_selection.ruleset.json`

- Catalog assets:
  - `src/catalogs/shawarma/spice_blends/*.json`
  - `src/catalogs/shawarma/marinades/*.json`
  - `src/catalogs/shawarma/sauces/*.json`
  - `src/catalogs/shawarma/condiments/*.json`
