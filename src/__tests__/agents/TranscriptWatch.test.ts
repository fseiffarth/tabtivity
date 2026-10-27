import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import {
  UNWATCHED_POLL_MS,
  WATCHED_BACKSTOP_MS,
  _notifyTranscriptChangedForTest,
  watchedReads,
} from "../../lib/agents/transcriptWatch";

/** A `read` whose answers the test hands out one by one. */
function reads(watched: boolean) {
  const ids: string[] = [];
  const read = vi.fn((watch: string) => {
    ids.push(watch);
    return Promise.resolve(watched);
  });
  return { read, ids };
}

describe("watched transcript reads", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    invoke.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("reads at once, then only on a change or the slow backstop while watched", async () => {
    const { read, ids } = reads(true);
    const stop = watchedReads(read);
    await vi.advanceTimersByTimeAsync(0);
    // The read that armed the watch, and one to catch what it missed.
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(UNWATCHED_POLL_MS * 3);
    expect(read).toHaveBeenCalledTimes(2);
    _notifyTranscriptChangedForTest(ids[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(3);
    // The change restarted the backstop clock.
    await vi.advanceTimersByTimeAsync(WATCHED_BACKSTOP_MS - 1);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(4);
    // One watch id for the life of the reads.
    expect(new Set(ids).size).toBe(1);
    stop();
  });

  // A prompt's record written while the arming read ran told no one: the chat
  // showed it as sending until the agent wrote again.
  it("reads once more right after the watch is armed, unwatched to watched too", async () => {
    let watched = false;
    const read = vi.fn((_watch: string) => Promise.resolve(watched));
    const stop = watchedReads(read);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    watched = true;
    await vi.advanceTimersByTimeAsync(UNWATCHED_POLL_MS);
    expect(read).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(WATCHED_BACKSTOP_MS - 1);
    expect(read).toHaveBeenCalledTimes(3);
    stop();
  });

  it("keeps the 2 s clock while the backend cannot watch", async () => {
    const { read } = reads(false);
    const stop = watchedReads(read);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(UNWATCHED_POLL_MS * 2);
    expect(read).toHaveBeenCalledTimes(3);
    stop();
  });

  it("never overlaps reads: a change during one runs one more after it", async () => {
    let finish: (watched: boolean) => void = () => {};
    const read = vi.fn((_watch: string) => new Promise<boolean>((resolve) => { finish = resolve; }));
    const stop = watchedReads(read);
    await vi.advanceTimersByTimeAsync(0);
    const id = read.mock.calls[0][0];
    _notifyTranscriptChangedForTest(id);
    _notifyTranscriptChangedForTest(id);
    expect(read).toHaveBeenCalledTimes(1);
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it("disarms on stop, again after a read that was in flight, and reads no more", async () => {
    let finish: (watched: boolean) => void = () => {};
    const read = vi.fn((_watch: string) => new Promise<boolean>((resolve) => { finish = resolve; }));
    const stop = watchedReads(read);
    await vi.advanceTimersByTimeAsync(0);
    const id = read.mock.calls[0][0];
    stop();
    expect(invoke).toHaveBeenCalledWith("agent_transcript_unwatch", { watchId: id });
    // The in-flight read armed the watch after the stop: disarmed once more.
    finish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(invoke.mock.calls.filter((c) => c[0] === "agent_transcript_unwatch")).toHaveLength(2);
    _notifyTranscriptChangedForTest(id);
    await vi.advanceTimersByTimeAsync(WATCHED_BACKSTOP_MS * 2);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("gives every reader its own watch id", async () => {
    const a = reads(true);
    const b = reads(true);
    const stopA = watchedReads(a.read);
    const stopB = watchedReads(b.read);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.ids[0]).not.toBe(b.ids[0]);
    _notifyTranscriptChangedForTest(a.ids[0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.read).toHaveBeenCalledTimes(3);
    expect(b.read).toHaveBeenCalledTimes(2);
    stopA();
    stopB();
  });
});
