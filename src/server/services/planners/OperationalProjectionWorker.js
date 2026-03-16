"use strict";

const { randomUUID } = require("node:crypto");

const {
  claimOutboxBatch,
  heartbeatOutboxLeases,
  markOutboxProcessed,
  markOutboxRetry,
  markOutboxDeadLetter,
  getOutboxStatus,
} = require("./OperationalOutboxService");

const {
  neo4jDriver,
} = require("./PlannerIntegrationService");
const {
  recordBatchStart,
  recordBatchResult,
  recordBatchError,
  recordClaimedEvent,
  recordProcessedEvent,
  recordRetriedEvent,
  recordDeadLetteredEvent,
  recordEventFailure,
  recordHeartbeatRun,
  logStructured,
} = require("./OperationalOutboxObservability");

let mongoose = null;
try {
  mongoose = require("mongoose");
} catch {
  mongoose = null;
}

const WORKER_INTERVAL_MS = Number(process.env.OPERATIONAL_OUTBOX_WORKER_INTERVAL_MS || 3000);
const RETRY_DELAY_MS = Number(process.env.OPERATIONAL_OUTBOX_RETRY_DELAY_MS || 5000);
const LEASE_MS = Math.max(1000, Number(process.env.OPERATIONAL_OUTBOX_LEASE_MS || 15000));
const HEARTBEAT_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.OPERATIONAL_OUTBOX_HEARTBEAT_INTERVAL_MS || Math.floor(LEASE_MS / 3))
);
const MAX_ATTEMPTS = Number(process.env.OPERATIONAL_OUTBOX_MAX_ATTEMPTS || 10);
const REQUIRE_NEO4J = String(process.env.OPERATIONAL_OUTBOX_REQUIRE_NEO4J || "false").toLowerCase() === "true";
const REQUIRE_MONGO = String(process.env.OPERATIONAL_OUTBOX_REQUIRE_MONGO || "false").toLowerCase() === "true";
const WORKER_ID = String(process.env.OPERATIONAL_OUTBOX_WORKER_ID || `outbox-worker-${process.pid}-${randomUUID().slice(0, 8)}`);

let workerTimer = null;
let heartbeatTimer = null;
let workerInFlight = false;
const inFlightEventIds = new Set();

async function heartbeatInFlightLeases() {
  if (!inFlightEventIds.size) return { ok: true, renewed: 0 };
  const ids = Array.from(inFlightEventIds.values());
  try {
    const renewed = await heartbeatOutboxLeases({
      workerId: WORKER_ID,
      ids,
      leaseMs: LEASE_MS,
      updatedBy: "outbox.worker",
      changeReason: "lease_heartbeat",
    });
    recordHeartbeatRun({ renewed: renewed.length });
    return { ok: true, renewed: renewed.length };
  } catch (error) {
    recordHeartbeatRun({ error: String(error?.message || error || "heartbeat_failed") });
    throw error;
  }
}

async function projectEventToNeo4j(event) {
  if (!neo4jDriver) {
    return REQUIRE_NEO4J
      ? { ok: false, retryable: true, error: "neo4j_unavailable" }
      : { ok: true, skipped: true, reason: "neo4j_unavailable_optional" };
  }

  const session = neo4jDriver.session();
  try {
    await session.writeTransaction((tx) =>
      tx.run(
        `
          MERGE (e:OperationalOutboxEvent {outboxEventId: $outboxEventId})
          SET e.eventType = $eventType,
              e.aggregateType = $aggregateType,
              e.aggregateId = $aggregateId,
              e.householdId = $householdId,
              e.payload = $payload,
              e.eventMeta = $eventMeta,
              e.projectedAt = datetime()
          WITH e
          FOREACH (_ IN CASE WHEN $householdId IS NULL OR $householdId = '' THEN [] ELSE [1] END |
            MERGE (h:Household {id: $householdId})
            MERGE (h)-[:HAS_OPERATIONAL_EVENT]->(e)
          )
        `,
        {
          outboxEventId: String(event.id),
          eventType: String(event.event_type || "unknown"),
          aggregateType: String(event.aggregate_type || "unknown"),
          aggregateId: String(event.aggregate_id || "unknown"),
          householdId: event.household_id == null ? null : String(event.household_id),
          payload: event.payload || {},
          eventMeta: event.event_meta || {},
        }
      )
    );

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      error: String(error?.message || error || "neo4j_projection_failed"),
    };
  } finally {
    await session.close();
  }
}

async function projectEventToMongo(event) {
  if (!mongoose?.connection?.db) {
    return REQUIRE_MONGO
      ? { ok: false, retryable: true, error: "mongo_unavailable" }
      : { ok: true, skipped: true, reason: "mongo_unavailable_optional" };
  }

  try {
    const coll = mongoose.connection.db.collection("operational_projection_events");
    await coll.updateOne(
      { outboxEventId: String(event.id) },
      {
        $setOnInsert: {
          outboxEventId: String(event.id),
          createdAt: new Date(),
        },
        $set: {
          householdId: event.household_id == null ? null : String(event.household_id),
          aggregateType: String(event.aggregate_type || "unknown"),
          aggregateId: String(event.aggregate_id || "unknown"),
          eventType: String(event.event_type || "unknown"),
          payload: event.payload || {},
          eventMeta: event.event_meta || {},
          projectedAt: new Date(),
        },
      },
      { upsert: true }
    );

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      retryable: true,
      error: String(error?.message || error || "mongo_projection_failed"),
    };
  }
}

async function projectOutboxEvent(event) {
  // Idempotent by target key:
  // - Neo4j uses MERGE on outboxEventId
  // - Mongo uses upsert on outboxEventId
  const neo4j = await projectEventToNeo4j(event);
  if (!neo4j.ok) return neo4j;

  const mongo = await projectEventToMongo(event);
  if (!mongo.ok) return mongo;

  return {
    ok: true,
    targets: {
      neo4j: neo4j.skipped ? "skipped" : "projected",
      mongo: mongo.skipped ? "skipped" : "projected",
    },
  };
}

async function processOutboxBatch({ limit = 25, householdId = null } = {}) {
  const batch = recordBatchStart({ requestedLimit: limit, householdId });
  const claimed = await claimOutboxBatch({
    limit,
    householdId,
    workerId: WORKER_ID,
    leaseMs: LEASE_MS,
    updatedBy: "outbox.worker",
    changeReason: "worker_claim",
  });
  const results = [];

  for (const event of claimed) {
    recordClaimedEvent(event);
    inFlightEventIds.add(String(event.id));
    const eventStartedAt = Date.now();
    try {
      // eslint-disable-next-line no-await-in-loop
      await heartbeatOutboxLeases({
        workerId: WORKER_ID,
        ids: [String(event.id)],
        leaseMs: LEASE_MS,
        updatedBy: "outbox.worker",
        changeReason: "lease_heartbeat",
      });

      // eslint-disable-next-line no-await-in-loop
      const projection = await projectOutboxEvent(event);
      if (projection.ok) {
        // eslint-disable-next-line no-await-in-loop
        await markOutboxProcessed(event.id, {
          updatedBy: "outbox.worker",
          changeReason: "projection_processed",
        });
        recordProcessedEvent({
          id: event.id,
          eventType: event.event_type,
          attempts: Number(event.attempts || 0),
          durationMs: Date.now() - eventStartedAt,
          targets: projection.targets || {},
        });
        results.push({ id: event.id, ok: true, projection });
      } else {
        if (Number(event.attempts || 0) >= MAX_ATTEMPTS) {
          // eslint-disable-next-line no-await-in-loop
          await markOutboxDeadLetter(event.id, {
            reason: projection.error || "max_attempts_reached",
            updatedBy: "outbox.worker",
            changeReason: "projection_dead_letter",
          });
          recordDeadLetteredEvent({
            id: event.id,
            eventType: event.event_type,
            attempts: Number(event.attempts || 0),
            error: projection.error || "max_attempts_reached",
          });
          results.push({ id: event.id, ok: false, deadLettered: true, error: projection.error || "max_attempts_reached" });
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        await markOutboxRetry(event.id, {
          delayMs: RETRY_DELAY_MS,
          error: projection.error || "projection_failed",
          updatedBy: "outbox.worker",
          changeReason: "projection_retry",
        });
        recordRetriedEvent({
          id: event.id,
          eventType: event.event_type,
          attempts: Number(event.attempts || 0),
          durationMs: Date.now() - eventStartedAt,
          error: projection.error || "projection_failed",
        });
        results.push({ id: event.id, ok: false, error: projection.error || "projection_failed" });
      }
    } catch (error) {
      recordEventFailure({
        id: event.id,
        eventType: event.event_type,
        attempts: Number(event.attempts || 0),
        error: String(error?.message || error || "projection_exception"),
      });
      if (Number(event.attempts || 0) >= MAX_ATTEMPTS) {
        // eslint-disable-next-line no-await-in-loop
        await markOutboxDeadLetter(event.id, {
          reason: String(error?.message || error || "max_attempts_reached"),
          updatedBy: "outbox.worker",
          changeReason: "projection_dead_letter_exception",
        });
        recordDeadLetteredEvent({
          id: event.id,
          eventType: event.event_type,
          attempts: Number(event.attempts || 0),
          error: String(error?.message || error || "max_attempts_reached"),
        });
        results.push({ id: event.id, ok: false, deadLettered: true, error: String(error?.message || error) });
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      await markOutboxRetry(event.id, {
        delayMs: RETRY_DELAY_MS,
        error: String(error?.message || error || "projection_exception"),
        updatedBy: "outbox.worker",
        changeReason: "projection_retry_exception",
      });
      recordRetriedEvent({
        id: event.id,
        eventType: event.event_type,
        attempts: Number(event.attempts || 0),
        durationMs: Date.now() - eventStartedAt,
        error: String(error?.message || error || "projection_exception"),
      });
      results.push({ id: event.id, ok: false, error: String(error?.message || error) });
    } finally {
      inFlightEventIds.delete(String(event.id));
    }
  }

  recordBatchResult({
    startedAt: batch.startedAt,
    claimed: claimed.length,
    processed: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok).length,
    deadLettered: results.filter((x) => x.deadLettered).length,
  });

  return {
    ok: true,
    claimed: claimed.length,
    processed: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok).length,
    results,
  };
}

async function workerTick() {
  if (workerInFlight) return;
  workerInFlight = true;
  try {
    await processOutboxBatch({ limit: 50 });
  } catch (error) {
    recordBatchError(error);
    logStructured("error", "worker.tick_failed", {
      workerId: WORKER_ID,
      error: String(error?.message || error || "worker_tick_failed"),
    });
    throw error;
  } finally {
    workerInFlight = false;
  }
}

function startOperationalProjectionWorker() {
  if (workerTimer) return { ok: true, started: false };
  workerTimer = setInterval(workerTick, WORKER_INTERVAL_MS);
  if (typeof workerTimer.unref === "function") workerTimer.unref();
  heartbeatTimer = setInterval(() => {
    heartbeatInFlightLeases().catch(() => {
      // worker heartbeat is best-effort; processing loop still handles retries/dead-letter.
    });
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  logStructured("info", "worker.started", {
    workerId: WORKER_ID,
    intervalMs: WORKER_INTERVAL_MS,
    leaseMs: LEASE_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  });
  return {
    ok: true,
    started: true,
    intervalMs: WORKER_INTERVAL_MS,
    leaseMs: LEASE_MS,
    heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
    workerId: WORKER_ID,
  };
}

function stopOperationalProjectionWorker() {
  if (!workerTimer) return { ok: true, stopped: false };
  clearInterval(workerTimer);
  workerTimer = null;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  inFlightEventIds.clear();
  logStructured("info", "worker.stopped", { workerId: WORKER_ID });
  return { ok: true, stopped: true };
}

async function getOperationalProjectionWorkerStatus() {
  const outbox = await getOutboxStatus();
  return {
    ok: true,
    worker: {
      running: !!workerTimer,
      inFlight: !!workerInFlight,
      workerId: WORKER_ID,
      intervalMs: WORKER_INTERVAL_MS,
      leaseMs: LEASE_MS,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      inFlightEvents: inFlightEventIds.size,
      requireNeo4j: REQUIRE_NEO4J,
      requireMongo: REQUIRE_MONGO,
    },
    outbox,
  };
}

module.exports = {
  processOutboxBatch,
  startOperationalProjectionWorker,
  stopOperationalProjectionWorker,
  getOperationalProjectionWorkerStatus,
};