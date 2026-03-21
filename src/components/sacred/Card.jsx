import React from "react";
import { classNames as cx } from "@/utils/css";

const STYLE_BY_KIND = {
  dashboard: "border-indigo-100/70",
  meal: "border-emerald-100/80",
  storehouse: "border-amber-100/80",
  homestead: "border-slate-200/80",
};

export default function Card({
  title,
  subtitle,
  value,
  delta,
  icon,
  kind = "dashboard",
  footer,
  children,
  className,
}) {
  const positive = typeof delta === "number" && delta >= 0;

  return (
    <article
      className={cx(
        "group rounded-2xl border bg-white p-5 shadow-[0_8px_24px_rgba(15,23,42,0.06)] transition-all duration-300 hover:-translate-y-1 hover:scale-[1.01] hover:shadow-[0_18px_36px_rgba(79,70,229,0.14)]",
        STYLE_BY_KIND[kind] || STYLE_BY_KIND.dashboard,
        className
      )}
      style={{ backgroundColor: "#FFFFFF" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-display text-lg font-bold tracking-tight text-slate-900">
            {title}
          </h3>
          {subtitle ? <p className="mt-1 text-sm text-slate-500">{subtitle}</p> : null}
        </div>
        {icon ? (
          <div className="rounded-xl bg-slate-100/80 p-2 text-slate-700 transition-all duration-300 group-hover:bg-indigo-100 group-hover:text-indigo-700">
            {icon}
          </div>
        ) : null}
      </div>

      {(value != null || delta != null) && (
        <div className="mt-4 flex items-end justify-between">
          <p className="font-sans text-3xl font-black text-slate-900">
            {value}
          </p>
          {delta != null ? (
            <span className={cx("rounded-full px-2.5 py-1 text-xs font-semibold", positive ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700")}>
              {positive ? "+" : ""}
              {delta}%
            </span>
          ) : null}
        </div>
      )}

      {children ? <div className="mt-4 text-sm text-slate-600">{children}</div> : null}
      {footer ? <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">{footer}</div> : null}
    </article>
  );
}
