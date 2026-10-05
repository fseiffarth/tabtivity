import { create } from "zustand";
import { storageKey } from "../../lib/brand";

/**
 * The TeX editor's two chrome switches — the beamer overlay bar (#tex-beamer)
 * and the snippet hover preview (#tex-hover-preview) — remembered **per
 * project**, across project switches and relaunches.
 *
 * They used to live on the tab (`ViewerState.texBeamer` / `.texHoverPreview`),
 * which meant every `.tex` file of a deck had to be told "beamer" separately and
 * a fresh tab of the same document opened without the bar. Neither switch is a
 * statement about one file: a project is a paper or a deck, and hovering is a
 * way of reading that does not change from chapter to chapter. So the row is the
 * project's, keyed by its id (`"root"` for the root scope), and every TeX pane
 * in it — center, workspace, popout — reads the same row live.
 *
 * Absent means "no choice made": the beamer bar follows the document
 * (`\documentclass{beamer}` ⇒ on) and the hover preview follows the per-type
 * `viewer_prefs.tex` default (on). Only a click writes a row.
 *
 * Persisted in localStorage like `fileSourcePref`: this is per-machine UI state,
 * not project identity, so it belongs neither in `project.json` (a control file
 * inside a public tree) nor in the session's tab layout (which is per tab by
 * construction).
 */
export interface TexViewPref {
  beamer?: boolean;
  hoverPreview?: boolean;
}

/** Where the per-project choices are remembered across relaunches. */
const STORAGE_KEY = storageKey("texViewByProject");

/** Bound on the persisted map — a project the user never opens again must not
 *  keep a row forever. Oldest insertions are dropped first. */
const MAX_PERSISTED = 200;

/** The store key for a file scope: a project id, or the root scope. */
export function texViewScopeKey(projectId: string | null | undefined): string {
  return projectId ?? "root";
}

function readPersisted(): Record<string, TexViewPref> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, TexViewPref> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue;
      const row: TexViewPref = {};
      const { beamer, hoverPreview } = v as Record<string, unknown>;
      if (typeof beamer === "boolean") row.beamer = beamer;
      if (typeof hoverPreview === "boolean") row.hoverPreview = hoverPreview;
      if (Object.keys(row).length) out[k] = row;
    }
    return out;
  } catch {
    return {};
  }
}

/** Merge one project's row into the persisted map. Re-reads first, so two
 *  windows (main + a popout share one origin, hence one localStorage) can't
 *  clobber each other's rows with a stale in-memory snapshot. */
function persistRow(key: string, row: TexViewPref) {
  try {
    const stored = readPersisted();
    delete stored[key]; // re-insert last, so the cap drops the oldest
    stored[key] = row;
    const keys = Object.keys(stored);
    const kept = keys.length > MAX_PERSISTED ? keys.slice(keys.length - MAX_PERSISTED) : keys;
    const out: Record<string, TexViewPref> = {};
    for (const k of kept) out[k] = stored[k];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // localStorage unavailable — the choice still holds for this session.
  }
}

interface TexViewPrefStore {
  byProject: Record<string, TexViewPref>;
  /** The user flipped a switch in this scope: remembered across relaunches. */
  set: (key: string, patch: TexViewPref) => void;
}

export const useTexViewPrefStore = create<TexViewPrefStore>((set) => ({
  byProject: readPersisted(),
  set: (key, patch) =>
    set((s) => {
      const row = { ...s.byProject[key], ...patch };
      persistRow(key, row);
      return { byProject: { ...s.byProject, [key]: row } };
    }),
}));
