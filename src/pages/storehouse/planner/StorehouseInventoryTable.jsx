import React from "react";

export default function StorehouseInventoryTable({
  rows = [],
  editable = false,
  onQtyChange,
  onRemoveRow,
  onQuickAdd,
}) {
  const [quickName, setQuickName] = React.useState("");
  const [quickQty, setQuickQty] = React.useState("1");
  const [quickUnit, setQuickUnit] = React.useState("unit");

  const submitQuickAdd = () => {
    const itemName = String(quickName || "").trim();
    const qty = Number(quickQty || 0);
    if (!itemName || !Number.isFinite(qty) || qty <= 0 || !onQuickAdd) return;
    onQuickAdd({ itemName, qty, unit: quickUnit || "unit" });
    setQuickName("");
    setQuickQty("1");
    setQuickUnit("unit");
  };

  return (
    <div className="space-y-3">
      {editable ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <div className="mb-2 text-sm font-semibold text-amber-900">Quick add item</div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-amber-900">
              Item
              <input
                className="ml-1 rounded-md border border-amber-300 px-2 py-1 text-sm"
                value={quickName}
                onChange={(e) => setQuickName(e.target.value)}
                placeholder="e.g., Dry beans"
              />
            </label>
            <label className="text-xs text-amber-900">
              Qty
              <input
                className="ml-1 w-20 rounded-md border border-amber-300 px-2 py-1 text-sm"
                value={quickQty}
                type="number"
                min="0"
                onChange={(e) => setQuickQty(e.target.value)}
              />
            </label>
            <label className="text-xs text-amber-900">
              Unit
              <input
                className="ml-1 w-24 rounded-md border border-amber-300 px-2 py-1 text-sm"
                value={quickUnit}
                onChange={(e) => setQuickUnit(e.target.value)}
              />
            </label>
            <button
              type="button"
              className="rounded-md border border-amber-300 bg-white px-3 py-1 text-sm font-medium text-amber-900 hover:bg-amber-100"
              onClick={submitQuickAdd}
            >
              Add item
            </button>
          </div>
        </div>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-amber-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-amber-50 text-left text-amber-900">
          <tr>
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2">Qty</th>
            <th className="px-3 py-2">State</th>
            <th className="px-3 py-2">Method</th>
            <th className="px-3 py-2">Prep Reduction</th>
            {editable ? <th className="px-3 py-2">Actions</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id || row.itemName} className="border-t border-amber-100">
              <td className="px-3 py-2">{row.itemName}</td>
              <td className="px-3 py-2">
                {editable ? (
                  <div className="flex items-center gap-2">
                    <input
                      className="w-20 rounded border border-amber-300 px-2 py-1"
                      type="number"
                      min="0"
                      value={row.qty}
                      onChange={(e) =>
                        onQtyChange?.(row, Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : 0)
                      }
                    />
                    <span>{row.unit}</span>
                  </div>
                ) : (
                  <>
                    {row.qty} {row.unit}
                  </>
                )}
              </td>
              <td className="px-3 py-2">{row.state || "raw"}</td>
              <td className="px-3 py-2">{row.method || "-"}</td>
              <td className="px-3 py-2">{row.prepTimeReductionPct ? `${Math.round(row.prepTimeReductionPct * 100)}%` : "0%"}</td>
              {editable ? (
                <td className="px-3 py-2">
                  <button
                    type="button"
                    className="rounded border border-rose-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                    onClick={() => onRemoveRow?.(row)}
                  >
                    Remove
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}
