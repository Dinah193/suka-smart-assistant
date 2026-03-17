// src/pages/MealPlanning/PrepChecklistGenerator.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

// Soft deps (graceful fallback)
let eventBus = { emit: () => {}, on: () => () => {} };
let automation = { invoke: async () => {} };
let useMealPlanStore = () => ({
  getActiveDraft: () => null,
  getSelectedScope: () => null, // { type: "plan|week|day|session", id }
  getMealsForScope: () => [],
});
let useBatchStore = () => ({ getActiveBatch: () => null }); // BatchSessionPlanner
let useRecipeStore = () => ({ getRecipeById: () => null });
let useInventoryStore = () => ({
  reserveForPrep: async () => {},
  releaseReservation: async () => {},
});
let usePreferencesStore = () => ({
  sabbathAware: true,
  unitSystem: "imperial",
});

try {
  eventBus = require("@/services/events/eventBus").eventBus;
} catch {}
try {
  automation = require("@/services/automation/runtime").automation;
} catch {}
try {
  useMealPlanStore = require("@/store/MealPlanStore").useMealPlanStore;
} catch {}
try {
  useBatchStore = require("@/store/BatchStore").useBatchStore;
} catch {}
try {
  useRecipeStore = require("@/store/RecipeStore").useRecipeStore;
} catch {}
try {
  useInventoryStore = require("@/store/InventoryStore").useInventoryStore;
} catch {}
try {
  usePreferencesStore = require("@/store/PreferencesStore").usePreferencesStore;
} catch {}

// UI
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/use-toast";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";

// Utils
const cx = (...a) => a.filter(Boolean).join(" ");
const MINUTE = 60 * 1000;

// --- Core task building helpers ------------------------------------------------

/**
 * Creates a normalized prep task object
 */
function prepTask({
  id,
  title,
  notes = "",
  station = "Prep",
  durationMin = 5,
  dependsOn = [],
  quantity = 1,
  unit = "",
  recipeId = null,
  slotRef = null, // {date, slot}
  isCritical = false,
  allergens = [],
  tags = [],
}) {
  return {
    id,
    title,
    notes,
    station,
    durationMin,
    dependsOn,
    quantity,
    unit,
    recipeId,
    slotRef,
    isCritical,
    allergens,
    tags,
    done: false,
  };
}

/**
 * Very light derivation from a recipe object into prep tasks.
 * Real system likely uses per-step metadata; we map common patterns.
 */
function deriveTasksFromRecipe(recipe, context = {}) {
  if (!recipe) return [];
  const r = recipe;
  const rId = r.id || r.ref || `recipe_${Math.random().toString(36).slice(2)}`;
  const baseTags = (r.tags || []).map(String);

  const servings = context.servings ?? r.servings ?? 4;
  const tasks = [];

  // 1) Thaw / Soak if present
  if (
    baseTags.includes("frozen") ||
    (r.meta?.requiresThaw && r.meta.requiresThaw === true)
  ) {
    tasks.push(
      prepTask({
        id: `${rId}_thaw`,
        title: `Thaw ${r.title || "ingredients"}`,
        station: "Cold",
        durationMin: 0,
        notes: "Move from freezer to fridge 12–24h prior.",
        isCritical: true,
        tags: ["thaw", "advance"],
        recipeId: rId,
      })
    );
  }
  if (r.meta?.requiresSoak) {
    tasks.push(
      prepTask({
        id: `${rId}_soak`,
        title: `Soak legumes/grains for ${r.meta.requiresSoak}h`,
        station: "Sink",
        durationMin: 5,
        notes: "Cover with water + salt/lemon as recipe prescribes.",
        isCritical: true,
        tags: ["soak", "advance"],
        recipeId: rId,
      })
    );
  }

  // 2) Core mise en place
  tasks.push(
    prepTask({
      id: `${rId}_mise`,
      title: `Mise en place: ${r.title || "ingredients"}`,
      station: "Prep",
      durationMin: Math.max(5, Math.round(servings * 3)), // heuristic
      notes: "Wash, measure, set out tools/pans; preheat if required.",
      tags: ["mise", "knife"],
      recipeId: rId,
    })
  );

  // 3) Cut/Chop based on ingredients
  const ing = r.ingredients || [];
  const chopCount = ing.filter((i) =>
    /onion|pepper|tomato|carrot|celery|garlic|greens|potato|herb/i.test(
      i.name || ""
    )
  ).length;

  if (chopCount > 0) {
    tasks.push(
      prepTask({
        id: `${rId}_chop`,
        title: `Chop / prep produce (${chopCount} items)`,
        station: "Knife",
        durationMin: Math.max(5, chopCount * 3),
        notes: "Uniform cuts = even cooking; set aside by recipe step.",
        tags: ["produce", "knife"],
        recipeId: rId,
      })
    );
  }

  // 4) Marinade/Rub (meat or plant-protein)
  if (baseTags.includes("marinade") || r.meta?.marinateMin) {
    tasks.push(
      prepTask({
        id: `${rId}_marinade`,
        title: `Marinate (${r.meta?.marinateMin || 30} min)`,
        station: "Prep",
        durationMin: 5,
        notes: "Combine marinade; toss, cover, chill.",
        tags: ["marinade"],
        recipeId: rId,
      })
    );
  }

  // 5) Preheat/Preboil
  if (r.meta?.preheat || baseTags.includes("baked")) {
    tasks.push(
      prepTask({
        id: `${rId}_preheat`,
        title: `Preheat oven to ${r.meta?.preheat || 375}°F`,
        station: "Oven",
        durationMin: 1,
        notes: "Start 10–15 min before cook step.",
        tags: ["preheat"],
        recipeId: rId,
      })
    );
  }
  if (baseTags.includes("pasta") || r.meta?.boilWater === true) {
    tasks.push(
      prepTask({
        id: `${rId}_boil`,
        title: "Bring water to a boil",
        station: "Stove",
        durationMin: 1,
        notes: "Salt water if appropriate.",
        tags: ["boil"],
        recipeId: rId,
      })
    );
  }

  // 6) Sauce/Dressing
  if (baseTags.includes("sauce") || baseTags.includes("dressing")) {
    tasks.push(
      prepTask({
        id: `${rId}_sauce`,
        title: "Make sauce/dressing",
        station: "Mix",
        durationMin: 10,
        notes: "Whisk/blend. Label if batchable.",
        tags: ["sauce"],
        recipeId: rId,
      })
    );
  }

  // 7) Labeling / Storage for batchable components
  if (context.batchMode) {
    tasks.push(
      prepTask({
        id: `${rId}_label`,
        title: "Label containers",
        station: "Label",
        durationMin: 2,
        notes: "Name • date • servings • reheating notes.",
        tags: ["label"],
        recipeId: rId,
      })
    );
  }

  return tasks;
}

/**
 * Build tasks from selected scope: plan/day/week or active batch session.
 */
function buildTasksFromScope({
  meals = [],
  recipesById = {},
  batch = null,
  scope = null,
}) {
  const tasks = [];

  // From meal items
  for (const m of meals) {
    for (const slot of m.slots || []) {
      for (const it of slot.items || []) {
        if (it.type === "recipe") {
          const recipe = recipesById[it.ref] || {
            id: it.ref,
            title: it.title,
            ingredients: [],
            tags: [],
          };
          const t = deriveTasksFromRecipe(recipe, {
            servings: recipe.servings,
            batchMode: Boolean(batch),
          }).map((tk) => ({
            ...tk,
            slotRef: { date: m.date, slot: slot.name },
          }));
          tasks.push(...t);
        }
      }
    }
  }

  // From batch session extras (if present)
  if (batch?.steps?.length) {
    tasks.push(
      ...batch.steps.map((s, i) =>
        prepTask({
          id: `batch_step_${i}`,
          title: s.title || "Batch Step",
          station: s.station || "Prep",
          durationMin: s.durationMin || 5,
          notes: s.notes || "",
          isCritical: !!s.isCritical,
          tags: ["batch"],
        })
      )
    );
  }

  return tasks;
}

/** Merge duplicate-ish tasks and sort by station then criticality */
function consolidateTasks(tasks) {
  const keyOf = (t) => `${t.station}|${t.title}|${t.recipeId ?? ""}`;
  const map = new Map();
  for (const t of tasks) {
    const k = keyOf(t);
    if (!map.has(k)) map.set(k, { ...t });
    else {
      const prev = map.get(k);
      prev.quantity = (prev.quantity || 1) + (t.quantity || 1);
      prev.durationMin += t.durationMin || 0;
      prev.notes = [prev.notes, t.notes].filter(Boolean).join(" • ");
      prev.tags = Array.from(
        new Set([...(prev.tags || []), ...(t.tags || [])])
      );
      map.set(k, prev);
    }
  }
  const merged = Array.from(map.values());
  // station order heuristic
  const order = [
    "Advance",
    "Cold",
    "Sink",
    "Knife",
    "Mix",
    "Stove",
    "Oven",
    "Label",
    "Cleanup",
    "Prep",
  ];
  const idx = (s) => {
    const i = order.indexOf(s);
    return i === -1 ? 999 : i;
  };
  merged.sort(
    (a, b) =>
      idx(a.station) - idx(b.station) ||
      b.isCritical - a.isCritical ||
      a.title.localeCompare(b.title)
  );
  return merged;
}

// --- Component ----------------------------------------------------------------

export default function PrepChecklistGenerator({ className }) {
  const { getSelectedScope, getMealsForScope } = useMealPlanStore();
  const { getRecipeById } = useRecipeStore();
  const { getActiveBatch } = useBatchStore();
  const { reserveForPrep, releaseReservation } = useInventoryStore();
  const { sabbathAware } = usePreferencesStore();

  const [scope, setScope] = useState(() => getSelectedScope?.() || null);
  const [source, setSource] = useState("selection"); // selection | batch
  const [search, setSearch] = useState("");
  const [stationFilter, setStationFilter] = useState("all");
  const [sortBy, setSortBy] = useState("station"); // station | alpha | critical
  const [notes, setNotes] = useState("");
  const [checkState, setCheckState] = useState({}); // id -> boolean
  const [busy, setBusy] = useState(false);

  const prevSnapshot = useRef(null);
  const reservationRef = useRef(null);

  // Refresh on plan events
  useEffect(() => {
    const off1 = eventBus.on("mealplan.updated", () =>
      setScope(getSelectedScope?.() || null)
    );
    const off2 = eventBus.on("session.finalized", () =>
      setScope(getSelectedScope?.() || null)
    );
    const off3 = eventBus.on("preferences.changed", () =>
      setScope(getSelectedScope?.() || null)
    );
    return () => {
      off1?.();
      off2?.();
      off3?.();
    };
  }, [getSelectedScope]);

  // Build tasks
  const meals = useMemo(() => {
    if (source === "batch") return [];
    return getMealsForScope?.(scope) || [];
  }, [scope, source, getMealsForScope]);

  const batch = useMemo(
    () => (source === "batch" ? getActiveBatch?.() : null),
    [source, getActiveBatch]
  );

  const recipesById = useMemo(() => {
    const map = {};
    for (const m of meals) {
      for (const s of m.slots || []) {
        for (const it of s.items || []) {
          if (it.type === "recipe" && it.ref) {
            const r = getRecipeById?.(it.ref);
            if (r) map[it.ref] = r;
          }
        }
      }
    }
    return map;
  }, [meals, getRecipeById]);

  const rawTasks = useMemo(
    () => buildTasksFromScope({ meals, recipesById, batch, scope }),
    [meals, recipesById, batch, scope]
  );

  const baseTasks = useMemo(() => consolidateTasks(rawTasks), [rawTasks]);

  // Filter / sort / search
  const tasks = useMemo(() => {
    let t = baseTasks;
    if (stationFilter !== "all")
      t = t.filter((x) => x.station === stationFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      t = t.filter(
        (x) =>
          x.title.toLowerCase().includes(q) ||
          (x.notes || "").toLowerCase().includes(q)
      );
    }
    if (sortBy === "alpha")
      t = [...t].sort((a, b) => a.title.localeCompare(b.title));
    if (sortBy === "critical")
      t = [...t].sort(
        (a, b) => b.isCritical - a.isCritical || a.title.localeCompare(b.title)
      );
    // default station sort already applied in consolidateTasks
    return t;
  }, [baseTasks, stationFilter, search, sortBy]);

  const stations = useMemo(
    () => ["all", ...Array.from(new Set(baseTasks.map((t) => t.station)))],
    [baseTasks]
  );

  const preservationOps = useMemo(() => {
    const hits = baseTasks.filter((t) =>
      /(label|cool|jar|canning|freeze|dehydrate|sauce|brine|preserve)/i.test(
        `${t.title || ""} ${t.notes || ""} ${(t.tags || []).join(" ")}`
      )
    );
    return {
      count: hits.length,
      titles: hits.slice(0, 4).map((t) => t.title),
    };
  }, [baseTasks]);

  const allChecked = useMemo(
    () => tasks.length > 0 && tasks.every((t) => checkState[t.id]),
    [tasks, checkState]
  );
  const someChecked = useMemo(
    () => tasks.some((t) => checkState[t.id]),
    [tasks, checkState]
  );

  const sabbathTag = sabbathAware ? (
    <Badge variant="secondary">Sabbath-aware</Badge>
  ) : null;

  // Actions
  const toggleAll = (val) => {
    const next = { ...checkState };
    for (const t of tasks) next[t.id] = val;
    setCheckState(next);
  };

  const clearChecks = () => setCheckState({});

  const snapshot = () =>
    JSON.parse(
      JSON.stringify({ checkState, notes, stationFilter, sortBy } || {})
    );
  const restore = () => {
    const prev = prevSnapshot.current;
    if (!prev) return;
    setCheckState(prev.checkState || {});
    setNotes(prev.notes || "");
    setStationFilter(prev.stationFilter || "all");
    setSortBy(prev.sortBy || "station");
    toast({
      title: "Reverted",
      description: "Restored previous checklist state.",
    });
  };

  const reserveInventory = async () => {
    prevSnapshot.current = snapshot();
    try {
      setBusy(true);
      const payload = {
        source,
        scope,
        tasks: baseTasks.map(({ title, quantity, unit, station }) => ({
          title,
          quantity,
          unit,
          station,
        })),
      };
      const res = await reserveForPrep?.(payload);
      reservationRef.current = res?.reservationId || "temp";
      toast({
        title: "Ingredients reserved",
        description: "Inventory quantities reserved for prep.",
        action: (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await releaseReservation?.(reservationRef.current);
              toast({ title: "Reservation released" });
            }}
          >
            Release
          </Button>
        ),
      });
    } catch {
      toast({
        title: "Reserve failed",
        description: "Could not reserve inventory.",
      });
    } finally {
      setBusy(false);
    }
  };

  const makeTimers = async () => {
    // create a multi-timer batch based on tasks; group by station
    try {
      const groups = {};
      for (const t of tasks) {
        groups[t.station] = groups[t.station] || [];
        groups[t.station].push({
          label: t.title,
          minutes: Math.max(1, t.durationMin),
        });
      }
      await automation.invoke?.("timer.batch.create", { groups });
      toast({
        title: "Timers created",
        description: "Multi-timer batch started in Timer Panel.",
      });
      eventBus.emit("ui.open", { id: "MultiTimerPanel" });
    } catch {
      toast({
        title: "Timer error",
        description: "Could not create multi-timers.",
      });
    }
  };

  const exportChecklist = async (format = "pdf") => {
    try {
      await automation.invoke?.("export.prepChecklist", {
        format,
        meta: { source, scope, notes },
        tasks: baseTasks,
        checks: checkState,
      });
      toast({
        title: "Exported",
        description: `Checklist exported as ${format.toUpperCase()}.`,
      });
    } catch {
      toast({
        title: "Export failed",
        description: "Could not export checklist.",
      });
    }
  };

  const shareChecklist = async () => {
    try {
      await automation.invoke?.("share.prepChecklist", {
        meta: { source, scope, notes },
        tasks: baseTasks,
      });
      toast({
        title: "Shared",
        description: "Checklist shared with your family group.",
      });
    } catch {
      toast({
        title: "Share failed",
        description: "Could not share checklist.",
      });
    }
  };

  const printChecklist = () => {
    eventBus.emit("export.print", {
      id: "PrepChecklist",
      tasks: baseTasks,
      checks: checkState,
    });
  };

  const openBatch = () =>
    eventBus.emit("ui.open", { id: "BatchSessionPlanner" });
  const openVault = () => eventBus.emit("ui.open", { id: "RecipeVault" });

  // Empty state
  const showEmpty = source === "selection" ? meals.length === 0 : !batch;
  if (showEmpty) {
    return (
      <div className={className}>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Prep Checklist Generator
              <Badge variant="outline">Empty</Badge>
              {sabbathTag}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>No meals or batch session found for the current selection.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={openVault}>
                Open Recipe Vault
              </Button>
              <Button size="sm" variant="outline" onClick={openBatch}>
                Open Batch Session Planner
              </Button>
            </div>
            <div className="grid grid-cols-3 gap-3 mt-4">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className={className}>
      {/* Header */}
      <Card className="sticky top-0 z-10">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                Prep Checklist Generator
                <Badge variant="outline">
                  {source === "batch" ? "Batch Session" : "Plan Selection"}
                </Badge>
                {sabbathTag}
              </CardTitle>
              <div className="text-xs text-muted-foreground mt-1">
                Auto-builds station-based prep tasks from your plan or batch
                session. Check off, export, or spin up multi-timers.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Select value={source} onValueChange={setSource}>
                <SelectTrigger className="h-8 w-[160px]">
                  <SelectValue placeholder="Source" />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="selection">Current Selection</SelectItem>
                  <SelectItem value="batch">Active Batch Session</SelectItem>
                </SelectContent>
              </Select>
              <Input
                className="h-8 w-56"
                placeholder="Search tasks…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </CardHeader>
        <Separator />
        <div className="px-6 py-2 flex flex-wrap items-center gap-2">
          <Label className="text-xs text-muted-foreground">Station</Label>
          <Select value={stationFilter} onValueChange={setStationFilter}>
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue placeholder="All stations" />
            </SelectTrigger>
            <SelectContent>
              {stations.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Label className="text-xs text-muted-foreground ml-2">Sort</Label>
          <Select value={sortBy} onValueChange={setSortBy}>
            <SelectTrigger className="h-8 w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="station">By Station</SelectItem>
              <SelectItem value="alpha">A → Z</SelectItem>
              <SelectItem value="critical">Critical First</SelectItem>
            </SelectContent>
          </Select>

          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => toggleAll(!allChecked)}
              variant={allChecked ? "secondary" : "default"}
            >
              {allChecked ? "Uncheck All" : "Check All"}
            </Button>
            <Button size="sm" variant="outline" onClick={clearChecks}>
              Clear Checks
            </Button>
          </div>
        </div>
      </Card>

      {/* Content */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 mt-3">
        {/* LEFT: Tasks */}
        <Card>
          <CardContent className="pt-4">
            {tasks.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No tasks match current filters.
              </div>
            ) : (
              <ScrollArea className="max-h-[70vh] pr-2">
                <div className="space-y-2">
                  {tasks.map((t) => (
                    <div
                      key={t.id}
                      className="flex items-start gap-3 rounded-lg border p-3"
                    >
                      <Checkbox
                        checked={!!checkState[t.id]}
                        onCheckedChange={(v) =>
                          setCheckState((cs) => ({ ...cs, [t.id]: !!v }))
                        }
                        className="mt-0.5"
                        aria-label={`Check ${t.title}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div
                            className={cx(
                              "font-medium truncate",
                              t.isCritical ? "text-amber-700" : ""
                            )}
                          >
                            {t.title}
                          </div>
                          <Badge variant="secondary">{t.station}</Badge>
                          {t.isCritical && (
                            <Badge className="bg-amber-100 text-amber-800">
                              Critical
                            </Badge>
                          )}
                          {t.tags?.slice(0, 2).map((tg) => (
                            <Badge key={tg} variant="outline">
                              {tg}
                            </Badge>
                          ))}
                        </div>
                        {t.notes && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {t.notes}
                          </div>
                        )}
                        <div className="text-[11px] text-muted-foreground mt-1">
                          Duration: {t.durationMin} min
                          {t.quantity ? (
                            <>
                              {" "}
                              • Qty: {t.quantity}
                              {t.unit ? ` ${t.unit}` : ""}
                            </>
                          ) : null}
                          {t.slotRef ? (
                            <>
                              {" "}
                              • {t.slotRef.date} • {t.slotRef.slot}
                            </>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        {/* RIGHT: Actions + Notes */}
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button size="sm" className="w-full" onClick={makeTimers}>
                Create Multi-Timers
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={reserveInventory}
                disabled={busy}
              >
                {busy ? "Reserving…" : "Reserve Ingredients"}
              </Button>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => exportChecklist("pdf")}
                >
                  Export PDF
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => exportChecklist("csv")}
                >
                  Export CSV
                </Button>
                <Button size="sm" variant="secondary" onClick={printChecklist}>
                  Print
                </Button>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="w-full"
                onClick={shareChecklist}
              >
                Share to Family
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Prep Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Any special instructions, allergies, or substitutions…"
              />
              <div className="mt-2 flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={async () => {
                    prevSnapshot.current = snapshot();
                    try {
                      await automation.invoke?.("notes.save", {
                        context: { kind: "prepChecklist", scope, source },
                        notes,
                      });
                      toast({
                        title: "Notes saved",
                        action: (
                          <Button size="sm" variant="outline" onClick={restore}>
                            Undo
                          </Button>
                        ),
                      });
                    } catch {
                      toast({
                        title: "Save failed",
                        description: "Could not save notes.",
                      });
                    }
                  }}
                >
                  Save Notes
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    prevSnapshot.current = snapshot();
                    setNotes("");
                    toast({
                      title: "Notes cleared",
                      action: (
                        <Button size="sm" variant="outline" onClick={restore}>
                          Undo
                        </Button>
                      ),
                    });
                  }}
                >
                  Clear
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Guide</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground space-y-2">
              <p>
                Tasks are derived from recipes (mise, chop, marinade, preheat,
                boil, sauces, labeling) and consolidated by station. Switch to{" "}
                <Badge variant="outline">Batch Session</Badge> to include
                BatchSessionPlanner steps.
              </p>
              <p>
                Use <Badge variant="secondary">Create Multi-Timers</Badge> to
                spin up timers grouped by station in your MultiTimerPanel.
                Reserve ingredients to protect storehouse stock before cooking.
              </p>
              <p>
                Sabbath-aware agents (if enabled) will insert hands-off holds
                when scheduling work.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Preservation Link</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <p>
                Detected preservation opportunities: <b>{preservationOps.count}</b>
              </p>
              {preservationOps.titles.length ? (
                <div className="rounded-md border p-2">
                  {preservationOps.titles.join("; ")}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    eventBus.emit("ui.open", {
                      id: "BatchSessionLinker",
                      params: { source: "prepChecklist", scope },
                    })
                  }
                >
                  Open Batch Session Linker
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    eventBus.emit("realtime.signal", {
                      type: "preservationOpportunity",
                      source: "prep.checklist",
                      scope,
                      count: preservationOps.count,
                    })
                  }
                >
                  Notify collaboration panel
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Footer: progress + bulk ops */}
      <Card className="mt-3">
        <CardContent className="py-3 flex flex-wrap items-center gap-2">
          <div className="text-xs text-muted-foreground">
            {someChecked
              ? `${Object.values(checkState).filter(Boolean).length} of ${
                  tasks.length
                } tasks checked`
              : `${tasks.length} tasks ready`}
          </div>
          <Tabs defaultValue="next">
            <TabsList>
              <TabsTrigger value="next">Next Best Action</TabsTrigger>
              <TabsTrigger value="ops">Bulk Ops</TabsTrigger>
            </TabsList>
            <TabsContent value="next" className="mt-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() =>
                    eventBus.emit("nutrition.suggestSwap", {
                      scope: scope || { type: "selection" },
                    })
                  }
                >
                  Suggest Nutrition-Aligned Swaps
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    eventBus.emit("ui.open", {
                      id: "ShoppingChecklistGenerator",
                      params: { scope },
                    })
                  }
                >
                  Generate Shopping List
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    eventBus.emit("ui.open", {
                      id: "BatchInventoryMap",
                      params: { scope },
                    })
                  }
                >
                  Open Inventory Map
                </Button>
              </div>
            </TabsContent>
            <TabsContent value="ops" className="mt-2">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => toggleAll(true)}>
                  Mark All Done
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => toggleAll(false)}
                >
                  Mark All Not Done
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const done = Object.entries(checkState)
                      .filter(([, v]) => v)
                      .map(([k]) => k);
                    eventBus.emit("prep.tasks.completed", {
                      ids: done,
                      scope,
                      source,
                    });
                    toast({
                      title: "Logged",
                      description: `${done.length} tasks marked complete.`,
                    });
                  }}
                >
                  Log Completed
                </Button>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
