import { useEffect, useRef, useState } from "react";

/**
 * The local model's guess at the user's next message, for an agent CLI that
 * draws no suggestion of its own (Codex, OpenCode, Copilot, …) or a Claude
 * turn it skipped one on. The backend writes it from the session's last turn
 * (`services::agent::next_prompt`, desktop `agent_next_prompt`, phone
 * `GET /api/v1/tabs/{id}/next-prompt`); this is when to ask, shared by the
 * desktop Chat composer, steering's prompt box and the phone's composer.
 *
 * - While the agent works, a `warm` request feeds Ollama the turn so far —
 *   at most one every `NEXT_PROMPT_WARM_MS` and one in flight — so the final
 *   request only reads the answer cold. Not where `canWarm` says no (a
 *   local-model agent holds the GPU), nor on a Claude tab whose last turn
 *   showed its own suggestion.
 * - Once per ended turn, after `settleMs` with an empty composer and no
 *   suggestion of the CLI's own, one `final` request; its text fills the
 *   suggestion slot (Tab / → take it, nothing sends it).
 * - The first keystroke, a suggestion of the CLI's own, a new turn or the
 *   pane hiding drop it; a dropped turn is not asked again.
 *
 * The model's text is attacker-shaped (the transcript holds project files and
 * fetched pages): it is only ever a placeholder or an untouched draft, one
 * line, control characters cut (`cleanNextPrompt`).
 *
 * While a prompt is being typed the same model writes how it goes on
 * (`usePromptCompletion`, the backend's `complete`): dim text after the caret
 * on the desktop, a strip over the field on the phone. Nothing takes it but
 * the user (Tab / →, a tap).
 */

export type NextPromptPhase = "warm" | "final";

/** The backend's answer (desktop `agent_next_prompt`; the phone's route
 * leaves out `turnKey`). Every failure is a status, never an error. `model`
 * names the local model that wrote `text` (absent from an older backend). */
export interface NextPromptAnswer {
  text: string | null;
  turnKey?: string | null;
  status: "ok" | "warmed" | "skipped" | "busy" | "not_running" | "no_model" | "refused" | "unavailable" | "off" | "locked";
  reason?: string;
  model?: string | null;
}

/** The local model's suggestion as a composer shows it: the line and the
 * model that wrote it ("" each when none; `model` "" too from a backend that
 * names none). */
export interface NextPromptShown {
  text: string;
  model: string;
}

const NONE_SHOWN: NextPromptShown = { text: "", model: "" };

/** The gap between warm-ups while the agent works. */
export const NEXT_PROMPT_WARM_MS = 3_000;
/** How long a Claude turn's end rests before the local model is asked:
 * Claude draws its own suggestion a moment after the turn. */
export const NEXT_PROMPT_CLAUDE_SETTLE_MS = 1_500;
/** Any other CLI's: long enough that the screen's busy row flickering off
 * between two steps is not a turn's end. */
export const NEXT_PROMPT_SETTLE_MS = 400;
/** A `final` answered `skipped` is asked again this much later, at most
 * `NEXT_PROMPT_FINAL_RETRIES` times: the screen can go idle before the CLI
 * has written the turn's answer to its transcript, and a surface keyed by
 * the work's end (steering, the phone) has no later key to ask on. */
export const NEXT_PROMPT_RETRY_MS = 1_500;
export const NEXT_PROMPT_FINAL_RETRIES = 3;
/** The longest suggestion shown. */
export const NEXT_PROMPT_MAX_CHARS = 200;

/** Bidirectional overrides and isolates: a suggestion could otherwise draw
 * its words in another order than they would be sent. */
const BIDI = /[‪-‮⁦-⁩]/gu;

/** `text` as the suggestion slot shows it: its first non-blank line, escape
 * sequences and control characters cut, spaces folded, at most
 * `NEXT_PROMPT_MAX_CHARS`; "" for nothing or the model's `NONE`. The backend
 * cleans it too — this keeps the slot one inert line whatever arrives. */
export function cleanNextPrompt(text: string | null | undefined): string {
  if (!text) return "";
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      // CSI (`ESC [ … final`) or a two-character escape.
      if (text[i + 1] === "[") {
        i += 2;
        while (i < text.length && !(text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e)) i += 1;
      } else i += 1;
      continue;
    }
    if (code === 0x0a || code === 0x0d) {
      if (out.trim()) break;
      out = "";
      continue;
    }
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : text[i];
  }
  const line = out.replace(BIDI, "").replace(/\s+/gu, " ").trim().replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, "").trim();
  if (!line || /^none\.?$/iu.test(line)) return "";
  return line.length > NEXT_PROMPT_MAX_CHARS ? `${line.slice(0, NEXT_PROMPT_MAX_CHARS - 1).trimEnd()}…` : line;
}

/** The longest model name a "suggested by" chip shows. */
export const NEXT_PROMPT_MAX_MODEL_CHARS = 80;

/** A model name as the chip shows it: one inert line, capped; "" for none. */
export function cleanModelName(name: string | null | undefined): string {
  if (!name) return "";
  let plain = "";
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    plain += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : char;
  }
  const line = plain.replace(BIDI, "").replace(/[\u200b-\u200f\ufeff]/gu, "").replace(/\s+/gu, " ").trim();
  return line.length > NEXT_PROMPT_MAX_MODEL_CHARS ? line.slice(0, NEXT_PROMPT_MAX_MODEL_CHARS).trimEnd() : line;
}

/** The turn key of a surface that does not read the transcript for it
 * (steering's prompt box, the phone): a new one each time the agent stops
 * working, null while it works. The backend keys its cache by the
 * transcript's own turn, so asking again for a turn it answered runs no
 * model. */
export function useWorkEndKey(working: boolean): string | null {
  const [ended, setEnded] = useState(0);
  const was = useRef(working);
  useEffect(() => {
    if (was.current && !working) setEnded((count) => count + 1);
    was.current = working;
  }, [working]);
  return working ? null : `idle-${ended}`;
}

/** The page is on screen (`document.visibilityState`): a phone in a pocket
 * asks for nothing. */
export function usePageShown(): boolean {
  const [shown, setShown] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const changed = () => setShown(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return shown;
}

export interface NextPromptInput {
  /** Asking is allowed at all: the pane is shown, its session read, nothing
   * else (a subagent, an earlier chat) the composer's target. */
  enabled: boolean;
  /** The agent is in a turn. */
  working: boolean;
  /** The turn that ended, new for each one; null while the agent works, a
   * dialog waits, or no turn has ended. */
  turnKey: string | null;
  /** Changes whenever the session moved on (a transcript read, a repaint):
   * what the warm-ups follow. */
  progress: unknown;
  /** Asked when a warm-up is due: false skips it. */
  canWarm: () => boolean;
  /** How long a turn's end rests before `final` is asked. */
  settleMs: number;
  /** The CLI's own suggestion ("" when none): it always wins. */
  screenSuggestion: string;
  /** The composer holds nothing of the user's. */
  composerEmpty: boolean;
  ask: (phase: NextPromptPhase) => Promise<NextPromptAnswer | null>;
}

/** The local model's suggestion for the ended turn and the model that wrote
 * it, `text` "" while there is none to show (see the module doc). Callers
 * show `screenSuggestion || text`. */
export function useNextPrompt({ enabled, working, turnKey, progress, canWarm, settleMs, screenSuggestion, composerEmpty, ask }: NextPromptInput): NextPromptShown {
  const [shown, setShown] = useState<{ turn: string; text: string; model: string } | null>(null);
  const askRef = useRef(ask);
  askRef.current = ask;
  const canWarmRef = useRef(canWarm);
  canWarmRef.current = canWarm;
  /** The turn `final` was asked for, and the one dropped: neither is asked
   * again. */
  const asked = useRef<string | null>(null);
  const dropped = useRef<string | null>(null);
  /** The CLI showed a suggestion of its own at its last turn's end (Claude):
   * its next turn is not warmed for a suggestion it will likely draw again. */
  const ownSeen = useRef(false);

  useEffect(() => {
    if (!enabled) {
      // Hidden: whatever was asked is let go; shown again, the turn is asked
      // once more (the backend answers it from its cache).
      asked.current = null;
      setShown(null);
      return;
    }
    if (turnKey === null || working) {
      setShown(null);
      return;
    }
    if (screenSuggestion) ownSeen.current = true;
    if (!composerEmpty || screenSuggestion) {
      dropped.current = turnKey;
      setShown(null);
      return;
    }
    if (dropped.current === turnKey || asked.current === turnKey) return;
    const turn = turnKey;
    let current = true;
    const run = (attempt: number) => {
      asked.current = turn;
      ownSeen.current = false;
      void askRef.current("final").catch(() => null).then((answer) => {
        if (!current) return;
        // The transcript had not caught up with the turn's end yet.
        if (answer?.status === "skipped" && attempt < NEXT_PROMPT_FINAL_RETRIES) {
          timer = setTimeout(() => run(attempt + 1), NEXT_PROMPT_RETRY_MS);
          return;
        }
        if (answer?.status !== "ok") return;
        const text = cleanNextPrompt(answer.text);
        setShown(text ? { turn, text, model: cleanModelName(answer.model) } : null);
      });
    };
    let timer = setTimeout(() => run(0), settleMs);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [enabled, working, turnKey, composerEmpty, screenSuggestion, settleMs]);

  /** The warm-up due, and whether one is on its way. A change while one is
   * due joins it rather than putting it off, so a steady stream of changes
   * still warms every `NEXT_PROMPT_WARM_MS`. */
  const warmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const warming = useRef(false);
  const warmOn = enabled && working;
  useEffect(() => {
    if (!warmOn || warmTimer.current !== undefined) return;
    warmTimer.current = setTimeout(() => {
      warmTimer.current = undefined;
      if (warming.current || ownSeen.current || !canWarmRef.current()) return;
      warming.current = true;
      void askRef.current("warm").catch(() => null).finally(() => { warming.current = false; });
    }, NEXT_PROMPT_WARM_MS);
  }, [warmOn, progress]);
  useEffect(() => {
    if (warmOn) return;
    clearTimeout(warmTimer.current);
    warmTimer.current = undefined;
  }, [warmOn]);
  useEffect(() => () => clearTimeout(warmTimer.current), []);

  return shown && enabled && !working && shown.turn === turnKey && composerEmpty && !screenSuggestion
    ? { text: shown.text, model: shown.model }
    : NONE_SHOWN;
}

/** How long the typing rests before the model is asked how the draft goes on. */
export const NEXT_PROMPT_COMPLETE_MS = 400;
/** After an answer that says completions are not to be had (switched off, no
 * model, Ollama down or refused), none is asked for this long. */
export const NEXT_PROMPT_COMPLETE_BACKOFF_MS = 60_000;
/** `draft` cut to its last `NEXT_PROMPT_MAX_DRAFT_CHARS` characters at a line
 * start (else a word start) — the backend's own window, for a box that holds
 * more than a completion may be asked about (a mail body). */
export function windowDraft(draft: string): string {
  if (draft.length <= NEXT_PROMPT_MAX_DRAFT_CHARS) return draft;
  const tail = draft.slice(draft.length - NEXT_PROMPT_MAX_DRAFT_CHARS);
  // The cut fell on a line start already.
  if (draft[draft.length - NEXT_PROMPT_MAX_DRAFT_CHARS - 1] === "\n") return tail;
  const line = tail.indexOf("\n");
  if (line >= 0) return tail.slice(line + 1);
  const word = tail.search(/\s/u);
  return word >= 0 ? tail.slice(word + 1) : tail;
}

/** The longest draft completed, and the longest continuation shown (the
 * backend's `MAX_DRAFT_CHARS` / `MAX_COMPLETION_CHARS`). */
export const NEXT_PROMPT_MAX_DRAFT_CHARS = 2_000;
export const NEXT_PROMPT_MAX_COMPLETION_CHARS = 120;

/** A continuation as it is shown after the draft: one inert line like
 * `cleanNextPrompt`'s, but the single space it may open with is kept (it
 * parts a new word from the draft) and nothing is read as `NONE`. */
export function cleanCompletion(text: string | null | undefined): string {
  if (!text) return "";
  const spaced = /^[ \t]/u.test(text);
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      if (text[i + 1] === "[") {
        i += 2;
        while (i < text.length && !(text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e)) i += 1;
      } else i += 1;
      continue;
    }
    if (code === 0x0a || code === 0x0d) {
      if (out.trim()) break;
      out = "";
      continue;
    }
    out += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : text[i];
  }
  const line = out.replace(BIDI, "").replace(/[\u200b-\u200f\ufeff]/gu, "").replace(/\s+/gu, " ").trim();
  if (!line) return "";
  const capped = line.length > NEXT_PROMPT_MAX_COMPLETION_CHARS ? line.slice(0, NEXT_PROMPT_MAX_COMPLETION_CHARS).trimEnd() : line;
  return spaced ? ` ${capped}` : capped;
}

/** Whether the model is asked how `draft` goes on (the backend's
 * `draft_tail` rule, so nothing it would skip is sent): not a `/command`,
 * at least one finished word, a last line that holds something, and no
 * longer than `NEXT_PROMPT_MAX_DRAFT_CHARS`. */
export function completableDraft(draft: string): boolean {
  const typed = draft.trimStart();
  if (!typed || typed.startsWith("/") || !/\s/u.test(typed) || draft.length > NEXT_PROMPT_MAX_DRAFT_CHARS) return false;
  return draft.slice(draft.lastIndexOf("\n") + 1).trim() !== "";
}

/** How the draft goes on, as a composer shows it: `text` to append ("" for
 * none), who wrote it, and whether that was the local model (not the CLI's
 * own suggestion being typed along). */
export interface PromptCompletionShown {
  text: string;
  model: string;
  local: boolean;
}

const NO_COMPLETION: PromptCompletionShown = { text: "", model: "", local: false };

export interface PromptCompletionInput {
  /** Asking is allowed at all: the composer is shown and usable, completions
   * are switched on, nothing else is the composer's target. */
  enabled: boolean;
  draft: string;
  /** The caret stands at the draft's end with nothing selected: where the
   * continuation is drawn. A surface that only appends passes true. */
  atEnd: boolean;
  /** The suggestion the empty box offers (the CLI's own or the local
   * model's, "" for none): a draft that starts it keeps showing its rest,
   * with no model run. */
  seed?: string;
  seedModel?: string;
  /** `seed` is the local model's. */
  seedLocal?: boolean;
  /** Asks the backend how `draft` goes on (`complete`). */
  complete: (draft: string) => Promise<NextPromptAnswer | null>;
}

/** What `line` (a whole line: `base` and what follows it) still adds to
 * `draft`: "" unless the draft was typed along it from `base` on. */
function restOf(line: { base: string; text: string } | null, draft: string): string {
  if (!line || !line.text || draft.length < line.base.length) return "";
  const whole = line.base + line.text;
  return whole.length > draft.length && whole.startsWith(draft) ? whole.slice(draft.length) : "";
}

/**
 * How the prompt being typed goes on. `NEXT_PROMPT_COMPLETE_MS` after the
 * last change to a draft worth completing (`completableDraft`) with the caret
 * at its end, the backend is asked once for that draft; its continuation
 * shows until the draft leaves it — typing along it keeps the rest and asks
 * nothing, and so does typing along the suggestion the empty box offered
 * (`seed`). The backend ends the run of a draft that was typed over. Taking
 * the continuation is the caller's (it appends `text` to the draft).
 */
export function usePromptCompletion({ enabled, draft, atEnd, seed = "", seedModel = "", seedLocal = false, complete }: PromptCompletionInput): PromptCompletionShown {
  const [held, setHeld] = useState<{ base: string; text: string; model: string } | null>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  const completeRef = useRef(complete);
  completeRef.current = complete;
  /** The suggestion the box offered while it was last empty: frozen once
   * the user types, so typing along it is recognised after the offer itself
   * has gone (a local one is dropped at the first keystroke). */
  const offered = useRef({ base: "", text: "", model: "", local: false });
  if (!draft) offered.current = { base: "", text: seed, model: seedModel, local: seedLocal };
  /** The draft the backend was last asked about: never asked twice. */
  const asked = useRef<string | null>(null);
  const quietUntil = useRef(0);

  useEffect(() => {
    if (!enabled || !atEnd || !completableDraft(draft)) return;
    if (asked.current === draft || Date.now() < quietUntil.current) return;
    if (restOf(heldRef.current, draft) || restOf(offered.current, draft)) return;
    const timer = setTimeout(() => {
      asked.current = draft;
      void completeRef.current(draft).catch(() => null).then((answer) => {
        // Aborted for a newer draft, or nothing to go on: just no answer.
        if (answer?.status === "skipped" || answer?.status === "busy") return;
        if (answer?.status !== "ok") {
          quietUntil.current = Date.now() + NEXT_PROMPT_COMPLETE_BACKOFF_MS;
          return;
        }
        const text = cleanCompletion(answer.text);
        if (text) setHeld({ base: draft, text, model: cleanModelName(answer.model) });
      });
    }, NEXT_PROMPT_COMPLETE_MS);
    return () => clearTimeout(timer);
  }, [enabled, atEnd, draft]);

  if (!enabled || !atEnd || !draft) return NO_COMPLETION;
  const own = restOf(held, draft);
  if (own) return { text: own, model: held?.model ?? "", local: true };
  const along = restOf(offered.current, draft);
  return along ? { text: along, model: offered.current.model, local: offered.current.local } : NO_COMPLETION;
}
