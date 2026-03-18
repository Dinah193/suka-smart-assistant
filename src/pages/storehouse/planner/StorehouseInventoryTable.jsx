import React from "react";

export default function StorehouseInventoryTable({
  rows = [],
  editable = false,
  onQtyChange,
  onRemoveRow,
  onQuickAdd,
}) {
  const idBase = React.useId();
  const [quickName, setQuickName] = React.useState("");
  const [quickQty, setQuickQty] = React.useState("1");
  const [quickUnit, setQuickUnit] = React.useState("unit");
  const [quickAddError, setQuickAddError] = React.useState("");

  const submitQuickAdd = (event) => {
    event?.preventDefault?.();
    const itemName = String(quickName || "").trim();
    const qty = Number(quickQty || 0);
    if (!itemName || !Number.isFinite(qty) || qty <= 0 || !onQuickAdd) {
      setQuickAddError("Enter an item name and quantity greater than zero.");
      return;
    }
    setQuickAddError("");
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
          <form className="flex flex-wrap items-end gap-2" onSubmit={submitQuickAdd}>
            <label className="text-xs text-amber-900" htmlFor={`${idBase}-quick-name`}>
              Item
            </label>
            <input
              id={`${idBase}-quick-name`}
              aria-label="Quick add item name"
              className="rounded-md border border-amber-300 px-2 py-1 text-sm"
              value={quickName}
              onChange={(e) => setQuickName(e.target.value)}
              placeholder="e.g., Dry beans"
            />
            <label className="text-xs text-amber-900" htmlFor={`${idBase}-quick-qty`}>
              Qty
            </label>
            <input
              id={`${idBase}-quick-qty`}
              aria-label="Quick add quantity"
              className="w-20 rounded-md border border-amber-300 px-2 py-1 text-sm"
              value={quickQty}
              type="number"
              min="0"
              onChange={(e) => setQuickQty(e.target.value)}
            />
            <label className="text-xs text-amber-900" htmlFor={`${idBase}-quick-unit`}>
              Unit
            </label>
            <input
              id={`${idBase}-quick-unit`}
              aria-label="Quick add unit"
              className="w-24 rounded-md border border-amber-300 px-2 py-1 text-sm"
              value={quickUnit}
              onChange={(e) => setQuickUnit(e.target.value)}
            />
            <button
              type="submit"
              className="rounded-md border border-amber-300 bg-white px-3 py-1 text-sm font-medium text-amber-900 hover:bg-amber-100"
            >
              Add item
            </button>
          </form>
          {quickAddError ? (
            <p className="mt-2 text-xs text-rose-700" role="alert">
              {quickAddError}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-2 md:hidden">
        {rows.map((row) => (
          <article key={`mobile-${row.id || row.itemName}`} className="rounded-xl border border-amber-200 bg-white p-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-amber-900">{row.itemName}</h3>
                <p className="text-xs text-amber-700">{row.state || "raw"} {row.method ? `• ${row.method}` : ""}</p>
              </div>
              <div className="text-xs text-amber-800">
                Prep reduction: {row.prepTimeReductionPct ? `${Math.round(row.prepTimeReductionPct * 100)}%` : "0%"}
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2">
              {editable ? (
                <>
                  <input
                    aria-label={`Quantity for ${row.itemName}`}
                    className="w-20 rounded border border-amber-300 px-2 py-1"
                    type="number"
                    min="0"
                    value={row.qty}
                    onChange={(e) =>
                      onQtyChange?.(row, Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : 0)
                    }
                  />
                  <span className="text-sm text-amber-900">{row.unit}</span>
                  <button
                    type="button"
                    className="ml-auto rounded border border-rose-300 px-2 py-1 text-xs text-rose-700 hover:bg-rose-50"
                    aria-label={`Remove ${row.itemName}`}
                    onClick={() => onRemoveRow?.(row)}
                  >
                    Remove
                  </button>
                </>
              ) : (
                <span className="text-sm text-amber-900">{row.qty} {row.unit}</span>
              )}
            </div>
          </article>
        ))}
      </div>

      <div className="hidden overflow-x-auto rounded-xl border border-amber-200 bg-white md:block">
      <table className="min-w-full text-sm" aria-label="Storehouse inventory table">
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
                      aria-label={`Quantity for ${row.itemName}`}
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
                    aria-label={`Remove ${row.itemName}`}
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
