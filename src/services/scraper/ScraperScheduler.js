// C:\Users\larho\suka-smart-assistant\src\services\scraper\ScraperScheduler.js
/**
 * ScraperScheduler — central controller for scraping cadence
 * --------------------------------------------------------------------
 * ROLE IN PIPELINE
 * imports (fetch/scrape) → intelligence (normalize/enrich) → automation (emit events)
 * → (optional) hub export (only for state-changing flows; scheduler itself does not mutate).
 *
 * WHAT THIS FILE DOES
 * - Queues URLs to be scraped and controls concurrency, per-host throttling, and retry backoff.
 * - Respects robots.txt (per-userAgent rules) with in-memory caching and TTL.
 * - Emits eventBus notifications for lifecycle events with payload { type, ts, source, data }.
 * - Provides extension points to:
 *    • override per-domain rates
 *    • plug custom “shouldSchedule(url)” guards
 *    • register after-scrape observers
 *
 * WHAT THIS FILE DOES *NOT* DO
 * - It does not change household data directly; it orchestrates ScraperEngine.scrape().
 *   Therefore, we DO NOT call exportToHubIfEnabled() here by default.
 *
 * EVENTS EMITTED
 * - scrape.schedule.added        { url, priority }
 * - scrape.schedule.skipped      { url, reason }
 * - scrape.request.blocked       { url, reason: 'robots' }
 * - scrape.request.throttled     { url, host, delayMs }
 * - scrape.request.sent          { url }
 * - scrape.result.received       { url, status, type, durationMs }
 * - scrape.error                 { url, error }
 * - scrape.scheduler.idle        {}
 */

import eventBus from "../events/eventBus.js";

// Soft imports (optional). If missing, features degrade gracefully.
let featureFlags = { familyFundMode: false };
let HubPacketFormatter = null;
let FamilyFundConnector = null;
let ScraperEngine = null;

(async () => {
  try {
    const mod = await import("@/config/featureFlags.json");
    featureFlags = mod.default || mod || featureFlags;
  } catch {}
  try {
    const mod = await import("@/services/hub/HubPacketFormatter.js");
    HubPacketFormatter = mod.default || mod;
  } catch {}
  try {
    const mod = await import("@/services/hub/FamilyFundConnector.js");
    FamilyFundConnector = mod.default || mod;
  } catch {}
  try {
    const mod = await import("./ScraperEngine.js");
    ScraperEngine = mod.default || mod;
  } catch {}
})();

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

const SOURCE = "ScraperScheduler";
const nowISO = () => new Date().toISOString();
const emit = (type, data) =>
  eventBus.emit({ type, ts: nowISO(), source: SOURCE, data });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tryParseURL(u) {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function safeHostname(u) {
  const url = tryParseURL(u);
  return url ? url.hostname.toLowerCase() : "";
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/**
 * Optional Hub export helper (not used by this file by default).
 * Kept here for future state-changing scheduler variants.
 */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    // silent by design
  }
}

/* -------------------------------------------------------------------------- */
/* Robots.txt cache + evaluator                                               */
/* -------------------------------------------------------------------------- */

/**
 * Very small robots.txt evaluator (Disallow/Allow for specific user-agent).
 * - Caches per-host directives for robotsTtlMs (default 24h).
 * - Checks a single userAgent token (config.userAgent).
 * - Ignores Crawl-delay (throttling is handled separately).
 */

const robotsCache = new Map(); // host -> { fetchedAt: ms, rules: Map<ua,{allow:[], disallow:[]}> }

function parseRobotsTxt(text) {
  const lines = (text || "").split(/\r?\n/);
  const groups = [];
  let current = { userAgents: [], allow: [], disallow: [] };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [k0, ...rest] = line.split(":");
    if (!k0 || rest.length === 0) continue;
    const key = k0.trim().toLowerCase();
    const val = rest.join(":").trim();

    if (key === "user-agent") {
      // start a new group if the previous has content
      if (
        current.userAgents.length ||
        current.allow.length ||
        current.disallow.length
      ) {
        groups.push(current);
        current = { userAgents: [], allow: [], disallow: [] };
      }
      current.userAgents.push(val.toLowerCase());
    } else if (key === "allow") {
      current.allow.push(val);
    } else if (key === "disallow") {
      current.disallow.push(val);
    } // ignore others for simplicity
  }
  groups.push(current);

  // reduce to map of UA -> rules
  const rules = new Map();
  for (const g of groups) {
    for (const ua of g.userAgents.length ? g.userAgents : ["*"]) {
      const prev = rules.get(ua) || { allow: [], disallow: [] };
      rules.set(ua, {
        allow: prev.allow.concat(g.allow || []),
        disallow: prev.disallow.concat(g.disallow || []),
      });
    }
  }
  return rules;
}

function pathMatchesRule(pathname, rule) {
  if (!rule) return false;
  if (rule === "/") return true;
  // Basic prefix match per common robots semantics.
  return pathname.startsWith(rule);
}

function evaluateRobots(rulesMap, userAgent, path) {
  // Pick the most specific user-agent group; if none, use '*'
  const ua = (userAgent || "").toLowerCase();
  const uaRules = rulesMap.get(ua) ||
    rulesMap.get("*") || { allow: [], disallow: [] };

  // Longest rule wins between allow/disallow (simple approximation)
  const matches = [];
  for (const d of uaRules.disallow) {
    if (pathMatchesRule(path, d)) matches.push({ rule: d, type: "disallow" });
  }
  for (const a of uaRules.allow) {
    if (pathMatchesRule(path, a)) matches.push({ rule: a, type: "allow" });
  }
  if (!matches.length) return true;

  matches.sort((a, b) => b.rule.length - a.rule.length);
  return matches[0].type === "allow";
}

async function fetchRobots(host, fetchFn, proxy) {
  const url = `https://${host}/robots.txt`;
  const targetUrl = proxy ? `${proxy}${encodeURIComponent(url)}` : url;
  try {
    const res = await fetchFn(targetUrl, { method: "GET" });
    if (!res.ok) return null;
    const text = await res.text();
    return text;
  } catch {
    return null;
  }
}

async function canFetch(
  urlStr,
  { userAgent, robotsTtlMs = 24 * 60 * 60 * 1000, proxy } = {}
) {
  const u = tryParseURL(urlStr);
  if (!u) return true; // if malformed, let the scheduler reject separately

  const host = u.hostname.toLowerCase();
  const cached = robotsCache.get(host);
  const now = Date.now();

  // If cached and fresh, evaluate
  if (cached && now - cached.fetchedAt < robotsTtlMs) {
    return evaluateRobots(cached.rules, userAgent, u.pathname);
  }

  // Fetch robots
  const text = await fetchRobots(host, fetch, proxy);
  if (!text) {
    // If unreachable, be permissive
    robotsCache.set(host, {
      fetchedAt: now,
      rules: new Map([["*", { allow: [], disallow: [] }]]),
    });
    return true;
  }

  const rules = parseRobotsTxt(text);
  robotsCache.set(host, { fetchedAt: now, rules });
  return evaluateRobots(rules, userAgent, u.pathname);
}

/* -------------------------------------------------------------------------- */
/* Per-host token buckets (rate limiting)                                     */
/* -------------------------------------------------------------------------- */

/**
 * TokenBucket: simple per-host limiter (requests per minute with small burst).
 */
class TokenBucket {
  constructor({ ratePerMinute = 12, burst = 3 } = {}) {
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.refillPerMs = clamp(ratePerMinute, 1, 6000) / 60000; // tokens per ms
    this.last = Date.now();
  }

  _refill() {
    const now = Date.now();
    const delta = now - this.last;
    const add = delta * this.refillPerMs;
    if (add > 0) {
      this.tokens = clamp(this.tokens + add, 0, this.capacity);
      this.last = now;
    }
  }

  async takeOrDelay(maxWaitMs = 15000) {
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    // compute needed time for next token
    const missing = 1 - this.tokens;
    const ms = Math.ceil(missing / this.refillPerMs);
    const delay = clamp(ms, 50, maxWaitMs);
    await sleep(delay);
    this._refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return delay;
    }
    return delay; // best-effort, caller can proceed or re-check externally
  }
}

/* -------------------------------------------------------------------------- */
/* Priority queue                                                             */
/* -------------------------------------------------------------------------- */

class PriorityQueue {
  constructor() {
    this._arr = [];
  }
  push(item) {
    this._arr.push(item);
    this._arr.sort((a, b) => b.priority - a.priority || a.addedAt - b.addedAt);
  }
  shift() {
    return this._arr.shift();
  }
  remove(predicate) {
    const before = this._arr.length;
    this._arr = this._arr.filter((x) => !predicate(x));
    return before - this._arr.length;
  }
  get length() {
    return this._arr.length;
  }
  toArray() {
    return [...this._arr];
  }
}

/* -------------------------------------------------------------------------- */
/* ScraperScheduler                                                           */
/* -------------------------------------------------------------------------- */

const DEFAULTS = Object.freeze({
  userAgent: "SukaSmartAssistantBot/1.0 (+https://example.local)",
  concurrency: 2,
  maxRetries: 2,
  backoffBaseMs: 750, // exponential backoff multiplier
  maxBackoffMs: 30_000,
  robotsTtlMs: 24 * 60 * 60 * 1000,
  perHost: {
    ratePerMinute: 12,
    burst: 3,
  },
  allowListEnforced: false, // pass-through to ScraperEngine if desired
  proxy: undefined, // e.g., '/api/proxy?url=' for CORS bypass
});

export class ScraperScheduler {
  constructor(config = {}) {
    this.cfg = { ...DEFAULTS, ...config };
    this._queue = new PriorityQueue();
    this._working = 0;
    this._stopped = true;

    /** per-host token buckets */
    this._buckets = new Map(); // host -> TokenBucket

    /** per-host pause switches */
    this._pausedHosts = new Set();

    /** observers notified after each run result */
    this._observers = new Set();

    /** optional guard to decide if a URL should be scheduled */
    this._shouldSchedule = (url) => !!tryParseURL(url);
  }

  // ------------------------ public API -------------------------------------

  /**
   * Add a URL to the schedule queue.
   * @param {string} url
   * @param {object} opts { priority, headers, persist, metadata }
   */
  add(url, opts = {}) {
    if (!this._shouldSchedule(url)) {
      emit("scrape.schedule.skipped", { url, reason: "guard-reject" });
      return false;
    }
    const u = tryParseURL(url);
    if (!u) {
      emit("scrape.schedule.skipped", { url, reason: "malformed-url" });
      return false;
    }

    const task = {
      id: `${url}::${Date.now()}::${Math.random().toString(36).slice(2, 8)}`,
      url,
      host: u.hostname.toLowerCase(),
      priority: Number.isFinite(opts.priority) ? opts.priority : 0,
      headers: opts.headers || {},
      persist: !!opts.persist,
      metadata: opts.metadata || {},
      retries: 0,
      nextAt: Date.now(),
      addedAt: Date.now(),
    };
    this._queue.push(task);
    emit("scrape.schedule.added", { url, priority: task.priority });
    this._kick();
    return true;
  }

  addMany(items = []) {
    let count = 0;
    for (const it of items) {
      if (!it) continue;
      if (typeof it === "string") {
        if (this.add(it)) count++;
      } else if (it.url) {
        if (this.add(it.url, it)) count++;
      }
    }
    return count;
  }

  start() {
    this._stopped = false;
    this._kick();
  }

  stop() {
    this._stopped = true;
  }

  onResult(fn) {
    if (typeof fn === "function") this._observers.add(fn);
    return () => this._observers.delete(fn);
  }

  setShouldScheduleGuard(fn) {
    if (typeof fn === "function") this._shouldSchedule = fn;
  }

  setGlobalConcurrency(n) {
    this.cfg.concurrency = clamp(n | 0, 1, 16);
    this._kick();
  }

  setRateLimitForHost(host, { ratePerMinute, burst } = {}) {
    const h = (host || "").toLowerCase();
    if (!h) return;
    this._buckets.set(
      h,
      new TokenBucket({
        ratePerMinute: ratePerMinute ?? this.cfg.perHost.ratePerMinute,
        burst: burst ?? this.cfg.perHost.burst,
      })
    );
  }

  pauseHost(host) {
    if (host) this._pausedHosts.add(host.toLowerCase());
  }

  resumeHost(host) {
    if (host) this._pausedHosts.delete(host.toLowerCase());
    this._kick();
  }

  cancel(urlOrPredicate) {
    if (!urlOrPredicate) return 0;
    if (typeof urlOrPredicate === "function") {
      return this._queue.remove(urlOrPredicate);
    }
    const target = String(urlOrPredicate);
    return this._queue.remove((t) => t.url === target);
  }

  stats() {
    return {
      queued: this._queue.length,
      working: this._working,
      pausedHosts: [...this._pausedHosts],
      buckets: [...this._buckets.keys()],
      concurrency: this.cfg.concurrency,
    };
  }

  // ------------------------ internal runner --------------------------------

  _kick() {
    if (this._stopped) return;
    while (this._working < this.cfg.concurrency) {
      const next = this._dequeueRunnable();
      if (!next) break;
      this._runOne(next);
    }
    if (this._working === 0 && this._queue.length === 0) {
      emit("scrape.scheduler.idle", {});
    }
  }

  _dequeueRunnable() {
    const now = Date.now();
    // peek until we find runnable or nothing left
    const snapshot = this._queue.toArray();
    for (let i = 0; i < snapshot.length; i++) {
      const t = snapshot[i];
      if (t.nextAt > now) continue;
      if (this._pausedHosts.has(t.host)) continue;
      // remove and return
      this._queue.remove((x) => x.id === t.id);
      return t;
    }
    return null;
  }

  async _runOne(task) {
    this._working += 1;
    try {
      // robots.txt
      const allowed = await canFetch(task.url, {
        userAgent: this.cfg.userAgent,
        robotsTtlMs: this.cfg.robotsTtlMs,
        proxy: this.cfg.proxy,
      });
      if (!allowed) {
        emit("scrape.request.blocked", { url: task.url, reason: "robots" });
        this._working -= 1;
        this._kick();
        return;
      }

      // per-host rate limiting
      const bucket =
        this._buckets.get(task.host) || new TokenBucket(this.cfg.perHost);
      this._buckets.set(task.host, bucket);
      const delay = await bucket.takeOrDelay();
      if (delay > 0) {
        emit("scrape.request.throttled", {
          url: task.url,
          host: task.host,
          delayMs: delay,
        });
      }

      // perform scrape
      const started =
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();
      emit("scrape.request.sent", { url: task.url });

      if (!ScraperEngine || typeof ScraperEngine.scrape !== "function") {
        throw new Error("ScraperEngine not available");
      }

      const result = await ScraperEngine.scrape(task.url, {
        headers: task.headers,
        persist: task.persist,
        allowListEnforced: this.cfg.allowListEnforced,
        proxy: this.cfg.proxy,
      });

      const ended =
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : Date.now();
      const durationMs = ended - started;

      emit("scrape.result.received", {
        url: task.url,
        status: result?.status ?? 0,
        type: result?.type ?? "unknown",
        durationMs: Math.round(durationMs),
      });

      // notify observers
      for (const fn of this._observers) {
        try {
          fn({ ok: true, task, result });
        } catch {
          // isolate observer errors
        }
      }
    } catch (error) {
      emit("scrape.error", {
        url: task.url,
        error: String(error?.message || error),
      });

      // backoff + retry
      if (task.retries < this.cfg.maxRetries) {
        task.retries += 1;
        const jitter = Math.random() * 200;
        const backoff = clamp(
          this.cfg.backoffBaseMs * Math.pow(2, task.retries - 1) + jitter,
          this.cfg.backoffBaseMs,
          this.cfg.maxBackoffMs
        );
        task.nextAt = Date.now() + backoff;
        this._queue.push(task);
      } else {
        // notify observers of failure
        for (const fn of this._observers) {
          try {
            fn({ ok: false, task, error });
          } catch {}
        }
      }
    } finally {
      this._working -= 1;
      this._kick();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Default singleton export                                                   */
/* -------------------------------------------------------------------------- */

const defaultScheduler = new ScraperScheduler();
export default defaultScheduler;

/* -------------------------------------------------------------------------- */
/* DEV NOTES / FUTURE                                                         */
/* -------------------------------------------------------------------------- */
/**
 * - Consider persisting queue state to IndexedDB/Dexie for resilience across reloads.
 * - Add per-domain “windows” (e.g., only scrape weekly-ads at 2am–5am).
 * - Support scheduled CRON-like expressions for recurring scrapes.
 * - Add health metrics exporter under src/analytics/HouseholdAnalytics.jsx.
 * - Integrate a domain reputation circuit breaker when repeated errors occur.
 * - Wire optional siteAllowList.json enforcement upstream (ScraperEngine already supports).
 * - If you later add schedulers that mutate storehouse/inventory (e.g., auto-ingest price pages),
 *   call exportToHubIfEnabled({ domain: 'storehouse', ... }) after confirmed changes.
 */
