// C:\Users\larho\suka-smart-assistant\src\features\planning\PlanningGraphProvider.jsx

/**
 * PlanningGraphProvider
 *
 * React context provider that:
 * - Loads the Planning Graph JSON (nodes, edges, metadata).
 * - Exposes helpers to query nodes and relationships.
 * - Integrates lightly with SSA eventBus + featureFlags.
 *
 * This is the "graph backbone" for:
 * - Calculators (ScripturalYearLengthCalculator, HouseholdStabilityCalculator, etc.)
 * - Next Steps mappings
 * - Cross-domain flows (meals → storehouse → garden → curriculum → stability, etc.)
 *
 * How it fits into SSA:
 * - Mounted near the app root (e.g., inside App.jsx).
 * - Children use `usePlanningGraph()` to:
 *   - Read graph/nodes/edges.
 *   - Resolve downstream flows and mappings.
 *   - Feed recommendations into SessionRunner "Now" candidates.
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
} from "react";

// Be defensive: eventBus + featureFlags may not exist in early development.
// We import them as namespace modules and guard their usage.
let eventBus = {};
let featureFlags = {};

try {
  // eslint-disable-next-line global-require
  eventBus = require("@/services/eventBus");
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn("[PlanningGraphProvider] eventBus not available yet.", err);
}

try {
  // eslint-disable-next-line global-require
  featureFlags = require("@/services/featureFlags");
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn("[PlanningGraphProvider] featureFlags not available yet.", err);
}

/**
 * @typedef {Object} PlanningGraphNode
 * @property {string} nodeKey
 * @property {string} kind                 - e.g. "calculator-node" | "planner-node" | "session-node"
 * @property {string} [label]
 * @property {string} [version]
 * @property {Record<string, any>} [config]
 * @property {Record<string, any>} [meta]
 */

/**
 * @typedef {Object} PlanningGraphEdge
 * @property {string} from                 - source nodeKey
 * @property {string} to                   - target nodeKey
 * @property {string} [reason]             - human readable note
 * @property {Record<string, any>} [meta]
 */

/**
 * @typedef {Object} PlanningGraph
 * @property {string} [version]
 * @property {PlanningGraphNode[]} nodes
 * @property {PlanningGraphEdge[]} edges
 * @property {Record<string, any>} [mappings]   - optional global mappings
 */

/**
 * @typedef {Object} PlanningGraphContextValue
 * @property {PlanningGraph|null} graph
 * @property {boolean} isLoading
 * @property {Error|null} error
 * @property {Record<string, PlanningGraphNode>} nodesByKey
 * @property {(nodeKey: string) => PlanningGraphNode | undefined} getNodeByKey
 * @property {(nodeKey: string) => PlanningGraphEdge[]} getOutgoingEdges
 * @property {(nodeKey: string) => PlanningGraphNode[]} getDownstreamNodes
 * @property {(mappingKey: string) => any} getGlobalMapping
 * @property {() => Promise<void>} refreshGraph
 * @property {boolean} familyFundMode
 * @property {string} [graphVersion]
 */

// Default, safe empty value
const PlanningGraphContext = createContext(
  /** @type {PlanningGraphContextValue} */ ({
    graph: null,
    isLoading: false,
    error: null,
    nodesByKey: {},
    getNodeByKey: () => undefined,
    getOutgoingEdges: () => [],
    getDownstreamNodes: () => [],
    getGlobalMapping: () => undefined,
    refreshGraph: async () => {},
    familyFundMode: false,
    graphVersion: undefined,
  })
);

/**
 * Default loader for the Planning Graph.
 *
 * NOTE:
 * - This is intentionally defensive so the app can run even
 *   before the actual graph JSON exists.
 * - If you have a real planningGraph.json, plug it into `loadGraph`
 *   prop in App.jsx or update this function to import it.
 *
 * @returns {Promise<PlanningGraph>}
 */
async function defaultLoadPlanningGraph() {
  // Try to import a local JSON file if it exists and bundler supports it.
  try {
    // Adjust this path + assert block if you store the JSON differently.
    // eslint-disable-next-line global-require
    const mod = require("./planningGraph.json");
    const graph = mod.default || mod;

    if (graph && Array.isArray(graph.nodes) && Array.isArray(graph.edges)) {
      return graph;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[PlanningGraphProvider] planningGraph.json not found or failed to load. Using empty graph.",
      err
    );
  }

  /** @type {PlanningGraph} */
  const fallback = {
    version: "0.0.0-empty",
    nodes: [],
    edges: [],
    mappings: {},
  };
  return fallback;
}

/**
 * Emit an event via the eventBus if available.
 *
 * @param {string} type
 * @param {string} source
 * @param {Record<string, any>} data
 */
function emitSafe(type, source, data) {
  const emitter = eventBus.emit || eventBus.default || eventBus.dispatch;
  if (typeof emitter !== "function") return;

  try {
    emitter({
      type,
      ts: new Date().toISOString(),
      source,
      data,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[PlanningGraphProvider] Failed to emit event", err);
  }
}

/**
 * Hook for children to access the Planning Graph context.
 *
 * @returns {PlanningGraphContextValue}
 */
export function usePlanningGraph() {
  const ctx = useContext(PlanningGraphContext);
  if (!ctx) {
    throw new Error(
      "usePlanningGraph must be used within a PlanningGraphProvider."
    );
  }
  return ctx;
}

/**
 * PlanningGraphProvider props.
 *
 * @typedef {Object} PlanningGraphProviderProps
 * @property {React.ReactNode} children
 * @property {() => Promise<PlanningGraph>} [loadGraph]
 *   Optional custom loader. If not provided, defaultLoadPlanningGraph is used.
 * @property {(graph: PlanningGraph) => void} [onGraphLoaded]
 *   Optional callback when graph successfully loads.
 */

/**
 * PlanningGraphProvider component.
 *
 * Example usage in App.jsx:
 * ```jsx
 * import { PlanningGraphProvider } from "@/features/planning/PlanningGraphProvider";
 *
 * function App() {
 *   return (
 *     <PlanningGraphProvider>
 *       <AppShell />
 *     </PlanningGraphProvider>
 *   );
 * }
 * ```
 *
 * @param {PlanningGraphProviderProps} props
 */
export function PlanningGraphProvider({ children, loadGraph, onGraphLoaded }) {
  const [graph, setGraph] = useState(/** @type {PlanningGraph|null} */ (null));
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(/** @type {Error|null} */ (null));

  const familyFundMode =
    typeof featureFlags.familyFundMode === "boolean"
      ? featureFlags.familyFundMode
      : Boolean(featureFlags.default && featureFlags.default.familyFundMode);

  const loader = loadGraph || defaultLoadPlanningGraph;

  const refreshGraph = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const loaded = await loader();

      if (!loaded || !Array.isArray(loaded.nodes) || !Array.isArray(loaded.edges)) {
        throw new Error(
          "[PlanningGraphProvider] Loaded graph is missing required properties `nodes` and/or `edges`."
        );
      }

      setGraph(loaded);

      emitSafe("planning.graph.loaded", "features/planning/PlanningGraphProvider", {
        version: loaded.version || "unknown",
        nodeCount: loaded.nodes.length,
        edgeCount: loaded.edges.length,
      });

      if (typeof onGraphLoaded === "function") {
        onGraphLoaded(loaded);
      }
    } catch (err) {
      const castErr = err instanceof Error ? err : new Error(String(err));
      setError(castErr);
      // eslint-disable-next-line no-console
      console.error("[PlanningGraphProvider] Failed to load graph:", castErr);

      emitSafe("planning.graph.load.failed", "features/planning/PlanningGraphProvider", {
        message: castErr.message,
      });
    } finally {
      setIsLoading(false);
    }
  }, [loader, onGraphLoaded]);

  // Initial load
  useEffect(() => {
    refreshGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nodesByKey = useMemo(() => {
    if (!graph || !Array.isArray(graph.nodes)) return {};
    return graph.nodes.reduce((acc, node) => {
      if (node && typeof node.nodeKey === "string") {
        acc[node.nodeKey] = node;
      }
      return acc;
    }, /** @type {Record<string, PlanningGraphNode>} */ ({}));
  }, [graph]);

  /**
   * Get node by its nodeKey.
   *
   * @param {string} nodeKey
   * @returns {PlanningGraphNode | undefined}
   */
  const getNodeByKey = useCallback(
    (nodeKey) => {
      if (!nodeKey) return undefined;
      return nodesByKey[nodeKey];
    },
    [nodesByKey]
  );

  /**
   * Get all outgoing edges for a given nodeKey.
   *
   * @param {string} nodeKey
   * @returns {PlanningGraphEdge[]}
   */
  const getOutgoingEdges = useCallback(
    (nodeKey) => {
      if (!graph || !Array.isArray(graph.edges) || !nodeKey) return [];
      return graph.edges.filter((edge) => {
        const from = edge.from || edge.source; // tolerate different field names
        return from === nodeKey;
      });
    },
    [graph]
  );

  /**
   * Get all downstream nodes for a given nodeKey.
   *
   * @param {string} nodeKey
   * @returns {PlanningGraphNode[]}
   */
  const getDownstreamNodes = useCallback(
    (nodeKey) => {
      const edges = getOutgoingEdges(nodeKey);
      if (!edges.length) return [];

      const downstreamKeys = edges
        .map((edge) => edge.to || edge.target)
        .filter(Boolean);

      return downstreamKeys
        .map((k) => nodesByKey[String(k)])
        .filter(Boolean);
    },
    [getOutgoingEdges, nodesByKey]
  );

  /**
   * Get a global mapping by key, if the graph defines a `mappings` object.
   *
   * @param {string} mappingKey
   * @returns {any}
   */
  const getGlobalMapping = useCallback(
    (mappingKey) => {
      if (!graph || !graph.mappings || typeof graph.mappings !== "object") {
        return undefined;
      }
      return graph.mappings[mappingKey];
    },
    [graph]
  );

  const value = useMemo(
    () => ({
      graph,
      isLoading,
      error,
      nodesByKey,
      getNodeByKey,
      getOutgoingEdges,
      getDownstreamNodes,
      getGlobalMapping,
      refreshGraph,
      familyFundMode,
      graphVersion: graph ? graph.version : undefined,
    }),
    [
      graph,
      isLoading,
      error,
      nodesByKey,
      getNodeByKey,
      getOutgoingEdges,
      getDownstreamNodes,
      getGlobalMapping,
      refreshGraph,
      familyFundMode,
    ]
  );

  return (
    <PlanningGraphContext.Provider value={value}>
      {children}
    </PlanningGraphContext.Provider>
  );
}

export default PlanningGraphProvider;
