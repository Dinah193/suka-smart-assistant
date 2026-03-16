// src/components/layout/DashboardSection.jsx
/* eslint-disable react/prop-types, no-console */
import React, { useEffect, useMemo, useState } from "react";

/* --------------------------- motion compat (safe) --------------------------- */
const ShimAnimatePresence = ({ children }) => <>{children}</>;
const makeTag = (tag) =>
  React.forwardRef((props, ref) => React.createElement(tag, { ref, ...props }));
const ShimM = new Proxy({}, { get: (_, t) => makeTag(t) });

function useMotionCompat() {
  const [mod, setMod] = useState({
    AnimatePresence: ShimAnimatePresence,
    m: ShimM,
    motion: ShimM,
  });
  useEffect(() => {
    let ok = true;
    (async () => {
      const tryImport = async (p) => {
        try {
          return await import(/* @vite-ignore */ p);
        } catch {
          return null;
        }
      };

      const compat =
        (await tryImport("@/app/ui/motion/compat")) ||
        (await tryImport("@/app/ui/motion/compat"));

      if (compat && ok) {
        setMod({
          AnimatePresence: compat.AnimatePresence || ShimAnimatePresence,
          m: compat.m || compat.motion || ShimM,
          motion: compat.motion || compat.m || ShimM,
        });
        return;
      }

      const fm = await tryImport("framer-motion");
      if (fm && ok) {
        setMod({
          AnimatePresence: fm.AnimatePresence || ShimAnimatePresence,
          m: fm.m || fm.motion || ShimM,
          motion: fm.motion || fm.m || ShimM,
        });
      }
    })();
    return () => {
      ok = false;
    };
  }, []);
  return mod;
}

/* --------------------------------- helpers --------------------------------- */
const cx = (...a) => a.filter(Boolean).join(" ");
const fire = (type, detail = {}) => {
  try {
    window.dispatchEvent(new CustomEvent(type, { detail }));
  } catch {}
  try {
    const bus = window.__suka?.eventBus;
    if (bus?.emit) bus.emit(type, detail);
  } catch {}
};

const store = {
  get: (k, fb) => {
    try {
      const s = localStorage.getItem(k);
      return s ? JSON.parse(s) : fb;
    } catch {
      return fb;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

const genId = () =>
  Math.random().toString(36).slice(2) + Date.now().toString(36);

/* ------------------------------- primitives -------------------------------- */
function ActionButton({ label, onClick, variant = "ghost", disabled = false }) {
  return (
    <button
      type="button"
      className={cx("btn", variant === "ghost" ? "btn--ghost" : "", "btn--sm")}
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      {label}
    </button>
  );
}

/* ---------------------------- DashboardSection ----------------------------- */
/**
 * Props:
 * - id, title, subtitle, icon, children
 * - actions: [{label, onClick, variant}]  // variant: "ghost" | "primary"
 * - collapsible (bool) default true
 * - defaultCollapsed (bool)
 * - footer (node), aside (node), dense (bool)
 * - tone ("default"|"alt"|"brand")
 * - variant ("default"|"hero") -> hero gets more header presence, still compact
 * - headerStyle ("soft"|"plain")
 * - onSaveFavorite, onSaveSchedule, favoriteLabel, scheduleLabel
 */
export default function DashboardSection({
  id,
  title,
  subtitle,
  icon: Icon,
  children,
  actions = [],
  collapsible = true,
  defaultCollapsed = false,
  footer = null,
  aside = null,
  dense = false,
  tone = "default",
  variant = "default",
  headerStyle = "soft",
  onSaveFavorite,
  onSaveSchedule,
  favoriteLabel = "Save Favorite",
  scheduleLabel = "Save Schedule",
}) {
  const { AnimatePresence, m } = useMotionCompat();
  const key = `ds:${id || title}:collapsed`;
  const [collapsed, setCollapsed] = useState(() =>
    store.get(key, defaultCollapsed)
  );
  const [busyFav, setBusyFav] = useState(false);
  const [busySch, setBusySch] = useState(false);
  const [toastMsg, setToastMsg] = useState("");

  useEffect(() => {
    store.set(key, collapsed);
  }, [collapsed]);

  const sectionTone = useMemo(() => {
    if (tone === "brand") return "card card-brand";
    if (tone === "alt") return "card card-alt";
    return "card";
  }, [tone]);

  const headPad = dense ? "px-3 pt-3" : "px-4 pt-4";
  const bodyPad = dense ? "pb-3 px-3" : "pb-4 px-4";

  const titleClass = variant === "hero" ? "section-h2" : "section-h2";
  const subClass = "section-sub";

  const doSaveFavorite = async () => {
    if (!onSaveFavorite) return;
    try {
      setBusyFav(true);
      const savedId = await onSaveFavorite();
      fire("ui.toast", { kind: "success", message: "Saved to Favorites" });
      fire("favorites.saved", { id: savedId || genId(), section: id || title });
      setToastMsg("Saved to Favorites");
    } catch (e) {
      console.warn(e);
      fire("ui.toast", { kind: "error", message: "Could not save favorite" });
      setToastMsg("Could not save favorite");
    } finally {
      setBusyFav(false);
      setTimeout(() => setToastMsg(""), 2200);
    }
  };

  const doSaveSchedule = async () => {
    if (!onSaveSchedule) return;
    try {
      setBusySch(true);
      const savedId = await onSaveSchedule();
      fire("ui.toast", { kind: "success", message: "Schedule saved" });
      fire("automation.schedule.saved", {
        id: savedId || genId(),
        section: id || title,
      });
      setToastMsg("Schedule saved");
    } catch (e) {
      console.warn(e);
      fire("ui.toast", { kind: "error", message: "Could not save schedule" });
      setToastMsg("Could not save schedule");
    } finally {
      setBusySch(false);
      setTimeout(() => setToastMsg(""), 2200);
    }
  };

  return (
    <section className={cx(sectionTone)}>
      {/* Header */}
      <div
        className={cx(
          "section-header",
          headPad,
          headerStyle === "soft" ? "tint-cool" : ""
        )}
        style={
          headerStyle === "soft"
            ? {
                borderTopLeftRadius: 18,
                borderTopRightRadius: 18,
              }
            : undefined
        }
      >
        <div className="section-title">
          {Icon ? <span className="section-icon">{<Icon />}</span> : null}
          <div>
            <h2 className={titleClass}>{title}</h2>
            {subtitle ? <p className={subClass}>{subtitle}</p> : null}
          </div>
        </div>

        <div className="section-actions">
          {aside ? <div className="hide-sm">{aside}</div> : null}

          {actions?.map((a, i) => (
            <ActionButton
              key={i}
              label={a.label}
              onClick={a.onClick}
              variant={a.variant === "primary" ? "primary" : "ghost"}
              disabled={a.disabled}
            />
          ))}

          {onSaveSchedule ? (
            <ActionButton
              label={busySch ? "Saving…" : scheduleLabel}
              onClick={doSaveSchedule}
              variant="ghost"
              disabled={busySch}
            />
          ) : null}

          {onSaveFavorite ? (
            <ActionButton
              label={busyFav ? "Saving…" : favoriteLabel}
              onClick={doSaveFavorite}
              variant="primary"
              disabled={busyFav}
            />
          ) : null}

          {collapsible ? (
            <button
              type="button"
              className="btn btn--ghost btn--icon btn--sm"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? "Expand section" : "Collapse section"}
              title={collapsed ? "Expand" : "Collapse"}
            >
              <svg
                className={cx(collapsed ? "rot-180" : "")}
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
              >
                <path
                  d="M6 9l6 6 6-6"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : null}
        </div>
      </div>

      {/* Body */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <m.div
            key="content"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22 }}
            className={cx("section-body", bodyPad)}
          >
            {children}
          </m.div>
        )}
      </AnimatePresence>

      {/* Footer */}
      {footer ? (
        <div className={cx(dense ? "px-3 pb-3" : "px-4 pb-4")}>{footer}</div>
      ) : null}

      {/* Toast */}
      <AnimatePresence>
        {toastMsg ? (
          <m.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.18 }}
            className="toast"
          >
            {toastMsg}
          </m.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
