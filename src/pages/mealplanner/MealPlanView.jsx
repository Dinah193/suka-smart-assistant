// src/pages/MealPlanning/MealPlanView.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { eventBus } from "@/services/events/eventBus";
import { automation } from "@/services/automation/runtime";

import MealTemplatePicker from "./MealTemplatePicker.jsx";
import MealPlanNutritiionPeek from "./MealPlanNutritiionPeek.jsx";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/use-toast";
import { Skeleton } from "@/components/ui/skeleton";

// Optional hooks/stores (soft deps with graceful fallback)
let useMealPlanStore = () => ({
  getActiveDraft: () => null,
  upsertDraft: () => {},
  removeDraft: () => {},
  commitDraftToPlan: async () => {},
  getPlanById: () => null,
  modeLabel: () => "",
  // helpers for selection
  setSelectedScope: () => {},
});
let usePreferencesStore = () => ({
  sabbathAware: true,
  unitSystem: "imperial",
});
let useRecipeStore = () => ({ findSimilar: async () => [] });

try {
  useMealPlanStore = require("@/store/MealPlanStore").useMealPlanStore;
} catch {}
try {
  usePreferencesStore = require("@/store/PreferencesStore").usePreferencesStore;
} catch {}
try {
  useRecipeStore = require("@/store/RecipeStore").useRecipeStore;
} catch {}

// Utilities
function cx(...cls) {
  return cls.filter(Boolean).join(" ");
}
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${DAY_NAMES[d.getDay()]} • ${d.toLocaleDateString()}`;
};

// Slot card for each meal time
function SlotCard({
  day,
  slot,
  onReplace,
  onRemove,
  onOpen,
  onSuggest,
  onDecide,
}) {
  const items = slot.items || [];
  return (
    <Card className="hover:shadow-sm transition">
      <CardHeader className="py-2">
        <CardTitle className="text-sm flex items-center justify-between">
          <span>{slot.name}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="xs" variant="ghost" aria-label="Slot actions">
                •••
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Slot actions</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => onSuggest?.(day, slot)}>
                Suggest recipes
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onDecide?.(day, slot)}>
                Decide for this slot
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onOpen?.(day, slot)}>
                Open in Recipe Vault
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onRemove?.(day, slot)}
                className="text-rose-600"
              >
                Clear slot
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {!items.length && (
          <div className="text-xs text-muted-foreground">
            Empty. Drag recipes here,{" "}
            <button
              className="underline"
              onClick={() => onSuggest?.(day, slot)}
            >
              get suggestions
            </button>
            , or{" "}
            <button className="underline" onClick={() => onDecide?.(day, slot)}>
              let the Decider choose
            </button>
            .
          </div>
        )}
        {items.map((it, idx) => (
          <div
            key={idx}
            className="flex items-center justify-between rounded-md border px-2 py-1"
          >
            <div className="min-w-0">
              <div className="truncate text-sm">
                {it.type === "note" ? (
                  <span className="italic text-muted-foreground">
                    {String(it.ref).replace("template:", "")}
                  </span>
                ) : (
                  it.title || it.ref || "Recipe"
                )}
              </div>
              <div className="text-[11px] text-muted-foreground">
                Qty: {it.quantity ?? 1}
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="xs" variant="ghost" aria-label="Item actions">
                  ⋯
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onOpen?.(day, slot, it)}>
                  Open
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onReplace?.(day, slot, it)}>
                  Swap with similar
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onRemove?.(day, slot, it)}
                  className="text-rose-600"
                >
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// Day row
function DayRow({ day, onSlotAction }) {
  const dateLabel = fmtDate(day.date);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="font-medium">{dateLabel}</div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">Plan Day</Badge>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onSlotAction("cloneDay", day)}
          >
            Clone day
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onSlotAction("clearDay", day)}
            className="text-rose-600"
          >
            Clear day
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {(day.slots || []).map((slot, i) => (
          <SlotCard
            key={i}
            day={day}
            slot={slot}
            onReplace={(...args) => onSlotAction("replaceItem", ...args)}
            onRemove={(...args) => onSlotAction("removeItem", ...args)}
            onOpen={(...args) => onSlotAction("open", ...args)}
            onSuggest={(...args) => onSlotAction("suggest", ...args)}
            onDecide={(...args) => onSlotAction("decideSlot", ...args)}
          />
        ))}
      </div>
      <Separator />
    </div>
  );
}

export default function MealPlanView({ className }) {
  const {
    getActiveDraft,
    upsertDraft,
    removeDraft,
    commitDraftToPlan,
    getPlanById,
    modeLabel,
    setSelectedScope,
  } = useMealPlanStore();
  const { sabbathAware } = usePreferencesStore();
  const { findSimilar } = useRecipeStore();

  // State
  const [draft, setDraft] = useState(() => getActiveDraft?.() || null);
  const [search, setSearch] = useState("");
  const [view, setView] = useState("plan"); // day | week | plan
  const prevDraftRef = useRef(null);
  const [loading, setLoading] = useState(false);

  // Subscribe to plan/draft updates
  useEffect(() => {
    const off1 = eventBus.on("mealplan.draft.created", ({ draft }) =>
      setDraft(draft)
    );
    const off2 = eventBus.on("mealplan.updated", ({ draft }) =>
      setDraft(draft)
    );
    const off3 = eventBus.on("recipe.consolidated", () =>
      setDraft(getActiveDraft?.())
    );
    return () => {
      off1?.();
      off2?.();
      off3?.();
    };
  }, [getActiveDraft]);

  // Scope selection updates Nutrition Peek
  useEffect(() => {
    if (!draft) return;
    // default to plan scope
    setSelectedScope?.({ type: "plan", id: draft.id });
  }, [draft, setSelectedScope]);

  const autoManualLabel = useMemo(() => {
    if (!draft?.meta) return "";
    return modeLabel?.({ type: "plan", id: draft.id }) || "";
  }, [draft, modeLabel]);

  // Filter days by search (simple)
  const filteredDays = useMemo(() => {
    if (!draft?.days) return [];
    if (!search.trim()) return draft.days;
    const q = search.toLowerCase();
    return draft.days.filter(
      (d) =>
        d.date.includes(q) ||
        (d.slots || []).some(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            (s.items || []).some((it) =>
              String(it.title || it.ref)
                .toLowerCase()
                .includes(q)
            )
        )
    );
  }, [draft, search]);

  // Undo helpers
  const snapshot = () => JSON.parse(JSON.stringify(draft || {}));
  const restorePrev = () => {
    const prev = prevDraftRef.current;
    if (!prev) return;
    upsertDraft?.(prev);
    setDraft(prev);
    toast({
      title: "Reverted",
      description: "Restored previous meal plan state.",
    });
  };

  const commitPlan = async () => {
    if (!draft) return;
    prevDraftRef.current = snapshot();
    try {
      setLoading(true);
      await commitDraftToPlan?.(draft.id);
      toast({
        title: "Plan saved",
        description: "Your meal plan has been committed.",
      });
      // Trigger downstream automations
      eventBus.emit("calendar.synced");
      eventBus.emit("grocerylist.requested", { draftId: draft.id }); // ensure list generation prompt
    } catch (e) {
      toast({
        title: "Save failed",
        description: "Could not commit meal plan.",
      });
    } finally {
      setLoading(false);
    }
  };

  const clearPlan = () => {
    if (!draft) return;
    prevDraftRef.current = snapshot();
    const next = {
      ...draft,
      days: draft.days.map((d) => ({
        ...d,
        slots: d.slots.map((s) => ({ ...s, items: [] })),
      })),
    };
    upsertDraft?.(next);
    setDraft(next);
    toast({
      title: "Plan cleared",
      description: "Removed all items from every slot.",
      action: (
        <Button variant="outline" size="sm" onClick={restorePrev}>
          Undo
        </Button>
      ),
    });
  };

  const exportPlan = async () => {
    try {
      await automation.invoke?.("export.mealPlan", { draftId: draft?.id });
      toast({ title: "Exported", description: "Meal plan exported." });
    } catch (e) {
      toast({
        title: "Export failed",
        description: "Could not export meal plan.",
      });
    }
  };

  const sharePlan = async () => {
    try {
      await automation.invoke?.("share.mealPlan", { draftId: draft?.id });
      toast({
        title: "Shared",
        description: "Meal plan shared with your family group.",
      });
    } catch (e) {
      toast({
        title: "Share failed",
        description: "Could not share meal plan.",
      });
    }
  };

  const autofill = async () => {
    if (!draft) return;
    prevDraftRef.current = snapshot();
    try {
      setLoading(true);
      await automation.invoke?.("mealplan.autofillFromTemplate", {
        draftId: draft.id,
        templateId: draft.meta?.templateId || draft.templateId,
        selectors: draft.meta?.selectors,
        constraints: draft.meta?.constraints,
      });
      toast({
        title: "Autofill queued",
        description: "We’ll suggest recipes for each slot.",
      });
    } catch {
      toast({
        title: "Autofill failed",
        description: "Agent could not complete autofill.",
      });
    } finally {
      setLoading(false);
    }
  };

  // NEW: Entry points for the 3 features
  const openCollector = () => {
    eventBus.emit("ui.open", {
      id: "CollectOrganize",
      params: { back: "MealPlanView", draftId: draft?.id },
    });
    eventBus.emit?.("recipe.import.requested", { source: "mealPlanner" });
  };

  const openDecider = (payload = {}) => {
    // Prefill with open slots in visible range + constraints
    const openSlots = (draft?.days || []).flatMap((d) =>
      (d.slots || [])
        .filter((s) => !s.items?.length)
        .map((s) => ({ day: d.date, slot: s.name }))
    );
    const params = {
      source: "mealPlanner",
      draftId: draft?.id,
      openSlots,
      constraints: draft?.meta?.constraints || {},
      ...payload,
    };
    eventBus.emit("ui.open", { id: "RecipeDecider", params });
    eventBus.emit("decider.invoked", params);
  };

  const openPinterestWizard = () => {
    eventBus.emit("ui.open", {
      id: "PinterestImportWizard",
      params: { draftId: draft?.id },
    });
  };

  const openEditor = () =>
    eventBus.emit("ui.open", {
      id: "MealPlanEditor",
      params: { draftId: draft?.id },
    });

  // Slot actions wiring
  const onSlotAction = async (type, day, slot, item) => {
    if (!draft) return;
    prevDraftRef.current = snapshot();

    const next = JSON.parse(JSON.stringify(draft));
    const dayIdx = next.days.findIndex((d) => d.date === day.date);
    const slotIdx = next.days[dayIdx]?.slots?.findIndex(
      (s) => s.name === slot.name
    );

    function write() {
      upsertDraft?.(next);
      setDraft(next);
      eventBus.emit("mealplan.updated", { draft: next });
    }

    if (type === "clearDay") {
      next.days[dayIdx].slots = next.days[dayIdx].slots.map((s) => ({
        ...s,
        items: [],
      }));
      write();
      toast({
        title: "Day cleared",
        description: fmtDate(day.date),
        action: (
          <Button size="sm" variant="outline" onClick={restorePrev}>
            Undo
          </Button>
        ),
      });
      return;
    }

    if (type === "cloneDay") {
      const clone = JSON.parse(JSON.stringify(next.days[dayIdx]));
      clone.date = new Date(
        new Date(clone.date).getTime() + 24 * 60 * 60 * 1000
      )
        .toISOString()
        .slice(0, 10);
      next.days.splice(dayIdx + 1, 0, clone);
      write();
      toast({
        title: "Day cloned",
        description: `Duplicated ${fmtDate(day.date)}`,
        action: (
          <Button size="sm" variant="outline" onClick={restorePrev}>
            Undo
          </Button>
        ),
      });
      return;
    }

    if (type === "removeItem") {
      if (!item) {
        next.days[dayIdx].slots[slotIdx].items = [];
      } else {
        next.days[dayIdx].slots[slotIdx].items = (
          next.days[dayIdx].slots[slotIdx].items || []
        ).filter((x) => x !== item);
      }
      write();
      toast({
        title: "Removed",
        description: `${slot.name} updated`,
        action: (
          <Button size="sm" variant="outline" onClick={restorePrev}>
            Undo
          </Button>
        ),
      });
      return;
    }

    if (type === "open") {
      eventBus.emit("ui.open", {
        id: "RecipeVault",
        params: { day: day.date, slot: slot.name },
      });
      return;
    }

    if (type === "suggest") {
      await automation.invoke?.("mealplan.suggestForSlot", {
        day: day.date,
        slot: slot.name,
        draftId: draft.id,
        constraints: draft.meta?.constraints,
        selectors: draft.meta?.selectors?.[slot.name?.toLowerCase()] || null,
      });
      toast({
        title: "Suggestions queued",
        description: `${slot.name} will be populated soon.`,
      });
      return;
    }

    if (type === "decideSlot") {
      openDecider({ focus: { day: day.date, slot: slot.name } });
      return;
    }

    if (type === "replaceItem") {
      const sims = (await findSimilar?.(item?.ref || item?.title)) || [];
      if (sims.length) {
        next.days[dayIdx].slots[slotIdx].items = [
          {
            type: "recipe",
            ref: sims[0].id,
            title: sims[0].title,
            quantity: 1,
          },
        ];
        write();
        toast({
          title: "Swapped",
          description: `Replaced with ${sims[0].title}`,
          action: (
            <Button size="sm" variant="outline" onClick={restorePrev}>
              Undo
            </Button>
          ),
        });
      } else {
        await automation.invoke?.("mealplan.swapWithSimilar", {
          draftId: draft.id,
          day: day.date,
          slot: slot.name,
          item,
        });
        toast({
          title: "Swap queued",
          description: "An agent is finding a similar recipe.",
        });
      }
      return;
    }
  };

  // Empty state
  if (!draft) {
    return (
      <div
        className={cx(
          "grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4",
          className
        )}
      >
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Meal Plan
                {sabbathAware && (
                  <Badge variant="secondary">Sabbath-aware</Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                No active plan draft. Choose a template, import recipes, or let
                the Decider get you started.
              </p>
              <div className="flex flex-wrap gap-2">
                <MealTemplatePicker triggerLabel="Plan Templates" />
                <Button
                  variant="outline"
                  onClick={() =>
                    eventBus.emit("ui.open", { id: "MealPlanEditor" })
                  }
                >
                  Create Manually
                </Button>
                <Button variant="secondary" onClick={openCollector}>
                  Collect Recipes
                </Button>
                <Button onClick={() => openDecider()}>Decide for me</Button>
                <Button variant="ghost" onClick={openPinterestWizard}>
                  Import Board
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
        <MealPlanNutritiionPeek />
      </div>
    );
  }

  const templateBadge = draft?.meta?.templateId || draft?.templateId || "";
  const planTitle = draft?.meta?.name || "Meal Plan Draft";
  const subtitle =
    draft?.meta?.summary || "Edit, autofill, and commit to calendar.";

  return (
    <div
      className={cx(
        "grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4",
        className
      )}
    >
      {/* LEFT: Plan */}
      <div className="space-y-3">
        {/* Header */}
        <Card className="sticky top-0 z-10">
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  {planTitle}
                  {templateBadge ? (
                    <Badge variant="outline">{templateBadge}</Badge>
                  ) : null}
                  {autoManualLabel ? <Badge>{autoManualLabel}</Badge> : null}
                  {sabbathAware && (
                    <Badge variant="secondary">Sabbath-aware</Badge>
                  )}
                </CardTitle>
                <div className="text-xs text-muted-foreground mt-1">
                  {subtitle}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  placeholder="Search days, slots, recipes…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 w-48"
                />
                <MealTemplatePicker triggerLabel="Templates" />
                <Button size="sm" variant="outline" onClick={openCollector}>
                  Collect
                </Button>
                <Button size="sm" onClick={() => openDecider()}>
                  Decide for me
                </Button>
                <Button size="sm" variant="ghost" onClick={openPinterestWizard}>
                  Import Board
                </Button>
                <Button size="sm" onClick={openEditor} variant="outline">
                  Open Editor
                </Button>
                <Button size="sm" onClick={autofill} disabled={loading}>
                  Autofill
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="secondary">
                      More
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuLabel>Plan</DropdownMenuLabel>
                    <DropdownMenuItem onClick={commitPlan}>
                      Save / Commit
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={exportPlan}>
                      Export
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={sharePlan}>
                      Share
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={clearPlan}
                      className="text-rose-600"
                    >
                      Clear All
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </CardHeader>
          <Separator />
          <div className="px-6 py-2">
            <Tabs value={view} onValueChange={setView} className="w-full">
              <TabsList>
                <TabsTrigger value="day">Day</TabsTrigger>
                <TabsTrigger value="week">Week</TabsTrigger>
                <TabsTrigger value="plan">Plan</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </Card>

        {/* Content */}
        <Tabs value={view} onValueChange={setView}>
          <TabsContent value="day" className="space-y-4">
            {filteredDays.slice(0, 1).map((d) => (
              <DayRow key={d.date} day={d} onSlotAction={onSlotAction} />
            ))}
          </TabsContent>

          <TabsContent value="week" className="space-y-4">
            {filteredDays.slice(0, 7).map((d) => (
              <DayRow key={d.date} day={d} onSlotAction={onSlotAction} />
            ))}
          </TabsContent>

          <TabsContent value="plan" className="space-y-4">
            {filteredDays.map((d) => (
              <DayRow key={d.date} day={d} onSlotAction={onSlotAction} />
            ))}
          </TabsContent>
        </Tabs>

        {/* Footer actions / Next Best Action */}
        <Card>
          <CardContent className="py-3 flex flex-wrap items-center gap-2">
            <div className="text-xs text-muted-foreground">
              Next best actions adapt as nutrition and inventory change.
            </div>
            <Button
              size="sm"
              onClick={() =>
                eventBus.emit("nutrition.suggestSwap", {
                  scope: { type: "plan", id: draft.id },
                })
              }
            >
              Suggest Nutrition Swaps
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                eventBus.emit("ui.open", {
                  id: "ShoppingChecklistGenerator",
                  params: { draftId: draft.id },
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
                  id: "BatchSessionPlanner",
                  params: { draftId: draft.id },
                })
              }
            >
              Build Batch Session
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => openDecider({ mode: "fill-open-dinners" })}
            >
              Fill Open Dinners via Decider
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* RIGHT: Nutrition Peek */}
      <MealPlanNutritiionPeek />
    </div>
  );
}
