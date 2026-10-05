import type { ScheduledPrompt } from "../api";
import type { PendingPrompt } from "./pendingPrompts";
import { storageKey } from "../../../src/lib/brand";

/**
 * The prompts this phone asked the desktop to hold (`holdPrompt`), kept per
 * tab outside the chat that sent them. The desktop keeps holding a prompt
 * after the reader leaves the tab, so its bubble must come back with the tab:
 * the session's record does not have it until the agent takes it in. Held
 * only until then — an arrived prompt is the record's.
 */
const KEY = storageKey("mobile.heldPrompts");
/** A prompt still here after this long belongs to a tab long gone. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A hold asked for this long ago and never answered was lost with the page;
 * a prompt typed this long ago has its record. */
const UNANSWERED_MS = 60 * 1000;

type Held = Record<string, PendingPrompt[]>;
type Patch = Partial<Pick<PendingPrompt, "held" | "failed" | "retrying">>;
type Listener = (tabId: string, id: number, patch: Patch) => void;

const listeners = new Set<Listener>();

function valid(value: unknown): value is PendingPrompt {
  if (!value || typeof value !== "object") return false;
  const prompt = value as Partial<PendingPrompt>;
  return typeof prompt.id === "number" && typeof prompt.text === "string" && typeof prompt.seen === "number"
    && typeof prompt.anchorSeen === "number" && typeof prompt.held === "string";
}

function fresh(prompt: PendingPrompt, now: number): boolean {
  const sent = prompt.sentAt ? Date.parse(prompt.sentAt) : NaN;
  return Number.isNaN(sent) || now - sent < MAX_AGE_MS;
}

function readAll(): Held {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return {};
    const now = Date.now();
    const held: Held = {};
    for (const [tabId, prompts] of Object.entries(parsed)) {
      if (!Array.isArray(prompts)) continue;
      const kept = prompts.filter((prompt): prompt is PendingPrompt => valid(prompt) && fresh(prompt, now));
      if (kept.length) held[tabId] = kept;
    }
    return held;
  } catch {
    return {};
  }
}

function writeAll(held: Held): void {
  try {
    if (Object.keys(held).length) localStorage.setItem(KEY, JSON.stringify(held));
    else localStorage.removeItem(KEY);
  } catch {
    // No storage: the bubbles live as long as the view, as before.
  }
}

/** The prompts the desktop still holds for `tabId`, as last known here. */
export function readHeld(tabId: string): PendingPrompt[] {
  return readAll()[tabId] ?? [];
}

/** Keep the held ones of `prompts` — those the desktop holds and the session
 * has not recorded — as `tabId`'s. */
export function writeHeld(tabId: string, prompts: readonly PendingPrompt[]): void {
  const held = readAll();
  // The anchor places a typed prompt; a held one waits at the end.
  const kept = prompts.filter((prompt) => prompt.held !== undefined).map((prompt) => ({ ...prompt, anchor: undefined }));
  if (kept.length) held[tabId] = kept;
  else delete held[tabId];
  writeAll(held);
}

/** What the desktop answered to a hold: the chat showing `tabId` now — which
 * may be a later one than the chat that asked, if the reader left and came
 * back meanwhile — takes it, and so does what is kept. */
export function patchHeld(tabId: string, id: number, patch: Patch): void {
  const held = readAll();
  const prompts = held[tabId];
  if (prompts?.some((prompt) => prompt.id === id)) {
    writeHeld(tabId, prompts.map((prompt) => (prompt.id === id ? { ...prompt, ...patch } : prompt)));
  }
  for (const listener of listeners) listener(tabId, id, patch);
}

/** Hear `patchHeld`; the return value stops it. */
export function onHeldPatched(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * `prompts` as the desktop's schedules for the tab stand: a prompt it holds
 * waits there as a send-now rule not yet run. One delivered, or gone (the
 * desktop's reader deleted it), is no longer held — the session's record is
 * what shows it, if anything; one delivered moments ago stays until its
 * record is read. A hold still unanswered takes the id of a
 * waiting rule with its words, unless it is so old its answer was lost.
 */
export function stillHeld(prompts: readonly PendingPrompt[], schedules: readonly ScheduledPrompt[], now = Date.now()): PendingPrompt[] {
  const waiting = schedules.filter((schedule) => schedule.rule.type === "once" && !schedule.last);
  const claimed = new Set(prompts.map((prompt) => prompt.held).filter((held) => !!held));
  return prompts.flatMap((prompt) => {
    if (prompt.held === undefined) return [prompt];
    if (prompt.held) {
      if (waiting.some((schedule) => schedule.id === prompt.held)) return [prompt];
      // Just typed: its record may not be written yet, and the bubble should
      // not blink out until it is (`withPending` then shows it in its place).
      const last = schedules.find((schedule) => schedule.id === prompt.held)?.last;
      const at = last?.result === "delivered" ? Date.parse(last.at) : NaN;
      return !Number.isNaN(at) && now - at < UNANSWERED_MS ? [prompt] : [];
    }
    const match = waiting.find((schedule) => !claimed.has(schedule.id) && schedule.message.trim() === prompt.text);
    if (match) {
      claimed.add(match.id);
      return [{ ...prompt, held: match.id }];
    }
    const sent = prompt.sentAt ? Date.parse(prompt.sentAt) : NaN;
    return !Number.isNaN(sent) && now - sent < UNANSWERED_MS ? [prompt] : [];
  });
}
