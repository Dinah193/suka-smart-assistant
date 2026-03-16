// C:\Users\larho\suka-smart-assistant\src\components\homestead\ProgressiveDisclosurePanel.jsx
//
// ProgressiveDisclosurePanel
// --------------------------
// A deterministic, local-first "progressive disclosure" wrapper for Homestead UI.
//
// Features:
// - Collapsible sections (accordion-style OR independent collapse)
// - "Show more" behavior inside a section (reveals hidden items progressively)
// - Remembers user choices via homestead_visibility_state repo (if available)
// - Safe fallbacks to localStorage when repo is not present
// - Supports “don’t show again” dismiss patterns (optional per section)
//
// Intended use:
// - Wrap dense Homestead Planner panels (Estimator details, Farm-to-Table details, etc.)
// - Prevent overwhelming users at lower levels
//
// Props:
// - householdId?: string (recommended)
// - panelKey: string (required) unique identifier for this panel instance
// - title?: ReactNode
// - description?: ReactNode
// - level?: string (optional; can be used for copy)
// - mode?: "accordion" | "multi" (default "multi")
// - defaultExpandedIds?: string[] (default [])
// - sections: Array<{
//     id: string,
//     title: ReactNode,
//     description?: ReactNode,
//     icon?: ReactNode,
//     // If provided, uses this to render content; otherwise uses children
//     render?: (ctx) => ReactNode,
//     // Optional content for "show more"
//     items?: any[],
//     renderItem?: (item, idx, ctx) => ReactNode,
//     // Progressive disclosure controls
//     initialVisibleCount?: number,     // default 0 (no show-more list)
//     step?: number,                    // default 5
//     maxVisibleCount?: number|null,    // default null (no cap)
//     showMoreLabel?: string,
//     showLessLabel?: string,
//     // Collapse + dismiss behavior
//     collapsible?: boolean,            // default true
//     defaultExpanded?: boolean,        // default false
//     canDismiss?: boolean,             // default false
//     dismissLabel?: string,            // default "Don't show again"
//     // Optional gates (deterministic UI rules; if false hides section)
//     visible?: boolean,                // default true
//     // Optional actions area
//     actions?: ReactNode,
//   }>
// - footer?: ReactNode
// - className?: string
//
// Visibility state persistence schema (expected):
// homestead_visibility_state:
// - householdId
// - collapsedSections: { [panelKey: string]: { [sectionId: string]: boolean } }
// - showMoreCounts: { [panelKey: string]: { [sectionId: string]: number } }
// - dismissedPanels: { [panelKey: string]: boolean }
// - dismissedSections: { [panelKey: string]: { [sectionId: string]: boolean } }
//
// This component does NOT require those exact fields; it will adapt safely.
//
// Repo expected:
// - src/services/repos/homestead/visibilityState.repo.js
//   Ex: getByHouseholdId(householdId), upsertByHouseholdId(householdId, patch)
//
// If missing, uses localStorage key:
// - ssa.homestead.visibilityState::<householdId>
//
import React, { useEffect, useMemo, useRef, useState } from "react";

// Best-effort repo import (exists per your earlier request)
import * as VisibilityStateRepo from "@/services/repos/homestead/visibilityState.repo";

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function storageKey(householdId) {
  return `ssa.homestead.visibilityState::${String(householdId || "anonymous")}`;
}

async function repoGet(householdId) {
  try {
    if (typeof VisibilityStateRepo.getByHouseholdId === "function") {
      return await VisibilityStateRepo.getByHouseholdId(String(householdId));
    }
    if (typeof VisibilityStateRepo.getState === "function") {
      return await VisibilityStateRepo.getState(String(householdId));
    }
    return null;
  } catch {
    return null;
  }
}

async function repoUpsert(householdId, patch) {
  try {
    if (typeof VisibilityStateRepo.upsertByHouseholdId === "function") {
      return await VisibilityStateRepo.upsertByHouseholdId(
        String(householdId),
        patch,
      );
    }
    if (typeof VisibilityStateRepo.saveState === "function") {
      return await VisibilityStateRepo.saveState(String(householdId), patch);
    }
    return null;
  } catch {
    return null;
  }
}

function readLocal(householdId) {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(storageKey(householdId));
  if (!raw) return null;
  return safeJsonParse(raw, null);
}

function writeLocal(householdId, nextState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(householdId),
      JSON.stringify(nextState),
    );
  } catch {
    // ignore
  }
}

function deepClone(obj) {
  return obj ? safeJsonParse(JSON.stringify(obj), obj) : obj;
}

function ensureObj(x) {
  return x && typeof x === "object" ? x : {};
}

function getPath(obj, path, fallback) {
  try {
    const parts = path.split(".");
    let cur = obj;
    for (const p of parts) {
      if (!cur || typeof cur !== "object") return fallback;
      cur = cur[p];
    }
    return cur == null ? fallback : cur;
  } catch {
    return fallback;
  }
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function IconChevron({ open }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-block transition-transform",
        open ? "rotate-180" : "rotate-0",
      )}
    >
      ▼
    </span>
  );
}

function Button({
  children,
  onClick,
  disabled,
  variant = "subtle",
  className,
  type = "button",
}) {
  const base =
    "inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-black/20";
  const variants = {
    subtle: "bg-zinc-100 text-black hover:bg-zinc-200 disabled:bg-zinc-100/50",
    ghost: "bg-transparent text-black hover:bg-black/5 disabled:text-black/40",
    danger: "bg-red-600 text-white hover:bg-red-700 disabled:bg-red-300",
    primary: "bg-black text-white hover:bg-black/90 disabled:bg-black/40",
  };
  return (
    <button
      type={type}
      className={cx(base, variants[variant], className)}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/**
 * ProgressiveDisclosurePanel
 */
export default function ProgressiveDisclosurePanel({
  householdId,
  panelKey,
  title,
  description,
  level,
  mode = "multi",
  defaultExpandedIds = [],
  sections = [],
  footer,
  className,
}) {
  if (!panelKey) {
    // Hard fail (developer error). Keep it visible during dev.
    throw new Error("[ProgressiveDisclosurePanel] panelKey is required");
  }

  const hId = String(householdId || "anonymous");
  const mountedRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [state, setState] = useState(null);

  // Load visibility state (repo → local fallback)
  useEffect(() => {
    let alive = true;
    setLoading(true);

    (async () => {
      const repoState = await repoGet(hId);
      const localState = readLocal(hId);

      const base = repoState ||
        localState || {
          householdId: hId,
          updatedAt: nowIso(),
          collapsedSections: {},
          showMoreCounts: {},
          dismissedPanels: {},
          dismissedSections: {},
        };

      if (!alive) return;

      setState(base);
      setLoading(false);
      mountedRef.current = true;
    })();

    return () => {
      alive = false;
    };
  }, [hId]);

  // Derived helpers from stored state
  const dismissedPanel = useMemo(() => {
    const s = ensureObj(state);
    const v =
      getPath(s, `dismissedPanels.${panelKey}`, false) ||
      getPath(s, `dismissed.${panelKey}`, false) ||
      false;
    return Boolean(v);
  }, [state, panelKey]);

  const collapsedMap = useMemo(() => {
    const s = ensureObj(state);
    return (
      getPath(s, `collapsedSections.${panelKey}`, null) ||
      getPath(s, `collapsed.${panelKey}`, null) ||
      {}
    );
  }, [state, panelKey]);

  const dismissedSectionsMap = useMemo(() => {
    const s = ensureObj(state);
    return (
      getPath(s, `dismissedSections.${panelKey}`, null) ||
      getPath(s, `dismissedSection.${panelKey}`, null) ||
      {}
    );
  }, [state, panelKey]);

  const showMoreCountsMap = useMemo(() => {
    const s = ensureObj(state);
    return (
      getPath(s, `showMoreCounts.${panelKey}`, null) ||
      getPath(s, `showMore.${panelKey}`, null) ||
      {}
    );
  }, [state, panelKey]);

  const visibleSections = useMemo(() => {
    return (Array.isArray(sections) ? sections : [])
      .filter((sec) => (sec?.visible ?? true) !== false)
      .filter(
        (sec) => !(sec?.canDismiss && dismissedSectionsMap?.[sec.id] === true),
      );
  }, [sections, dismissedSectionsMap]);

  const expandedSet = useMemo(() => {
    // Determine expanded state:
    // - If user collapsed it in state => closed
    // - Else if defaultExpanded or in defaultExpandedIds => open
    // - In accordion mode: only one open at a time (choose first open)
    const openIds = [];
    for (const sec of visibleSections) {
      const collapsible = sec?.collapsible !== false;
      const userCollapsed = Boolean(collapsedMap?.[sec.id]);
      const defaultOpen =
        Boolean(sec?.defaultExpanded) || defaultExpandedIds.includes(sec.id);
      const isOpen = collapsible ? !userCollapsed && defaultOpen : true;
      if (isOpen) openIds.push(sec.id);
    }

    if (mode === "accordion") {
      return new Set(openIds.length ? [openIds[0]] : []);
    }
    return new Set(openIds);
  }, [visibleSections, collapsedMap, defaultExpandedIds, mode]);

  const [openIds, setOpenIds] = useState(() => new Set(defaultExpandedIds));

  // Sync openIds from derived expandedSet on first load / when state loads
  useEffect(() => {
    if (!mountedRef.current) return;
    // Only initialize once after load to avoid fighting user toggles.
    // But if panelKey changes, we should reset.
  }, []);

  useEffect(() => {
    if (loading) return;
    // When state loads, set open ids based on stored collapsed + defaults.
    setOpenIds(new Set(Array.from(expandedSet)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, panelKey]);

  // Persist helper
  async function persistPatch(mutator) {
    const prev = ensureObj(state);
    const next = deepClone(prev) || {};
    next.householdId = next.householdId || hId;
    next.updatedAt = nowIso();

    mutator(next);

    // Update React state immediately
    setState(next);

    // Best-effort persist
    writeLocal(hId, next);
    await repoUpsert(hId, next);
  }

  function toggleSection(secId, collapsible = true) {
    if (!collapsible) return;

    const isOpen = openIds.has(secId);

    if (mode === "accordion") {
      const nextSet = new Set();
      if (!isOpen) nextSet.add(secId);
      setOpenIds(nextSet);
    } else {
      const nextSet = new Set(openIds);
      if (isOpen) nextSet.delete(secId);
      else nextSet.add(secId);
      setOpenIds(nextSet);
    }

    // Persist collapsed flag
    void persistPatch((draft) => {
      const baseCollapsed = ensureObj(
        getPath(draft, `collapsedSections.${panelKey}`, {}),
      );
      // collapsed = !open (for collapsible sections)
      baseCollapsed[secId] = isOpen ? true : false;
      setPath(draft, `collapsedSections.${panelKey}`, baseCollapsed);
    });
  }

  function dismissPanel() {
    void persistPatch((draft) => {
      const base = ensureObj(getPath(draft, "dismissedPanels", {}));
      base[panelKey] = true;
      setPath(draft, "dismissedPanels", base);
    });
  }

  function dismissSection(secId) {
    void persistPatch((draft) => {
      const base = ensureObj(
        getPath(draft, `dismissedSections.${panelKey}`, {}),
      );
      base[secId] = true;
      setPath(draft, `dismissedSections.${panelKey}`, base);
    });
  }

  function setShowCount(secId, count) {
    void persistPatch((draft) => {
      const base = ensureObj(getPath(draft, `showMoreCounts.${panelKey}`, {}));
      base[secId] = count;
      setPath(draft, `showMoreCounts.${panelKey}`, base);
    });
  }

  function resolveVisibleCount(sec) {
    const list = Array.isArray(sec.items) ? sec.items : null;
    if (!list || !list.length) return 0;

    const initial = Number.isFinite(sec.initialVisibleCount)
      ? Number(sec.initialVisibleCount)
      : 0;
    const stored = showMoreCountsMap?.[sec.id];
    const fromStore = Number.isFinite(Number(stored)) ? Number(stored) : null;

    let count = fromStore != null ? fromStore : initial;
    if (count < 0) count = 0;
    if (count > list.length) count = list.length;

    // Optional max cap
    if (
      sec.maxVisibleCount != null &&
      Number.isFinite(Number(sec.maxVisibleCount))
    ) {
      count = Math.min(count, Number(sec.maxVisibleCount));
    }
    return count;
  }

  function handleShowMore(sec) {
    const list = Array.isArray(sec.items) ? sec.items : null;
    if (!list || !list.length) return;

    const current = resolveVisibleCount(sec);
    const step = Number.isFinite(sec.step) ? Number(sec.step) : 5;
    const next = Math.min(list.length, current + step);

    setShowCount(sec.id, next);
  }

  function handleShowLess(sec) {
    const list = Array.isArray(sec.items) ? sec.items : null;
    if (!list || !list.length) return;

    const initial = Number.isFinite(sec.initialVisibleCount)
      ? Number(sec.initialVisibleCount)
      : 0;
    setShowCount(sec.id, initial);
  }

  const headerTitle = title || "Details";
  const headerDescription =
    description ||
    (level
      ? `Showing what’s relevant for level: ${String(level)}`
      : "Use ‘Show more’ to reveal additional detail.");

  if (loading) {
    return (
      <div
        className={cx(
          "rounded-xl border border-black/10 bg-white p-4 shadow-sm",
          className,
        )}
      >
        <div className="text-sm text-black/60">Loading…</div>
      </div>
    );
  }

  if (dismissedPanel) {
    return null;
  }

  return (
    <div
      className={cx(
        "rounded-xl border border-black/10 bg-white shadow-sm",
        className,
      )}
    >
      {/* Header */}
      <div className="border-b border-black/10 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-lg font-bold text-black">{headerTitle}</div>
            <div className="mt-1 text-sm text-black/60">
              {headerDescription}
            </div>
          </div>

          {/* Panel-level actions */}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                // Expand all / collapse all depending on current state (multi only)
                if (mode === "accordion") return;

                const allOpen = visibleSections.every(
                  (s) => openIds.has(s.id) || s.collapsible === false,
                );
                const nextSet = new Set(openIds);

                if (allOpen) {
                  // close all collapsible
                  for (const s of visibleSections) {
                    if (s.collapsible === false) continue;
                    nextSet.delete(s.id);
                  }
                } else {
                  for (const s of visibleSections) {
                    nextSet.add(s.id);
                  }
                }

                setOpenIds(nextSet);

                void persistPatch((draft) => {
                  const baseCollapsed = ensureObj(
                    getPath(draft, `collapsedSections.${panelKey}`, {}),
                  );
                  for (const s of visibleSections) {
                    if (s.collapsible === false) {
                      baseCollapsed[s.id] = false;
                      continue;
                    }
                    baseCollapsed[s.id] = allOpen ? true : false;
                  }
                  setPath(
                    draft,
                    `collapsedSections.${panelKey}`,
                    baseCollapsed,
                  );
                });
              }}
              disabled={mode === "accordion" || visibleSections.length === 0}
            >
              {mode === "accordion" ? "Accordion" : "Toggle all"}
            </Button>

            <Button variant="ghost" onClick={dismissPanel}>
              Hide
            </Button>
          </div>
        </div>
      </div>

      {/* Sections */}
      <div className="divide-y divide-black/10">
        {visibleSections.length === 0 ? (
          <div className="p-4 text-sm text-black/60">
            Nothing to show right now.
          </div>
        ) : (
          visibleSections.map((sec) => {
            const collapsible = sec?.collapsible !== false;
            const isOpen = collapsible ? openIds.has(sec.id) : true;

            const list = Array.isArray(sec.items) ? sec.items : null;
            const visibleCount = resolveVisibleCount(sec);
            const canShowMore = Boolean(
              list && list.length && visibleCount < list.length,
            );
            const canShowLess = Boolean(
              list &&
              list.length &&
              visibleCount > (sec.initialVisibleCount ?? 0),
            );

            const showMoreLabel = sec.showMoreLabel || "Show more";
            const showLessLabel = sec.showLessLabel || "Show less";

            return (
              <div key={sec.id} className="p-4">
                {/* Section header */}
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    className={cx(
                      "flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus:outline-none focus:ring-2 focus:ring-black/20",
                      collapsible ? "cursor-pointer" : "cursor-default",
                    )}
                    onClick={() => toggleSection(sec.id, collapsible)}
                    aria-expanded={isOpen}
                  >
                    {sec.icon ? <div className="mt-0.5">{sec.icon}</div> : null}

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="text-base font-bold text-black">
                          {sec.title}
                        </div>
                        {collapsible ? <IconChevron open={isOpen} /> : null}
                      </div>
                      {sec.description ? (
                        <div className="mt-1 text-sm text-black/60">
                          {sec.description}
                        </div>
                      ) : null}
                    </div>
                  </button>

                  {/* Section-level actions */}
                  <div className="flex shrink-0 items-center gap-2">
                    {sec.actions ? (
                      <div className="hidden md:block">{sec.actions}</div>
                    ) : null}

                    {sec.canDismiss ? (
                      <Button
                        variant="ghost"
                        onClick={() => dismissSection(sec.id)}
                        className="text-xs"
                      >
                        {sec.dismissLabel || "Don't show again"}
                      </Button>
                    ) : null}
                  </div>
                </div>

                {/* Section body */}
                {isOpen ? (
                  <div className="mt-3">
                    {/* Custom render */}
                    {typeof sec.render === "function" ? (
                      <div className="rounded-xl border border-black/10 bg-zinc-50 p-3">
                        {sec.render({
                          householdId: hId,
                          panelKey,
                          sectionId: sec.id,
                          level,
                          visibilityState: state,
                        })}
                      </div>
                    ) : null}

                    {/* Items list with progressive disclosure */}
                    {list ? (
                      <div className="mt-3">
                        <div className="rounded-xl border border-black/10 bg-white">
                          <div className="p-3">
                            {visibleCount === 0 ? (
                              <div className="text-sm text-black/60">
                                Nothing revealed yet. Use “{showMoreLabel}”.
                              </div>
                            ) : (
                              <div className="grid gap-2">
                                {list
                                  .slice(0, visibleCount)
                                  .map((item, idx) => (
                                    <div
                                      key={
                                        item?.id ||
                                        item?.key ||
                                        `${sec.id}_${idx}`
                                      }
                                      className="rounded-lg border border-black/10 bg-zinc-50 p-3"
                                    >
                                      {typeof sec.renderItem === "function" ? (
                                        sec.renderItem(item, idx, {
                                          householdId: hId,
                                          panelKey,
                                          sectionId: sec.id,
                                          level,
                                        })
                                      ) : (
                                        <pre className="whitespace-pre-wrap break-words text-xs text-black/70">
                                          {typeof item === "string"
                                            ? item
                                            : JSON.stringify(item, null, 2)}
                                        </pre>
                                      )}
                                    </div>
                                  ))}
                              </div>
                            )}
                          </div>

                          {/* Show more/less controls */}
                          <div className="border-t border-black/10 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-xs text-black/50">
                                Showing{" "}
                                <span className="font-semibold text-black">
                                  {Math.min(visibleCount, list.length)}
                                </span>{" "}
                                of{" "}
                                <span className="font-semibold text-black">
                                  {list.length}
                                </span>
                              </div>

                              <div className="flex items-center gap-2">
                                {canShowLess ? (
                                  <Button
                                    variant="ghost"
                                    onClick={() => handleShowLess(sec)}
                                  >
                                    {showLessLabel}
                                  </Button>
                                ) : null}

                                {canShowMore ? (
                                  <Button
                                    variant="primary"
                                    onClick={() => handleShowMore(sec)}
                                  >
                                    {showMoreLabel}
                                  </Button>
                                ) : (
                                  <Button variant="subtle" disabled>
                                    All shown
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : null}

                    {/* Mobile actions */}
                    {sec.actions ? (
                      <div className="mt-3 md:hidden">{sec.actions}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      {footer ? (
        <div className="border-t border-black/10 p-4">{footer}</div>
      ) : null}
    </div>
  );
}
