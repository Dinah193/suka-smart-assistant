import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Barcode,
  QrCode,
  ScanLine,
  Image as ImageIcon,
  FileText,
  Star,
  StarOff,
  Clock,
  ChevronUp,
  ChevronDown,
  X,
} from "lucide-react";

/**
 * ScanFAB — Floating entry point for Scan • Compare • Trust
 *
 * Fixes: remove alias-based dynamic requires ("@/…") to avoid sandbox resolution errors.
 * Dependencies are now DI-friendly via props or global fallbacks:
 *   - eventBus: { emit, on, off }
 *   - automation: { notify, seed }
 *   - dateUtil: { formatRelative(dateMs) }
 *
 * Usage options:
 *   <ScanFAB />                                 // no-ops if globals not present
 *   <ScanFAB eventBus={bus} automation={auto} /> // explicit DI
 *
 * Optional globals (if you want auto-wiring without props):
 *   window.__SUKA_EVENT_BUS__
 *   window.__SUKA_AUTOMATION__
 *   window.__SUKA_DATEUTIL__
 */
export default function ScanFAB({ eventBus: eventBusProp, automation: automationProp, dateUtil: dateUtilProp }) {
  // --------------------------- DI & environment ---------------------------
  const isBrowser = typeof window !== "undefined";
  const g = (isBrowser ? window : /** @type {any} */({}));
  const noopBus = { emit: () => {}, on: () => {}, off: () => {} };
  const eventBus = eventBusProp || g.__SUKA_EVENT_BUS__ || noopBus;
  const automation = automationProp || g.__SUKA_AUTOMATION__ || null;
  const dateUtil = dateUtilProp || g.__SUKA_DATEUTIL__ || null;

  // ------------------------------ Local state ------------------------------
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [drag, setDrag] = useState(() => {
    if (!isBrowser) return { x: 20, y: 20 };
    try {
      const p = JSON.parse(g.localStorage?.getItem("suka:scanFab:pos"));
      return p || { x: 20, y: 20 };
    } catch { return { x: 20, y: 20 }; }
  });
  const [store, setStore] = useLocalStore(isBrowser);
  const panelRef = useRef(null);
  useOutsideClick(panelRef, () => setOpen(false));

  // ------------------------------ Shortcuts --------------------------------
  useEffect(() => {
    if (!isBrowser) return;
    function onKey(e) {
      if ((e.altKey || e.metaKey) && (e.key?.toLowerCase?.() === "s")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isBrowser]);

  // ------------------------------ Orchestration ---------------------------
  // Listen for results to enrich recents
  useEffect(() => {
    const onCompare = (p) => setStore((s) => ({ ...s, recents: mergeRecent(s.recents, { ...p, kind: "compare" }) }));
    const onTrust = (p) => setStore((s) => ({ ...s, recents: mergeRecent(s.recents, { ...p, kind: "trust" }) }));
    eventBus.on?.("compare:results", onCompare);
    eventBus.on?.("trust:alerts", onTrust);
    return () => {
      eventBus.off?.("compare:results", onCompare);
      eventBus.off?.("trust:alerts", onTrust);
    };
  }, [eventBus, setStore]);

  // ------------------------------ Actions ----------------------------------
  function emitScan(kind, content) {
    const id = uid("scan");
    const payload = { id, kind, content, at: now(), source: "desktop" };
    eventBus.emit?.("scan:item", payload);
    setStore((s) => ({ ...s, recents: mergeRecent(s.recents, payload) }));
    automation?.notify?.({ title: "Scanning…", message: describeScan(kind, content), ts: now(), scope: "local", severity: "info", tags: ["scan", kind] });
    setOpen(false);
  }

  function onPickFile(type) {
    if (!isBrowser) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = type === "image" ? "image/*" : "*/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);
      emitScan("image", url);
    };
    input.click();
  }

  function onPasteText() {
    if (!isBrowser) return;
    navigator.clipboard?.readText?.().then((text) => {
      if (!text) return;
      emitScan("text", text);
    }).catch(() => {
      setExpanded(true);
    });
  }

  function saveFavoriteFromRecent(r) {
    const fav = {
      id: uid("fav"),
      ownerId: "me",
      kind: r.kind === "compare" ? "template" : "session",
      name: r.itemName || r.content || "Saved scan",
      sourceRef: r.id,
      createdAt: now(),
      meta: { tags: ["scan"], content: r.content, comparisons: r.comparisons, alerts: r.alerts },
    };
    setStore((s) => ({ ...s, favs: [fav, ...s.favs].slice(0, 50) }));
    eventBus.emit?.("favorites:saved", fav);
    automation?.notify?.({ title: "Saved to Favorites", message: fav.name, ts: now(), scope: "local", severity: "success", tags: ["favorites", "scan"] });
  }

  function removeFavorite(id) {
    setStore((s) => ({ ...s, favs: s.favs.filter((f) => f.id !== id) }));
    eventBus.emit?.("favorites:removed", { id, kind: "template", removedAt: now() });
  }

  // ------------------------------ Position ----------------------------------
  function onDrag(e) {
    if (!isBrowser) return;
    const rect = (e.currentTarget?.parentElement || document.body).getBoundingClientRect();
    setDrag((p) => ({ x: clamp((p.x + (e.movementX || 0)), 8, rect.width - 80), y: clamp((p.y + (e.movementY || 0)), 8, rect.height - 80) }));
  }
  useEffect(() => { if (!isBrowser) return; try { g.localStorage?.setItem("suka:scanFab:pos", JSON.stringify(drag)); } catch {} }, [drag, g, isBrowser]);

  // ------------------------------ Render ------------------------------------
  return (
    <div className="fixed z-[90] pointer-events-none" style={{ inset: 0 }}>
      {/* Button container */}
      <div className="pointer-events-auto fixed" style={{ right: drag.x, bottom: drag.y }}>
        {/* Drag handle area */}
        <div
          className="absolute -top-2 -left-2 px-2 py-1 rounded-full text-xs text-muted-foreground bg-background/60 shadow-sm backdrop-blur-sm cursor-grab active:cursor-grabbing select-none"
          onMouseDown={(e) => { e.currentTarget.dataset.dragging = "1"; }}
          onMouseUp={(e) => { e.currentTarget.dataset.dragging = "0"; }}
          onMouseMove={(e) => { if (e.currentTarget.dataset.dragging === "1") onDrag(e); }}
          aria-label="Drag Scan Button"
        >
          <ChevronUp className="inline h-3 w-3 mr-1" /> drag
        </div>

        {/* Main FAB */}
        <motion.button
          whileTap={{ scale: 0.96 }}
          onClick={() => setOpen((v) => !v)}
          className="h-14 w-14 rounded-full shadow-xl bg-black text-white flex items-center justify-center hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-black"
          aria-label="Open Scan menu"
        >
          <ScanLine className="h-6 w-6" />
        </motion.button>

        {/* Quick radial actions */}
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 320, damping: 28 }}
              className="mt-3 w-[320px] rounded-2xl border bg-background shadow-2xl overflow-hidden"
              ref={panelRef}
            >
              <div className="flex items-center justify-between px-3 py-2 border-b">
                <div className="flex items-center gap-2 font-medium">
                  <ScanLine className="h-4 w-4" /> Scan • Compare • Trust
                </div>
                <button className="p-1 rounded-md hover:bg-muted" onClick={() => setOpen(false)} aria-label="Close">
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Actions */}
              <div className="grid grid-cols-4 gap-2 p-3">
                <ActionTile icon={<Barcode className="h-5 w-5" />} label="Barcode" onClick={() => emitScan("barcode", promptValue("Scan barcode value (mock)", isBrowser) )} />
                <ActionTile icon={<QrCode className="h-5 w-5" />} label="QR" onClick={() => emitScan("qrcode", promptValue("Scan QR (mock)", isBrowser) )} />
                <ActionTile icon={<ImageIcon className="h-5 w-5" />} label="Image" onClick={() => onPickFile("image")} />
                <ActionTile icon={<FileText className="h-5 w-5" />} label="Paste" onClick={onPasteText} />
              </div>

              {/* Expand toggle */}
              <button className="w-full text-sm text-muted-foreground hover:text-foreground flex items-center justify-center gap-1 py-1 border-t" onClick={() => setExpanded(v => !v)}>
                {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />} {expanded ? "Hide" : "Show"} recents & favorites
              </button>

              <AnimatePresence initial={false}>
                {expanded && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="border-t">
                    {/* Recents */}
                    <section className="p-3">
                      <div className="flex items-center gap-2 text-sm font-medium mb-2"><Clock className="h-4 w-4" /> Recent</div>
                      <div className="flex flex-col gap-2 max-h-52 overflow-auto pr-1">
                        {store.recents.length === 0 && (
                          <div className="text-sm text-muted-foreground">No scans yet. Try barcode, image, or paste text.</div>
                        )}
                        {store.recents.map((r) => (
                          <RecentRow key={r.id} r={r} onReRun={() => eventBus.emit?.("scan:item", { ...r, at: now() })} onFav={() => saveFavoriteFromRecent(r)} dateUtil={dateUtil} />
                        ))}
                      </div>
                    </section>

                    {/* Favorites */}
                    <section className="px-3 pb-3">
                      <div className="flex items-center gap-2 text-sm font-medium mb-2"><Star className="h-4 w-4" /> Favorites</div>
                      <div className="flex flex-col gap-2 max-h-44 overflow-auto pr-1">
                        {store.favs.length === 0 && (
                          <div className="text-sm text-muted-foreground">Save a scan or comparison to reuse later.</div>
                        )}
                        {store.favs.map((f) => (
                          <FavRow key={f.id} f={f} onRun={() => eventBus.emit?.("scan:item", { id: uid("scan"), kind: "text", content: f.meta?.content || f.name, at: now(), source: "favorite" })} onRemove={() => removeFavorite(f.id)} />
                        ))}
                      </div>
                    </section>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ------------------------------ Subcomponents -------------------------------
function ActionTile({ icon, label, onClick }) {
  return (
    <button onClick={onClick} className="group flex flex-col items-center justify-center gap-1 rounded-xl border p-3 hover:bg-muted transition">
      <div className="rounded-full p-2 border group-hover:shadow-md">{icon}</div>
      <div className="text-xs text-muted-foreground group-hover:text-foreground">{label}</div>
    </button>
  );
}

function RecentRow({ r, onReRun, onFav, dateUtil }) {
  const when = dateUtil?.formatRelative ? dateUtil.formatRelative(r.at) : new Date(r.at).toLocaleString();
  const subtitle = r.kind === "compare"
    ? `${(r.comparisons?.length || 0)} stores compared`
    : r.kind === "trust" ? `${(r.alerts?.length || 0)} alerts` : r.content?.slice(0, 40);
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border p-2">
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">{r.itemName || r.content || "Scan"}</div>
        <div className="text-[11px] text-muted-foreground truncate">{subtitle} • {when}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button className="px-2 py-1 text-xs rounded-md border hover:bg-muted" onClick={onReRun}>Run</button>
        <button className="p-1 rounded-md border hover:bg-muted" onClick={onFav} aria-label="Save to favorites"><Star className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

function FavRow({ f, onRun, onRemove }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border p-2">
      <div className="min-w-0">
        <div className="text-sm font-medium truncate">{f.name}</div>
        <div className="text-[11px] text-muted-foreground truncate">Saved • {new Date(f.createdAt).toLocaleDateString()}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button className="px-2 py-1 text-xs rounded-md border hover:bg-muted" onClick={onRun}>Run</button>
        <button className="p-1 rounded-md border hover:bg-muted" onClick={onRemove} aria-label="Remove favorite"><StarOff className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

// ------------------------------ Hooks & utils -------------------------------
function useLocalStore(isBrowser) {
  const [state, setState] = useState(() => {
    if (!isBrowser) return { favs: [], recents: [] };
    try { return JSON.parse(window.localStorage.getItem("suka:scanFab:v1")) || { favs: [], recents: [] }; }
    catch { return { favs: [], recents: [] }; }
  });
  useEffect(() => { if (!isBrowser) return; try { window.localStorage.setItem("suka:scanFab:v1", JSON.stringify(state)); } catch {} }, [state, isBrowser]);
  return [state, setState];
}

function useOutsideClick(ref, onOutside) {
  useEffect(() => {
    if (typeof document === "undefined") return;
    function onClick(e) { if (ref.current && !ref.current.contains(e.target)) onOutside?.(); }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [ref, onOutside]);
}

const STORE_KEY = "suka:scanFab:v1"; // kept for backward compatibility
const uid = (p = "scan") => `${p}:${Math.random().toString(36).slice(2)}:${Date.now().toString(36)}`;
const now = () => Date.now();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function mergeRecent(recents, item) {
  const idx = recents.findIndex((r) => r.id === item.id);
  const base = { id: item.id, at: item.at || now(), content: item.content || "", kind: item.kind || "scan", itemName: item.itemName, comparisons: item.comparisons, alerts: item.alerts };
  if (idx >= 0) {
    const next = recents.slice();
    next[idx] = { ...next[idx], ...base };
    return clampLen(next);
  }
  return clampLen([{ ...base }, ...recents]);
}
function clampLen(arr) { return arr.slice(0, 25); }

function promptValue(msg, isBrowser) {
  try { return isBrowser ? (window.prompt?.(msg) || "") : ""; } catch { return ""; }
}
