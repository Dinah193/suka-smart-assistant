// src/services/realtime/wsFallback.js
// WebSocket publish/subscribe transport for SSA — reliable fallback when WebRTC is unavailable.
// Fits in SSA pipeline: imports → intelligence → automation → (optional) hub export
// Emits SSA-standard events via eventBus: { type, ts, source, data } with ISO timestamps.
//
// Capabilities
// • Auto-connect with exponential backoff + jitter, heartbeat pings, and liveness detection.
// • Topic-based pub/sub (rooms) with subscribe/unsubscribe and per-topic handlers.
// • Message envelope normalization and input validation.
// • Offline publish queue with backpressure (drop oldest when full) to avoid unbounded memory.
// • Optional Hub export for mutating domain messages (session.*, inventory.*, garden.*, preservation.*).
// • Forward-thinking: pluggable auth headers, protocol ops, and message router hook.
//
// Assumptions
// • Signaling/bus server speaks simple JSON frames: { op, topic, payload, ts, src }.
// • Supported ops: "sub", "unsub", "pub", "ping", "pong", (server may send "sys" notices).
// • eventBus adapter located at "@/services/events/eventBus". Non-fatal if missing.

let eventBus = {
  emit: (...a) => console.debug("[wsFallback:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {
  /* optional */
}

// Feature flags
let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/config/featureFlags.json");
} catch {
  /* optional */
}

// Optional Hub export support
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  HubPacketFormatter = require("@/integrations/HubPacketFormatter");
  FamilyFundConnector = require("@/integrations/FamilyFundConnector");
} catch {
  /* optional */
}

const SRC = "services.realtime.wsFallback";

/* ----------------------------- Small helpers ----------------------------- */
function nowIso() {
  return new Date().toISOString();
}
function emit(type, data = {}) {
  try {
    eventBus.emit({ type, ts: nowIso(), source: SRC, data });
  } catch (err) {
    console.warn("[wsFallback] eventBus.emit failed", err);
  }
}
function isMutating(type = "") {
  return /^session\.|^inventory\.|^garden\.|^preservation\./.test(type || "");
}
async function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch (err) {
    console.warn(
      "[wsFallback] Hub export failed silently:",
      err?.message || err
    );
  }
}
// Clamp utility
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
// Exponential backoff with full jitter (AWS strategy)
function nextBackoff(attempt, baseMs = 500, maxMs = 15000) {
  const exp = Math.pow(2, clamp(attempt, 0, 10));
  const cap = clamp(baseMs * exp, baseMs, maxMs);
  return Math.floor(Math.random() * cap);
}

/* ------------------------------ Core client ------------------------------ */
class WSFallback {
  constructor() {
    this._url = null;
    this._headers = {}; // optional auth headers via protocols or query
    this._ws = null;
    this._alive = false;

    this._heartbeatTimer = null;
    this._lastPong = 0;
    this._heartbeatMs = 15000;
    this._livenessGrace = 45000;

    this._attempt = 0;
    this._closing = false;

    this._topics = new Map(); // topic -> Set(handlers)
    this._wildcards = new Set(); // handlers that receive all topics
    this._router = null; // optional custom router(payload) -> void

    // Offline publish queue
    this._queue = [];
    this._queueMax = 200; // backpressure cap

    // Options
    this._opts = {
      protocols: [], // optional subprotocols
      params: {}, // query params appended to URL
      debug: false,
      autoConnect: true,
    };
  }

  /* --------------------------- Configuration API -------------------------- */
  configure({
    url,
    headers,
    protocols,
    params,
    heartbeatMs,
    livenessGrace,
    queueMax,
    debug,
    autoConnect,
  } = {}) {
    if (url) this._url = url;
    if (headers && typeof headers === "object")
      this._headers = { ...this._headers, ...headers };
    if (Array.isArray(protocols)) this._opts.protocols = protocols.slice(0);
    if (params && typeof params === "object")
      this._opts.params = { ...this._opts.params, ...params };
    if (typeof heartbeatMs === "number")
      this._heartbeatMs = clamp(heartbeatMs, 5000, 60000);
    if (typeof livenessGrace === "number")
      this._livenessGrace = clamp(livenessGrace, 10000, 180000);
    if (typeof queueMax === "number")
      this._queueMax = clamp(queueMax, 20, 5000);
    if (typeof debug === "boolean") this._opts.debug = debug;
    if (typeof autoConnect === "boolean") this._opts.autoConnect = autoConnect;

    if (this._opts.autoConnect && this._url && !this._ws) {
      this.connect().catch((err) =>
        this._log("connect error", err?.message || err)
      );
    }
  }

  setRouter(fn) {
    this._router = typeof fn === "function" ? fn : null;
  }

  /* ----------------------------- Lifecycle API ---------------------------- */
  async connect() {
    if (!this._url)
      throw new Error("wsFallback.configure({ url }) is required");
    if (this._ws && (this._ws.readyState === 0 || this._ws.readyState === 1))
      return; // CONNECTING/OPEN

    this._closing = false;

    const urlWithQuery = this._decorateUrl(this._url, this._opts.params);
    const protocols = this._opts.protocols;

    await new Promise((resolve, reject) => {
      let opened = false;
      try {
        this._ws = protocols?.length
          ? new WebSocket(urlWithQuery, protocols)
          : new WebSocket(urlWithQuery);
      } catch (err) {
        return reject(err);
      }

      this._ws.onopen = () => {
        opened = true;
        this._attempt = 0;
        this._alive = true;
        this._lastPong = Date.now();
        this._startHeartbeat();
        this._flushQueue();
        emit("ws.status", { state: "open", url: urlWithQuery });
        resolve();
      };

      this._ws.onmessage = (evt) => this._handleFrame(evt.data);

      this._ws.onclose = (evt) => {
        this._alive = false;
        this._stopHeartbeat();
        emit("ws.status", {
          state: "close",
          code: evt?.code,
          reason: evt?.reason || "",
        });

        if (this._closing) return; // user-initiated, do not reconnect

        // Reconnect with backoff
        const delay = nextBackoff(this._attempt++);
        setTimeout(() => this.connect().catch(() => {}), delay);
      };

      this._ws.onerror = (err) => {
        emit("ws.error", { message: err?.message || String(err) });
        if (!opened) reject(err);
      };
    });
  }

  close(code = 1000, reason = "client-close") {
    this._closing = true;
    try {
      this._ws?.close(code, reason);
    } catch {}
    this._stopHeartbeat();
    this._ws = null;
    this._alive = false;
    emit("ws.status", { state: "closed", code, reason });
  }

  /* -------------------------------- Pub/Sub ------------------------------- */
  subscribe(topic, handler) {
    if (!topic || typeof handler !== "function") return () => {};
    if (!this._topics.has(topic)) this._topics.set(topic, new Set());
    this._topics.get(topic).add(handler);
    this._send({ op: "sub", topic, ts: nowIso(), src: SRC });
    return () => this.unsubscribe(topic, handler);
  }

  unsubscribe(topic, handler) {
    const set = this._topics.get(topic);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) {
      this._topics.delete(topic);
      this._send({ op: "unsub", topic, ts: nowIso(), src: SRC });
    }
  }

  onAny(handler) {
    // wildcard receiver
    if (typeof handler !== "function") return () => {};
    this._wildcards.add(handler);
    return () => this._wildcards.delete(handler);
  }

  async publish(topic, message) {
    if (!topic) throw new Error("publish requires a topic");
    const envelope = this._normalizeMessage(message);
    const frame = {
      op: "pub",
      topic,
      payload: envelope,
      ts: nowIso(),
      src: SRC,
    };

    // Hub export for mutating domain messages
    if (isMutating(envelope?.type)) {
      exportToHubIfEnabled({ via: "ws", topic, message: envelope });
    }

    if (this._alive && this._ws && this._ws.readyState === 1) {
      this._ws.send(JSON.stringify(frame));
    } else {
      this._enqueue(frame);
    }
    emit("ws.publish", { topic, previewType: envelope?.type });
  }

  /* ------------------------------- Heartbeat ------------------------------ */
  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      try {
        if (!this._ws || this._ws.readyState !== 1) return;
        this._ws.send(JSON.stringify({ op: "ping", ts: nowIso(), src: SRC }));
        // Liveness: if no pong within grace, force reconnect
        if (Date.now() - this._lastPong > this._livenessGrace) {
          this._log("liveness timeout; reconnecting");
          try {
            this._ws.close(4000, "liveness-timeout");
          } catch {}
        }
      } catch (err) {
        this._log("heartbeat error", err?.message || err);
      }
    }, this._heartbeatMs);
  }
  _stopHeartbeat() {
    clearInterval(this._heartbeatTimer);
    this._heartbeatTimer = null;
  }

  /* ------------------------------ Frame parse ----------------------------- */
  _handleFrame(raw) {
    let msg = null;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { op, topic, payload, ts } = msg;

    if (op === "pong") {
      this._lastPong = Date.now();
      return;
    }

    if (op === "sys") {
      emit("ws.system", { notice: payload, at: ts || nowIso() });
      return;
    }

    if (op === "pub" && topic) {
      const envelope = this._coerceEnvelope(payload);
      // Router hook gets first shot
      try {
        this._router && this._router({ topic, envelope });
      } catch (err) {
        this._log("router error", err?.message || err);
      }

      // Fan-out to topic handlers
      const handlers = this._topics.get(topic);
      if (handlers) {
        handlers.forEach((fn) => {
          try {
            fn(envelope, topic);
          } catch {}
        });
      }
      // Wildcard handlers
      this._wildcards.forEach((fn) => {
        try {
          fn(envelope, topic);
        } catch {}
      });

      emit("ws.message", {
        topic,
        type: envelope?.type || "unknown",
        inbound: true,
      });

      // Hub export for inbound mutating messages
      if (isMutating(envelope?.type)) {
        exportToHubIfEnabled({
          via: "ws",
          inbound: true,
          topic,
          message: envelope,
        });
      }
      return;
    }
  }

  /* ------------------------------ Internals ------------------------------- */
  _send(obj) {
    const str = JSON.stringify(obj);
    if (this._alive && this._ws && this._ws.readyState === 1) {
      try {
        this._ws.send(str);
      } catch (err) {
        this._log("send error", err?.message || err);
      }
    } else {
      this._enqueue(obj);
    }
  }

  _enqueue(frame) {
    if (this._queue.length >= this._queueMax) {
      // Drop oldest and notify
      const dropped = this._queue.shift();
      emit("ws.queue.drop", {
        reason: "backpressure",
        droppedOp: dropped?.op,
        droppedTopic: dropped?.topic,
      });
    }
    this._queue.push(frame);
    emit("ws.queue.size", { size: this._queue.length });
  }

  _flushQueue() {
    if (!this._alive || !this._ws || this._ws.readyState !== 1) return;
    while (this._queue.length > 0) {
      const frame = this._queue.shift();
      try {
        this._ws.send(JSON.stringify(frame));
      } catch (err) {
        this._log("flush error", err?.message || err);
        // Put it back and bail to retry later
        this._queue.unshift(frame);
        break;
      }
    }
    emit("ws.queue.size", { size: this._queue.length });
  }

  _normalizeMessage(payload) {
    // Accept either a ready envelope or raw data to wrap
    if (payload && typeof payload === "object" && payload.type && payload.ts)
      return payload;
    const type = payload?.type || "ws.payload";
    const data = payload && payload.data !== undefined ? payload.data : payload;
    return { type, ts: nowIso(), source: SRC, data };
  }

  _coerceEnvelope(obj) {
    // Ensure shape: { type, ts, source, data }
    if (!obj || typeof obj !== "object") {
      return { type: "ws.raw", ts: nowIso(), source: SRC, data: obj };
    }
    const type = obj.type || "ws.payload";
    const ts = obj.ts || nowIso();
    const source = obj.source || SRC;
    const data = "data" in obj ? obj.data : obj;
    return { type, ts, source, data };
  }

  _decorateUrl(url, paramsObj) {
    const u = new URL(
      url,
      typeof window !== "undefined" && window.location
        ? window.location.origin
        : undefined
    );
    if (paramsObj && typeof paramsObj === "object") {
      Object.entries(paramsObj).forEach(([k, v]) =>
        u.searchParams.set(k, String(v))
      );
    }
    // Headers for WS are limited; if you need auth, pass token as ?token= or use protocols.
    return u.toString();
  }

  _log(...args) {
    if (this._opts.debug) console.debug("[wsFallback]", ...args);
  }
}

/* ----------------------------- Public export ----------------------------- */
const wsFallback = new WSFallback();

module.exports = {
  WSFallback,
  wsFallback,
  __internals: {
    nextBackoff,
    isMutating,
    nowIso,
  },
};

/* --------------------------------- Usage ---------------------------------
   // Configure once (e.g., app boot)
   wsFallback.configure({
     url: "wss://your-bus.example/ws",
     params: { app: "ssa", deviceId: "overlay-1" },
     debug: false,
     autoConnect: true
   });

   // Subscribe to a room/topic
   const off = wsFallback.subscribe("room:ABC123", (msg, topic) => {
     // msg is { type, ts, source, data }
     // Handle control messages for overlays, timers, etc.
   });

   // Wildcard listener (observability/tools)
   const offAny = wsFallback.onAny((msg, topic) => {
     console.log("ANY", topic, msg.type);
   });

   // Publish a message
   wsFallback.publish("room:ABC123", { type: "session.control.next", data: { stepId: "sear-2" } });

   // Close when you’re done
   wsFallback.close();
---------------------------------------------------------------------------- */
