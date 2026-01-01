// src/services/realtime/rtcClient.js
// WebRTC DataChannel Client with QR "room pairing" and WebSocket signaling fallback.
//
// Fits in SSA pipeline:
// imports → intelligence → automation → (optional) hub export
// This module powers cross-device session control (e.g., phone ↔ overlay/TV).
// It emits SSA-standard events via eventBus: { type, ts, source, data }.
//
// Key capabilities:
// • Host creates a "room" (ephemeral ID). We generate a pairing URL for QR display.
// • Joiner scans/opens the URL, connects to the same signaling room, and establishes a DataChannel.
// • Reliable/ordered channel by default; can opt into low-latency mode (unordered).
// • Heartbeats + reconnection resilience on signaling; ICE restarts supported.
// • Hub export hook is called only for domain events that mutate household state (session.*, inventory.*).
//
// Assumptions:
// • A signaling service is reachable via WebSocket (URL passed in options or env).
// • Signaling protocol is JSON messages with shape: { op, roomId, payload }.
//   ops: "host", "join", "offer", "answer", "ice", "close".
// • eventBus is available at "@/services/eventBus" (graceful fallback included).
//
// Extension points:
// • Custom ICE servers via options. • Pluggable QR generation (see buildPairingQRCode()).
// • Message routing hooks by domain. • Alternate signaling transports (long-poll/SSE) if needed.

let eventBus = {
  emit: (...a) => console.debug("[rtcClient:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch { /* optional */ }

// Feature flags (familyFundMode, etc.)
let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/config/featureFlags.json");
} catch { /* optional */ }

// Optional Hub exports
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  HubPacketFormatter = require("@/integrations/HubPacketFormatter");
  FamilyFundConnector = require("@/integrations/FamilyFundConnector");
} catch { /* optional */ }

const SRC = "services.realtime.rtcClient";

function nowIso() {
  return new Date().toISOString();
}

function emit(type, data = {}) {
  try {
    eventBus.emit({ type, ts: nowIso(), source: SRC, data });
  } catch (err) {
    console.warn("[rtcClient] eventBus.emit failed", err);
  }
}

// Optional Hub export hook — used only for domain events that mutate household data.
async function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch (err) {
    // Fail silently by design; Hub is auxiliary.
    console.warn("[rtcClient] Hub export failed silently:", err?.message || err);
  }
}

// Simple ID helper for rooms / correlation
function makeId(prefix = "room", len = 8) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}_${s}`;
}

// Default STUN/TURN — override via options. Keep minimal to avoid dependency.
const DEFAULT_ICE = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478?transport=udp" },
  // Add TURN here if you operate one: { urls: "turns:your.turn.host:5349", username: "u", credential: "p" }
];

// Signaling op constants
const SIG = {
  HOST: "host",
  JOIN: "join",
  OFFER: "offer",
  ANSWER: "answer",
  ICE: "ice",
  CLOSE: "close",
};

class RTCClient {
  constructor() {
    this._ws = null;
    this._wsUrl = null;
    this._wsAlive = false;
    this._wsHeartbeat = null;

    this._pc = null;
    this._dc = null;

    this._role = null; // "host" | "joiner"
    this._roomId = null;
    this._pairingUrl = null;

    this._options = {
      signalingUrl: null,
      iceServers: DEFAULT_ICE,
      channelLabel: "ssa-control",
      ordered: true,
      maxPacketLifeTime: undefined, // set for low-latency
      debug: false,
      pairingUrlBase: null, // e.g., "https://ssa.local/cooking/remote?room="
    };

    // External message handler
    this._onMessage = null;
    this._onStatus = null;
  }

  configure(opts = {}) {
    this._options = { ...this._options, ...opts };
    if (!this._wsUrl && this._options.signalingUrl) {
      this._wsUrl = this._options.signalingUrl;
    }
  }

  get roomId() { return this._roomId; }
  get role() { return this._role; }
  get pairingUrl() { return this._pairingUrl; }
  get connected() { return this._dc && this._dc.readyState === "open"; }

  // Host flow: create room, open signaling, create offer, present pairing URL/QR.
  async createRoom(customRoomId) {
    if (!this._ensureWsUrl()) throw new Error("Missing signalingUrl in rtcClient.configure()");
    if (this._pc) this.close("recreate-room");

    this._role = "host";
    this._roomId = customRoomId || makeId("room");
    this._pairingUrl = this._buildPairingUrl(this._roomId);

    await this._connectSignaling();

    // Announce hosting to signaling
    this._sendSignal(SIG.HOST, { roomId: this._roomId });

    await this._setupPeerConnection();
    await this._createDataChannel(); // Host creates DC proactively
    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);

    this._sendSignal(SIG.OFFER, { roomId: this._roomId, sdp: offer.sdp, type: offer.type });

    emit("rtc.room.created", { roomId: this._roomId, pairingUrl: this._pairingUrl, role: this._role });
    return { roomId: this._roomId, pairingUrl: this._pairingUrl };
  }

  // Joiner flow: connect signaling, announce join, wait for offer (or accept direct offer), answer.
  async joinRoom(roomId) {
    if (!this._ensureWsUrl()) throw new Error("Missing signalingUrl in rtcClient.configure()");
    if (!roomId) throw new Error("joinRoom requires roomId");
    if (this._pc) this.close("rejoin-room");

    this._role = "joiner";
    this._roomId = roomId;
    await this._connectSignaling();

    this._sendSignal(SIG.JOIN, { roomId: this._roomId });

    await this._setupPeerConnection();

    // If host already sent an offer, signaling should forward it to us.
    emit("rtc.room.joined", { roomId: this._roomId, role: this._role });
    return { roomId: this._roomId };
  }

  async send(payload) {
    if (!this._dc || this._dc.readyState !== "open") {
      throw new Error("DataChannel not open");
    }
    const envelope = this._wrapMessage(payload);
    this._dc.send(JSON.stringify(envelope));

    // Optionally export to Hub if it's a mutating domain message
    if (this._isHouseholdMutation(envelope)) {
      exportToHubIfEnabled({ via: "webrtc", message: envelope });
    }
  }

  onMessage(fn) { this._onMessage = typeof fn === "function" ? fn : null; }
  onStatus(fn)  { this._onStatus  = typeof fn === "function" ? fn : null; }

  // Close gracefully
  close(reason = "client-close") {
    try { this._sendSignal(SIG.CLOSE, { roomId: this._roomId, reason }); } catch {}
    if (this._dc) { try { this._dc.close(); } catch {} }
    if (this._pc) { try { this._pc.close(); } catch {} }
    if (this._ws) { try { this._ws.close(); } catch {} }

    clearInterval(this._wsHeartbeat);
    this._ws = null; this._wsAlive = false; this._wsHeartbeat = null;
    this._pc = null; this._dc = null; this._role = null; this._roomId = null; this._pairingUrl = null;

    emit("rtc.connection.closed", { reason });
    this._notifyStatus("closed", { reason });
  }

  // ---------------------------- Internals ----------------------------

  _ensureWsUrl() {
    if (this._options.signalingUrl) this._wsUrl = this._options.signalingUrl;
    return !!this._wsUrl;
  }

  _notifyStatus(status, data = {}) {
    try { this._onStatus && this._onStatus({ status, ...data }); } catch {}
    emit("rtc.connection.status", { status, ...data });
  }

  async _connectSignaling() {
    await new Promise((resolve, reject) => {
      try {
        this._ws = new WebSocket(this._wsUrl);
      } catch (err) {
        return reject(err);
      }

      const onOpen = () => {
        this._wsAlive = true;
        this._startWsHeartbeat();
        this._ws.onmessage = (ev) => this._handleSignal(ev.data);
        this._ws.onclose = () => {
          this._wsAlive = false;
          clearInterval(this._wsHeartbeat);
          this._notifyStatus("signaling.closed");
        };
        this._ws.onerror = (err) => {
          this._notifyStatus("signaling.error", { error: err?.message || String(err) });
        };
        this._notifyStatus("signaling.open");
        resolve();
      };

      const onErr = (e) => reject(e);

      this._ws.addEventListener("open", onOpen, { once: true });
      this._ws.addEventListener("error", onErr, { once: true });
    });
  }

  _startWsHeartbeat() {
    clearInterval(this._wsHeartbeat);
    this._wsHeartbeat = setInterval(() => {
      try {
        if (this._ws && this._ws.readyState === 1) {
          this._ws.send(JSON.stringify({ op: "ping", ts: nowIso() }));
        }
      } catch {}
    }, 15000);
  }

  _sendSignal(op, payload = {}) {
    if (!this._ws || this._ws.readyState !== 1) return;
    const msg = { op, roomId: this._roomId, payload, ts: nowIso(), src: SRC };
    this._ws.send(JSON.stringify(msg));
  }

  async _setupPeerConnection() {
    const iceServers = Array.isArray(this._options.iceServers) ? this._options.iceServers : DEFAULT_ICE;
    this._pc = new RTCPeerConnection({ iceServers });

    this._pc.onicecandidate = (e) => {
      if (e.candidate) {
        this._sendSignal(SIG.ICE, { candidate: e.candidate });
      }
    };

    this._pc.onconnectionstatechange = () => {
      const s = this._pc.connectionState;
      this._notifyStatus("pc.state", { state: s });
      if (s === "connected") emit("rtc.connection.ready", { roomId: this._roomId, role: this._role });
      if (s === "failed") {
        // Try ICE restart once
        try { this._pc.restartIce?.(); } catch {}
        emit("rtc.connection.failed", { roomId: this._roomId, role: this._role });
      }
    };

    // Joiner will receive channel from host
    this._pc.ondatachannel = (e) => {
      this._attachDataChannel(e.channel);
    };
  }

  async _createDataChannel() {
    const opts = {
      ordered: !!this._options.ordered,
    };
    if (typeof this._options.maxPacketLifeTime === "number") {
      opts.maxPacketLifeTime = this._options.maxPacketLifeTime; // enables unordered/partial reliability
      opts.ordered = false;
    }
    const label = this._options.channelLabel || "ssa-control";
    const dc = this._pc.createDataChannel(label, opts);
    this._attachDataChannel(dc);
  }

  _attachDataChannel(dc) {
    this._dc = dc;
    dc.onopen = () => {
      this._notifyStatus("dc.open", { label: dc.label });
      emit("rtc.datachannel.open", { roomId: this._roomId, label: dc.label });
    };
    dc.onclose = () => {
      this._notifyStatus("dc.close", { label: dc.label });
      emit("rtc.datachannel.close", { roomId: this._roomId, label: dc.label });
    };
    dc.onerror = (err) => {
      this._notifyStatus("dc.error", { error: err?.message || String(err) });
    };
    dc.onmessage = (e) => {
      let msg = null;
      try { msg = JSON.parse(e.data); } catch { msg = { type: "rtc.raw", ts: nowIso(), payload: e.data }; }
      // Fan out to consumer
      try { this._onMessage && this._onMessage(msg); } catch {}
      emit("rtc.message", { roomId: this._roomId, role: this._role, message: msg });

      // Hub export only for mutating domain types (session.*, inventory.*, garden.*, preservation.*)
      if (this._isHouseholdMutation(msg)) {
        exportToHubIfEnabled({ via: "webrtc", inbound: true, message: msg });
      }
    };
  }

  _wrapMessage(payload) {
    // Ensure messages have a consistent envelope
    if (payload && payload.type && payload.ts) return payload;
    const type = payload?.type || "rtc.payload";
    const data = payload?.data ?? payload;
    return { type, ts: nowIso(), source: SRC, data };
  }

  _isHouseholdMutation(msg) {
    const t = msg?.type || "";
    return /^session\.|^inventory\.|^garden\.|^preservation\./.test(t);
  }

  async _handleSignal(raw) {
    let m = null;
    try { m = JSON.parse(raw); } catch { return; }
    const { op, roomId, payload } = m || {};
    if (roomId && this._roomId && roomId !== this._roomId) return;

    if (op === SIG.OFFER && this._role === "joiner") {
      const desc = { type: "offer", sdp: payload.sdp };
      await this._pc.setRemoteDescription(desc);
      const answer = await this._pc.createAnswer();
      await this._pc.setLocalDescription(answer);
      this._sendSignal(SIG.ANSWER, { roomId: this._roomId, sdp: answer.sdp, type: answer.type });
      return;
    }

    if (op === SIG.ANSWER && this._role === "host") {
      const desc = { type: "answer", sdp: payload.sdp };
      await this._pc.setRemoteDescription(desc);
      return;
    }

    if (op === SIG.ICE && payload?.candidate) {
      try { await this._pc.addIceCandidate(payload.candidate); } catch (err) {
        console.warn("[rtcClient] addIceCandidate failed:", err?.message || err);
      }
      return;
    }

    if (op === SIG.CLOSE) {
      this.close("remote-close");
      return;
    }
  }

  // ------------------- QR pairing helpers (pluggable) -------------------
  _buildPairingUrl(roomId) {
    // Prefer explicit pairingUrlBase (e.g., your /cooking/remote route)
    if (this._options.pairingUrlBase) return `${this._options.pairingUrlBase}${encodeURIComponent(roomId)}`;

    // Fallback to a custom scheme the mobile app/shortcut can intercept.
    // You can also map this to /import/share-capture if desired.
    const base = (typeof window !== "undefined" && window.location)
      ? `${window.location.origin}/remote?room=`
      : "ssa://remote?room=";
    return `${base}${encodeURIComponent(roomId)}`;
  }

  /**
   * Return an object with the pairing string and, if an external QR generator is present,
   * an SVG string. To keep this module dependency-free, we look for a global QR helper:
   *   window.__SSA_QR__(text, size) => SVG string
   * You can register it elsewhere (e.g., using 'qrcode' lib) without coupling this file.
   */
  buildPairingQRCode(size = 256) {
    const text = this._pairingUrl || "";
    if (!text) return { text, svg: null };
    let svg = null;
    try {
      if (typeof window !== "undefined" && typeof window.__SSA_QR__ === "function") {
        svg = window.__SSA_QR__(text, size);
      }
    } catch {}
    return { text, svg };
  }
}

// Singleton export
const rtcClient = new RTCClient();

module.exports = {
  RTCClient,
  rtcClient,
  // Re-export helpers for advanced usage/testing
  __internals: {
    nowIso,
    makeId,
  },
};
