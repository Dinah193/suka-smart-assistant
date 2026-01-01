// src/features/calculators/calculatorContext.jsx

/**
 * Suka Smart Assistant (SSA) – Calculator Context
 * ---------------------------------------------------------------------------
 * HOW THIS FITS:
 * - Central React Context for all calculators (Health, StorehouseMeals, Garden, etc.).
 * - Shares calculator state, results, and status across:
 *     - Calculator pages
 *     - Dashboard widgets
 *     - SessionRunner hint cards
 * - Connects calculator results to the Planning Graph by emitting nodeScore events
 *   through the global eventBus, so planners and analytics can react.
 *
 * CONTRACTS:
 * - Uses CALCULATOR_TYPES from calculatorTypes.js for metadata (domain, nodeId, route).
 * - Emits events:
 *     planningGraph.nodeScore.updated.<domain>.<calculatorId>
 *   when a calculator result is updated and has a usable numeric score.
 *
 * EXTENSION POINTS:
 * - Add persistence (Dexie/localStorage) inside the reducer or via effects.
 * - Add per-calculator schemas/validation before accepting results.
 * - Integrate with SessionRunner to auto-create sessions based on results.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer
} from "react";
import { CALCULATOR_TYPES, getCalculatorConfig } from "./calculatorTypes";
// Prefer relative import to avoid alias coupling; adjust if you standardize "@/services".
import eventBus from "../../services/eventBus";

/**
 * @typedef {"idle" | "loading" | "success" | "error"} CalculatorStatus
 */

/**
 * @typedef {Object} CalculatorStateEntry
 * @property {string} id                       Calculator id (e.g., "bmi").
 * @property {string | undefined} nodeId       Planning Graph node id (if any).
 * @property {CalculatorStatus} status         Current status of this calculator.
 * @property {any} value                       Last computed result (shape per calculator).
 * @property {any} meta                        Extra metadata (e.g., score, inputs).
 * @property {string | null} error             Error message, if any.
 * @property {string | null} lastUpdated       ISO timestamp of last update.
 */

/**
 * @typedef {Object} CalculatorContextState
 * @property {{[id: string]: CalculatorStateEntry}} calculators
 * @property {string | null} activeCalculatorId
 */

/**
 * @typedef {Object} CalculatorContextValue
 * @property {CalculatorContextState} state
 * @property {(calculatorId: string) => void} setActiveCalculator
 * @property {(args: {
 *   calculatorId: string;
 *   value: any;
 *   meta?: any;
 *   nodeIdOverride?: string;
 *   status?: CalculatorStatus;
 * }) => void} updateCalculatorResult
 * @property {(calculatorId: string, status: CalculatorStatus, error?: string | null) => void} setCalculatorStatus
 * @property {(calculatorId: string) => void} resetCalculator
 * @property {() => void} resetAllCalculators
 * @property {(calculatorId: string) => CalculatorStateEntry | undefined} getCalculatorState
 */

const CalculatorContext = createContext /** @type {CalculatorContextValue | undefined} */ (
  undefined
);

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** @type {CalculatorContextState} */
const INITIAL_STATE = {
  calculators: {},
  activeCalculatorId: null
};

const ACTIONS = {
  SET_ACTIVE: "SET_ACTIVE",
  UPDATE_RESULT: "UPDATE_RESULT",
  SET_STATUS: "SET_STATUS",
  RESET_ONE: "RESET_ONE",
  RESET_ALL: "RESET_ALL"
};

/**
 * @typedef {Object} ActionBase
 * @property {string} type
 */

/**
 * @typedef {ActionBase & { type: "SET_ACTIVE"; payload: { calculatorId: string | null } }} SetActiveAction
 * @typedef {ActionBase & { type: "UPDATE_RESULT"; payload: {
 *   calculatorId: string;
 *   value: any;
 *   meta?: any;
 *   nodeId?: string;
 *   status?: CalculatorStatus;
 *   ts: string;
 * }}} UpdateResultAction
 * @typedef {ActionBase & { type: "SET_STATUS"; payload: {
 *   calculatorId: string;
 *   status: CalculatorStatus;
 *   error?: string | null;
 *   ts: string;
 * }}} SetStatusAction
 * @typedef {ActionBase & { type: "RESET_ONE"; payload: { calculatorId: string } }} ResetOneAction
 * @typedef {ActionBase & { type: "RESET_ALL" }} ResetAllAction
 *
 * @typedef {SetActiveAction | UpdateResultAction | SetStatusAction | ResetOneAction | ResetAllAction} CalculatorAction
 */

/**
 * @param {CalculatorContextState} state
 * @param {CalculatorAction} action
 * @returns {CalculatorContextState}
 */
function calculatorReducer(state, action) {
  switch (action.type) {
    case ACTIONS.SET_ACTIVE: {
      const { calculatorId } = action.payload;
      return {
        ...state,
        activeCalculatorId: calculatorId
      };
    }

    case ACTIONS.UPDATE_RESULT: {
      const { calculatorId, value, meta, nodeId, status, ts } =
        action.payload;
      const prev = state.calculators[calculatorId];

      /** @type {CalculatorStateEntry} */
      const updatedEntry = {
        id: calculatorId,
        nodeId: nodeId || prev?.nodeId || getCalculatorConfig(calculatorId)?.nodeId,
        status: status || "success",
        value,
        meta,
        error: null,
        lastUpdated: ts
      };

      return {
        ...state,
        calculators: {
          ...state.calculators,
          [calculatorId]: updatedEntry
        }
      };
    }

    case ACTIONS.SET_STATUS: {
      const { calculatorId, status, error, ts } = action.payload;
      const prev = state.calculators[calculatorId] || {
        id: calculatorId,
        nodeId: getCalculatorConfig(calculatorId)?.nodeId,
        status: "idle",
        value: null,
        meta: null,
        error: null,
        lastUpdated: null
      };

      return {
        ...state,
        calculators: {
          ...state.calculators,
          [calculatorId]: {
            ...prev,
            status,
            error: error ?? null,
            lastUpdated: ts
          }
        }
      };
    }

    case ACTIONS.RESET_ONE: {
      const { calculatorId } = action.payload;
      if (!state.calculators[calculatorId]) return state;

      const next = { ...state.calculators };
      delete next[calculatorId];

      return {
        ...state,
        calculators: next,
        activeCalculatorId:
          state.activeCalculatorId === calculatorId
            ? null
            : state.activeCalculatorId
      };
    }

    case ACTIONS.RESET_ALL: {
      return {
        calculators: {},
        activeCalculatorId: null
      };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * Provider for CalculatorContext.
 *
 * Wrap this high in the tree (e.g., around Tier 2 pages) so:
 *  - Calculator pages
 *  - Dashboard widgets
 *  - SessionRunner hint components
 * all share a unified view of calculator state.
 *
 * @param {{ children: React.ReactNode }} props
 */
export function CalculatorProvider({ children }) {
  const [state, dispatch] = useReducer(calculatorReducer, INITIAL_STATE);

  /**
   * Set the currently active calculator (for UI focus, tabs, etc.)
   * @type {(calculatorId: string) => void}
   */
  const setActiveCalculator = useCallback((calculatorId) => {
    if (!calculatorId || typeof calculatorId !== "string") return;
    dispatch({
      type: ACTIONS.SET_ACTIVE,
      payload: { calculatorId }
    });
  }, []);

  /**
   * Internal helper to safely emit events without crashing the app
   * if eventBus is missing or misconfigured.
   *
   * @param {string} type
   * @param {any} data
   */
  const safeEmit = useCallback((type, data) => {
    try {
      if (eventBus && typeof eventBus.emit === "function") {
        eventBus.emit({
          type,
          ts: new Date().toISOString(),
          source: "CalculatorContext",
          data
        });
      }
    } catch (err) {
      // Fail silently – telemetry could be added here if desired.
      // console.warn("CalculatorContext: failed to emit event", err);
    }
  }, []);

  /**
   * Update a calculator result and emit Planning Graph events if applicable.
   *
   * @type {(args: {
   *   calculatorId: string;
   *   value: any;
   *   meta?: any;
   *   nodeIdOverride?: string;
   *   status?: CalculatorStatus;
   * }) => void}
   */
  const updateCalculatorResult = useCallback(
    ({ calculatorId, value, meta, nodeIdOverride, status }) => {
      if (!calculatorId || typeof calculatorId !== "string") return;
      const ts = new Date().toISOString();

      // Resolve nodeId and domain from config
      const config = getCalculatorConfig(calculatorId);
      const nodeId = nodeIdOverride || config?.nodeId;
      const domain = config?.domain;

      dispatch({
        type: ACTIONS.UPDATE_RESULT,
        payload: {
          calculatorId,
          value,
          meta,
          nodeId,
          status: status || "success",
          ts
        }
      });

      // Infer a numeric score if possible
      let score = undefined;
      if (meta && typeof meta.score === "number") {
        score = meta.score;
      } else if (typeof value === "number") {
        score = value;
      }

      // Emit Planning Graph event if we know the nodeId and domain
      if (nodeId && domain && typeof score === "number") {
        const eventType = `planningGraph.nodeScore.updated.${domain}.${calculatorId}`;
        safeEmit(eventType, {
          nodeId,
          calculatorId,
          score,
          value,
          meta,
          lastUpdated: ts
        });
      }
    },
    [safeEmit]
  );

  /**
   * Update the status (loading / error / success) of a calculator.
   *
   * @type {(calculatorId: string, status: CalculatorStatus, error?: string | null) => void}
   */
  const setCalculatorStatus = useCallback(
    (calculatorId, status, error = null) => {
      if (!calculatorId || typeof calculatorId !== "string") return;
      if (!status) return;

      const ts = new Date().toISOString();

      dispatch({
        type: ACTIONS.SET_STATUS,
        payload: {
          calculatorId,
          status,
          error,
          ts
        }
      });
    },
    []
  );

  /**
   * Reset a single calculator entry (remove it from the map).
   *
   * @type {(calculatorId: string) => void}
   */
  const resetCalculator = useCallback((calculatorId) => {
    if (!calculatorId || typeof calculatorId !== "string") return;
    dispatch({
      type: ACTIONS.RESET_ONE,
      payload: { calculatorId }
    });
  }, []);

  /**
   * Reset all calculators and active id.
   */
  const resetAllCalculators = useCallback(() => {
    dispatch({ type: ACTIONS.RESET_ALL });
  }, []);

  /**
   * Get the current state entry for a calculator id.
   *
   * @type {(calculatorId: string) => CalculatorStateEntry | undefined}
   */
  const getCalculatorState = useCallback(
    (calculatorId) => {
      if (!calculatorId || typeof calculatorId !== "string") return undefined;
      return state.calculators[calculatorId];
    },
    [state.calculators]
  );

  /** @type {CalculatorContextValue} */
  const value = useMemo(
    () => ({
      state,
      setActiveCalculator,
      updateCalculatorResult,
      setCalculatorStatus,
      resetCalculator,
      resetAllCalculators,
      getCalculatorState
    }),
    [
      state,
      setActiveCalculator,
      updateCalculatorResult,
      setCalculatorStatus,
      resetCalculator,
      resetAllCalculators,
      getCalculatorState
    ]
  );

  return (
    <CalculatorContext.Provider value={value}>
      {children}
    </CalculatorContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Access the full CalculatorContext value.
 *
 * @returns {CalculatorContextValue}
 */
export function useCalculatorContext() {
  const ctx = useContext(CalculatorContext);
  if (!ctx) {
    throw new Error(
      "useCalculatorContext must be used within a <CalculatorProvider />"
    );
  }
  return ctx;
}

/**
 * Convenience hook for a single calculator.
 *
 * @param {string} calculatorId
 * @returns {{
 *   config: import("./calculatorTypes").CalculatorTypeConfig | undefined;
 *   state: CalculatorStateEntry | undefined;
 *   setActive: () => void;
 *   updateResult: (value: any, meta?: any, status?: CalculatorStatus) => void;
 *   setStatus: (status: CalculatorStatus, error?: string | null) => void;
 *   reset: () => void;
 * }}
 */
export function useCalculator(calculatorId) {
  const {
    state,
    setActiveCalculator,
    updateCalculatorResult,
    setCalculatorStatus,
    resetCalculator
  } = useCalculatorContext();

  const config = getCalculatorConfig(calculatorId);
  const calcState = state.calculators[calculatorId];

  const setActive = useCallback(() => {
    if (!calculatorId) return;
    setActiveCalculator(calculatorId);
  }, [calculatorId, setActiveCalculator]);

  const updateResult = useCallback(
    (value, meta, status) => {
      if (!calculatorId) return;
      updateCalculatorResult({
        calculatorId,
        value,
        meta,
        status
      });
    },
    [calculatorId, updateCalculatorResult]
  );

  const setStatus = useCallback(
    (status, error) => {
      if (!calculatorId) return;
      setCalculatorStatus(calculatorId, status, error);
    },
    [calculatorId, setCalculatorStatus]
  );

  const reset = useCallback(() => {
    if (!calculatorId) return;
    resetCalculator(calculatorId);
  }, [calculatorId, resetCalculator]);

  return {
    config,
    state: calcState,
    setActive,
    updateResult,
    setStatus,
    reset
  };
}
