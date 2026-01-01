// src/ui/RewardPopup.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import PropTypes from "prop-types";

/**
 * RewardPopup — celebratory toast/card with motion, a11y, and cues
 *
 * Backwards-compatible props:
 *  - message?: string = "🎉 Great job!"
 *  - icon?: ReactNode | string = "🏆"
 *  - onClose?: () => void
 *  - duration?: number = 4000
 *
 * New optional props:
 *  - tone?: "success" | "info" | "warning" | "danger" | "sabbath" | "neutral" = "success"
 *  - placement?: "bottom-right" | "bottom-left" | "top-right" | "top-left" | "center" = "bottom-right"
 *  - sticky?: boolean (if true, no auto-hide)
 *  - hoverPause?: boolean = true (pause timer while hovered)
 *  - showProgress?: boolean = true
 *  - closeButton?: boolean = true
 *  - onDismiss?: () => void (fires when user closes manually)
 *  - zIndexClass?: string = "z-50"
 *  - widthClass?: string = "w-72"
 *  - stackIndex?: number = 0 (offset when stacking multiple popups)
 *  - portalId?: string (render into #portalId if present)
 *  - sound?: boolean = false (play a soft chime)
 *  - vibrate?: boolean = true (short haptic)
 */

const rewardVariants = {
  hidden: { opacity: 0, y: 24, scale: 0.96 },
  visible: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: -20, scale: 0.96 },
};

const TONE = {
  success: { wrap: "bg-emerald-50 border-emerald-300 text-emerald-900", badge: "bg-emerald-500" },
  info:    { wrap: "bg-sky-50 border-sky-300 text-sky-900",             badge: "bg-sky-500" },
  warning: { wrap: "bg-amber-50 border-amber-300 text-amber-900",        badge: "bg-amber-500" },
  danger:  { wrap: "bg-rose-50 border-rose-300 text-rose-900",           badge: "bg-rose-500" },
  sabbath: { wrap: "bg-indigo-50 border-indigo-300 text-indigo-900",      badge: "bg-indigo-500" },
  neutral: { wrap: "bg-stone-100 border-stone-300 text-stone-800",        badge: "bg-stone-500" },
};

const PLACEMENT = {
  "bottom-right": "fixed bottom-8 right-8",
  "bottom-left":  "fixed bottom-8 left-8",
  "top-right":    "fixed top-8 right-8",
  "top-left":     "fixed top-8 left-8",
  center:         "fixed inset-0 grid place-items-center",
};

// ultra-short base64 chime (no network), ~0.1s
const CHIME_SRC =
  "data:audio/mp3;base64,//uQZAAAAAAAAAAAAAAAAAAAAAAAWGluZwAAAA8AAAACAAACcQACcQAAAAAAAAAAA..."; // intentionally truncated; replace with your own short data: URI if you want sound

// Tiny confetti (lightweight, no deps); respects reduced motion
function Confetti({ pieces = 12, tone = "success" }) {
  const reduced = useReducedMotion();
  if (reduced) return null;
  const colors = {
    success: ["#10b981", "#34d399", "#047857", "#6ee7b7"],
    info:    ["#0ea5e9", "#38bdf8", "#0369a1", "#7dd3fc"],
    warning: ["#f59e0b", "#fbbf24", "#b45309", "#fde68a"],
    danger:  ["#ef4444", "#f87171", "#991b1b", "#fecaca"],
    sabbath: ["#6366f1", "#818cf8", "#3730a3", "#c7d2fe"],
    neutral: ["#6b7280", "#9ca3af", "#374151", "#d1d5db"],
  }[tone] || ["#6b7280", "#9ca3af", "#374151", "#d1d5db"];

  const dots = Array.from({ length: pieces }).map((_, i) => {
    const x = (Math.random() - 0.5) * 80; // px spread
    const y = -Math.random() * 80 - 40;
    const rot = (Math.random() - 0.5) * 180;
    const delay = Math.random() * 0.15;
    const c = colors[i % colors.length];
    const size = 5 + Math.random() * 5;
    return (
      <motion.span
        key={i}
        initial={{ opacity: 0, y: 0, x: 0, rotate: 0 }}
        animate={{ opacity: 1, y, x, rotate: rot }}
        transition={{ duration: 0.7, delay, ease: "easeOut" }}
        style={{
          position: "absolute",
          top: "0.75rem",
          left: "50%",
          width: size,
          height: size,
          marginLeft: -size / 2,
          background: c,
          borderRadius: 2,
          pointerEvents: "none",
        }}
      />
    );
  });
  return <>{dots}</>;
}

export default function RewardPopup({
  message = "🎉 Great job!",
  icon = "🏆",
  onClose = () => {},
  duration = 4000,

  tone = "success",
  placement = "bottom-right",
  sticky = false,
  hoverPause = true,
  showProgress = true,
  closeButton = true,
  onDismiss,
  zIndexClass = "z-50",
  widthClass = "w-72",
  stackIndex = 0,
  portalId,
  sound = false,
  vibrate = true,
}) {
  const [visible, setVisible] = useState(true);
  const [hovered, setHovered] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const reduced = useReducedMotion();
  const startRef = useRef(0);
  const remainRef = useRef(duration);
  const timerRef = useRef(null);
  const nodeRef = useRef(null);
  const audioRef = useRef(null);

  const colors = TONE[tone] || TONE.success;
  const wrapClasses = `${PLACEMENT[placement]} ${zIndexClass}`;
  const offsetStyle =
    placement === "center"
      ? {}
      : { transform: `translateY(${stackIndex * 88}px)` }; // simple vertical stack offset

  // Timer logic (pausable)
  useEffect(() => {
    if (sticky) return; // no auto-hide
    startRef.current = performance.now();

    // kick progress
    setProgressPct(0);
    timerRef.current = requestAnimationFrame(tick);

    return () => {
      if (timerRef.current) cancelAnimationFrame(timerRef.current);
    };

    function tick(now) {
      const elapsed = now - startRef.current;
      const pct = Math.min(100, ((duration - remainRef.current + elapsed) / duration) * 100);
      setProgressPct(pct);
      if (elapsed >= remainRef.current) {
        // done
        setVisible(false);
        onClose?.();
        return;
      }
      timerRef.current = requestAnimationFrame(tick);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, sticky]);

  // Hover to pause/resume
  useEffect(() => {
    if (sticky || !hoverPause) return;
    if (hovered) {
      // pause
      if (timerRef.current) cancelAnimationFrame(timerRef.current);
      const now = performance.now();
      const elapsed = now - startRef.current;
      remainRef.current = Math.max(0, remainRef.current - elapsed);
    } else {
      // resume
      startRef.current = performance.now();
      timerRef.current = requestAnimationFrame(function tick(now) {
        const elapsed = now - startRef.current;
        const pct = Math.min(100, ((duration - remainRef.current + elapsed) / duration) * 100);
        setProgressPct(pct);
        if (elapsed >= remainRef.current) {
          setVisible(false);
          onClose?.();
          return;
        }
        timerRef.current = requestAnimationFrame(tick);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hovered, hoverPause, sticky]);

  // Focus on show, Esc to dismiss
  useEffect(() => {
    nodeRef.current?.focus?.();
    const onKey = (e) => {
      if (e.key === "Escape") {
        setVisible(false);
        onDismiss?.();
        onClose?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onDismiss]);

  // Haptics + sound (respect reduced motion)
  useEffect(() => {
    if (!reduced && vibrate && navigator?.vibrate) {
      try { navigator.vibrate([20, 40, 20]); } catch {}
    }
    if (!reduced && sound) {
      try {
        const a = new Audio(CHIME_SRC);
        audioRef.current = a;
        a.volume = 0.35;
        a.play().catch(() => {});
      } catch {}
    }
    return () => {
      try { audioRef.current?.pause?.(); } catch {}
    };
  }, [reduced, sound, vibrate]);

  const ariaLive = useMemo(() => (tone === "danger" ? "assertive" : "polite"), [tone]);
  const body = (
    <div className={wrapClasses} style={offsetStyle}>
      <AnimatePresence>
        {visible && (
          <motion.div
            ref={nodeRef}
            className={[
              "relative border shadow-lg rounded-xl p-4",
              "text-center",
              colors.wrap,
              widthClass,
              placement === "center" ? "" : "",
              "outline-none",
            ].join(" ")}
            variants={rewardVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            transition={{ duration: reduced ? 0.15 : 0.35, ease: "easeOut" }}
            role="status"
            aria-live={ariaLive}
            aria-atomic="true"
            tabIndex={-1}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            {/* Confetti (lightweight) */}
            <Confetti tone={tone} />

            {/* Content */}
            <div className="flex flex-col items-center">
              <div className="text-4xl mb-2 leading-none select-none" aria-hidden>
                {icon}
              </div>
              <p className="font-semibold leading-snug">{message}</p>

              {/* Progress */}
              {!sticky && showProgress && duration > 500 && (
                <div className="mt-3 w-full bg-black/10 rounded-full h-1 overflow-hidden">
                  <div
                    className="h-1 bg-black/30 transition-[width] duration-100 ease-linear"
                    style={{ width: `${Math.max(0, Math.min(100, Math.round(progressPct)))}%` }}
                    aria-hidden
                  />
                </div>
              )}

              {/* Controls */}
              {closeButton && (
                <button
                  className="absolute top-2 right-2 inline-flex items-center justify-center w-6 h-6 rounded hover:bg-black/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
                  onClick={() => {
                    setVisible(false);
                    onDismiss?.();
                    onClose?.();
                  }}
                  aria-label="Dismiss notification"
                  title="Dismiss"
                  type="button"
                >
                  ×
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  if (portalId && typeof document !== "undefined") {
    const target = document.getElementById(portalId);
    if (target) return ReactDOM.createPortal(body, target);
  }
  return body;
}

RewardPopup.propTypes = {
  message: PropTypes.string,
  icon: PropTypes.node,
  onClose: PropTypes.func,
  duration: PropTypes.number,

  tone: PropTypes.oneOf(["success", "info", "warning", "danger", "sabbath", "neutral"]),
  placement: PropTypes.oneOf(["bottom-right", "bottom-left", "top-right", "top-left", "center"]),
  sticky: PropTypes.bool,
  hoverPause: PropTypes.bool,
  showProgress: PropTypes.bool,
  closeButton: PropTypes.bool,
  onDismiss: PropTypes.func,
  zIndexClass: PropTypes.string,
  widthClass: PropTypes.string,
  stackIndex: PropTypes.number,
  portalId: PropTypes.string,
  sound: PropTypes.bool,
  vibrate: PropTypes.bool,
};
