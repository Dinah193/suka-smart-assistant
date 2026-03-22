"use strict";

const express = require("express");
const { authenticateRequest } = require("../middleware/realtime/authenticateRequest.js");
const {
  requireHouseholdAccessPolicy,
  requireCollaborationPolicy,
  requireEntitlementPolicy,
} = require("../middleware/accessPolicy.js");

function loadPlannerIntegrationService() {
  try {
    return require("../services/planners/PlannerIntegrationService");
  } catch {
    return {};
  }
}

function loadPlannerProjectionSync() {
  try {
    return require("../services/planners/PlannerProjectionSync");
  } catch {
    return {};
  }
}

function loadMealPlannerOrchestrationService() {
  try {
    return require("../services/planners/MealPlannerOrchestrationService");
  } catch {
    return {};
  }
}

function loadOperationalReadinessService() {
  try {
    return require("../services/planners/HouseholdOperationalReadinessService");
  } catch {
    return {};
  }
}

function loadOperationalOutboxService() {
  try {
    return require("../services/planners/OperationalOutboxService");
  } catch {
    return {};
  }
}

function loadOperationalProjectionWorker() {
  try {
    return require("../services/planners/OperationalProjectionWorker");
  } catch {
    return {};
  }
}

function loadOperationalOutboxObservability() {
  try {
    return require("../services/planners/OperationalOutboxObservability");
  } catch {
    return {};
  }
}

const router = express.Router();

router.use(authenticateRequest);
router.use(requireHouseholdAccessPolicy());
router.use(requireCollaborationPolicy({ moduleKey: "planners" }));
router.use(requireEntitlementPolicy({ feature: "planner.base" }));

router.get("/meal", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { getMealPlannerSnapshot } = loadPlannerIntegrationService();
    if (typeof getMealPlannerSnapshot !== "function") {
      return res.json({ ok: true, snapshot: null, meals: [], preservationTasks: [] });
    }
    const snapshot = await getMealPlannerSnapshot(householdId);
    return res.json({ ok: true, snapshot, meals: snapshot?.planner_output?.meals || [], preservationTasks: snapshot?.planner_output?.preservationTasks || [] });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/meal", express.json(), async (req, res) => {
  try {
    const {
      ensureMongoConnected,
      saveMealPlannerOutput,
      persistMealPlannerFanoutContracts,
    } = loadPlannerIntegrationService();
    const { orchestrateMealPlanFanout } = loadMealPlannerOrchestrationService();
    const { syncMealPlannerFanoutContracts } = loadPlannerProjectionSync();
    if (typeof saveMealPlannerOutput !== "function") {
      return res.status(503).json({ ok: false, error: "planner_integration_unavailable" });
    }
    if (typeof ensureMongoConnected === "function") {
      await ensureMongoConnected();
    }
    const payload = req.body || {};
    const out = await saveMealPlannerOutput(payload);

    let orchestration = {
      ok: false,
      skipped: true,
      reason: "meal_planner_orchestration_unavailable",
    };

    if (typeof orchestrateMealPlanFanout === "function") {
      orchestration = await orchestrateMealPlanFanout({
        mealPayload: payload,
        mealSaveResult: {
          id: out.id || payload.id,
          householdId: payload.householdId,
        },
        persistContracts:
          typeof persistMealPlannerFanoutContracts === "function"
            ? ({ mealPlanId, householdId, contracts }) =>
                persistMealPlannerFanoutContracts({
                  mealPlanId,
                  householdId,
                  contracts,
                  updatedBy: String(payload.updatedBy || payload.userId || "mealplanner:backendOrchestration"),
                  changeReason: "meal_plan_backend_fanout",
                })
            : null,
        syncProjection:
          typeof syncMealPlannerFanoutContracts === "function"
            ? (args) => syncMealPlannerFanoutContracts(args)
            : null,
      });
    }

    return res.json({ ok: true, ...out, orchestration });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/storehouse", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { getStorehousePlannerSnapshot } = loadPlannerIntegrationService();
    if (typeof getStorehousePlannerSnapshot !== "function") {
      return res.json({
        ok: true,
        householdId,
        inventory: [],
        summary: { totalItems: 0, preservedItems: 0, lowStockItems: 0 },
        warnings: ["planner_integration_unavailable"],
      });
    }

    const snapshot = await getStorehousePlannerSnapshot(householdId);
    return res.json({
      ok: true,
      householdId,
      inventory: Array.isArray(snapshot?.inventory) ? snapshot.inventory : [],
      summary: snapshot?.summary || { totalItems: 0, preservedItems: 0, lowStockItems: 0 },
      warnings: Array.isArray(snapshot?.warnings) ? snapshot.warnings : [],
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/storehouse/inventory", express.json(), async (req, res) => {
  try {
    const { upsertStorehouseInventory } = loadPlannerIntegrationService();
    const { syncStorehouseUpdate } = loadPlannerProjectionSync();
    if (typeof upsertStorehouseInventory !== "function") {
      return res.status(503).json({ ok: false, error: "planner_integration_unavailable" });
    }
    if (typeof syncStorehouseUpdate !== "function") {
      return res.status(503).json({ ok: false, error: "planner_projection_unavailable" });
    }
    const payload = req.body || {};
    const upsert = await upsertStorehouseInventory(payload);
    const projection = await syncStorehouseUpdate({
      payload,
      upsert,
      queuedJob: upsert.projectionQueue,
    });
    return res.json({ ok: true, upsert, projection });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/homestead", async (req, res) => {
  try {
    const householdId = String(req.query.householdId || "default-household");
    const { getHomesteadPlannerSnapshot } = loadPlannerIntegrationService();
    if (typeof getHomesteadPlannerSnapshot !== "function") {
      return res.json({
        ok: true,
        householdId,
        planId: null,
        seasonKey: null,
        gardenTasks: [],
        animalPlan: {},
        outputs: [],
        preservationForecast: {
          totalOutputs: 0,
          preservationReadyCount: 0,
          preservationReadyQty: 0,
        },
        warnings: ["planner_integration_unavailable"],
      });
    }

    const snapshot = await getHomesteadPlannerSnapshot(householdId);
    return res.json({
      ok: true,
      householdId,
      planId: snapshot?.planId || null,
      seasonKey: snapshot?.seasonKey || null,
      gardenTasks: Array.isArray(snapshot?.gardenTasks) ? snapshot.gardenTasks : [],
      animalPlan: snapshot?.animalPlan || {},
      outputs: Array.isArray(snapshot?.outputs) ? snapshot.outputs : [],
      preservationForecast: snapshot?.preservationForecast || {
        totalOutputs: 0,
        preservationReadyCount: 0,
        preservationReadyQty: 0,
      },
      warnings: Array.isArray(snapshot?.warnings) ? snapshot.warnings : [],
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/homestead", express.json(), async (req, res) => {
  try {
    const { upsertHomesteadPlan, getHomesteadPlannerSnapshot } = loadPlannerIntegrationService();
    const { syncHomesteadUpdate } = loadPlannerProjectionSync();
    if (
      typeof upsertHomesteadPlan !== "function" ||
      typeof getHomesteadPlannerSnapshot !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "planner_integration_unavailable" });
    }
    if (typeof syncHomesteadUpdate !== "function") {
      return res.status(503).json({ ok: false, error: "planner_projection_unavailable" });
    }

    const payload = req.body || {};
    const saved = await upsertHomesteadPlan(payload);
    const snapshot = await getHomesteadPlannerSnapshot(saved.householdId);
    const projection = await syncHomesteadUpdate({
      payload,
      saved,
      snapshot,
    });
    return res.json({ ok: true, saved, snapshot, projection });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/projection/status", async (req, res) => {
  try {
    const { getProjectionStatus } = loadPlannerProjectionSync();
    if (typeof getProjectionStatus !== "function") {
      return res.status(503).json({ ok: false, error: "planner_projection_unavailable" });
    }

    const status = await getProjectionStatus();
    return res.json({ ok: true, ...status });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/projection/replay", express.json(), async (req, res) => {
  try {
    const { replayProjectionJobs, processProjectionBacklog } = loadPlannerProjectionSync();
    if (
      typeof replayProjectionJobs !== "function" ||
      typeof processProjectionBacklog !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "planner_projection_unavailable" });
    }

    const payload = req.body || {};
    const replayed = await replayProjectionJobs(payload);
    const processed = await processProjectionBacklog({ limit: Number(payload.processLimit || 20) });
    return res.json({ ok: true, replayed, processed });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/projection/reconcile", express.json(), async (req, res) => {
  try {
    const { reconcileHouseholdProjection } = loadPlannerProjectionSync();
    if (typeof reconcileHouseholdProjection !== "function") {
      return res.status(503).json({ ok: false, error: "planner_projection_unavailable" });
    }

    const payload = req.body || {};
    const result = await reconcileHouseholdProjection({
      householdId: payload.householdId,
      planner: payload.planner || "all",
      processNow: payload.processNow !== false,
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/readiness/meal", async (req, res) => {
  try {
    const { getMealPlanningReadiness } = loadOperationalReadinessService();
    if (typeof getMealPlanningReadiness !== "function") {
      return res.status(503).json({ ok: false, error: "operational_readiness_unavailable" });
    }
    const householdId = String(req.query.householdId || req.query.householdKey || "");
    const readiness = await getMealPlanningReadiness(householdId);
    return res.json({ ok: true, readiness });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/readiness/storehouse", async (req, res) => {
  try {
    const { getStorehouseInventoryReadiness } = loadOperationalReadinessService();
    if (typeof getStorehouseInventoryReadiness !== "function") {
      return res.status(503).json({ ok: false, error: "operational_readiness_unavailable" });
    }
    const householdId = String(req.query.householdId || req.query.householdKey || "");
    const readiness = await getStorehouseInventoryReadiness(householdId);
    return res.json({ ok: true, readiness });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/readiness/homestead", async (req, res) => {
  try {
    const { getHomesteadProductionReadiness } = loadOperationalReadinessService();
    if (typeof getHomesteadProductionReadiness !== "function") {
      return res.status(503).json({ ok: false, error: "operational_readiness_unavailable" });
    }
    const householdId = String(req.query.householdId || req.query.householdKey || "");
    const readiness = await getHomesteadProductionReadiness(householdId);
    return res.json({ ok: true, readiness });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/readiness", async (req, res) => {
  try {
    const {
      getMealPlanningReadiness,
      getStorehouseInventoryReadiness,
      getHomesteadProductionReadiness,
    } = loadOperationalReadinessService();
    if (
      typeof getMealPlanningReadiness !== "function" ||
      typeof getStorehouseInventoryReadiness !== "function" ||
      typeof getHomesteadProductionReadiness !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "operational_readiness_unavailable" });
    }
    const householdId = String(req.query.householdId || req.query.householdKey || "");
    const [meal, storehouse, homestead] = await Promise.all([
      getMealPlanningReadiness(householdId),
      getStorehouseInventoryReadiness(householdId),
      getHomesteadProductionReadiness(householdId),
    ]);
    return res.json({ ok: true, householdId, readiness: { meal, storehouse, homestead } });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/saved-recipes/search", async (req, res) => {
  try {
    const { searchSavedRecipes } = loadOperationalReadinessService();
    if (typeof searchSavedRecipes !== "function") {
      return res.status(503).json({ ok: false, error: "operational_readiness_unavailable" });
    }
    const householdIdOrKey = String(req.query.householdId || req.query.householdKey || "");
    const query = String(req.query.q || "");
    const limit = Number(req.query.limit || 25);
    const rows = await searchSavedRecipes({ householdIdOrKey, query, limit });
    return res.json({ ok: true, count: rows.length, items: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/outbox/status", async (req, res) => {
  try {
    const { getOutboxStatus, getOutboxHealthSignals } = loadOperationalOutboxService();
    const { getOperationalProjectionWorkerStatus } = loadOperationalProjectionWorker();
    if (typeof getOutboxStatus !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_unavailable" });
    }
    const householdId = String(req.query.householdId || "").trim();
    const outbox = await getOutboxStatus({ householdId: householdId || null });
    const health =
      typeof getOutboxHealthSignals === "function"
        ? await getOutboxHealthSignals({ householdId: householdId || null })
        : null;
    if (typeof getOperationalProjectionWorkerStatus === "function") {
      const worker = await getOperationalProjectionWorkerStatus();
      return res.json({ ok: true, ...outbox, health, worker: worker.worker });
    }
    return res.json({ ok: true, ...outbox, health });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/outbox/metrics", async (req, res) => {
  try {
    const { getOutboxStatus, getOutboxHealthSignals } = loadOperationalOutboxService();
    const { getOperationalProjectionWorkerStatus } = loadOperationalProjectionWorker();
    const { getMetricsSnapshot } = loadOperationalOutboxObservability();
    if (
      typeof getOutboxStatus !== "function" ||
      typeof getOutboxHealthSignals !== "function" ||
      typeof getMetricsSnapshot !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const householdId = String(req.query.householdId || "").trim();
    const windowMs = Number(req.query.windowMs || 300000);
    const [outbox, health, metrics, workerStatus] = await Promise.all([
      getOutboxStatus({ householdId: householdId || null }),
      getOutboxHealthSignals({ householdId: householdId || null }),
      Promise.resolve(getMetricsSnapshot({ windowMs })),
      typeof getOperationalProjectionWorkerStatus === "function"
        ? getOperationalProjectionWorkerStatus()
        : Promise.resolve(null),
    ]);

    return res.json({
      ok: true,
      householdId: householdId || null,
      outbox: outbox.summary,
      health,
      metrics,
      worker: workerStatus?.worker || null,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/outbox/alerts", async (req, res) => {
  try {
    const { getOutboxStatus, getOutboxHealthSignals } = loadOperationalOutboxService();
    const { evaluateAlerts, ensureThresholdOverridesLoaded, deliverAlerts } = loadOperationalOutboxObservability();
    if (
      typeof getOutboxStatus !== "function" ||
      typeof getOutboxHealthSignals !== "function" ||
      typeof evaluateAlerts !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const householdId = String(req.query.householdId || "").trim();
    const windowMs = Number(req.query.windowMs || 300000);
    const [outbox, health] = await Promise.all([
      getOutboxStatus({ householdId: householdId || null }),
      getOutboxHealthSignals({ householdId: householdId || null }),
    ]);

    if (typeof ensureThresholdOverridesLoaded === "function") {
      await ensureThresholdOverridesLoaded();
    }

    const alerts = evaluateAlerts({
      outboxSummary: outbox.summary,
      healthSignals: health,
      windowMs,
    });

    let delivery = null;
    const dispatch = String(req.query.dispatch || "").toLowerCase();
    const shouldDispatch = dispatch === "1" || dispatch === "true" || dispatch === "yes";
    if (shouldDispatch && typeof deliverAlerts === "function") {
      delivery = await deliverAlerts({
        payload: {
          householdId: householdId || null,
          windowMs: alerts.windowMs,
          outbox: outbox.summary,
          health,
          thresholds: alerts.thresholds,
          alerts: alerts.alerts,
          hasCritical: alerts.hasCritical,
          hasWarning: alerts.hasWarning,
        },
      });
    }

    return res.json({
      ok: true,
      householdId: householdId || null,
      outbox: outbox.summary,
      health,
      ...alerts,
      delivery,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/operational/outbox/alerts/dispatch", express.json(), async (req, res) => {
  try {
    const { getOutboxStatus, getOutboxHealthSignals } = loadOperationalOutboxService();
    const { evaluateAlerts, ensureThresholdOverridesLoaded, deliverAlerts } =
      loadOperationalOutboxObservability();
    if (
      typeof getOutboxStatus !== "function" ||
      typeof getOutboxHealthSignals !== "function" ||
      typeof evaluateAlerts !== "function" ||
      typeof deliverAlerts !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const payload = req.body || {};
    const householdId = String(payload.householdId || req.query.householdId || "").trim();
    const windowMs = Number(payload.windowMs || req.query.windowMs || 300000);
    const [outbox, health] = await Promise.all([
      getOutboxStatus({ householdId: householdId || null }),
      getOutboxHealthSignals({ householdId: householdId || null }),
    ]);

    if (typeof ensureThresholdOverridesLoaded === "function") {
      await ensureThresholdOverridesLoaded();
    }

    const alerts = evaluateAlerts({
      outboxSummary: outbox.summary,
      healthSignals: health,
      windowMs,
    });

    const delivery = await deliverAlerts({
      payload: {
        householdId: householdId || null,
        windowMs: alerts.windowMs,
        outbox: outbox.summary,
        health,
        thresholds: alerts.thresholds,
        alerts: alerts.alerts,
        hasCritical: alerts.hasCritical,
        hasWarning: alerts.hasWarning,
      },
      force: payload.force === true,
      urls: Array.isArray(payload.urls) ? payload.urls : null,
    });

    return res.json({
      ok: true,
      householdId: householdId || null,
      outbox: outbox.summary,
      health,
      alerts,
      delivery,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/outbox/alert-deliveries", async (req, res) => {
  try {
    const { getAlertDeliveryHistory } = loadOperationalOutboxObservability();
    if (typeof getAlertDeliveryHistory !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const limit = Number(req.query.limit || 50);
    const items = getAlertDeliveryHistory({ limit });
    return res.json({ ok: true, count: items.length, items });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/outbox/events", async (req, res) => {
  try {
    const { getRecentEvents } = loadOperationalOutboxObservability();
    if (typeof getRecentEvents !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const limit = Number(req.query.limit || 100);
    const items = getRecentEvents({ limit });
    return res.json({ ok: true, count: items.length, items });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/outbox/alert-thresholds", async (req, res) => {
  try {
    const { getThresholds, ensureThresholdOverridesLoaded } = loadOperationalOutboxObservability();
    if (typeof getThresholds !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    if (typeof ensureThresholdOverridesLoaded === "function") {
      await ensureThresholdOverridesLoaded();
    }

    return res.json({ ok: true, thresholds: getThresholds() });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/operational/outbox/alert-thresholds", express.json(), async (req, res) => {
  try {
    const { setThresholdOverrides, clearThresholdOverrides, getThresholds } =
      loadOperationalOutboxObservability();
    if (
      typeof setThresholdOverrides !== "function" ||
      typeof clearThresholdOverrides !== "function" ||
      typeof getThresholds !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const payload = req.body || {};
    if (payload.reset === true) {
      const thresholds = await clearThresholdOverrides();
      return res.json({ ok: true, reset: true, thresholds });
    }

    const thresholds = await setThresholdOverrides(payload.thresholds || {});
    return res.json({ ok: true, thresholds });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.get("/operational/outbox/observability", async (req, res) => {
  try {
    const { getOutboxStatus, getOutboxHealthSignals } = loadOperationalOutboxService();
    const { getOperationalProjectionWorkerStatus } = loadOperationalProjectionWorker();
    const { getMetricsSnapshot, evaluateAlerts, getThresholds, getRecentEvents, ensureThresholdOverridesLoaded } =
      loadOperationalOutboxObservability();
    if (
      typeof getOutboxStatus !== "function" ||
      typeof getOutboxHealthSignals !== "function" ||
      typeof getMetricsSnapshot !== "function" ||
      typeof evaluateAlerts !== "function"
    ) {
      return res.status(503).json({ ok: false, error: "operational_outbox_observability_unavailable" });
    }

    const householdId = String(req.query.householdId || "").trim();
    const windowMs = Number(req.query.windowMs || 300000);
    const recentLimit = Number(req.query.eventsLimit || 50);
    const [outbox, health, metrics, workerStatus] = await Promise.all([
      getOutboxStatus({ householdId: householdId || null }),
      getOutboxHealthSignals({ householdId: householdId || null }),
      Promise.resolve(getMetricsSnapshot({ windowMs })),
      typeof getOperationalProjectionWorkerStatus === "function"
        ? getOperationalProjectionWorkerStatus()
        : Promise.resolve(null),
    ]);

    if (typeof ensureThresholdOverridesLoaded === "function") {
      await ensureThresholdOverridesLoaded();
    }

    const alerts = evaluateAlerts({
      outboxSummary: outbox.summary,
      healthSignals: health,
      windowMs,
    });

    return res.json({
      ok: true,
      householdId: householdId || null,
      outbox: outbox.summary,
      health,
      worker: workerStatus?.worker || null,
      metrics,
      alerts,
      thresholds: typeof getThresholds === "function" ? getThresholds() : null,
      recentEvents: typeof getRecentEvents === "function" ? getRecentEvents({ limit: recentLimit }) : [],
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/operational/outbox/claim", express.json(), async (req, res) => {
  try {
    const { claimOutboxBatch } = loadOperationalOutboxService();
    if (typeof claimOutboxBatch !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_unavailable" });
    }
    const payload = req.body || {};
    const claimed = await claimOutboxBatch({
      limit: Number(payload.limit || 25),
      householdId: payload.householdId == null ? null : String(payload.householdId),
    });
    return res.json({ ok: true, claimed: claimed.length, items: claimed });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/operational/outbox/retry", express.json(), async (req, res) => {
  try {
    const { markOutboxRetry, markOutboxDeadLetter, getOutboxEventById } = loadOperationalOutboxService();
    if (typeof markOutboxRetry !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_unavailable" });
    }
    const payload = req.body || {};
    const id = String(payload.id || "").trim();
    if (!id) {
      return res.status(400).json({ ok: false, error: "missing_outbox_id" });
    }

    const existing =
      typeof getOutboxEventById === "function" ? await getOutboxEventById(id) : null;
    if (!existing) {
      return res.status(404).json({ ok: false, error: "outbox_event_not_found" });
    }

    if (payload.deadLetter === true) {
      if (typeof markOutboxDeadLetter !== "function") {
        return res.status(503).json({ ok: false, error: "operational_outbox_dead_letter_unavailable" });
      }

      const deadLettered = await markOutboxDeadLetter(id, {
        reason: payload.error || "manual_dead_letter",
        updatedBy: String(payload.updatedBy || "operational.api"),
        changeReason: String(payload.changeReason || "manual_dead_letter"),
      });
      return res.json({ ok: true, deadLettered });
    }

    const retried = await markOutboxRetry(id, {
      delayMs: Number(payload.delayMs || 0),
      error: payload.error || "manual_retry",
      updatedBy: String(payload.updatedBy || "operational.api"),
      changeReason: String(payload.changeReason || "manual_retry"),
    });

    return res.json({ ok: true, retried });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/operational/outbox/replay-dead-letter", express.json(), async (req, res) => {
  try {
    const { replayDeadLetter, getDeadLetterSummary } = loadOperationalOutboxService();
    if (typeof replayDeadLetter !== "function") {
      return res.status(503).json({ ok: false, error: "operational_outbox_unavailable" });
    }

    const payload = req.body || {};
    const replayed = await replayDeadLetter({
      householdId: payload.householdId == null ? null : String(payload.householdId),
      eventType: payload.eventType == null ? null : String(payload.eventType),
      limit: Number(payload.limit || 100),
      updatedBy: String(payload.updatedBy || "operational.api"),
      changeReason: String(payload.changeReason || "manual_dead_letter_replay"),
    });

    const deadLetterSummary =
      typeof getDeadLetterSummary === "function"
        ? await getDeadLetterSummary({
            householdId: payload.householdId == null ? null : String(payload.householdId),
          })
        : [];

    return res.json({
      ok: true,
      replayed: replayed.length,
      items: replayed,
      deadLetterSummary,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

router.post("/operational/outbox/process", express.json(), async (req, res) => {
  try {
    const { processOutboxBatch } = loadOperationalProjectionWorker();
    if (typeof processOutboxBatch !== "function") {
      return res.status(503).json({ ok: false, error: "operational_projection_unavailable" });
    }
    const payload = req.body || {};
    const result = await processOutboxBatch({
      limit: Number(payload.limit || 25),
      householdId: payload.householdId == null ? null : String(payload.householdId),
    });
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

module.exports = router;
