/* eslint-disable no-console */
// FavoritePlanEditorModal — edit/adopt/favorite plans with autosave drafts
// - Save updates to user-authored plans
// - Adopt featured/system plans into "My Plans" (Save as My Copy)
// - "Save & Favorite" one-click
// - Inline tags, summary, domain picker; optional advanced JSON editor slot
// - Defensive: works without hook by using PlanStorageRouter directly
// - Emits orchestration events and NBA pulses; accessible and keyboard-friendly

import React, { useEffect, useMemo, useRef, useState } from "react";

/* --------------------------------- Imports -------------------------------- */
let useFavoritePlans = null;
try {
  const mod = require("@/hooks/useFavoritePlans");
  useFavoritePlans = mod?.default || null;
} catch (_e) {}

let createPlanStorageRouter = null;
try {
  const psr = require("@/managers/storage/PlanStorageRouter");
  createPlanStorageRouter = psr?.createPlanStorageRouter || null;
} catch (_e) {}

let eventBus = { on() {}, off() {}, emit() {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let automation = null;
try {
  const rt = require("@/services/automation/runtime");
  automation = rt?.automation || rt?.default || null;
} catch (_e) {}

const isBrowser = typeof window !== "undefined";

/* ---------------------------------- Icons --------------------------------- */
const IconX = (p) => (
  <svg viewBox="0 0 24 24" className={p.className} aria-hidden="true">
    <path d="M6.225 4.811L4.811 6.225 9.586 11l-4.775 4.775 1.414 1.414L11 12.414l4.775 4.775 1.414-1.414L12.414 11l4.775-4.775-1.414-1.414L11 9.586 6.225 4.811z" />
  </svg>
);
const IconHeart = ({ filled, className }) =>
  filled ? (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.1 21.35l-.1.1-.11-.1C7.14 17.24 4 14.39 4 10.99 4 8.58 5.99 6.6 8.4 6.6c1.33 0 2.61.57 3.6 1.49a5.12 5.12 0 013.6-1.49c2.41 0 4.4 1.98 4.4 4.39 0 3.4-3.14 6.25-7.9 10.36z" />
    </svg>
  ) : (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 6.6c-1.33 0-2.61.57-3.6 1.49A5.12 5.12 0 008.8 6.6C6.39 6.6 4.4 8.58 4.4 11c0 3.4 3.14 6.25 7.9 10.36C17.06 17.25 20.2 14.4 20.2 11c0-2.42-1.99-4.4-4.4-4.4zm0-1.6c3.31 0 6 2.69 6 6 0 3.97-3.8 7.34-8.97 12.04L12 23l-.03-.03C6.8 18.34 3 14.97 3 11c0-3.31 2.69-6 6-6 1.76 0 3.35.76 4.47 1.97A6.96 6.96 0 0116 5z" />
    </svg>
  );
const IconSave = (p) => (
  <svg viewBox="0 0 24 24" className={p.className} aria-hidden="true">
    <path d="M17 3H5a2 2 0 00-2 2v14l4-4h10a2 2 0 002-2V5a2 2 0 00-2-2zm-3 6H7V7h7v2z" />
  </svg>
);

/* --------------------------------- Helpers -------------------------------- */
const DOMAINS = [
  "meals",
  "cleaning",
  "garden",
  "animals",
  "inventory",
  "health",
];
const cls = (...xs) => xs.filter(Boolean).join(" ");
const draftKey = (userId, pid) =>
  `suka:drafts:plan:${userId || "anon"}:${pid || "new"}`;

/* ---------------------------- Internal utilities --------------------------- */
function useDraft(plan, userId) {
  const [draft, setDraft] = useState(() => {
    if (!isBrowser) return null;
    const raw = window.localStorage.getItem(draftKey(userId, plan?.id));
    return raw ? JSON.parse(raw) : null;
  });

  useEffect(() => {
    if (!isBrowser) return;
    if (!draft) return;
    const t = setTimeout(() => {
      try {
        window.localStorage.setItem(
          draftKey(userId, plan?.id),
          JSON.stringify(draft)
        );
      } catch (_e) {}
    }, 250);
    return () => clearTimeout(t);
  }, [draft, plan?.id, userId]);

  const clearDraft = () => {
    if (!isBrowser) return;
    try {
      window.localStorage.removeItem(draftKey(userId, plan?.id));
    } catch (_e) {}
  };

  return { draft, setDraft, clearDraft };
}

/* ------------------------------- Component -------------------------------- */
/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {object} props.plan                 The plan object to edit (may be featured/system)
 * @param {string} props.userId
 * @param {string} [props.domain="meals"]
 * @param {function=} props.onClose
 * @param {function=} props.onSaved           (savedPlan) => void
 * @param {boolean=} props.showAdvancedJson   Show a JSON textarea for planBody (power user)
 */
export default function FavoritePlanEditorModal({
  open,
  plan,
  userId = "anon",
  domain = "meals",
  onClose,
  onSaved,
  showAdvancedJson = false,
}) {
  const hasHook = typeof useFavoritePlans === "function";
  const hook = hasHook
    ? useFavoritePlans({ userId, domain, only: "all" })
    : null;

  const {
    saveUserPlan,
    adoptFeatured,
    favorite,
    unfavorite,
    toggleFavorite,
    get,
  } = hook || {};

  const [busy, setBusy] = useState(false);
  const [favBusy, setFavBusy] = useState(false);

  const source = plan?.meta?.source || "featured";
  const createdBy = plan?.meta?.createdBy || null;
  const isMine = source === "user" && createdBy === userId;

  const initial = useMemo(
    () => ({
      title: plan?.title || "",
      summary: plan?.summary || "",
      tags: (plan?.tags || []).slice(0, 20),
      domain: plan?.domain || domain,
      planBody: plan?.planBody || {},
    }),
    [plan, domain]
  );

  const { draft, setDraft, clearDraft } = useDraft(plan, userId);
  const [form, setForm] = useState(draft || initial);

  // isFavorite discovery — try hook get or plan flag
  const [isFavorite, setIsFavorite] = useState(!!plan?.isFavorite);

  useEffect(() => {
    // reset form if plan changes (but keep draft if it exists for same id)
    if (!draft || plan?.id !== plan?.id) setForm(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.id]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!plan?.id) return;
        if (toggleFavorite && get) {
          const updated = await get({
            planId: plan.id,
            domain: plan.domain || domain,
          });
          if (alive && updated) setIsFavorite(!!updated.isFavorite);
        } else {
          setIsFavorite(!!plan?.isFavorite);
        }
      } catch (_e) {}
    })();
    return () => {
      alive = false;
    };
  }, [plan?.id]);

  // Router fallback when no hook
  const routerRef = useRef(null);
  useEffect(() => {
    if (hasHook || !createPlanStorageRouter) return;
    let alive = true;
    (async () => {
      try {
        const r = await createPlanStorageRouter({ userId });
        if (alive) routerRef.current = r;
      } catch (_e) {}
    })();
    return () => {
      alive = false;
    };
  }, [hasHook, userId]);

  const onEsc = (e) => e.key === "Escape" && onClose?.();
  useEffect(() => {
    if (!open || !isBrowser) return;
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [open]);

  // ------------------------------ Handlers ----------------------------------
  const update = (patch) => setForm((f) => ({ ...f, ...patch }));

  const handleTagKey = (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = e.currentTarget.value.trim();
      if (!val) return;
      if (!form.tags.includes(val)) update({ tags: [...form.tags, val] });
      e.currentTarget.value = "";
    }
  };
  const removeTag = (t) => update({ tags: form.tags.filter((x) => x !== t) });

  function requireTitle() {
    const ok = !!(form.title || "").trim();
    if (!ok) {
      eventBus.emit?.("toast.show", {
        level: "warning",
        title: "Add a title",
        message: "Your plan needs a title.",
        ts: Date.now(),
      });
    }
    return ok;
  }

  async function doSave({ favorite: fav = false, forceCopy = false } = {}) {
    if (!requireTitle()) return;
    setBusy(true);
    try {
      let saved = null;

      // payload
      const payload = {
        ...(plan || {}),
        title: form.title.trim(),
        summary: form.summary.trim(),
        tags: form.tags,
        domain: form.domain || domain,
        planBody: form.planBody || {},
        userId,
        meta: {
          ...(plan?.meta || {}),
          source: isMine && !forceCopy ? "user" : "user",
          createdBy: userId,
          version: (plan?.meta?.version || 1) + 1,
        },
      };

      if (hasHook && saveUserPlan && adoptFeatured) {
        if (isMine && !forceCopy) {
          saved = await saveUserPlan(payload);
        } else {
          // adopt featured or “save as my copy”
          saved = await adoptFeatured({
            userId,
            domain: payload.domain,
            planId: plan?.id,
            favorite: !!fav,
          });
          if (!saved) {
            // If adopt via hook requires a planId, fallback to saving outright as user plan
            saved = await saveUserPlan({ ...payload, id: undefined });
          }
        }
      } else {
        // Router fallback
        const r = routerRef.current;
        if (r?.savePlan) {
          if (isMine && !forceCopy) {
            saved = await r.savePlan(payload, {
              scope: "user",
              userId,
              overwrite: true,
            });
          } else {
            // featured/system → save new copy
            saved = await r.savePlan(
              { ...payload, id: undefined },
              { scope: "user", userId, favorite: !!fav }
            );
          }
          if (fav && r?.adapter?.get && r?.adapter?.set) {
            const favKey = `favorites:user:${userId}`;
            const existing = (await r.adapter.get(favKey)) || { byId: {} };
            existing.byId[payload.id || saved?.id] = {
              at: Date.now(),
              domain: payload.domain,
            };
            await r.adapter.set(favKey, existing);
          }
          try {
            r.afterSaveOrchestrate?.(saved);
          } catch (_e) {}
        }
      }

      // optimistic favorite
      if (fav && (favorite || routerRef.current)) {
        try {
          if (favorite)
            await favorite({
              userId,
              domain: saved?.domain || form.domain,
              planId: saved?.id || plan?.id,
            });
          setIsFavorite(true);
        } catch (_e) {}
      }

      clearDraft();
      eventBus.emit?.("toast.show", {
        level: "success",
        title: isMine && !forceCopy ? "Plan saved" : "Saved to My Plans",
        message: fav
          ? "Saved and added to favorites."
          : "Your changes are preserved.",
        ts: Date.now(),
      });
      automation?.emit?.("nba.signal", {
        kind: fav ? "plan.saved.favorite" : "plan.saved",
        domain: saved?.domain || form.domain || domain,
        userId,
        planId: saved?.id || plan?.id,
        ts: Date.now(),
      });
      onSaved?.(saved || { ...plan, ...payload });
      onClose?.();
    } catch (err) {
      eventBus.emit?.("toast.show", {
        level: "error",
        title: "Could not save",
        message: String(err?.message || err),
        ts: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  }

  async function doToggleFavorite() {
    if (!plan?.id && !form.title.trim()) return;
    setFavBusy(true);
    try {
      if (toggleFavorite) {
        await toggleFavorite({
          planId: plan?.id,
          domain: plan?.domain || form.domain || domain,
        });
        const next = !isFavorite;
        setIsFavorite(next);
        eventBus.emit?.("toast.show", {
          level: "success",
          title: next ? "Added to favorites" : "Removed from favorites",
          message: form.title || plan?.title || "Plan",
          ts: Date.now(),
        });
      } else if (
        routerRef.current?.adapter?.get &&
        routerRef.current?.adapter?.set &&
        (plan?.id || true)
      ) {
        // If plan isn't persisted yet, doSave then favorite.
        if (!plan?.id) {
          const temp = await doSave({ favorite: false, forceCopy: !isMine });
          if (!temp?.id && !plan?.id) return;
        }
        const favKey = `favorites:user:${userId}`;
        const current = (await routerRef.current.adapter.get(favKey)) || {
          byId: {},
        };
        const id = plan?.id;
        if (!id) return;
        if (isFavorite) delete current.byId[id];
        else
          current.byId[id] = {
            at: Date.now(),
            domain: plan?.domain || form.domain || domain,
          };
        await routerRef.current.adapter.set(favKey, current);
        setIsFavorite(!isFavorite);
      }
    } catch (err) {
      eventBus.emit?.("toast.show", {
        level: "error",
        title: "Favorite failed",
        message: String(err?.message || err),
        ts: Date.now(),
      });
    } finally {
      setFavBusy(false);
    }
  }

  /* --------------------------------- Render -------------------------------- */
  if (!open) return null;

  const mine = isMine;
  const featured = !isMine;
  const title = mine ? "Edit Plan" : "Adopt Plan";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        aria-hidden="true"
        onClick={() => onClose?.()}
      />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative w-[min(880px,92vw)] max-h-[90vh] overflow-auto rounded-2xl bg-white shadow-xl border"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b px-5 py-3 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-xs text-gray-500">
              {mine ? "Your Plan" : "Featured Plan"}
            </div>
            <h3 className="text-lg font-semibold truncate">
              {form.title || "Untitled Plan"}
            </h3>
          </div>
          <div className="flex items-center gap-2">
            {/* Favorite */}
            <button
              type="button"
              onClick={doToggleFavorite}
              disabled={favBusy}
              aria-label={
                isFavorite ? "Remove from favorites" : "Add to favorites"
              }
              title={isFavorite ? "Remove from favorites" : "Add to favorites"}
              className={cls(
                "inline-flex items-center justify-center rounded-full border h-10 w-10 transition",
                isFavorite
                  ? "bg-rose-50 border-rose-200 hover:bg-rose-100"
                  : "bg-white border-gray-200 hover:bg-gray-50"
              )}
            >
              <IconHeart
                filled={!!isFavorite}
                className={cls(
                  "h-5 w-5",
                  isFavorite ? "fill-rose-600" : "fill-gray-500"
                )}
              />
            </button>

            {/* Close */}
            <button
              type="button"
              onClick={() => onClose?.()}
              aria-label="Close"
              title="Close"
              className="inline-flex items-center justify-center h-10 w-10 rounded-full hover:bg-gray-100"
            >
              <IconX className="h-5 w-5 fill-gray-600" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left column: meta */}
          <div className="lg:col-span-1 space-y-3">
            <label className="block">
              <span className="text-sm font-medium text-gray-700">Domain</span>
              <select
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm bg-white"
                value={form.domain}
                onChange={(e) => update({ domain: e.target.value })}
              >
                {DOMAINS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Title</span>
              <input
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="e.g., 7-Day Winter Comforts"
                value={form.title}
                onChange={(e) => update({ title: e.target.value })}
              />
            </label>

            <label className="block">
              <span className="text-sm font-medium text-gray-700">Summary</span>
              <textarea
                className="mt-1 w-full rounded-xl border px-3 py-2 text-sm"
                rows={3}
                placeholder="Short description that helps you remember the plan."
                value={form.summary}
                onChange={(e) => update({ summary: e.target.value })}
              />
            </label>

            <div className="block">
              <span className="text-sm font-medium text-gray-700">Tags</span>
              <div className="mt-1 flex flex-wrap gap-1">
                {form.tags.map((t) => (
                  <span
                    key={t}
                    className="inline-flex items-center gap-1 rounded-full bg-blue-50 text-blue-700 px-2 py-0.5 text-xs"
                  >
                    {t}
                    <button
                      type="button"
                      className="ml-1 rounded-full px-1 hover:bg-blue-200/50"
                      aria-label={`Remove tag ${t}`}
                      onClick={() => removeTag(t)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
              <input
                className="mt-2 w-full rounded-xl border px-3 py-2 text-sm"
                placeholder="Type a tag and press Enter"
                onKeyDown={handleTagKey}
                aria-label="Add tag"
              />
            </div>
          </div>

          {/* Right column: plan body / steps */}
          <div className="lg:col-span-2 space-y-3">
            {showAdvancedJson ? (
              <label className="block">
                <span className="text-sm font-medium text-gray-700">
                  Plan JSON (advanced)
                </span>
                <textarea
                  className="mt-1 w-full rounded-xl border px-3 py-2 text-sm font-mono"
                  rows={14}
                  value={(() => {
                    try {
                      return JSON.stringify(form.planBody || {}, null, 2);
                    } catch {
                      return "{}";
                    }
                  })()}
                  onChange={(e) => {
                    try {
                      update({ planBody: JSON.parse(e.target.value) });
                    } catch {
                      /* keep invalid until user fixes */
                    }
                  }}
                />
                <span className="text-xs text-gray-500">
                  Tip: conforms to your domain contracts when available.
                </span>
              </label>
            ) : (
              <div className="rounded-xl border p-3">
                <div className="text-sm text-gray-700 font-medium mb-2">
                  Steps / Tasks
                </div>
                {/* Minimal step editor without external deps; replace with your richer builder if present */}
                <SimpleStepsEditor
                  value={form.planBody?.steps || []}
                  onChange={(steps) =>
                    update({ planBody: { ...(form.planBody || {}), steps } })
                  }
                />
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-white/80 backdrop-blur border-t px-5 py-3 flex flex-wrap gap-2 justify-between">
          <div className="text-xs text-gray-500 self-center">
            {mine ? "Editing your plan" : "You’re viewing a featured plan"} •
            Changes are autosaved to a draft locally until you save.
          </div>
          <div className="flex items-center gap-2">
            {!mine && (
              <button
                type="button"
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                onClick={() => doSave({ favorite: false, forceCopy: true })}
                disabled={busy}
                title="Create a private copy in your library"
              >
                Save as My Copy
              </button>
            )}
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-xl bg-blue-600 text-white px-3 py-2 text-sm hover:bg-blue-700 disabled:opacity-60"
              onClick={() => doSave({ favorite: false, forceCopy: false })}
              disabled={busy}
            >
              <IconSave className="h-4 w-4" />
              {mine ? "Save Changes" : "Save to My Plans"}
            </button>
            <button
              type="button"
              className="rounded-xl bg-blue-50 text-blue-700 border border-blue-200 px-3 py-2 text-sm hover:bg-blue-100"
              onClick={() => doSave({ favorite: true, forceCopy: !mine })}
              disabled={busy}
              title="Save and add to Favorites for quick access"
            >
              Save & Favorite
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* --------------------------- SimpleStepsEditor ----------------------------- */
// Minimal inline list editor to avoid external deps (replace with your builder if you have one)
function SimpleStepsEditor({ value, onChange }) {
  const [items, setItems] = useState(Array.isArray(value) ? value : []);
  useEffect(() => setItems(Array.isArray(value) ? value : []), [value]);

  const add = () => {
    const next = [
      ...items,
      { id: `s_${Math.random().toString(36).slice(2)}`, text: "" },
    ];
    setItems(next);
    onChange?.(next);
  };
  const update = (i, text) => {
    const next = items.slice();
    next[i] = { ...(next[i] || {}), text };
    setItems(next);
    onChange?.(next);
  };
  const remove = (i) => {
    const next = items.slice();
    next.splice(i, 1);
    setItems(next);
    onChange?.(next);
  };

  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={it.id || i} className="flex items-center gap-2">
          <div className="flex-1">
            <input
              className="w-full rounded-xl border px-3 py-2 text-sm"
              placeholder={`Step ${i + 1}`}
              value={it.text || ""}
              onChange={(e) => update(i, e.target.value)}
            />
          </div>
          <button
            type="button"
            className="rounded-lg border px-2 py-1 text-xs hover:bg-gray-50"
            onClick={() => remove(i)}
            aria-label={`Remove step ${i + 1}`}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
        onClick={add}
      >
        + Add Step
      </button>
    </div>
  );
}
