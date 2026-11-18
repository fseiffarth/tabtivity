import { useCallback, useState, type PointerEvent as ReactPointerEvent } from "react";

const MIN_COLUMN = 220;
const MAX_COLUMN = 1100;

const clamp = (w: number) => Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, Math.round(w)));

/** A remembered column width (per machine; a convenience, never state). Read
 *  tolerantly: a missing, non-numeric, zero or out-of-range value is the
 *  fallback or the nearest legal width, never an error. */
export function readWidth(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? clamp(n) : fallback;
  } catch {
    return fallback;
  }
}

function writeWidth(key: string, width: number) {
  try {
    localStorage.setItem(key, String(width));
  } catch {
    // Unavailable: the width holds for this session.
  }
}

/** A column's drag handle: the width follows the pointer, and is written once
 *  on release. `sign` is +1 when dragging right widens the column. Now's rail
 *  and detail and Root's open rail share it (each under its own key). */
export function useColumnWidth(key: string, fallback: number, sign: 1 | -1) {
  const [width, setWidth] = useState(() => readWidth(key, fallback));
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const startX = e.clientX;
      const start = width;
      let last = start;
      const move = (ev: PointerEvent) => {
        last = clamp(start + sign * (ev.clientX - startX));
        setWidth(last);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        writeWidth(key, last);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [key, sign, width],
  );
  return { width, onPointerDown };
}

/** The resize grip between two columns (`.cockpit-grip`). */
export function ColumnGrip({ onPointerDown }: { onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void }) {
  return <div className="cockpit-grip" role="separator" aria-orientation="vertical" onPointerDown={onPointerDown} />;
}
