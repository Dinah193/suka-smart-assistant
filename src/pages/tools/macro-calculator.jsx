// C:\Users\larho\suka-smart-assistant\src\pages\tools\macro-calculator.jsx
//
// Macro Calculator / Nutrition Tool
// ---------------------------------
// This page is a SSA "Tools" view that helps the user:
//   - Track daily macros from imported foods (via barcode / OFF search / meal plans)
//   - Compute calories + macro percentages
//   - Save a daily snapshot to localStorage
//
// Pipeline role (imports → intelligence → automation → (optional) hub export):
// - imports:    food items from OpenFoodFacts, barcode scans, and meal plan JSON
// - intelligence: computes total grams, calories, macro percentages for a given day
// - automation: emits events on SSA eventBus so other domains (Meals, Storehouse,
//               Analytics) can react (e.g., propose sessions that fit macro targets)
// - hub export: NOT used here yet, because this page does not directly modify
//               inventory/storehouse/sessions. When/if it does, call
//               exportToHubIfEnabled(payload) around those writes.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
  forwardRef,
} from "react";
import eventBus from "../../services/events/eventBus"; // SSA shared event bus

/**************************** Event helpers *****************************/

function nowIso() {
  return new Date().toISOString();
}

/**
 * Emit a standardized SSA event from this tool.
 * Shape: { type, ts, source, data }
 */
function emitToolEvent(type, data = {}) {
  try {
    eventBus.emit({
      type,
      ts: nowIso(),
      source: "tools/macro-calculator",
      data,
    });
  } catch (err) {
    // Never let analytics/events crash the page
    // eslint-disable-next-line no-console
    console.warn("Macro calculator event emit failed:", err);
  }
}

// Placeholder for future Hub export when this tool starts writing household data
// (inventory, storehouse, or generated sessions).
// import featureFlags from "../../config/featureFlags";
// import HubPacketFormatter from "@/services/hub/HubPacketFormatter";
// import FamilyFundConnector from "@/services/hub/FamilyFundConnector";
// function exportToHubIfEnabled(payload) {
//   try {
//     if (!featureFlags?.familyFundMode) return;
//     const packet = HubPacketFormatter.format("nutritionSnapshot", payload);
//     FamilyFundConnector.send(packet);
//   } catch (err) {
//     console.warn("Macro calculator Hub export failed:", err);
//   }
// }

/********************** Small UI helpers (no external deps) **********************/
const btnBase =
  "inline-flex items-center justify-center rounded-xl border bg-white px-4 py-2 font-medium shadow-[0_6px_0_rgba(0,0,0,0.2),0_1px_4px_rgba(0,0,0,0.15)] active:translate-y-[4px] active:shadow-[0_2px_0_rgba(0,0,0,0.25),0_1px_2px_rgba(0,0,0,0.25)] transition-all";
const card =
  "rounded-3xl p-4 bg-gradient-to-b from-slate-50 to-slate-200 border border-slate-300 shadow-[0_10px_0_rgba(0,0,0,0.15),0_2px_8px_rgba(0,0,0,0.15)]";
const cardSoft =
  "rounded-3xl p-4 bg-gradient-to-b from-white to-slate-50 border border-slate-200 shadow-[0_8px_0_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.12)]";

function Input({ className = "", ...props }) {
  return (
    <input
      className={`h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-indigo-400 ${className}`}
      {...props}
    />
  );
}
function SmallInput({ className = "", ...props }) {
  return (
    <input
      className={`h-8 rounded-xl border border-slate-300 bg-white px-2 text-sm outline-none focus:ring-2 focus:ring-indigo-400 ${className}`}
      {...props}
    />
  );
}
function Textarea({ className = "", ...props }) {
  return (
    <textarea
      className={`min-h-[8rem] rounded-xl border border-slate-300 bg-white p-3 text-sm outline-none focus:ring-2 focus:ring-indigo-400 ${className}`}
      {...props}
    />
  );
}
function KeyBtn({ children, onClick, className = "", title }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`${btnBase} ${className}`}
    >
      {children}
    </button>
  );
}

/**************************** Nutrition utilities *****************************/
const clampNum = (n) => (Number.isFinite(+n) ? +n : 0);
const safe = (n) => (Number.isFinite(+n) && +n >= 0 ? +n : 0);

function computeTotals({ netCarb, fiber, sugarAlcohol, protein, fat }, opts) {
  const {
    includeFiberCalories,
    fiberCalPerGram,
    includeSACalories,
    saCalPerGram,
  } = opts;
  const carbCals = safe(netCarb) * 4;
  const protCals = safe(protein) * 4;
  const fatCals = safe(fat) * 9;
  const fiberCals = includeFiberCalories ? safe(fiber) * fiberCalPerGram : 0;
  const saCals = includeSACalories ? safe(sugarAlcohol) * saCalPerGram : 0;
  const totalCalories = carbCals + protCals + fatCals + fiberCals + saCals;
  return { carbCals, protCals, fatCals, fiberCals, saCals, totalCalories };
}
function computeMacroPercents({ carbCals, protCals, fatCals, totalCalories }) {
  const den = totalCalories || 1;
  return {
    carbsPct: carbCals / den,
    proteinPct: protCals / den,
    fatPct: fatCals / den,
  };
}

function parseServingToGrams(serv) {
  if (!serv) return 0;
  const s = String(serv).toLowerCase();
  const g = s.match(/([0-9]+(?:\.[0-9]+)?)\s*g/);
  if (g) return clampNum(g[1]);
  const ml = s.match(/([0-9]+(?:\.[0-9]+)?)\s*ml/);
  if (ml) return clampNum(ml[1]);
  const oz = s.match(/([0-9]+(?:\.[0-9]+)?)\s*fl\s*oz/);
  if (oz) return clampNum(oz[1]) * 29.5735;
  return 0;
}

function normalizeFromOFF(product) {
  const brand = product.brands || product.brand || "";
  const name =
    product.product_name ||
    product.generic_name ||
    product.product_name_en ||
    "Food";
  const label = [brand, name].filter(Boolean).join(" – ");
  const n = product.nutriments || {};
  const grams = parseServingToGrams(product.serving_size || "");
  const scale = grams ? grams / 100 : 1;
  const carbs100 = clampNum(n.carbohydrates_100g ?? n.carbs_100g ?? 0);
  const fiber100 = clampNum(n.fiber_100g ?? 0);
  const polyols100 = clampNum(n.polyols_100g ?? 0);
  const protein100 = clampNum(n.proteins_100g ?? 0);
  const fat100 = clampNum(n.fat_100g ?? 0);
  const tot = carbs100 * scale;
  const fib = fiber100 * scale;
  const sa = polyols100 * scale;
  const net = Math.max(0, tot - fib - sa);
  const pr = protein100 * scale;
  const ft = fat100 * scale;
  return {
    label,
    netCarb: net,
    fiber: fib,
    sugarAlcohol: sa,
    protein: pr,
    fat: ft,
    saType: "generic",
  };
}

const OFF_BASE = "https://world.openfoodfacts.org/api/v2";
async function fetchOpenFoodFactsUPC(upc) {
  const res = await fetch(
    `${OFF_BASE}/product/${encodeURIComponent(upc)}.json`
  );
  if (!res.ok) throw new Error("OFF lookup failed");
  const data = await res.json();
  if (data?.product) return normalizeFromOFF(data.product);
  throw new Error("Product not found (OFF)");
}
async function searchByNameOFF(query) {
  const url = `${OFF_BASE}/search?search_terms=${encodeURIComponent(
    query
  )}&page_size=10&json=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("OFF search failed");
  const data = await res.json();
  const products = data?.products || [];
  return products.map((p) => ({
    code: p.code,
    label: [p.brands || "", p.product_name || "Food"]
      .filter(Boolean)
      .join(" – "),
  }));
}

/************************** Barcode scanner modal **************************/
function BarcodeScanModal({
  open,
  onClose = () => {},
  onDetected = () => {},
  formats = ["ean-13", "ean-8", "upc-a", "upc-e"],
  preferredFacingMode = "environment",
  throttleMs = 150,
  autoClose = true,
  allowManual = true,
  initialUPC = "",
  showTorch = false,
  onError,
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const rafRef = useRef(0);
  const detectorRef = useRef(null);
  const [err, setErr] = useState("");
  const [manualUPC, setManualUPC] = useState(initialUPC);
  const [secureHint, setSecureHint] = useState("");
  const [torchOn, setTorchOn] = useState(false);
  const [torchSupported, setTorchSupported] = useState(false);

  useEffect(() => {
    if (!open) return;
    try {
      const isSecure =
        window.isSecureContext ||
        location.protocol === "https:" ||
        location.hostname === "localhost" ||
        location.hostname === "127.0.0.1";
      setSecureHint(
        isSecure
          ? ""
          : "Tip: Camera access usually requires HTTPS (or localhost)."
      );
    } catch {
      setSecureHint("");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    async function start() {
      setErr("");

      if (!("BarcodeDetector" in window)) {
        setErr("BarcodeDetector API not supported in this browser.");
        onError?.("BarcodeDetector unsupported");
        return;
      }

      try {
        detectorRef.current = new window.BarcodeDetector({ formats });
      } catch (e) {
        setErr("Failed to initialize barcode detector.");
        onError?.("Detector init failed");
        return;
      }

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: preferredFacingMode },
          audio: false,
        });
        if (cancelled) return;
        streamRef.current = stream;

        // Torch support check (best-effort)
        try {
          const track = stream.getVideoTracks?.()[0];
          const caps = track?.getCapabilities?.();
          if (showTorch && caps && "torch" in caps) {
            setTorchSupported(true);
          } else {
            setTorchSupported(false);
          }
        } catch {
          setTorchSupported(false);
        }

        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
      } catch (e) {
        setErr("Camera access denied or unavailable.");
        onError?.("Camera unavailable");
        return;
      }

      let last = 0;
      const loop = async (t) => {
        if (cancelled) return;
        rafRef.current = requestAnimationFrame(loop);
        if (!detectorRef.current || !videoRef.current) return;
        if (t - last < throttleMs) return;
        last = t;

        try {
          const codes = await detectorRef.current.detect(videoRef.current);
          const hit = codes?.[0]?.rawValue || null;
          if (hit) {
            const text = String(hit).trim();
            if (/^[0-9]{8,14}$/.test(text)) {
              onDetected(text);
              if (autoClose) onClose();
            }
          }
        } catch {
          // ignore transient errors
        }
      };

      rafRef.current = requestAnimationFrame(loop);
    }

    start();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      try {
        const tracks = streamRef.current?.getTracks?.() || [];
        tracks.forEach((t) => t.stop());
      } catch {}
      streamRef.current = null;
      detectorRef.current = null;
      setTorchOn(false);
    };
  }, [
    open,
    formats,
    preferredFacingMode,
    throttleMs,
    autoClose,
    showTorch,
    onClose,
    onDetected,
    onError,
  ]);

  async function toggleTorch(nextState) {
    try {
      const track = streamRef.current?.getVideoTracks?.()[0];
      const caps = track?.getCapabilities?.();
      if (!caps || !("torch" in caps)) return;
      await track.applyConstraints({ advanced: [{ torch: !!nextState }] });
      setTorchOn(!!nextState);
    } catch {
      // ignore
    }
  }

  if (!open) return null;

  const validUPC = /^[0-9]{8,14}$/.test(manualUPC);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-lg rounded-3xl overflow-hidden bg-gradient-to-b from-slate-100 to-slate-200 border border-slate-300 shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b">
          <h3 className="font-semibold">Scan Barcode</h3>
          <div className="flex items-center gap-2">
            {torchSupported && (
              <button
                className={btnBase}
                onClick={() => toggleTorch(!torchOn)}
                title="Toggle flashlight"
              >
                {torchOn ? "Torch Off" : "Torch On"}
              </button>
            )}
            <button className={btnBase} onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="p-3 space-y-3">
          {!err && (
            <div className="rounded-xl overflow-hidden bg-black">
              <video
                ref={videoRef}
                className="w-full aspect-video"
                muted
                playsInline
              />
            </div>
          )}

          {!!err && (
            <div className="text-sm text-amber-700 bg-amber-100 border border-amber-300 rounded-xl p-2">
              {err} — You can still enter or paste a UPC below. USB scanners
              work as keyboards.
            </div>
          )}

          {secureHint && (
            <div className="text-xs text-slate-500">{secureHint}</div>
          )}

          {allowManual && (
            <div className="flex w-full gap-2">
              <Input
                placeholder="Enter or scan UPC"
                value={manualUPC}
                onChange={(e) => setManualUPC(e.target.value)}
                onKeyDown={(e) =>
                  e.key === "Enter" &&
                  validUPC &&
                  (onDetected(manualUPC), autoClose && onClose())
                }
                autoFocus={!!err}
                className="flex-1"
              />
              <KeyBtn
                onClick={() =>
                  validUPC && (onDetected(manualUPC), autoClose && onClose())
                }
                title={validUPC ? "Import" : "Enter 8–14 digits"}
              >
                Import
              </KeyBtn>
              {"clipboard" in navigator && navigator.clipboard?.readText && (
                <KeyBtn
                  onClick={async () => {
                    try {
                      const txt = (
                        await navigator.clipboard.readText()
                      )?.trim();
                      if (txt) setManualUPC(txt);
                    } catch {}
                  }}
                >
                  Paste
                </KeyBtn>
              )}
            </div>
          )}

          <div className="text-xs text-slate-500">
            Tip: On desktop, a USB barcode scanner acts as a keyboard—focus the
            UPC input and scan.
          </div>
        </div>
      </div>
    </div>
  );
}

/************************ MacroPercentCalculator (full) ************************/
const MacroPercentCalculator = forwardRef(function MacroPercentCalculator(
  { settings, onTotalsChange },
  ref
) {
  const [manual, setManual] = useState({
    netCarb: 0,
    fiber: 0,
    sugarAlcohol: 0,
    protein: 0,
    fat: 0,
  });
  const [manualAdd, setManualAdd] = useState({
    netCarb: "",
    fiber: "",
    sugarAlcohol: "",
    protein: "",
    fat: "",
  });
  const [entries, setEntries] = useState([]); // {label, netCarb, fiber, sugarAlcohol, protein, fat, servings}

  const [includeFiberCalories, setIncludeFiberCalories] = useState(
    settings?.includeFiberCalories ?? true
  );
  const [fiberCalPerGram, setFiberCalPerGram] = useState(
    settings?.fiberCalPerGram ?? 2
  );
  const [includeSACalories, setIncludeSACalories] = useState(
    settings?.includeSACalories ?? true
  );
  const [saCalPerGram, setSACalPerGram] = useState(
    settings?.saCalPerGram ?? 2.4
  );

  useImperativeHandle(ref, () => ({
    addEntries: (arr = []) => {
      const normalized = arr.map((e) => ({
        label: e.label || "Item",
        netCarb: safe(e.netCarb),
        fiber: safe(e.fiber),
        sugarAlcohol: safe(e.sugarAlcohol),
        protein: safe(e.protein),
        fat: safe(e.fat),
        servings: clampNum(e.servings ?? 1),
        source: e.source,
        externalId: e.externalId,
      }));
      setEntries((prev) => [...normalized, ...prev]);

      // Emit import event so other SSA domains know nutrition entries were added.
      emitToolEvent("tools.macroCalculator.entries.added", {
        count: normalized.length,
        sources: normalized.map((n) => n.source || "unknown"),
      });
    },
    clear: () => {
      setEntries([]);
      setManual({
        netCarb: 0,
        fiber: 0,
        sugarAlcohol: 0,
        protein: 0,
        fat: 0,
      });
      emitToolEvent("tools.macroCalculator.cleared");
    },
    getSnapshot: () => ({ totals, calories: calcs, pct, entries }),
  }));

  const inc = (key, by) =>
    setManual((m) => ({ ...m, [key]: Math.max(0, clampNum(m[key]) + by) }));
  const onAbs = (key, v) =>
    setManual((m) => ({ ...m, [key]: Math.max(0, clampNum(v)) }));
  const onAddChange = (key, v) => setManualAdd((s) => ({ ...s, [key]: v }));
  const addCustom = (key) => {
    const amt = clampNum(manualAdd[key]);
    if (!Number.isFinite(amt) || amt === 0) return;
    inc(key, amt);
    setManualAdd((s) => ({ ...s, [key]: "" }));
  };

  const entriesSum = useMemo(
    () =>
      entries.reduce(
        (acc, e) => {
          const s = clampNum(e.servings || 1);
          acc.netCarb += safe(e.netCarb) * s;
          acc.fiber += safe(e.fiber) * s;
          acc.sugarAlcohol += safe(e.sugarAlcohol) * s;
          acc.protein += safe(e.protein) * s;
          acc.fat += safe(e.fat) * s;
          return acc;
        },
        { netCarb: 0, fiber: 0, sugarAlcohol: 0, protein: 0, fat: 0 }
      ),
    [entries]
  );

  const totals = useMemo(
    () => ({
      netCarb: safe(manual.netCarb) + entriesSum.netCarb,
      fiber: safe(manual.fiber) + entriesSum.fiber,
      sugarAlcohol: safe(manual.sugarAlcohol) + entriesSum.sugarAlcohol,
      protein: safe(manual.protein) + entriesSum.protein,
      fat: safe(manual.fat) + entriesSum.fat,
    }),
    [manual, entriesSum]
  );

  const calcs = useMemo(
    () =>
      computeTotals(totals, {
        includeFiberCalories,
        fiberCalPerGram,
        includeSACalories,
        saCalPerGram,
      }),
    [
      totals,
      includeFiberCalories,
      fiberCalPerGram,
      includeSACalories,
      saCalPerGram,
    ]
  );

  const pct = useMemo(() => computeMacroPercents(calcs), [calcs]);

  useEffect(() => {
    onTotalsChange?.(totals, calcs, pct);
  }, [totals, calcs, pct, onTotalsChange]);

  const ROWS = [
    { key: "netCarb", label: "Net Carbs (g)" },
    { key: "protein", label: "Protein (g)" },
    { key: "fat", label: "Fat (g)" },
    { key: "fiber", label: "Fiber (g)" },
    { key: "sugarAlcohol", label: "Sugar Alcohols (g)" },
  ];

  return (
    <div className="w-full grid lg:grid-cols-2 gap-6">
      {/* Left: Inputs */}
      <div className="space-y-4">
        <div className={card}>
          <div className="font-semibold mb-2">Manual totals (today)</div>

          {ROWS.map((f) => (
            <div
              key={f.key}
              className="grid grid-cols-[max-content_12rem_14rem_auto] items-center gap-2 py-1"
            >
              <label className="w-36 text-sm text-slate-700 text-right pr-3">
                {f.label}
              </label>

              {/* Absolute value input */}
              <Input
                type="number"
                inputMode="decimal"
                step="0.1"
                value={manual[f.key]}
                onChange={(e) => onAbs(f.key, e.target.value)}
                className="w-48"
              />

              {/* Manual add field */}
              <div className="flex items-center gap-2 w-[14rem]">
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  value={manualAdd[f.key]}
                  onChange={(e) => onAddChange(f.key, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addCustom(f.key)}
                  placeholder="+ grams"
                  aria-label={`Add ${f.label}`}
                  className="w-24"
                />
                <KeyBtn onClick={() => addCustom(f.key)}>Add</KeyBtn>
              </div>

              {/* Quick +1 / +5 buttons */}
              <div className="flex gap-2">
                <KeyBtn onClick={() => inc(f.key, +1)}>+1</KeyBtn>
                <KeyBtn onClick={() => inc(f.key, +5)}>+5</KeyBtn>
              </div>
            </div>
          ))}

          <div className="mt-3 flex gap-2">
            <KeyBtn
              onClick={() =>
                setManual({
                  netCarb: 0,
                  fiber: 0,
                  sugarAlcohol: 0,
                  protein: 0,
                  fat: 0,
                })
              }
            >
              Clear manual
            </KeyBtn>
          </div>
        </div>

        <div className={card}>
          <div className="font-semibold mb-2">Calorie model</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeFiberCalories}
                onChange={(e) => setIncludeFiberCalories(e.target.checked)}
              />
              Include Fiber Calories
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-600 w-32">Fiber cal/g</span>
              <Input
                type="number"
                step="0.1"
                value={fiberCalPerGram}
                onChange={(e) => setFiberCalPerGram(clampNum(e.target.value))}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeSACalories}
                onChange={(e) => setIncludeSACalories(e.target.checked)}
              />
              Include Sugar Alcohol Calories
            </label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-slate-600 w-32">
                Sugar alcohol cal/g
              </span>
              <Input
                type="number"
                step="0.1"
                value={saCalPerGram}
                onChange={(e) => setSACalPerGram(clampNum(e.target.value))}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Right: Totals & Entries */}
      <div className="space-y-4">
        <div className={cardSoft}>
          <div className="font-semibold mb-2">Today totals</div>
          <div className="grid grid-cols-2 gap-2 text-sm text-slate-700">
            <div>
              Net Carbs:{" "}
              <span className="font-semibold">
                {totals.netCarb.toFixed(1)} g
              </span>
            </div>
            <div>
              Protein:{" "}
              <span className="font-semibold">
                {totals.protein.toFixed(1)} g
              </span>
            </div>
            <div>
              Fat:{" "}
              <span className="font-semibold">{totals.fat.toFixed(1)} g</span>
            </div>
            <div>
              Fiber:{" "}
              <span className="font-semibold">{totals.fiber.toFixed(1)} g</span>
            </div>
            <div>
              Sugar Alcohols:{" "}
              <span className="font-semibold">
                {totals.sugarAlcohol.toFixed(1)} g
              </span>
            </div>
          </div>
          <div className="mt-3 text-sm text-slate-700">
            Calories total:{" "}
            <span className="font-bold">
              {calcs.totalCalories.toFixed(0)} kcal
            </span>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-sm">
            <div className="rounded-xl p-2 border bg-white">
              <div className="text-slate-500">Net Carb %</div>
              <div className="text-lg font-bold">
                {(pct.carbsPct * 100).toFixed(1)}%
              </div>
            </div>
            <div className="rounded-xl p-2 border bg-white">
              <div className="text-slate-500">Protein %</div>
              <div className="text-lg font-bold">
                {(pct.proteinPct * 100).toFixed(1)}%
              </div>
            </div>
            <div className="rounded-xl p-2 border bg-white">
              <div className="text-slate-500">Fat %</div>
              <div className="text-lg font-bold">
                {(pct.fatPct * 100).toFixed(1)}%
              </div>
            </div>
          </div>
        </div>

        <div className={card}>
          <div className="flex items-center justify-between mb-2">
            <div className="font-semibold">Imported items</div>
            <KeyBtn onClick={() => setEntries([])}>Clear</KeyBtn>
          </div>

          {entries.length === 0 ? (
            <div className="text-sm text-slate-500">
              Use Scan / Search to import foods. You can adjust servings.
            </div>
          ) : (
            <ul className="space-y-2">
              {entries.map((e, idx) => (
                <li
                  key={idx}
                  className="grid grid-cols-[max-content_12rem_14rem_auto] gap-2 items-center bg-white rounded-xl border p-2"
                >
                  <div className="text-sm font-medium truncate" title={e.label}>
                    {e.label}
                  </div>

                  <div className="flex items-center gap-1 text-sm">
                    <span className="text-slate-500">Servings</span>
                    <SmallInput
                      type="number"
                      step="0.25"
                      value={e.servings ?? 1}
                      onChange={(ev) => {
                        const v = clampNum(ev.target.value);
                        setEntries((prev) =>
                          prev.map((x, i) =>
                            i === idx ? { ...x, servings: Math.max(0, v) } : x
                          )
                        );
                      }}
                      className="w-20"
                    />
                  </div>

                  <KeyBtn
                    className="text-xs"
                    onClick={() =>
                      setEntries((prev) => prev.filter((_, i) => i !== idx))
                    }
                  >
                    Remove
                  </KeyBtn>

                  <details className="text-xs text-slate-600">
                    <summary className="cursor-pointer">Macros</summary>
                    <div>
                      net {e.netCarb}g, fiber {e.fiber}g, SA {e.sugarAlcohol}g,
                      protein {e.protein}g, fat {e.fat}g
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
});

/************************ NutritionImportBridge (toolbar) ************************/
function NutritionImportBridge({
  calcRef,
  enableBarcode = true,
  enableSearch = true,
  fdcProxyUrl = null, // reserved for future USDA/FDC proxy usage
  onImported = () => {},
}) {
  const [scanOpen, setScanOpen] = useState(false);
  const [upc, setUpc] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState([]);

  async function doLookup(code) {
    const up = String(code || "").trim();
    if (!up) return;
    setBusy(true);
    try {
      // Try OFF first
      const entry = await fetchOpenFoodFactsUPC(up);
      calcRef?.current?.addEntries([entry]);
      onImported([entry]);

      emitToolEvent("tools.macroCalculator.foodImported", {
        method: "upc",
        upc: up,
        count: 1,
      });
    } catch (e) {
      alert(e.message || "Lookup failed");
    } finally {
      setBusy(false);
    }
  }

  async function doSearch(q) {
    const s = String(q || "").trim();
    if (!s) return;
    setBusy(true);
    try {
      const items = await searchByNameOFF(s);
      setResults(items);
      emitToolEvent("tools.macroCalculator.foodSearch", {
        query: s,
        results: items.length,
      });
    } catch (e) {
      alert(e.message || "Search failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-6xl mx-auto space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {enableBarcode && (
          <KeyBtn onClick={() => setScanOpen(true)}>Scan Barcode</KeyBtn>
        )}
        <div className="flex items-center gap-2">
          <Input
            placeholder="Enter UPC"
            value={upc}
            onChange={(e) => setUpc(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && doLookup(upc)}
          />
          <KeyBtn onClick={() => doLookup(upc)}>
            {busy ? "Looking..." : "Lookup"}
          </KeyBtn>
        </div>
        {enableSearch && (
          <div className="flex items-center gap-2">
            <Input
              placeholder="Search name (Open Food Facts)"
              onKeyDown={(e) =>
                e.key === "Enter" && doSearch(e.currentTarget.value)
              }
              className="min-w-[18rem]"
            />
            <KeyBtn
              onClick={(e) => {
                const inp = e.currentTarget.previousSibling;
                if (inp && inp.value) doSearch(inp.value);
              }}
            >
              Search
            </KeyBtn>
          </div>
        )}
      </div>

      {!!results.length && (
        <div className="rounded-2xl border bg-white/80 p-3">
          <div className="text-sm font-medium mb-2">Search results</div>
          <ul className="space-y-2">
            {results.map((r) => (
              <li
                key={r.code}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-sm truncate">{r.label}</span>
                <KeyBtn onClick={() => doLookup(r.code)}>Import</KeyBtn>
              </li>
            ))}
          </ul>
        </div>
      )}

      <BarcodeScanModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onDetected={doLookup}
      />
    </div>
  );
}

/***************************** Meal Plan mapper *****************************/
function mapRecipeToMacroEntry(recipe) {
  const fiber = recipe.fiber ?? 0;
  const sa = recipe.sugarAlcohol ?? 0;
  const netCarb =
    recipe.netCarbs != null
      ? recipe.netCarbs
      : Math.max(0, (recipe.totalCarbs ?? 0) - fiber - sa);
  return {
    label: recipe.title || "Meal",
    netCarb,
    fiber,
    sugarAlcohol: sa,
    protein: recipe.protein ?? 0,
    fat: recipe.fat ?? 0,
    servings: recipe.servings ?? 1,
    source: "meal-plan",
    externalId: recipe.id,
  };
}

/******************************* The Page *********************************/
function toISODate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
const DEFAULT_SETTINGS = {
  includeFiberCalories: true,
  fiberCalPerGram: 2,
  includeSACalories: true,
  saCalPerGram: 2.4,
};

export default function MacroCalculatorPage() {
  const calcRef = useRef(null);
  const [dayKey, setDayKey] = useState(() => toISODate(new Date()));
  const [saved, setSaved] = useState(null);
  const [summary, setSummary] = useState([]);
  const [importOpen, setImportOpen] = useState(false);
  const [mealPlanText, setMealPlanText] = useState("");

  // Page open event
  useEffect(() => {
    emitToolEvent("tools.macroCalculator.opened", {
      dayKey,
    });
  }, []); // once on mount

  useEffect(() => {
    // hydrate for the day
    try {
      const raw = localStorage.getItem(`suka:nutrition:${dayKey}`);
      const snap = raw ? JSON.parse(raw) : null;
      setSaved(snap || null);
      if (calcRef.current?.clear) {
        calcRef.current.clear();
        if (snap?.entries?.length) calcRef.current.addEntries(snap.entries);
      }
    } catch {
      setSaved(null);
    }
    setSummary([]);
  }, [dayKey]);

  function simpleSummary(prev, cur) {
    const lines = [];
    const fmtG = (n) => `${Number(n).toFixed(1)} g`;
    const fmtK = (n) => `${Math.round(Number(n))} kcal`;
    const cmp = (k, lab, fmt = (x) => x) => {
      const a = prev?.totals?.[k] ?? 0,
        b = cur?.totals?.[k] ?? 0;
      if (Math.abs(a - b) > 0.05) lines.push(`${lab}: ${fmt(a)} → ${fmt(b)}`);
    };
    cmp("netCarb", "Net Carbs", fmtG);
    cmp("protein", "Protein", fmtG);
    cmp("fat", "Fat", fmtG);
    cmp("fiber", "Fiber", fmtG);
    cmp("sugarAlcohol", "Sugar Alcohols", fmtG);
    const tcA = prev?.calories?.totalCalories ?? 0,
      tcB = cur?.calories?.totalCalories ?? 0;
    if (Math.abs(tcA - tcB) > 0.5)
      lines.push(`Calories total: ${fmtK(tcA)} → ${fmtK(tcB)}`);
    const ec = prev?.entries?.length || 0,
      nc = cur?.entries?.length || 0;
    if (ec !== nc) lines.push(`Items: ${ec} → ${nc}`);
    return lines;
  }

  const handleTotalsChange = (totals, calories, pct) => {
    const entries = calcRef.current?.getSnapshot?.().entries ?? [];
    const current = { entries, totals, calories, pct };

    // Emit SSA event for analytics / other engines (e.g. nutrition-aware sessions).
    emitToolEvent("tools.macroCalculator.totalsChanged", {
      dayKey,
      totals,
      calories,
      pct,
      entryCount: entries.length,
    });

    if (saved) setSummary(simpleSummary(saved, current));
    else setSummary(entries.length ? ["New unsaved data"] : []);
  };

  const saveSnapshot = () => {
    const snap = calcRef.current?.getSnapshot?.();
    if (!snap) return;
    try {
      localStorage.setItem(`suka:nutrition:${dayKey}`, JSON.stringify(snap));
      setSaved(snap);
      setSummary([]);

      emitToolEvent("tools.macroCalculator.snapshot.saved", {
        dayKey,
        totals: snap.totals,
        calories: snap.calories,
        pct: snap.pct,
        entryCount: snap.entries?.length || 0,
      });

      // Potential future place to call exportToHubIfEnabled({ dayKey, ...snap });
    } catch {
      alert("Could not save snapshot.");
    }
  };
  const exportSnapshot = () => {
    const snap = calcRef.current?.getSnapshot?.();
    if (!snap) return;
    const file = new Blob([JSON.stringify({ dayKey, ...snap }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = `suka-macros-${dayKey}.json`;
    a.click();
    URL.revokeObjectURL(url);

    emitToolEvent("tools.macroCalculator.snapshot.exported", {
      dayKey,
    });
  };
  const clearDay = () => {
    if (!calcRef.current?.clear) return;
    calcRef.current.clear();
    setSummary(saved ? ["Cleared current working totals"] : []);

    emitToolEvent("tools.macroCalculator.dayCleared", {
      dayKey,
      hadSavedSnapshot: !!saved,
    });
  };
  const copySummary = async () => {
    try {
      const text = summary.length ? summary.join("\n") : "No changes.";
      await navigator.clipboard.writeText(text);
      emitToolEvent("tools.macroCalculator.summary.copied", {
        dayKey,
        lines: summary.length,
      });
    } catch {}
  };

  const importFromMealPlan = () => {
    let plan = null;
    if (typeof window !== "undefined" && window.sukaMealPlan)
      plan = window.sukaMealPlan;
    if (!plan && mealPlanText.trim()) {
      try {
        plan = JSON.parse(mealPlanText);
      } catch {
        alert("Invalid JSON");
        return;
      }
    }
    if (!plan) {
      alert("Provide window.sukaMealPlan or paste JSON.");
      return;
    }
    const recipes = Array.isArray(plan?.recipes) ? plan.recipes : [];
    if (!recipes.length) {
      alert("Meal plan has no recipes.");
      return;
    }
    const entries = recipes.map(mapRecipeToMacroEntry);
    calcRef.current?.addEntries(entries);
    setImportOpen(false);
    setMealPlanText("");

    emitToolEvent("tools.macroCalculator.mealPlanImported", {
      dayKey,
      recipeCount: recipes.length,
      entryCount: entries.length,
    });
  };

  return (
    <div className="space-y-6 p-4 max-w-6xl mx-auto">
      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Macro Calculator</h1>
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-600">Day</span>
            <Input
              type="date"
              value={dayKey}
              onChange={(e) => setDayKey(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <KeyBtn onClick={saveSnapshot} title="Save today's snapshot">
            Save
          </KeyBtn>
          <KeyBtn onClick={exportSnapshot} title="Download JSON">
            Export
          </KeyBtn>
          <KeyBtn
            onClick={copySummary}
            title="Copy change summary"
            className={!summary.length ? "opacity-60 cursor-not-allowed" : ""}
          >
            Copy Summary
          </KeyBtn>
          <KeyBtn onClick={clearDay} title="Clear current (keeps saved)">
            Clear Working
          </KeyBtn>
        </div>
      </header>

      {/* Change summary */}
      <section className={cardSoft}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Changes vs Saved</h2>
          <span className="text-xs text-slate-500">
            {saved ? "Comparing to last saved snapshot" : "Nothing saved yet"}
          </span>
        </div>
        {summary.length === 0 ? (
          <div className="text-sm text-slate-500 mt-2">No changes.</div>
        ) : (
          <ul className="mt-2 list-disc pl-5 space-y-1 text-sm">
            {summary.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Import toolbar (barcode/name search) */}
      <NutritionImportBridge
        calcRef={calcRef}
        enableBarcode
        enableSearch
        onImported={() => {}}
      />

      {/* Calculator */}
      <MacroPercentCalculator
        ref={calcRef}
        settings={DEFAULT_SETTINGS}
        onTotalsChange={handleTotalsChange}
      />

      {/* Meal Plan import panel */}
      <section className={card}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Import from Meal Plan</h2>
          <KeyBtn onClick={() => setImportOpen((s) => !s)}>
            {importOpen ? "Hide" : "Open"}
          </KeyBtn>
        </div>
        {importOpen && (
          <div className="mt-3 space-y-3">
            <p className="text-sm text-slate-600">
              Option A: set <code>window.sukaMealPlan</code> in devtools to your
              plan object then click “Import Plan”.
              <br />
              Option B: paste meal plan JSON below and click “Import Plan”.
            </p>
            <Textarea
              placeholder='{"recipes":[{"id":"abc","title":"Chicken Bowl","netCarbs":8,"protein":42,"fat":18,"fiber":3,"sugarAlcohol":0,"servings":1}]}'
              value={mealPlanText}
              onChange={(e) => setMealPlanText(e.target.value)}
            />
            <div className="flex gap-2">
              <KeyBtn onClick={importFromMealPlan}>Import Plan</KeyBtn>
              <KeyBtn onClick={() => setMealPlanText("")}>Clear Text</KeyBtn>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
