import React, { useEffect, useMemo, useState, useRef } from "react";

/**
 * CropPicker.jsx
 *
 * Props:
 *  - open: boolean
 *  - onClose: () => void
 *  - initial: Array<CropPlanItem>
 *  - beds: Array<{ bedId, lengthM?, widthM?, areaM2? }>
 *  - catalog: Record<string, { category?, spacingInches?:{inRow,betweenRow}, plantsPerSqft?, seedsPerPlant?, seedOverplantPct? }>
 *  - onSave: (items) => void
 *  - onSuggest?: () => Promise<Array<{name, variety?, areaSqft?, plants?, successions?}>>
 */

function sameItemIds(a = [], b = []) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;

  // Use stable signatures so order changes don't cause false diffs
  const sa = a.map(sigItem).sort();
  const sb = b.map(sigItem).sort();
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

export default function CropPicker({
  open = false,
  onClose = () => {},
  initial = [],
  beds = [],
  catalog = {},
  onSave = () => {},
  onSuggest,
}) {
  const [q, setQ] = useState("");
  const [quickAdd, setQuickAdd] = useState("");
  const [items, setItems] = useState(Array.isArray(initial) ? initial : []);
  const [busy, setBusy] = useState(false);

  // Quick-add helpers
  const [zone, setZone] = useState("7b");
  const [season, setSeason] = useState("spring"); // spring | summer | fall
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");

  /**
   * ✅ FIX: Loop-proof parent -> local sync
   * The old effect could loop if `initial` changed identity each render.
   * We compute a stable key from signatures and only set local state when
   * the incoming items are truly different from the current `items`.
   */
  const initialKey = useMemo(() => {
    const arr = Array.isArray(initial) ? initial : [];
    return JSON.stringify(arr.map(sigItem).sort());
  }, [initial]);

  useEffect(() => {
    const next = Array.isArray(initial) ? initial : [];
    if (!sameItemIds(items, next)) {
      setItems(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]); // intentionally NOT depending on `items` to avoid re-trigger loops

  const allCrops = useMemo(() => {
    const keys = Object.keys(catalog || {});
    if (keys.length) return keys.sort((a, b) => a.localeCompare(b));
    return [
      "Tomato",
      "Lettuce",
      "Cucumber",
      "Pepper",
      "Carrot",
      "Beet",
      "Onion",
      "Kale",
      "Broccoli",
      "Beans",
      "Pea",
      "Spinach",
      "Garlic",
      "Basil",
      "Dill",
    ];
  }, [catalog]);

  const filtered = useMemo(() => {
    const s = (q || "").trim().toLowerCase();
    return s ? allCrops.filter((c) => c.toLowerCase().includes(s)) : allCrops;
  }, [q, allCrops]);

  const addCrop = (name, opts = {}) => {
    const clean = cap((name || "").trim());
    if (!clean) return;
    setItems((prev) => [
      ...prev,
      {
        id: cryptoSafeId(),
        name: clean,
        variety: opts.variety || "",
        areaSqft:
          numberOrNull(opts.areaSqft) ?? defaultAreaSqft(catalog[clean]),
        plants: numberOrNull(opts.plants) ?? undefined,
        successions: numberOrNull(opts.successions) ?? 0,
      },
    ]);
  };

  const removeCrop = (id) =>
    setItems((prev) => prev.filter((i) => i.id !== id));
  const patch = (id, data) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...data } : i)));

  const handleSave = () => {
    const cleaned = items.map((i) => {
      const area = numberOrNull(i.areaSqft);
      const plants = numberOrNull(i.plants);
      return {
        id: i.id,
        name: (i.name || "").trim(),
        variety: strOrNull(i.variety),
        areaSqft: area != null && area > 0 ? area : undefined,
        plants: area == null ? plants || undefined : undefined,
        bedId: strOrNull(i.bedId),
        successions: numberOrNull(i.successions) ?? 0,
      };
    });
    onSave(cleaned);
    onClose();
  };

  const handleSuggest = async () => {
    if (!onSuggest) return;
    try {
      setBusy(true);
      const suggested = await onSuggest();
      if (Array.isArray(suggested) && suggested.length) {
        const bySig = new Set(items.map(sigItem));
        const toAdd = suggested
          .filter((s) => s?.name && !bySig.has(sigItem(s)))
          .map((s) => ({
            id: cryptoSafeId(),
            name: s.name,
            variety: s.variety || "",
            areaSqft: numberOrNull(s.areaSqft) ?? undefined,
            plants: numberOrNull(s.plants) ?? undefined,
            successions: numberOrNull(s.successions) ?? 0,
          }));
        setItems((prev) => [...prev, ...toAdd]);
      }
    } finally {
      setBusy(false);
    }
  };

  // Zone starter
  const handleZoneStarter = () => {
    const picks = zoneStarter(zone, season);
    const bySig = new Set(items.map(sigItem));
    const toAdd = picks
      .filter((p) => p?.name && !bySig.has(sigItem(p)))
      .map((p) => ({
        id: cryptoSafeId(),
        name: cap(p.name),
        variety: p.variety || "",
        areaSqft:
          numberOrNull(p.areaSqft) ?? defaultAreaSqft(catalog[cap(p.name)]),
        plants: numberOrNull(p.plants) ?? undefined,
        successions: numberOrNull(p.successions) ?? 0,
      }));
    setItems((prev) => [...prev, ...toAdd]);
  };

  // Paste list
  const handlePasteParse = () => {
    const lines = (pasteText || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const parsed = lines.map(parseCropLine).filter(Boolean);
    if (!parsed.length) return;

    const bySig = new Set(items.map(sigItem));
    const toAdd = parsed
      .filter((p) => !bySig.has(sigItem(p)))
      .map((p) => ({
        id: cryptoSafeId(),
        name: cap(p.name),
        variety: p.variety || "",
        areaSqft:
          p.areaSqft ??
          (p.plants ? undefined : defaultAreaSqft(catalog[cap(p.name)])),
        plants: p.plants ?? undefined,
        successions: numberOrNull(p.successions) ?? 0,
      }));

    setItems((prev) => [...prev, ...toAdd]);
    setPasteText("");
    setPasteOpen(false);
  };

  // Add by typing (not just search)
  const handleQuickAddEnter = (e) => {
    if (e.key !== "Enter") return;
    const val = (quickAdd || "").trim();
    if (!val) return;
    addCrop(val);
    setQuickAdd("");
  };

  // Search box also supports Enter to add first match (or the typed text)
  const handleSearchEnter = (e) => {
    if (e.key !== "Enter") return;
    const val = (q || "").trim();
    if (!val) return;
    const first = filtered[0];
    addCrop(first || val);
    setQ("");
  };

  if (!open) return null;

  const selectedNames = new Set(items.map((i) => safeLc(i.name)));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div className="relative w-[min(1100px,94vw)] max-h-[90vh] overflow-hidden rounded-2xl bg-white shadow-2xl border flex flex-col">
        <header className="flex items-center justify-between border-b px-5 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-lime-800">
              Select Crops
            </h2>
            {busy && <span className="text-xs text-stone-500">loading…</span>}
          </div>
          <div className="flex items-center gap-2">
            {onSuggest && (
              <button className="btn sm primary" onClick={handleSuggest}>
                Suggest from Meal Plan
              </button>
            )}
            <button className="btn xs" onClick={onClose}>
              Close
            </button>
          </div>
        </header>

        {/* CONTENT AREA: locks internal scroll so page height doesn't grow */}
        <div className="flex-1 overflow-hidden p-5">
          <div className="grid grid-cols-12 gap-5 h-full">
            {/* LEFT: Catalog + Quick tools */}
            <div className="col-span-4 min-h-0 flex flex-col gap-3">
              {/* Quick add card */}
              <div className="card p-3">
                <div className="text-sm font-medium text-lime-800 mb-2">
                  Quick add
                </div>
                <div className="grid grid-cols-12 gap-2 items-end mb-3">
                  <div className="col-span-5">
                    <Label>USDA zone</Label>
                    <select
                      className="btn w-full"
                      value={zone}
                      onChange={(e) => setZone(e.target.value)}
                    >
                      {[
                        "5a",
                        "5b",
                        "6a",
                        "6b",
                        "7a",
                        "7b",
                        "8a",
                        "8b",
                        "9a",
                        "9b",
                      ].map((z) => (
                        <option key={z} value={z}>
                          {z}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="col-span-5">
                    <Label>Season</Label>
                    <select
                      className="btn w-full"
                      value={season}
                      onChange={(e) => setSeason(e.target.value)}
                    >
                      <option value="spring">spring</option>
                      <option value="summer">summer</option>
                      <option value="fall">fall</option>
                    </select>
                  </div>
                  <div className="col-span-2">
                    <button
                      className="btn xs"
                      onClick={handleZoneStarter}
                      title="Add a sensible starter set"
                    >
                      Add
                    </button>
                  </div>
                </div>

                <Label>Type to add (Enter)</Label>
                <input
                  value={quickAdd}
                  onChange={(e) => setQuickAdd(e.target.value)}
                  onKeyDown={handleQuickAddEnter}
                  placeholder="e.g., Kale"
                  className="btn w-full mb-2"
                />

                <div className="mb-2">
                  <button
                    className="btn xs"
                    onClick={() => setPasteOpen((v) => !v)}
                  >
                    {pasteOpen ? "Hide paste box" : "Paste list…"}
                  </button>
                </div>
                {pasteOpen && (
                  <div className="space-y-2">
                    <textarea
                      className="btn w-full"
                      rows={4}
                      placeholder={`One per line, examples:
Tomato – Roma – 24 sqft
Lettuce – — – 12 plants
Basil – Genovese – 16 sqft`}
                      value={pasteText}
                      onChange={(e) => setPasteText(e.target.value)}
                    />
                    <div className="text-[11px] text-stone-500">
                      Use "-", "–", or "—" between parts. End with "sqft" or
                      "plants".
                    </div>
                    <div className="flex justify-end">
                      <button
                        className="btn xs primary"
                        onClick={handlePasteParse}
                      >
                        Add from paste
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Catalog card */}
              <div className="card p-3 flex-1 min-h-0 flex flex-col">
                <div className="mb-2">
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={handleSearchEnter}
                    placeholder="Search crops… (Enter adds first match)"
                    className="btn w-full"
                  />
                </div>

                <div className="text-xs text-stone-600 mb-2">
                  Catalog{" "}
                  <span className="text-stone-400">({filtered.length})</span>
                </div>

                <div className="flex-1 overflow-auto">
                  <div className="flex flex-wrap gap-2">
                    {filtered.map((name) => {
                      const isSelected = selectedNames.has(safeLc(name));
                      return (
                        <button
                          key={name}
                          type="button"
                          onClick={() => !isSelected && addCrop(name)}
                          disabled={isSelected}
                          aria-pressed={isSelected}
                          className="btn xs"
                          title={
                            isSelected
                              ? "Already in planned crops"
                              : "Add to plan"
                          }
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                  {filtered.length === 0 && (
                    <div className="text-sm text-stone-500 mt-2">
                      No matches. Press Enter to add "{q}".
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* RIGHT: Plan list */}
            <div className="col-span-8 min-h-0 flex flex-col">
              <div className="card p-3 flex-1 min-h-0 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm text-stone-600">
                    Planned crops{" "}
                    <span className="text-stone-400">({items.length})</span>
                  </div>
                  {items.length > 0 && (
                    <button className="btn xs primary" onClick={handleSave}>
                      Save selection
                    </button>
                  )}
                </div>

                <div className="flex-1 min-h-0 overflow-auto space-y-3 pr-1">
                  {items.length === 0 ? (
                    <div className="text-sm italic text-stone-500">
                      No crops selected yet. Add from the catalog, type a name
                      and press Enter, use Zone starter, or paste a list.
                    </div>
                  ) : (
                    items.map((it) => {
                      const prof = catalog[it.name] || {};
                      const est = estimateFor(it, prof);
                      return (
                        <div
                          key={it.id}
                          className="bg-white border border-lime-200 rounded-xl p-3 grid grid-cols-12 gap-3"
                        >
                          <div className="col-span-3">
                            <Label>Crop</Label>
                            <Input
                              value={it.name}
                              onChange={(e) =>
                                patch(it.id, { name: e.target.value })
                              }
                              list="crop-catalog"
                            />
                            <datalist id="crop-catalog">
                              {allCrops.map((n) => (
                                <option key={n} value={n} />
                              ))}
                            </datalist>
                            <Hint className="mt-1">
                              {prof?.category
                                ? `Category: ${prof.category}`
                                : "\u00A0"}
                            </Hint>
                          </div>

                          <div className="col-span-3">
                            <Label>Variety (optional)</Label>
                            <Input
                              value={it.variety || ""}
                              onChange={(e) =>
                                patch(it.id, { variety: e.target.value })
                              }
                            />
                          </div>

                          <div className="col-span-2">
                            <Label>Area (sqft)</Label>
                            <Input
                              type="number"
                              min="0"
                              value={it.areaSqft ?? ""}
                              onChange={(e) =>
                                patch(it.id, {
                                  areaSqft: numberOrNull(e.target.value),
                                  plants: undefined,
                                })
                              }
                            />
                            <Hint>or Plants ↓</Hint>
                          </div>

                          <div className="col-span-2">
                            <Label>Plants (alt.)</Label>
                            <Input
                              type="number"
                              min="0"
                              value={it.plants ?? ""}
                              onChange={(e) =>
                                patch(it.id, {
                                  plants: numberOrNull(e.target.value),
                                  areaSqft: undefined,
                                })
                              }
                            />
                          </div>

                          <div className="col-span-1">
                            <Label>Succession Plantings</Label>
                            <Input
                              type="number"
                              min="0"
                              value={it.successions ?? 0}
                              onChange={(e) =>
                                patch(it.id, {
                                  successions:
                                    numberOrNull(e.target.value) ?? 0,
                                })
                              }
                            />
                          </div>

                          <div className="col-span-1 flex items-end justify-end">
                            <button
                              className="btn xs"
                              onClick={() => removeCrop(it.id)}
                            >
                              Remove
                            </button>
                          </div>

                          <div className="col-span-12">
                            <Label>Bed (optional)</Label>
                            <select
                              value={it.bedId || ""}
                              onChange={(e) =>
                                patch(it.id, {
                                  bedId: e.target.value || undefined,
                                })
                              }
                              className="btn w-full"
                            >
                              <option value="">— none —</option>
                              {beds.map((b) => (
                                <option key={b.bedId} value={b.bedId}>
                                  {b.bedId} {formatBedDims(b)}
                                </option>
                              ))}
                            </select>
                            <div className="mt-2 text-xs text-stone-600">
                              {est.summary}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {items.length > 0 && (
                  <div className="pt-3 border-t mt-3 flex justify-end">
                    <button className="btn primary" onClick={handleSave}>
                      Save selection
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- tiny UI atoms ---------- */
function Label({ children }) {
  return <div className="text-xs text-stone-600 mb-1">{children}</div>;
}
function Input(props) {
  return <input {...props} className={`btn w-full ${props.className || ""}`} />;
}
function Hint({ children, className = "" }) {
  return (
    <div className={`text-[11px] text-stone-500 ${className}`}>{children}</div>
  );
}

/* ---------- helpers ---------- */
function cryptoSafeId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2, 10);
}
const safeLc = (s) => (s || "").toLowerCase().trim();
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const strOrNull = (s) => {
  const v = (s || "").trim();
  return v.length ? v : null;
};
const numberOrNull = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const sigItem = (i) => `${safeLc(i.name)}::${safeLc(i.variety || "")}`;

function defaultAreaSqft(profile = {}) {
  if (profile?.plantsPerSqft) return 16; // 4×4ft quick add
  if (profile?.spacingInches?.inRow && profile?.spacingInches?.betweenRow) {
    const pps = plantsPerSqftFromSpacing(
      profile.spacingInches.inRow,
      profile.spacingInches.betweenRow
    );
    if (pps) return Math.max(12, Math.round(16 / pps));
  }
  return 20;
}

function plantsPerSqftFromSpacing(inRowIn, betweenIn) {
  const a = Number(inRowIn);
  const b = Number(betweenIn);
  if (!a || !b) return 0;
  return 144 / (a * b);
}

function estimateFor(item, profile = {}) {
  const pps =
    profile.plantsPerSqft ||
    (profile.spacingInches?.inRow && profile.spacingInches?.betweenRow
      ? plantsPerSqftFromSpacing(
          profile.spacingInches.inRow,
          profile.spacingInches.betweenRow
        )
      : null);

  let plants = numberOrNull(item.plants);
  if ((plants == null || plants <= 0) && numberOrNull(item.areaSqft) && pps) {
    plants = Math.max(1, Math.floor(item.areaSqft * pps));
  }

  const seedsPerPlant = profile.seedsPerPlant || 1;
  const over = (profile.seedOverplantPct ?? 10) / 100;
  const seeds = plants ? Math.ceil(plants * seedsPerPlant * (1 + over)) : null;

  const parts = [];
  if (plants) parts.push(`est. plants: ${plants}`);
  if (seeds) parts.push(`seeds to start: ~${seeds}`);
  if (!plants && !seeds) parts.push("enter area (sqft) or plant count");
  return { plants, seeds, summary: parts.join(" · ") };
}

function formatBedDims(b) {
  const len = b.lengthM ? `${strip(b.lengthM)}m` : "";
  const wid = b.widthM ? `${strip(b.widthM)}m` : "";
  const area =
    b.areaM2 || (b.lengthM && b.widthM ? b.lengthM * b.widthM : null);
  const a = area ? ` · ${strip(area)}m²` : "";
  return (len && wid ? `(${len}×${wid}${a})` : a) || "";
}
function strip(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return n;
  return v % 1 === 0 ? v : v.toFixed(1);
}

/* ---------- Zone starter + Paste parser ---------- */
function zoneStarter(zone = "7b", season = "spring") {
  const z = String(zone).toLowerCase();
  const s = String(season).toLowerCase();
  const base = {
    spring: [
      { name: "lettuce", areaSqft: 16 },
      { name: "spinach", areaSqft: 12 },
      { name: "peas", areaSqft: 20 },
      { name: "carrot", areaSqft: 16 },
      { name: "beet", areaSqft: 12 },
      { name: "broccoli", areaSqft: 16 },
    ],
    summer: [
      { name: "tomato", areaSqft: 24 },
      { name: "cucumber", areaSqft: 20 },
      { name: "pepper", areaSqft: 16 },
      { name: "basil", areaSqft: 12 },
      { name: "beans", areaSqft: 20 },
      { name: "squash", areaSqft: 24 },
    ],
    fall: [
      { name: "kale", areaSqft: 16 },
      { name: "lettuce", areaSqft: 12 },
      { name: "radish", areaSqft: 8 },
      { name: "turnip", areaSqft: 12 },
      { name: "garlic", areaSqft: 12 },
      { name: "cabbage", areaSqft: 16 },
    ],
  };
  const tweaks = {
    "7b": {
      spring: [{ name: "onion", areaSqft: 16 }],
      summer: [{ name: "okra", areaSqft: 16 }],
      fall: [{ name: "collards", areaSqft: 16 }],
    },
    "6b": { summer: [{ name: "parsley", areaSqft: 8 }] },
    "8a": {
      spring: [{ name: "dill", areaSqft: 8 }],
      summer: [{ name: "sweet potato", areaSqft: 24 }],
    },
  };
  return [...(base[s] || []), ...(tweaks[z]?.[s] || [])];
}

function parseCropLine(line) {
  const parts = line.split(/\s*[-–—]\s*/g).map((p) => p.trim());
  if (!parts.length) return null;
  const name = cap(parts[0] || "");
  const variety = parts[1] && parts[1] !== "-" ? parts[1] : "";

  let qtyStr = parts[2] || "";
  if (!qtyStr && parts.length >= 2) qtyStr = parts[1] || "";

  const m = /(\d+(?:\.\d+)?)\s*(sq\s*ft|sqft|ft2|plants?)/i.exec(qtyStr);
  let areaSqft = null;
  let plants = null;

  if (m) {
    const val = Number(m[1]);
    const unit = (m[2] || "").toLowerCase();
    if (unit.includes("plant")) plants = val;
    else areaSqft = val;
  } else {
    const onlyNum = Number(qtyStr);
    if (Number.isFinite(onlyNum)) areaSqft = onlyNum;
  }
  if (!name) return null;
  return {
    name,
    variety,
    areaSqft: numberOrNull(areaSqft),
    plants: numberOrNull(plants),
  };
}
