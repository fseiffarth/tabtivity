import { useSyncExternalStore, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { storageKey } from "../../lib/brand";

/**
 * Hand-set widths for the wide file list's columns (Name · Git · Modified ·
 * Size; Share of folder takes what is left). A grip on a column head's right
 * edge drags its width; a double-click gives the column back its default.
 *
 * One set for every file list (side panel, Files tabs, docked columns, box
 * sections, popouts), kept in localStorage: the columns are a reading
 * preference, not a per-project rule. Each list applies the widths as CSS
 * custom properties on its root; `file-tree.css` falls back to the default
 * track when one is unset.
 */
export type FileTreeColumn = "name" | "git" | "mod" | "size";

export type FileTreeColumnWidths = Partial<Record<FileTreeColumn, number>>;

export const FILE_TREE_COLUMN_WIDTHS_KEY = storageKey("fileTree.columnWidths");

/** Index of each column's track in `.file-cols`' grid (after the chip and
 *  action tracks). */
const TRACK_INDEX: Record<FileTreeColumn, number> = { name: 2, git: 3, mod: 4, size: 5 };

/** The defaults' widths as a starting point when the track cannot be measured
 *  (the name's default is flexible; this is only where a drag starts). */
const FALLBACK_PX: Record<FileTreeColumn, number> = { name: 240, git: 110, mod: 150, size: 76 };

export const MIN_COLUMN_PX = 48;
export const MAX_COLUMN_PX = 800;

/** Name never squeezes below this when the list is narrower than the widths
 *  ask for: the other columns are fixed, Share keeps its own minimum. */
const NAME_FLOOR_PX = 120;

const COLUMNS: FileTreeColumn[] = ["name", "git", "mod", "size"];

function clampWidth(px: number): number {
  return Math.round(Math.max(MIN_COLUMN_PX, Math.min(MAX_COLUMN_PX, px)));
}

/** Parse the stored JSON, keeping only known columns with sane numbers. */
export function parseColumnWidths(raw: string | null): FileTreeColumnWidths {
  if (!raw) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return {}; }
  if (!value || typeof value !== "object") return {};
  const out: FileTreeColumnWidths = {};
  for (const col of COLUMNS) {
    const v = (value as Record<string, unknown>)[col];
    if (typeof v === "number" && Number.isFinite(v)) out[col] = clampWidth(v);
  }
  return out;
}

function readStored(): FileTreeColumnWidths {
  try { return parseColumnWidths(localStorage.getItem(FILE_TREE_COLUMN_WIDTHS_KEY)); } catch { return {}; }
}

let widths: FileTreeColumnWidths = readStored();
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function setWidths(next: FileTreeColumnWidths, persist: boolean) {
  widths = next;
  emit();
  if (!persist) return;
  try {
    if (Object.keys(next).length === 0) localStorage.removeItem(FILE_TREE_COLUMN_WIDTHS_KEY);
    else localStorage.setItem(FILE_TREE_COLUMN_WIDTHS_KEY, JSON.stringify(next));
  } catch { /* ignore storage failures */ }
}

function onStorage(e: StorageEvent) {
  // Another window (a popout) changed them.
  if (e.key !== FILE_TREE_COLUMN_WIDTHS_KEY) return;
  widths = parseColumnWidths(e.newValue);
  emit();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener("storage", onStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}

function getSnapshot() {
  return widths;
}

/** The CSS custom properties a list root carries for the set widths. */
export function columnWidthStyle(w: FileTreeColumnWidths): CSSProperties | undefined {
  const style: Record<string, string> = {};
  if (w.name != null) style["--fc-name"] = `minmax(${Math.min(NAME_FLOOR_PX, w.name)}px, ${w.name}px)`;
  if (w.git != null) style["--fc-git"] = `${w.git}px`;
  if (w.mod != null) style["--fc-mod"] = `${w.mod}px`;
  if (w.size != null) style["--fc-size"] = `${w.size}px`;
  return Object.keys(style).length ? (style as CSSProperties) : undefined;
}

/** The track's rendered width, read off the header grid's computed columns. */
function measureTrack(grip: HTMLElement, col: FileTreeColumn): number {
  const header = grip.closest<HTMLElement>(".file-cols");
  if (header) {
    const tracks = getComputedStyle(header).gridTemplateColumns.split(/\s+/);
    const px = parseFloat(tracks[TRACK_INDEX[col]] ?? "");
    if (Number.isFinite(px) && px > 0) return px;
  }
  return widths[col] ?? FALLBACK_PX[col];
}

export function useFileTreeColumns() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  function onGripPointerDown(col: FileTreeColumn, e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const grip = e.currentTarget;
    const startX = e.clientX;
    const startW = measureTrack(grip, col);
    try { grip.setPointerCapture(e.pointerId); } catch { /* jsdom / lost pointer */ }
    grip.classList.add("dragging");
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      moved = true;
      setWidths({ ...widths, [col]: clampWidth(startW + ev.clientX - startX) }, false);
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      grip.classList.remove("dragging");
      if (moved) setWidths(widths, true);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  }

  function resetColumn(col: FileTreeColumn) {
    if (widths[col] == null) return;
    const next = { ...widths };
    delete next[col];
    setWidths(next, true);
  }

  return { widths: current, style: columnWidthStyle(current), onGripPointerDown, resetColumn };
}

/** Test hook: drop the in-memory widths and re-read storage. */
export function reloadFileTreeColumnWidthsForTests() {
  widths = readStored();
  emit();
}
