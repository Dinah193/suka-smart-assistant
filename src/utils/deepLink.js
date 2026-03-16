// C:\Users\larho\suka-smart-assistant\src\utils\deepLink.js
/**
 * utils/deepLink.js — Build SSA deep links:
 *   • Custom scheme: ssa://play?domain=cooking&id=123
 *   • Web paths:     /cooking/play/:id, /cleaning/play/:id, /garden/play/:id, /animals/play/:id
 *
 * Where this fits in SSA:
 * - SSA pipeline: imports → intelligence → automation → (optional) hub export.
 * - Deep links live in the “execution UX” layer: once sessions are generated/approved
 *   by automation, the UI can surface “Play on this device” or “Open on another device”
 *   links using these helpers. This module does not mutate household data (no hub export).
 *
 * Design goals:
 * - Forward-thinking: supports domains {cooking, cleaning, garden, animal/animals, preservation, storehouse}.
 * - Defensive: validates inputs, normalizes domains/ids, tolerates SSR, and emits eventBus telemetry.
 * - Consistent payloads on eventBus: { type, ts, source, data } with ISO timestamps.
 * - Utility helpers: build web or custom-scheme links, parse links, copy to clipboard, open in tab.
 */

let eventBus = {
  emit: (...a) => console.debug("[deepLink:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

const isBrowser =
  typeof window !== "undefined" && typeof document !== "undefined";

/* -------------------------------------------------------------------------- */
/* Event helpers                                                              */
/* -------------------------------------------------------------------------- */
const nowISO = () => new Date().toISOString();
function emit(type, data = {}) {
  try {
    eventBus.emit({ type, ts: nowISO(), source: "utils.deeplink", data });
  } catch {}
}

/* -------------------------------------------------------------------------- */
/* Domain + route normalization                                               */
/* -------------------------------------------------------------------------- */
const DOMAIN_KEYS = /** @type {const} */ ([
  "cooking",
  "cleaning",
  "garden",
  "animal",
  "animals",
  "preservation",
  "storehouse",
]);

const WEB_ROUTES = {
  // page surface design:
  // /{domain}/play/:id
  // /{domain}/draft/:id
  // /{domain}/remote/:room
  cooking: {
    play: "/cooking/play",
    draft: "/cooking/draft",
    remote: "/cooking/remote",
  },
  cleaning: {
    play: "/cleaning/play",
    draft: "/cleaning/draft",
    remote: "/cleaning/remote",
  },
  garden: {
    play: "/garden/play",
    draft: "/garden/draft",
    remote: "/garden/remote",
  },
  animals: {
    play: "/animals/play",
    draft: "/animals/draft",
    remote: "/animals/remote",
  },
  preservation: {
    play: "/preservation/play",
    draft: "/preservation/draft",
    remote: "/preservation/remote",
  },
  storehouse: {
    play: "/storehouse/play",
    draft: "/storehouse/draft",
    remote: "/storehouse/remote",
  },
};

// Map singular "animal" → plural path key "animals"
function normalizeDomain(domain) {
  const d = String(domain || "")
    .trim()
    .toLowerCase();
  if (!d) return null;
  if (!DOMAIN_KEYS.includes(d)) return null;
  return d === "animal" ? "animals" : d;
}

function normalizeId(id) {
  if (id == null) return null;
  const s = String(id).trim();
  return s ? s : null;
}

function getOrigin(baseUrl) {
  if (typeof baseUrl === "string" && baseUrl.trim()) {
    try {
      const u = new URL(baseUrl);
      return `${u.protocol}//${u.host}`;
    } catch {
      // If given a path like "/subapp", just join to current origin
      return isBrowser ? window.location.origin : "http://localhost:5173";
    }
  }
  return isBrowser ? window.location.origin : "http://localhost:5173";
}

/* -------------------------------------------------------------------------- */
/* Builders                                                                   */
/* -------------------------------------------------------------------------- */
/**
 * Build a web link to play/draft/remote surfaces.
 * @param {{domain:string, id?:string|number, mode?:'play'|'draft'|'remote', room?:string, baseUrl?:string}} opts
 * @returns {string|null}
 */
export function buildWebLink(opts = {}) {
  const mode = (opts.mode || "play").toLowerCase();
  if (!["play", "draft", "remote"].includes(mode)) {
    emit("deeplink.error", { stage: "buildWebLink.mode", mode });
    return null;
  }
  const domain = normalizeDomain(opts.domain);
  if (!domain) {
    emit("deeplink.error", {
      stage: "buildWebLink.domain",
      domain: opts.domain,
    });
    return null;
  }
  const routes = WEB_ROUTES[domain];
  if (!routes) {
    emit("deeplink.error", { stage: "buildWebLink.routes", domain });
    return null;
  }

  const origin = getOrigin(opts.baseUrl);
  if (mode === "remote") {
    const room = normalizeId(opts.room);
    if (!room) {
      emit("deeplink.error", {
        stage: "buildWebLink.room_missing",
        domain,
        mode,
      });
      return null;
    }
    const url = `${origin}${routes.remote}/${encodeURIComponent(room)}`;
    emit("deeplink.built", { kind: "web", mode, domain, url });
    return url;
  }

  const id = normalizeId(opts.id);
  if (!id) {
    emit("deeplink.error", { stage: "buildWebLink.id_missing", domain, mode });
    return null;
  }
  const url = `${origin}${routes[mode]}/${encodeURIComponent(id)}`;
  emit("deeplink.built", { kind: "web", mode, domain, url });
  return url;
}

/**
 * Build a custom-scheme deep link.
 * Supported actions: play, draft, remote
 * Format examples:
 *   ssa://play?domain=cooking&id=123
 *   ssa://remote?domain=cooking&room=ROOMCODE
 */
export function buildCustomSchemeLink(opts = {}) {
  const action = (opts.mode || "play").toLowerCase();
  if (!["play", "draft", "remote"].includes(action)) {
    emit("deeplink.error", { stage: "buildCustomSchemeLink.action", action });
    return null;
  }
  const domain = normalizeDomain(opts.domain);
  if (!domain) {
    emit("deeplink.error", {
      stage: "buildCustomSchemeLink.domain",
      domain: opts.domain,
    });
    return null;
  }

  const q = new URLSearchParams();
  q.set("domain", domain);

  if (action === "remote") {
    const room = normalizeId(opts.room);
    if (!room) {
      emit("deeplink.error", {
        stage: "buildCustomSchemeLink.room_missing",
        domain,
        action,
      });
      return null;
    }
    q.set("room", room);
  } else {
    const id = normalizeId(opts.id);
    if (!id) {
      emit("deeplink.error", {
        stage: "buildCustomSchemeLink.id_missing",
        domain,
        action,
      });
      return null;
    }
    q.set("id", id);
  }

  // Optional metadata for receiving app
  if (opts.title) q.set("title", String(opts.title));
  if (opts.source) q.set("source", String(opts.source));

  const url = `ssa://${action}?${q.toString()}`;
  emit("deeplink.built", { kind: "scheme", action, domain, url });
  return url;
}

/**
 * Convenience bundle: returns both links for UI "Copy / Open" menus.
 * @returns {{web:string|null, scheme:string|null}}
 */
export function buildDeepLinkBundle({
  domain,
  id,
  room,
  mode = "play",
  baseUrl,
  title,
  source,
} = {}) {
  const web = buildWebLink({ domain, id, room, mode, baseUrl });
  const scheme = buildCustomSchemeLink({
    domain,
    id,
    room,
    mode,
    title,
    source,
  });
  return { web, scheme };
}

/* -------------------------------------------------------------------------- */
/* Parser                                                                     */
/* -------------------------------------------------------------------------- */
/**
 * Parse an SSA deep link (web or scheme) back into { mode, domain, id?, room? }.
 */
export function parseDeepLink(href = "") {
  try {
    const s = String(href || "");
    if (!s) return { ok: false, error: "empty" };

    // Custom scheme
    if (s.startsWith("ssa://")) {
      const [proto, rest] = s.split("://");
      const [action, query = ""] = rest.split("?");
      const qs = new URLSearchParams(query);
      const domain = normalizeDomain(qs.get("domain"));
      const id = normalizeId(qs.get("id"));
      const room = normalizeId(qs.get("room"));
      const mode = ["play", "draft", "remote"].includes(action)
        ? action
        : "play";
      if (!domain) return { ok: false, error: "invalid_domain" };
      if (mode === "remote" ? !room : !id)
        return { ok: false, error: "missing_identifier" };
      return { ok: true, mode, domain, id, room, kind: "scheme" };
    }

    // Web path
    const u = new URL(
      s,
      isBrowser ? window.location.origin : "http://localhost:5173"
    );
    const segments = (u.pathname || "").split("/").filter(Boolean); // [domain, mode, id|room]
    // Expect: /{domain}/(play|draft|remote)/:idOrRoom
    if (segments.length >= 3) {
      const dom = normalizeDomain(segments[0]);
      const mode = ["play", "draft", "remote"].includes(segments[1])
        ? segments[1]
        : "play";
      const ident = normalizeId(segments[2]);
      if (dom && ident) {
        return {
          ok: true,
          kind: "web",
          mode,
          domain: dom,
          id: mode === "remote" ? null : ident,
          room: mode === "remote" ? ident : null,
        };
      }
    }
    return { ok: false, error: "unrecognized_format" };
  } catch (err) {
    emit("deeplink.error", {
      stage: "parseDeepLink",
      message: err?.message || String(err),
    });
    return { ok: false, error: "parse_failed" };
  }
}

/* -------------------------------------------------------------------------- */
/* UX helpers                                                                 */
/* -------------------------------------------------------------------------- */
export async function copyToClipboard(text) {
  if (!isBrowser) return { ok: false, error: "not_browser" };
  try {
    await navigator.clipboard.writeText(String(text || ""));
    emit("deeplink.copied", { textPreview: String(text || "").slice(0, 80) });
    return { ok: true };
  } catch (err) {
    emit("deeplink.error", {
      stage: "copy",
      message: err?.message || String(err),
    });
    return { ok: false, error: "clipboard_failed" };
  }
}

export function openInNewTab(url) {
  if (!isBrowser) return { ok: false, error: "not_browser" };
  try {
    const w = window.open(String(url || ""), "_blank", "noopener,noreferrer");
    emit("deeplink.opened", { url, popupBlocked: !w });
    return { ok: !!w };
  } catch (err) {
    emit("deeplink.error", {
      stage: "open",
      message: err?.message || String(err),
    });
    return { ok: false, error: "open_failed" };
  }
}

/**
 * Smart-open: prefer custom scheme on mobile (if user opts in via param), else web.
 * We can't reliably detect app install; provide both and let UI decide. Here we just open the chosen href.
 */
export function openDeepLink({ useSchemeFirst = false, ...opts } = {}) {
  const { web, scheme } = buildDeepLinkBundle(opts);
  const href = useSchemeFirst ? scheme || web : web || scheme;
  if (!href) return { ok: false, error: "build_failed" };
  return openInNewTab(href);
}

/* -------------------------------------------------------------------------- */
/* Auto-wiring: offer deep links when sessions are approved/scheduled         */
/* -------------------------------------------------------------------------- *
 * Engines can emit:
 *   { type: "session.draft.approved", data: { domain, id } }
 *   { type: "session.scheduled",      data: { session: { id, domain }, offerDeepLink: true } }
 * This module will emit "deeplink.offer" with a bundle for UI surfaces (buttons/QR).
 * -------------------------------------------------------------------------- */
try {
  eventBus.on((evt) => {
    if (!evt || typeof evt !== "object") return;

    if (
      evt.type === "session.draft.approved" &&
      evt?.data?.id &&
      evt?.data?.domain
    ) {
      const domain = evt.data.domain;
      const id = evt.data.id;
      const bundle = buildDeepLinkBundle({ domain, id, mode: "play" });
      emit("deeplink.offer", {
        reason: "draft.approved",
        domain,
        id,
        ...bundle,
      });
      return;
    }

    if (
      evt.type === "session.scheduled" &&
      evt?.data?.session &&
      evt?.data?.offerDeepLink
    ) {
      const s = evt.data.session;
      const bundle = buildDeepLinkBundle({
        domain: s.domain,
        id: s.id,
        mode: "play",
      });
      emit("deeplink.offer", {
        reason: "session.scheduled",
        domain: s.domain,
        id: s.id,
        ...bundle,
      });
      return;
    }
  });
} catch {}

/* -------------------------------------------------------------------------- */
/* Notes for integrators                                                      */
/* -------------------------------------------------------------------------- *
 * - To show an “Open on phone” button, call buildDeepLinkBundle({ domain, id, mode:'play' })
 *   and render both a web link and a custom scheme link behind a long-press menu.
 * - Consider pairing with utils/awake.js (keepAwake), utils/notify.js (beep/toast),
 *   and utils/speech.js (audible prompts) during session play.
 */
