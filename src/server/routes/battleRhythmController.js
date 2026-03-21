import express from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { authenticateRequest } = require("../middleware/realtime/authenticateRequest.js");
const {
  requireHouseholdAccessPolicy,
  requireCollaborationPolicy,
  requireEntitlementPolicy,
} = require("../middleware/accessPolicy.js");

import {
  getUserBattleRhythm,
  saveUserBattleRhythm,
  listRecipeCustomizations,
  upsertRecipeCustomization,
  deleteRecipeCustomization,
} from "../services/battleRhythmService.js";

const router = express.Router();
router.use(authenticateRequest);
router.use(requireHouseholdAccessPolicy());
router.use(requireCollaborationPolicy({ moduleKey: "battle-rhythm" }));
router.use(requireEntitlementPolicy({ feature: "planner.base" }));

const ajv = new Ajv({ allErrors: true, removeAdditional: "failing", strict: false });
addFormats(ajv);

const userSchema = {
  type: "object",
  required: ["userId"],
  properties: { userId: { type: "string", minLength: 1 } },
  additionalProperties: true,
};

const profileSchema = {
  type: "object",
  required: ["userId", "profile"],
  properties: {
    userId: { type: "string", minLength: 1 },
    profile: { type: "object" },
  },
  additionalProperties: true,
};

const customizationSchema = {
  type: "object",
  required: ["userId", "override"],
  properties: {
    userId: { type: "string", minLength: 1 },
    recipeId: { type: "string" },
    fingerprint: { type: "string" },
    override: { type: "object" },
  },
  additionalProperties: true,
};

const customizationDeleteSchema = {
  type: "object",
  required: ["userId"],
  properties: {
    userId: { type: "string", minLength: 1 },
    recipeId: { type: "string" },
    fingerprint: { type: "string" },
  },
  additionalProperties: true,
};

const resolveSchema = {
  type: "object",
  required: ["recipe"],
  properties: {
    userId: { type: "string" },
    recipe: { type: "object" },
    rhythm: { type: "object" },
    override: { type: "object" },
    context: { type: "object" },
    resolveServerSide: { type: "boolean" },
  },
  additionalProperties: true,
};

const validateUser = ajv.compile(userSchema);
const validateProfile = ajv.compile(profileSchema);
const validateCustomization = ajv.compile(customizationSchema);
const validateCustomizationDelete = ajv.compile(customizationDeleteSchema);
const validateResolve = ajv.compile(resolveSchema);

function badRequest(res, validate) {
  const msg = (validate?.errors || [])
    .map((e) => `${e.instancePath || "/"} ${e.message}`)
    .join("; ");
  return res.status(400).json({ ok: false, error: msg || "Invalid payload", details: validate?.errors || [] });
}

router.get("/health", (_req, res) => {
  res.json({ ok: true, service: "battleRhythmController" });
});

router.get("/profile", async (req, res) => {
  const payload = { userId: String(req.query.userId || "global") };
  if (!validateUser(payload)) return badRequest(res, validateUser);

  const profile = await getUserBattleRhythm(payload.userId);
  return res.json({ ok: true, userId: payload.userId, profile });
});

router.post("/profile", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateProfile(body)) return badRequest(res, validateProfile);

  const profile = await saveUserBattleRhythm(body.userId, body.profile || {});
  return res.json({ ok: true, userId: body.userId, profile });
});

router.get("/customizations", async (req, res) => {
  const payload = { userId: String(req.query.userId || "global") };
  if (!validateUser(payload)) return badRequest(res, validateUser);

  const items = await listRecipeCustomizations(payload.userId);
  return res.json({ ok: true, userId: payload.userId, items });
});

router.post("/customizations", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateCustomization(body)) return badRequest(res, validateCustomization);

  try {
    const item = await upsertRecipeCustomization(body);
    return res.json({ ok: true, item });
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
});

router.delete("/customizations", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateCustomizationDelete(body)) return badRequest(res, validateCustomizationDelete);

  const deleted = await deleteRecipeCustomization(body);
  return res.json({ ok: true, deleted });
});

router.post("/resolve", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateResolve(body)) return badRequest(res, validateResolve);

  const resolveServerSide = body.resolveServerSide !== false;
  if (!resolveServerSide) {
    return res.json({ ok: true, passthrough: true, recipe: body.recipe });
  }

  const resolver = await import("../../services/recipes/battleRhythmResolver.js");
  const applyBattleRhythm = resolver?.applyBattleRhythm || resolver?.default?.applyBattleRhythm;

  if (typeof applyBattleRhythm !== "function") {
    return res.status(501).json({ ok: false, error: "battle rhythm resolver unavailable" });
  }

  const profile = body.rhythm && typeof body.rhythm === "object"
    ? body.rhythm
    : await getUserBattleRhythm(body.userId || "global");

  const resolved = await applyBattleRhythm(
    body.recipe,
    profile,
    body.override || {},
    body.context || {}
  );

  return res.json({ ok: true, resolved });
});

export default router;
