import { useSyncExternalStore } from "react";

/**
 * Prompts Tabtivity just typed into an agent tab (`sendSteeringPrompt`: the
 * Reader's composer, steering's prompt box), told to whoever shows that tab's
 * chat — the desktop Reader draws each one as sending at once, not only when
 * the CLI records it (a prompt queued while the agent works is recorded only
 * once the CLI takes it up). Keyed by the tab's `scheduleTargetId`.
 *
 * Each one is also kept here until a Reader lets it go (recorded, or waited
 * long enough while the agent sat idle): the Reader is unmounted while its
 * pane shows the terminal, and a prompt queued behind a long turn must still
 * show as sending when the chat comes back.
 */
export interface SentPrompt {
  id: number;
  text: string;
  sentAt: number;
}

type Listener = (prompt: SentPrompt) => void;

/** How long a prompt no Reader let go is kept at most. */
const KEPT_MS = 24 * 60 * 60_000;
const NONE: readonly SentPrompt[] = [];

const listeners = new Map<string, Set<Listener>>();
const kept = new Map<string, readonly SentPrompt[]>();
const watchers = new Set<() => void>();
let lastId = 0;

function setKept(target: string, prompts: readonly SentPrompt[]): void {
  if (prompts.length === 0) kept.delete(target);
  else kept.set(target, prompts);
  for (const watcher of [...watchers]) watcher();
}

export function noteSentPrompt(target: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  lastId += 1;
  const prompt: SentPrompt = { id: lastId, text: trimmed, sentAt: Date.now() };
  const fresh = (kept.get(target) ?? NONE).filter((item) => prompt.sentAt - item.sentAt < KEPT_MS);
  setKept(target, [...fresh, prompt]);
  for (const listener of [...(listeners.get(target) ?? [])]) listener(prompt);
}

/** Calls `listener` for every prompt sent to `target`; returns the unsubscribe. */
export function onSentPrompt(target: string, listener: Listener): () => void {
  let set = listeners.get(target);
  if (!set) listeners.set(target, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(target) === set) listeners.delete(target);
  };
}

/** The prompts sent to `target` that still show as sending, oldest first. */
export function sentPromptsFor(target: string | undefined): readonly SentPrompt[] {
  return (target && kept.get(target)) || NONE;
}

/** Lets these of `target`'s sent prompts go (recorded, taken back, expired). */
export function forgetSentPrompts(target: string, ids: readonly number[]): void {
  const prompts = kept.get(target);
  if (!prompts) return;
  const left = prompts.filter((item) => !ids.includes(item.id));
  if (left.length !== prompts.length) setKept(target, left);
}

/** `sentPromptsFor(target)`, re-rendering as it changes. */
export function useSentPrompts(target: string | undefined): readonly SentPrompt[] {
  return useSyncExternalStore(
    (watcher) => {
      watchers.add(watcher);
      return () => { watchers.delete(watcher); };
    },
    () => sentPromptsFor(target),
  );
}

/** Tests: forget every kept prompt. */
export function clearSentPrompts(): void {
  kept.clear();
  for (const watcher of [...watchers]) watcher();
}
