// src/components/cooking/RemoteQR.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * RemoteQR — renders a QR for joining a remote control room (Play/Overlay).
 *
 * SSA pipeline note:
 * - Execution UX helper. Does not mutate imports or inventory. It emits small telemetry
 *   events so the automation runtime can nudge users (e.g., “remote joined”, “copied link”).
 * - Payloads use the standard shape { type, ts, source, data }.
 * - If you WANT hub mirroring of engagement, set hubSync=true; export will silently no-op
 *   when FamilyFund Hub is unavailable or familyFundMode=false.
 *
 * Extension points:
 * - urlBuilder(room) to customize the join URL.
 * - onShareEnvelope(envelope) to forward envelopes via rtcClient/WS if desired.
 */

// ---------------- safe requires ----------------
let eventBus = {
  emit: (...a) => console.debug("[RemoteQR:eventBus.emit]", ...a),
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = {};
try {
  featureFlags = require("@/config/featureFlags.json");
} catch {}

let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter").default;
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector").default;
} catch {}

let QRCodeLib = null;
try {
  // If you have "qrcode" in deps, this will work. Otherwise we fall back.
  QRCodeLib = require("qrcode");
} catch {}

// ---------------- helpers ----------------
const isoNow = () => new Date().toISOString();

function emitEvent(type, data = {}) {
  const payload = {
    type,
    ts: isoNow(),
    source: "components.cooking.RemoteQR",
    data,
  };
  eventBus.emit?.(type, payload);
  return payload;
}

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

function defaultUrlBuilder(room) {
  if (typeof window === "undefined")
    return `/cooking/remote/${encodeURIComponent(room)}`;
  const u = new URL(window.location.href);
  u.pathname = `/cooking/remote/${encodeURIComponent(room)}`;
  u.search = ""; // clean query for a fresh join
  return u.toString();
}

async function tryClipboardWrite(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // Fallback: legacy approach
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return true;
  } catch {}
  return false;
}

function canShare() {
  try {
    return !!navigator.share;
  } catch {
    return false;
  }
}

// Render a tiny SVG fallback (no dependency). Not a true QR: just a stylized link mark.
// We only show this if proper QR generation is unavailable.
function FallbackSvg({ text = "" }) {
  return (
    <svg
      viewBox="0 0 200 200"
      width="200"
      height="200"
      role="img"
      aria-label="Join link fallback"
      style={{
        background: "var(--sv-bg)",
        borderRadius: 12,
        border: "1px solid var(--sv-border)",
      }}
    >
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--sv-accent)" />
          <stop offset="100%" stopColor="var(--sv-accent-700)" />
        </linearGradient>
      </defs>
      <rect
        x="0"
        y="0"
        width="200"
        height="200"
        fill="url(#g)"
        opacity="0.12"
      />
      <g fill="currentColor" transform="translate(40,40)">
        <rect x="0" y="0" width="40" height="40" rx="6" />
        <rect x="80" y="0" width="40" height="40" rx="6" />
        <rect x="0" y="80" width="40" height="40" rx="6" />
        <rect x="80" y="80" width="40" height="40" rx="6" />
      </g>
      <text
        x="100"
        y="175"
        textAnchor="middle"
        fontSize="12"
        fill="currentColor"
      >
        {text.length > 24 ? text.slice(0, 24) + "…" : text}
      </text>
    </svg>
  );
}

// ---------------- component ----------------
export default function RemoteQR({
  room, // required: room code (e.g., "ABCD")
  url, // optional: direct join URL (otherwise built from room)
  size = 256, // px
  cornerHint = "Scan with your phone",
  showCopy = true,
  showShare = true,
  showDownload = true,
  showUrl = true,
  filename = "suka-remote-qr.png",
  urlBuilder = defaultUrlBuilder,
  hubSync = false,
  onShareEnvelope = null, // (envelope) => void
  className = "",
  style = {},
}) {
  const joinUrl = useMemo(
    () => (url ? url : room ? urlBuilder(room) : ""),
    [url, room, urlBuilder]
  );
  const [dataUrl, setDataUrl] = useState(null);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);
  const imgRef = useRef(null);

  useEffect(() => {
    let alive = true;
    setErr(null);
    setDataUrl(null);

    if (!joinUrl) return;

    (async () => {
      // Emit that we prepared a QR for tracking
      const e = emitEvent("play.remote.qr.prepared", { room, joinUrl });
      if (hubSync) exportToHubIfEnabled(e);

      // Try real QR first
      if (QRCodeLib?.toDataURL) {
        try {
          const url = await QRCodeLib.toDataURL(joinUrl, {
            margin: 1,
            scale: 8,
            errorCorrectionLevel: "M",
            color: { dark: "#111111", light: "#ffffffff" },
          });
          if (!alive) return;
          setDataUrl(url);
          return;
        } catch (er) {
          console.warn(
            "[RemoteQR] QRCodeLib failed, using fallback:",
            er?.message || er
          );
          if (!alive) return;
          setDataUrl(null);
        }
      }

      // Fallback: no library -> use SVG placeholder; user will copy link.
      if (!alive) return;
      setDataUrl(null);
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinUrl, room, hubSync]);

  const doCopy = async () => {
    if (!joinUrl) return;
    const ok = await tryClipboardWrite(joinUrl);
    setCopied(ok);
    const e = emitEvent("play.remote.link.copied", { room, ok });
    if (hubSync) exportToHubIfEnabled(e);
    if (ok) {
      setTimeout(() => setCopied(false), 1800);
    }
  };

  const doShare = async () => {
    if (!joinUrl) return;
    const envelope = {
      kind: "share.joinurl",
      ts: isoNow(),
      room,
      url: joinUrl,
      title: "Join my Suka Cook Remote",
      text: "Use your phone as the remote for this cooking session.",
    };
    try {
      if (canShare()) {
        await navigator.share({
          title: envelope.title,
          text: envelope.text,
          url: envelope.url,
        });
      }
      onShareEnvelope?.(envelope);
      emitEvent("play.remote.link.shared", {
        room,
        via: canShare() ? "navigator.share" : "custom",
      });
    } catch (er) {
      console.warn("[RemoteQR] share error:", er?.message || er);
      emitEvent("play.remote.link.share.failed", { room });
    }
  };

  const doDownload = () => {
    if (!dataUrl || !imgRef.current) return;
    try {
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      emitEvent("play.remote.qr.downloaded", { room, filename });
    } catch (e) {
      console.warn("[RemoteQR] download failed:", e?.message || e);
    }
  };

  // low-level envelope for other tabs/devices
  const broadcastPrepared = () => {
    try {
      const env = {
        kind: "remote.qr.prepared",
        ts: isoNow(),
        room,
        url: joinUrl,
      };
      eventBus.emit?.("play.control", {
        type: "play.control",
        ts: env.ts,
        source: "RemoteQR",
        data: env,
      });
      onShareEnvelope?.(env);
    } catch {}
  };

  useEffect(() => {
    if (!joinUrl) return;
    broadcastPrepared();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joinUrl]);

  const sz = Math.max(120, Math.min(1024, Number(size) || 256));

  return (
    <div
      className={`sv-card sv-pad ${className}`}
      style={{ textAlign: "center", ...style }}
    >
      <div className="sv-subtitle">Remote Control</div>
      <div className="sv-muted" style={{ marginBottom: 8 }}>
        {cornerHint}
      </div>

      <div
        style={{
          display: "grid",
          placeItems: "center",
          padding: 8,
          border: "1px dashed var(--sv-border)",
          borderRadius: 12,
          background: "white",
        }}
      >
        {dataUrl ? (
          <img
            ref={imgRef}
            src={dataUrl}
            width={sz}
            height={sz}
            alt="Scan to join the Suka remote room"
            style={{ width: sz, height: sz }}
          />
        ) : (
          <div
            style={{
              width: sz,
              height: sz,
              display: "grid",
              placeItems: "center",
            }}
          >
            <FallbackSvg text={room || "room"} />
          </div>
        )}
      </div>

      {showUrl && joinUrl ? (
        <div className="sv-block sv-text-sm" style={{ wordBreak: "break-all" }}>
          <span className="sv-strong">Join URL:</span>{" "}
          <span className="sv-muted">{joinUrl}</span>
        </div>
      ) : null}

      <div
        className="sv-row sv-justify-between sv-block"
        style={{ flexWrap: "wrap", gap: 8 }}
      >
        {showCopy && (
          <button
            type="button"
            className="sv-btn sv-btn--outline"
            onClick={doCopy}
            disabled={!joinUrl}
            title="Copy join link"
          >
            {copied ? "✅ Copied" : "Copy link"}
          </button>
        )}
        {showShare && (
          <button
            type="button"
            className="sv-btn sv-btn--outline"
            onClick={doShare}
            disabled={!joinUrl}
            title="Share join link"
          >
            Share
          </button>
        )}
        {showDownload && (
          <button
            type="button"
            className="sv-btn sv-btn--outline"
            onClick={doDownload}
            disabled={!dataUrl}
            title="Download QR as PNG"
          >
            Download QR
          </button>
        )}
      </div>

      {err ? (
        <div className="sv-danger sv-text-sm sv-block">
          Couldn’t build QR: {String(err)}
        </div>
      ) : null}
    </div>
  );
}
