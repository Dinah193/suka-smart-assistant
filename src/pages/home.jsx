// src/pages/home.jsx
import React, { useEffect, useMemo, useState, Suspense } from "react";
import DashboardSection from "@/components/layout/DashboardSection";
import RecipeConsolidatorCard from "@/components/home/RecipeConsolidatorCard";
import HouseholdProfile from "@/components/home/HouseholdProfile";
import { automation } from "@/services/automation/runtime"; // shared automation runtime

/* ✅ QuickAdd (cross-domain) */
import QuickAddModal from "@/components/quickadd/QuickAddModal";
import QuickAddEngine from "@/services/quickadd/QuickAddEngine";

/* 🔧 bring in the bridge styles so .btn/.card/.chip work */
import "@/styles/bridge.scan.css";

/* ------------------------------ lazy components ------------------------------ */
const Scanner = React.lazy(() =>
  import(
    /* @vite-ignore */ "@/app/features/scan-compare-trust/components/Scanner"
  ).catch(() => ({
    default: () => null,
  }))
);
const ScanSheet = React.lazy(() =>
  import(
    /* @vite-ignore */ "@/app/features/scan-compare-trust/components/ScanSheet"
  ).catch(() => ({
    default: () => null,
  }))
);

/* ------------------------------ page-local fallback CSS ------------------------------ */
function FallbackStyles() {
  const css = `
  .card{background:hsl(var(--panel));border:1px solid hsl(var(--line));border-radius:16px;box-shadow:var(--shadow-1)}
  .btn{--_h:40px;height:var(--_h);padding:0 14px;border-radius:12px;border:1px solid hsl(var(--suka-brand-600));
       background:hsl(var(--suka-brand));color:#fff;display:inline-flex;align-items:center;gap:10px;
       font-size:14px;line-height:1;cursor:pointer;box-shadow:var(--shadow-1)}
  .btn:hover{background:hsl(var(--suka-brand-600))}
  .btn[disabled]{opacity:.6;pointer-events:none}
  .btn.btn--ghost{background:transparent;color:hsl(var(--suka-brand-700));border-color:hsl(var(--line))}
  .btn-bar{display:flex;gap:8px;flex-wrap:wrap}
  .chip{display:inline-flex;align-items:center;gap:8px;height:28px;padding:0 10px;border-radius:999px;background:hsl(var(--panel-2));border:1px solid hsl(var(--line));font-size:12px;color:hsl(var(--text-subtle))}
  .chip--brand{background:hsla(var(--suka-brand)/.12);color:hsl(var(--suka-brand-700));border-color:hsla(var(--suka-brand-700)/.25)}
  .skeleton{border-radius:12px;height:12px;width:100%;background:linear-gradient(90deg,hsl(var(--panel-2)) 0%,hsl(var(--panel)) 40%,hsl(var(--panel-2)) 80%);background-size:200% 100%;animation:suka-shimmer 1200ms linear infinite}
  @keyframes suka-shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
  .link{color:hsl(var(--suka-brand-700));font-weight:600}
  `;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

/* ------------------------------ hard-override compact CSS ------------------------------ */
function LocalTightStyles() {
  const css = `
  /* ✅ section-grid.half (requested) */
  .section-grid{display:grid;gap:12px}
  .section-grid.half{grid-template-columns:1fr;align-items:start}
  @media (min-width: 1024px){
    .section-grid.half{grid-template-columns:repeat(2,minmax(0,1fr));}
  }

  /* Home polish helpers */
  .home-hero-kpis{display:flex;flex-direction:column;gap:12px}
  .home-hero-top{display:flex;flex-direction:column;gap:10px}
  .home-hero-title{display:flex;flex-direction:column;gap:4px}
  .home-muted{color:hsl(var(--text-subtle))}
  .home-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
  .home-actions-right{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .home-action-pill{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 12px;border-radius:999px;border:1px solid hsl(var(--line));background:hsl(var(--panel));box-shadow:var(--shadow-0);color:hsl(var(--text));font-size:13px;cursor:pointer}
  .home-action-pill:hover{border-color:hsla(var(--suka-brand-700)/.35)}
  .home-kpi-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
  @media (min-width: 640px){ .home-kpi-row{grid-template-columns:repeat(3,minmax(0,1fr));} }
  @media (min-width: 1280px){ .home-kpi-row{grid-template-columns:repeat(5,minmax(0,1fr));} }
  .kpi-card{display:flex;align-items:center;gap:12px;min-height:74px;padding:12px;border-radius:16px;border:1px solid hsl(var(--line));background:hsl(var(--panel));box-shadow:var(--shadow-0)}
  .kpi-card:hover{border-color:hsla(var(--suka-brand-700)/.35)}
  .kpi-icon{width:34px;height:34px;border-radius:12px;display:grid;place-items:center;border:1px solid hsla(var(--suka-brand-700)/.18);background:hsla(var(--suka-brand)/.10);color:hsl(var(--suka-brand-700));font-weight:700}
  .kpi-meta{display:flex;flex-direction:column;gap:2px;min-width:0}
  .kpi-label{font-size:12px;color:hsl(var(--text-subtle));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .kpi-value{font-size:18px;font-weight:700;line-height:1.05}
  .kpi-sub{font-size:12px;color:hsl(var(--text-subtle))}
  .kpi-active .kpi-icon{background:hsla(var(--suka-brand)/.14);border-color:hsla(var(--suka-brand-700)/.28)}
  .kpi-active .kpi-value{color:hsl(var(--suka-brand-700))}
  .home-soft-wrap{border:1px solid hsl(var(--line));background:linear-gradient(180deg, hsla(var(--suka-brand)/.06), transparent 55%);border-radius:18px;padding:12px}

  /* ✅ Condense the two tall ingest cards (Scan + Seed) */
  section#scan-seed-grid { gap: 12px !important; }
  #scan.card, #seed-to-garden.card { padding: 10px !important; }
  #scan .card, #seed-to-garden .card { padding: 10px !important; }
  #scan .grid, #seed-to-garden .grid { gap: 8px !important; }
  #scan h2, #seed-to-garden h2 { margin: 0 0 4px 0 !important; line-height: 1.15 !important; }
  #scan p.text-xs, #seed-to-garden p.text-xs { margin: 0 !important; }
  #scan .btn-bar, #seed-to-garden .btn-bar { margin-top: 6px !important; gap: 8px !important; }
  #scan .card p, #seed-to-garden .card p { margin-top: 4px !important; margin-bottom: 0 !important; }
  #scan .font-semibold.mb-1, #seed-to-garden .font-semibold.mb-1 { margin-bottom: 4px !important; }

  /* shrink scanner frame + sheet height a bit */
  #scan .camera-frame, #seed-to-garden .camera-frame {
    aspect-ratio: 4 / 3 !important;
    max-height: 170px !important;
  }
  #scan .skeleton.h-40, #seed-to-garden .skeleton.h-40 { height: 140px !important; }

  /* make ScanSheet compact */
  #scan .card + .card { margin-top: 0 !important; }

  /* Animal preference chips */
  .animal-chip{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 12px;border-radius:999px;border:1px solid hsl(var(--line));
               background:hsl(var(--panel));color:hsl(var(--text));font-size:13px;cursor:pointer}
  .animal-chip:hover{border-color:hsla(var(--suka-brand-700)/.35)}
  .animal-chip--on{background:hsla(var(--suka-brand)/.12);border-color:hsla(var(--suka-brand-700)/.25);color:hsl(var(--suka-brand-700));font-weight:600}
  .animal-row{display:flex;flex-wrap:wrap;gap:8px}
  .animal-input{width:100%;border:1px solid hsl(var(--line));border-radius:12px;padding:10px 12px;background:hsl(var(--panel));}
  `;
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

/* -------------------------------------------------------------------------- */
/* utils                                                                      */
/* -------------------------------------------------------------------------- */
function navigateTo(route) {
  try {
    window.history.pushState({}, "", route);
    window.dispatchEvent(new Event("popstate"));
  } catch {
    window.location.href = route;
  }
}
const fire = (type, detail = {}) => {
  window.dispatchEvent(new CustomEvent(type, { detail }));
  try {
    const bus = window.__suka?.eventBus;
    if (bus?.emit) bus.emit(type, detail);
  } catch {}
};
const readFileAsDataURL = (file) =>
  new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });

/* -------------------------------------------------------------------------- */
/* tiny local favorites store (user-owned)                                    */
/* -------------------------------------------------------------------------- */
const favKey = {
  sessions: "suka.favorites.sessions",
  schedules: "suka.favorites.schedules",
};
const readFav = (k) => {
  try {
    const s = localStorage.getItem(k);
    return s ? JSON.parse(s) : [];
  } catch {
    return [];
  }
};
const writeFav = (k, val) => {
  try {
    localStorage.setItem(k, JSON.stringify(val));
  } catch {}
};

/* ✅ local animals preference store */
const animalPrefKey = "suka.home.animalPreferences";
const readAnimalPrefs = () => {
  try {
    const raw = localStorage.getItem(animalPrefKey);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      selected: Array.isArray(parsed?.selected) ? parsed.selected : [],
      other: typeof parsed?.other === "string" ? parsed.other : "",
    };
  } catch {
    return { selected: [], other: "" };
  }
};
const writeAnimalPrefs = (next) => {
  try {
    localStorage.setItem(animalPrefKey, JSON.stringify(next));
  } catch {}
};

/* --------------------------------- UI bits -------------------------------- */
function IconGlyph({ glyph }) {
  return <span aria-hidden="true">{glyph}</span>;
}

function KpiCard({
  label,
  value,
  loading = false,
  onClick,
  title,
  icon = "•",
  hint,
}) {
  const Tag = onClick ? "button" : "div";
  const active = !loading && Number(value || 0) > 0;

  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      title={title || (onClick ? `Open ${label}` : undefined)}
      className={`kpi-card ${onClick ? "cursor-pointer" : ""} ${
        active ? "kpi-active" : ""
      }`}
      style={{ textAlign: "left" }}
    >
      <div className="kpi-icon">
        <IconGlyph glyph={icon} />
      </div>

      <div className="kpi-meta">
        <div className="kpi-label">{label}</div>
        <div className={`kpi-value tabular-nums ${loading ? "skeleton" : ""}`}>
          {loading ? "\u00A0" : value}
        </div>
        {hint ? <div className="kpi-sub">{hint}</div> : null}
      </div>
    </Tag>
  );
}

function HomeActionMenu({
  onMealPlanning,
  onCleaning,
  onCooking,
  onGarden,
  onAnimals,
}) {
  // lightweight “more actions” menu without adding deps
  return (
    <details className="relative">
      <summary className="home-action-pill" role="button">
        <span aria-hidden="true">▾</span>
        <span>Today’s actions</span>
      </summary>

      <div
        className="card"
        style={{
          position: "absolute",
          top: "calc(100% + 8px)",
          left: 0,
          zIndex: 20,
          minWidth: 260,
          padding: 10,
        }}
      >
        <div className="text-xs home-muted" style={{ marginBottom: 8 }}>
          Jump to a page or start a session.
        </div>

        <div className="btn-bar" style={{ flexDirection: "column", gap: 8 }}>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={onMealPlanning}
          >
            🍽️ Meal Planning
          </button>
          <button type="button" className="btn btn--ghost" onClick={onCleaning}>
            🧼 Cleaning
          </button>
          <button type="button" className="btn btn--ghost" onClick={onCooking}>
            🍳 Cooking
          </button>
          <button type="button" className="btn btn--ghost" onClick={onGarden}>
            🌿 Garden
          </button>
          <button type="button" className="btn btn--ghost" onClick={onAnimals}>
            🐾 Animals
          </button>
        </div>
      </div>
    </details>
  );
}

/* ---------------------------------- Page ---------------------------------- */
export default function HomePage() {
  const [showFallback, setShowFallback] = useState(true);

  /* ✅ QuickAdd engine (reusable across domains) */
  const qa = useMemo(() => new QuickAddEngine(), []);

  useEffect(() => {
    const hasTokens = getComputedStyle(
      document.documentElement
    ).getPropertyValue("--suka-brand");
    if (hasTokens) setShowFallback(false);
  }, []);

  const [kpis, setKpis] = useState({
    mealsThisWeek: 0,
    tasksToday: 0,
    sessionsThisWeek: 0,
    gardenTasksThisWeek: 0,
    animalTasksThisWeek: 0,
  });
  const [kpiLoading, setKpiLoading] = useState(true);

  const [favSessions, setFavSessions] = useState(() =>
    readFav(favKey.sessions)
  );
  const [favSchedules, setFavSchedules] = useState(() =>
    readFav(favKey.schedules)
  );

  const addFavSessionLocal = (s) => {
    const next = [...readFav(favKey.sessions).filter((x) => x.id !== s.id), s];
    writeFav(favKey.sessions, next);
    setFavSessions(next);
  };
  const removeFavSessionLocal = (id) => {
    const next = readFav(favKey.sessions).filter((x) => x.id !== id);
    writeFav(favKey.sessions, next);
    setFavSessions(next);
  };
  const addFavScheduleLocal = (s) => {
    const next = [...readFav(favKey.schedules).filter((x) => x.id !== s.id), s];
    writeFav(favKey.schedules, next);
    setFavSchedules(next);
  };
  const removeFavScheduleLocal = (id) => {
    const next = readFav(favKey.schedules).filter((x) => x.id !== id);
    writeFav(favKey.schedules, next);
    setFavSchedules(next);
  };

  const [geo, setGeo] = useState({ region: null, lat: null, lon: null });
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const ProfileStore = await import(
          /* @vite-ignore */ "@/store/ProfileStore"
        ).catch(() => null);
        const regionFromStore = ProfileStore?.useProfile?.getState?.()?.region;
        if (regionFromStore && alive)
          setGeo((g) => ({ ...g, region: regionFromStore }));
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            (pos) => {
              if (!alive) return;
              const { latitude, longitude } = pos.coords || {};
              setGeo((g) => ({
                ...g,
                lat: latitude ?? null,
                lon: longitude ?? null,
              }));
              fire("geo/updated", { latitude, longitude, source: "home" });
            },
            () => {},
            { enableHighAccuracy: false, timeout: 3000, maximumAge: 60000 }
          );
        }
      } catch {}
    })();
    return () => {
      alive = false;
    };
  }, []);

  // fetch KPIs from your stores
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const MealPlanStore = await import(
          /* @vite-ignore */ "@/store/MealPlanStore"
        ).catch(() => null);
        const CleaningStore = await import(
          /* @vite-ignore */ "@/store/CleaningStore"
        ).catch(() => null);
        const CookingStore = await import(
          /* @vite-ignore */ "@/store/CookingStore"
        ).catch(() => null);
        const GardenStore = await import(
          /* @vite-ignore */ "@/store/GardenStore"
        ).catch(() => null);
        const AnimalStore = await import(
          /* @vite-ignore */ "@/store/AnimalStore"
        ).catch(() => null);

        const mealsThisWeek =
          MealPlanStore?.useMealPlan?.getState?.().week?.items?.length ?? 0;
        const tasksToday =
          CleaningStore?.useCleaning?.getState?.().today?.tasks?.length ?? 0;
        const cook = CookingStore?.useCooking?.getState?.() ?? {};
        const sessionsThisWeek =
          cook?.week?.sessions?.length ?? cook?.schedule?.thisWeek?.length ?? 0;
        const gardenTasksThisWeek =
          GardenStore?.useGarden?.getState?.()?.thisWeek?.tasks?.length ??
          GardenStore?.useGarden?.getState?.()?.plan?.tasks?.length ??
          0;
        const animalTasksThisWeek =
          AnimalStore?.useAnimals?.getState?.()?.thisWeek?.tasks?.length ??
          AnimalStore?.useAnimals?.getState?.()?.plan?.tasks?.length ??
          0;

        if (alive)
          setKpis({
            mealsThisWeek,
            tasksToday,
            sessionsThisWeek,
            gardenTasksThisWeek,
            animalTasksThisWeek,
          });
      } finally {
        if (alive) setKpiLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  /* ---------------------------------------------------------------------- */
  /* helpers to talk to automation runtime                                  */
  /* ---------------------------------------------------------------------- */
  const scheduleViaRuntime = (payload) => {
    try {
      automation.emitEvent("automation.schedule.request", payload);
    } catch {
      fire("automation.schedule.request", payload);
    }
  };

  const runTemplateNow = (templateId, ctx = {}, meta = {}) => {
    try {
      automation.queue(templateId, { priority: 2, ctx, meta });
    } catch {
      fire("automation:intent", { intent: templateId, payload: ctx, meta });
    }
  };

  /* ---------------------------------------------------------------------- */
  /* navigation helpers                                                      */
  /* ---------------------------------------------------------------------- */
  const startMealPlanning = () => {
    fire("automation:intent", { intent: "mealplan/open", source: "home" });
    scheduleViaRuntime({
      title: "Daily Mealplan Refresh",
      templateId: "mealplan.session.generate",
      rule: { at: "06:30" },
      meta: { domain: "mealplan" },
      ctx: { source: "home" },
    });
    navigateTo("/meal-planning");
  };
  const startCleaning = () => {
    fire("automation:intent", { intent: "cleaning/open", source: "home" });
    scheduleViaRuntime({
      title: "AM Cleaning Routine",
      templateId: "cleaning.session.generate",
      rule: { at: "09:00" },
      meta: { domain: "cleaning" },
    });
    navigateTo("/cleaning");
  };
  const openCookingSchedule = () => {
    fire("automation:intent", {
      intent: "cooking/schedule/open",
      source: "home",
    });
    scheduleViaRuntime({
      title: "Batch Cooking – Sunday",
      templateId: "cooking.session.generate",
      rule: { at: "15:00", days: [0] }, // Sunday 3pm
      meta: { domain: "cooking" },
    });
    navigateTo("/cooking#schedule");
  };
  const openGarden = () => {
    scheduleViaRuntime({
      title: "Daily Garden Check",
      templateId: "garden.session.generate",
      rule: { at: "08:00" },
      meta: { domain: "garden" },
    });
    navigateTo("/garden");
  };
  const openAnimals = () => {
    scheduleViaRuntime({
      title: "Morning Animal Care",
      templateId: "animals.session.generate",
      rule: { at: "07:00" },
      meta: { domain: "animals" },
    });
    navigateTo("/animals");
  };

  /* ---------------------------------------------------------------------- */
  /* recent activity                                                         */
  /* ---------------------------------------------------------------------- */
  const [recent, setRecent] = useState([]);
  const pushRecent = (type, summary) =>
    setRecent((r) =>
      [{ t: new Date().toLocaleTimeString(), type, summary }, ...r].slice(0, 8)
    );

  /* ---------------------------------------------------------------------- */
  /* scan handlers                                                           */
  /* ---------------------------------------------------------------------- */
  const onProductScanned = async (result) => {
    pushRecent(
      "scan:product",
      result?.product?.name || result?.barcode || "Item scanned"
    );
    fire("scan/result", { source: "home", kind: "product", result });

    // push to scan store if present
    try {
      const useScan = (
        await import(
          /* @vite-ignore */ "@/app/features/scan-compare-trust/stores/useScanStore"
        ).catch(() => null)
      )?.useScanStore;
      useScan?.setState?.((s) => ({
        lastScan: result,
        history: [
          { ts: Date.now(), kind: "product", result },
          ...(s.history || []),
        ].slice(0, 50),
      }));
    } catch {}

    // tell automation to enrich
    fire("automation:intent", {
      intent: "scan/enrich",
      payload: { kind: "product", result },
      source: "home",
    });

    // ALSO: send domain-level schedule if user wants watch on that product
    scheduleViaRuntime({
      title: "Daily Price/Coupon Watch – last scan",
      templateId: "sct.session.generate",
      rule: { everyMinutes: 240 },
      meta: { domain: "scan-compare-trust" },
      ctx: {
        source: "home",
        watch: result?.product?.upc || result?.barcode || null,
      },
    });
  };

  const onSeedScanned = async (result) => {
    const summary = result?.variety
      ? `${result.variety} (${result.crop || "seed"})`
      : "Seed packet scanned";
    pushRecent("scan:seed", summary);
    fire("garden/seed/parsed", { source: "home", result });

    // update garden store if present
    try {
      const GardenStore = (
        await import(/* @vite-ignore */ "@/store/GardenStore").catch(() => null)
      )?.useGarden;
      GardenStore?.setState?.((s) => ({
        lastSeedScan: result,
        inbox: [
          { ts: Date.now(), type: "seed-scan", data: result },
          ...(s.inbox || []),
        ],
      }));
    } catch {}

    // tell automation we want planner to run
    fire("automation:intent", {
      intent: "garden/plan/generate-from-seed-scan",
      source: "home",
      payload: { result, geo },
    });

    // ALSO: schedule the garden session through the runtime’s remap
    scheduleViaRuntime({
      title: "Garden Session from Seed Scan",
      templateId: "garden.session.generate",
      rule: { at: "08:00" },
      meta: { domain: "garden" },
      ctx: { source: "home", seedScan: result, geo },
    });
  };

  /* ---------------------------------------------------------------------- */
  /* recipe / import handlers                                                */
  /* ---------------------------------------------------------------------- */
  const [pinterestUrl, setPinterestUrl] = useState("");
  const [genericUrl, setGenericUrl] = useState("");
  const [recipeUploading, setRecipeUploading] = useState(false);

  const importFromUrl = (url, kind = "generic") => {
    if (!/^https?:\/\//i.test(url)) return;
    const intent =
      kind === "pinterest" ? "recipes/import/pinterest" : "recipes/import/url";
    fire("automation:intent", { intent, source: "home", payload: { url } });
    pushRecent(
      "recipes:import",
      `${kind === "pinterest" ? "Pinterest" : "URL"} import started`
    );

    // ALSO: ask runtime to schedule import processor
    scheduleViaRuntime({
      title: kind === "pinterest" ? "Pinterest → Planner" : "URL → Planner",
      templateId: "import.session.process",
      rule: { everyMinutes: 180 },
      meta: { domain: "import", origin: kind },
      ctx: { url, origin: kind },
    });
  };

  const importFromPhoto = async (file) => {
    if (!file) return;
    setRecipeUploading(true);
    try {
      const dataUrl = await readFileAsDataURL(file);
      fire("automation:intent", {
        intent: "recipes/import/photo",
        source: "home",
        payload: { dataUrl, filename: file.name },
      });
      pushRecent("recipes:scan", `Photo uploaded: ${file.name}`);

      // schedule followup OCR/normalize pass
      scheduleViaRuntime({
        title: "OCR Recipe Photo",
        templateId: "import.session.process",
        rule: { everyMinutes: 120 },
        meta: { domain: "import", origin: "photo" },
        ctx: { filename: file.name },
      });
    } finally {
      setRecipeUploading(false);
    }
  };

  /* ---------------------------------------------------------------------- */
  /* animal planner (reasoner/orchestrator/shim)                             */
  /* ---------------------------------------------------------------------- */
  const [breedNotes, setBreedNotes] = useState(null);
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const reasoner = window.__suka?.reasoner;
        if (!reasoner || typeof reasoner.query !== "function") {
          if (!cancelled) setBreedNotes(null);
          return;
        }

        const res = await reasoner.query("animals/breeds-and-meat-estimates", {
          region: geo.region,
          lat: geo.lat,
          lon: geo.lon,
          mode: "demand-aware",
          includeBreeds: true,
          includeMeatEstimates: true,
          source: "home",
        });

        if (!cancelled && res) setBreedNotes(res);
        else if (!cancelled) setBreedNotes(null);
      } catch {
        if (!cancelled) setBreedNotes(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [geo.region, geo.lat, geo.lon]);

  /* ✅ home animal preferences */
  const [animalPrefs, setAnimalPrefs] = useState(() => readAnimalPrefs());
  const commonAnimals = useMemo(
    () => [
      "Chickens",
      "Ducks",
      "Turkeys",
      "Rabbits",
      "Goats",
      "Sheep",
      "Cattle",
      "Pigs",
      "Quail",
      "Bees",
    ],
    []
  );

  const toggleAnimal = (name) => {
    setAnimalPrefs((prev) => {
      const set = new Set(prev.selected || []);
      if (set.has(name)) set.delete(name);
      else set.add(name);
      const next = { ...prev, selected: Array.from(set) };
      writeAnimalPrefs(next);
      fire("animals/preferences.updated", { source: "home", prefs: next });
      return next;
    });
  };

  const setOtherAnimals = (val) => {
    setAnimalPrefs((prev) => {
      const next = { ...prev, other: val };
      writeAnimalPrefs(next);
      fire("animals/preferences.updated", { source: "home", prefs: next });
      return next;
    });
  };

  /* ---------------------------------------------------------------------- */
  /* scan favorites / schedules – now with automation fallback               */
  /* ---------------------------------------------------------------------- */
  const saveScanFavorite = async () => {
    // 1) try scan store
    try {
      const mod = await import(
        /* @vite-ignore */ "@/app/features/scan-compare-trust/stores/useScanStore"
      ).catch(() => null);
      const store = mod?.useScanStore?.getState?.();
      const active = store?.activeSessionId;
      const id =
        store?.saveFavoriteSession?.(active, "Home — Quick Scan") ??
        (crypto?.randomUUID?.() || String(Date.now()));

      // 2) ALSO tell automation so it’s in the global favorites bucket
      try {
        automation.saveFavoriteSession({
          id,
          title: "Home — Quick Scan",
          domain: "scan-compare-trust",
          savedFrom: "home",
        });
      } catch {}
      return id;
    } catch {
      // runtime-only path
      const id = crypto?.randomUUID?.() || String(Date.now());
      try {
        automation.saveFavoriteSession({
          id,
          title: "Home — Quick Scan",
          domain: "scan-compare-trust",
          savedFrom: "home",
        });
      } catch {}
      return id;
    }
  };

  const saveScanSchedule = async () => {
    // original local store path
    try {
      const mod = await import(
        /* @vite-ignore */ "@/app/features/scan-compare-trust/stores/useScanStore"
      ).catch(() => null);
      const store = mod?.useScanStore?.getState?.();
      const schedId =
        store?.saveScheduleForWatchlist?.({
          name: "My Price & Coupon Watch",
          rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
          payload: { stores: store?.prefs?.preferredStores || [] },
          tags: ["home", "watchlist"],
        }) ??
        (crypto?.randomUUID?.() || String(Date.now()));

      // ALSO push to automation as a canonical schedule
      scheduleViaRuntime({
        id: schedId,
        title: "My Price & Coupon Watch",
        templateId: "sct.session.generate",
        rule: { at: "09:00" },
        meta: { domain: "scan-compare-trust" },
        ctx: { stores: store?.prefs?.preferredStores || [] },
      });
      return schedId;
    } catch {
      // runtime-only path
      const sid = crypto?.randomUUID?.() || String(Date.now());
      scheduleViaRuntime({
        id: sid,
        title: "My Price & Coupon Watch",
        templateId: "sct.session.generate",
        rule: { at: "09:00" },
        meta: { domain: "scan-compare-trust" },
        ctx: {},
      });
      return sid;
    }
  };

  /* ---------------------------------- render ---------------------------------- */
  return (
    <div className="scan-bridge min-h-screen w-full bg-gradient-to-br from-slate-50 via-white to-slate-100 dark:from-gray-900 dark:to-gray-800">
      {showFallback && <FallbackStyles />}
      <LocalTightStyles />

      <main className="fold-pack mx-auto max-w-7xl px-4 md:px-6 lg:px-8 py-5 md:py-8 space-y-6 md:space-y-8">
        {/* HOUSEHOLD TODAY (Hero + Primary CTA + KPI Row) */}
        <DashboardSection
          id="hero-kpis"
          title="Your Household Today"
          subtitle="Calm, organized, and ready for what’s next."
          dense
          tone="alt"
        >
          <div className="home-hero-kpis">
            <div className="home-soft-wrap">
              <div className="home-hero-top">
                <div className="home-actions">
                  <button
                    type="button"
                    onClick={() => qa.open({ source: "Home" })}
                    className="btn"
                    title="Quick Add (works across meals, cleaning, cooking, garden, animals)"
                  >
                    Quick Add
                  </button>

                  <HomeActionMenu
                    onMealPlanning={startMealPlanning}
                    onCleaning={startCleaning}
                    onCooking={openCookingSchedule}
                    onGarden={openGarden}
                    onAnimals={openAnimals}
                  />

                  <div
                    className="home-actions-right"
                    style={{ marginLeft: "auto" }}
                  >
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => navigateTo("/calendar")}
                      title="Open Calendar"
                    >
                      Calendar
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => navigateTo("/storehouse")}
                      title="Open Storehouse"
                    >
                      Storehouse
                    </button>
                  </div>
                </div>

                <div className="home-muted text-sm">
                  Your dashboard shows what matters most first. Tap a card to
                  jump into that part of your household.
                </div>
              </div>
            </div>

            <div className="home-kpi-row">
              <KpiCard
                label="Meals planned"
                value={kpis.mealsThisWeek}
                loading={kpiLoading}
                onClick={startMealPlanning}
                title="Go to Meal Planning"
                icon="🍽️"
                hint="This week"
              />
              <KpiCard
                label="Today’s cleaning"
                value={kpis.tasksToday}
                loading={kpiLoading}
                onClick={startCleaning}
                title="Go to Cleaning"
                icon="🧼"
                hint="Today"
              />
              <KpiCard
                label="Cooking sessions"
                value={kpis.sessionsThisWeek}
                loading={kpiLoading}
                onClick={openCookingSchedule}
                title="Go to Cooking Schedule"
                icon="🍳"
                hint="This week"
              />
              <KpiCard
                label="Garden tasks"
                value={kpis.gardenTasksThisWeek}
                loading={kpiLoading}
                onClick={openGarden}
                title="Go to Garden"
                icon="🌿"
                hint="This week"
              />
              <KpiCard
                label="Animal tasks"
                value={kpis.animalTasksThisWeek}
                loading={kpiLoading}
                onClick={openAnimals}
                title="Go to Animals"
                icon="🐾"
                hint="This week"
              />
            </div>
          </div>
        </DashboardSection>

        {/* BRING THINGS INTO YOUR HOUSEHOLD */}
        <DashboardSection
          id="bring-into-household"
          title="Bring Things Into Your Household"
          subtitle="Scan products, turn seed packets into a plan, and import recipes — all of it can flow into Meals and Inventory."
          dense
          tone="alt"
        >
          {/* Pair 1: Scan + Seed */}
          <section id="scan-seed-grid" className="section-grid half">
            {/* Card 1: Scan • Compare • Trust */}
            <div id="scan" className="card">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold leading-tight">
                    Know What Comes Into Your Home
                  </h2>
                  <p className="text-xs text-[hsl(var(--text-subtle))]">
                    Scan items; we’ll check pricing, coupons, recalls, and
                    ingredients automatically. Results can flow to Meals and
                    Inventory.
                  </p>
                </div>
                <div className="btn-bar">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={saveScanFavorite}
                  >
                    Save Favorite
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={saveScanSchedule}
                  >
                    Save Watchlist
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 mt-2">
                <div className="card">
                  <div className="font-semibold mb-1">Product Scanner</div>
                  <Suspense
                    fallback={<div className="skeleton h-40 rounded-md" />}
                  >
                    <div className="Scanner">
                      <Scanner mode="product" onResult={onProductScanned} />
                    </div>
                  </Suspense>
                  <p className="text-xs mt-1 text-[hsl(var(--text-subtle))]">
                    Point at a barcode or choose a photo. We’ll enrich results
                    with live prices and coupon stacking when available.
                  </p>
                  <div className="btn-bar">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => navigateTo("/scan-compare-trust")}
                    >
                      Open Full Scan View
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() =>
                        fire("automation:intent", {
                          intent: "scan/clear-last",
                          source: "home",
                        })
                      }
                    >
                      Clear Last
                    </button>
                  </div>
                </div>

                <div className="card">
                  <div className="font-semibold mb-1">Last Scan Details</div>
                  <Suspense
                    fallback={<div className="skeleton h-40 rounded-md" />}
                  >
                    <ScanSheet compact />
                  </Suspense>
                </div>
              </div>
            </div>

            {/* Card 2: Seed Packet → Garden Plan */}
            <div id="seed-to-garden" className="card">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold leading-tight">
                    Turn Seeds Into a Garden Plan
                  </h2>
                  <p className="text-xs text-[hsl(var(--text-subtle))]">
                    OCR seed packets to auto-fill variety, sowing window, and
                    spacing. Applies to Garden Planner and syncs tasks.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 mt-2">
                <div className="card">
                  <div className="font-semibold mb-1">Seed-Packet Scanner</div>
                  <Suspense
                    fallback={<div className="skeleton h-40 rounded-md" />}
                  >
                    <div className="Scanner">
                      <Scanner mode="seed" onResult={onSeedScanned} />
                    </div>
                  </Suspense>
                  <div className="btn-bar">
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        fire("automation:intent", {
                          intent: "garden/plan/apply-inbox",
                          source: "home",
                        });
                        scheduleViaRuntime({
                          title: "Apply Seed Inbox to Garden",
                          templateId: "garden.session.generate",
                          rule: { at: "08:15" },
                          meta: { domain: "garden" },
                          ctx: { source: "home", action: "apply-inbox" },
                        });
                      }}
                    >
                      Apply to Garden Planner
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => navigateTo("/garden#planner")}
                    >
                      Open Garden Planner
                    </button>
                  </div>
                </div>

                <div className="card">
                  <div className="font-semibold mb-1">Seed Inbox</div>
                  <div className="text-sm text-[hsl(var(--text-subtle))]">
                    New seed scans land in your Garden inbox. Applying creates
                    or updates the season plan and tasks.
                  </div>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      fire("automation:intent", {
                        intent: "garden/plan/generate-from-seeds",
                        source: "home",
                        geo,
                      });
                      scheduleViaRuntime({
                        title: "Generate Plan from Seeds on Hand",
                        templateId: "garden.session.generate",
                        rule: { at: "08:30" },
                        meta: { domain: "garden" },
                        ctx: { geo, source: "home" },
                      });
                    }}
                  >
                    Generate Plan from Seeds on Hand
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* Pair 2: Recipes + Meat Animal Estimates (and Household Profile under Animals) */}
          <section className="section-grid half" style={{ marginTop: 14 }}>
            {/* Recipe importer card */}
            <div className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold leading-tight">
                    Bring Recipes Into Your Kitchen
                  </div>
                  <div className="text-xs text-[hsl(var(--text-subtle))]">
                    Paste a Pinterest pin/board or any recipe URL — or upload a
                    photo. Imported items flow to the Collector and can
                    auto-feed Meals, Garden, and Animals.
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
                <div className="card p-3 flex flex-col gap-2">
                  <label className="text-sm font-semibold">
                    Pinterest board or pin
                  </label>
                  <input
                    type="url"
                    inputMode="url"
                    className="input border rounded-md px-3 py-2"
                    placeholder="https://www.pinterest.com/your/board-or-pin"
                    value={pinterestUrl}
                    onChange={(e) => setPinterestUrl(e.target.value)}
                  />
                  <div className="btn-bar">
                    <button
                      type="button"
                      className="btn"
                      disabled={!/^https?:\/\//i.test(pinterestUrl)}
                      onClick={() => importFromUrl(pinterestUrl, "pinterest")}
                    >
                      Import
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => setPinterestUrl("")}
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div className="card p-3 flex flex-col gap-2">
                  <label className="text-sm font-semibold">
                    Any recipe/article URL
                  </label>
                  <input
                    type="url"
                    inputMode="url"
                    className="input border rounded-md px-3 py-2"
                    placeholder="https://example.com/recipe"
                    value={genericUrl}
                    onChange={(e) => setGenericUrl(e.target.value)}
                  />
                  <div className="btn-bar">
                    <button
                      type="button"
                      className="btn"
                      disabled={!/^https?:\/\//i.test(genericUrl)}
                      onClick={() => importFromUrl(genericUrl, "generic")}
                    >
                      Import
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => setGenericUrl("")}
                    >
                      Clear
                    </button>
                  </div>
                </div>

                <div className="card p-3 flex flex-col gap-2">
                  <label className="text-sm font-semibold">
                    Photo to recipe
                  </label>
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="input border rounded-md px-3 py-2"
                    onChange={(e) => importFromPhoto(e.target.files?.[0])}
                  />
                  <button
                    type="button"
                    className="btn"
                    disabled={recipeUploading}
                  >
                    {recipeUploading ? "Uploading…" : "Scan Photo"}
                  </button>
                  <p className="text-xs text-[hsl(var(--text-subtle))]">
                    We’ll OCR the photo, extract ingredients/steps, and send to
                    the Collector.
                  </p>
                </div>
              </div>

              <div className="mt-3">
                <RecipeConsolidatorCard />
              </div>
            </div>

            {/* Right column: Animals card + Household Profile under it */}
            <div className="space-y-3">
              {/* Meat animal estimates card */}
              <div className="card p-4">
                <div className="text-lg font-semibold leading-tight">
                  Meat Animal Estimates & Breed Ideas
                </div>
                <div className="text-xs text-[hsl(var(--text-subtle))]">
                  Draft herd/flock targets and suitable breeds for your
                  region—synced with demand from planned recipes.
                </div>

                {/* ✅ NEW: user input for desired animals */}
                <div className="card p-3" style={{ marginTop: 10 }}>
                  <div className="font-semibold" style={{ marginBottom: 6 }}>
                    What animals do you want to raise?
                  </div>
                  <div className="text-xs text-[hsl(var(--text-subtle))]">
                    Chickens are the gateway homestead animal—start there if
                    you’re new, then expand.
                  </div>

                  <div className="btn-bar" style={{ marginTop: 8 }}>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => toggleAnimal("Chickens")}
                      title="Add Chickens"
                    >
                      🐔 Add Chickens
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => {
                        const next = { selected: [], other: "" };
                        setAnimalPrefs(next);
                        writeAnimalPrefs(next);
                        fire("animals/preferences.updated", {
                          source: "home",
                          prefs: next,
                        });
                      }}
                      title="Clear animal preferences"
                    >
                      Clear
                    </button>
                  </div>

                  <div className="animal-row" style={{ marginTop: 10 }}>
                    {commonAnimals.map((a) => {
                      const on = (animalPrefs.selected || []).includes(a);
                      return (
                        <button
                          key={a}
                          type="button"
                          className={`animal-chip ${
                            on ? "animal-chip--on" : ""
                          }`}
                          onClick={() => toggleAnimal(a)}
                          title={on ? `Remove ${a}` : `Add ${a}`}
                        >
                          {a}
                        </button>
                      );
                    })}
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <label className="text-xs text-[hsl(var(--text-subtle))]">
                      Other animals (comma-separated)
                    </label>
                    <input
                      className="animal-input"
                      placeholder="ex: guinea fowl, alpacas, dairy cows"
                      value={animalPrefs.other}
                      onChange={(e) => setOtherAnimals(e.target.value)}
                    />
                  </div>

                  <div
                    className="text-xs text-[hsl(var(--text-subtle))]"
                    style={{ marginTop: 8 }}
                  >
                    Saved locally. The Animals planner can read this and tailor
                    breeds, schedules, and meat-yield estimates.
                  </div>
                </div>

                <div className="mt-3">
                  {!breedNotes ? (
                    <div className="text-sm text-[hsl(var(--text-subtle))]">
                      Pulling suggestions… If nothing appears, the animal
                      planner reasoner + shim will compute them once recipes or
                      region are set.
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {breedNotes?.summary ? (
                        <p className="text-sm">{breedNotes.summary}</p>
                      ) : null}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {(breedNotes?.breeds || []).map((b) => (
                          <div
                            key={`${b.species}-${b.name}`}
                            className="card p-3"
                          >
                            <div className="font-semibold">{b.species}</div>
                            <div className="text-sm">{b.name}</div>
                            {b.notes ? (
                              <div className="text-xs mt-1 text-[hsl(var(--text-subtle))]">
                                {b.notes}
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                      {breedNotes?.meatEstimates ? (
                        <div className="text-xs text-[hsl(var(--text-subtle))]">
                          Estimated annual yields & cull schedules available in
                          the Animals planner after generation.
                        </div>
                      ) : null}
                      <div className="btn-bar">
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            fire("automation:intent", {
                              intent: "animals/plan/apply-estimates",
                              source: "home",
                              payload: {
                                estimates: breedNotes?.meatEstimates ?? null,
                                breeds: breedNotes?.breeds ?? [],
                                desiredAnimals: animalPrefs,
                              },
                            });
                            scheduleViaRuntime({
                              title: "Animals – Apply Estimates",
                              templateId: "animals.session.generate",
                              rule: { at: "07:30" },
                              meta: { domain: "animals" },
                              ctx: {
                                estimates: breedNotes?.meatEstimates ?? null,
                                breeds: breedNotes?.breeds ?? [],
                                desiredAnimals: animalPrefs,
                              },
                            });
                          }}
                        >
                          Apply to Animals Planner
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => navigateTo("/animals#planner")}
                        >
                          Open Animals Planner
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* ✅ moved Household Profile under Meat Animal card */}
              <div className="card p-4">
                <div className="text-lg font-semibold leading-tight">
                  Household Profile
                </div>
                <div className="text-xs text-[hsl(var(--text-subtle))]">
                  Your vision powers planning across meals, cleaning, garden,
                  animals, and calendar.
                </div>
                <div className="mt-3">
                  <HouseholdProfile />
                </div>
              </div>
            </div>
          </section>
        </DashboardSection>

        {/* ACTIVITY (left below the paired cards, per request) */}
        <DashboardSection
          id="activity"
          title="Activity"
          subtitle="Inline tools update your other pages automatically. Here are your latest actions."
          dense
        >
          <ul className="text-sm space-y-1">
            {recent.length === 0 ? (
              <li className="text-[hsl(var(--text-subtle))]">
                No recent activity yet.
              </li>
            ) : (
              recent.map((e, i) => (
                <li key={`${e.type}-${i}`} className="flex items-center gap-2">
                  <span className="text-xs tabular-nums w-16 text-[hsl(var(--text-subtle))]">
                    {e.t}
                  </span>
                  <span className="chip chip--brand">{e.type}</span>
                  <span>{e.summary}</span>
                </li>
              ))
            )}
          </ul>
        </DashboardSection>

        {/* ✅ Mount QuickAddModal once (Home is OK; App root is even better later) */}
        <QuickAddModal />
      </main>
    </div>
  );
}
