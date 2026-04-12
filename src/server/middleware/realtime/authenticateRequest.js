"use strict";

const path = require("path");

async function loadAny(modulePath) {
  try {
    const mod = require(modulePath);
    return mod && mod.__esModule ? mod.default || mod : mod;
  } catch (e1) {
    try {
      const full = path.isAbsolute(modulePath) ? modulePath : path.resolve(__dirname, modulePath);
      const url = `file://${full.replace(/\\/g, "/")}`;
      const mod = await import(url);
      return mod && (mod.default || mod);
    } catch {
      throw e1;
    }
  }
}

async function authenticateRequest(req, res, next) {
  try {
    const authUser = req.user || req.auth || null;
    if (authUser?.id || authUser?.userId) {
      req.user = {
        id: authUser.id || authUser.userId,
        homeId: authUser.homeId || authUser.householdId || null,
        familyId: authUser.familyId || null,
        roles: authUser.roles || [],
      };
      return next();
    }

    const tokenHeader = req.headers.authorization || req.headers["x-auth-token"] || "";
    const token = String(tokenHeader).replace(/^Bearer\s+/i, "").trim();
    const sessionToken = req.cookies?.ssa_session || req.cookies?.session || null;

    try {
      const auth = await loadAny("../../services/authService.js");
      if (auth?.verifyHttpRequest) {
        const verified = await auth.verifyHttpRequest({ token, sessionToken, headers: req.headers });
        if (verified?.ok) {
          req.user = {
            id: verified.userId,
            homeId: verified.homeId || null,
            familyId: verified.familyId || null,
            roles: verified.roles || [],
          };
          return next();
        }
      }
      if (auth?.verifySocketToken && token) {
        const verified = await auth.verifySocketToken(token, {});
        if (verified?.ok) {
          req.user = {
            id: verified.userId,
            homeId: verified.homeId || null,
            familyId: verified.familyId || null,
            roles: verified.roles || [],
          };
          return next();
        }
      }
    } catch {
      // Legacy fallback below keeps current integrations working when authService is absent.
    }

    const insecureHeaderAuthAllowed =
      String(process.env.ALLOW_INSECURE_HEADER_AUTH || "")
        .toLowerCase() === "true";

    const fallbackUserId = req.headers["x-user-id"];
    if (insecureHeaderAuthAllowed && fallbackUserId) {
      req.user = {
        id: String(fallbackUserId),
        homeId: req.headers["x-home-id"] ? String(req.headers["x-home-id"]) : null,
        familyId: req.headers["x-family-id"] ? String(req.headers["x-family-id"]) : null,
        roles: String(req.headers["x-roles"] || "")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      };
      return next();
    }

    const host = String(req?.hostname || req?.headers?.host || "").split(":")[0].toLowerCase();
    const localHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
    const localBypassEnabled =
      String(process.env.NODE_ENV || "").toLowerCase() !== "production" &&
      String(process.env.SSA_DEV_AUTH_BYPASS || "").toLowerCase() === "true";

    if (localHost && localBypassEnabled) {
      req.user = {
        id: "dev-local-user",
        homeId: "default-household",
        familyId: null,
        roles: ["owner", "admin"],
      };
      return next();
    }

    return res.status(401).json({ ok: false, error: "unauthorized" });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  authenticateRequest,
};
