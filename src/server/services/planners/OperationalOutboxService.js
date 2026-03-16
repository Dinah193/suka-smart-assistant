"use strict";

const { pgPool } = require("./PlannerIntegrationService");

const MAX_ATTEMPTS = Number(process.env.OPERATIONAL_OUTBOX_MAX_ATTEMPTS || 10);
const DEFAULT_LEASE_MS = Number(process.env.OPERATIONAL_OUTBOX_LEASE_MS || 15000);

async function claimOutboxBatch({
  limit = 50,
  householdId = null,
  workerId = "manual-claim",
  leaseMs = DEFAULT_LEASE_MS,
  updatedBy = "operational.api",
  changeReason = "manual_claim",
} = {}) {
  const safeLimit = Math.max(1, Number(limit || 50));
  const safeLeaseMs = Math.max(1000, Number(leaseMs || DEFAULT_LEASE_MS));
  const filterByHousehold = householdId != null && String(householdId).trim() !== "";
  const { rows } = await pgPool.query(
    `
      with picked as (
        select id
        from operational_outbox_events
        where (
          (status in ('pending', 'retry') and available_at <= now())
          or (status = 'processing' and lease_expires_at is not null and lease_expires_at <= now())
        )
          and attempts < $1
          and ($5::boolean = false or household_id = $6)
        order by created_at asc
        limit $2
        for update skip locked
      )
      update operational_outbox_events o
      set
        status = 'processing',
        updated_at = now(),
        attempts = attempts + 1,
        processor_id = $3,
        lease_expires_at = now() + ($4::int * interval '1 millisecond'),
        last_heartbeat_at = now(),
        updated_by = $7,
        change_reason = $8
      from picked
      where o.id = picked.id
      returning o.*
    `,
    [
      MAX_ATTEMPTS,
      safeLimit,
      String(workerId || "manual-claim"),
      safeLeaseMs,
      filterByHousehold,
      filterByHousehold ? String(householdId) : null,
      String(updatedBy || "operational.api"),
      String(changeReason || "manual_claim"),
    ]
  );

  return rows;
}

async function heartbeatOutboxLeases({
  workerId,
  ids = [],
  leaseMs = DEFAULT_LEASE_MS,
  updatedBy = "outbox.worker",
  changeReason = "lease_heartbeat",
} = {}) {
  const safeWorkerId = String(workerId || "").trim();
  if (!safeWorkerId) return [];

  const safeLeaseMs = Math.max(1000, Number(leaseMs || DEFAULT_LEASE_MS));
  const scopedIds = Array.isArray(ids) ? ids.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const filterByIds = scopedIds.length > 0;

  const { rows } = await pgPool.query(
    `
      update operational_outbox_events
      set
        lease_expires_at = now() + ($2::int * interval '1 millisecond'),
        last_heartbeat_at = now(),
        updated_at = now(),
        updated_by = $3,
        change_reason = $4
      where status = 'processing'
        and processor_id = $1
        and ($5::boolean = false or id = any($6::uuid[]))
      returning id, lease_expires_at, last_heartbeat_at
    `,
    [
      safeWorkerId,
      safeLeaseMs,
      String(updatedBy || "outbox.worker"),
      String(changeReason || "lease_heartbeat"),
      filterByIds,
      filterByIds ? scopedIds : null,
    ]
  );

  return rows;
}

async function getOutboxEventById(id) {
  const { rows } = await pgPool.query(
    `
      select *
      from operational_outbox_events
      where id = $1
      limit 1
    `,
    [String(id)]
  );

  return rows[0] || null;
}

async function markOutboxProcessed(id, { updatedBy = "outbox.worker", changeReason = "projection_processed" } = {}) {
  const { rows } = await pgPool.query(
    `
      update operational_outbox_events
      set
        status = 'processed',
        processed_at = now(),
        processor_id = null,
        lease_expires_at = null,
        last_heartbeat_at = null,
        updated_at = now(),
        updated_by = $2,
        change_reason = $3
      where id = $1
      returning id, status, processed_at
    `,
    [String(id), String(updatedBy), String(changeReason)]
  );

  return rows[0] || null;
}

async function markOutboxRetry(
  id,
  {
    delayMs = 5000,
    error = null,
    updatedBy = "outbox.worker",
    changeReason = "projection_retry",
  } = {}
) {
  const nextAvailableAt = new Date(Date.now() + Math.max(0, Number(delayMs || 0))).toISOString();
  const { rows } = await pgPool.query(
    `
      update operational_outbox_events
      set
        status = 'retry',
        available_at = $2::timestamptz,
        event_meta = coalesce(event_meta, '{}'::jsonb) || jsonb_build_object('last_error', $3::text, 'last_retry_at', now()),
        processor_id = null,
        lease_expires_at = null,
        last_heartbeat_at = null,
        updated_at = now(),
        updated_by = $4,
        change_reason = $5
      where id = $1
      returning id, status, available_at
    `,
    [String(id), nextAvailableAt, String(error || "retry_requested"), String(updatedBy), String(changeReason)]
  );

  return rows[0] || null;
}

async function markOutboxDeadLetter(
  id,
  {
    reason = null,
    updatedBy = "outbox.worker",
    changeReason = "projection_dead_letter",
  } = {}
) {
  const { rows } = await pgPool.query(
    `
      update operational_outbox_events
      set
        status = 'dead_letter',
        dead_letter_reason = $2,
        dead_lettered_at = now(),
        processor_id = null,
        lease_expires_at = null,
        last_heartbeat_at = null,
        updated_at = now(),
        updated_by = $3,
        change_reason = $4
      where id = $1
      returning id, status, dead_letter_reason, dead_lettered_at
    `,
    [
      String(id),
      String(reason || "max_attempts_reached"),
      String(updatedBy || "outbox.worker"),
      String(changeReason || "projection_dead_letter"),
    ]
  );

  return rows[0] || null;
}

async function replayDeadLetter({
  householdId = null,
  eventType = null,
  limit = 100,
  updatedBy = "operational.api",
  changeReason = "dead_letter_replay",
} = {}) {
  const safeLimit = Math.max(1, Number(limit || 100));
  const hh = String(householdId || "").trim();
  const et = String(eventType || "").trim();
  const hasHousehold = hh !== "";
  const hasEventType = et !== "";

  const { rows } = await pgPool.query(
    `
      with picked as (
        select id
        from operational_outbox_events
        where status = 'dead_letter'
          and ($1::boolean = false or household_id = $2)
          and ($3::boolean = false or event_type = $4)
        order by dead_lettered_at asc nulls last, created_at asc
        limit $5
        for update skip locked
      )
      update operational_outbox_events o
      set
        status = 'pending',
        available_at = now(),
        attempts = 0,
        dead_letter_reason = null,
        dead_lettered_at = null,
        processor_id = null,
        lease_expires_at = null,
        last_heartbeat_at = null,
        updated_at = now(),
        updated_by = $6,
        change_reason = $7
      from picked
      where o.id = picked.id
      returning o.id, o.status, o.available_at
    `,
    [
      hasHousehold,
      hasHousehold ? hh : null,
      hasEventType,
      hasEventType ? et : null,
      safeLimit,
      String(updatedBy || "operational.api"),
      String(changeReason || "dead_letter_replay"),
    ]
  );

  return rows;
}

async function getDeadLetterSummary({ householdId = null } = {}) {
  const hh = String(householdId || "").trim();
  const filterByHousehold = hh !== "";

  const { rows } = await pgPool.query(
    `
      select coalesce(dead_letter_reason, 'unknown') as reason, count(*)::int as count
      from operational_outbox_events
      where status = 'dead_letter'
        and ($1::boolean = false or household_id = $2)
      group by coalesce(dead_letter_reason, 'unknown')
      order by count(*) desc, reason asc
    `,
    [filterByHousehold, filterByHousehold ? hh : null]
  );

  return rows;
}

async function getOutboxStatus({ householdId = null } = {}) {
  const filterByHousehold = householdId != null && String(householdId).trim() !== "";
  const { rows } = await pgPool.query(
    `
      select status, count(*)::int as count
      from operational_outbox_events
      where ($1::boolean = false or household_id = $2)
      group by status
    `,
    [filterByHousehold, filterByHousehold ? String(householdId) : null]
  );

  const summary = rows.reduce((acc, row) => {
    acc[row.status] = Number(row.count || 0);
    return acc;
  }, {});

  return {
    ok: true,
    summary: {
      pending: Number(summary.pending || 0),
      retry: Number(summary.retry || 0),
      processing: Number(summary.processing || 0),
      processed: Number(summary.processed || 0),
      deadLetter: Number(summary.dead_letter || 0),
      total:
        Number(summary.pending || 0) +
        Number(summary.retry || 0) +
        Number(summary.processing || 0) +
        Number(summary.processed || 0) +
        Number(summary.dead_letter || 0),
    },
  };
}

async function getOutboxHealthSignals({ householdId = null } = {}) {
  const hh = String(householdId || "").trim();
  const filterByHousehold = hh !== "";

  const { rows } = await pgPool.query(
    `
      select
        coalesce(max(extract(epoch from (now() - available_at)) * 1000)
          filter (where status in ('pending', 'retry') and available_at <= now()), 0)::bigint
          as oldest_pending_age_ms,
        coalesce(count(*) filter (where status = 'processing' and lease_expires_at is not null and lease_expires_at <= now()), 0)::int
          as stale_processing_count,
        coalesce(max(extract(epoch from (now() - last_heartbeat_at)) * 1000)
          filter (where status = 'processing' and last_heartbeat_at is not null), 0)::bigint
          as max_processing_heartbeat_age_ms,
        coalesce(count(*) filter (where status = 'retry'), 0)::int as retry_backlog,
        coalesce(count(*) filter (where status = 'dead_letter'), 0)::int as dead_letter_count
      from operational_outbox_events
      where ($1::boolean = false or household_id = $2)
    `,
    [filterByHousehold, filterByHousehold ? hh : null]
  );

  const row = rows[0] || {};
  return {
    ok: true,
    oldestPendingAgeMs: Number(row.oldest_pending_age_ms || 0),
    staleProcessingCount: Number(row.stale_processing_count || 0),
    maxProcessingHeartbeatAgeMs: Number(row.max_processing_heartbeat_age_ms || 0),
    retryBacklog: Number(row.retry_backlog || 0),
    deadLetterCount: Number(row.dead_letter_count || 0),
  };
}

module.exports = {
  claimOutboxBatch,
  heartbeatOutboxLeases,
  getOutboxEventById,
  markOutboxProcessed,
  markOutboxRetry,
  markOutboxDeadLetter,
  replayDeadLetter,
  getDeadLetterSummary,
  getOutboxHealthSignals,
  getOutboxStatus,
};