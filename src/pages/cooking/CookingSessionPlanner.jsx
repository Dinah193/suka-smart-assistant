// src/pages/cooking/CookingSessionPlanner.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { automation, emitProgress } from "@/services/automation/runtime";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard"; // respects your Sabbath guardrails
import NutritionPanel from "@/components/food/NutritionPanel";     // optional – auto-fallbacks if store not wired

/** Small bits using .sv-* styles from cooking.css */
function Card({ children, className = "" }) { return <div className={`sv-card ${className}`}>{children}</div>; }
function SectionHeader({ icon, title, sub, right }) {
  return (
    <div className="sv-sectionHead">
      <div className="sv-sectionHead__row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <div className="sv-sectionHead__row">
          {icon ? <span className="sv-sectionHead__icon">{icon}</span> : null}
          <h2 className="sv-sectionHead__title">{title}</h2>
        </div>
        {right}
      </div>
      {sub ? <p className="sv-muted">{sub}</p> : null}
    </div>
  );
}
function Input({ label, value, onChange, type = "text", placeholder, className = "", ...rest }) {
  return (
    <label className={`sv-field ${className}`}>
      {label ? <span className="sv-field__label">{label}</span> : null}
      <input type={type} value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="sv-input" {...rest}/>
    </label>
  );
}
function Button({ children, onClick, variant = "primary", disabled, className = "", title }) {
  const variantClass = variant === "ghost" ? "sv-btn--ghost" : variant === "outline" ? "sv-btn--outline" : "sv-btn--primary";
  return <button className={`sv-btn ${variantClass} ${className}`} onClick={onClick} disabled={disabled} title={title}>{children}</button>;
}
function Chip({ active, children, onClick }) { return <button onClick={onClick} className={`sv-chip ${active ? "is-active" : ""}`}>{children}</button>; }
function Toggle({ label, checked, onChange }) {
  return (
    <label className="sv-toggle">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="sv-toggle__thumb" />
      <span className="sv-toggle__label">{label}</span>
    </label>
  );
}
const Banner = ({ tone="info", children, onDismiss }) => (
  <div className={`sv-banner sv-banner--${tone}`}>
    <div className="sv-banner__content">{children}</div>
    {onDismiss && <button className="sv-btn sv-btn--ghost sv-btn--sm" onClick={onDismiss}>Dismiss</button>}
  </div>
);
const Toast = ({ tone="info", text, action, onClose }) => (
  <div className={`sv-toast sv-toast--${tone}`}>
    <span>{text}</span>
    {action && <button className="sv-btn sv-btn--outline sv-btn--sm" onClick={action.fn}>{action.label}</button>}
    <button className="sv-btn sv-btn--ghost sv-btn--sm" onClick={onClose}>✕</button>
  </div>
);

/** Demo library (augment with dietary flags so filters/warnings do something) */
const DEMO_RECIPES = [
  { id: "r1", title: "Chicken Bone Broth", tag: "Batch Prep", estMin: 180, gf: true, df: true, vegan: false },
  { id: "r2", title: "Tomato Sauce Base", tag: "Batch Prep", estMin: 90,  gf: true, df: true, vegan: true },
  { id: "r3", title: "Seasoned Ground Beef", tag: "Batch Prep", estMin: 40, gf: true, df: true, vegan: false },
  { id: "r4", title: "Eggs & Toast", tag: "Breakfast", estMin: 10, gf: false, df: false, vegan: false },
  { id: "r5", title: "Beef Brisket", tag: "Feast Meals", estMin: 240, gf: true, df: true, vegan: false },
  { id: "r6", title: "Roast Chicken", tag: "Dinner", estMin: 75, gf: true, df: true, vegan: false },
  { id: "r7", title: "Veggie Wrap", tag: "Lunch", estMin: 15, gf: true, df: true, vegan: true },
];

const TAGS = ["Breakfast", "Lunch", "Dinner", "Snack", "Feast Meals", "Batch Prep"];
const STATIONS = ["prep", "range", "oven", "grill"];
const STORAGE = ["fridge", "freezer", "pantry"];
const PACK_SIZES = ["1 cup", "pint", "quart", "tray"];
const DATE_FORMATS = ["YYYY-MM-DD", "MM/DD/YY", "DD MMM YYYY"];

// cup/pint/quart/tray -> freezer-quart equivalents (rough)
const PACK_TO_QT = { "1 cup": 0.25, pint: 0.5, quart: 1, tray: 2 };

/* -------------------------------- Undo stack ------------------------------- */
function useUndo() {
  const stack = useRef([]);
  const push = (revert, descr="Change") => { stack.current.push(revert); return { undo: () => stack.current.pop()?.(), descr }; };
  return { push };
}

/* ---------- Normalize any event return into a callable unsubscribe ---------- */
function toUnsubFn(ret) {
  if (typeof ret === "function") return ret;
  const methods = ["off", "unsubscribe", "remove", "dispose", "destroy"];
  for (const m of methods) if (ret && typeof ret[m] === "function") return () => ret[m]();
  return null;
}

/* ------------------------------ Event glue -------------------------------- */
const EVENT_KEYS = ["recipe.consolidated","inventory.updated","calendar.synced","preferences.changed","torah.profile.updated"];
function useAutomationGlue(onEvent) {
  useEffect(() => {
    const offs = [];
    EVENT_KEYS.forEach((k) => {
      const ret = automation?.on?.(k, (payload) => onEvent?.(k, payload));
      const fn = toUnsubFn(ret);
      if (fn) offs.push(fn);
    });
    return () => {
      for (const fn of offs) {
        try { if (typeof fn === "function") fn(); } catch { /* never crash unmount */ }
      }
    };
  }, [onEvent]);
}

/* --------------------------- Main Planner View ---------------------------- */
export default function CookingSessionPlanner({ onDraftReady, initialTitle = "Cooking Session" }) {
  const undo = useUndo();

  /** Stepper */
  const [step, setStep] = useState(1); // 1: Pick, 2: Configure, 3: Review
  const nextStep = () => setStep((s) => Math.min(3, s + 1));
  const prevStep = () => setStep((s) => Math.max(1, s - 1));

  /** Search & selection */
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState([]); // {id,title,tag,estMin,servings,storage,pack,station,yieldAmt,yieldUnit,hotFill, chillMin, allergens, diet}
  const [activeTags, setActiveTags] = useState(new Set(["Breakfast", "Lunch", "Dinner", "Snack"]));

  /** Global options */
  const [title, setTitle] = useState(initialTitle);
  const [servingsOverride, setServingsOverride] = useState("");
  const [batchX, setBatchX] = useState(1);

  /** Dietary/allergen filters & warnings preferences */
  const [avoidGluten, setAvoidGluten] = useState(false);
  const [avoidDairy, setAvoidDairy] = useState(false);
  const [avoidNuts, setAvoidNuts] = useState(false);
  const [requireVegan, setRequireVegan] = useState(false);

  /** Label template */
  const [labelPrefix, setLabelPrefix] = useState("Suka");
  const [labelDateFmt, setLabelDateFmt] = useState("YYYY-MM-DD");
  const [ingredientsLine, setIngredientsLine] = useState("");

  /** Storage capacity hints (quarts/units) */
  const [capFreezerQt, setCapFreezerQt] = useState("16");
  const [capFridgeQt, setCapFridgeQt] = useState("12");
  const [capPantryUnits, setCapPantryUnits] = useState("24");

  /** Notes */
  const [notes, setNotes] = useState("");

  /** UI feedback */
  const [banners, setBanners] = useState([]);
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);

  /** Suggestions (diet-aware & tag-aware) */
  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return DEMO_RECIPES
      .filter(r => activeTags.has(r.tag))
      .filter(r => !q || r.title.toLowerCase().includes(q))
      .filter(r => (avoidGluten ? r.gf : true))
      .filter(r => (avoidDairy ? r.df : true))
      .filter(r => (requireVegan ? r.vegan : true))
      .slice(0, 12);
  }, [query, avoidGluten, avoidDairy, requireVegan, activeTags]);

  /** Derived totals */
  const stationLoads = useMemo(() => {
    const loads = { prep: 0, range: 0, oven: 0, grill: 0 };
    selected.forEach(r => { loads[r.station || "prep"] += (r.estMin || 0) * (batchX || 1); });
    return loads;
  }, [selected, batchX]);

  const packaging = useMemo(() => {
    // estimate packs and freezer-quart usage
    let usedFreezerQt = 0, usedFridgeQt = 0, usedPantry = 0, totalPacks = 0;

    selected.forEach(r => {
      const yAmt = Number(r.yieldAmt || 0);
      let packs = 1;
      const qtPerPack = PACK_TO_QT[r.pack || "quart"] || 1;

      if (yAmt > 0 && r.yieldUnit) {
        const unit = (r.yieldUnit || "").toLowerCase();
        const toQt = unit.includes("quart") ? 1 : unit.includes("pint") ? 0.5 : unit.includes("cup") ? 0.25 : unit.includes("tray") ? 2 : 1;
        const totalQt = yAmt * toQt;
        packs = Math.max(1, Math.round(totalQt / qtPerPack));
      }
      totalPacks += packs;

      if (r.storage === "freezer") usedFreezerQt += packs * qtPerPack;
      else if (r.storage === "fridge") usedFridgeQt += packs * qtPerPack;
      else usedPantry += packs;
    });

    return {
      totalPacks,
      usedFreezerQt,
      usedFridgeQt,
      usedPantry,
      overFreezer: capFreezerQt && usedFreezerQt > Number(capFreezerQt),
      overFridge: capFridgeQt && usedFridgeQt > Number(capFridgeQt),
      overPantry: capPantryUnits && usedPantry > Number(capPantryUnits),
    };
  }, [selected, capFreezerQt, capFridgeQt, capPantryUnits]);

  const totals = useMemo(() => {
    const count = selected.length;
    const totalEst = selected.reduce((sum, r) => sum + (r.estMin || 0), 0) * (batchX || 1);
    return { count, estMin: totalEst };
  }, [selected, batchX]);

  /* --------------------------- Event-driven glue -------------------------- */
  useAutomationGlue((event) => {
    if (event === "recipe.consolidated") {
      bannerAdd({
        key: "recs",
        tone: "info",
        text: "Recipes changed. Refresh your suggestions and station plan.",
        actions: [{ label: "Refresh", fn: () => setQuery((q) => q) }],
      });
    }
    if (event === "inventory.updated") {
      bannerAdd({
        key: "inv",
        tone: "warning",
        text: "Inventory updated. Re-check availability before generating.",
        actions: [{ label: "Check Inventory", fn: () => handleCheckInventory() }],
      });
    }
    if (event === "calendar.synced") bannerAdd({ key: "cal", tone: "success", text: "Calendar sync complete.", dismissible: true });
    if (event === "preferences.changed") setToast({ tone: "info", text: "Preferences applied to suggestions." });
    if (event === "torah.profile.updated") bannerAdd({ key: "diet", tone: "info", text: "Dietary profile changed. Review allergens before generating." });
  });

  function bannerAdd(b) { setBanners((prev) => (prev.find((x) => x.key === b.key) ? prev : [...prev, b])); }
  function bannerDismiss(key) { setBanners((prev) => prev.filter((b) => b.key !== key)); }

  /* ------------------------------ UX helpers ------------------------------ */
  const toggleTag = (tag) => {
    setActiveTags((prev) => {
      const next = new Set(prev);
      next.has(tag) ? next.delete(tag) : next.add(tag);
      return next;
    });
  };

  const addRecipe = (r) => {
    const nextItem = {
      ...r,
      servings: "",
      storage: "freezer",
      pack: "quart",
      station: defaultStationForTag(r.tag),
      yieldAmt: "",
      yieldUnit: "",
      hotFill: r.tag === "Batch Prep",
      chillMin: r.tag === "Batch Prep" ? 30 : 0,
      containsGluten: !r.gf,
      containsDairy: !r.df,
      containsNuts: false,
      diet: { gf: !!r.gf, df: !!r.df, vegan: !!r.vegan },
    };
    setSelected((prev) => (prev.some((x) => x.id === r.id) ? prev : [...prev, nextItem]));
    setQuery("");
    setStep(2);
  };

  const quickAdd = () => {
    const t = query.trim();
    if (!t) return;
    addRecipe({ id: `custom:${t}`, title: t, tag: "Batch Prep", estMin: 30, gf: true, df: true, vegan: false });
  };

  const removeRecipe = (id) => {
    const prev = selected;
    const next = selected.filter((r) => r.id !== id);
    setSelected(next);
    const { undo: revert } = undo.push(() => setSelected(prev), "Remove recipe");
    setToast({ tone: "success", text: "Removed.", action: { label: "Undo", fn: revert } });
  };

  const updateSelected = (id, patch) => setSelected((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  function defaultStationForTag(tag) {
    if (tag === "Batch Prep") return "range";
    if (tag === "Feast Meals") return "oven";
    if (tag === "Breakfast") return "prep";
    return "oven";
  }

  function autoBalance() {
    const items = [...selected].sort((a, b) => (b.estMin || 0) - (a.estMin || 0));
    const loads = { prep: 0, range: 0, oven: 0, grill: 0 };
    const next = items.map((r) => {
      const best = Object.entries(loads).sort((a, b) => a[1] - b[1])[0][0];
      loads[best] += (r.estMin || 0);
      return { ...r, station: best };
    });
    const byId = new Map(next.map((n) => [n.id, n]));
    const prev = selected;
    setSelected((prevSel) => prevSel.map((p) => byId.get(p.id) || p));
    const { undo: revert } = undo.push(() => setSelected(prev), "Auto-balance");
    setToast({ tone: "success", text: "Stations balanced.", action: { label: "Undo", fn: revert } });
  }

  /* --------------------------- Inventory helpers -------------------------- */
  const handleCheckInventory = async () => {
    setBusy(true);
    try {
      const resp = await automation.request?.("inventory.checkForRecipes", { recipes: selected });
      const missing = resp?.missing || [];
      if (missing.length) {
        setToast({ tone: "warning", text: `Missing ${missing.length} item${missing.length > 1 ? "s" : ""}.` });
      } else {
        setToast({ tone: "success", text: "All set. Inventory looks good." });
      }
    } catch {
      setToast({ tone: "error", text: "Couldn’t check inventory." });
    } finally {
      setBusy(false);
    }
  };

  const handleReserveInventory = async () => {
    const task = async () => {
      setBusy(true);
      try {
        const resp = await automation.request?.("inventory.reserveForCooking", { recipes: selected });
        const reservationId = resp?.reservationId;
        const { undo: revert } = undo.push(async () => {
          await automation.request?.("inventory.releaseReservation", { reservationId });
        }, "Reserve inventory");
        setToast({ tone: "success", text: "Ingredients reserved.", action: { label: "Undo", fn: revert } });
      } catch {
        setToast({ tone: "error", text: "Couldn’t reserve ingredients." });
      } finally {
        setBusy(false);
      }
    };
    await sabbathGuard(task, { allowReadOnly: false });
  };

  /* ------------------------------- Generate ------------------------------- */
  const handleGenerate = async () => {
    const now = Date.now();
    const timers = [];

    selected.forEach((r, idx) => {
      if (r.chillMin && Number(r.chillMin) > 0) {
        timers.push({
          id: `cool:${idx}`,
          label: `Chill ${r.title} to safe temp`,
          seconds: Number(r.chillMin) * 60,
          station: "prep",
        });
      }
    });

    const draft = {
      id: `draft:${now}`,
      title: title || "Cooking Session",
      metrics: { totalRecipes: selected.length, estMinutes: totals.estMin },
      notes: notes || undefined,
      timers,
      stations: [
        { key: "prep", label: "Prep Station", tools: ["knife", "board"] },
        { key: "range", label: "Range / Stovetop", tools: ["pot", "pan"] },
        { key: "oven", label: "Oven", tools: ["sheet", "roaster"] },
        { key: "grill", label: "Grill", tools: ["tongs", "thermometer"] },
      ],
      steps: selected.map((r, idx) => ({
        id: `step:${idx}`,
        label: `Cook: ${r.title}${batchX > 1 ? ` ×${batchX}` : ""}`,
        station: r.station || "prep",
        estMin: Math.max(5, Math.round((r.estMin || 30) * (batchX || 1))),
        safety: r.hotFill || r.chillMin ? { hotFill: !!r.hotFill, chillMin: Number(r.chillMin || 0) } : undefined,
        allergens: {
          gluten: !!r.containsGluten,
          dairy: !!r.containsDairy,
          nuts: !!r.containsNuts,
        },
        yield: r.yieldAmt ? { amount: Number(r.yieldAmt), unit: r.yieldUnit || "" } : undefined,
      })),
      inventory: { pulls: [], missing: [] },
      packaging: {
        labelTemplate: { prefix: labelPrefix || "", dateFormat: labelDateFmt || "YYYY-MM-DD", ingredients: ingredientsLine || "" },
        capacity: {
          freezerQt: capFreezerQt ? Number(capFreezerQt) : null,
          fridgeQt: capFridgeQt ? Number(capFridgeQt) : null,
          pantryUnits: capPantryUnits ? Number(capPantryUnits) : null,
        },
        estimate: {
          freezerQt: packaging.usedFreezerQt,
          fridgeQt: packaging.usedFridgeQt,
          pantryUnits: packaging.usedPantry,
          packs: packaging.totalPacks,
        },
      },
      selection: selected,
      options: {
        servingsOverride: servingsOverride ? Number(servingsOverride) : null,
        batchX,
        tags: Array.from(activeTags),
        dietPrefs: { avoidGluten, avoidDairy, avoidNuts, requireVegan },
      },
    };

    const task = async () => {
      try {
        await automation.request?.("cooking.session.saveDraft", draft);
      } catch {
        // non-fatal if not wired
      }
      onDraftReady?.(draft);
      emitProgress?.("cooking.session.generated", {
        id: draft.id,
        nextBestAction: { label: "Open in Cook Now", action: "ui.navigate:/cooking/now" },
      });
      setToast({
        tone: "success",
        text: "Draft created.",
        action: {
          label: "Open in Cook Now",
          fn: () => automation.emit?.("ui.navigate", { to: "/cooking/now", state: { draftId: draft.id } }),
        },
      });
      if (packaging.overFreezer || packaging.overFridge || packaging.overPantry) {
        bannerAdd({
          key: "capacity",
          tone: "warning",
          text: "Your packaging plan is over capacity. Consider smaller packs or fewer items.",
        });
      }
      setStep(3);
    };

    await sabbathGuard(task, { allowReadOnly: false });
  };

  /* --------------------------------- UI ---------------------------------- */
  return (
    <Card>
      <div className="sv-pad">

        {/* Stepper header */}
        <SectionHeader
          icon="🧪"
          title="Cooking Session Planner"
          sub="Pick recipes, configure stations & packing, then review and generate a ready-to-cook draft."
          right={
            <div className="sv-row sv-gap">
              <span className="sv-stepper">
                <b>Step {step}</b> of 3
              </span>
              {step > 1 && <Button variant="ghost" onClick={prevStep}>Back</Button>}
              {step < 3 && <Button variant="outline" onClick={nextStep} disabled={selected.length === 0}>Next</Button>}
            </div>
          }
        />

        {/* Banners */}
        {banners.map((b) => (
          <Banner key={b.key} tone={b.tone} onDismiss={b.dismissible === false ? undefined : () => bannerDismiss(b.key)}>
            <div className="sv-row sv-gap" style={{ justifyContent: "space-between" }}>
              <span>{b.text}</span>
              <div className="sv-row sv-gap">
                {b.actions?.map((a, i) => (
                  <Button key={i} variant="outline" onClick={a.fn}>{a.label}</Button>
                ))}
              </div>
            </div>
          </Banner>
        ))}

        {/* STEP 1 — PICK */}
        {step === 1 && (
          <>
            {/* Search & filters */}
            <div className="sv-grid-2">
              <Input label="Choose Recipes" value={query} onChange={setQuery} placeholder="Search or quick add..." />
              <div className="sv-field">
                <span className="sv-field__label">&nbsp;</span>
                <Button variant="outline" onClick={quickAdd} title="Add a quick custom item">+ Add</Button>
              </div>
            </div>

            <div className="sv-wrap sv-block">
              <Toggle label="Avoid gluten" checked={avoidGluten} onChange={setAvoidGluten} />
              <Toggle label="Avoid dairy" checked={avoidDairy} onChange={setAvoidDairy} />
              <Toggle label="Avoid nuts" checked={avoidNuts} onChange={setAvoidNuts} />
              <Toggle label="Require vegan" checked={requireVegan} onChange={setRequireVegan} />
            </div>

            {/* Suggestions */}
            {query && suggestions.length > 0 && (
              <div className="sv-block">
                <div className="sv-subtitle">Suggestions</div>
                <div className="sv-wrap">
                  {suggestions.map((s) => (
                    <Chip key={s.id} active={false} onClick={() => addRecipe(s)}>
                      {s.title}
                    </Chip>
                  ))}
                </div>
              </div>
            )}

            {/* Active tags */}
            <div className="sv-block">
              <div className="sv-subtitle">Meal tags</div>
              <div className="sv-wrap">
                {TAGS.map((t) => (
                  <Chip key={t} active={activeTags.has(t)} onClick={() => toggleTag(t)}>{t}</Chip>
                ))}
              </div>
            </div>

            {/* Empty state */}
            {selected.length === 0 && (
              <div className="sv-block">
                <div className="sv-empty">
                  <p className="sv-muted">No recipes selected yet.</p>
                  <div className="sv-wrap" style={{ marginTop: 8 }}>
                    {DEMO_RECIPES.slice(0, 6).map((s) => (
                      <Button key={s.id} variant="outline" onClick={() => addRecipe(s)}>Quick add: {s.title}</Button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* STEP 2 — CONFIGURE */}
        {step === 2 && (
          <>
            {/* Selected list */}
            <div className="sv-block">
              <div className="sv-subtitle">Selected</div>
              {selected.length === 0 ? (
                <p className="sv-muted">No recipes selected yet.</p>
              ) : (
                <div className="sv-stack-sm">
                  {selected.map((r) => {
                    const violates = (avoidGluten && r.containsGluten) || (avoidDairy && r.containsDairy) || (avoidNuts && r.containsNuts) || (requireVegan && !r?.diet?.vegan);
                    return (
                      <div key={r.id} className="sv-card sv-pad">
                        <div className="sv-row sv-gap" style={{ justifyContent: "space-between" }}>
                          <div className="sv-row sv-gap">
                            <strong>{r.title}</strong>
                            <span className="sv-caption">• {r.tag}</span>
                            <span className="sv-caption">• ~{r.estMin ?? 30}m</span>
                            {violates ? <span className="sv-caption" style={{ color: "#b91c1c" }}>⚠ diet/allergen conflict</span> : null}
                          </div>
                          <Button variant="ghost" onClick={() => removeRecipe(r.id)}>Remove</Button>
                        </div>

                        <div className="sv-grid-4 sv-block">
                          <label className="sv-field">
                            <span className="sv-field__label">Station</span>
                            <select className="sv-input" value={r.station} onChange={(e) => updateSelected(r.id, { station: e.target.value })}>
                              {STATIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                            </select>
                          </label>
                          <Input label="Servings (this item)" type="number" value={r.servings} onChange={(v) => updateSelected(r.id, { servings: v })} placeholder="e.g., 6" />
                          <label className="sv-field">
                            <span className="sv-field__label">Storage</span>
                            <select className="sv-input" value={r.storage} onChange={(e) => updateSelected(r.id, { storage: e.target.value })}>
                              {STORAGE.map((s) => <option value={s} key={s}>{s}</option>)}
                            </select>
                          </label>
                          <label className="sv-field">
                            <span className="sv-field__label">Pack Size</span>
                            <select className="sv-input" value={r.pack} onChange={(e) => updateSelected(r.id, { pack: e.target.value })}>
                              {PACK_SIZES.map((p) => <option value={p} key={p}>{p}</option>)}
                            </select>
                          </label>
                        </div>

                        <div className="sv-grid-4 sv-block">
                          <Input label="Yield amount" type="number" value={r.yieldAmt} onChange={(v) => updateSelected(r.id, { yieldAmt: v })} placeholder="e.g., 6" />
                          <label className="sv-field">
                            <span className="sv-field__label">Yield unit</span>
                            <select className="sv-input" value={r.yieldUnit} onChange={(e) => updateSelected(r.id, { yieldUnit: e.target.value })}>
                              {["cup", "pint", "quart", "tray"].map((u) => <option key={u} value={u}>{u}</option>)}
                            </select>
                          </label>
                          <div className="sv-field">
                            <span className="sv-field__label">&nbsp;</span>
                            <Toggle label="Hot fill" checked={!!r.hotFill} onChange={(v) => updateSelected(r.id, { hotFill: v })} />
                          </div>
                          <Input label="Chill minutes" type="number" value={r.chillMin} onChange={(v) => updateSelected(r.id, { chillMin: v })} placeholder="e.g., 30" />
                        </div>

                        <div className="sv-grid-4 sv-block">
                          <div className="sv-field"><span className="sv-field__label">Allergens</span>
                            <div className="sv-wrap">
                              <Toggle label="Contains gluten" checked={!!r.containsGluten} onChange={(v) => updateSelected(r.id, { containsGluten: v })} />
                              <Toggle label="Contains dairy" checked={!!r.containsDairy} onChange={(v) => updateSelected(r.id, { containsDairy: v })} />
                              <Toggle label="Contains nuts" checked={!!r.containsNuts} onChange={(v) => updateSelected(r.id, { containsNuts: v })} />
                            </div>
                          </div>
                          <div className="sv-field">
                            <span className="sv-field__label">Diet tags</span>
                            <div className="sv-wrap">
                              <Toggle label="GF" checked={!!r?.diet?.gf} onChange={(v) => updateSelected(r.id, { diet: { ...(r.diet || {}), gf: v } })} />
                              <Toggle label="DF" checked={!!r?.diet?.df} onChange={(v) => updateSelected(r.id, { diet: { ...(r.diet || {}), df: v } })} />
                              <Toggle label="Vegan" checked={!!r?.diet?.vegan} onChange={(v) => updateSelected(r.id, { diet: { ...(r.diet || {}), vegan: v } })} />
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Global options */}
            <div className="sv-grid-2 sv-block">
              <Input label="Title" value={title} onChange={setTitle} placeholder="Cooking Session" />
              <Input label="Servings override (optional)" type="number" value={servingsOverride} onChange={setServingsOverride} placeholder="e.g., 8" />
            </div>

            {/* Storage capacity & usage */}
            <div className="sv-grid-3 sv-block">
              <Input label="Freezer capacity (quarts)" type="number" value={capFreezerQt} onChange={setCapFreezerQt} />
              <Input label="Fridge capacity (quarts)" type="number" value={capFridgeQt} onChange={setCapFridgeQt} />
              <Input label="Pantry capacity (units)" type="number" value={capPantryUnits} onChange={setCapPantryUnits} />
            </div>

            <div className="sv-grid-3 sv-block">
              <Card className="sv-pad">
                <div className="sv-subtitle">Freezer usage</div>
                <div className="sv-text-sm">{packaging.usedFreezerQt.toFixed(1)} qt</div>
                {packaging.overFreezer ? <div className="sv-caption" style={{ color: "#b91c1c" }}>Over capacity!</div> : null}
              </Card>
              <Card className="sv-pad">
                <div className="sv-subtitle">Fridge usage</div>
                <div className="sv-text-sm">{packaging.usedFridgeQt.toFixed(1)} qt</div>
                {packaging.overFridge ? <div className="sv-caption" style={{ color: "#b91c1c" }}>Over capacity!</div> : null}
              </Card>
              <Card className="sv-pad">
                <div className="sv-subtitle">Pantry usage</div>
                <div className="sv-text-sm">{packaging.usedPantry} units</div>
                {packaging.overPantry ? <div className="sv-caption" style={{ color: "#b91c1c" }}>Over capacity!</div> : null}
              </Card>
            </div>

            {/* Station loads & auto-balance */}
            <div className="sv-grid-4 sv-block">
              <Card className="sv-pad"><div className="sv-subtitle">Prep</div><div className="sv-text-sm">~{Math.round(stationLoads.prep)} min</div></Card>
              <Card className="sv-pad"><div className="sv-subtitle">Range</div><div className="sv-text-sm">~{Math.round(stationLoads.range)} min</div></Card>
              <Card className="sv-pad"><div className="sv-subtitle">Oven</div><div className="sv-text-sm">~{Math.round(stationLoads.oven)} min</div></Card>
              <Card className="sv-pad"><div className="sv-subtitle">Grill</div><div className="sv-text-sm">~{Math.round(stationLoads.grill)} min</div></Card>
            </div>
            <div className="sv-row sv-gap">
              <Button variant="outline" onClick={autoBalance} disabled={selected.length === 0}>Auto-balance stations</Button>
              <div className="sv-caption">Assigns longest tasks to the least-loaded stations.</div>
            </div>

            {/* Notes */}
            <label className="sv-field sv-block">
              <span className="sv-field__label">Notes (labels, station setup, allergies, etc.)</span>
              <textarea className="sv-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Label prefix, tray counts, who’s cooking which station..." />
            </label>

            {/* Labels */}
            <div className="sv-grid-4 sv-block">
              <label className="sv-field">
                <span className="sv-field__label">Batch Multiplier</span>
                <select className="sv-input" value={batchX} onChange={(e) => setBatchX(Number(e.target.value))}>
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}×</option>)}
                </select>
              </label>
              <div className="sv-field">
                <span className="sv-field__label">Label prefix</span>
                <input className="sv-input" value={labelPrefix} onChange={(e) => setLabelPrefix(e.target.value)} />
              </div>
              <label className="sv-field">
                <span className="sv-field__label">Date format</span>
                <select className="sv-input" value={labelDateFmt} onChange={(e) => setLabelDateFmt(e.target.value)}>
                  {DATE_FORMATS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              <Input label="Ingredients line (for labels)" value={ingredientsLine} onChange={setIngredientsLine} placeholder="e.g., chicken, onion, celery, salt" />
            </div>

            {/* Actions for this step */}
            <div className="sv-row sv-gap sv-block" style={{ justifyContent: "flex-end" }}>
              <Button variant="outline" onClick={handleCheckInventory} disabled={selected.length === 0}>Check Inventory</Button>
              <Button variant="outline" onClick={handleReserveInventory} disabled={selected.length === 0 || busy}>Reserve Ingredients</Button>
              <Button onClick={() => setStep(3)} disabled={selected.length === 0}>Review</Button>
            </div>
          </>
        )}

        {/* STEP 3 — REVIEW & GENERATE */}
        {step === 3 && (
          <>
            <div className="sv-grid-2 sv-block">
              <Card className="sv-pad">
                <div className="sv-subtitle">Summary</div>
                <div className="sv-text-sm">
                  {totals.count} recipe{totals.count === 1 ? "" : "s"} • ~{totals.estMin} min • {packaging.totalPacks} pack{packaging.totalPacks === 1 ? "" : "s"}
                </div>
                {(packaging.overFreezer || packaging.overFridge || packaging.overPantry) && (
                  <div className="sv-caption" style={{ color: "#b91c1c" }}>⚠ Over capacity detected. Consider smaller packs or fewer items.</div>
                )}
                <div className="sv-row sv-gap sv-block">
                  <Button variant="outline" onClick={() => setSelected([])} disabled={selected.length === 0}>Clear</Button>
                  <Button onClick={handleGenerate} disabled={selected.length === 0 || busy}>Generate Session Draft</Button>
                </div>
              </Card>

              {/* Nutrition peek (per serving & totals) */}
              <Card className="sv-pad">
                <div className="sv-subtitle">Nutrition (estimate)</div>
                <NutritionPanel
                  recipes={selected.map((r) => ({ id: r.id }))}
                  servings={Number(servingsOverride || 0) || 1}
                  dense
                />
              </Card>
            </div>
          </>
        )}

        {/* Footer quick-actions always visible */}
        <div className="sv-row sv-gap sv-block" style={{ justifyContent: "space-between" }}>
          <div className="sv-muted sv-text-sm">
            {totals.count} recipe{totals.count === 1 ? "" : "s"} • ~{totals.estMin} min • {packaging.totalPacks} pack{packaging.totalPacks === 1 ? "" : "s"}
          </div>
          <div className="sv-row sv-gap">
            <Button variant="outline" onClick={() => setSelected([])} disabled={selected.length === 0}>Clear</Button>
            <Button onClick={handleGenerate} disabled={selected.length === 0 || busy}>Generate Session Draft</Button>
          </div>
        </div>

        {/* Toasts */}
        {toast && (
          <div className="sv-toastWrap">
            <Toast
              tone={toast.tone}
              text={toast.text}
              action={toast.action}
              onClose={() => setToast(null)}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
