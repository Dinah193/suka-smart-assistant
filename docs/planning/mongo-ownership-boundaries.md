# Mongo Ownership Boundaries

This document is the canonical ownership map for planner data persistence.

## Decision Summary
- PostgreSQL is the authoritative system of record for planner domain state and operations.
- MongoDB is authoritative for raw ingestion/snapshot collections that do not drive transactional planner correctness.
- Neo4j is authoritative only for graph projection/read-optimization concerns.
- Runtime contract enforcement in CI: `db-runtime-contracts` is required and must stay green.

## Ownership Matrix

| Domain/Data | Primary Store | Secondary/Projection | Authority | Notes |
|---|---|---|---|---|
| Meal plans (`meal_plans`, `meal_plan_items`) | PostgreSQL | Neo4j projections, optional Mongo snapshots | PostgreSQL | Release and operational decisions read from Postgres first. |
| Storehouse lots (`storehouse_lots`) | PostgreSQL | Neo4j lot graph projection | PostgreSQL | Inventory state transitions must be transactionally consistent in Postgres. |
| Preservation inventory/batches (`preservation_inventory`, `preservation_batches`) | PostgreSQL | Neo4j recommendation links, optional Mongo snapshots | PostgreSQL | Planner scoring and readiness rely on Postgres rows. |
| Homestead plans/outputs (`homestead_plans`, `homestead_outputs`) | PostgreSQL | Neo4j planning graph projection | PostgreSQL | Scheduling and forecast source is Postgres. |
| Operational outbox/events | PostgreSQL | Neo4j + Mongo projection consumers | PostgreSQL | Outbox durability, retries, and dead-letter are Postgres-owned. |
| Raw recipe ingestion (`raw_recipes`) | MongoDB | Postgres curated records when promoted | MongoDB | Raw payload storage and source fidelity remain Mongo-owned. |
| Raw nutrition ingestion (`nutrition_data`) | MongoDB | Postgres derived aggregates if needed | MongoDB | Raw upstream nutrition documents remain Mongo-owned. |
| Nutrition lookup adapter (`nutrition_records`) | MongoDB | None | MongoDB | Contract-gated with focused runtime test. |
| Catalog/source snapshots | MongoDB or file cache | Postgres indexes when curated | MongoDB/file until promotion | Promotion to transactional planning requires Postgres write path. |
| Realtime graph recommendation edges | Neo4j | N/A | Neo4j | Must not be treated as transactional source of truth. |

## Promotion Rule
When any Mongo dataset begins to drive transactional planner behavior (status changes, commitments, allocations, or release decisions), that dataset must be promoted to PostgreSQL ownership first, with Mongo retained only as a raw/snapshot companion.

## CI Policy
- Required check: `db-runtime-contracts` in [.github/workflows/ci.yml](.github/workflows/ci.yml).
- Gate contents:
  - `db:preflight` (Postgres bootstrap + Mongo connectivity + server health)
  - `_tests_/nutritionMongoAdapter.contract.test.js` with `SSA_ENABLE_DB_RUNTIME_CONTRACT_TESTS=true`
- Branch protection must include `db-runtime-contracts` in required checks.

## Nutrition Adapter Expectations (Audit Sign-off)
- Service adapter priority is intentional: Postgres adapter first, Mongo adapter fallback only when Postgres adapter is unavailable (see `pickAdapter` in `src/server/services/nutritionService.js`).
- Unavailable-DB behavior contract is intentional for Mongo adapter:
  - Reads (`getById`, `getByName`) return soft miss: `{ ok: true, data: null }`
  - Writes (`upsert`) return hard fail: `{ ok: false, error: "mongo_unavailable" }`
- Name normalization parity is intentional and aligned between service and adapter:
  - Service normalization in `src/server/services/nutritionService.js`
  - Adapter normalization in `src/server/db/adapters/nutrition.mongo.js`
  - Both use lowercase + diacritic strip + punctuation collapse + whitespace normalize + light singularization.
