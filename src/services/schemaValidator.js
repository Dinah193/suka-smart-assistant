// C:\Users\larho\suka-smart-assistant\src\services\schemaValidator.js
// Suka Smart Assistant – Schema Validator
// -----------------------------------------------------------------------------
// PURPOSE
// - Centralized, browser-friendly JSON-schema-ish validator for your Suka imports,
//   automations, schedules, and shared orchestration payloads.
// - LIGHTWEIGHT so it works offline and doesn’t require a big AJV bundle.
// - Understands your Suka fields: __importType, saveAsFavorite, schedule, reverseMeta,
//   familyFundMode-ish metadata, coop/collaborative flags.
// - Auto-injects reverseMeta so reverse generation always works.
// - Auto-clones system templates into user-owned favorites if needed.
// - UPDATED to your current domain set (multi-domain imports):
//     • recipe
//     • mealPlan
//     • cleaningPlan
//     • gardenPlan
//     • gardenCare
//     • harvestPlan
//     • storehouseGoal
//     • storehouseStock
//     • animalPlan
//     • animalAcquisition
//     • butcherySession
//     • inventoryUpdate
//     • preservationPlan (forward-looking for preservation/dehydrating/canning)
//     • video / article / scanCompareTrust (for video/how-to and receipt/circular flows)
//     • generic
//
// HOW THIS FITS THE PIPELINE
// imports → (schemaValidator.validateImport) → normalized payload with:
//    - known __importType
//    - reverseMeta ensured
//    - schedule normalized
//    - flags for coop/familyFundMode
// → emit { type:"import.parsed", ts, source:"schemaValidator", data:{...} } on eventBus
// → automation runtime can now suggest/schedule sessions
// → optional hub: a *validator* does not change household data, so we DO NOT auto-export
//   BUT we expose a helper exportToHubIfEnabled(...) for future callers that *do* mutate
//   and reuse this file.
// -----------------------------------------------------------------------------

(function () {
  // ------------------------------ Defensive deps ------------------------------
  const isBrowser = typeof window !== "undefined";

  let eventBus = { emit() {}, on() {}, off() {} };
  try {
    // eslint-disable-next-line global-require
    const eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {
    // no-op – browser build without alias or early init
  }

  let featureFlags = { familyFundMode: false };
  try {
    // eslint-disable-next-line global-require
    const ff = require("@/config/featureFlags.json");
    featureFlags = ff || featureFlags;
  } catch (_e) {
    // ok – keep default
  }

  let HubPacketFormatter = null;
  let FamilyFundConnector = null;
  try {
    // eslint-disable-next-line global-require
    HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  } catch (_e) {}
  try {
    // eslint-disable-next-line global-require
    FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
  } catch (_e) {}

  // ------------------------------ Constants -----------------------------------
  const DEFAULT_REVERSE_META = {
    shareTarget: "family-fund-hub",
    includeShare: true,
    format: "json"
  };

  // central registry – can be hot-extended at runtime
  // “import” schema mirrors the importable domains in siteAllowList.json
  const schemaRegistry = {
    import: {
      required: ["__importType"],
      // must stay in sync with:
      //  - src/services/siteAllowList.json (types there might use kebab-case; we map to camel here)
      //  - src/features/import/*
      allowedTypes: [
        "recipe",
        "mealPlan",
        "cleaningPlan",
        "gardenPlan",
        "gardenCare",
        "harvestPlan",
        "storehouseGoal",
        "storehouseStock",
        "animalPlan",
        "animalAcquisition",
        "butcherySession",
        "inventoryUpdate",
        "preservationPlan",
        "video",
        "article",
        "scanCompareTrust",
        "generic"
      ]
    },
    schedule: {
      required: ["id"]
    },
    event: {
      required: ["type"]
    }
  };

  // ------------------------------ Small utils --------------------------------
  const nowIso = () => new Date().toISOString();

  const safeClone = (o) => {
    if (!o) return {};
    try {
      return JSON.parse(JSON.stringify(o));
    } catch (_e) {
      return { ...o };
    }
  };

  function onlySoftErrors(errors) {
    // soft errors are the ones we auto-fixed or nudged
    // if we see “unknown import type” we consider it hard
    return errors.every((e) => {
      if (!e || !e.message) return true;
      return (
        e.message.includes("auto-injected") ||
        e.message.includes("auto-generated") ||
        e.message.includes("normalized") ||
        e.message.includes("converted to user-owned") ||
        e.message.includes("set to once")
      );
    });
  }

  function buildScheduleFromRule(rule) {
    if (!rule) {
      return {
        frequency: "once",
        runAt: Date.now() + 2 * 60 * 1000
      };
    }
    if (rule === "once+5min") {
      return {
        frequency: "once",
        runAt: Date.now() + 5 * 60 * 1000
      };
    }
    if (rule === "daily@9") {
      const d = new Date();
      const runAt = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0, 0).getTime();
      return {
        frequency: "daily",
        runAt
      };
    }
    // fallback
    return {
      frequency: "once",
      runAt: Date.now() + 2 * 60 * 1000
    };
  }

  // tries to guess the import type from text/url/title – tuned for your multi-domain app
  function inferImportType(raw) {
    const txt = (raw && (raw.title || raw.text || raw.url || raw.source || "") || "").toLowerCase();

    // pinterest → usually meal or garden
    if (txt.includes("pinterest.com")) return "mealPlan";

    // garden / seed / care / harvest
    if (txt.includes("seed") || txt.includes("garden") || txt.includes("burpee") || txt.includes("nursery")) {
      return "gardenPlan";
    }
    if (txt.includes("prune") || txt.includes("watering") || txt.includes("mulch")) {
      return "gardenCare";
    }
    if (txt.includes("harvest") || txt.includes("pick at")) {
      return "harvestPlan";
    }

    // preservation
    if (txt.includes("canning") || txt.includes("dehydrate") || txt.includes("ferment") || txt.includes("preserve")) {
      return "preservationPlan";
    }

    // storehouse
    if (txt.includes("storehouse") || txt.includes("pantry goal")) {
      return "storehouseGoal";
    }
    if (txt.includes("grocery section") || txt.includes("restock") || txt.includes("stock up")) {
      return "storehouseStock";
    }

    // cleaning / declutter
    if (txt.includes("cleaning") || txt.includes("declutter") || txt.includes("wash day")) {
      return "cleaningPlan";
    }

    // animal / butchery
    if (txt.includes("animal acquisition") || txt.includes("buy goats") || txt.includes("buy sheep")) {
      return "animalAcquisition";
    }
    if (txt.includes("butchery") || txt.includes("slaughter") || txt.includes("cut sheet")) {
      return "butcherySession";
    }
    if (txt.includes("animal") || txt.includes("breed")) {
      return "animalPlan";
    }

    // scan-ish (receipts, circulars, ads)
    if (txt.includes("receipt") || txt.includes("circular") || txt.includes("scan")) {
      return "inventoryUpdate";
    }

    // video/how-to
    if (txt.includes("youtube.com") || txt.includes("youtu.be") || txt.includes("m.youtube.com")) {
      return "video";
    }

    // meal planning
    if (txt.includes("meal plan") || txt.includes("weekly menu") || txt.includes("batch cook")) {
      return "mealPlan";
    }

    // default to recipe
    if (txt.includes("recipe") || txt.includes("ingredients")) {
      return "recipe";
    }

    return "recipe";
  }

  // optional – for future: if validation ends up producing an inventory-like payload
  // we can route it to the Hub. For now, schema validation itself does not do that,
  // but other services can reuse this helper.
  function exportToHubIfEnabled(payload) {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    try {
      const pkt = HubPacketFormatter.toHubPacket(payload);
      FamilyFundConnector.send(pkt);
    } catch (_e) {
      // fail silently
    }
  }

  // ------------------------------ Core object ---------------------------------
  const schemaValidator = {
    /**
     * register/update a schema at runtime
     * - used by: new import types, beta domains, mobile/PWA share-target handlers
     */
    registerSchema(name, schemaObj) {
      if (!name || typeof name !== "string") return;
      schemaRegistry[name] = schemaObj || {};
    },

    /**
     * validate an import-like payload
     * - ensures __importType is present & known (or inferred)
     * - ensures reverseMeta present
     * - makes sure user can own the plan/session
     * - normalizes schedule
     * - emits eventBus event for observability
     *
     * returns: { valid, errors, normalized }
     */
    validateImport(payload, opts = {}) {
      const errors = [];
      const cloned = safeClone(payload);

      // 1) ensure type
      if (!cloned.__importType) {
        cloned.__importType = inferImportType(cloned);
        errors.push({
          path: "__importType",
          message: `missing __importType → auto-injected/inferred as '${cloned.__importType}'`
        });
      }

      // 2) check against registry
      const importSchema = schemaRegistry.import;
      if (
        importSchema &&
        Array.isArray(importSchema.allowedTypes) &&
        !importSchema.allowedTypes.includes(cloned.__importType)
      ) {
        errors.push({
          path: "__importType",
          message: `unknown import type '${cloned.__importType}' – not in schemaRegistry.import.allowedTypes`
        });
      }

      // 3) favorites / user-owned rule
      // your rule: “Users can save their own favorite sessions and schedules, not just system ones.”
      if (cloned.systemTemplate === true && opts.allowUserCopy !== false) {
        cloned.userTemplate = true;
        cloned.saveAsFavorite = true;
        errors.push({
          path: "saveAsFavorite",
          message: "systemTemplate detected → converted to user-owned favorite (auto-injected)"
        });
      } else if (typeof cloned.saveAsFavorite === "undefined" && opts.defaultSaveAsFavorite) {
        cloned.saveAsFavorite = true;
        errors.push({
          path: "saveAsFavorite",
          message: "saveAsFavorite missing → defaulted to true (auto-injected)"
        });
      }

      // 4) reverse generation support
      if (!cloned.reverseMeta) {
        cloned.reverseMeta = { ...DEFAULT_REVERSE_META };
        errors.push({
          path: "reverseMeta",
          message: "reverseMeta was missing → auto-injected default (auto-injected)"
        });
      } else {
        // ensure required keys
        if (!cloned.reverseMeta.shareTarget) {
          cloned.reverseMeta.shareTarget = DEFAULT_REVERSE_META.shareTarget;
          errors.push({
            path: "reverseMeta.shareTarget",
            message: "reverseMeta.shareTarget missing → set to default (auto-injected)"
          });
        }
        if (typeof cloned.reverseMeta.includeShare === "undefined") {
          cloned.reverseMeta.includeShare = DEFAULT_REVERSE_META.includeShare;
          errors.push({
            path: "reverseMeta.includeShare",
            message: "reverseMeta.includeShare missing → set to default (auto-injected)"
          });
        }
        if (!cloned.reverseMeta.format) {
          cloned.reverseMeta.format = DEFAULT_REVERSE_META.format;
          errors.push({
            path: "reverseMeta.format",
            message: "reverseMeta.format missing → set to default (auto-injected)"
          });
        }
      }

      // 5) schedule validation / normalization
      if (cloned.schedule) {
        const { valid: schedValid, errors: schedErrors, normalized: schedNorm } = this.validateSchedule(
          cloned.schedule
        );
        if (!schedValid) {
          errors.push({
            path: "schedule",
            message: "schedule is invalid",
            details: schedErrors
          });
        } else if (schedErrors && schedErrors.length) {
          // even if valid, carry over soft messages
          errors.push({
            path: "schedule",
            message: "schedule normalized with soft warnings",
            details: schedErrors
          });
        }
        cloned.schedule = schedNorm;
      }

      // 6) co-op / collaborative flag – needed for “plan with others” SSA → Hub
      if (cloned.collaborative === true && !cloned.coop) {
        cloned.coop = true;
        errors.push({
          path: "coop",
          message: "collaborative plan → marked as coop for multi-household goal (auto-injected)"
        });
      }

      // 7) familyFundMode hint – SSA still owns the data
      if (typeof cloned.familyFundMode === "undefined" && featureFlags.familyFundMode) {
        cloned.familyFundMode = true;
        errors.push({
          path: "familyFundMode",
          message: "featureFlags.familyFundMode is true → hint added to payload (auto-injected)"
        });
      }

      const valid = errors.length === 0 || onlySoftErrors(errors);

      // emit observability event – imports → intelligence → automation
      eventBus.emit("schema.validation.completed", {
        type: "schema.validation.completed",
        ts: nowIso(),
        source: "schemaValidator",
        data: {
          valid,
          errors,
          payload: cloned
        }
      });

      if (!valid) {
        // also emit a failure event (automation can inspect)
        eventBus.emit("schema.validation.failed", {
          type: "schema.validation.failed",
          ts: nowIso(),
          source: "schemaValidator",
          data: {
            errors,
            payload: cloned
          }
        });
      }

      return { valid, errors, normalized: cloned };
    },

    /**
     * validate an automation / schedule payload
     * supports:
     *  - { id, frequency, runAt }
     *  - { rule: "once+5min" }
     *  - { rule: "daily@9" }
     * emits: schema.schedule.validated
     */
    validateSchedule(schedule) {
      const errors = [];
      const cloned = safeClone(schedule);

      // accept a "rule" like from PWA/bookmarklet/share-target
      if (cloned.rule && !cloned.frequency) {
        const built = buildScheduleFromRule(cloned.rule);
        Object.assign(cloned, built);
        errors.push({
          path: "rule",
          message: "rule detected → schedule normalized from rule (auto-injected)"
        });
      }

      // id
      if (!cloned.id) {
        cloned.id = `sch-${Math.random().toString(36).slice(2)}`;
        errors.push({ path: "id", message: "schedule.id missing → auto-generated (auto-injected)" });
      }

      // frequency / runAt defaults
      if (!cloned.frequency) {
        cloned.frequency = "once";
        cloned.runAt = Date.now() + 2 * 60 * 1000;
        errors.push({
          path: "frequency",
          message: "frequency/rule missing → set to once in 2 minutes (auto-injected)"
        });
      }

      const valid = errors.length === 0 || onlySoftErrors(errors);

      eventBus.emit("schema.schedule.validated", {
        type: "schema.schedule.validated",
        ts: nowIso(),
        source: "schemaValidator",
        data: {
          valid,
          errors,
          schedule: cloned
        }
      });

      return {
        valid,
        errors,
        normalized: cloned
      };
    },

    /**
     * validate an event envelope used by your shared orchestration
     * emits: schema.event.validated
     */
    validateEvent(evt) {
      const errors = [];
      const cloned = safeClone(evt);

      if (!cloned.type) {
        cloned.type = "unknown";
        errors.push({ path: "type", message: "event.type missing → set to 'unknown' (auto-injected)" });
      }

      // recommended: must have payload
      if (typeof cloned.payload === "undefined") {
        errors.push({ path: "payload", message: "event.payload missing" });
      }

      // shared orchestration whitelist – updated to match your import routes map + PWA flows
      const ok = [
        "import.queue.enqueue",
        "import.preview.open",
        "import.preview.favorite",
        "import.preview.reverse",
        "import.service.completed",
        "import.settings.changed",
        "automation.schedule.request",
        "automation.schedule.updated",
        "import.pwa-share.received",
        "schema.validation.completed" // allow validators to re-emit
      ];
      if (!ok.includes(cloned.type)) {
        errors.push({
          path: "type",
          message: "event.type not in shared orchestration list"
        });
      }

      const valid = errors.length === 0 || onlySoftErrors(errors);

      eventBus.emit("schema.event.validated", {
        type: "schema.event.validated",
        ts: nowIso(),
        source: "schemaValidator",
        data: {
          valid,
          errors,
          event: cloned
        }
      });

      return {
        valid,
        errors,
        normalized: cloned
      };
    },

    /**
     * Convenience: validate + classify + return domain
     * Useful for ImportRouter or ImportService to quickly know what pipeline to pick.
     */
    classify(payload) {
      const { valid, normalized, errors } = this.validateImport(payload);
      return {
        valid,
        errors,
        domain: normalized.__importType || "generic",
        payload: normalized
      };
    },

    /**
     * For future: expose export helper for services that *do* mutate
     */
    _exportToHubIfEnabled: exportToHubIfEnabled,

    /**
     * For admin/debug in browser
     */
    _getRegistry() {
      return safeClone(schemaRegistry);
    }
  };

  // ------------------------------ Export --------------------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { schemaValidator };
  } else {
    // browser/global fallback
    // @ts-ignore
    window.schemaValidator = schemaValidator;
  }
})();
