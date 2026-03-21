import express from "express";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import {
  createNativeAccount,
  signInNative,
  requestPasswordReset,
  resetPassword,
  getHubAuthorizationUrl,
  handleHubCallback,
  getCurrentSession,
  refreshSession,
  revokeSession,
  bootstrapHouseholdMembership,
} from "../services/authService.js";

const router = express.Router();

const ajv = new Ajv({ allErrors: true, removeAdditional: "failing", strict: false });
addFormats(ajv);

const loginSchema = {
  type: "object",
  required: ["email", "password"],
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 1 },
    rememberMe: { type: "boolean" },
  },
  additionalProperties: true,
};

const registerSchema = {
  type: "object",
  required: ["firstName", "lastName", "email", "password", "confirmPassword", "consent"],
  properties: {
    firstName: { type: "string", minLength: 1 },
    lastName: { type: "string", minLength: 1 },
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 10 },
    confirmPassword: { type: "string", minLength: 1 },
    consent: { type: "boolean" },
  },
  additionalProperties: true,
};

const forgotPasswordSchema = {
  type: "object",
  required: ["email"],
  properties: {
    email: { type: "string", format: "email" },
  },
  additionalProperties: true,
};

const resetPasswordSchema = {
  type: "object",
  required: ["token", "password", "confirmPassword"],
  properties: {
    token: { type: "string", minLength: 1 },
    password: { type: "string", minLength: 10 },
    confirmPassword: { type: "string", minLength: 1 },
  },
  additionalProperties: true,
};

const validateLogin = ajv.compile(loginSchema);
const validateRegister = ajv.compile(registerSchema);
const validateForgotPassword = ajv.compile(forgotPasswordSchema);
const validateResetPassword = ajv.compile(resetPasswordSchema);

function validationError(validate) {
  const details = validate?.errors || [];
  const error = details
    .map((issue) => `${issue.instancePath || "/"} ${issue.message}`)
    .join("; ");
  return {
    ok: false,
    error: error || "invalid_payload",
    details,
  };
}

function readAuthTokens(req) {
  const tokenHeader = req.headers.authorization || req.headers["x-auth-token"] || "";
  const token = String(tokenHeader).replace(/^Bearer\s+/i, "").trim();
  const sessionToken = req.cookies?.session || "";
  return { token, sessionToken };
}

router.get("/health", (_req, res) => {
  res.json({ ok: true, service: "authController", scaffold: true });
});

async function handleLogin(req, res) {
  const body = req.body || {};
  if (!validateLogin(body)) {
    return res.status(400).json(validationError(validateLogin));
  }

  try {
    const result = await signInNative(body);
    return res.status(200).json(result);
  } catch (err) {
    const error = String(err?.message || err);
    if (error === "invalid_credentials") {
      return res.status(401).json({ ok: false, error });
    }
    return res.status(400).json({ ok: false, error });
  }
}

router.post("/login", express.json(), handleLogin);
router.post("/signin", express.json(), handleLogin);

async function handleRegister(req, res) {
  const body = req.body || {};
  if (!validateRegister(body)) {
    return res.status(400).json(validationError(validateRegister));
  }

  if (body.password !== body.confirmPassword) {
    return res.status(400).json({ ok: false, error: "password_mismatch" });
  }
  if (!body.consent) {
    return res.status(400).json({ ok: false, error: "consent_required" });
  }

  try {
    const result = await createNativeAccount(body);
    return res.status(201).json(result);
  } catch (err) {
    const error = String(err?.message || err);
    if (error === "account_exists") {
      return res.status(409).json({ ok: false, error });
    }
    return res.status(400).json({ ok: false, error });
  }
}

router.post("/register", express.json(), handleRegister);
router.post("/signup", express.json(), handleRegister);

router.get("/me", async (req, res) => {
  const result = await getCurrentSession(readAuthTokens(req));
  if (!result.ok) {
    return res.status(401).json(result);
  }
  return res.status(200).json(result);
});

router.post("/session/refresh", async (req, res) => {
  const result = await refreshSession(readAuthTokens(req));
  if (!result.ok) {
    return res.status(401).json(result);
  }
  return res.status(200).json(result);
});

router.post("/logout", async (req, res) => {
  const result = revokeSession(readAuthTokens(req));
  if (typeof res.clearCookie === "function") {
    res.clearCookie("session", { path: "/" });
  }
  return res.status(200).json(result);
});

router.post("/household/bootstrap", express.json(), async (req, res) => {
  const body = req.body || {};
  const result = await bootstrapHouseholdMembership({
    ...readAuthTokens(req),
    householdId: body.householdId,
    householdName: body.householdName,
  });
  if (!result.ok) {
    if (result.error === "household_membership_locked") {
      return res.status(409).json(result);
    }
    return res.status(401).json(result);
  }
  return res.status(200).json(result);
});

router.post("/forgot-password", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateForgotPassword(body)) {
    return res.status(400).json(validationError(validateForgotPassword));
  }

  try {
    const result = await requestPasswordReset(body);
    return res.status(200).json(result);
  } catch (err) {
    return res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
});

router.post("/reset-password", express.json(), async (req, res) => {
  const body = req.body || {};
  if (!validateResetPassword(body)) {
    return res.status(400).json(validationError(validateResetPassword));
  }

  if (body.password !== body.confirmPassword) {
    return res.status(400).json({ ok: false, error: "password_mismatch" });
  }

  const result = await resetPassword(body);
  if (!result.ok) {
    return res.status(400).json(result);
  }
  return res.status(200).json(result);
});

router.get("/hub/start", async (req, res) => {
  const returnTo = typeof req.query.returnTo === "string" ? req.query.returnTo : "/";
  const hub = getHubAuthorizationUrl({ returnTo });

  if (!hub.configured) {
    return res.redirect(302, hub.fallbackUrl);
  }

  return res.redirect(302, hub.url);
});

router.get("/hub/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const result = handleHubCallback({ code, state });
  return res.redirect(302, result.redirectTo);
});

export default router;