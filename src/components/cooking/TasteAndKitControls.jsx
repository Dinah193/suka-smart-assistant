// src/components/cooking/TasteAndKitControls.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { CookingPrefsStore } from "@/store/CookingPrefsStore";
import { automation } from "@/services/automation/runtime";

/**
 * TasteAndKitControls v4
 * - Super-interactive, accessible, and user-friendly settings panel
 * - No direct imports from sibling stores; relies on CookingPrefsStore + automation events
 *
 * Improvements:
 *  - Collapsible sections
 *  - Typeahead for appliances/utensils + curated suggestions
 *  - Drag-to-reorder Weekly Flavor Rhythm
 *  - Save/load custom taste presets
 *  - Live slider badges + keyboard shortcuts (←/→ to adjust focused slider)
 *  - Kit tester (emits event to preview adaptations)
 *  - Undo (Ctrl/Cmd+Z)
 *  - Inline tooltips and little empty-state guidance
 */

export default function TasteAndKitControls({ compact = false, showAdvanced = true }) {
  const [prefs, setPrefs] = useState(CookingPrefsStore.get());
  const [packsInput, setPacksInput] = useState("");
  const [applianceInput, setApplianceInput] = useState("");
  const [utensilInput, setUtensilInput] = useState("");
  const [open, setOpen] = useState({
    taste: true,
    kit: true,
    rhythm: true,
    packs: false,
    caps: showAdvanced,
    importExport: false,
  });

  const fileRef = useRef(null);
  const sliderOrder = ["doneness", "softness", "browning", "smokiness", "sourness", "chiliHeat"];

  // subscribe to store
  useEffect(() => CookingPrefsStore.subscribe((s) => setPrefs({ ...s })), []);

  // keyboard: undo + slider nudge
  useEffect(() => {
    const onKey = (e) => {
      const isCmd = e.metaKey || e.ctrlKey;
      if (isCmd && e.key.toLowerCase() === "z") {
        e.preventDefault();
        CookingPrefsStore.undo();
      }
      // slider arrows: if focus is on a slider, adjust by 1
      const el = document.activeElement;
      const isSlider = el?.getAttribute?.("data-slider-key");
      if (isSlider && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const k = el.getAttribute("data-slider-key");
        const delta = e.key === "ArrowRight" ? 1 : -1;
        CookingPrefsStore.setSliders({ [k]: clamp((prefs.sliders?.[k] ?? 50) + delta, 0, 100) });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [prefs.sliders]);

  // curated suggestions
  const popularAppliances = ["pressure_cooker", "air_fryer", "charcoal_grill", "smoker", "induction_hob", "wok_burner", "bread_machine", "slow_cooker"];
  const popularUtensils = ["cast_iron", "carbon_steel_wok", "dutch_oven", "sheet_pan", "fish_spatula", "instant_read_thermometer", "mortar_pestle", "rice_cooker_basket"];

  // taste presets (localStorage so users can save custom sets)
  const [customPresets, setCustomPresets] = useState(getSavedPresets());
  function savePreset() {
    const name = prompt("Save current sliders as preset name:");
    if (!name) return;
    const next = { ...customPresets, [name]: { ...prefs.sliders } };
    setCustomPresets(next);
    localStorage.setItem("suka.cooking.customPresets", JSON.stringify(next));
    automation.emit("toast/show", { kind: "success", title: "Preset saved", message: name });
  }
  function applyPresetName(name) {
    const p = builtinPresets()[name] || customPresets[name];
    if (p) CookingPrefsStore.setSliders(p);
    automation.emit("ui/presetApplied", { scope: "cookingPrefs.sliders", name });
  }
  function deletePreset(name) {
    const next = { ...customPresets };
    delete next[name];
    setCustomPresets(next);
    localStorage.setItem("suka.cooking.customPresets", JSON.stringify(next));
  }

  // import/export
  function exportJSON() {
    const blob = new Blob([CookingPrefsStore.exportJSON()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "suka-cooking-prefs.json"; a.click();
    URL.revokeObjectURL(url);
  }
  function importJSON(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      CookingPrefsStore.importJSON(String(reader.result), { merge: true });
      automation.emit("toast/show", { kind: "success", title: "Imported", message: "Cooking preferences merged." });
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // typeahead helpers
  const applianceMatches = useMemo(() => typeahead(applianceInput, popularAppliances), [applianceInput]);
  const utensilMatches = useMemo(() => typeahead(utensilInput, popularUtensils), [utensilInput]);

  // rhythm drag
  const [dragIdx, setDragIdx] = useState(null);
  function onDragStart(i) { setDragIdx(i); }
  function onDragOver(e, i) {
    e.preventDefault();
    if (dragIdx === null || dragIdx === i) return;
    const arr = [...(prefs.weeklyFlavorRhythm || [])];
    const [moved] = arr.splice(dragIdx, 1);
    arr.splice(i, 0, moved);
    setDragIdx(i);
    CookingPrefsStore.setWeeklyFlavorRhythm(arr);
  }
  function onDragEnd() { setDragIdx(null); }

  return (
    <div className={["rounded-2xl shadow-lg border border-base-200 bg-base-100/90 backdrop-blur", compact ? "p-3" : "p-5"].join(" ")}>
      <HeaderRow prefs={prefs} onSavePreset={savePreset} />

      {/* Taste Sliders */}
      <Section title="Taste Sliders" open={open.taste} onToggle={() => setOpen(s => ({ ...s, taste: !s.taste }))} subtitle="Tune your default doneness/softness/browning, etc.">
        <SliderGrid
          sliders={prefs.sliders}
          order={sliderOrder}
          onChange={(k, v) => CookingPrefsStore.setSliders({ [k]: Number(v) })}
        />
        <PresetRow
          customPresets={customPresets}
          onApply={applyPresetName}
          onDelete={deletePreset}
        />
      </Section>

      {/* Region / Units */}
      <RowGroup>
        <BadgeItem label={`Region: ${prefs.region}`} tip="Guides swaps & authentic anchors">
          <button className="btn btn-xs" onClick={() => cycleRegion()} title="Cycle region">Change</button>
        </BadgeItem>
        <BadgeItem label={`Units: ${prefs.units}`} tip="Switches measurements in plans">
          <button className="btn btn-xs" onClick={() => CookingPrefsStore.setUnits(prefs.units === "imperial" ? "metric" : "imperial")} title="Toggle units">Toggle</button>
        </BadgeItem>
        <KitTester />
      </RowGroup>

      {/* Kitchen Kit */}
      <Section title="Kitchen Kit" open={open.kit} onToggle={() => setOpen(s => ({ ...s, kit: !s.kit }))} subtitle="Tell us what you can actually cook with.">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <TypeaheadEditor
            title="Appliances"
            items={prefs.appliances}
            inputValue={applianceInput}
            setInputValue={setApplianceInput}
            suggestions={popularAppliances}
            matches={applianceMatches}
            onAdd={(arr) => CookingPrefsStore.setKit({ appliances: uniq([...(prefs.appliances || []), ...arr]) })}
            onRemove={(x) => CookingPrefsStore.setKit({ appliances: (prefs.appliances || []).filter((a) => a !== x) })}
          />
          <TypeaheadEditor
            title="Utensils"
            items={prefs.utensils}
            inputValue={utensilInput}
            setInputValue={setUtensilInput}
            suggestions={popularUtensils}
            matches={utensilMatches}
            onAdd={(arr) => CookingPrefsStore.setKit({ utensils: uniq([...(prefs.utensils || []), ...arr]) })}
            onRemove={(x) => CookingPrefsStore.setKit({ utensils: (prefs.utensils || []).filter((a) => a !== x) })}
          />
        </div>
      </Section>

      {/* Weekly Flavor Rhythm */}
      <Section
        title="Weekly Flavor Rhythm"
        open={open.rhythm}
        onToggle={() => setOpen(s => ({ ...s, rhythm: !s.rhythm }))}
        subtitle="Plan your week by cuisines/themes. Drag to reorder."
      >
        <RhythmDragGrid
          values={prefs.weeklyFlavorRhythm || []}
          onChange={(i, v) => setRhythmAt(i, v)}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
        />
        <div className="mt-2 flex gap-2">
          <button className="btn btn-xs" onClick={() => quickFillRhythm("Classic")}>Fill: Classic</button>
          <button className="btn btn-xs" onClick={() => quickFillRhythm("LowEffort")}>Fill: Low Effort</button>
          <button className="btn btn-xs" onClick={() => quickFillRhythm("GrillWeek")}>Fill: Grill Week</button>
        </div>
      </Section>

      {/* Packs */}
      <Section title="Recipe Packs" open={open.packs} onToggle={() => setOpen(s => ({ ...s, packs: !s.packs }))} subtitle="Preferred packs bias generation.">
        <PackEditor
          preferred={prefs.recipePacks?.preferred || []}
          recent={prefs.recipePacks?.recentUsed || []}
          input={packsInput}
          setInput={setPacksInput}
          onAdd={(ids) => CookingPrefsStore.setPreferredPacks([...(prefs.recipePacks?.preferred || []), ...ids])}
          onRemove={(id) => CookingPrefsStore.setPreferredPacks((prefs.recipePacks?.preferred || []).filter((x) => x !== id))}
        />
      </Section>

      {/* Capabilities */}
      {showAdvanced && (
        <Section title="Appliance Capabilities" open={open.caps} onToggle={() => setOpen(s => ({ ...s, caps: !s.caps }))} subtitle="Agents read this to adapt steps.">
          <CapsEditor caps={prefs.applianceCaps} onChange={(appl, k, v) => CookingPrefsStore.setApplianceCaps(appl, { [k]: v })} />
        </Section>
      )}

      {/* Import / Export */}
      {showAdvanced && (
        <Section title="Import / Export" open={open.importExport} onToggle={() => setOpen(s => ({ ...s, importExport: !s.importExport }))}>
          <div className="flex items-center gap-2">
            <button className="btn btn-sm" onClick={exportJSON}>Export Preferences</button>
            <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={importJSON} />
            <button className="btn btn-sm" onClick={() => fileRef.current?.click()}>Import (merge)</button>
            <span className="ml-auto text-xs opacity-60">Last summarized: {prefs.lastSummarizedAt ? new Date(prefs.lastSummarizedAt).toLocaleString() : "—"}</span>
          </div>
        </Section>
      )}
    </div>
  );

  /* ---------- local helpers ---------- */

  function cycleRegion() {
    const order = ["US", "NG", "GH", "UK", "EU", "CA"];
    const idx = order.indexOf(prefs.region);
    CookingPrefsStore.setRegion(order[(idx + 1) % order.length] || "US");
  }

  function quickFillRhythm(seed) {
    const patterns = {
      Classic: ["Nigerian", "Cajun", "Mediterranean", "BBQ", "West African", "Asian Fusion", "Soul Food"],
      LowEffort: ["Batch Braise", "Tacos", "Sheet Pan", "Fried Rice", "Slow Cooker", "Sandwich Night", "Leftovers"],
      GrillWeek: ["BBQ", "Mediterranean", "BBQ", "Cajun", "BBQ", "West African", "BBQ"],
    };
    if (patterns[seed]) CookingPrefsStore.setWeeklyFlavorRhythm(patterns[seed]);
  }

  function setRhythmAt(i, val) {
    const arr = [...(prefs.weeklyFlavorRhythm || [])];
    arr[i] = val;
    CookingPrefsStore.setWeeklyFlavorRhythm(arr);
  }
}

/* ============================== UI Bits ============================== */

function HeaderRow({ prefs, onSavePreset }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div>
        <h3 className="text-lg font-semibold">Taste & Kitchen</h3>
        <div className="text-xs opacity-70">Personalize how the agent adapts traditional methods to your home.</div>
      </div>
      <div className="flex items-center gap-2">
        <button className="btn btn-xs" onClick={() => applyBuiltin("Balanced")}>Balanced</button>
        <button className="btn btn-xs" onClick={() => applyBuiltin("TenderSilky")}>Tender & Silky</button>
        <button className="btn btn-xs" onClick={() => applyBuiltin("CharAndCrispy")}>Char & Crispy</button>
        <button className="btn btn-xs" onClick={() => applyBuiltin("BrightAndTangy")}>Bright & Tangy</button>
        <button className="btn btn-xs" onClick={() => applyBuiltin("FireLovers")}>Fire Lovers</button>
        <div className="dropdown dropdown-end">
          <label tabIndex={0} className="btn btn-xs">Presets ▾</label>
          <ul tabIndex={0} className="dropdown-content menu p-2 shadow bg-base-100 rounded-box w-56">
            {Object.keys(builtinPresets()).map((k) => (
              <li key={k}><button onClick={() => applyBuiltin(k)}>{k}</button></li>
            ))}
            <li className="menu-title mt-1">Custom</li>
            {Object.keys(getSavedPresets()).length === 0 && <li className="text-xs opacity-60 px-4 py-1">None yet</li>}
            {Object.entries(getSavedPresets()).map(([k]) => (
              <li key={k} className="flex items-center justify-between px-2">
                <button className="flex-1 text-left" onClick={() => applyCustom(k)}>{k}</button>
                <button className="btn btn-ghost btn-xs" onClick={() => removeCustom(k)} title="Delete">✕</button>
              </li>
            ))}
            <div className="divider my-1"></div>
            <li><button onClick={onSavePreset}>Save current as preset…</button></li>
          </ul>
        </div>
      </div>
    </div>
  );

  function applyBuiltin(name) {
    const p = builtinPresets()[name];
    if (p) CookingPrefsStore.setSliders(p);
    automation.emit("ui/presetApplied", { scope: "cookingPrefs.sliders", name });
  }
  function applyCustom(name) {
    const p = getSavedPresets()[name];
    if (p) CookingPrefsStore.setSliders(p);
    automation.emit("ui/presetApplied", { scope: "cookingPrefs.sliders", name });
  }
  function removeCustom(name) {
    const next = { ...getSavedPresets() }; delete next[name];
    localStorage.setItem("suka.cooking.customPresets", JSON.stringify(next));
    automation.emit("toast/show", { kind: "info", title: "Preset removed", message: name });
  }
}

function Section({ title, subtitle, children, open, onToggle }) {
  return (
    <div className="mt-4 card bg-base-100 border border-base-200 shadow-sm overflow-hidden">
      <button
        className="card-title px-4 py-3 text-left flex items-center justify-between hover:bg-base-200/60"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`${title}-content`}
      >
        <div>
          <div className="font-semibold">{title}</div>
          {subtitle && <div className="text-xs opacity-70">{subtitle}</div>}
        </div>
        <span className="text-xl">{open ? "−" : "+"}</span>
      </button>
      <div id={`${title}-content`} className={`px-4 pb-4 ${open ? "block" : "hidden"}`}>
        {children}
      </div>
    </div>
  );
}

function RowGroup({ children }) {
  return <div className="mt-3 flex flex-wrap items-center gap-3">{children}</div>;
}

function BadgeItem({ label, tip, children }) {
  return (
    <div className="flex items-center gap-2">
      <div className="tooltip" data-tip={tip}>
        <div className="badge badge-neutral">{label}</div>
      </div>
      {children}
    </div>
  );
}

/* --------------------- Sliders --------------------- */

function SliderGrid({ sliders = {}, order = [], onChange }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {order.map((k) => <SliderRow key={k} k={k} v={sliders[k] ?? 50} onChange={onChange} />)}
    </div>
  );
}

function SliderRow({ k, v, onChange }) {
  const meta = {
    doneness: { label: "Doneness", help: "Higher = more cooked-through" },
    softness: { label: "Softness", help: "Higher = softer/tender texture" },
    browning: { label: "Browning", help: "Higher = more crust/Maillard" },
    smokiness: { label: "Smokiness", help: "Higher = stronger smoke/char notes" },
    sourness: { label: "Sourness", help: "Higher = more tang/acid" },
    chiliHeat: { label: "Chili Heat", help: "Higher = spicier" },
  }[k] || { label: k, help: "" };

  return (
    <div className="p-3 rounded-xl bg-base-200">
      <div className="flex items-center justify-between mb-1">
        <span className="font-medium">{meta.label}</span>
        <span className="text-xs opacity-70">{meta.help}</span>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min="0"
          max="100"
          value={v}
          onChange={(e) => onChange(k, e.target.value)}
          className="range range-xs flex-1"
          aria-label={`${meta.label} slider`}
          data-slider-key={k}
        />
        <span className="w-10 text-right">
          <span className="badge">{v}</span>
        </span>
      </div>
    </div>
  );
}

/* --------------------- Typeahead Editors --------------------- */

function TypeaheadEditor({ title, items = [], inputValue, setInputValue, suggestions = [], matches = [], onAdd, onRemove }) {
  const [focused, setFocused] = useState(false);

  function addFromInput() {
    const arr = splitCSV(inputValue);
    if (!arr.length) return;
    onAdd(arr);
    setInputValue("");
  }

  return (
    <div className="card bg-base-100 border border-base-200 shadow-sm">
      <div className="card-body p-4">
        <h4 className="font-semibold mb-2">{title}</h4>
        {items.length ? (
          <TagList items={items} onRemove={onRemove} />
        ) : (
          <div className="text-sm opacity-70">No {title.toLowerCase()} yet — add some below.</div>
        )}

        <div className="mt-2 relative">
          <input
            className="input input-bordered input-sm w-full"
            placeholder={`Add ${title.toLowerCase()} (comma or Enter)`}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => (e.key === "Enter" ? addFromInput() : null)}
            onFocus={() => setFocused(true)}
            onBlur={() => setTimeout(() => setFocused(false), 120)}
          />
          {focused && (matches.length || suggestions.length) ? (
            <div className="absolute z-20 mt-2 w-full bg-base-100 border border-base-200 rounded-xl shadow">
              <div className="p-2 grid grid-cols-2 gap-2 max-h-56 overflow-auto">
                {[...matches, ...suggestions.filter(s => !matches.includes(s))].slice(0, 12).map((s) => (
                  <button
                    key={s}
                    className="btn btn-ghost btn-xs justify-start"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => { setInputValue(s); setTimeout(() => addFromInput(), 0); }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TagList({ items = [], onRemove }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((x) => (
        <span key={x} className="badge badge-outline gap-2">
          {x}
          <button
            className="btn btn-ghost btn-xs"
            title={`Remove ${x}`}
            onClick={() => onRemove(x)}
            aria-label={`Remove ${x}`}
          >
            ✕
          </button>
        </span>
      ))}
    </div>
  );
}

/* --------------------- Rhythm Drag Grid --------------------- */

function RhythmDragGrid({ values = [], onChange, onDragStart, onDragOver, onDragEnd }) {
  const days = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  return (
    <div className="grid grid-cols-1 md:grid-cols-7 gap-2 mt-1">
      {days.map((d, i) => (
        <div
          key={d}
          className="p-3 bg-base-200 rounded-xl"
          draggable
          onDragStart={() => onDragStart(i)}
          onDragOver={(e) => onDragOver(e, i)}
          onDragEnd={onDragEnd}
          aria-label={`Reorder ${d}`}
        >
          <div className="text-xs opacity-70 mb-1 flex items-center justify-between">
            <span>{d}</span>
            <span className="opacity-60 cursor-grab">⋮⋮</span>
          </div>
          <input
            className="input input-bordered input-sm w-full"
            placeholder="Cuisine or theme"
            value={values[i] || ""}
            onChange={(e) => onChange(i, e.target.value)}
          />
        </div>
      ))}
    </div>
  );
}

/* --------------------- Packs --------------------- */

function PackEditor({ preferred = [], recent = [], input, setInput, onAdd, onRemove }) {
  function add() {
    const ids = splitCSV(input);
    if (!ids.length) return;
    onAdd(ids);
    setInput("");
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body p-4">
          <h4 className="font-semibold mb-1">Preferred Packs</h4>
          <p className="text-xs opacity-70 mb-2">Agents will prefer these when generating variants.</p>
          {preferred.length ? (
            <div className="flex flex-wrap gap-2">
              {preferred.map((id) => (
                <span key={id} className="badge badge-outline gap-2">
                  {id}
                  <button className="btn btn-ghost btn-xs" onClick={() => onRemove(id)} title="Remove">✕</button>
                </span>
              ))}
            </div>
          ) : <div className="text-sm opacity-60">No preferred packs yet.</div>}
          <div className="mt-2 flex gap-2">
            <input
              className="input input-bordered input-sm flex-1"
              placeholder="Add pack IDs (comma or Enter)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => (e.key === "Enter" ? add() : null)}
            />
            <button className="btn btn-sm btn-primary" onClick={add}>Add</button>
          </div>
        </div>
      </div>

      <div className="card bg-base-100 border border-base-200 shadow-sm">
        <div className="card-body p-4">
          <h4 className="font-semibold mb-1">Recently Used</h4>
          {recent.length ? (
            <div className="flex flex-wrap gap-2">{recent.map((id) => <span key={id} className="badge">{id}</span>)}</div>
          ) : <div className="text-sm opacity-60">No recent packs.</div>}
        </div>
      </div>
    </div>
  );
}

/* --------------------- Capabilities Editor --------------------- */

function CapsEditor({ caps = {}, onChange }) {
  const pairs = Object.entries(caps || {});
  if (!pairs.length) return <div className="text-sm opacity-60">No capabilities yet.</div>;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {pairs.map(([appl, c]) => (
        <div key={appl} className="p-3 rounded-xl bg-base-200">
          <div className="flex items-center justify-between">
            <div className="font-medium">{appl}</div>
            <span className="badge">{capSummary(c)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-2 items-center">
            {"supportsPressure" in c && (
              <ToggleRow label="Pressure" value={!!c.supportsPressure} onToggle={(v) => onChange(appl, "supportsPressure", v)} />
            )}
            {"convection" in c && (
              <ToggleRow label="Convection" value={!!c.convection} onToggle={(v) => onChange(appl, "convection", v)} />
            )}
            {"wokHei" in c && (
              <ToggleRow label="Wok Hei" value={!!c.wokHei} onToggle={(v) => onChange(appl, "wokHei", v)} />
            )}
            {"smokeFlavor" in c && (
              <SelectRow label="Smoke" value={c.smokeFlavor || "low"} options={["low","medium","high","very_high"]} onChange={(v) => onChange(appl, "smokeFlavor", v)} />
            )}
            {"maxC" in c && (
              <NumberRow label="Max °C" value={Number(c.maxC ?? 0)} min={0} max={400} step={5} onChange={(v) => onChange(appl, "maxC", v)} />
            )}
            {"capacityLiters" in c && (
              <NumberRow label="Capacity L" value={Number(c.capacityLiters ?? 0)} min={0} max={20} step={0.5} onChange={(v) => onChange(appl, "capacityLiters", v)} />
            )}
            {"btus" in c && (
              <NumberRow label="BTUs" value={Number(c.btus ?? 0)} min={0} max={100000} step={1000} onChange={(v) => onChange(appl, "btus", v)} />
            )}
            {"speedMultiplier" in c && (
              <NumberRow label="Speed ×" value={Number(c.speedMultiplier ?? 1)} min={0.5} max={3} step={0.1} onChange={(v) => onChange(appl, "speedMultiplier", v)} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function ToggleRow({ label, value, onToggle }) {
  return (
    <label className="flex items-center justify-between gap-2 p-2 bg-base-300 rounded-lg">
      <span className="text-sm">{label}</span>
      <input type="checkbox" className="toggle toggle-sm" checked={!!value} onChange={(e) => onToggle(e.target.checked)} aria-label={label} />
    </label>
  );
}
function NumberRow({ label, value, min=0, max=100, step=1, onChange }) {
  return (
    <label className="flex items-center justify-between gap-2 p-2 bg-base-300 rounded-lg">
      <span className="text-sm">{label}</span>
      <input type="number" className="input input-bordered input-xs w-24 text-right" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
    </label>
  );
}
function SelectRow({ label, value, options=[], onChange }) {
  return (
    <label className="flex items-center justify-between gap-2 p-2 bg-base-300 rounded-lg">
      <span className="text-sm">{label}</span>
      <select className="select select-bordered select-xs w-28" value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

/* --------------------- Kit Tester --------------------- */

function KitTester() {
  return (
    <div className="tooltip" data-tip="Preview how your kit changes steps">
      <button
        className="btn btn-xs"
        onClick={() => automation.emit("styles/kitTest", { ts: new Date().toISOString() })}
        title="Kit test"
      >
        Test my kit
      </button>
    </div>
  );
}

/* --------------------- Utilities --------------------- */

function builtinPresets() {
  return {
    Balanced: { doneness: 60, softness: 55, browning: 55, smokiness: 35, sourness: 35, chiliHeat: 45 },
    TenderSilky: { doneness: 60, softness: 75, browning: 45, smokiness: 30, sourness: 35, chiliHeat: 40 },
    CharAndCrispy: { doneness: 70, softness: 45, browning: 80, smokiness: 55, sourness: 30, chiliHeat: 50 },
    BrightAndTangy: { doneness: 55, softness: 55, browning: 45, smokiness: 25, sourness: 70, chiliHeat: 35 },
    FireLovers: { doneness: 65, softness: 55, browning: 70, smokiness: 55, sourness: 30, chiliHeat: 75 },
  };
}
function getSavedPresets() {
  try {
    const raw = localStorage.getItem("suka.cooking.customPresets");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
function typeahead(input, list) {
  const s = String(input || "").toLowerCase().trim();
  if (!s) return [];
  return list.filter((x) => x.toLowerCase().includes(s)).slice(0, 6);
}
function splitCSV(s) { return String(s || "").split(",").map((x) => x.trim()).filter(Boolean); }
function uniq(arr) { return Array.from(new Set((arr || []).filter(Boolean))); }
function clamp(n, lo, hi) { const x = Number.isFinite(Number(n)) ? Number(n) : lo; return Math.max(lo, Math.min(hi, x)); }
