// File: src/components/cleaning/CleaningPlanShareModal.jsx
/**
 * CleaningPlanShareModal (SSA)
 * -----------------------------------------------------------------------------
 * Browser-only modal UI to share/export a Cleaning Plan schedule for a
 * housekeeper/manager/maid.
 *
 * Uses:
 *  - CleaningPlanExportService.createHousekeeperPacket()
 *  - CleaningPlanExportService.copyPacketText()
 *  - CleaningPlanExportService.downloadPacketFiles()
 *  - CleaningPlanExportService.openPrint()
 *
 * Features
 *  - Preview packet (HTML rendered in an iframe)
 *  - Copy packet text (SMS/email friendly)
 *  - Download HTML/CSV/ICS (and TXT via service download batch)
 *  - Open print dialog (user can "Save as PDF")
 *
 * Assumptions
 *  - You have shadcn/ui-style components OR your own UI components.
 *  - This file is written to be dependency-light: it uses plain HTML elements
 *    with minimal styling so it works even without a component library.
 *
 * Optional Props
 *  - open (boolean)
 *  - onClose () => void
 *  - planId (string) optional; defaults to active plan
 *  - defaultDays (number) default 7
 *  - title (string) modal title override
 *  - className (string)
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import CleaningPlanStore from "@/services/cleaning/CleaningPlanStore";
import CleaningPlanExportService from "@/services/cleaning/CleaningPlanExportService";

const DEFAULT_CONTACT = {
  name: "",
  phone: "",
  email: "",
  addressNote: "",
  entryInstructions: "",
  petsNote: "",
  preferredSupplies: "",
  doNotUse: "",
  allergies: "",
  notes: "",
};

function clamp(n, min, max) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : min;
}

function asStr(x) {
  return String(x ?? "");
}

function safeJoinLines(arr) {
  return (Array.isArray(arr) ? arr : []).filter(Boolean).join("\n");
}

function useEscapeKey(open, onClose) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);
}

export default function CleaningPlanShareModal({
  open = false,
  onClose,
  planId,
  defaultDays = 7,
  title = "Share Cleaning Plan",
  className = "",
}) {
  useEscapeKey(open, onClose);

  const [days, setDays] = useState(clamp(defaultDays, 1, 30));
  const [groupMode, setGroupMode] = useState("day"); // "day" | "day_room"
  const [includeTimes, setIncludeTimes] = useState(true);
  const [includeSteps, setIncludeSteps] = useState(true);
  const [includeSupplies, setIncludeSupplies] = useState(true);
  const [includeConstraints, setIncludeConstraints] = useState(true);
  const [includeContact, setIncludeContact] = useState(true);

  const [contact, setContact] = useState(DEFAULT_CONTACT);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [packet, setPacket] = useState(null);

  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef(null);

  const activePlanId = useMemo(() => {
    try {
      const st = CleaningPlanStore.getState?.();
      return st?.activePlanId || null;
    } catch {
      return null;
    }
  }, [open]);

  const effectivePlanId = planId || activePlanId;

  const options = useMemo(() => {
    return {
      title: "Housekeeper Work Order",
      groupMode,
      includeTimes,
      includeSteps,
      includeTotals: true,
      includeSupplies,
      includeConstraints,
      includeContact,
      contact: {
        ...contact,
        // allow comma separated entries
        preferredSupplies: contact.preferredSupplies,
        doNotUse: contact.doNotUse,
        allergies: contact.allergies,
      },
    };
  }, [
    groupMode,
    includeTimes,
    includeSteps,
    includeSupplies,
    includeConstraints,
    includeContact,
    contact,
  ]);

  useEffect(() => {
    if (!open) return;
    // hydrate store in case user opens modal fresh
    (async () => {
      try {
        await CleaningPlanStore.ensureHydrated?.();
      } catch {
        // ignore
      }
    })();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // auto-generate preview on open
    regenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // re-generate when toggles change (debounced small)
    const t = setTimeout(() => regenerate(), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, options, effectivePlanId, open]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  async function regenerate() {
    if (!open) return;
    setErr("");
    setLoading(true);
    try {
      const pkt = await CleaningPlanExportService.createHousekeeperPacket({
        planId: effectivePlanId,
        days,
        options,
      });
      if (!pkt?.ok) {
        setPacket(null);
        setErr(pkt?.error || "Failed to generate packet.");
      } else {
        setPacket(pkt);
      }
    } catch (e) {
      setPacket(null);
      setErr(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  async function onCopyText() {
    setErr("");
    setCopied(false);
    try {
      const res = await CleaningPlanExportService.copyPacketText({
        planId: effectivePlanId,
        days,
        options,
      });
      if (!res?.ok) throw new Error(res?.error || "Copy failed.");

      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }

  async function onDownloadAll() {
    setErr("");
    try {
      const res = await CleaningPlanExportService.downloadPacketFiles({
        planId: effectivePlanId,
        days,
        options,
        basename: "housekeeper_work_order",
      });
      if (!res?.ok) throw new Error(res?.error || "Download failed.");
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }

  async function onPrint() {
    setErr("");
    try {
      const res = await CleaningPlanExportService.openPrint({
        planId: effectivePlanId,
        days,
        options,
      });
      if (!res?.ok)
        throw new Error(res?.error || "Print failed (popup blocked?).");
    } catch (e) {
      setErr(String(e?.message || e));
    }
  }

  const previewSrcDoc =
    packet?.html || "<!doctype html><html><body></body></html>";

  const copyPreviewText = useMemo(() => {
    if (!packet?.text) return "";
    // keep the preview to a manageable size
    const lines = packet.text.split("\n");
    return (
      safeJoinLines(lines.slice(0, 80)) +
      (lines.length > 80 ? "\n…(truncated preview)…" : "")
    );
  }, [packet?.text]);

  if (!open) return null;

  return (
    <div
      className={`ssaModalOverlay ${className}`}
      role="dialog"
      aria-modal="true"
    >
      <div className="ssaModal">
        <div className="ssaModalHeader">
          <div>
            <div className="ssaTitle">{title}</div>
            <div className="ssaSub">
              Preview + share exports for a housekeeper (HTML/CSV/ICS + print to
              PDF).
            </div>
          </div>
          <button
            className="ssaBtn ssaBtnGhost"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="ssaModalBody">
          <div className="ssaGrid">
            {/* LEFT: Controls */}
            <div className="ssaPanel">
              <div className="ssaPanelTitle">Export Settings</div>

              <div className="ssaRow">
                <label className="ssaLabel">Days</label>
                <input
                  className="ssaInput"
                  type="number"
                  min={1}
                  max={30}
                  value={days}
                  onChange={(e) => setDays(clamp(e.target.value, 1, 30))}
                />
              </div>

              <div className="ssaRow">
                <label className="ssaLabel">Grouping</label>
                <select
                  className="ssaSelect"
                  value={groupMode}
                  onChange={(e) => setGroupMode(e.target.value)}
                >
                  <option value="day">Group by day</option>
                  <option value="day_room">Group by day + room</option>
                </select>
              </div>

              <div className="ssaChecks">
                <label className="ssaCheck">
                  <input
                    type="checkbox"
                    checked={includeTimes}
                    onChange={(e) => setIncludeTimes(e.target.checked)}
                  />
                  <span>Include times</span>
                </label>
                <label className="ssaCheck">
                  <input
                    type="checkbox"
                    checked={includeSteps}
                    onChange={(e) => setIncludeSteps(e.target.checked)}
                  />
                  <span>Include steps</span>
                </label>
                <label className="ssaCheck">
                  <input
                    type="checkbox"
                    checked={includeSupplies}
                    onChange={(e) => setIncludeSupplies(e.target.checked)}
                  />
                  <span>Include supplies</span>
                </label>
                <label className="ssaCheck">
                  <input
                    type="checkbox"
                    checked={includeConstraints}
                    onChange={(e) => setIncludeConstraints(e.target.checked)}
                  />
                  <span>Include “do not do” constraints</span>
                </label>
                <label className="ssaCheck">
                  <input
                    type="checkbox"
                    checked={includeContact}
                    onChange={(e) => setIncludeContact(e.target.checked)}
                  />
                  <span>Include contact/instructions</span>
                </label>
              </div>

              {includeContact ? (
                <div className="ssaContact">
                  <div className="ssaPanelTitle" style={{ marginTop: 10 }}>
                    Contact & Instructions
                  </div>

                  <div className="ssaRow">
                    <label className="ssaLabel">Name</label>
                    <input
                      className="ssaInput"
                      value={contact.name}
                      onChange={(e) =>
                        setContact((c) => ({ ...c, name: e.target.value }))
                      }
                      placeholder="Household contact name"
                    />
                  </div>

                  <div className="ssaRow2">
                    <div>
                      <label className="ssaLabel">Phone</label>
                      <input
                        className="ssaInput"
                        value={contact.phone}
                        onChange={(e) =>
                          setContact((c) => ({ ...c, phone: e.target.value }))
                        }
                        placeholder="(555) 555-5555"
                      />
                    </div>
                    <div>
                      <label className="ssaLabel">Email</label>
                      <input
                        className="ssaInput"
                        value={contact.email}
                        onChange={(e) =>
                          setContact((c) => ({ ...c, email: e.target.value }))
                        }
                        placeholder="name@example.com"
                      />
                    </div>
                  </div>

                  <div className="ssaRow">
                    <label className="ssaLabel">Entry instructions</label>
                    <textarea
                      className="ssaTextarea"
                      value={contact.entryInstructions}
                      onChange={(e) =>
                        setContact((c) => ({
                          ...c,
                          entryInstructions: e.target.value,
                        }))
                      }
                      placeholder="Door code, lock instructions, areas to avoid, etc."
                      rows={3}
                    />
                  </div>

                  <div className="ssaRow">
                    <label className="ssaLabel">
                      Preferred cleaning supplies (comma-separated)
                    </label>
                    <textarea
                      className="ssaTextarea"
                      value={contact.preferredSupplies}
                      onChange={(e) =>
                        setContact((c) => ({
                          ...c,
                          preferredSupplies: e.target.value,
                        }))
                      }
                      placeholder="e.g., Microfiber cloths, Dawn dish soap, Bona floor cleaner"
                      rows={2}
                    />
                    <div className="ssaHint">
                      These are explicitly included in the packet as “Preferred
                      supplies to use.”
                    </div>
                  </div>

                  <div className="ssaRow">
                    <label className="ssaLabel">
                      Do not use (comma-separated)
                    </label>
                    <input
                      className="ssaInput"
                      value={contact.doNotUse}
                      onChange={(e) =>
                        setContact((c) => ({ ...c, doNotUse: e.target.value }))
                      }
                      placeholder="e.g., Bleach, Ammonia, Strong fragrances"
                    />
                  </div>

                  <div className="ssaRow">
                    <label className="ssaLabel">
                      Allergies/sensitivities (comma-separated)
                    </label>
                    <input
                      className="ssaInput"
                      value={contact.allergies}
                      onChange={(e) =>
                        setContact((c) => ({ ...c, allergies: e.target.value }))
                      }
                      placeholder="e.g., Strong fragrances"
                    />
                  </div>

                  <div className="ssaRow">
                    <label className="ssaLabel">Notes</label>
                    <textarea
                      className="ssaTextarea"
                      value={contact.notes}
                      onChange={(e) =>
                        setContact((c) => ({ ...c, notes: e.target.value }))
                      }
                      placeholder="Anything else the cleaner should know."
                      rows={2}
                    />
                  </div>
                </div>
              ) : null}

              <div className="ssaActions">
                <button
                  className="ssaBtn"
                  onClick={regenerate}
                  disabled={loading}
                >
                  {loading ? "Generating…" : "Regenerate Preview"}
                </button>
                <button
                  className="ssaBtn"
                  onClick={onCopyText}
                  disabled={loading || !packet?.ok}
                >
                  {copied ? "Copied!" : "Copy Text"}
                </button>
                <button
                  className="ssaBtn"
                  onClick={onDownloadAll}
                  disabled={loading || !packet?.ok}
                >
                  Download HTML/CSV/ICS
                </button>
                <button
                  className="ssaBtn ssaBtnPrimary"
                  onClick={onPrint}
                  disabled={loading || !packet?.ok}
                >
                  Print / Save as PDF
                </button>
              </div>

              {err ? <div className="ssaError">{err}</div> : null}

              <div className="ssaFooterNote">
                Tip: “Print / Save as PDF” uses a popup window. If it doesn’t
                open, allow popups for this site.
              </div>
            </div>

            {/* RIGHT: Preview */}
            <div className="ssaPanel">
              <div className="ssaPanelTitle">Preview</div>

              {!packet && loading ? (
                <div className="ssaSkeleton">Generating preview…</div>
              ) : null}

              {!packet && !loading ? (
                <div className="ssaSkeleton">
                  No preview yet. Click “Regenerate Preview.”
                </div>
              ) : null}

              {packet ? (
                <>
                  <div className="ssaTabs">
                    <span className="ssaTabLabel">HTML Preview</span>
                    <span className="ssaTabHint">
                      (This matches the printed/PDF version)
                    </span>
                  </div>

                  <iframe
                    title="Housekeeper Packet Preview"
                    className="ssaIframe"
                    sandbox="allow-same-origin"
                    srcDoc={previewSrcDoc}
                  />

                  <div className="ssaTabs" style={{ marginTop: 10 }}>
                    <span className="ssaTabLabel">Text Preview</span>
                    <span className="ssaTabHint">(Copy/paste friendly)</span>
                  </div>

                  <pre className="ssaPre">{copyPreviewText}</pre>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Minimal CSS (scoped-ish via class names) */}
      <style>{`
        .ssaModalOverlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.55);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          z-index: 9999;
        }
        .ssaModal {
          width: min(1200px, 100%);
          max-height: min(92vh, 900px);
          background: #0b0b0b;
          color: #f2f2f2;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 16px;
          overflow: hidden;
          box-shadow: 0 20px 60px rgba(0,0,0,0.45);
          display: flex;
          flex-direction: column;
        }
        .ssaModalHeader {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 12px;
          padding: 14px 16px;
          border-bottom: 1px solid rgba(255,255,255,0.12);
          background: rgba(255,255,255,0.03);
        }
        .ssaTitle { font-weight: 800; font-size: 16px; }
        .ssaSub { font-size: 12px; opacity: 0.75; margin-top: 2px; }
        .ssaModalBody { padding: 14px 16px; overflow: auto; }
        .ssaGrid {
          display: grid;
          grid-template-columns: 420px 1fr;
          gap: 12px;
        }
        @media (max-width: 980px) {
          .ssaGrid { grid-template-columns: 1fr; }
        }
        .ssaPanel {
          background: rgba(255,255,255,0.03);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 14px;
          padding: 12px;
        }
        .ssaPanelTitle {
          font-weight: 800;
          font-size: 13px;
          margin-bottom: 10px;
        }
        .ssaRow { margin-bottom: 10px; }
        .ssaRow2 {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          margin-bottom: 10px;
        }
        .ssaLabel {
          display: block;
          font-size: 12px;
          opacity: 0.85;
          margin-bottom: 6px;
        }
        .ssaInput, .ssaSelect, .ssaTextarea {
          width: 100%;
          background: rgba(255,255,255,0.06);
          color: #f2f2f2;
          border: 1px solid rgba(255,255,255,0.14);
          border-radius: 10px;
          padding: 8px 10px;
          font-size: 13px;
          outline: none;
        }
        .ssaTextarea { resize: vertical; }
        .ssaInput:focus, .ssaSelect:focus, .ssaTextarea:focus {
          border-color: rgba(255,255,255,0.28);
        }
        .ssaChecks {
          display: grid;
          grid-template-columns: 1fr;
          gap: 8px;
          margin: 10px 0;
        }
        .ssaCheck {
          display: flex;
          gap: 10px;
          align-items: center;
          font-size: 13px;
          opacity: 0.95;
        }
        .ssaCheck input { transform: scale(1.05); }
        .ssaHint { font-size: 12px; opacity: 0.7; margin-top: 4px; }
        .ssaActions {
          display: grid;
          grid-template-columns: 1fr;
          gap: 8px;
          margin-top: 12px;
        }
        .ssaBtn {
          width: 100%;
          border-radius: 12px;
          padding: 9px 10px;
          font-weight: 800;
          font-size: 13px;
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.06);
          color: #f2f2f2;
          cursor: pointer;
        }
        .ssaBtn:hover { background: rgba(255,255,255,0.09); }
        .ssaBtn:disabled { opacity: 0.55; cursor: not-allowed; }
        .ssaBtnPrimary {
          background: rgba(255,255,255,0.16);
          border-color: rgba(255,255,255,0.22);
        }
        .ssaBtnGhost {
          width: auto;
          padding: 8px 10px;
          border-radius: 12px;
        }
        .ssaError {
          margin-top: 10px;
          padding: 10px;
          border-radius: 12px;
          background: rgba(255, 80, 80, 0.15);
          border: 1px solid rgba(255, 80, 80, 0.25);
          color: #ffd7d7;
          font-size: 12px;
          white-space: pre-wrap;
        }
        .ssaFooterNote {
          margin-top: 10px;
          font-size: 12px;
          opacity: 0.7;
        }
        .ssaIframe {
          width: 100%;
          height: 420px;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 12px;
          background: #fff;
        }
        .ssaTabs {
          display: flex;
          align-items: baseline;
          gap: 10px;
          margin: 6px 0 8px;
        }
        .ssaTabLabel { font-weight: 900; font-size: 12px; }
        .ssaTabHint { font-size: 12px; opacity: 0.7; }
        .ssaPre {
          width: 100%;
          max-height: 260px;
          overflow: auto;
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 12px;
          padding: 10px;
          font-size: 12px;
          line-height: 1.4;
          white-space: pre-wrap;
        }
        .ssaSkeleton {
          padding: 12px;
          border-radius: 12px;
          border: 1px dashed rgba(255,255,255,0.18);
          color: rgba(255,255,255,0.75);
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}
