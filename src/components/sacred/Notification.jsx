import React from "react";
import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { classNames as cx } from "@/utils/css";

const TYPE_STYLES = {
  info: {
    icon: Info,
    box: "border-indigo-200 bg-indigo-50 text-indigo-800",
    iconWrap: "bg-indigo-100 text-indigo-700",
  },
  success: {
    icon: CheckCircle2,
    box: "border-emerald-200 bg-emerald-50 text-emerald-800",
    iconWrap: "bg-emerald-100 text-emerald-700",
  },
  warning: {
    icon: TriangleAlert,
    box: "border-amber-200 bg-amber-50 text-amber-900",
    iconWrap: "bg-amber-100 text-amber-700",
  },
  error: {
    icon: AlertCircle,
    box: "border-rose-200 bg-rose-50 text-rose-900",
    iconWrap: "bg-rose-100 text-rose-700",
  },
};

export default function Notification({
  type = "info",
  title,
  message,
  timestamp,
  onDismiss,
  className,
}) {
  const cfg = TYPE_STYLES[type] || TYPE_STYLES.info;
  const Icon = cfg.icon;

  return (
    <div
      role="status"
      className={cx(
        "animate-fade-in-up rounded-2xl border p-4 shadow-sm transition-all duration-300 hover:-translate-y-0.5",
        cfg.box,
        className
      )}
    >
      <div className="flex items-start gap-3">
        <div className={cx("mt-0.5 rounded-xl p-1.5", cfg.iconWrap)}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-display font-semibold">
            {title}
          </p>
          <p className="mt-1 text-sm leading-relaxed opacity-90">{message}</p>
          {timestamp ? <p className="mt-2 text-xs opacity-70">{timestamp}</p> : null}
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss notification"
            className="rounded-lg p-1.5 transition-colors duration-200 hover:bg-black/5"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
