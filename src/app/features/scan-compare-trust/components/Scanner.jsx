import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Camera,
  CameraOff,
  Flashlight,
  FlashlightOff,
  RefreshCcw,
  RotateCcw,
  QrCode,
  Barcode,
  Image as ImageIcon,
  FileText,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  Star,
  StarOff,
} from "lucide-react";

// ✅ NEW: mode panels
import PantryModePanel from "./modes/PantryModePanel";
import ShoppingModePanel from "./modes/ShoppingModePanel";
import ReceiptModePanel from "./modes/ReceiptModePanel";

// ✅ NEW: optional db (best-effort persistence)
import { db as dbImport } from "@/services/db";

/**
 * Scanner.jsx — Webcam/ZXing barcode + still capture
 *
 * Goals:
 *  - Webcam scanner (ZXing) with device picker & torch control (when supported)
 *  - Still photo capture (emits image scans)
 *  - Manual entry fallback (paste/type)
 *  - Emits orchestration events: "scan:item" (barcode/image/text)
 *  - Favorites-first: users can save frequently scanned codes/templates
 *  - DI-safe: accepts eventBus, automation, dateUtil via props (or window globals)
 *
 * ✅ Mode System:
 *  - Pantry / Shopping / Receipt modes
 *  - Shopping mode stages candidates (NOT committed) and requires receipt to commit
 *  - Receipt mode captures receipt and emits commit request for reconciliation pipeline
 *
 * Install (optional but recommended):
 *   npm i @zxing/library
 *
 * Usage:
 *   <Scanner />                       // uses window.__SUKA_* fallbacks or no-ops
 *   <Scanner eventBus={bus} automation={auto} />
 *
 * Optional globals for auto-wiring:
 *   window.__SUKA_EVENT_BUS__
 *   window.__SUKA_AUTOMATION__
 *   window.__SUKA_DATEUTIL__
 */

const MODES = /** @type {const} */ ({
  pantry: { key: "pantry", label: "Pantry", intent: "pantry.scan" },
  shopping: { key: "shopping", label: "Shopping", intent: "shopping.scan" },
  receipt: {
    key: "receipt",
    label: "Receipt",
    intent: "shopping.receipt.commit",
  },
});

export default function Scanner({
  eventBus: eventBusProp,
  automation: automationProp,
  dateUtil: dateUtilProp,
  aspect = 16 / 9,
  preferredFacingMode = "environment", // "user" | "environment"
}) {
  // --------------------------- DI & environment ---------------------------
  const isBrowser = typeof window !== "undefined";
  const g = /** @type {any} */ (isBrowser ? window : {});
  const noopBus = { emit: () => {}, on: () => {}, off: () => {} };
  const eventBus = eventBusProp || g.__SUKA_EVENT_BUS__ || noopBus;
  const automation = automationProp || g.__SUKA_AUTOMATION__ || null;
  const dateUtil = dateUtilProp || g.__SUKA_DATEUTIL__ || null;

  // Optional db (best-effort)
  const db = dbImport || null;

  // ------------------------------ Mode State ------------------------------
  const [mode, setMode] = useState(() => loadMode());
  const modeMeta = MODES[mode] || MODES.pantry;

  // Shopping mode session + stores
  const [selectedStores, setSelectedStores] = useState(() => loadStores());
  const [shoppingSessionId, setShoppingSessionId] = useState(() =>
    loadShoppingSessionId()
  );
  const [shoppingCandidates, setShoppingCandidates] = useState(() => []);

  // Receipt mode capture state
  const [receiptDraft, setReceiptDraft] = useState(null); // { id, kind, content, at, source }

  // ------------------------------ Local state ------------------------------
  const [hasCam, setHasCam] = useState(false);
  const [permission, setPermission] = useState("prompt"); // "granted"|"denied"|"prompt"
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [torch, setTorch] = useState(false);
  const [detected, setDetected] = useState(null); // { text, format, at }
  const [manual, setManual] = useState("");
  const [zx, setZx] = useState(null); // ZXing BrowserMultiFormatReader (lazy)
  const [err, setErr] = useState("");

  // favorites
  const [favs, setFavs] = useState(() => loadFavs());
  useEffect(() => saveFavs(favs), [favs]);

  // Refs
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const currentTrackRef = useRef(null);

  // ------------------------------ Effects -----------------------------------
  // Persist mode/stores/session
  useEffect(() => saveMode(mode), [mode]);
  useEffect(() => saveStores(selectedStores), [selectedStores]);
  useEffect(
    () => saveShoppingSessionId(shoppingSessionId),
    [shoppingSessionId]
  );

  // Emit mode change
  useEffect(() => {
    eventBus.emit?.("scanner:mode.changed", {
      id: uid("mode"),
      at: Date.now(),
      mode,
      intent: modeMeta.intent,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Probe devices
  useEffect(() => {
    if (!isBrowser || !navigator.mediaDevices?.enumerateDevices) return;
    (async () => {
      try {
        const devs = await navigator.mediaDevices.enumerateDevices();
        const cams = devs.filter((d) => d.kind === "videoinput");
        setDevices(cams);
        setHasCam(cams.length > 0);
        if (!deviceId && cams.length > 0) {
          const back = cams.find((d) => /back|rear|environment/i.test(d.label));
          setDeviceId((back || cams[0]).deviceId);
        }
      } catch (e) {
        setErr("Unable to enumerate cameras");
      }
    })();
  }, [isBrowser, deviceId]);

  // Load ZXing dynamically (if available)
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const mod = await safeImportZXing();
        if (!mounted) return;
        if (mod?.BrowserMultiFormatReader) {
          setZx(new mod.BrowserMultiFormatReader());
        } else {
          setZx(null); // graceful: manual/photo only
        }
      } catch {
        setZx(null);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // Start/stop stream when device changes or streaming toggles
  useEffect(() => {
    if (!isBrowser || !hasCam) return;
    if (streaming) {
      startStream(deviceId).catch((e) => {
        setErr(e?.message || "Failed to start camera");
        setStreaming(false);
      });
    } else {
      stopStream();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, streaming, hasCam]);

  // Try to toggle torch if supported
  useEffect(() => {
    const track = currentTrackRef.current;
    if (!track) return;
    toggleTorch(track, torch).catch(() => {});
  }, [torch]);

  // When leaving shopping mode, keep candidates but do not commit
  useEffect(() => {
    if (mode !== "shopping") return;
    // If stores already selected but no session, ensure session
    if (selectedStores?.length && !shoppingSessionId) {
      void ensureShoppingSession({
        stores: selectedStores,
        source: "auto.onModeEnter",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ------------------------------ Camera ------------------------------------
  async function startStream(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera not supported on this device");
    }

    const constraints = {
      audio: false,
      video: deviceId
        ? { deviceId: { exact: deviceId } }
        : {
            facingMode: preferredFacingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      setPermission("granted");
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      const track = stream.getVideoTracks()[0];
      currentTrackRef.current = track;

      const v = videoRef.current;
      if (v && aspect) v.style.aspectRatio = String(aspect);

      if (zx) {
        zx.decodeFromVideoDevice(
          deviceId || null,
          videoRef.current,
          (result, err) => {
            if (result) {
              onDetected({
                text: result.getText
                  ? result.getText()
                  : String(result.text || ""),
                format: String(
                  result.getBarcodeFormat
                    ? result.getBarcodeFormat()
                    : result.format || "unknown"
                ),
                at: Date.now(),
              });
            } else if (err && err.name !== "NotFoundException") {
              // ignore NotFoundException (no barcode in frame)
            }
          }
        );
      }

      setErr("");
    } catch (e) {
      if (String(e?.name).includes("NotAllowed")) {
        setPermission("denied");
        throw new Error(
          "Camera permission denied. Use manual entry or upload a photo."
        );
      }
      setPermission("prompt");
      throw e;
    }
  }

  function stopStream() {
    try {
      const v = videoRef.current;
      const stream = v?.srcObject;
      if (stream && typeof stream.getTracks === "function") {
        stream.getTracks().forEach((t) => t.stop());
      }
      if (zx?.reset) zx.reset();
      if (v) v.srcObject = null;
    } catch {}
  }

  async function toggleTorch(track, on) {
    if (!track?.getCapabilities) return;
    const caps = track.getCapabilities();
    if (!caps.torch) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !!on }] });
    } catch {}
  }

  // ------------------------------ Shopping Session --------------------------
  async function ensureShoppingSession({ stores, source = "ui" } = {}) {
    const storeSet = Array.isArray(stores) ? stores.filter(Boolean) : [];
    const storeSetKey = stableStoreSetKey(storeSet);

    if (!storeSet.length) return { ok: false, error: "No stores selected" };

    // If we already have a session for this storeSetKey, keep it.
    // (We don't strictly need to check DB; local session id is enough.)
    if (shoppingSessionId) {
      return {
        ok: true,
        sessionId: shoppingSessionId,
        reused: true,
        storeSetKey,
      };
    }

    const sessId = uid("shop");
    const session = {
      id: sessId,
      sessionId: sessId,
      kind: "shopping.session",
      domain: "shopping",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      storeSet,
      storeSetKey,
      source,
    };

    setShoppingSessionId(sessId);

    // Emit for automation/orchestrator
    eventBus.emit?.("shopping:stores.selected", {
      id: uid("evt"),
      at: Date.now(),
      stores: storeSet,
      storeSetKey,
      source,
    });

    eventBus.emit?.("shopping:session.created", {
      id: uid("evt"),
      at: Date.now(),
      session,
      source,
    });

    // Best-effort DB persist if a matching table exists.
    // Supports either camelCase or snake_case store names.
    try {
      const t =
        db?.shoppingSessions ||
        db?.shopping_sessions ||
        (db?.table ? safeTable(db, "shoppingSessions") : null) ||
        (db?.table ? safeTable(db, "shopping_sessions") : null);

      if (t?.put) {
        await t.put(session);
      }
    } catch {}

    return { ok: true, sessionId: sessId, reused: false, storeSetKey };
  }

  function onStoresChange(nextStores) {
    const stores = Array.isArray(nextStores) ? nextStores : [];
    setSelectedStores(stores);

    // selecting stores should create shopping session automatically
    if (stores.length) {
      void ensureShoppingSession({ stores, source: "ui.storeSelector" });
    } else {
      // if no stores, clear shopping session (staging can remain in UI)
      setShoppingSessionId(null);
    }
  }

  function stageShoppingCandidate(scanItem) {
    // Shopping candidates are provisional and tied to shoppingSessionId + stores.
    const cand = {
      id: uid("cand"),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "staged",
      domain: "shopping",
      shoppingSessionId: shoppingSessionId || null,
      stores: Array.isArray(selectedStores) ? selectedStores : [],
      storeSetKey: stableStoreSetKey(selectedStores || []),
      scan: scanItem, // keep original scan payload (kind/content/meta)
    };

    setShoppingCandidates((xs) => [cand, ...xs].slice(0, 200));

    eventBus.emit?.("shopping:candidate.staged", {
      id: uid("evt"),
      at: Date.now(),
      candidate: cand,
    });

    // Best-effort DB persist
    try {
      const t =
        db?.shoppingCandidates ||
        db?.shopping_candidates ||
        (db?.table ? safeTable(db, "shoppingCandidates") : null) ||
        (db?.table ? safeTable(db, "shopping_candidates") : null);

      if (t?.put) {
        void t.put(cand);
      }
    } catch {}
  }

  // ------------------------------ Actions ------------------------------------
  function emitScanItem({ kind, content, at, source, meta = {} }) {
    const id = uid("scan");
    const stores = Array.isArray(selectedStores) ? selectedStores : [];
    const payload = {
      id,
      kind,
      content,
      at: at || Date.now(),
      source: source || "unknown",
      meta: meta && typeof meta === "object" ? meta : {},
      mode,
      intent: modeMeta.intent,
      shoppingSessionId: shoppingSessionId || null,
      stores,
      storeSetKey: stableStoreSetKey(stores),
    };

    // Canonical scan event (existing pipeline)
    eventBus.emit?.("scan:item", payload);

    // Also emit an intent-scoped event (useful for Layer Spine router)
    eventBus.emit?.("layer:intent", {
      id: uid("intent"),
      at: payload.at,
      intent: payload.intent,
      mode,
      payload,
    });

    // Shopping staging
    if (mode === "shopping") {
      // Ensure session if stores exist
      if (stores.length && !shoppingSessionId) {
        void ensureShoppingSession({ stores, source: "auto.onScan" }).then(
          () => {
            stageShoppingCandidate(payload);
          }
        );
      } else {
        stageShoppingCandidate(payload);
      }
    }

    // Receipt mode capture (receipt artifact)
    if (mode === "receipt") {
      const receipt = {
        id: uid("rcpt"),
        kind,
        content,
        at: payload.at,
        source: payload.source,
        meta: payload.meta,
        intent: "shopping.receipt.commit",
        shoppingSessionId: shoppingSessionId || null,
        stores,
        storeSetKey: stableStoreSetKey(stores),
      };
      setReceiptDraft(receipt);

      eventBus.emit?.("shopping:receipt.captured", {
        id: uid("evt"),
        at: payload.at,
        receipt,
      });
    }

    return payload;
  }

  function onDetected(payload) {
    setDetected(payload);
    const code = payload.text?.trim();
    if (!code) return;

    const scanPayload = emitScanItem({
      kind: "barcode",
      content: code,
      at: payload.at,
      source: "camera.zxing",
      meta: { format: payload.format },
    });

    automation?.notify?.({
      title: "Barcode detected",
      message: `${code.slice(0, 60)}${code.length > 60 ? "…" : ""}`,
      ts: Date.now(),
      scope: "local",
      severity: mode === "shopping" ? "info" : "success",
      tags: ["scan", "barcode", mode],
      data: scanPayload,
    });
  }

  function captureImage() {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    const w = v.videoWidth || 1280;
    const h = v.videoHeight || 720;
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    ctx.drawImage(v, 0, 0, w, h);
    c.toBlob(
      (blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);

        const scanPayload = emitScanItem({
          kind: "image",
          content: url,
          at: Date.now(),
          source: "camera.capture",
          meta: { mime: "image/jpeg" },
        });

        automation?.notify?.({
          title: "Photo captured",
          message:
            mode === "receipt"
              ? "Receipt image captured"
              : "Image scan emitted",
          ts: Date.now(),
          scope: "local",
          severity: "info",
          tags: ["scan", "image", mode],
          data: scanPayload,
        });
      },
      "image/jpeg",
      0.9
    );
  }

  function onPickFile() {
    if (!isBrowser) return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const url = URL.createObjectURL(file);

      const scanPayload = emitScanItem({
        kind: "image",
        content: url,
        at: Date.now(),
        source: "upload",
        meta: { filename: file.name, mime: file.type || "image/*" },
      });

      automation?.notify?.({
        title: "Image selected",
        message: file.name,
        ts: Date.now(),
        scope: "local",
        severity: "info",
        tags: ["scan", "image", mode],
        data: scanPayload,
      });
    };
    input.click();
  }

  function submitManual() {
    const t = manual.trim();
    if (!t) return;

    const scanPayload = emitScanItem({
      kind: "text",
      content: t,
      at: Date.now(),
      source: "manual",
      meta: {},
    });

    setManual("");

    automation?.notify?.({
      title: mode === "receipt" ? "Receipt text captured" : "Text scanned",
      message: t.slice(0, 60),
      ts: Date.now(),
      scope: "local",
      severity: "info",
      tags: ["scan", "text", mode],
      data: scanPayload,
    });
  }

  // ------------------------------ Favorites ----------------------------------
  function saveFavorite() {
    const name = detected?.text || manual;
    if (!name) return;
    const fav = {
      id: uid("fav"),
      ownerId: "me",
      kind: "template",
      name,
      sourceRef: "scanner",
      createdAt: Date.now(),
      meta: { format: detected?.format, note: "Saved from Scanner" },
    };
    setFavs((xs) => [fav, ...xs].slice(0, 50));
    eventBus.emit?.("favorites:saved", fav);
    automation?.notify?.({
      title: "Saved to Favorites",
      message: name.slice(0, 60),
      ts: Date.now(),
      scope: "local",
      severity: "success",
    });
  }

  function removeFavorite(id) {
    setFavs((xs) => xs.filter((f) => f.id !== id));
    eventBus.emit?.("favorites:removed", {
      id,
      kind: "template",
      removedAt: Date.now(),
    });
  }

  // ------------------------------ Receipt Commit -----------------------------
  function requestReceiptCommit() {
    if (!receiptDraft) {
      automation?.notify?.({
        title: "Receipt required",
        message: "Capture or upload a receipt first.",
        ts: Date.now(),
        scope: "local",
        severity: "warning",
        tags: ["shopping", "receipt", "commit"],
      });
      return;
    }

    const req = {
      id: uid("commit"),
      at: Date.now(),
      intent: "shopping.receipt.commit",
      mode: "receipt",
      receipt: receiptDraft,
      shoppingSessionId: shoppingSessionId || null,
      stores: Array.isArray(selectedStores) ? selectedStores : [],
      storeSetKey: stableStoreSetKey(selectedStores || []),
      // Provide candidate snapshot for builder convenience; builder can also query DB.
      candidates: shoppingCandidates.slice(0, 200),
    };

    eventBus.emit?.("shopping:receipt.commit.requested", req);
    eventBus.emit?.("layer:intent", {
      id: uid("intent"),
      at: req.at,
      intent: "shopping.receipt.commit",
      mode: "receipt",
      payload: req,
    });

    automation?.notify?.({
      title: "Commit requested",
      message: "Receipt reconciliation/commit flow triggered.",
      ts: Date.now(),
      scope: "local",
      severity: "success",
      tags: ["shopping", "receipt", "commit"],
      data: req,
    });
  }

  // ------------------------------ Render ------------------------------------
  const supported = zx != null || hasCam;

  return (
    <div className="w-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 font-medium">
          <Barcode className="h-5 w-5" /> Scanner
          {!supported && (
            <span className="text-xs text-muted-foreground">
              {" "}
              • Camera/ZXing not available, use manual or image
            </span>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {detected?.at ? formatRelative(detected.at, dateUtil) : null}
        </div>
      </div>

      {/* ✅ Mode selector + mode panel */}
      <div className="mb-3 rounded-xl border p-3 bg-background">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-medium">Mode</div>
          <div className="flex items-center gap-2">
            <select
              className="text-sm rounded-md border px-2 py-1"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              {Object.values(MODES).map((m) => (
                <option key={m.key} value={m.key}>
                  {m.label}
                </option>
              ))}
            </select>

            {mode === "shopping" ? (
              <span className="text-[11px] text-muted-foreground">
                Staging only • commit requires receipt
              </span>
            ) : null}
            {mode === "receipt" ? (
              <span className="text-[11px] text-muted-foreground">
                Capture receipt • reconcile → commit
              </span>
            ) : null}
          </div>
        </div>

        <div className="mt-3">
          {mode === "pantry" ? <PantryModePanel /> : null}

          {mode === "shopping" ? (
            <ShoppingModePanel
              selectedStores={selectedStores}
              onStoresChange={onStoresChange}
              shoppingSessionId={shoppingSessionId}
              candidates={shoppingCandidates}
              onClearCandidates={() => setShoppingCandidates([])}
              onRemoveCandidate={(id) =>
                setShoppingCandidates((xs) => xs.filter((c) => c.id !== id))
              }
            />
          ) : null}

          {mode === "receipt" ? (
            <ReceiptModePanel
              selectedStores={selectedStores}
              shoppingSessionId={shoppingSessionId}
              candidatesCount={shoppingCandidates.length}
              receiptDraft={receiptDraft}
              onClearReceipt={() => setReceiptDraft(null)}
              onCommitRequest={requestReceiptCommit}
              onStoresEdit={() => setMode("shopping")}
            />
          ) : null}
        </div>
      </div>

      {/* Video / controls */}
      <div className="rounded-2xl border overflow-hidden bg-black/90 relative">
        <div className="aspect-video">
          {/* Video preview */}
          <video
            ref={videoRef}
            className="w-full h-full object-contain bg-black"
            muted
            playsInline
            autoPlay
          />
        </div>

        {/* Overlay controls */}
        <div className="absolute inset-x-0 bottom-0 p-2 flex items-center justify-between bg-gradient-to-t from-black/60 to-transparent">
          <div className="flex items-center gap-2">
            <button
              className="px-2 py-1 text-xs rounded-md border text-white/90 hover:bg-white/10"
              onClick={() => setStreaming((s) => !s)}
              title={streaming ? "Stop" : "Start"}
            >
              {streaming ? (
                <CameraOff className="h-4 w-4 inline mr-1" />
              ) : (
                <Camera className="h-4 w-4 inline mr-1" />
              )}{" "}
              {streaming ? "Stop" : "Start"}
            </button>

            <button
              className="px-2 py-1 text-xs rounded-md border text-white/90 hover:bg-white/10"
              onClick={() => setTorch((t) => !t)}
              disabled={!torchCapability(currentTrackRef.current)}
              title="Toggle flashlight"
            >
              {torch ? (
                <FlashlightOff className="h-4 w-4 inline mr-1" />
              ) : (
                <Flashlight className="h-4 w-4 inline mr-1" />
              )}{" "}
              Torch
            </button>

            <button
              className="px-2 py-1 text-xs rounded-md border text-white/90 hover:bg-white/10"
              onClick={() => {
                const idx = devices.findIndex((d) => d.deviceId === deviceId);
                const next =
                  devices[(idx + 1 + devices.length) % (devices.length || 1)];
                if (next) setDeviceId(next.deviceId);
              }}
              disabled={devices.length < 2}
              title="Switch camera"
            >
              <RefreshCcw className="h-4 w-4 inline mr-1" /> Camera
            </button>
          </div>

          <div className="flex items-center gap-2">
            <button
              className="px-3 py-1.5 text-xs rounded-md bg-white text-black hover:brightness-95"
              onClick={captureImage}
            >
              <ImageIcon className="h-4 w-4 inline mr-1" />{" "}
              {mode === "receipt" ? "Receipt" : "Photo"}
            </button>
          </div>
        </div>
      </div>

      {/* Device picker + status */}
      <div className="flex items-center justify-between gap-2 mt-2">
        <div className="flex items-center gap-2 text-xs">
          {err && (
            <span className="inline-flex items-center gap-1 text-red-600">
              <AlertCircle className="h-4 w-4" /> {err}
            </span>
          )}
          {!err && permission === "denied" ? (
            <span className="inline-flex items-center gap-1 text-amber-600">
              <AlertCircle className="h-4 w-4" /> Camera permission denied
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          <select
            className="text-sm rounded-md border px-2 py-1"
            value={deviceId || ""}
            onChange={(e) => setDeviceId(e.target.value)}
          >
            {devices.length === 0 ? <option value="">No cameras</option> : null}
            {devices.map((d, i) => (
              <option key={d.deviceId || i} value={d.deviceId}>
                {labelForDevice(d, i)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Detected preview + actions */}
      <AnimatePresence initial={false}>
        {detected?.text && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="mt-3 rounded-xl border p-3 bg-background"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">
                  {detected.text}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Format: {detected.format || "unknown"} • Mode:{" "}
                  <span className="font-medium">{modeMeta.label}</span>
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
                  onClick={saveFavorite}
                >
                  <Star className="h-4 w-4 inline mr-1" /> Save
                </button>
                <button
                  className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
                  onClick={() => setDetected(null)}
                >
                  <RotateCcw className="h-4 w-4 inline mr-1" /> Clear
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Manual + paste + upload fallback */}
      <div className="mt-3 rounded-xl border p-3">
        <div className="text-sm font-medium mb-2 flex items-center gap-2">
          <QrCode className="h-4 w-4" />{" "}
          {mode === "receipt"
            ? "Receipt Manual / Paste / Upload"
            : "Manual / Paste / Upload"}
        </div>
        <div className="flex items-center gap-2">
          <input
            className="flex-1 rounded-md border px-2 py-1 text-sm"
            placeholder={
              mode === "receipt"
                ? "Paste receipt text (or any line items)…"
                : "Type or paste a code / text…"
            }
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitManual()}
          />
          <button
            className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
            onClick={submitManual}
          >
            <CheckCircle2 className="h-4 w-4 inline mr-1" /> Submit
          </button>
          <button
            className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
            onClick={onPickFile}
          >
            <ImageIcon className="h-4 w-4 inline mr-1" /> Image
          </button>
          <button
            className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
            onClick={() =>
              navigator.clipboard
                ?.readText?.()
                .then((t) => setManual(t || manual))
                .catch(() => {})
            }
          >
            <FileText className="h-4 w-4 inline mr-1" /> Paste
          </button>
        </div>
        {mode === "shopping" ? (
          <div className="mt-2 text-[11px] text-muted-foreground">
            Scans are staged as candidates until a receipt commit is requested.
          </div>
        ) : null}
        {mode === "receipt" ? (
          <div className="mt-2 text-[11px] text-muted-foreground">
            Capture the receipt here, then click “Request Commit” in the Receipt
            panel.
          </div>
        ) : null}
      </div>

      {/* Favorites (local) */}
      <FavsPanel
        favs={favs}
        onRun={(f) =>
          runFavorite(f, (content) =>
            emitScanItem({
              kind: "text",
              content,
              at: Date.now(),
              source: "favorite",
            })
          )
        }
        onRemove={(id) => removeFavorite(id)}
        dateUtil={dateUtil}
      />

      {/* Hidden canvas for snapshots */}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}

/* ------------------------------ Subcomponents ------------------------------ */

function FavsPanel({ favs, onRun, onRemove, dateUtil }) {
  if (!favs?.length) return null;
  return (
    <div className="mt-3 rounded-xl border">
      <details open>
        <summary className="flex items-center justify-between px-3 py-2 text-sm">
          <span className="inline-flex items-center gap-2">
            <Star className="h-4 w-4" /> Favorites
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </summary>
        <div className="p-3 pt-0 flex flex-col gap-2">
          {favs.map((f) => (
            <div
              key={f.id}
              className="flex items-center justify-between gap-2 rounded-lg border p-2"
            >
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{f.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  Saved • {formatRelative(f.createdAt, dateUtil)}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <button
                  className="px-2 py-1 text-xs rounded-md border hover:bg-muted"
                  onClick={() => onRun(f)}
                >
                  Run
                </button>
                <button
                  className="p-1 rounded-md border hover:bg-muted"
                  onClick={() => onRemove(f.id)}
                  aria-label="Remove favorite"
                >
                  <StarOff className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

/* --------------------------------- Utils ----------------------------------- */

function uid(p = "scan") {
  return `${p}:${Math.random().toString(36).slice(2)}:${Date.now().toString(
    36
  )}`;
}

function formatRelative(ms, dateUtil) {
  try {
    return dateUtil?.formatRelative
      ? dateUtil.formatRelative(ms)
      : new Date(ms).toLocaleString();
  } catch {
    return new Date(ms).toLocaleString();
  }
}

function labelForDevice(d, i) {
  if (d?.label) return d.label;
  return `Camera ${i + 1}`;
}

function torchCapability(track) {
  try {
    return !!track?.getCapabilities?.()?.torch;
  } catch {
    return false;
  }
}

function loadFavs() {
  try {
    const raw = localStorage.getItem("suka:scanner:favs");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFavs(favs) {
  try {
    localStorage.setItem("suka:scanner:favs", JSON.stringify(favs));
  } catch {}
}

function runFavorite(f, emitFn) {
  const content = f?.meta?.content || f?.name || "";
  if (!content) return;
  emitFn(content);
}

function loadMode() {
  try {
    const m = localStorage.getItem("suka:scanner:mode");
    return m && MODES[m] ? m : "pantry";
  } catch {
    return "pantry";
  }
}

function saveMode(m) {
  try {
    localStorage.setItem("suka:scanner:mode", String(m || "pantry"));
  } catch {}
}

function loadStores() {
  try {
    const raw = localStorage.getItem("suka:scanner:stores");
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function saveStores(stores) {
  try {
    localStorage.setItem(
      "suka:scanner:stores",
      JSON.stringify(Array.isArray(stores) ? stores : [])
    );
  } catch {}
}

function loadShoppingSessionId() {
  try {
    const v = localStorage.getItem("suka:scanner:shoppingSessionId");
    return v ? String(v) : null;
  } catch {
    return null;
  }
}

function saveShoppingSessionId(id) {
  try {
    if (!id) {
      localStorage.removeItem("suka:scanner:shoppingSessionId");
    } else {
      localStorage.setItem("suka:scanner:shoppingSessionId", String(id));
    }
  } catch {}
}

function stableStoreSetKey(stores) {
  const arr = Array.isArray(stores)
    ? stores.map((s) => String(s || "").trim()).filter(Boolean)
    : [];
  arr.sort((a, b) => a.localeCompare(b));
  return arr.join("|");
}

function safeTable(db, name) {
  try {
    return db?.table?.(name);
  } catch {
    return null;
  }
}

/**
 * Dynamically import ZXing if available; otherwise return null to gracefully degrade.
 * Priority:
 *  1) window.ZXing (preloaded)
 *  2) ESM import('@zxing/library') if installed
 *  3) null
 */
async function safeImportZXing() {
  if (typeof window !== "undefined") {
    const ZXg = window.ZXing || window.__ZXING__;
    if (ZXg) return ZXg;
  }
  try {
    const mod = await import(/* webpackChunkName: "zxing" */ "@zxing/library");
    return mod;
  } catch {
    return null;
  }
}
