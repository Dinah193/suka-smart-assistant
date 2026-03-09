// C:\Users\larho\suka-smart-assistant\src\import\shareCaptureHandler.js
// -----------------------------------------------------------------------------
// SSA Share Capture Handler (front-end / client-side)
// -----------------------------------------------------------------------------
// PURPOSE
// This module is the *browser-side* capture layer for SSA. It is meant to be
// called by:
//   - a browser bookmarklet
//   - a "Share to Suka" web share target
//   - a mobile/webview share sheet
//   - a mini in-page script injected into external sites
//
// It takes whatever the browser/app can give us (URL, title, text, files,
// HTML snippets) → wraps it in SSA's expected import envelope → emits a local
// event → *then* posts to the server endpoint
//     POST /api/import
// (which you already have in src/server/routes/import.js)
//
// This keeps the pipeline consistent:
//   share → shareCaptureHandler → **imports → intelligence → automation → (optional) hub**
//
// KEY FEATURES
// - Multi-domain detection from URL + keywords (recipe, cleaning, garden/seed,
//   animal/butchery, storehouse, video/how-to).
// - Event-driven: emits { type, ts, source, data } to src/services/events/eventBus.js
// - Forward-thinking: easy to add new detectors and new domains
// - Defensive: does not crash the UI; returns structured results
// - SSA-first: SSA owns the data; Hub export is *optional* (familyFundMode)
// - If the captured data is *already* household-changing (rare on the client,
//   but possible if we parsed inline data), we also call exportToHubIfEnabled.
//
// ASSUMPTIONS
// - src/services/events/eventBus.js exists and exposes `emit(evt)`
// - src/config/featureFlags.js exists
// - src/services/hub/HubPacketFormatter.js & src/services/hub/FamilyFundConnector.js exist
// - The server route is mounted at `/api/import`
//
// HOW IT FITS
// 1. User clicks "Share to SSA" on an external site
// 2. This handler normalizes the *raw* share into an SSA import envelope
// 3. We emit `import.share.captured` locally
// 4. We POST to /api/import → server normalizes → emits domain events
// 5. Server can export to Hub if familyFundMode === true
// 6. Client can listen for `import.parsed` echoes if you broadcast them back
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

import eventBus from "../services/events/eventBus.js";
import featureFlags from "@/config/featureFlags.json";

// Soft imports for Hub (fail silently on web)
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  // These may not exist in basic SSA builds or in browser-only bundles
  // The bundler/tree-shaker may also drop them; that's fine.
  // eslint-disable-next-line import/no-unresolved, global-require
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter.js");
  // eslint-disable-next-line import/no-unresolved, global-require
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector.js");
} catch (err) {
  // ignore
}

// -----------------------------------------------------------------------------
// emitEvent – consistent client-side event
// -----------------------------------------------------------------------------
function emitEvent(type, source, data = {}) {
  const evt = {
    type,
    ts: new Date().toISOString(),
    source,
    data,
  };
  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit(evt);
    }
  } catch (err) {
    // client events should never break UX
  }
  return evt;
}

// -----------------------------------------------------------------------------
// exportToHubIfEnabled – only if familyFundMode is ON and we actually have
// household-changing data right now on the client (uncommon, but keep it)
// -----------------------------------------------------------------------------
async function exportToHubIfEnabled(payload) {
  if (!featureFlags || !featureFlags.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;

  try {
    const packet = HubPacketFormatter.format(payload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (err) {
    // Silent fail; Hub is optional
  }
}

// -----------------------------------------------------------------------------
// guessDomain – determine which import domain this is
// Forward-thinking: add more detectors / rules / signatures here
// -----------------------------------------------------------------------------
export function guessDomain({ url = "", title = "", text = "" }) {
  const lowerUrl = url.toLowerCase();
  const lowerTitle = title.toLowerCase();
  const lowerText = text.toLowerCase();

  // recipes / food
  if (
    lowerUrl.includes("allrecipes") ||
    lowerUrl.includes("loveandlemons") ||
    lowerUrl.includes("foodnetwork") ||
    lowerUrl.includes("/recipe") ||
    lowerTitle.includes("recipe") ||
    lowerText.includes("ingredients:")
  ) {
    return "recipe";
  }

  // cleaning
  if (
    lowerUrl.includes("clean") ||
    lowerTitle.includes("declutter") ||
    lowerText.includes("laundry") ||
    lowerText.includes("bathroom") ||
    lowerText.includes("kitchen cleaning")
  ) {
    return "cleaning";
  }

  // garden / seed
  if (
    lowerUrl.includes("seed") ||
    lowerUrl.includes("garden") ||
    lowerTitle.includes("garden") ||
    lowerText.includes("sow ") ||
    lowerText.includes("transplant") ||
    lowerText.includes("harvest")
  ) {
    return "garden";
  }

  // animal / butchery
  if (
    lowerUrl.includes("butcher") ||
    lowerUrl.includes("animal") ||
    lowerText.includes("slaughter") ||
    lowerText.includes("pasture") ||
    lowerText.includes("goat") ||
    lowerText.includes("sheep") ||
    lowerText.includes("lamb")
  ) {
    return "animal";
  }

  // storehouse / pantry / preservation
  if (
    lowerUrl.includes("pantry") ||
    lowerUrl.includes("storehouse") ||
    lowerText.includes("canning") ||
    lowerText.includes("dehydrate") ||
    lowerText.includes("preserve")
  ) {
    return "storehouse";
  }

  // video / how-to
  if (
    lowerUrl.includes("youtube") ||
    lowerUrl.includes("tiktok") ||
    lowerUrl.includes("facebook.com/watch") ||
    lowerUrl.includes("vimeo") ||
    lowerText.includes("how to ") ||
    lowerTitle.includes("how to")
  ) {
    return "video";
  }

  // default
  return "unknown";
}

// -----------------------------------------------------------------------------
// buildImportEnvelope – create the SSA-shaped packet
// -----------------------------------------------------------------------------
export function buildImportEnvelope(rawShare, options = {}) {
  const {
    url = "",
    title = "",
    text = "",
    html = "",
    site = "",
    media = null, // e.g. FileList from share target
  } = rawShare || {};

  const domain = options.forceDomain || guessDomain({ url, title, text });
  const now = new Date().toISOString();

  return {
    id: options.id || `share_${Date.now()}`,
    kind: domain, // SSA server will re-check this
    source: "client:share",
    importedAt: now,
    site: site || (url ? new URL(url).hostname : ""),
    url,
    title,
    text,
    html,
    media,
    meta: {
      capturedAt: now,
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      lang: typeof navigator !== "undefined" ? navigator.language : "",
      clientHints: options.clientHints || null,
    },
    // forward-thinking: let the server know we came from share/bookmarklet
    channel: "share",
  };
}

// -----------------------------------------------------------------------------
// sendToServer – POST to /api/import
// -----------------------------------------------------------------------------
async function sendToServer(envelope, options = {}) {
  const endpoint = options.endpoint || "/api/import";

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelope),
    });

    const json = await res.json().catch(() => ({}));

    return {
      ok: res.ok,
      status: res.status,
      data: json,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err.message,
    };
  }
}

// -----------------------------------------------------------------------------
// captureFromShareTarget – main entry
// -----------------------------------------------------------------------------
// usage:
//   import { captureFromShareTarget } from './shareCaptureHandler';
//
//   navigator.shareTarget      // in PWA
//   or bookmarklet → calls → captureFromShareTarget({...});
//
//   captureFromShareTarget(
//     { url, title, text },
//     { endpoint: '/api/import', forceDomain: 'recipe' }
//   );
//
// returns a structured result so UI can show success/failure
// -----------------------------------------------------------------------------
export async function captureFromShareTarget(rawShare, options = {}) {
  if (!rawShare || typeof rawShare !== "object") {
    emitEvent("import.share.invalid", "client:share", {
      reason: "No share payload",
    });
    return {
      ok: false,
      error: "No share payload provided.",
    };
  }

  // 1. Build SSA envelope
  const envelope = buildImportEnvelope(rawShare, options);

  // 2. Emit local capture event
  emitEvent("import.share.captured", "client:share", envelope);

  // 3. If the client already parsed something household-changing (rare),
  //    push to Hub immediately (best-effort)
  if (envelope.generated || envelope.inventory || envelope.storehouse) {
    await exportToHubIfEnabled({
      source: "client:share",
      at: new Date().toISOString(),
      envelope,
    });
  }

  // 4. Send to server
  const serverRes = await sendToServer(envelope, options);

  if (!serverRes.ok) {
    emitEvent("import.share.failed", "client:share", {
      envelopeId: envelope.id,
      status: serverRes.status,
      error: serverRes.error || (serverRes.data && serverRes.data.error),
    });

    return {
      ok: false,
      error:
        serverRes.error ||
        (serverRes.data && serverRes.data.error) ||
        "Import failed on server.",
    };
  }

  // 5. Server responded OK → emit parsed event mirror
  //    (this is useful for optimistic UIs)
  emitEvent("import.share.forwarded", "client:share", {
    envelopeId: envelope.id,
    server: serverRes.data,
  });

  return {
    ok: true,
    id: envelope.id,
    domain: envelope.kind,
    server: serverRes.data,
  };
}

// -----------------------------------------------------------------------------
// Convenience export for bookmarklets or inline scripts
// window.__sukaShareCapture && window.__sukaShareCapture(...)
// -----------------------------------------------------------------------------
if (typeof window !== "undefined") {
  // attach only once
  if (!window.__sukaShareCapture) {
    window.__sukaShareCapture = (payload, opts) =>
      captureFromShareTarget(payload, opts);
  }
}

export default {
  captureFromShareTarget,
  buildImportEnvelope,
  guessDomain,
};
