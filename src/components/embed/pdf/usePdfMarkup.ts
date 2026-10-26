/**
 * The desktop PDF viewer's markup mode — its layer, storage, Submit and pill
 * (`docs/done/pdf_markup_rounds_plan.md` §2.6). The marks are the phone's own
 * (`mobile-web/src/markup/`): the same vectors in page points, the same
 * rounds (sent marks dim and are never sent again), the same IndexedDB store
 * — in this webview, keyed by the project and the file's absolute path, never
 * in the project folder or the session state — and the same pill machine.
 *
 * Submit bakes the marked copy (`pdf_markup_submit`), then queues the prompt
 * for an agent tab of the same project as a send-now schedule and holds it for
 * the CLI's own queue (`holdPhonePrompt`), exactly as a phone prompt sent
 * mid-turn: typed in at once, never waiting an hour for an idle point.
 *
 * The agent's markup questions (`markup_ask`, `docs/done/markup_questions_mcp_plan.md`
 * P2) are listed here too: the target tab's open ask for this file, re-read on
 * `markup-mcp-changed` while the pane is on screen and once more when it shows
 * again. An answer goes out the Submit's way; when it cannot be queued the ask
 * is reopened with the answer's receipt, so the card stays and a retry works.
 *
 * Each Submit carries a fresh round id (`mintRound`) and logs its marks as
 * sent (`SentLayer.log`), so the agent's ticks (`markup_done`,
 * `docs/done/markup_tick_approve_plan.md` §3) — read for every agent tab of the
 * project on the asks' triggers — map onto sent marks; the viewer shows a ✓
 * on each, and only the reader's click (one, or Approve all) removes a mark.
 * An undone `apply` round is forgotten from the log: its ticks show nothing.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { subscribeTauri } from "../../../hooks/useTauriListener";
import { fileMtime } from "../../../lib/files/fileAccess";
import { useT } from "../../../lib/i18n";
import { holdPhonePrompt } from "../../../lib/agents/phoneHolds";
import { readTabDialogLine } from "../../../lib/agents/tabDialog";
import { agentTabLabel, agentTabModelTag, useAgentModelsStore } from "../../../stores/agents/agentModels";
import {
  blobBase64,
  DEFAULT_PDF_MARKUP_APPLY,
  markupErrorCode,
  markupReasonKey,
  markupForSubagent,
  markupUndoNote,
  pdfMarkupAsk,
  pdfMarkupInstruction,
  pdfMarkupPrompt,
  pdfMarkupUndoFailure,
  previewPdfMarkupUndo,
  runPdfMarkupUndo,
  settlePdfMarkupUndo,
  submitPdfMarkup,
  type PdfMarkupPage,
  type PdfMarkupUndoChanges,
} from "../../../lib/viewers/pdfMarkup";
import {
  answerMarkupQuestions,
  dismissMarkupQuestions,
  listMarkupQuestions,
  listMarkupTicks,
  MARKUP_MCP_CHANGED,
  questionReasonKey,
  reopenMarkupQuestions,
  type MarkupAnswer,
  type MarkupAsk,
  type MarkupTick,
} from "../../../lib/viewers/markupQuestions";
import { useSettingsStore } from "../../../stores/settings";
import { agentTabStateOf, lastTabReadAt, useActivityStore } from "../../../stores/activity";
import { queuePromptForTab } from "../../../stores/agents/agentPrompts";
import { useTabsStore, type TabEntry } from "../../../stores/tabs";
import {
  addMark,
  addMarks,
  approveMarks,
  approveShown,
  canAdd,
  canAddAll,
  canReplace,
  clearAll as clearLayerAll,
  clearPage as clearLayerPage,
  clearSent as clearLayerSent,
  commit,
  forgetRound,
  hasSent,
  isEmpty,
  markedPages,
  markSent,
  mintRound,
  redo as redoHistory,
  removeMarks,
  replaceMark,
  restyleMarks,
  setComment,
  startHistory,
  tickedMarks,
  tickGroups,
  undo as undoHistory,
  type History,
  type Layer,
  type Mark,
  type MarkColor,
  STAMP_SYMBOLS,
  type StampSymbol,
  type TextMark,
  type TickedMark,
  type TickGroup,
} from "../../../../mobile-web/src/markup/layer";
import type { TextRun } from "../../../../mobile-web/src/markup/findText";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { markupPagePicture } from "./markupPage";
import { pageTextItemBoxes } from "./pageText";
import { tickCaption, type TickCaption } from "./PdfMarkupTicks";
import {
  applyPreset as applyPenPreset,
  colorOf,
  nextStyle,
  PRESSURE_CURVES,
  readPenPrefs,
  resetPresets as resetPenPresets,
  savePreset as savePenPreset,
  stepSize as stepPenSize,
  TEXT_MARK_MODES,
  withColor,
  writePenPrefs,
  type EraserMode,
  type PenPrefs,
  type PenSize,
  type PenStyle,
  type TextMarkMode,
} from "../../../../mobile-web/src/markup/pen";
import { layerKey, loadLayer, saveLayer, stale, type Fingerprint } from "../../../../mobile-web/src/markup/store";
import {
  canApply,
  canUndo,
  followRound,
  holdsUndo,
  nextCheck,
  startRound,
  stepRound,
  undoneRound,
  type Round,
} from "../../../../mobile-web/src/markup/submitState";

/** When a tab's dialog is read a second time after its wait began. */
const DIALOG_REREAD_MS = 1_000;

export type MarkupTool = "ink" | "box" | "text" | "stamp" | "textmark" | "select" | "eraser";

/** A note being typed: where it goes, and which existing note it replaces. */
export type NoteDraft = {
  n: number;
  /** The page's size, in the units the note is placed in. */
  pageSize: [number, number];
  at: [number, number];
  index: number | null;
  text: string;
  color: MarkColor;
  size: number;
};

/** The select tool's marks: positions in `layer.pages[n].marks`, the unsent
 *  marks only — so a sent mark is never selected. */
export type MarkSelection = { n: number; indices: readonly number[] };

/** A comment being typed for the one selected ink, box or stamp mark. */
export type CommentDraft = { n: number; index: number; text: string };

/** An agent tab of the project a Submit can go to. */
export type MarkupTarget = { scheduleTargetId: string; label: string; ptyId: string };

/** The project's agent tabs that can take a scheduled prompt, in tab order. */
export function agentTargets(projectId: string, tabs: readonly TabEntry[] | undefined): MarkupTarget[] {
  return (tabs ?? []).flatMap((tab) =>
    (tab.kind === "agent" || tab.kind === "local_agent") && tab.scheduleTargetId
      ? [{ scheduleTargetId: tab.scheduleTargetId, label: tab.label, ptyId: `${projectId}:${tab.key}` }]
      : [],
  );
}

/** The tab a Submit goes to when the reader has not picked one: the one last
 *  deliberately opened (`lastTabReadAt`), else the first. */
export function defaultTarget(
  targets: readonly MarkupTarget[],
  readAt: (ptyId: string) => number | undefined = lastTabReadAt,
): MarkupTarget | null {
  let best: MarkupTarget | null = null;
  let bestAt = -1;
  for (const target of targets) {
    const at = readAt(target.ptyId) ?? 0;
    if (best === null || at > bestAt) {
      best = target;
      bestAt = at;
    }
  }
  return best;
}

/** The agent's open markup questions for this file and target tab
 * (`PdfMarkupQuestions` renders them). */
export type MarkupQuestions = {
  asks: MarkupAsk[];
  /** The ask whose answer is on its way: its card waits. */
  answering: string | null;
  /** Why the last answer or dismissal did not go through; `prompt` is the
   *  answer's text when it was taken but could not be delivered or undone. */
  failure: { text: string; prompt?: string } | null;
  dismissFailure: () => void;
  /** `true` once the answer is queued into the tab. */
  answer: (ask: MarkupAsk, answers: MarkupAnswer[]) => Promise<boolean>;
  /** **Answer in chat instead**. */
  dismiss: (ask: MarkupAsk) => Promise<void>;
  /** A question picked on the page (`on: "card"` scrolls the card to it) or in
   *  the card (`on: "page"` scrolls the page to its pin); `nonce` repeats it. */
  focus: QuestionFocus | null;
  show: (askId: string, index: number, on: QuestionFocus["on"]) => void;
};
export type QuestionFocus = { askId: string; index: number; on: "card" | "page"; nonce: number };

/** The Undo of an `apply` round (`docs/done/pdf_markup_direct_apply_plan.md`):
 *  offered on the pill once the round is done; `ask` reads what it would put
 *  back for the confirm dialog (`preview`), `confirm` runs it and answers
 *  whether it went through — the strip then reloads the PDF. `note` is how
 *  the last try went; `noUndo` why an asked-for `apply` round runs as `list`. */
export type MarkupRoundUndo = {
  offered: boolean;
  busy: boolean;
  preview: PdfMarkupUndoChanges | null;
  ask: () => Promise<void>;
  confirm: () => Promise<boolean>;
  cancel: () => void;
  note: { text: string; alert: boolean } | null;
  noUndo: string | null;
};

/** The sent marks the agent ticked off (`markup_done`), while marking with
 *  sent marks shown, and the same marks grouped by nearness (`tickGroups`),
 *  one badge each: `approve` removes a group (an undoable edit) — `marks` are
 *  the objects its badge was drawn for — `approveAll` every one listed. */
export type MarkupTicks = {
  marks: TickedMark[];
  groups: TickGroup[];
  /** A group's words at Submit and now, where both are read and differ. */
  captions: ReadonlyMap<TickGroup, TickCaption>;
  approve: (page: number, marks: readonly Mark[]) => void;
  approveAll: () => void;
};

/** The layer's undo history and the strokes in flight on top of it. */
export type MarkupEdit = {
  /** What is drawn: a gesture's scratch layer while one is in flight. */
  layer: Layer;
  /** The committed layer gestures build on. */
  base: Layer;
  showSent: boolean;
  tool: MarkupTool;
  color: MarkColor;
  /** The pen bar's choices: the pen's style and size, the eraser's mode. */
  pen: PenPrefs;
  /** A Submit is uploading: drawing waits. */
  busy: boolean;
  note: NoteDraft | null;
  /** Adds a finished mark; `false` when the layer is at the backend's ceiling. */
  add: (n: number, size: [number, number], mark: Mark) => boolean;
  /** Adds several marks as one undo step (a text-mark drag's lines). */
  addAll: (n: number, size: [number, number], marks: readonly Mark[]) => boolean;
  scratch: (next: Layer | null) => void;
  commit: (next: Layer) => void;
  openNote: (draft: NoteDraft) => void;
  editNote: (text: string) => void;
  editNoteColor: (color: MarkColor) => void;
  saveNote: (text: string | null) => void;
  cancelNote: () => void;
  /** Page `n`'s text runs for the text-mark tool: `undefined` until read
   *  (`wantText` asks), `null` when they could not be, `[]` on a page with
   *  no text. */
  text: (n: number) => readonly TextRun[] | null | undefined;
  wantText: (n: number) => void;
  /** The select tool's marks, while they stand on the committed layer. */
  selection: MarkSelection | null;
  select: (n: number, indices: readonly number[]) => void;
  clearSelection: () => void;
  /** Commits a change to the selected marks (a move) and keeps them selected. */
  commitSelection: (next: Layer) => void;
  comment: CommentDraft | null;
  editComment: (text: string) => void;
  /** `null` removes the comment. */
  saveComment: (text: string | null) => void;
  cancelComment: () => void;
};

export function usePdfMarkup({
  projectId,
  scope,
  path,
  active,
  visible,
  pageCount,
  docSize,
  docVersion,
  doc = null,
}: {
  /** The project the viewer is scoped to, when markup is offered at all. */
  projectId: string | null;
  /** The viewer's file scope, for the mtime read. */
  scope: string | null;
  /** The PDF's absolute path. */
  path: string;
  /** Markup mode is on. */
  active: boolean;
  /** The pane is on screen — the stored layer is read only then. */
  visible: boolean;
  /** Pages in the loaded document; marks past it are kept, not sent. */
  pageCount: number;
  /** The loaded file's size in bytes. */
  docSize: number | null;
  /** Bumped by every load of the document — the fingerprint is read again. */
  docVersion: number;
  /** The loaded document: Submit draws each marked page from it and reads
   *  the words under each mark (`markupPage.ts`). */
  doc?: PDFDocumentProxy | null;
}) {
  const t = useT();
  const key = useMemo(() => (projectId ? layerKey(projectId, { files: path }) : null), [projectId, path]);

  const [history, setHistory] = useState<History>(() => startHistory());
  const [scratchLayer, setScratchLayer] = useState<Layer | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loaded = key !== null && loadedKey === key;
  const [storage, setStorage] = useState<"saved" | "unsaved">("saved");
  const [storedFingerprint, setStoredFingerprint] = useState<Fingerprint | null>(null);
  const [changed, setChanged] = useState(false);
  const [fingerprint, setFingerprint] = useState<Fingerprint | null>(null);
  /** The pen bar's choices, kept for this window (`markup/pen.ts`). */
  const [pen, setPen] = useState<PenPrefs>(readPenPrefs);
  useEffect(() => writePenPrefs(pen), [pen]);
  const tool = pen.tool;
  const color = colorOf(pen);
  const [showSent, setShowSent] = useState(true);
  const [note, setNote] = useState<NoteDraft | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [roundTick, setRoundTick] = useState(0);
  /** The tab the round's last prompt went to. The picker may move on while the
   *  round is out; the pill, the undo's settle and note and **Make these
   *  changes** stay with this tab. */
  const [roundTargetId, setRoundTargetId] = useState<string | null>(null);
  /** The file changed on disk and its new pages wait for Reload. */
  const [pdfStale, setPdfStale] = useState(false);
  /** Reloaded since the agent last finished: Reload steps back to secondary. */
  const [reloaded, setReloaded] = useState(false);
  /** The last load of new pages under the marks came by itself (Settings →
   *  PDF markup → auto-reload), not by Reload PDF: the strip says so until
   *  the next round goes out or the reader reloads by hand. */
  const [autoReloaded, setAutoReloaded] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  /** The target's open asks, with the target and file they were listed for. */
  const [listed, setListed] = useState<{ key: string; asks: MarkupAsk[] } | null>(null);
  const [asksChanged, setAsksChanged] = useState(0);
  const [answering, setAnswering] = useState<string | null>(null);
  const [askFailure, setAskFailure] = useState<MarkupQuestions["failure"]>(null);
  const [questionFocus, setQuestionFocus] = useState<QuestionFocus | null>(null);
  /** **Apply marks directly**: why an asked-for `apply` round runs as `list`,
   *  what an undo would put back (the confirm dialog), how the last undo went. */
  const [noUndo, setNoUndo] = useState<string | null>(null);
  /** The preview carries the undo id it was read for: a new Submit meanwhile
   *  replaces the round, never what the dialog's Undo runs. */
  const [undoPreview, setUndoPreview] = useState<{ id: string; changes: PdfMarkupUndoChanges } | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  /** Set at once on a click, before the render that disables the button — a
   *  double click sends one request. */
  const undoBusyRef = useRef(false);
  const [undoNote, setUndoNote] = useState<MarkupRoundUndo["note"]>(null);
  /** The agent's ticks for this file, with the tabs and file they were read for. */
  const [tickList, setTickList] = useState<{ key: string; ticks: MarkupTick[] } | null>(null);
  /** Which Submit's round id an `apply` round's undo id belongs to: an undone
   *  round is forgotten from the log. */
  const undoRounds = useRef(new Map<string, string>());

  const skipSave = useRef(false);
  const pendingSave = useRef(false);
  /** A Reload is under way from the file read as this fingerprint: the record
   *  waits for the new one. */
  const reloadingRef = useRef<Fingerprint | null | false>(false);
  const fingerprintRef = useRef(fingerprint);
  fingerprintRef.current = fingerprint;
  const docSizeRef = useRef(docSize);
  docSizeRef.current = docSize;

  // ── The file's fingerprint, read again after every load ──────────────────
  useEffect(() => {
    if (!projectId || docVersion < 0) return;
    let live = true;
    void fileMtime(path, scope).then(
      (modified) => {
        const size = docSizeRef.current;
        if (live && size !== null) setFingerprint({ size, modified });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [projectId, path, scope, docVersion]);

  // ── The stored layer, once per file, read while the pane is on screen ────
  useEffect(() => {
    if (!key || !visible || loadedKey === key) return;
    let live = true;
    void loadLayer(key).then((stored) => {
      if (!live) return;
      setScratchLayer(null);
      setNote(null);
      setRound(null);
      setRoundTargetId(null);
      setChanged(false);
      // Nothing to write back until the first change.
      skipSave.current = true;
      if (stored === "unavailable") {
        setStorage("unsaved");
        setHistory(startHistory());
        setStoredFingerprint(null);
      } else if (stored) {
        // Not saved straight back: that would stamp the file's current
        // fingerprint on marks drawn against an older one.
        setStorage("saved");
        // The undo steps the record kept come back too (redo never does).
        setHistory(startHistory(stored.layer, stored.past));
        setStoredFingerprint(stored.fingerprint);
      } else {
        setStorage("saved");
        setHistory(startHistory());
        setStoredFingerprint(null);
      }
      setLoadedKey(key);
    });
    return () => {
      live = false;
    };
  }, [key, visible, loadedKey]);

  // Marks drawn against another version of the file say so until a Reload.
  useEffect(() => {
    if (!loaded || !storedFingerprint || !fingerprint || reloadingRef.current !== false) return;
    if (stale({ layer: history.present, fingerprint: storedFingerprint, saved: 0 }, fingerprint)
      && (!isEmpty(history.present) || hasSent(history.present))) {
      setChanged(true);
    }
  }, [loaded, storedFingerprint, fingerprint, history.present]);

  // ── Saved as each change lands, with the file it was drawn on ────────────
  useEffect(() => {
    if (!loaded || !key) return;
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    pendingSave.current = true;
  }, [history.present, loaded, key]);
  useEffect(() => {
    if (!loaded || !key || !pendingSave.current || !fingerprint) return;
    // Reloading: the marks are saved as they change, and once more with the new
    // file's fingerprint when it has been read — from then on they sit on it.
    const waiting = reloadingRef.current !== false && fingerprint === reloadingRef.current;
    if (reloadingRef.current !== false && !waiting) {
      reloadingRef.current = false;
      setChanged(false);
    }
    pendingSave.current = waiting;
    const layer = history.present;
    const at = fingerprint;
    void saveLayer(key, layer, at, undefined, history.past).then((ok) => {
      setStorage(ok ? "saved" : "unsaved");
      if (ok) setStoredFingerprint(at);
    });
    // `history.past` moves with `present`: no dependency of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history.present, fingerprint, loaded, key]);

  // ── Targets ───────────────────────────────────────────────────────────────
  const tabs = useTabsStore((s) => (projectId ? s.tabsByScope[projectId] : undefined));
  const targets = useMemo(() => (projectId ? agentTargets(projectId, tabs) : []), [projectId, tabs]);
  // The default is fixed when markup comes on (or the chosen tab closes), so
  // looking at another tab meanwhile does not move it under the reader.
  useEffect(() => {
    if (!active) return;
    if (chosen && targets.some((target) => target.scheduleTargetId === chosen)) return;
    const next = defaultTarget(targets)?.scheduleTargetId ?? null;
    if (next !== chosen) setChosen(next);
  }, [active, targets, chosen]);
  const target = targets.find((entry) => entry.scheduleTargetId === chosen) ?? null;
  const targetPty = target?.ptyId ?? null;
  const showTab = useCallback(
    (ptyId: string | null) => {
      if (!projectId || !ptyId?.startsWith(`${projectId}:`)) return;
      useTabsStore.getState().setActive(ptyId.slice(projectId.length + 1));
    },
    [projectId],
  );
  const showTarget = useCallback(() => showTab(targetPty), [showTab, targetPty]);
  /** The tab the round is with — the one the last prompt of the round went to
   *  (the picked tab until one went out); null once it closed. */
  const roundTarget = round && roundTargetId ? targets.find((entry) => entry.scheduleTargetId === roundTargetId) ?? null : target;
  const roundPty = roundTarget?.ptyId ?? null;
  const showRoundTarget = useCallback(() => showTab(roundPty), [showTab, roundPty]);
  const tabAgent = useActivityStore((s) => (target ? agentTabStateOf(s, target.ptyId) : "idle"));
  const roundTabAgent = useActivityStore((s) => (roundTarget ? agentTabStateOf(s, roundTarget.ptyId) : "idle"));
  const modelsByTab = useAgentModelsStore((s) => s.byTab);
  const screenModels = useAgentModelsStore((s) => s.screenByTab);
  const targetTab = target && projectId ? tabs?.find((tab) => `${projectId}:${tab.key}` === target.ptyId) : undefined;
  const roundTab = roundTarget && projectId ? tabs?.find((tab) => `${projectId}:${tab.key}` === roundTarget.ptyId) : undefined;
  /** The target's model as the tab bar says it — the strip's model chip. */
  const targetModelTag = targetTab && projectId ? agentTabModelTag(projectId, targetTab, modelsByTab, screenModels)?.trim() : undefined;
  /** Who the pill says is at work: the round's tab's model by its first word,
   *  as the reader view's working row says it (`Opus is working…`). */
  const roundModelTag = roundTab && projectId ? agentTabModelTag(projectId, roundTab, modelsByTab, screenModels)?.trim() : undefined;
  const targetModel = roundModelTag?.split(/\s+/)[0];

  // ── The agent's questions (`markup_ask`) ─────────────────────────────────
  const targetId = target?.scheduleTargetId ?? null;
  const asksKey = active && projectId && targetId ? `${projectId}\n${targetId}\n${path}` : null;
  const asks = useMemo(() => (listed && listed.key === asksKey ? listed.asks : []), [listed, asksKey]);
  // The project's other agent tabs are asked whether they have an open ask
  // for this file: marking off (todo #2341), every one — the Mark up button
  // then says so and opens the strip on the asking tab; marking, every one
  // but the chosen — the strip names the asking tab and switches to it.
  // Keyed by the ids, not the `targets` object: a relabel or any other tab's
  // change hands the hook a new list, and must not re-read every tab.
  const idleIdList = projectId
    ? targets.flatMap((entry) => (active && entry.scheduleTargetId === targetId ? [] : [entry.scheduleTargetId])).join("\n")
    : "";
  const idleIds = useMemo(() => (idleIdList ? idleIdList.split("\n") : []), [idleIdList]);
  const idleKey = projectId && idleIds.length ? `${projectId}\n${idleIds.join("\n")}\n${path}` : null;
  const [waiting, setWaiting] = useState<{ key: string; target: string | null } | null>(null);
  const listening = asksKey !== null || idleKey !== null || (active && projectId !== null && targets.length > 0);
  useEffect(() => {
    if (!listening) return;
    return subscribeTauri(() => listen(MARKUP_MCP_CHANGED, () => setAsksChanged((n) => n + 1)));
  }, [listening]);
  // Read while the pane is on screen — a change heard while hidden is caught
  // up on show — and never while an answer is on its way: the card it is
  // about stays put until the answer is queued or the ask reopened.
  useEffect(() => {
    if (!asksKey || !projectId || !targetId || !visible || answering) return;
    let live = true;
    const key = asksKey;
    void listMarkupQuestions(projectId, targetId, path).then(
      (rows) => {
        if (live) setListed({ key, asks: rows });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [asksKey, projectId, targetId, path, visible, answering, asksChanged]);
  // The same reads for the other agent tabs, one per tab, on screen only.
  useEffect(() => {
    if (!idleKey || !projectId || !visible) return;
    let live = true;
    const key = idleKey;
    void Promise.all(
      idleIds.map((id) => listMarkupQuestions(projectId, id, path).then((rows) => (rows.length ? id : null), () => null)),
    ).then((found) => {
      if (live) setWaiting({ key, target: found.find((id) => id !== null) ?? null });
    });
    return () => {
      live = false;
    };
  }, [idleKey, idleIds, projectId, path, visible, asksChanged]);
  // The agent's ticks (`markup_done`), read on the asks' triggers while
  // marking — from every agent tab of the project: a round id names one
  // Submit, so a tick finds only that Submit's marks, whichever tab it went to.
  // A backend without the command (a hot-reloaded window over an older one)
  // has no ticks.
  const tickIdList = active && projectId ? targets.map((entry) => entry.scheduleTargetId).join("\n") : "";
  const ticksKey = tickIdList ? `${projectId}\n${tickIdList}\n${path}` : null;
  useEffect(() => {
    if (!ticksKey || !projectId || !visible) return;
    let live = true;
    const key = ticksKey;
    void Promise.all(
      tickIdList.split("\n").map((id) => listMarkupTicks(projectId, id, path).catch((): MarkupTick[] => [])),
    ).then((found) => {
      if (live) setTickList({ key, ticks: found.flat() });
    });
    return () => {
      live = false;
    };
  }, [ticksKey, tickIdList, projectId, path, visible, asksChanged]);
  const ticks = useMemo(() => (tickList && tickList.key === ticksKey ? tickList.ticks : []), [tickList, ticksKey]);
  const ticksRef = useRef(ticks);
  ticksRef.current = ticks;

  /** An agent tab other than the chosen one (any, while marking is off)
   *  with an open ask for this file. */
  const askOther = waiting && waiting.key === idleKey ? waiting.target : null;
  const askWaiting = active ? null : askOther;
  /** Marking for one tab while another asks about this file. */
  const askElsewhere = active && askOther ? targets.find((entry) => entry.scheduleTargetId === askOther) ?? null : null;
  // An open ask is the agent asking: the round's pill says so.
  const chipAgent = asks.length > 0 && tabAgent === "idle" ? "question" : tabAgent;
  const roundAsking = asks.length > 0 && roundTarget?.scheduleTargetId === targetId;
  const agent = roundAsking && roundTabAgent === "idle" ? "question" : roundTabAgent;

  // ── The round: what the agent does with the last Submit ──────────────────
  const layer = scratchLayer ?? history.present;
  const sentShown = hasSent(history.present);
  useEffect(() => {
    if (!round) {
      // Opened again over sent marks: the pill shows once the agent works.
      if (active && sentShown && agent !== "idle") {
        setRoundTargetId(targetId);
        setRound(followRound(agent, Date.now()));
      }
      return;
    }
    const now = Date.now();
    const next = stepRound(round, agent, now);
    if (next !== round) {
      if (next.phase === "finished") setReloaded(false);
      setRound(next);
      return;
    }
    const wait = nextCheck(round, agent, now);
    if (wait === null) return;
    const timer = window.setTimeout(() => setRoundTick((tick) => tick + 1), wait);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [round, agent, active, sentShown, roundTick]);

  // ── The target tab's own dialog ──────────────────────────────────────────
  /** While the round waits on a dialog of the target tab's own (a permission
   *  prompt, the CLI's question picker) and no `markup_ask` card: the tab and
   *  when the wait began. Such a dialog is answered only in the tab — the pill
   *  shows its question line and leads there (`showTarget`). */
  const roundLabel = roundTab ? agentTabLabel(roundTab) : "";
  const dialogWait = active && visible && roundPty && round?.phase === "question" && !roundAsking && roundTabAgent === "question"
    ? `${roundPty}\n${round.since}`
    : null;
  const [tabDialog, setTabDialog] = useState<{ wait: string; line: string } | null>(null);
  useEffect(() => {
    if (!dialogWait || !roundPty) return;
    let live = true;
    const read = () => {
      void readTabDialogLine(roundPty, roundLabel).then(
        (line) => {
          if (live && line) setTabDialog({ wait: dialogWait, line });
        },
        () => {},
      );
    };
    read();
    // The hook's verdict can beat the dialog's bytes to the router: look once
    // more when they have had time to land.
    const again = window.setTimeout(read, DIALOG_REREAD_MS);
    return () => {
      live = false;
      window.clearTimeout(again);
    };
  }, [dialogWait, roundPty, roundLabel]);
  const dialogLine = dialogWait && tabDialog?.wait === dialogWait ? tabDialog.line : undefined;

  const roundRef = useRef(round);
  roundRef.current = round;
  const answerAsk = useCallback(
    async (ask: MarkupAsk, answers: MarkupAnswer[]) => {
      if (!projectId || !target || answering) return false;
      const reason = (error: unknown) => {
        const code = markupErrorCode(error);
        return t(questionReasonKey(code), { code });
      };
      setAnswering(ask.id);
      setAskFailure(null);
      const queued = agentTabStateOf(useActivityStore.getState(), target.ptyId) === "working";
      let prompt: string;
      let receipt: string;
      try {
        ({ prompt, receipt } = await answerMarkupQuestions(projectId, target.scheduleTargetId, ask.id, answers));
      } catch (error) {
        setAskFailure({ text: t("pdfMarkup.questions.answerFailed", { reason: reason(error) }) });
        setAnswering(null);
        return false;
      }
      try {
        const { id } = await queuePromptForTab(projectId, target.scheduleTargetId, prompt);
        holdPhonePrompt(id);
      } catch (error) {
        // Taken but not delivered: open the ask again so the card stays and a
        // retry is not refused as `answered`.
        const why = reason(error);
        try {
          await reopenMarkupQuestions(projectId, target.scheduleTargetId, ask.id, receipt);
          setAskFailure({ text: t("pdfMarkup.questions.queueFailed", { reason: why }) });
        } catch {
          setAskFailure({ text: t("pdfMarkup.questions.queueFailedClosed", { reason: why }), prompt });
        }
        setAnswering(null);
        return false;
      }
      setListed((now) => (now ? { ...now, asks: now.asks.filter((entry) => entry.id !== ask.id) } : now));
      setQuestionFocus(null);
      setReloaded(false);
      setAutoReloaded(false);
      setRoundTargetId(target.scheduleTargetId);
      setRound(startRound(queued, Date.now(), roundRef.current?.applied ?? false, roundRef.current?.undo));
      setAnswering(null);
      return true;
    },
    [projectId, target, answering, t],
  );
  const dismissAsk = useCallback(
    async (ask: MarkupAsk) => {
      if (!projectId || !target || answering) return;
      setAskFailure(null);
      try {
        await dismissMarkupQuestions(projectId, target.scheduleTargetId, ask.id);
      } catch (error) {
        const code = markupErrorCode(error);
        setAskFailure({ text: t("pdfMarkup.questions.dismissFailed", { reason: t(questionReasonKey(code), { code }) }) });
        return;
      }
      setListed((now) => (now ? { ...now, asks: now.asks.filter((entry) => entry.id !== ask.id) } : now));
      setQuestionFocus(null);
    },
    [projectId, target, answering, t],
  );
  const questions: MarkupQuestions = {
    asks,
    answering,
    failure: askFailure,
    dismissFailure: () => setAskFailure(null),
    answer: answerAsk,
    dismiss: dismissAsk,
    focus: questionFocus,
    show: (askId, index, on) =>
      setQuestionFocus((was) => ({ askId, index, on, nonce: (was?.nonce ?? 0) + 1 })),
  };

  // ── Editing ───────────────────────────────────────────────────────────────
  const historyRef = useRef(history);
  historyRef.current = history;
  const add = useCallback((n: number, size: [number, number], mark: Mark) => {
    if (!canAdd(historyRef.current.present, n, mark)) {
      setLimitHit(true);
      return false;
    }
    setLimitHit(false);
    setHistory((now) => commit(now, addMark(now.present, n, size, mark)));
    return true;
  }, []);
  const addAll = useCallback((n: number, size: [number, number], marks: readonly Mark[]) => {
    if (!marks.length) return false;
    if (!canAddAll(historyRef.current.present, n, marks)) {
      setLimitHit(true);
      return false;
    }
    setLimitHit(false);
    setHistory((now) => commit(now, addMarks(now.present, n, size, marks)));
    return true;
  }, []);
  const commitLayer = useCallback((next: Layer) => {
    setScratchLayer(null);
    setHistory((now) => commit(now, next));
  }, []);

  // ── Text runs, read per page as the text-mark tool or a tick's caption
  // needs them; a new load of the file reads them again.
  const [runs, setRuns] = useState<{ doc: PDFDocumentProxy | null; pages: Record<number, TextRun[] | null> }>({ doc: null, pages: {} });
  const runsAsked = useRef<{ doc: PDFDocumentProxy | null; pages: Set<number> }>({ doc: null, pages: new Set() });
  const wantText = useCallback(
    (n: number) => {
      if (!doc || n < 1 || n > doc.numPages) return;
      if (runsAsked.current.doc !== doc) runsAsked.current = { doc, pages: new Set() };
      if (runsAsked.current.pages.has(n)) return;
      runsAsked.current.pages.add(n);
      void pageTextItemBoxes(doc, n)
        .then((read): TextRun[] | null => read, () => null)
        .then((read) => {
          // A read from a document since replaced is dropped.
          if (runsAsked.current.doc !== doc) return;
          setRuns((was) => ({ doc, pages: { ...(was.doc === doc ? was.pages : {}), [n]: read } }));
        });
    },
    [doc],
  );
  const runsOf = useCallback(
    (n: number) => (runs.doc === doc ? runs.pages[n] : undefined),
    [runs, doc],
  );

  // ── The select tool's marks: they stand only on the layer they were picked
  // on — an undo, an erase or a Submit renumbers the marks and drops them.
  const [selected, setSelected] = useState<{ n: number; indices: readonly number[]; layer: Layer } | null>(null);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const selection = useMemo<MarkSelection | null>(
    () =>
      selected && tool === "select" && selected.layer === history.present && selected.indices.length
        ? { n: selected.n, indices: selected.indices }
        : null,
    [selected, tool, history.present],
  );
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const select = useCallback((n: number, indices: readonly number[]) => {
    setCommentDraft(null);
    setSelected(indices.length ? { n, indices, layer: historyRef.current.present } : null);
  }, []);
  const clearSelection = useCallback(() => {
    setCommentDraft(null);
    setSelected(null);
  }, []);
  const commitSelection = useCallback((next: Layer) => {
    setScratchLayer(null);
    setHistory((now) => commit(now, next));
    setSelected((was) => (was ? { ...was, layer: next } : was));
  }, []);
  /** The selection recoloured or restyled — one undo step, still selected. */
  const restyleSelection = useCallback(
    (change: { color?: MarkColor; style?: PenStyle }) => {
      const chosen = selectionRef.current;
      if (!chosen) return;
      const next = restyleMarks(historyRef.current.present, chosen.n, chosen.indices, change);
      if (next !== historyRef.current.present) commitSelection(next);
    },
    [commitSelection],
  );
  const deleteSelection = useCallback(() => {
    const chosen = selectionRef.current;
    if (!chosen) return;
    setCommentDraft(null);
    setSelected(null);
    setHistory((now) => commit(now, removeMarks(now.present, chosen.n, chosen.indices)));
  }, []);
  /** A comment card is open only for one selected ink, box or stamp mark. */
  const comment =
    commentDraft && selection && selection.n === commentDraft.n && selection.indices.length === 1 && selection.indices[0] === commentDraft.index
      ? commentDraft
      : null;
  const single = selection && selection.indices.length === 1 ? history.present.pages[selection.n]?.marks[selection.indices[0]] : undefined;
  /** The one selected mark takes a comment (a note says its own words). */
  const canComment = !!single && single.kind !== "text";
  const openComment = useCallback(() => {
    const chosen = selectionRef.current;
    const mark = chosen && chosen.indices.length === 1 ? historyRef.current.present.pages[chosen.n]?.marks[chosen.indices[0]] : undefined;
    if (!chosen || !mark || mark.kind === "text") return;
    setCommentDraft({ n: chosen.n, index: chosen.indices[0], text: mark.comment ?? "" });
  }, []);
  const saveComment = useCallback(
    (text: string | null) => {
      const draft = commentDraft;
      setCommentDraft(null);
      if (!draft) return;
      const next = setComment(historyRef.current.present, draft.n, draft.index, text);
      if (next !== historyRef.current.present) commitSelection(next);
    },
    [commentDraft, commitSelection],
  );
  /** `text` null deletes the note being edited. */
  const saveNote = useCallback(
    (text: string | null) => {
      const draft = note;
      setNote(null);
      if (!draft) return;
      // Every control character but the line break — the backend refuses them.
      const clean = (text ?? "").replace(/(?!\n)\p{Cc}/gu, "").trim();
      const mark: TextMark | null = clean
        ? { kind: "text", color: draft.color, at: draft.at, size: draft.size, text: clean }
        : null;
      if (draft.index === null) {
        if (mark) add(draft.n, draft.pageSize, mark);
        return;
      }
      if (mark && !canReplace(historyRef.current.present, draft.n, draft.index, mark)) {
        setLimitHit(true);
        return;
      }
      const index = draft.index;
      setHistory((now) => commit(now, replaceMark(now.present, draft.n, index, mark)));
    },
    [note, add],
  );

  const edit: MarkupEdit = {
    layer,
    base: history.present,
    showSent,
    tool,
    color,
    pen,
    busy: sending,
    note,
    add,
    scratch: setScratchLayer,
    commit: commitLayer,
    addAll,
    openNote: setNote,
    editNote: (text) => setNote((draft) => (draft ? { ...draft, text } : draft)),
    editNoteColor: (next) => setNote((draft) => (draft ? { ...draft, color: next } : draft)),
    saveNote,
    cancelNote: () => setNote(null),
    text: runsOf,
    wantText,
    selection,
    select,
    clearSelection,
    commitSelection,
    comment,
    editComment: (text) => setCommentDraft((draft) => (draft ? { ...draft, text } : draft)),
    saveComment,
    cancelComment: () => setCommentDraft(null),
  };

  /** Each tool draws in its own remembered colour (`colorOf`). */
  const setTool = useCallback((next: MarkupTool) => setPen((was) => ({ ...was, tool: next })), []);
  /** A tool's key pressed: arms it, and pressed again on an armed pen steps
   *  its style, on an armed eraser switches between rubbing and the area, on
   *  the text marks steps their mode, on the stamp its symbol. */
  const pressTool = useCallback(
    (next: MarkupTool) =>
      setPen((was) => {
        if (was.tool !== next) return { ...was, tool: next };
        if (next === "ink") return { ...was, style: nextStyle(was.style) };
        if (next === "eraser") return { ...was, eraser: was.eraser === "area" ? "medium" : "area" };
        if (next === "textmark") return { ...was, textMark: TEXT_MARK_MODES[(TEXT_MARK_MODES.indexOf(was.textMark) + 1) % TEXT_MARK_MODES.length] };
        if (next === "stamp") return { ...was, stamp: STAMP_SYMBOLS[(STAMP_SYMBOLS.indexOf(was.stamp) + 1) % STAMP_SYMBOLS.length] };
        return was;
      }),
    [],
  );
  /** A colour picked: the armed tool's — or, with marks selected, theirs. */
  const setColor = useCallback(
    (next: MarkColor) => {
      if (selectionRef.current) restyleSelection({ color: next });
      else setPen((was) => withColor(was, next));
    },
    [restyleSelection],
  );
  const setTextMark = useCallback((mode: TextMarkMode) => setPen((was) => ({ ...was, tool: "textmark", textMark: mode })), []);
  const setStamp = useCallback((symbol: StampSymbol) => setPen((was) => ({ ...was, tool: "stamp", stamp: symbol })), []);
  const setSnap = useCallback((snap: boolean) => setPen((was) => ({ ...was, snap })), []);
  const cyclePressure = useCallback(
    () => setPen((was) => ({ ...was, pressure: PRESSURE_CURVES[(PRESSURE_CURVES.indexOf(was.pressure) + 1) % PRESSURE_CURVES.length] })),
    [],
  );
  /** Preset `i` (0-based) armed, when there is one. */
  const applyPreset = useCallback((i: number) => setPen((was) => (was.presets[i] ? applyPenPreset(was, was.presets[i]) : was)), []);
  const savePreset = useCallback(() => setPen(savePenPreset), []);
  const resetPresets = useCallback(() => setPen(resetPenPresets), []);
  const setStyle = useCallback((style: PenStyle) => setPen((was) => ({ ...was, tool: "ink", style })), []);
  const setSize = useCallback((size: PenSize) => setPen((was) => ({ ...was, size })), []);
  const setEraser = useCallback((eraser: EraserMode) => setPen((was) => ({ ...was, tool: "eraser", eraser })), []);
  const stepSize = useCallback((delta: -1 | 1) => setPen((was) => stepPenSize(was, delta)), []);

  // ── Submit ────────────────────────────────────────────────────────────────
  /** The marked pages a Submit carries: a page past the end of the PDF (it
   *  shrank on a Reload) keeps its marks, but they are not drawn or sent. */
  const marked = markedPages(history.present);
  const sendable = marked.filter((n) => n <= pageCount);
  const leftOut = marked.length - sendable.length;
  /** Sends every marked page. */
  const submit = useCallback(async () => {
    if (!projectId || !target || sending || note) return;
    const reason = (error: unknown) => {
      const code = markupErrorCode(error);
      return t(markupReasonKey(code), { code });
    };
    const present = history.present;
    const pages = markedPages(present).filter((n) => n <= pageCount);
    if (!pages.length) return;
    setSending(true);
    setFailure(null);
    let prompt: string;
    let undo: string | null = null;
    let fellBack: string | null = null;
    const roundId = mintRound();
    /** Per page, the words under each mark at Submit — the round log keeps
     *  them for a ✓ group's before/after caption. */
    const words: Record<number, (string | null)[]> = {};
    try {
      const body: PdfMarkupPage[] = [];
      for (const n of pages) {
        const page = present.pages[n];
        const picture = await markupPagePicture(doc, n, page);
        if (picture.words) words[n] = picture.words;
        body.push({
          n,
          size: page.size,
          marks: page.marks,
          layerPng: await blobBase64(picture.png),
          ...(picture.composed ? { composed: true } : {}),
          ...(picture.anchors.length ? { anchors: picture.anchors } : {}),
        });
      }
      const settings = useSettingsStore.getState().settings;
      const instruction = pdfMarkupInstruction(settings?.pdf_markup_instruction);
      const direct = settings?.pdf_markup_direct ?? true;
      const answer = await submitPdfMarkup(projectId, path, body, instruction, pdfMarkupAsk(settings?.pdf_markup_ask), direct ? "apply" : "list", roundId);
      prompt = answer.prompt;
      // The mode the backend gave the round decides its follow-up — Undo or
      // Make these changes — never the setting.
      undo = answer.mode === "apply" && typeof answer.undo === "string" && answer.undo ? answer.undo : null;
      fellBack = direct && !undo ? answer.noUndo ?? null : null;
      if (settings?.pdf_markup_subagents) prompt = markupForSubagent(prompt);
    } catch (error) {
      setSending(false);
      setFailure(t("pdfMarkup.sendFailed", { reason: reason(error) }));
      return;
    }
    // Read before the prompt goes in: a working agent takes it into its queue.
    const queued = agentTabStateOf(useActivityStore.getState(), target.ptyId) === "working";
    try {
      const { id } = await queuePromptForTab(projectId, target.scheduleTargetId, prompt);
      holdPhonePrompt(id);
    } catch (error) {
      setSending(false);
      setFailure(t("pdfMarkup.queueFailed", { reason: reason(error) }));
      return;
    }
    // The round's marks go to the sent side — dimmed, never sent again, past
    // undo — and marking goes on for the next round. The round is logged with
    // the marks as the request listed them, which the agent's ticks index —
    // unless a page changed meanwhile (drawing waits, but not every path).
    setScratchLayer(null);
    setHistory((now) => {
      const asSent = pages.every((n) => now.present.pages[n]?.marks === present.pages[n].marks);
      return startHistory(markSent(now.present, pages, asSent ? roundId : undefined, words));
    });
    // Only the newest round's undo can run (`holdsUndo`): older ids are dead.
    undoRounds.current.clear();
    if (undo) undoRounds.current.set(undo, roundId);
    setShowSent(true);
    setReloaded(false);
    setAutoReloaded(false);
    setNoUndo(fellBack);
    setUndoNote(null);
    setUndoPreview(null);
    setRoundTargetId(target.scheduleTargetId);
    setRound(startRound(queued, Date.now(), false, undo ? { id: undo, state: "ready" } : undefined));
    setSending(false);
  }, [projectId, target, sending, note, history.present, pageCount, path, doc, t]);

  // An `apply` round's snapshot is settled each time the round finishes — a
  // later turn (an answered question) moves it on, and the last one wins. A
  // failure is quiet: the undo's preview settles again. Not held back in a
  // hidden pane: the after-snapshot must be the agent's finish, and an edit
  // the user makes meanwhile (another pane, an editor) would otherwise land in
  // the round and be undone with it. One call per finish, never a poll.
  const finishedAt = round?.phase === "finished" ? round.since : null;
  const settleId = round?.undo?.state === "ready" ? round.undo.id : null;
  useEffect(() => {
    if (finishedAt === null || !settleId || !projectId) return;
    void settlePdfMarkupUndo(projectId, settleId).catch(() => {});
  }, [finishedAt, settleId, projectId]);

  /** Why an undo call failed, as the strip's line: the files changed since
   *  (nothing was changed), an undo the backend no longer holds (offered no
   *  more), or a plain failure — which may have put some files back. */
  const undoFailed = useCallback(
    (error: unknown, step: "preview" | "undo", id: string) => {
      const failure = pdfMarkupUndoFailure(error);
      if (failure.code === "undo_conflict") {
        const named = failure.files.map((path) => `\`${path}\``).join(", ") || "…";
        const files = failure.more > 0 ? t("mobile.markup.undo.andMore", { files: named, count: failure.more }) : named;
        setUndoNote({ text: t("mobile.markup.undo.conflict", { files }), alert: true });
      } else if (failure.code === "undo_gone" || failure.code === "round_not_found") {
        setRound((was) => was && undoneRound(was, id));
        setUndoNote({ text: t("mobile.markup.undo.gone"), alert: true });
      } else {
        const reasonText = t(markupReasonKey(failure.code), { code: failure.code });
        setUndoNote({
          text: t(step === "preview" ? "mobile.markup.undo.previewFailed" : "mobile.markup.undo.failed", { reason: reasonText }),
          alert: true,
        });
      }
    },
    [t],
  );
  const askUndo = useCallback(async () => {
    const id = roundRef.current?.undo?.id;
    if (!projectId || !id || undoBusyRef.current) return;
    undoBusyRef.current = true;
    setUndoNote(null);
    setUndoBusy(true);
    try {
      const changes = await previewPdfMarkupUndo(projectId, id);
      // Not when a new Submit replaced the round meanwhile.
      if (holdsUndo(roundRef.current, id)) setUndoPreview({ id, changes });
    } catch (error) {
      if (holdsUndo(roundRef.current, id)) undoFailed(error, "preview", id);
    }
    undoBusyRef.current = false;
    setUndoBusy(false);
  }, [projectId, undoFailed]);
  /** The dialog's **Undo**: the files go back and the agent is told — a note
   *  queued as **Make these changes** queues its prompt, not a new round. The
   *  sent marks stay: only the reader removes marks. */
  const confirmUndo = useCallback(async () => {
    const id = undoPreview?.id;
    setUndoPreview(null);
    if (!projectId || !id || undoBusyRef.current) return false;
    undoBusyRef.current = true;
    setUndoBusy(true);
    let done: PdfMarkupUndoChanges;
    try {
      done = await runPdfMarkupUndo(projectId, id);
    } catch (error) {
      undoFailed(error, "undo", id);
      undoBusyRef.current = false;
      setUndoBusy(false);
      return false;
    }
    setRound((was) => was && undoneRound(was, id));
    // Its ticks mean nothing now: the round leaves the log (the marks stay).
    const undoneId = undoRounds.current.get(id);
    if (undoneId) {
      undoRounds.current.delete(id);
      const forget = (entry: Layer) => forgetRound(entry, undoneId);
      setHistory((now) => ({ past: now.past.map(forget), present: forget(now.present), future: now.future.map(forget) }));
    }
    // The files went back, whatever else happened since: the agent is told.
    let told = false;
    if (roundTarget) {
      try {
        const { id: scheduled } = await queuePromptForTab(projectId, roundTarget.scheduleTargetId, markupUndoNote(done.files.map((file) => file.path), done.more));
        holdPhonePrompt(scheduled);
        told = true;
      } catch {
        told = false;
      }
    }
    setUndoNote(told ? { text: t("mobile.markup.undo.done"), alert: false } : { text: t("mobile.markup.undo.noteFailed"), alert: true });
    undoBusyRef.current = false;
    setUndoBusy(false);
    return true;
  }, [projectId, roundTarget, undoPreview, undoFailed, t]);
  const roundUndo: MarkupRoundUndo = {
    offered: canUndo(round) && asks.length === 0,
    busy: undoBusy,
    preview: undoPreview?.changes ?? null,
    ask: askUndo,
    confirm: confirmUndo,
    cancel: () => setUndoPreview(null),
    note: undoNote,
    noUndo: round ? noUndo : null,
  };

  /** **Make these changes**: the agent listed what the marks ask for (the
   *  default instruction edits nothing until told) — one click tells it to go
   *  ahead, worded in Settings → PDF markup (`pdf_markup_apply`). */
  const apply = useCallback(async () => {
    if (!projectId || !roundTarget || sending) return;
    setFailure(null);
    const text = pdfMarkupPrompt(useSettingsStore.getState().settings?.pdf_markup_apply) ?? DEFAULT_PDF_MARKUP_APPLY;
    const queued = agentTabStateOf(useActivityStore.getState(), roundTarget.ptyId) === "working";
    try {
      const { id } = await queuePromptForTab(projectId, roundTarget.scheduleTargetId, text);
      holdPhonePrompt(id);
    } catch (error) {
      const code = markupErrorCode(error);
      setFailure(t("pdfMarkup.applyFailed", { reason: t(markupReasonKey(code), { code }) }));
      return;
    }
    setReloaded(false);
    setAutoReloaded(false);
    // Why the Submit got no undo is past: this round makes the changes.
    setNoUndo(null);
    setRoundTargetId(roundTarget.scheduleTargetId);
    setRound(startRound(queued, Date.now(), true));
  }, [projectId, roundTarget, sending, t]);

  /** About to load the file's new pages under the layer: the sent marks stay
   *  on show so the reader can check the agent's changes against them and
   *  erase them by hand; the record is stamped with the new file once its
   *  fingerprint is read. `auto`: the viewer reloads on its own, not Reload
   *  PDF. */
  const beforeReload = useCallback((auto = false) => {
    setPdfStale(false);
    setReloaded(true);
    setAutoReloaded(auto);
    reloadingRef.current = fingerprintRef.current;
    pendingSave.current = true;
  }, []);

  // ── The agent's ticks: a ✓ on each group of ticked sent marks ───────────
  const ticked = useMemo(
    () => (active && showSent ? tickedMarks(history.present, ticks) : []),
    [active, showSent, history.present, ticks],
  );
  const tickedGroups = useMemo(() => tickGroups(history.present, ticked), [history.present, ticked]);
  // Each ✓ group whose words were logged at Submit is compared with the page
  // as it is now: its text is read for that, on screen only.
  const captionPages = useMemo(() => {
    const out = new Set<number>();
    for (const group of tickedGroups) if (history.present.sent?.log?.some((entry) => entry.words?.[group.page])) out.add(group.page);
    return [...out];
  }, [tickedGroups, history.present]);
  useEffect(() => {
    if (!visible) return;
    for (const n of captionPages) wantText(n);
  }, [visible, captionPages, wantText]);
  const tickCaptions = useMemo(() => {
    const out = new Map<TickGroup, TickCaption>();
    for (const group of tickedGroups) {
      const caption = tickCaption(history.present, group, runsOf(group.page));
      if (caption) out.set(group, caption);
    }
    return out;
  }, [tickedGroups, history.present, runsOf]);
  /** Approves the marks the badge was drawn for, those still on the page and
   *  still ticked in the layer the change lands on — a second click on a gone
   *  badge removes nothing else. */
  const approveTicked = useCallback((page: number, shown: readonly Mark[]) => {
    setHistory((now) => commit(now, approveShown(now.present, ticksRef.current, page, shown)));
  }, []);
  const approveAllTicked = useCallback(() => {
    setHistory((now) => commit(now, approveMarks(now.present, tickedMarks(now.present, ticksRef.current))));
  }, []);
  const tickState: MarkupTicks = { marks: ticked, groups: tickedGroups, captions: tickCaptions, approve: approveTicked, approveAll: approveAllTicked };

  const hasMarks = !isEmpty(history.present) || sentShown;
  return {
    key,
    loaded,
    storage,
    changed,
    edit,
    tool,
    setTool,
    pressTool,
    color,
    setColor,
    pen,
    setStyle,
    setSize,
    setEraser,
    stepSize,
    setTextMark,
    setStamp,
    setSnap,
    cyclePressure,
    applyPreset,
    savePreset,
    resetPresets,
    restyleSelection,
    deleteSelection,
    canComment,
    openComment,
    showSent,
    setShowSent,
    limitHit,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undo: () => setHistory(undoHistory),
    redo: () => setHistory(redoHistory),
    clearPage: (n: number) => setHistory((now) => commit(now, clearLayerPage(now.present, n, showSent))),
    clearSent: () => setHistory((now) => commit(now, clearLayerSent(now.present))),
    /** Every page's marks at once — one step, so Undo brings them all back. */
    clearAll: () => setHistory((now) => commit(now, clearLayerAll(now.present, showSent))),
    canClearAll: !isEmpty(history.present) || (showSent && hasSent(history.present)),
    /** **Make these changes** fits: the agent is done with a Submit's marks
     *  and asks nothing more. */
    canApply: roundTarget !== null && canApply(round) && asks.length === 0,
    apply,
    roundUndo,
    hasUnsent: !isEmpty(history.present),
    sentShown,
    /** Marks are on the file, or a round is out: a new version waits for Reload. */
    holdsReload: active && (hasMarks || round !== null),
    targets,
    target,
    /** The target's tab entry, for its model chip (`PdfMarkupModel`). */
    targetTab,
    targetModelTag,
    /** The tab the round is with — the picked one until a round goes out. */
    roundTarget,
    targetModel,
    chooseTarget: setChosen,
    /** Bring the target agent tab to the front; the tab's prompt strip leads
     *  back here while a round is on (`stores/viewers/markupLinks`). */
    showTarget,
    /** The same for the tab the round is with. */
    showRoundTarget,
    /** The target tab waits on a dialog of its own: the question line it
     *  shows, once read (`readTabDialogLine`); null while it waits on none. */
    tabDialog: dialogWait ? { line: dialogLine } : null,
    agent,
    /** The picked tab's state, for its model chip. */
    chipAgent,
    questions,
    ticks: tickState,
    askWaiting,
    askElsewhere,
    round,
    reloaded,
    autoReloaded,
    stale: pdfStale,
    markStale: () => setPdfStale(true),
    clearStale: () => setPdfStale(false),
    beforeReload,
    sending,
    failure,
    dismissFailure: () => setFailure(null),
    sendable,
    leftOut,
    submit,
  };
}

export type PdfMarkup = ReturnType<typeof usePdfMarkup>;
