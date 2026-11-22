import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { speechChunks } from "../../../shared/voice";
import { createNavMode, type NavContext, type NavLine, type NavMode, type NavModePorts, type NavOutcome, type NavSpeechWait } from "../../../shared/voiceNavMode";
import { loadDict, translate, type Language, type TranslationKey } from "../../lib/i18n";
import { playChime } from "../../lib/voice/chime";
import { SPEAK_LIMITS, VOICE_EVENTS, voiceSpeak, voiceSpeakStop, type SpeakingEvent } from "../../lib/voice/desktopVoice";
import {
  agentTabChoice, isAgentTab, isNavScope, leaveDesktopLanding, navLists, navQueue, scopeAgentTab, tabAtNumber, type NavQueueKind,
} from "../../lib/voice/desktopNav";
import { type VoiceCommand, type VoiceLists } from "../../lib/voice/voiceCommands";
import { afterStatusJump, nextStatusTab, shownStatusTab, type StatusTab } from "../../lib/shortcuts/statusJump";
import { jumpToTab } from "../../lib/shortcuts/tabJump";
import { readerAgent, readerOffered, rememberedReader } from "../../lib/agents/agentReader";
import { readerViewFor } from "../../lib/agents/readerSteering";
import { subscribeTauri } from "../../hooks/useTauriListener";
import { useActivityStore } from "../../stores/activity";
import { useAgentReaderStore } from "../../stores/agents/agentReader";
import { agentTabLabel } from "../../stores/agents/agentModels";
import { BOX_SCOPE_PREFIX, useBoxesStore } from "../../stores/boxes";
import { isDetachedWindow } from "../../stores/detachedContext";
import { useKeyboardSteeringStore } from "../../stores/keyboardSteering";
import { restoreProjectScope, useProjectsStore } from "../../stores/projects";
import { rootViewShown, useRootOverlayStore } from "../../stores/rootOverlay";
import { orderedTabKeys, useTabsStore, type TabEntry } from "../../stores/tabs";

/** A spoken line that never reports its end stops holding the mode after
 * this long once it started, plus a little per character. */
const SPEAK_GUARD_MS = 4_000;
/** A line queued behind other reads (a long answer) that never starts. */
const SPEAK_START_GUARD_MS = 60_000;
const SPEAK_GUARD_PER_CHAR_MS = 90;
/** A chunk the voice says whole (read-aloud's size). */
const SPEAK_CHUNK = 300;

/** How a line is spoken: read-aloud's voice settings. */
export interface ReaderSpeech {
  /** The voice's language tag. */
  lang: string;
  rate: number;
  natural: boolean;
}

/**
 * Says `text` as read `id` (`voice_speak`, after what is being said) and runs
 * `done` once that read is over — its `voice:speaking` `done`, `stopped` or
 * `failed`, which come after the backend's mic mute tail — or once a guard
 * timer runs out, so a voice that never reports its end cannot hold anything
 * up. The guard is long until the read starts (it may wait behind an answer
 * being read) and fits the line once it has. `finish` runs `done` now;
 * `cancel` drops it.
 */
export function speakThenWait(id: string, text: string, speech: ReaderSpeech, done: () => void): NavSpeechWait {
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    window.clearTimeout(guard);
    off();
  };
  const finish = () => {
    if (over) return;
    end();
    done();
  };
  const off = subscribeTauri(() => listen<SpeakingEvent>(VOICE_EVENTS.speaking, ({ payload }) => {
    if (payload.readId !== id || over) return;
    if (payload.state !== "started") {
      finish();
      return;
    }
    window.clearTimeout(guard);
    guard = window.setTimeout(finish, SPEAK_GUARD_MS + text.length * SPEAK_GUARD_PER_CHAR_MS);
  }));
  let guard = window.setTimeout(finish, SPEAK_START_GUARD_MS);
  const chunks = speechChunks(text, SPEAK_CHUNK).slice(0, SPEAK_LIMITS.chunks);
  const rate = Math.min(SPEAK_LIMITS.rate.max, Math.max(SPEAK_LIMITS.rate.min, speech.rate));
  if (chunks.length === 0) queueMicrotask(finish);
  else void voiceSpeak(id, chunks, speech.lang, rate, false, speech.natural).catch(() => finish());
  return { finish, cancel: end };
}

/** Whether `tab` would show its Chat: what its pane says, when it is on
 * screen and registered; else its CLI's Chat/Terminal choice, where the
 * Chat is offered. */
export function tabHasChat(scope: string, tab: TabEntry): boolean {
  const pane = readerViewFor(`${scope}:${tab.key}`);
  if (pane) return pane.view() === "chat";
  if (!readerOffered(tab)) return false;
  const agent = readerAgent(tab);
  return useAgentReaderStore.getState().byAgent[agent] ?? rememberedReader(agent);
}

/** The popout `tab` lives in, if one: the jump raises that window. */
function popoutOf(scope: string, key: string): string | null {
  const groups = useTabsStore.getState().detachedGroupsByScope[scope] ?? [];
  return groups.find((entry) => orderedTabKeys(entry.subtree).includes(key))?.label ?? null;
}

/** A scope's name as a line says it: the project's or the box's. */
function scopeName(scope: string): string {
  if (scope.startsWith(BOX_SCOPE_PREFIX)) return useBoxesStore.getState().boxes.find((b) => `${BOX_SCOPE_PREFIX}${b.id}` === scope)?.name ?? scope;
  return useProjectsStore.getState().projects.find((p) => p.id === scope)?.name ?? scope;
}

/** Brings a project or box up with nothing in particular in front. */
async function openScope(scope: string): Promise<void> {
  if (scope.startsWith(BOX_SCOPE_PREFIX)) await useBoxesStore.getState().openBox(scope.slice(BOX_SCOPE_PREFIX.length));
  else await useProjectsStore.getState().setActive(scope);
}

/** Opens `target` and writes the Back key's record, as a status key's jump
 * does (`useSteering`'s `goToTab`); `from` is the tab left, when the scope
 * already switched before. Returns where the tab lives. */
function jumpWithBack(target: StatusTab, from: StatusTab | null = shownStatusTab()): string {
  const steering = useKeyboardSteeringStore.getState();
  steering.setJumpBack(afterStatusJump(steering.jumpBack, from, target));
  if (rootViewShown(useRootOverlayStore.getState())) useRootOverlayStore.getState().close();
  return jumpToTab(target.scope, target.key);
}

interface NavData {
  lists: VoiceLists;
}

/** What "project …" / "box …" asked back about. */
interface NavScopeTarget {
  scope: string;
  name: string;
}

type Ctx = NavContext<NavScopeTarget>;

/**
 * Spoken navigation in the desktop Chat's mic (docs/desktop_tabby_navigate_plan.md
 * step 5): the desktop's adapter of the shared mode (`shared/voiceNavMode.ts`).
 * Its lists are the stores' (projects, boxes, the shown scope's tabs and
 * agents); its queues are steering's status walk; a jump is `jumpToTab` with
 * the Back key's record, and leaves a note for the Chat it lands in
 * (`useReaderVoiceLanding`) after this tab's session was dropped. Its lines are
 * said through `voice_speak` under the tab's read id while the mic stays open:
 * the backend throws captured audio away while it speaks.
 *
 * Main window only: in a popout "{assistant} navigate" shows that it is not
 * here, and a jump to a tab in a popout raises that window, says where, and
 * listens nowhere.
 */
export function useReaderVoiceNav({ scope, tabKey, ptyId, lang, speech, handsFree, guardReset, sessionOn, startMic, dropSession }: {
  scope: string;
  tabKey: string;
  ptyId: string;
  /** The language commands are heard and lines said in. */
  lang: () => Language;
  speech: () => ReaderSpeech | null;
  /** Hands-free is on: what a landing does (read, then listen gated). */
  handsFree: () => boolean;
  /** The send guard drops a pause or window running. */
  guardReset: () => void;
  /** A session is running (listening, or starting). */
  sessionOn: () => boolean;
  /** Starts the mic as a click would. */
  startMic: () => void;
  /** Ends this tab's session at once (a jump leaves it). */
  dropSession: () => void;
}) {
  const [line, setLine] = useState<NavLine | null>(null);
  const [open, setOpen] = useState(false);
  const live = useRef({ scope, tabKey, ptyId });
  live.current = { scope, tabKey, ptyId };
  const tr = (key: TranslationKey, params?: Record<string, string | number>) => translate(lang(), key, params);

  const where = (target: string, tab: TabEntry) => tr("voice.nav.landed", { agent: isAgentTab(tab) ? agentTabLabel(tab) : tab.label, project: scopeName(target) });

  /** What going to `tab` in `target` comes to: this tab is said and left
   * alone; a tab with a Chat in this window is jumped to and gets the note;
   * one in a popout, or with no Chat, is said first and nothing listens there. */
  const goTo = (target: string, tab: TabEntry): NavOutcome<NavScopeTarget> => {
    const here = live.current;
    const said = where(target, tab);
    if (target === here.scope && tab.key === here.tabKey) return { say: said, then: "leave" };
    const to = { scope: target, key: tab.key };
    if (popoutOf(target, tab.key) !== null || !tabHasChat(target, tab)) {
      return { say: said, then: (nav) => { nav.exit(); dropSession(); jumpWithBack(to); } };
    }
    return {
      jump: () => {
        leaveDesktopLanding({ ptyId: `${target}:${tab.key}`, handsFree: handsFree(), where: said });
        dropSession();
        jumpWithBack(to);
      },
    };
  };

  const queueJump = (kind: NavQueueKind, ctx: Ctx) => {
    const nothing: Record<NavQueueKind, TranslationKey> = {
      waiting: "voice.nav.nothingWaiting", working: "voice.nav.nothingWorking", done: "voice.nav.nothingDone",
    };
    const activity = useActivityStore.getState();
    const tabsByScope = useTabsStore.getState().tabsByScope;
    const queue = navQueue(kind, activity.busyByTab, activity.attentionByTab, tabsByScope, tabHasChat);
    const here = { scope: live.current.scope, key: live.current.tabKey };
    const next = nextStatusTab(queue, shownStatusTab() ?? here, 1);
    const tab = next && !(next.scope === here.scope && next.key === here.key)
      ? (tabsByScope[next.scope] ?? []).find((entry) => entry.key === next.key) : undefined;
    ctx.apply(next && tab ? goTo(next.scope, tab) : { say: tr(nothing[kind]) });
  };

  const resolve = (command: VoiceCommand, _found: NavData, ctx: Ctx) => {
    const here = live.current.scope;
    const tabs = isNavScope(here) ? useTabsStore.getState().tabsByScope[here] ?? [] : [];
    const activity = useActivityStore.getState();
    const place = (tab: TabEntry | undefined) => ctx.apply(tab ? goTo(here, tab) : { say: tr("voice.nav.noSuchTab") });
    switch (command.id) {
      case "openProject":
        ctx.apply({ confirm: { scope: command.args.project.id, name: command.args.project.name }, say: tr("voice.nav.project", { name: command.args.project.name }) });
        return;
      case "openBox":
        ctx.apply({ confirm: { scope: command.args.box.id, name: command.args.box.name }, say: tr("voice.nav.box", { name: command.args.box.name }) });
        return;
      case "nextWaiting": queueJump("waiting", ctx); return;
      case "nextWorking": queueJump("working", ctx); return;
      case "nextDone": queueJump("done", ctx); return;
      case "goToTab": place(tabs.find((tab) => tab.key === command.args.tab.id)); return;
      case "tabNumber": place(tabAtNumber(tabs, command.args.n)); return;
      case "agentTab":
        place(agentTabChoice(here, tabs, command.args.agent.name, agentTabLabel, activity.lastWorkingByTab, activity.lastDoneByTab, command.args.n));
        return;
      default: ctx.apply({ say: tr("voice.nav.notYet") });
    }
  };

  /** "Project Alpha?" — yes: its agent tab with the latest activity. A
   * project not restored this session is restored first; a box's tabs come
   * with opening it, so a box not yet open is opened and landed in after. */
  const confirmed = async (target: NavScopeTarget, _found: NavData, ctx: Ctx) => {
    const project = useProjectsStore.getState().projects.find((p) => p.id === target.scope);
    if (project) await restoreProjectScope(project).catch(() => {});
    if (ctx.stale()) return;
    const known = useTabsStore.getState().tabsByScope[target.scope];
    const activity = useActivityStore.getState();
    const pick = (tabs: TabEntry[]) => scopeAgentTab(target.scope, tabs, activity.lastWorkingByTab, activity.lastDoneByTab);
    if (!known && target.scope.startsWith(BOX_SCOPE_PREFIX)) {
      ctx.apply({
        jump: () => {
          const from = shownStatusTab();
          const how = speech();
          const ptyIdLeft = live.current.ptyId;
          dropSession();
          void openScope(target.scope).then(() => {
            const tab = pick(useTabsStore.getState().tabsByScope[target.scope] ?? []);
            if (!tab) {
              // The box is up; there is nothing in it to listen in.
              if (how) speakThenWait(`${ptyIdLeft}#nav:box`, tr("voice.nav.noAgentTab", { name: target.name }), how, () => {});
              return;
            }
            if (tabHasChat(target.scope, tab) && popoutOf(target.scope, tab.key) === null) {
              leaveDesktopLanding({ ptyId: `${target.scope}:${tab.key}`, handsFree: handsFree(), where: where(target.scope, tab) });
            }
            jumpWithBack({ scope: target.scope, key: tab.key }, from);
          }, () => {});
        },
      });
      return;
    }
    const tab = pick(known ?? []);
    if (tab) {
      ctx.apply(goTo(target.scope, tab));
      return;
    }
    // Nothing to listen in: the scope comes up, the mode and the mic end.
    ctx.apply({
      say: tr("voice.nav.noAgentTab", { name: target.name }),
      then: (nav) => {
        nav.exit();
        dropSession();
        void openScope(target.scope).catch(() => {});
      },
    });
  };

  const ports = useRef<NavModePorts<NavData, NavScopeTarget> | null>(null);
  ports.current = {
    lang,
    timers: { set: (run, ms) => window.setTimeout(run, ms), clear: (id) => window.clearTimeout(id) },
    showLine: setLine,
    chime: playChime,
    speechOutput: () => speech() !== null,
    speak: (text, n, done) => {
      const how = speech();
      if (!how) {
        queueMicrotask(done);
        return { finish: () => {}, cancel: () => {} };
      }
      return speakThenWait(`${live.current.ptyId}#nav:${n}`, text, how, done);
    },
    stopSpeaking: () => void voiceSpeakStop().catch(() => {}),
    onOpen: (next) => {
      if (next) guardReset();
      setOpen(next);
    },
    canOpen: () => !isDetachedWindow(),
    notHere: "voice.nav.mainOnly",
    // The mic stays open while a line is said; it is opened again only if it ended.
    listen: () => { if (!sessionOn()) startMic(); },
    leaveToDictation: () => { if (!sessionOn()) startMic(); },
    // A pause running before a send must not send the draft while the help is said.
    dictationHelp: () => {
      guardReset();
      return () => { if (!sessionOn()) startMic(); };
    },
    help: { untested: "terminal.reader.voice.help" },
    load: async () => {
      await loadDict(lang()).catch(() => false);
      const here = live.current.scope;
      const tabs = useTabsStore.getState().tabsByScope[here] ?? [];
      const projects = useProjectsStore.getState().projects.filter((p) => p.status === "active");
      return { lists: navLists(projects, useBoxesStore.getState().boxes, here, tabs, agentTabLabel) };
    },
    resolve,
    confirmed,
  };
  const nav = useRef<NavMode | null>(null);
  nav.current ??= createNavMode(() => ports.current!);
  const mode = nav.current;

  // The mode belongs to the tab it opened in.
  useEffect(() => () => {
    mode.dispose();
    setOpen(false);
    setLine(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey]);

  return { mode, line, open };
}
