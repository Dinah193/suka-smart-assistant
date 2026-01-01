// src/pages/agrarian.jsx
import React, { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import {
  Save, RefreshCcw, Calculator, ClipboardList, Sprout, Beef, Milk, Egg, Settings2, Wheat,
  Ruler, Droplets, ChefHat, Boxes, Play, Calendar as CalendarIcon
} from "lucide-react";

import { automation } from "@/services/automation/runtime";
import AutomationPanel from "@/ui/AutomationPanel";
import "../index.css";

/* ------------------------------------------------------------------
   Context sync (same pattern as Cleaning/Cooking pages)
   ------------------------------------------------------------------ */
async function getHomeSelectionsSnapshot() {
  try {
    const res = await automation.runTemplate("home.selections.snapshot", { invokedBy: "ui/agrarian" });
    if (res && typeof res === "object") return normalizeHomeSelections(res);
  } catch {}
  // Fallback attempts
  for (const path of [
    "@store/HomeSelectionsStore","@/store/HomeSelectionsStore",
    "@store/HomeStore","@/store/HomeStore",
    "@context/VisionContext","@/context/VisionContext"
  ]) {
    try {
      const mod = await import(/* @vite-ignore */ path);
      if (typeof mod.getHomeSelections === "function") return normalizeHomeSelections(await mod.getHomeSelections());
      if (typeof mod.useHomeSelections === "function" && mod.useHomeSelections.getState) return normalizeHomeSelections(mod.useHomeSelections.getState());
      if (mod.homeSelections) return normalizeHomeSelections(mod.homeSelections);
      if (mod.default) return normalizeHomeSelections(mod.default);
    } catch {}
  }
  // Defaults
  return normalizeHomeSelections({
    familySize: 4,
    defaultZones: ["Kitchen", "Garden"],
    cookingPrefs: { schedule: "weekly", dietTags: ["balanced"] },
  });
}

function normalizeHomeSelections(raw = {}) {
  return {
    familySize: Number(raw.familySize) || 4,
    defaultZones: Array.isArray(raw.defaultZones) ? raw.defaultZones : ["Kitchen", "Garden"],
    cookingPrefs: raw.cookingPrefs || {},
  };
}

async function getKitchenSnapshot() {
  try {
    const res = await automation.runTemplate("kitchen.gear.snapshot", { invokedBy: "ui/agrarian" });
    if (res && typeof res === "object") return normalizeKitchen(res);
  } catch {}
  for (const path of ["@/store/KitchenStore","@store/KitchenStore"]) {
    try {
      const mod = await import(/* @vite-ignore */ path);
      if (typeof mod.getKitchenGear === "function") return normalizeKitchen(await mod.getKitchenGear());
      if (mod.kitchen || mod.kitchenGear) return normalizeKitchen(mod.kitchen || mod.kitchenGear);
      if (mod.default) return normalizeKitchen(mod.default);
    } catch {}
  }
  return normalizeKitchen({
    appliances: ["Oven","Stovetop","Freezer","Refrigerator","Pressure Canner","Dehydrator","Stand Mixer"],
    tools: ["Stock Pot","Dutch Oven","Sheet Pans","Blender"],
    utensils: ["Chef Knife","Tongs","Measuring Cups"],
  });
}
function normalizeKitchen(raw = {}) {
  const list = (x)=> (Array.isArray(x)?x:[]).map(String).filter(Boolean);
  return {
    appliances: list(raw.appliances ?? raw.Appliances),
    tools: list(raw.tools ?? raw.Tools),
    utensils: list(raw.utensils ?? raw.Utensils),
  };
}

/* ------------------------------------------------------------------
   Baseline coefficients (editable by user in UI)
   These are conservative planning defaults; users can override.
   Units: land in acres; housing in sq ft; water in gallons/day.
   ------------------------------------------------------------------ */
const DEFAULT_COEFFICIENTS = {
  animals: {
    chicken: { label:"Chickens", landAcres: 0.003, housingSqft: 4, waterGpd: 0.1, fenceFtPerAnimal: 8 },
    duck:    { label:"Ducks",    landAcres: 0.003, housingSqft: 5, waterGpd: 0.2, fenceFtPerAnimal: 8 },
    rabbit:  { label:"Rabbits",  landAcres: 0.001, housingSqft: 3, waterGpd: 0.1, fenceFtPerAnimal: 4 },
    goat:    { label:"Goats",    landAcres: 0.1,   housingSqft: 20, waterGpd: 1.5, fenceFtPerAnimal: 35 },
    sheep:   { label:"Sheep",    landAcres: 0.12,  housingSqft: 20, waterGpd: 1.5, fenceFtPerAnimal: 40 },
    pig:     { label:"Pigs",     landAcres: 0.05,  housingSqft: 30, waterGpd: 1.0, fenceFtPerAnimal: 30 },
    cattle:  { label:"Cattle",   landAcres: 1.0,   housingSqft: 60, waterGpd: 7.0, fenceFtPerAnimal: 80 },
  },
  // Garden: servings assumptions
  garden: {
    servingsPerSqftPerSeason: 0.5, // avg mixed-crop yield proxy
    sqftPerRaisedBed: 32,          // 4x8 bed
  },
  // Preservation kitchen planning
  kitchen: {
    counterLinearFeetPerCanner: 6,
    sinkBasins: 2,
    dryStorageCubicFtPerWeekOfCanning: 3,
    coldStorageCubicFtPerPerson: 4,
    dedicatedCircuitsNeeded: 2, // e.g., canner + dehydrator
  }
};

/* Helpers */
function sum(arr) { return arr.reduce((a,b)=>a+(Number(b)||0),0); }

/* ------------------------------------------------------------------
   Page
   ------------------------------------------------------------------ */
export default function AgrarianPage() {
  // Context
  const [home, setHome] = useState({ familySize: 4 });
  const [kitchen, setKitchen] = useState({ appliances: [], tools: [], utensils: [] });

  // Animal herd/flock inputs
  const [herd, setHerd] = useState({
    chicken: 12, duck: 0, rabbit: 0, goat: 2, sheep: 0, pig: 0, cattle: 0
  });

  // Garden inputs
  const [garden, setGarden] = useState({
    targetServingsPerDay: 5, // per person
    seasonsPerYear: 2,       // spring/summer + fall
    percentPreserved: 50,    // % of yield to preserve
  });

  // Tunable coefficients (user-editable advanced panel)
  const [coef, setCoef] = useState(DEFAULT_COEFFICIENTS);

  // UI state
  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [lastOutput, setLastOutput] = useState(null);

  /* ---------------------- sync on mount ---------------------- */
  useEffect(() => {
    (async () => {
      const [h, k] = await Promise.all([getHomeSelectionsSnapshot(), getKitchenSnapshot()]);
      setHome(h); setKitchen(k);
    })();
  }, []);

  const resyncFromHome = async () => {
    setBusy(true); setFeedback("");
    try {
      const [h, k] = await Promise.all([getHomeSelectionsSnapshot(), getKitchenSnapshot()]);
      setHome(h); setKitchen(k);
      setFeedback("🔄 Synced household & kitchen context.");
      setOk(true); setTimeout(()=>setOk(false), 900);
    } finally { setBusy(false); }
  };

  /* ---------------------- calculations ---------------------- */
  const calc = useMemo(() => {
    // Animal tallies
    const animalKeys = Object.keys(coef.animals);
    const details = animalKeys.map(key => {
      const n = Number(herd[key] || 0);
      const c = coef.animals[key];
      return {
        key,
        label: c.label,
        count: n,
        landAcres: n * c.landAcres,
        housingSqft: n * c.housingSqft,
        waterGpd: n * c.waterGpd,
        fenceFt: n * c.fenceFtPerAnimal,
      };
    });
    const totals = {
      landAcres: details.reduce((a,d)=>a+d.landAcres,0),
      housingSqft: details.reduce((a,d)=>a+d.housingSqft,0),
      waterGpd: details.reduce((a,d)=>a+d.waterGpd,0),
      fenceFt: details.reduce((a,d)=>a+d.fenceFt,0),
      headcount: details.reduce((a,d)=>a+d.count,0),
    };

    // Garden land need (very coarse, user-adjustable)
    const people = Number(home.familySize || 1);
    const servingsPerYear = people * Number(garden.targetServingsPerDay || 0) * 365;
    const seasons = Number(garden.seasonsPerYear || 1);
    const servingsPerSqftPerYear = Number(coef.garden.servingsPerSqftPerSeason) * seasons;
    const gardenSqftNeeded = servingsPerYear / (servingsPerSqftPerYear || 1);
    const bedsNeeded = gardenSqftNeeded / (coef.garden.sqftPerRaisedBed || 32);

    // Preservation volumes
    const preservedFraction = Math.max(0, Math.min(1, Number(garden.percentPreserved || 0)/100));
    const weeklyCanningBatches = Math.ceil((servingsPerYear * preservedFraction) / 52 / 12); // 12 servings ~ 3 pts/quarts proxy
    const dryStorageCubicFt =
      weeklyCanningBatches * coef.kitchen.dryStorageCubicFtPerWeekOfCanning;
    const coldStorageCubicFt =
      (coef.kitchen.coldStorageCubicFtPerPerson || 0) * people;

    // Kitchen workstation guidance
    const needsPressureCanner = (kitchen.appliances || []).some(a => /pressure canner/i.test(a)) ||
                                (kitchen.appliances || []).some(a => /canner/i.test(a));
    const cannerStations = Math.max(1, needsPressureCanner ? 1 : 0);
    const counterFt = cannerStations * coef.kitchen.counterLinearFeetPerCanner;
    const circuits = Math.max(coef.kitchen.dedicatedCircuitsNeeded, needsPressureCanner ? 2 : 1);

    return {
      animals: { details, totals },
      garden: { gardenSqftNeeded, bedsNeeded },
      water: { gpd: totals.waterGpd },
      kitchen: { counterFt, sinkBasins: coef.kitchen.sinkBasins, dryStorageCubicFt, coldStorageCubicFt, circuits },
    };
  }, [coef, herd, garden, home, kitchen]);

  /* ---------------------- actions ---------------------- */
  const savePlan = async () => {
    const plan = {
      name: `Agrarian Plan — ${dayjs().format("YYYY-MM-DD")}`,
      household: home,
      kitchen,
      herd,
      garden,
      coefficients: coef,
      calculations: calc,
    };
    setBusy(true); setOk(false); setFeedback("");
    try {
      const res = await automation.runTemplate("agrarian.plan.save", { plan, invokedBy: "ui/agrarian" });
      setLastOutput({ via:"template", res });
      setFeedback("✅ Agrarian plan saved via automation.");
    } catch (e) {
      // Local fallback event
      automation.emit("event", { type: "agrarian/plan_saved", payload: { plan } });
      setLastOutput({ via:"fallback", emitted:true });
      setFeedback("✅ Agrarian plan saved (local).");
    } finally { setBusy(false); setOk(true); setTimeout(()=>setOk(false), 900); }
  };

  const exportToCalendar = async () => {
    // Create suggested tasks (rotational grazing, planting windows, preservation weeks)
    const payload = {
      invokedBy: "ui/agrarian",
      household: home,
      herd, garden, calculations: calc,
      suggestions: {
        grazing: "Create rotational grazing reminders every 7–14 days during growing season.",
        planting: "Add planting/harvest windows for seasonsPerYear.",
        preservation: "Block weekly preservation sessions based on weeklyCanningBatches.",
      }
    };
    setBusy(true); setFeedback("");
    try {
      const res = await automation.runTemplate("agrarian.calendar.export", payload);
      setLastOutput({ via:"template", res });
      setFeedback("📆 Calendar events exported.");
    } catch (e) {
      automation.emit("event", { type:"agrarian/calendar_export", payload });
      setLastOutput({ via:"event", emitted:true });
      setFeedback("📆 Calendar export emitted (local).");
    } finally { setBusy(false); setOk(true); setTimeout(()=>setOk(false), 900); }
  };

  /* ---------------------- UI ---------------------- */
  return (
    <div>
      <h1>🏡 Agrarian Planner</h1>
      <p className="subtitle">
        Estimate land, water, garden area, and preservation‑kitchen needs — then save and schedule tasks.
      </p>

      {/* Actions */}
      <div className="card">
        <div style={{ display:"grid", gap:12, gridTemplateColumns:"1fr auto auto auto" }}>
          <div className="subtitle">
            <strong>Household:</strong> {home.familySize} people • Appliances: {kitchen.appliances?.length || 0}
          </div>
          <button className="btn sm" onClick={resyncFromHome} aria-busy={busy} title="Re-sync Home & Kitchen">
            <RefreshCcw size={16} style={{ marginRight:6 }} />
            <span className="label">Re‑Sync Home</span>
          </button>
          <button className="btn sm" onClick={savePlan} aria-busy={busy}>
            <Save size={16} style={{ marginRight:6 }} />
            <span className="label">Save Plan</span>
          </button>
          <button className="btn primary sm" onClick={exportToCalendar} aria-busy={busy}>
            <CalendarIcon size={16} style={{ marginRight:6 }} />
            <span className="label">Export to Calendar</span>
          </button>
        </div>
        {feedback && <div className="subtitle" style={{ marginTop:8 }}>{feedback}</div>}
        {ok ? <span className="subtitle" style={{ color:"var(--success)" }}>✓ Updated</span> : null}
      </div>

      {/* Herd/Flock */}
      <div className="card" style={{ marginTop:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <Beef size={18} /><h2 style={{ margin:0 }}>Animals</h2><span className="subtitle">Set your target counts</span>
        </div>
        <div style={{ display:"grid", gap:12, gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))", marginTop:12 }}>
          {Object.entries(coef.animals).map(([key, meta]) => (
            <NumericField
              key={key}
              label={meta.label}
              value={herd[key]}
              onChange={(v)=> setHerd(h=>({ ...h, [key]: v }))}
              min={0}
            />
          ))}
        </div>
      </div>

      {/* Garden */}
      <div className="card" style={{ marginTop:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <Sprout size={18} /><h2 style={{ margin:0 }}>Garden</h2><span className="subtitle">Servings‑based sizing</span>
        </div>
        <div style={{ display:"grid", gap:12, gridTemplateColumns:"repeat(auto-fit, minmax(220px, 1fr))", marginTop:12 }}>
          <NumericField label="Target Servings / Person / Day" value={garden.targetServingsPerDay} onChange={(v)=>setGarden(g=>({ ...g, targetServingsPerDay: v }))} min={0} />
          <NumericField label="Seasons per Year" value={garden.seasonsPerYear} onChange={(v)=>setGarden(g=>({ ...g, seasonsPerYear: v }))} min={1} />
          <NumericField label="% Yield to Preserve" value={garden.percentPreserved} onChange={(v)=>setGarden(g=>({ ...g, percentPreserved: v }))} min={0} max={100} />
        </div>
      </div>

      {/* Results */}
      <div className="card" style={{ marginTop:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <Calculator size={18} /><h2 style={{ margin:0 }}>Estimates</h2>
        </div>

        <div style={{ display:"grid", gap:12, gridTemplateColumns:"repeat(auto-fit, minmax(260px, 1fr))", marginTop:12 }}>
          <MetricCard icon={<Ruler />} title="Total Land (acres)" value={calc.animals.totals.landAcres.toFixed(2)} note="Pasture/forage footprint" />
          <MetricCard icon={<Boxes />} title="Animal Housing (sq ft)" value={Math.ceil(calc.animals.totals.housingSqft)} note="Barn/coops/shelters" />
          <MetricCard icon={<Droplets />} title="Water (gal/day)" value={calc.water.gpd.toFixed(1)} note="Average across species" />
          <MetricCard icon={<Wheat />} title="Garden Area (sq ft)" value={Math.ceil(calc.garden.gardenSqftNeeded)} note="Mixed-crop proxy" />
          <MetricCard icon={<Sprout />} title="Raised Beds (4×8)" value={Math.ceil(calc.garden.bedsNeeded)} note="Rounded up" />
        </div>

        <div className="divider" />

        <h3 style={{ marginTop:0 }}>Preservation Kitchen Guidance</h3>
        <div style={{ display:"grid", gap:12, gridTemplateColumns:"repeat(auto-fit, minmax(260px, 1fr))" }}>
          <MetricCard icon={<ChefHat />} title="Counter (linear ft)" value={Math.ceil(calc.kitchen.counterFt)} note="Active canning workspace" />
          <MetricCard icon={<Droplets />} title="Sink Basins" value={calc.kitchen.sinkBasins} note="Prefer deep dual basins" />
          <MetricCard icon={<Boxes />} title="Dry Storage (cu ft)" value={Math.ceil(calc.kitchen.dryStorageCubicFt)} note="For jars & supplies" />
          <MetricCard icon={<Boxes />} title="Cold Storage (cu ft)" value={Math.ceil(calc.kitchen.coldStorageCubicFt)} note="Fridge/Freezer space" />
        </div>
        <p className="subtitle" style={{ marginTop:8 }}>
          Consider <strong>{calc.kitchen.circuits}</strong> dedicated circuits for canner/dehydrator loads. Adjust in Advanced Settings.
        </p>
      </div>

      {/* Advanced: Coefficients */}
      <div className="card" style={{ marginTop:16 }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <Settings2 size={18} /><h2 style={{ margin:0 }}>Advanced Coefficients</h2><span className="subtitle">Tune baselines for your climate/forage</span>
        </div>

        <h3>Animals</h3>
        <div style={{ display:"grid", gap:12, gridTemplateColumns:"repeat(auto-fit, minmax(220px, 1fr))" }}>
          {Object.entries(coef.animals).map(([key, meta]) => (
            <div key={key} className="card" style={{ background:"#fff", borderColor:"#e5e7eb" }}>
              <div style={{ fontWeight:700, marginBottom:8 }}>{meta.label}</div>
              <SmallNumber label="Acres / animal" value={meta.landAcres} onChange={(v)=> setCoef(c=>({ ...c, animals:{ ...c.animals, [key]: { ...c.animals[key], landAcres: v }}}))} step={0.001} />
              <SmallNumber label="Housing sq ft / animal" value={meta.housingSqft} onChange={(v)=> setCoef(c=>({ ...c, animals:{ ...c.animals, [key]: { ...c.animals[key], housingSqft: v }}}))} />
              <SmallNumber label="Water gal/day / animal" value={meta.waterGpd} onChange={(v)=> setCoef(c=>({ ...c, animals:{ ...c.animals, [key]: { ...c.animals[key], waterGpd: v }}}))} step={0.1} />
              <SmallNumber label="Fence ft / animal" value={meta.fenceFtPerAnimal} onChange={(v)=> setCoef(c=>({ ...c, animals:{ ...c.animals, [key]: { ...c.animals[key], fenceFtPerAnimal: v }}}))} />
            </div>
          ))}
        </div>

        <h3 style={{ marginTop:16 }}>Garden & Kitchen</h3>
        <div style={{ display:"grid", gap:12, gridTemplateColumns:"repeat(auto-fit, minmax(220px, 1fr))" }}>
          <SmallNumber label="Servings / sq ft / season" value={coef.garden.servingsPerSqftPerSeason} onChange={(v)=> setCoef(c=>({ ...c, garden:{ ...c.garden, servingsPerSqftPerSeason: v }}))} step={0.1} />
          <SmallNumber label="Raised bed sq ft" value={coef.garden.sqftPerRaisedBed} onChange={(v)=> setCoef(c=>({ ...c, garden:{ ...c.garden, sqftPerRaisedBed: v }}))} />
          <SmallNumber label="Counter ft / canner" value={coef.kitchen.counterLinearFeetPerCanner} onChange={(v)=> setCoef(c=>({ ...c, kitchen:{ ...c.kitchen, counterLinearFeetPerCanner: v }}))} />
          <SmallNumber label="Dry storage cu ft / weekly batch" value={coef.kitchen.dryStorageCubicFtPerWeekOfCanning} onChange={(v)=> setCoef(c=>({ ...c, kitchen:{ ...c.kitchen, dryStorageCubicFtPerWeekOfCanning: v }}))} step={0.5} />
          <SmallNumber label="Cold storage cu ft / person" value={coef.kitchen.coldStorageCubicFtPerPerson} onChange={(v)=> setCoef(c=>({ ...c, kitchen:{ ...c.kitchen, coldStorageCubicFtPerPerson: v }}))} />
          <SmallNumber label="Dedicated circuits needed" value={coef.kitchen.dedicatedCircuitsNeeded} onChange={(v)=> setCoef(c=>({ ...c, kitchen:{ ...c.kitchen, dedicatedCircuitsNeeded: v }}))} />
        </div>
      </div>

      {/* Last automation output */}
      {lastOutput && (
        <div className="card" style={{ marginTop:16 }}>
          <div style={{ fontWeight:700, marginBottom:6 }}>Last Automation Output</div>
          <pre style={{ margin:0, whiteSpace:"pre-wrap" }}>{JSON.stringify(lastOutput, null, 2)}</pre>
        </div>
      )}

      {/* Templates/Agents */}
      <AutomationPanel
        title="Automation & Templates"
        context={{
          household: home, kitchen,
          herd, garden, coefficients: coef, calculations: calc
        }}
        agents={[]}
      />
    </div>
  );
}

/* ----------------------------- UI bits ----------------------------- */

function NumericField({ label, value, onChange, min = 0, max, step = 1 }) {
  return (
    <label className="field">
      <div className="subtitle" style={{ marginBottom:4 }}>{label}</div>
      <input
        type="number"
        className="btn"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e)=> onChange(Number(e.target.value))}
      />
    </label>
  );
}

function SmallNumber({ label, value, onChange, step = 1 }) {
  return (
    <div style={{ display:"grid", gap:6 }}>
      <div className="subtitle">{label}</div>
      <input
        type="number"
        className="btn"
        step={step}
        value={Number(value)}
        onChange={(e)=> onChange(Number(e.target.value))}
      />
    </div>
  );
}

function MetricCard({ icon, title, value, note }) {
  return (
    <div className="card" style={{ background:"#fff", borderColor:"#e5e7eb" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
        {icon}{/* lucide element */}
        <div style={{ fontWeight:700 }}>{title}</div>
      </div>
      <div style={{ fontSize:22, fontWeight:800 }}>{value}</div>
      {note ? <div className="subtitle">{note}</div> : null}
    </div>
  );
}
