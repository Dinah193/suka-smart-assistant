// src/hooks/useAutomationTemplates.js
import { useMemo, useCallback } from "react";
import useAutomationVersion from "@/hooks/useAutomationVersion";
import { automation } from "@/services/automation/runtime";

/**
 * useAutomationTemplates
 * -----------------------------------------------------------------------------
 * Purpose:
 * - Expose automation templates as a stable, UI-ready API.
 * - Recompute only when the automation runtime version changes (via useAutomationVersion()).
 * - Provide fast selectors (by type/agent/tags/enabled), fuzzy-ish search, grouping,
 *   and light normalization so cards/menus don't need to do data massaging.
 *
 * Expected template shape (flexible; we normalize where possible):
 * {
 *   id: string,
 *   title: string,
 *   description?: string,
 *   type?: "agent"|"trigger"|"schedule"|"orchestrator"|"template"|"tool",
 *   agent?: string,                  // e.g. "mealPlanningAgent"
 *   tags?: string[],                 // e.g. ["meals","batch","intuitive","tier2"]
 *   scope?: string|string[],         // e.g. "tier2" or ["tier1","tier2"]
 *   enabled?: boolean,
 *   triggers?: string[]|object[],    // (any form; not enforced)
 *   meta?: object
 * }
 */

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function normalizeTemplate(t, i) {
  const id = t?.id ?? `tmpl_${i}`;
  const title = (t?.title || id).trim();
  const description = (t?.description || "").trim();
  const type = (t?.type || "template").toLowerCase();
  const agent = t?.agent || null;
  const tags = (t?.tags && Array.isArray(t.tags)) ? t.tags.map(String) : [];
  const scope = toArray(t?.scope).map(String);
  const enabled = Boolean(t?.enabled ?? true);
  const triggers = t?.triggers ?? [];
  const meta = t?.meta ?? {};

  return { id, title, description, type, agent, tags, scope, enabled, triggers, meta, __raw: t };
}

function buildIndexes(templates) {
  const byId = new Map();
  const byType = new Map();     // type -> array
  const byAgent = new Map();    // agent -> array
  const byTag = new Map();      // tag -> array
  const byScope = new Map();    // scope -> array

  for (const t of templates) {
    byId.set(t.id, t);

    // Type
    if (!byType.has(t.type)) byType.set(t.type, []);
    byType.get(t.type).push(t);

    // Agent
    if (t.agent) {
      if (!byAgent.has(t.agent)) byAgent.set(t.agent, []);
      byAgent.get(t.agent).push(t);
    }

    // Tags
    for (const tag of t.tags) {
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag).push(t);
    }

    // Scope
    for (const s of t.scope) {
      if (!byScope.has(s)) byScope.set(s, []);
      byScope.get(s).push(t);
    }
  }

  // Sorted views for consistent UI (title asc)
  const sortByTitle = (a, b) => a.title.localeCompare(b.title);

  const sortAll = (arr) => [...arr].sort(sortByTitle);
  const sorted = sortAll(templates);

  const sortedByType = new Map();
  for (const [k, arr] of byType.entries()) sortedByType.set(k, sortAll(arr));

  const sortedByAgent = new Map();
  for (const [k, arr] of byAgent.entries()) sortedByAgent.set(k, sortAll(arr));

  const sortedByTag = new Map();
  for (const [k, arr] of byTag.entries()) sortedByTag.set(k, sortAll(arr));

  const sortedByScope = new Map();
  for (const [k, arr] of byScope.entries()) sortedByScope.set(k, sortAll(arr));

  // Derived lists for filters/menus
  const types = [...sortedByType.keys()].sort();
  const agents = [...sortedByAgent.keys()].sort();
  const tags = [...sortedByTag.keys()].sort();
  const scopes = [...sortedByScope.keys()].sort();

  return {
    byId,
    byType: sortedByType,
    byAgent: sortedByAgent,
    byTag: sortedByTag,
    byScope: sortedByScope,
    types,
    agents,
    tags,
    scopes,
    all: sorted,
  };
}

export default function useAutomationTemplates() {
  const version = useAutomationVersion();

  const normalized = useMemo(() => {
    const safeGet = () => {
      try {
        if (automation && typeof automation.getTemplates === "function") {
          const raw = automation.getTemplates() || [];
          return raw.map(normalizeTemplate);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[useAutomationTemplates] automation.getTemplates() failed:", e);
      }
      return [];
    };
    return safeGet();
  }, [version]);

  const index = useMemo(() => buildIndexes(normalized), [normalized]);

  // ---------- Selectors (stable) ----------
  const get = useCallback((id) => index.byId.get(id) || null, [index]);

  const has = useCallback((id) => index.byId.has(id), [index]);

  const list = useCallback((opts = {}) => {
    const {
      type,             // string|string[]
      agent,            // string|string[]
      tagsAny,          // string[]
      tagsAll,          // string[]
      scopeAny,         // string[]
      enabled,          // boolean
    } = opts;

    const typeSet = new Set(toArray(type));
    const agentSet = new Set(toArray(agent));
    const tagsAnySet = new Set(toArray(tagsAny));
    const tagsAllSet = new Set(toArray(tagsAll));
    const scopeAnySet = new Set(toArray(scopeAny));

    return index.all.filter((t) => {
      if (typeSet.size && !typeSet.has(t.type)) return false;
      if (agentSet.size && (!t.agent || !agentSet.has(t.agent))) return false;

      if (typeof enabled === "boolean" && t.enabled !== enabled) return false;

      if (tagsAllSet.size) {
        for (const tag of tagsAllSet) {
          if (!t.tags.includes(tag)) return false;
        }
      }
      if (tagsAnySet.size) {
        let ok = false;
        for (const tag of t.tags) {
          if (tagsAnySet.has(tag)) {
            ok = true;
            break;
          }
        }
        if (!ok) return false;
      }

      if (scopeAnySet.size) {
        let ok = false;
        for (const s of t.scope) {
          if (scopeAnySet.has(s)) {
            ok = true;
            break;
          }
        }
        if (!ok) return false;
      }

      return true;
    });
  }, [index]);

  const search = useCallback((q, opts = {}) => {
    const needle = String(q || "").trim().toLowerCase();
    if (!needle) return list(opts);

    return list(opts).filter((t) => {
      const hay = [
        t.id,
        t.title,
        t.description,
        t.type,
        t.agent || "",
        ...t.tags,
        ...t.scope,
      ].join(" • ").toLowerCase();
      return hay.includes(needle);
    });
  }, [list]);

  // Grouping helpers for UI sections/cards
  const grouped = useCallback((by = "type", opts = {}) => {
    const source = list(opts);
    const map = new Map();

    const pickKey = (t) => {
      switch (by) {
        case "type": return t.type || "template";
        case "agent": return t.agent || "unassigned";
        case "scope": return t.scope.length ? t.scope.join(",") : "global";
        case "tag": return t.tags.length ? t.tags[0] : "untagged"; // primary tag
        default: return "misc";
      }
    };

    for (const t of source) {
      const k = pickKey(t);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(t);
    }

    const sorter = (a, b) => a.localeCompare(b);
    return [...map.entries()]
      .sort((a, b) => sorter(a[0], b[0]))
      .map(([key, arr]) => ({
        key,
        title: key.charAt(0).toUpperCase() + key.slice(1),
        items: arr,
        count: arr.length,
      }));
  }, [list]);

  const counts = useCallback(() => {
    const total = index.all.length;
    const enabled = index.all.filter((t) => t.enabled).length;
    const byType = {};
    for (const t of index.all) {
      byType[t.type] = (byType[t.type] || 0) + 1;
    }
    return { total, enabled, byType };
  }, [index]);

  // Menu/Card helpers (kept generic—perfect for the IntentBar or AutomationPanel)
  const toMenuItems = useCallback((arr) => {
    return arr.map((t) => ({
      key: t.id,
      label: t.title,
      sublabel: t.description || t.agent || t.type,
      rightTag: t.enabled ? "Enabled" : "Disabled",
      tags: t.tags,
      scope: t.scope,
      data: t,
    }));
  }, []);

  const toCardData = useCallback((arr) => {
    return arr.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      badges: [
        ...(t.agent ? [t.agent] : []),
        t.type,
        ...t.tags,
        ...(t.scope.length ? t.scope : []),
        t.enabled ? "enabled" : "disabled",
      ],
      meta: t.meta,
      raw: t.__raw,
    }));
  }, []);

  // Convenience short-hands for common panels
  const meals = useMemo(() => list({ tagsAny: ["meals", "meal-planning", "batch"] }), [list]);
  const cleaning = useMemo(() => list({ tagsAny: ["cleaning", "deep-clean", "chores"] }), [list]);
  const garden = useMemo(() => list({ tagsAny: ["garden", "planting", "harvest"] }), [list]);
  const animals = useMemo(() => list({ tagsAny: ["animals", "livestock"] }), [list]);
  const defense = useMemo(() => list({ tagsAny: ["defense", "fitness"] }), [list]);

  return useMemo(() => ({
    // raw + indexes
    version,
    templates: index.all,     // normalized & title-sorted
    index,

    // selectors
    get,
    has,
    list,
    search,
    grouped,
    counts,

    // helpers for UI
    toMenuItems,
    toCardData,

    // convenience buckets
    meals,
    cleaning,
    garden,
    animals,
    defense,

    // quick lists for filters
    types: index.types,
    agents: index.agents,
    tags: index.tags,
    scopes: index.scopes,
  }), [
    version,
    index,
    get, has, list, search, grouped, counts,
    toMenuItems, toCardData,
    meals, cleaning, garden, animals, defense,
  ]);
}
