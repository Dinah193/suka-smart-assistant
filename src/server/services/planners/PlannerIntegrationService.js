"use strict";

const { Pool } = require("pg");
const { randomUUID } = require("node:crypto");

let neo4j = null;
try {
  neo4j = require("neo4j-driver");
} catch {
  neo4j = null;
}

let mongoose = null;
try {
  mongoose = require("mongoose");
} catch {
  mongoose = null;
}

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/suka",
});

function toBool(value, fallback = false) {
  if (value == null) return !!fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return !!fallback;
}

function resolveNeo4jConfig() {
  const uri = String(process.env.NEO4J_URI || "").trim();
  const user = String(process.env.NEO4J_USER || "").trim();
  const password = String(process.env.NEO4J_PASSWORD || "").trim();
  const enabledByFlag = toBool(process.env.NEO4J_ENABLED, false);
  const enabledByConfig = !!(uri || user || password);
  const enabled = enabledByFlag || enabledByConfig;
  const required = toBool(process.env.NEO4J_REQUIRED, false);
  const configured = !!(uri && user && password);

  return {
    uri,
    user,
    password,
    enabled,
    required,
    configured,
  };
}

async function withPgTransaction(work) {
  const client = await pgPool.connect();
  try {
    await client.query("begin");
    const out = await work(client);
    await client.query("commit");
    return out;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // keep original error
    }
    throw error;
  } finally {
    client.release();
  }
}

async function enqueueProjectionJobInTransaction(client, { householdId, planner, updateType, payload }) {
  const id = randomUUID();
  const { rows } = await client.query(
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

async function enqueueOperationalOutboxEventInTransaction(
  client,
  {
    householdId,
    aggregateType,
    aggregateId,
    eventType,
    payload,
    eventMeta,
    updatedBy = "planner.integration",
    changeReason = "transactional_write",
  }
) {
  const id = randomUUID();
  const { rows } = await client.query(
    `
      insert into operational_outbox_events (
        id,
        household_id,
        aggregate_type,
        aggregate_id,
        event_type,
        payload,
        event_meta,
        status,
        available_at,
        updated_by,
        change_reason,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, 'pending', now(), $8, $9, now())
      returning id, status, available_at
    `,
    [
      id,
      householdId == null ? null : String(householdId),
      String(aggregateType || "unknown"),
      String(aggregateId || "unknown"),
      String(eventType || "unknown"),
      JSON.stringify(payload || {}),
      JSON.stringify(eventMeta || {}),
      String(updatedBy || "planner.integration"),
      String(changeReason || "transactional_write"),
    ]
  );

  return rows[0] || { id, status: "pending", available_at: new Date().toISOString() };
}

function createNeo4jDriver() {
  const cfg = resolveNeo4jConfig();
  if (!cfg.enabled) return null;
  if (!neo4j) return null;
  if (!cfg.configured) return null;
  return neo4j.driver(cfg.uri, neo4j.auth.basic(cfg.user, cfg.password));
}

const neo4jDriver = createNeo4jDriver();

async function verifyNeo4jIntegration({ required = null } = {}) {
  const cfg = resolveNeo4jConfig();
  const strictRequired = required == null ? cfg.required : !!required;
  const status = {
    enabled: cfg.enabled,
    required: strictRequired,
    configured: cfg.configured,
    driverLoaded: !!neo4j,
    connected: false,
    skipped: false,
    reason: null,
    error: null,
  };

  if (!cfg.enabled && !strictRequired) {
    status.skipped = true;
    status.reason = "neo4j_not_enabled";
    return { ok: true, ...status };
  }

  if (!cfg.configured) {
    status.error = "neo4j_config_incomplete";
    return { ok: !strictRequired, ...status };
  }

  if (!neo4j) {
    status.error = "neo4j_driver_missing";
    return { ok: !strictRequired, ...status };
  }

  if (!neo4jDriver) {
    status.error = "neo4j_driver_unavailable";
    return { ok: !strictRequired, ...status };
  }

  let session = null;
  try {
    session = neo4jDriver.session();
    await session.run("RETURN 1 AS ok");
    status.connected = true;
    return { ok: true, ...status };
  } catch (error) {
    status.error = String(error?.message || error || "neo4j_ping_failed");
    return { ok: !strictRequired, ...status };
  } finally {
    if (session) {
      await session.close().catch(() => {});
    }
  }
}

async function ensureMongoConnected() {
  if (!mongoose) return false;
  if (mongoose.connection.readyState === 1) return true;
  const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/suka";
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 2000 });
  return mongoose.connection.readyState === 1;
}

async function getMealPlannerSnapshot(householdId) {
  const { rows } = await pgPool.query(
    "select id, title, planner_output from meal_plans where household_id = $1 order by updated_at desc limit 1",
    [householdId]
  );
  return rows[0] || null;
}

async function queryOrFallback(queryText, params, fallbackRows = []) {
  try {
    const out = await pgPool.query(queryText, params);
    return { ok: true, rows: out.rows || [] };
  } catch (error) {
    return {
      ok: false,
      rows: fallbackRows,
      error: String(error?.message || error || "query_failed"),
      code: error?.code || null,
    };
  }
}

async function getStorehousePlannerSnapshot(householdId, { limit = 250 } = {}) {
  const safeLimit = Math.max(1, Number(limit || 250));

  const lots = await queryOrFallback(
    `
      select
        id,
        sku,
        item_name,
        qty,
        unit,
        state,
        method,
        reserved_qty,
        expires_at,
        metadata,
        'storehouse_lot' as source
      from storehouse_lots
      where household_id = $1
      order by updated_at desc
      limit $2
    `,
    [householdId, safeLimit],
    []
  );

  const preserved = await queryOrFallback(
    `
      select
        id,
        null::text as sku,
        item_name,
        qty,
        unit,
        'preserved'::text as state,
        method,
        0::numeric as reserved_qty,
        expires_at,
        metadata,
        'preservation_inventory' as source
      from preservation_inventory
      where household_id = $1
      order by created_at desc
      limit $2
    `,
    [householdId, safeLimit],
    []
  );

  const inventory = lots.rows.concat(preserved.rows).map((row) => ({
    id: row.id,
    sku: row.sku,
    itemName: row.item_name,
    qty: Number(row.qty || 0),
    unit: row.unit,
    state: row.state,
    method: row.method,
    reservedQty: Number(row.reserved_qty || 0),
    expiresAt: row.expires_at,
    metadata: row.metadata || {},
    source: row.source,
  }));

  const warnings = [];
  if (!lots.ok) warnings.push(`storehouse_lots_unavailable:${lots.code || "unknown"}`);
  if (!preserved.ok) warnings.push(`preservation_inventory_unavailable:${preserved.code || "unknown"}`);

  return {
    householdId,
    inventory,
    summary: {
      totalItems: inventory.length,
      preservedItems: inventory.filter((x) => x.state === "preserved").length,
      lowStockItems: inventory.filter((x) => x.qty > 0 && x.qty <= x.reservedQty).length,
    },
    warnings,
  };
}

async function getHomesteadPlannerSnapshot(householdId) {
  const plan = await queryOrFallback(
    `
      select
        id,
        season_key,
        garden_plan,
        orchard_plan,
        herb_spice_plan,
        animal_plan,
        updated_at
      from homestead_plans
      where household_id = $1
      order by updated_at desc
      limit 1
    `,
    [householdId],
    []
  );

  const currentPlan = plan.rows[0] || null;
  let outputs = [];
  if (currentPlan?.id) {
    const out = await queryOrFallback(
      `
        select
          id,
          output_type,
          output_name,
          qty,
          unit,
          expected_harvest_at,
          preservation_ready,
          metadata
        from homestead_outputs
        where homestead_plan_id = $1
        order by expected_harvest_at nulls last, output_name asc
      `,
      [currentPlan.id],
      []
    );
    outputs = out.rows || [];
  }

  const warnings = [];
  if (!plan.ok) warnings.push(`homestead_plans_unavailable:${plan.code || "unknown"}`);

  const gardenPlan = currentPlan?.garden_plan || {};
  const animalPlan = currentPlan?.animal_plan || {};
  const gardenTasks = Array.isArray(gardenPlan.tasks)
    ? gardenPlan.tasks
    : Array.isArray(gardenPlan.schedule)
      ? gardenPlan.schedule
      : [];

  const preservationReadyOutputs = outputs.filter((x) => x.preservation_ready);

  return {
    householdId,
    planId: currentPlan?.id || null,
    seasonKey: currentPlan?.season_key || null,
    gardenTasks,
    animalPlan,
    outputs: outputs.map((x) => ({
      id: x.id,
      outputType: x.output_type,
      outputName: x.output_name,
      qty: Number(x.qty || 0),
      unit: x.unit,
      expectedHarvestAt: x.expected_harvest_at,
      preservationReady: !!x.preservation_ready,
      metadata: x.metadata || {},
    })),
    preservationForecast: {
      totalOutputs: outputs.length,
      preservationReadyCount: preservationReadyOutputs.length,
      preservationReadyQty: preservationReadyOutputs.reduce(
        (sum, x) => sum + Number(x.qty || 0),
        0
      ),
    },
    warnings,
  };
}

async function upsertStorehouseInventory(payload = {}) {
  const householdId = String(payload.householdId || "default-household");
  const items = Array.isArray(payload.inventory)
    ? payload.inventory.filter((x) => x && typeof x === "object")
    : [];

  return withPgTransaction(async (client) => {
    const upsertedIds = [];
    const projectionInventory = [];
    for (const item of items) {
      const id = String(item.id || randomUUID());
      upsertedIds.push(id);

      const normalized = {
        id,
        sku: String(item.sku || "manual.sku"),
        itemName: String(item.itemName || item.name || "Unknown item"),
        qty: Number(item.qty || 0),
        unit: String(item.unit || "unit"),
        state: String(item.state || "raw"),
        method: item.method == null ? null : String(item.method),
        reservedQty: Number(item.reservedQty || 0),
        metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {},
      };
      projectionInventory.push(normalized);

      await client.query(
        `
        insert into storehouse_lots (
          id, household_id, sku, item_name, qty, unit, state, method, reserved_qty, metadata, updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now())
        on conflict (id) do update
          set household_id = excluded.household_id,
              sku = excluded.sku,
              item_name = excluded.item_name,
              qty = excluded.qty,
              unit = excluded.unit,
              state = excluded.state,
              method = excluded.method,
              reserved_qty = excluded.reserved_qty,
              metadata = excluded.metadata,
              updated_at = now()
        `,
        [
          id,
          householdId,
          normalized.sku,
          normalized.itemName,
          normalized.qty,
          normalized.unit,
          normalized.state,
          normalized.method,
          normalized.reservedQty,
          JSON.stringify(normalized.metadata),
        ]
      );
    }

    const queuedProjectionJob = await enqueueProjectionJobInTransaction(client, {
      householdId,
      planner: "storehouse",
      updateType: "inventory.upsert",
      payload: {
        projectionInput: {
          inventory: projectionInventory,
        },
      },
    });

    const queuedOutboxEvent = await enqueueOperationalOutboxEventInTransaction(client, {
      householdId,
      aggregateType: "storehouse_lots",
      aggregateId: String(householdId),
      eventType: "planner.storehouse.inventory.upserted",
      payload: {
        householdId,
        itemIds: upsertedIds,
        inventory: projectionInventory,
        projectionQueueJobId: queuedProjectionJob.id,
      },
      eventMeta: {
        source: "PlannerIntegrationService.upsertStorehouseInventory",
        projection: "planner_projection_jobs",
      },
      updatedBy: String(payload.updatedBy || "planner.integration"),
      changeReason: String(payload.changeReason || "storehouse_inventory_upsert"),
    });

    return {
      householdId,
      upserted: upsertedIds.length,
      itemIds: upsertedIds,
      projectedInventory: projectionInventory,
      projectionQueue: queuedProjectionJob,
      outboxEvent: queuedOutboxEvent,
    };
  });
}

async function upsertHomesteadPlan(payload = {}) {
  const householdId = String(payload.householdId || "default-household");
  const planId = String(payload.planId || payload.id || randomUUID());
  const seasonKey = String(payload.seasonKey || "unknown-season");
  const replaceOutputs = payload.replaceOutputs !== false;

  return withPgTransaction(async (client) => {
    await client.query(
      `
      insert into homestead_plans (
        id, household_id, season_key, garden_plan, orchard_plan, herb_spice_plan, animal_plan, updated_at
      )
      values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, now())
      on conflict (id) do update
        set household_id = excluded.household_id,
            season_key = excluded.season_key,
            garden_plan = excluded.garden_plan,
            orchard_plan = excluded.orchard_plan,
            herb_spice_plan = excluded.herb_spice_plan,
            animal_plan = excluded.animal_plan,
            updated_at = now()
      `,
      [
        planId,
        householdId,
        seasonKey,
        JSON.stringify(payload.gardenPlan || {}),
        JSON.stringify(payload.orchardPlan || {}),
        JSON.stringify(payload.herbSpicePlan || {}),
        JSON.stringify(payload.animalPlan || {}),
      ]
    );

    if (replaceOutputs) {
      await client.query("delete from homestead_outputs where homestead_plan_id = $1", [planId]);
    }

    const outputIds = [];
    const projectedOutputs = [];
    const outputs = Array.isArray(payload.outputs)
      ? payload.outputs.filter((x) => x && typeof x === "object")
      : [];

    for (const output of outputs) {
      const outputId = String(output.id || randomUUID());
      outputIds.push(outputId);

      const normalizedOutput = {
        id: outputId,
        outputType: String(output.outputType || "unknown"),
        outputName: String(output.outputName || "Unnamed output"),
        qty: Number(output.qty || 0),
        unit: String(output.unit || "unit"),
        expectedHarvestAt: output.expectedHarvestAt || null,
        preservationReady: !!output.preservationReady,
        metadata: output.metadata && typeof output.metadata === "object" ? output.metadata : {},
      };
      projectedOutputs.push(normalizedOutput);

      await client.query(
        `
        insert into homestead_outputs (
          id, homestead_plan_id, output_type, output_name, qty, unit, expected_harvest_at, preservation_ready, metadata
        )
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        on conflict (id) do update
          set homestead_plan_id = excluded.homestead_plan_id,
              output_type = excluded.output_type,
              output_name = excluded.output_name,
              qty = excluded.qty,
              unit = excluded.unit,
              expected_harvest_at = excluded.expected_harvest_at,
              preservation_ready = excluded.preservation_ready,
              metadata = excluded.metadata
        `,
        [
          outputId,
          planId,
          normalizedOutput.outputType,
          normalizedOutput.outputName,
          normalizedOutput.qty,
          normalizedOutput.unit,
          normalizedOutput.expectedHarvestAt,
          normalizedOutput.preservationReady,
          JSON.stringify(normalizedOutput.metadata),
        ]
      );
    }

    const queuedProjectionJob = await enqueueProjectionJobInTransaction(client, {
      householdId,
      planner: "homestead",
      updateType: "production.upsert",
      payload: {
        projectionInput: {
          outputs: projectedOutputs,
        },
      },
    });

    const queuedOutboxEvent = await enqueueOperationalOutboxEventInTransaction(client, {
      householdId,
      aggregateType: "homestead_plan",
      aggregateId: String(planId),
      eventType: "planner.homestead.plan.upserted",
      payload: {
        householdId,
        planId,
        seasonKey,
        outputIds,
        outputs: projectedOutputs,
        projectionQueueJobId: queuedProjectionJob.id,
      },
      eventMeta: {
        source: "PlannerIntegrationService.upsertHomesteadPlan",
        projection: "planner_projection_jobs",
      },
      updatedBy: String(payload.updatedBy || "planner.integration"),
      changeReason: String(payload.changeReason || "homestead_plan_upsert"),
    });

    return {
      householdId,
      planId,
      seasonKey,
      outputIds,
      upsertedOutputs: outputIds.length,
      projectedOutputs,
      projectionQueue: queuedProjectionJob,
      outboxEvent: queuedOutboxEvent,
    };
  });
}

async function saveMealPlannerOutput(payload = {}) {
  const id = payload.id || payload.mealPlanId;
  const householdId = payload.householdId;
  const userId = payload.userId || "system";

  return withPgTransaction(async (client) => {
    await client.query(
      `
      insert into meal_plans (id, household_id, user_id, title, start_date, end_date, planner_output, recommendation_score, updated_by, change_reason)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10)
      on conflict (id) do update
        set planner_output = excluded.planner_output,
            recommendation_score = excluded.recommendation_score,
            updated_by = excluded.updated_by,
            change_reason = excluded.change_reason,
            updated_at = now()
      `,
      [
        id,
        householdId,
        userId,
        payload.title || "Meal plan",
        payload.startDate || new Date().toISOString().slice(0, 10),
        payload.endDate || new Date().toISOString().slice(0, 10),
        JSON.stringify(payload.plannerOutput || {}),
        JSON.stringify(payload.recommendationScore || {}),
        String(payload.updatedBy || userId),
        String(payload.changeReason || "meal_plan_save"),
      ]
    );

    const outboxEvent = await enqueueOperationalOutboxEventInTransaction(client, {
      householdId,
      aggregateType: "meal_plan",
      aggregateId: String(id),
      eventType: "planner.meal.plan.saved",
      payload: {
        id,
        householdId,
        userId,
      },
      eventMeta: {
        source: "PlannerIntegrationService.saveMealPlannerOutput",
      },
      updatedBy: String(payload.updatedBy || userId),
      changeReason: String(payload.changeReason || "meal_plan_save"),
    });

    return { ok: true, id, outboxEvent };
  });
}

async function persistMealPlannerFanoutContracts({
  mealPlanId,
  householdId,
  contracts = [],
  updatedBy = "mealplanner:backendOrchestration",
  changeReason = "meal_plan_fanout",
} = {}) {
  const safeContracts = Array.isArray(contracts)
    ? contracts.filter((item) => item && typeof item === "object" && item.eventType)
    : [];

  if (!safeContracts.length) {
    return { queuedCount: 0, queuedContracts: [] };
  }

  return withPgTransaction(async (client) => {
    const queuedContracts = [];
    for (const item of safeContracts) {
      const eventType = String(item.eventType || "planner.contract.unknown");
      const contract = item.contract && typeof item.contract === "object" ? item.contract : {};
      const queuedOutboxEvent = await enqueueOperationalOutboxEventInTransaction(client, {
        householdId,
        aggregateType: "meal_plan_fanout",
        aggregateId: String(mealPlanId || "unknown"),
        eventType,
        payload: {
          mealPlanId: String(mealPlanId || ""),
          householdId: String(householdId || ""),
          contract,
        },
        eventMeta: {
          source: "PlannerIntegrationService.persistMealPlannerFanoutContracts",
          contractVersion: contract.contractVersion || null,
        },
        updatedBy: String(updatedBy || "mealplanner:backendOrchestration"),
        changeReason: String(changeReason || "meal_plan_fanout"),
      });

      queuedContracts.push({
        eventType,
        id: queuedOutboxEvent.id,
        status: queuedOutboxEvent.status,
      });
    }

    return {
      queuedCount: queuedContracts.length,
      queuedContracts,
    };
  });
}

async function projectInventoryToNeo4j({ householdId, inventory = [] }) {
  if (!neo4jDriver) return { ok: false, reason: "neo4j_driver_missing" };
  const session = neo4jDriver.session();
  try {
    await session.writeTransaction((tx) =>
      tx.run(
        `
        MERGE (h:Household {id: $householdId})
        WITH h
        UNWIND $inventory AS item
        MERGE (l:Lot {id: item.id})
        SET l.name = item.itemName,
            l.qty = item.qty,
            l.unit = item.unit,
            l.state = item.state,
            l.method = item.method
        MERGE (h)-[:OWNS]->(l)
        `,
        { householdId, inventory }
      )
    );
    return { ok: true, projected: inventory.length };
  } finally {
    await session.close();
  }
}

async function projectHomesteadOutputsToNeo4j({
  householdId,
  planId = null,
  seasonKey = null,
  outputs = [],
}) {
  if (!neo4jDriver) return { ok: false, reason: "neo4j_driver_missing" };

  const normalizedOutputs = Array.isArray(outputs)
    ? outputs
        .filter((x) => x && typeof x === "object")
        .map((x) => ({
          id: String(x.id || randomUUID()),
          outputType: String(x.outputType || "unknown"),
          outputName: String(x.outputName || "Unnamed output"),
          qty: Number(x.qty || 0),
          unit: String(x.unit || "unit"),
          expectedHarvestAt: x.expectedHarvestAt || null,
          preservationReady: !!x.preservationReady,
          metadataJson: JSON.stringify(
            x.metadata && typeof x.metadata === "object" ? x.metadata : {}
          ),
        }))
    : [];

  const session = neo4jDriver.session();
  try {
    await session.writeTransaction((tx) =>
      tx.run(
        `
          MERGE (h:Household {id: $householdId})
          MERGE (p:HomesteadPlan {id: $planId})
          SET p.seasonKey = $seasonKey,
              p.updatedAt = datetime()
          MERGE (h)-[:HAS_HOMESTEAD_PLAN]->(p)
          WITH h, p
          UNWIND $outputs AS output
          MERGE (o:HomesteadOutput {id: output.id})
          SET o.outputType = output.outputType,
              o.outputName = output.outputName,
              o.qty = output.qty,
              o.unit = output.unit,
              o.expectedHarvestAt = output.expectedHarvestAt,
              o.preservationReady = output.preservationReady,
              o.metadataJson = output.metadataJson,
              o.updatedAt = datetime()
          MERGE (p)-[:PRODUCES]->(o)
        `,
        {
          householdId: String(householdId || "default-household"),
          planId: String(planId || `homestead-plan-${householdId || "default-household"}`),
          seasonKey: seasonKey == null ? null : String(seasonKey),
          outputs: normalizedOutputs,
        }
      )
    );

    return {
      ok: true,
      projected: normalizedOutputs.length,
      reason: "homestead_projected",
    };
  } finally {
    await session.close();
  }
}

module.exports = {
  pgPool,
  neo4jDriver,
  verifyNeo4jIntegration,
  ensureMongoConnected,
  getMealPlannerSnapshot,
  getStorehousePlannerSnapshot,
  getHomesteadPlannerSnapshot,
  upsertStorehouseInventory,
  upsertHomesteadPlan,
  saveMealPlannerOutput,
  persistMealPlannerFanoutContracts,
  projectInventoryToNeo4j,
  projectHomesteadOutputsToNeo4j,
};
