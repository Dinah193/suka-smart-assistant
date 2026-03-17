import { useCallback, useRef, useState } from "react";
import { coerceNonNegativeNumber } from "@/ui/ux/validation";
import { notifyWarning } from "@/ui/ux/feedback";

export const CLAMP_HINT_TEXT =
  "Negative values are not allowed. Value was clamped to 0.";

export function useNonNegativeClampHints({
  paths = [],
  warningTitle = "Invalid quantity adjusted",
  warningDescription = "Negative values were clamped to zero.",
} = {}) {
  const [clampHints, setClampHints] = useState({});
  const hasWarnedRef = useRef(false);

  const isTrackedPath = useCallback(
    (path) => paths.some((pattern) => pattern.test(path)),
    [paths]
  );

  const sanitizeFieldValue = useCallback(
    (path, value) => {
      if (!isTrackedPath(path)) return value;

      if (value === "") {
        setClampHints((prev) => {
          if (!prev[path]) return prev;
          const next = { ...prev };
          delete next[path];
          return next;
        });
        return "";
      }

      const n = Number(value);
      if (!Number.isFinite(n)) return "";

      const safe = coerceNonNegativeNumber(n, 0);
      const clamped = safe !== n;

      if (clamped) {
        setClampHints((prev) => ({ ...prev, [path]: true }));
        if (!hasWarnedRef.current) {
          notifyWarning(warningTitle, warningDescription);
          hasWarnedRef.current = true;
        }
      } else {
        setClampHints((prev) => {
          if (!prev[path]) return prev;
          const next = { ...prev };
          delete next[path];
          return next;
        });
      }

      return safe;
    },
    [isTrackedPath, warningTitle, warningDescription]
  );

  return {
    clampHints,
    sanitizeFieldValue,
    isTrackedPath,
  };
}
