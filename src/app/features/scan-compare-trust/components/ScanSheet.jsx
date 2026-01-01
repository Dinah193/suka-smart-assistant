import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  ShieldAlert,
  ShoppingCart,
  Share2,
  Star,
  StarOff,
  RefreshCw,
  X,
  Building2,
  DollarSign,
  CheckCircle2,
  TriangleAlert,
} from "lucide-react";

/**
 * ScanSheet — Bottom sheet that shows Compare/Trust results and quick actions
 *
 * Goals covered:
 *  - DI-safe: accepts eventBus, automation, dateUtil, listApi via props (falls back to window globals)
 *  - Integrates orchestration events: "scan:item", "compare:results", "trust:alerts"
 *  - User can Save favorites (sessions/schedules/templates) — emits favorites:* events
 *  - Polished UX inspired by mobile web bottom-sheets (Apple/Google)
 *  - Works with ScanFAB but can also be mounted standalone
 */
export default function ScanSheet({
  eventBus: eventBusProp,
  automation: automationProp,
  dateUtil: dateUtilProp,
  listApi: listApiProp, // optional: { add(itemName, meta) }
}) {
  // --------------------------- DI & environment ---------------------------
  const isBrowser = typeof window !== "undefined";
  const g = /** @type {any} */ (isBrowser ? window : {});
  const noopBus = { emit: () => {}, on: () => {}, off: () => {} };
  const eventBus = eventBusProp || g.__SUKA_EVENT_BUS__ || noopBus;
  const automation = automationProp || g.__SUKA_AUTOMATION__ || null;
  const dateUtil = dateUtilProp || g.__SUKA_DATEUTIL__ || null;
  const listApi = listApiProp || g.__SUKA_LIST_API__ || null;

  // ------------------------------ State ------------------------------------
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(null); // scan id
  const [scan, setScan] = useState(null); // { id, kind, content, at, itemName? }
  const [compare, setCompare] = useState(null); // { id, itemName, comparisons[] }
  const [trust, setTrust] = useState(null); // { id, alerts[] }
  const [saving, setSaving] = useState(false);

  // Sheet drag-to-close
  const startY = useRef(0);
  const lastY = useRef(0);
  const dragging = useRef(false);

  // Listen to orchestration events
  useEffect(() => {
    const onScan = (p) => {
      setScan(p);
      setCompare(null);
      setTrust(null);
      setActiveId(p.id);
      setOpen(true);
    };
    const onCompare = (p) => {
      if (activeId && p.id !== activeId) return; // ignore other scans
      setCompare(p);
      setOpen(true);
    };
    const onTrust = (p) => {
      if (activeId && p.id !== activeId) return;
      setTrust(p);
      setOpen(true);
    };

    eventBus.on?.("scan:item", onScan);
    eventBus.on?.("compare:results", onCompare);
    eventBus.on?.("trust:alerts", onTrust);
    return () => {
      eventBus.off?.("scan:item", onScan);
      eventBus.off?.("compare:results", onCompare);
      eventBus.off?.("trust:alerts", onTrust);
    };
  }, [eventBus, activeId]);

  const itemName = compare?.itemName || scan?.itemName || (scan?.content ? String(scan.content).slice(0, 40) : "");
  const when = scan?.at ? (dateUtil?.formatRelative ? dateUtil.formatRelative(scan.at) : new Date(scan.at).toLocaleString()) : "";

  const compareRows = useMemo(() => (compare?.comparisons || []).map((c, i) => ({
    key: `${c.store}-${i}`,
    store: c.store,
    price: c.price,
    unit: c.unit,
    lastSeen: c.lastSeen,
    coupon: c.coupon,
  })), [compare]);

  const trustAlerts = useMemo(() => (trust?.alerts || []), [trust]);

  function closeSheet() {
    setOpen(false);
    // defer clearing; if user reopens quickly we still have content
    setTimeout(() => { setCompare(null); setTrust(null); setScan(null); setActiveId(null); }, 400);
  }

  function saveFavorite(kind = "template") {
    if (!itemName) return;
    setSaving(true);
    const fav = {
      id: uid("fav"),
      ownerId: "me",
      kind, // "template" (scan/template) | "session" (quick-run)
      name: itemName,
      sourceRef: activeId,
      createdAt: Date.now(),
      meta: { scan, compare, trust },
    };
    eventBus.emit?.("favorites:saved", fav);
    automation?.notify?.({ title: "Saved to Favorites", message: fav.name, ts: Date.now(), scope: "local", severity: "success", tags: ["favorites", "scan"] });
    setSaving(false);
  }

  function removeFavorite(id) {
    eventBus.emit?.("favorites:removed", { id, kind: "template", removedAt: Date.now() });
  }

  function addToList() {
    if (!listApi || !itemName) return;
    const meta = { scanId: activeId, price: compareRows?.[0]?.price, unit: compareRows?.[0]?.unit };
    try { listApi.add?.(itemName, meta); automation?.notify?.({ title: "Added to list", message: itemName, ts: Date.now(), scope: "local", severity: "info" }); } catch {}
  }

  function rerunScan() {
    if (!scan) return;
    const payload = { ...scan, at: Date.now() };
    eventBus.emit?.("scan:item", payload);
  }

  // ------------------------------ Render ------------------------------------
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[95] flex items-end justify-center" aria-live="polite" aria-atomic>
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={closeSheet}
          />

          {/* Sheet */}
          <motion.div
            role="dialog"
            aria-label="Scan results"
            className="relative w-full max-w-xl rounded-t-2xl bg-background shadow-2xl border"
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 32 }}
            onMouseDown={(e) => { dragging.current = true; startY.current = e.clientY; lastY.current = e.clientY; }}
            onMouseMove={(e) => {
              if (!dragging.current) return;
              lastY.current = e.clientY;
              const dy = Math.max(0, lastY.current - startY.current);
              e.currentTarget.style.transform = `translateY(${dy}px)`;
              e.currentTarget.style.transition = "none";
            }}
            onMouseUp={(e) => {
              if (!dragging.current) return;
              dragging.current = false;
              e.currentTarget.style.transition = "";
              e.currentTarget.style.transform = "";
              const dy = Math.max(0, lastY.current - startY.current);
              if (dy > 120) closeSheet();
            }}
          >
            {/* Header */}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b">
              <div className="flex items-center gap-2 min-w-0">
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
                <div className="truncate font-medium">{itemName || "Scan"}</div>
                <div className="text-xs text-muted-foreground ml-2 truncate">{when}</div>
              </div>
              <div className="flex items-center gap-1">
                <button className="px-2 py-1 text-xs rounded-md border hover:bg-muted" onClick={rerunScan}><RefreshCw className="h-3 w-3 mr-1 inline" /> Re-run</button>
                <button className="p-1 rounded-md hover:bg-muted" onClick={closeSheet} aria-label="Close"><X className="h-4 w-4" /></button>
              </div>
            </div>

            {/* Content */}
            <div className="max-h-[70vh] overflow-auto">
              {/* Compare block */}
              {compareRows?.length > 0 && (
                <section className="px-4 py-3 border-b">
                  <div className="flex items-center gap-2 text-sm font-medium mb-2"><Building2 className="h-4 w-4" /> Store comparison</div>
                  <ul className="divide-y rounded-xl border overflow-hidden">
                    {compareRows.map((row) => (
                      <li key={row.key} className="flex items-center justify-between gap-2 px-3 py-2">
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{row.store}</div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {row.unit ? row.unit : ""} {row.lastSeen ? `• seen ${formatWhen(row.lastSeen, dateUtil)}` : ""}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          {row.coupon ? (
                            <span className="text-xs rounded-md bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-300/40 px-2 py-0.5">{row.coupon.label}</span>
                          ) : null}
                          <div className="text-sm font-semibold flex items-center gap-1"><DollarSign className="h-3 w-3" />{formatPrice(row.price)}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Trust alerts */}
              {trustAlerts?.length > 0 && (
                <section className="px-4 py-3 border-b">
                  <div className="flex items-center gap-2 text-sm font-medium mb-2"><ShieldAlert className="h-4 w-4" /> Trust alerts</div>
                  <ul className="flex flex-col gap-2">
                    {trustAlerts.map((a, i) => (
                      <li key={`${a.type}-${i}`} className="flex items-start gap-2 rounded-lg border p-2">
                        <TriangleAlert className="h-4 w-4 mt-0.5" />
                        <div className="min-w-0">
                          <div className="text-sm font-medium truncate">{a.title}</div>
                          {a.detail && <div className="text-[12px] text-muted-foreground whitespace-pre-wrap">{a.detail}</div>}
                          {a.source && <div className="text-[11px] text-muted-foreground truncate">Source: {a.source}</div>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>

            {/* Footer actions */}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40">
              <div className="flex items-center gap-2">
                <ActionButton icon={<Star className="h-4 w-4" />} label={saving ? "Saving…" : "Save"} onClick={() => saveFavorite("template")} disabled={saving || !itemName} />
                <ActionButton icon={<ShoppingCart className="h-4 w-4" />} label="Add to list" onClick={addToList} disabled={!itemName || !listApi} />
              </div>
              <div className="flex items-center gap-2">
                <ActionButton icon={<Share2 className="h-4 w-4" />} label="Share" onClick={() => sharePayload({ scan, compare, trust })} />
                <ActionButton icon={<CheckCircle2 className="h-4 w-4" />} label="Done" onClick={closeSheet} tone="primary" />
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

// ------------------------------ Subcomponents -------------------------------
function ActionButton({ icon, label, onClick, tone = "", disabled }) {
  const cls = tone === "primary"
    ? "bg-black text-white hover:brightness-110 border-black"
    : "bg-background hover:bg-muted border";
  return (
    <button disabled={disabled} onClick={onClick} className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm rounded-md ${cls} disabled:opacity-50 disabled:cursor-not-allowed`}>
      {icon}<span>{label}</span>
    </button>
  );
}

// ------------------------------ Utils --------------------------------------
const uid = (p = "scan") => `${p}:${Math.random().toString(36).slice(2)}:${Date.now().toString(36)}`;
function formatPrice(n) {
  if (n == null || isNaN(Number(n))) return "—";
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(Number(n)); } catch { return `$${Number(n).toFixed(2)}`; }
}
function formatWhen(iso, dateUtil) {
  if (!iso) return "";
  try { return dateUtil?.formatRelative ? dateUtil.formatRelative(new Date(iso).getTime()) : new Date(iso).toLocaleString(); } catch { return String(iso); }
}
function sharePayload(obj) {
  try {
    const text = JSON.stringify(obj, null, 2);
    if (navigator.share) {
      navigator.share({ text });
    } else if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
      // no toast here; parent may handle
    }
  } catch {}
}
