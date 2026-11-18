import { forPlatformKeys } from "../../lib/shortcuts/shortcuts";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useT, type TranslationKey } from "../../lib/i18n";
import { useUse24h } from "../../lib/timeFormat";
import { basename, relativePathWithin } from "../../lib/paths";
import { parseUnifiedDiff, type DiffLine } from "../../lib/viewers/diff";
import { disabledViewers, type FileEntry } from "../../lib/viewers/fileUtils";
import { readerRequest } from "../../lib/agents/agentReader";
import { watchedReads } from "../../lib/agents/transcriptWatch";
import { useSettingsStore } from "../../stores/settings";
import type { TabEntry } from "../../stores/tabs";
import { DiffLineRow, SplitRows } from "../embed/DiffView";
import { hunkWordMarks, type WordMark } from "../../lib/viewers/wordDiff";
import { SIGN_IN_CARD_CLASS } from "./TerminalSignInCard";
import { openFileEntry } from "../../lib/files/openFileEntry";
import { openTabInScope } from "../../lib/tabs/tabScopeContext";
import { UntestedTag } from "../common/UntestedTag";
import { ArrowUpRightIcon, CloseIcon } from "../common/icons/Icon";
import { Dropdown } from "../common/Dropdown";
import { useCheckpointScope } from "./CheckpointDiffScope";
import { chatMoment, chatTime } from "../../../mobile-web/src/terminal/chatTimes";
import { projectIdOfScope } from "../../lib/terminal/ptyId";
import { registerReaderInside, useSteeringInside, type ReaderInsideResult } from "../../lib/agents/readerSteering";
import type { SteeringAction } from "../../lib/shortcuts/steeringBindings";
import {
  buildDiffNotesPrompt,
  describeSelection,
  PROMPT_CHAR_CAP,
  firstNoteLine,
  noteRows,
  rangeLines,
  slotLine,
  type DiffNote,
} from "../../lib/agents/diffNotes";
import { useDiffNotes, useDiffNotesStore } from "../../stores/agents/diffNotes";
import { insertIntoReader } from "../../lib/terminal/terminalDrop";
import { useDialogs } from "../common/PromptDialogs";
import { DiffNoteBox, SavedDiffNote } from "./DiffNoteBox";

/**
 * The Reader's Changes panel: the files the conversation on screen changed,
 * as the diffs its CLI recorded (`agent_tab_changes`, `services::agent_changes`
 * — Claude's applied edits, Codex's file changes, OpenCode's edit tools),
 * shown in a dedicated full-width tab. Newest first; a file row narrows
 * the list to that file's changes. Reads while shown, as the chat does, and
 * follows it into an open subagent. Portaled with the Reader over the
 * pane, so the pane's mouse handling leaves it alone (`SIGN_IN_CARD_CLASS`).
 */

export interface FileChange {
  path: string;
  kind: "edit" | "add" | "delete" | "write";
  diff: string;
  added: number;
  removed: number;
  at?: string;
  cut?: boolean;
  movedTo?: string;
}

interface AgentChanges {
  available: boolean;
  reason?: string;
  version?: string;
  unchanged?: boolean;
  changes: FileChange[];
  truncated: boolean;
  /** The read's watch is armed (`lib/agents/transcriptWatch`). */
  watched?: boolean;
}

const KIND_KEY: Record<FileChange["kind"], TranslationKey> = {
  edit: "terminal.changes.kind.edit",
  add: "terminal.changes.kind.add",
  delete: "terminal.changes.kind.delete",
  write: "terminal.changes.kind.write",
};

function reasonKey(changes: AgentChanges | null): TranslationKey {
  if (!changes) return "terminal.changes.loading";
  if (changes.reason === "no_subagent") return "terminal.changes.noSubagent";
  if (changes.reason === "unsupported") return "terminal.changes.unsupported";
  return "terminal.changes.unreadable";
}

/** `path` as shown: inside the tab's folder relative to it, else whole. */
function shownPath(base: string | undefined, path: string): string {
  return (base && relativePathWithin(base, path)) || path;
}

function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="terminal-changes-counts">
      <span className="add">+{added}</span>
      <span className="del">−{removed}</span>
    </span>
  );
}

/** Each change's card key, in the store's order: when and which file, with a
 * count for the same file twice in one moment — stable as newer ones arrive. */
function changeKeys(list: FileChange[]): string[] {
  const seen = new Map<string, number>();
  return list.map((change) => {
    const base = `${change.at ?? ""}|${change.path}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}|${n}`;
  });
}

/** The note being written or edited (one at a time, over all cards): the lines
 * it is on as indices into one card's hunk, and the row a Shift+click extends
 * from. `serial` is its box's key, so a fresh start empties the text. */
interface NoteDraft {
  card: string;
  hunk: number;
  anchor: number;
  lines: number[];
  text: string;
  /** The saved note being edited, else a new one. */
  editing?: string;
  serial: number;
}

/** What a card hands over to save a note: its fields without id and time. */
type NoteFields = Omit<DiffNote, "id" | "at">;

const NO_NOTES: DiffNote[] = [];
const NO_OP = () => {};
const NO_SAVE: NoteActions["onSaveNote"] = () => {};

/** The note handlers a card gets, stable across renders. */
interface NoteActions {
  onStartNote: (card: string, hunk: number, rows: number[][], index: number, extend: boolean) => void;
  onSaveNote: (fields: NoteFields, editing: string | undefined) => void;
  onCancelNote: () => void;
  /** The box's text as it is typed, kept so a Shift+click that moves the box
   * to another row carries it along. */
  onNoteText: (text: string) => void;
  onEditNote: (id: string) => void;
  onDeleteNote: (id: string) => void;
}

/** One change, with its time and diff. The first existing edit opens on entry;
 * newly arriving edits stay folded and marked new until opened. */
export const ChangeCard = memo(function ChangeCard({ change, cardKey, fresh, cursor, base, use24h, split, initialOpen, onOpenFile, onOpenDiff, onUnfold, notes = NO_NOTES, draft = null, onStartNote, onSaveNote = NO_SAVE, onCancelNote = NO_OP, onNoteText = NO_OP, onEditNote = NO_OP, onDeleteNote = NO_OP }: {
  change: FileChange;
  cardKey: string;
  fresh: boolean;
  /** Keyboard steering's cursor is on this card (`readerSteering`). */
  cursor: boolean;
  base: string | undefined;
  use24h: boolean;
  split: boolean;
  initialOpen: boolean;
  /** Absent: the card draws no open buttons (the checkpoint scope's). */
  onOpenFile?: (path: string, newSubwindow: boolean) => void;
  onOpenDiff?: (path: string) => void;
  onUnfold: (cardKey: string) => void;
  /** This card's saved notes, and the note being written when it is here.
   * Without `onStartNote` the card takes no notes (the checkpoint scope's). */
  notes?: DiffNote[];
  draft?: NoteDraft | null;
} & Partial<NoteActions>) {
  const t = useT();
  const [open, setOpen] = useState(initialOpen);
  // Without its final newline, which would parse as one more (empty) row.
  const files = useMemo(() => (open ? parseUnifiedDiff(change.diff.replace(/\n$/u, "")) : []), [open, change.diff]);
  // Word-level marks for every paired del/add line, shared by both layouts.
  const marks = useMemo(() => {
    const all = new Map<DiffLine, readonly WordMark[]>();
    for (const file of files) for (const hunk of file.hunks) for (const [line, m] of hunkWordMarks(hunk.lines)) all.set(line, m);
    return all;
  }, [files]);
  const shown = shownPath(base, change.path);
  const name = basename(shown);
  const folder = shown.slice(0, shown.length - name.length);
  const moment = chatMoment(change.at);
  const openable = change.kind !== "delete" && !change.movedTo;

  // Notes: a note started here (the gutter button, or the `viewNote` key on a
  // folded card) opens the card.
  const hunks = useMemo(() => files.flatMap((file) => file.hunks), [files]);
  const rows = useMemo(() => hunks.map((hunk) => noteRows(hunk.lines, split)), [hunks, split]);
  const noteLabel = t("diffNotes.add");
  useEffect(() => {
    if (!draft || open) return;
    onUnfold(cardKey);
    setOpen(true);
  }, [draft, open, onUnfold, cardKey]);
  const save = (text: string) => {
    const span = draft && describeSelection(hunks[draft.hunk]?.lines ?? [], draft.lines);
    if (!draft || !span) {
      onCancelNote();
      return;
    }
    onSaveNote({ ...span, path: shown, text: text.trim(), card: cardKey, hunk: draft.hunk, lines: draft.lines }, draft.editing);
  };
  /** One hunk's note rows: the lines under a note, and the saved notes and
   * the box that hang under each. */
  const noteView = (hunkIndex: number) => {
    const noted = new Set<number>();
    const under = new Map<number, ReactNode[]>();
    const hang = (lines: readonly number[], node: ReactNode) => {
      const slot = slotLine(rows[hunkIndex] ?? [], lines);
      if (slot !== null) under.set(slot, [...(under.get(slot) ?? []), node]);
    };
    for (const note of notes) {
      if (note.hunk !== hunkIndex) continue;
      note.lines.forEach((index) => noted.add(index));
      if (draft?.editing !== note.id) {
        hang(note.lines, <SavedDiffNote key={note.id} id={note.id} text={note.text} onEdit={onEditNote} onDelete={onDeleteNote} />);
      }
    }
    if (draft && draft.hunk === hunkIndex) {
      draft.lines.forEach((index) => noted.add(index));
      hang(draft.lines, <DiffNoteBox key={`box-${draft.serial}`} initial={draft.text} onChange={onNoteText} onSave={save} onCancel={onCancelNote} />);
    }
    const start = onStartNote
      ? (index: number, event: MouseEvent<HTMLButtonElement>) =>
        onStartNote(cardKey, hunkIndex, rows[hunkIndex] ?? [], index, event.shiftKey)
      : undefined;
    return { noted, under, start };
  };
  return (
    <section className={`terminal-changes-card ${change.kind}${fresh ? " fresh" : ""}`} data-card-key={cardKey}>
      <div className={cursor ? "terminal-changes-card-head steer-cursor" : "terminal-changes-card-head"}>
        <button
          type="button"
          className="terminal-changes-fold"
          aria-expanded={open}
          title={t(open ? "terminal.changes.collapse" : "terminal.changes.expand")}
          onClick={() => {
            if (!open) onUnfold(cardKey);
            setOpen(!open);
          }}
        >
          <span className={open ? "terminal-reader-subagent-caret open" : "terminal-reader-subagent-caret"} aria-hidden="true">▾</span>
          {fresh && <span className="terminal-changes-new">{t("terminal.changes.new")}</span>}
          <span className="terminal-changes-kind">{t(KIND_KEY[change.kind])}</span>
          <span className="terminal-changes-path" title={change.path}>
            {folder && <small>{folder}</small>}
            <strong>{name}</strong>
          </span>
        </button>
        <Counts added={change.added} removed={change.removed} />
        {notes.length > 0 && (
          <span className="terminal-changes-notechip">{t(notes.length === 1 ? "diffNotes.countOne" : "diffNotes.count", { n: notes.length })}</span>
        )}
        {moment && <small className="terminal-changes-time">{chatTime(moment, use24h)}</small>}
        {openable && onOpenDiff && (
          <button
            type="button"
            className="terminal-changes-open"
            title={t("terminal.changes.openDiff")}
            aria-label={t("terminal.changes.openDiff")}
            onClick={() => onOpenDiff(change.path)}
          >
            ±
          </button>
        )}
        {openable && onOpenFile && (
          <button
            type="button"
            className="terminal-changes-open"
            title={`${t("terminal.changes.open")} · ${forPlatformKeys(t("terminal.pathLink.newSubwindow"))}`}
            aria-label={t("terminal.changes.open")}
            onClick={(event) => onOpenFile(change.path, event.ctrlKey || event.metaKey)}
          >
            <ArrowUpRightIcon />
          </button>
        )}
      </div>
      {change.movedTo && (
        <small className="terminal-changes-note">{t("terminal.changes.moved", { path: shownPath(base, change.movedTo) })}</small>
      )}
      {open && change.kind === "write" && <small className="terminal-changes-note">{t("terminal.changes.writeHint")}</small>}
      {open && (
        <div className="terminal-changes-diff">
          {hunks.map((hunk, hunkIndex) => {
            const view = noteView(hunkIndex);
            return (
              <div className="diff-hunk" key={hunkIndex}>
                {split ? <div className="terminal-changes-split">
                  <div className="terminal-changes-split-heading"><span>{t("terminal.changes.before")}</span><span>{t("terminal.changes.after")}</span></div>
                  <SplitRows lines={hunk.lines} marks={marks} notes={view.start && { label: noteLabel, noted: view.noted, onStart: view.start, under: view.under }} />
                </div> : hunk.lines.map((line, lineIndex) => (
                  <Fragment key={lineIndex}>
                    <DiffLineRow line={line} marks={marks.get(line)} noteAt={lineIndex} onNote={view.start} noted={view.noted.has(lineIndex)} noteLabel={noteLabel} />
                    {view.under.get(lineIndex)}
                  </Fragment>
                ))}
              </div>
            );
          })}
          {change.cut && <small className="terminal-changes-note">{t("terminal.changes.cut")}</small>}
        </div>
      )}
    </section>
  );
});

/** What the Inside keys read, from the latest render. */
interface ChangesSteerState {
  /** The shown cards, newest first. */
  cards: { change: FileChange; key: string }[];
  /** Every card of the read, oldest first (the file filter not applied). */
  keyed: { change: FileChange; key: string }[];
  files: { path: string }[];
  filter: string | null;
  cursor: string | null;
  fresh: ReadonlySet<string> | null;
  openFile: (path: string, newSubwindow: boolean) => void;
  openDiff: (path: string) => void;
  /** Start a note on a card's first changed line. */
  beginNote: (cardKey: string, change: FileChange) => void;
  root: HTMLElement | null;
}

/**
 * One Inside key of the Diffs view: up/down move the card cursor (up on the
 * first card steps out, not on a held key), Shift+up/down step All, then each
 * file, `viewToggle` folds, `viewNew` jumps to the next new card, `viewMode`
 * flips split/unified, `viewNote` starts a note on the card's first changed
 * line (the box takes the keyboard), `viewOpen` opens the file (Shift: new
 * subwindow), `viewOpenAlt` the diff viewer. left/right, Enter and Space are the scroll
 * level's own (`pass`); anything else is swallowed.
 */
function changesSteerKey(
  state: ChangesSteerState,
  action: SteeringAction,
  e: Pick<KeyboardEvent, "shiftKey" | "repeat">,
  set: { setCursor: (key: string | null) => void; setPicked: (path: string | null) => void; setSplit: (fn: (split: boolean) => boolean) => void },
): ReaderInsideResult {
  const { cards, cursor } = state;
  const at = cards.findIndex((card) => card.key === cursor);
  const move = (index: number) => {
    const key = cards[index]?.key ?? null;
    state.cursor = key;
    set.setCursor(key);
  };
  switch (action) {
    case "work":
    case "agentPrompt":
    case "left":
    case "right":
      return "pass";
    case "up":
    case "down": {
      if (e.shiftKey) {
        // [All, ...files], wrapping: past the last file back to All.
        const order = [null, ...state.files.map((file) => file.path)];
        if (order.length < 2) return "handled";
        const from = Math.max(0, order.indexOf(state.filter));
        const next = order[(from + (action === "down" ? 1 : -1) + order.length) % order.length];
        const first = [...state.keyed].reverse().find((card) => !next || card.change.path === next)?.key ?? null;
        state.cursor = first;
        set.setPicked(next);
        set.setCursor(first);
        return "handled";
      }
      if (action === "up") {
        if (at <= 0) return e.repeat ? "handled" : "leave";
        move(at - 1);
      } else if (at < cards.length - 1) {
        move(at + 1);
      }
      return "handled";
    }
    case "viewToggle": {
      if (e.repeat || at < 0) return "handled";
      const card = [...(state.root?.querySelectorAll<HTMLElement>("[data-card-key]") ?? [])].find((el) => el.dataset.cardKey === cursor);
      card?.querySelector<HTMLButtonElement>(".terminal-changes-fold")?.click();
      return "handled";
    }
    case "viewNew": {
      if (e.repeat || !state.fresh?.size || cards.length === 0) return "handled";
      for (let step = 1; step <= cards.length; step++) {
        const index = (Math.max(at, 0) + step) % cards.length;
        if (state.fresh.has(cards[index].key)) {
          move(index);
          break;
        }
      }
      return "handled";
    }
    case "viewMode":
      if (!e.repeat) set.setSplit((split) => !split);
      return "handled";
    case "viewNote": {
      const card = cards[at];
      if (!e.repeat && card) state.beginNote(card.key, card.change);
      return "handled";
    }
    case "viewOpen":
    case "viewOpenAlt": {
      const change = cards[at]?.change;
      if (e.repeat || !change || change.kind === "delete" || change.movedTo) return "handled";
      if (action === "viewOpen") state.openFile(change.path, e.shiftKey);
      else state.openDiff(change.path);
      return "handled";
    }
    default:
      return "handled";
  }
}

export function TerminalReaderChanges({ scope, ptyId, tab, cwd, visible, subagent, subagentTitle, chat, chatTitle, steerId, onClose }: {
  scope: string;
  /** The pane's PTY id: the notes' owner and the Chat box they go into. */
  ptyId: string;
  tab: TabEntry;
  cwd: string | undefined;
  visible: boolean;
  /** The open subagent's handle: its changes are shown instead. */
  subagent: string | undefined;
  subagentTitle: string | undefined;
  /** An earlier chat the Reader shows (`lib/agents/agentChats`): its changes
   * are shown instead. */
  chat?: string;
  chatTitle?: string;
  /** The pane's id, for keyboard steering's Inside target (`readerSteering`). */
  steerId?: string;
  onClose: () => void;
}) {
  const t = useT();
  const use24h = useUse24h();
  const [read, setRead] = useState<{ key: string; changes: AgentChanges } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [split, setSplit] = useState(true);
  const viewerPrefs = useSettingsStore((state) => state.settings?.viewer_prefs);
  const disabled = useMemo(() => disabledViewers(viewerPrefs), [viewerPrefs]);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const base = tab.cwd || cwd;
  /** The second scope, Since checkpoint (`CheckpointDiffScope`). */
  const checkpoints = useCheckpointScope({ uid: tab.sessionId, ptyId: steerId, visible, base, split, card: ChangeCard });
  /** Whose changes a read belongs to — a read of another conversation is
   * never drawn under this one. */
  const readKey = `${tab.sessionId ?? ""}|${chat ?? ""}|${subagent ?? ""}`;
  /** The cards of the last read, and those that arrived after the panel's
   * first read of this conversation — what it already held is not new. */
  const seenRef = useRef<{ key: string; cards: Set<string> } | null>(null);
  const [fresh, setFresh] = useState<{ key: string; cards: Set<string> } | null>(null);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let version: string | undefined;
    const stop = watchedReads(async (watch) => {
      const args = readerRequest(scope, tabRef.current, cwd, version, 0, subagent, chat);
      if (!args) {
        setRead({ key: readKey, changes: { available: false, reason: "no_session", changes: [], truncated: false } });
        return false;
      }
      const next = await invoke<AgentChanges>("agent_tab_changes", { ...args, limit: null, watch })
        .catch((): AgentChanges => ({ available: false, reason: "read_failed", changes: [], truncated: false }));
      if (cancelled) return next.watched === true;
      if (!next.unchanged) version = next.version;
      if (!next.unchanged && next.available) {
        const keys = changeKeys(next.changes);
        const seen = seenRef.current;
        const arrived = seen?.key === readKey ? keys.filter((key) => !seen.cards.has(key)) : [];
        seenRef.current = { key: readKey, cards: new Set(keys) };
        if (arrived.length) {
          setFresh((previous) => ({
            key: readKey,
            cards: new Set([...(previous?.key === readKey ? previous.cards : []), ...arrived]),
          }));
        }
      }
      setRead((previous) => (next.unchanged && previous?.key === readKey ? previous : { key: readKey, changes: next }));
      return next.watched === true;
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [visible, scope, cwd, subagent, chat, readKey]);

  const changes = read?.key === readKey ? read.changes : null;
  const list = useMemo(() => (changes?.available ? changes.changes : []), [changes]);
  /** Every file changed, with its totals, in the order first changed. */
  const files = useMemo(() => {
    const byPath = new Map<string, { path: string; added: number; removed: number; count: number }>();
    for (const change of list) {
      const file = byPath.get(change.path) ?? { path: change.path, added: 0, removed: 0, count: 0 };
      file.added += change.added;
      file.removed += change.removed;
      file.count += 1;
      byPath.set(change.path, file);
    }
    return [...byPath.values()];
  }, [list]);
  const filter = picked && files.some((file) => file.path === picked) ? picked : null;
  /** Newest first, keyed by the change itself so a card keeps its fold as
   * newer ones arrive above it. */
  const keyed = useMemo(() => {
    const keys = changeKeys(list);
    return list.map((change, index) => ({ change, key: keys[index] }));
  }, [list]);
  const cards = useMemo(
    () => keyed.filter(({ change }) => !filter || change.path === filter).reverse(),
    [keyed, filter],
  );
  const freshCards = fresh?.key === readKey ? fresh.cards : null;
  const unfold = useCallback((cardKey: string) => {
    setFresh((previous) => {
      if (!previous?.cards.has(cardKey)) return previous;
      const cards = new Set(previous.cards);
      cards.delete(cardKey);
      return { key: previous.key, cards };
    });
  }, []);

  // Notes (`lib/agents/diffNotes`): the saved ones live per tab in the store;
  // the one being written is here, a card at a time.
  const { confirmAction, dialogs } = useDialogs();
  const allNotes = useDiffNotes(ptyId);
  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [noteNotice, setNoteNotice] = useState<string | null>(null);
  const serial = useRef(0);
  const noteText = useRef("");
  const cardNotes = useRef(new Map<string, DiffNote[]>());
  /** Each card's notes, an unchanged list keeping its identity so the other
   * cards' memo holds when one note changes. */
  const notesByCard = useMemo(() => {
    const grouped = new Map<string, DiffNote[]>();
    for (const note of allNotes) grouped.set(note.card, [...(grouped.get(note.card) ?? []), note]);
    const next = new Map<string, DiffNote[]>();
    for (const [card, list] of grouped) {
      const before = cardNotes.current.get(card);
      next.set(card, before && before.length === list.length && before.every((note, i) => note === list[i]) ? before : list);
    }
    cardNotes.current = next;
    return next;
  }, [allNotes]);
  const startNote = useCallback((card: string, hunk: number, rows: number[][], index: number, extend: boolean) => {
    setNoteNotice(null);
    setDraft((previous) => {
      if (extend && previous && previous.card === card && previous.hunk === hunk) {
        return { ...previous, lines: rangeLines(rows, previous.anchor, index), text: noteText.current };
      }
      serial.current += 1;
      noteText.current = "";
      return { card, hunk, anchor: index, lines: rangeLines(rows, index, index), text: "", serial: serial.current };
    });
  }, []);
  const saveNote = useCallback((fields: NoteFields, editing: string | undefined) => {
    const store = useDiffNotesStore.getState();
    if (editing) store.update(ptyId, editing, fields);
    else store.add(ptyId, { ...fields, id: `${Date.now().toString(36)}-${++serial.current}`, at: Date.now() });
    setDraft(null);
  }, [ptyId]);
  const cancelNote = useCallback(() => setDraft(null), []);
  const typeNote = useCallback((text: string) => {
    noteText.current = text;
  }, []);
  const editNote = useCallback((id: string) => {
    const note = useDiffNotesStore.getState().byTab[ptyId]?.find((n) => n.id === id);
    if (!note) return;
    serial.current += 1;
    noteText.current = note.text;
    setDraft({ card: note.card, hunk: note.hunk, anchor: note.lines[0] ?? 0, lines: note.lines, text: note.text, editing: id, serial: serial.current });
  }, [ptyId]);
  const deleteNote = useCallback((id: string) => {
    useDiffNotesStore.getState().remove(ptyId, id);
    setDraft((previous) => (previous?.editing === id ? null : previous));
  }, [ptyId]);
  const beginNote = (cardKey: string, change: FileChange) => {
    const hunks = parseUnifiedDiff(change.diff.replace(/\n$/u, "")).flatMap((file) => file.hunks);
    for (let hunk = 0; hunk < hunks.length; hunk++) {
      const index = firstNoteLine(hunks[hunk].lines);
      if (index >= 0) {
        startNote(cardKey, hunk, noteRows(hunks[hunk].lines, split), index, false);
        return;
      }
    }
  };
  const prompt = useMemo(() => buildDiffNotesPrompt(allNotes, t), [allNotes, t]);
  /** Into the Chat's text box (which takes the Reader to Chat itself), never
   * typed into the terminal or sent. Only the notes that fit go; the rest stay. */
  const addToDraft = () => {
    if (!insertIntoReader(ptyId, prompt.text)) {
      setNoteNotice(t("diffNotes.noComposer"));
      return;
    }
    setNoteNotice(null);
    useDiffNotesStore.getState().removeMany(ptyId, prompt.included.map((note) => note.id));
  };
  const clearNotes = async () => {
    if (allNotes.length > 1) {
      const ok = await confirmAction({
        title: t("diffNotes.clearTitle"),
        body: t("diffNotes.clearBody", { n: allNotes.length }),
        confirmLabel: t("diffNotes.clear"),
        danger: true,
      });
      if (!ok) return;
    }
    useDiffNotesStore.getState().clear(ptyId);
    setDraft(null);
    setNoteNotice(null);
  };

  // Ctrl (⌘) + click opens the file in a new subwindow.
  const openFile = (path: string, newSubwindow: boolean) => {
    const name = basename(path);
    const dot = name.lastIndexOf(".");
    const entry: FileEntry = {
      name,
      path,
      is_dir: false,
      size: 0,
      extension: dot > 0 ? name.slice(dot).toLowerCase() : null,
      mime: null,
    };
    openFileEntry({
      entry,
      projectDir: base ?? "",
      projectId: projectIdOfScope(scope),
      origin: "reader_changes",
      external: false,
      disabled,
      scope,
      newSubwindow,
    });
  };

  /** The file in the diff viewer (whole file unless the user narrowed it), as
   * the file tree's Show diff opens it: a re-open re-reads. */
  const openDiff = (path: string) => {
    const sameDiff = (t: TabEntry) => t.kind === "embed" && t.viewer === "diff" && t.embedPath === path;
    openTabInScope(
      scope,
      { label: basename(path), cmd: "", cwd: base ?? "", kind: "embed", embedPath: path, viewer: "diff" },
      sameDiff,
      { replace: true },
    );
  };

  // Keyboard steering (`lib/agents/readerSteering`): a card cursor and an
  // Inside target. The cursor is a card key; one gone from the list (a file
  // narrowed away) snaps to the newest card. Keys act through the latest
  // render's values (`live`), and the fold is the card's own button's click,
  // so pointer and keys share one path.
  const inside = useSteeringInside(steerId);
  const [cursor, setCursor] = useState<string | null>(null);
  const effCursor = cards.some((card) => card.key === cursor) ? cursor : (cards[0]?.key ?? null);
  const cursorKey = inside ? effCursor : null;
  const rootRef = useRef<HTMLElement>(null);
  const live = useRef<ChangesSteerState | null>(null);
  live.current = { cards, keyed, files, filter, cursor: effCursor, fresh: freshCards, openFile, openDiff, beginNote, root: rootRef.current };
  useEffect(() => {
    if (!steerId || !visible) return;
    return registerReaderInside(steerId, {
      view: "changes",
      key: (action, e) => {
        const state = live.current;
        return state ? changesSteerKey(state, action, e, { setCursor, setPicked, setSplit }) : "handled";
      },
    });
  }, [steerId, visible]);
  useEffect(() => {
    if (!cursorKey) return;
    const card = [...(rootRef.current?.querySelectorAll<HTMLElement>("[data-card-key]") ?? [])].find((el) => el.dataset.cardKey === cursorKey);
    if (typeof card?.scrollIntoView === "function") card.scrollIntoView({ block: "nearest" });
  }, [cursorKey]);

  return (
    <aside ref={rootRef} className={`terminal-changes terminal-changes-tab ${SIGN_IN_CARD_CLASS}`} aria-label={t("terminal.changes.title")} tabIndex={-1}>
      <header className="terminal-changes-head">
        <strong>{t("terminal.changes.title")}</strong>
        <UntestedTag id="terminal.reader.changes" />
        <UntestedTag id="diff-notes" />
        {list.length > 0 && (
          <small>{t("terminal.changes.summary", { files: files.length, edits: list.length })}</small>
        )}
        {allNotes.length > 0 && (
          <span className="terminal-changes-notes">
            <small>{t(allNotes.length === 1 ? "diffNotes.countOne" : "diffNotes.count", { n: allNotes.length })}</small>
            <button
              type="button"
              className="btn-primary"
              onClick={addToDraft}
              title={prompt.omitted > 0 ? t("diffNotes.partialTitle", { max: PROMPT_CHAR_CAP, n: prompt.included.length, total: allNotes.length }) : t("diffNotes.addToDraftTitle")}
            >
              {prompt.omitted > 0 ? t("diffNotes.addPartial", { n: prompt.included.length, total: allNotes.length }) : t("diffNotes.addToDraft")}
            </button>
            <button type="button" className="btn-quiet" onClick={() => void clearNotes()}>{t("diffNotes.clear")}</button>
            {noteNotice && <small className="terminal-changes-notice" role="alert">{noteNotice}</small>}
          </span>
        )}
        <Dropdown className="terminal-changes-view" value={split ? "split" : "unified"}
          options={[{ value: "split", label: t("terminal.changes.split") }, { value: "unified", label: t("terminal.changes.unified") }]}
          onChange={(value) => setSplit(value === "split")} />
        {checkpoints.switchEl}
        <button type="button" className="terminal-changes-close" onClick={onClose} title={t("terminal.changes.close")} aria-label={t("terminal.changes.close")}>
          <CloseIcon />
        </button>
      </header>
      {subagent ? (
        <small className="terminal-changes-scope" title={subagentTitle}>{t("terminal.changes.subagent", { name: subagentTitle ?? "" })}</small>
      ) : chat && (
        <small className="terminal-changes-scope" title={chatTitle}>{t("terminal.changes.chat", { name: chatTitle ?? "" })}</small>
      )}
      <div className="terminal-changes-body">
      {checkpoints.bodyEl ?? <>
      {files.length > 0 && (
        <div className="terminal-changes-files" role="listbox" aria-label={t("terminal.changes.files")}>
          <button type="button" role="option" aria-selected={!filter} className={!filter ? "active" : undefined} onClick={() => setPicked(null)}>
            <span className="terminal-changes-path"><strong>{t("terminal.changes.allFiles")}</strong></span>
          </button>
          {files.map((file) => {
            const shown = shownPath(base, file.path);
            return (
              <button
                type="button"
                role="option"
                key={file.path}
                aria-selected={filter === file.path}
                className={filter === file.path ? "active" : undefined}
                title={file.path}
                onClick={() => setPicked(filter === file.path ? null : file.path)}
              >
                <span className="terminal-changes-path"><strong>{shown}</strong></span>
                {file.count > 1 && <small><CloseIcon />{file.count}</small>}
                <Counts added={file.added} removed={file.removed} />
              </button>
            );
          })}
        </div>
      )}
      <div className="terminal-changes-list">
        {!changes?.available ? (
          <div className="terminal-reader-empty">{t(reasonKey(changes))}</div>
        ) : list.length === 0 ? (
          <div className="terminal-reader-empty">{t("terminal.changes.empty")}</div>
        ) : (
          cards.map(({ change, key }, index) => (
            <ChangeCard
              key={key}
              change={change}
              cardKey={key}
              fresh={!!freshCards?.has(key)}
              cursor={key === cursorKey}
              base={base}
              use24h={use24h}
              split={split}
              initialOpen={index === 0 && !freshCards?.has(key)}
              onOpenFile={openFile}
              onOpenDiff={openDiff}
              onUnfold={unfold}
              notes={notesByCard.get(key) ?? NO_NOTES}
              draft={draft?.card === key ? draft : null}
              onStartNote={startNote}
              onSaveNote={saveNote}
              onCancelNote={cancelNote}
              onNoteText={typeNote}
              onEditNote={editNote}
              onDeleteNote={deleteNote}
            />
          ))
        )}
        {changes?.available && changes.truncated && (
          <small className="terminal-changes-note">{t("terminal.changes.truncated")}</small>
        )}
      </div>
      </>}
      </div>
      {dialogs}
    </aside>
  );
}
