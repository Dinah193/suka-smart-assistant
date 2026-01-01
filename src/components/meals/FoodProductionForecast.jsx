// src/components/meals/FoodProductionForecast.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { automation } from "@/services/automation/runtime";
import { useVision } from "@/context/VisionContext";
import useRecipeStore from "@/store/RecipeStore";

/* ----------------------------- helpers -------------------------------- */

// Vite-friendly dynamic import that never throws
async function safeImport(path) {
  try {
    // eslint-disable-next-line no-undef
    return await import(/* @vite-ignore */ path);
  } catch {
    return null;
  }
}

// Try to read MealPlanStore WITHOUT calling a hook (Rules of Hooks safe)
async function readMealPlanRecipesSafe() {
  const mod = await safeImport("@/store/MealPlanStore");
  const useMealPlanStore = mod?.useMealPlanStore || mod?.default || null;
  try {
    if (typeof useMealPlanStore === "function") {
      const st = useMealPlanStore.getState ? useMealPlanStore.getState() : useMealPlanStore();
      // common shapes: st.intent?.recipes, st.mealPlan?.recipes, st.plan?.plan...
      if (Array.isArray(st?.intent?.recipes)) return st.intent.recipes;
      if (Array.isArray(st?.mealPlan?.recipes)) return st.mealPlan.recipes;
      // Some stores keep plan.days[].meals[].ingredients
      const plan = st?.plan || st?.mealPlan;
      if (Array.isArray(plan?.plan)) {
        const flat = [];
        for (const d of plan.plan) {
          for (const m of d?.meals || []) {
            if (m?.ingredients) {
              flat.push({
                title: m.title || m.time || "meal",
                ingredients: m.ingredients,
              });
            }
          }
        }
        if (flat.length) return flat;
      }
    }
  } catch {}
  return [];
}

// Fuzzy template finder
function findTemplateId(...needles) {
  try {
    const list = automation?.getTemplates?.() || [];
    const N = needles.map((n) => String(n).toLowerCase());
    const hit = list.find((t) => {
      const id = String(t.id || "").toLowerCase();
      const title = String(t.title || "").toLowerCase();
      const tags = (t.tags || []).join(" ").toLowerCase();
      return N.every((n) => id.includes(n) || title.includes(n) || tags.includes(n));
    });
    return hit?.id || null;
  } catch {
    return null;
  }
}

// Light but smarter ingredient demand extractor (handles strings OR objects)
function extractDemand(recipes = []) {
  const out = { produce: {}, proteins: {}, staples: {} };

  const bump = (bucket, key, qty) => {
    if (!key) return;
    const k = key.toLowerCase().trim();
    if (!k) return;
    out[bucket][k] = (out[bucket][k] || 0) + (Number(qty) || 1);
  };

  const bucketFor = (name) => {
    const s = name.toLowerCase();
    if (/(tomato|pepper|onion|garlic|bean|pea|corn|squash|green|kale|spinach|lettuce|carrot|potato|cabbage|apple|grape|berry|fruit|herb)/.test(
      s
    ))
      return "produce";
    if (/(beef|chicken|pork|lamb|goat|turkey|egg|fish|salmon|tuna|milk|cheese|yogurt)/.test(s)) return "proteins";
    return "staples";
  };

  for (const r of recipes || []) {
    const ings = r.ingredients || r?.data?.ingredients || [];
    for (const ing of ings) {
      // Support "2 cups kale" (string) or { key:'kale', qty:150, unit:'g' } or { name:'kale' }
      if (typeof ing === "string") {
        const s = ing.toLowerCase();
        const qtyMatch = s.match(/\d+(\.\d+)?/);
        const qty = qtyMatch ? parseFloat(qtyMatch[0]) : 1;
        const name = s.replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
        const key = name.split(" ").slice(-2).join(" ");
        bump(bucketFor(name), key, qty);
      } else if (ing && (ing.key || ing.name)) {
        const key = (ing.key || ing.name || "").toString();
        const qty = Number(ing.qty ?? ing.quantity ?? 1) || 1;
        bump(bucketFor(key), key, qty);
      }
    }
  }
  return out;
}

function mergeForecast({ garden = {}, animals = {}, pantryTargets = {} }) {
  const kcalFromVeg = (garden.totalLbs || 0) * 90; // rough kcal/lb veg
  const proteinFromEggs = (animals.eggsPerWeek || 0) * 6 * 4; // 6g/egg, ~4 wks
  return {
    monthly: {
      kcal: Math.round(kcalFromVeg + (animals.kcal || 0)),
      protein: Math.round(proteinFromEggs + (animals.proteinG || 0)),
      jars: pantryTargets.jars || 0,
      freezerQt: pantryTargets.freezerQt || 0,
    },
    garden,
    animals,
    pantryTargets,
  };
}

function Stat({ label, value, hint }) {
  return (
    <div className="rounded-xl border bg-stone-50 p-3 text-sm">
      <div className="text-stone-500">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
      {hint ? <div className="text-xs text-stone-500">{hint}</div> : null}
    </div>
  );
}

function Card({ title, children, right }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-semibold">{title}</h3>
        {right || null}
      </div>
      {children}
    </div>
  );
}

const kgToLb = (kg) => +(Number(kg || 0) * 2.20462).toFixed(1);

/* ----------------------------- component ------------------------------ */
export default function FoodProductionForecast() {
  // Home Vision (profile + options)
  const { key: visionKey, options: vision } = useVision();

  // Recipes (demand signal #1)
  const recipes = useRecipeStore((s) => s.recipes || []);

  // Optional MealPlan recipes (demand signal #2) – read safely via getState
  const [mealPlanRecipes, setMealPlanRecipes] = useState([]);
  useEffect(() => {
    let alive = true;
    readMealPlanRecipesSafe().then((rows) => {
      if (alive) setMealPlanRecipes(Array.isArray(rows) ? rows : []);
    });
    return () => {
      alive = false;
    };
  }, []);

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [data, setData] = useState(null);

  // Demand is derived from either active meal plan OR selected recipes
  const demand = useMemo(
    () => extractDemand(mealPlanRecipes.length ? mealPlanRecipes : recipes || []),
    [mealPlanRecipes, recipes]
  );

  // A stable “inputs” signature so recalculation re-runs smartly
  const inputs = useMemo(
    () => ({
      profile: visionKey,
      zone: vision?.zone || "8a",
      landSqft: Number(vision?.landSqft || 0),
      livestockAllowed: !!vision?.livestockAllowed,
      organicPref: Number(vision?.organicPreference || 0),
      budgetLimit: vision?.budgetLimit ?? null,
      weeklyTime: Number(vision?.weeklyTimeBudgetHrs || 0),
      demand,
      people: Number(vision?.people || 4),
    }),
    [
      visionKey,
      vision?.zone,
      vision?.landSqft,
      vision?.livestockAllowed,
      vision?.organicPreference,
      vision?.budgetLimit,
      vision?.weeklyTimeBudgetHrs,
      vision?.people,
      demand,
    ]
  );

  const abortRef = useRef(null);
  const debounceRef = useRef(null);

  async function run(immediate = false) {
    // Debounce quick successive changes (e.g., toggling options)
    if (!immediate) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => run(true), 300);
      return;
    }

    // cancel any in-flight run
    if (abortRef.current) {
      abortRef.current.aborted = true;
    }
    const token = { aborted: false };
    abortRef.current = token;

    setBusy(true);
    setErr("");

    try {
      /* -------------------- Garden (via gardenAgent) -------------------- */
      let garden = { totalLbs: 0, items: [] };
      const gardenAgent = await safeImport("@/agents/gardenAgent");
      const wantedCrops = Object.keys(inputs.demand.produce || {});
      const cropList = wantedCrops.length
        ? wantedCrops.map((c) => ({ name: c }))
        : [{ name: "kale" }, { name: "lettuce" }, { name: "radish" }]; // tiny fallback

      const est = await gardenAgent?.handleCommand?.("estimatePlan", {
        location: { zone: inputs.zone },
        beds: [{ bedId: "A", areaSqft: inputs.landSqft || 0 }],
        crops: cropList,
        mealPrefs: { mode: "custom", includeCrops: wantedCrops },
        mealDemandWeights: Object.fromEntries(
          Object.entries(inputs.demand.produce || {}).map(([k, v]) => [k.toLowerCase(), Number(v) || 1])
        ),
        options: { horizonDays: 120, useLLM: false },
      });

      if (token.aborted) return;

      const estPlan = Array.isArray(est?.gardenUpdates)
        ? est.gardenUpdates.find((u) => u?.type === "garden.estimate_plan.v2")
        : null;

      if (estPlan?.lines?.length) {
        const totalKg = estPlan.lines.reduce((s, l) => s + Number(l.adjustedYieldKg || 0), 0);
        garden.totalLbs = kgToLb(totalKg);
        garden.items = estPlan.lines.slice(0, 10).map((l) => ({ name: l.crop, lbs: kgToLb(l.adjustedYieldKg) }));
      } else {
        // Secondary attempt: season dashboard to infer near-term activity (no yields)
        const dash = await gardenAgent?.handleCommand?.("getSeasonDashboard", {
          location: { zone: inputs.zone },
          beds: [{ bedId: "A", areaSqft: inputs.landSqft || 0 }],
          crops: cropList,
          options: { horizonDays: 45 },
        });
        if (token.aborted) return;
        if (dash?.calendarEvents?.length) {
          garden = { totalLbs: 0, items: [] };
        }
      }

      // Background: planting calendar template (best-effort)
      const plantTpl = findTemplateId("planting", "calendar");
      if (plantTpl) {
        automation.runTemplate(plantTpl, {
          zone: inputs.zone,
          landSqft: inputs.landSqft,
          focusCrops: wantedCrops,
          controlLevel: 2,
        }).catch(() => {});
      }

      /* -------------------- Animals (agent) ------------------------------ */
      let animals = {};
      const animalAgent = await safeImport("@/agents/animalAgent");
      const animalRes = await animalAgent?.handleCommand?.("estimateOutputs", {
        animals: [], // future: from AnimalStore
        landSqft: inputs.landSqft,
        options: { horizonDays: 30, livestockAllowed: inputs.livestockAllowed },
      });
      if (token.aborted) return;

      if (animalRes?.monthly) {
        animals = {
          eggsPerWeek: Number(animalRes.monthly.eggsPerWeek || 0),
          milkQt: Number(animalRes.monthly.milkQt || 0),
          meatLbs: Number(animalRes.monthly.meatLbs || 0),
          kcal: Number(animalRes.monthly.kcal || 0),
          proteinG: Number(animalRes.monthly.proteinG || 0),
        };
      }

      // Optional background nudges
      const breedTpl = findTemplateId("breeding", "cycle", "planner");
      const feedTpl = findTemplateId("daily", "feed", "rotation");
      if (breedTpl) automation.runTemplate(breedTpl, { controlLevel: 2 }).catch(() => {});
      if (feedTpl) automation.runTemplate(feedTpl, { controlLevel: 2 }).catch(() => {});

      /* -------- Pantry & Preservation Targets (storehouse agent) -------- */
      let pantryTargets = {};
      const storehouse = await safeImport("@/agents/storehouseAgent");
      const pars =
        (storehouse?.estimatePars?.({
          people: inputs.people,
          days: 30,
          includeNonFood: true,
        }) || []) ?? [];
      if (token.aborted) return;

      // derive monthly jar/freezer estimates (very rough)
      const producePars = pars.filter((p) => /veg|fruit/i.test(p.category || ""));
      const jars = producePars.reduce((n, p) => n + Math.ceil((p.parLevel || 0) / 800), 0);
      pantryTargets = { jars, freezerQt: Math.ceil(jars * 0.5) };

      // Preservation template (best-effort)
      const preserveTpl = findTemplateId("harvest", "preservation", "sync");
      if (preserveTpl) {
        automation
          .runTemplate(preserveTpl, {
            demand: inputs.demand,
            controlLevel: 2,
          })
          .catch(() => {});
      }

      if (token.aborted) return;

      const merged = mergeForecast({ garden, animals, pantryTargets });
      setData(merged);

      // Broadcast to downstream (Inventory, Cleaning, Garden, Animals pages)
      automation?.emit?.("forecast/updated", {
        ts: Date.now(),
        inputs,
        forecast: merged,
      });
    } catch (e) {
      if (!abortRef.current?.aborted) {
        setErr(e?.message || String(e));
        setData(null);
      }
    } finally {
      if (!abortRef.current?.aborted) setBusy(false);
    }
  }

  // Auto-run when inputs change (debounced)
  useEffect(() => {
    run(false);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (abortRef.current) abortRef.current.aborted = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(inputs)]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Production Forecast</h2>
        <button className="btn btn-outline" onClick={() => run(true)} disabled={busy} aria-busy={busy}>
          {busy ? "Calculating…" : "Recalculate"}
        </button>
      </div>

      {err ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-red-700 text-sm">
          Couldn’t calculate forecast. {err}
        </div>
      ) : null}

      {!data ? (
        <div className="rounded-xl border bg-stone-50 p-6 text-stone-500 text-sm">
          {busy ? "Working…" : "No forecast yet."}
        </div>
      ) : (
        <>
          {/* Overview */}
          <div className="grid gap-3 md:grid-cols-3">
            <Stat label="Monthly Calories (est.)" value={data.monthly.kcal.toLocaleString()} />
            <Stat label="Monthly Protein g (est.)" value={data.monthly.protein.toLocaleString()} />
            <Stat label="Preservation Targets" value={`${data.monthly.jars} jars / ${data.monthly.freezerQt} qt`} />
          </div>

          {/* Details */}
          <div className="grid gap-3 lg:grid-cols-3">
            <Card
              title="Garden Yield (next 30–120 days)"
              right={
                <span className="text-xs text-stone-500">
                  {inputs.landSqft || 0} sqft • zone {inputs.zone}
                </span>
              }
            >
              <div className="text-sm">
                <div className="mb-2 font-medium">Total ≈ {data.garden.totalLbs || 0} lb</div>
                <ul className="list-disc pl-5 space-y-1">
                  {(data.garden.items || []).slice(0, 6).map((it, i) => (
                    <li key={`${it.name}-${i}`}>
                      {it.name} — {it.lbs} lb
                    </li>
                  ))}
                  {!data.garden.items?.length && (
                    <li className="text-stone-500">No crop details available.</li>
                  )}
                </ul>
              </div>
            </Card>

            <Card title="Animal Products (monthly)">
              <div className="grid gap-2 text-sm">
                <div>
                  Eggs / week: <b>{data.animals.eggsPerWeek ?? 0}</b>
                </div>
                <div>
                  Milk (qt): <b>{data.animals.milkQt ?? 0}</b>
                </div>
                <div>
                  Meat (lb): <b>{data.animals.meatLbs ?? 0}</b>
                </div>
              </div>
            </Card>

            <Card title="Pantry & Preservation Targets">
              <div className="grid gap-2 text-sm">
                <div>
                  Jars to preserve: <b>{data.pantryTargets.jars ?? 0}</b>
                </div>
                <div>
                  Freezer space (qt): <b>{data.pantryTargets.freezerQt ?? 0}</b>
                </div>
                <div className="text-xs text-stone-500">
                  Targets adapt to your Household Profile (“{inputs.profile}”), demand from Meal Planning,
                  and capacity (land/animals).
                </div>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
