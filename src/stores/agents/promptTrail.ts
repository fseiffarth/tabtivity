import { create } from "zustand";
import { feedTypedLine, type TypedLine } from "../../lib/agents/typedPrompt";
import type { TypedPrompt } from "../../lib/agents/prompt/trail";

/**
 * The prompts the keystrokes submitted into each agent pane, by composed PTY
 * id — the half of the prompt strip that needs nothing of any CLI
 * (`lib/agents/prompt/trail`). In memory only: the history rows are the
 * record that outlives the window.
 *
 * A leaf (no other store imports), so `stores/tabs` can forget a closed tab's
 * trail without a cycle.
 */
interface PromptTrailStore {
  typedByPty: Record<string, TypedPrompt[]>;
}

/** Typed prompts kept per pane; the history keeps the rest. */
export const TYPED_TRAIL_MAX = 50;

export const usePromptTrailStore = create<PromptTrailStore>(() => ({ typedByPty: {} }));

/** The line each pane is typing — churns per keystroke, so outside React.
 *  `deciding`: the line was begun while the agent sat on a decision, so its
 *  Enter answers that dialog rather than asking anything. */
const lineByPty: Record<string, { line: TypedLine; pasting: boolean; deciding: boolean }> = {};

/**
 * Feed one chunk of the user's input to `ptyId`'s line. `deciding` says the
 * agent is waiting on a decision as it arrives. Every prompt an Enter in it
 * submitted that `accept` takes (trimmed) joins the pane's trail.
 */
export function notePromptTrailInput(
  ptyId: string,
  data: string,
  deciding: boolean,
  accept: (text: string) => boolean,
): void {
  const prev = lineByPty[ptyId] ?? { line: { text: "", cursor: 0 }, pasting: false, deciding: false };
  const { line, submitted, pasting } = feedTypedLine(prev.line, data, prev.pasting);
  const answering = prev.deciding || deciding;
  // Answered, or nothing pending (an Esc that declined it): the next line
  // is a prompt again.
  lineByPty[ptyId] = { line, pasting, deciding: answering && !submitted.length && !!line?.text };
  if (answering) return;
  const taken = submitted.map((text) => text.trim()).filter(accept);
  if (!taken.length) return;
  const at = Date.now();
  usePromptTrailStore.setState((state) => ({
    typedByPty: {
      ...state.typedByPty,
      [ptyId]: [...(state.typedByPty[ptyId] ?? []), ...taken.map((text) => ({ text, at }))].slice(-TYPED_TRAIL_MAX),
    },
  }));
}

/** Forget a pane's line and trail (tab closed). */
export function forgetPromptTrail(ptyId: string): void {
  delete lineByPty[ptyId];
  if (!(ptyId in usePromptTrailStore.getState().typedByPty)) return;
  usePromptTrailStore.setState((state) => {
    const { [ptyId]: _drop, ...rest } = state.typedByPty;
    return { typedByPty: rest };
  });
}

/** Test seam. */
export function _resetPromptTrailForTest(): void {
  for (const key of Object.keys(lineByPty)) delete lineByPty[key];
  usePromptTrailStore.setState({ typedByPty: {} });
}
