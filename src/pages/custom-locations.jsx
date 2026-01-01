// src/pages/custom-locations.jsx
import React, { useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import DexieDB from "../db";
import { automation } from "@/services/automation/runtime";
import AutomationPanel from "@/ui/AutomationPanel";
import "../index.css";

export default function CustomLocationsPage() {
  const [locations, setLocations] = useState([]);
  const [newLocation, setNewLocation] = useState("");

  const [busy, setBusy] = useState(false);
  const [ok, setOk] = useState(false);
  const [lastOutput, setLastOutput] = useState(null);

  useEffect(() => {
    loadLocations();
  }, []);

  async function loadLocations() {
    const all = await DexieDB.customLocations.toArray();
    setLocations(all);
  }

  async function handleAdd() {
    const name = newLocation.trim();
    if (!name) return;

    setBusy(true); setOk(false); setLastOutput(null);
    const location = { id: `location-${Date.now()}`, name, createdAt: new Date() };

    try {
      // Prefer an automation template if registered
      const res = await automation.runTemplate("locations.custom.add", {
        invokedBy: "ui/custom-locations",
        location,
      });
      setLastOutput({ via: "template", res });
      // If template didn’t persist to Dexie, we still mirror locally:
      if (!res?.persisted) await DexieDB.customLocations.put(location);
    } catch (e) {
      // Fallback to local DB + emit an event
      await DexieDB.customLocations.put(location);
      automation.emit("event", { type: "locations/custom_added", payload: { location } });
      setLastOutput({ via: "fallback", emitted: true, error: e?.message });
    } finally {
      setBusy(false); setOk(true); setTimeout(()=>setOk(false), 900);
      setNewLocation("");
      loadLocations();
    }
  }

  async function handleDelete(id) {
    setBusy(true); setOk(false); setLastOutput(null);
    try {
      const res = await automation.runTemplate("locations.custom.remove", {
        invokedBy: "ui/custom-locations",
        id,
      });
      setLastOutput({ via: "template", res });
      if (!res?.persisted) await DexieDB.customLocations.delete(id);
    } catch (e) {
      await DexieDB.customLocations.delete(id);
      automation.emit("event", { type: "locations/custom_removed", payload: { id } });
      setLastOutput({ via: "fallback", emitted: true, error: e?.message });
    } finally {
      setBusy(false); setOk(true); setTimeout(()=>setOk(false), 900);
      loadLocations();
    }
  }

  async function syncLocations() {
    setBusy(true); setOk(false); setLastOutput(null);
    try {
      // Expect: { locations:[{id,name,createdAt}], persisted?:boolean }
      const res = await automation.runTemplate("locations.custom.sync", {
        invokedBy: "ui/custom-locations",
        known: locations,
      });
      if (Array.isArray(res?.locations)) {
        setLocations(res.locations);
      }
      setLastOutput({ via: "template", res });
    } catch (e) {
      automation.emit("event", {
        type: "locations/custom_sync_request",
        payload: { known: locations },
      });
      setLastOutput({ via: "event", emitted: true, error: e?.message });
    } finally {
      setBusy(false); setOk(true); setTimeout(()=>setOk(false), 900);
    }
  }

  return (
    <div>
      <h1>📍 Custom Storage Locations</h1>
      <p className="subtitle">Create and manage your own storage spots like Root Cellar, Back Pantry, or Freezer.</p>

      {/* Add new location */}
      <div className="card">
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr auto auto" }}>
          <input
            type="text"
            placeholder="e.g., Root Cellar, Freezer, Back Pantry"
            value={newLocation}
            onChange={(e) => setNewLocation(e.target.value)}
            className="btn"
            style={{ width: "100%" }}
          />
          <button className="btn primary sm" aria-busy={busy} onClick={handleAdd}>
            <Plus size={16} aria-hidden style={{ marginRight: 6 }} />
            <span className="label">Add Location</span>
          </button>
          <button className="btn sm" aria-busy={busy} onClick={syncLocations}>
            <span className="label">Sync</span>
          </button>
        </div>
        {ok ? <div className="subtitle" style={{ marginTop: 8, color: "var(--success)" }}>✓ Updated</div> : null}
      </div>

      {/* List */}
      <div className="card" style={{ marginTop: 16 }}>
        {locations.length === 0 ? (
          <p className="subtitle" style={{ textAlign: "center" }}>No custom locations saved yet.</p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {locations.map((loc) => (
              <li key={loc.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 8px",
                    borderBottom: "1px solid var(--line)"
                  }}>
                <span>{loc.name}</span>
                <button className="btn sm" onClick={() => handleDelete(loc.id)} title="Delete">
                  <Trash2 size={16} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Output / logs */}
      {lastOutput && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Last Automation Output</div>
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            {JSON.stringify(lastOutput, null, 2)}
          </pre>
        </div>
      )}

      {/* Templates/Agents panel (you can pass agents later) */}
      <AutomationPanel title="Automation & Templates" agents={[]} />
    </div>
  );
}
