// src/pages/favorites/index.jsx
/**
 * SSA Favorites Page
 *
 * HOW THIS FITS:
 * - Shows a homestead-centric view of the user’s favorite sessions & plans
 *   across domains (meals, cleaning, garden, animals, preservation, storehouse).
 * - Does NOT run timers or heavy logic itself. Instead it:
 *     * Emits "session.play.requested" when the user taps a "Now" CTA.
 *     * Leaves SessionRunner + background shims to handle:
 *         - wake lock, notifications, Dexie persistence, auto-resume, etc.
 * - Safe if the user navigates away: the long-running session continues because
 *   the actual runner/modal lives at the app root and/or in automation/runtime.
 *
 * EXPECTED SUPPORTING PIECES (shim contract style):
 * - "@/services/automation/runtime": { emit(type, data) }
 *   → bridging to src/services/events/eventBus.js with payload { type, ts, source, data }.
 * - "@/stores/favoritesStore.js": useFavoritesStore()
 *   → returns { favorites, lastSessionHint } or a similar object.
 *   → This file includes a minimal contract note at the bottom.
 */

import React, { useMemo } from "react";
import { Link } from "react-router-dom";
// EASIEST SAFE FIX: remove bad emit import for now
// import { emit } from "@/services/automation/runtime";
import { useFavoritesStore } from "@/store/favoritesStore.js";

/**
 * Small helper to decide if a favorite can be played in SessionRunner.
 * We treat anything with a sessionId OR kind === "session" as runnable.
 *
 * @param {object} fav
 * @returns {boolean}
 */
function isRunnableFavorite(fav) {
  if (!fav) return false;
  if (fav.sessionId) return true;
  if (fav.kind === "session") return true;
  // Optional: treat recipes with generated sessions as runnable if they carry domain+id
  if (fav.domain && fav.id && fav.canGenerateSession) return true;
  return false;
}

/**
 * Emit a "play now" request.
 * This is a shim-style fire-and-forget call: the SessionRunner shim or runtime
 * is responsible for:
 *  - Looking up / creating the session object
 *  - Guard checks (sabbath, quiet hours, inventory, weather)
 *  - Opening the SessionRunner modal and managing background behavior
 *
 * @param {object} fav
 */
function handlePlayNow(fav) {
  if (!fav) return;

  const sessionId = fav.sessionId || fav.id;
  if (!sessionId) return;

  // EASIEST SAFE FIX: just log for now so the page loads without needing runtime.emit
  console.log("[Favorites] session.play.requested (stub)", {
    sessionId,
    domain: fav.domain || "storehouse",
    source: "ui.favorites.now",
    hint: {
      title: fav.title,
      fromFavorite: true,
      templateRef: fav.templateRef || null,
    },
  });

  // TODO: later wire this to eventBus or automationRuntime.handleEvent
  // emit("session.play.requested", {
  //   sessionId,
  //   domain: fav.domain || "storehouse",
  //   source: "ui.favorites.now",
  //   hint: {
  //     title: fav.title,
  //     fromFavorite: true,
  //     templateRef: fav.templateRef || null,
  //   },
  // });
}

/**
 * Simple badge by domain for visual grouping.
 *
 * @param {string} domain
 */
function DomainBadge({ domain }) {
  if (!domain) return null;

  const labelMap = {
    cooking: "Meals & Cooking",
    cleaning: "Cleaning",
    garden: "Garden",
    animals: "Animals",
    preservation: "Preservation",
    storehouse: "Storehouse",
  };

  const colorMap = {
    cooking: "badge-primary",
    cleaning: "badge-accent",
    garden: "badge-success",
    animals: "badge-warning",
    preservation: "badge-info",
    storehouse: "badge-neutral",
  };

  const label = labelMap[domain] || domain;
  const color = colorMap[domain] || "badge-outline";

  return <span className={`badge ${color} text-xs`}>{label}</span>;
}

function FavoriteCard({ fav }) {
  if (!fav) return null;

  const runnable = isRunnableFavorite(fav);

  return (
    <div className="card border shadow-sm hover:shadow-md transition-shadow duration-150">
      <div className="card-body p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <h3 className="font-semibold text-sm md:text-base">
              {fav.title || "Unnamed favorite"}
            </h3>
            {fav.subtitle && (
              <p className="text-xs opacity-70 mt-0.5">{fav.subtitle}</p>
            )}
          </div>
          <DomainBadge domain={fav.domain} />
        </div>

        {fav.notes && (
          <p className="text-xs md:text-sm opacity-80 line-clamp-3">
            {fav.notes}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2 mt-1">
          {fav.tags && fav.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {fav.tags.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className="badge badge-ghost badge-xs md:badge-sm"
                >
                  {tag}
                </span>
              ))}
              {fav.tags.length > 4 && (
                <span className="badge badge-ghost badge-xs">
                  +{fav.tags.length - 4}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="card-actions mt-3 flex justify-between items-center gap-2">
          <div className="flex gap-2">
            {runnable && (
              <button
                type="button"
                className="btn btn-xs md:btn-sm btn-primary"
                onClick={() => handlePlayNow(fav)}
              >
                Now
              </button>
            )}
            {fav.href && (
              <Link to={fav.href} className="btn btn-xs md:btn-sm btn-outline">
                Open
              </Link>
            )}
          </div>
          {fav.lastUsedAt && (
            <span className="text-[0.65rem] md:text-xs opacity-60">
              Last used:{" "}
              {new Date(fav.lastUsedAt).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Group favorites by domain for separate sections.
 *
 * @param {Array<object>} favorites
 */
function useFavoritesByDomain(favorites) {
  return useMemo(() => {
    const groups = {
      cooking: [],
      cleaning: [],
      garden: [],
      animals: [],
      preservation: [],
      storehouse: [],
      other: [],
    };

    (favorites || []).forEach((fav) => {
      const d = fav.domain;
      if (d && groups[d]) {
        groups[d].push(fav);
      } else {
        groups.other.push(fav);
      }
    });

    return groups;
  }, [favorites]);
}

export default function FavoritesPage() {
  const { favorites = [], lastSessionHint = null } = useFavoritesStore() || {};
  const grouped = useFavoritesByDomain(favorites);

  const hasAny = favorites && Array.isArray(favorites) && favorites.length > 0;

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Snapshot / Intro */}
      <section className="grid gap-4 md:gap-6 md:grid-cols-3">
        <div className="card border shadow-sm col-span-1">
          <div className="card-body p-4">
            <h1 className="text-lg md:text-xl font-semibold mb-1">
              Favorites & “Now” Sessions
            </h1>
            <p className="text-xs md:text-sm opacity-80">
              Pin the plans, sessions, and tools your household leans on most.
              Start any runnable favorite with a single{" "}
              <span className="font-semibold">Now</span> button — the
              SessionRunner will keep it alive in the background.
            </p>
          </div>
        </div>

        <div className="card border shadow-sm col-span-1">
          <div className="card-body p-4 space-y-2">
            <h2 className="text-sm md:text-base font-semibold">
              Session Runner Status
            </h2>
            {lastSessionHint?.status === "running" ? (
              <>
                <p className="text-xs md:text-sm opacity-80">
                  A session is currently in progress.
                </p>
                <p className="text-xs md:text-sm">
                  <span className="font-semibold">
                    {lastSessionHint.title || "Active session"}
                  </span>
                  {lastSessionHint.domain && (
                    <span className="opacity-70">
                      {" "}
                      • {lastSessionHint.domain}
                    </span>
                  )}
                </p>
                <div className="card-actions mt-2">
                  <button
                    type="button"
                    className="btn btn-xs md:btn-sm btn-outline"
                    onClick={() => {
                      // EASIEST SAFE FIX: stubbed focus request
                      console.log(
                        "[Favorites] session.runner.focus.requested (stub)",
                        { source: "ui.favorites.snapshot" }
                      );
                      // TODO: later wire to automationRuntime/eventBus
                      // emit("session.runner.focus.requested", {
                      //   source: "ui.favorites.snapshot",
                      // });
                    }}
                  >
                    Bring Runner to Front
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="text-xs md:text-sm opacity-80">
                  No session is actively running. Start a favorite session and
                  the runner will appear as a full-screen modal, staying active
                  across navigation.
                </p>
              </>
            )}
          </div>
        </div>

        <div className="card border shadow-sm col-span-1">
          <div className="card-body p-4 space-y-2">
            <h2 className="text-sm md:text-base font-semibold">
              Quick Add Ideas
            </h2>
            <p className="text-xs md:text-sm opacity-80">
              As you use SSA, look for <span className="font-semibold">★</span>{" "}
              icons on sessions and plans:
            </p>
            <ul className="list-disc list-inside text-xs md:text-sm opacity-80 space-y-1">
              <li>Favorite your weekly meal plan or batch session.</li>
              <li>Pin a garden care routine or animal chore loop.</li>
              <li>Save preservation “days” and storehouse top-up plans.</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Empty state */}
      {!hasAny && (
        <section className="card border p-6">
          <h2 className="text-base md:text-lg font-semibold mb-2">
            No favorites yet
          </h2>
          <p className="text-xs md:text-sm opacity-80 mb-4">
            As you build meal plans, cleaning rhythms, garden and animal care,
            you can mark key sessions or templates as favorites. They’ll show up
            here as “one tap” Now sessions.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link className="btn btn-sm" to="/tier2/household/meals">
              Open Meal Planner
            </Link>
            <Link className="btn btn-sm" to="/tier2/household/meals#batch">
              Batch Cooking Sessions
            </Link>
            <Link className="btn btn-sm" to="/tier2/garden">
              Garden Dashboard
            </Link>
            <Link className="btn btn-sm" to="/tier2/animals">
              Animal Care & Butchery
            </Link>
            <Link className="btn btn-sm" to="/tier2/storehouse">
              Storehouse Targets
            </Link>
          </div>
        </section>
      )}

      {/* Favorites by domain */}
      {hasAny && (
        <section className="space-y-6">
          {/* Cooking */}
          {grouped.cooking.length > 0 && (
            <DomainSection
              title="Meals & Cooking"
              description="Favorite meal plans, cooking sessions, and feast-day menus."
              items={grouped.cooking}
            />
          )}

          {/* Cleaning */}
          {grouped.cleaning.length > 0 && (
            <DomainSection
              title="Cleaning & Zones"
              description="Pinned declutter sessions, zone routines, and reset checklists."
              items={grouped.cleaning}
            />
          )}

          {/* Garden */}
          {grouped.garden.length > 0 && (
            <DomainSection
              title="Garden"
              description="Bed prep, watering cycles, and harvest sessions you rely on."
              items={grouped.garden}
            />
          )}

          {/* Animals */}
          {grouped.animals.length > 0 && (
            <DomainSection
              title="Animals"
              description="Feeding, milking, breeding, and butchery sessions."
              items={grouped.animals}
            />
          )}

          {/* Preservation */}
          {grouped.preservation.length > 0 && (
            <DomainSection
              title="Preservation"
              description="Canning, dehydrating, curing, and other preservation days."
              items={grouped.preservation}
            />
          )}

          {/* Storehouse */}
          {grouped.storehouse.length > 0 && (
            <DomainSection
              title="Storehouse & Provisioning"
              description="Top-up plans, bulk buy events, and rotation check sessions."
              items={grouped.storehouse}
            />
          )}

          {/* Other */}
          {grouped.other.length > 0 && (
            <DomainSection
              title="Other favorites"
              description="Tools or flows that don’t fit a single domain but matter to your home."
              items={grouped.other}
            />
          )}
        </section>
      )}
    </div>
  );
}

/**
 * Simple reusable domain section.
 */
function DomainSection({ title, description, items }) {
  if (!items || items.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex flex-col md:flex-row md:items-baseline md:justify-between gap-1">
        <h2 className="text-base md:text-lg font-semibold">{title}</h2>
        <p className="text-xs md:text-sm opacity-75">{description}</p>
      </div>
      <div className="grid gap-3 md:gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((fav) => (
          <FavoriteCard key={fav.id || fav.sessionId} fav={fav} />
        ))}
      </div>
    </div>
  );
}

/* ==========================================================================
   FAVORITES STORE CONTRACT (REFERENCE / TODO)
   --------------------------------------------------------------------------
   Expected shape from "@/stores/favoritesStore.js":

   export function useFavoritesStore(){
     // Designed like a simple Zustand or context selector.
     return {
       favorites: [
         {
           id: "fav-123",
           sessionId: "session-abc",      // optional, for directly runnable sessions
           domain: "cooking",             // "cooking|cleaning|garden|animals|preservation|storehouse"
           title: "Weeknight Batch: 3 Dinners",
           subtitle: "Batch session from Meal Planner",
           notes: "Cook once, eat 3 nights; uses current storehouse inventory.",
           href: "/tier2/household/meals?session=session-abc",
           kind: "session",               // or "template", etc.
           tags: ["batch", "simple", "family-favorite"],
           lastUsedAt: "2025-11-01T18:00:00Z",
           templateRef: null,
           canGenerateSession: true       // if runtime can turn this into a session
         },
         // ...
       ],
       lastSessionHint: {
         status: "running|paused|idle",
         title: "Weeknight Batch: 3 Dinners",
         domain: "cooking",
       },
     };
   }

   You can adjust this contract as needed, but keep the key idea:
   - Favorites page is a thin UI shim that emits:
       "session.play.requested"
       "session.runner.focus.requested"
     and lets the background SessionRunner + shims do the heavy lifting.
========================================================================== */
