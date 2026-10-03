/**
 * The desktop PDF viewer's markup mode — its layer, storage, Submit and pill
 * (`docs/pdf_markup_rounds_plan.md` §2.6). The marks are the phone's own
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
 * The agent's markup questions (`markup_ask`, `docs/markup_questions_mcp_plan.md`
 * P2) are listed here too: the target tab's open ask for this file, re-read on
 * `markup-mcp-changed` while the pane is on screen and once more when it shows
 * again. An answer goes out the Submit's way; when it cannot be queued the ask
 * is reopened with the answer's receipt, so the card stays and a retry works.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { fileMtime } from "../fileAccess";
import { useT } from "../../../lib/i18n";
import { holdPhonePrompt } from "../../../lib/agents/phoneHolds";
import {
  blobBase64,
  DEFAULT_PDF_MARKUP_APPLY,
  markupErrorCode,
  markupReasonKey,
  pdfMarkupPrompt,
  submitPdfMarkup,
  type PdfMarkupPage,
} from "../../../lib/viewers/pdfMarkup";
import {
  answerMarkupQuestions,
  dismissMarkupQuestions,
  listMarkupQuestions,
  MARKUP_MCP_CHANGED,
  questionReasonKey,
  reopenMarkupQuestions,
  type MarkupAnswer,
  type MarkupAsk,
} from "../../../lib/viewers/markupQuestions";
import { useSettingsStore } from "../../../stores/settings";
import { agentTabStateOf, lastTabReadAt, useActivityStore } from "../../../stores/activity";
import { queuePromptForTab } from "../../../stores/agents/agentPrompts";
import { useTabsStore, type TabEntry } from "../../../stores/tabs";
import {
  addMark,
  canAdd,
  canReplace,
  clearPage as clearLayerPage,
  clearSent as clearLayerSent,
  commit,
  hasSent,
  isEmpty,
  markedPages,
  markSent,
  redo as redoHistory,
  replaceMark,
  startHistory,
  undo as undoHistory,
  type History,
  type Layer,
  type Mark,
  type MarkColor,
  type TextMark,
} from "../../../../mobile-web/src/markup/layer";
import { layerPng } from "../../../../mobile-web/src/markup/rasterize";
import { layerKey, loadLayer, saveLayer, stale, type Fingerprint } from "../../../../mobile-web/src/markup/store";
import {
  canApply,
  followRound,
  nextCheck,
  startRound,
  stepRound,
  type Round,
} from "../../../../mobile-web/src/markup/submitState";

export type MarkupTool = "ink" | "box" | "text" | "eraser";

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

/** The layer's undo history and the strokes in flight on top of it. */
export type MarkupEdit = {
  /** What is drawn: a gesture's scratch layer while one is in flight. */
  layer: Layer;
  /** The committed layer gestures build on. */
  base: Layer;
  showSent: boolean;
  tool: MarkupTool;
  color: MarkColor;
  /** A Submit is uploading: drawing waits. */
  busy: boolean;
  note: NoteDraft | null;
  /** Adds a finished mark; `false` when the layer is at the backend's ceiling. */
  add: (n: number, size: [number, number], mark: Mark) => boolean;
  scratch: (next: Layer | null) => void;
  commit: (next: Layer) => void;
  openNote: (draft: NoteDraft) => void;
  editNote: (text: string) => void;
  saveNote: (text: string | null) => void;
  cancelNote: () => void;
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
  const [tool, setToolState] = useState<MarkupTool>("ink");
  const [color, setColor] = useState<MarkColor>("red");
  const [showSent, setShowSent] = useState(true);
  const [note, setNote] = useState<NoteDraft | null>(null);
  const [limitHit, setLimitHit] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [round, setRound] = useState<Round | null>(null);
  const [roundTick, setRoundTick] = useState(0);
  /** The file changed on disk and its new pages wait for Reload. */
  const [pdfStale, setPdfStale] = useState(false);
  /** Reloaded since the agent last finished: Reload steps back to secondary. */
  const [reloaded, setReloaded] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  /** The target's open asks, with the target and file they were listed for. */
  const [listed, setListed] = useState<{ key: string; asks: MarkupAsk[] } | null>(null);
  const [asksChanged, setAsksChanged] = useState(0);
  const [answering, setAnswering] = useState<string | null>(null);
  const [askFailure, setAskFailure] = useState<MarkupQuestions["failure"]>(null);
  const [questionFocus, setQuestionFocus] = useState<QuestionFocus | null>(null);

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
        setHistory(startHistory(stored.layer));
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
    void saveLayer(key, layer, at).then((ok) => {
      setStorage(ok ? "saved" : "unsaved");
      if (ok) setStoredFingerprint(at);
    });
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
  const tabAgent = useActivityStore((s) => (target ? agentTabStateOf(s, target.ptyId) : "idle"));

  // ── The agent's questions (`markup_ask`) ─────────────────────────────────
  const asksKey = active && projectId && target ? `${projectId}\n${target.scheduleTargetId}\n${path}` : null;
  const asks = useMemo(() => (listed && listed.key === asksKey ? listed.asks : []), [listed, asksKey]);
  const listening = asksKey !== null;
  useEffect(() => {
    if (!listening) return;
    let live = true;
    let unlisten: (() => void) | null = null;
    void listen(MARKUP_MCP_CHANGED, () => setAsksChanged((n) => n + 1)).then(
      (stop) => {
        if (live) unlisten = stop;
        else stop();
      },
      () => {},
    );
    return () => {
      live = false;
      unlisten?.();
    };
  }, [listening]);
  // Read while the pane is on screen — a change heard while hidden is caught
  // up on show — and never while an answer is on its way: the card it is
  // about stays put until the answer is queued or the ask reopened.
  useEffect(() => {
    if (!asksKey || !projectId || !target || !visible || answering) return;
    let live = true;
    const key = asksKey;
    void listMarkupQuestions(projectId, target.scheduleTargetId, path).then(
      (rows) => {
        if (live) setListed({ key, asks: rows });
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [asksKey, projectId, target, path, visible, answering, asksChanged]);
  // An open ask is the agent asking: the round's pill says so.
  const agent = asks.length > 0 && tabAgent === "idle" ? "question" : tabAgent;

  // ── The round: what the agent does with the last Submit ──────────────────
  const layer = scratchLayer ?? history.present;
  const sentShown = hasSent(history.present);
  useEffect(() => {
    if (!round) {
      // Opened again over sent marks: the pill shows once the agent works.
      if (active && sentShown && agent !== "idle") setRound(followRound(agent, Date.now()));
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
  }, [round, agent, active, sentShown, roundTick]);

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
      setRound(startRound(queued, Date.now(), roundRef.current?.applied ?? false));
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
  const commitLayer = useCallback((next: Layer) => {
    setScratchLayer(null);
    setHistory((now) => commit(now, next));
  }, []);
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
    busy: sending,
    note,
    add,
    scratch: setScratchLayer,
    commit: commitLayer,
    openNote: setNote,
    editNote: (text) => setNote((draft) => (draft ? { ...draft, text } : draft)),
    saveNote,
    cancelNote: () => setNote(null),
  };

  const setTool = useCallback((next: MarkupTool) => {
    setToolState(next);
    setColor((was) => (next === "box" && was !== "yellow" ? "yellow" : next === "ink" && was === "yellow" ? "red" : was));
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────
  /** The marked pages a Submit carries: a page past the end of the PDF (it
   *  shrank on a Reload) keeps its marks, but they are not drawn or sent. */
  const marked = markedPages(history.present);
  const sendable = marked.filter((n) => n <= pageCount);
  const leftOut = marked.length - sendable.length;

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
    try {
      const body: PdfMarkupPage[] = [];
      for (const n of pages) {
        const page = present.pages[n];
        body.push({ n, size: page.size, marks: page.marks, layerPng: await blobBase64(await layerPng(page)) });
      }
      const instruction = pdfMarkupPrompt(useSettingsStore.getState().settings?.pdf_markup_instruction);
      prompt = (await submitPdfMarkup(projectId, path, body, instruction)).prompt;
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
    // undo — and marking goes on for the next round.
    setScratchLayer(null);
    setHistory((now) => startHistory(markSent(now.present, pages)));
    setShowSent(true);
    setReloaded(false);
    setRound(startRound(queued, Date.now()));
    setSending(false);
  }, [projectId, target, sending, note, history.present, pageCount, path, t]);

  /** **Make these changes**: the agent listed what the marks ask for (the
   *  default instruction edits nothing until told) — one click tells it to go
   *  ahead, worded in Settings → PDF markup (`pdf_markup_apply`). */
  const apply = useCallback(async () => {
    if (!projectId || !target || sending) return;
    setFailure(null);
    const text = pdfMarkupPrompt(useSettingsStore.getState().settings?.pdf_markup_apply) ?? DEFAULT_PDF_MARKUP_APPLY;
    const queued = agentTabStateOf(useActivityStore.getState(), target.ptyId) === "working";
    try {
      const { id } = await queuePromptForTab(projectId, target.scheduleTargetId, text);
      holdPhonePrompt(id);
    } catch (error) {
      const code = markupErrorCode(error);
      setFailure(t("pdfMarkup.applyFailed", { reason: t(markupReasonKey(code), { code }) }));
      return;
    }
    setReloaded(false);
    setRound(startRound(queued, Date.now(), true));
  }, [projectId, target, sending, t]);

  /** About to load the file's new pages under the layer: the sent marks stay
   *  on show so the reader can check the agent's changes against them and
   *  erase them by hand; the record is stamped with the new file once its
   *  fingerprint is read. */
  const beforeReload = useCallback(() => {
    setPdfStale(false);
    setReloaded(true);
    reloadingRef.current = fingerprintRef.current;
    pendingSave.current = true;
  }, []);

  const hasMarks = !isEmpty(history.present) || sentShown;
  return {
    key,
    loaded,
    storage,
    changed,
    edit,
    tool,
    setTool,
    color,
    setColor,
    showSent,
    setShowSent,
    limitHit,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    undo: () => setHistory(undoHistory),
    redo: () => setHistory(redoHistory),
    clearPage: (n: number) => setHistory((now) => commit(now, clearLayerPage(now.present, n, showSent))),
    clearSent: () => setHistory((now) => commit(now, clearLayerSent(now.present))),
    /** **Make these changes** fits: the agent is done with a Submit's marks
     *  and asks nothing more. */
    canApply: target !== null && canApply(round) && asks.length === 0,
    apply,
    hasUnsent: !isEmpty(history.present),
    sentShown,
    /** Marks are on the file, or a round is out: a new version waits for Reload. */
    holdsReload: active && (hasMarks || round !== null),
    targets,
    target,
    chooseTarget: setChosen,
    agent,
    questions,
    round,
    reloaded,
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
