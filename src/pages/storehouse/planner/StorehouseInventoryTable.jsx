import React from "react";

export default function StorehouseInventoryTable({ rows = [] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-amber-200 bg-white">
      <table className="min-w-full text-sm">
        <thead className="bg-amber-50 text-left text-amber-900">
          <tr>
            <th className="px-3 py-2">Item</th>
            <th className="px-3 py-2">Qty</th>
            <th className="px-3 py-2">State</th>
            <th className="px-3 py-2">Method</th>
            <th className="px-3 py-2">Prep Reduction</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id || row.itemName} className="border-t border-amber-100">
              <td className="px-3 py-2">{row.itemName}</td>
              <td className="px-3 py-2">{row.qty} {row.unit}</td>
              <td className="px-3 py-2">{row.state || "raw"}</td>
              <td className="px-3 py-2">{row.method || "-"}</td>
              <td className="px-3 py-2">{row.prepTimeReductionPct ? `${Math.round(row.prepTimeReductionPct * 100)}%` : "0%"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
