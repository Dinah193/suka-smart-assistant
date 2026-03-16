/* eslint-disable no-console */
// FileDownloadAdapter.js — sidecar for exporting/importing plans & favorites
// Shape-compatible with other adapters (get/set/keys/etc.) by delegating to an upstream adapter.
// Adds: exportToJSON(), downloadJSON(), importFromJSON()/importFromFile(), exportUserBundle()
//
// Goals supported:
// - Users can save THEIR OWN favorites and plans to a file (backup/share/portability).
// - Domain-aware export (filter by domain, scope).
// - Shared orchestration: emits export/import & plan/favorite events.
// - Defensive: runs in browser and Node (SSR), safe fallbacks.

(function () {
  var logger = console;
  var isBrowser =
    typeof window !== "undefined" && typeof document !== "undefined";

  /* --------------------------- Defensive imports --------------------------- */
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

  /* --------------------------------- Utils --------------------------------- */
  var now = function () {
    return Date.now();
  };
  var clamp = function (n, a, b) {
    return Math.max(a, Math.min(b, n));
  };
  var isStr = function (v) {
    return typeof v === "string";
  };
  var isObj = function (v) {
    return v && typeof v === "object" && !Array.isArray(v);
  };

  function toJSON(x) {
    try {
      return JSON.stringify(x, null, 2);
    } catch (_e) {
      return "{}";
    }
  }
  function fromJSON(s) {
    try {
      return JSON.parse(s);
    } catch (_e) {
      return null;
    }
  }

  function safeFilename(name, ext) {
    var base =
      (name || "plans")
        .toString()
        .replace(/[^\w.\-]+/g, "_")
        .slice(0, 64) || "plans";
    return base + "." + (ext || "json");
  }

  function triggerDownload(filename, data, mime) {
    if (!isBrowser) return false;
    try {
      var blob = new Blob([data], {
        type: mime || "application/json;charset=utf-8",
      });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 0);
      return true;
    } catch (e) {
      logger.warn("[FileDownloadAdapter] download failed", e);
      return false;
    }
  }

  /* ----------------------------- Adapter class ----------------------------- */
  function FileDownloadAdapter(options) {
    options = options || {};
    this.name = "filedownload";
    this.ready = false;

    // Upstream adapter (cloud/dexie/localStorage/memory). Highly recommended.
    // Must have { init, get, set, del, keys, bulkGet, bulkSet }.
    this.upstream = options.upstream || null;

    // Cosmetic metadata for exported files
    this.appName = options.appName || "Suka Smart Assistant";
    this.appVersion = options.appVersion || "1.0";

    // export knobs
    this.maxList = clamp(options.maxList || 5000, 500, 20000);
  }

  FileDownloadAdapter.prototype.init = async function () {
    if (this.upstream && this.upstream.init) {
      try {
        await this.upstream.init();
      } catch (_e) {}
    }
    this.ready = true;
    return;
  };

  /* -------------------------- KV proxy (delegation) ------------------------ */
  FileDownloadAdapter.prototype.get = function (key) {
    return this.upstream?.get?.(key);
  };
  FileDownloadAdapter.prototype.set = function (key, val) {
    return this.upstream?.set?.(key, val);
  };
  FileDownloadAdapter.prototype.del = function (key) {
    return this.upstream?.del?.(key);
  };
  FileDownloadAdapter.prototype.keys = function (prefix) {
    return this.upstream?.keys?.(prefix);
  };
  FileDownloadAdapter.prototype.bulkGet = function (keys) {
    return this.upstream?.bulkGet?.(keys);
  };
  FileDownloadAdapter.prototype.bulkSet = function (entries) {
    return this.upstream?.bulkSet?.(entries);
  };

  /* ----------------------- Export helpers (JSON files) --------------------- */
  // Collect plans under scopes and optional favorites for user.
  // opts: { scope?: "global"|"user"|"all", userId?, domain?, includeDeleted?, includeFavorites?:true, filename?, title? }
  FileDownloadAdapter.prototype.exportToJSON = async function (opts) {
    opts = opts || {};
    var scope = opts.scope || "all";
    var domain = opts.domain || null;
    var includeDeleted = !!opts.includeDeleted;
    var includeFavorites =
      typeof opts.includeFavorites === "boolean" ? opts.includeFavorites : true;
    var userId = opts.userId || null;

    if (!this.upstream || !this.upstream.keys || !this.upstream.bulkGet) {
      throw new Error("Upstream adapter required for export");
    }

    eventBus.emit?.("export.started", {
      scope: scope,
      userId: userId || undefined,
      domain: domain || undefined,
      at: now(),
    });

    // Build prefixes according to your keying scheme:
    // plans:global:*         → featured/system
    // plans:user:<id>:*      → user plans
    // favorites:user:<id>    → favorites object { byId: { [planId]: { at, domain? } } }
    var prefixes = [];
    if (scope === "global" || scope === "all") prefixes.push("plans:global:");
    if (scope === "user" || scope === "all")
      prefixes.push(userId ? "plans:user:" + userId + ":" : "plans:user:");

    // gather keys
    var keys = [];
    for (var i = 0; i < prefixes.length; i++) {
      var ks = await this.upstream.keys(prefixes[i]);
      // limit aggressively to avoid huge memory spikes
      ks = (ks || []).slice(0, this.maxList);
      keys = keys.concat(ks);
    }

    // bulk get plan values
    var planObjs = await this.upstream.bulkGet(keys);
    var plans = [];
    for (var j = 0; j < planObjs.length; j++) {
      var p = planObjs[j];
      if (!p || !p.id) continue;
      if (!includeDeleted && p.meta && p.meta.deletedAt) continue;
      if (domain && p.domain !== domain) continue;
      plans.push(p);
    }

    // favorites (per user)
    var favorites = null;
    if (includeFavorites && userId) {
      var favKey = "favorites:user:" + userId;
      favorites = await this.upstream.get(favKey);
      // normalize
      if (!favorites || !isObj(favorites) || !favorites.byId) {
        favorites = { byId: {} };
      }
    }

    var payload = {
      kind: "suka.export/v1",
      app: this.appName,
      appVersion: this.appVersion,
      exportedAt: now(),
      scope: scope,
      domain: domain || null,
      userId: userId || null,
      includeDeleted: includeDeleted,
      counts: {
        plans: plans.length,
        favorites: favorites ? Object.keys(favorites.byId || {}).length : 0,
      },
      items: plans,
      favorites: favorites, // may be null
    };

    eventBus.emit?.("export.finished", {
      scope: scope,
      userId: userId || undefined,
      domain: domain || undefined,
      counts: payload.counts,
      at: now(),
    });
    automation?.emit?.("nba.signal", {
      kind: "export.finished",
      scope: scope,
      domain: domain || undefined,
      count: plans.length,
      ts: now(),
    });

    return payload;
  };

  // Download JSON in the browser; otherwise just return the JSON string to caller.
  FileDownloadAdapter.prototype.downloadJSON = async function (
    filename,
    payload
  ) {
    var json = isStr(payload) ? payload : toJSON(payload);
    var name = safeFilename(filename || "plans_export", "json");
    if (isBrowser) {
      var ok = triggerDownload(name, json, "application/json;charset=utf-8");
      return { ok: ok, filename: name, bytes: json.length };
    }
    return { ok: true, filename: name, text: json };
  };

  // Convenience: export a coherent user bundle and download it.
  // opts: same as exportToJSON + { filename? }
  FileDownloadAdapter.prototype.exportUserBundle = async function (opts) {
    var payload = await this.exportToJSON(opts);
    var fnameParts = ["suka", opts?.domain || "all", opts?.scope || "all"];
    if (opts?.userId) fnameParts.push("u-" + String(opts.userId).slice(0, 16));
    fnameParts.push(
      String(new Date(payload.exportedAt).toISOString().replace(/[:.]/g, "-"))
    );
    var fname = fnameParts.join("_") + ".json";
    return this.downloadJSON(fname, payload);
  };

  /* ---------------------------- Import helpers ----------------------------- */
  // Accepts a parsed JSON payload (object) that matches exportToJSON output.
  // Writes plans and favorites back via upstream.bulkSet/upstream.set.
  // opts: { scope?: "user"|"global", userId?, overwrite?:bool }
  FileDownloadAdapter.prototype.importFromJSON = async function (
    payload,
    opts
  ) {
    opts = opts || {};
    if (!payload || !Array.isArray(payload.items))
      throw new Error("Invalid import payload");
    if (!this.upstream || !this.upstream.bulkSet)
      throw new Error("Upstream adapter required for import");

    var scope = opts.scope === "global" ? "global" : "user";
    var userId = opts.userId || payload.userId || null;
    if (scope === "user" && !userId)
      throw new Error("Import into user scope requires userId");

    eventBus.emit?.("import.started", {
      scope: scope,
      userId: userId || undefined,
      at: now(),
    });

    // Prepare entries for bulkSet
    var entries = [];
    var imported = 0;

    for (var i = 0; i < payload.items.length; i++) {
      var plan = payload.items[i];
      if (!plan || !plan.id) continue;

      // Re-scope plan on import:
      var newScope = scope === "global" ? "global" : "user:" + userId;
      var key = "plans:" + newScope + ":" + plan.id;

      // Ensure minimal normalization (keep original timestamps; router will bump version later if needed)
      var value = {
        id: plan.id,
        title: plan.title || "Untitled Plan",
        domain: plan.domain || payload.domain || "general",
        steps:
          plan.steps ||
          plan.tasks ||
          plan.items ||
          plan.content ||
          plan.body ||
          [],
        tags: plan.tags || [],
        summary: plan.summary || plan.description || "",
        schedule: plan.schedule || null,
        meta: Object.assign({}, plan.meta || {}, {
          source: scope === "global" ? "featured" : "user",
          createdBy: scope === "global" ? plan.meta?.createdBy || null : userId,
          createdAt: plan.meta?.createdAt || now(),
          updatedAt: now(),
          version: (plan.meta?.version || 0) + 1,
        }),
        scope: newScope,
      };

      entries.push({ key: key, value: value });
      imported++;
    }

    // Bulk write plans
    if (entries.length) {
      await this.upstream.bulkSet(entries);
    }

    // Import favorites if present & importing into user scope
    var favImported = 0;
    if (
      scope === "user" &&
      userId &&
      payload.favorites &&
      isObj(payload.favorites) &&
      payload.favorites.byId
    ) {
      var favKey = "favorites:user:" + userId;
      // Merge existing favorites with incoming
      var existingFav = await this.upstream.get(favKey);
      if (!existingFav || !isObj(existingFav) || !existingFav.byId)
        existingFav = { byId: {} };

      var byId = Object.assign({}, existingFav.byId);
      var incoming = payload.favorites.byId;
      Object.keys(incoming).forEach(function (pid) {
        byId[pid] = byId[pid] || incoming[pid];
      });

      await this.upstream.set(favKey, { byId: byId });
      favImported = Object.keys(payload.favorites.byId || {}).length;

      // Emit favorite.updated per imported favorite (throttled: one aggregate event)
      eventBus.emit?.("favorites.imported", {
        userId: userId,
        count: favImported,
        at: now(),
      });
    }

    // Orchestration signals
    eventBus.emit?.("import.finished", {
      scope: scope,
      userId: userId || undefined,
      plans: imported,
      favorites: favImported,
      at: now(),
    });
    if (imported > 0) {
      eventBus.emit?.("plan.imported", {
        count: imported,
        scope: scope === "global" ? "global" : "user:" + userId,
        at: now(),
      });
    }
    automation?.emit?.("nba.signal", {
      kind: "import.finished",
      scope: scope,
      userId: userId || undefined,
      count: imported,
      ts: now(),
    });

    return { imported: imported, favorites: favImported };
  };

  // Accept a File (browser) or string (Node/SSR) and import.
  // opts: passthrough to importFromJSON()
  FileDownloadAdapter.prototype.importFromFile = async function (
    fileOrString,
    opts
  ) {
    var text = null;

    if (
      isBrowser &&
      typeof File !== "undefined" &&
      fileOrString instanceof File
    ) {
      text = await fileOrString.text();
    } else if (isStr(fileOrString)) {
      text = fileOrString;
    } else if (fileOrString && fileOrString.text) {
      // Blob-like
      text = await fileOrString.text();
    } else {
      throw new Error("Unsupported import input");
    }

    var payload = fromJSON(text);
    if (!payload) throw new Error("Invalid JSON file");
    return this.importFromJSON(payload, opts);
  };

  /* ------------------------------ Factory/export --------------------------- */
  function createFileDownloadAdapter(options) {
    return new FileDownloadAdapter(options || {});
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      FileDownloadAdapter: FileDownloadAdapter,
      createFileDownloadAdapter: createFileDownloadAdapter,
    };
  } else {
    // @ts-ignore
    window.FileDownloadAdapter = FileDownloadAdapter;
    // @ts-ignore
    window.createFileDownloadAdapter = createFileDownloadAdapter;
  }
})();
