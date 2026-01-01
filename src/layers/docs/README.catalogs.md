# SSA Catalogs

Catalogs define **finite planning patterns** SSA can assemble into sessions.

✅ Patterns are:
- repeatable workflow objects
- structured inputs/outputs/constraints/steps
- convertible to SSA blueprints

❌ Patterns are NOT:
- raw UI tasks
- recipes
- one-off personal plans

## Required fields
Each pattern should include:
- id, domain, kind, title
- intentTags
- inputs, outputs, constraints
- steps (blueprint templates)
- kpis (Lean-friendly metrics)

Recommended:
- variants
- lean block (waste targets, countermeasures)
- ui block (fields, chips, help)
- requires / produces (cross-domain links)

## Index files
Each catalog folder has an `index.json` listing patterns with id/path/tags and changelog/version.
