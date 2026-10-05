/**
 * Prompts Tabtivity just typed into an agent tab (`sendSteeringPrompt`: the
 * Reader's composer, steering's prompt box), told to whoever shows that tab's
 * chat — the desktop Reader draws each one as sending at once, not only when
 * the CLI records it (a prompt queued while the agent works is recorded only
 * once the CLI takes it up). Keyed by the tab's `scheduleTargetId`; nothing is
 * kept, a listener that is not mounted misses it.
 */
export interface SentPrompt {
  text: string;
  sentAt: number;
}

type Listener = (prompt: SentPrompt) => void;

const listeners = new Map<string, Set<Listener>>();

export function noteSentPrompt(target: string, text: string): void {
  const prompt: SentPrompt = { text: text.trim(), sentAt: Date.now() };
  if (!prompt.text) return;
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
