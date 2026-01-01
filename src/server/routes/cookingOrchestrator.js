// C:\Users\larho\suka-smart-assistant\src\server\routes\cookingOrchestrator.js
//
// Suka Smart Assistant — Cooking Orchestrator Route
//
// Exposes secure cooking webhooks (step start/reminder/end/history).
// - Preserves raw JSON bytes for HMAC verification
// - Verifies signature + timestamp + nonce (anti-replay)
// - Enforces simple rate limit
// - De-dupes by Idempotency-Key / eventId
// - Delegates trusted traffic to cookingController
//
// Mount in server entry:
//   import cookingOrchestrator from "./routes/cookingOrchestrator.js";
//   app.use("/api/cooking", cookingOrchestrator);
//
// Env (defaults shown):
//   N8N_INBOUND_SECRET / N8N_SHARED_SECRET
//   N8N_SIGNATURE_HEADER   = x-n8n-signature
//   N8N_TIMESTAMP_HEADER   = x-suka-timestamp
//   N8N_NONCE_HEADER       = x-suka-nonce
//   N8N_ALLOWED_DRIFT_SEC  = 300
//   COOKING_RATE_LIMIT_IP  = 120   (tokens per 5m)
//

import express from "express";
import bodyParser from "body-parser";
import crypto from "crypto";

let verifyN8nSignature = null;
try {
  // Optional custom middleware; if not present, we use a local verifier below.
  ({ verifyN8nSignature } = await import("../middleware/verifyN8nSignature.js"));
} catch { /* fallback below */ }

import cookingController from "../controllers/cookingController.js";

const router = express.Router();

/* -----------------------------------------------------------------------------
 * Config & in-memory stores
 * -------------------------------------------------------------------------- */
const SIG_HDR = (process.env.N8N_SIGNATURE_HEADER || "x-n8n-signature").toLowerCase();
const TS_HDR  = (process.env.N8N_TIMESTAMP_HEADER || "x-suka-timestamp").toLowerCase();
const NONCE_HDR = (process.env.N8N_NONCE_HEADER || "x-suka-nonce").toLowerCase();
const DRIFT_SEC = Number(process.env.N8N_ALLOWED_DRIFT_SEC || 300); // 5 min

const RATE_LIMIT_TOKENS = Number(process.env.COOKING_RATE_LIMIT_IP || 120); // per window
const RATE_WINDOW_MS = 5 * 60 * 1000;

// very small, in-proc stores (ok for single instance; swap for Redis when clustered)
const nonceCache = new Map();            // nonce -> expiresAt(ms)
const idemCache = new Map();             // key -> expiresAt(ms)
const rateBuckets = new Map();           // ip -> { tokens, refillAt }

/* -----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */
const now = () => Date.now();
const toISO = (x) => new Date(x).toISOString();

function pruneMap(m) {
  const t = now();
  for (const [k, v] of m.entries()) if (v <= t) m.delete(k);
}

function getHeader(req, name) {
  const v = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

// Very small per-IP token bucket (refills fully every window)
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const bucket = rateBuckets.get(ip) || { tokens: RATE_LIMIT_TOKENS, refillAt: now() + RATE_WINDOW_MS };
  const t = now();
  if (t >= bucket.refillAt) {
    bucket.tokens = RATE_LIMIT_TOKENS;
    bucket.refillAt = t + RATE_WINDOW_MS;
  }
  if (bucket.tokens <= 0) {
    return res.status(429).json({ ok: false, error: "Rate limit exceeded. Try again shortly." });
  }
  bucket.tokens -= 1;
  rateBuckets.set(ip, bucket);
  return next();
}

// Fallback HMAC verifier (raw body string)
function localVerifySignature(req, res, next) {
  const secret = process.env.N8N_INBOUND_SECRET || process.env.N8N_SHARED_SECRET;
  if (!secret) {
    return res.status(501).json({ ok: false, error: "Inbound secret missing. Set N8N_INBOUND_SECRET." });
  }

  const signature = getHeader(req, SIG_HDR);
  const ts = getHeader(req, TS_HDR);
  const nonce = getHeader(req, NONCE_HDR);

  if (!signature || !ts || !nonce) {
    return res.status(400).json({ ok: false, error: "Missing signature/timestamp/nonce headers." });
  }

  // anti-replay: timestamp window
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now() - tsNum) > DRIFT_SEC * 1000) {
    return res.status(400).json({ ok: false, error: "Timestamp outside allowed window." });
  }

  // anti-replay: nonce single-use
  pruneMap(nonceCache);
  if (nonceCache.has(nonce)) {
    return res.status(409).json({ ok: false, error: "Replay detected (nonce already used)." });
  }

  const raw = req.rawBody || "";
  // canonical string: timestamp + "." + nonce + "." + raw
  const msg = `${ts}.${nonce}.${raw}`;
  const expected = crypto.createHmac("sha256", secret).update(msg).digest("hex");

  if (expected !== signature) {
    return res.status(401).json({ ok: false, error: "Invalid signature." });
  }

  // mark nonce for reuse protection
  nonceCache.set(nonce, now() + DRIFT_SEC * 1000);
  return next();
}

// Idempotency: reject duplicates by Idempotency-Key header or body.eventId
function idempotencyGuard(req, res, next) {
  pruneMap(idemCache);
  const headerKey = getHeader(req, "idempotency-key");
  const bodyKey = (() => {
    try {
      // body is parsed later; we can peek raw JSON safely here
      const parsed = req.body && Object.keys(req.body).length ? req.body : JSON.parse(req.rawBody || "{}");
      return parsed?.eventId || parsed?.id || null;
    } catch { return null; }
  })();

  const key = headerKey || bodyKey;
  if (!key) return next();

  const exists = idemCache.get(key);
  if (exists && exists > now()) {
    return res.status(208).json({ ok: true, duplicate: true, note: "Duplicate event ignored by idempotency guard." });
  }
  idemCache.set(key, now() + 10 * 60 * 1000); // 10 minutes
  return next();
}

/* -----------------------------------------------------------------------------
 * 1) Raw JSON parser (preserve exact bytes for HMAC verification)
 * -------------------------------------------------------------------------- */
const rawJson = bodyParser.json({
  limit: "512kb",
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString("utf8"); // keep original bytes for HMAC
  },
});

/* -----------------------------------------------------------------------------
 * 2) Security chain (rate limit → signature → idempotency)
 *    If your project supplies verifyN8nSignature, we use it; otherwise fallback.
 * -------------------------------------------------------------------------- */
const signatureMiddleware = verifyN8nSignature
  ? (req, res, next) => verifyN8nSignature(req, res, next)
  : localVerifySignature;

// All cooking webhooks flow through this chain, then into cookingController
router.use(rateLimit, rawJson, signatureMiddleware, idempotencyGuard, cookingController);

/* -----------------------------------------------------------------------------
 * 3) Health + dev helpers (NO signature required)
 * -------------------------------------------------------------------------- */
router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    ts: toISO(Date.now()),
    sigHeader: SIG_HDR,
    tsHeader: TS_HDR,
    nonceHeader: NONCE_HDR,
    driftSec: DRIFT_SEC,
    rateLimitPerWindow: RATE_LIMIT_TOKENS,
    windowMs: RATE_WINDOW_MS,
    secureChain: !!verifyN8nSignature ? "custom-middleware" : "local-hmac",
  });
});

// Development-only echo (disabled in production)
if (process.env.NODE_ENV !== "production") {
  router.post("/dev/echo", express.json(), (req, res) => {
    return res.json({
      ok: true,
      note: "Local testing only. In production, requests must be n8n-signed.",
      body: req.body,
    });
  });
}

export default router;
