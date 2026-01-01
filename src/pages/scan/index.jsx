/* eslint-disable no-console */
// src/pages/scan/index.jsx
// Scan • Compare • Trust — top-level page shell + nested routes bridge
// Goals met:
// - Lazy routes to src/features/scan-compare-trust/pages/index.jsx
// - User-owned favorites & sessions (separate from system templates)
// - Event-driven: emits canonical events to orchestration/runtime
// - Quiet hours + Sabbath guard respected when scheduling sessions
// - Works standalone; all deps optional via props or global singletons

import React, { Suspense, useMemo, useRef, useEffect, useState } from "react";
import {
  Routes,
  Route,
  NavLink,
  useLocation,
  useNavigate,
} from "react-router-dom";

// ────────────────────────────── lazy feature pages ─────────────────────────────
const FeatureIndex = React.lazy(() =>
  import("../../app/features/scan-compare-trust/pages/index.jsx")
);

// (Optional) leaf routes if you split later; safe to keep here.
const ComparePage = React.lazy(() =>
  import("../../app/features/scan-compare-trust/pages/compare.js").catch(
    () => ({ default: Stub })
  )
);
const TrustPage = React.lazy(() =>
  import("../../app/features/scan-compare-trust/pages/trust.js").catch(() => ({
    default: Stub,
  }))
);

// ────────────────────────────── tiny no-op fallbacks ──────────────────────────
const NULL = Object.freeze({
  emit: () => {},
  track: () => {},
  get: (_path, fb) => (fb !== undefined ? fb : undefined),
});
function Stub() {
  return <div className="p-6 text-sm opacity-70">Coming soon…</div>;
}

// ────────────────────────────── utilities ─────────────────────────────────────
const now = () => new Date();
const clampHour = (d, quietHours) => {
  if (!quietHours) return d;
  const out = new Date(d);
  const [startH = 22, endH = 7] = quietHours;
  const h = out.getHours();
  const inside = (startH <= h && h <= 23) || (0 <= h && h < endH);
  if (inside) out.setHours(endH, 5, 0, 0);
  return out;
};
const withinSabbath = (d, sabbathGuard) => {
  if (!sabbathGuard?.enabled) return false;
  const dow = d.getDay(); // 0..6
  const hr = d.getHours();
  if (dow === 5 && hr >= 16) return true; // Fri eve
  if (dow === 6 && hr < 21) return true; // Sat till ~9p
  return false;
};

// ────────────────────────────── favorites/session helpers ─────────────────────
async function saveFavoriteSession(DexieDB, payload) {
  if (!DexieDB?.scanFavorites) return { ...payload, id: undefined };
  const id = await DexieDB.scanFavorites.put({
    ...payload,
    owner: "user",
    createdAt: new Date().toISOString(),
  });
  return { ...payload, id };
}
async function saveRunSession(DexieDB, payload) {
  if (!DexieDB?.scanSessions) return { ...payload, id: undefined };
  const id = await DexieDB.scanSessions.put({
    ...payload,
    owner: "user",
    createdAt: new Date().toISOString(),
  });
  return { ...payload, id };
}
async function listFavorites(DexieDB, { owner = "user" } = {}) {
  if (!DexieDB?.scanFavorites) return [];
  return DexieDB.scanFavorites.where("owner").equals(owner).reverse().toArray();
}

// ────────────────────────────── Error boundary ────────────────────────────────
class PageErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="p-6">
          <h2 className="text-lg font-semibold mb-2">Something went wrong</h2>
          <pre className="text-xs bg-neutral-100 p-3 rounded">
            {String(this.state.error)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// ────────────────────────────── Page Shell ────────────────────────────────────
export default function ScanPage(props = {}) {
  // Optional DI (all safe no-ops when absent)
  const DexieDB = props.DexieDB || (window?.DexieDB ?? null);
  const eventBus = props.eventBus || (window?.eventBus ?? NULL);
  const analytics = props.analytics || (window?.analytics ?? NULL);
  const config = props.config || (window?.config ?? NULL);
  const automation = props.automation || (window?.automation ?? null);

  const sabbathGuard =
    config?.sabbathGuard || config?.get?.("sabbathGuard", { enabled: false });
  const quietHours = config?.quietHours || config?.get?.("quietHours", [22, 7]);

  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [favList, setFavList] = useState([]);
  const [saving, setSaving] = useState(false);

  // Load favorites (user-owned)
  useEffect(() => {
    let alive = true;
    (async () => {
      const list = await listFavorites(DexieDB);
      if (alive) setFavList(list || []);
    })();
    return () => {
      alive = false;
    };
  }, [DexieDB]);

  // Deep link: /scan -> /scan/home
  useEffect(() => {
    if (pathname === "/scan") navigate("/scan/home", { replace: true });
  }, [pathname, navigate]);

  // Keyboard shortcuts (like “well executed” UIs)
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        eventBus.emit("command.palette.toggle", { source: "scan" });
      }
      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        eventBus.emit("help.panel.opened", { topic: "scan" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [eventBus]);

  // Save current scan “session” to calendar (respects quiet + sabbath)
  const saveSessionSchedule = async ({
    title = "Scan Session",
    blocks = [],
    calendarId = "primary",
  }) => {
    const adjusted = (blocks || []).map((b) => {
      const s = clampHour(new Date(b.start), quietHours);
      const shifted = withinSabbath(s, sabbathGuard);
      return {
        ...b,
        start: (shifted
          ? new Date(
              s.setDate(s.getDate() + ((6 - s.getDay() + 7) % 7))
            ).setHours(21, 0, 0, 0)
          : s
        ).toString(),
        note:
          (b.note || "") +
          (shifted ? " (auto-shifted for Sabbath/quiet hours)" : ""),
      };
    });

    const doc = await saveRunSession(DexieDB, {
      title,
      schedule: { calendarId, blocks: adjusted },
      domain: "scan",
    });

    if (automation?.scheduleBlocks) {
      try {
        await automation.scheduleBlocks(adjusted, {
          calendarId,
          domain: "scan",
        });
      } catch (e) {
        console.warn("[scan.jsx] automation.scheduleBlocks failed:", e);
      }
    }

    eventBus.emit("schedule.saved", {
      domain: "scan",
      sessionId: doc.id,
      blocks: adjusted,
    });
    analytics.track?.("scan_schedule_saved", {
      sessionId: doc.id,
      count: adjusted.length,
    });
    return doc;
  };

  // Save a favorite flow config (camera + providers + checks toggles)
  const handleSaveFavorite = async (snapshot) => {
    setSaving(true);
    try {
      const payload = await saveFavoriteSession(DexieDB, {
        title: snapshot?.title || "Favorite Scan Flow",
        owner: "user",
        snapshot: {
          camera: snapshot?.camera ?? { mode: "barcode+ocr", torch: false },
          checks: snapshot?.checks ?? {
            recalls: true,
            ingredients: true,
            coupons: true,
            priceCompare: true,
          },
          providers: snapshot?.providers ?? {
            sams: true,
            costco: true,
            aldi: true,
          },
          ui: snapshot?.ui ?? { sheet: "compact", haptics: true, voice: true },
        },
      });
      setFavList([payload, ...favList]);
      eventBus.emit("session.saved.favorite", {
        type: "scan",
        favoriteId: payload.id,
      });
      analytics.track?.("scan_favorite_saved", { favoriteId: payload.id });
    } finally {
      setSaving(false);
    }
  };

  // CTA blocks that other subpages can call through context
  const actions = useMemo(
    () => ({
      saveFavorite: handleSaveFavorite,
      saveSessionSchedule,
      emit: eventBus.emit,
    }),
    [handleSaveFavorite, saveSessionSchedule, eventBus.emit]
  );

  return (
    <div className="min-h-[calc(100vh-64px)]">
      <HeaderBar saving={saving} />

      <nav className="sticky top-0 bg-white/70 backdrop-blur border-b">
        <div className="max-w-6xl mx-auto flex items-center gap-2 px-4 h-12">
          <Tab to="/scan/home" label="Scan" />
          <Tab to="/scan/compare" label="Compare" />
          <Tab to="/scan/trust" label="Trust" />
          <div className="ml-auto flex items-center gap-2">
            <ShortcutHint />
            <FavDropdown
              favs={favList}
              onPick={(fav) => {
                // Rehydrate favorite snapshot into the feature index
                eventBus.emit("scan.favorite.apply", {
                  favoriteId: fav?.id,
                  snapshot: fav?.snapshot,
                });
                analytics.track?.("scan_favorite_applied", {
                  favoriteId: fav?.id,
                });
              }}
            />
            <SaveFavoriteButton onClick={() => actions.saveFavorite()} />
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-4">
        <PageErrorBoundary>
          <Suspense fallback={<PageSkeleton />}>
            <Routes>
              {/* Feature Index (routes to /features/... index.jsx) */}
              <Route
                path="home"
                element={
                  <FeatureIndex
                    // pass DI + CTA so the feature page can emit and save
                    DexieDB={DexieDB}
                    eventBus={eventBus}
                    analytics={analytics}
                    config={config}
                    automation={automation}
                    actions={actions}
                    // Default toggles that reflect recent chats/goals
                    defaultChecks={{
                      recalls: true,
                      ingredients: true,
                      coupons: true,
                      priceCompare: true,
                    }}
                    defaultProviders={{ sams: true, costco: true, aldi: true }}
                    defaultCamera={{ mode: "barcode+ocr", torch: false }}
                    defaultUI={{ sheet: "compact", haptics: true, voice: true }}
                  />
                }
              />
              <Route path="compare" element={<ComparePage />} />
              <Route path="trust" element={<TrustPage />} />
            </Routes>
          </Suspense>
        </PageErrorBoundary>
      </main>
    </div>
  );
}

// ────────────────────────────── UI bits (small, dependency-light) ─────────────
function HeaderBar({ saving }) {
  return (
    <header className="bg-white border-b">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-xl border">
            {/* minimalist icon */}
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
              <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" />
            </svg>
          </span>
          <h1 className="text-base font-semibold">Scan • Compare • Trust</h1>
          {saving ? (
            <span className="ml-2 text-xs opacity-70">Saving…</span>
          ) : null}
        </div>
        <div className="text-xs opacity-70">Suka Smart Assistant</div>
      </div>
    </header>
  );
}

function Tab({ to, label }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        "px-3 py-1.5 rounded-lg text-sm " +
        (isActive ? "bg-black text-white" : "hover:bg-neutral-100")
      }
    >
      {label}
    </NavLink>
  );
}

function ShortcutHint() {
  return (
    <span
      title="Open Command Palette"
      className="hidden sm:inline-flex items-center gap-2 text-xs px-2 py-1 border rounded-md"
      onClick={() =>
        window?.eventBus?.emit?.("command.palette.toggle", { source: "scan" })
      }
      role="button"
    >
      <kbd className="px-1.5 py-0.5 border rounded">Ctrl</kbd>+
      <kbd className="px-1.5 py-0.5 border rounded">K</kbd>
    </span>
  );
}

function SaveFavoriteButton({ onClick }) {
  return (
    <button
      onClick={onClick}
      className="text-xs px-3 py-1.5 rounded-lg border hover:bg-neutral-50"
      title="Save as Favorite Flow"
    >
      Save Favorite
    </button>
  );
}

function FavDropdown({ favs = [], onPick }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  useEffect(() => {
    const onDoc = (e) => {
      if (!btnRef.current) return;
      if (!btnRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);
  return (
    <div className="relative" ref={btnRef}>
      <button
        className="text-xs px-3 py-1.5 rounded-lg border hover:bg-neutral-50"
        onClick={() => setOpen((v) => !v)}
        title="Apply a Favorite Flow"
      >
        Favorites
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-64 bg-white border rounded-lg shadow">
          <ul className="max-h-72 overflow-auto text-sm">
            {favs.length === 0 ? (
              <li className="px-3 py-2 text-xs opacity-60">No favorites yet</li>
            ) : (
              favs.map((f) => (
                <li key={f.id}>
                  <button
                    className="w-full text-left px-3 py-2 hover:bg-neutral-50"
                    onClick={() => {
                      setOpen(false);
                      onPick?.(f);
                    }}
                  >
                    <div className="font-medium truncate">
                      {f.title || "Favorite"}
                    </div>
                    <div className="text-xs opacity-60">
                      {(f.snapshot?.providers &&
                        Object.keys(f.snapshot.providers)
                          .filter((k) => f.snapshot.providers[k])
                          .join(", ")) ||
                        "providers: —"}
                    </div>
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="animate-pulse space-y-3">
      <div className="h-8 w-40 bg-neutral-100 rounded" />
      <div className="h-40 bg-neutral-100 rounded" />
      <div className="h-40 bg-neutral-100 rounded" />
    </div>
  );
}
