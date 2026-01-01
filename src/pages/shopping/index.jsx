/* eslint-disable no-console */
// src/pages/shopping/index.jsx
// -----------------------------------------------------------------------------
// Shopping Sessions — dedicated view for Shopping Mode
// -----------------------------------------------------------------------------
// Responsibilities:
// - List shopping sessions (recent trips) + allow resume
// - Show staged candidates waiting on receipt
// - Show receipts pending reconciliation
// - Provide 1-click entrypoints into Scanner in Shopping mode or Receipt mode
//
// Notes:
// - Scanner mode is stored in localStorage (suka:scanner:mode)
// - Scanner shopping session id is stored in localStorage (suka:scanner:shoppingSessionId)
// - Shopping staging tables live in Dexie (db.shoppingSessions, db.shoppingCandidates, db.receiptReconciliations)
//   but this page is safe if those tables are missing.
//
// Styling:
// - Uses bridge.scan.css chips/buttons so it matches the Scan experience.
// -----------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import DashboardSection from "@/components/layout/DashboardSection";
import db from "@/services/db";
import "@/styles/bridge.scan.css";

const NULL = Object.freeze({
  toArray: async () => [],
  where: () => ({ toArray: async () => [] }),
  orderBy: () => ({
    reverse: () => ({ limit: () => ({ toArray: async () => [] }) }),
  }),
});

function useQueryTab() {
  const loc = useLocation();
  return useMemo(() => {
    const sp = new URLSearchParams(loc.search || "");
    return (sp.get("tab") || "sessions").toLowerCase();
  }, [loc.search]);
}

function setScannerMode(mode) {
  try {
    localStorage.setItem("suka:scanner:mode", String(mode || "shopping"));
  } catch {}
}
function clearScannerShoppingSession() {
  try {
    localStorage.removeItem("suka:scanner:shoppingSessionId");
  } catch {}
}
function setScannerShoppingSessionId(id) {
  try {
    if (!id) return;
    localStorage.setItem("suka:scanner:shoppingSessionId", String(id));
  } catch {}
}

function fmtTime(ts) {
  try {
    if (!ts) return "";
    const d = typeof ts === "number" ? new Date(ts) : new Date(String(ts));
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString();
  } catch {
    return "";
  }
}

function statusChip(status) {
  const s = String(status || "").toLowerCase();
  if (!s) return "chip chip--soft";
  if (["staged", "matched"].includes(s)) return "chip chip--warn";
  if (["reconciled"].includes(s)) return "chip chip--ok";
  if (["committed"].includes(s)) return "chip chip--ok";
  if (["discarded", "void"].includes(s)) return "chip chip--danger";
  return "chip chip--soft";
}

export default function ShoppingPage() {
  const navigate = useNavigate();
  const tab = useQueryTab();

  const [loading, setLoading] = useState(true);
  const [sessions, setSessions] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [err, setErr] = useState("");

  const shoppingSessionsTable = db?.shoppingSessions || NULL;
  const shoppingCandidatesTable = db?.shoppingCandidates || NULL;
  const receiptReconsTable = db?.receiptReconciliations || NULL;

  const counts = useMemo(() => {
    const waitingReceipt = (candidates || []).filter((r) => {
      const st = String(r?.status || "").toLowerCase();
      if (!st) return true;
      return !["reconciled", "committed", "discarded"].includes(st);
    }).length;

    const receiptsPending = (receipts || []).filter((r) => {
      const st = String(r?.status || "").toLowerCase();
      if (!st) return true;
      return !["reconciled", "committed", "closed", "done"].includes(st);
    }).length;

    return {
      sessions: (sessions || []).length,
      waitingReceipt,
      receiptsPending,
    };
  }, [sessions, candidates, receipts]);

  const refresh = async () => {
    setLoading(true);
    setErr("");
    try {
      const sess =
        (await (shoppingSessionsTable
          ?.orderBy?.("startedAt")
          ?.reverse?.()
          ?.limit?.(25)
          ?.toArray?.() ??
          shoppingSessionsTable?.toArray?.() ??
          [])) || [];
      sess.sort(
        (a, b) => Number(b?.startedAt || 0) - Number(a?.startedAt || 0)
      );

      const cand =
        (await (shoppingCandidatesTable
          ?.orderBy?.("createdAt")
          ?.reverse?.()
          ?.limit?.(200)
          ?.toArray?.() ??
          shoppingCandidatesTable?.toArray?.() ??
          [])) || [];
      cand.sort(
        (a, b) =>
          Number(b?.createdAt || b?.updatedAt || 0) -
          Number(a?.createdAt || a?.updatedAt || 0)
      );

      const rec =
        (await (receiptReconsTable
          ?.orderBy?.("receivedAt")
          ?.reverse?.()
          ?.limit?.(200)
          ?.toArray?.() ??
          receiptReconsTable?.toArray?.() ??
          [])) || [];
      rec.sort(
        (a, b) =>
          Number(b?.receivedAt || b?.createdAt || 0) -
          Number(a?.receivedAt || a?.createdAt || 0)
      );

      setSessions(sess);
      setCandidates(cand);
      setReceipts(rec);
    } catch (e) {
      console.warn("[ShoppingPage] refresh failed:", e);
      setErr(
        "Could not load shopping data yet. Your tables may still be initializing."
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const goScannerShopping = () => {
    setScannerMode("shopping");
    clearScannerShoppingSession();
    navigate("/scan/extreme");
  };

  const goScannerReceipt = () => {
    setScannerMode("receipt");
    navigate("/scan/extreme");
  };

  const resumeSession = (s) => {
    setScannerMode("shopping");
    setScannerShoppingSessionId(s?.id || s?.shoppingSessionId || s?.sessionId);
    navigate("/scan/extreme");
  };

  const openTab = (next) => {
    const t = String(next || "sessions");
    navigate(`/shopping?tab=${encodeURIComponent(t)}`);
  };

  const tabBtn = (key, label, count) => (
    <button
      type="button"
      className={`btn btn--sm ${tab === key ? "" : "btn--ghost"}`}
      onClick={() => openTab(key)}
    >
      {label}
      <span className="ml-2 chip chip--soft">{count}</span>
    </button>
  );

  return (
    <div className="p-4 md:p-6">
      <div className="card mb-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl font-semibold leading-tight">Shopping</h1>
            <div className="text-sm text-[hsl(var(--text-subtle))]">
              Staged scans stay out of Inventory until a receipt arrives.
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button type="button" className="btn" onClick={goScannerShopping}>
              Start Shopping Scan
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={goScannerReceipt}
            >
              Scan Receipt
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={refresh}
              disabled={loading}
              title="Refresh lists"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>
        </div>

        <div className="mt-3 flex gap-2 flex-wrap">
          <span className="chip chip--soft">
            Sessions: <strong className="ml-1">{counts.sessions}</strong>
          </span>
          <span className="chip chip--soft">
            Waiting receipt:{" "}
            <strong className="ml-1">{counts.waitingReceipt}</strong>
          </span>
          <span className="chip chip--soft">
            Receipts pending:{" "}
            <strong className="ml-1">{counts.receiptsPending}</strong>
          </span>
        </div>

        {err ? <div className="mt-3 text-sm text-red-600">{err}</div> : null}

        <div className="mt-4 flex items-center gap-2 flex-wrap">
          {tabBtn("sessions", "Sessions", counts.sessions)}
          {tabBtn("candidates", "Candidates", counts.waitingReceipt)}
          {tabBtn("receipts", "Receipts", counts.receiptsPending)}
        </div>
      </div>

      <DashboardSection
        id="shopping-content"
        title={
          tab === "receipts"
            ? "Receipts Pending Reconciliation"
            : tab === "candidates"
            ? "Candidates Waiting for Receipt"
            : "Recent Shopping Sessions"
        }
        subtitle={
          tab === "receipts"
            ? "Receipts block commit until reconciled."
            : tab === "candidates"
            ? "These scans are staged. They do not affect household totals yet."
            : "Resume a trip to keep scanning into the same shopping session."
        }
        dense
      >
        {tab === "sessions" ? (
          <div className="grid gap-3">
            {!sessions?.length ? (
              <div className="card">
                <div className="text-sm opacity-80">
                  No shopping sessions yet. Start a Shopping Scan to create one.
                </div>
              </div>
            ) : null}

            {sessions.map((s) => (
              <div
                key={s?.id || s?.sessionId || Math.random()}
                className="card"
              >
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="font-semibold">
                      {s?.storeName ||
                        s?.storeLabel ||
                        s?.storeId ||
                        "Shopping session"}
                    </div>
                    <div className="text-xs text-[hsl(var(--text-subtle))]">
                      {fmtTime(s?.startedAt)}{" "}
                      {s?.endedAt ? `→ ${fmtTime(s?.endedAt)}` : ""}
                    </div>
                    <div className="mt-2 flex gap-2 flex-wrap">
                      <span className={statusChip(s?.status)}>
                        {String(s?.status || "active")}
                      </span>
                      {s?.storeIds?.length ? (
                        <span className="chip chip--soft">
                          Stores:{" "}
                          <strong className="ml-1">{s.storeIds.length}</strong>
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => resumeSession(s)}
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => openTab("candidates")}
                    >
                      View Candidates
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {tab === "candidates" ? (
          <div className="grid gap-3">
            {!candidates?.length ? (
              <div className="card">
                <div className="text-sm opacity-80">
                  No staged candidates found. Scan items in Shopping mode.
                </div>
              </div>
            ) : null}

            {candidates
              .filter((r) => {
                const st = String(r?.status || "").toLowerCase();
                if (!st) return true;
                return !["reconciled", "committed", "discarded"].includes(st);
              })
              .slice(0, 200)
              .map((c) => (
                <div
                  key={
                    c?.candidateId || c?.id || c?.fingerprint || Math.random()
                  }
                  className="card"
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="font-semibold">
                        {c?.resolved?.name || c?.name || c?.title || "Item"}
                      </div>
                      <div className="text-xs text-[hsl(var(--text-subtle))]">
                        UPC:{" "}
                        <span className="font-mono">
                          {c?.upc || c?.barcode || "—"}
                        </span>
                        {c?.storeId ? (
                          <>
                            {" "}
                            • Store:{" "}
                            <span className="font-mono">{c.storeId}</span>
                          </>
                        ) : null}
                      </div>

                      <div className="mt-2 flex gap-2 flex-wrap">
                        <span className={statusChip(c?.status)}>
                          {String(c?.status || "staged")}
                        </span>
                        {c?.price?.amount ? (
                          <span className="chip chip--soft">
                            Price:{" "}
                            <strong className="ml-1">{c.price.amount}</strong>
                          </span>
                        ) : null}
                        {c?.resolved?.couponBest ? (
                          <span className="chip chip--ok">Coupon</span>
                        ) : null}
                        {c?.resolved?.recallRisk ? (
                          <span className="chip chip--danger">Recall</span>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => {
                          setScannerMode("shopping");
                          if (c?.shoppingSessionId)
                            setScannerShoppingSessionId(c.shoppingSessionId);
                          navigate("/scan/extreme");
                        }}
                      >
                        Continue scanning
                      </button>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        ) : null}

        {tab === "receipts" ? (
          <div className="grid gap-3">
            {!receipts?.length ? (
              <div className="card">
                <div className="text-sm opacity-80">
                  No receipts found yet. Use “Scan Receipt” to add one.
                </div>
              </div>
            ) : null}

            {receipts
              .filter((r) => {
                const st = String(r?.status || "").toLowerCase();
                if (!st) return true;
                return !["reconciled", "committed", "closed", "done"].includes(
                  st
                );
              })
              .slice(0, 200)
              .map((r) => (
                <div
                  key={
                    r?.reconId ||
                    r?.id ||
                    r?.receiptFingerprint ||
                    Math.random()
                  }
                  className="card"
                >
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="font-semibold">
                        {r?.storeName || r?.storeId || "Receipt"}
                      </div>
                      <div className="text-xs text-[hsl(var(--text-subtle))]">
                        Received: {fmtTime(r?.receivedAt || r?.createdAt)}
                      </div>

                      <div className="mt-2 flex gap-2 flex-wrap">
                        <span className={statusChip(r?.status)}>
                          {String(r?.status || "pending")}
                        </span>
                        {r?.shoppingSessionId ? (
                          <span className="chip chip--soft">
                            Session:{" "}
                            <span className="font-mono ml-1">
                              {r.shoppingSessionId}
                            </span>
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="btn btn--sm"
                        onClick={goScannerReceipt}
                      >
                        Re-scan / update
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => openTab("candidates")}
                      >
                        View candidates
                      </button>
                    </div>
                  </div>
                </div>
              ))}
          </div>
        ) : null}
      </DashboardSection>
    </div>
  );
}
