// C:\Users\larho\suka-smart-assistant\src\server\middleware\verifyAppSignature.js
//
// Middleware to verify inbound requests from trusted automation sources (e.g., n8n)
//
// Uses HMAC-SHA256 over the raw JSON body string, compared against the
// X-Suka-Signature header sent with the request.
//
// Env vars required:
//   N8N_SHARED_SECRET   - shared string with n8n (must match in workflows + app env)
// Optional env vars:
//   SIGNATURE_HEADER    - defaults to 'x-suka-signature'
//   SIGNATURE_ALGO      - defaults to 'sha256'
//
// Usage:
//   import { verifyAppSignature } from "./middleware/verifyAppSignature.js";
//   app.post("/api/cooking/notify-step-started", verifyAppSignature, controllerFn);
//
// Important: must run *before* any body parser that mutates req.body.
// For Express: use a raw body parser for this route or mount globally with raw json.
//

import crypto from "crypto";

// Header name & algorithm (customizable via env)
const HEADER_NAME = (process.env.SIGNATURE_HEADER || "x-suka-signature").toLowerCase();
const HMAC_ALGO = process.env.SIGNATURE_ALGO || "sha256";

const SHARED_SECRET = process.env.N8N_SHARED_SECRET;
if (!SHARED_SECRET) {
  console.warn("[verifyAppSignature] Warning: N8N_SHARED_SECRET is not set; all requests will pass.");
}

/**
 * Get the raw body string for signing.
 * We rely on req.rawBody being set by a raw body parser, or reconstruct from req.body if it's still a string.
 */
function getRawBody(req) {
  if (req.rawBody && typeof req.rawBody === "string") return req.rawBody;
  if (req.rawBody && Buffer.isBuffer(req.rawBody)) return req.rawBody.toString("utf8");
  if (typeof req.body === "string") return req.body;
  try {
    return JSON.stringify(req.body);
  } catch {
    return "";
  }
}

/**
 * Compute HMAC hex digest.
 */
function computeSignature(bodyString) {
  return crypto.createHmac(HMAC_ALGO, SHARED_SECRET)
    .update(bodyString, "utf8")
    .digest("hex");
}

/**
 * Express middleware to verify app/n8n HMAC signature.
 * If SHARED_SECRET is missing, logs warning and calls next().
 */
export function verifyAppSignature(req, res, next) {
  if (!SHARED_SECRET) {
    return next();
  }

  const provided = String(req.headers[HEADER_NAME] || "").trim().toLowerCase();
  if (!provided) {
    return res.status(401).json({ ok: false, error: `Missing ${HEADER_NAME} header` });
  }

  const rawBody = getRawBody(req);
  const expected = computeSignature(rawBody);

  // Use timingSafeEqual to prevent timing attacks
  const valid = (() => {
    try {
      return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
    } catch {
      return false;
    }
  })();

  if (!valid) {
    return res.status(401).json({
      ok: false,
      error: "Invalid signature",
      details: process.env.NODE_ENV === "development" ? { provided, expected } : undefined,
    });
  }

  return next();
}

/**
 * Optional: factory for per-secret verification (multi-tenant / multiple sources)
 */
export function createSignatureVerifier(secret) {
  return function verifier(req, res, next) {
    const provided = String(req.headers[HEADER_NAME] || "").trim().toLowerCase();
    if (!provided) {
      return res.status(401).json({ ok: false, error: `Missing ${HEADER_NAME} header` });
    }
    const rawBody = getRawBody(req);
    const expected = crypto.createHmac(HMAC_ALGO, secret)
      .update(rawBody, "utf8")
      .digest("hex");
    const valid = (() => {
      try {
        return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
      } catch {
        return false;
      }
    })();
    if (!valid) {
      return res.status(401).json({ ok: false, error: "Invalid signature" });
    }
    return next();
  };
}

/* -----------------------------------------------------------------------------
   Example: mounting with raw body parser for JSON
   (ensures req.rawBody is available and not modified before verification)
   -----------------------------------------------------------------------------

   import bodyParser from "body-parser";
   import { verifyAppSignature } from "./middleware/verifyAppSignature.js";

   // Raw parser that stores raw body string
   const rawJson = bodyParser.json({
     verify: (req, res, buf) => { req.rawBody = buf.toString(); }
   });

   app.post("/api/cooking/notify-step-started", rawJson, verifyAppSignature, controllerFn);

----------------------------------------------------------------------------- */
