/* eslint-disable no-console */

import React, { useEffect, useMemo, useState } from "react";
import {
  listPlanningDrafts,
  getPlanningDraft,
  savePlanningDraft,
} from "../../data/PlanningDraftsRepo";

export default function DraftInbox({ onAttachDraft }) {
  const [drafts, setDrafts] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    const rows = await listPlanningDrafts({ status: "draft", limit: 25 });
    setDrafts(rows);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
  }, []);

  const animalDrafts = useMemo(
    () => drafts.filter((d) => d.kind === "animal.stocking.draft"),
    [drafts]
  );

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
        }}
      >
        <h3 style={{ margin: 0 }}>Draft Inbox</h3>
        <button type="button" className="btn" onClick={refresh}>
          Refresh
        </button>
      </div>

      {loading ? (
        <div style={{ paddingTop: 10, opacity: 0.7 }}>Loading drafts…</div>
      ) : animalDrafts.length === 0 ? (
        <div style={{ paddingTop: 10, opacity: 0.7 }}>
          No animal stocking drafts yet. Create one from Animals → Estimate
          Animals.
        </div>
      ) : (
        <div style={{ paddingTop: 10, display: "grid", gap: 10 }}>
          {animalDrafts.map((d) => (
            <div key={d.id} className="card" style={{ padding: 12 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ fontWeight: 700 }}>
                    {d.title || "Animal Stocking Draft"}
                  </div>
                  <div style={{ fontSize: 13, opacity: 0.75 }}>
                    Updated: {new Date(d.updatedAt).toLocaleString()}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => onAttachDraft?.(d)}
                  >
                    Attach to Plan
                  </button>
                </div>
              </div>

              <div style={{ marginTop: 8 }}>
                <strong>Recommendations:</strong>{" "}
                {(d.outputs?.recommendations || [])
                  .map((r) => `${r.count} ${r.species}`)
                  .slice(0, 6)
                  .join(", ") || "—"}
              </div>

              {d.outputs?.followUps?.length ? (
                <div style={{ marginTop: 6 }}>
                  <strong>Follow-ups:</strong>{" "}
                  {d.outputs.followUps
                    .map((x) => x.msg)
                    .slice(0, 3)
                    .join(" • ")}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
