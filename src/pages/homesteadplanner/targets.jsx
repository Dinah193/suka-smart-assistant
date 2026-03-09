// C:\Users\larho\suka-smart-assistant\src\pages\homesteadplanner\targets.jsx
/* eslint-disable no-console */

import React, { useEffect, useMemo, useRef, useState } from "react";
import RealtimeCoordinationPanel from "@/components/home/RealtimeCoordinationPanel";
import { emitCanonicalSignal } from "@/services/realtime/canonicalSignalEmitter";

/**
 * Homestead Planner • Targets
 * -----------------------------------------------------------------------------
 * Purpose
 * - Provisioning Targets + Gap detection + Deterministic Actions
 * - Works with Dexie tables (expected):
 *    • ftt_provisioning_targets
 *    • ftt_component_inventory (for component gap checks)
 *
 * Design goals
 * - Production-safe: never hard-crash if tables are missing; show helpful UI instead.
 * - Deterministic: gaps computed via catalog keys + inventory totals (no AI required).
 * - User-friendly: filters, quick actions, edit modal, explanations.
 */

// ---- Safe DB import (handles db.js exporting default or named `db`) ----------
let db = null;
let dbLoadError = null;
async function loadDb() {
  if (db || dbLoadError) return db;
  try {
    // Prefer alias if configured; falls back to relative if needed.
    // IMPORTANT: Keep only ONE import path to avoid bundler resolution surprises.
    const mod = await import("@/services/db");
    db = mod?.db || mod?.default || mod;
    return db;
  } catch (e) {
    dbLoadError = e;
    console.error("[HomesteadPlannerTargets] Failed to import db:", e);
    return null;
  }
}

// ---- UI imports (shadcn-style). If your project uses different paths, adjust. -
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";

// ---- Small helpers ----------------------------------------------------------

const SOURCE = "pages.homesteadplanner.targets";

const TARGET_TYPES = [
  { key: "component", label: "Component" },
  { key: "raw_crop", label: "Raw Crop" },
  { key: "animal_output", label: "Animal Output" },
  { key: "meal", label: "Meal/Plate" },
];

const STATUSES = [
  { key: "planned", label: "Planned" },
  { key: "in_progress", label: "In Progress" },
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
  { key: "cancelled", label: "Cancelled" },
];

const PRIORITIES = [
  { key: "low", label: "Low" },
  { key: "normal", label: "Normal" },
  { key: "high", label: "High" },
  { key: "critical", label: "Critical" },
];

const SOURCING = [
  { key: "own", label: "Own homestead" },
  { key: "neighbor", label: "Neighbor / family" },
  { key: "local", label: "Local farmer / market" },
  { key: "retail", label: "Retail fallback" },
];

const HOMESTEAD_SCOPE_STORAGE_KEY = "suka.homestead.realtime.scope";

function nowISO() {
  return new Date().toISOString();
}

function uid(prefix = "tgt") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diff = t - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function isOverdue(iso) {
  const d = daysUntil(iso);
  return typeof d === "number" ? d < 0 : false;
}

function safeTable(dbObj, tableName) {
  try {
    if (!dbObj?.tables?.some((t) => t?.name === tableName)) return null;
    return dbObj.table(tableName);
  } catch {
    return null;
  }
}

function statusBadgeVariant(status) {
  switch (status) {
    case "done":
      return "secondary";
    case "blocked":
      return "destructive";
    case "in_progress":
      return "default";
    case "cancelled":
      return "outline";
    case "planned":
    default:
      return "outline";
  }
}

function priorityBadgeVariant(priority) {
  switch (priority) {
    case "critical":
      return "destructive";
    case "high":
      return "default";
    case "normal":
      return "secondary";
    case "low":
    default:
      return "outline";
  }
}

function buildDeterministicActions(target) {
  // Deterministic action suggestions based on target_type + sourcing priority
  const actions = [];

  // Always include sourcing ladder as a "how to resolve" guide
  const ladder = {
    own: [
      "Make/harvest from your homestead",
      "Use preserved components",
      "Schedule a session",
    ],
    neighbor: [
      "Ask family/neighbor homesteads",
      "Coordinate bulk / swap",
      "Schedule pickup",
    ],
    local: [
      "Check local farmers/market",
      "Request pre-order",
      "Plan market day route",
    ],
    retail: [
      "Create a retail fallback list",
      "Price compare",
      "Buy minimal required amount",
    ],
  };

  const src = target?.sourcePriority || "own";
  const ladderSteps = ladder[src] || ladder.own;

  if (target?.targetType === "component") {
    actions.push({
      id: "start_preservation_batch",
      title: "Start preservation / prep session",
      description:
        "Create this component using your methods catalog and store it in Component Inventory.",
      kind: "primary",
    });
    actions.push({
      id: "map_to_inventory",
      title: "Map to component inventory",
      description:
        "Confirm the inventory key and storage location for reliable gap tracking.",
      kind: "secondary",
    });
  } else if (target?.targetType === "raw_crop") {
    actions.push({
      id: "create_garden_target",
      title: "Create garden target",
      description: "Turn this need into planting/bed targets and a timeline.",
      kind: "primary",
    });
    actions.push({
      id: "check_substitutions",
      title: "Check substitutions",
      description:
        "See acceptable substitutes (e.g., cabbage ↔ collards) based on your rules.",
      kind: "secondary",
    });
  } else if (target?.targetType === "animal_output") {
    actions.push({
      id: "create_animal_target",
      title: "Create animal target",
      description:
        "Translate this into breeding/purchase + processing milestones.",
      kind: "primary",
    });
    actions.push({
      id: "schedule_processing",
      title: "Schedule processing cadence",
      description:
        "Plan slaughter/processing and preservation batches (stock, sausage, confit).",
      kind: "secondary",
    });
  } else if (target?.targetType === "meal") {
    actions.push({
      id: "generate_plate_plan",
      title: "Generate plate plan",
      description:
        "Break this meal into required component roles and cooking methods.",
      kind: "primary",
    });
    actions.push({
      id: "link_to_mealplan",
      title: "Link to meal plan",
      description:
        "Attach this to a weekly cadence and derive component targets automatically.",
      kind: "secondary",
    });
  }

  actions.push({
    id: "resolve_source_ladder",
    title: `Resolve via ${
      SOURCING.find((s) => s.key === src)?.label || "sourcing ladder"
    }`,
    description: ladderSteps.join(" • "),
    kind: "outline",
  });

  return actions;
}

function signalForTargetRecord(record) {
  const targetType = String(record?.targetType || "component");
  const status = String(record?.status || "planned");
  const qty = toNum(record?.quantity ?? 0);

  if (targetType === "raw_crop" && status === "done") {
    return {
      type: "cropHarvested",
      urgency: "high",
      completionPct: 100,
      dependencies: ["storehouse", "cooking.sessions"],
      payload: {
        crop: record?.title || record?.key || "crop",
        quantity: qty,
        unit: record?.unit || "unit",
      },
    };
  }

  if (targetType === "animal_output" && status === "done") {
    const label = String(record?.title || record?.key || "").toLowerCase();
    const type = label.includes("milk") ? "milkingDone" : "butcheryLogged";
    return {
      type,
      urgency: "high",
      completionPct: 100,
      dependencies: ["preservation", "cooking.sessions"],
      payload: {
        name: record?.title || record?.key || "animal output",
        quantity: qty,
        unit: record?.unit || "unit",
      },
    };
  }

  return {
    type: status === "done" ? "taskCompleted" : "taskStarted",
    urgency: record?.priority === "critical" ? "critical" : record?.priority || "normal",
    completionPct: status === "done" ? 100 : status === "in_progress" ? 50 : 15,
    dependencies: ["readiness", "tasks"],
    payload: {
      taskId: record?.id,
      name: record?.title || record?.key || "target",
      status,
      targetType,
      quantity: qty,
      unit: record?.unit || "unit",
    },
  };
}

// ---- Page -------------------------------------------------------------------

export default function HomesteadPlannerTargetsPage() {
  const [ready, setReady] = useState(false);
  const [dbOk, setDbOk] = useState(false);
  const [targets, setTargets] = useState([]);
  const [componentInventory, setComponentInventory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [panelScope, setPanelScope] = useState(() => {
    if (typeof window === "undefined") return "household";
    try {
      const saved = window.localStorage?.getItem(HOMESTEAD_SCOPE_STORAGE_KEY);
      return saved === "family" ? "family" : "household";
    } catch {
      return "household";
    }
  });

  // Filters
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [gapFilter, setGapFilter] = useState("all"); // all | gaps | ok | overdue
  const [sortKey, setSortKey] = useState("dueAsc"); // dueAsc | dueDesc | updatedDesc | priorityDesc

  // Modal
  const [editOpen, setEditOpen] = useState(false);
  const [editMode, setEditMode] = useState("create"); // create | edit
  const [form, setForm] = useState(null);

  // Busy flags
  const busyRef = useRef(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      const dbObj = await loadDb();
      if (!alive) return;

      setReady(true);

      const tTargets = safeTable(dbObj, "ftt_provisioning_targets");
      const tInv = safeTable(dbObj, "ftt_component_inventory");

      const ok = !!tTargets;
      setDbOk(ok);

      if (!tTargets) {
        setTargets([]);
        setComponentInventory([]);
        setLoading(false);
        return;
      }

      // Initial load
      const [targetRows, invRows] = await Promise.all([
        tTargets.toArray(),
        tInv ? tInv.toArray() : Promise.resolve([]),
      ]);

      if (!alive) return;
      setTargets(targetRows || []);
      setComponentInventory(invRows || []);
      setLoading(false);

      // Lightweight “refresh on focus” behavior
      const onFocus = async () => {
        const dbObj2 = await loadDb();
        const tt = safeTable(dbObj2, "ftt_provisioning_targets");
        const ti = safeTable(dbObj2, "ftt_component_inventory");
        if (!tt) return;

        const [targetRows2, invRows2] = await Promise.all([
          tt.toArray(),
          ti ? ti.toArray() : Promise.resolve([]),
        ]);

        setTargets(targetRows2 || []);
        setComponentInventory(invRows2 || []);
      };

      window.addEventListener("focus", onFocus);
      return () => window.removeEventListener("focus", onFocus);
    })();

    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage?.setItem(HOMESTEAD_SCOPE_STORAGE_KEY, panelScope);
    } catch {
      // Ignore storage failures in locked-down browser contexts.
    }
  }, [panelScope]);

  const inventoryByComponentKey = useMemo(() => {
    // Normalize component inventory totals. Expected inventory row keys may vary; we handle common ones.
    // Supported keys: componentKey | key | component_id | componentId
    const map = new Map();
    for (const row of componentInventory || []) {
      const k =
        row?.componentKey ||
        row?.key ||
        row?.component_id ||
        row?.componentId ||
        row?.component;
      if (!k) continue;
      const qty = toNum(row?.quantity ?? row?.qty ?? row?.amount ?? 0);
      map.set(k, (map.get(k) || 0) + qty);
    }
    return map;
  }, [componentInventory]);

  const enrichedTargets = useMemo(() => {
    return (targets || []).map((t) => {
      const targetType = t?.targetType || t?.target_type || "component";
      const key =
        t?.key ||
        t?.targetKey ||
        t?.target_key ||
        t?.componentKey ||
        t?.rawKey ||
        "";
      const title = t?.title || t?.name || key || "(untitled)";
      const unit = t?.unit || t?.units || "unit";
      const qty = toNum(t?.quantity ?? t?.qty ?? 0);
      const neededBy =
        t?.neededBy || t?.needed_by || t?.dueAt || t?.dueISO || null;
      const status = t?.status || "planned";
      const priority = t?.priority || "normal";
      const sourcePriority = t?.sourcePriority || t?.source_priority || "own";
      const updatedAt =
        t?.updatedAt || t?.updated_at || t?.modifiedAt || t?.createdAt || null;

      // Only compute "available" for component targets (since inventory table is component-based)
      const available =
        targetType === "component"
          ? toNum(inventoryByComponentKey.get(key) || 0)
          : null;
      const gap =
        targetType === "component" ? Math.max(0, qty - available) : null;

      return {
        ...t,
        _computed: {
          targetType,
          key,
          title,
          unit,
          qty,
          available,
          gap,
          neededBy,
          overdue: isOverdue(neededBy),
          daysUntil: daysUntil(neededBy),
          status,
          priority,
          sourcePriority,
          updatedAt,
          actions: buildDeterministicActions({
            targetType,
            sourcePriority,
          }),
        },
      };
    });
  }, [targets, inventoryByComponentKey]);

  const filteredTargets = useMemo(() => {
    const query = (q || "").trim().toLowerCase();

    let list = enrichedTargets;

    if (typeFilter !== "all") {
      list = list.filter((t) => t?._computed?.targetType === typeFilter);
    }
    if (statusFilter !== "all") {
      list = list.filter(
        (t) => (t?._computed?.status || "planned") === statusFilter
      );
    }
    if (priorityFilter !== "all") {
      list = list.filter(
        (t) => (t?._computed?.priority || "normal") === priorityFilter
      );
    }
    if (query) {
      list = list.filter((t) => {
        const c = t?._computed;
        const hay = `${c?.title || ""} ${c?.key || ""} ${
          t?.notes || ""
        }`.toLowerCase();
        return hay.includes(query);
      });
    }

    if (gapFilter === "gaps") {
      list = list.filter((t) => (t?._computed?.gap ?? 0) > 0);
    } else if (gapFilter === "ok") {
      list = list.filter(
        (t) =>
          t?._computed?.targetType !== "component" ||
          (t?._computed?.gap ?? 0) === 0
      );
    } else if (gapFilter === "overdue") {
      list = list.filter((t) => !!t?._computed?.overdue);
    }

    // Sorting
    const sorters = {
      dueAsc: (a, b) =>
        (a?._computed?.neededBy || "").localeCompare(
          b?._computed?.neededBy || ""
        ),
      dueDesc: (a, b) =>
        (b?._computed?.neededBy || "").localeCompare(
          a?._computed?.neededBy || ""
        ),
      updatedDesc: (a, b) =>
        (b?._computed?.updatedAt || "").localeCompare(
          a?._computed?.updatedAt || ""
        ),
      priorityDesc: (a, b) => {
        const rank = { low: 1, normal: 2, high: 3, critical: 4 };
        return (
          (rank[b?._computed?.priority] || 0) -
          (rank[a?._computed?.priority] || 0)
        );
      },
    };

    const sorter = sorters[sortKey] || sorters.dueAsc;
    return [...list].sort(sorter);
  }, [
    enrichedTargets,
    q,
    typeFilter,
    statusFilter,
    priorityFilter,
    gapFilter,
    sortKey,
  ]);

  const kpis = useMemo(() => {
    const total = enrichedTargets.length;
    const gaps = enrichedTargets.filter(
      (t) => (t?._computed?.gap ?? 0) > 0
    ).length;
    const overdue = enrichedTargets.filter((t) => t?._computed?.overdue).length;
    const done = enrichedTargets.filter(
      (t) => (t?._computed?.status || "planned") === "done"
    ).length;
    return { total, gaps, overdue, done };
  }, [enrichedTargets]);

  function openCreate() {
    setEditMode("create");
    setForm({
      id: uid(),
      targetType: "component",
      key: "",
      title: "",
      quantity: 1,
      unit: "portion",
      status: "planned",
      priority: "normal",
      sourcePriority: "own",
      neededBy: "",
      notes: "",
      createdAt: nowISO(),
      updatedAt: nowISO(),
    });
    setEditOpen(true);
  }

  function openEdit(row) {
    const c = row?._computed || {};
    setEditMode("edit");
    setForm({
      // Keep original row fields, but also map normalized fields for editing
      ...row,
      id: row?.id || row?.keyId || row?.uuid || uid(),
      targetType: c.targetType,
      key: c.key || "",
      title: c.title || "",
      quantity: c.qty || 0,
      unit: c.unit || "unit",
      status: c.status || "planned",
      priority: c.priority || "normal",
      sourcePriority: c.sourcePriority || "own",
      neededBy: c.neededBy ? String(c.neededBy) : "",
      notes: row?.notes || "",
      updatedAt: nowISO(),
    });
    setEditOpen(true);
  }

  async function refresh() {
    const dbObj = await loadDb();
    const tTargets = safeTable(dbObj, "ftt_provisioning_targets");
    const tInv = safeTable(dbObj, "ftt_component_inventory");
    if (!tTargets) return;

    const [targetRows, invRows] = await Promise.all([
      tTargets.toArray(),
      tInv ? tInv.toArray() : Promise.resolve([]),
    ]);
    setTargets(targetRows || []);
    setComponentInventory(invRows || []);
  }

  async function upsertTarget(payload) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const dbObj = await loadDb();
      const tTargets = safeTable(dbObj, "ftt_provisioning_targets");
      if (!tTargets) return;

      // Normalize payload to a stable shape while keeping extras
      const record = {
        ...payload,
        id: payload?.id || uid(),
        targetType: payload?.targetType || payload?.target_type || "component",
        key: payload?.key || payload?.targetKey || payload?.target_key || "",
        title: payload?.title || payload?.name || payload?.key || "(untitled)",
        quantity: toNum(payload?.quantity ?? payload?.qty ?? 0),
        unit: payload?.unit || "unit",
        status: payload?.status || "planned",
        priority: payload?.priority || "normal",
        sourcePriority: payload?.sourcePriority || "own",
        neededBy:
          payload?.neededBy ||
          payload?.needed_by ||
          payload?.dueISO ||
          payload?.dueAt ||
          null,
        notes: payload?.notes || "",
        createdAt: payload?.createdAt || nowISO(),
        updatedAt: nowISO(),
        source: payload?.source || SOURCE,
      };

      await tTargets.put(record);
      await refresh();

      const signal = signalForTargetRecord(record);
      emitCanonicalSignal({
        ...signal,
        sourceModule: "planner.homestead",
      });
    } finally {
      busyRef.current = false;
    }
  }

  async function deleteTarget(row) {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const dbObj = await loadDb();
      const tTargets = safeTable(dbObj, "ftt_provisioning_targets");
      if (!tTargets) return;
      const id = row?.id;
      if (!id) return;
      await tTargets.delete(id);
      await refresh();

      emitCanonicalSignal({
        type: "taskCompleted",
        sourceModule: "planner.homestead",
        urgency: "normal",
        completionPct: 100,
        dependencies: ["readiness", "tasks"],
        payload: {
          taskId: id,
          name: row?._computed?.title || row?.title || row?.key || "target",
          action: "deleteTarget",
        },
      });
    } finally {
      busyRef.current = false;
    }
  }

  async function quickStatus(row, status) {
    const id = row?.id;
    if (!id) return;
    await upsertTarget({ ...row, id, status });
  }

  async function quickBumpPriority(row) {
    const current = row?._computed?.priority || "normal";
    const order = ["low", "normal", "high", "critical"];
    const idx = order.indexOf(current);
    const next = order[clamp(idx + 1, 0, order.length - 1)] || "normal";
    await upsertTarget({ ...row, id: row?.id, priority: next });
  }

  function renderDbMissing() {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Provisioning Targets</CardTitle>
          <CardDescription>
            This page needs the Dexie table{" "}
            <code>ftt_provisioning_targets</code> to exist.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {dbLoadError ? (
            <div className="text-sm">
              <Badge variant="destructive">DB Import Failed</Badge>
              <div className="mt-2 text-muted-foreground">
                Could not import <code>@/services/db</code>. Check your
                path/exports.
              </div>
            </div>
          ) : (
            <div className="text-sm">
              <Badge variant="destructive">Table Missing</Badge>
              <div className="mt-2 text-muted-foreground">
                Create/confirm the table name and migration in{" "}
                <code>src/services/db.js</code>:
              </div>
              <ul className="list-disc pl-6 mt-2 text-sm text-muted-foreground">
                <li>ftt_provisioning_targets</li>
                <li>
                  ftt_component_inventory (optional but enables gap checks)
                </li>
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="px-4 py-4 md:px-6 md:py-6 space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            Homestead Planner • Targets
          </h1>
          <p className="text-sm text-muted-foreground">
            Provisioning targets drive preservation, planting, and animal
            planning. Gaps are computed deterministically from your Component
            Inventory when available.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={refresh}
            variant="secondary"
            disabled={!dbOk || loading}
          >
            Refresh
          </Button>
          <Button onClick={openCreate} disabled={!dbOk || loading}>
            Add target
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Realtime scope:</span>
          <button
            type="button"
            onClick={() => setPanelScope("household")}
            className={`rounded border px-2 py-1 text-xs ${
              panelScope === "household"
                ? "bg-black text-white"
                : "bg-transparent text-foreground"
            }`}
          >
            Household
          </button>
          <button
            type="button"
            onClick={() => setPanelScope("family")}
            className={`rounded border px-2 py-1 text-xs ${
              panelScope === "family"
                ? "bg-black text-white"
                : "bg-transparent text-foreground"
            }`}
          >
            Family
          </button>
        </div>
        <RealtimeCoordinationPanel scopeOverrides={{ scope: panelScope }} />
      </div>

      {/* If DB not ready */}
      {ready && !dbOk ? renderDbMissing() : null}

      {/* KPIs + Filters */}
      {dbOk ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Status overview</CardTitle>
            <CardDescription>
              Track total targets, gaps, overdue items, and completed work.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">Total: {kpis.total}</Badge>
              <Badge variant={kpis.gaps > 0 ? "destructive" : "secondary"}>
                Gaps: {kpis.gaps}
              </Badge>
              <Badge variant={kpis.overdue > 0 ? "destructive" : "secondary"}>
                Overdue: {kpis.overdue}
              </Badge>
              <Badge variant="secondary">Done: {kpis.done}</Badge>
            </div>

            <Separator />

            <div className="grid grid-cols-1 gap-3 md:grid-cols-6">
              <div className="md:col-span-2">
                <Label htmlFor="q">Search</Label>
                <Input
                  id="q"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search title, key, notes…"
                />
              </div>

              <div className="md:col-span-1">
                <Label>Type</Label>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All types" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    {TARGET_TYPES.map((t) => (
                      <SelectItem key={t.key} value={t.key}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="md:col-span-1">
                <Label>Status</Label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    {STATUSES.map((s) => (
                      <SelectItem key={s.key} value={s.key}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="md:col-span-1">
                <Label>Priority</Label>
                <Select
                  value={priorityFilter}
                  onValueChange={setPriorityFilter}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="All priorities" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    {PRIORITIES.map((p) => (
                      <SelectItem key={p.key} value={p.key}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="md:col-span-1">
                <Label>Gaps</Label>
                <Select value={gapFilter} onValueChange={setGapFilter}>
                  <SelectTrigger>
                    <SelectValue placeholder="All" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="gaps">Gaps only</SelectItem>
                    <SelectItem value="ok">No gaps</SelectItem>
                    <SelectItem value="overdue">Overdue</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="md:col-span-2">
                <Label>Sort</Label>
                <Select value={sortKey} onValueChange={setSortKey}>
                  <SelectTrigger>
                    <SelectValue placeholder="Due date (asc)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="dueAsc">
                      Due date (soonest first)
                    </SelectItem>
                    <SelectItem value="dueDesc">
                      Due date (latest first)
                    </SelectItem>
                    <SelectItem value="updatedDesc">
                      Recently updated
                    </SelectItem>
                    <SelectItem value="priorityDesc">
                      Priority (high → low)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="text-xs text-muted-foreground">
              Gap checks are currently computed for <strong>Component</strong>{" "}
              targets by comparing target quantity to totals in{" "}
              <code>ftt_component_inventory</code>. Raw crop and animal targets
              will show “—” for gap until you add projections or inventory
              mappings for those types.
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* List */}
      {dbOk ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Targets</CardTitle>
            <CardDescription>
              Click a row to edit. Use quick actions to update status or
              priority.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading ? (
              <div className="text-sm text-muted-foreground">
                Loading targets…
              </div>
            ) : filteredTargets.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No targets match your filters. Try clearing filters or add a
                target.
              </div>
            ) : (
              <div className="space-y-3">
                {filteredTargets.map((row) => {
                  const c = row._computed;
                  const showGap = c.targetType === "component";
                  const gap = showGap ? c.gap : null;

                  return (
                    <Card
                      key={row.id}
                      className="hover:shadow-sm transition-shadow"
                    >
                      <CardContent className="py-4">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          {/* Left info */}
                          <div className="min-w-0 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                variant="ghost"
                                className="px-0 h-auto text-left font-semibold"
                                onClick={() => openEdit(row)}
                              >
                                {c.title}
                              </Button>

                              <Badge variant="outline">
                                {TARGET_TYPES.find(
                                  (t) => t.key === c.targetType
                                )?.label || c.targetType}
                              </Badge>
                              <Badge variant={statusBadgeVariant(c.status)}>
                                {STATUSES.find((s) => s.key === c.status)
                                  ?.label || c.status}
                              </Badge>
                              <Badge variant={priorityBadgeVariant(c.priority)}>
                                {PRIORITIES.find((p) => p.key === c.priority)
                                  ?.label || c.priority}
                              </Badge>

                              {c.overdue ? (
                                <Badge variant="destructive">Overdue</Badge>
                              ) : null}
                            </div>

                            <div className="text-sm text-muted-foreground break-words">
                              <span className="font-mono text-xs">
                                {c.key || "—"}
                              </span>
                              {c.neededBy ? (
                                <>
                                  {" "}
                                  • Due:{" "}
                                  <span className="font-medium">
                                    {fmtDate(c.neededBy)}
                                  </span>
                                  {typeof c.daysUntil === "number" ? (
                                    <span className="text-xs">
                                      {" "}
                                      ({c.daysUntil}d)
                                    </span>
                                  ) : null}
                                </>
                              ) : (
                                <>
                                  {" "}
                                  • Due: <span className="font-medium">—</span>
                                </>
                              )}{" "}
                              • Source:{" "}
                              <span className="font-medium">
                                {SOURCING.find(
                                  (s) => s.key === c.sourcePriority
                                )?.label || c.sourcePriority}
                              </span>
                            </div>

                            <div className="flex flex-wrap items-center gap-2 text-sm">
                              <Badge variant="secondary">
                                Target: {c.qty} {c.unit}
                              </Badge>

                              {showGap ? (
                                <>
                                  <Badge variant="outline">
                                    Available: {c.available} {c.unit}
                                  </Badge>
                                  <Badge
                                    variant={
                                      gap > 0 ? "destructive" : "secondary"
                                    }
                                  >
                                    Gap: {gap} {c.unit}
                                  </Badge>
                                </>
                              ) : (
                                <Badge variant="outline">Gap: —</Badge>
                              )}
                            </div>

                            {row?.notes ? (
                              <div className="text-sm text-muted-foreground whitespace-pre-wrap">
                                {row.notes}
                              </div>
                            ) : null}
                          </div>

                          {/* Right actions */}
                          <div className="flex flex-col gap-2 md:items-end">
                            <div className="flex flex-wrap gap-2 md:justify-end">
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => quickStatus(row, "in_progress")}
                              >
                                Start
                              </Button>
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => quickStatus(row, "done")}
                              >
                                Mark done
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => quickBumpPriority(row)}
                              >
                                Bump priority
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openEdit(row)}
                              >
                                Edit
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => deleteTarget(row)}
                              >
                                Delete
                              </Button>
                            </div>

                            <Tabs
                              defaultValue="actions"
                              className="w-full md:w-[420px]"
                            >
                              <TabsList className="grid w-full grid-cols-2">
                                <TabsTrigger value="actions">
                                  Actions
                                </TabsTrigger>
                                <TabsTrigger value="why">Why</TabsTrigger>
                              </TabsList>

                              <TabsContent value="actions" className="pt-2">
                                <div className="space-y-2">
                                  {c.actions.map((a) => (
                                    <div
                                      key={a.id}
                                      className="rounded-md border p-3"
                                    >
                                      <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                          <div className="font-medium">
                                            {a.title}
                                          </div>
                                          <div className="text-sm text-muted-foreground">
                                            {a.description}
                                          </div>
                                        </div>
                                        <Badge
                                          variant="outline"
                                          className="shrink-0"
                                        >
                                          {a.kind}
                                        </Badge>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </TabsContent>

                              <TabsContent value="why" className="pt-2">
                                <div className="rounded-md border p-3 text-sm text-muted-foreground">
                                  <div className="font-medium text-foreground mb-1">
                                    Deterministic explanation
                                  </div>
                                  <ul className="list-disc pl-5 space-y-1">
                                    <li>
                                      Targets are stored in{" "}
                                      <code>ftt_provisioning_targets</code> and
                                      filtered by type, status, and priority.
                                    </li>
                                    <li>
                                      For <strong>component</strong> targets,
                                      the gap is computed as{" "}
                                      <code>
                                        max(0, targetQty - inventoryTotal)
                                      </code>{" "}
                                      where <code>inventoryTotal</code> is
                                      summed from{" "}
                                      <code>ftt_component_inventory</code> for
                                      the same component key.
                                    </li>
                                    <li>
                                      Suggested actions are based on target type
                                      and the household sourcing ladder (own →
                                      neighbor → local → retail). No AI is used.
                                    </li>
                                  </ul>
                                </div>
                              </TabsContent>
                            </Tabs>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Edit/Create Modal */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {editMode === "create" ? "Add target" : "Edit target"}
            </DialogTitle>
            <DialogDescription>
              Targets should use stable keys for deterministic planning and gap
              tracking.
            </DialogDescription>
          </DialogHeader>

          {form ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Type</Label>
                <Select
                  value={form.targetType}
                  onValueChange={(v) =>
                    setForm((s) => ({ ...s, targetType: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select type" />
                  </SelectTrigger>
                  <SelectContent>
                    {TARGET_TYPES.map((t) => (
                      <SelectItem key={t.key} value={t.key}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => setForm((s) => ({ ...s, status: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => (
                      <SelectItem key={s.key} value={s.key}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Priority</Label>
                <Select
                  value={form.priority}
                  onValueChange={(v) => setForm((s) => ({ ...s, priority: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select priority" />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => (
                      <SelectItem key={p.key} value={p.key}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>Source priority</Label>
                <Select
                  value={form.sourcePriority}
                  onValueChange={(v) =>
                    setForm((s) => ({ ...s, sourcePriority: v }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent>
                    {SOURCING.map((s) => (
                      <SelectItem key={s.key} value={s.key}>
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label>Key (stable identifier)</Label>
                <Input
                  value={form.key}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, key: e.target.value }))
                  }
                  placeholder="e.g., chicken_stock_portion | tomato_passata | cabbage | lamb_bones_stock"
                />
                <div className="text-xs text-muted-foreground">
                  Use your canonical keys so conversions and gap tracking stay
                  reliable.
                </div>
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label>Title</Label>
                <Input
                  value={form.title}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, title: e.target.value }))
                  }
                  placeholder="Human-friendly name"
                />
              </div>

              <div className="space-y-2">
                <Label>Quantity</Label>
                <Input
                  type="number"
                  value={form.quantity}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, quantity: toNum(e.target.value) }))
                  }
                  min={0}
                  step="1"
                />
              </div>

              <div className="space-y-2">
                <Label>Unit</Label>
                <Input
                  value={form.unit}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, unit: e.target.value }))
                  }
                  placeholder="portion | qt | pint | pack | lb"
                />
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label>Needed by (ISO date or datetime)</Label>
                <Input
                  value={form.neededBy || ""}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, neededBy: e.target.value }))
                  }
                  placeholder="2026-02-01 or 2026-02-01T18:00:00.000Z"
                />
                <div className="text-xs text-muted-foreground">
                  Tip: a simple date is okay; this is used for overdue flags and
                  sorting.
                </div>
              </div>

              <div className="space-y-2 md:col-span-2">
                <Label>Notes</Label>
                <Textarea
                  value={form.notes}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, notes: e.target.value }))
                  }
                  placeholder="Constraints, intended meals, storage notes, sourcing notes…"
                  rows={4}
                />
              </div>
            </div>
          ) : null}

          <DialogFooter className="gap-2">
            <Button variant="secondary" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                if (!form) return;
                const payload = {
                  ...form,
                  // Normalize for db:
                  targetType: form.targetType,
                  key: (form.key || "").trim(),
                  title:
                    (form.title || "").trim() ||
                    (form.key || "").trim() ||
                    "(untitled)",
                  quantity: toNum(form.quantity),
                  unit: (form.unit || "unit").trim(),
                  status: form.status,
                  priority: form.priority,
                  sourcePriority: form.sourcePriority,
                  neededBy: (form.neededBy || "").trim() || null,
                  notes: form.notes || "",
                  updatedAt: nowISO(),
                  source: SOURCE,
                };

                // Small validation (deterministic)
                if (!payload.key) {
                  console.warn(
                    "[HomesteadPlannerTargets] Missing key; refusing save."
                  );
                  return;
                }

                await upsertTarget(payload);
                setEditOpen(false);
              }}
              disabled={!form || !form.key}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Footer hint */}
      {dbOk ? (
        <div className="text-xs text-muted-foreground">
          Next: wire “Start preservation session” / “Create garden target” /
          “Create animal target” to your SessionRunner and planner builders.
          This page already exposes the deterministic action list.
        </div>
      ) : null}
    </div>
  );
}
