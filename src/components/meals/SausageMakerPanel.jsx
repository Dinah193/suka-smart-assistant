// src/components/meals/SausageMakerPanel.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * SausageMakerPanel — Torah-First UI, With Optional Shellfish
 *
 * Primary Tab: Torah-Aligned Bacon (Torah First)
 * Secondary Tab: Sausages
 *
 * Integrates with: @/agents/sausageAgent.js (planBatch, simulate, commit, undo, listTemplates)
 * Event glue: @/services/automation/runtime (on/subscribe + emit)
 *
 * Props:
 *  - household: { shellfishAllowed?: boolean, timezone?: string }
 *  - onOpenHouseholdProfile?: () => void    // opens profile screen to toggle shellfish
 *
 * Design tokens: Tailwind utility classes (works with DaisyUI/shadcn themes)
 */

let runtime = {};
try {
  // eslint-disable-next-line import/no-unresolved
  runtime = require("@/services/automation/runtime");
} catch {
  runtime = {};
}
const onEvent = runtime.on || runtime.subscribe || null;
const emitEvent = runtime.emitEvent || (() => {});
const emitProgress = runtime.emitProgress || (() => {});
const emitDraftApproved = runtime.emitDraftApproved || (() => {});

let sausageAgent;
try {
  // eslint-disable-next-line import/no-unresolved
  sausageAgent = require("@/agents/sausageAgent.js").default || require("@/agents/sausageAgent.js");
} catch {
  sausageAgent = null;
}

function classNames(...arr) {
  return arr.filter(Boolean).join(" ");
}

function Chip({ children, tone = "default" }) {
  const toneMap = {
    default: "bg-gray-100 text-gray-800 border-gray-200",
    info: "bg-blue-50 text-blue-700 border-blue-200",
    warn: "bg-amber-50 text-amber-800 border-amber-200",
    danger: "bg-red-50 text-red-700 border-red-200",
    success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  };
  return (
    <span
      className={classNames(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium",
        toneMap[tone] || toneMap.default
      )}
    >
      {children}
    </span>
  );
}

function Button({ children, variant = "primary", size = "md", loading = false, className = "", ...rest }) {
  const base =
    "inline-flex items-center justify-center rounded-xl transition focus:outline-none focus:ring-2 focus:ring-offset-2";
  const variants = {
    primary: "bg-neutral-900 text-white hover:bg-neutral-800 focus:ring-neutral-400",
    ghost: "bg-transparent text-neutral-800 hover:bg-neutral-100 focus:ring-neutral-300",
    subtle: "bg-neutral-100 text-neutral-800 hover:bg-neutral-200 focus:ring-neutral-300",
    danger: "bg-red-600 text-white hover:bg-red-700 focus:ring-red-400",
  };
  const sizes = {
    sm: "px-3 py-1.5 text-sm",
    md: "px-4 py-2 text-sm",
    lg: "px-5 py-2.5 text-base",
  };
  return (
    <button
      className={classNames(base, variants[variant], sizes[size], loading && "opacity-70 cursor-wait", className)}
      disabled={loading}
      {...rest}
    >
      {loading ? "…" : children}
    </button>
  );
}

function Card({ title, subtitle, right, children, footer }) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <div className="flex items-start justify-between gap-3 border-b border-neutral-100 px-4 py-3">
        <div>
          {title && <h3 className="text-sm font-semibold text-neutral-900">{title}</h3>}
          {subtitle && <p className="text-xs text-neutral-500">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">{right}</div>
      </div>
      <div className="p-4">{children}</div>
      {footer && <div className="border-t border-neutral-100 px-4 py-3">{footer}</div>}
    </div>
  );
}

function Empty({ title, hint, action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-neutral-300 p-8 text-center">
      <p className="text-sm font-semibold text-neutral-700">{title}</p>
      {hint && <p className="text-xs text-neutral-500">{hint}</p>}
      {action}
    </div>
  );
}

/* ------------------------------ Normalizers ------------------------------- */
// Is this item Torah-Aligned Bacon based on name or kind?
const isTorahBaconName = (name) => /(^|\s)bac(on)?(\s|$)/i.test(name || "") || /torah[-\s]?aligned\s+bacon/i.test(name || "");
const isBaconStyleKind = (kind) => String(kind || "").toLowerCase() === "bacon-style";
const isTorahBaconKind = (kind) => String(kind || "").toLowerCase() === "torah-bacon";

// Coerce any bacon-ish data to kind="torah-bacon"
const normalizeKind = (item) => {
  const name = item?.name || "";
  const kind = String(item?.kind || "").toLowerCase();
  if (isTorahBaconKind(kind) || isTorahBaconName(name) || isBaconStyleKind(kind)) {
    return { ...item, kind: "torah-bacon" };
  }
  return item;
};

// Human-readable kind for chips
const displayKind = (kind, name) => {
  const k = String(kind || "").toLowerCase();
  if (isTorahBaconKind(k) || isTorahBaconName(name) || isBaconStyleKind(k)) return "Torah-Aligned Bacon";
  return kind || "coarse";
};

export default function SausageMakerPanel({
  household = { shellfishAllowed: false, timezone: "America/New_York" },
  onOpenHouseholdProfile,
}) {
  const [activeTab, setActiveTab] = useState("bacon"); // "bacon" | "sausage"
  const [loading, setLoading] = useState(false);
  const [shellfishAllowed, setShellfishAllowed] = useState(!!household.shellfishAllowed);

  // Templates fetched from agent (normalized)
  const [templates, setTemplates] = useState([]);
  // Selected recipes (from templates or custom) — always normalized on entry
  const [selected, setSelected] = useState([]); // [{id,name,species,kind:'torah-bacon'|...,casings,targetWeightKg,ingredients,cook,notes}]
  // Agent outputs
  const [planEnvelope, setPlanEnvelope] = useState(null);
  const [simulation, setSimulation] = useState(null);
  const [commitResult, setCommitResult] = useState(null);
  const undoTokenRef = useRef(null);

  // Household banner text
  const bannerText = useMemo(() => {
    return `Torah Interpretation Profile: Shellfish ${shellfishAllowed ? "On" : "Off"}  |  click to change`;
  }, [shellfishAllowed]);

  // Load templates on mount (normalize kinds)
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (!sausageAgent) return;
      try {
        const res = await sausageAgent.actions.listTemplates();
        if (!mounted) return;
        const raw = res?.data?.templates || [];
        // Normalize any bacon variants to "torah-bacon"
        setTemplates(raw.map(normalizeKind));
      } catch {
        setTemplates([]);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Event glue: react to runtime events to keep panel fresh
  useEffect(() => {
    if (!onEvent) return;
    const offs = [];
    offs.push(
      onEvent("inventory.updated", () => {
        emitProgress({
          topic: "ui.toast.info",
          payload: { message: "Inventory changed — consider re-simulating this batch." },
        });
      })
    );
    offs.push(
      onEvent("calendar.synced", () => {
        emitProgress({ topic: "ui.toast.info", payload: { message: "Calendar synced for your batch holds/tasks." } });
      })
    );
    offs.push(
      onEvent("preferences.changed", (prefs) => {
        if (typeof prefs?.shellfishAllowed === "boolean") {
          setShellfishAllowed(!!prefs.shellfishAllowed);
          emitProgress({ topic: "ui.toast.info", payload: { message: "Household shellfish preference updated here." } });
        }
      })
    );
    offs.push(
      onEvent("recipes.consolidated", (payload) => {
        if (payload?.count) {
          emitProgress({ topic: "ui.toast.info", payload: { message: `Recipes consolidated: ${payload.count} new.` } });
        }
      })
    );
    return () => {
      offs.forEach((off) => {
        try {
          off && off();
        } catch {}
      });
    };
  }, []);

  // Filter templates by tab & shellfish (post-normalization)
  const filteredTemplates = useMemo(() => {
    const list = templates.filter((t) => {
      const torahBacon = isTorahBaconKind(t.kind) || isTorahBaconName(t.name);
      const isShellfish =
        t.ingredients?.some((i) => i.isShellfish) ||
        /shrimp|prawn|crab|lobster|clam|oyster|scallop|mussel/i.test(t.species || "");
      if (!shellfishAllowed && isShellfish) return false;
      if (activeTab === "bacon") return torahBacon;
      return !torahBacon;
    });
    return list;
  }, [templates, shellfishAllowed, activeTab]);

  const hasShellfishInSelection = useMemo(
    () => selected.some((r) => r.ingredients?.some((i) => i.isShellfish)),
    [selected]
  );

  // Add selection — normalize kind on entry
  function addSelected(tpl) {
    // Hide shellfish when Off; if imported from older batch, flag it
    const isShellfish = tpl.ingredients?.some((i) => i.isShellfish);
    if (isShellfish && !shellfishAllowed) {
      emitProgress({
        topic: "ui.toast.warn",
        payload: { message: "Shellfish is Off in your profile. This item is hidden by default." },
      });
      return;
    }
    const normalized = normalizeKind(tpl);
    setSelected((prev) => {
      if (prev.find((p) => p.id === normalized.id)) return prev;
      return prev.concat(normalized);
    });
  }

  function removeSelected(id) {
    setSelected((prev) => prev.filter((p) => p.id !== id));
  }

  async function doPlan() {
    if (!sausageAgent) return;
    setLoading(true);
    try {
      // Ensure every outgoing recipe uses kind:"torah-bacon" when applicable
      const recipes = selected.map((s0) => {
        const s = normalizeKind(s0);
        return {
          id: s.id,
          name: s.name,
          species: s.species,
          kind: isTorahBaconKind(s.kind) || isTorahBaconName(s.name) ? "torah-bacon" : (s.kind || "coarse"),
          casings: s.casings || undefined,
          targetWeightKg: s.targetWeightKg || undefined,
          cook: s.cook || undefined,
          ingredients: s.ingredients || [],
          notes: s.notes || "",
        };
      });

      const res = await sausageAgent.actions.planBatch({
        household: { shellfishAllowed, timezone: household?.timezone || "America/New_York" },
        recipes,
        options: { whenISO: new Date().toISOString() },
      });

      setPlanEnvelope(res);
      setSimulation(null);
      setCommitResult(null);
      emitProgress({
        topic: "ui.toast.success",
        payload: { message: "Plan created. Next: Simulate inventory & timing." },
      });
    } catch (e) {
      emitProgress({ topic: "ui.toast.error", payload: { message: "Failed to plan batch." } });
    } finally {
      setLoading(false);
    }
  }

  async function doSimulate() {
    if (!sausageAgent || !planEnvelope?.data?.plan) return;
    setLoading(true);
    try {
      const res = await sausageAgent.actions.simulate({ plan: planEnvelope.data.plan });
      setSimulation(res);
      emitProgress({ topic: "ui.toast.success", payload: { message: "Simulation ready. Review & Commit." } });
    } catch {
      emitProgress({ topic: "ui.toast.error", payload: { message: "Failed to simulate." } });
    } finally {
      setLoading(false);
    }
  }

  async function doCommit() {
    if (!sausageAgent || !simulation?.data?.commitPacket) return;
    setLoading(true);
    try {
      const res = await sausageAgent.actions.commit({ commitPacket: simulation.data.commitPacket });
      setCommitResult(res);
      undoTokenRef.current = res?.data?.undoToken || null;
      emitProgress({
        topic: "ui.toast.success",
        payload: { message: "Batch committed. You can Undo from the toast." },
      });
      // Offer Undo toast using event bus so app-wide toaster can render:
      emitEvent({
        topic: "ui.toast.action",
        payload: {
          message: "Sausage batch committed.",
          actionLabel: "Undo",
          actionIntent: { kind: "sausage.undo", token: undoTokenRef.current },
        },
      });
    } catch {
      emitProgress({ topic: "ui.toast.error", payload: { message: "Commit failed." } });
    } finally {
      setLoading(false);
    }
  }

  async function doUndo() {
    if (!sausageAgent || !undoTokenRef.current) return;
    setLoading(true);
    try {
      await sausageAgent.actions.undo({ undoToken: undoTokenRef.current });
      emitProgress({
        topic: "ui.toast.success",
        payload: { message: "Undo complete. Calendar and inventory reverted." },
      });
      // Reset local end-state
      setCommitResult(null);
      setSimulation(null);
      setPlanEnvelope(null);
      setSelected([]);
    } catch {
      emitProgress({ topic: "ui.toast.error", payload: { message: "Undo failed." } });
    } finally {
      setLoading(false);
    }
  }

  const nextBestAction = useMemo(() => {
    if (!planEnvelope) {
      return { label: "Plan Batch", onClick: doPlan, disabled: selected.length === 0 };
    }
    if (!simulation) {
      return { label: "Simulate", onClick: doSimulate, disabled: !planEnvelope?.data?.plan };
    }
    if (!commitResult) {
      return { label: "Commit", onClick: doCommit, disabled: !simulation?.data?.commitPacket };
    }
    return {
      label: "Print Labels",
      onClick: () => emitEvent({ topic: "ui.printLabels", payload: { labels: commitResult?.data?.labels } }),
    };
  }, [planEnvelope, simulation, commitResult, selected]);

  // Labels preview (always “Torah-aligned …”, add Shellfish if included)
  const labelBadges = useMemo(() => {
    const base = ["Torah-aligned (household profile)"];
    if (hasShellfishInSelection && shellfishAllowed) base.push("Shellfish per household interpretation");
    return base;
  }, [hasShellfishInSelection, shellfishAllowed]);

  // Render
  return (
    <div className="flex flex-col gap-4">
      {/* Household profile capsule banner */}
      <div className="flex items-center justify-between">
        <button
          className="text-xs rounded-full border border-neutral-300 bg-neutral-50 px-3 py-1 text-neutral-700 hover:bg-neutral-100"
          onClick={() => onOpenHouseholdProfile && onOpenHouseholdProfile()}
          title="Open Household Profile"
        >
          {bannerText}
        </button>
        <div className="flex items-center gap-2">
          <Chip tone="info">{shellfishAllowed ? "Shellfish: On" : "Shellfish: Off"}</Chip>
          <Chip tone="success">Sabbath-aware scheduling</Chip>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2">
        <Button
          variant={activeTab === "bacon" ? "primary" : "subtle"}
          size="sm"
          onClick={() => setActiveTab("bacon")}
        >
          Torah-Aligned Bacon
        </Button>
        <Button
          variant={activeTab === "sausage" ? "primary" : "subtle"}
          size="sm"
          onClick={() => setActiveTab("sausage")}
        >
          Sausages
        </Button>
      </div>

      {/* Template picker */}
      <Card
        title="Templates"
        subtitle={
          activeTab === "bacon"
            ? "Start with a Torah-Aligned Bacon base"
            : "Standard coarse/emulsion sausages"
        }
        right={
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              if (!sausageAgent) return;
              setLoading(true);
              try {
                const res = await sausageAgent.actions.listTemplates();
                const raw = res?.data?.templates || [];
                setTemplates(raw.map(normalizeKind)); // normalize on refresh, too
              } finally {
                setLoading(false);
              }
            }}
          >
            Refresh
          </Button>
        }
      >
        {filteredTemplates.length === 0 ? (
          <Empty
            title="No templates available"
            hint={shellfishAllowed ? "Try switching tabs or add your own recipe." : "Shellfish Off hides seafood templates."}
            action={
              <Button
                size="sm"
                variant="ghost"
                onClick={() => emitEvent({ topic: "ui.addRecipe" })}
              >
                Add Custom Recipe
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {filteredTemplates.map((tpl) => {
              const isShellfish = tpl.ingredients?.some((i) => i.isShellfish);
              const torahBacon = isTorahBaconKind(tpl.kind) || isTorahBaconName(tpl.name);
              return (
                <div key={tpl.id} className="rounded-xl border border-neutral-200 p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold text-neutral-900">{tpl.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        {isShellfish && <Chip tone="warn">Contains Shellfish</Chip>}
                        {torahBacon && <Chip tone="info">Torah-Aligned Bacon</Chip>}
                        <Chip>Species: {tpl.species || "n/a"}</Chip>
                      </div>
                    </div>
                    <Button size="sm" variant="primary" onClick={() => addSelected(tpl)}>
                      Select
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Selection & Builder */}
      <Card
        title="Batch Builder"
        subtitle="Select templates or add your own recipes, then plan the session"
        right={
          <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
            Clear
          </Button>
        }
        footer={
          <div className="flex items-center justify-between">
            <div className="flex flex-wrap items-center gap-2">
              {labelBadges.map((b) => (
                <Chip key={b}>{b}</Chip>
              ))}
              <Chip tone="info">Safe handling: chill ≤ 4°C, cook to target temp</Chip>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={doPlan} loading={loading} disabled={selected.length === 0}>
                Plan
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={doSimulate}
                loading={loading}
                disabled={!planEnvelope?.data?.plan}
              >
                Simulate
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={doCommit}
                loading={loading}
                disabled={!simulation?.data?.commitPacket}
              >
                Commit
              </Button>
            </div>
          </div>
        }
      >
        {selected.length === 0 ? (
          <Empty
            title="No recipes selected"
            hint="Pick at least one template or add a custom recipe."
            action={
              <Button size="sm" variant="primary" onClick={() => emitEvent({ topic: "ui.addRecipe" })}>
                Add Recipe
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {selected.map((s0) => {
              const s = normalizeKind(s0); // ensure normalized for display too
              const isShellfish = s.ingredients?.some((i) => i.isShellfish);
              const kindLabel = displayKind(s.kind, s.name);
              return (
                <div key={s.id} className="rounded-xl border border-neutral-200 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-neutral-900">{s.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <Chip>Kind: {kindLabel}</Chip>
                        <Chip>Species: {s.species || "n/a"}</Chip>
                        {isShellfish && shellfishAllowed && <Chip tone="warn">Contains Shellfish</Chip>}
                        {isShellfish && !shellfishAllowed && <Chip tone="danger">Hidden by profile</Chip>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => removeSelected(s.id)}>
                        Remove
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Plan & Schedule Preview */}
      <Card title="Plan Preview" subtitle="Sabbath-aware schedule & steps">
        {!planEnvelope?.data?.plan ? (
          <Empty title="No plan yet" hint="Click Plan to generate a Sabbath-aware draft." />
        ) : (
          <div className="flex flex-col gap-3">
            {(planEnvelope.data.plan.schedule || []).map((step, idx) => (
              <div
                key={`${step.lot}-${idx}`}
                className="flex flex-col rounded-lg border border-neutral-200 p-3 md:flex-row md:items-center md:justify-between"
              >
                <div className="flex items-center gap-2">
                  <Chip tone={step.kind === "hold" ? "info" : "default"}>
                    {step.kind === "hold" ? "Hold" : "Task"}
                  </Chip>
                  <div className="text-sm font-medium text-neutral-800">{step.name}</div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-2 md:mt-0">
                  <Chip>{new Date(step.startISO).toLocaleString()}</Chip>
                  <span className="text-neutral-300">→</span>
                  <Chip>{new Date(step.endISO).toLocaleString()}</Chip>
                  {step.note && <Chip>{step.note}</Chip>}
                  <Chip tone="success">Lot {step.lot}</Chip>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Simulation Preview */}
      <Card title="Simulation" subtitle="FEFO inventory deltas, label set, and calendar holds">
        {!simulation?.data?.commitPacket ? (
          <Empty title="No simulation yet" hint="Click Simulate to preview inventory and labels." />
        ) : (
          <div className="flex flex-col gap-4">
            <section>
              <div className="mb-2 text-xs font-semibold uppercase text-neutral-500">Inventory Ops</div>
              <div className="rounded-lg border border-neutral-200">
                <table className="w-full text-left text-sm">
                  <thead className="border-b bg-neutral-50 text-xs text-neutral-500">
                    <tr>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">SKU</th>
                      <th className="px-3 py-2">Qty</th>
                      <th className="px-3 py-2">Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {simulation.data.commitPacket.inventoryOps.map((op, i) => (
                      <tr key={i} className="border-b last:border-b-0">
                        <td className="px-3 py-2">{op.type}</td>
                        <td className="px-3 py-2">{op.sku}</td>
                        <td className="px-3 py-2">
                          {op.qty} {op.unit}
                        </td>
                        <td className="px-3 py-2 text-neutral-600">{op.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <div className="mb-2 text-xs font-semibold uppercase text-neutral-500">Labels Preview</div>
              <div className="flex flex-wrap items-center gap-2">
                {labelBadges.map((b) => (
                  <Chip key={b}>{b}</Chip>
                ))}
                <Chip tone="info">Standard safe-handling</Chip>
              </div>
            </section>

            <section>
              <div className="mb-2 text-xs font-semibold uppercase text-neutral-500">Calendar</div>
              <div className="flex flex-col gap-2">
                {simulation.data.commitPacket.calendarEvents.slice(0, 5).map((e, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 p-2">
                    <Chip tone={e.kind === "hold" ? "info" : "default"}>{e.kind}</Chip>
                    <div className="text-sm">{e.title}</div>
                    <Chip>{new Date(e.startISO).toLocaleString()}</Chip>
                    <span className="text-neutral-300">→</span>
                    <Chip>{new Date(e.endISO).toLocaleString()}</Chip>
                  </div>
                ))}
                {simulation.data.commitPacket.calendarEvents.length > 5 && (
                  <div className="text-xs text-neutral-500">…and more events scheduled</div>
                )}
              </div>
            </section>
          </div>
        )}
      </Card>

      {/* Footer Actions – Next Best Action & Undo */}
      <div className="sticky bottom-0 z-10 flex items-center justify-between gap-2 rounded-2xl border border-neutral-200 bg-white/90 p-3 backdrop-blur">
        <div className="flex items-center gap-2">
          {!commitResult?.data?.undoToken ? (
            <Chip tone="info">Tip: Use Undo after Commit instead of blocking confirmations.</Chip>
          ) : (
            <Chip tone="success">Committed — Undo available</Chip>
          )}
        </div>
        <div className="flex items-center gap-2">
          {commitResult?.data?.undoToken && (
            <Button variant="ghost" size="sm" onClick={doUndo} loading={loading}>
              Undo
            </Button>
          )}
          <Button
            variant="primary"
            size="md"
            onClick={nextBestAction?.onClick}
            disabled={nextBestAction?.disabled || loading}
            loading={loading}
          >
            {nextBestAction?.label || "Continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
