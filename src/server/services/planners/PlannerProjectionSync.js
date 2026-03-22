"use strict";

const { randomUUID } = require("node:crypto");
const { publishPlannerEvent, PlannerEvents } = require("../../../eventBus/plannerEventBus");
const {
  buildProjectionRealtimeEnvelope,
  bridgeProjectionRealtimeEvent,
} = require("./PlannerRealtimeBridge");
const {
  pgPool,
  projectInventoryToNeo4j,
  projectHomesteadOutputsToNeo4j,
  getStorehousePlannerSnapshot,
  getHomesteadPlannerSnapshot,
} = require("./PlannerIntegrationService");

const MAX_PROJECTION_ATTEMPTS = Number(process.env.PLANNER_PROJECTION_MAX_ATTEMPTS || 5);
const WORKER_INTERVAL_MS = Number(process.env.PLANNER_PROJECTION_WORKER_INTERVAL_MS || 3000);

let workerTimer = null;
let workerInFlight = false;

async function ensureProjectionTables() {
  await pgPool.query(`
    create table if not exists planner_projection_jobs (
      id uuid primary key,
      household_id text not null,
      planner text not null,
      update_type text not null,
      status text not null default 'queued',
      attempts int not null default 0,
      next_attempt_at timestamptz not null default now(),
      payload jsonb not null default '{}'::jsonb,
      projection_result jsonb,
      last_error text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      processed_at timestamptz
    )
  `);

  await pgPool.query(`
    create index if not exists idx_projection_jobs_status_next_attempt
    on planner_projection_jobs (status, next_attempt_at, created_at)
  `);
}

function retryDelayMs(attempts) {
  const exp = Math.min(6, Math.max(1, Number(attempts || 1)));
  return Math.min(120_000, 2000 * (2 ** exp));
}

function normalizeProjectionContract({
  planner,
  householdId,
  updateType,
  projection,
  counts = {},
  warnings = [],
  queue = {},
}) {
  return {
    contractVersion: 2,
    planner,
    householdId: String(householdId || "default-household"),
    updateType,
    projection: {
      ok: !!projection?.ok,
      projected: Number(projection?.projected || 0),
      reason: projection?.reason || null,
    },
    counts: {
      inventoryItems: Number(counts.inventoryItems || 0),
      outputItems: Number(counts.outputItems || 0),
    },
    queue: {
      jobId: queue.jobId || null,
      status: queue.status || null,
      attempts: Number(queue.attempts || 0),
      accepted: !!queue.accepted,
      durable: !!queue.durable,
    },
    warnings: Array.isArray(warnings) ? warnings : [],
  };
}

async function enqueueProjectionJob({ householdId, planner, updateType, payload }) {
  await ensureProjectionTables();
  const id = randomUUID();

  const { rows } = await pgPool.query(
    `
      insert into planner_projection_jobs (
        id, household_id, planner, update_type, status, attempts, next_attempt_at, payload, updated_at
      )
      values ($1, $2, $3, $4, 'queued', 0, now(), $5::jsonb, now())
      returning id, status, attempts
    `,
    [
      id,
      String(householdId || "default-household"),
      String(planner || "unknown"),
      String(updateType || "unknown"),
      JSON.stringify(payload || {}),
    ]
  );

  return rows[0] || { id, status: "queued", attempts: 0 };
}

async function claimNextProjectionJob() {
  await ensureProjectionTables();
  const { rows } = await pgPool.query(`
    with candidate as (
      select id
      from planner_projection_jobs
      where status in ('queued', 'retry')
        and next_attempt_at <= now()
      order by created_at asc
      limit 1
      for update skip locked
    )
    update planner_projection_jobs j
    set status = 'processing', updated_at = now()
    from candidate
    where j.id = candidate.id
    returning j.*
  `);
  return rows[0] || null;
}

async function markProjectionJobSuccess(job, projectionResult) {
  const { rows } = await pgPool.query(
    `
      update planner_projection_jobs
      set
        status = 'processed',
        attempts = attempts + 1,
        projection_result = $2::jsonb,
        last_error = null,
        processed_at = now(),
        updated_at = now()
      where id = $1
      returning id, status, attempts, processed_at
    `,
    [job.id, JSON.stringify(projectionResult || {})]
  );
  return rows[0] || null;
}

async function markProjectionJobFailure(job, error) {
  const nextAttempts = Number(job.attempts || 0) + 1;
  const terminal = nextAttempts >= MAX_PROJECTION_ATTEMPTS;
  const nextStatus = terminal ? "dead_letter" : "retry";
  const nextAttemptAt = new Date(Date.now() + retryDelayMs(nextAttempts)).toISOString();

  const { rows } = await pgPool.query(
    `
      update planner_projection_jobs
      set
        status = $2,
        attempts = $3,
        last_error = $4,
        next_attempt_at = case when $2 = 'retry' then $5::timestamptz else next_attempt_at end,
        updated_at = now()
      where id = $1
      returning id, status, attempts, last_error, next_attempt_at
    `,
    [
      job.id,
      nextStatus,
      nextAttempts,
      String(error?.message || error || "projection_failed"),
      nextAttemptAt,
    ]
  );

  return rows[0] || null;
}

async function applyProjectionJob(job) {
  const payload = job?.payload || {};
  if (job.planner === "storehouse") {
    const inventory = Array.isArray(payload?.projectionInput?.inventory)
      ? payload.projectionInput.inventory
      : [];
    const out = await projectInventoryToNeo4j({
      householdId: job.household_id,
      inventory,
    });
    if (!out?.ok) {
      throw new Error(`neo4j_projection_failed:${out?.reason || "unknown"}`);
    }
    return {
      ok: true,
      planner: "storehouse",
      projected: Number(out.projected || inventory.length),
      reason: out.reason || null,
    };
  }

  if (job.planner === "homestead") {
    const outputs = Array.isArray(payload?.projectionInput?.outputs)
      ? payload.projectionInput.outputs
      : [];
    const out = await projectHomesteadOutputsToNeo4j({
      householdId: job.household_id,
      planId: payload?.projectionInput?.planId || payload?.planId || null,
      seasonKey: payload?.projectionInput?.seasonKey || payload?.seasonKey || null,
      outputs,
    });
    if (!out?.ok) {
      throw new Error(`neo4j_projection_failed:${out?.reason || "unknown"}`);
    }
    return {
      ok: true,
      planner: "homestead",
      projected: Number(out.projected || outputs.length),
      reason: out.reason || "homestead_projected",
    };
  }

  return {
    ok: true,
    planner: String(job.planner || "unknown"),
    projected: 0,
    reason: "no_projection_handler",
  };
}

async function processProjectionJob(job) {
  try {
    const projectionResult = await applyProjectionJob(job);
    const saved = await markProjectionJobSuccess(job, projectionResult);
    return {
      ok: true,
      job: saved,
      projectionResult,
    };
  } catch (error) {
    const saved = await markProjectionJobFailure(job, error);
    return {
      ok: false,
      job: saved,
      error: String(error?.message || error),
    };
  }
}

async function processProjectionBacklog({ limit = 10 } = {}) {
  await ensureProjectionTables();
  const out = [];
  const safeLimit = Math.max(1, Number(limit || 10));

  for (let i = 0; i < safeLimit; i += 1) {
    const job = await claimNextProjectionJob();
    if (!job) break;
    out.push(await processProjectionJob(job));
  }

  return {
    ok: true,
    processed: out.length,
    results: out,
  };
}

async function getProjectionStatus() {
  await ensureProjectionTables();
  const { rows } = await pgPool.query(`
    select status, count(*)::int as count
    from planner_projection_jobs
    group by status
  `);

  const byStatus = rows.reduce((acc, row) => {
    acc[row.status] = Number(row.count || 0);
    return acc;
  }, {});

  const total = Object.values(byStatus).reduce((sum, n) => sum + Number(n || 0), 0);

  return {
    ok: true,
    worker: {
      running: !!workerTimer,
      inFlight: !!workerInFlight,
      intervalMs: WORKER_INTERVAL_MS,
    },
    queue: {
      total,
      queued: Number(byStatus.queued || 0),
      retry: Number(byStatus.retry || 0),
      processing: Number(byStatus.processing || 0),
      processed: Number(byStatus.processed || 0),
      deadLetter: Number(byStatus.dead_letter || 0),
    },
  };
}

async function replayProjectionJobs({ householdId = null, planner = null, limit = 50 } = {}) {
  await ensureProjectionTables();
  const clauses = ["status in ('retry', 'dead_letter')"];
  const params = [];

  if (householdId) {
    params.push(String(householdId));
    clauses.push(`household_id = $${params.length}`);
  }
  if (planner) {
    params.push(String(planner));
    clauses.push(`planner = $${params.length}`);
  }

  params.push(Math.max(1, Number(limit || 50)));

  const { rows } = await pgPool.query(
    `
      with picked as (
        select id
        from planner_projection_jobs
        where ${clauses.join(" and ")}
        order by updated_at asc
        limit $${params.length}
      )
      update planner_projection_jobs j
      set status = 'queued', next_attempt_at = now(), updated_at = now(), last_error = null
      from picked
      where j.id = picked.id
      returning j.id
    `,
    params
  );

  return {
    ok: true,
    replayed: rows.length,
  };
}

async function reconcileHouseholdProjection({ householdId, planner = "all", processNow = false } = {}) {
  const hh = String(householdId || "default-household");
  const queued = [];

  if (planner === "all" || planner === "storehouse") {
    const snapshot = await getStorehousePlannerSnapshot(hh);
    const item = await enqueueProjectionJob({
      householdId: hh,
      planner: "storehouse",
      updateType: "reconcile.snapshot",
      payload: {
        projectionInput: {
          inventory: Array.isArray(snapshot?.inventory) ? snapshot.inventory : [],
        },
      },
    });
    queued.push({ planner: "storehouse", jobId: item.id });
  }

  if (planner === "all" || planner === "homestead") {
    const snapshot = await getHomesteadPlannerSnapshot(hh);
    const item = await enqueueProjectionJob({
      householdId: hh,
      planner: "homestead",
      updateType: "reconcile.snapshot",
      payload: {
        projectionInput: {
          outputs: Array.isArray(snapshot?.outputs) ? snapshot.outputs : [],
        },
      },
    });
    queued.push({ planner: "homestead", jobId: item.id });
  }

  let processed = null;
  if (processNow) {
    processed = await processProjectionBacklog({ limit: queued.length || 1 });
  }

  return {
    ok: true,
    householdId: hh,
    planner,
    queued,
    processed,
  };
}

async function workerTick() {
  if (workerInFlight) return;
  workerInFlight = true;
  try {
    await processProjectionBacklog({ limit: 5 });
  } catch {
    // keep worker resilient; errors are persisted per-job
  } finally {
    workerInFlight = false;
  }
}

function startProjectionWorker() {
  if (workerTimer) return { ok: true, started: false };
  workerTimer = setInterval(workerTick, WORKER_INTERVAL_MS);
  if (typeof workerTimer.unref === "function") workerTimer.unref();
  return { ok: true, started: true };
}

function stopProjectionWorker() {
  if (!workerTimer) return { ok: true, stopped: false };
  clearInterval(workerTimer);
  workerTimer = null;
  return { ok: true, stopped: true };
}

async function syncStorehouseUpdate(payload = {}) {
  const reqPayload =
    payload && payload.payload && typeof payload.payload === "object" ? payload.payload : payload;
  const upsert = payload && payload.upsert && typeof payload.upsert === "object" ? payload.upsert : {};
  const queuedFromTx =
    payload && payload.queuedJob && typeof payload.queuedJob === "object"
      ? payload.queuedJob
      : upsert && upsert.projectionQueue && typeof upsert.projectionQueue === "object"
        ? upsert.projectionQueue
        : null;

  const inventory = Array.isArray(upsert.projectedInventory)
    ? upsert.projectedInventory
    : Array.isArray(reqPayload.inventory)
      ? reqPayload.inventory
      : [];

  const queued = queuedFromTx || (await enqueueProjectionJob({
    householdId: reqPayload.householdId || upsert.householdId,
    planner: "storehouse",
    updateType: "inventory.upsert",
    payload: {
      projectionInput: { inventory },
    },
  }));

  await processProjectionBacklog({ limit: 1 });

  const projection = {
    ok: true,
    projected: inventory.length,
    reason: "queued_for_async_projection",
  };

  const contract = normalizeProjectionContract({
    planner: "storehouse",
    householdId: reqPayload.householdId || upsert.householdId,
    updateType: "inventory.upsert",
    projection,
    counts: { inventoryItems: inventory.length, outputItems: 0 },
    queue: {
      jobId: queued.id,
      status: queued.status,
      attempts: queued.attempts,
      accepted: true,
      durable: true,
    },
  });

  publishPlannerEvent(PlannerEvents.STOREHOUSE_INVENTORY_UPDATED, contract, {
    source: "PlannerProjectionSync.syncStorehouseUpdate",
  });
  publishPlannerEvent(PlannerEvents.PLANNER_RECOMMENDATIONS_UPDATED, contract, {
    source: "PlannerProjectionSync.syncStorehouseUpdate",
  });
  bridgeProjectionRealtimeEvent({
    eventType: "planner.storehouse.inventory.updated",
    contract,
  });

  return contract;
}

async function syncHomesteadUpdate({ payload = {}, saved = {}, snapshot = {} } = {}) {
  const outputs = Array.isArray(saved.projectedOutputs)
    ? saved.projectedOutputs
    : Array.isArray(payload.outputs)
      ? payload.outputs
    : Array.isArray(snapshot.outputs)
      ? snapshot.outputs
      : [];

  const queued =
    saved && saved.projectionQueue && typeof saved.projectionQueue === "object"
      ? saved.projectionQueue
      : await enqueueProjectionJob({
    householdId: saved.householdId || payload.householdId,
    planner: "homestead",
    updateType: "production.upsert",
    payload: {
      projectionInput: { outputs },
    },
      });

  await processProjectionBacklog({ limit: 1 });

  const contract = normalizeProjectionContract({
    planner: "homestead",
    householdId: saved.householdId || payload.householdId,
    updateType: "production.upsert",
    projection: {
      ok: true,
      projected: outputs.length,
      reason: "event_payload_normalized",
    },
    counts: { inventoryItems: 0, outputItems: outputs.length },
    queue: {
      jobId: queued.id,
      status: queued.status,
      attempts: queued.attempts,
      accepted: true,
      durable: true,
    },
  });

  publishPlannerEvent(PlannerEvents.HOMESTEAD_PRODUCTION_UPDATED, contract, {
    source: "PlannerProjectionSync.syncHomesteadUpdate",
  });
  publishPlannerEvent(PlannerEvents.PLANNER_RECOMMENDATIONS_UPDATED, contract, {
    source: "PlannerProjectionSync.syncHomesteadUpdate",
  });
  bridgeProjectionRealtimeEvent({
    eventType: "planner.homestead.production.updated",
    contract,
  });

  return contract;
}

async function syncMealPlannerFanoutContracts({
  mealPlanId = null,
  householdId = null,
  contracts = [],
  plannerGaps = {},
  storehouseIngest = {},
} = {}) {
  const safeContracts = Array.isArray(contracts) ? contracts : [];

  const contract = normalizeProjectionContract({
    planner: "meal",
    householdId: householdId || "default-household",
    updateType: "meal.fanout",
    projection: {
      ok: true,
      projected: safeContracts.length,
      reason: "meal_fanout_contracts_published",
    },
    counts: {
      inventoryItems: Number(storehouseIngest?.count || 0),
      outputItems: Number(plannerGaps?.summary?.hardGapCount || 0),
    },
    queue: {
      jobId: mealPlanId || null,
      status: "processed",
      attempts: 1,
      accepted: true,
      durable: true,
    },
  });

  publishPlannerEvent(PlannerEvents.PLANNER_RECOMMENDATIONS_UPDATED, contract, {
    source: "PlannerProjectionSync.syncMealPlannerFanoutContracts",
  });

  bridgeProjectionRealtimeEvent({
    eventType: "planner.recommendations.updated",
    contract,
  });

  return {
    ok: true,
    contract,
    processedContracts: safeContracts.length,
  };
}

module.exports = {
  ensureProjectionTables,
  processProjectionBacklog,
  getProjectionStatus,
  replayProjectionJobs,
  reconcileHouseholdProjection,
  startProjectionWorker,
  stopProjectionWorker,
  syncStorehouseUpdate,
  syncHomesteadUpdate,
  syncMealPlannerFanoutContracts,
};
