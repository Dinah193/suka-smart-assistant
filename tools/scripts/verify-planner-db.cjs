"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const {
  bootstrapPlannerTables,
} = require("../../src/server/services/planners/PlannerSchemaBootstrap");

function loadWorkspaceEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    if (!key || process.env[key] != null) continue;
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function resolveConnectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = process.env.PGHOST;
  const port = process.env.PGPORT || "5432";
  const user = process.env.PGUSER;
  const pass = process.env.PGPASSWORD;
  const db = process.env.PGDATABASE;

  if (host && user && pass && db) {
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
  }

  return "";
}

function flattenPlanNodes(node, out = []) {
  if (!node || typeof node !== "object") return out;
  out.push(node);

  const plans = Array.isArray(node.Plans) ? node.Plans : [];
  for (const child of plans) {
    flattenPlanNodes(child, out);
  }

  return out;
}

function resolveSeqScanRowThreshold() {
  const raw = Number(process.env.DB_VERIFY_SEQ_SCAN_ROW_THRESHOLD || 10000);
  if (!Number.isFinite(raw) || raw < 0) return 10000;
  return Math.floor(raw);
}

function resolveIndexMissRowThreshold() {
  const raw = Number(process.env.DB_VERIFY_INDEX_MISS_ROW_THRESHOLD || 25000);
  if (!Number.isFinite(raw) || raw < 0) return 25000;
  return Math.floor(raw);
}

function parseNameList(value) {
  return String(value || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function resolvePolicyFilterConfig() {
  const allowlist = parseNameList(process.env.DB_VERIFY_POLICY_ALLOWLIST);
  const denylist = parseNameList(process.env.DB_VERIFY_POLICY_DENYLIST);
  return {
    allowlist,
    denylist,
    allowset: new Set(allowlist),
    denyset: new Set(denylist),
  };
}

function isPolicyEnforcedForCheck(checkName, filterConfig) {
  if (filterConfig.denyset.has(checkName)) return false;
  if (filterConfig.allowset.size > 0) return filterConfig.allowset.has(checkName);
  return true;
}

async function getTableRowEstimates(client, tableNames = []) {
  const names = [...new Set((tableNames || []).map((x) => String(x || "").trim()).filter(Boolean))];
  if (!names.length) return {};

  const { rows } = await client.query(
    `
      select
        c.relname as table_name,
        greatest(
          coalesce(s.n_live_tup, 0)::bigint,
          coalesce(c.reltuples, 0)::bigint
        ) as row_estimate
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_user_tables s
        on s.schemaname = n.nspname
       and s.relname = c.relname
      where n.nspname = 'public'
        and c.relkind = 'r'
        and c.relname = any($1::text[])
    `,
    [names]
  );

  const out = {};
  for (const row of rows) {
    out[row.table_name] = Number(row.row_estimate || 0);
  }

  return out;
}

function buildExplainChecks() {
  return [
    {
      name: "meal_plans_latest_by_household",
      query:
        "select id, title, planner_output from meal_plans where household_id = $1 order by updated_at desc limit 1",
      params: ["verify-household"],
      expectedIndexHints: ["idx_meal_plans_household_updated_at"],
    },
    {
      name: "storehouse_lots_household_recent",
      query:
        "select id, sku, item_name, qty, unit, state, method, reserved_qty, expires_at, metadata from storehouse_lots where household_id = $1 order by updated_at desc limit $2",
      params: ["verify-household", 250],
      expectedIndexHints: ["idx_storehouse_lots_household_updated_at"],
    },
    {
      name: "preservation_inventory_household_recent",
      query:
        "select id, item_name, qty, unit, method, expires_at, metadata from preservation_inventory where household_id = $1 order by created_at desc limit $2",
      params: ["verify-household", 250],
      expectedIndexHints: ["idx_preservation_inventory_household_created_at"],
    },
    {
      name: "homestead_plans_latest_by_household",
      query:
        "select id, season_key, garden_plan, orchard_plan, herb_spice_plan, animal_plan, updated_at from homestead_plans where household_id = $1 order by updated_at desc limit 1",
      params: ["verify-household"],
      expectedIndexHints: ["idx_homestead_plans_household_updated_at"],
    },
    {
      name: "homestead_outputs_for_plan",
      query:
        "select id, output_type, output_name, qty, unit, expected_harvest_at, preservation_ready, metadata from homestead_outputs where homestead_plan_id = $1 order by expected_harvest_at nulls last, output_name asc",
      params: ["00000000-0000-0000-0000-000000000000"],
      expectedIndexHints: ["idx_homestead_outputs_plan_harvest_name"],
    },
    {
      name: "projection_jobs_claim_candidate",
      query:
        "select id from planner_projection_jobs where status in ('queued', 'retry') and next_attempt_at <= now() order by created_at asc limit 1",
      params: [],
      expectedIndexHints: ["idx_projection_jobs_status_next_attempt"],
    },
    {
      name: "projection_jobs_replay_pick",
      query:
        "select id from planner_projection_jobs where status in ('retry', 'dead_letter') and household_id = $1 and planner = $2 order by updated_at asc limit $3",
      params: ["verify-household", "storehouse", 50],
      expectedIndexHints: ["idx_projection_jobs_household_planner_status_updated_at"],
    },
  ];
}

async function runExplainChecks(client, checks) {
  const out = [];
  const seqScanThreshold = resolveSeqScanRowThreshold();
  const indexMissThreshold = resolveIndexMissRowThreshold();
  const filterConfig = resolvePolicyFilterConfig();

  for (const check of checks) {
    const explainSql = `explain (format json, costs true, verbose false) ${check.query}`;
    const startedAt = Date.now();
    const res = await client.query(explainSql, check.params || []);
    const elapsedMs = Date.now() - startedAt;

    const explainJson = res.rows?.[0]?.["QUERY PLAN"]?.[0] || null;
    const root = explainJson?.Plan || null;
    const nodes = flattenPlanNodes(root, []);

    const nodeTypes = [...new Set(nodes.map((n) => n["Node Type"]).filter(Boolean))];
    const relationNames = [...new Set(nodes.map((n) => n["Relation Name"]).filter(Boolean))];
    const indexNames = [...new Set(nodes.map((n) => n["Index Name"]).filter(Boolean))];
    const seqScanRelations = [
      ...new Set(
        nodes
          .filter((n) => n["Node Type"] === "Seq Scan")
          .map((n) => n["Relation Name"])
          .filter(Boolean)
      ),
    ];
    const rowEstimates = await getTableRowEstimates(
      client,
      [...new Set([...seqScanRelations, ...relationNames])]
    );
    const policyEnforced = isPolicyEnforcedForCheck(check.name, filterConfig);

    const seqScanTables = seqScanRelations.map((table) => {
      const rowEstimate = Number(rowEstimates[table] || 0);
      return {
        table,
        rowEstimate,
        threshold: seqScanThreshold,
        violatesPolicy: rowEstimate >= seqScanThreshold,
      };
    });

    const warnings = [];
    if (nodeTypes.includes("Seq Scan")) {
      warnings.push("plan_contains_seq_scan");
    }

    const expectedHints = Array.isArray(check.expectedIndexHints) ? check.expectedIndexHints : [];
    const matchedHint = expectedHints.some((hint) =>
      indexNames.some((name) => String(name).toLowerCase().includes(String(hint).toLowerCase()))
    );

    if (expectedHints.length > 0 && !matchedHint) {
      warnings.push("expected_index_not_observed");
    }

    const indexMissTables = relationNames.map((table) => {
      const rowEstimate = Number(rowEstimates[table] || 0);
      return {
        table,
        rowEstimate,
        threshold: indexMissThreshold,
        violatesPolicy: rowEstimate >= indexMissThreshold,
      };
    });

    const policyViolations = [];
    if (policyEnforced) {
      policyViolations.push(
        ...seqScanTables
          .filter((x) => x.violatesPolicy)
          .map((x) => ({
            code: "seq_scan_over_threshold",
            table: x.table,
            rowEstimate: x.rowEstimate,
            threshold: x.threshold,
          }))
      );

      if (expectedHints.length > 0 && !matchedHint) {
        policyViolations.push(
          ...indexMissTables
            .filter((x) => x.violatesPolicy)
            .map((x) => ({
              code: "expected_index_not_observed_over_threshold",
              table: x.table,
              rowEstimate: x.rowEstimate,
              threshold: x.threshold,
              expectedIndexHints: expectedHints,
            }))
        );
      }
    }

    out.push({
      name: check.name,
      policyEnforced,
      elapsedMs,
      nodeTypes,
      relationNames,
      indexNames,
      seqScanTables,
      indexMissTables,
      policyViolations,
      warnings,
      expectedIndexHints: expectedHints,
      query: check.query,
    });
  }

  return out;
}

async function main() {
  loadWorkspaceEnv();
  const connectionString = resolveConnectionString();

  if (!connectionString) {
    console.error(
      "[db:verify] Missing DB connection. Set DATABASE_URL or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE, or add them to .env"
    );
    process.exit(1);
  }

  process.env.DATABASE_URL = connectionString;

  const bootstrap = await bootstrapPlannerTables(connectionString);
  if (!bootstrap.ok) {
    console.error(
      "[db:verify] Bootstrap table check failed. Missing:",
      bootstrap.tableCheck?.missing?.join(", ") || "unknown"
    );
    process.exit(1);
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const checks = buildExplainChecks();
    const plans = await runExplainChecks(client, checks);
    const warningCount = plans.reduce((sum, plan) => sum + plan.warnings.length, 0);
    const violations = plans.flatMap((plan) =>
      (Array.isArray(plan.policyViolations) ? plan.policyViolations : []).map((violation) => ({
        check: plan.name,
        ...violation,
      }))
    );

    const result = {
      ok: violations.length === 0,
      bootstrap: {
        ok: bootstrap.ok,
        files: bootstrap.files,
        tableCheck: bootstrap.tableCheck,
      },
      policy: {
        seqScanRowThreshold: resolveSeqScanRowThreshold(),
        indexMissRowThreshold: resolveIndexMissRowThreshold(),
        allowlist: resolvePolicyFilterConfig().allowlist,
        denylist: resolvePolicyFilterConfig().denylist,
        enforcedChecks: plans.filter((x) => x.policyEnforced).map((x) => x.name),
        skippedChecks: plans.filter((x) => !x.policyEnforced).map((x) => x.name),
        violations: violations.length,
        items: violations,
      },
      explain: {
        checks: plans.length,
        warnings: warningCount,
        plans,
      },
    };

    console.log(JSON.stringify(result));
    if (!result.ok) {
      console.error(
        `[db:verify] Policy failed: ${violations.length} seq scan violation(s) at/above row threshold ${result.policy.seqScanRowThreshold}`
      );
      process.exit(1);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[db:verify] Failed:", String(error?.message || error));
  process.exit(1);
});
