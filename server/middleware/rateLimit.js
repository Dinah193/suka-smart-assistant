// server/middleware/rateLimit.js
// -----------------------------------------------------------------------------
// Tiny IP-based rate limiter (in-memory).
// Production note: for multi-instance deployments, use Redis.
// -----------------------------------------------------------------------------

function now() {
  return Date.now();
}

export function rateLimit({
  windowMs = 60_000,
  max = 60,
  keyFn = (req) => req.ip || req.headers["x-forwarded-for"] || "unknown",
} = {}) {
  const hits = new Map(); // key -> { count, resetAt }

  return function rateLimitMiddleware(req, res, next) {
    try {
      const key = String(keyFn(req) || "unknown");
      const t = now();

      let rec = hits.get(key);
      if (!rec || t > rec.resetAt) {
        rec = { count: 0, resetAt: t + windowMs };
        hits.set(key, rec);
      }

      rec.count += 1;

      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader(
        "X-RateLimit-Remaining",
        String(Math.max(0, max - rec.count))
      );
      res.setHeader("X-RateLimit-Reset", String(rec.resetAt));

      if (rec.count > max) {
        res.status(429).json({
          status: "RATE_LIMITED",
          error: { message: "Too many requests. Please slow down." },
        });
        return;
      }

      next();
    } catch (e) {
      next(e);
    }
  };
}
