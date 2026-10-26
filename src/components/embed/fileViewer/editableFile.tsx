import { DraftSaver } from "../draftSaver";
import { registerUnsavedWork } from "../../../lib/window/unsavedWork";
import { usePaneSleepHold } from "../../../lib/sleepWhenHidden";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useSettingsStore } from "../../../stores/settings";
import { useDiskReloadPoll } from "../../../lib/useDiskReloadPoll";
import { useProjectsStore } from "../../../stores/projects";
import { useProjectRemarksStore } from "../../../stores/projectRemarks";
import { type EditResult } from "../../../lib/viewers/markdownEdit";
import { lineEndingOf, applyLineEnding } from "../../../lib/viewers/fileUtils";
import { basename } from "../../../lib/paths";
import { resolveProjectDirectory } from "../../../types";
import {
  useFileScope,
  readFileText,
  writeFileText,
  fileMtime,
  describeFileErrorKey,
} from "../../../lib/files/fileAccess";
import { useT, type TranslationKey } from "../../../lib/i18n";

// ── Undo/redo history (#46) ──────────────────────────────────────────────────

/** Edit-history state: a stack of past values, the present value, and a redo
 *  stack of future values. Pure so it can be unit-tested without React. */
/** Imperative editing surface exposed by {@link CodeEditor} via `editorApiRef`,
 *  letting a toolbar transform the live value+selection. */
export interface EditorApi {
  /** Run `fn` over the current value and selection `[start, end)`, commit the
   *  result through the editor's normal edit path, and restore the returned
   *  selection. */
  applyEdit: (fn: (value: string, start: number, end: number) => EditResult) => void;
}

export interface EditHistory {
  past: string[];
  present: string;
  future: string[];
}

export type EditAction =
  | { type: "set"; value: string; coalesce?: boolean }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset"; value: string };

/** Cap so a long editing session can't grow the undo stack without bound. */
const HISTORY_LIMIT = 200;

/**
 * Pure reducer for the editor undo/redo history (#46). A "set" pushes the prior
 * present onto `past` and clears `future`, unless `coalesce` is true (rapid
 * keystrokes) — then it replaces the present in place so a burst of typing
 * collapses into one undo step. "reset" seeds a fresh baseline (file (re)load)
 * with empty stacks.
 */
export function editHistoryReducer(state: EditHistory, action: EditAction): EditHistory {
  switch (action.type) {
    case "set": {
      if (action.value === state.present) return state;
      if (action.coalesce) {
        return { ...state, present: action.value, future: [] };
      }
      const past = [...state.past, state.present];
      if (past.length > HISTORY_LIMIT) past.shift();
      return { past, present: action.value, future: [] };
    }
    case "undo": {
      if (state.past.length === 0) return state;
      const prev = state.past[state.past.length - 1];
      return {
        past: state.past.slice(0, -1),
        present: prev,
        future: [state.present, ...state.future],
      };
    }
    case "redo": {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        past: [...state.past, state.present],
        present: next,
        future: state.future.slice(1),
      };
    }
    case "reset":
      return { past: [], present: action.value, future: [] };
    default:
      return state;
  }
}

// Coalesce keystrokes within this window into a single undo step.
const COALESCE_MS = 400;

/** React wrapper over `editHistoryReducer` exposing `value`, a coalescing
 *  `setValue`, `undo`/`redo` (+ availability), and `reset`. */
function useEditHistory(initial: string) {
  const [hist, dispatch] = useReducer(editHistoryReducer, {
    past: [],
    present: initial,
    future: [],
  } as EditHistory);
  const lastEditAt = useRef(0);

  const setValue = useCallback((value: string) => {
    const now = Date.now();
    const coalesce = now - lastEditAt.current < COALESCE_MS;
    lastEditAt.current = now;
    dispatch({ type: "set", value, coalesce });
  }, []);
  const undo = useCallback(() => dispatch({ type: "undo" }), []);
  const redo = useCallback(() => dispatch({ type: "redo" }), []);
  const reset = useCallback((value: string) => {
    lastEditAt.current = 0;
    dispatch({ type: "reset", value });
  }, []);

  return {
    value: hist.present,
    setValue,
    undo,
    redo,
    reset,
    canUndo: hist.past.length > 0,
    canRedo: hist.future.length > 0,
  };
}

/**
 * Editable-file state shared by the editable viewers — the code and markdown
 * editors, and the table viewer, whose cell edits are splices into this same
 * text draft (see `lib/viewers/table.ts`): loads `path`, keeps a `draft` against
 * the last-known-on-disk `baseline` (so "dirty" is just draft !== baseline), and
 * writes the draft back via write_file_text — re-seeding the baseline on success
 * so the dirty flag clears without re-reading the file.
 *
 * Adds (Group M):
 *  - #46 undo/redo: the draft is backed by `useEditHistory`; `undo`/`redo` are
 *    surfaced for keybindings + toolbar buttons.
 *  - #47 autosave: when `settings.autosave` is on, a dirty buffer is saved after
 *    400 ms idle, with a 2-second maximum scheduling delay and serialized writes.
 *  - #43 diff-aware reload: polls `file_mtime`; when the file changes on disk it
 *    silently re-reads into a clean buffer, or surfaces a non-destructive banner
 *    when the buffer is dirty (Reload / Keep mine) — never clobbering edits.
 */
export function useEditableFile(path: string, enabled = true) {
  const scope = useFileScope();
  const t = useT();
  const loadedIdentity = useRef<string | null>(null);
  const identity = JSON.stringify([path, scope]);
  const [content, setContent] = useState<string | null>(null);
  // The failure is held as a translation KEY, not a sentence: the read effects
  // must not depend on `t` (a language flip would re-run them and discard an
  // unsaved draft), and holding the key makes the message follow the language.
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const error = errorKey ? t(errorKey) : null;
  const [baseline, setBaseline] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // True when disk changed under a dirty buffer; the viewer shows a banner.
  const [externalChange, setExternalChange] = useState(false);

  const { value: draft, setValue: setDraftValue, undo, redo, reset, canUndo, canRedo } =
    useEditHistory("");

  // mtime we last saw on disk, to detect external writes (#43): the reload
  // poll's baseline (`useDiskReloadPoll`, below), seeded here with the load.
  // Our own saves bump it so they don't trip the watcher.
  const lastMtime = useRef<number | null>(null);

  // The line ending the FILE uses, remembered at load and re-applied at save.
  //
  // It has to be remembered, because the draft cannot carry it: the editor is a
  // `<textarea>` and `onTextChange` reads `el.value`, whose API value the HTML
  // spec normalizes to LF. So the first keystroke anywhere in a CRLF file
  // silently rewrote EVERY line ending in the buffer and the save wrote LF
  // throughout — a one-character edit producing a whole-file diff, in every text
  // viewer at once (md, tex, yaml, .bib, code). That also broke the promise the
  // structured viewers are built on: `yaml.ts`, `table.ts` and `bib.ts` each
  // derive the file's ending from the buffer and splice it back, so on a CRLF
  // file they wrote CRLF into a buffer that turned LF underneath them and the
  // result was MIXED endings.
  //
  // The buffer is therefore LF by construction — seeded normalized, so every
  // parser and splice above sees one convention — and the ending is restored on
  // the way out, at the single place bytes leave this hook.
  const fileEol = useRef<"\r\n" | "\n">("\n");

  // Autosave is ON by default; only an explicit `autosave: false` disables it.
  const autosave = useSettingsStore((s) => s.settings?.autosave !== false);

  // setDraft seeds history when typing; reset is used for (re)loads from disk.
  const setDraft = setDraftValue;

  const seedFromDisk = useCallback(
    (text: string) => {
      // Record the file's own ending, then hold the buffer in LF (see `fileEol`).
      // A file with no CRLF at all is LF, which is also the right default for an
      // empty one. Mixed endings resolve to CRLF, the same "any CRLF ⇒ CRLF" rule
      // `bib.ts`'s `lineEndingOf` and `table.ts` already follow.
      fileEol.current = lineEndingOf(text);
      const lf = applyLineEnding(text, "\n");
      reset(lf);
      setBaseline(lf);
      setContent(lf);
      setExternalChange(false);
    },
    [reset],
  );

  // Initial load + mtime baseline.
  useEffect(() => {
    let cancelled = false;
    loadedIdentity.current = null;
    setSaving(false);
    setSaveError(null);
    setContent(null);
    setErrorKey(null);
    setBaseline(null);
    setExternalChange(false);
    lastMtime.current = null;
    if (!enabled) return;
    readFileText(path, scope)
      .then((text) => {
        if (cancelled) return;
        loadedIdentity.current = identity;
        seedFromDisk(text);
      })
      .catch((e) => { if (!cancelled) setErrorKey(describeFileErrorKey(e)); });
    fileMtime(path, scope)
      .then((m) => { if (!cancelled) lastMtime.current = m; })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [path, scope, seedFromDisk, enabled, identity]);

  const loaded = content != null && loadedIdentity.current === identity;
  const isDirty = loaded && baseline != null && draft !== baseline;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;
  // An unsaved buffer (or a save in flight) keeps the pane awake: a sleeping
  // pane is unmounted, and the buffer lives here (performance plan §5.3).
  usePaneSleepHold(isDirty || saving);
  // The poll's `.then` closes over the render that armed it, so the baseline is
  // read through a ref — same reason `isDirtyRef` exists beside it.
  const baselineRef = useRef(baseline);
  baselineRef.current = baseline;

  const saver = useMemo(() => new DraftSaver(async (text) => {
    // The ONE place a text buffer leaves this hook, and therefore the one place
    // the file's own line ending is restored (see `fileEol`). `\r?\n` rather than
    // `\n` so this is idempotent: a buffer that still holds CRLF — the seed,
    // before any keystroke has been through the textarea — is not doubled into
    // `\r\r\n`.
    await writeFileText(path, applyLineEnding(text, fileEol.current), scope);
    if (scope && basename(path).toLowerCase() === "remarks.md") {
      const project = useProjectsStore.getState().projects.find((p) => p.id === scope);
      if (project) await useProjectRemarksStore.getState().load(scope, resolveProjectDirectory(project));
    }
  }), [path, scope]);
  useEffect(() => {
    let active = true;
    saver.onSaved = (text) => {
      if (!active) return;
      setBaseline(text);
      setExternalChange(false);
      void fileMtime(path, scope).then((m) => {
        if (active) lastMtime.current = m;
      }).catch(() => {});
    };
    saver.onStatus = (busy, error) => {
      if (active) { setSaving(busy); setSaveError(error); }
    };
    // A popout closed by a Wayland scope-out asks this before it goes.
    const unregister = registerUnsavedWork({
      dirty: () => saver.dirty,
      flush: () => saver.flushIfAutosave(),
    });
    return () => {
      active = false;
      unregister();
      saver.dispose();
    };
  }, [saver, path, scope]);
  useEffect(() => {
    saver.update(draft, baseline, loaded && enabled, autosave);
  }, [saver, draft, baseline, loaded, enabled, autosave]);
  const save = useCallback(() => saver.flush(), [saver]);

  // #43 diff-aware reload: on an external write, re-read into a clean buffer
  // silently, or flag a banner if the buffer is dirty. `useDiskReloadPoll` only
  // polls while the pane is on screen (the catch-up on re-show compares against
  // the baseline seeded at load time) and widens rather than stops while the
  // window is unfocused: a viewer left open on a second screen as a live
  // preview of a file edited in another app must still follow it.
  const onDiskChange = useCallback(() => {
    if (isDirtyRef.current) {
      // Don't clobber unsaved edits — surface a reconcile banner.
      setExternalChange(true);
      return;
    }
    // Clean buffer → silently re-read + reseed baseline/draft.
    //
    // …but NOT when the bytes are the ones already in the buffer. An mtime
    // advance is not a content change: a latexmk run that rewrote an
    // identical file, a `touch`, a formatter that made no difference, a
    // checkout of the same content all land here, and `seedFromDisk`
    // `reset()`s the history — clearing `past` AND `future`. So an
    // untouched recompile in the background silently threw away the
    // reader's whole undo stack, with nothing on screen to say it had
    // happened. The banner case at least asks; this one never did.
    //
    // The comparison is made in BUFFER space, not against the raw bytes:
    // the draft is LF by construction (see `fileEol`), so a CRLF file read
    // back from disk would never compare equal and the skip would never
    // fire on exactly the platform that needs it.
    const readIdentity = identity;
    readFileText(path, scope)
      .then((text) => {
        if (loadedIdentity.current !== readIdentity || isDirtyRef.current) return;
        if (applyLineEnding(text, "\n") === baselineRef.current) return;
        seedFromDisk(text);
      })
      .catch(() => {});
  }, [path, scope, identity, seedFromDisk]);
  useDiskReloadPoll(path, scope, onDiskChange, { enabled: loaded, baseline: lastMtime, seed: false });

  // Banner actions (#43): take the disk version, or keep mine (dismiss banner +
  // adopt current mtime so the next external change re-triggers).
  const reloadFromDisk = useCallback(() => {
    readFileText(path, scope)
      .then((text) => { if (loadedIdentity.current === identity) seedFromDisk(text); })
      .catch((e) => { if (loadedIdentity.current === identity) setSaveError(String(e)); });
  }, [path, scope, seedFromDisk, identity]);
  const keepMine = useCallback(() => setExternalChange(false), []);

  return {
    content, error, draft, setDraft, loaded, isDirty, saving, saveError, save,
    undo, redo, canUndo, canRedo,
    externalChange, reloadFromDisk, keepMine,
    /** The text last read from or written to disk — what a build sees. */
    baseline,
  };
}

/** The non-destructive external-change banner (#43). */
export function ExternalChangeBanner({
  onReload,
  onKeep,
}: {
  onReload: () => void;
  onKeep: () => void;
}) {
  const t = useT();
  return (
    <div className="file-viewer-reload-banner" role="alert">
      <span>{t("fileViewer.externalChangeMsg")}</span>
      <button className="file-viewer-reload-btn" onClick={onReload}>{t("common.reload")}</button>
      <button className="file-viewer-reload-btn" onClick={onKeep}>{t("fileViewer.keepMine")}</button>
    </div>
  );
}

/**
 * Read-only sibling of `useEditableFile` for the table/notebook/diff viewers
 * (none of which edit on disk). Loads the file once via `read_file_text` and
 * polls `file_mtime`, silently re-reading when the file changes underneath — the
 * same load/refresh path `useEditableFile` uses, minus all the draft/undo/save
 * machinery. Returns the raw text (or null while loading) and an error string.
 */
export function useReadonlyFile(path: string) {
  const t = useT();
  const scope = useFileScope();
  // Which file is on screen, so a re-read that lands after a switch is dropped.
  const identity = JSON.stringify([path, scope]);
  const current = useRef(identity);
  current.current = identity;
  const [content, setContent] = useState<string | null>(null);
  // The failure is held as a translation KEY, not a sentence: the read effects
  // must not depend on `t` (a language flip would re-run them and discard an
  // unsaved draft), and holding the key makes the message follow the language.
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const error = errorKey ? t(errorKey) : null;

  useEffect(() => {
    let cancelled = false;
    setContent(null);
    setErrorKey(null);
    readFileText(path, scope)
      .then((text) => { if (!cancelled) setContent(text); })
      .catch((e) => { if (!cancelled) setErrorKey(describeFileErrorKey(e)); });
    return () => { cancelled = true; };
  }, [path, scope]);

  // Diff-aware reload: silently re-read on an external write, once loaded. The
  // read is dropped if the file was switched meanwhile.
  const onDiskChange = useCallback(() => {
    readFileText(path, scope)
      .then((text) => {
        if (current.current === identity) setContent(text);
      })
      .catch(() => {});
  }, [path, scope, identity]);
  useDiskReloadPoll(path, scope, onDiskChange, { enabled: content != null });

  return { content, error, loaded: content != null };
}
