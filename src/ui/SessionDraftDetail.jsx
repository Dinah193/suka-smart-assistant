// C:\Users\larho\suka-smart-assistant\src\ui\SessionDraftDetail.jsx
//
// SessionDraftDetail
// ------------------
// Editor for Cooking Session Drafts (status: "draft").
// - Loads a draft by id (from window event or props)
// - Lets user edit: title, start, duration, recipes (station/tags/yield/packaging),
//   label template, safety timers
// - Live storage capacity hints & warnings
// - Save (clone-to-new draft) and optionally cancel old
// - Approve (and optionally schedule at time) -> Cooking.approveDraft(...) which
//   emits a calendar sync intent per CookingStore v3
//
// Open modal by dispatching:
//   window.dispatchEvent(new CustomEvent("ui:modal:open", { detail: { id: "SessionDraftDetail", sessionId } }))
//
// Dependencies (all optional, dynamic):
// - @/store/CookingStore.js (expects named export { Cooking } or default with same API)
//
// Notes:
// - We don't mutate drafts in place to keep the store simple. Editing -> Save creates
//   a **new** draft via createDraft(), then cancels the original.
// - If a schedule time is chosen directly from this modal, Approve passes it through.
// - TailwindCSS styling; no external UI libs.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------ Safe dynamic imports ------------------------ */
async function safeImport(paths = []) {
  for (const p of paths) {
    try {
      // @vite-ignore
      const mod = await import(p);
      return mod?.default || mod;
    } catch {}
  }
  return null;
}
async function CookingAPI() {
  const mod = await safeImport(["@/store/CookingStore.js", "@/store/CookingStore"]);
  return mod?.Cooking || mod;
}

/* ------------------------------ Utils -------------------------------- */
const mins = (n, fb = 90) => (Number.isFinite(+n) ? Math.max(0, Math.floor(+n)) : fb);
const toLocalInputValue = (iso) => {
  try {
    if (!iso) return "";
    const d = new Date(iso);
    // Convert to "YYYY-MM-DDTHH:MM" in local time
    const pad = (x) => String(x).padStart(2, "0");
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    return `${y}-${m}-${day}T${hh}:${mm}`;
  } catch { return ""; }
};
const fromLocalInputValue = (val) => {
  try { return val ? new Date(val).toISOString() : null; } catch { return null; }
};
const toQuarts = (amount, unit) => {
  const u = (unit || "").toLowerCase();
  const n = Number(amount || 0);
  if (u === "q" || u === "quart" || u === "quarts") return n;
  if (u === "cup" || u === "cups") return n / 4;
  if (u === "pt" || u === "pint" || u === "pints") return n / 2;
  if (u === "gal" || u === "gallon" || u === "gallons") return n * 4;
  return n; // fallback
};
const estimateStorage = (recipes=[]) => {
  const totalQ = recipes.reduce(
    (sum, r) => sum + toQuarts(r?.yieldUnit?.amount, r?.yieldUnit?.unit),
    0
  );
  return {
    fridgeQ: Math.round(totalQ * 0.6 * 10) / 10,
    freezerQ: Math.round(totalQ * 0.3 * 10) / 10,
    pantryQ: Math.round(totalQ * 0.1 * 10) / 10,
  };
};

/* -------------------------- Small UI bits ----------------------------- */
function Field({ label, children, help, className="" }) {
  return (
    <label className={`block ${className}`}>
      <div className="text-xs font-medium text-gray-700 mb-1">{label}</div>
      {children}
      {help ? <div className="text-[11px] text-gray-500 mt-1">{help}</div> : null}
    </label>
  );
}
function Pill({ children, tone="default" }) {
  const tones = {
    default: "bg-gray-100 text-gray-700",
    warn: "bg-amber-100 text-amber-800",
    ok: "bg-emerald-100 text-emerald-800",
    info: "bg-sky-100 text-sky-800",
  };
  return <span className={`px-2 py-0.5 text-xs rounded-full ${tones[tone]||tones.default}`}>{children}</span>;
}
function Divider() {
  return <hr className="my-4 border-gray-200" />;
}

/* --------------------------- Main component --------------------------- */
export default function SessionDraftDetail({
  open: openProp = false,
  sessionId: sessionIdProp = null,
  onClose,
}) {
  const [open, setOpen] = useState(!!openProp);
  const [sessionId, setSessionId] = useState(sessionIdProp);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Store context
  const [capacity, setCapacity] = useState(null); // { freezerQ, fridgeQ, pantryQ }

  // Form state
  const [title, setTitle] = useState("Draft Cooking Session");
  const [startIso, setStartIso] = useState(null);
  const [durationMin, setDurationMin] = useState(90);
  const [recipes, setRecipes] = useState([]); // [{title, station, allergens[], dietary[], yieldUnit{amount,unit}, packaging{containerSize,containerUnit}, packagingEstimate}]
  const [labelPrefix, setLabelPrefix] = useState("SVFH");
  const [labelDateFmt, setLabelDateFmt] = useState("YYYY-MM-DD");
  const [labelIngredients, setLabelIngredients] = useState("");
  const [hotHold, setHotHold] = useState("");     // mins
  const [chillTarget, setChillTarget] = useState(""); // F
  const [maxChillMins, setMaxChillMins] = useState(""); // mins

  const [scheduleDraftIso, setScheduleDraftIso] = useState(""); // optional scheduling at approve

  // Internal open sync + event hooks
  useEffect(() => setOpen(!!openProp), [openProp]);
  useEffect(() => setSessionId(sessionIdProp || null), [sessionIdProp]);

  useEffect(() => {
    const onOpen = (e) => {
      if (e?.detail?.id === "SessionDraftDetail") {
        setOpen(true);
        if (e.detail.sessionId) setSessionId(e.detail.sessionId);
      }
    };
    const onCloseEvt = (e) => {
      if (e?.detail?.id === "SessionDraftDetail") {
        setOpen(false);
        onClose?.();
      }
    };
    window.addEventListener("ui:modal:open", onOpen);
    window.addEventListener("ui:modal:close", onCloseEvt);
    return () => {
      window.removeEventListener("ui:modal:open", onOpen);
      window.removeEventListener("ui:modal:close", onCloseEvt);
    };
  }, [onClose]);

  /* ----------------------------- Load draft ----------------------------- */
  const loadDraft = useCallback(async (id) => {
    setError("");
    setLoading(true);
    try {
      const Cooking = await CookingAPI();
      if (!Cooking) throw new Error("Cooking store not available.");

      // Pull state and find draft by id
      const st = Cooking.state || (typeof Cooking.getState === "function" ? Cooking.getState() : null);
      setCapacity(st?.capacity || null);

      const sessions = st?.week?.sessions || [];
      const s = sessions.find((x) => x.id === id);
      if (!s) throw new Error("Draft not found.");

      // Populate form
      setTitle(s.title || "Draft Cooking Session");
      setStartIso(s.start || null);
      setDurationMin(() => {
        const dur =
          (new Date(s.end || s.start).getTime() - new Date(s.start || Date.now()).getTime()) / 60000;
        return mins(dur, 90);
      });
      setRecipes(Array.isArray(s.recipes) ? s.recipes : []);
      setLabelPrefix(s.labelTemplate?.prefix || "SVFH");
      setLabelDateFmt(s.labelTemplate?.dateFormat || "YYYY-MM-DD");
      setLabelIngredients(s.labelTemplate?.ingredientsLine || "");
      setHotHold(s.safetyTimers?.hotFillHoldMins ?? "");
      setChillTarget(s.safetyTimers?.chillTargetF ?? "");
      setMaxChillMins(s.safetyTimers?.maxChillMins ?? "");
      setScheduleDraftIso("");
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && sessionId) loadDraft(sessionId);
  }, [open, sessionId, loadDraft]);

  /* --------------------------- Derived values --------------------------- */
  const storageHints = useMemo(() => estimateStorage(recipes), [recipes]);
  const capWarning = useMemo(() => {
    if (!capacity) return null;
    const over = [];
    if (Number(storageHints.freezerQ || 0) > Number(capacity.freezerQ ?? Infinity)) over.push("freezer");
    if (Number(storageHints.fridgeQ || 0) > Number(capacity.fridgeQ ?? Infinity)) over.push("fridge");
    if (Number(storageHints.pantryQ || 0) > Number(capacity.pantryQ ?? Infinity)) over.push("pantry");
    return over.length ? `May exceed ${over.join(", ")} capacity` : null;
  }, [storageHints, capacity]);

  /* ------------------------------ Actions ------------------------------ */

  // Save = clone into a new draft; cancel old (optional)
  const handleSave = useCallback(async ({ cancelOld = false } = {}) => {
    setLoading(true);
    setError("");
    try {
      const Cooking = await CookingAPI();
      if (!Cooking?.createDraft) throw new Error("Cooking store missing createDraft().");

      const newId = await Cooking.createDraft({
        title: title || "Draft Cooking Session",
        start: startIso || new Date().toISOString(),
        durationMins: mins(durationMin, 90),
        recipes: recipes.map((r) => ({
          id: r.id,
          title: r.title || "Untitled",
          station: r.station || "prep",
          allergens: Array.isArray(r.allergens) ? r.allergens : [],
          dietary: Array.isArray(r.dietary) ? r.dietary : [],
          yieldUnit: { amount: Number(r?.yieldUnit?.amount || 0), unit: r?.yieldUnit?.unit || "cups" },
          packaging: {
            containerSize: Number(r?.packaging?.containerSize || 1),
            containerUnit: r?.packaging?.containerUnit || "cups",
          },
        })),
        labelTemplate: {
          prefix: labelPrefix || "SVFH",
          dateFormat: labelDateFmt || "YYYY-MM-DD",
          ingredientsLine: labelIngredients || "",
        },
        safetyTimers: {
          hotFillHoldMins: hotHold ? Number(hotHold) : undefined,
          chillTargetF: chillTarget ? Number(chillTarget) : undefined,
          maxChillMins: maxChillMins ? Number(maxChillMins) : undefined,
        },
        notes: "",
      });

      // optionally cancel the old draft
      if (cancelOld && sessionId) {
        window.dispatchEvent(new CustomEvent("automation:intent", {
          detail: { intent: "cooking/session/cancel", id: sessionId }
        }));
      }

      // Switch editor to the new draft id
      if (newId) setSessionId(newId);

      // Toast-like event for UX
      window.dispatchEvent(new CustomEvent("ui:toast", {
        detail: { tone: "success", message: "Draft saved." }
      }));
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [title, startIso, durationMin, recipes, labelPrefix, labelDateFmt, labelIngredients, hotHold, chillTarget, maxChillMins, sessionId]);

  // Approve (optionally with chosen time)
  const handleApprove = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const Cooking = await CookingAPI();
      if (!Cooking?.approveDraft) throw new Error("Cooking store missing approveDraft().");

      // If user has changed inputs but not saved, do a quick save-to-new + cancel old first
      // We detect "changed" naïvely by presence of scheduleDraftIso or just always save-as-new for safety.
      const changedNeedsClone = true;
      let targetId = sessionId;

      if (changedNeedsClone) {
        const newId = await Cooking.createDraft({
          title: title || "Draft Cooking Session",
          start: startIso || new Date().toISOString(),
          durationMins: mins(durationMin, 90),
          recipes,
          labelTemplate: {
            prefix: labelPrefix || "SVFH",
            dateFormat: labelDateFmt || "YYYY-MM-DD",
            ingredientsLine: labelIngredients || "",
          },
          safetyTimers: {
            hotFillHoldMins: hotHold ? Number(hotHold) : undefined,
            chillTargetF: chillTarget ? Number(chillTarget) : undefined,
            maxChillMins: maxChillMins ? Number(maxChillMins) : undefined,
          },
        });
        if (newId) {
          // cancel original
          if (sessionId) {
            window.dispatchEvent(new CustomEvent("automation:intent", {
              detail: { intent: "cooking/session/cancel", id: sessionId }
            }));
          }
          targetId = newId;
        }
      }

      // schedule override if provided
      const override = scheduleDraftIso ? { scheduleAtIso: scheduleDraftIso } : undefined;
      await Cooking.approveDraft(targetId, override);

      // Close the modal
      setOpen(false);
      onClose?.();

      window.dispatchEvent(new CustomEvent("ui:toast", {
        detail: { tone: "success", message: "Draft approved and scheduled." }
      }));
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, title, startIso, durationMin, recipes, labelPrefix, labelDateFmt, labelIngredients, hotHold, chillTarget, maxChillMins, scheduleDraftIso, onClose]);

  const handleCancelDraft = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      window.dispatchEvent(new CustomEvent("automation:intent", {
        detail: { intent: "cooking/session/cancel", id: sessionId }
      }));
      setOpen(false);
      onClose?.();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, onClose]);

  /* ----------------------------- Recipe editor ----------------------------- */
  const addRecipe = () => {
    setRecipes((r) => [
      ...r,
      {
        id: undefined,
        title: "",
        station: "prep",
        allergens: [],
        dietary: [],
        yieldUnit: { amount: 0, unit: "cups" },
        packaging: { containerSize: 1, containerUnit: "cups" },
        packagingEstimate: 0,
      },
    ]);
  };
  const removeRecipe = (idx) => setRecipes((r) => r.filter((_, i) => i !== idx));
  const updateRecipe = (idx, patch) =>
    setRecipes((arr) =>
      arr.map((r, i) => (i === idx ? { ...r, ...patch } : r))
    );
  const updateTags = (list, raw) =>
    raw.split(",").map((x) => x.trim()).filter(Boolean);

  const recPackagingEstimate = (r) => {
    const total = Number(r?.yieldUnit?.amount || 0);
    const size = Number(r?.packaging?.containerSize || 1);
    return total > 0 && size > 0 ? Math.ceil(total / size) : 0;
  };

  /* ------------------------------ Render ------------------------------ */
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/20">
      <div className="w-full md:max-w-3xl bg-white rounded-t-2xl md:rounded-2xl shadow-2xl border border-gray-200 overflow-hidden">
        <header className="px-4 py-3 flex items-center justify-between border-b border-gray-100">
          <div>
            <div className="text-sm font-semibold">Session Draft</div>
            <div className="text-[11px] text-gray-500">Edit details, then approve & schedule</div>
          </div>
          <div className="flex items-center gap-2">
            {loading ? <span className="text-xs text-gray-500">working…</span> : null}
            <button
              onClick={() => { setOpen(false); onClose?.(); }}
              className="text-gray-500 hover:text-gray-700 rounded-md p-1"
              aria-label="Close"
              title="Close"
            >
              ✕
            </button>
          </div>
        </header>

        {/* Error banner */}
        {error ? (
          <div className="mx-4 mt-3 rounded-lg bg-rose-50 text-rose-800 text-xs p-3">{error}</div>
        ) : null}

        <div className="px-4 py-4 max-h-[70vh] overflow-y-auto">
          {/* Basics */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Title">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
                placeholder="e.g., Weekday Batch"
              />
            </Field>

            <Field label="Start (optional)">
              <input
                type="datetime-local"
                value={toLocalInputValue(startIso)}
                onChange={(e) => setStartIso(fromLocalInputValue(e.target.value))}
                className="w-full border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
              />
            </Field>

            <Field label="Duration (minutes)">
              <input
                type="number"
                min={10}
                step={5}
                value={durationMin}
                onChange={(e) => setDurationMin(mins(e.target.value, 90))}
                className="w-full border rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-amber-400"
              />
            </Field>
          </div>

          {/* Label + Safety */}
          <Divider />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Label prefix" help="Printed on jar/pack labels">
              <input
                value={labelPrefix}
                onChange={(e) => setLabelPrefix(e.target.value)}
                className="w-full border rounded-md px-2 py-1 text-sm"
              />
            </Field>
            <Field label="Label date format" help="e.g., YYYY-MM-DD">
              <input
                value={labelDateFmt}
                onChange={(e) => setLabelDateFmt(e.target.value)}
                className="w-full border rounded-md px-2 py-1 text-sm"
              />
            </Field>
            <Field label="Ingredients (label line)">
              <input
                value={labelIngredients}
                onChange={(e) => setLabelIngredients(e.target.value)}
                className="w-full border rounded-md px-2 py-1 text-sm"
                placeholder="tomato, basil, garlic"
              />
            </Field>
          </div>

          <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Hot fill hold (mins)">
              <input
                type="number"
                min={0}
                value={hotHold}
                onChange={(e) => setHotHold(e.target.value)}
                className="w-full border rounded-md px-2 py-1 text-sm"
              />
            </Field>
            <Field label="Chill target (°F)">
              <input
                type="number"
                min={0}
                value={chillTarget}
                onChange={(e) => setChillTarget(e.target.value)}
                className="w-full border rounded-md px-2 py-1 text-sm"
              />
            </Field>
            <Field label="Max chill time (mins)">
              <input
                type="number"
                min={0}
                value={maxChillMins}
                onChange={(e) => setMaxChillMins(e.target.value)}
                className="w-full border rounded-md px-2 py-1 text-sm"
              />
            </Field>
          </div>

          {/* Recipes */}
          <Divider />
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Recipes</div>
            <button
              onClick={addRecipe}
              className="text-xs px-2.5 py-1 rounded-md border hover:bg-gray-50"
            >
              Add recipe
            </button>
          </div>

          <ul className="mt-2 space-y-3">
            {recipes.map((r, idx) => (
              <li key={`r_${idx}`} className="border rounded-lg p-3">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <Field label="Title" className="md:col-span-2">
                    <input
                      value={r.title || ""}
                      onChange={(e) => updateRecipe(idx, { title: e.target.value })}
                      className="w-full border rounded-md px-2 py-1 text-sm"
                      placeholder="e.g., Marinara"
                    />
                  </Field>
                  <Field label="Station">
                    <select
                      value={r.station || "prep"}
                      onChange={(e) => updateRecipe(idx, { station: e.target.value })}
                      className="w-full border rounded-md px-2 py-1 text-sm"
                    >
                      <option value="prep">prep</option>
                      <option value="range">range</option>
                      <option value="oven">oven</option>
                      <option value="grill">grill</option>
                      <option value="chill">chill</option>
                    </select>
                  </Field>
                  <div className="flex items-end">
                    <button
                      onClick={() => removeRecipe(idx)}
                      className="text-[11px] px-2.5 py-1 rounded-md text-rose-700 hover:bg-rose-50 border"
                      title="Remove recipe"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
                  <Field label="Allergens (comma-separated)">
                    <input
                      value={(r.allergens || []).join(", ")}
                      onChange={(e) => updateRecipe(idx, { allergens: updateTags(r.allergens, e.target.value) })}
                      className="w-full border rounded-md px-2 py-1 text-sm"
                      placeholder="gluten, dairy, nuts"
                    />
                  </Field>
                  <Field label="Dietary tags (comma-separated)">
                    <input
                      value={(r.dietary || []).join(", ")}
                      onChange={(e) => updateRecipe(idx, { dietary: updateTags(r.dietary, e.target.value) })}
                      className="w-full border rounded-md px-2 py-1 text-sm"
                      placeholder="gluten-free, dairy-free"
                    />
                  </Field>

                  <Field label="Yield amount">
                    <input
                      type="number"
                      min={0}
                      value={Number(r?.yieldUnit?.amount || 0)}
                      onChange={(e) => updateRecipe(idx, { yieldUnit: { amount: Number(e.target.value||0), unit: r?.yieldUnit?.unit || "cups" } })}
                      className="w-full border rounded-md px-2 py-1 text-sm"
                    />
                  </Field>
                  <Field label="Yield unit">
                    <select
                      value={r?.yieldUnit?.unit || "cups"}
                      onChange={(e) => updateRecipe(idx, { yieldUnit: { amount: Number(r?.yieldUnit?.amount || 0), unit: e.target.value } })}
                      className="w-full border rounded-md px-2 py-1 text-sm"
                    >
                      <option value="cups">cups</option>
                      <option value="pints">pints</option>
                      <option value="quarts">quarts</option>
                      <option value="gal">gal</option>
                    </select>
                  </Field>
                </div>

                <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-3">
                  <Field label="Container size">
                    <input
                      type="number"
                      min={0.25}
                      step={0.25}
                      value={Number(r?.packaging?.containerSize || 1)}
                      onChange={(e) => updateRecipe(idx, { packaging: { containerSize: Number(e.target.value||1), containerUnit: r?.packaging?.containerUnit || "cups" } })}
                      className="w-full border rounded-md px-2 py-1 text-sm"
                    />
                  </Field>
                  <Field label="Container unit">
                    <select
                      value={r?.packaging?.containerUnit || "cups"}
                      onChange={(e) => updateRecipe(idx, { packaging: { containerSize: Number(r?.packaging?.containerSize || 1), containerUnit: e.target.value } })}
                      className="w-full border rounded-md px-2 py-1 text-sm"
                    >
                      <option value="cups">cups</option>
                      <option value="pints">pints</option>
                      <option value="quarts">quarts</option>
                    </select>
                  </Field>
                  <div className="md:col-span-2 flex items-center gap-2">
                    <Pill tone="info">Est. containers: {recPackagingEstimate(r)}</Pill>
                    {r.station ? <Pill tone="default">{r.station}</Pill> : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {/* Storage hints */}
          <Divider />
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="default">Fridge: {storageHints.fridgeQ} q</Pill>
            <Pill tone="default">Freezer: {storageHints.freezerQ} q</Pill>
            <Pill tone="default">Pantry: {storageHints.pantryQ} q</Pill>
            {capWarning ? <Pill tone="warn">{capWarning}</Pill> : null}
          </div>

          {/* Approve & schedule */}
          <Divider />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Field label="Schedule (on approve)">
              <input
                type="datetime-local"
                value={scheduleDraftIso ? toLocalInputValue(scheduleDraftIso) : ""}
                onChange={(e) => setScheduleDraftIso(fromLocalInputValue(e.target.value))}
                className="w-full border rounded-md px-2 py-1 text-sm"
              />
            </Field>
            <div className="md:col-span-2 flex items-end gap-2">
              <button
                onClick={() => handleSave({ cancelOld: false })}
                className="text-xs px-3 py-2 rounded-md border hover:bg-gray-50"
                title="Save as a new draft (keep original)"
              >
                Save draft
              </button>
              <button
                onClick={() => handleSave({ cancelOld: true })}
                className="text-xs px-3 py-2 rounded-md border hover:bg-gray-50"
                title="Save to a new draft and discard original"
              >
                Save & replace
              </button>
              <button
                onClick={handleApprove}
                className="ml-auto text-xs px-3 py-2 rounded-md bg-emerald-600 text-white hover:bg-emerald-700"
                title="Approve and schedule"
              >
                Approve & Schedule
              </button>
              <button
                onClick={handleCancelDraft}
                className="text-xs px-3 py-2 rounded-md text-rose-700 hover:bg-rose-50 border"
                title="Discard this draft"
              >
                Discard
              </button>
            </div>
          </div>
        </div>

        <footer className="px-4 py-3 border-t border-gray-100 text-[11px] text-gray-500 flex items-center justify-between">
          <span>Approving schedules the session and triggers calendar sync.</span>
          <button
            onClick={() => { setOpen(false); onClose?.(); }}
            className="text-xs px-2.5 py-1 rounded-md border hover:bg-gray-50"
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
