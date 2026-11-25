// Spoken navigation (docs/done/voice_nav_mode_plan.md), inside the Focus screen's
// open mic, hands-free or not: "{assistant} navigate" opens a mode in which
// each settled utterance is a command — go to a project (asked back first), to
// the working / done / waiting tab across projects, to a tab by name or number
// — and the phone says where it is going, half-duplex: the mic closes while it
// speaks and opens again a moment after the voice falls quiet.
//
// The utterance layer (`voiceInput.ts`, N1) hands every settled utterance to
// `utterances.take`; this hook is what fills it. While the mode is open it sets
// `utterances.capture`, so nothing heard is typed. "{assistant} help" (and
// "help" alone in the mode) says what can be said there, with the mic closed.
// A jump unmounts this screen
// (App keys it by tab), so the jump leaves a note for the next one
// (`voiceNav.ts`, `useVoiceLanding.ts`).
// The mode itself (the order of checks, the question asked back, the idle
// timer, the epochs) is the shared controller (`shared/voiceNavMode.ts`, the
// desktop Chat drives it too); this is the phone's adapter: its lists, its
// jumps and its half-duplex voice. The ports are rebuilt every render and the
// controller reads the latest, so the continuations of a spoken line (which
// outlive the render that started them) never act on stale state.
import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { loadDict, translate, type TranslationKey } from "../../../../src/lib/i18n";
import { playChime } from "../../../../src/lib/voice/chime";
import { type VoiceCommand, type VoiceListItem, type VoiceLists } from "../../../../src/lib/voice/voiceCommands";
import { createNavMode, NAV_TAIL_MS, type NavContext, type NavLine, type NavMode, type NavModePorts, type NavOutcome } from "../../../../shared/voiceNavMode";
import { api, getActivity, getProjectDetail, type ProjectDetail, type ProjectRow, type TabRow } from "../../api";
import { speechLanguage, speechTag } from "../../speechLang";
import { speak, speechOutputSupported, stopSpeaking, whenSpeechQuiet } from "../../speechOutput";
import { markDoneSeen, readSeenDone } from "../../seenDone";
import {
  agentTabChoice, detailLists, latestAgentTab, leaveLanding, navQueue, nextInQueue, noteJump, projectItems, tabAtNumber,
  type NavQueueKind,
} from "../../voiceNav";
import { type SendGuard } from "../../../../shared/handsFree";
import { type DictationSession } from "../../voiceSession";
import { type TabbyGate } from "./useTabbyGate";
import { type StartVoiceOptions, type UtteranceHooks } from "./useVoiceInput";

export { NAV_IDLE_MS, NAV_TAIL_MS, type NavLine } from "../../../../shared/voiceNavMode";

export interface VoiceNav {
  line: NavLine | null;
  /** A tap on the mic or a stop: the mode ends, nothing else. True when it was open. */
  end(): boolean;
}

/** What the mode reads off the phone's own routes, once, when it opens. */
interface NavData {
  lists: VoiceLists;
  detail: ProjectDetail | null;
}

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
  /** Hands-free is on: its send guard and the Tabby gate are in play. */
  handsFreeOn: MutableRefObject<boolean>;
  guard: () => SendGuard;
  voiceOpen: MutableRefObject<boolean>;
  recognition: MutableRefObject<DictationSession | undefined>;
  endDictation: () => void;
  startVoiceRef: MutableRefObject<(options?: StartVoiceOptions) => Promise<void>>;
}): VoiceNav {
  const [line, setLine] = useState<NavLine | null>(null);
  // The latest of everything a long-lived continuation reads.
  const live = useRef({ tab, project, openTab, openProject });
  live.current = { tab, project, openTab, openProject };

  const lang = () => speechLanguage(speechTag());
  const tr = (key: TranslationKey, params?: Record<string, string | number>) => translate(lang(), key, params);

  /** The lists the matcher resolves names against: the projects, and this
   * project's tabs and agents. Opaque ids from rows the phone already reads. */
  const load = async (): Promise<NavData> => {
    const here = live.current.project;
    const [rows, detail] = await Promise.all([
      api<{ projects: ProjectRow[] }>("/api/v1/projects?view=active").then((body) => body.projects, () => [] as ProjectRow[]),
      here ? getProjectDetail(here).catch(() => null) : Promise.resolve(null),
      // The lines and the command phrases are said and heard in the spoken language.
      loadDict(lang()),
    ]);
    const own = detail && Array.isArray(detail.tabs) ? detailLists({ tabs: detail.tabs, agents: Array.isArray(detail.agents) ? detail.agents : [] }) : { tabs: [], agents: [] };
    return { lists: { projects: projectItems(Array.isArray(rows) ? rows : []), ...own }, detail };
  };

  /** Opens `row`, in `projectId`: the screen is replaced, so the note for the
   * next one (what to read) is left first. */
  const goTo = (row: TabRow, projectId: string, projectLabel: string): NavOutcome<VoiceListItem> => {
    const agent = row.agent_label ?? row.label;
    const where = tr("voice.nav.landed", { agent, project: projectLabel });
    if (!row.available) return { say: tr("voice.nav.unavailable", { name: row.label }) };
    if (row.id === live.current.tab.id) return { say: where, then: "leave" };
    return {
      jump: () => {
        if (row.agent_status === "done") markDoneSeen(row.id, row.done_at);
        if (row.kind === "agent") leaveLanding({ tabId: row.id, where });
        live.current.openTab?.(row, { project: projectId });
      },
    };
  };

  type Ctx = NavContext<VoiceListItem>;

  const openProjectTab = async (item: VoiceListItem, ctx: Ctx) => {
    let detail: ProjectDetail;
    try {
      detail = await getProjectDetail(item.id);
    } catch {
      if (!ctx.stale()) ctx.apply({ say: tr("voice.nav.desktopDown") });
      return;
    }
    if (ctx.stale()) return;
    const row = latestAgentTab(Array.isArray(detail.tabs) ? detail.tabs : []);
    if (row) {
      ctx.apply(goTo(row, item.id, item.name));
      return;
    }
    // The project screen has no mic: the line is said first.
    ctx.apply({
      say: tr("voice.nav.noAgentTab", { name: item.name }),
      then: (nav) => {
        const opener = live.current.openProject;
        if (!opener) {
          nav.listen();
          return;
        }
        nav.exit();
        opener(item.id);
      },
    });
  };

  const queueJump = async (kind: NavQueueKind, ctx: Ctx) => {
    const nothing: Record<NavQueueKind, TranslationKey> = {
      waiting: "voice.nav.nothingWaiting", working: "voice.nav.nothingWorking", done: "voice.nav.nothingDone",
    };
    let body;
    try {
      body = await getActivity();
    } catch {
      body = null;
    }
    if (ctx.stale()) return;
    if (!body || body.desktop_available === false) {
      ctx.apply({ say: tr("voice.nav.desktopDown") });
      return;
    }
    const queue = navQueue(kind, Array.isArray(body.tabs) ? body.tabs : [], readSeenDone());
    const next = nextInQueue(kind, queue, live.current.tab.id);
    if (!next) {
      ctx.apply({ say: tr(nothing[kind]) });
      return;
    }
    if (kind !== "done") noteJump(kind, next.id);
    ctx.apply(goTo(next, next.project_id, next.project_label));
  };

  const resolve = async (command: VoiceCommand, found: NavData, ctx: Ctx) => {
    const detail = found.detail;
    const here = live.current.project;
    const place = (row: TabRow | undefined) =>
      ctx.apply(!row || !here || !detail ? { say: tr("voice.nav.noSuchTab") } : goTo(row, here, detail.project.label));
    switch (command.id) {
      case "openProject":
        ctx.apply({ confirm: command.args.project, say: tr("voice.nav.project", { name: command.args.project.name }) });
        return;
      case "nextWaiting": await queueJump("waiting", ctx); return;
      case "nextWorking": await queueJump("working", ctx); return;
      case "nextDone": await queueJump("done", ctx); return;
      case "goToTab": place(detail?.tabs.find((row) => row.id === command.args.tab.id)); return;
      case "tabNumber": place(detail ? tabAtNumber(detail.tabs, command.args.n) : undefined); return;
      case "agentTab": place(detail ? agentTabChoice(detail.tabs, command.args.agent.name, command.args.n) : undefined); return;
      default: ctx.apply({ say: tr("voice.nav.notYet") });
    }
  };

  const ports = useRef<NavModePorts<NavData, VoiceListItem> | null>(null);
  ports.current = {
    lang,
    timers: { set: (run, ms) => window.setTimeout(run, ms), clear: (id) => window.clearTimeout(id) },
    showLine: setLine,
    chime: playChime,
    speechOutput: speechOutputSupported,
    // Half-duplex: the mic closes while the phone speaks.
    speak: (text, n, done) => {
      if (recognition.current !== undefined) endDictation();
      speak(`nav:${n}`, text, speechTag(), true);
      // Guarded: a voice that never ends must not keep the mic closed for good.
      return whenSpeechQuiet(NAV_TAIL_MS, done);
    },
    stopSpeaking,
    onOpen: (open) => {
      utterances.capture.current = open;
      if (open) {
        // The hands-free send guard drops its window.
        if (handsFreeOn.current) guard().reset();
        voiceOpen.current = false;
      }
      setOpen(open);
    },
    listen: () => void startVoiceRef.current({}),
    // Hands-free goes back to waiting for "Tabby …"; a plain mic to dictating.
    leaveToDictation: () => {
      const gate = handsFreeOn.current;
      if (recognition.current !== undefined) tabbyGate.set(gate);
      else void startVoiceRef.current({ gate });
    },
    // The help is said with the mic closed (it would hear it). Hands-free: a
    // pause running before a send must not send the draft while the help is
    // said; the next words count it again.
    dictationHelp: () => {
      const gate = handsFreeOn.current && tabbyGate.on.current;
      if (handsFreeOn.current) guard().reset();
      voiceOpen.current = false;
      return () => void startVoiceRef.current({ gate });
    },
    help: { untested: "mobile.voice.help" },
    load,
    resolve,
    confirmed: (item, _found, ctx) => openProjectTab(item, ctx),
  };
  const nav = useRef<NavMode | null>(null);
  nav.current ??= createNavMode(() => ports.current!);
  const mode = nav.current;

  // Words being said are not quiet: a command begun just inside the ten seconds
  // must not be cut off by them before it has settled and been handled.
  utterances.activity.current = () => mode.activity();
  utterances.take.current = (text) => mode.route(text);

  // The mode belongs to the screen it opened on.
  useEffect(() => () => {
    mode.dispose();
    utterances.capture.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  return { line, end: () => mode.end() };
}
