// src/utils/adsense.js
/* eslint-disable no-console */
let injected = false;
let _clientId = null;
let _opts = {
  autoAds: true,
  cspNonce: null,
  respectDNT: true,
  blockForPremium: true,
  lazy: true,
  loadTimeoutMs: 3500,
  consent: null,
};

// Defensive deps
let eventBus = { emit() {}, on() {}, off() {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let PlanStorageRouter = null;
try {
  PlanStorageRouter = require("@/services/plans/PlanStorageRouter").default;
} catch (_e) {}

let useFavoritePlans = null;
try {
  useFavoritePlans = require("@/hooks/useFavoritePlans").default;
} catch (_e) {}

/* --------------------------------- helpers --------------------------------- */
const isBrowser =
  typeof window !== "undefined" && typeof document !== "undefined";
const toISO = () => new Date().toISOString();
const safeJSON = {
  parse: (s, f = null) => {
    try {
      return JSON.parse(s);
    } catch {
      return f;
    }
  },
};

function dntEnabled() {
  try {
    if (!_opts.respectDNT) return false;
    const v =
      navigator.doNotTrack ||
      window.doNotTrack ||
      navigator.msDoNotTrack ||
      "0";
    return v === "1" || v === "yes";
  } catch {
    return false;
  }
}

function isPremiumUser() {
  try {
    const ls = safeJSON.parse(localStorage?.getItem("suka:user:flags"), {});
    return !!(ls && (ls.premium || ls.adFree));
  } catch {
    return false;
  }
}

function withTimeout(promise, ms, onTimeout) {
  let t;
  const timeout = new Promise((res) => {
    t = setTimeout(() => res(onTimeout?.()), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(t)), timeout]);
}

/* ------------------------------ AdSense script ----------------------------- */
export function initAdSense(options = {}) {
  if (!isBrowser) return { ok: false, reason: "ssr" };
  _opts = { ..._opts, ...options };
  _clientId = options.clientId || _clientId;

  if (!_clientId) return { ok: false, reason: "no-clientId" };
  if (injected) return { ok: true, already: true };

  if (_opts.blockForPremium && isPremiumUser()) {
    eventBus.emit?.("adsense.skipped", { reason: "premium", tsISO: toISO() });
    injected = true;
    return { ok: true, skipped: "premium" };
  }

  if (dntEnabled()) {
    eventBus.emit?.("adsense.skipped", { reason: "dnt", tsISO: toISO() });
    injected = true;
    return { ok: true, skipped: "dnt" };
  }

  const s = document.createElement("script");
  s.async = true;
  s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js";
  s.setAttribute("data-ad-client", _clientId);
  s.setAttribute("crossorigin", "anonymous");
  if (_opts.cspNonce) s.setAttribute("nonce", _opts.cspNonce);
  document.head.appendChild(s);
  injected = true;

  if (_opts.consent && typeof window !== "undefined") {
    window.dataLayer = window.dataLayer || [];
    window.gtag =
      window.gtag ||
      function () {
        window.dataLayer.push(arguments);
      };
    window.gtag("consent", "default", _opts.consent);
  }

  eventBus.emit?.("adsense.init", {
    clientId: _clientId,
    autoAds: !!_opts.autoAds,
    tsISO: toISO(),
  });
  return { ok: true };
}

/* ------------------------------ Slot mounting ------------------------------ */
export function mountAdSlot(container, opts = {}) {
  if (!isBrowser || !container) return { ok: false, reason: "no-container" };

  const options = {
    format: opts.format || "auto",
    responsive: opts.responsive !== false,
    layoutKey: opts.layoutKey || null,
    style: opts.style || { display: "block", minHeight: "100px" },
    slotId: opts.slotId || `adslot-${Math.random().toString(36).slice(2)}`,
    adTest: !!opts.adTest,
    onFallback: typeof opts.onFallback === "function" ? opts.onFallback : null,
    meta: opts.meta || {},
  };

  if (!injected && _clientId) initAdSense({ clientId: _clientId });

  if ((_opts.blockForPremium && isPremiumUser()) || dntEnabled()) {
    eventBus.emit?.("adsense.slot.skipped", {
      slotId: options.slotId,
      reason: "policy",
      tsISO: toISO(),
    });
    renderHouseAd(container, options.meta);
    return { ok: true, skipped: "policy" };
  }

  const ins = document.createElement("ins");
  ins.className = "adsbygoogle";
  ins.style.display = options.style.display || "block";
  Object.keys(options.style || {}).forEach((k) => {
    ins.style[k] = options.style[k];
  });

  ins.setAttribute("data-ad-client", _clientId);
  ins.setAttribute("data-ad-format", options.format);
  if (options.responsive)
    ins.setAttribute("data-full-width-responsive", "true");
  if (options.layoutKey)
    ins.setAttribute("data-ad-layout-key", options.layoutKey);
  if (options.adTest) ins.setAttribute("data-adtest", "on");
  ins.setAttribute("data-ad-slot", options.slotId);

  container.innerHTML = "";
  container.appendChild(ins);

  const doPush = () => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
      eventBus.emit?.("adsense.slot.pushed", {
        slotId: options.slotId,
        meta: options.meta,
        tsISO: toISO(),
      });
    } catch (e) {
      eventBus.emit?.("adsense.slot.error", {
        slotId: options.slotId,
        error: e?.message || String(e),
        tsISO: toISO(),
      });
      renderHouseAd(container, options.meta);
    }
  };

  if (_opts.lazy && "IntersectionObserver" in window) {
    const io = new IntersectionObserver(
      (entries) => {
        if (
          entries.some((en) => en.isIntersecting || en.intersectionRatio > 0)
        ) {
          io.disconnect();
          withTimeout(Promise.resolve().then(doPush), _opts.loadTimeoutMs, () =>
            renderHouseAd(container, options.meta)
          );
        }
      },
      { rootMargin: "200px 0px" }
    );
    io.observe(ins);
  } else {
    withTimeout(Promise.resolve().then(doPush), _opts.loadTimeoutMs, () =>
      renderHouseAd(container, options.meta)
    );
  }

  const unmount = () => {
    try {
      container.innerHTML = "";
    } catch (_e) {}
  };
  return { ok: true, el: ins, unmount };
}

/* ------------------------------ House Ad (fallback) ------------------------ */
function renderHouseAd(container, meta = {}) {
  if (!container) return;
  container.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.style.cssText =
    "border:1px solid #e5e7eb;border-radius:12px;padding:14px;display:flex;align-items:center;gap:12px;background:#fafafa;";
  const text = document.createElement("div");
  text.style.cssText = "flex:1;";

  const title = meta.title || "Make life easier with a Favorite Plan";
  const desc =
    meta.desc ||
    "Save your best runbooks to reuse—meals, cleaning, garden, and animals.";
  text.innerHTML = `<div style="font-weight:600">${escapeHTML(
    title
  )}</div><div style="opacity:.75;font-size:0.95em">${escapeHTML(desc)}</div>`;

  const ctaRow = document.createElement("div");
  ctaRow.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;";

  const btnSave = document.createElement("button");
  btnSave.textContent = "Save as Favorite";
  btnSave.style.cssText =
    "border:1px solid #111;border-radius:10px;padding:8px 12px;background:#111;color:#fff;cursor:pointer;";
  btnSave.onclick = () => {
    const suggested = {
      planId: meta.planId || `housead-plan:${Date.now()}`,
      title: meta.planTitle || "My Favorite Plan",
      domain: meta.domain || "meals",
      tags: meta.tags || ["evergreen"],
      source: "AdHouse",
    };
    eventBus.emit?.("plan.save.modal.open", { source: "AdHouse", suggested });
    setTimeout(async () => {
      await saveFavoritePlanFallback(suggested);
    }, 300);
  };

  const btnCreate = document.createElement("button");
  btnCreate.textContent = "Create a Plan";
  btnCreate.style.cssText =
    "border:1px solid #e5e7eb;border-radius:10px;padding:8px 12px;background:#fff;cursor:pointer;";
  btnCreate.onclick = () => {
    eventBus.emit?.("plan.fromAd.requested", {
      createdISO: toISO(),
      domain: meta.domain || "meals",
      title: meta.planTitle || "New Plan",
      params: { tags: meta.tags || ["evergreen"], source: "AdHouse" },
    });
  };

  ctaRow.appendChild(btnSave);
  ctaRow.appendChild(btnCreate);
  text.appendChild(ctaRow);

  wrap.appendChild(text);
  container.appendChild(wrap);

  eventBus.emit?.("adsense.housead.rendered", { meta, tsISO: toISO() });
}

async function saveFavoritePlanFallback(meta) {
  try {
    if (PlanStorageRouter?.savePlanFavorite) {
      await PlanStorageRouter.savePlanFavorite({
        planId: meta.planId,
        domain: meta.domain,
        source: "AdHouse",
        target: "local",
        meta,
      });
      eventBus.emit?.("toast", {
        kind: "success",
        message: "Saved as Favorite Plan",
        tsISO: toISO(),
      });
      return true;
    }
  } catch (_e) {}
  try {
    if (typeof useFavoritePlans === "function") {
      const st = useFavoritePlans.getState?.();
      st?.addFavorite?.({
        id: meta.planId,
        domain: meta.domain,
        title: meta.title || meta.planTitle || "Favorite Plan",
        meta,
      });
      eventBus.emit?.("toast", {
        kind: "success",
        message: "Saved as Favorite Plan",
        tsISO: toISO(),
      });
      return true;
    }
  } catch (_e) {}
  try {
    const key = "suka:favorites:plans";
    const prev = JSON.parse(localStorage.getItem(key) || "[]");
    prev.push({
      id: meta.planId,
      domain: meta.domain,
      title: meta.title || meta.planTitle || "Favorite Plan",
      meta,
    });
    localStorage.setItem(key, JSON.stringify(prev));
    eventBus.emit?.("toast", {
      kind: "success",
      message: "Saved as Favorite Plan",
      tsISO: toISO(),
    });
    return true;
  } catch (_e) {}
  eventBus.emit?.("toast", {
    kind: "error",
    message: "Could not save favorite",
    tsISO: toISO(),
  });
  return false;
}

/* -------------------------------- Utilities -------------------------------- */
export function refreshVisibleAds() {
  if (!isBrowser || !window.adsbygoogle) return;
  document.querySelectorAll("ins.adsbygoogle").forEach((el) => {
    try {
      (window.adsbygoogle = window.adsbygoogle || []).push({});
    } catch (_e) {}
  });
  eventBus.emit?.("adsense.refresh", { tsISO: toISO() });
}

export function attachRouteAutoRefresh(router) {
  try {
    if (!router || typeof router.listen !== "function") return;
    router.listen(() => setTimeout(refreshVisibleAds, 250));
  } catch (_e) {}
}

/* ------------------------------- tiny escapes ------------------------------ */
const HTML_ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHTML(s) {
  return String(s || "").replace(/[&<>"']/g, function (ch) {
    return HTML_ESCAPE_MAP[ch];
  });
}
