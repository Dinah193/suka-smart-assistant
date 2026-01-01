// src/components/garden/HarvestLogger.jsx
/**
 * HarvestLogger
 *
 * DOMAIN ROLE (WEB OF MEANING):
 * - Garden → the field/bed where the yield comes from.
 * - Storehouse / Provisioning → where the yield is sent (fresh, preserved, shared).
 * - Feasts / Meal planning → concentrated use windows (feast cycles, batch cooking).
 *
 * TOOL MODE:
 * - Can run by itself with local-only state.
 * - Accepts props and just calls `onLogHarvest` if provided.
 *
 * STEWARDSHIP MODE:
 * - Emits richer events to `eventBus` so:
 *   - storehouse views can show “incoming yield”,
 *   - preservation tools can suggest canning/freezing sessions,
 *   - feast planners can see what’s available for upcoming seasons.
 *
 * EVENTS:
 * - garden.harvest.logged
 *   Fired on every submit with harvestPayload.
 *
 * - storehouse.provision.incoming (stewardshipMode only)
 *   Fired when a harvest is marked for storehouse/preservation.
 *
 * TODO[cycles]:
 * - Attach a cycle/season key from a cycles engine:
 *   e.g., "Spring-Planting-5786" or "Fall-Feast-Week-1".
 *
 * TODO[insights]:
 * - Route harvest history through intelligence:
 *   - suggest future planting based on household usage,
 *   - flag over/under-planting across seasons.
 */

import React, { useState } from "react";
import { classNames as cx } from "@/utils/css";
import { eventBus } from "@/services/events/eventBus";
import { automation } from "@/services/automation/runtime";

// Optional hooks (works fine without them)
let useGardenStore, useInventoryStore;
try {
  useGardenStore = require("@/store/GardenStore").useGardenStore;
} catch {}
try {
  useInventoryStore = require("@/store/InventoryStore").useInventoryStore;
} catch {}

export default function HarvestLogger({
  stewardshipMode = false,
  seasonContext = null,     // { seasonKey?, feastKey?, dayLabel? }
  defaultUnit = "lb",
  onLogHarvest,             // (harvestPayload) => void
  onSyncToStorehouse,       // (harvestPayload) => void
}) {
  const gardenStore = useGardenStore?.();
  const inventoryStore = useInventoryStore?.();

  const [cropName, setCropName] = useState("");
  const [bedLabel, setBedLabel] = useState("");
  const [harvestDate, setHarvestDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [cycleLabel, setCycleLabel] = useState(seasonContext?.seasonKey || "");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState(defaultUnit);
  const [grade, setGrade] = useState("household");
  const [destFresh, setDestFresh] = useState(true);
  const [destPreserve, setDestPreserve] = useState(false);
  const [destShare, setDestShare] = useState(false);
  const [destAnimals, setDestAnimals] = useState(false);
  const [notes, setNotes] = useState("");
  const [pending, setPending] = useState(false);

  const modeContext = stewardshipMode ? "stewardship" : "tool";

  function resetForm() {
    setCropName("");
    setBedLabel("");
    setAmount("");
    setUnit(defaultUnit);
    setGrade("household");
    setDestFresh(true);
    setDestPreserve(false);
    setDestShare(false);
    setDestAnimals(false);
    setNotes("");
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!cropName || !amount) return;

    const qty = Number(amount) || 0;
    const harvestPayload = {
      cropName: cropName.trim(),
      bedLabel: bedLabel.trim() || null,
      harvestDate,
      cycleLabel: cycleLabel || null,
      seasonContext: seasonContext || null,
      qty,
      unit,
      grade,
      destinations: {
        freshMeals: destFresh,
        preserveStorehouse: destPreserve,
        shareMutualAid: destShare,
        compostAnimals: destAnimals,
      },
      notes: notes.trim() || null,
      modeContext,
      createdAt: new Date().toISOString(),
    };

    setPending(true);
    try {
      // TOOL MODE: inform parent first
      onLogHarvest?.(harvestPayload);

      // Optional garden store integration
      try {
        gardenStore?.logHarvest?.(harvestPayload);
      } catch {}

      // Emit base garden event
      eventBus?.emit?.("garden.harvest.logged", harvestPayload);

      // STEWARDSHIP hooks: storehouse + inventory + intelligence
      if (stewardshipMode) {
        if (destPreserve || destFresh || destShare) {
          const provisionEvent = {
            kind: "harvest",
            sourceDomain: "garden",
            cropName: harvestPayload.cropName,
            qty,
            unit,
            grade,
            destinations: harvestPayload.destinations,
            harvestDate,
            seasonContext,
          };

          eventBus?.emit?.("storehouse.provision.incoming", provisionEvent);
          onSyncToStorehouse?.(provisionEvent);

          // Optional inventory/storehouse write-through
          try {
            // Simple optimistic add as a placeholder.
            // TODO[storehouse]:
            // Replace with a structured "incoming lot" entry that can be
            // claimed by preservation or meal-planning flows.
            inventoryStore?.addIncomingHarvest?.(provisionEvent);
          } catch {}
        }

        // TODO[intel]:
        // Hook into intelligence routes for yield tracking & suggestions:
        // await automation?.("intelligence.garden.harvest.logged", {
        //   harvest: harvestPayload,
        // });
      }
    } finally {
      setPending(false);
      resetForm();
    }
  }

  return (
    <div className="rounded-2xl border border-base-200 bg-base-100 shadow-md">
      {/* Header */}
      <div className="px-4 pt-4 pb-2 border-b border-base-200 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold uppercase tracking-wide text-base-content/70">
            Harvest Log
          </div>
          <div className="text-xs text-base-content/70">
            Capture today&apos;s yield and tell SSA where it should flow:
            fresh meals, storehouse, mutual aid, or animals/compost.
          </div>
        </div>
        {seasonContext && (
          <div className="text-right text-[11px] text-base-content/60 space-y-1">
            {seasonContext.seasonKey && (
              <div className="px-2 py-1 rounded-full bg-base-200 inline-block">
                Season: {seasonContext.seasonKey}
              </div>
            )}
            {seasonContext.feastKey && (
              <div className="px-2 py-1 rounded-full bg-base-200 inline-block ml-1">
                Feast cycle: {seasonContext.feastKey}
              </div>
            )}
            {seasonContext.dayLabel && (
              <div className="block mt-1">{seasonContext.dayLabel}</div>
            )}
          </div>
        )}
      </div>

      {/* Form */}
      <form onSubmit={handleSubmit} className="p-4 space-y-4 text-xs">
        {/* Row 1: Crop, bed, date */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="label py-0">
              <span className="label-text text-xs">Crop / plant</span>
            </label>
            <input
              className="input input-bordered input-sm w-full"
              placeholder="e.g., collards, tomatoes, okra…"
              value={cropName}
              onChange={(e) => setCropName(e.target.value)}
            />
          </div>

          <div>
            <label className="label py-0">
              <span className="label-text text-xs">Bed / row label (optional)</span>
            </label>
            <input
              className="input input-bordered input-sm w-full"
              placeholder="e.g., Bed A, East row"
              value={bedLabel}
              onChange={(e) => setBedLabel(e.target.value)}
            />
          </div>

          <div>
            <label className="label py-0">
              <span className="label-text text-xs">Harvest date</span>
            </label>
            <input
              type="date"
              className="input input-bordered input-sm w-full"
              value={harvestDate}
              onChange={(e) => setHarvestDate(e.target.value)}
            />
          </div>
        </div>

        {/* Row 2: Quantity & cycle label */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="label py-0">
                <span className="label-text text-xs">Amount harvested</span>
              </label>
              <input
                className="input input-bordered input-sm w-full"
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.0"
              />
            </div>
            <div>
              <label className="label py-0">
                <span className="label-text text-xs">Unit</span>
              </label>
              <select
                className="select select-bordered select-sm"
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
              >
                <option value="lb">lb</option>
                <option value="kg">kg</option>
                <option value="bunch">bunch</option>
                <option value="ea">each</option>
                <option value="basket">basket</option>
              </select>
            </div>
          </div>

          <div>
            <label className="label py-0">
              <span className="label-text text-xs">Grade / quality</span>
            </label>
            <select
              className="select select-bordered select-sm w-full"
              value={grade}
              onChange={(e) => setGrade(e.target.value)}
            >
              <option value="market">Market quality (top)</option>
              <option value="household">Household table (good)</option>
              <option value="processing">Good for processing/preserving</option>
              <option value="feed">Feed / compost only</option>
            </select>
          </div>

          <div>
            <label className="label py-0">
              <span className="label-text text-xs">
                Cycle label (optional)
              </span>
            </label>
            <input
              className="input input-bordered input-sm w-full"
              placeholder="e.g., Spring greens cycle, Feast prep week 1…"
              value={cycleLabel}
              onChange={(e) => setCycleLabel(e.target.value)}
            />
            <p className="text-[10px] text-base-content/60 mt-1">
              Helps SSA tie this yield into your broader garden and feast rhythm.
            </p>
          </div>
        </div>

        {/* Destinations */}
        <div className="border border-base-200 rounded-xl p-3 space-y-2 bg-base-100/60">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-base-content/70">
            Where should this yield flow?
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="checkbox checkbox-xs mt-0.5"
                checked={destFresh}
                onChange={(e) => setDestFresh(e.target.checked)}
              />
              <span className="text-xs">
                <span className="font-semibold">Fresh meals this week</span>
                <br />
                <span className="text-[11px] text-base-content/60">
                  Mark for near-term meals; SSA can nudge meal planning to use it while it&apos;s at its best.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="checkbox checkbox-xs mt-0.5"
                checked={destPreserve}
                onChange={(e) => setDestPreserve(e.target.checked)}
              />
              <span className="text-xs">
                <span className="font-semibold">Preserve &amp; storehouse</span>
                <br />
                <span className="text-[11px] text-base-content/60">
                  Mark as headed to canning, freezing, drying, or curing so your storehouse records stay honest.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="checkbox checkbox-xs mt-0.5"
                checked={destShare}
                onChange={(e) => setDestShare(e.target.checked)}
              />
              <span className="text-xs">
                <span className="font-semibold">Share / mutual aid</span>
                <br />
                <span className="text-[11px] text-base-content/60">
                  Mark how much is set aside for neighbors, family, or community table.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="checkbox checkbox-xs mt-0.5"
                checked={destAnimals}
                onChange={(e) => setDestAnimals(e.target.checked)}
              />
              <span className="text-xs">
                <span className="font-semibold">Animals / compost</span>
                <br />
                <span className="text-[11px] text-base-content/60">
                  Trace what flows back to animals or compost so the garden → animals → soil cycle stays visible.
                </span>
              </span>
            </label>
          </div>
        </div>

        {/* Notes */}
        <div>
          <label className="label py-0">
            <span className="label-text text-xs">Observation notes (optional)</span>
          </label>
          <textarea
            className="textarea textarea-bordered textarea-xs w-full"
            rows={2}
            placeholder="e.g., first harvest from this bed, pest damage, weather notes…"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between pt-1">
          <div className="text-[11px] text-base-content/60">
            SSA treats each harvest as a small story in your garden rhythm:
            what came in, when, and where it flowed.
          </div>
          <button
            type="submit"
            className={cx(
              "btn btn-primary btn-sm",
              pending && "btn-disabled"
            )}
            disabled={!cropName || !amount || pending}
          >
            {pending ? "Recording…" : "Record harvest & flow"}
          </button>
        </div>
      </form>
    </div>
  );
}
