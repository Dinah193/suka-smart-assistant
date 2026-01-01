// src/ui/ReheatNotesPrinter.jsx
import React, { useEffect, useMemo, useState } from "react";

/**
 * ReheatNotesPrinter — dynamic, printable reheating/serving card
 *
 * Backwards-compatible props:
 *  - title?: string
 *  - lines?: string[]
 *  - footer?: string
 *
 * New optional props:
 *  - units?: 'imperial' | 'metric' (default 'imperial')
 *  - meta?: {
 *      serves?: number;
 *      allergens?: string[];
 *      bestBy?: string;      // YYYY-MM-DD
 *      preparedOn?: string;  // ISO or YYYY-MM-DD
 *      household?: string;
 *    }
 *  - showCheckboxes?: boolean (default true)
 *  - compact?: boolean        (default false; compact = larger density)
 *  - copies?: number          (default 1)
 *  - qr?: {
 *      imgSrc?: string;      // data: or http(s) URL for QR image
 *      url?: string;         // will use a public QR endpoint if imgSrc not provided
 *      caption?: string;     // text under QR
 *    }
 *  - onBeforePrint?: () => void
 *  - onAfterPrint?: () => void
 *
 * Rich line shape supported in `lines`:
 *  { text: string; method?: 'oven'|'microwave'|'stovetop'|'airfryer'|string;
 *    tempF?: number; tempC?: number; minutes?: number; note?: string; checked?: boolean; }
 */

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);

// round helper
const r = (n, d = 0) => (isFinite(n) ? Number(n.toFixed(d)) : undefined);

// °C <-> °F
const toC = (f) => (f == null ? undefined : (f - 32) * (5 / 9));
const toF = (c) => (c == null ? undefined : c * (9 / 5) + 32);

// normalize incoming lines to rich objects
function normalizeLines(lines, units) {
  const arr = Array.isArray(lines) ? lines : [];
  return arr.map((line) => {
    if (!isObj(line)) return { text: String(line), checked: false };
    const o = { ...line };
    // compute missing temps
    if (units === "metric" && o.tempC == null && o.tempF != null) o.tempC = r(toC(o.tempF));
    if (units === "imperial" && o.tempF == null && o.tempC != null) o.tempF = r(toF(o.tempC));
    return o;
  });
}

function MethodIcon({ m }) {
  const map = {
    oven: "🔥",
    microwave: "📡",
    stovetop: "🍳",
    airfryer: "💨",
  };
  return <span aria-hidden="true" title={m || ""}>{map[m] || "🍽️"}</span>;
}

function QR({ qr }) {
  if (!qr) return null;
  const { imgSrc, url, caption } = qr || {};
  const src =
    imgSrc ||
    (url
      ? `https://api.qrserver.com/v1/create-qr-code/?size=120x120&data=${encodeURIComponent(
          url
        )}`
      : null);
  if (!src) return null;
  return (
    <div className="mt-3 flex flex-col items-center print:mt-2">
      <img src={src} alt="QR code to full instructions" className="h-24 w-24" />
      {caption ? <div className="text-[11px] text-stone-500 mt-1 text-center">{caption}</div> : null}
    </div>
  );
}

export default function ReheatNotesPrinter({
  title = "Reheat Notes",
  lines = [],
  footer = "",
  units = "imperial",
  meta,
  showCheckboxes = true,
  compact = false,
  copies: copiesProp = 1,
  qr,
  onBeforePrint,
  onAfterPrint,
}) {
  const [copies, setCopies] = useState(Math.max(1, copiesProp | 0));
  const [localLines, setLocalLines] = useState(normalizeLines(lines, units));

  // keep in sync with incoming props
  useEffect(() => setLocalLines(normalizeLines(lines, units)), [lines, units]);

  // print hooks
  useEffect(() => {
    const before = () => onBeforePrint?.();
    const after = () => onAfterPrint?.();
    if (window.matchMedia) {
      const mql = window.matchMedia("print");
      const onChange = (e) => (e.matches ? before() : after());
      mql.addEventListener?.("change", onChange);
      return () => mql.removeEventListener?.("change", onChange);
    }
    window.addEventListener?.("beforeprint", before);
    window.addEventListener?.("afterprint", after);
    return () => {
      window.removeEventListener?.("beforeprint", before);
      window.removeEventListener?.("afterprint", after);
    };
  }, [onBeforePrint, onAfterPrint]);

  const allChecked = useMemo(
    () => localLines.length > 0 && localLines.every((l) => !!l.checked),
    [localLines]
  );

  const toggleAll = (next) =>
    setLocalLines((prev) => prev.map((l) => ({ ...l, checked: next })));

  const toggleLine = (idx) =>
    setLocalLines((prev) =>
      prev.map((l, i) => (i === idx ? { ...l, checked: !l.checked } : l))
    );

  const headerDate = useMemo(() => {
    const d = meta?.preparedOn ? new Date(meta.preparedOn) : new Date();
    return isFinite(d.getTime()) ? d.toLocaleDateString() : meta?.preparedOn;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta?.preparedOn]);

  const Card = ({ oneBased = 1 }) => (
    <div className="print:page break-inside-avoid p-6 max-w-2xl mx-auto text-stone-900 bg-white">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <h1 className={`font-bold ${compact ? "text-xl" : "text-2xl"} leading-tight`}>
            {title}
          </h1>
          {(meta?.household || meta?.serves || meta?.bestBy || meta?.allergens?.length) && (
            <div className="mt-1 text-sm text-stone-600 space-x-3 flex flex-wrap items-center">
              {meta?.household ? <span>Household: <strong>{meta.household}</strong></span> : null}
              {meta?.serves ? <span>Serves: <strong>{meta.serves}</strong></span> : null}
              {meta?.bestBy ? <span>Best by: <strong>{meta.bestBy}</strong></span> : null}
              {meta?.preparedOn ? <span>Prepared: <strong>{headerDate}</strong></span> : null}
              {meta?.allergens?.length ? (
                <span>Allergens: <strong>{meta.allergens.join(", ")}</strong></span>
              ) : null}
            </div>
          )}
        </div>

        {/* QR (optional) */}
        {qr ? (
          <div className="shrink-0">
            <QR qr={qr} />
          </div>
        ) : null}
      </div>

      {/* Checklist */}
      {localLines.length > 0 ? (
        <ul className={`mt-4 ${compact ? "space-y-1.5" : "space-y-2.5"} list-none pl-0`}>
          {localLines.map((l, i) => {
            const temp =
              units === "metric"
                ? l.tempC != null
                  ? `${r(l.tempC)}°C`
                  : l.tempF != null
                  ? `${r(toC(l.tempF))}°C`
                  : null
                : l.tempF != null
                ? `${r(l.tempF)}°F`
                : l.tempC != null
                ? `${r(toF(l.tempC))}°F`
                : null;
            const mins = isFinite(l.minutes) ? `${l.minutes} min` : null;
            return (
              <li key={i} className="flex items-start gap-3">
                {showCheckboxes ? (
                  <input
                    type="checkbox"
                    className="mt-1 w-5 h-5 accent-emerald-600 print:hidden"
                    checked={!!l.checked}
                    onChange={() => toggleLine(i)}
                    aria-label={`Step ${i + 1}`}
                  />
                ) : (
                  <span className="mt-1 inline-block w-4 h-4 border border-stone-400 rounded-sm print:inline-block" />
                )}

                <div className="flex-1 min-w-0">
                  <div className="text-[15px] leading-snug">
                    <span className="mr-2"><MethodIcon m={l.method} /></span>
                    <span className={`${l.checked ? "line-through text-stone-400" : "text-stone-800"}`}>
                      {l.text}
                    </span>
                  </div>

                  {(temp || mins || l.note) && (
                    <div className="mt-0.5 text-[12px] text-stone-500 flex flex-wrap gap-x-3 gap-y-1">
                      {temp ? <span>Temp: <strong className="text-stone-700">{temp}</strong></span> : null}
                      {mins ? <span>Time: <strong className="text-stone-700">{mins}</strong></span> : null}
                      {l.note ? <span className="italic">{l.note}</span> : null}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="mt-6 text-stone-600">No steps provided.</div>
      )}

      {/* Footer */}
      {footer ? (
        <p className="mt-6 text-sm text-stone-600">{footer}</p>
      ) : null}

      {/* Copy index + cut guide */}
      <div className="mt-6 text-[11px] text-stone-400 flex items-center justify-between print:mt-4">
        <span>Printed: {new Date().toLocaleString()}</span>
        <span className="print:hidden">Copy {oneBased} of {copies}</span>
        <span className="hidden print:inline">✂︎ Cut along dotted line</span>
      </div>
      <div className="mt-2 border-t border-dashed border-stone-300" />
    </div>
  );

  return (
    <div className="p-4 max-w-3xl mx-auto">
      {/* Screen controls (hidden when printing) */}
      <div className="print:hidden mb-4 flex flex-wrap items-center gap-3">
        <label className="text-sm text-stone-700 flex items-center gap-2">
          Copies
          <input
            type="number"
            min={1}
            max={12}
            value={copies}
            onChange={(e) => setCopies(Math.max(1, Number(e.target.value) || 1))}
            className="w-16 border border-stone-300 rounded px-2 py-1"
          />
        </label>

        <label className="text-sm text-stone-700 flex items-center gap-2">
          <input
            type="checkbox"
            checked={showCheckboxes}
            onChange={() => { /* preserved for controlled prop; noop */ }}
            disabled
          />
          Checkboxes
        </label>

        <label className="text-sm text-stone-700 flex items-center gap-2">
          <input
            type="checkbox"
            checked={compact}
            onChange={() => { /* controlled by prop; show local preview only if needed */ }}
            disabled
          />
          Compact
        </label>

        <button
          className="ml-auto px-3 py-1.5 border rounded-lg shadow-sm hover:shadow text-sm"
          onClick={() => window.print()}
        >
          Print
        </button>
        {localLines.length > 0 && (
          <button
            className="px-3 py-1.5 border rounded-lg text-sm"
            onClick={() => toggleAll(!allChecked)}
            title={allChecked ? "Uncheck all" : "Check all"}
          >
            {allChecked ? "Uncheck all" : "Check all"}
          </button>
        )}
      </div>

      {/* Render N copies with page breaks on print */}
      <div className="print:divide-y print:divide-dashed print:divide-stone-300">
        {Array.from({ length: copies }).map((_, i) => (
          <Card key={i} oneBased={i + 1} />
        ))}
      </div>

      {/* Print styles scoped here */}
      <style>{`
        /* Page & print hygiene */
        @media print {
          @page { size: auto; margin: 0.5in; } /* works for Letter/A4 */
          .print\\:hidden { display: none !important; }
          .print\\:mt-2 { margin-top: 0.5rem !important; }
          .print\\:mt-4 { margin-top: 1rem !important; }
          .print\\:divide-y > * + * { border-top: 1px dashed #d6d3d1; }
          .print\\:page { page-break-inside: avoid; page-break-after: always; }
        }
        /* Respect reduced motion (no fancy animations here) */
        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 1ms !important; transition-duration: 1ms !important; }
        }
      `}</style>
    </div>
  );
}
