# Integration Runbook: PostgreSQL + MongoDB + Neo4j

This runbook defines how to operate the three-database stack safely and predictably.

## 1) Ownership (Source of Truth)

| Concern | Primary Store | Secondary Use |
|---|---|---|
| Transactional planner state, outbox, readiness, allocations | PostgreSQL | Neo4j and MongoDB consume projections/snapshots |
| Raw ingestion payloads and TTL data | MongoDB | Optional Postgres promotion when data becomes transactional |
| Relationship/recommendation graph reads | Neo4j | Never authoritative for transactional correctness |

Rules:
- PostgreSQL owns correctness for planner decisions.
- MongoDB owns raw source fidelity and cache-like TTL records.
- Neo4j owns graph traversal/read optimization only.
- Any dataset that starts driving commitments or status transitions must be promoted to PostgreSQL ownership.

Reference ownership map: docs/planning/mongo-ownership-boundaries.md

## 2) Environment Modes

Recommended flags:
- Local dev (degraded allowed): NEO4J_REQUIRED=false
- Staging burn-in: NEO4J_ENABLED=true, NEO4J_REQUIRED=false
- Production strict mode: NEO4J_ENABLED=true, NEO4J_REQUIRED=true

Core env vars:
- PostgreSQL: DATABASE_URL (or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE)
- MongoDB: MONGODB_URI (or MONGO_URI/MONGO_URL)
- Neo4j: NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, NEO4J_ENABLED, NEO4J_REQUIRED

Example env blocks:
- Local dev (degraded):
  - NEO4J_ENABLED=true
  - NEO4J_REQUIRED=false
  - MONGODB_URI=mongodb://127.0.0.1:27017/suka-dev
- Staging burn-in:
  - NEO4J_ENABLED=true
  - NEO4J_REQUIRED=false
  - DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/suka
- Production strict:
  - NEO4J_ENABLED=true
  - NEO4J_REQUIRED=true
  - NEO4J_URI=neo4j+s://<cluster-host>

## 3) One-Command Integration Preflight

Command:
- npm run integration:preflight

This runs, in order:
1. db:preflight (Postgres bootstrap + Mongo connectivity + health)
2. neo4j:preflight (Neo4j verification)
3. gate:fast (smoke + lint + audit)

Expected behavior:
- Exit 0 only when all checks pass.
- Fails fast when any required dependency is unavailable.

Health payload contract (minimum):
- `db` block exists and includes:
  - `connected` (boolean)
  - `fallbackFileMode` (boolean)
  - `uriConfigured` (boolean)
- `mongo` block exists and includes:
  - `ok` (boolean)
  - `required` (boolean)
  - `connected` (boolean)
- `postgres` block exists and includes:
  - `ok` (boolean)
  - `required` (boolean)
  - `connected` (boolean)
- `neo4j` block exists and includes:
  - `ok` (boolean)
  - `required` (boolean)
  - `connected` (boolean)

## 4) Release Go/No-Go

Go:
- integration:preflight exits 0
- health endpoint reports expected db and neo4j status
- no dead-letter or retry spike in projection workers

No-Go:
- PostgreSQL migration/bootstrap failures
- Mongo connectivity fallback where strict mode requires live Mongo
- Neo4j preflight fails while NEO4J_REQUIRED=true

## 5) Troubleshooting Quick Path

- Neo4j connection refused:
  - Verify NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
  - Confirm Neo4j listener/port and encryption compatibility
  - Temporarily set NEO4J_REQUIRED=false in non-production environments
- Mongo missing/timeout:
  - Validate MONGODB_URI and network access
  - Check fallback mode expectations for current environment
- Postgres bootstrap failure:
  - Re-run db:migrate and db:bootstrap
  - Confirm DATABASE_URL credentials and schema permissions

## 6) Strict vs Degraded DB Policy

Use this policy to avoid accidental strict-mode outages:
- Production:
  - Mode: strict
  - Required flags: `NEO4J_REQUIRED=true`
  - Deployment rule: no release when `integration:preflight` fails.
- Staging:
  - Mode: degraded-allowed during burn-in
  - Required flags: `NEO4J_REQUIRED=false` unless explicit strict verification window is scheduled.
  - Deployment rule: degraded mode is acceptable only for controlled verification windows.
- Local development:
  - Mode: degraded-allowed by default
  - Required flags: `NEO4J_REQUIRED=false`
  - Developer rule: switch to strict locally before promoting infra/config changes.

Escalation triggers:
- Any production strict-mode boot failure.
- Repeated `db:preflight` health timeouts.
- Repeated fallback activation outside approved staging windows.

## 7) Reliability Backlog

Tracked in: `docs/planning/integration-reliability-backlog.md`
