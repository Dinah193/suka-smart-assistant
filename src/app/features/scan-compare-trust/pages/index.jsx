/* eslint-disable no-console */
// src/features/scan-compare-trust/pages/index.jsx
// Scan • Compare • Trust — Feature Landing (history, tips, prefs quick actions)

import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

/* ────────────────────────────── safe no-ops ─────────────────────────────── */
const NULL = Object.freeze({
  emit: () => {},
  track: () => {},
  get: (_p, fb) => (fb !== undefined ? fb : undefined),
});

/* ────────────────────────────── helpers ─────────────────────────────────── */
const isTruthy = (v) => String(v).toLowerCase() === "true";
const fmtDate = (iso) => {
  try { return new Date(iso).toLocaleString(); } catch { return iso || ""; }
};

function readDefaults(config, env = import.meta?.env || {}) {
  return {
    checks: {
      recalls: config?.get?.("enableRecallsCheck", true) ?? isTruthy(env?.VITE_FEATURE_ENABLE_RECALLS_CHECK ?? "true"),
      ingredients: config?.get?.("enableIngredientsCheck", true) ?? isTruthy(env?.VITE_FEATURE_ENABLE_INGREDIENTS_CHECK ?? "true"),
      coupons: config?.get?.("enableCoupons", true) ?? isTruthy(env?.VITE_FEATURE_ENABLE_COUPONS ?? "true"),
      priceCompare: config?.get?.("enablePriceCompare", true) ?? isTruthy(env?.VITE_FEATURE_ENABLE_PRICE_COMPARE ?? "true"),
    },
    providers: {
      sams: config?.get?.("coupons.providers.sams.enabled", true) ?? isTruthy(env?.VITE_PROVIDER_SAMS_ENABLED ?? "true"),
      costco: config?.get?.("coupons.providers.costco.enabled", true) ?? isTruthy(env?.VITE_PROVIDER_COSTCO_ENABLED ?? "true"),
      aldi: config?.get?.("coupons.providers.aldi.enabled", true) ?? isTruthy(env?.VITE_PROVIDER_ALDI_ENABLED ?? "true"),
    },
    camera: {
      mode: config?.get?.("scan.camera.mode", env?.VITE_SCAN_CAMERA_DEFAULT_MODE || "barcode+ocr"),
      torch: false,
    },
    ui: {
      sheet: config?.get?.("scan.ui.sheet", env?.VITE_SCAN_UI_SHEET || "compact"),
      haptics: config?.get?.("scan.ui.haptics", isTruthy(env?.VITE_SCAN_UI_HAPTICS ?? "true")),
      voice: config?.get?.("scan.ui.voice", isTruthy(env?.VITE_SCAN_UI_VOICE ?? "true")),
    }
  };
}

/* ────────────────────────────── component ───────────────────────────────── */
export default function ScanIndexPage(props = {}) {
  const DexieDB   = props.DexieDB   || (window?.DexieDB ?? null);
  const eventBus  = props.eventBus  || (window?.eventBus ?? NULL);
  const analytics = props.analytics || (window?.analytics ?? NULL);
  const config    = props.config    || (window?.config ?? NULL);
  const actions   = props.actions   || {}; // { saveFavorite, saveSessionSchedule, emit? }
  const navigate  = useNavigate();

  const defaults = useMemo(() => readDefaults(config), [config]);

  // Prefs snapshot (read-only glance; deep edits live in /settings)
  const [checks, setChecks] = useState(defaults.checks);
  const [providers, setProviders] = useState(defaults.providers);
  const [camera, setCamera] = useState(defaults.camera);
  const [ui, setUI] = useState(defaults.ui);

  // Data: history, favorites, sessions
  const [history, setHistory] = useState([]);      // DexieDB.scanHistory
  const [favorites, setFavorites] = useState([]);  // DexieDB.scanFavorites
  const [sessions, setSessions] = useState([]);    // DexieDB.scanSessions
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // hydrate from prefs if present
        if (DexieDB?.scanPrefs) {
          const doc = await DexieDB.scanPrefs.get("user:scan");
          if (doc) {
            setChecks(doc.checks || defaults.checks);
            setProviders(doc.providers || defaults.providers);
            setCamera(doc.camera || defaults.camera);
            setUI(doc.ui || defaults.ui);
          }
        }
        const [h, f, s] = await Promise.all([
          DexieDB?.scanHistory?.orderBy?.("createdAt")?.reverse()?.limit(30)?.toArray?.() || [],
          DexieDB?.scanFavorites?.where?.("owner")?.equals?.("user")?.reverse()?.limit(20)?.toArray?.() || [],
          DexieDB?.scanSessions?.where?.("owner")?.equals?.("user")?.reverse()?.limit(10)?.toArray?.() || [],
        ]);
        if (!alive) return;
        setHistory(h || []);
        setFavorites(f || []);
        setSessions(s || []);
      } catch (e) {
        console.warn("[ScanIndex] load failed", e);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DexieDB]);

  // Keyboard: Ctrl+K for command palette
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        eventBus.emit("command.palette.toggle", { source: "scan.index" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [eventBus]);

  const startScanNow = () => {
    const opts = { camera, checks, providers, ui };
    eventBus.emit("scan.start.requested", opts);
    analytics.track?.("scan_start_requested", { checks, providers });
    // If you have a dedicated live scanner route, navigate there:
    navigate("/scan/home", { replace: false });
  };

  const saveCurrentAsFavorite = async () => {
    const snapshot = { title: "My Scan Flow", camera, checks, providers, ui };
    if (typeof actions?.saveFavorite === "function") {
      await actions.saveFavorite(snapshot);
      // reload favorites list
      if (DexieDB?.scanFavorites) {
        const f = await DexieDB.scanFavorites.where("owner").equals("user").reverse().limit(20).toArray();
        setFavorites(f || []);
      }
    } else {
      eventBus.emit("session.saved.favorite", { type: "scan", snapshot });
    }
  };

  const scheduleScanSession = async () => {
    // 20-minute scan session block starting now; parent handles Sabbath/quiet hour shifts.
    const start = new Date();
    const end = new Date(start.getTime() + 20 * 60 * 1000);
    if (typeof actions?.saveSessionSchedule === "function") {
      const doc = await actions.saveSessionSchedule({
        title: "Scan & Compare Session",
        blocks: [{ start, end, title: "Scan • Compare • Trust", note: "Quick scan session", ref: { type: "scan.flow" } }],
      });
      if (doc?.id && DexieDB?.scanSessions) {
        const s = await DexieDB.scanSessions.where("owner").equals("user").reverse().limit(10).toArray();
        setSessions(s || []);
      }
    } else {
      eventBus.emit("schedule.saved.requested", {
        domain: "scan",
        blocks: [{ start, end, title: "Scan • Compare • Trust", note: "Quick scan session" }],
      });
    }
  };

  const applyFavorite = (fav) => {
    if (!fav) return;
    const snapshot = fav.snapshot || {};
    setChecks(snapshot.checks || checks);
    setProviders(snapshot.providers || providers);
    setCamera(snapshot.camera || camera);
    setUI(snapshot.ui || ui);
    eventBus.emit("scan.favorite.apply", { favoriteId: fav.id, snapshot });
    analytics.track?.("scan_favorite_applied", { favoriteId: fav.id });
  };

  /* ───────────── UI ───────────── */
  return (
    <div className="space-y-6">
      {/* Hero */}
      <section className="rounded-2xl border p-4 md:p-6 bg-white">
        <div className="flex flex-col md:flex-row md:items-center gap-4">
          <div className="grow">
            <h1 className="text-xl font-semibold">Scan • Compare • Trust</h1>
            <p className="text-sm opacity-70">
              Point, snap, and decide. Instantly check recalls, ingredients, coupons, and prices — then save your flow or schedule a session.
            </p>
          </div>
          <div className="flex gap-2">
            <button className="px-4 py-2 text-sm rounded-lg border hover:bg-neutral-50" onClick={startScanNow}>
              Start Scan
            </button>
            <button className="px-4 py-2 text-sm rounded-lg border hover:bg-neutral-50" onClick={() => navigate("/scan/compare")}>
              Compare
            </button>
            <button className="px-4 py-2 text-sm rounded-lg border hover:bg-neutral-50" onClick={() => navigate("/scan/trust")}>
              Trust
            </button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
          <QuickToggle label="Recalls"   value={checks.recalls}      onChange={(v)=>setChecks((c)=>({ ...c, recalls: v }))} />
          <QuickToggle label="Ingredients" value={checks.ingredients} onChange={(v)=>setChecks((c)=>({ ...c, ingredients: v }))} />
          <QuickToggle label="Coupons"   value={checks.coupons}      onChange={(v)=>setChecks((c)=>({ ...c, coupons: v }))} />
          <QuickToggle label="Price Compare" value={checks.priceCompare} onChange={(v)=>setChecks((c)=>({ ...c, priceCompare: v }))} />
        </div>
        <div className="mt-2 grid grid-cols-3 md:grid-cols-6 gap-2">
          <ProviderPill label="Sam's"  active={providers.sams}   onToggle={(v)=>setProviders((p)=>({ ...p, sams: v }))} />
          <ProviderPill label="Costco" active={providers.costco} onToggle={(v)=>setProviders((p)=>({ ...p, costco: v }))} />
          <ProviderPill label="ALDI"   active={providers.aldi}   onToggle={(v)=>setProviders((p)=>({ ...p, aldi: v }))} />
          <ModePill label={camera.mode === "barcode" ? "Barcode" : camera.mode === "ocr" ? "OCR" : "Barcode+OCR"} onClick={()=>{
            const seq = ["barcode+ocr","barcode","ocr"];
            const idx = seq.indexOf(camera.mode || "barcode+ocr");
            setCamera((c)=>({ ...c, mode: seq[(idx+1)%seq.length] }));
          }}/>
          <Pill label={ui.sheet === "cozy" ? "Cozy" : "Compact"} onClick={()=>setUI((u)=>({ ...u, sheet: u.sheet === "cozy" ? "compact" : "cozy" }))}/>
          <Pill label={ui.voice ? "Voice On" : "Voice Off"} onClick={()=>setUI((u)=>({ ...u, voice: !u.voice }))}/>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button className="px-3 py-1.5 text-xs rounded-lg border hover:bg-neutral-50" onClick={()=>navigate("/scan/settings")}>
            Preferences & Stores
          </button>
          <button className="px-3 py-1.5 text-xs rounded-lg border hover:bg-neutral-50" onClick={saveCurrentAsFavorite}>
            Save as Favorite Flow
          </button>
          <button className="px-3 py-1.5 text-xs rounded-lg border hover:bg-neutral-50" onClick={scheduleScanSession}>
            Schedule 20-min Session
          </button>
        </div>
      </section>

      {/* Recent History & Favorites */}
      <section className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-2xl border p-4 bg-white">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-base font-semibold">Recent Scans</h2>
            <button className="text-xs px-2 py-1.5 rounded-lg border hover:bg-neutral-50" onClick={()=>eventBus.emit("history.clear.requested", { domain: "scan" })}>
              Clear
            </button>
          </div>
          {loading ? <SkeletonList /> : (
            history?.length ? (
              <ul className="divide-y">
                {history.map((h) => (
                  <li key={h.id} className="py-2 flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg border grid place-items-center text-xs">{h.type?.toUpperCase?.() || "UPC"}</div>
                    <div className="min-w-0 grow">
                      <div className="text-sm font-medium truncate">{h.title || h.barcode || h.ocrPreview || "Untitled scan"}</div>
                      <div className="text-xs opacity-70 truncate">{h.meta?.stores?.join?.(", ") || h.meta?.providers?.join?.(", ") || "—"}</div>
                    </div>
                    <div className="text-xs opacity-60">{fmtDate(h.createdAt)}</div>
                  </li>
                ))}
              </ul>
            ) : <EmptyStateSmall title="No scans yet" subtitle="Start your first scan to see history here." action={{ label: "Start Scan", onClick: startScanNow }} />
          )}
        </div>

        <div className="rounded-2xl border p-4 bg-white">
          <h2 className="text-base font-semibold mb-2">Favorite Flows</h2>
          {loading ? <SkeletonList small /> : (
            favorites?.length ? (
              <ul className="space-y-2">
                {favorites.map((f) => (
                  <li key={f.id} className="border rounded-xl p-3">
                    <div className="text-sm font-medium truncate">{f.title || "Favorite"}</div>
                    <div className="text-xs opacity-70 truncate">
                      {(f.snapshot?.providers && Object.keys(f.snapshot.providers).filter(k=>f.snapshot.providers[k]).join(", ")) || "—"}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button className="px-2 py-1 text-xs rounded-lg border hover:bg-neutral-50" onClick={()=>applyFavorite(f)}>Apply</button>
                      <button className="px-2 py-1 text-xs rounded-lg border hover:bg-neutral-50" onClick={startScanNow}>Run</button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <EmptyStateSmall title="No favorites yet" subtitle="Configure your checks/providers, then save as a Favorite Flow." action={{ label: "Save current", onClick: saveCurrentAsFavorite }} />
          )}
        </div>
      </section>

      {/* Sessions + Tips */}
      <section className="grid lg:grid-cols-3 gap-6">
        <div className="rounded-2xl border p-4 bg-white">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold mb-2">Scheduled Sessions</h2>
            <button className="text-xs px-2 py-1.5 rounded-lg border hover:bg-neutral-50" onClick={scheduleScanSession}>+ Quick 20-min</button>
          </div>
          {loading ? <SkeletonList small /> : (
            sessions?.length ? (
              <ul className="space-y-2">
                {sessions.map((s) => (
                  <li key={s.id} className="border rounded-xl p-3">
                    <div className="text-sm font-medium truncate">{s.title || "Scan Session"}</div>
                    <div className="text-xs opacity-70">
                      {(s.schedule?.blocks || []).slice(0,1).map((b, i) => (
                        <span key={i}>{fmtDate(b.start)} — {b.title || "Scan session"}</span>
                      ))}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <button className="px-2 py-1 text-xs rounded-lg border hover:bg-neutral-50" onClick={startScanNow}>Start Now</button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : <EmptyStateSmall title="No sessions yet" subtitle="Schedule short scan blocks to keep price books fresh." action={{ label: "Schedule one", onClick: scheduleScanSession }} />
          )}
        </div>

        <div className="lg:col-span-2 rounded-2xl border p-4 bg-white">
          <h2 className="text-base font-semibold mb-2">Tips</h2>
          <ul className="grid md:grid-cols-2 gap-3 text-sm">
            <TipCard
              title="Use Favorites"
              body="Save your camera mode, checks, and provider mix as a Favorite Flow. Re-apply with one click before shopping."
              cta="Save current flow"
              onClick={saveCurrentAsFavorite}
            />
            <TipCard
              title="Stores & Loyalty"
              body="Enter loyalty IDs and order your stores. We’ll use that order when comparing prices and matching coupons."
              cta="Open preferences"
              onClick={()=>navigate("/scan/settings")}
            />
            <TipCard
              title="Ingredients & Recalls"
              body="Turn on ‘Ingredients’ and ‘Recalls’ checks to flag harmful additives and active recalls during scanning."
              cta={checks.ingredients && checks.recalls ? "Enabled ✓" : "Enable checks"}
              onClick={()=>setChecks((c)=>({ ...c, ingredients: true, recalls: true }))}
            />
            <TipCard
              title="Session Rhythm"
              body="Schedule a 20-minute weekly session. We’ll respect quiet hours & Sabbath guard automatically."
              cta="Schedule now"
              onClick={scheduleScanSession}
            />
          </ul>
        </div>
      </section>
    </div>
  );
}

/* ────────────────────────────── small UI bits ─────────────────────────────── */
function QuickToggle({ label, value, onChange }) {
  return (
    <button
      className={"px-3 py-2 rounded-lg border text-xs " + (value ? "bg-black text-white" : "hover:bg-neutral-50")}
      onClick={() => onChange?.(!value)}
    >
      {label}
    </button>
  );
}

function ProviderPill({ label, active, onToggle }) {
  return (
    <button
      className={"px-3 py-1.5 rounded-full border text-xs " + (active ? "bg-black text-white" : "hover:bg-neutral-50")}
      onClick={() => onToggle?.(!active)}
      title={active ? "Enabled" : "Disabled"}
    >
      {label}
    </button>
  );
}

function Pill({ label, onClick }) {
  return (
    <button className="px-3 py-1.5 rounded-full border text-xs hover:bg-neutral-50" onClick={onClick}>{label}</button>
  );
}

function ModePill({ label, onClick }) {
  return <Pill label={label} onClick={onClick} />;
}

function SkeletonList({ small }) {
  return (
    <div className={"animate-pulse space-y-2 " + (small ? "" : "mt-1")}>
      <div className="h-10 bg-neutral-100 rounded" />
      <div className="h-10 bg-neutral-100 rounded" />
      <div className="h-10 bg-neutral-100 rounded" />
    </div>
  );
}

function EmptyStateSmall({ title, subtitle, action }) {
  return (
    <div className="p-6 text-center border rounded-2xl">
      <div className="text-sm font-medium">{title}</div>
      {subtitle ? <div className="text-xs opacity-70 mt-1">{subtitle}</div> : null}
      {action ? (
        <button className="mt-3 px-3 py-1.5 text-xs rounded-lg border hover:bg-neutral-50" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function TipCard({ title, body, cta, onClick }) {
  return (
    <li className="border rounded-2xl p-3">
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs opacity-70 mt-1">{body}</div>
      <button className="mt-3 px-3 py-1.5 text-xs rounded-lg border hover:bg-neutral-50" onClick={onClick}>
        {cta}
      </button>
    </li>
  );
}
