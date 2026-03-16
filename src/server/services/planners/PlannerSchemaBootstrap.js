"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const REQUIRED_TABLES = [
  "meal_plans",
  "meal_plan_items",
  "storehouse_lots",
  "preservation_batches",
  "preservation_inventory",
  "planner_audit_history",
  "homestead_plans",
  "homestead_outputs",
  "planner_projection_jobs",
  "ssa_users",
  "households",
  "household_memberships",
  "saved_recipes",
  "garden_plans",
  "animal_records",
  "task_sessions",
  "task_session_events",
  "planner_outputs",
  "operational_change_history",
  "operational_outbox_events",
  "operational_outbox_observability_config",
];

function schemaFiles() {
  const root = path.resolve(__dirname, "../../../services/db");
  const preferredOrder = [
    "mealplanner.schema.sql",
    "storehouse.schema.sql",
    "preservation.schema.sql",
    "homestead.schema.sql",
    "operational.schema.sql",
    "operational.outbox.hardening.sql",
  ];

  const out = [];
  for (const name of preferredOrder) {
    const filePath = path.join(root, name);
    if (fs.existsSync(filePath)) out.push(filePath);
  }

  return out;
}

async function assertPlannerTablesPresent(client) {
  const { rows } = await client.query(
    `
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name = any($1::text[])
    `,
    [REQUIRED_TABLES]
  );

  const present = new Set(rows.map((row) => row.table_name));
  const missing = REQUIRED_TABLES.filter((name) => !present.has(name));

  return {
    required: [...REQUIRED_TABLES],
    found: [...present],
    missing,
    ok: missing.length === 0,
  };
}

async function bootstrapPlannerTables(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();

  try {
    const files = schemaFiles();
    for (const filePath of files) {
      const sql = fs.readFileSync(filePath, "utf8");
      await client.query(sql);
    }

    const tableCheck = await assertPlannerTablesPresent(client);
    return {
      ok: tableCheck.ok,
      files,
      tableCheck,
    };
  } finally {
    await client.end();
  }
}

module.exports = {
  REQUIRED_TABLES,
  bootstrapPlannerTables,
  assertPlannerTablesPresent,
};
