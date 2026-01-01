// C:\Users\larho\suka-smart-assistant\src\features\stability\StabilityRadarChart.jsx

/**
 * StabilityRadarChart
 *
 * Lightweight, dependency-free radar chart for visualizing SSA stability dimensions.
 *
 * How this fits:
 * - Designed to pair with StabilityDashboardView as the “at a glance” visual.
 * - You can pass in aggregated scores for different stability dimensions:
 *   device capabilities, guards, session resilience, background behavior, etc.
 * - Pure SVG, no external chart library required (keeps bundle small + predictable).
 *
 * Data contract (flexible):
 * - props.dimensions: Array<{ key, label, score, weight? }>
 *   • key: stable identifier (e.g. "device", "guards")
 *   • label: human-friendly name shown around the chart
 *   • score: numeric 0–1 (0 = poor, 1 = excellent). Values are clamped.
 *   • weight (optional): future extension if you want weighted styling or analytics.
 *
 * Example:
 *   <StabilityRadarChart
 *     dimensions={[
 *       { key: "device", label: "Device", score: 0.8 },
 *       { key: "guards", label: "Guards", score: 0.6 },
 *       { key: "session", label: "Session", score: 0.9 },
 *       { key: "background", label: "Background", score: 0.7 },
 *       { key: "integration", label: "Integration", score: 0.5 },
 *     ]}
 *   />
 */

import React, { useMemo } from "react";

/**
 * @typedef {Object} StabilityDimension
 * @property {string} key
 * @property {string} label
 * @property {number} score  // 0–1; will be clamped
 * @property {number} [weight]
 */

/**
 * @param {{
 *  dimensions?: StabilityDimension[],
 *  size?: number,
 *  ringCount?: number,
 *  className?: string,
 *  showLegend?: boolean,
 * }} props
 */
function StabilityRadarChart({
  dimensions,
  size = 260,
  ringCount = 4,
  className = "",
  showLegend = true,
}) {
  const safeDimensions = useMemo(() => {
    if (!Array.isArray(dimensions) || dimensions.length === 0) {
      // Provide a soft default so the component doesn't explode if called without props.
      return [
        { key: "device", label: "Device", score: 0.5 },
        { key: "guards", label: "Guards", score: 0.5 },
        { key: "session", label: "Session", score: 0.5 },
        { key: "background", label: "Background", score: 0.5 },
        { key: "integration", label: "Integration", score: 0.5 },
      ];
    }
    return dimensions.map((d) => ({
      key: d.key || d.label || "dim",
      label: d.label || d.key || "Dimension",
      score: clampScore(d.score),
      weight: typeof d.weight === "number" ? d.weight : 1,
    }));
  }, [dimensions]);

  const {
    pointCoords,
    axisCoords,
    ringRadius,
    center,
    labelOffsetRadius,
  } = useMemo(() => {
    const n = safeDimensions.length;
    const cx = size / 2;
    const cy = size / 2;
    const maxRadius = size * 0.35; // leave padding for labels
    const labelRadius = size * 0.42;

    /** @type {{x: number, y: number}[]} */
    const points = [];
    /** @type {{x: number, y: number, labelX: number, labelY: number, label: string}[]} */
    const axes = [];

    if (n === 0) {
      return {
        pointCoords: [],
        axisCoords: [],
        ringRadius: 0,
        center: { cx, cy },
        labelOffsetRadius: labelRadius,
      };
    }

    for (let i = 0; i < n; i += 1) {
      const dim = safeDimensions[i];
      // Rotate so that first axis is at the top (–90°).
      const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
      const axisX = cx + maxRadius * Math.cos(angle);
      const axisY = cy + maxRadius * Math.sin(angle);

      const valueRadius = maxRadius * clampScore(dim.score);
      const pointX = cx + valueRadius * Math.cos(angle);
      const pointY = cy + valueRadius * Math.sin(angle);

      const labelX = cx + labelRadius * Math.cos(angle);
      const labelY = cy + labelRadius * Math.sin(angle);

      points.push({ x: pointX, y: pointY });
      axes.push({
        x: axisX,
        y: axisY,
        labelX,
        labelY,
        label: dim.label,
      });
    }

    return {
      pointCoords: points,
      axisCoords: axes,
      ringRadius: maxRadius / ringCount,
      center: { cx, cy },
      labelOffsetRadius: labelRadius,
    };
  }, [safeDimensions, size, ringCount]);

  const polygonPath = useMemo(() => {
    if (!pointCoords.length) return "";
    return pointCoords
      .map((p, idx) => `${idx === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
      .join(" ") + " Z";
  }, [pointCoords]);

  const averageScore = useMemo(() => {
    if (!safeDimensions.length) return 0;
    const sum = safeDimensions.reduce((acc, d) => acc + clampScore(d.score), 0);
    return sum / safeDimensions.length;
  }, [safeDimensions]);

  const avgLabel = useMemo(() => {
    if (averageScore >= 0.8) return "Excellent";
    if (averageScore >= 0.6) return "Strong";
    if (averageScore >= 0.4) return "Moderate";
    if (averageScore > 0) return "At risk";
    return "Unknown";
  }, [averageScore]);

  return (
    <div className={`w-full flex flex-col items-center ${className}`}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          role="img"
          aria-label="Stability radar chart"
        >
          {/* Background rings */}
          {Array.from({ length: ringCount }).map((_, idx) => {
            const r = ringRadius * (idx + 1);
            return (
              <circle
                key={`ring-${idx}`}
                cx={center.cx}
                cy={center.cy}
                r={r}
                fill="none"
                stroke="#e5e7eb"
                strokeWidth={1}
              />
            );
          })}

          {/* Axes */}
          {axisCoords.map((axis, idx) => (
            <line
              key={`axis-${idx}`}
              x1={center.cx}
              y1={center.cy}
              x2={axis.x}
              y2={axis.y}
              stroke="#e5e7eb"
              strokeWidth={1}
            />
          ))}

          {/* Filled polygon */}
          {polygonPath && (
            <>
              <path
                d={polygonPath}
                fill="rgba(79, 70, 229, 0.16)" // indigo-ish area
                stroke="#4f46e5"
                strokeWidth={1.5}
              />
              {/* Vertex points */}
              {pointCoords.map((p, idx) => (
                <circle
                  key={`pt-${idx}`}
                  cx={p.x}
                  cy={p.y}
                  r={3}
                  fill="#4f46e5"
                  stroke="#eef2ff"
                  strokeWidth={1}
                />
              ))}
            </>
          )}

          {/* Center dot */}
          <circle
            cx={center.cx}
            cy={center.cy}
            r={3}
            fill="#0f172a"
            stroke="#e5e7eb"
            strokeWidth={1}
          />

          {/* Axis labels */}
          {axisCoords.map((axis, idx) => {
            const isLeft = axis.labelX < center.cx;
            const isTop = axis.labelY < center.cy;
            const textAnchor = isLeft ? "end" : "start";
            const dy = isTop ? "-0.25em" : "1em";
            return (
              <text
                key={`label-${idx}`}
                x={axis.labelX}
                y={axis.labelY}
                textAnchor={textAnchor}
                dy={dy}
                style={{
                  fontSize: 11,
                  fill: "#4b5563",
                  fontFamily:
                    'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
                }}
              >
                {axis.label}
              </text>
            );
          })}
        </svg>

        {/* Average score badge in the center */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="pointer-events-auto inline-flex flex-col items-center justify-center rounded-full bg-white/80 backdrop-blur-sm border border-slate-200 px-3 py-2 shadow-sm">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">
              Overall
            </span>
            <span className="text-sm font-semibold text-slate-900 leading-tight">
              {Math.round(averageScore * 100)}%
            </span>
            <span className="text-[11px] text-slate-500">{avgLabel}</span>
          </div>
        </div>
      </div>

      {showLegend && (
        <div className="mt-3 w-full max-w-xs">
          <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
            <span>Low</span>
            <span>High</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-200 overflow-hidden">
            <div
              className="h-full rounded-full bg-indigo-500 transition-all"
              style={{ width: `${Math.max(4, averageScore * 100)}%` }}
            />
          </div>
          <ul className="mt-3 space-y-1.5 text-xs text-slate-600">
            {safeDimensions.map((dim) => (
              <li
                key={dim.key}
                className="flex items-center justify-between gap-2"
              >
                <span className="truncate">{dim.label}</span>
                <span className="font-mono text-[11px] text-slate-500">
                  {Math.round(clampScore(dim.score) * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Clamp score into the [0, 1] interval.
 * @param {number} value
 * @returns {number}
 */
function clampScore(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export default StabilityRadarChart;
