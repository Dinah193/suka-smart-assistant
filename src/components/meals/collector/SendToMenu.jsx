// File: src/components/meals/collector/SendToMenu.jsx
// Purpose: Context-aware action menu to route selected items from the Collector
// into Suka modules (Grocery List, Inventory Mapping, Recipe Library, Batch Session,
// Meal Plan Draft, CSV export, Share, etc.), with alias-safe shims and automation hooks.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/* ------------------------------ Alias-safe shims ------------------------------ */
const softRequire = (id) => {
  try {
    const req = typeof require === "function" ? require : (0, eval)("require");
    return req ? req(id) : null;
  } catch {
    return null;
  }
};
const alias = (p) => "@" + "/" + p; // avoid static resolution by bundlers

/* ---------------------------------- Icons ----------------------------------- */
let Icons = softRequire("lucide-react") || {};
const mkIcon = (name) => (props) =>
  (
    <span
      aria-hidden
      className={props?.className || "inline-block w-4 h-4"}
      data-icon={name}
    />
  );
const {
  Send = mkIcon("Send"),
  Share2 = mkIcon("Share2"),
  ClipboardList = mkIcon("ClipboardList"),
  FileDown = mkIcon("FileDown"),
  CalendarDays = mkIcon("CalendarDays"),
  ListChecks = mkIcon("ListChecks"),
  ChefHat = mkIcon("ChefHat"),
  Boxes = mkIcon("Boxes"),
  Library = mkIcon("Library"),
  Sparkles = mkIcon("Sparkles"),
  ShoppingCart = mkIcon("ShoppingCart"),
  ExternalLink = mkIcon("ExternalLink"),
  X = mkIcon("X"),
} = Icons;

/* ------------------------------- Integrations -------------------------------- */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const mod = softRequire(alias("services/events/eventBus"));
  if (mod?.eventBus) eventBus = mod.eventBus;
} catch {}

let automation = null;
try {
  const mod = softRequire(alias("services/automation/runtime"));
  automation = mod?.automation || null;
} catch {}

// Optional stores (graceful shims so preview/sandbox works)
let useMealPlanningStore = () => ({
  addToPlanDraft: () => {},
  requestDraft: () => {},
});
try {
  const mod = softRequire(alias("store/MealPlanningStore"));
  if (mod?.useMealPlanningStore)
    useMealPlanningStore = mod.useMealPlanningStore;
} catch {}

let useBatchQueue = () => ({ addRecipes: () => {}, startSession: () => {} });
try {
  const mod = softRequire(alias("features/batch/BatchQueueProvider"));
  if (mod?.useBatchQueue) useBatchQueue = mod.useBatchQueue;
} catch {}

let toast = { success: console.log, error: console.error, info: console.log };
try {
  const mod = softRequire("react-toastify");
  toast = mod?.toast || toast;
} catch {}

/* --------------------------------- Helpers ---------------------------------- */
const cap = (s = "") => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/* ------------------------------ Actions builder ------------------------------ */
export function useSendToActions({ mode = "ingredients", selected = [] }) {
  const ids = useMemo(
    () => selected.map((x) => x.id || x.key || x.raw || x.name),
    [selected]
  );
  const ingredients = mode === "ingredients" ? selected : [];
  const recipes = mode === "recipes" ? selected : [];

  const { addToPlanDraft, requestDraft } = useMealPlanningStore();
  const { addRecipes } = useBatchQueue();

  const actions = useMemo(() => {
    const list = [];

    if (mode === "ingredients") {
      // Smart action (if automation exists)
      if (automation?.runTemplate) {
        list.push({
          id: "smart-grocery",
          label: "Smart Grocery (AI)",
          hint: "Normalize → group → add to aisles",
          icon: <Sparkles className="w-4 h-4" />,
          run: async () => {
            const res = await automation.runTemplate(
              "grocery.smart.normalize",
              { ingredients }
            );
            eventBus.emit("grocery.smart.applied", { res });
            toast.success("Smart grocery updated");
          },
        });
      }

      list.push(
        {
          id: "to-grocery",
          label: "Grocery List",
          hint: "Add items to GroceryListPanel",
          icon: <ShoppingCart className="w-4 h-4" />,
          run: async () => {
            eventBus.emit("grocery.items.add.requested", {
              items: ingredients,
            });
            if (automation?.runTemplate) {
              await automation.runTemplate("grocery.from.ingredients", {
                ingredients,
              });
            }
            toast.success(`Added ${ingredients.length} to grocery list`);
          },
        },
        {
          id: "to-inventory-map",
          label: "Map to Inventory",
          hint: "Open Ingredient Mapping",
          icon: <Boxes className="w-4 h-4" />,
          run: async () => {
            // Your IngredientMappingModal listens for this to open with rows:
            eventBus.emit("meals.ingredients.mapping.open", {
              rows: ingredients,
            });
            toast.info("Opening Ingredient Mapping…");
          },
        },
        {
          id: "to-plan-draft",
          label: "Plan Draft (Meals)",
          hint: "Send ingredients to meal plan draft",
          icon: <CalendarDays className="w-4 h-4" />,
          run: async () => {
            addToPlanDraft?.(ingredients);
            eventBus.emit("mealplan.draft.requested", {
              from: "collector",
              count: ingredients.length,
            });
            if (automation?.runTemplate) {
              await automation.runTemplate("mealplan.draft.generate", {
                ingredients,
              });
            }
            toast.success("Draft updated");
          },
        }
      );
    }

    if (mode === "recipes") {
      list.push(
        {
          id: "to-recipe-library",
          label: "Save to Recipe Library",
          hint: "Store recipes for later",
          icon: <Library className="w-4 h-4" />,
          run: async () => {
            eventBus.emit("recipes.library.save.requested", { ids, recipes });
            if (automation?.runTemplate) {
              await automation.runTemplate("recipes.library.save", { recipes });
            }
            toast.success(`Saved ${recipes.length} to library`);
          },
        },
        {
          id: "to-batch-session",
          label: "Add to Batch Session",
          hint: "Queue in Batch Session Planner",
          icon: <ChefHat className="w-4 h-4" />,
          run: async () => {
            addRecipes?.(recipes);
            eventBus.emit("batch.queue.recipes.added", {
              ids,
              count: recipes.length,
            });
            toast.success(`Queued ${recipes.length} recipes`);
          },
        },
        {
          id: "to-mealplan",
          label: "Schedule Recipes",
          hint: "Push into meal plan draft",
          icon: <CalendarDays className="w-4 h-4" />,
          run: async () => {
            requestDraft?.({ recipes });
            eventBus.emit("mealplan.draft.requested", {
              from: "collector",
              recipes: ids,
            });
            if (automation?.runTemplate) {
              await automation.runTemplate("mealplan.draft.fromRecipes", {
                recipes,
              });
            }
            toast.success("Meal plan draft requested");
          },
        }
      );
    }

    // Universal utilities
    list.push(
      {
        id: "to-clipboard",
        label: "Copy to Clipboard",
        icon: <ClipboardList className="w-4 h-4" />,
        run: async () => {
          const text = selected
            .map((x) => x.raw || x.title || x.name)
            .join("\n");
          await navigator.clipboard?.writeText(text);
          toast.success("Copied");
        },
      },
      {
        id: "export",
        label: "Export (CSV)",
        icon: <FileDown className="w-4 h-4" />,
        run: async () => {
          const rows = selected.map((x) => ({
            key: x.id || x.key || x.raw,
            name: x.name || x.raw || x.title,
          }));
          const csv = [
            "key,name",
            ...rows.map(
              (r) => `${JSON.stringify(r.key)},${JSON.stringify(r.name)}`
            ),
          ].join("\n");
          const blob = new Blob([csv], { type: "text/csv" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `collector_export_${Date.now()}.csv`;
          a.click();
          URL.revokeObjectURL(url);
          toast.success("Exported CSV");
        },
      },
      {
        id: "share",
        label: "Share…",
        icon: <Share2 className="w-4 h-4" />,
        run: async () => {
          const text = selected
            .map((x) => x.raw || x.title || x.name)
            .join("\n");
          if (navigator.share) {
            await navigator.share({ text, title: "Suka Collector" });
          } else {
            await navigator.clipboard?.writeText(text);
            toast.info("No Web Share — copied instead");
          }
        },
      }
    );

    return list;
  }, [mode, selected, automation, addToPlanDraft, requestDraft, addRecipes]);

  return { actions };
}

/* -------------------------------- Component --------------------------------- */
export default function SendToMenu({
  mode = "ingredients",
  selected = [],
  align = "right", // "left" | "right"
  onAction,
  onClose,
  buttonClassName = "",
  size = "md", // "sm" | "md" | "lg"
  label = "Send to…",
}) {
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const [open, setOpen] = useState(false);
  const { actions } = useSendToActions({ mode, selected });

  const width =
    size === "sm"
      ? "max-w-[280px]"
      : size === "lg"
      ? "max-w-[420px]"
      : "max-w-[360px]";

  const show = () => setOpen(true);
  const hide = useCallback(() => {
    setOpen(false);
    onClose?.();
  }, [onClose]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target)) hide();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, hide]);

  // Keyboard controls
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") hide();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        hide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hide]);

  const handle = async (a) => {
    await a.run?.();
    onAction?.(a);
    hide();
  };

  return (
    <div className="relative inline-block" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={
          "inline-flex items-center gap-2 px-3 py-1.5 rounded-md border bg-white hover:bg-gray-50 " +
          buttonClassName
        }
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Send className="w-4 h-4" />
        <span>{label}</span>
      </button>

      {open && (
        <div
          className={`absolute ${
            align === "right" ? "right-0" : "left-0"
          } mt-2 z-[70] w-[92vw] ${width}`}
        >
          <div className="rounded-lg border bg-white shadow-xl overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b bg-gray-50">
              <div className="text-sm font-medium">Choose destination</div>
              <button
                className="p-1 rounded hover:bg-gray-100"
                onClick={hide}
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <ul role="menu" className="max-h-[60vh] overflow-auto py-1">
              {actions.map((a) => (
                <li key={a.id} role="menuitem">
                  <button
                    onClick={() => handle(a)}
                    className="w-full flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-indigo-50"
                    title={a.hint || a.label}
                  >
                    <span className="flex items-center gap-2">
                      {a.icon}
                      <span>{a.label}</span>
                    </span>
                    <ExternalLink className="w-4 h-4 opacity-50" />
                  </button>
                </li>
              ))}
              {actions.length === 0 && (
                <li className="px-3 py-4 text-sm text-gray-500">
                  No actions available for this selection.
                </li>
              )}
            </ul>

            <div className="px-3 py-2 border-t text-[11px] text-gray-500 flex items-center justify-between">
              <span>
                Tip:{" "}
                <kbd className="px-1.5 py-0.5 border rounded bg-white">Esc</kbd>{" "}
                closes ·{" "}
                <kbd className="px-1.5 py-0.5 border rounded bg-white">
                  Ctrl/⌘
                </kbd>{" "}
                + <kbd className="px-1.5 py-0.5 border rounded bg-white">K</kbd>{" "}
                hides
              </span>
              <span className="hidden md:inline">
                Actions adapt to <em>{cap(mode)}</em> selection
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------- Usage Notes ---------------------------------
Toolbar in Collector:
  <SendToMenu
    mode="ingredients"             // or "recipes"
    selected={selectedRows}        // array of selected items
    onAction={(a) => console.log('ran', a.id)}
    size="md"                      // "sm" | "md" | "lg"
    align="right"                  // "left" | "right"
  />

Signals emitted:
  - grocery.items.add.requested        { items }
  - meals.ingredients.mapping.open     { rows }
  - mealplan.draft.requested           { from, ... }
  - batch.queue.recipes.added          { ids, count }
  - grocery.smart.applied              { res }           (if automation available)

Automation templates (optional):
  - grocery.smart.normalize
  - grocery.from.ingredients
  - mealplan.draft.generate
  - mealplan.draft.fromRecipes
  - recipes.library.save

The menu is intentionally narrow and feels like a modern popup.
------------------------------------------------------------------------------- */
