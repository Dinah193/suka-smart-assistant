import React from "react";
import { classNames as cx } from "@/utils/css";

const SIZE_MAP = {
  sm: "h-10 w-10 text-xs",
  md: "h-12 w-12 text-sm",
  lg: "h-16 w-16 text-base",
};

function initialsFromName(name = "") {
  const tokens = String(name).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return "SV";
  if (tokens.length === 1) return tokens[0].slice(0, 2).toUpperCase();
  return `${tokens[0][0] || ""}${tokens[1][0] || ""}`.toUpperCase();
}

export default function Avatar({
  name,
  type = "user",
  imageUrl,
  size = "md",
  online = false,
  subtitle,
  className,
}) {
  const isHousehold = type === "household";
  const ringColor = isHousehold ? "ring-[#FBBF24]/60" : "ring-[#4F46E5]/55";

  return (
    <div className={cx("inline-flex items-center gap-3", className)}>
      <div className="relative">
        <div
          className={cx(
            "avatar rounded-2xl ring-2 bg-white p-[2px] shadow-sm transition-transform duration-200 hover:scale-[1.03]",
            ringColor
          )}
        >
          <div className={cx("rounded-xl overflow-hidden bg-slate-100", SIZE_MAP[size] || SIZE_MAP.md)}>
            {imageUrl ? (
              <img src={imageUrl} alt={name || "avatar"} className="h-full w-full object-cover" />
            ) : (
              <div
                className={cx(
                  "flex h-full w-full items-center justify-center font-bold",
                  isHousehold ? "bg-amber-100 text-amber-700" : "bg-indigo-100 text-indigo-700"
                )}
              >
                {initialsFromName(name)}
              </div>
            )}
          </div>
        </div>
        <span
          aria-hidden="true"
          className={cx(
            "absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white transition-all duration-200",
            online ? "bg-emerald-500" : "bg-slate-300"
          )}
        />
      </div>
      {(name || subtitle) && (
        <div className="leading-tight">
          <p className="font-semibold text-slate-800" style={{ fontFamily: "Inter, ui-sans-serif, system-ui" }}>
            {name}
          </p>
          {subtitle ? <p className="text-xs text-slate-500">{subtitle}</p> : null}
        </div>
      )}
    </div>
  );
}
