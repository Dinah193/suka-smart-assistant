import React, { useEffect, useRef, useState } from "react";

/**
 * BarcodeScanModal (dependency-free)
 * - Uses native BarcodeDetector when available
 * - Clean manual UPC fallback (works with USB keyboard-wedge scanners)
 * - Torch toggle where supported (some mobile browsers)
 * - HTTPS + permission hints, full cleanup on close
 *
 * Props:
 *  open: boolean
 *  onClose(): void
 *  onDetected(code: string): void
 *  formats?: string[]                // default: ['ean-13','ean-8','upc-a','upc-e']
 *  preferredFacingMode?: 'environment'|'user'
 *  throttleMs?: number               // default: 150
 *  autoClose?: boolean               // default: true (close after detection)
 *  allowManual?: boolean             // default: true
 *  initialUPC?: string               // optional seed for manual box
 *  showTorch?: boolean               // default: false (attempt torch toggle)
 *  onError?(message: string): void   // optional error callback
 */
export default function BarcodeScanModal({
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

  // show HTTPS hint (camera rarely works on insecure origins)
  useEffect(() => {
    if (!open) return;
    try {
      const isSecure =
        window.isSecureContext ||
        location.protocol === "https:" ||
        location.hostname === "localhost" ||
        location.hostname === "127.0.0.1";
      if (!isSecure) setSecureHint("Tip: Camera access usually requires HTTPS (or localhost).");
      else setSecureHint("");
    } catch {
      setSecureHint("");
    }
  }, [open]);

  // start/stop camera + detection loop
  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    async function start() {
      setErr("");

      const hasDetector = "BarcodeDetector" in window;
      if (!hasDetector) {
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
          // ignore transient detection errors
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

  // torch toggle
  async function toggleTorch(nextState) {
    try {
      const track = streamRef.current?.getVideoTracks?.()[0];
      const caps = track?.getCapabilities?.();
      if (!caps || !("torch" in caps)) return;
      await track.applyConstraints({ advanced: [{ torch: !!nextState }] });
      setTorchOn(!!nextState);
    } catch {
      // silently ignore
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
                className="px-3 py-1 rounded-xl border shadow active:translate-y-[2px]"
                onClick={() => toggleTorch(!torchOn)}
                title="Toggle flashlight"
              >
                {torchOn ? "Torch Off" : "Torch On"}
              </button>
            )}
            <button
              className="px-3 py-1 rounded-xl border shadow active:translate-y-[2px]"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>

        <div className="p-3 space-y-3">
          {!err && (
            <div className="rounded-xl overflow-hidden bg-black">
              <video ref={videoRef} className="w-full aspect-video" muted playsInline />
            </div>
          )}

          {!!err && (
            <div className="text-sm text-amber-700 bg-amber-100 border border-amber-300 rounded-xl p-2">
              {err} — You can still enter or paste a UPC below. USB scanners work as keyboards.
            </div>
          )}

          {secureHint && (
            <div className="text-xs text-slate-500">
              {secureHint}
            </div>
          )}

          {allowManual && (
            <div className="join w-full">
              <input
                className="input input-bordered join-item w-full"
                placeholder="Enter or scan UPC"
                value={manualUPC}
                onChange={(e) => setManualUPC(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && validUPC && (onDetected(manualUPC), autoClose && onClose())}
                autoFocus={!!err}
              />
              <button
                className="join-item relative rounded-xl px-4 py-2 font-semibold bg-gradient-to-b from-slate-50 to-slate-200 border border-slate-300 shadow-[0_6px_0_rgba(0,0,0,0.2),0_1px_4px_rgba(0,0,0,0.15)] active:translate-y-[4px] active:shadow-[0_2px_0_rgba(0,0,0,0.25),0_1px_2px_rgba(0,0,0,0.25)]"
                onClick={() => validUPC && (onDetected(manualUPC), autoClose && onClose())}
                disabled={!validUPC}
                title={validUPC ? "Import" : "Enter an 8–14 digit UPC"}
              >
                Import
              </button>
              {"clipboard" in navigator && navigator.clipboard?.readText && (
                <button
                  className="join-item relative rounded-xl px-4 py-2 font-semibold bg-gradient-to-b from-slate-50 to-slate-200 border border-slate-300 shadow-[0_6px_0_rgba(0,0,0,0.2),0_1px_4px_rgba(0,0,0,0.15)] active:translate-y-[4px] active:shadow-[0_2px_0_rgba(0,0,0,0.25),0_1px_2px_rgba(0,0,0,0.25)]"
                  onClick={async () => {
                    try {
                      const txt = (await navigator.clipboard.readText())?.trim();
                      if (txt) setManualUPC(txt);
                    } catch {}
                  }}
                  title="Paste from clipboard"
                >
                  Paste
                </button>
              )}
            </div>
          )}

          <div className="text-xs text-slate-500">
            Tip: On desktop, a USB barcode scanner acts as a keyboard—focus the UPC input and scan.
          </div>
        </div>
      </div>
    </div>
  );
}
