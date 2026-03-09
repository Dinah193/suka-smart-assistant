<!--
File: src/catalogs/shawarma/docs/traditional_spice_notes.md
SSA • Shawarma Catalog Documentation

Purpose:
- Provide traditional shawarma spice context (what each spice contributes),
  without prescribing one “only correct” recipe.
- Serve as documentation for spice_blends/*.json and rulesets that select/dose blends.
- Help SSA UI explain “why this blend tastes like shawarma” in plain language.
-->

# Traditional Shawarma Spice Notes (SSA Reference)

This document describes **traditional shawarma-adjacent spices** and what they contribute to flavor, aroma, and “shawarma identity.” SSA uses these notes to keep blends explainable and to guide deterministic adjustments (heat/smoke/brightness).

> Shawarma blends vary by region, shop, and family. The invariant is a **warm spice backbone** plus **garlic + acid + salt** supported by **fat/emulsion** and finished with **pickles/brightness**.

---

## What “Traditional” Means Here

In SSA docs, **traditional** means:

- commonly used in Levantine/Middle Eastern shawarma and shawarma-adjacent kebab/döner families
- consistent with classic street profiles
- explainable building blocks (not proprietary shop secrets)

SSA avoids claiming there is a single, universal “authentic” blend.

---

## The Core Shawarma Backbone (Most Common)

### Cumin

**Flavor role:** earthy, warm, savory “meat spice.”  
**Why it matters:** cumin is one of the strongest shawarma identity anchors, especially in beef/lamb profiles.  
**Risk:** too much reads “taco-ish” or dusty.

### Coriander (seed)

**Flavor role:** citrusy, nutty warmth; softens cumin’s earthiness.  
**Why it matters:** gives lift without sharp acid; helps the blend feel rounded.

### Paprika (sweet)

**Flavor role:** mild sweetness + red color + gentle pepper.  
**Why it matters:** helps “shawarma browning vibe” and makes the blend feel fuller without heat.  
**Risk:** stale paprika tastes flat.

### Black pepper

**Flavor role:** bite, warmth, savory sharpness.  
**Why it matters:** makes shawarma taste “alive,” especially in beef blends.

### Garlic (powder) / Onion (powder)

**Flavor role:** aromatic base that survives heat well.  
**Why it matters:** supports “street” aroma when fresh garlic is in marinade.

> SSA note: fresh garlic belongs in marinades/sauces; garlic/onion powders stabilize “dry rub” identity.

---

## Warm Spice “Signature Notes” (Classic Shawarma Character)

These spices are used carefully—often in small amounts—to create the unmistakable shawarma warmth.

### Cinnamon

**Flavor role:** sweet warmth, depth, “perfume.”  
**Common use:** more common in beef/lamb shawarma.  
**Risk:** too much reads like dessert.

### Allspice

**Flavor role:** warm, peppery, clove-like; “kebab shop” energy.  
**Why it matters:** bridges meatiness and aromatic warmth.

### Clove (tiny amounts)

**Flavor role:** sharp, sweet, medicinal warmth.  
**Why it matters:** a pinprick makes the blend smell “authentic.”  
**Risk:** overuse dominates everything.

### Cardamom

**Flavor role:** floral, citrusy warmth; airy lift.  
**Why it matters:** gives top-note elegance, especially in lamb blends.

### Nutmeg / Mace

**Flavor role:** warm, sweet, nutty perfume.  
**Why it matters:** deepens richness; used lightly.

---

## Brightness and Tang Spices (Not “Acid,” but Perception)

### Sumac

**Flavor role:** tart berry-like tang; dry “lemony” perception.  
**Why it matters:** adds brightness without adding liquid acid (important for balance).  
**SSA usage:** commonly recommended as a **finisher** for `bright` flavor goals.

### Dried lemon / citrus peel (where used)

**Flavor role:** aromatic citrus; less sharp than juice.  
**Why it matters:** can brighten without increasing marinade acidity.

---

## Heat Spices (Optional Style Knob)

### Cayenne

**Flavor role:** clean heat with minimal aroma.  
**SSA usage:** suggested when `inputs.flavorGoals` includes `heat`.  
**Risk:** too much masks warm spices.

### Chili flakes

**Flavor role:** textured heat + roasted pepper note.  
**Why it matters:** “pepper bite” that feels familiar to many households.

### Aleppo pepper (if you add later)

**Flavor role:** fruity, gentle heat; rich pepper flavor.  
**Why it matters:** heat without aggression.

---

## Smoke and Char Helpers (Home Cooking Realities)

Traditional shawarma gets flavor from vertical rotisserie rendering + char edges. Home methods often need help.

### Smoked paprika

**Flavor role:** smoke impression; grilled aroma.  
**SSA usage:** suggested when `flavorGoals` includes `smoky` or method is oven/air-fry.

### Toasted spices (technique, not ingredient)

**Flavor role:** deeper, rounder aroma.  
**SSA note:** pre-toasting whole spices is an authenticity booster, but SSA defaults to pre-ground convenience unless a “from scratch” mode exists.

---

## Herbs (More Common in Sauces / Finishes)

While dried herbs appear in some blends, fresh herb character is often carried by sauces.

### Parsley / cilantro

**Flavor role:** fresh green lift.  
**SSA mapping:** `shawarma.sauces.green_herb_shawarma_sauce`

### Mint (occasional)

**Flavor role:** cooling freshness.  
**SSA note:** more common in yogurt sauces or side salads than in the core meat blend.

---

## Ingredient Pairing Notes by Protein

SSA uses these ideas when selecting and dosing blends.

### Chicken

- thrives on **bright aromatics** (coriander, garlic, paprika)
- warm spices should be present but not heavy
- pairs well with **yogurt base** and **garlic-forward sauces**

### Beef

- likes **pepper + warm spice depth** (cumin, allspice, black pepper, hint cinnamon)
- vinegar/lemon marinade bases feel “street” and punchy
- roasted pepper sauces complement beef well

### Lamb

- handles **bolder warm spices** (cardamom, allspice, cinnamon)
- benefits from a “perfumed” top note without overpowering
- bright finishing (lemon/sumac) helps cut richness

### Vegetables

- benefit from **sumac/herb-forward** blends
- need less heavy warm spice
- pair best with green sauce + lemon finishing

---

## The “Taste Like Shawarma” Checklist

If a blend “doesn’t read” as shawarma, one of these is usually missing:

1. **Cumin/coriander backbone** is absent or too weak
2. **Warm spice hint** (allspice/cinnamon/cardamom) is missing
3. **Garlic/onion aromatic base** is too faint
4. **Acid/fat/salt balance** is off (harsh, flat, or greasy)
5. **Pickle/bright finish** isn’t present to create contrast

---

## Common Balance Mistakes (and Deterministic Fixes)

### “It tastes like taco seasoning”

- too much cumin + chili + not enough warm spice nuance  
  **Fix:** add tiny allspice/cinnamon/cardamom notes; shift to coriander/paprika balance.

### “It tastes flat”

- stale paprika; not enough salt/acid; no finishing brightness  
  **Fix:** add salt; add lemon/sumac; choose a brighter sauce.

### “It tastes harsh”

- too much acid or too little fat/emulsion  
  **Fix:** add fat/emulsifier; then recheck salt.

### “It tastes bitter after cooking”

- too much dry spice on high heat; scorched sugar/paprika  
  **Fix:** cap spice dose; pat excess marinade; reduce sugar; ensure fat for cling.

---

## How These Notes Map to SSA Files

### Spice blends

- `src/catalogs/shawarma/spice_blends/shawarma_classic_blend.json`
- `src/catalogs/shawarma/spice_blends/shawarma_chicken_blend.json`
- `src/catalogs/shawarma/spice_blends/shawarma_beef_blend.json`
- `src/catalogs/shawarma/spice_blends/shawarma_lamb_blend.json`
- `src/catalogs/shawarma/spice_blends/shawarma_vegetable_blend.json`

### Rulesets that operationalize these ideas

- `src/catalogs/shawarma/rules/shawarma_spice_selection.ruleset.json`
- `src/catalogs/shawarma/rules/shawarma_marinade_by_protein.ruleset.json`
- `src/catalogs/shawarma/rules/shawarma_acid_fat_balance.ruleset.json`

---

## Suggested UI Tooltips (Optional Copy)

Use these snippets in SSA UI where helpful:

- **Cumin:** “Earthy meat spice; the backbone of classic shawarma.”
- **Coriander:** “Citrusy warmth that brightens without sharpness.”
- **Allspice:** “Kebab-shop warmth; bridges pepper and sweet spice.”
- **Cinnamon (tiny):** “Deep warm perfume that signals ‘shawarma’ when subtle.”
- **Sumac:** “Dry tang—adds brightness without more liquid acid.”
- **Smoked paprika:** “Adds grill/smoke impression for oven and air-fryer.”

---

## Maintenance Note

If you add new blends or regional presets:

- update this doc with **why** the new spices matter
- keep “traditional” claims conservative
- prefer describing _flavor role_ over “authenticity policing”
