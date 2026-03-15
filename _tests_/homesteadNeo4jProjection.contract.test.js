import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const plannerIntegrationModulePath = require.resolve("../src/server/services/planners/PlannerIntegrationService.js");
const neo4jDriverModulePath = require.resolve("neo4j-driver");

function withTempEnv(pairs, run) {
  const prev = new Map();
  for (const [key, value] of Object.entries(pairs || {})) {
    prev.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }

  try {
    return run();
  } finally {
    for (const [key, value] of prev.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function withMockedPlannerIntegration({ runQueryImpl }, run) {
  const txRun = vi.fn(runQueryImpl);
  const writeTransaction = vi.fn(async (work) => work({ run: txRun }));
  const close = vi.fn(async () => {});
  const session = vi.fn(() => ({ writeTransaction, close }));

  const fakeNeo4jDriver = {
    auth: {
      basic: vi.fn(() => ({ token: "fake" })),
    },
    driver: vi.fn(() => ({ session })),
  };

  const prevNeo4j = require.cache[neo4jDriverModulePath];
  const prevPlanner = require.cache[plannerIntegrationModulePath];

  require.cache[neo4jDriverModulePath] = {
    id: neo4jDriverModulePath,
    filename: neo4jDriverModulePath,
    loaded: true,
    exports: fakeNeo4jDriver,
  };

  delete require.cache[plannerIntegrationModulePath];

  try {
    return run({ txRun, writeTransaction, close });
  } finally {
    delete require.cache[plannerIntegrationModulePath];
    if (prevPlanner) require.cache[plannerIntegrationModulePath] = prevPlanner;

    if (prevNeo4j) require.cache[neo4jDriverModulePath] = prevNeo4j;
    else delete require.cache[neo4jDriverModulePath];
  }
}

describe("homestead neo4j projection contract", () => {
  it("writes expected household -> plan -> output graph with stable output properties", async () => {
    await withTempEnv(
      {
        NEO4J_ENABLED: "true",
        NEO4J_REQUIRED: "true",
        NEO4J_URI: "bolt://127.0.0.1:7687",
        NEO4J_USER: "neo4j",
        NEO4J_PASSWORD: "test-password",
      },
      async () => {
        await withMockedPlannerIntegration(
          {
            runQueryImpl: async () => ({ records: [], summary: {} }),
          },
          async ({ txRun }) => {
            const planner = require("../src/server/services/planners/PlannerIntegrationService.js");

            const out = await planner.projectHomesteadOutputsToNeo4j({
              householdId: "home-42",
              planId: "plan-spring-42",
              seasonKey: "2026-spring",
              outputs: [
                {
                  id: "output-1",
                  outputType: "garden",
                  outputName: "Tomatoes",
                  qty: 18,
                  unit: "lb",
                  expectedHarvestAt: "2026-06-15T00:00:00.000Z",
                  preservationReady: true,
                  metadata: { method: "canning", prepReductionPct: 0.25 },
                },
              ],
            });

            expect(out.ok).toBe(true);
            expect(out.projected).toBe(1);

            expect(txRun).toHaveBeenCalledTimes(1);
            const [query, params] = txRun.mock.calls[0];

            expect(String(query)).toContain("MERGE (h:Household {id: $householdId})");
            expect(String(query)).toContain("MERGE (p:HomesteadPlan {id: $planId})");
            expect(String(query)).toContain("MERGE (h)-[:HAS_HOMESTEAD_PLAN]->(p)");
            expect(String(query)).toContain("MERGE (o:HomesteadOutput {id: output.id})");
            expect(String(query)).toContain("MERGE (p)-[:PRODUCES]->(o)");

            expect(params.householdId).toBe("home-42");
            expect(params.planId).toBe("plan-spring-42");
            expect(params.seasonKey).toBe("2026-spring");
            expect(Array.isArray(params.outputs)).toBe(true);
            expect(params.outputs).toHaveLength(1);
            expect(params.outputs[0]).toMatchObject({
              id: "output-1",
              outputType: "garden",
              outputName: "Tomatoes",
              qty: 18,
              unit: "lb",
              expectedHarvestAt: "2026-06-15T00:00:00.000Z",
              preservationReady: true,
            });
            expect(params.outputs[0].metadataJson).toBe(
              JSON.stringify({ method: "canning", prepReductionPct: 0.25 })
            );
          }
        );
      }
    );
  });
});
