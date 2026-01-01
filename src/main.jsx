// C:\Users\larho\suka-smart-assistant\src\main.jsx
/* eslint-disable no-console */
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation } from "react-router-dom";
import App from "./App.jsx";
import "./index.css";

/* ────────────────────────────────────────────────────────────────────────────
   0) Small utilities
   ────────────────────────────────────────────────────────────────────────── */
const isBrowser = typeof window !== "undefined";
const nowISO = () => new Date().toISOString();

/** Try multiple candidate module paths; first that loads wins. */
async function safeImportMany(paths = []) {
  for (const p of paths) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await import(/* @vite-ignore */ p);
    } catch {
      /* try next */
    }
  }
  return {};
}

/* ────────────────────────────────────────────────────────────────────────────
   1) Legacy hash-routing redirect (for old #/links)
   ────────────────────────────────────────────────────────────────────────── */
(function hashToPathShim() {
  if (!isBrowser) return;
  const { hash, origin } = window.location;
  if (hash && hash.startsWith("#/")) {
    const target = hash.slice(1); // "/settings/profile"
    const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
    const nextUrl = `${origin}${base}${target}`;
    history.replaceState(null, "", nextUrl);
  }
})();

/* ────────────────────────────────────────────────────────────────────────────
   2) DEV: global runtime & unhandled rejection logger
   ────────────────────────────────────────────────────────────────────────── */
if (import.meta.env.DEV && isBrowser) {
  let warnedOnce = false;
  const showNotice = (msg) => {
    console.error("[GlobalError]", msg);
    if (warnedOnce) return;
    warnedOnce = true;
    const n = document.createElement("div");
    n.textContent = "A runtime error occurred. Check the console for details.";
    Object.assign(n.style, {
      position: "fixed",
      right: "12px",
      bottom: "12px",
      zIndex: 999999,
      background: "#fee2e2",
      color: "#991b1b",
      padding: "8px 10px",
      borderRadius: "8px",
      boxShadow: "0 2px 10px rgba(0,0,0,.1)",
      font: "12px/1 system-ui",
      maxWidth: "360px",
    });
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 6000);
  };
  window.addEventListener("error", (e) =>
    showNotice(e?.error || e?.message || e)
  );
  window.addEventListener("unhandledrejection", (e) =>
    showNotice(e?.reason || e)
  );
}

/* ────────────────────────────────────────────────────────────────────────────
   3) Theme boot: respect saved theme + OS preference
   ────────────────────────────────────────────────────────────────────────── */
(function themeBoot() {
  if (!isBrowser) return;
  const key = "sv.theme";
  const root = document.documentElement;
  const saved = localStorage.getItem(key);
  const prefersDark = window.matchMedia?.(
    "(prefers-color-scheme: dark)"
  ).matches;
  const next = saved || (prefersDark ? "dark" : "light");
  root.setAttribute("data-theme", next);

  // Live-sync on OS theme change (if user hasn't pinned a theme)
  if (!saved && window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) =>
      root.setAttribute("data-theme", e.matches ? "dark" : "light");
    try {
      mql.addEventListener("change", onChange);
    } catch {
      mql.addListener(onChange);
    }
  }
})();

/* ────────────────────────────────────────────────────────────────────────────
   4) Route helpers: progress bar, scroll restore, a11y announcer, analytics
   ────────────────────────────────────────────────────────────────────────── */
function RouterProgress() {
  const [loading, setLoading] = React.useState(false);
  const { pathname } = useLocation();

  React.useEffect(() => {
    setLoading(true);
    const id = setTimeout(() => setLoading(false), 300);
    return () => clearTimeout(id);
  }, [pathname]);

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        height: 2,
        width: loading ? "100%" : 0,
        background:
          "linear-gradient(90deg, var(--fallback-p, #570df8), rgba(87,13,248,.35))",
        transition: "width .3s ease",
        zIndex: 9999,
      }}
    />
  );
}

function ScrollRestorer() {
  const { pathname } = useLocation();
  React.useEffect(() => {
    try {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    } catch {
      window.scrollTo(0, 0);
    }
  }, [pathname]);
  return null;
}

function RouteAnnouncer() {
  const { pathname } = useLocation();
  const ref = React.useRef(null);
  React.useEffect(() => {
    if (ref.current) ref.current.textContent = `Navigated to ${pathname}`;
  }, [pathname]);
  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: "absolute",
        width: 1,
        height: 1,
        overflow: "hidden",
        clip: "rect(0 0 0 0)",
      }}
    />
  );
}

function RouteAnalytics() {
  const { pathname } = useLocation();
  React.useEffect(() => {
    (async () => {
      const bus =
        (await safeImportMany([
          "@/services/events/eventBus.js",
          "@/services/events/eventBus",
          "@/eventBus.js",
        ])) || {};
      const emit =
        bus.emit ||
        ((type, payload) => {
          try {
            window.dispatchEvent?.(new CustomEvent(type, { detail: payload }));
          } catch {}
        });

      const evt = { at: nowISO(), path: pathname };
      emit("route.changed", evt);

      // Hook household analytics
      try {
        const ha = await safeImportMany([
          "@/analytics/HouseholdAnalytics.js",
          "@/analytics/HouseholdAnalytics.jsx",
        ]);
        if (ha?.trackRoute) {
          ha.trackRoute(pathname, evt);
        }
      } catch {
        /* non-blocking */
      }

      window.analytics?.track?.("route_changed", { path: pathname });
    })();
  }, [pathname]);
  return null;
}

/* ────────────────────────────────────────────────────────────────────────────
   5) Boot DI singletons (DexieDB, config, eventBus, analytics, automation, KG)
   ────────────────────────────────────────────────────────────────────────── */
async function bootDI() {
  // create SSA namespace early
  if (isBrowser) {
    if (!window.__suka) window.__suka = {};
    window.__suka.startedAt = window.__suka.startedAt || nowISO();
  }

  // 1. Dexie (DB): expose globally for DI fallbacks used across features
  //    Split-brain guard:
  //    - Prefer ONE canonical import path first
  //    - If a different DB instance is later returned, keep the first and warn in DEV
  const dbMod = await safeImportMany([
    // ✅ Prefer alias-based canonical module first
    "@/db/index.js",
    "@/db/index.ts",
    "@/db",

    // Fallbacks (dev / older layouts)
    "./db/index.js",
    "./db/index.ts",
  ]);

  const importedDb = dbMod?.default || dbMod?.db || null;

  if (isBrowser) {
    const existing = window.DexieDB;

    if (!existing && importedDb) {
      window.DexieDB = importedDb;
    } else if (existing && importedDb && existing !== importedDb) {
      // Keep the first instance to prevent split-brain usage.
      if (import.meta.env.DEV) {
        console.warn(
          "[main] Split-brain DB guard: multiple db modules resolved. Keeping window.DexieDB (first) and ignoring the later import."
        );
      }
    } else if (!existing && !importedDb && import.meta.env.DEV) {
      console.warn(
        "[main] Dexie DB module not found or did not export {default|db}."
      );
    }

    // If your db module exports a readiness promise, expose it for consumers.
    // (We do NOT await it here to avoid blocking first paint.)
    if (dbMod?.dbReady && !window.__suka.dbReady) {
      window.__suka.dbReady = dbMod.dbReady;
    }
    if (dbMod?.db && !window.__suka.db) {
      window.__suka.db = dbMod.db;
    }
  }

  // 2. Config: merge featureFlags.json + .env hints into a tiny getter
  const flagsMod = await safeImportMany([
    "./config/featureFlags.json",
    "@/config/featureFlags.json",
  ]);
  const flags = flagsMod?.default || {};
  const env = import.meta?.env || {};

  const getFrom = (obj, path) => {
    const parts = String(path).split(".");
    let cur = obj;
    for (const p of parts) cur = cur?.[p];
    return cur;
  };
  const cfg = {
    env,
    flags,
    get(path, fb) {
      const d = getFrom(flags?.defaults || {}, path);
      const v = d !== undefined ? d : getFrom(flags, path);
      return v === undefined ? fb : v;
    },
    getBoolEnv(key, fb = false) {
      if (!(key in env)) return fb;
      const v = String(env[key]).toLowerCase();
      return v === "true" || v === "1" || v === "yes";
    },
  };
  if (isBrowser) {
    window.config = cfg;
    window.__suka.config = cfg;
  }

  // 3. Event bus (DOM-based)
  if (isBrowser && !window.__suka.eventBus) {
    const domBus = {
      emit(type, payload) {
        try {
          window.dispatchEvent(new CustomEvent(type, { detail: payload }));
        } catch {}
      },
      on(type, handler) {
        const fn = (e) => handler(e.detail);
        window.addEventListener(type, fn);
        return () => window.removeEventListener(type, fn);
      },
    };
    window.__suka.eventBus = domBus;
    window.eventBus = window.eventBus || domBus;
  }

  // 4. Global analytics stub
  if (isBrowser && !window.analytics) {
    window.analytics = {
      track: (name, payload) => {
        if (import.meta.env.DEV) console.debug("[analytics]", name, payload);
      },
      identify: () => {},
    };
  }

  // 5. Automation runtime (wire to new automation/runtime.js shim)
  if (isBrowser) {
    try {
      const autoMod = await safeImportMany([
        "@/services/automation/runtime.js",
        "@/services/automationRuntime.js", // legacy fallback
      ]);

      const automationInstance =
        autoMod?.automation || autoMod?.default || null;

      if (!window.__suka.automationInitialized) {
        // Ensure runtime shim + cooking shim bootstrap run once
        autoMod.bootstrapAutomation?.();
        autoMod.bootstrap?.();
        window.__suka.automationInitialized = true;
      }

      if (automationInstance) {
        // Backwards-compatible shape, plus direct instance
        window.__suka.automation = {
          instance: automationInstance,
          handleEvent: (...args) => automationInstance.emitEvent?.(...args),
          registerHandler: (...args) => automationInstance.onTopic?.(...args),
        };
      }
    } catch (e) {
      if (import.meta.env.DEV)
        console.warn("[main] automation runtime not loaded:", e?.message || e);
    }
  }

  // 6. Knowledge Graph service
  if (isBrowser) {
    try {
      const kg = await safeImportMany(["@/services/knowledgeGraph.js"]);
      if (kg?.upsertFromImport) {
        window.__suka.knowledgeGraph = kg;
      }
    } catch {}
  }

  // 7. Family Fund export helper
  if (isBrowser && !window.__suka.exportToHubIfEnabled) {
    window.__suka.exportToHubIfEnabled = async function exportToHubIfEnabled(
      payload
    ) {
      try {
        const { getConfig } = await safeImportMany([
          "@/config/index.js",
          "@/config",
          "./config/index.js",
        ]);
        const cfg2 = getConfig ? getConfig() : window.config;
        const enabled =
          cfg2?.featureFlags?.familyFundMode === true ||
          cfg2?.flags?.familyFundMode === true ||
          cfg2?.get?.("familyFundMode", false);

        if (!enabled) return;
        const HubPacketFormatter = (
          await safeImportMany([
            "@/services/HubPacketFormatter.js",
            "@/services/HubPacketFormatter",
          ])
        )?.default;
        const FamilyFundConnector = (
          await safeImportMany([
            "@/services/FamilyFundConnector.js",
            "@/services/FamilyFundConnector",
          ])
        )?.default;

        if (!HubPacketFormatter || !FamilyFundConnector) return;

        const packet = HubPacketFormatter.format(payload);
        await FamilyFundConnector.send(packet);
      } catch {
        // fail silently – SSA must keep working
      }
    };
  }

  // 8. Global keyboard shortcut
  if (isBrowser) {
    window.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        window.__suka.eventBus.emit("command.palette.toggle", {
          source: "global",
          at: nowISO(),
        });
      }
    });
  }

  // 9. Global listeners for Scan • Compare • Trust
  if (isBrowser && window.DexieDB) {
    window.__suka.eventBus.on("session.saved.favorite", async (payload) => {
      if (!payload || payload.type !== "scan") return;
      const table = window.DexieDB.scanFavorites;
      if (!table) return;
      try {
        await table.put({
          owner: "user",
          title: payload.snapshot?.title || "Favorite Scan Flow",
          snapshot: payload.snapshot || {},
          createdAt: nowISO(),
        });
      } catch (e) {
        console.warn("[main] favorite save failed:", e?.message || e);
      }
    });

    window.__suka.eventBus.on("scan.result", async (r) => {
      const table = window.DexieDB.scanHistory;
      if (!table) return;
      try {
        await table.add({
          type: r?.type || "unknown",
          title: r?.title || r?.barcode || r?.ocrPreview || "Scan",
          barcode: r?.barcode,
          ocrPreview: r?.ocrPreview,
          meta: r?.meta || {},
          createdAt: nowISO(),
        });
      } catch (e) {
        console.warn("[main] scanHistory add failed:", e?.message || e);
      }
    });

    window.__suka.eventBus.on(
      "history.clear.requested",
      async ({ domain } = {}) => {
        if (domain !== "scan") return;
        try {
          await window.DexieDB.scanHistory?.clear?.();
        } catch {}
        window.__suka.eventBus.emit("history.cleared", {
          domain: "scan",
          at: nowISO(),
        });
      }
    );
  }

  // 10. Share-capture inbox
  if (isBrowser) {
    window.addEventListener("message", (evt) => {
      const msg = evt?.data;
      if (!msg || typeof msg !== "object") return;

      const ssaEvt = {
        type: msg.type || "external.message",
        ts: nowISO(),
        source: "main.shareCaptureBridge",
        data: msg.payload || msg.data || {},
      };

      window.__suka.eventBus.emit(ssaEvt.type, ssaEvt);

      if (
        ssaEvt.type === "import.shared" ||
        ssaEvt.type === "import.normalized"
      ) {
        window.__suka.automation?.handleEvent?.({
          type: "import.parsed",
          ts: ssaEvt.ts,
          source: ssaEvt.source,
          data: ssaEvt.data,
        });

        if (window.__suka.knowledgeGraph?.upsertFromImport) {
          window.__suka.knowledgeGraph.upsertFromImport({
            ...ssaEvt.data,
            source: "share-capture",
          });
        }
      }
    });
  }
}

/* ────────────────────────────────────────────────────────────────────────────
   6) Mount the app
   ────────────────────────────────────────────────────────────────────────── */
const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error(
    '#root element not found. Ensure index.html contains <div id="root"></div>.'
  );
}
const root = createRoot(rootEl);

// Boot DI singletons before first paint (but don't block UI forever)
const diReady = bootDI().catch(
  (e) => import.meta.env.DEV && console.warn("DI boot failed:", e)
);

root.render(
  <React.StrictMode>
    {/* Single router lives here. App.jsx does NOT create a BrowserRouter. */}
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <RouterProgress />
      <ScrollRestorer />
      <RouteAnnouncer />
      <RouteAnalytics />
      <App />
    </BrowserRouter>
  </React.StrictMode>
);

/* ────────────────────────────────────────────────────────────────────────────
   7) Automation bootstrap (client / node)
   ────────────────────────────────────────────────────────────────────────── */
(async () => {
  try {
    if (!isBrowser) {
      const mod = await safeImportMany([
        "@/services/automation/bootstrap.node.js",
        "@/services/automation/bootstrap.node",
      ]);
      await mod.startAutomationBootstrap?.({});
    } else {
      const mod = await safeImportMany([
        "@/services/automation/bootstrap.client.js",
        "@/services/automation/bootstrap.client",
        "@/services/automation/bootstrap.js",
      ]);
      await mod.startAutomationBootstrap?.({});
    }
  } catch (e) {
    if (import.meta.env.DEV)
      console.warn("Automation bootstrap skipped:", e?.message || e);
  }
})();

/* ────────────────────────────────────────────────────────────────────────────
   8) PWA Service Worker
   ────────────────────────────────────────────────────────────────────────── */
if (isBrowser && "serviceWorker" in navigator) {
  if (import.meta.env.PROD) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register(`${import.meta.env.BASE_URL}service-worker.js`)
        .then((reg) => console.log("✅ Service Worker registered:", reg.scope))
        .catch((err) =>
          console.error("❌ Service Worker registration failed:", err)
        );
    });
  } else {
    // in dev → unregister so Vite HMR works properly
    navigator.serviceWorker.getRegistrations?.().then((regs) => {
      regs.forEach((r) =>
        r
          .unregister()
          .then(() => console.log("🧹 SW unregistered (dev):", r.scope))
      );
    });
    if (navigator.serviceWorker.controller) {
      try {
        navigator.serviceWorker.controller.postMessage({
          type: "SKIP_WAITING",
        });
      } catch {}
      setTimeout(() => location.reload(), 50);
    }
  }
}
