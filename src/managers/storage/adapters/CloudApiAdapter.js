/* eslint-disable no-console */
// CloudApiAdapter.js — network storage adapter (ES2015-safe)
// Shape matches other adapters: { name, init, get, set, del, keys, bulkGet, bulkSet, ready }
// Extras: flushOutbox(), isOnline(), setAuth(), setBaseUrl()
(function () {
  var logger = console;

  // ----------------------------- Safe imports ------------------------------
  var eventBus = {
    emit: function () {},
    on: function () {},
    off: function () {},
  };
  try {
    var eb = require("@/services/events/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  var automation = null;
  try {
    var rt = require("@/services/automation/runtime");
    automation = (rt && (rt.automation || rt.default)) || null;
  } catch (_e) {}

  // Use global fetch if present; node fallback if available
  var _fetch = typeof fetch !== "undefined" ? fetch : null;
  if (!_fetch) {
    try {
      _fetch = require("node-fetch");
    } catch (_e) {}
  }

  var isBrowser = typeof window !== "undefined";

  // ------------------------------ Small utils ------------------------------
  var assign = function (t, s) {
    for (var k in s) {
      if (Object.prototype.hasOwnProperty.call(s, k)) t[k] = s[k];
    }
    return t;
  };
  var clamp = function (n, a, b) {
    return Math.max(a, Math.min(b, n));
  };
  var now = function () {
    return Date.now();
  };

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  function toJSON(x) {
    try {
      return JSON.stringify(x);
    } catch (_e) {
      return null;
    }
  }
  function fromJSON(s) {
    try {
      return JSON.parse(s);
    } catch (_e) {
      return null;
    }
  }

  function u8(str) {
    try {
      return encodeURIComponent(str);
    } catch (_e) {
      return str;
    }
  }

  // ------------------------------ Outbox (LS) ------------------------------
  // Minimal durable queue for offline operations.
  function createOutbox(key) {
    var storageOK = false;
    try {
      storageOK = isBrowser && !!window.localStorage;
    } catch (_e) {}
    var _key = key || "suka:cloud:outbox";

    function read() {
      if (!storageOK) return [];
      var raw = window.localStorage.getItem(_key);
      if (!raw) return [];
      var arr = fromJSON(raw);
      return Array.isArray(arr) ? arr : [];
    }
    function write(arr) {
      if (!storageOK) return;
      try {
        window.localStorage.setItem(_key, toJSON(arr || []));
      } catch (_e) {}
    }

    return {
      push: function (job) {
        var list = read();
        list.push(assign({ ts: now() }, job));
        write(list);
      },
      drain: function () {
        var list = read();
        write([]);
        return list;
      },
      peekAll: function () {
        return read();
      },
      size: function () {
        return read().length;
      },
      clear: function () {
        write([]);
      },
    };
  }

  // --------------------------- HTTP wrapper w/ retry ------------------------
  function makeHttp(baseUrl, getAuthToken, onAuthError, timeoutMs) {
    var base = baseUrl || "/api";
    var _timeout = clamp(timeoutMs || 10000, 3000, 60000);

    async function http(method, path, body, headers, attempt) {
      if (!_fetch) throw new Error("fetch unavailable");
      var url = base.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
      var h = assign(
        {
          "Content-Type": "application/json",
        },
        headers || {}
      );
      try {
        var token =
          typeof getAuthToken === "function" ? await getAuthToken() : null;
        if (token) h.Authorization = "Bearer " + token;
      } catch (_e) {}

      var controller = null;
      var signal = undefined;
      if (typeof AbortController !== "undefined") {
        controller = new AbortController();
        signal = controller.signal;
        setTimeout(function () {
          try {
            controller.abort();
          } catch (_e) {}
        }, _timeout);
      }

      var opts = { method: method, headers: h, signal: signal };
      if (body != null)
        opts.body = typeof body === "string" ? body : toJSON(body);

      try {
        var res = await _fetch(url, opts);
        var etag =
          res.headers && res.headers.get ? res.headers.get("ETag") : null;
        if (res.status === 401 || res.status === 403) {
          onAuthError && onAuthError(res);
          var e = new Error("Unauthorized");
          e.status = res.status;
          throw e;
        }
        if (res.status === 204)
          return { status: res.status, ok: true, data: null, etag: etag };
        var text = await res.text();
        var data = text ? fromJSON(text) : null;
        if (!res.ok) {
          var err = new Error((data && data.message) || "HTTP " + res.status);
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return { status: res.status, ok: true, data: data, etag: etag };
      } catch (e) {
        // Retry with exponential backoff on network-ish errors
        var a = (attempt || 0) + 1;
        var retryable = !e.status || (e.status >= 500 && e.status < 600);
        if (retryable && a <= 3) {
          await sleep(200 * Math.pow(2, a));
          return http(method, path, body, headers, a);
        }
        throw e;
      }
    }

    return {
      get: function (path, headers) {
        return http("GET", path, null, headers);
      },
      del: function (path, headers) {
        return http("DELETE", path, null, headers);
      },
      put: function (path, body, headers) {
        return http("PUT", path, body, headers);
      },
      post: function (path, body, headers) {
        return http("POST", path, body, headers);
      },
      baseUrl: base,
    };
  }

  // ---------------------------- CloudApiAdapter -----------------------------
  function CloudApiAdapter(options) {
    options = options || {};
    this.name = "cloud";
    this.ready = false;

    this._baseUrl = options.baseUrl || "/api/v1";
    this._getAuthToken = options.getAuthToken || null;
    this._onAuthError = options.onAuthError || null;
    this._timeout = options.timeoutMs || 10000;

    this._kvPrefix = options.kvPrefix || "storage/kv"; // endpoints: /kv, /kv/bulk, etc.
    this._healthPath = options.healthPath || "health"; // GET /health -> 200

    this._http = makeHttp(
      this._baseUrl,
      this._getAuthToken,
      this._onAuthError,
      this._timeout
    );

    this._etagCache = {}; // key -> etag
    this._outbox = createOutbox(options.outboxKey || "suka:cloud:outbox");
    this._online = true;
  }

  CloudApiAdapter.prototype.setAuth = function (getAuthTokenFn) {
    this._getAuthToken = getAuthTokenFn;
    this._http = makeHttp(
      this._baseUrl,
      this._getAuthToken,
      this._onAuthError,
      this._timeout
    );
  };

  CloudApiAdapter.prototype.setBaseUrl = function (baseUrl) {
    this._baseUrl = baseUrl;
    this._http = makeHttp(
      this._baseUrl,
      this._getAuthToken,
      this._onAuthError,
      this._timeout
    );
  };

  CloudApiAdapter.prototype.isOnline = function () {
    return !!this._online;
  };

  CloudApiAdapter.prototype.init = async function () {
    // health check (non-fatal)
    try {
      var res = await this._http.get(this._healthPath);
      this._online = res && res.ok;
    } catch (_e) {
      this._online = false;
    }
    this.ready = true;

    // Try flushing any pending outbox
    try {
      await this.flushOutbox();
    } catch (_e) {}
    return;
  };

  // ----------------------------- KV primitives ------------------------------
  // GET /storage/kv/:key
  CloudApiAdapter.prototype.get = async function (key) {
    if (!this.ready) return undefined;
    try {
      var res = await this._http.get(this._kvPrefix + "/" + u8(key));
      var data = res && res.data ? res.data.value : undefined;
      if (res && res.etag) this._etagCache[key] = res.etag;
      return data;
    } catch (e) {
      this._online = false;
      // Not-found should resolve undefined
      if (e && e.status === 404) return undefined;
      // On network errors, we can’t satisfy a read from cloud; return undefined.
      return undefined;
    }
  };

  // PUT /storage/kv  { key, value }  supports If-Match with known ETag
  CloudApiAdapter.prototype.set = async function (key, value) {
    if (!this.ready) return;
    var body = { key: key, value: value };
    var hdrs = {};
    var et = this._etagCache[key];
    if (et) hdrs["If-Match"] = et;

    try {
      var res = await this._http.put(this._kvPrefix, body, hdrs);
      if (res && res.etag) this._etagCache[key] = res.etag;

      // Domain-aware orchestration hints (only for plan keys)
      // plans:<scope>:<id>
      if (key && key.indexOf("plans:") === 0 && value && value.id) {
        try {
          eventBus.emit("plan.saved", {
            id: value.id,
            domain: value.domain,
            scope: value.scope,
            userId: (value.meta && value.meta.createdBy) || undefined,
            version: value.meta && value.meta.version,
            at: now(),
          });
          automation &&
            automation.emit &&
            automation.emit("nba.signal", {
              kind: "plan.saved",
              domain: value.domain,
              planId: value.id,
              userId: (value.meta && value.meta.createdBy) || undefined,
              ts: now(),
            });
        } catch (_e) {}
      }

      return;
    } catch (e) {
      // If conflict and server returns 412/409, last-write-wins fallback by removing If-Match and retry once
      if (e && (e.status === 409 || e.status === 412)) {
        try {
          var res2 = await this._http.put(this._kvPrefix, body, {}); // force overwrite
          if (res2 && res2.etag) this._etagCache[key] = res2.etag;
          return;
        } catch (e2) {
          // Queue if still failing
        }
      }
      // Network/5xx → enqueue in outbox for later
      this._online = false;
      this._outbox.push({ op: "set", key: key, value: value });
      eventBus.emit("sync.outbox.enqueued", { op: "set", key: key, at: now() });
      return;
    }
  };

  // DELETE /storage/kv/:key
  CloudApiAdapter.prototype.del = async function (key) {
    if (!this.ready) return;
    var hdrs = {};
    var et = this._etagCache[key];
    if (et) hdrs["If-Match"] = et;

    try {
      await this._http.del(this._kvPrefix + "/" + u8(key), hdrs);
      delete this._etagCache[key];
      return;
    } catch (e) {
      // Queue delete on failure
      this._online = false;
      this._outbox.push({ op: "del", key: key });
      eventBus.emit("sync.outbox.enqueued", { op: "del", key: key, at: now() });
      return;
    }
  };

  // GET /storage/kv?prefix=<prefix>  -> { keys: [...] }
  CloudApiAdapter.prototype.keys = async function (prefix) {
    if (!this.ready) return [];
    try {
      var res = await this._http.get(
        this._kvPrefix + "?prefix=" + u8(prefix || "")
      );
      var ks = (res && res.data && res.data.keys) || [];
      return ks;
    } catch (_e) {
      this._online = false;
      return [];
    }
  };

  // POST /storage/kv/bulk/get { keys } -> { items: [{ key, value, etag? }, ...] }
  CloudApiAdapter.prototype.bulkGet = async function (keys) {
    if (!this.ready)
      return keys.map(function () {
        return undefined;
      });
    try {
      var res = await this._http.post(this._kvPrefix + "/bulk/get", {
        keys: keys || [],
      });
      var items = (res && res.data && res.data.items) || [];
      var byKey = {};
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it && it.key) {
          byKey[it.key] = it.value;
          if (it.etag) this._etagCache[it.key] = it.etag;
        }
      }
      return (keys || []).map(function (k) {
        return byKey[k];
      });
    } catch (_e) {
      this._online = false;
      return keys.map(function () {
        return undefined;
      });
    }
  };

  // POST /storage/kv/bulk/set { entries: [{ key, value }...] }
  CloudApiAdapter.prototype.bulkSet = async function (entries) {
    if (!this.ready) return;
    try {
      var res = await this._http.post(this._kvPrefix + "/bulk/set", {
        entries: entries || [],
      });
      // Optional: server returns etags { items: [{ key, etag }] }
      var items = res && res.data && res.data.items;
      if (items && items.length) {
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (it && it.key && it.etag) this._etagCache[it.key] = it.etag;
        }
      }
      return;
    } catch (e) {
      // Enqueue all entries on failure
      this._online = false;
      for (var j = 0; j < (entries || []).length; j++) {
        var ent = entries[j];
        this._outbox.push({ op: "set", key: ent.key, value: ent.value });
      }
      eventBus.emit("sync.outbox.enqueued", {
        op: "bulkSet",
        count: (entries || []).length,
        at: now(),
      });
      return;
    }
  };

  // ------------------------------ Outbox flush ------------------------------
  CloudApiAdapter.prototype.flushOutbox = async function () {
    if (!this.ready) return { flushed: 0 };
    var jobs = this._outbox.peekAll();
    if (!jobs.length) return { flushed: 0 };

    eventBus.emit("sync.flush.started", { count: jobs.length, at: now() });
    var flushed = 0;

    // Drain & replay
    jobs = this._outbox.drain();
    for (var i = 0; i < jobs.length; i++) {
      var j = jobs[i];
      try {
        if (j.op === "set") {
          await this.set(j.key, j.value); // set already re-enqueues if fails
          flushed++;
        } else if (j.op === "del") {
          await this.del(j.key);
          flushed++;
        }
      } catch (_e) {
        // On error, requeue job
        this._outbox.push(j);
      }
    }

    if (flushed > 0) {
      try {
        eventBus.emit("sync.flush.finished", { flushed: flushed, at: now() });
        automation &&
          automation.emit &&
          automation.emit("nba.signal", {
            kind: "sync.flushed",
            flushed: flushed,
            ts: now(),
          });
      } catch (_e) {}
    }
    return { flushed: flushed };
  };

  // ----------------------------- Export / factory ---------------------------
  function createCloudApiAdapter(options) {
    return new CloudApiAdapter(options || {});
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      CloudApiAdapter: CloudApiAdapter,
      createCloudApiAdapter: createCloudApiAdapter,
    };
  } else {
    // @ts-ignore
    window.CloudApiAdapter = CloudApiAdapter;
    // @ts-ignore
    window.createCloudApiAdapter = createCloudApiAdapter;
  }
})();
