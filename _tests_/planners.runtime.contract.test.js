import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Client } from "pg";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");
const bootstrapCheckEntry = path.resolve(
  repoRoot,
  "tools/scripts/check-planner-db-bootstrap.cjs"
);
const runtimeFlag = String(process.env.SSA_ENABLE_RUNTIME_CONTRACT_TESTS || "").toLowerCase();
const runtimeEnabled = runtimeFlag === "1" || runtimeFlag === "true" || runtimeFlag === "yes";
const runtimeDescribe = runtimeEnabled ? describe : describe.skip;
const dbRuntimeFlag = String(process.env.SSA_ENABLE_DB_RUNTIME_CONTRACT_TESTS || "").toLowerCase();
const dbRuntimeEnabled = dbRuntimeFlag === "1" || dbRuntimeFlag === "true" || dbRuntimeFlag === "yes";
const runtimeDbDescribe = runtimeEnabled && dbRuntimeEnabled ? describe : describe.skip;

function randomPort() {
  return 4700 + Math.floor(Math.random() * 250);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // retry until timeout
    }
    await sleep(150);
  }
  throw new Error("health_timeout");
}

async function waitForRoute(url, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // retry until timeout
    }
    await sleep(150);
  }
  throw new Error("route_timeout");
}

async function waitForCondition(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error("condition_timeout");
}

async function startWebhookSink() {
  const deliveries = [];
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 404;
      res.end("not-found");
      return;
    }

    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      try {
        deliveries.push(JSON.parse(raw || "{}"));
      } catch {
        deliveries.push({ raw });
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    });
  });

  const address = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address());
    });
  });

  const port = Number(address?.port || 0);
  return {
    server,
    deliveries,
    url: `http://127.0.0.1:${port}`,
    async stop() {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function startServer(extraEnv = {}) {
  const port = randomPort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      STRICT_STARTUP_ENV: "false",
      MONGO_SERVER_SELECTION_TIMEOUT_MS: "100",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return { child, port };
}

async function stopServer(child) {
  if (!child || child.killed) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, 2500);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

async function ensurePlannerTables(client) {
  await client.query(`
    create table if not exists storehouse_lots (
      id uuid primary key,
      household_id text not null,
      sku text not null,
      item_name text not null,
      qty numeric(12,2) not null default 0,
      unit text not null,
      state text not null default 'raw',
      method text,
      reserved_qty numeric(12,2) not null default 0,
      expires_at timestamptz,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);

  await client.query(`
    create table if not exists preservation_inventory (
      id uuid primary key,
      household_id text not null,
      batch_id uuid,
      item_name text not null,
      qty numeric(12,2) not null default 0,
      unit text not null,
      method text not null,
      shelf_life_days int,
      available_from timestamptz,
      expires_at timestamptz,
      collaboration_ready boolean not null default false,
      metadata jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    )
  `);

  await client.query(`
    create table if not exists homestead_plans (
      id uuid primary key,
      household_id text not null,
      season_key text not null,
      garden_plan jsonb not null default '{}'::jsonb,
      orchard_plan jsonb not null default '{}'::jsonb,
      herb_spice_plan jsonb not null default '{}'::jsonb,
      animal_plan jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);

  await client.query(`
    create table if not exists homestead_outputs (
      id uuid primary key,
      homestead_plan_id uuid not null,
      output_type text not null,
      output_name text not null,
      qty numeric(12,2) not null default 0,
      unit text not null,
      expected_harvest_at timestamptz,
      preservation_ready boolean not null default false,
      metadata jsonb not null default '{}'::jsonb
    )
  `);
}

async function seedPlannerDb(connectionString, householdId) {
  const client = new Client({ connectionString });
  await client.connect();

  const ids = {
    lotId: randomUUID(),
    preservedId: randomUUID(),
    planId: randomUUID(),
    outputId: randomUUID(),
    mutationLotId: null,
    mutationPlanId: null,
    mutationOutputId: null,
  };

  try {
    await ensurePlannerTables(client);

    await client.query(
      `
      insert into storehouse_lots (id, household_id, sku, item_name, qty, unit, state, method, reserved_qty, metadata)
      values ($1, $2, 'seed.sku.beans', 'Beans', 4, 'jar', 'raw', null, 1, '{"seed":"contract"}'::jsonb)
      `,
      [ids.lotId, householdId]
    );

    await client.query(
      `
      insert into preservation_inventory (id, household_id, item_name, qty, unit, method, metadata)
      values ($1, $2, 'Tomato Sauce', 2, 'jar', 'canning', '{"seed":"contract"}'::jsonb)
      `,
      [ids.preservedId, householdId]
    );

    await client.query(
      `
      insert into homestead_plans (id, household_id, season_key, garden_plan, orchard_plan, herb_spice_plan, animal_plan)
      values (
        $1,
        $2,
        '2026-spring',
        '{"tasks":[{"id":"task-seed","title":"Seed tomatoes"}]}'::jsonb,
        '{}'::jsonb,
        '{}'::jsonb,
        '{"flockSize":12}'::jsonb
      )
      `,
      [ids.planId, householdId]
    );

    await client.query(
      `
      insert into homestead_outputs (id, homestead_plan_id, output_type, output_name, qty, unit, preservation_ready, metadata)
      values ($1, $2, 'produce', 'Tomatoes', 10, 'lb', true, '{"seed":"contract"}'::jsonb)
      `,
      [ids.outputId, ids.planId]
    );
  } finally {
    await client.end();
  }

  return ids;
}

async function cleanupPlannerDb(connectionString, ids) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    if (ids.outputId) {
      await client.query("delete from homestead_outputs where id = $1", [ids.outputId]);
    }
    if (ids.mutationOutputId) {
      await client.query("delete from homestead_outputs where id = $1", [ids.mutationOutputId]);
    }
    if (ids.planId) {
      await client.query("delete from homestead_plans where id = $1", [ids.planId]);
    }
    if (ids.mutationPlanId) {
      await client.query("delete from homestead_plans where id = $1", [ids.mutationPlanId]);
    }
    if (ids.preservedId) {
      await client.query("delete from preservation_inventory where id = $1", [ids.preservedId]);
    }
    if (ids.lotId) {
      await client.query("delete from storehouse_lots where id = $1", [ids.lotId]);
    }
    if (ids.mutationLotId) {
      await client.query("delete from storehouse_lots where id = $1", [ids.mutationLotId]);
    }
  } finally {
    await client.end();
  }
}

async function cleanupOperationalOutboxForHousehold(connectionString, householdId) {
  if (!householdId) return;
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("delete from operational_outbox_events where household_id = $1", [
      String(householdId),
    ]);
  } finally {
    await client.end();
  }
}

async function resetOutboxObservabilityThresholdOverrides(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query(`
      create table if not exists operational_outbox_observability_config (
        config_key text primary key,
        threshold_overrides jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);

    await client.query(
      `
        insert into operational_outbox_observability_config (config_key, threshold_overrides, updated_at)
        values ('global', '{}'::jsonb, now())
        on conflict (config_key) do update
          set threshold_overrides = '{}'::jsonb,
              updated_at = now()
      `
    );
  } finally {
    await client.end();
  }
}

async function ensurePlannerTablesForConnection(connectionString) {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await ensurePlannerTables(client);
  } finally {
    await client.end();
  }
}

runtimeDescribe("planners endpoints runtime smoke", () => {
  it("serves the new /api/planners GET endpoints", async () => {
    const { child, port } = startServer();
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);
      await waitForRoute(`${baseUrl}/api/planners/storehouse`);

      const storehouseRes = await fetch(`${baseUrl}/api/planners/storehouse?householdId=smoke-home`);
      const storehouse = await storehouseRes.json();
      expect(storehouseRes.status).toBe(200);
      expect(storehouse.ok).toBe(true);
      expect(storehouse.householdId).toBe("smoke-home");
      expect(Array.isArray(storehouse.inventory)).toBe(true);
      expect(storehouse.summary).toBeTruthy();
      expect(typeof storehouse.summary.totalItems).toBe("number");
      expect(typeof storehouse.summary.preservedItems).toBe("number");
      expect(typeof storehouse.summary.lowStockItems).toBe("number");
      expect(Array.isArray(storehouse.warnings)).toBe(true);

      if (storehouse.inventory.length) {
        const item = storehouse.inventory[0];
        expect(typeof item.itemName).toBe("string");
        expect(typeof item.qty).toBe("number");
        expect(typeof item.unit).toBe("string");
        expect(typeof item.state).toBe("string");
        expect(typeof item.reservedQty).toBe("number");
      }

      const homesteadRes = await fetch(`${baseUrl}/api/planners/homestead?householdId=smoke-home`);
      const homestead = await homesteadRes.json();
      expect(homesteadRes.status).toBe(200);
      expect(homestead.ok).toBe(true);
      expect(homestead.householdId).toBe("smoke-home");
      expect(homestead.planId === null || typeof homestead.planId === "string").toBe(true);
      expect(homestead.seasonKey === null || typeof homestead.seasonKey === "string").toBe(true);
      expect(Array.isArray(homestead.gardenTasks)).toBe(true);
      expect(typeof homestead.animalPlan).toBe("object");
      expect(Array.isArray(homestead.outputs)).toBe(true);
      expect(homestead.preservationForecast).toBeTruthy();
      expect(typeof homestead.preservationForecast.totalOutputs).toBe("number");
      expect(typeof homestead.preservationForecast.preservationReadyCount).toBe("number");
      expect(typeof homestead.preservationForecast.preservationReadyQty).toBe("number");
      expect(Array.isArray(homestead.warnings)).toBe(true);

      if (homestead.outputs.length) {
        const output = homestead.outputs[0];
        expect(typeof output.outputType).toBe("string");
        expect(typeof output.outputName).toBe("string");
        expect(typeof output.qty).toBe("number");
        expect(typeof output.unit).toBe("string");
        expect(typeof output.preservationReady).toBe("boolean");
      }

      const mealRes = await fetch(`${baseUrl}/api/planners/meal?householdId=smoke-home`);
      const meal = await mealRes.json();
      expect([200, 500]).toContain(mealRes.status);
      expect(typeof meal.ok).toBe("boolean");
    } finally {
      await stopServer(child);
    }
  }, 25000);
});

runtimeDbDescribe("planners endpoints DB-seeded runtime contract", () => {
  it("executes planner schema bootstrap path and verifies required tables", async () => {
    const connectionString =
      process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/suka";

    const result = spawnSync(process.execPath, [bootstrapCheckEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DATABASE_URL: connectionString,
      },
      encoding: "utf8",
      shell: false,
    });

    expect(result.status).toBe(0);
    const lines = String(result.stdout || "")
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    const payload = JSON.parse(lines[lines.length - 1] || "{}");
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.files)).toBe(true);
    expect(payload.files.length).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(payload.tableCheck?.required)).toBe(true);
    expect(payload.tableCheck.required).toEqual(
      expect.arrayContaining([
        "storehouse_lots",
        "preservation_inventory",
        "homestead_plans",
        "homestead_outputs",
        "planner_projection_jobs",
      ])
    );
    expect(Array.isArray(payload.tableCheck?.missing)).toBe(true);
    expect(payload.tableCheck.missing.length).toBe(0);
  }, 30000);

  it("returns seeded PostgreSQL content for storehouse and homestead snapshots", async () => {
    const connectionString =
      process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/suka";
    const householdId = `seed-home-${Date.now()}`;
    const ids = await seedPlannerDb(connectionString, householdId);
    const { child, port } = startServer({ DATABASE_URL: connectionString });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);
      await waitForRoute(`${baseUrl}/api/planners/storehouse?householdId=${encodeURIComponent(householdId)}`);

      const storehouseRes = await fetch(
        `${baseUrl}/api/planners/storehouse?householdId=${encodeURIComponent(householdId)}`
      );
      const storehouse = await storehouseRes.json();
      expect(storehouseRes.status).toBe(200);
      expect(storehouse.ok).toBe(true);
      expect(Array.isArray(storehouse.inventory)).toBe(true);
      expect(storehouse.inventory.length).toBeGreaterThanOrEqual(2);
      expect(storehouse.summary.totalItems).toBeGreaterThanOrEqual(2);
      expect(storehouse.summary.preservedItems).toBeGreaterThanOrEqual(1);
      expect(storehouse.warnings.length).toBe(0);

      const seededLot = storehouse.inventory.find((x) => x.id === ids.lotId);
      expect(seededLot).toBeTruthy();
      expect(seededLot.itemName).toBe("Beans");
      expect(seededLot.qty).toBe(4);

      const seededPreserved = storehouse.inventory.find((x) => x.id === ids.preservedId);
      expect(seededPreserved).toBeTruthy();
      expect(seededPreserved.state).toBe("preserved");

      const homesteadRes = await fetch(
        `${baseUrl}/api/planners/homestead?householdId=${encodeURIComponent(householdId)}`
      );
      const homestead = await homesteadRes.json();
      expect(homesteadRes.status).toBe(200);
      expect(homestead.ok).toBe(true);
      expect(homestead.planId).toBe(ids.planId);
      expect(homestead.seasonKey).toBe("2026-spring");
      expect(Array.isArray(homestead.gardenTasks)).toBe(true);
      expect(homestead.gardenTasks.length).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(homestead.outputs)).toBe(true);
      expect(homestead.outputs.length).toBeGreaterThanOrEqual(1);
      expect(homestead.preservationForecast.totalOutputs).toBeGreaterThanOrEqual(1);
      expect(homestead.preservationForecast.preservationReadyCount).toBeGreaterThanOrEqual(1);
      expect(homestead.warnings.length).toBe(0);

      const seededOutput = homestead.outputs.find((x) => x.id === ids.outputId);
      expect(seededOutput).toBeTruthy();
      expect(seededOutput.outputName).toBe("Tomatoes");
      expect(seededOutput.preservationReady).toBe(true);
    } finally {
      await stopServer(child);
      await cleanupPlannerDb(connectionString, ids).catch(() => {});
    }
  }, 30000);

  it("applies storehouse and homestead mutations and reflects them in subsequent reads", async () => {
    const connectionString =
      process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/suka";
    const householdId = `seed-home-mutation-${Date.now()}`;
    const ids = {
      lotId: null,
      preservedId: null,
      planId: null,
      outputId: null,
      mutationLotId: randomUUID(),
      mutationPlanId: randomUUID(),
      mutationOutputId: randomUUID(),
    };

    await ensurePlannerTablesForConnection(connectionString);
    const { child, port } = startServer({ DATABASE_URL: connectionString });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);

      const storehouseMutationRes = await fetch(`${baseUrl}/api/planners/storehouse/inventory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          inventory: [
            {
              id: ids.mutationLotId,
              sku: "seed.sku.corn",
              itemName: "Corn",
              qty: 7,
              unit: "bag",
              state: "raw",
              reservedQty: 2,
              metadata: { source: "contract-mutation" },
            },
          ],
        }),
      });
      const storehouseMutation = await storehouseMutationRes.json();
      expect(storehouseMutationRes.status).toBe(200);
      expect(storehouseMutation.ok).toBe(true);
      expect(storehouseMutation.upsert?.upserted).toBe(1);
      expect(Array.isArray(storehouseMutation.upsert?.itemIds)).toBe(true);
      expect(storehouseMutation.upsert.itemIds[0]).toBe(ids.mutationLotId);
      expect(storehouseMutation.projection?.contractVersion).toBe(2);
      expect(storehouseMutation.projection?.planner).toBe("storehouse");
      expect(storehouseMutation.projection?.householdId).toBe(householdId);
      expect(storehouseMutation.projection?.updateType).toBe("inventory.upsert");
      expect(storehouseMutation.projection?.counts?.inventoryItems).toBe(1);
      expect(typeof storehouseMutation.projection?.projection?.ok).toBe("boolean");
      expect(storehouseMutation.projection?.queue?.durable).toBe(true);
      expect(typeof storehouseMutation.projection?.queue?.jobId).toBe("string");
      expect(Array.isArray(storehouseMutation.projection?.warnings)).toBe(true);

      const storehouseAfterRes = await fetch(
        `${baseUrl}/api/planners/storehouse?householdId=${encodeURIComponent(householdId)}`
      );
      const storehouseAfter = await storehouseAfterRes.json();
      expect(storehouseAfterRes.status).toBe(200);
      const mutatedLot = storehouseAfter.inventory.find((x) => x.id === ids.mutationLotId);
      expect(mutatedLot).toBeTruthy();
      expect(mutatedLot.itemName).toBe("Corn");
      expect(mutatedLot.qty).toBe(7);
      expect(mutatedLot.reservedQty).toBe(2);

      const homesteadMutationRes = await fetch(`${baseUrl}/api/planners/homestead`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          planId: ids.mutationPlanId,
          seasonKey: "2026-summer",
          gardenPlan: {
            tasks: [
              { id: "task-water", title: "Water beds" },
            ],
          },
          animalPlan: { flockSize: 20 },
          outputs: [
            {
              id: ids.mutationOutputId,
              outputType: "produce",
              outputName: "Peppers",
              qty: 5,
              unit: "lb",
              preservationReady: false,
              metadata: { source: "contract-mutation" },
            },
          ],
        }),
      });
      const homesteadMutation = await homesteadMutationRes.json();
      expect(homesteadMutationRes.status).toBe(200);
      expect(homesteadMutation.ok).toBe(true);
      expect(homesteadMutation.saved?.planId).toBe(ids.mutationPlanId);
      expect(homesteadMutation.saved?.seasonKey).toBe("2026-summer");
      expect(homesteadMutation.saved?.upsertedOutputs).toBe(1);
      expect(homesteadMutation.projection?.contractVersion).toBe(2);
      expect(homesteadMutation.projection?.planner).toBe("homestead");
      expect(homesteadMutation.projection?.householdId).toBe(householdId);
      expect(homesteadMutation.projection?.updateType).toBe("production.upsert");
      expect(homesteadMutation.projection?.counts?.outputItems).toBe(1);
      expect(homesteadMutation.projection?.projection?.ok).toBe(true);
      expect(homesteadMutation.projection?.queue?.durable).toBe(true);
      expect(typeof homesteadMutation.projection?.queue?.jobId).toBe("string");
      expect(Array.isArray(homesteadMutation.projection?.warnings)).toBe(true);

      const homesteadAfterRes = await fetch(
        `${baseUrl}/api/planners/homestead?householdId=${encodeURIComponent(householdId)}`
      );
      const homesteadAfter = await homesteadAfterRes.json();
      expect(homesteadAfterRes.status).toBe(200);
      expect(homesteadAfter.planId).toBe(ids.mutationPlanId);
      expect(homesteadAfter.seasonKey).toBe("2026-summer");
      expect(Array.isArray(homesteadAfter.gardenTasks)).toBe(true);
      expect(
        homesteadAfter.gardenTasks.some((x) => String(x?.title || "") === "Water beds")
      ).toBe(true);

      const mutatedOutput = homesteadAfter.outputs.find((x) => x.id === ids.mutationOutputId);
      expect(mutatedOutput).toBeTruthy();
      expect(mutatedOutput.outputName).toBe("Peppers");
      expect(mutatedOutput.qty).toBe(5);
      expect(mutatedOutput.preservationReady).toBe(false);
    } finally {
      await stopServer(child);
      await cleanupPlannerDb(connectionString, ids).catch(() => {});
    }
  }, 30000);

  it("supports projection status, replay, and reconcile flows for consistency checks", async () => {
    const connectionString =
      process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/suka";
    const householdId = `seed-home-p2-${Date.now()}`;
    const ids = {
      lotId: null,
      preservedId: null,
      planId: null,
      outputId: null,
      mutationLotId: randomUUID(),
      mutationPlanId: randomUUID(),
      mutationOutputId: randomUUID(),
    };

    await ensurePlannerTablesForConnection(connectionString);
    const { child, port } = startServer({ DATABASE_URL: connectionString });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);

      const storehouseMutationRes = await fetch(`${baseUrl}/api/planners/storehouse/inventory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          inventory: [
            {
              id: ids.mutationLotId,
              sku: "seed.sku.p2.beans",
              itemName: "P2 Beans",
              qty: 3,
              unit: "jar",
              state: "raw",
              reservedQty: 1,
              metadata: { source: "p2-contract" },
            },
          ],
        }),
      });
      expect(storehouseMutationRes.status).toBe(200);

      const statusRes = await fetch(`${baseUrl}/api/planners/projection/status`);
      const status = await statusRes.json();
      expect(statusRes.status).toBe(200);
      expect(status.ok).toBe(true);
      expect(status.queue).toBeTruthy();
      expect(typeof status.queue.total).toBe("number");
      expect(typeof status.worker.running).toBe("boolean");

      const reconcileRes = await fetch(`${baseUrl}/api/planners/projection/reconcile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          planner: "all",
          processNow: true,
        }),
      });
      const reconcile = await reconcileRes.json();
      expect(reconcileRes.status).toBe(200);
      expect(reconcile.ok).toBe(true);
      expect(Array.isArray(reconcile.queued)).toBe(true);
      expect(reconcile.queued.length).toBeGreaterThanOrEqual(2);

      const replayRes = await fetch(`${baseUrl}/api/planners/projection/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          planner: "storehouse",
          processLimit: 20,
        }),
      });
      const replay = await replayRes.json();
      expect(replayRes.status).toBe(200);
      expect(replay.ok).toBe(true);
      expect(typeof replay.replayed?.replayed).toBe("number");
      expect(typeof replay.processed?.processed).toBe("number");
    } finally {
      await stopServer(child);
      await cleanupPlannerDb(connectionString, ids).catch(() => {});
    }
  }, 30000);

  it("serves operational readiness endpoints", async () => {
    const connectionString =
      process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/suka";
    const householdId = `seed-home-readiness-${Date.now()}`;
    const { child, port } = startServer({ DATABASE_URL: connectionString });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);

      const aggregateRes = await fetch(
        `${baseUrl}/api/planners/operational/readiness?householdId=${encodeURIComponent(householdId)}`
      );
      const aggregate = await aggregateRes.json();
      expect(aggregateRes.status).toBe(200);
      expect(aggregate.ok).toBe(true);
      expect(aggregate.readiness).toBeTruthy();
      expect(aggregate.readiness.meal).toBeTruthy();
      expect(aggregate.readiness.storehouse).toBeTruthy();
      expect(aggregate.readiness.homestead).toBeTruthy();

      const mealRes = await fetch(
        `${baseUrl}/api/planners/operational/readiness/meal?householdId=${encodeURIComponent(householdId)}`
      );
      const meal = await mealRes.json();
      expect(mealRes.status).toBe(200);
      expect(meal.ok).toBe(true);
      expect(meal.readiness).toBeTruthy();

      const storehouseRes = await fetch(
        `${baseUrl}/api/planners/operational/readiness/storehouse?householdId=${encodeURIComponent(
          householdId
        )}`
      );
      const storehouse = await storehouseRes.json();
      expect(storehouseRes.status).toBe(200);
      expect(storehouse.ok).toBe(true);
      expect(storehouse.readiness).toBeTruthy();

      const homesteadRes = await fetch(
        `${baseUrl}/api/planners/operational/readiness/homestead?householdId=${encodeURIComponent(
          householdId
        )}`
      );
      const homestead = await homesteadRes.json();
      expect(homesteadRes.status).toBe(200);
      expect(homestead.ok).toBe(true);
      expect(homestead.readiness).toBeTruthy();

      const searchRes = await fetch(
        `${baseUrl}/api/planners/operational/saved-recipes/search?householdId=${encodeURIComponent(
          householdId
        )}&q=beans&limit=5`
      );
      const search = await searchRes.json();
      expect(searchRes.status).toBe(200);
      expect(search.ok).toBe(true);
      expect(Array.isArray(search.items)).toBe(true);
    } finally {
      await stopServer(child);
    }
  }, 30000);

  it("emits outbox events and supports claim/retry semantics", async () => {
    const connectionString =
      process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/suka";
    const householdId = `seed-home-outbox-${Date.now()}`;
    const ids = {
      lotId: null,
      preservedId: null,
      planId: null,
      outputId: null,
      mutationLotId: randomUUID(),
      mutationPlanId: null,
      mutationOutputId: null,
    };

    await ensurePlannerTablesForConnection(connectionString);
    const { child, port } = startServer({
      DATABASE_URL: connectionString,
      PLANNER_OPERATIONAL_OUTBOX_WORKER_DISABLED: "true",
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);

      const mutationRes = await fetch(`${baseUrl}/api/planners/storehouse/inventory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          inventory: [
            {
              id: ids.mutationLotId,
              sku: "seed.sku.outbox.beans",
              itemName: "Outbox Beans",
              qty: 4,
              unit: "jar",
              state: "raw",
              reservedQty: 1,
              metadata: { source: "outbox-contract" },
            },
          ],
        }),
      });
      const mutation = await mutationRes.json();
      expect(mutationRes.status).toBe(200);
      expect(mutation.ok).toBe(true);
      expect(typeof mutation.upsert?.outboxEvent?.id).toBe("string");

      const statusRes = await fetch(
        `${baseUrl}/api/planners/operational/outbox/status?householdId=${encodeURIComponent(
          householdId
        )}`
      );
      const status = await statusRes.json();
      expect(statusRes.status).toBe(200);
      expect(status.ok).toBe(true);
      expect(status.summary.total).toBeGreaterThanOrEqual(1);

      const claimRes = await fetch(`${baseUrl}/api/planners/operational/outbox/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ householdId, limit: 10 }),
      });
      const claim = await claimRes.json();
      expect(claimRes.status).toBe(200);
      expect(claim.ok).toBe(true);
      expect(claim.claimed).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(claim.items)).toBe(true);

      const picked = claim.items.find((x) => x.household_id === householdId) || claim.items[0];
      expect(picked).toBeTruthy();

      const retryRes = await fetch(`${baseUrl}/api/planners/operational/outbox/retry`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: picked.id,
          delayMs: 0,
          error: "contract_retry",
          changeReason: "contract_retry",
        }),
      });
      const retry = await retryRes.json();
      expect(retryRes.status).toBe(200);
      expect(retry.ok).toBe(true);
      expect(retry.retried?.status).toBe("retry");
    } finally {
      await stopServer(child);
      await cleanupPlannerDb(connectionString, ids).catch(() => {});
      await cleanupOperationalOutboxForHousehold(connectionString, householdId).catch(() => {});
    }
  }, 30000);

  it("serves outbox observability endpoints and supports threshold override/reset", async () => {
    const connectionString =
      process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/suka";
    const householdId = `seed-home-observe-${Date.now()}`;
    const ids = {
      lotId: null,
      preservedId: null,
      planId: null,
      outputId: null,
      mutationLotId: randomUUID(),
      mutationPlanId: null,
      mutationOutputId: null,
    };

    await ensurePlannerTablesForConnection(connectionString);
    const { child, port } = startServer({
      DATABASE_URL: connectionString,
      PLANNER_OPERATIONAL_OUTBOX_WORKER_DISABLED: "true",
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);

      const seedRes = await fetch(`${baseUrl}/api/planners/storehouse/inventory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          inventory: [
            {
              id: ids.mutationLotId,
              sku: "seed.sku.observe.beans",
              itemName: "Observe Beans",
              qty: 6,
              unit: "jar",
              state: "raw",
              reservedQty: 0,
              metadata: { source: "observe-contract" },
            },
          ],
        }),
      });
      expect(seedRes.status).toBe(200);

      const thresholdsBeforeRes = await fetch(
        `${baseUrl}/api/planners/operational/outbox/alert-thresholds`
      );
      const thresholdsBefore = await thresholdsBeforeRes.json();
      expect(thresholdsBeforeRes.status).toBe(200);
      expect(thresholdsBefore.ok).toBe(true);
      expect(typeof thresholdsBefore.thresholds.pendingAgeWarnMs).toBe("number");

      const overrideRes = await fetch(
        `${baseUrl}/api/planners/operational/outbox/alert-thresholds`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            thresholds: {
              pendingAgeWarnMs: 1,
              pendingAgeCritMs: 2,
              retryRateWarn: 0,
              retryRateCrit: 0,
            },
          }),
        }
      );
      const override = await overrideRes.json();
      expect(overrideRes.status).toBe(200);
      expect(override.ok).toBe(true);
      expect(override.thresholds.pendingAgeWarnMs).toBe(1);
      expect(override.thresholds.pendingAgeCritMs).toBe(2);
      expect(override.thresholds.retryRateWarn).toBe(0);
      expect(override.thresholds.retryRateCrit).toBe(0);

      const metricsRes = await fetch(
        `${baseUrl}/api/planners/operational/outbox/metrics?householdId=${encodeURIComponent(
          householdId
        )}&windowMs=60000`
      );
      const metrics = await metricsRes.json();
      expect(metricsRes.status).toBe(200);
      expect(metrics.ok).toBe(true);
      expect(metrics.metrics).toBeTruthy();
      expect(metrics.metrics.window.windowMs).toBe(60000);
      expect(typeof metrics.outbox.total).toBe("number");
      expect(metrics.health).toBeTruthy();

      const alertsRes = await fetch(
        `${baseUrl}/api/planners/operational/outbox/alerts?householdId=${encodeURIComponent(
          householdId
        )}&windowMs=60000`
      );
      const alerts = await alertsRes.json();
      expect(alertsRes.status).toBe(200);
      expect(alerts.ok).toBe(true);
      expect(Array.isArray(alerts.alerts)).toBe(true);
      expect(alerts.thresholds.pendingAgeWarnMs).toBe(1);

      const eventsRes = await fetch(
        `${baseUrl}/api/planners/operational/outbox/events?limit=20`
      );
      const events = await eventsRes.json();
      expect(eventsRes.status).toBe(200);
      expect(events.ok).toBe(true);
      expect(Array.isArray(events.items)).toBe(true);
      expect(events.count).toBeGreaterThanOrEqual(1);
      expect(events.items.some((x) => x.type === "thresholds.updated")).toBe(true);

      const observeRes = await fetch(
        `${baseUrl}/api/planners/operational/outbox/observability?householdId=${encodeURIComponent(
          householdId
        )}&windowMs=60000&eventsLimit=20`
      );
      const observe = await observeRes.json();
      expect(observeRes.status).toBe(200);
      expect(observe.ok).toBe(true);
      expect(observe.metrics).toBeTruthy();
      expect(observe.alerts).toBeTruthy();
      expect(Array.isArray(observe.recentEvents)).toBe(true);
      expect(observe.thresholds.pendingAgeWarnMs).toBe(1);

      const resetRes = await fetch(
        `${baseUrl}/api/planners/operational/outbox/alert-thresholds`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reset: true }),
        }
      );
      const reset = await resetRes.json();
      expect(resetRes.status).toBe(200);
      expect(reset.ok).toBe(true);
      expect(reset.reset).toBe(true);
      expect(reset.thresholds.pendingAgeWarnMs).toBe(
        thresholdsBefore.thresholds.pendingAgeWarnMs
      );
    } finally {
      await stopServer(child);
      await cleanupPlannerDb(connectionString, ids).catch(() => {});
      await cleanupOperationalOutboxForHousehold(connectionString, householdId).catch(() => {});
    }
  }, 30000);

  it("persists outbox alert threshold overrides across server restarts", async () => {
    const connectionString =
      process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/suka";
    const pendingAgeWarnMs = 43210;
    const retryRateWarn = 0.333;

    await resetOutboxObservabilityThresholdOverrides(connectionString);

    let server = startServer({ DATABASE_URL: connectionString });
    let baseUrl = `http://127.0.0.1:${server.port}`;

    try {
      await waitForHealth(server.port);

      const overrideRes = await fetch(
        `${baseUrl}/api/planners/operational/outbox/alert-thresholds`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            thresholds: {
              pendingAgeWarnMs,
              retryRateWarn,
            },
          }),
        }
      );
      const override = await overrideRes.json();
      expect(overrideRes.status).toBe(200);
      expect(override.ok).toBe(true);
      expect(override.thresholds.pendingAgeWarnMs).toBe(pendingAgeWarnMs);
      expect(override.thresholds.retryRateWarn).toBe(retryRateWarn);

      await stopServer(server.child);

      server = startServer({ DATABASE_URL: connectionString });
      baseUrl = `http://127.0.0.1:${server.port}`;
      await waitForHealth(server.port);

      const thresholdsRes = await fetch(
        `${baseUrl}/api/planners/operational/outbox/alert-thresholds`
      );
      const thresholds = await thresholdsRes.json();
      expect(thresholdsRes.status).toBe(200);
      expect(thresholds.ok).toBe(true);
      expect(thresholds.thresholds.pendingAgeWarnMs).toBe(pendingAgeWarnMs);
      expect(thresholds.thresholds.retryRateWarn).toBe(retryRateWarn);
    } finally {
      await stopServer(server.child).catch(() => {});
      await resetOutboxObservabilityThresholdOverrides(connectionString).catch(() => {});
    }
  }, 45000);

  it("dispatches outbox alerts to configured delivery hooks", async () => {
    const connectionString =
      process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/suka";
    const householdId = `seed-home-alert-hook-${Date.now()}`;
    const ids = {
      lotId: null,
      preservedId: null,
      planId: null,
      outputId: null,
      mutationLotId: randomUUID(),
      mutationPlanId: null,
      mutationOutputId: null,
    };

    await ensurePlannerTablesForConnection(connectionString);
    await resetOutboxObservabilityThresholdOverrides(connectionString);

    const sink = await startWebhookSink();
    const { child, port } = startServer({
      DATABASE_URL: connectionString,
      PLANNER_OPERATIONAL_OUTBOX_WORKER_DISABLED: "true",
      OPERATIONAL_OUTBOX_ALERT_WEBHOOK_URLS: sink.url,
      OPERATIONAL_OUTBOX_ALERT_HOOK_DEDUPE_MS: "60000",
    });
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      await waitForHealth(port);

      const seedRes = await fetch(`${baseUrl}/api/planners/storehouse/inventory`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          householdId,
          inventory: [
            {
              id: ids.mutationLotId,
              sku: "seed.sku.alert.hook",
              itemName: "Hook Beans",
              qty: 4,
              unit: "jar",
              state: "raw",
              reservedQty: 0,
              metadata: { source: "alert-hook-contract" },
            },
          ],
        }),
      });
      expect(seedRes.status).toBe(200);

      const overrideRes = await fetch(
        `${baseUrl}/api/planners/operational/outbox/alert-thresholds`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            thresholds: {
              retryRateWarn: 0,
              retryRateCrit: 0,
            },
          }),
        }
      );
      expect(overrideRes.status).toBe(200);

      const dispatchRes = await fetch(
        `${baseUrl}/api/planners/operational/outbox/alerts/dispatch`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ householdId, windowMs: 60000, force: true }),
        }
      );
      const dispatch = await dispatchRes.json();
      expect(dispatchRes.status).toBe(200);
      expect(dispatch.ok).toBe(true);
      expect(dispatch.delivery.ok).toBe(true);
      expect(dispatch.delivery.attempted).toBe(1);
      expect(dispatch.delivery.delivered).toBe(1);
      expect(dispatch.delivery.failed).toBe(0);

      await waitForCondition(() => sink.deliveries.length >= 1, 5000);
      const payload = sink.deliveries[0] || {};
      expect(Array.isArray(payload.alerts)).toBe(true);
      expect(payload.alerts.length).toBeGreaterThanOrEqual(1);
      expect(payload.householdId).toBe(householdId);

      const deliveriesRes = await fetch(
        `${baseUrl}/api/planners/operational/outbox/alert-deliveries?limit=5`
      );
      const deliveries = await deliveriesRes.json();
      expect(deliveriesRes.status).toBe(200);
      expect(deliveries.ok).toBe(true);
      expect(deliveries.count).toBeGreaterThanOrEqual(1);
      expect(Array.isArray(deliveries.items)).toBe(true);
      expect(deliveries.items.some((x) => Number(x.delivered || 0) >= 1)).toBe(true);
    } finally {
      await stopServer(child);
      await sink.stop().catch(() => {});
      await cleanupPlannerDb(connectionString, ids).catch(() => {});
      await cleanupOperationalOutboxForHousehold(connectionString, householdId).catch(() => {});
      await resetOutboxObservabilityThresholdOverrides(connectionString).catch(() => {});
    }
  }, 45000);
});
