/**
 * The Reader's Files view under keyboard steering: the pure cursor / row /
 * action model (`TerminalReaderFiles` does the DOM and the props).
 *
 * The view lists files, then links, as one walkable list. The cursor is a
 * *key* (a file's path, a link's URL), never an index: the lists grow while the
 * agent talks, and a key survives rows arriving above it. Moving the cursor
 * opens nothing; only `o` / `v` act on the row it stands on.
 */

export type RowKind = "file" | "link";

export interface Row {
  kind: RowKind;
  /** The file's path or the link's URL. */
  key: string;
}

/** What one key press asks the view to do besides moving the cursor. */
export type FilesEffect = "show" | "openTab" | "openTabNew" | "openLink" | "scroll" | "out";

export interface FilesDecision {
  /** The cursor's new key, when the press moved it. */
  cursor?: string;
  effect?: FilesEffect;
  /** The row `show` / `openTab` / `openTabNew` / `openLink` act on. */
  row?: Row;
  /** Screens to scroll with `scroll` (negative = back). */
  pages?: number;
}

export type FilesAction = "up" | "down" | "left" | "right" | "viewOpen" | "viewOpenAlt";

export interface FilesMods {
  shift: boolean;
  repeat: boolean;
}

/** The walkable list: every file, then every link (the order the view draws). */
export function rowsOf(files: readonly { entry: { path: string } }[], links: readonly { url: string }[]): Row[] {
  return [
    ...files.map((file) => ({ kind: "file" as const, key: file.entry.path })),
    ...links.map((link) => ({ kind: "link" as const, key: link.url })),
  ];
}

/** Where the cursor starts: the file already shown, else the first row. */
export function startKey(rows: readonly Row[], pickedPath: string | null | undefined): string | null {
  if (pickedPath && rows.some((row) => row.kind === "file" && row.key === pickedPath)) return pickedPath;
  return rows[0]?.key ?? null;
}

/** The cursor in effect: the set one while its row exists, else the start. */
export function effectiveCursor(rows: readonly Row[], cursor: string | null, pickedPath: string | null | undefined): string | null {
  if (cursor !== null && rows.some((row) => row.key === cursor)) return cursor;
  return startKey(rows, pickedPath);
}

/**
 * One row up (`delta` -1) or down (+1). Down on the last row stays; up on the
 * first is `"out"` (the caller leaves to the tabs). A cursor not in `rows`
 * counts as the first row.
 */
export function stepCursor(rows: readonly Row[], cursor: string | null, delta: -1 | 1): string | "out" {
  if (rows.length === 0) return "out";
  const at = Math.max(0, rows.findIndex((row) => row.key === cursor));
  const to = at + delta;
  if (to < 0) return "out";
  return rows[Math.min(to, rows.length - 1)].key;
}

/**
 * The first row of the previous (-1) / next (+1) section, Files then Links;
 * a section with no rows does not exist, so with one section (or none beyond
 * the cursor's) the cursor stays.
 */
export function jumpSection(rows: readonly Row[], cursor: string | null, delta: -1 | 1): string | null {
  const here = rows.find((row) => row.key === cursor);
  if (!here) return rows[0]?.key ?? null;
  const target: RowKind | null = delta > 0 ? (here.kind === "file" ? "link" : null) : here.kind === "link" ? "file" : null;
  if (!target) return here.key;
  return rows.find((row) => row.kind === target)?.key ?? here.key;
}

/**
 * One key press against the list. `cursor` is the effective cursor (see
 * `effectiveCursor`). Up past the first row is `effect: "out"` — except on key
 * repeat, which does nothing (a held ↑ must not run on out of the view). The
 * open and show keys ignore repeat.
 */
export function decide(rows: readonly Row[], cursor: string | null, action: FilesAction, mods: FilesMods): FilesDecision {
  switch (action) {
    case "up":
    case "down": {
      const delta = action === "up" ? -1 : 1;
      if (mods.shift) {
        const next = jumpSection(rows, cursor, delta);
        return next !== null && next !== cursor ? { cursor: next } : {};
      }
      // Nothing to walk: ↑ steps out as from a first row, but ↓ never leaves.
      if (rows.length === 0 && delta > 0) return {};
      const next = stepCursor(rows, cursor, delta);
      if (next === "out") return mods.repeat ? {} : { effect: "out" };
      return next === cursor ? {} : { cursor: next };
    }
    case "left":
    case "right":
      return { effect: "scroll", pages: (action === "right" ? 1 : -1) * (mods.shift ? 1 : 0.5) };
    case "viewOpen": {
      const row = rows.find((r) => r.key === cursor);
      if (!row || mods.repeat) return {};
      if (row.kind === "link") return { effect: "openLink", row };
      return { effect: mods.shift ? "openTabNew" : "openTab", row };
    }
    case "viewOpenAlt": {
      const row = rows.find((r) => r.key === cursor);
      if (!row || mods.repeat || row.kind === "link") return {};
      return { effect: "show", row };
    }
  }
}
