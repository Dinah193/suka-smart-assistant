/* eslint-disable no-console */
/**
 * SafetyBadges — Scan • Compare • Trust
 * -----------------------------------------------------------------------------
 * Purposes:
 *  - Collapse safety signals into readable badges:
 *      • Recall (severity + authority, e.g., FDA/USDA/CPSC) with date
 *      • Allergens (user-household profile aware if hook exists)
 *      • Harmful Ingredients (e.g., additives list, watchlists)
 *      • Clean Labels (e.g., organic, non-GMO) for balance
 *  - Expandable details panel (inline popover) with sources & actions
 *  - Orchestration:
 *      • Emits events for history/detail drawers, etc.
 *      • Analytics tracking
 *      • Save as Favorite Schedule (monitor recalls/alerts)
 *      • Save as Favorite Session (replacement run)
 *
 * Expected 'item' shape (best-effort; normalize defensively):
 * {
 *   id, upc, name, brand,
 *   badges?: string[], // 'organic','non_gmo','recall','harmful'
 *   safety?: {
 *     recalls?: [{
 *       id, authority: 'FDA'|'USDA'|'CPSC'|string,
 *       severity: 'info'|'low'|'moderate'|'high'|'critical',
 *       reason?: string,
 *       affectedLots?: string[],
 *       announcedISO?: string,
 *       updatedISO?: string,
 *       sources?: [{label?: string, url?: string}]
 *     }],
 *     allergensDetected?: string[],       // from label/scan
 *     allergensUserRisk?: string[],       // intersect with household profile (if any)
 *     harmfulIngredients?: [{
 *       name, category?: string, risk?: 'low'|'moderate'|'high', source?: string
 *     }],
 *     clean?: string[] // 'organic','non_gmo','no_artificial_colors', etc.
 *   }
 * }
 */

import React, { useMemo, useState } from "react";

/* ------------------------------ Optional deps (defensive) ------------------------------ */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let analytics = { track: () => {} };
try {
  const a = require("@/services/analytics");
  analytics = (a && (a.default || a.analytics || a)) || analytics;
} catch (_e) {}

/** Household allergens hook (optional): returns { list: string[] } */
let useHouseholdAllergens = null;
try {
  ({ useHouseholdAllergens } = require("@/hooks/useHouseholdAllergens"));
} catch (_e) {}

let useFavoriteSchedules = null;
let useFavoriteSessions = null;
try {
  ({ useFavoriteSchedules } = require("@/hooks/useFavoriteSchedules"));
} catch (_e) {}
try {
  ({ useFavoriteSessions } = require("@/hooks/useFavoriteSessions"));
} catch (_e) {}

/* --------------------------------------- UI utils -------------------------------------- */
const tone = {
  neutral: "border-gray-300 text-gray-700",
  info: "border-sky-300 text-sky-700",
  low: "border-amber-300 text-amber-700",
  moderate: "border-orange-300 text-orange-700",
  high: "border-red-300 text-red-700",
  critical: "border-rose-400 text-rose-800",
  good: "border-emerald-300 text-emerald-700",
};

const badge = (key, label, cls, extra = {}) => (
  <span
    key={key}
    className={`inline-block text-[10px] px-1.5 py-0.5 rounded-md border ${cls}`}
    style={{ marginRight: 6, marginBottom: 6 }}
    {...extra}
  >
    {label}
  </span>
);

const fmtDate = (iso) => {
  try {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString();
  } catch {
    return null;
  }
};

/* ----------------------------------- Normalizers ----------------------------------- */
function normalize(item = {}, householdAllergens = []) {
  const s = item.safety || {};
  const recalls = Array.isArray(s.recalls) ? s.recalls : [];
  const allergensDetected = (s.allergensDetected || []).map((x) =>
    String(x).toLowerCase()
  );
  const householdSet = new Set(
    (householdAllergens || []).map((x) => String(x).toLowerCase())
  );
  const allergensUserRisk = allergensDetected.filter((a) =>
    householdSet.has(a)
  );

  const harmfulIngredients = Array.isArray(s.harmfulIngredients)
    ? s.harmfulIngredients
    : [];
  const clean = Array.isArray(s.clean) ? s.clean : [];

  return {
    recalls,
    allergensDetected,
    allergensUserRisk,
    harmfulIngredients,
    clean,
  };
}

/* ----------------------------------- Popover UI ----------------------------------- */
function Popover({ open, onClose, children }) {
  if (!open) return null;
  return (
    <div className="relative z-10">
      <div className="absolute mt-2 min-w-[280px] max-w-[420px] rounded-xl border bg-white p-3 shadow-xl">
        <div className="flex justify-end">
          <button
            className="text-xs px-2 py-1 border rounded-md hover:shadow-sm"
            onClick={onClose}
            title="Close"
          >
            ✕
          </button>
        </div>
        <div className="mt-1">{children}</div>
      </div>
    </div>
  );
}

/* ---------------------------------- Action Buttons --------------------------------- */
function WatchScheduleButton({ item }) {
  const fav = useFavoriteSchedules ? useFavoriteSchedules() : null;
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        label: `Watch recalls/alerts: ${item.brand || ""} ${
          item.name || item.upc || ""
        }`.trim(),
        when: "weekly", // your scheduler or RRULE can refine this
        meta: { upc: item.upc, domain: "safety" },
        createdAt: Date.now(),
        source: "SafetyBadges",
      };
      if (fav?.add) await fav.add(payload);
      else eventBus.emit("favorites:schedule:add", payload);
      analytics.track("safety_watch_schedule_saved", { upc: item.upc });
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={save}
      disabled={busy}
      className="px-2 py-1 rounded-md border hover:shadow-sm text-xs"
      title="Create a favorite schedule to monitor recall & safety updates"
    >
      {busy ? "Saving…" : "⏰ Watch updates"}
    </button>
  );
}

function ReplacementSessionButton({ item }) {
  const fav = useFavoriteSessions ? useFavoriteSessions() : null;
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        type: "shopping",
        label: `Replacement for ${item.brand || ""} ${
          item.name || item.upc || ""
        }`.trim(),
        items: [
          {
            upc: item.upc,
            name: item.name,
            store: item.store,
            price: item.price,
            note: "Find safer alternative",
          },
        ],
        createdAt: Date.now(),
        source: "SafetyBadges",
      };
      if (fav?.add) await fav.add(payload);
      else eventBus.emit("favorites:session:add", payload);
      analytics.track("safety_replacement_session_saved", { upc: item.upc });
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={save}
      disabled={busy}
      className="px-2 py-1 rounded-md border hover:shadow-sm text-xs"
      title="Start a favorite shopping session to replace this item"
    >
      {busy ? "Saving…" : "★ Replacement run"}
    </button>
  );
}

/* ----------------------------------- Main Export ----------------------------------- */
/**
 * @param {object} props
 * @param {object} props.item        // product/offer
 * @param {boolean} [props.compact]  // if true, show badges only (no label text); click opens popover
 * @param {boolean} [props.showActions] // show Watch/Replacement buttons in popover
 */
export default function SafetyBadges({
  item = {},
  compact = false,
  showActions = true,
}) {
  const household = useHouseholdAllergens
    ? useHouseholdAllergens()
    : { list: [] };
  const {
    recalls,
    allergensDetected,
    allergensUserRisk,
    harmfulIngredients,
    clean,
  } = useMemo(() => normalize(item, household?.list || []), [item, household]);

  const [open, setOpen] = useState(false);

  const hasRecall = recalls.length > 0;
  const hasAllergen = allergensDetected.length > 0;
  const hasUserRisk = allergensUserRisk.length > 0;
  const hasHarmful = harmfulIngredients.length > 0;
  const hasClean = clean.length > 0;

  const worstSeverity =
    recalls
      .map((r) => r.severity)
      .reduce((acc, cur) => {
        const order = ["info", "low", "moderate", "high", "critical"];
        return order.indexOf(cur) > order.indexOf(acc) ? cur : acc;
      }, "info") || "info";

  const openDetails = () => {
    setOpen(true);
    eventBus.emit("safety:details:open", {
      upc: item.upc,
      context: "SafetyBadges",
    });
    analytics.track("safety_details_opened", { upc: item.upc });
  };

  /* ------------------------------ Badge Row (collapsed) ------------------------------ */
  const nodes = [];

  if (hasRecall) {
    const label = compact
      ? "Recall"
      : `Recall${worstSeverity !== "info" ? ` (${worstSeverity})` : ""}`;
    nodes.push(
      badge("recall", label, tone[worstSeverity] || tone.moderate, {
        onClick: openDetails,
        role: "button",
        title: "View recall details",
      })
    );
  }

  if (hasAllergen) {
    const label = compact
      ? hasUserRisk
        ? "Allergen (You)"
        : "Allergen"
      : hasUserRisk
      ? `Allergen risk (You: ${allergensUserRisk.join(", ")})`
      : `Allergens (${allergensDetected.join(", ")})`;
    nodes.push(
      badge("allergens", label, hasUserRisk ? tone.high : tone.low, {
        onClick: openDetails,
        role: "button",
        title: "View allergen details",
      })
    );
  }

  if (hasHarmful) {
    const high = harmfulIngredients.some((h) => h.risk === "high");
    const sev = high ? "high" : "moderate";
    nodes.push(
      badge("harmful", compact ? "Harmful" : "Harmful ingredients", tone[sev], {
        onClick: openDetails,
        role: "button",
        title: "View ingredient details",
      })
    );
  }

  if (hasClean) {
    nodes.push(
      badge(
        "clean",
        compact
          ? "Clean"
          : `Clean: ${clean.slice(0, 2).join(", ")}${
              clean.length > 2 ? "…" : ""
            }`,
        tone.good,
        { onClick: openDetails, role: "button", title: "View more labels" }
      )
    );
  }

  // If nothing, show a neutral “No alerts” badge (still clickable to open details)
  if (!nodes.length) {
    nodes.push(
      badge("none", compact ? "OK" : "No safety alerts", tone.neutral, {
        onClick: openDetails,
        role: "button",
        title: "View details",
      })
    );
  }

  /* ------------------------------ Details Popover Content ----------------------------- */
  const Details = () => (
    <div className="text-sm">
      {/* Recalls */}
      <section className="mb-3">
        <div className="font-semibold flex items-center gap-2">
          <span>Recalls</span>
          {hasRecall ? (
            <span
              className={`text-[10px] px-1 py-0.5 rounded border ${tone[worstSeverity]}`}
            >
              {worstSeverity}
            </span>
          ) : (
            <span
              className={`text-[10px] px-1 py-0.5 rounded border ${tone.neutral}`}
            >
              none
            </span>
          )}
        </div>
        {hasRecall ? (
          <ul className="mt-1 space-y-2">
            {recalls.map((r) => (
              <li
                key={r.id || `${r.authority}-${r.announcedISO || ""}`}
                className="border rounded-md p-2"
              >
                <div className="text-xs text-gray-600">
                  {r.authority || "Authority"} • {r.severity || "info"} •{" "}
                  {fmtDate(r.updatedISO) ||
                    fmtDate(r.announcedISO) ||
                    "date n/a"}
                </div>
                {r.reason ? <div className="mt-1">{r.reason}</div> : null}
                {Array.isArray(r.affectedLots) && r.affectedLots.length ? (
                  <div className="mt-1 text-xs">
                    Lots:{" "}
                    <span className="font-mono">
                      {r.affectedLots.join(", ")}
                    </span>
                  </div>
                ) : null}
                {Array.isArray(r.sources) && r.sources.length ? (
                  <div className="mt-1 text-xs">
                    Sources:{" "}
                    {r.sources.map((s, i) =>
                      s?.url ? (
                        <a
                          key={i}
                          className="underline"
                          href={s.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() =>
                            analytics.track("safety_source_opened", {
                              upc: item.upc,
                              url: s.url,
                            })
                          }
                        >
                          {s.label || s.url}
                        </a>
                      ) : (
                        <span key={i}>{s?.label || "—"}</span>
                      )
                    )}
                  </div>
                ) : null}
                <div className="mt-2 flex gap-2">
                  <button
                    className="px-2 py-1 rounded-md border hover:shadow-sm text-xs"
                    onClick={() => {
                      eventBus.emit("safety:recall:acknowledge", {
                        upc: item.upc,
                        recallId: r.id,
                        source: "SafetyBadges",
                      });
                      analytics.track("safety_recall_acknowledged", {
                        upc: item.upc,
                        id: r.id,
                      });
                    }}
                  >
                    Acknowledge
                  </button>
                  <button
                    className="px-2 py-1 rounded-md border hover:shadow-sm text-xs"
                    onClick={() => {
                      eventBus.emit("safety:recall:history:open", {
                        upc: item.upc,
                        recallId: r.id,
                        source: "SafetyBadges",
                      });
                      analytics.track("safety_recall_history_open", {
                        upc: item.upc,
                        id: r.id,
                      });
                    }}
                  >
                    View history
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-xs text-gray-600 mt-1">
            No recalls reported for this item.
          </div>
        )}
      </section>

      {/* Allergens */}
      <section className="mb-3">
        <div className="font-semibold">Allergens</div>
        {!hasAllergen ? (
          <div className="text-xs text-gray-600 mt-1">
            None detected from label scan.
          </div>
        ) : (
          <>
            <div className="mt-1">
              Detected:{" "}
              <span className="text-xs">
                {allergensDetected.map((a) => (
                  <span key={a} className="mr-2">
                    {a}
                  </span>
                ))}
              </span>
            </div>
            {hasUserRisk ? (
              <div className="mt-1 text-xs text-red-700">
                Household risk: {allergensUserRisk.join(", ")}
              </div>
            ) : (
              <div className="mt-1 text-xs text-emerald-700">
                No household matches.
              </div>
            )}
          </>
        )}
      </section>

      {/* Harmful ingredients */}
      <section className="mb-3">
        <div className="font-semibold">Harmful ingredients</div>
        {!hasHarmful ? (
          <div className="text-xs text-gray-600 mt-1">None flagged.</div>
        ) : (
          <ul className="mt-1 space-y-1 text-xs">
            {harmfulIngredients.map((h, i) => (
              <li key={`${h.name}-${i}`} className="flex justify-between gap-3">
                <div>
                  <span className="font-medium">{h.name}</span>
                  {h.category ? (
                    <span className="ml-1 text-gray-600">({h.category})</span>
                  ) : null}
                  {h.source ? (
                    <span className="ml-1 text-gray-500">[{h.source}]</span>
                  ) : null}
                </div>
                <span
                  className={`px-1 rounded border ${
                    tone[h.risk || "moderate"] || tone.moderate
                  }`}
                >
                  {h.risk || "moderate"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Clean labels */}
      <section className="mb-3">
        <div className="font-semibold">Clean labels</div>
        {!hasClean ? (
          <div className="text-xs text-gray-600 mt-1">None recorded.</div>
        ) : (
          <div className="mt-1 text-xs flex flex-wrap">
            {clean.map((c) => (
              <span
                key={c}
                className="mr-2 mb-1 px-1 py-0.5 rounded border border-emerald-300 text-emerald-700"
              >
                {c}
              </span>
            ))}
          </div>
        )}
      </section>

      {/* Actions */}
      {showActions ? (
        <div className="mt-2 flex gap-2 flex-wrap">
          <WatchScheduleButton item={item} />
          <ReplacementSessionButton item={item} />
          <button
            className="px-2 py-1 rounded-md border hover:shadow-sm text-xs"
            onClick={() => {
              eventBus.emit("safety:report:submit", {
                upc: item.upc,
                source: "SafetyBadges",
              });
              analytics.track("safety_report_start", { upc: item.upc });
              setOpen(false);
            }}
            title="Submit an issue or observation about this item"
          >
            📝 Report an issue
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="relative inline-block">
      <div className="flex flex-wrap">{nodes}</div>
      <div className="relative">{/* anchor for absolute popover */}</div>
      <Popover open={open} onClose={() => setOpen(false)}>
        <Details />
      </Popover>
    </div>
  );
}
