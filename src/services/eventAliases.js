/* eslint-disable no-console */
// src/services/eventAliases.js — canonical event/topic/schema aliases + middleware (ES2015-safe)

(function () {
  // ----------------------------- Safe Imports -----------------------------
  function prefer(mod, keys) {
    if (!mod) return {};
    if (!keys) return mod.default || mod;
    var picked = {};
    keys.forEach(function (k) {
      if (mod[k]) picked[k] = mod[k];
      else if (mod.default && mod.default[k]) picked[k] = mod.default[k];
    });
    return picked;
  }

  var EventsApi = {};
  try {
    EventsApi = prefer(require("@/automation/events")); // { emit, emitSync, use, Events, replay, ... }
  } catch (e) {}

  var _env = (typeof process !== "undefined" && process.env) ? process.env : {};
  var DEV = !!(_env.NODE_ENV ? _env.NODE_ENV.includes("dev") : true);

  // Try to load optional external alias config (JSON)
  var externalAliases = null;
  try {
    // Shape: { topics: { "<alias>": "<canonical>" }, schemas: { "<alias>": "<canonical>" }, payloadRenames: { "<topic>": { "<from>": "<to>" } } }
    externalAliases = require("@/data/event-aliases.json");
    externalAliases = externalAliases && (externalAliases.default || externalAliases);
  } catch (e) { /* optional */ }

  // ----------------------------- Helpers -----------------------------
  function toArray(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }

  function wildcardToRegExp(pattern) {
    // Supports "*", "segment.*", "a.b.*", exact strings; dots are literal segment separators
    // Escape regex-critical chars except '*'
    var esc = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + esc + "$", "i");
  }

  function shallowMerge(a, b) {
    var out = {}; var k;
    for (k in a || {}) out[k] = a[k];
    for (k in b || {}) out[k] = b[k];
    return out;
  }

  function warnOnce() {
    var seen = {};
    return function (key, msg) {
      if (seen[key]) return;
      seen[key] = true;
      try { console.warn(msg); } catch (e) {}
    };
  }
  var warn = warnOnce();

  // ----------------------------- Canonical Maps -----------------------------
  // 1) Topic aliases — left is ALIAS (legacy/variant), right is CANONICAL (preferred)
  //    Keep this list short & precise; use wildcards generously to cover families.
  var TOPIC_ALIASES = {
    // ------ Session ------
    "session.start": "session.started",
    "session.resume": "session.resumed",
    "session.end": "session.ended",

    // ------ Meals ------
    "meal.plan.created": "mealplan.confirmed",
    "mealplan.created": "mealplan.confirmed",
    "meal.plan.finalized": "mealplan.confirmed",
    "mealplan.finalized": "mealplan.confirmed",
    "mealplan.generate.draft": "mealplan.draft.requested",
    "meal.plan.generate.draft": "mealplan.draft.requested",
    "mealplan.draft.generate": "mealplan.draft.requested",
    "meal.plan.draft.requested": "mealplan.draft.requested",
    "grocery.list.generated": "grocerylist.generated",
    "grocery-list.generated": "grocerylist.generated",
    "cook.batch.start": "cooking.batch.started",
    "cook.batch.started": "cooking.batch.started",
    "cook.batch.done": "cooking.batch.completed",
    "cooking.batch.done": "cooking.batch.completed",

    // wildcard namespace cleanups
    "meals.plan.*": "mealplan.*",
    "meals.*": "mealplan.*", // broad legacy namespace -> route to mealplan.*

    // ------ Cleaning ------
    "clean.plan.generate.draft": "cleanplan.draft.requested",
    "clean.plan.draft.requested": "cleanplan.draft.requested",
    "clean.plan.confirmed": "cleanplan.confirmed",
    "cleaning.task.done": "cleaning.task.completed",
    "cleaning.tasks.completed": "cleaning.task.completed",
    "cleaning.plan.*": "cleanplan.*",

    // ------ Garden ------
    "garden.plan.generate.draft": "gardenplan.draft.requested",
    "garden.plan.draft.requested": "gardenplan.draft.requested",
    "garden.plan.confirmed": "gardenplan.confirmed",
    "garden.harvest.logged": "harvest.logged",
    "harvest.recorded": "harvest.logged",
    "garden.plan.*": "gardenplan.*",

    // ------ Animals / Butchery ------
    "animal.plan.generate.draft": "animalplan.draft.requested",
    "animal.plan.draft.requested": "animalplan.draft.requested",
    "butchery.batch.done": "butchery.batch.completed",
    "cold.storage.updated": "coldstorage.updated",
    "animal.plan.*": "animalplan.*",

    // ------ Cross-cutting ------
    "nba.refresh": "nba.updated",
    "inventory.changed": "inventory.updated",
    "stability.changed": "stability.score.changed",
    "milestone.hit": "milestone.achieved",
  };

  // 2) Schema aliases — left is ALIAS (legacy/variant), right is CANONICAL
  var SCHEMA_ALIASES = {
    "urn:suka:contracts:meal-plan": "urn:suka:contracts:mealplan",
    "urn:suka:contracts:clean-plan": "urn:suka:contracts:cleanplan",
    "urn:suka:contracts:garden-plan": "urn:suka:contracts:gardenplan",
    "urn:suka:contracts:animal-plan": "urn:suka:contracts:animalplan",
    "urn:suka:contracts:grocery-list": "urn:suka:contracts:grocerylist",
  };

  // 3) Per-topic payload key renames (migrations); { "<topic>": { "<from>": "<to>" } }
  //    These are shallow, top-level migrations; keep transforms idempotent.
  var PAYLOAD_RENAMES = {
    "mealplan.confirmed": { mealPlanId: "planId" },
    "mealplan.draft.requested": { templateId: "planTemplateId" },
    "grocerylist.generated": { list_id: "listId" },
    "cooking.batch.started": { batchId: "runId" },
    "cooking.batch.completed": { batchId: "runId" },

    "cleanplan.confirmed": { cleanPlanId: "planId" },
    "gardenplan.confirmed": { gardenPlanId: "planId" },
    "animalplan.draft.requested": { animalPlanId: "planId" },

    "inventory.updated": { sku_id: "skuId" },
    "harvest.logged": { harvestId: "logId" },
  };

  // Allow external JSON to extend/override the maps
  if (externalAliases) {
    if (externalAliases.topics) TOPIC_ALIASES = shallowMerge(TOPIC_ALIASES, externalAliases.topics);
    if (externalAliases.schemas) SCHEMA_ALIASES = shallowMerge(SCHEMA_ALIASES, externalAliases.schemas);
    if (externalAliases.payloadRenames) PAYLOAD_RENAMES = shallowMerge(PAYLOAD_RENAMES, externalAliases.payloadRenames);
  }

  // Precompile alias matchers (supports exact and wildcard)
  var _compiled = Object.keys(TOPIC_ALIASES).map(function (alias) {
    return { alias: alias, to: TOPIC_ALIASES[alias], rx: wildcardToRegExp(alias) };
  });

  // ----------------------------- Core API -----------------------------
  function resolveTopicAlias(topic) {
    if (!topic) return { topic: topic, aliased: false, from: null };
    var i, m;
    for (i = 0; i < _compiled.length; i++) {
      if (_compiled[i].rx.test(topic)) {
        m = _compiled[i];
        // If the canonical contains a wildcard tail, and alias had a tail, carry it forward.
        // ex: "cleaning.plan.*" -> "cleanplan.*" should map "cleaning.plan.draft.requested" -> "cleanplan.draft.requested"
        if (m.alias.indexOf("*") >= 0 && m.to.indexOf("*") >= 0) {
          try {
            var aliasPrefix = m.alias.split("*")[0];
            var suffix = topic.replace(new RegExp("^" + aliasPrefix.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&")), "");
            var canonPrefix = m.to.split("*")[0];
            return { topic: (canonPrefix + suffix).replace(/^\./, ""), aliased: true, from: topic };
          } catch (e) {
            return { topic: m.to.replace(/\.\*$/, ""), aliased: true, from: topic };
          }
        }
        return { topic: m.to, aliased: true, from: topic };
      }
    }
    return { topic: topic, aliased: false, from: null };
  }

  function resolveSchemaAlias(schemaId) {
    if (!schemaId) return { schema: schemaId, aliased: false, from: null };
    var canonical = SCHEMA_ALIASES[schemaId] || schemaId;
    return { schema: canonical, aliased: canonical !== schemaId, from: canonical !== schemaId ? schemaId : null };
  }

  function migratePayloadKeys(topic, payload) {
    var renames = PAYLOAD_RENAMES[topic];
    if (!renames || !payload) return payload;
    var out = shallowMerge({}, payload);
    var k;
    for (k in renames) {
      if (Object.prototype.hasOwnProperty.call(out, k)) {
        var to = renames[k];
        if (!(to in out)) out[to] = out[k];
        delete out[k];
        if (DEV) warn("payload_" + topic + "_" + k, "[eventAliases] Renamed payload key '" + k + "' → '" + to + "' for topic '" + topic + "'.");
      }
    }
    return out;
  }

  /**
   * Expand an input topic into a set of topics the system should emit (canonical + mirrors).
   * Examples:
   *   expandTopics("grocery.list.generated") -> ["grocerylist.generated"] plus optional mirrors
   *   expandTopics("cleaning.plan.draft.requested") -> ["cleanplan.draft.requested"]
   */
  function expandTopics(topic, opts) {
    var o = opts || {};
    var res = resolveTopicAlias(topic);
    var topics = [res.topic];
    if (o.includeAliasEcho && res.aliased) topics.push(topic); // let legacy listeners still see old name if desired
    return Array.from(new Set(topics));
  }

  /**
   * Canonicalize an envelope in-place: normalize topic, schema, payload keys.
   */
  function canonicalizeEnvelope(envelope) {
    if (!envelope) return envelope;
    var tRes = resolveTopicAlias(envelope.topic);
    var sRes = resolveSchemaAlias(envelope.schema);
    var newPayload = migratePayloadKeys(tRes.topic, envelope.payload);

    var newEnv = shallowMerge(envelope, {
      topic: tRes.topic,
      schema: sRes.schema,
      payload: newPayload,
    });

    // Retain origin info as tags to help debugging without breaking idempotence.
    var tags = toArray(newEnv.tags);
    if (tRes.aliased) tags.push("aliasedTopic");
    if (sRes.aliased) tags.push("aliasedSchema");
    newEnv.tags = Array.from(new Set(tags));

    // Attach hint for downstream (optional)
    if (tRes.aliased) newEnv.metaTopicAliasFrom = tRes.from;
    if (sRes.aliased) newEnv.metaSchemaAliasFrom = sRes.from;
    return newEnv;
  }

  // ----------------------------- Runtime Registry -----------------------------
  // Allow modules to add/remove aliases at runtime (e.g., experiments or partner integrations)
  function addTopicAlias(aliasPattern, canonicalPattern) {
    if (!aliasPattern || !canonicalPattern) return false;
    TOPIC_ALIASES[aliasPattern] = canonicalPattern;
    _compiled.push({ alias: aliasPattern, to: canonicalPattern, rx: wildcardToRegExp(aliasPattern) });
    return true;
  }

  function removeTopicAlias(aliasPattern) {
    if (!aliasPattern || !(aliasPattern in TOPIC_ALIASES)) return false;
    delete TOPIC_ALIASES[aliasPattern];
    _compiled = _compiled.filter(function (x) { return x.alias !== aliasPattern; });
    return true;
  }

  function addSchemaAlias(aliasId, canonicalId) {
    if (!aliasId || !canonicalId) return false;
    SCHEMA_ALIASES[aliasId] = canonicalId;
    return true;
  }

  function removeSchemaAlias(aliasId) {
    if (!aliasId || !(aliasId in SCHEMA_ALIASES)) return false;
    delete SCHEMA_ALIASES[aliasId];
    return true;
  }

  // ----------------------------- Middleware Installer -----------------------------
  /**
   * Injects aliasing as a middleware into your unified events hub.
   * Options:
   *   - rewrite (default true): rewrite the incoming envelope.topic/schema to canonical
   *   - mirror (default true): also emit a mirror event for the alias or canonical pair so legacy listeners still fire
   *   - mirrorDirection ("aliasToCanonical" | "canonicalToAlias" | "both"): which side gets mirrored (default "aliasToCanonical")
   *   - tag ("aliased"): tag added to mirrored envs to prevent loops and ease filtering
   */
  function installAliasMiddleware(eventsApi, options) {
    var api = eventsApi || EventsApi || {};
    if (!api.use || !api.emitSync) {
      if (DEV) console.warn("[eventAliases] Events API is missing 'use' or 'emitSync'. Middleware not installed.");
      return function noop() {};
    }

    var opts = shallowMerge({ rewrite: true, mirror: true, mirrorDirection: "aliasToCanonical", tag: "aliased" }, options || {});
    var DISPATCH_GUARD = "__aliasDispatchGuard";

    var off = api.use(function (env, next) {
      try {
        // Prevent infinite loops on mirrored re-emits
        if (env && env[DISPATCH_GUARD]) return next(env);

        var originalTopic = env.topic;
        var canonicalEnv = canonicalizeEnvelope(env);
        var changedTopic = canonicalEnv.topic !== originalTopic;

        // 1) Rewrite incoming envelope to canonical (recommended)
        var forwardEnv = opts.rewrite ? canonicalEnv : env;

        // 2) Continue the pipeline for the (possibly rewritten) event
        var p = next(forwardEnv);

        // 3) Mirror logic: emit a sibling event for legacy/canonical subscribers
        if (opts.mirror) {
          // alias → canonical mirror
          if (changedTopic && (opts.mirrorDirection === "aliasToCanonical" || opts.mirrorDirection === "both")) {
            try {
              var mirrorEnv = shallowMerge(canonicalEnv, {
                tags: Array.from(new Set(toArray(canonicalEnv.tags).concat([opts.tag]))),
              });
              mirrorEnv[DISPATCH_GUARD] = true;
              // Preserve correlation, session, actor; give it a unique eventId (events hub will stamp anyway)
              api.emitSync(mirrorEnv.topic, mirrorEnv.payload, mirrorEnv);
            } catch (e) { /* noop */ }
          }

          // canonical → alias mirror (useful if some UI still listens to legacy names)
          if (!changedTopic && (opts.mirrorDirection === "canonicalToAlias" || opts.mirrorDirection === "both")) {
            var aliasHit = resolveTopicAlias(originalTopic);
            // If topic was already canonical, try to find any alias keys that map to it and emit them
            var i;
            for (i = 0; i < _compiled.length; i++) {
              if (_compiled[i].to === originalTopic) {
                try {
                  var legacyTopic = _compiled[i].alias.replace(/\.\*$/, "");
                  var legacyEnv = shallowMerge(env, { topic: legacyTopic });
                  legacyEnv[DISPATCH_GUARD] = true;
                  legacyEnv.tags = Array.from(new Set(toArray(legacyEnv.tags).concat([opts.tag, "legacyMirror"])));
                  api.emitSync(legacyEnv.topic, legacyEnv.payload, legacyEnv);
                } catch (e) { /* noop */ }
              }
            }
          }
        }

        // 4) Telemetry (dev)
        if (DEV && changedTopic) {
          warn("alias_" + originalTopic, "[eventAliases] '" + originalTopic + "' → '" + canonicalEnv.topic + "' (schema: " + (canonicalEnv.schema || "n/a") + ").");
        }

        return p;
      } catch (e) {
        if (DEV) console.error("[eventAliases] middleware error", e);
        return next(env);
      }
    });

    return function uninstall() {
      try { if (api.offAll) api.offAll(); } catch (e) {}
      try { off && off(); } catch (e) {}
    };
  }

  // Auto-install if events hub is available
  try { installAliasMiddleware(EventsApi); } catch (e) {}

  // ----------------------------- Public Surface -----------------------------
  var api = {
    // Resolve/canonicalize
    resolveTopicAlias: resolveTopicAlias,
    resolveSchemaAlias: resolveSchemaAlias,
    expandTopics: expandTopics,
    canonicalizeEnvelope: canonicalizeEnvelope,

    // Mutate registry at runtime
    addTopicAlias: addTopicAlias,
    removeTopicAlias: removeTopicAlias,
    addSchemaAlias: addSchemaAlias,
    removeSchemaAlias: removeSchemaAlias,

    // Installer for the events hub
    installAliasMiddleware: installAliasMiddleware,

    // Exposed maps (read-only snapshots)
    get topicAliases() { return shallowMerge({}, TOPIC_ALIASES); },
    get schemaAliases() { return shallowMerge({}, SCHEMA_ALIASES); },
    get payloadRenames() { return shallowMerge({}, PAYLOAD_RENAMES); },
  };

  // CommonJS + ESM compatible export
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
    module.exports.default = api;
  } else {
    try { window.SukaEventAliases = api; } catch (e) {}
  }
})();
