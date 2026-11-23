// Spoken navigation's mode, host-free (docs/desktop_tabby_navigate_plan.md
// step 1): "{assistant} navigate" opens it, and from then on each utterance is
// a command — go to a project or a box (asked back first), to the working /
// done / waiting tab, to a tab by name or number — until a jump, "stop" or ten
// quiet seconds end it. The phone's Focus screen (`useVoiceNav.ts`) and the
// desktop Chat (`useReaderVoiceNav.ts`) drive the one controller through ports:
// how a line is spoken and when it has fallen quiet, how the mic is opened
// again, what the lists are and what a command does there.
//
// The controller owns the order of checks for an utterance in the mode, the
// question it asked (a project, a pick between two names), the idle timer, and
// the epoch and turn counters: an epoch is one opening of the mode, a turn one
// spoken line, so a continuation that outlived either does nothing.
import { translate, type Language, type TranslationKey } from "../src/lib/i18n";
import {
  ambiguityLine, didNotCatchLine, match, matchConfirm, matchHelp, matchNavLeave, matchNavigate, matchStartWord, resolveAmbiguity,
  type VoiceAmbiguity, type VoiceCommand, type VoiceLists, type VoiceMatch,
} from "../src/lib/voice/voiceCommands";

/** No utterance for this long, with the mic open and the voice quiet: the mode
 * closes. */
export const NAV_IDLE_MS = 10_000;
/** The mic opens this long after the voice is quiet. */
export const NAV_TAIL_MS = 300;
/** How long "Navigation closed" (and "works in the main window") stays on the voice line. */
export const NAV_CLOSED_LINE_MS = 3_000;
/** How long the dictation help stays on the voice line once it was said. */
export const NAV_HELP_LINE_MS = 12_000;

/** The voice line while the mode is open or a landing is read. */
export interface NavLine {
  text: string;
  /** A tap: stops the voice and goes on now. */
  run?: () => void;
  /** The register row its untested mark stands for (`src/lib/untested.ts`),
   * when not the mode's own. */
  untested?: string;
}

/** A wait for a spoken line to fall quiet: `finish` skips it, `cancel` drops it. */
export interface NavSpeechWait {
  finish(): void;
  cancel(): void;
}

/** What the controller may do in a command's continuation. */
export interface NavActions {
  /** The mode is over (no mic change). */
  exit(): void;
  /** The mic opens again for the next command. */
  listen(): void;
  /** Back to dictation; `closedLine`: "Navigation closed" is shown. */
  leave(closedLine?: boolean): void;
}

/** What a command came to, decided by the host:
 * - `say`: a line, then `then` (default: listen for the next command; "leave":
 *   back to dictation with no closed line; a function: anything else);
 * - `confirm`: ask `say` back; a yes hands `confirm` to `confirmed`;
 * - `jump`: the mode ends, then `jump` runs;
 * - `null`: nothing (the host found the mode moved on meanwhile). */
export type NavOutcome<T> =
  | null
  | { say: string; then?: "listen" | "leave" | ((nav: NavActions) => void) }
  | { confirm: T; say: string }
  | { jump: () => void };

/** A host's view of one command: `stale()` turns true once the mode it was
 * heard in is over (a host checks it after its own awaits); `apply` hands
 * back what the command came to — at once, in the tick the host decided it,
 * so a line is said no later than the host's own await allows. Ignored once
 * stale. */
export interface NavContext<T> {
  stale(): boolean;
  apply(outcome: NavOutcome<T>): void;
}

export interface NavTimers {
  set(run: () => void, ms: number): number;
  clear(id: number): void;
}

export interface NavModePorts<D extends { lists: VoiceLists }, T> {
  /** The language the lines are said and the commands heard in. */
  lang(): Language;
  timers: NavTimers;
  showLine(line: NavLine | null): void;
  chime(): void;
  /** Whether a line can be spoken at all; without, it is only shown. */
  speechOutput(): boolean;
  /** Speaks `text` as line `turn`; `done` runs once the voice has fallen quiet
   * (guarded by the host: a voice that never reports its end must not stall). */
  speak(text: string, turn: number, done: () => void): NavSpeechWait;
  stopSpeaking(): void;
  /** The mode opened (true) or ended (false): the host stops typing what is
   * heard, or goes back to it. */
  onOpen(open: boolean): void;
  /** May the mode open here? False: `notHere` is shown instead (the desktop's
   * popout). */
  canOpen?(): boolean;
  notHere?: TranslationKey;
  /** The mic opens again for the next command (the phone closes it to speak). */
  listen(): void;
  /** The mode left: the host goes back to dictation (its mic open, or opened). */
  leaveToDictation(): void;
  /** "{assistant} help" while dictating is about to be said: the host gets
   * ready and returns what resumes dictation afterwards. */
  dictationHelp(): () => void;
  /** The help lines' register row (`src/lib/untested.ts`), spelled
   * `untested: "<id>"` so the register's audit finds it. */
  help: { untested: string };
  /** What the matcher resolves names against, read once per opening. */
  load(): Promise<D>;
  /** A command was heard: the host decides what it comes to (`ctx.apply`). */
  resolve(command: VoiceCommand, data: D, ctx: NavContext<T>): void | Promise<void>;
  /** The ask-back (`confirm`) was answered yes. */
  confirmed(target: T, data: D, ctx: NavContext<T>): void | Promise<void>;
}

type Mode<T> =
  | { kind: "off" }
  | { kind: "open" }
  /** "Project Alpha?" was asked; the next utterance answers it. */
  | { kind: "confirm"; target: T }
  /** Two names were too close; the next utterance picks one. */
  | { kind: "pick"; ambiguity: VoiceAmbiguity };

type Next = "listen" | (() => void);

export interface NavMode {
  /** An utterance settled while dictating. True when navigation took it. */
  route(text: string): boolean;
  /** Whether the mode is open. */
  isOpen(): boolean;
  /** Words are being said: the quiet timer starts again. */
  activity(): void;
  /** A tap on the mic or a stop: the mode ends, nothing else. True when it was open. */
  end(): boolean;
  /** The host goes away: nothing in flight runs, no state is touched. */
  dispose(): void;
}

export function createNavMode<D extends { lists: VoiceLists }, T>(portsOf: () => NavModePorts<D, T>): NavMode {
  const p = () => portsOf();
  let mode: Mode<T> = { kind: "off" };
  /** Bumped when the mode opens or ends: what was in flight for the last one stops. */
  let epoch = 0;
  /** Bumped by each spoken line: only the newest line's continuation runs. */
  let turn = 0;
  let idle = 0;
  /** The quiet timer is running (the mic is open and the voice is quiet). */
  let idleArmed = false;
  let flashTimer = 0;
  let data: Promise<D> | null = null;
  /** Commands run one at a time, in the order they were heard. */
  let chain: Promise<void> = Promise.resolve();
  let wait: NavSpeechWait | null = null;
  let shown: NavLine | null = null;

  const lang = () => p().lang();
  const tr = (key: TranslationKey, params?: Record<string, string | number>) => translate(lang(), key, params);
  const show = (line: NavLine | null) => {
    shown = line;
    p().showLine(line);
  };
  /** A function, so that no narrowing of `mode` outlives an `await`. */
  const isOff = () => mode.kind === "off";

  const clearIdle = () => {
    p().timers.clear(idle);
    idleArmed = false;
  };
  const armIdle = () => {
    clearIdle();
    if (isOff()) return;
    const mine = epoch;
    idleArmed = true;
    idle = p().timers.set(() => {
      idleArmed = false;
      if (epoch === mine) leave();
    }, NAV_IDLE_MS);
  };
  const exit = () => {
    epoch += 1;
    turn += 1;
    clearIdle();
    wait?.cancel();
    wait = null;
    data = null;
    mode = { kind: "off" };
    p().onOpen(false);
    show(null);
  };
  const flash = (line: NavLine, ms = NAV_CLOSED_LINE_MS) => {
    show(line);
    p().timers.clear(flashTimer);
    flashTimer = p().timers.set(() => {
      if (shown === line) show(null);
    }, ms);
  };
  /** Leaves the mode and goes back to dictation. */
  const leave = (closedLine = true) => {
    exit();
    if (closedLine) flash({ text: tr("voice.nav.closed") });
    p().leaveToDictation();
  };
  const listenAgain = () => {
    if (isOff()) return;
    p().listen();
    armIdle();
  };
  const actions: NavActions = { exit, listen: listenAgain, leave };

  /** Says `text` (always, read-aloud on or off), then `next`; with no speech
   * output the line is only shown and `next` runs now. */
  const say = (text: string, next: Next, untested?: string) => {
    const mine = ++turn;
    const mineEpoch = epoch;
    clearIdle();
    const proceed = () => {
      if (turn !== mine || epoch !== mineEpoch) return;
      wait = null;
      if (next === "listen") listenAgain();
      else next();
    };
    const skip = () => { p().stopSpeaking(); wait?.finish(); };
    p().timers.clear(flashTimer);
    show({ text, run: skip, untested });
    if (!p().speechOutput()) {
      proceed();
      return;
    }
    // Not inside the host's own call: it may still have a step to finish.
    queueMicrotask(() => {
      if (turn !== mine || epoch !== mineEpoch) return;
      wait = p().speak(text, mine, proceed);
    });
  };

  const load = (): Promise<D> => {
    data ??= p().load();
    return data;
  };

  const apply = (outcome: NavOutcome<T>, mineEpoch: number) => {
    if (!outcome || epoch !== mineEpoch) return;
    if ("jump" in outcome) {
      exit();
      outcome.jump();
      return;
    }
    if ("confirm" in outcome) {
      mode = { kind: "confirm", target: outcome.confirm };
      say(outcome.say, "listen");
      return;
    }
    const then = outcome.then ?? "listen";
    say(outcome.say, then === "listen" ? "listen" : then === "leave" ? () => leave(false) : () => then(actions));
  };
  const ctxFor = (mineEpoch: number): NavContext<T> => ({
    stale: () => epoch !== mineEpoch,
    apply: (outcome) => apply(outcome, mineEpoch),
  });

  const run = async (command: VoiceCommand, found: D, mineEpoch: number) => {
    await p().resolve(command, found, ctxFor(mineEpoch));
  };
  const dispatch = async (result: VoiceMatch, found: D, mineEpoch: number) => {
    if (result.kind === "command") await run(result, found, mineEpoch);
    else if (result.kind === "ambiguous") {
      mode = { kind: "pick", ambiguity: result };
      say(ambiguityLine(lang(), result.candidates), "listen");
    } else say(didNotCatchLine(lang()), "listen");
  };

  /** One utterance, heard in the mode. */
  const handle = async (heard: string) => {
    const mineEpoch = epoch;
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
    // "help" asks what the mode takes; a question it had asked stays open.
    if (matchHelp(said, l, { bare: true })) {
      say(tr("voice.help.nav"), "listen", p().help.untested);
      return;
    }
    const found = await load();
    if (epoch !== mineEpoch || isOff()) return;
    const asked = mode;
    mode = { kind: "open" };
    if (asked.kind === "confirm") {
      const answer = matchConfirm(said, l);
      if (answer === "yes") {
        await p().confirmed(asked.target, found, ctxFor(mineEpoch));
        return;
      }
      if (answer === "no") {
        show({ text: tr("voice.nav.open") });
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
    chain = chain.then(() => handle(heard)).catch(() => {});
  };

  /** "{assistant} navigate" heard: every utterance from here is a command. */
  const enter = () => {
    epoch += 1;
    turn += 1;
    p().timers.clear(flashTimer);
    mode = { kind: "open" };
    p().onOpen(true);
    show({ text: tr("voice.nav.open") });
    p().chime();
    void load();
    armIdle();
  };

  /** "{assistant} help" while dictating: the commands a draft takes are said,
   * stay on the voice line a while (a tap hides them), and dictation goes on. */
  const helpDictation = () => {
    const resume = p().dictationHelp();
    const untested = p().help.untested;
    say(tr("voice.help.dictation"), () => {
      const line: NavLine = { text: tr("voice.help.dictation"), untested, run: () => show(null) };
      flash(line, NAV_HELP_LINE_MS);
      resume();
    }, untested);
  };

  return {
    route(text) {
      if (!isOff()) {
        queue(text);
        return true;
      }
      if (matchHelp(text, lang())) {
        helpDictation();
        return true;
      }
      const opened = matchNavigate(text, lang());
      if (!opened) return false;
      const ports = p();
      if (ports.canOpen && !ports.canOpen()) {
        if (ports.notHere) flash({ text: tr(ports.notHere) });
        return true;
      }
      enter();
      if (opened.rest) queue(opened.rest);
      return true;
    },
    isOpen: () => !isOff(),
    activity() {
      if (idleArmed) armIdle();
    },
    end() {
      if (isOff()) return false;
      exit();
      return true;
    },
    dispose() {
      epoch += 1;
      turn += 1;
      p().timers.clear(idle);
      p().timers.clear(flashTimer);
      wait?.cancel();
      wait = null;
      mode = { kind: "off" };
    },
  };
}
