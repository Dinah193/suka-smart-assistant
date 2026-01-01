C:\Users\larho\suka-smart-assistant\src\schemas\README.txt
================================================================================
Suka Smart Assistant (SSA) — Schemas
Versioned schema definitions & backward-compatibility notes
================================================================================

ROLE IN THE PIPELINE
--------------------
imports (scrape/ingest) → intelligence (normalize/adapt) → automation (rules/tasks)
→ (optional) hub export (Family Fund). These schemas define the normalized contracts
exchanged between subsystems and over the event bus.

CURRENT META
------------
- JSON Schema Draft: draft-07 (validator-friendly in VS Code and most runtimes)
- File naming: *.schema.json
- $id namespace: https://suka-smart-assistant/schemas/<Name>.schema.json
- Event envelope (shared): { type, ts, source, data } with ISO-8601 ts

IN THIS FOLDER
--------------
- Task.schema.json                Universal Task contract
- ResourceReadiness.schema.json   Readiness gate for steps/resources
- Rule.schema.json                Universal rule format (conditions → actions)
- Preference.schema.json          User/household preferences
- (Add others here as they are introduced; keep $id unique and immutable)

================================================================================
1) VERSIONING & COMPATIBILITY POLICY
================================================================================
We use **Semantic Versioning** for payloads *within each schema file*:

- MAJOR (X.0.0): Breaking change to structure or semantics
  * Requires migration tooling and dual-read period.
- MINOR (0.X.0): Backward-compatible additions (new optional fields, enum values)
  * Consumers must ignore unknown fields.
- PATCH (0.0.X): Clarifications, description updates, tightened patterns without breakage

Schema file itself does NOT change its $id; instead, the *payload*’s version
field (e.g., "version": "1.0.0") increments. This allows documents using
older payload versions to remain valid as long as changes are non-breaking.

BACKWARD-COMPATIBLE CHANGES (ALLOWED):
- Add optional properties with sane defaults
- Add new enum values (consumers must treat unknown enum as 'other' if supported)
- Add new definitions referenced by optional fields
- Broaden pattern constraints where safe

BREAKING CHANGES (AVOID; REQUIRE MAJOR):
- Rename/remove existing properties
- Change types of existing properties
- Tighten validation in a way that rejects previously valid documents
- Reinterpret semantics (e.g., units, meaning of fields)

DEPRECATION PROCESS:
1) Mark property as deprecated in description; keep validating.
2) Announce in CHANGELOG and analytics warning counters.
3) Provide migration function in /schemas/migrations/<Name>/vA_to_B.js.
4) After ≥2 MINOR cycles, remove in next MAJOR and bump payload version.

================================================================================
2) CROSS-SCHEMA REFERENCES
================================================================================
- Use absolute $ref to external schemas: e.g.
  "$ref": "https://suka-smart-assistant/schemas/Task.schema.json"
- Use local "#/definitions/…" for within-file references.
- Keep $id immutable; treat schema files as addressable API contracts.

================================================================================
3) EVENT ENVELOPE (CANONICAL)
================================================================================
All events must use this immutable envelope:

{
  "type": "string",           // e.g., "import.parsed", "inventory.updated"
  "ts":   "2025-11-11T21:00:00.000Z",
  "source": "ModuleName",     // e.g., "ScraperEngine", "InventorySessionEngine"
  "data": { ... }             // payload per event type; may embed schema’d objects
}

Guidelines:
- Never break envelope keys.
- Prefer embedding schema’d objects (Task, Rule, Readiness) in data.

================================================================================
4) SCHEMA EVOLUTION GUIDELINES
================================================================================
ENUMS:
- When adding enum values, keep an "other" or "unknown" fallback in consumers.
- Document new values in this README and Rule/Task/Readiness comments.

UNITS:
- Always specify explicit units in field names or adjacent "unit" property.
- Preferences control display conversion; storage remains canonical.

DATES & TIMES:
- Use ISO-8601 strings with timezone (UTC recommended).
- Preferences.scope.timezone informs UI, not storage.

IDENTIFIERS:
- Prefer deterministic ids (hash of stable fields) where deduplication helps.
- Keep id spaces distinct (taskId, ruleId, readinessId).

================================================================================
5) VALIDATION & TESTING
================================================================================
DEV VALIDATION:
- VS Code JSON Schema validation should be green (draft-07)
- Node tooling: ajv@^8 (draft-07 mode)

TEST CONTRACTS:
- Place sample instances under /schemas/examples/<Name>/
- Add a Jest test per schema that:
  1) Validates provided examples
  2) Asserts unknown-field ignore behavior in consumers
  3) Round-trips migrations (when present)

CLI SNIPPET (ajv):
  npx ajv -s src/schemas/Task.schema.json -d src/schemas/examples/task_ok.json

================================================================================
6) MIGRATIONS (PATTERN)
================================================================================
Each schema with breaking changes must ship a migration helper:

/schemas/migrations/Task/v1_to_v2.js
------------------------------------
module.exports = function migrateTaskV1toV2(doc){
  const out = { ...doc };
  out.version = "2.0.0";
  // Example: split 'durationMinutes' → metrics.{prepMinutes,activeMinutes,totalMinutes}
  if (typeof doc.durationMinutes === "number") {
    out.metrics = out.metrics || {};
    out.metrics.totalMinutes = doc.durationMinutes;
    delete out.durationMinutes;
  }
  return out;
};

At runtime, consumers should:
- Detect payload version
- Apply chain of migrations until current version
- Validate with current schema
- Log provenance of migrations (old → new hashes)

================================================================================
7) COMPATIBILITY MATRIX (RUNTIME → SCHEMA PAYLOAD)
================================================================================
Runtime/Service                    Supported payload versions
----------------------------------------------------------------
ImportRouter                       Task 1.x, Rule 1.x
InventorySessionEngine             Task 1.x
Automation Runtime                 Task 1.x, Rule 1.x, Readiness 1.x, Preference 1.x
Scraper/Normalizer                 Preference 1.x (units, dietary)
Hub Export (FamilyFundConnector)   Task 1.x summary/full (no PII)

* If a consumer sees an unknown MINOR: attempt to proceed (ignore unknown fields).
* If a consumer sees a higher MAJOR: reject and request migration.

================================================================================
8) CHANGELOG (SCHEMAS)
================================================================================
[1.0.0] 2025-11-11
- Initial release for Task, ResourceReadiness, Rule, Preference (draft-07).
- Established event envelope, units policy, and deprecation workflow.

(Add future entries here; keep terse and actionable.)

================================================================================
9) REVIEW & PR CHECKLIST
================================================================================
[ ] $schema is draft-07
[ ] $id is unique, stable, correct URL
[ ] Required fields minimal and justified
[ ] New fields optional with defaults where sensible
[ ] Enums documented; consumers tolerate unknown values
[ ] Examples updated and validated
[ ] Migrations provided for breaking changes
[ ] README updated (this file)

================================================================================
10) FREQUENT PATTERNS (DOs and DON’Ts)
================================================================================
DO:
- Keep descriptions practical; mention units and examples.
- Emit ISO timestamps; compute local views in UI only.
- Model “actions” and “conditions” declaratively (see Rule.schema.json).

DON’T:
- Bake user-specific preferences into normalized objects (use Preference).
- Store raw HTML or PII in normalized payloads.
- Change meaning of existing fields; prefer adding new ones.

================================================================================
11) CONTACT
================================================================================
Owner: SSA Architecture
Notes: Questions about schema changes go to #ssa-schemas channel (internal).

-- END --
