# SSA Layers (Fixed-Layer Spine)

This folder contains SSA's **fixed layers**: validated JSON assets (catalogs + lexicons) and deterministic resolvers that convert user intent + context into repeatable plan blueprints.

## Why layers?
SSA has a finite set of planning variations. Instead of generating ad-hoc tasks, SSA:
1. Parses intent with lexicons (L1)
2. Matches methods/patterns deterministically (L2)
3. Builds blueprints/sessions from catalog patterns (L3)
4. Applies overlays (culture/season/lean/overrides) without changing the engine

## Key rules
- Catalog patterns are **finite** and repeatable.
- Cultural workflows are **opt-in overlays** and must never hard-code stereotypes.
- Lexicon action types are constrained to the enum used by SSA validators:
  - boostMethodKey, downrankMethodKey, blockMethodKey, addNote, addWarning, emitHintTag

## Tests
Run layer asset validation to prevent drift:
- `src/layers/__tests__/layerAssets.test.js`
