# SSA Lexicons

Lexicons map phrases to canonical method IDs (often catalog pattern IDs) and emit Lean signals and hint tags.

## Allowed action types (SSA constraint)
- boostMethodKey
- downrankMethodKey
- blockMethodKey
- addNote
- addWarning
- emitHintTag

Do not add other action types unless you update SSA validators and schema together.

## Best practices
- Prefer emitHintTag for missing context instead of failing.
- Keep culturally aware terms as mappings to canonical tags, not assumptions.
- Keep routing lexicons aligned to pattern IDs (not recipes).
