// C:\Users\larho\suka-smart-assistant\src\pages\settings\index.jsx
import React, { Suspense, useEffect, useMemo, useState } from "react";
import { useRoutes } from "react-router-dom";
import getSettingsRoutes from "./routes.jsx";

/**
 * SettingsPage (host)
 * ---------------------------------------------------------------------------
 * - Renders nested settings routes via useRoutes(getSettingsRoutes("/settings"))
 * - Subscribes to Household Profile for initial readiness
 * - Listens to domain events and re-renders subtly on changes
 * - Consistent skeleton + error boundary
 */

// ---------- soft import (no hard crash if service missing) ----------
let Profile = null;
try {
  Profile = require("@/services/profile/householdProfileService");
} catch {
  Profile = { getProfile: async () => ({}), subscribe: () => () => {} };
}

// ✅ NEW (soft) import: Ads prefs + modal
let getAdsPrefs = null;
let setAdsPrefs = null;
try {
  // eslint-disable-next-line global-require
  const ads = require("@/services/ads/SponsoredPlacementService");
  getAdsPrefs = ads?.getAdsPrefs;
  setAdsPrefs = ads?.setAdsPrefs;
} catch {
  getAdsPrefs = () => ({
    sponsoredPlacementsEnabled: true,
    shareAdsTelemetry: false,
    premiumConversionProxy: false,
    explainersEnabled: true,
  });
  setAdsPrefs = (p) => ({ ...(getAdsPrefs() || {}), ...(p || {}) });
}

// lazy-load modal to avoid bundling it into every settings paint
const WhyThisAdModal = React.lazy(() =>
  import("@/components/ads/WhyThisAdModal").catch(() => ({
    default: () => null,
  }))
);

// ---------- UI helpers ----------
function Skeleton() {
  return (
    <div className="w-full max-w-7xl mx-auto px-4 md:px-0 py-4">
      <div className="animate-pulse h-8 w-64 bg-base-200 rounded-2xl mb-4" />
      <div className="grid gap-3">
        <div className="animate-pulse h-28 bg-base-200 rounded-2xl" />
        <div className="animate-pulse h-40 bg-base-200 rounded-2xl" />
        <div className="animate-pulse h-24 bg-base-200 rounded-2xl" />
      </div>
    </div>
  );
}

class ErrorBoundary extends React.Component {
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
        <div className="w-full max-w-5xl mx-auto px-4 md:px-0 py-6">
          <div className="card bg-base-100 border border-base-200 rounded-2xl shadow-sm">
            <div className="card-body">
              <h2 className="card-title">Something went wrong.</h2>
              <pre className="text-xs opacity-80 bg-base-200/60 rounded-xl p-3 overflow-auto">
                {String(this.state.error?.message || this.state.error)}
              </pre>
              <div className="mt-3">
                <button
                  className="btn btn-primary btn-sm rounded-2xl"
                  onClick={() => location.reload()}
                >
                  Reload
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    return <>{this.props.children}</>;
  }
}

// ✅ NEW: small Ads transparency card (host-level; minimal coupling)
function AdsTransparencyCard() {
  const [prefs, setPrefs] = useState(() => (getAdsPrefs ? getAdsPrefs() : {}));
  const [whyOpen, setWhyOpen] = useState(false);
  const [whyPayload, setWhyPayload] = useState(null);

  useEffect(() => {
    const onChanged = () => setPrefs(getAdsPrefs ? getAdsPrefs() : {});
    window.addEventListener("ads.preferences.changed", onChanged);

    // Allow any part of the app to open the modal with context:
    // window.dispatchEvent(new CustomEvent("ads.why.open",{detail:{ place, meta, filters, context }}))
    const onWhy = (e) => {
      setWhyPayload(e?.detail || null);
      setWhyOpen(true);
    };
    window.addEventListener("ads.why.open", onWhy);

    return () => {
      window.removeEventListener("ads.preferences.changed", onChanged);
      window.removeEventListener("ads.why.open", onWhy);
    };
  }, []);

  return (
    <div className="w-full max-w-7xl mx-auto px-4 md:px-0 pt-4">
      <div className="card bg-base-100 border border-base-200 rounded-2xl shadow-sm">
        <div className="card-body">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h2 className="card-title">Sponsored placements</h2>
              <p className="text-sm opacity-80 mt-1">
                SSA can show clearly-labeled sponsored local store cards that
                still match your filters (distance/category/open-now).
              </p>
            </div>

            <div className="flex items-center gap-3">
              <div className="flex flex-col items-end">
                <span className="text-xs opacity-70">
                  Enable sponsored cards
                </span>
                <input
                  type="checkbox"
                  className="toggle toggle-primary"
                  checked={!!prefs?.sponsoredPlacementsEnabled}
                  onChange={(e) => {
                    const next = setAdsPrefs
                      ? setAdsPrefs({
                          sponsoredPlacementsEnabled: e.target.checked,
                        })
                      : prefs;
                    setPrefs(next);
                  }}
                />
              </div>

              <button
                className="btn btn-ghost btn-sm rounded-2xl"
                onClick={() => setWhyOpen(true)}
                title="Why am I seeing this?"
              >
                Why am I seeing this?
              </button>
            </div>
          </div>

          <div className="mt-3 grid md:grid-cols-2 gap-3">
            <div className="p-3 rounded-2xl bg-base-200/60">
              <div className="text-sm font-semibold">Trust-safe rules</div>
              <ul className="text-sm mt-2 list-disc pl-5 space-y-1 opacity-90">
                <li>Caps per session (limits sponsored cards + impressions)</li>
                <li>No misleading placements — must be labeled “Sponsored”</li>
                <li>Must still match your current filters</li>
              </ul>
            </div>

            <div className="p-3 rounded-2xl bg-base-200/60">
              <div className="text-sm font-semibold">Privacy</div>
              <div className="text-sm mt-2 opacity-90">
                Telemetry is stored locally by default. You can opt-in inside
                the explainer modal.
              </div>
            </div>
          </div>
        </div>
      </div>

      <Suspense fallback={null}>
        <WhyThisAdModal
          open={whyOpen}
          onClose={() => setWhyOpen(false)}
          payload={whyPayload}
        />
      </Suspense>
    </div>
  );
}

// ---------- Component ----------
export default function SettingsPage() {
  const [ready, setReady] = useState(false);
  const [, setProfile] = useState(null); // trigger re-renders on updates

  // Initial profile load + live updates
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const p = await Profile.getProfile();
        if (mounted) {
          setProfile(p || {});
          setReady(true);
        }
      } catch {
        if (mounted) setReady(true); // still render routes even if profile fetch fails
      }
    })();
    const unsub = Profile.subscribe?.((p) => mounted && setProfile(p));
    return () => {
      mounted = false;
      unsub && unsub();
    };
  }, []);

  // Event glue: gently re-render when domain events occur
  useEffect(() => {
    const events = [
      "preferences.changed",
      "ads.preferences.changed", // ✅ NEW
      "recipe.consolidated",
      "inventory.updated",
      "calendar.synced",
      "garden.updated",
      "animal.updated",
    ];
    const bump = () => setProfile((prev) => ({ ...(prev || {}) })); // noop state change
    events.forEach((ev) => window.addEventListener(ev, bump));
    return () => events.forEach((ev) => window.removeEventListener(ev, bump));
  }, []);

  // Build routes once; useRoutes returns the element tree
  const routes = useMemo(() => getSettingsRoutes("/settings"), []);
  const element = useRoutes(routes);

  if (!ready) return <Skeleton />;

  return (
    <ErrorBoundary>
      {/* ✅ NEW: Ads transparency toggles at host level */}
      <AdsTransparencyCard />

      <Suspense fallback={<Skeleton />}>{element}</Suspense>
    </ErrorBoundary>
  );
}
