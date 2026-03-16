/**
 * src/features/session/session.guards/equipment.js
 * -----------------------------------------------------------------------------
 * Equipment Guard
 *
 * Purpose:
 * - Blocks starting/advancing a step when required equipment/devices are not
 *   available. This covers both physical tools (thermometer, scale) tracked by
 *   your household registry and device capabilities (camera/mic/BT/USB/etc).
 *
 * How it fits:
 * - The SessionRunner calls this guard when:
 *    • starting a session that has steps with "equipment" in blockers, or
 *    • advancing to a step that declares "equipment" in blockers.
 * - The guard returns a structured allow/deny result. The runner handles UI
 *   messaging, pause state, and retry prompts. No user-facing events are
 *   emitted from this guard (the runner emits session.* events).
 *
 * Contract & Conventions:
 * - Steps can request equipment via step.metadata.requiredEquipment: string[]
 *   where each string is a normalized "equipment key", e.g.:
 *     "thermometer", "kitchenScale", "timer", "probe", "camera", "microphone",
 *     "bluetooth", "usb", "serial", "tts", "vibrate"
 * - Heuristics:
 *   • If step.metadata.donenessCue === "probeTemp" OR step.metadata.tempTargetF > 0,
 *     require "thermometer" if not explicitly declared.
 *   • If session.prefs.voiceGuidance === true, require "tts" (Web Speech API).
 *
 * Household Equipment Registry (optional but recommended):
 * - Pass ctx.registry with functions:
 *     has(toolKey: string): boolean | Promise<boolean>
 *     resolveAlias?(name: string): string | null
 *   If not provided, we still validate device capabilities and assume common
 *   kitchen tools are present (configurable).
 *
 * Feature flag:
 * - featureFlags.equipmentGuard (default: enabled if flag missing).
 *
 * Defensive defaults:
 * - Unknown equipment keys: allow progression unless settings.failClosed === true.
 * - Missing registry: allow common tools unless settings.assumeCommonTools === false.
 *
 * Extension points:
 * - Add more capability checkers in capabilityCheckers map.
 * - Add registry lookups for your real inventory/equipment store.
 *
 * Typed JSDoc documents inputs/outputs.
 * -----------------------------------------------------------------------------
 */

import eventBus from "../../../services/events/eventBus";
import { featureFlags } from "../../../config/featureFlags";

/**
 * @typedef {Object} SessionStep
 * @property {string} id
 * @property {string} title
 * @property {string} desc
 * @property {number} durationSec
 * @property {Array<"inventory"|"weather"|"quietHours"|"sabbath"|"equipment">} blockers
 * @property {{
 *   tempTargetF?: number,
 *   donenessCue?: "color"|"texture"|"probeTemp"|"timer"|"smell",
 *   cueNotes?: string,
 *   requiredEquipment?: string[]
 * }} [metadata]
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} title
 * @property {{ type: "recipe"|"cleaningPlan"|"gardenPlan"|"animalTask"|"import"|"manual", refId: string|null }} source
 * @property {SessionStep[]} steps
 * @property {{ voiceGuidance?: boolean, haptic?: boolean, autoAdvance?: boolean }} prefs
 * @property {"pending"|"running"|"paused"|"completed"|"aborted"} status
 * @property {{ currentStepIndex: number, elapsedSec: number, startedAt: string|null, pausedAt: string|null }} progress
 * @property {{ skippedSteps: string[], adjustments: Array<any> }} analytics
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} EquipmentRegistry
 * @property {(toolKey: string) => (boolean|Promise<boolean>)} has
 * @property {(name: string) => (string|null)} [resolveAlias]
 */

/**
 * @typedef {Object} GuardContext
 * @property {EquipmentRegistry} [registry]
 * @property {{
 *   enabled?: boolean,                 // default true or feature flag
 *   failClosed?: boolean,              // default false (unknown keys don't block)
 *   assumeCommonTools?: boolean,       // default true (thermometer/scale/timer)
 *   commonTools?: string[],            // default ["timer"]
 *   aliasMap?: Record<string,string>,  // normalize incoming names → equipment keys
 * }} [settings]
 * @property {(msg: string, data?: any) => void} [logger]
 */

/**
 * @typedef {Object} GuardResult
 * @property {boolean} allowed
 * @property {"equipment"} guard
 * @property {string} [reason]
 * @property {string} [message]
 * @property {string} [retryAt] // ISO timestamp (usually undefined here)
 * @property {string[]} [missing] // list of missing equipment keys (normalized)
 */

/**
 * Evaluate equipment guard for a given step.
 * @param {Session} session
 * @param {number} stepIndex - Index of considered step (-1 means "session start"; we inspect the first runnable step)
 * @param {GuardContext} [ctx]
 * @returns {Promise<GuardResult>}
 */
export async function evaluateEquipmentGuard(session, stepIndex, ctx = {}) {
  const log = ctx.logger || (() => {});
  if (!isGuardEnabled(ctx?.settings)) {
    return { allowed: true, guard: "equipment" };
  }

  const step = resolveStep(session, stepIndex);
  // If step doesn't declare equipment blocker, skip.
  if (!hasBlocker(step, "equipment")) {
    return { allowed: true, guard: "equipment" };
  }

  const settings = withDefaults(ctx.settings);
  const required = normalizeRequiredEquipment(step, session, settings);
  if (required.length === 0) {
    return { allowed: true, guard: "equipment" };
  }

  // Resolve aliases then dedupe
  const normalized = Array.from(
    new Set(
      required
        .map((r) => normalizeKey(r, ctx.registry, settings))
        .filter(Boolean)
    )
  );

  const missing = [];
  for (const key of normalized) {
    // 1) Check device/web capabilities if it's a capability key.
    if (key in capabilityCheckers) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await capabilityCheckers[key]();
      if (!ok) {
        missing.push(key);
        continue;
      }
      continue;
    }

    // 2) Ask household registry for physical/soft tools.
    const hasTool = await hasFromRegistryOrAssume(key, ctx.registry, settings);
    if (!hasTool) missing.push(key);
  }

  if (missing.length > 0) {
    const msg =
      "Required equipment not available: " +
      missing.map(formatKeyForUI).join(", ") +
      ". Connect or substitute, then try again.";
    safeEmitDebug("guard.equipment.blocked", {
      sessionId: safeId(session),
      stepId: step?.id || null,
      missing,
    });
    return {
      allowed: false,
      guard: "equipment",
      reason: "equipment_missing",
      message: msg,
      missing,
    };
  }

  return { allowed: true, guard: "equipment" };
}

/* --------------------------------- Helpers -------------------------------- */

function isGuardEnabled(settings) {
  const fromSettings =
    typeof settings?.enabled === "boolean" ? settings.enabled : undefined;
  if (typeof fromSettings === "boolean") return fromSettings;

  try {
    if (
      featureFlags &&
      Object.prototype.hasOwnProperty.call(featureFlags, "equipmentGuard")
    ) {
      return !!featureFlags.equipmentGuard;
    }
  } catch {
    // ignore
  }
  return true; // default ON
}

/**
 * With sane defaults.
 * @param {GuardContext["settings"]} s
 */
function withDefaults(s) {
  const d = {
    enabled: true,
    failClosed: false,
    assumeCommonTools: true,
    commonTools: ["timer"], // timer always available in runner UI
    aliasMap: {
      probe: "thermometer",
      instantRead: "thermometer",
      tempProbe: "thermometer",
      foodScale: "kitchenScale",
      scale: "kitchenScale",
      cam: "camera",
      mic: "microphone",
      bt: "bluetooth",
      speech: "tts",
      voice: "tts",
    },
  };
  return Object.assign({}, d, s || {});
}

/**
 * Extract/augment required equipment from step & session prefs.
 * @param {SessionStep|null|undefined} step
 * @param {Session} session
 * @param {ReturnType<typeof withDefaults>} settings
 */
function normalizeRequiredEquipment(step, session, settings) {
  const base = Array.isArray(step?.metadata?.requiredEquipment)
    ? step.metadata.requiredEquipment.slice()
    : [];

  // Heuristic: temp targets / probe doneness implies thermometer.
  const needThermo =
    (typeof step?.metadata?.tempTargetF === "number" &&
      step.metadata.tempTargetF > 0) ||
    step?.metadata?.donenessCue === "probeTemp";

  if (
    needThermo &&
    !base.some((k) => normalizeKey(k, null, settings) === "thermometer")
  ) {
    base.push("thermometer");
  }

  // If voice guidance: require TTS capability (Web Speech API).
  if (
    session?.prefs?.voiceGuidance &&
    !base.some((k) => normalizeKey(k, null, settings) === "tts")
  ) {
    base.push("tts");
  }

  return base;
}

/**
 * Resolve a step for evaluation.
 * If stepIndex === -1, choose currentStepIndex or 0.
 * @param {Session} session
 * @param {number} stepIndex
 * @returns {SessionStep|null}
 */
function resolveStep(session, stepIndex) {
  if (!session || !Array.isArray(session.steps) || session.steps.length === 0)
    return null;
  if (
    typeof stepIndex === "number" &&
    stepIndex >= 0 &&
    stepIndex < session.steps.length
  ) {
    return session.steps[stepIndex];
  }
  const idx =
    Number.isFinite(session?.progress?.currentStepIndex) &&
    session.progress.currentStepIndex >= 0
      ? session.progress.currentStepIndex
      : 0;
  return session.steps[idx] || null;
}

/**
 * @param {SessionStep|undefined|null} step
 * @param {string} blocker
 */
function hasBlocker(step, blocker) {
  if (!step || !Array.isArray(step.blockers)) return false;
  return step.blockers.includes(blocker);
}

/**
 * Normalize a requested equipment key using registry alias or settings aliasMap.
 * @param {string} raw
 * @param {EquipmentRegistry|undefined} registry
 * @param {ReturnType<typeof withDefaults>} settings
 */
function normalizeKey(raw, registry, settings) {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  const lowered = s.toLowerCase();
  const aliasHit = settings.aliasMap?.[lowered];
  if (aliasHit) return aliasHit;

  if (registry && typeof registry.resolveAlias === "function") {
    const r = registry.resolveAlias(lowered);
    if (typeof r === "string" && r) return r;
  }

  // known capability keys or common tool names should be kept as-is
  return lowered;
}

/**
 * Ask registry if present; otherwise fall back to "assumeCommonTools".
 * @param {string} key
 * @param {EquipmentRegistry|undefined} registry
 * @param {ReturnType<typeof withDefaults>} settings
 */
async function hasFromRegistryOrAssume(key, registry, settings) {
  // Assume common tools if configured (timer/thermometer/scale).
  const isCommon =
    settings.commonTools.includes(key) ||
    (settings.assumeCommonTools &&
      (key === "thermometer" || key === "kitchenScale"));

  if (registry && typeof registry.has === "function") {
    try {
      const val = await registry.has(key);
      if (typeof val === "boolean") return val;
    } catch {
      // ignore registry errors, fall through to assumption
    }
  }

  return !!isCommon;
}

/**
 * Friendly label for UI messages.
 * @param {string} key
 */
function formatKeyForUI(key) {
  switch (key) {
    case "kitchenScale":
      return "Kitchen Scale";
    case "tts":
      return "Text-to-Speech (Voice)";
    case "bt": // rarely used because aliasMap normalizes this to bluetooth
    case "bluetooth":
      return "Bluetooth";
    default:
      // Title-case fallback
      return key.replace(/(^\w|[_-]\w)/g, (m) =>
        m.replace(/[_-]/, " ").toUpperCase()
      );
  }
}

function safeId(session) {
  return (session && typeof session.id === "string" && session.id) || null;
}

function safeEmitDebug(type, data) {
  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit({
        type,
        ts: new Date().toISOString(),
        source: "equipmentGuard",
        data,
      });
    }
  } catch {
    // no-op
  }
}

/* --------------------------- Capability Checkers --------------------------- */
/**
 * Each checker returns a Promise<boolean> indicating whether the device/API
 * appears available. These are best-effort probes; we *do not* request
 * persistent permissions here—only capability existence. The runner can ask
 * for permission later when starting the step.
 */
const capabilityCheckers = {
  /** Camera present (MediaDevices) */
  async camera() {
    try {
      if (!navigator?.mediaDevices?.enumerateDevices) return false;
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.some((d) => d.kind === "videoinput");
    } catch {
      return false;
    }
  },

  /** Microphone present (MediaDevices) */
  async microphone() {
    try {
      if (!navigator?.mediaDevices?.enumerateDevices) return false;
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.some((d) => d.kind === "audioinput");
    } catch {
      return false;
    }
  },

  /** Text-to-Speech support */
  async tts() {
    try {
      // Some browsers lazily populate voices; still, existence of speechSynthesis is enough to proceed.
      return typeof window !== "undefined" && "speechSynthesis" in window;
    } catch {
      return false;
    }
  },

  /** Vibration support (for haptic cues on mobile) */
  async vibrate() {
    try {
      return (
        typeof navigator !== "undefined" &&
        typeof navigator.vibrate === "function"
      );
    } catch {
      return false;
    }
  },

  /** Web Bluetooth */
  async bluetooth() {
    try {
      // Presence of navigator.bluetooth is a good heuristic; requesting devices needs user gesture, so skip.
      return typeof navigator !== "undefined" && !!navigator.bluetooth;
    } catch {
      return false;
    }
  },

  /** WebUSB */
  async usb() {
    try {
      return typeof navigator !== "undefined" && !!navigator.usb;
    } catch {
      return false;
    }
  },

  /** Web Serial (for serial thermometers/scales) */
  async serial() {
    try {
      return typeof navigator !== "undefined" && !!navigator.serial;
    } catch {
      return false;
    }
  },
};

/* ----------------------------- Public API Shape ---------------------------- */

/**
 * Convenience for current step (session.progress.currentStepIndex).
 * @param {Session} session
 * @param {GuardContext} [ctx]
 * @returns {Promise<GuardResult>}
 */
export async function evaluateForCurrentStep(session, ctx) {
  const idx = safeStepIndex(session);
  return evaluateEquipmentGuard(session, idx, ctx);
}

function safeStepIndex(session) {
  if (!session || !session.progress) return -1;
  const i = Number(session.progress.currentStepIndex);
  return Number.isFinite(i) && i >= 0 ? i : -1;
}

/* --------------------------------- Default -------------------------------- */

const equipmentGuard = {
  id: "equipment",
  evaluate: evaluateEquipmentGuard,
  evaluateForCurrentStep,
};

export default equipmentGuard;

/* --------------------------------- Usage -----------------------------------
 * // In SessionRunner (pseudo):
 * import equipmentGuard from "@/features/session/session.guards/equipment";
 *
 * async function guardCheck(session, stepIndex, ctx) {
 *   const res = await equipmentGuard.evaluate(session, stepIndex, {
 *     ...ctx,
 *     settings: {
 *       // enabled: true,
 *       // failClosed: false,
 *       // assumeCommonTools: true,
 *       // commonTools: ["timer","thermometer","kitchenScale"],
 *       // aliasMap: { tempProbe: "thermometer" },
 *     },
 *     registry: {
 *       has: async (key) => myHouseholdEquipmentStore.has(key), // integrate with your DB
 *       resolveAlias: (name) => myAliasResolver(name),
 *     },
 *   });
 *   if (!res.allowed) {
 *     // Show "Connect required equipment" sheet with res.missing list,
 *     // offer "Retry" once user connects devices or chooses substitutions.
 *   }
 * }
 * -------------------------------------------------------------------------- */
