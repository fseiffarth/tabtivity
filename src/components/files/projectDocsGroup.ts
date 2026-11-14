// The file tree's "Project docs" group: the project root's standard files, the
// backend's per-doc status laid over them, and the ghost rows for the docs that
// can be created. Pure; the tree renders what this returns.
import type { FileEntry } from "../../lib/viewers/fileUtils";
import type { DocState, DocStatus } from "../../lib/projects/projectDocs";

/**
 * The docs a new project is born with (the catalog's `default` entries that are
 * not git-only). The header summary counts how many of them are there. The
 * status carries no `default` flag, so the names live here; a deleted default
 * shows as a ghost row.
 */
export const DEFAULT_DOCS: readonly string[] = ["AGENTS.md", "README.md"];

/** One row of the group, in on-screen order. */
export type DocsGroupRow =
  /** A file or folder that lists in the root. `state` is `null` before the status arrives and for `.gitignore` / `.git`. */
  | { kind: "file"; entry: FileEntry; state: DocState | null; nested: boolean }
  /** A creatable doc that is not there: a `+ name  create` row. Not a file. */
  | { kind: "ghost"; name: string };

export interface DocsGroupSummary {
  /** Default docs that are there. */
  present: number;
  /** How many default docs there are. */
  total: number;
  /** Shown docs still holding Tabtivity's untouched text (pointer files do not count). */
  templates: number;
}

export interface DocsGroup {
  rows: DocsGroupRow[];
  /** The file rows only, in group order: what selection, the row cap and shift-range see. */
  files: FileEntry[];
  /** `null` while no status is known (remote-only, not loaded): the header then shows a plain count. */
  summary: DocsGroupSummary | null;
}

/**
 * Lay the status over the root's standard files.
 *
 * - File rows keep the listing's order (the tree's sort), except that a pointer
 *   file nests directly under the doc it names (`nestedUnder`, `AGENTS.md`) when
 *   that doc is itself a row; otherwise it is an ordinary row.
 * - A doc the status calls `missing` and `creatable` becomes a ghost row after
 *   the files, in catalog order — unless the listing holds it after all.
 * - With no status there are no ghosts, no states and no summary.
 */
export function buildDocsGroup(standard: FileEntry[], status: DocStatus[] | null): DocsGroup {
  const byName = new Map<string, DocStatus>();
  for (const s of status ?? []) byName.set(s.name, s);
  const listed = new Set(standard.map((e) => e.name));

  const nestedOf = (e: FileEntry): string | null => {
    const parent = byName.get(e.name)?.nestedUnder ?? null;
    return parent && listed.has(parent) ? parent : null;
  };
  const stateOf = (e: FileEntry): DocState | null => {
    const s = byName.get(e.name)?.state ?? null;
    // The listing is the truth about what exists: a row that lists is never "missing".
    return s === "missing" ? "edited" : s;
  };

  const rows: DocsGroupRow[] = [];
  for (const e of standard) {
    if (nestedOf(e)) continue;
    rows.push({ kind: "file", entry: e, state: stateOf(e), nested: false });
    for (const child of standard) {
      if (nestedOf(child) === e.name) {
        rows.push({ kind: "file", entry: child, state: stateOf(child), nested: true });
      }
    }
  }
  for (const s of status ?? []) {
    if (s.state === "missing" && s.creatable && !listed.has(s.name)) rows.push({ kind: "ghost", name: s.name });
  }

  const files = rows.flatMap((r) => (r.kind === "file" ? [r.entry] : []));
  if (!status) return { rows, files, summary: null };
  const present = DEFAULT_DOCS.filter((n) => listed.has(n) || (byName.has(n) && byName.get(n)!.state !== "missing")).length;
  const templates = rows.filter((r) => r.kind === "file" && r.state === "template").length;
  return { rows, files, summary: { present, total: DEFAULT_DOCS.length, templates } };
}
