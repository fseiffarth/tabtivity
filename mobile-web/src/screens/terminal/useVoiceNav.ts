// Spoken navigation (docs/voice_nav_mode_plan.md), inside the Focus screen's
// open mic while Hands-free is on: "{assistant} navigate" opens a mode in which
// each settled utterance is a command — go to a project (asked back first), to
// the working / done / waiting tab across projects, to a tab by name or number
// — and the phone says where it is going, half-duplex: the mic closes while it
// speaks and opens again a moment after the voice falls quiet.
//
// The utterance layer (`voiceInput.ts`, N1) hands every settled utterance to
// `utterances.take`; this hook is what fills it. While the mode is open it sets
// `utterances.capture`, so nothing heard is typed. A jump unmounts this screen
// (App keys it by tab), so the jump leaves a note for the next one
// (`voiceNav.ts`, `useVoiceLanding.ts`).
// Everything here reads refs, so the continuations of a spoken line (which
// outlive the render that started them) never act on stale state.
import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { loadDict, translate, type TranslationKey } from "../../../../src/lib/i18n";
import { playChime } from "../../../../src/lib/voice/chime";
import {
  didNotCatchLine, ambiguityLine, match, matchConfirm, matchNavLeave, matchNavigate, matchStartWord, resolveAmbiguity,
  type VoiceAmbiguity, type VoiceCommand, type VoiceListItem, type VoiceLists, type VoiceMatch,
} from "../../../../src/lib/voice/voiceCommands";
import { api, getActivity, type ProjectDetail, type ProjectRow, type TabRow } from "../../api";
import { speechLanguage, speechTag } from "../../speechLang";
import { currentSpeechId, speak, speechOutputSupported, stopSpeaking, subscribeSpeech } from "../../speechOutput";
import { markDoneSeen, readSeenDone } from "../../seenDone";
import {
  agentTabChoice, detailLists, latestAgentTab, leaveLanding, navQueue, nextInQueue, noteJump, projectItems, tabAtNumber,
  type NavQueueKind,
} from "../../voiceNav";
import { type SendGuard } from "../../../../shared/handsFree";
import { type DictationSession } from "../../voiceSession";
import { type TabbyGate } from "./useTabbyGate";
import { type StartVoiceOptions, type UtteranceHooks } from "./useVoiceInput";

/** No utterance for this long, with the mic open and the phone quiet: the mode
 * closes. */
export const NAV_IDLE_MS = 10_000;
/** The desktop plan's tail: the mic opens this long after the voice is quiet. */
export const NAV_TAIL_MS = 300;
/** How long "Navigation closed" stays on the voice line. */
const CLOSED_LINE_MS = 3_000;

/** The voice line while the mode is open or a landing is read. */
export interface NavLine {
  text: string;
  /** A tap: stops the voice and opens the mic now. */
  run?: () => void;
}

export interface VoiceNav {
  line: NavLine | null;
  /** A tap on the mic or a stop: the mode ends, nothing else. True when it was open. */
  end(): boolean;
}

type Mode =
  | { kind: "off" }
  | { kind: "open" }
  /** "Project Alpha?" was asked; the next utterance answers it. */
  | { kind: "confirm"; project: VoiceListItem }
  /** Two names were too close; the next utterance picks one. */
  | { kind: "pick"; ambiguity: VoiceAmbiguity };

/** What the mode reads off the phone's own routes, once, when it opens. */
interface NavData {
  lists: VoiceLists;
  detail: ProjectDetail | null;
}

type Next = "listen" | (() => void);

export function useVoiceNav({
  tab, project, openTab, openProject, setOpen, utterances, tabbyGate, handsFreeOn, guard, voiceOpen, recognition,
  endDictation, startVoiceRef,
}: {
  tab: TabRow;
  /** The project this tab belongs to (the current project's tabs are the ones
   * "tab two" and "Claude tab" mean). */
  project: string | undefined;
  openTab?: (tab: TabRow, opts?: { project?: string }) => void;
  openProject?: (id: string) => void;
  /** Whether the mode is open, as the screen's state: hands-free defers its
   * reopen of the mic to it (`useHandsFree`'s `navOpen`). */
  setOpen: Dispatch<SetStateAction<boolean>>;
  utterances: UtteranceHooks;
  tabbyGate: TabbyGate;
  /** Hands-free is on: navigation exists only there. */
  handsFreeOn: MutableRefObject<boolean>;
  guard: () => SendGuard;
  voiceOpen: MutableRefObject<boolean>;
  recognition: MutableRefObject<DictationSession | undefined>;
  endDictation: () => void;
  startVoiceRef: MutableRefObject<(options?: StartVoiceOptions) => Promise<void>>;
}): VoiceNav {
  const [line, setLine] = useState<NavLine | null>(null);
  const mode = useRef<Mode>({ kind: "off" });
  /** Bumped when the mode opens or ends: what was in flight for the last one stops. */
  const epoch = useRef(0);
  /** Bumped by each spoken line: only the newest line's continuation runs. */
  const turn = useRef(0);
  const idle = useRef(0);
  /** The quiet timer is running (the mic is open and the phone is not speaking). */
  const idleArmed = useRef(false);
  const flashTimer = useRef(0);
  const data = useRef<Promise<NavData> | null>(null);
  /** Commands run one at a time, in the order they were heard. */
  const chain = useRef<Promise<void>>(Promise.resolve());
  /** The wait for the voice to fall quiet: `finish` skips it, `cancel` drops it. */
  const wait = useRef<{ finish(): void; cancel(): void } | null>(null);
  // The latest of everything a long-lived continuation reads.
  const live = useRef({ tab, project, openTab, openProject });
  live.current = { tab, project, openTab, openProject };

  const lang = () => speechLanguage(speechTag());
  const tr = (key: TranslationKey, params?: Record<string, string | number>) => translate(lang(), key, params);

  /** A function, so that no narrowing of `mode.current` outlives an `await`. */
  const isOff = () => mode.current.kind === "off";
  const clearIdle = () => {
    window.clearTimeout(idle.current);
    idleArmed.current = false;
  };
  const armIdle = () => {
    clearIdle();
    if (mode.current.kind === "off") return;
    const mine = epoch.current;
    idleArmed.current = true;
    idle.current = window.setTimeout(() => {
      idleArmed.current = false;
      if (epoch.current === mine) leave();
    }, NAV_IDLE_MS);
  };
  // Words being said are not quiet: a command begun just inside the ten seconds
  // must not be cut off by them before it has settled and been handled.
  utterances.activity.current = () => { if (idleArmed.current) armIdle(); };
  /** The mode is over (no mic change): what is in flight stops, the screen goes back to dictating. */
  const exit = () => {
    epoch.current += 1;
    turn.current += 1;
    clearIdle();
    wait.current?.cancel();
    wait.current = null;
    data.current = null;
    mode.current = { kind: "off" };
    utterances.capture.current = false;
    setOpen(false);
    setLine(null);
  };
  const flash = (text: string) => {
    setLine({ text });
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setLine(null), CLOSED_LINE_MS);
  };
  /** Leaves the mode and goes back to dictation, the Tabby gate on: the mic is
   * open (an utterance, the idle timer) or is opened. */
  const leave = (closedLine = true) => {
    const micOpen = recognition.current !== undefined;
    exit();
    if (closedLine) flash(tr("voice.nav.closed"));
    if (micOpen) tabbyGate.set(true);
    else void startVoiceRef.current({ gate: true });
  };

  /** The mic opens again for the next utterance. */
  const listenAgain = () => {
    if (mode.current.kind === "off") return;
    void startVoiceRef.current({});
    armIdle();
  };
  /** Says `text` (always, read-aloud on or off) with the mic closed, then
   * `next`; with no speech output the line is only shown and `next` runs now. */
  const say = (text: string, next: Next) => {
    const mine = ++turn.current;
    const mineEpoch = epoch.current;
    clearIdle();
    const proceed = () => {
      if (turn.current !== mine || epoch.current !== mineEpoch) return;
      wait.current = null;
      if (next === "listen") listenAgain();
      else next();
    };
    const skip = () => { stopSpeaking(); wait.current?.finish(); };
    setLine({ text, run: skip });
    if (!speechOutputSupported()) {
      proceed();
      return;
    }
    // Not inside the utterance layer's own call: it still has a step to hand back.
    queueMicrotask(() => {
      if (turn.current !== mine || epoch.current !== mineEpoch) return;
      if (recognition.current !== undefined) endDictation();
      speak(`nav:${mine}`, text, speechTag(), true);
      let timer = 0;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        off();
        window.clearTimeout(timer);
        proceed();
      };
      const check = () => {
        window.clearTimeout(timer);
        if (currentSpeechId() === null) timer = window.setTimeout(finish, NAV_TAIL_MS);
      };
      const off = subscribeSpeech(check);
      wait.current = {
        finish,
        cancel: () => { done = true; off(); window.clearTimeout(timer); },
      };
      check();
    });
  };

  /** The lists the matcher resolves names against: the projects, and this
   * project's tabs and agents. Opaque ids from rows the phone already reads. */
  const load = (): Promise<NavData> => {
    data.current ??= (async () => {
      const here = live.current.project;
      const [rows, detail] = await Promise.all([
        api<{ projects: ProjectRow[] }>("/api/v1/projects?view=active").then((body) => body.projects, () => [] as ProjectRow[]),
        here ? api<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(here)}`).catch(() => null) : Promise.resolve(null),
        // The lines and the command phrases are said and heard in the spoken language.
        loadDict(lang()),
      ]);
      const own = detail && Array.isArray(detail.tabs) ? detailLists({ tabs: detail.tabs, agents: Array.isArray(detail.agents) ? detail.agents : [] }) : { tabs: [], agents: [] };
      return { lists: { projects: projectItems(Array.isArray(rows) ? rows : []), ...own }, detail };
    })();
    return data.current;
  };

  /** Opens `row`, in `projectId`: the screen is replaced, so the note for the
   * next one (what to read) is left first. */
  const goTo = (row: TabRow, projectId: string, projectLabel: string) => {
    const agent = row.agent_label ?? row.label;
    const where = tr("voice.nav.landed", { agent, project: projectLabel });
    if (!row.available) {
      say(tr("voice.nav.unavailable", { name: row.label }), "listen");
      return;
    }
    if (row.id === live.current.tab.id) {
      say(where, () => leave(false));
      return;
    }
    if (row.agent_status === "done") markDoneSeen(row.id, row.done_at);
    if (row.kind === "agent") leaveLanding({ tabId: row.id, where });
    exit();
    live.current.openTab?.(row, { project: projectId });
  };

  const openProjectTab = async (item: VoiceListItem, mineEpoch: number) => {
    let detail: ProjectDetail;
    try {
      detail = await api<ProjectDetail>(`/api/v1/projects/${encodeURIComponent(item.id)}`);
    } catch {
      if (epoch.current === mineEpoch) say(tr("voice.nav.desktopDown"), "listen");
      return;
    }
    if (epoch.current !== mineEpoch) return;
    const row = latestAgentTab(Array.isArray(detail.tabs) ? detail.tabs : []);
    if (row) {
      goTo(row, item.id, item.name);
      return;
    }
    // The project screen has no mic: the line is said first.
    say(tr("voice.nav.noAgentTab", { name: item.name }), () => {
      const opener = live.current.openProject;
      if (!opener) {
        listenAgain();
        return;
      }
      exit();
      opener(item.id);
    });
  };

  const queueJump = async (kind: NavQueueKind, mineEpoch: number) => {
    const nothing: Record<NavQueueKind, TranslationKey> = {
      waiting: "voice.nav.nothingWaiting", working: "voice.nav.nothingWorking", done: "voice.nav.nothingDone",
    };
    let body;
    try {
      body = await getActivity();
    } catch {
      body = null;
    }
    if (epoch.current !== mineEpoch) return;
    if (!body || body.desktop_available === false) {
      say(tr("voice.nav.desktopDown"), "listen");
      return;
    }
    const queue = navQueue(kind, Array.isArray(body.tabs) ? body.tabs : [], readSeenDone());
    const next = nextInQueue(kind, queue, live.current.tab.id);
    if (!next) {
      say(tr(nothing[kind]), "listen");
      return;
    }
    if (kind !== "done") noteJump(kind, next.id);
    goTo(next, next.project_id, next.project_label);
  };

  const run = async (command: VoiceCommand, found: NavData, mineEpoch: number) => {
    const detail = found.detail;
    const here = live.current.project;
    const place = (row: TabRow | undefined) => {
      if (!row || !here || !detail) say(tr("voice.nav.noSuchTab"), "listen");
      else goTo(row, here, detail.project.label);
    };
    switch (command.id) {
      case "openProject":
        mode.current = { kind: "confirm", project: command.args.project };
        say(tr("voice.nav.project", { name: command.args.project.name }), "listen");
        return;
      case "nextWaiting": await queueJump("waiting", mineEpoch); return;
      case "nextWorking": await queueJump("working", mineEpoch); return;
      case "nextDone": await queueJump("done", mineEpoch); return;
      case "goToTab": place(detail?.tabs.find((row) => row.id === command.args.tab.id)); return;
      case "tabNumber": place(detail ? tabAtNumber(detail.tabs, command.args.n) : undefined); return;
      case "agentTab": place(detail ? agentTabChoice(detail.tabs, command.args.agent.name, command.args.n) : undefined); return;
      default: say(tr("voice.nav.notYet"), "listen");
    }
  };

  const dispatch = async (result: VoiceMatch, found: NavData, mineEpoch: number) => {
    if (result.kind === "command") await run(result, found, mineEpoch);
    else if (result.kind === "ambiguous") {
      mode.current = { kind: "pick", ambiguity: result };
      say(ambiguityLine(lang(), result.candidates), "listen");
    } else say(didNotCatchLine(lang()), "listen");
  };

  /** One settled utterance, heard in the mode. */
  const handle = async (heard: string) => {
    const mineEpoch = epoch.current;
    if (isOff()) return;
    clearIdle();
    const l = lang();
    // "{assistant} navigate …" said again, or the start word before a command.
    const again = matchNavigate(heard, l);
    const start = again ?? matchStartWord(heard, l);
    const said = (start ? start.rest : heard).trim();
    if (!said) {
      armIdle();
      return;
    }
    if (matchNavLeave(said, l)) {
      leave();
      return;
    }
    const found = await load();
    if (epoch.current !== mineEpoch || isOff()) return;
    const asked = mode.current;
    mode.current = { kind: "open" };
    if (asked.kind === "confirm") {
      const answer = matchConfirm(said, l);
      if (answer === "yes") {
        await openProjectTab(asked.project, mineEpoch);
        return;
      }
      if (answer === "no") {
        setLine({ text: tr("mobile.voice.navOpen") });
        armIdle();
        return;
      }
    } else if (asked.kind === "pick") {
      const resolved = resolveAmbiguity(said, asked.ambiguity, l);
      if (resolved) {
        await run(resolved, found, mineEpoch);
        return;
      }
    }
    await dispatch(match(said, l, found.lists, { requireCommandWord: false }), found, mineEpoch);
  };
  const queue = (heard: string) => {
    chain.current = chain.current.then(() => handle(heard)).catch(() => {});
  };

  /** "{assistant} navigate" heard: the mode opens, the hands-free send guard
   * drops its window, and every utterance from here is a command. */
  const enter = () => {
    epoch.current += 1;
    turn.current += 1;
    window.clearTimeout(flashTimer.current);
    mode.current = { kind: "open" };
    utterances.capture.current = true;
    guard().reset();
    voiceOpen.current = false;
    setOpen(true);
    setLine({ text: tr("mobile.voice.navOpen") });
    playChime();
    void load();
    armIdle();
  };

  /** A held utterance settled (`UtteranceHooks.take`). True when navigation took it. */
  const route = (text: string): boolean => {
    if (mode.current.kind !== "off") {
      queue(text);
      return true;
    }
    if (!handsFreeOn.current) return false;
    const opened = matchNavigate(text, lang());
    if (!opened) return false;
    enter();
    if (opened.rest) queue(opened.rest);
    return true;
  };
  utterances.take.current = route;

  // The mode belongs to the screen it opened on.
  useEffect(() => () => {
    epoch.current += 1;
    turn.current += 1;
    window.clearTimeout(idle.current);
    window.clearTimeout(flashTimer.current);
    wait.current?.cancel();
    wait.current = null;
    mode.current = { kind: "off" };
    utterances.capture.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  return {
    line,
    end: () => {
      if (mode.current.kind === "off") return false;
      exit();
      return true;
    },
  };
}
