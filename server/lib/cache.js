// server/lib/cache.js
// -----------------------------------------------------------------------------
// Tiny TTL cache (in-memory).
// Production note: swap with Redis or a shared cache.
// -----------------------------------------------------------------------------

function now() {
  return Date.now();
}

export default class TTLCache {
  constructor({ ttlMs = 300_000, maxEntries = 2000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map(); // key -> { value, expiresAt }
  }

  get(key) {
    const k = String(key);
    const rec = this.map.get(k);
    if (!rec) return null;
    if (now() > rec.expiresAt) {
      this.map.delete(k);
      return null;
    }
    return rec.value;
  }

  set(key, value, ttlMs = null) {
    const k = String(key);
    const ttl = Number.isFinite(ttlMs) ? ttlMs : this.ttlMs;

    if (this.map.size >= this.maxEntries) {
      // naive eviction: delete first
      const first = this.map.keys().next().value;
      if (first) this.map.delete(first);
    }

    this.map.set(k, { value, expiresAt: now() + ttl });
    return value;
  }
}
