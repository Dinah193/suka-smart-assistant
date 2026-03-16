// C:\Users\larho\suka-smart-assistant\src\features\stability\StabilityEngine.js

/**
 * StabilityEngine
 * ----------------
 * Core engine computing a household stability index using domain metrics
 * (cooking, cleaning, garden, animals, preservation, storehouse, etc.).
 *
 * How this fits:
 * - Upstream calculators, planners, and sessions emit or persist metrics
 *   (e.g., meal coverage, cleaning backlog, garden readiness).
 * - Domain pages and the global “Now” CTA ask StabilityEngine for:
 *     • overall stability index
 *     • per-domain stability indices
 *     • hotspots (domains in trouble)
 *     • recommended flows to stabilize (“foodStabilization”, “healthReset”, etc.)
 * - The SessionRunner and planning graph can then use these signals to
 *   prioritize which session template to run next.
 *
 * Design:
 * - Metrics are expected to be normalized to [0,1] where 1 = very stable/healthy.
 * - Domain weights from domainWeights.config.json determine how much each
 *   domain influences the overall index and some recommendation logic.
 * - Flow configs (flow.*.json) are injected at call-time; this file does NOT
 *   try to read the filesystem. Callers provide the subset of flows they care
 *   about so bundlers/tree-shaking remain happy.
 *
 * Events:
 * - Emits "stability.updated" on the event bus:
 *     { type, ts, source, data: StabilitySnapshot }
 * - Emits "stability.hotspot.detected" per domain when severity >= "warning".
 */

// Imports are defensive and alias-friendly; adjust paths if your alias differs.
import eventBus from "@/services/events/eventBus";
import domainWeightsConfig from "@/features/planning/configs/domainWeights.config.json";

/**
 * @typedef {Record<string, number>} DomainMetrics
 *  Arbitrary numeric metrics for a domain, already normalized to [0,1] where possible.
 *
 * @typedef {Object} StabilityMetricsInput
 * @property {Record<string, DomainMetrics>} domains
 *  Metrics keyed by domain id ("cooking", "cleaning", etc.).
 * @property {Object<string, any>} [meta]
 *  Optional metadata (timestamps, notes, etc.).
 *
 * @typedef {Object} DomainStability
 * @property {string} domain
 * @property {number} index          Normalized [0,1] stability score (1 = very stable).
 * @property {number} weight         Domain weight from config.
 * @property {DomainMetrics} metrics Raw metrics used to compute the index.
 *
 * @typedef {Object} StabilityHotspot
 * @property {string} domain
 * @property {"warning"|"critical"} severity
 * @property {number} index
 * @property {string[]} hints
 *
 * @typedef {Object} FlowConfig
 * @property {string} id
 * @property {string} title
 * @property {string} [description]
 * @property {string} [category]
 * @property {number} [priority]
 * @property {string[]} [domainsInvolved]
 *
 * @typedef {Object} FlowRecommendation
 * @property {string} id
 * @property {string} title
 * @property {number} score
 * @property {string[]} matchedDomains
 * @property {string[]} reasons
 *
 * @typedef {Object} StabilitySnapshot
 * @property {string} ts                      ISO timestamp of computation time.
 * @property {number} overallIndex            [0,1] overall stability score.
 * @property {Record<string, DomainStability>} domains
 * @property {StabilityHotspot[]} hotspots
 * @property {{ flows: FlowRecommendation[], suggestedNowDomains: string[] }} recommendations
 * @property {Object<string, any>} [meta]
 */

const ENGINE_SOURCE = "StabilityEngine";

/**
 * Clamp a numeric value to [0,1]. Non-numeric values fall back to 0.
 * @param {unknown} value
 * @returns {number}
 */
function clamp01(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Safely read domain weights from config; fall back to 1 when missing.
 * @param {string} domain
 * @returns {number}
 */
function getDomainWeight(domain) {
  if (
    domainWeightsConfig &&
    typeof domainWeightsConfig === "object" &&
    domainWeightsConfig.domains &&
    typeof domainWeightsConfig.domains[domain] === "number"
  ) {
    return domainWeightsConfig.domains[domain];
  }
  return 1;
}

/**
 * Compute a naive average of all numeric metrics in a domain.
 * Assumes metrics are already normalized [0,1].
 * If no usable metrics exist, returns null.
 *
 * @param {DomainMetrics} metrics
 * @returns {number|null}
 */
function computeDomainIndexFromMetrics(metrics) {
  if (!metrics || typeof metrics !== "object") return null;

  let sum = 0;
  let count = 0;

  for (const key of Object.keys(metrics)) {
    const v = metrics[key];
    if (typeof v === "number" && !Number.isNaN(v)) {
      sum += clamp01(v);
      count += 1;
    }
  }

  if (!count) return null;
  return clamp01(sum / count);
}

/**
 * Evaluate severity thresholds on a domain index.
 * @param {number} index
 * @param {{warning:number,critical:number}} thresholds
 * @returns {"none"|"warning"|"critical"}
 */
function classifySeverity(index, thresholds) {
  const value = clamp01(index);
  if (value <= thresholds.critical) return "critical";
  if (value <= thresholds.warning) return "warning";
  return "none";
}

class StabilityEngine {
  constructor() {
    /** @type {{warning:number,critical:number}} */
    this.severityThresholds = {
      warning: 0.6,
      critical: 0.35,
    };
  }

  /**
   * Compute a stability snapshot for given metrics and optional flow configs.
   *
   * @param {StabilityMetricsInput} metricsInput
   * @param {{ flows?: FlowConfig[], emitEvents?: boolean }} [options]
   * @returns {StabilitySnapshot | null}
   */
  computeStabilitySnapshot(metricsInput, options = {}) {
    const { flows = [], emitEvents = true } = options;

    if (!metricsInput || typeof metricsInput !== "object") {
      if (emitEvents) {
        this._emitSafe("stability.updated", {
          error: "invalid_metrics_input",
          message: "metricsInput must be an object",
        });
      }
      return null;
    }

    const ts = new Date().toISOString();
    const domainMetrics = metricsInput.domains || {};

    /** @type {Record<string, DomainStability>} */
    const domainStability = {};
    let weightedSum = 0;
    let weightTotal = 0;

    // 1) Compute per-domain indices and weighted overall score
    for (const domain of Object.keys(domainMetrics)) {
      const metrics = domainMetrics[domain] || {};
      const index = computeDomainIndexFromMetrics(metrics);
      const weight = getDomainWeight(domain);

      // If no metrics, treat index as null & skip from overall
      if (index === null) {
        domainStability[domain] = {
          domain,
          index: 0,
          weight,
          metrics,
        };
        continue;
      }

      const safeIndex = clamp01(index);
      domainStability[domain] = {
        domain,
        index: safeIndex,
        weight,
        metrics,
      };

      weightedSum += safeIndex * weight;
      weightTotal += weight;
    }

    // Fall back if no weighted domains are available
    const overallIndex =
      weightTotal > 0 ? clamp01(weightedSum / weightTotal) : 0;

    // 2) Compute hotspots based on thresholds
    const hotspots = this._computeHotspots(domainStability);

    // 3) Compute recommendations based on hotspots and flows
    const recommendations = this._computeRecommendations(
      domainStability,
      hotspots,
      flows
    );

    /** @type {StabilitySnapshot} */
    const snapshot = {
      ts,
      overallIndex,
      domains: domainStability,
      hotspots,
      recommendations,
      meta: metricsInput.meta || {},
    };

    // 4) Emit events for other systems (planning graph, SessionRunner, Hub, etc.)
    if (emitEvents) {
      this._emitSnapshotEvents(snapshot);
    }

    return snapshot;
  }

  /**
   * Compute hotspot objects from domain stability map.
   * @private
   * @param {Record<string, DomainStability>} domainStability
   * @returns {StabilityHotspot[]}
   */
  _computeHotspots(domainStability) {
    /** @type {StabilityHotspot[]} */
    const hotspots = [];

    for (const [domain, info] of Object.entries(domainStability)) {
      const severity = classifySeverity(info.index, this.severityThresholds);
      if (severity === "none") continue;

      /** @type {string[]} */
      const hints = [];

      if (info.index <= this.severityThresholds.critical) {
        hints.push("Consider a dedicated stabilization flow for this domain.");
      } else {
        hints.push(
          "Scheduling one or two focused sessions may relieve pressure."
        );
      }

      // Domain-specific hint seasoning (lightweight, easily extendable)
      if (domain === "cooking") {
        hints.push(
          "A batch-cooking or meal-planning session can quickly improve stability."
        );
      } else if (domain === "cleaning") {
        hints.push(
          "A timed cleaning sprint or zone reset session is often enough to stabilize."
        );
      } else if (domain === "garden") {
        hints.push(
          "Try a short garden maintenance or harvest logging session."
        );
      } else if (domain === "storehouse") {
        hints.push(
          "Run a storehouse inventory alignment or shopping-list planning session."
        );
      }

      hotspots.push({
        domain,
        severity,
        index: info.index,
        hints,
      });
    }

    return hotspots;
  }

  /**
   * Compute flow recommendations and suggested “Now” domains based on hotspots.
   *
   * @private
   * @param {Record<string, DomainStability>} domainStability
   * @param {StabilityHotspot[]} hotspots
   * @param {FlowConfig[]} flows
   * @returns {{ flows: FlowRecommendation[], suggestedNowDomains: string[] }}
   */
  _computeRecommendations(domainStability, hotspots, flows) {
    if (!Array.isArray(flows) || flows.length === 0) {
      // Even without flows, we can still suggest domains for the "Now" CTA.
      const suggestedNowDomains = this._suggestNowDomains(
        domainStability,
        hotspots
      );
      return { flows: [], suggestedNowDomains };
    }

    const hotspotDomains = new Set(hotspots.map((h) => h.domain));
    const suggestedNowDomains = this._suggestNowDomains(
      domainStability,
      hotspots
    );

    /** @type {FlowRecommendation[]} */
    const flowRecs = [];

    for (const flow of flows) {
      if (!flow || typeof flow !== "object" || !flow.id) continue;

      const domainsInvolved = Array.isArray(flow.domainsInvolved)
        ? flow.domainsInvolved
        : [];

      // Score = combination of:
      //  - how many hotspot domains it touches
      //  - severity level (critical > warning)
      //  - base flow priority (if provided)
      let score = 0;
      const matchedDomains = [];
      const reasons = [];

      for (const d of domainsInvolved) {
        if (hotspotDomains.has(d)) {
          matchedDomains.push(d);

          const stabilityInfo = domainStability[d];
          const severity = classifySeverity(
            stabilityInfo?.index ?? 0,
            this.severityThresholds
          );

          if (severity === "critical") {
            score += 1.5;
            reasons.push(`Critical instability in ${d}.`);
          } else if (severity === "warning") {
            score += 1.0;
            reasons.push(`Warning-level instability in ${d}.`);
          } else {
            score += 0.3;
          }
        }
      }

      if (!matchedDomains.length) {
        // Slight score for flows with domains that are present but not hotspots.
        for (const d of domainsInvolved) {
          if (domainStability[d]) {
            score += 0.1;
          }
        }
      }

      if (typeof flow.priority === "number") {
        score += clamp01(flow.priority);
      }

      if (score <= 0) continue; // not relevant enough to recommend

      flowRecs.push({
        id: flow.id,
        title: flow.title || flow.id,
        score,
        matchedDomains,
        reasons,
      });
    }

    // Sort descending by score
    flowRecs.sort((a, b) => b.score - a.score);

    return {
      flows: flowRecs,
      suggestedNowDomains,
    };
  }

  /**
   * Suggest which domains should provide the primary “Now” CTA based on
   * lowest stability and hotspots. This does NOT pick a specific session;
   * domain pages still resolve that using their own logic.
   *
   * @private
   * @param {Record<string, DomainStability>} domainStability
   * @param {StabilityHotspot[]} hotspots
   * @returns {string[]}
   */
  _suggestNowDomains(domainStability, hotspots) {
    const criticalDomains = hotspots
      .filter((h) => h.severity === "critical")
      .map((h) => h.domain);
    const warningDomains = hotspots
      .filter((h) => h.severity === "warning")
      .map((h) => h.domain);

    if (criticalDomains.length > 0) {
      // Prioritize critical domains by ascending index (worst first)
      return criticalDomains
        .slice()
        .sort(
          (a, b) =>
            (domainStability[a]?.index ?? 1) - (domainStability[b]?.index ?? 1)
        );
    }

    if (warningDomains.length > 0) {
      return warningDomains
        .slice()
        .sort(
          (a, b) =>
            (domainStability[a]?.index ?? 1) - (domainStability[b]?.index ?? 1)
        );
    }

    // If no hotspots, gently nudge domains with below-perfect stability
    const candidates = Object.values(domainStability)
      .filter((d) => d.index < 1)
      .sort((a, b) => a.index - b.index);

    return candidates.map((c) => c.domain);
  }

  /**
   * Emit snapshot + hotspot events on the event bus.
   * @private
   * @param {StabilitySnapshot} snapshot
   */
  _emitSnapshotEvents(snapshot) {
    const payloadBase = {
      ts: snapshot.ts,
      source: ENGINE_SOURCE,
    };

    this._emitSafe("stability.updated", {
      ...payloadBase,
      data: snapshot,
    });

    for (const hotspot of snapshot.hotspots) {
      this._emitSafe("stability.hotspot.detected", {
        ...payloadBase,
        data: hotspot,
      });
    }
  }

  /**
   * Safe wrapper around eventBus.emit. If eventBus fails or is undefined,
   * this becomes a no-op instead of crashing the app.
   *
   * @private
   * @param {string} type
   * @param {any} data
   */
  _emitSafe(type, data) {
    try {
      if (!eventBus || typeof eventBus.emit !== "function") return;
      eventBus.emit({
        type,
        ts: new Date().toISOString(),
        source: ENGINE_SOURCE,
        data,
      });
    } catch (err) {
      // Deliberately swallow errors—stability computation should not crash SSA.
      if (process && process.env && process.env.NODE_ENV === "development") {
        // eslint-disable-next-line no-console
        console.warn("[StabilityEngine] Failed to emit event:", type, err);
      }
    }
  }
}

/**
 * Singleton instance for app-wide use.
 * Most callers should import this instance instead of creating their own.
 *
 * Example:
 *   import { stabilityEngine } from "@/features/stability/StabilityEngine";
 *
 *   const snapshot = stabilityEngine.computeStabilitySnapshot(metrics, {
 *     flows: [foodStabilizationFlow, healthResetFlow],
 *   });
 */
export const stabilityEngine = new StabilityEngine();

export default StabilityEngine;
