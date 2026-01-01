/* eslint-disable no-console */
// src/features/scan-compare-trust/services/routing/deeplinks.js
// Deep link handler: scan:// upc=... -> open ScanSheet prefilled
// Style: ESM-first, DI-friendly, browser/SSR safe, event-driven.

/**
 * Public API
 * ---------------------------------------------------------------------------
 * initDeepLinks({ router, eventBus, config, analytics, guards, stores })
 * openDeepLink(urlString, ctx?)              // programmatic open
 * buildScanLink({ upc, ean, store, tab, ... }) // create shareable links
 */

const DEFAULTS = {
  schemeAliases: ["scan", "suka-scan", "suka"], // we also accept suka://scan?... form
  // Fallbacks we will parse for web contexts:
  httpAliases: [
    "/scan",
    "/scan-compare-trust/scan",
    "/deeplink/scan",
    "/open/scan",
  ],
  // Query param aliases we accept
  queryAliases: {
    upc: ["upc", "barcode", "code", "gtin12"],
    ean: ["ean", "gtin13"],
    q: ["q", "query", "text"],
    store: ["store", "warehouse", "club"],
    zip: ["zip", "postal", "zipcode"],
    tab: ["tab", "view"],
    favor: ["favor", "favorite", "save"],
    schedule: ["schedule", "sched", "plan"],
  },
  sheetEvent: "scan:sheet:open", // bottom sheet opener listened to by ScanSheet.jsx
  scanStartEvent: "scan:orchestrate:start", // useProductScan.js orchestration start
};

export function initDeepLinks(deps = {}) {
  const {
    router = null, // optional: your app router (React Router, Wouter, etc.)
    eventBus = safeBus(),
    analytics = safeAnalytics(),
    config = safeConfig(),
    guards = safeGuards(),
    stores = {}, // optional: { favoriteSessions, schedules, couponPrefs }
    log = console,
    win = typeof window !== "undefined" ? window : null,
  } = deps;

  // Idempotent attach
  if (win) {
    if (!win.__suka_deeplinks_attached__) {
      // 1) Handle custom app events (native wrapper / PWA)
      win.addEventListener("app:open:url", (e) => {
        const url = e?.detail?.url || e?.url;
        if (url) openDeepLink(url, { eventBus, analytics, guards, stores, log, config });
      });

      // 2) Handle clicks on elements with data-deeplink
      win.addEventListener("click", (ev) => {
        const t = ev.target?.closest?.("[data-deeplink]");
        if (!t) return;
        const href = t.getAttribute("data-deeplink") || t.getAttribute("href");
        if (!href) return;
        ev.preventDefault();
        openDeepLink(href, { eventBus, analytics, guards, stores, log, config });
      });

      // 3) Check initial URL (hash or query) for web deep links
      tryOpenFromLocation(win.location, { eventBus, analytics, guards, stores, log, config });

      win.__suka_deeplinks_attached__ = true;
    }
  }

  // Optional: register a router path so normal navigation also triggers scanners
  if (router && router.addRoute) {
    DEFAULTS.httpAliases.forEach((path) => {
      try {
        router.addRoute(path, () => {
          const url = win ? win.location.href : path;
          openDeepLink(url, { eventBus, analytics, guards, stores, log, config });
        });
      } catch {
        /* router may not support dynamic add */
      }
    });
  }

  return {
    open: (url, ctx = {}) =>
      openDeepLink(url, { eventBus, analytics, guards, stores, log, config, ...ctx }),
    buildScanLink,
  };
}

/** Programmatic entry point */
export function openDeepLink(urlString, ctx = {}) {
  const { eventBus = safeBus(), analytics = safeAnalytics(), guards = safeGuards(), log = console } = ctx;

  const parsed = parseDeepLink(urlString);
  if (!parsed) {
    log.warn("[deeplinks] Unrecognized deep link:", urlString);
    return false;
  }

  // Respect guards (Sabbath/Quiet Hours)
  if (guards.blockNow?.("scan.open")) {
    // Queue intent for after guard period
    ctx.eventBus?.emit?.("guard:blocked", {
      feature: "scan.open",
      reason: guards.blockNow.reason || "guarded",
      atISO: new Date().toISOString(),
      intent: { type: "scan", payload: parsed.payload },
    });
    ctx.eventBus?.emit?.("nba:hint", {
      scope: "scan",
      title: "Action deferred",
      body: "Your settings are guarding actions right now. I’ll tee this up for later.",
      action: { type: "queue", for: "scan.open", payload: parsed.payload },
    });
    return false;
  }

  // Emit bottom sheet opener with prefill payload (UI listens in ScanSheet.jsx)
  eventBus.emit(DEFAULTS.sheetEvent, parsed.payload);

  // Optionally kick orchestration immediately (useProductScan)
  // - If link explicitly says tab=compare or trust, we still start orchestration so results render ASAP.
  eventBus.emit(DEFAULTS.scanStartEvent, {
    source: "deeplink",
    ...parsed.payload,
  });

  // Handle "favor" and "schedule" intents from the URL
  if (parsed.meta.saveFavorite) {
    eventBus.emit("session:favorites:prompt", {
      domain: "scan",
      template: "Scan • Compare • Trust",
      payload: parsed.payload,
      origin: "deeplink",
    });
  }
  if (parsed.meta.scheduleTemplate) {
    eventBus.emit("scheduler:template:apply", {
      domain: "scan",
      templateKey: parsed.meta.scheduleTemplate,
      context: { payload: parsed.payload, origin: "deeplink" },
    });
  }

  analytics.track?.("deeplink_opened", {
    kind: "scan",
    ...parsed.analytics,
  });

  return true;
}

/** Build a shareable scan link (scheme-first, with web fallback) */
export function buildScanLink(opts = {}) {
  const {
    upc = null,
    ean = null,
    q = null,
    store = null,
    zip = null,
    tab = "compare", // compare | details | trust
    favor = false,    // prompt to save as favorite session
    schedule = null,  // schedule template key (e.g., "weekly-scan-sunday-6pm")
    scheme = "scan",
  } = opts;

  const params = new URLSearchParams();
  if (upc) params.set("upc", String(upc));
  if (ean) params.set("ean", String(ean));
  if (q) params.set("q", String(q));
  if (store) params.set("store", String(store));
  if (zip) params.set("zip", String(zip));
  if (tab) params.set("tab", String(tab));
  if (favor) params.set("favor", "1");
  if (schedule) params.set("schedule", String(schedule));

  const schemeUrl = `${scheme}://open?${params.toString()}`;

  // Provide a web fallback path that the same parser understands
  const webUrl = `/scan?${params.toString()}`;

  return { schemeUrl, webUrl };
}

/* ----------------------------- Internals ---------------------------------- */

function parseDeepLink(urlString) {
  if (!urlString) return null;
  let url = urlString;

  // Normalize common forms:
  // - scan://open?upc=...
  // - suka://scan?upc=...
  // - https://app/scan?upc=...
  // - /scan?upc=...
  const isScheme = /^[a-z][a-z0-9+\-.]*:\/\//i.test(urlString);
  if (!isScheme && urlString.startsWith("#")) {
    // hash-based deep link like #/scan?upc=...
    url = urlString.slice(1);
  }

  // Create a URL object safely (use dummy origin if relative)
  let u;
  try {
    u = new URL(url, "https://local.suka");
  } catch {
    return null;
  }

  // Identify intent
  const { scheme, pathType } = deriveSchemeAndPath(u);

  if (!scheme && !pathType) return null;

  // Collect params with alias support
  const qp = extractQueryParams(u.searchParams);

  // Build prefill payload for ScanSheet + orchestration
  const payload = {
    barcode: barcodeFrom(qp),
    queryText: qp.q || null,
    storeFilter: qp.store || null,
    userZip: qp.zip || null,
    initialTab: qp.tab || "compare", // "compare" | "details" | "trust"
    // Provider hints talk to ProductResolver + Pricing + Coupons
    providerHints: {
      preferStores: qp.store ? [qp.store] : undefined,
      zip: qp.zip || undefined,
    },
    // Flags that ScanSheet.jsx can use for UI state
    _deeplink: {
      source: scheme || pathType,
      at: new Date().toISOString(),
    },
  };

  const meta = {
    saveFavorite: ["1", "true", "yes"].includes(String(qp.favor || "").toLowerCase()),
    scheduleTemplate: qp.schedule || null,
  };

  const analytics = {
    scheme: scheme || "http",
    tab: payload.initialTab,
    hasBarcode: !!payload.barcode?.value,
    store: payload.storeFilter || null,
  };

  return { payload, meta, analytics };
}

function deriveSchemeAndPath(u) {
  const protocol = (u.protocol || "").replace(":", "");
  const host = u.host || "";
  const pathname = u.pathname || "";

  // scheme://open?...
  const isScanScheme = DEFAULTS.schemeAliases.includes(protocol);
  if (isScanScheme) return { scheme: protocol, pathType: "open" };

  // suka://scan?...
  if (DEFAULTS.schemeAliases.includes(protocol) && /^\/scan/i.test(pathname)) {
    return { scheme: protocol, pathType: "scan" };
  }

  // Web fallback routes
  const hit = DEFAULTS.httpAliases.find((p) => pathname.toLowerCase().startsWith(p));
  if (hit) return { scheme: null, pathType: "web-scan" };

  // Also accept custom host like scan.suka.local/open
  if (/^scan(\.|\b)/i.test(host)) return { scheme: "scan", pathType: "open" };

  return { scheme: null, pathType: null };
}

function extractQueryParams(searchParams) {
  const out = {};
  const getAlias = (key) => DEFAULTS.queryAliases[key] || [key];

  for (const [k, v] of searchParams.entries()) {
    out[k] = v;
  }

  // Normalize aliases → canonical keys
  const norm = (canon) => {
    for (const a of getAlias(canon)) {
      if (out[a] != null && out[canon] == null) {
        out[canon] = out[a];
      }
    }
  };

  ["upc", "ean", "q", "store", "zip", "tab", "favor", "schedule"].forEach(norm);
  return out;
}

function barcodeFrom(qp) {
  if (qp.upc) return { type: "upc", value: String(qp.upc).replace(/\D+/g, "") };
  if (qp.ean) return { type: "ean", value: String(qp.ean).replace(/\D+/g, "") };
  return null;
}

/* ----------------------------- Safe deps ---------------------------------- */

function safeBus() {
  return {
    emit: () => {},
  };
}
function safeAnalytics() {
  return { track: () => {} };
}
function safeConfig() {
  return { get: (_p, fb) => fb };
}
function safeGuards() {
  // Example: guards.blockNow('scan.open') -> {blocked:true, reason:'sabbath'}
  const fn = () => false;
  fn.reason = null;
  return { blockNow: fn };
}

/* ----------------------------- Extras ------------------------------------- */

/**
 * Inspect current window.location for a deep link on load (web only).
 * Accepts:
 *  - /scan?... on path
 *  - #/scan?... in hash
 *  - ?deeplink=scan%3A%2F%2Fopen%3Fupc%3D... (wrapper handoff)
 */
function tryOpenFromLocation(loc, ctx) {
  if (!loc) return;
  const search = loc.search || "";
  const hash = loc.hash || "";
  const full = loc.href || "";

  // 1) direct path /scan?... or aliases
  const pathHit = DEFAULTS.httpAliases.find((p) =>
    (loc.pathname || "").toLowerCase().startsWith(p)
  );
  if (pathHit) {
    openDeepLink(full, ctx);
    return;
  }

  // 2) hash-based #/scan?...
  if (/#\/?scan(\?|$)/i.test(hash)) {
    openDeepLink(hash.replace(/^#/, ""), ctx);
    return;
  }

  // 3) handoff param ?deeplink=scan%3A%2F%2Fopen%3F...
  const sp = new URLSearchParams(search);
  const dl = sp.get("deeplink");
  if (dl) {
    openDeepLink(decodeURIComponent(dl), ctx);
  }
}

/* ----------------------------- Convenience ------------------------------- */

/** Small helper to create a <a> tag payload for UI buttons (data-deeplink attr) */
export function deeplinkAttrForScan(opts) {
  const { schemeUrl } = buildScanLink(opts);
  return { "data-deeplink": schemeUrl };
}
