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
 */

export type NextPromptPhase = "warm" | "final";

/** The backend's answer (desktop `agent_next_prompt`; the phone's route
 * leaves out `turnKey`). Every failure is a status, never an error. `model`
 * names the local model that wrote `text` (absent from an older backend). */
export interface NextPromptAnswer {
  text: string | null;
  turnKey?: string | null;
  status: "ok" | "warmed" | "skipped" | "busy" | "not_running" | "no_model" | "refused" | "unavailable";
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
