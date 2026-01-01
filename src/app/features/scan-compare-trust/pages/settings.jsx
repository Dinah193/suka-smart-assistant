/* eslint-disable no-console */
// src/features/scan-compare-trust/pages/settings.jsx
// Scan • Compare • Trust — Settings
// - Source/provider toggles
// - Safety checks (recalls, ingredients, coupons, price compare)
// - Allergens (common + custom) and Avoid List
// - Stores + loyalty IDs + preferred order
// - User-owned favorites & export/import
// - Sabbath guard + quiet hours awareness for session defaults

import React, { useEffect, useMemo, useState } from "react";

/* ────────────────────────────── safe no-ops / env helpers ─────────────────── */
const NULL = Object.freeze({
  emit: () => {},
  track: () => {},
  get: (_p, fb) => (fb !== undefined ? fb : undefined),
});
const isTruthy = (v) => String(v).toLowerCase() === "true";

/* Pull app defaults from config/env with safe fallbacks */
function readDefaults(config) {
  return {
    ui: {
      sheet: config?.get?.("scan.ui.sheet", "compact") ?? (import.meta?.env?.VITE_SCAN_UI_SHEET || "compact"),
      haptics: config?.get?.("scan.ui.haptics", true) ?? isTruthy(import.meta?.env?.VITE_SCAN_UI_HAPTICS ?? "true"),
      voice: config?.get?.("scan.ui.voice", true) ?? isTruthy(import.meta?.env?.VITE_SCAN_UI_VOICE ?? "true"),
    },
    camera: {
      mode: config?.get?.("scan.camera.mode", "barcode+ocr") ?? (import.meta?.env?.VITE_SCAN_CAMERA_DEFAULT_MODE || "barcode+ocr"),
      torch: false,
    },
    checks: {
      recalls: config?.get?.("enableRecallsCheck", true) ?? isTruthy(import.meta?.env?.VITE_FEATURE_ENABLE_RECALLS_CHECK ?? "true"),
      ingredients: config?.get?.("enableIngredientsCheck", true) ?? isTruthy(import.meta?.env?.VITE_FEATURE_ENABLE_INGREDIENTS_CHECK ?? "true"),
      coupons: config?.get?.("enableCoupons", true) ?? isTruthy(import.meta?.env?.VITE_FEATURE_ENABLE_COUPONS ?? "true"),
      priceCompare: config?.get?.("enablePriceCompare", true) ?? isTruthy(import.meta?.env?.VITE_FEATURE_ENABLE_PRICE_COMPARE ?? "true"),
    },
    providers: {
      sams: config?.get?.("coupons.providers.sams.enabled", true) ?? isTruthy(import.meta?.env?.VITE_PROVIDER_SAMS_ENABLED ?? "true"),
      costco: config?.get?.("coupons.providers.costco.enabled", true) ?? isTruthy(import.meta?.env?.VITE_PROVIDER_COSTCO_ENABLED ?? "true"),
      aldi: config?.get?.("coupons.providers.aldi.enabled", true) ?? isTruthy(import.meta?.env?.VITE_PROVIDER_ALDI_ENABLED ?? "true"),
    },
    sabbathGuard: config?.get?.("sabbathGuard", { enabled: true, startHint: "Fri 18:00", endHint: "Sat 21:00" }),
    quietHours: config?.get?.("quietHours", [22, 7]),
    sessions: { autoSave: config?.get?.("scan.sessions.autoSave", true) ?? true, maxRecent: config?.get?.("scan.sessions.maxRecent", 20) ?? 20 },
  };
}

/* Defaults for allergens list */
const COMMON_ALLERGENS = [
  "Eggs", "Milk", "Peanuts", "Tree nuts", "Soy", "Wheat", "Fish", "Shellfish", "Sesame", "Gluten"
];

/* Simple chip input */
function ChipInput({ label, items = [], placeholder, onAdd, onRemove }) {
  const [value, setValue] = useState("");
  return (
    <div>
      <label className="block text-sm font-medium mb-1">{label}</label>
      <div className="flex flex-wrap gap-2 mb-2">
        {items.map((it, idx) => (
          <span key={`${it}-${idx}`} className="inline-flex items-center gap-2 text-xs px-2 py-1 border rounded-xl">
            {it}
            <button aria-label="remove" className="opacity-70 hover:opacity-100" onClick={() => onRemove?.(it)}>✕</button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className="w-full border rounded-lg px-3 py-2 text-sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              onAdd?.(value.trim());
              setValue("");
            }
          }}
        />
        <button className="px-3 py-2 text-sm rounded-lg border hover:bg-neutral-50" onClick={() => { if (value.trim()) { onAdd?.(value.trim()); setValue(""); } }}>
          Add
        </button>
      </div>
    </div>
  );
}

/* Toggle row */
function ToggleRow({ label, checked, onChange, subtitle }) {
  return (
    <label className="flex items-start justify-between gap-4 py-2">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {subtitle ? <div className="text-xs opacity-70">{subtitle}</div> : null}
      </div>
      <input type="checkbox" className="w-5 h-5" checked={!!checked} onChange={(e) => onChange?.(e.target.checked)} />
    </label>
  );
}

/* Store row with loyalty + order controls */
function StoreRow({ store, onToggle, onUpdate, onMoveUp, onMoveDown }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-3 p-3 border rounded-xl">
      <div className="md:col-span-2 flex items-center gap-2">
        <input type="checkbox" checked={!!store.enabled} onChange={(e) => onToggle?.(e.target.checked)} />
        <span className="text-sm font-medium">{store.key.toUpperCase()}</span>
      </div>
      <div className="md:col-span-4 grid grid-cols-2 gap-2">
        <input
          className="border rounded-lg px-3 py-2 text-sm"
          placeholder="Loyalty ID"
          value={store.loyaltyId || ""}
          onChange={(e) => onUpdate?.({ ...store, loyaltyId: e.target.value })}
        />
        <input
          className="border rounded-lg px-3 py-2 text-sm"
          placeholder="Zip / Preferred Location"
          value={store.locationHint || ""}
          onChange={(e) => onUpdate?.({ ...store, locationHint: e.target.value })}
        />
      </div>
      <div className="md:col-span-4">
        <input
          className="w-full border rounded-lg px-3 py-2 text-sm"
          placeholder="Notes (e.g., membership tier, fuel perks)"
          value={store.notes || ""}
          onChange={(e) => onUpdate?.({ ...store, notes: e.target.value })}
        />
      </div>
      <div className="md:col-span-2 flex items-center justify-end gap-1">
        <button className="px-2 py-1 text-xs rounded-lg border hover:bg-neutral-50" onClick={onMoveUp} title="Move up">↑</button>
        <button className="px-2 py-1 text-xs rounded-lg border hover:bg-neutral-50" onClick={onMoveDown} title="Move down">↓</button>
      </div>
    </div>
  );
}

export default function ScanSettingsPage(props = {}) {
  const DexieDB   = props.DexieDB   || (window?.DexieDB ?? null);
  const config    = props.config    || (window?.config ?? NULL);
  const eventBus  = props.eventBus  || (window?.eventBus ?? NULL);
  const analytics = props.analytics || (window?.analytics ?? NULL);
  const actions   = props.actions   || {}; // { saveFavorite(snapshot)?, saveSessionSchedule? }

  const defaults = useMemo(() => readDefaults(config), [config]);

  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Core prefs state
  const [ui, setUI] = useState(defaults.ui);
  const [camera, setCamera] = useState(defaults.camera);
  const [checks, setChecks] = useState(defaults.checks);
  const [providers, setProviders] = useState(defaults.providers);

  // Safety dietary prefs
  const [allergens, setAllergens] = useState(COMMON_ALLERGENS.map(label => ({ label, selected: false })));
  const [customAllergens, setCustomAllergens] = useState([]); // chips
  const [avoidList, setAvoidList] = useState([]); // chips

  // Stores/loyalty
  const [stores, setStores] = useState([
    { key: "sams",   enabled: providers.sams,   loyaltyId: "", locationHint: "", notes: "" },
    { key: "costco", enabled: providers.costco, loyaltyId: "", locationHint: "", notes: "" },
    { key: "aldi",   enabled: providers.aldi,   loyaltyId: "", locationHint: "", notes: "" }
  ]);

  // Sessions defaults (quiet hours, sabbath)
  const [sessionOpts, setSessionOpts] = useState({
    autoSave: defaults.sessions.autoSave,
    maxRecent: defaults.sessions.maxRecent,
    sabbathGuard: defaults.sabbathGuard,
    quietHours: defaults.quietHours
  });

  // Load existing prefs (if any)
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!DexieDB?.scanPrefs) return;
      const doc = await DexieDB.scanPrefs.get("user:scan");
      if (doc && alive) {
        setUI(doc.ui || ui);
        setCamera(doc.camera || camera);
        setChecks(doc.checks || checks);
        setProviders(doc.providers || providers);
        setAllergens(doc.allergens?.common || allergens);
        setCustomAllergens(doc.allergens?.custom || customAllergens);
        setAvoidList(doc.avoidList || avoidList);
        setStores(doc.stores || stores);
        setSessionOpts(doc.sessions || sessionOpts);
        setDirty(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DexieDB]);

  // Mark dirty on change
  useEffect(() => {
    setDirty(true);
  }, [ui, camera, checks, providers, allergens, customAllergens, avoidList, stores, sessionOpts]);

  /* Persist to Dexie */
  const savePrefs = async () => {
    if (!DexieDB?.scanPrefs) {
      console.warn("[ScanSettings] DexieDB.scanPrefs missing; settings not persisted");
      return;
    }
    setSaving(true);
    const payload = {
      id: "user:scan",
      ui, camera, checks, providers,
      allergens: { common: allergens, custom: customAllergens },
      avoidList,
      stores,
      sessions: sessionOpts,
      updatedAt: new Date().toISOString()
    };
    try {
      await DexieDB.scanPrefs.put(payload);
      eventBus.emit("prefs.updated", { domain: "scan", payload });
      analytics.track?.("scan_prefs_saved", { providers: Object.keys(providers).filter(k => providers[k]) });
      setDirty(false);
    } finally {
      setSaving(false);
    }
  };

  const resetToDefaults = () => {
    setUI(defaults.ui);
    setCamera(defaults.camera);
    setChecks(defaults.checks);
    setProviders(defaults.providers);
    setAllergens(COMMON_ALLERGENS.map(label => ({ label, selected: false })));
    setCustomAllergens([]);
    setAvoidList([]);
    setStores([
      { key: "sams",   enabled: defaults.providers.sams,   loyaltyId: "", locationHint: "", notes: "" },
      { key: "costco", enabled: defaults.providers.costco, loyaltyId: "", locationHint: "", notes: "" },
      { key: "aldi",   enabled: defaults.providers.aldi,   loyaltyId: "", locationHint: "", notes: "" }
    ]);
    setSessionOpts({
      autoSave: defaults.sessions.autoSave,
      maxRecent: defaults.sessions.maxRecent,
      sabbathGuard: defaults.sabbathGuard,
      quietHours: defaults.quietHours
    });
  };

  const exportJSON = () => {
    const payload = {
      ui, camera, checks, providers,
      allergens: { common: allergens, custom: customAllergens },
      avoidList, stores, sessions: sessionOpts
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.download = "suka-scan-settings.json";
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importJSON = (file) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.ui) setUI(data.ui);
        if (data.camera) setCamera(data.camera);
        if (data.checks) setChecks(data.checks);
        if (data.providers) setProviders(data.providers);
        if (data.allergens?.common) setAllergens(data.allergens.common);
        if (data.allergens?.custom) setCustomAllergens(data.allergens.custom);
        if (Array.isArray(data.avoidList)) setAvoidList(data.avoidList);
        if (Array.isArray(data.stores)) setStores(data.stores);
        if (data.sessions) setSessionOpts(data.sessions);
        eventBus.emit("prefs.imported", { domain: "scan" });
      } catch (e) {
        console.warn("[ScanSettings] Import failed:", e);
      }
    };
    reader.readAsText(file);
  };

  const saveAsFavoriteFlow = async () => {
    const snapshot = {
      title: "Scan Settings Favorite",
      camera, checks, providers, ui,
      allergens: { common: allergens, custom: customAllergens },
      avoidList,
      stores,
    };
    if (typeof actions?.saveFavorite === "function") {
      await actions.saveFavorite(snapshot);
    } else {
      // Fallback: emit for listeners to handle saving
      eventBus.emit("session.saved.favorite", { type: "scan", snapshot });
    }
  };

  /* UI helpers */
  const updateProvider = (key, val) => {
    setProviders((p) => ({ ...p, [key]: val }));
    setStores((arr) => arr.map((s) => (s.key === key ? { ...s, enabled: val } : s)));
  };
  const moveStore = (idx, dir) => {
    setStores((arr) => {
      const next = arr.slice();
      const j = idx + dir;
      if (j < 0 || j >= next.length) return next;
      const [item] = next.splice(idx, 1);
      next.splice(j, 0, item);
      return next;
    });
  };

  return (
    <div className="max-w-5xl mx-auto py-6 px-4">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Scan • Compare • Trust — Settings</h1>
        <p className="text-sm opacity-70">Tune providers, safety checks, allergens, avoid lists, and store preferences. Your settings are saved to your device and can be exported.</p>
      </header>

      {/* Providers & Checks */}
      <section className="mb-8">
        <div className="mb-3">
          <h2 className="text-base font-semibold">Providers & Checks</h2>
          <p className="text-xs opacity-70">Enable sources and safety checks. Some features may require signed-in integrations.</p>
        </div>
        <div className="grid md:grid-cols-2 gap-6">
          <div className="border rounded-2xl p-4">
            <div className="text-sm font-medium mb-2">Providers</div>
            <ToggleRow label="Sam's Club" checked={providers.sams} onChange={(v) => updateProvider("sams", v)} />
            <ToggleRow label="Costco" checked={providers.costco} onChange={(v) => updateProvider("costco", v)} />
            <ToggleRow label="ALDI" checked={providers.aldi} onChange={(v) => updateProvider("aldi", v)} />
          </div>
          <div className="border rounded-2xl p-4">
            <div className="text-sm font-medium mb-2">Checks</div>
            <ToggleRow label="Recalls" checked={checks.recalls} onChange={(v) => setChecks((c) => ({ ...c, recalls: v }))} />
            <ToggleRow label="Ingredients" checked={checks.ingredients} onChange={(v) => setChecks((c) => ({ ...c, ingredients: v }))} />
            <ToggleRow label="Coupons" checked={checks.coupons} onChange={(v) => setChecks((c) => ({ ...c, coupons: v }))} />
            <ToggleRow label="Price Compare" checked={checks.priceCompare} onChange={(v) => setChecks((c) => ({ ...c, priceCompare: v }))} />
          </div>
        </div>
      </section>

      {/* UI & Camera */}
      <section className="mb-8 grid md:grid-cols-2 gap-6">
        <div className="border rounded-2xl p-4">
          <div className="text-sm font-medium mb-2">UI Preferences</div>
          <label className="block text-sm mb-1">Sheet Density</label>
          <select
            className="w-full border rounded-lg px-3 py-2 text-sm mb-3"
            value={ui.sheet}
            onChange={(e) => setUI((u) => ({ ...u, sheet: e.target.value }))}
          >
            <option value="compact">Compact</option>
            <option value="cozy">Cozy</option>
          </select>
          <ToggleRow label="Haptics" checked={ui.haptics} onChange={(v) => setUI((u) => ({ ...u, haptics: v }))} />
          <ToggleRow label="Voice prompts" checked={ui.voice} onChange={(v) => setUI((u) => ({ ...u, voice: v }))} />
        </div>
        <div className="border rounded-2xl p-4">
          <div className="text-sm font-medium mb-2">Camera & OCR</div>
          <label className="block text-sm mb-1">Mode</label>
          <select
            className="w-full border rounded-lg px-3 py-2 text-sm mb-3"
            value={camera.mode}
            onChange={(e) => setCamera((c) => ({ ...c, mode: e.target.value }))}
          >
            <option value="barcode+ocr">Barcode + OCR</option>
            <option value="barcode">Barcode only</option>
            <option value="ocr">OCR only</option>
          </select>
          <ToggleRow label="Torch" checked={camera.torch} onChange={(v) => setCamera((c) => ({ ...c, torch: v }))} />
        </div>
      </section>

      {/* Allergens & Avoid Lists */}
      <section className="mb-8">
        <div className="mb-3">
          <h2 className="text-base font-semibold">Allergens & Avoid List</h2>
          <p className="text-xs opacity-70">Mark allergens and ingredients you prefer to avoid. Scan results will flag these items.</p>
        </div>
        <div className="grid md:grid-cols-2 gap-6">
          <div className="border rounded-2xl p-4">
            <div className="text-sm font-medium mb-2">Common Allergens</div>
            <div className="grid grid-cols-2 gap-2">
              {allergens.map((a, idx) => (
                <label key={`${a.label}-${idx}`} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={!!a.selected}
                    onChange={(e) =>
                      setAllergens((list) =>
                        list.map((x, i) => (i === idx ? { ...x, selected: e.target.checked } : x))
                      )
                    }
                  />
                  <span>{a.label}</span>
                </label>
              ))}
            </div>
            <div className="mt-4">
              <ChipInput
                label="Custom Allergens"
                items={customAllergens}
                placeholder="e.g., Nightshades, Sulfites"
                onAdd={(v) => setCustomAllergens((arr) => Array.from(new Set([...(arr || []), v])))}
                onRemove={(v) => setCustomAllergens((arr) => (arr || []).filter((x) => x !== v))}
              />
            </div>
          </div>
          <div className="border rounded-2xl p-4">
            <ChipInput
              label="Avoid List (Ingredients)"
              items={avoidList}
              placeholder="e.g., High fructose corn syrup, Red 40"
              onAdd={(v) => setAvoidList((arr) => Array.from(new Set([...(arr || []), v])))}
              onRemove={(v) => setAvoidList((arr) => (arr || []).filter((x) => x !== v))}
            />
          </div>
        </div>
      </section>

      {/* Stores & Loyalty */}
      <section className="mb-8">
        <div className="mb-3">
          <h2 className="text-base font-semibold">Stores & Loyalty</h2>
          <p className="text-xs opacity-70">Toggle the stores you use, set loyalty IDs, and order them by preference (used for price compare & coupon matching).</p>
        </div>
        <div className="space-y-3">
          {stores.map((s, idx) => (
            <StoreRow
              key={s.key}
              store={s}
              onToggle={(v) => setStores((arr) => arr.map((row) => (row.key === s.key ? { ...row, enabled: v } : row)))}
              onUpdate={(next) => setStores((arr) => arr.map((row) => (row.key === s.key ? next : row)))}
              onMoveUp={() => moveStore(idx, -1)}
              onMoveDown={() => moveStore(idx, +1)}
            />
          ))}
        </div>
      </section>

      {/* Sessions defaults */}
      <section className="mb-8">
        <div className="mb-3">
          <h2 className="text-base font-semibold">Session Defaults</h2>
          <p className="text-xs opacity-70">Auto-save scan sessions and respect your quiet hours and Sabbath guard for scheduled tasks.</p>
        </div>
        <div className="grid md:grid-cols-2 gap-6">
          <div className="border rounded-2xl p-4">
            <ToggleRow
              label="Auto-save scan sessions"
              checked={sessionOpts.autoSave}
              onChange={(v) => setSessionOpts((o) => ({ ...o, autoSave: v }))}
            />
            <label className="block text-sm mt-2">Max recent sessions</label>
            <input
              type="number"
              min={5}
              max={100}
              className="w-40 border rounded-lg px-3 py-2 text-sm"
              value={sessionOpts.maxRecent}
              onChange={(e) => setSessionOpts((o) => ({ ...o, maxRecent: Math.max(5, Math.min(100, Number(e.target.value) || 20)) }))}
            />
          </div>
          <div className="border rounded-2xl p-4">
            <ToggleRow
              label="Sabbath Guard"
              subtitle={`${sessionOpts.sabbathGuard?.startHint || "Fri 18:00"} → ${sessionOpts.sabbathGuard?.endHint || "Sat 21:00"}`}
              checked={!!sessionOpts.sabbathGuard?.enabled}
              onChange={(v) => setSessionOpts((o) => ({ ...o, sabbathGuard: { ...(o.sabbathGuard || {}), enabled: v } }))}
            />
            <div className="grid grid-cols-2 gap-3 mt-2">
              <div>
                <label className="block text-sm">Quiet hours start</label>
                <input
                  type="number"
                  min={0}
                  max={23}
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  value={sessionOpts.quietHours?.[0] ?? 22}
                  onChange={(e) => {
                    const start = Math.max(0, Math.min(23, Number(e.target.value) || 22));
                    setSessionOpts((o) => ({ ...o, quietHours: [start, o.quietHours?.[1] ?? 7] }));
                  }}
                />
              </div>
              <div>
                <label className="block text-sm">Quiet hours end</label>
                <input
                  type="number"
                  min={0}
                  max={23}
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  value={sessionOpts.quietHours?.[1] ?? 7}
                  onChange={(e) => {
                    const end = Math.max(0, Math.min(23, Number(e.target.value) || 7));
                    setSessionOpts((o) => ({ ...o, quietHours: [o.quietHours?.[0] ?? 22, end] }));
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Actions */}
      <section className="flex flex-wrap gap-2 border-t pt-4">
        <button
          className="px-4 py-2 text-sm rounded-lg border hover:bg-neutral-50"
          onClick={savePrefs}
          disabled={saving || !dirty}
          title={dirty ? "Save changes" : "No changes"}
        >
          {saving ? "Saving…" : "Save Settings"}
        </button>
        <button className="px-4 py-2 text-sm rounded-lg border hover:bg-neutral-50" onClick={resetToDefaults}>
          Reset to Defaults
        </button>
        <button className="px-4 py-2 text-sm rounded-lg border hover:bg-neutral-50" onClick={saveAsFavoriteFlow}>
          Save as Favorite Flow
        </button>
        <button className="px-4 py-2 text-sm rounded-lg border hover:bg-neutral-50" onClick={exportJSON}>
          Export JSON
        </button>
        <label className="px-4 py-2 text-sm rounded-lg border hover:bg-neutral-50 cursor-pointer">
          Import JSON
          <input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && importJSON(e.target.files[0])} />
        </label>
        <span className="ml-auto text-xs opacity-70">{dirty ? "Unsaved changes" : "All changes saved"}</span>
      </section>
    </div>
  );
}
