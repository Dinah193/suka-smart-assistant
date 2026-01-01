// C:\Users\larho\suka-smart-assistant\src\server\middleware\verifyN8nSignature.js
//
// Verify that an inbound HTTP request really came from *your n8n workflows*.
// Usage: mount on callback routes that n8n calls (e.g., /api/cooking/*).
//
// ✦ How it works
// - Expects HMAC-SHA256 signature of "<timestamp>.<rawBody>" in X-N8N-Signature
// - Expects X-Suka-Timestamp header (ms epoch) to prevent replay
// - Compares using timingSafeEqual
// - Optional in-memory nonce cache (X-Suka-Nonce) to reject replays within window
//
// Env vars:
//   N8N_INBOUND_SECRET     (fallback: N8N_SHARED_SECRET)  → required in production
//   N8N_SIGNATURE_HEADER   (default: "x-n8n-signature")
//   N8N_TIMESTAMP_HEADER   (default: "x-suka-timestamp")
//   N8N_NONCE_HEADER       (default: "x-suka-nonce")
//   N8N_SIG_TOLERANCE_SEC  (default: "300")  // 5 minutes
//   SIGNATURE_ALGO         (default: "sha256")
//
// IMPORTANT: You must use a raw body parser on these routes to preserve body bytes.
// Example wiring is at the bottom of this file.
//

import crypto from "crypto";

const SIG_HEADER = (process.env.N8N_SIGNATURE_HEADER || "x-n8n-signature").toLowerCase();
const TS_HEADER  = (process.env.N8N_TIMESTAMP_HEADER || "x-suka-timestamp").toLowerCase();
const NONCE_H    = (process.env.N8N_NONCE_HEADER || "x-suka-nonce").toLowerCase();
const HMAC_ALGO  = process.env.SIGNATURE_ALGO || "sha256";
const TOLERANCE  = Number(process.env.N8N_SIG_TOLERANCE_SEC || 300); // seconds

const SECRET = process.env.N8N_INBOUND_SECRET || process.env.N8N_SHARED_SECRET;

if (!SECRET) {
  console.warn("[verifyN8nSignature] Warning: N8N_INBOUND_SECRET/N8N_SHARED_SECRET not set; requests won't be verified.");
}

/** Re-play protection (simple in-memory nonce cache with TTL) */
const nonceCache = new Map(); // key: `${ts}:${nonce}`, val: expiresAt (ms)
const CLEAN_EVERY_MS = 60_000;
let lastClean = Date.now();

function cleanupNonces() {
  const now = Date.now();
  if (now - lastClean < CLEAN_EVERY_MS) return;
  for (const [k, exp] of nonceCache) {
    if (exp <= now) nonceCache.delete(k);
  }
  lastClean = now;
}

function rememberNonce(ts, nonce) {
  if (!nonce) return true; // nonce optional
  cleanupNonces();
  const key = `${ts}:${nonce}`;
  if (nonceCache.has(key)) return false; // replay
  const exp = Date.now() + TOLERANCE * 1000;
  nonceCache.set(key, exp);
  return true;
}

/** Get raw body string for signing */
function getRawBody(req) {
  if (req.rawBody && typeof req.rawBody === "string") return req.rawBody;
  if (req.rawBody && Buffer.isBuffer(req.rawBody)) return req.rawBody.toString("utf8");
  if (typeof req.body === "string") return req.body;
  try { return JSON.stringify(req.body); } catch { return ""; }
}

/** Build signing string "<timestamp>.<rawBody>" */
function signingString(ts, raw) {
  return `${ts}.${raw}`;
}

/** Compute HMAC hex digest */
function computeHmac(str) {
  return crypto.createHmac(HMAC_ALGO, SECRET).update(str, "utf8").digest("hex");
}

/**
 * Express middleware to verify requests from n8n.
 * Fails with 401 on missing/invalid signature or stale timestamp.
 */
export function verifyN8nSignature(req, res, next) {
  if (!SECRET) return next(); // dev fallback; do not do this in prod

  const sigProvided = String(req.headers[SIG_HEADER] || "").trim().toLowerCase();
  const tsHeader = String(req.headers[TS_HEADER] || "").trim();
  const nonce = String(req.headers[NONCE_H] || "").trim();

  if (!sigProvided) {
    return res.status(401).json({ ok: false, error: `Missing ${SIG_HEADER} header` });
  }
  if (!tsHeader) {
    return res.status(401).json({ ok: false, error: `Missing ${TS_HEADER} header` });
  }

  // Timestamp freshness check
  const tsNum = Number(tsHeader);
  if (!Number.isFinite(tsNum)) {
    return res.status(401).json({ ok: false, error: "Invalid timestamp" });
  }
  const now = Date.now();
  if (Math.abs(now - tsNum) > TOLERANCE * 1000) {
    return res.status(401).json({ ok: false, error: "Stale or future timestamp" });
  }

  // Replay protection via nonce
  if (!rememberNonce(tsHeader, nonce)) {
    return res.status(401).json({ ok: false, error: "Replay detected" });
  }

  const raw = getRawBody(req);
  const signed = signingString(tsHeader, raw);
  const expected = computeHmac(signed);

  // timing-safe compare
  const valid = (() => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sigProvided), Buffer.from(expected));
    } catch {
      return false;
    }
  })();

  if (!valid) {
    return res.status(401).json({
      ok: false,
      error: "Invalid signature",
      details: process.env.NODE_ENV === "development" ? { expected } : undefined,
    });
  }

  return next();
}

/**
 * Factory variant if you need per-tenant/per-workflow secrets.
 * Example: app.use("/api/callbacks/:tenant", createN8nVerifier(tenantSecret), handler)
 */
export function createN8nVerifier(secret) {
  return function verifier(req, res, next) {
    const sigProvided = String(req.headers[SIG_HEADER] || "").trim().toLowerCase();
    const tsHeader = String(req.headers[TS_HEADER] || "").trim();
    const nonce = String(req.headers[NONCE_H] || "").trim();

    if (!secret) return res.status(500).json({ ok: false, error: "Missing verifier secret" });
    if (!sigProvided) return res.status(401).json({ ok: false, error: `Missing ${SIG_HEADER} header` });
    if (!tsHeader) return res.status(401).json({ ok: false, error: `Missing ${TS_HEADER} header` });

    const tsNum = Number(tsHeader);
    if (!Number.isFinite(tsNum) || Math.abs(Date.now() - tsNum) > TOLERANCE * 1000) {
      return res.status(401).json({ ok: false, error: "Stale or invalid timestamp" });
    }
    if (!rememberNonce(tsHeader, nonce)) {
      return res.status(401).json({ ok: false, error: "Replay detected" });
    }

    const raw = getRawBody(req);
    const signed = `${tsHeader}.${raw}`;
    const expected = crypto.createHmac(HMAC_ALGO, secret).update(signed, "utf8").digest("hex");

    const ok = (() => {
      try { return crypto.timingSafeEqual(Buffer.from(sigProvided), Buffer.from(expected)); }
      catch { return false; }
    })();

    if (!ok) return res.status(401).json({ ok: false, error: "Invalid signature" });
    return next();
  };
}
