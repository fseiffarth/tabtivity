// The project docs' status shapes, with no Tauri in sight: the phone bundle and
// the pure group builder import these; `projectDocs.ts` (the commands) re-exports them.

/** `missing`: nothing is there (a ghost row when `creatable`). `template`: untouched text Tabtivity wrote. `pointer`: an untouched CLAUDE.md/GEMINI.md stub. `edited`: anything else — also a doc that is there but is a link, a FIFO, not UTF-8 or too large (never `missing`, so never offered for creation). */
export type DocState = "missing" | "template" | "edited" | "pointer";

export interface DocStatus {
  /** The leaf name in the project root, e.g. `AGENTS.md`. */
  name: string;
  state: DocState;
  /** The doc this one is shown beneath (`AGENTS.md` for a pointer file); nest only when that doc is itself in the list. */
  nestedUnder: string | null;
  /** The catalog allows creating it from its template. A ghost row is `state === "missing" && creatable`. */
  creatable: boolean;
  /** A new project is born with it (`AGENTS.md`, `README.md`): what the group's `present/total` summary counts. */
  isDefault: boolean;
}
