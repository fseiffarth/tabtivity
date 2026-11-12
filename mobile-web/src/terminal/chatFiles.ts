// The project files an agent tab's chat touches, past the ones it sent: what
// its answers name (`useNamedFiles`, the desktop Chat's path links) and what it
// changed (`useChangedFiles`, the Diffs view's record). Both arrive as the
// library's sealed rows, so they open through the 📁 door — the file itself,
// with its own marks — and never as a path of the host's.
import { useEffect, useMemo, useRef, useState } from "react";

import { findPathCandidates } from "../../../src/lib/terminal/pathCandidates";
import { describeNamedFiles, getChanges, type ChatChanges, type OutboxFile, type PhoneMarkupFile } from "../api";
import { startVisiblePoll } from "../visiblePoll";

/** Paths asked about at once: each is a line of the request's query. */
const BATCH = 32;
/** Files one answer previews (the desktop Chat's `ReaderAnswerFiles`). */
const MAX_ANSWER_FILES = 4;
/** How often the list re-reads what the chat changed; an unmoved transcript
 * answers `unchanged`, so nothing but that crosses the link. */
const CHANGES_POLL = 8_000;
/** The changes one read lists (the route's most). */
const CHANGES_LIMIT = 200;

const NOTHING: ReadonlyMap<string, OutboxFile> = new Map();

/** One file of the library however it was reached: a chat names it twice, or
 * names one the agent sent. Its sealed token differs per read. */
export function fileKey(row: Pick<PhoneMarkupFile, "place" | "name">): string {
  return `${row.place}/${row.name}`;
}

/** A library row as the viewers take a file; `name` is what it is keyed by. */
export function rowFile(row: PhoneMarkupFile, name = fileKey(row)): OutboxFile {
  return { name, original: row.name, kind: row.kind, size: row.size, modified: row.modified, ref: row.token, file_row: row };
}

function pathsOf(texts: readonly string[]): string[] {
  return [...new Set(texts.flatMap((text) => findPathCandidates(text).map((candidate) => candidate.path)))];
}

/**
 * The files `texts` (the chat's answers) name, by the words that name them.
 * Each path is asked about once, except that the newest answer's are asked
 * again: an agent often says what it will write before it has. A failed ask
 * leaves the paths unasked for the next change of `texts`. The map stands
 * until a new file turns up, so a poll re-renders no answer. It holds only
 * what the current `texts` name: after a clear or a resume, the earlier
 * conversation's files drop out (and come back at once, already known, when
 * its words return).
 */
export function useNamedFiles(tabId: string, texts: readonly string[], enabled: boolean): ReadonlyMap<string, OutboxFile> {
  const [found, setFound] = useState(NOTHING);
  const asked = useRef(new Set<string>());
  const known = useRef(NOTHING);
  const shown = enabled ? texts.join("\u0000") : "";
  useEffect(() => {
    asked.current = new Set();
    known.current = NOTHING;
    setFound(NOTHING);
  }, [tabId]);
  useEffect(() => {
    const parts = shown ? shown.split("\u0000") : [];
    const newest = new Set(pathsOf(parts.slice(-1)));
    const missing = pathsOf(parts).filter((path) => !known.current.has(path) && (!asked.current.has(path) || newest.has(path)));
    if (missing.length === 0) return;
    const controller = new AbortController();
    void (async () => {
      for (let start = 0; start < missing.length; start += BATCH) {
        const batch = missing.slice(start, start + BATCH);
        let rows: Awaited<ReturnType<typeof describeNamedFiles>>;
        try {
          rows = await describeNamedFiles(tabId, batch, controller.signal);
        } catch {
          return;
        }
        if (controller.signal.aborted) return;
        for (const path of batch) asked.current.add(path);
        if (rows.length === 0) continue;
        const next = new Map(known.current);
        for (const { path, file } of rows) next.set(path, rowFile(file, path));
        known.current = next;
        setFound(next);
      }
    })();
    return () => controller.abort();
  }, [tabId, shown]);
  return useMemo(() => {
    if (found.size === 0) return found;
    const named = new Set(pathsOf(shown ? shown.split("\u0000") : []));
    return [...found.keys()].every((path) => named.has(path)) ? found : new Map([...found].filter(([path]) => named.has(path)));
  }, [found, shown]);
}

/** The previews under one answer: the pictures and PDFs it names, in order,
 * each once, past any the chat already shows as sent (`sent`). */
export function answerLeaves(text: string, named: ReadonlyMap<string, OutboxFile>, sent: ReadonlySet<string>): string[] {
  const leaves: string[] = [];
  const seen = new Set<string>();
  for (const { path } of findPathCandidates(text)) {
    const file = named.get(path);
    if (!file?.file_row || !(file.kind.startsWith("image/") || file.kind === "application/pdf")) continue;
    const key = fileKey(file.file_row);
    if (seen.has(key) || sent.has(key)) continue;
    seen.add(key);
    leaves.push(path);
    if (leaves.length === MAX_ANSWER_FILES) break;
  }
  return leaves;
}

/** What the chat changed, newest first, and whether the record holds more
 * than that: a file the library would not list, or changes past the read. */
export interface ChangedFiles {
  files: readonly OutboxFile[];
  more: boolean;
}

const UNCHANGED: ChangedFiles = { files: [], more: false };

/** The files of one read of the changes, each once, as of its newest change. */
export function changedFiles(read: Pick<ChatChanges, "changes" | "truncated">): ChangedFiles {
  const files = new Map<string, OutboxFile>();
  let more = read.truncated;
  for (let index = read.changes.length - 1; index >= 0; index -= 1) {
    const row = read.changes[index].file;
    if (!row) {
      more = true;
      continue;
    }
    const key = fileKey(row);
    if (!files.has(key)) files.set(key, rowFile(row));
  }
  return { files: [...files.values()], more };
}

/** The files `tabId`'s conversation changed, re-read while the page is
 * visible. A read that fails, or a desktop that refuses (the "Project files
 * on the phone" switch), keeps what is shown. */
export function useChangedFiles(tabId: string, enabled: boolean): ChangedFiles {
  const [changed, setChanged] = useState(UNCHANGED);
  useEffect(() => {
    setChanged(UNCHANGED);
    if (!enabled) return;
    let version: string | undefined;
    return startVisiblePoll(async (signal) => {
      const read = await getChanges(tabId, version, undefined, signal, CHANGES_LIMIT);
      if (signal.aborted || !read.available || read.unchanged) return;
      version = read.version;
      setChanged(changedFiles(read));
    }, CHANGES_POLL).stop;
  }, [tabId, enabled]);
  return changed;
}

/** The named files a path in an answer's words opens: what the viewers show. */
export function useViewableNamed(named: ReadonlyMap<string, OutboxFile>, viewable: (file: OutboxFile) => boolean): ReadonlyMap<string, OutboxFile> {
  return useMemo(() => new Map([...named].filter(([, file]) => viewable(file))), [named, viewable]);
}
