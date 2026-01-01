/* eslint-disable no-console */
// GoogleDriveAdapter.js — Google Drive-backed KV adapter (Drive v3)
// Shape: { name, ready, init(), get(key), set(key,val), del(key), keys(prefix), bulkGet(keys), bulkSet(entries) }
// Extras: setAuth(), useVisibleFolder(), flushOutbox(), isOnline()
// Stores small JSON blobs as files in appDataFolder by default for privacy/cleanliness.
// Keeps a "suka_manifest.json" (manifest) to accelerate prefix scans.
// Domain-aware orchestration pulses on plan writes keep your pipelines hot.

(function () {
  var logger = console;
  var isBrowser = typeof window !== "undefined";

  /* --------------------------------- Config -------------------------------- */
  var DEFAULTS = {
    appName: "Suka Smart Assistant",
    manifestName: "suka_manifest.json",      // file living in appDataFolder (or visible folder if configured)
    visibleFolderName: "Suka Smart Assistant",
    maxKeys: 10000,                           // clamp to avoid memory spikes
    mimeJson: "application/json",
  };

  /* --------------------------- Defensive imports --------------------------- */
  // Event bus
  var eventBus = { emit: function(){}, on: function(){}, off: function(){} };
  try {
    var eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  // Automation runtime (optional)
  var automation = null;
  try {
    var rt = require("@/services/automation/runtime");
    automation = (rt && (rt.automation || rt.default)) || null;
  } catch (_e) {}

  /* ---------------------------------- Utils -------------------------------- */
  var now = function(){ return Date.now(); };
  var clamp = function(n,a,b){ return Math.max(a, Math.min(b, n)); };
  var isStr = function(v){ return typeof v === "string"; };
  var isObj = function (v){ return v && typeof v === "object" && !Array.isArray(v); };

  function toJSON(x) { try { return JSON.stringify(x); } catch (_e) { return "{}"; } }
  function fromJSON(s) { try { return JSON.parse(s); } catch (_e) { return null; } }

  function encName(key) {
    // Drive "name" must be a string; keep it readable but safe.
    return String(key).replace(/[^\w.\-:]/g, "_").slice(0, 255);
  }

  function sleep(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

  /* -------------------------------- Outbox --------------------------------- */
  function createOutbox(lsKey) {
    var ok = false;
    try { ok = isBrowser && !!window.localStorage; } catch (_e){}
    var KEY = lsKey || "suka:gdrive:outbox";

    function read(){ if (!ok) return []; var s = window.localStorage.getItem(KEY); var a = s ? fromJSON(s) : []; return Array.isArray(a) ? a : []; }
    function write(a){ if (!ok) return; try { window.localStorage.setItem(KEY, toJSON(a || [])); } catch(_e){} }

    return {
      push: function(job){ var a = read(); a.push(Object.assign({ ts: now() }, job)); write(a); },
      drain: function(){ var a = read(); write([]); return a; },
      peekAll: function(){ return read(); },
      size: function(){ return read().length; },
      clear: function(){ write([]); }
    };
  }

  /* ------------------------------ Drive wrapper ---------------------------- */
  // Uses window.gapi.client.drive.files.*; SSR-safe (no-op if gapi absent).
  function createDrive(api) {
    var gapi = api || (isBrowser ? (window.gapi || null) : null);
    if (!gapi || !gapi.client || !gapi.client.drive) {
      return {
        ok: false,
        ready: false,
        init: async function(){ this.ready = !!(isBrowser && window.gapi && window.gapi.client && window.gapi.client.drive); return this.ready; },
      };
    }

    return {
      ok: true,
      ready: true,
      init: async function(){ return true; },

      // Find or create the container folder; appDataFolder is implicit via spaces="appDataFolder".
      findManifest: async function(name, useVisible, visibleFolderId) {
        if (!useVisible) {
          // Look in appDataFolder
          var q = "name = '" + name.replace(/'/g, "\\'") + "' and trashed = false";
          var res = await gapi.client.drive.files.list({ spaces: "appDataFolder", fields: "files(id,name,modifiedTime,version,md5Checksum)", q: q });
          var items = res && res.result && res.result.files || [];
          return items[0] || null;
        } else {
          if (!visibleFolderId) return null;
          var res2 = await gapi.client.drive.files.list({
            q: "name = '" + name.replace(/'/g, "\\'") + "' and '" + visibleFolderId + "' in parents and trashed = false",
            fields: "files(id,name,modifiedTime,version,md5Checksum)"
          });
          var items2 = res2 && res2.result && res2.result.files || [];
          return items2[0] || null;
        }
      },

      readFile: async function(fileId) {
        var res = await gapi.client.drive.files.get({ fileId: fileId, alt: "media" });
        return res && res.body ? fromJSON(res.body) : (res.result || null);
      },

      writeFile: async function(opts) {
        // Uses multipart upload to set name/parents + media in one call
        // opts: { fileId?, name, parents?, dataObj }
        var boundary = "-------314159265358979323846";
        var delimiter = "\r\n--" + boundary + "\r\n";
        var closeDelim = "\r\n--" + boundary + "--";
        var metadata = { name: opts.name, mimeType: DEFAULTS.mimeJson };
        if (opts.parents) metadata.parents = opts.parents;

        var meta = toJSON(metadata);
        var body = toJSON(opts.dataObj || {});
        var multipartRequestBody =
          delimiter +
          "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
          meta +
          delimiter +
          "Content-Type: " + DEFAULTS.mimeJson + "\r\n\r\n" +
          body +
          closeDelim;

        var params = {
          resource: metadata,
          media: { mimeType: DEFAULTS.mimeJson, body: body },
          uploadType: "multipart"
        };

        if (opts.fileId) {
          var upd = await gapi.client.request({
            path: "/upload/drive/v3/files/" + encodeURIComponent(opts.fileId),
            method: "PATCH",
            params: { uploadType: "multipart" },
            headers: { "Content-Type": "multipart/related; boundary=" + boundary },
            body: multipartRequestBody
          });
          return upd && upd.result;
        } else {
          var ins = await gapi.client.request({
            path: "/upload/drive/v3/files",
            method: "POST",
            params: { uploadType: "multipart" },
            headers: { "Content-Type": "multipart/related; boundary=" + boundary },
            body: multipartRequestBody
          });
          return ins && ins.result;
        }
      },

      deleteFile: async function(fileId){
        await gapi.client.drive.files.delete({ fileId: fileId });
      },

      listByNamePrefix: async function(prefix, useVisible, visibleFolderId, pageSize){
        // In appDataFolder, query by name contains; we'll refine with manifest anyway.
        var results = [];
        var pageToken = null;
        var tries = 0;
        do {
          var params = {
            fields: "nextPageToken, files(id,name,modifiedTime,version,md5Checksum)",
            pageSize: clamp(pageSize || 200, 50, 500)
          };
          if (!useVisible) {
            params.spaces = "appDataFolder";
            params.q = "name contains '" + prefix.replace(/'/g, "\\'") + "' and trashed = false";
          } else {
            if (!visibleFolderId) return [];
            params.q = "'" + visibleFolderId + "' in parents and name contains '" + prefix.replace(/'/g, "\\'") + "' and trashed = false";
          }
          if (pageToken) params.pageToken = pageToken;
          var res = await gapi.client.drive.files.list(params);
          var files = res && res.result && res.result.files || [];
          results = results.concat(files);
          pageToken = res && res.result && res.result.nextPageToken || null;
          tries++;
        } while (pageToken && tries < 10);
        return results;
      },

      findOrCreateVisibleFolder: async function(folderName){
        var q = "mimeType = 'application/vnd.google-apps.folder' and name = '" + folderName.replace(/'/g, "\\'") + "' and trashed = false";
        var res = await gapi.client.drive.files.list({ q: q, fields: "files(id,name)" });
        var files = res && res.result && res.result.files || [];
        if (files[0]) return files[0];
        // create
        var create = await gapi.client.drive.files.create({
          resource: { name: folderName, mimeType: "application/vnd.google-apps.folder" },
          fields: "id,name"
        });
        return create && create.result;
      }
    };
  }

  /* ----------------------------- Adapter class ----------------------------- */
  function GoogleDriveAdapter(options) {
    options = options || {};
    this.name = "googledrive";
    this.ready = false;

    // Config
    this.appName = options.appName || DEFAULTS.appName;
    this.manifestName = options.manifestName || DEFAULTS.manifestName;
    this.visibleFolderName = options.visibleFolderName || DEFAULTS.visibleFolderName;
    this.maxKeys = clamp(options.maxKeys || DEFAULTS.maxKeys, 1000, 20000);

    // Auth / API handles
    this._gapi = (isBrowser && window.gapi) ? window.gapi : null;
    this._drive = createDrive(this._gapi);

    // Storage mode
    this._useVisibleFolder = !!options.useVisibleFolder; // default: appDataFolder
    this._visibleFolderId = null;

    // Manifest cache { id, name, map: { key: fileId }, mtime, version }
    this._manifest = { id: null, map: {}, mtime: 0, version: 0 };

    // Simple memory index (hot path) for key -> fileId
    this._index = {}; // key -> fileId

    // Outbox
    this._outbox = createOutbox("suka:gdrive:outbox");

    // Online-ish
    this._online = false;
  }

  GoogleDriveAdapter.prototype.isOnline = function(){ return !!this._online; };
  GoogleDriveAdapter.prototype.setAuth = function(gapiInstance) {
    // Allow host app to inject an already init'ed gapi client
    this._gapi = gapiInstance;
    this._drive = createDrive(this._gapi);
  };
  GoogleDriveAdapter.prototype.useVisibleFolder = function(flag){ this._useVisibleFolder = !!flag; };

  GoogleDriveAdapter.prototype.init = async function() {
    try {
      // Ensure Drive client present
      var ok = await this._drive.init();
      if (!ok && !this._drive.ready) {
        this.ready = false;
        return;
      }

      // If using visible folder, resolve (or create) it
      if (this._useVisibleFolder) {
        try {
          var folder = await this._drive.findOrCreateVisibleFolder(this.visibleFolderName);
          this._visibleFolderId = folder && folder.id;
        } catch (_e) {
          this._visibleFolderId = null;
        }
      }

      // Load or create manifest
      await this._ensureManifest();
      this._online = true;
      this.ready = true;

      // Attempt to flush outbox
      try { await this.flushOutbox(); } catch (_e) {}
    } catch (e) {
      logger.warn("[GoogleDriveAdapter] init failed", e);
      this.ready = false;
      this._online = false;
    }
    return;
  };

  /* ------------------------------- Manifest -------------------------------- */
  GoogleDriveAdapter.prototype._ensureManifest = async function() {
    try {
      var f = await this._drive.findManifest(this.manifestName, this._useVisibleFolder, this._visibleFolderId);
      if (f && f.id) {
        var obj = await this._drive.readFile(f.id);
        var map = (obj && obj.map && isObj(obj.map)) ? obj.map : {};
        this._manifest = { id: f.id, map: map, mtime: Date.parse(f.modifiedTime || new Date().toISOString()), version: f.version || 0 };
        this._index = Object.assign({}, map);
      } else {
        // create empty manifest
        var parents = this._useVisibleFolder && this._visibleFolderId ? [this._visibleFolderId] : ["appDataFolder"];
        var created = await this._drive.writeFile({ name: this.manifestName, parents: parents, dataObj: { map: {} } });
        this._manifest = { id: created.id, map: {}, mtime: Date.now(), version: created.version || 0 };
        this._index = {};
      }
    } catch (e) {
      // If manifest fails, we still can operate with listByNamePrefix on demand
      logger.warn("[GoogleDriveAdapter] manifest unavailable, will degrade to Drive queries", e);
      this._manifest = { id: null, map: {}, mtime: 0, version: 0 };
      this._index = {};
    }
  };

  GoogleDriveAdapter.prototype._updateManifest = async function(mutateFn) {
    if (!this._manifest || !this._manifest.id) return;
    var nextMap = Object.assign({}, this._manifest.map);
    mutateFn && mutateFn(nextMap);
    try {
      var parents = this._useVisibleFolder && this._visibleFolderId ? [this._visibleFolderId] : ["appDataFolder"];
      var res = await this._drive.writeFile({
        fileId: this._manifest.id,
        name: this.manifestName,
        parents: parents,
        dataObj: { map: nextMap }
      });
      this._manifest.map = nextMap;
      this._manifest.mtime = Date.now();
      this._manifest.version = res && res.version || (this._manifest.version + 1);
      this._index = Object.assign({}, nextMap);
    } catch (e) {
      logger.warn("[GoogleDriveAdapter] manifest update failed", e);
    }
  };

  /* -------------------------------- Primitives ----------------------------- */
  GoogleDriveAdapter.prototype.get = async function(key) {
    if (!this.ready) return undefined;
    try {
      var fileId = this._index[key];
      if (!fileId) {
        // Heal index via a targeted list (degraded path)
        var guessName = encName(key);
        var files = await this._drive.listByNamePrefix(guessName, this._useVisibleFolder, this._visibleFolderId, 50);
        var found = (files || []).find(function(f){ return f.name === guessName; });
        if (found) {
          fileId = found.id;
          // opportunistically repair manifest/index
          this._index[key] = fileId;
          if (this._manifest.id) await this._updateManifest(function(map){ map[key] = fileId; });
        }
      }
      if (!fileId) return undefined;
      var obj = await this._drive.readFile(fileId);
      return (obj && obj.value != null) ? obj.value : obj; // we store wrapped {value} or raw
    } catch (e) {
      this._online = false;
      return undefined;
    }
  };

  GoogleDriveAdapter.prototype.set = async function(key, value) {
    if (!this.ready) return;

    var name = encName(key);
    var parents = this._useVisibleFolder && this._visibleFolderId ? [this._visibleFolderId] : ["appDataFolder"];
    var payload = (value != null && value.id != null) ? value : { value: value };

    try {
      var fileId = this._index[key];
      var res = await this._drive.writeFile({
        fileId: fileId || undefined,
        name: name,
        parents: parents,
        dataObj: payload
      });
      if (res && res.id) {
        this._index[key] = res.id;
        // Update manifest map
        if (this._manifest.id) await this._updateManifest(function(map){ map[key] = res.id; });
      }

      // Orchestration: if it's a plan key, emit pulses
      if (isStr(key) && key.indexOf("plans:") === 0 && value && value.id) {
        try {
          eventBus.emit("plan.saved", {
            id: value.id,
            domain: value.domain,
            scope: value.scope,
            userId: (value.meta && value.meta.createdBy) || undefined,
            version: value.meta && value.meta.version,
            at: now()
          });
          automation && automation.emit && automation.emit("nba.signal", {
            kind: "plan.saved",
            domain: value.domain,
            planId: value.id,
            userId: (value.meta && value.meta.createdBy) || undefined,
            ts: now()
          });
        } catch (_e) {}
      }

      this._online = true;
      return;
    } catch (e) {
      // enqueue for later
      this._outbox.push({ op: "set", key: key, value: value });
      eventBus.emit("sync.outbox.enqueued", { op: "set", key: key, at: now() });
      this._online = false;
      return;
    }
  };

  GoogleDriveAdapter.prototype.del = async function(key) {
    if (!this.ready) return;
    try {
      var fileId = this._index[key];
      if (!fileId) return;
      await this._drive.deleteFile(fileId);
      delete this._index[key];
      if (this._manifest.id) await this._updateManifest(function(map){ delete map[key]; });
      this._online = true;
      return;
    } catch (e) {
      this._outbox.push({ op: "del", key: key });
      eventBus.emit("sync.outbox.enqueued", { op: "del", key: key, at: now() });
      this._online = false;
      return;
    }
  };

  GoogleDriveAdapter.prototype.keys = async function(prefix) {
    if (!this.ready) return [];
    var out = [];
    try {
      // Prefer manifest for speed
      var map = this._manifest && this._manifest.map || {};
      if (prefix) {
        for (var k in map) { if (Object.prototype.hasOwnProperty.call(map, k) && k.indexOf(prefix) === 0) out.push(k); }
      } else {
        out = Object.keys(map);
      }

      // If manifest missing or empty, degrade to Drive list (and heal)
      if (!this._manifest.id || out.length === 0) {
        var files = await this._drive.listByNamePrefix(prefix ? encName(prefix) : "", this._useVisibleFolder, this._visibleFolderId, 200);
        var keysSeen = [];
        for (var i=0;i<files.length;i++){
          var fname = files[i].name || "";
          // fname is encName(key); we can't always invert safely.
          // Strategy: use prefix-only case or rely on readFile to get back original key if stored inside.
          // As we store JSON payloads, we’ll accept manifest-less mode as best-effort.
          if (!prefix || fname.indexOf(encName(prefix)) === 0) {
            keysSeen.push(fname); // best-effort (encoded)
          }
        }
        // We will not overwrite the manifest here to avoid poisoning; manifest gets updated on writes.
        return keysSeen.slice(0, this.maxKeys);
      }

      return out.slice(0, this.maxKeys);
    } catch (_e) {
      this._online = false;
      return out.slice(0, this.maxKeys);
    }
  };

  GoogleDriveAdapter.prototype.bulkGet = async function(keys) {
    if (!this.ready) return (keys || []).map(function(){ return undefined; });
    var self = this;
    var results = new Array((keys || []).length);
    await Promise.all((keys || []).map(async function(k, i){
      try {
        results[i] = await self.get(k);
      } catch (_e) {
        results[i] = undefined;
      }
    }));
    return results;
  };

  GoogleDriveAdapter.prototype.bulkSet = async function(entries) {
    if (!this.ready || !Array.isArray(entries) || !entries.length) return;
    for (var i=0;i<entries.length;i++){
      var e = entries[i];
      if (!e || !isStr(e.key)) continue;
      try { await this.set(e.key, e.value); } catch (_e) { /* queued in outbox if needed */ }
    }
    return;
  };

  /* ------------------------------ Outbox flush ------------------------------ */
  GoogleDriveAdapter.prototype.flushOutbox = async function() {
    if (!this.ready) return { flushed: 0 };
    var jobs = this._outbox.peekAll();
    if (!jobs.length) return { flushed: 0 };

    eventBus.emit("sync.flush.started", { count: jobs.length, at: now() });
    var flushed = 0;

    jobs = this._outbox.drain();
    for (var i=0;i<jobs.length;i++){
      var j = jobs[i];
      try {
        if (j.op === "set") {
          await this.set(j.key, j.value);
          flushed++;
        } else if (j.op === "del") {
          await this.del(j.key);
          flushed++;
        }
      } catch (_e) {
        // requeue if still failing
        this._outbox.push(j);
      }
    }

    if (flushed > 0) {
      try {
        eventBus.emit("sync.flush.finished", { flushed: flushed, at: now() });
        automation && automation.emit && automation.emit("nba.signal", { kind: "sync.flushed", flushed: flushed, ts: now() });
      } catch (_e) {}
    }
    return { flushed: flushed };
  };

  /* ----------------------------- Factory/export ---------------------------- */
  function createGoogleDriveAdapter(options) {
    return new GoogleDriveAdapter(options || {});
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      GoogleDriveAdapter: GoogleDriveAdapter,
      createGoogleDriveAdapter: createGoogleDriveAdapter
    };
  } else {
    // @ts-ignore
    window.GoogleDriveAdapter = GoogleDriveAdapter;
    // @ts-ignore
    window.createGoogleDriveAdapter = createGoogleDriveAdapter;
  }
})();
