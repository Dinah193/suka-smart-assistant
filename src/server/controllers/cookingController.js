// C:\Users\larho\suka-smart-assistant\src\server\controllers\cookingController.js
//
// Suka Smart Assistant — Cooking Controller
// Purpose:
//  - Receive callbacks from n8n (and other services) about cooking sessions
//  - Push real-time updates to the UI via Socket.io
//  - Persist lightweight session/step history (if CookingHistory model exists)
//
// Endpoints:
//  POST /api/cooking/notify-step-started   -> emits COOKING:STEP_STARTED
//  POST /api/cooking/notify-step-reminder  -> emits COOKING:STEP_REMINDER
//  POST /api/cooking/session-ended         -> emits COOKING:SESSION_ENDED
//  POST /api/cooking/history               -> persists session/steps history
//  GET  /api/cooking/history/:sessionId    -> fetch one session history (if model present)
//
// Notes:
//  - Uses Ajv validation against your /src/automation schemas
//  - Designed to be resilient even if DB models aren’t wired up yet
//

import express from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";

// Reuse shared JSON Schemas from your automation module
import cookingSchema from "@/automation/payloadSchemas/cooking.json" assert { type: "json" };

// Optional: if you created a central validator already, you can swap in:
//   import { validate } from "@/automation/validate";
//
// For this controller we keep a local Ajv instance to avoid circular deps in some setups.
const ajv = new Ajv({ allErrors: true, removeAdditional: "failing", strict: false });
addFormats(ajv);

const router = express.Router();

// Socket.io instance (exported by src/server/socket.js)
import { io } from "../socket.js";

/* -----------------------------------------------------------------------------
   Utilities
----------------------------------------------------------------------------- */

function badRequest(res, message, details = undefined) {
  return res.status(400).json({ ok: false, error: message, details });
}

function toValidation(fn, data) {
  const ok = fn(data);
  if (!ok) {
    const msg = fn.errors?.map(e => `${e.instancePath || "/"} ${e.message}`).join("; ") || "invalid payload";
    const details = fn.errors;
    const error = new Error(msg);
    error.details = details;
    throw error;
  }
  return true;
}

// Safe dynamic import for models (so this file works even before DB layer is ready)
async function getCookingHistoryModel() {
  try {
    const mod = await import("../db/models/CookingHistory.js");
    return mod?.default || mod?.CookingHistory || null;
  } catch {
    return null;
  }
}

// Push to a user’s private room (room name == userId)
function emitToUser(userId, event, payload) {
  if (!userId) return;
  io.to(String(userId)).emit(event, payload);
}

/* -----------------------------------------------------------------------------
   Schemas for specific endpoints (derived from the general cooking schema)
----------------------------------------------------------------------------- */

// STEP_STARTED validator
const stepStartSchema = {
  type: "object",
  required: ["userId", "sessionId", "stepId", "stepName"],
  properties: {
    userId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    recipeId: { type: "string" },
    stepId: { type: "string", minLength: 1 },
    stepName: { type: "string", minLength: 1 },
    expectedDurationSec: { type: "number", minimum: 0 },
  },
  additionalProperties: true,
};
const validateStepStart = ajv.compile(stepStartSchema);

// STEP_REMINDER validator
const stepReminderSchema = {
  type: "object",
  required: ["userId", "sessionId", "stepId"],
  properties: {
    userId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    stepId: { type: "string", minLength: 1 },
    note: { type: "string" },
  },
  additionalProperties: true,
};
const validateStepReminder = ajv.compile(stepReminderSchema);

// SESSION_ENDED validator
const sessionEndedSchema = {
  type: "object",
  required: ["userId", "sessionId"],
  properties: {
    userId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    summary: { type: "object", additionalProperties: true },
  },
  additionalProperties: true,
};
const validateSessionEnded = ajv.compile(sessionEndedSchema);

// HISTORY upsert validator (uses broader cooking schema shapes)
const historySchema = {
  type: "object",
  required: ["userId", "sessionId"],
  properties: {
    userId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    recipeId: { type: "string" },
    startedAt: { type: "number" },
    endedAt: { type: "number" },
    notes: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        required: ["stepId", "name"],
        properties: {
          stepId: { type: "string" },
          name: { type: "string" },
          startedAt: { type: "number" },
          endedAt: { type: "number" },
          outcome: { type: "string" },
          doneness: { type: "string" },
          durationSec: { type: "number" },
        },
        additionalProperties: true,
      },
    },
  },
  additionalProperties: true,
};
const validateHistory = ajv.compile(historySchema);

/* -----------------------------------------------------------------------------
   Routes
----------------------------------------------------------------------------- */

/**
 * POST /api/cooking/notify-step-started
 * Body: { userId, sessionId, stepId, stepName, expectedDurationSec? }
 * Emits: COOKING:STEP_STARTED
 */
router.post("/notify-step-started", express.json(), async (req, res) => {
  try {
    toValidation(validateStepStart, req.body);
    const { userId, sessionId, stepId, stepName, expectedDurationSec, recipeId } = req.body;

    emitToUser(userId, "COOKING:STEP_STARTED", {
      sessionId,
      stepId,
      stepName,
      expectedDurationSec: expectedDurationSec ?? null,
      recipeId: recipeId ?? null,
    });

    return res.json({ ok: true });
  } catch (err) {
    return badRequest(res, err.message, err.details);
  }
});

/**
 * POST /api/cooking/notify-step-reminder
 * Body: { userId, sessionId, stepId, note? }
 * Emits: COOKING:STEP_REMINDER
 */
router.post("/notify-step-reminder", express.json(), async (req, res) => {
  try {
    toValidation(validateStepReminder, req.body);
    const { userId, sessionId, stepId, note } = req.body;

    emitToUser(userId, "COOKING:STEP_REMINDER", {
      sessionId,
      stepId,
      note: note || "Check your step timing/doneness.",
    });

    return res.json({ ok: true });
  } catch (err) {
    return badRequest(res, err.message, err.details);
  }
});

/**
 * POST /api/cooking/session-ended
 * Body: { userId, sessionId, summary? }
 * Emits: COOKING:SESSION_ENDED
 */
router.post("/session-ended", express.json(), async (req, res) => {
  try {
    toValidation(validateSessionEnded, req.body);
    const { userId, sessionId, summary } = req.body;

    emitToUser(userId, "COOKING:SESSION_ENDED", {
      sessionId,
      summary: summary || {},
    });

    return res.json({ ok: true });
  } catch (err) {
    return badRequest(res, err.message, err.details);
  }
});

/**
 * POST /api/cooking/history
 * Body: {
 *   userId, sessionId, recipeId?, startedAt?, endedAt?, notes?,
 *   steps?: [{ stepId, name, startedAt?, endedAt?, outcome?, doneness?, durationSec? }]
 * }
 * Action: Upsert (create or update) history if model exists; else no-op with ok:true.
 */
router.post("/history", express.json(), async (req, res) => {
  try {
    toValidation(validateHistory, req.body);

    const CookingHistory = await getCookingHistoryModel();
    if (!CookingHistory) {
      // App isn't using DB layer yet; gracefully succeed.
      return res.json({ ok: true, persisted: false, reason: "No CookingHistory model available" });
    }

    const {
      userId,
      sessionId,
      recipeId = null,
      startedAt = null,
      endedAt = null,
      notes = "",
      steps = [],
    } = req.body;

    // Upsert by (userId, sessionId)
    const existing = await CookingHistory.findOne({ userId, sessionId }).exec();
    if (existing) {
      existing.recipeId = recipeId ?? existing.recipeId;
      existing.startedAt = startedAt ?? existing.startedAt;
      existing.endedAt = endedAt ?? existing.endedAt;
      existing.notes = notes ?? existing.notes;
      if (Array.isArray(steps) && steps.length) {
        // append or merge by stepId
        const byId = new Map((existing.steps || []).map(s => [s.stepId, s]));
        for (const s of steps) {
          if (s?.stepId && byId.has(s.stepId)) {
            byId.set(s.stepId, { ...byId.get(s.stepId), ...s });
          } else if (s?.stepId) {
            byId.set(s.stepId, s);
          }
        }
        existing.steps = Array.from(byId.values());
      }
      await existing.save();
      return res.json({ ok: true, persisted: true, updated: true });
    } else {
      const doc = new CookingHistory({
        userId,
        sessionId,
        recipeId,
        startedAt,
        endedAt,
        notes,
        steps,
      });
      await doc.save();
      return res.json({ ok: true, persisted: true, created: true });
    }
  } catch (err) {
    return badRequest(res, err.message, err.details);
  }
});

/**
 * GET /api/cooking/history/:sessionId
 * Return a single session’s history if the model exists
 */
router.get("/history/:sessionId", async (req, res) => {
  const { sessionId } = req.params;
  const userId = req.query.userId?.toString?.();

  if (!sessionId || !userId) {
    return badRequest(res, "Missing sessionId or userId (as query param)");
  }

  try {
    const CookingHistory = await getCookingHistoryModel();
    if (!CookingHistory) {
      return res.status(404).json({ ok: false, error: "History not available (no model)" });
    }
    const doc = await CookingHistory.findOne({ userId, sessionId }).exec();
    if (!doc) return res.status(404).json({ ok: false, error: "Not found" });
    return res.json({ ok: true, data: doc });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/* -----------------------------------------------------------------------------
   (Optional) Endpoint to proxy a direct socket notice from trusted automations
   POST /api/cooking/notice { userId, message }
----------------------------------------------------------------------------- */
router.post("/notice", express.json(), async (req, res) => {
  const { userId, message } = req.body || {};
  if (!userId || !message) return badRequest(res, "userId and message are required");
  emitToUser(userId, "NOTICE", { message });
  return res.json({ ok: true });
});

export default router;

/* -----------------------------------------------------------------------------
   Example: wire this controller in your express app (src/server/index.js)
   -----------------------------------------------------------------------------
   import cookingController from "./controllers/cookingController.js";
   app.use("/api/cooking", cookingController);
----------------------------------------------------------------------------- */
