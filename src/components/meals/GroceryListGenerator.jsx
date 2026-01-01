// src/components/meals/GroceryListGenerator.jsx
/**
 * GroceryListGenerator
 *
 * DOMAIN ROLE (WEB OF MEANING):
 * - Primary domains:
 *   - cooking/meals  → recipes and batch cycles that create demand
 *   - storehouse     → what the household already holds in reserve
 *   - provisioning   → grocery trips / orders that refill the storehouse
 *
 * - Connected domains:
 *   - feasts/events  → feast cycles that create concentrated demand spikes
 *   - preservation   → extra purchases for canning/freezing/drying
 *
 * CONCEPT:
 * - Turn a provision list (usually from ShoppingListGenerator) or a set of
 *   recipes into a **trip-ready grocery list** grouped by store section
 *   so the householder can move through the store efficiently.
 *
 * TOOL MODE:
 * - Works with local props only:
 *   - `provisionItems` OR `recipes` may be passed directly.
 *   - No dependency on automation, storehouse, or external services.
 *
 * STEWARDSHIP MODE:
 * - When `stewardshipMode` is true, this component:
 *   - Emits richer events on the `eventBus` so other domains can react.
 *   - Can optionally call automation routes to:
 *     - log provision runs,
 *     - send the list to SMS/email,
 *     - sync with any “household run” log.
 *
 * EVENTS:
 * - groceryList.generated
 *   - Fired whenever the grocery/provision list is re-built.
 * - groceryList.shared
 *   - Fired when the list is sent to mobile/email or copied for sharing.
 * - groceryList.printed
 *   - Fired when the user opens a print-friendly view.
 *
 * TODO[seasons]:
 * - Attach seasonContext / feastContext so that:
 *   - recurring feast cycles can be recognized by the intelligence layer.
 *   - storehouse insights can learn which provisions spike before feasts.
 *
 * TODO[insights]:
 * - Use an intelligence route to:
 *   - suggest bulk staples that would stabilize the storehouse over several
 *     cycles (e.g., “buy 10 lb bag of rice instead of 2 lb”).
 */

import React, { useEffect, useMemo, useState } from "react";
import { classNames as cx } from "@/utils/css";
import { eventBus } from "@/services/events/eventBus";
import { automation } from "@/services/automation/runtime";

// A provision item from ShoppingListGenerator looks like:
// {
//   name,
//   unit,
//   neededQty,
//   coverage: { status, onHandQty, shortfallQty },
//   recipeIds: Set,
//   recipeTitles: Set,
// }
export default function GroceryListGenerator({
  provisionItems = [],     // preferred: from ShoppingListGenerator
  recipes = [],            // fallback: raw recipes if provisionItems not supplied
  stewardshipMode = false,
  seasonContext = null,    // { seasonKey?, feastKey?, dayLabel? }
  sessionId = null,        // batch / feast / meal-cycle session id
  onListGenerated,         // (groceryList) => void
  onSendToMobile,          // optional bridge: (payload) => void
  onSendToEmail,           // optional bridge: (payload) => void
}) {
  const [showCovered, setShowCovered] = useState(false);
  const [groupBySection, setGroupBySection] = useState(true);
  const [listNote, setListNote] = useState("");
  const [sending, setSending] = useState(false);

  const modeContext = stewardshipMode ? "stewardship" : "tool";

  // ---------------- Build grocery items from inputs --------------------

  const baseItems = useMemo(() => {
    if (Array.isArray(provisionItems) && provisionItems.length) {
      // Use shortfall if present, otherwise full needed quantity.
      return provisionItems.map((row) => {
        const shortfall = Number(row.coverage?.shortfallQty ?? 0);
        const qty =
          shortfall > 0
            ? shortfall
            : Number(row.neededQty ?? 0) || 0;

        return {
          key: row.key || `${row.name.toLowerCase()}::${row.unit || "ea"}`,
          name: row.name,
          unit: row.unit || "ea",
          qty,
          fullNeededQty: Number(row.neededQty ?? qty) || qty,
          recipeTitles: Array.from(row.recipeTitles || []),
          coverageStatus: row.coverage?.status || "unknown",
        };
      });
    }

    // Fallback: aggregate from recipes directly (TOOL MODE is enough here)
    const map = new Map();

    for (const recipe of recipes || []) {
      const title = recipe?.title || "Untitled dish";
      const rid = recipe?.id || title;
      const ings = Array.isArray(recipe.ingredients)
        ? recipe.ingredients
        : [];

      for (const ing of ings) {
        const rawName = (ing.name || "").trim();
        if (!rawName) continue;

        const name = rawName.toLowerCase();
        const unit = (ing.unit || "ea").toLowerCase();
        const key = `${name}::${unit}`;
        const qty = Number(ing.qty ?? ing.quantity ?? 0) || 0;

        if (!map.has(key)) {
          map.set(key, {
            key,
            name: capitalize(rawName),
            unit,
            qty: 0,
            fullNeededQty: 0,
            recipeTitles: new Set(),
            recipeIds: new Set(),
            coverageStatus: "unknown",
          });
        }

        const row = map.get(key);
        row.qty += qty;
        row.fullNeededQty += qty;
        row.recipeTitles.add(title);
        row.recipeIds.add(rid);
      }
    }

    return Array.from(map.values()).map((row) => ({
      ...row,
      recipeTitles: Array.from(row.recipeTitles),
    }));
  }, [JSON.stringify(provisionItems), JSON.stringify(recipes)]);

  const groceryList = useMemo(() => {
    // 1) Filter by coverage if we came from provision items
    let rows = [...baseItems];

    if (!showCovered && provisionItems.length) {
      rows = rows.filter((row) =>
        row.coverageStatus === "missing" || row.coverageStatus === "partial"
      );
    }

    // 2) Attach store section classifications
    rows = rows.map((row) => ({
      ...row,
      section: categorizeItem(row.name),
    }));

    // 3) Sort by section then name
    rows.sort((a, b) => {
      if (groupBySection) {
        const sa = a.section || "Other";
        const sb = b.section || "Other";
        if (sa !== sb) return sa.localeCompare(sb);
      }
      return a.name.localeCompare(b.name);
    });

    return rows;
  }, [baseItems, showCovered, groupBySection, provisionItems.length]);

  const groupedBySection = useMemo(() => {
    if (!groupBySection) return null;
    const groups = new Map();
    for (const item of groceryList) {
      const sec = item.section || "Other";
      if (!groups.has(sec)) groups.set(sec, []);
      groups.get(sec).push(item);
    }
    return groups;
  }, [groceryList, groupBySection]);

  const stats = useMemo(
    () => summarizeGroceryList(groceryList),
    [groceryList]
  );

  // ---------------- Emit updates to parent + eventBus -----------------

  useEffect(() => {
    if (onListGenerated) onListGenerated(groceryList);

    eventBus?.emit?.("groceryList.generated", {
      context: modeContext,
      sessionId,
      seasonContext,
      itemCount: groceryList.length,
      stats,
    });

    // TODO[intel]:
    // automation?.("intelligence.storehouse.groceryList.generated", {
    //   context: modeContext,
    //   sessionId,
    //   seasonContext,
    //   itemCount: groceryList.length,
    //   stats,
    //   note: listNote || null,
    // });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(groceryList), modeContext, sessionId, JSON.stringify(seasonContext)]);

  // ---------------- Actions: copy, print, send ------------------------

  function copyToClipboard() {
    const text = renderPlainTextList(groceryList, { groupBySection, listNote });
    navigator.clipboard?.writeText?.(text).catch(() => {});
    eventBus?.emit?.("groceryList.shared", {
      context: modeContext,
      method: "clipboard",
      sessionId,
      itemCount: groceryList.length,
    });
  }

  function printList() {
    const text = renderPlainTextList(groceryList, { groupBySection, listNote });
    const win = window.open("", "_blank", "width=600,height=800");
    if (!win) return;
    win.document.write("<pre style='font-family: system-ui, sans-serif; white-space: pre-wrap;'>" +
      escapeHtml(text) +
      "</pre>");
    win.document.close();
    win.focus();
    win.print?.();

    eventBus?.emit?.("groceryList.printed", {
      context: modeContext,
      sessionId,
      itemCount: groceryList.length,
    });
  }

  async function handleSendToPhone() {
    if (!groceryList.length) return;
    const payload = {
      sessionId,
      seasonContext,
      note: listNote || undefined,
      text: renderPlainTextList(groceryList, { groupBySection, listNote }),
    };

    setSending(true);
    try {
      // Local callback (e.g., parent integration)
      onSendToMobile?.(payload);

      // Optional automation bridge
      // TODO: wire to your notification / SMS service
      // await automation?.("notifications.sms.sendList", payload);

      eventBus?.emit?.("groceryList.shared", {
        context: modeContext,
        method: "sms",
        sessionId,
        itemCount: groceryList.length,
      });
    } finally {
      setSending(false);
    }
  }

  async function handleSendToEmail() {
    if (!groceryList.length) return;
    const payload = {
      sessionId,
      seasonContext,
      note: listNote || undefined,
      text: renderPlainTextList(groceryList, { groupBySection, listNote }),
    };

    setSending(true);
    try {
      onSendToEmail?.(payload);

      // TODO: wire to your email/notification service
      // await automation?.("notifications.email.sendList", payload);

      eventBus?.emit?.("groceryList.shared", {
        context: modeContext,
        method: "email",
        sessionId,
        itemCount: groceryList.length,
      });
    } finally {
      setSending(false);
    }
  }

  // ---------------- Render --------------------------------------------

  const isEmpty = !groceryList.length;

  return (
    <div className="rounded-2xl border border-base-200 bg-base-100 shadow-md flex flex-col min-h-[260px]">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-base-200 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold uppercase tracking-wide text-base-content/70">
            Grocery Run (Provision List)
          </div>
          <div className="text-xs text-base-content/70 truncate">
            Grouped list of what needs to be brought in to support this meal or feast cycle.
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 text-[11px] text-base-content/70">
          <div className="flex items-center gap-2">
            <span className="px-2 py-1 rounded-full bg-base-200">
              {stats.totalItems} line items • {stats.totalQtyLabel}
            </span>
          </div>
          {seasonContext && (
            <div className="flex flex-wrap items-center justify-end gap-1">
              {seasonContext.feastKey && (
                <span className="px-2 py-1 rounded-full bg-base-200">
                  Feast cycle: {seasonContext.feastKey}
                </span>
              )}
              {seasonContext.dayLabel && (
                <span className="px-2 py-1 rounded-full bg-base-200">
                  {seasonContext.dayLabel}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="px-4 py-2 border-b border-base-200 flex flex-wrap items-center gap-3 text-xs">
        {provisionItems.length > 0 && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              className="checkbox checkbox-xs"
              checked={showCovered}
              onChange={(e) => setShowCovered(e.target.checked)}
            />
            <span>Include items already covered by the storehouse</span>
          </label>
        )}
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="checkbox checkbox-xs"
            checked={groupBySection}
            onChange={(e) => setGroupBySection(e.target.checked)}
          />
          <span>Group by store section</span>
        </label>

        <div className="ml-auto flex items-center gap-2">
          <button
            className="btn btn-ghost btn-xs"
            onClick={copyToClipboard}
            disabled={isEmpty}
          >
            Copy list
          </button>
          <button
            className="btn btn-ghost btn-xs"
            onClick={printList}
            disabled={isEmpty}
          >
            Print / Save PDF
          </button>
        </div>
      </div>

      {/* Note area */}
      <div className="px-4 py-2 border-b border-base-200">
        <textarea
          className="textarea textarea-bordered textarea-xs w-full"
          rows={2}
          placeholder="Optional note for this grocery run (e.g., store name, budget, person responsible)…"
          value={listNote}
          onChange={(e) => setListNote(e.target.value)}
        />
      </div>

      {/* Body */}
      <div className="flex-1 p-4 overflow-auto">
        {isEmpty ? (
          <EmptyGroceryList />
        ) : groupBySection && groupedBySection ? (
          Array.from(groupedBySection.entries()).map(([section, items]) => (
            <div key={section} className="mb-4 last:mb-0">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-base-content/60 mb-1">
                {section}
              </div>
              <ul className="space-y-1">
                {items.map((item) => (
                  <li
                    key={item.key}
                    className="flex items-start justify-between text-xs bg-base-200/50 rounded-lg px-2 py-1"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">
                        {item.qty || "—"} {item.unit}{" "}
                        <span className="font-normal">{item.name}</span>
                      </div>
                      {item.recipeTitles?.length > 0 && (
                        <div className="text-[11px] text-base-content/60 truncate">
                          For: {item.recipeTitles.join(" • ")}
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        ) : (
          <ul className="space-y-1">
            {groceryList.map((item) => (
              <li
                key={item.key}
                className="flex items-start justify-between text-xs bg-base-200/50 rounded-lg px-2 py-1"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium">
                    {item.qty || "—"} {item.unit}{" "}
                    <span className="font-normal">{item.name}</span>
                  </div>
                  {item.recipeTitles?.length > 0 && (
                    <div className="text-[11px] text-base-content/60 truncate">
                      For: {item.recipeTitles.join(" • ")}
                    </div>
                  )}
                </div>
                {groupBySection && (
                  <span className="text-[11px] text-base-content/60 ml-2 shrink-0">
                    {item.section}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer: sending */}
      <div className="px-4 py-3 border-t border-base-200 flex flex-wrap items-center gap-2 text-xs">
        <button
          className="btn btn-primary btn-xs"
          onClick={handleSendToPhone}
          disabled={isEmpty || sending}
        >
          {sending ? "Sending…" : "Send to my phone"}
        </button>
        <button
          className="btn btn-outline btn-xs"
          onClick={handleSendToEmail}
          disabled={isEmpty || sending}
        >
          {sending ? "Sending…" : "Send by email"}
        </button>
        <div className="ml-auto text-[11px] text-base-content/60">
          {sessionId ? (
            <>Linked to session: {sessionId}</>
          ) : (
            <>One-time grocery run (not linked to a stored cycle).</>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Empty state ------------------------------ */

function EmptyGroceryList() {
  return (
    <div className="rounded-xl border border-dashed border-base-300 p-6 text-center bg-base-100">
      <div className="text-sm font-semibold">
        No grocery run defined
      </div>
      <p className="text-xs text-base-content/70 mt-1 max-w-md mx-auto">
        Choose recipes or a batch session first. Once there is a provision list,
        this panel will shape it into a trip-ready grocery run.
      </p>
    </div>
  );
}

/* ------------------------------ Helpers: classification ------------------- */

function categorizeItem(name) {
  const n = (name || "").toLowerCase();

  if (!n) return "Other";

  if (includesAny(n, ["lettuce", "tomato", "onion", "pepper", "spinach", "greens", "cabbage", "okra", "carrot", "celery"])) {
    return "Produce";
  }
  if (includesAny(n, ["apple", "banana", "orange", "mango", "pineapple", "pear", "grape", "fruit"])) {
    return "Produce";
  }
  if (includesAny(n, ["beef", "chicken", "goat", "lamb", "turkey", "fish", "tilapia", "salmon"])) {
    return "Meat / Fish";
  }
  if (includesAny(n, ["milk", "cheese", "yogurt", "butter", "cream"])) {
    return "Dairy";
  }
  if (includesAny(n, ["rice", "pasta", "spaghetti", "noodle", "flour", "cornmeal", "grain", "oats"])) {
    return "Grains / Staples";
  }
  if (includesAny(n, ["oil", "olive oil", "vegetable oil", "palm oil", "shortening"])) {
    return "Oils / Fats";
  }
  if (includesAny(n, ["salt", "pepper", "spice", "seasoning", "curry", "bouillon", "herb", "ginger", "garlic"])) {
    return "Spices / Seasonings";
  }
  if (includesAny(n, ["sugar", "honey", "syrup", "sweetener"])) {
    return "Sweeteners";
  }
  if (includesAny(n, ["beans", "peas", "lentil", "chickpea"])) {
    return "Beans / Legumes";
  }
  if (includesAny(n, ["can", "canned", "tin"])) {
    return "Canned Goods";
  }

  return "Other";
}

function includesAny(str, needles) {
  return needles.some((needle) => str.includes(needle));
}

function summarizeGroceryList(rows) {
  const summary = {
    totalItems: rows.length,
    totalQtyLabel: "",
  };

  let totalUnits = 0;
  for (const row of rows) {
    totalUnits += Number(row.qty || 0);
  }
  if (totalUnits <= 0) {
    summary.totalQtyLabel = "quantities vary";
  } else if (totalUnits < 20) {
    summary.totalQtyLabel = `${totalUnits} units total (approx.)`;
  } else {
    summary.totalQtyLabel = `${totalUnits}+ units total (approx.)`;
  }

  return summary;
}

function renderPlainTextList(rows, { groupBySection, listNote }) {
  if (!rows.length) return "No items.";

  const lines = [];
  if (listNote) {
    lines.push(`Note: ${listNote}`);
    lines.push("");
  }

  if (!groupBySection) {
    for (const row of rows) {
      lines.push(formatLine(row));
    }
  } else {
    // Group by section in text form
    const groups = new Map();
    for (const row of rows) {
      const sec = row.section || "Other";
      if (!groups.has(sec)) groups.set(sec, []);
      groups.get(sec).push(row);
    }
    for (const [section, items] of groups.entries()) {
      lines.push(`[${section}]`);
      for (const row of items) {
        lines.push("• " + formatLine(row));
      }
      lines.push("");
    }
  }

  return lines.join("\n").trim();

  function formatLine(row) {
    const qtyPart = row.qty ? `${row.qty} ${row.unit}` : "";
    const base = qtyPart ? `${qtyPart} ${row.name}` : row.name;
    if (!row.recipeTitles || !row.recipeTitles.length) return base;
    return `${base}  — for: ${row.recipeTitles.join(" / ")}`;
  }
}

function capitalize(str) {
  const s = String(str || "").trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
