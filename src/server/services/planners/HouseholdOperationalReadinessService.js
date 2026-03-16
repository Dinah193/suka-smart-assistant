"use strict";

const { pgPool } = require("./PlannerIntegrationService");

async function resolveHouseholdUuidByKey(householdKey) {
  const key = String(householdKey || "").trim();
  if (!key) return null;

  const { rows } = await pgPool.query(
    `
      select id
      from households
      where household_key = $1
      limit 1
    `,
    [key]
  );

  return rows[0]?.id || null;
}

async function getMealPlanningReadiness(householdIdOrKey) {
  const resolvedId = await resolveHouseholdUuidByKey(householdIdOrKey);
  const householdId = resolvedId || String(householdIdOrKey || "");

  const { rows } = await pgPool.query(
    `
      select *
      from household_meal_readiness_v1
      where household_id::text = $1
      limit 1
    `,
    [householdId]
  );

  return rows[0] || {
    household_id: householdId,
    latest_meal_plan_at: null,
    total_meal_plans_30d: 0,
    saved_recipe_count: 0,
    ready_lots: 0,
    reserved_lots: 0,
  };
}

async function getStorehouseInventoryReadiness(householdIdOrKey) {
  const resolvedId = await resolveHouseholdUuidByKey(householdIdOrKey);
  const householdId = resolvedId || String(householdIdOrKey || "");

  const { rows } = await pgPool.query(
    `
      select *
      from household_storehouse_readiness_v1
      where household_id::text = $1
      limit 1
    `,
    [householdId]
  );

  return rows[0] || {
    household_id: householdId,
    in_stock_lots: 0,
    expiring_7d: 0,
    preserved_lots: 0,
    total_qty_in_stock: 0,
  };
}

async function getHomesteadProductionReadiness(householdIdOrKey) {
  const resolvedId = await resolveHouseholdUuidByKey(householdIdOrKey);
  const householdId = resolvedId || String(householdIdOrKey || "");

  const { rows } = await pgPool.query(
    `
      select *
      from household_homestead_schedule_readiness_v1
      where household_id::text = $1
      limit 1
    `,
    [householdId]
  );

  return rows[0] || {
    household_id: householdId,
    active_garden_plans: 0,
    active_animals: 0,
    upcoming_outputs_14d: 0,
    open_task_sessions: 0,
  };
}

async function searchSavedRecipes({ householdIdOrKey, query, limit = 25 }) {
  const resolvedId = await resolveHouseholdUuidByKey(householdIdOrKey);
  const householdId = resolvedId || String(householdIdOrKey || "");
  const safeLimit = Math.max(1, Number(limit || 25));
  const q = String(query || "").trim();

  const { rows } = await pgPool.query(
    `
      select id, recipe_ref, title, source, tags, notes, updated_at
      from saved_recipes
      where household_id::text = $1
        and archived = false
        and (
          $2 = ''
          or search_vector @@ plainto_tsquery('english', $2)
        )
      order by updated_at desc
      limit $3
    `,
    [householdId, q, safeLimit]
  );

  return rows;
}

module.exports = {
  getMealPlanningReadiness,
  getStorehouseInventoryReadiness,
  getHomesteadProductionReadiness,
  searchSavedRecipes,
};