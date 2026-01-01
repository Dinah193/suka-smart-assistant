import React from "react";
import { Package, Info } from "lucide-react";

export default function PantryModePanel() {
  return (
    <div className="rounded-lg border p-3 bg-muted/30">
      <div className="flex items-start gap-2">
        <Package className="h-4 w-4 mt-0.5" />
        <div className="min-w-0">
          <div className="text-sm font-medium">Pantry Mode</div>
          <div className="text-[12px] text-muted-foreground mt-1">
            Scan items to add/update pantry inventory workflows (your
            automation/runtime decides whether to quick-add, match catalog
            methods, or open a session).
          </div>

          <div className="mt-2 inline-flex items-center gap-2 text-[11px] text-muted-foreground">
            <Info className="h-4 w-4" />
            Shopping & Receipt modes add staging gates (no commit until
            receipt).
          </div>
        </div>
      </div>
    </div>
  );
}
