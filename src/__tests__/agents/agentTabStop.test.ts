import { describe, expect, it } from "vitest";
import {
  BACKGROUND_GRACE_MS,
  FRESH_GRACE_MS,
  PHONE_GRACE_MS,
  freeMemoryBytes,
  isStoppableCli,
  lastUsedOf,
  pickRestoreWakes,
  pickStops,
  rankStopCandidates,
  staticStopBlockers,
  stopBlockers,
  type StopCandidate,
  type StopPlace,
  type StopSignals,
  type StopTab,
} from "../../lib/agents/agentTabStop";
import { AGENT_CLI_ROWS } from "../../lib/agents/agentClis";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

const tab = (over: Partial<StopTab> = {}): StopTab => ({ kind: "agent", cmd: "claude", sessionId: "s-1", ...over });
const place = (over: Partial<StopPlace> = {}): StopPlace => ({ reservedScope: false, local: true, inContainer: false, ...over });
const quiet = (over: Partial<StopSignals> = {}): StopSignals => ({
  now: NOW,
  deliveryReady: true,
  busy: false,
  decision: false,
  askedAttention: false,
  shown: false,
  queuedPrompt: false,
  printPending: false,
  ...over,
});
const cand = (ptyId: string, lastUsedAt: number, over: Partial<StopCandidate> = {}): StopCandidate => ({
  ptyId,
  scope: "p",
  key: ptyId,
  lastUsedAt,
  ...over,
});

describe("the CLI allow-list", () => {
  it("takes the id-resuming CLIs and the pinned-only ones", () => {
    for (const cmd of ["claude", "codex", "agy", "vibe", "opencode", "copilot", "muse"]) expect(isStoppableCli(cmd)).toBe(true);
  });

  it("never takes a folder's-latest CLI, a CLI with no resume, or a custom agent", () => {
    for (const cmd of ["gemini", "cursor-agent", "grok", "qwen", "droid", "aider", "kiro-cli", "my-custom-agent"]) {
      expect(isStoppableCli(cmd)).toBe(false);
    }
  });

  it("names only binaries the registry has", () => {
    const bins = new Set(AGENT_CLI_ROWS.map((r) => r.bin));
    for (const cmd of ["claude", "codex", "agy", "vibe", "opencode", "copilot", "muse"]) expect(bins.has(cmd)).toBe(true);
  });
});

describe("stopBlockers", () => {
  it("lets a quiet local Claude tab with a conversation go", () => {
    expect(stopBlockers(tab(), place(), quiet({ resumePinned: true, runningSubagents: 0, markupAsk: false }))).toEqual([]);
  });

  it.each([
    ["not_agent", tab({ kind: "local_agent" }), place()],
    ["cli", tab({ cmd: "gemini" }), place()],
    ["no_session", tab({ sessionId: undefined }), place()],
    ["reserved_scope", tab(), place({ reservedScope: true })],
    ["reserved_scope", tab({ assistant: {} }), place()],
    ["host_session", tab({ hostSession: true }), place()],
    ["remote", tab(), place({ local: false })],
    ["container", tab(), place({ inContainer: true })],
    ["auto_continue", tab({ autoContinue: true }), place()],
    ["sign_in", tab({ signIn: {} }), place()],
    ["sign_in", tab({ cloud: true }), place()],
    ["sign_in", tab({ login: {} }), place()],
    ["attach", tab({ tmuxAttach: "work" }), place()],
  ] as const)("static %s", (blocker, t, p) => {
    expect(staticStopBlockers(t, p)).toContain(blocker);
    expect(stopBlockers(t, p, quiet())).toContain(blocker);
  });

  it.each([
    ["stopped", tab({ stopped: true }), quiet()],
    ["turn", tab(), quiet({ deliveryReady: false })],
    ["busy", tab(), quiet({ busy: true })],
    ["decision", tab(), quiet({ decision: true })],
    ["attention", tab(), quiet({ askedAttention: true })],
    ["background", tab(), quiet({ backgroundAt: NOW - BACKGROUND_GRACE_MS + 1000 })],
    ["shown", tab(), quiet({ shown: true })],
    ["phone", tab(), quiet({ phoneSeenAt: NOW - PHONE_GRACE_MS + 1000 })],
    ["queued", tab(), quiet({ queuedPrompt: true })],
    ["print", tab(), quiet({ printPending: true })],
    ["fresh", tab(), quiet({ startedAt: NOW - FRESH_GRACE_MS + 1000 })],
    ["subagents", tab(), quiet({ runningSubagents: 2 })],
    ["markup", tab(), quiet({ markupAsk: true })],
    ["no_conversation", tab(), quiet({ resumePinned: false })],
  ] as const)("the moment: %s", (blocker, t, s) => {
    expect(stopBlockers(t, place(), s)).toEqual([blocker]);
  });

  it("lets old background work, an old phone look and an old spawn pass", () => {
    const s = quiet({
      backgroundAt: NOW - BACKGROUND_GRACE_MS - 1,
      phoneSeenAt: NOW - PHONE_GRACE_MS - 1,
      startedAt: NOW - FRESH_GRACE_MS - 1,
    });
    expect(stopBlockers(tab(), place(), s)).toEqual([]);
  });

  it("does not block on a final check not asked yet", () => {
    expect(stopBlockers(tab(), place(), quiet())).toEqual([]);
  });
});

describe("lastUsedOf", () => {
  it("is the latest mark", () => {
    expect(lastUsedOf({ lastShownAt: 5, lastUserInputAt: 9, lastDoneAt: 7, lastWorkingAt: 8, restoredLastUsedAt: 3, startedAt: 1 })).toBe(9);
    expect(lastUsedOf({ restoredLastUsedAt: 30, startedAt: 10 })).toBe(30);
    expect(lastUsedOf({ lastWorkingAt: 40, lastDoneAt: 20 })).toBe(40);
    expect(lastUsedOf({ lastShownAt: 12 })).toBe(12);
  });

  it("is 0 with no marks, and skips junk", () => {
    expect(lastUsedOf({})).toBe(0);
    expect(lastUsedOf({ lastShownAt: Number.NaN, startedAt: 4 })).toBe(4);
  });
});

describe("rankStopCandidates", () => {
  it("puts the least recently used first, ties in order", () => {
    const ranked = rankStopCandidates([cand("a", 30), cand("b", 10), cand("c", 20), cand("d", 10)]);
    expect(ranked.map((c) => c.ptyId)).toEqual(["b", "d", "c", "a"]);
  });

  it("ranks by use, never by age: an old tab used just now goes after a new unused one", () => {
    // `lastUsedAt` is what a tab's creation does not move.
    const oldButUsed = cand("old", lastUsedOf({ startedAt: NOW - 10 * HOUR, lastUserInputAt: NOW - 60_000 }));
    const newUnused = cand("new", lastUsedOf({ startedAt: NOW - HOUR }));
    expect(rankStopCandidates([oldButUsed, newUnused]).map((c) => c.ptyId)).toEqual(["new", "old"]);
  });

  it("puts a tab with stale MCP lanes in front", () => {
    const ranked = rankStopCandidates([cand("a", 10), cand("b", 50, { mcpStale: true })]);
    expect(ranked.map((c) => c.ptyId)).toEqual(["b", "a"]);
  });
});

describe("pickStops", () => {
  const base = { cap: null, idleMs: null, now: NOW, memLow: false };

  it("stops live - cap of the least recently used, at most five a sweep", () => {
    const cs = [cand("a", 5), cand("b", 1), cand("c", 3)];
    expect(pickStops({ ...base, live: 12, cap: 10, candidates: cs }).map((p) => [p.candidate.ptyId, p.trigger])).toEqual([
      ["b", "cap"],
      ["c", "cap"],
    ]);
    const many = Array.from({ length: 9 }, (_, i) => cand(`t${i}`, i));
    expect(pickStops({ ...base, live: 40, cap: 30, candidates: many })).toHaveLength(5);
  });

  it("stops nothing for the cap while under it, or when only blocked tabs are over", () => {
    expect(pickStops({ ...base, live: 10, cap: 10, candidates: [cand("a", 1)] })).toEqual([]);
    expect(pickStops({ ...base, live: 12, cap: 10, candidates: [] })).toEqual([]);
  });

  it("stops every candidate idle past the time, at most five", () => {
    const cs = [cand("a", NOW - 3 * HOUR), cand("b", NOW - HOUR), cand("c", NOW - 2 * HOUR - 1)];
    expect(pickStops({ ...base, live: 3, idleMs: 2 * HOUR, candidates: cs }).map((p) => p.candidate.ptyId)).toEqual(["a", "c"]);
    const many = Array.from({ length: 8 }, (_, i) => cand(`t${i}`, NOW - 5 * HOUR));
    expect(pickStops({ ...base, live: 8, idleMs: HOUR, candidates: many })).toHaveLength(5);
  });

  it("stops for low memory the least recently used, idle or not, at most three", () => {
    const cs = Array.from({ length: 6 }, (_, i) => cand(`t${i}`, NOW - i));
    const picks = pickStops({ ...base, live: 6, memLow: true, idleMs: 10 * HOUR, candidates: cs });
    expect(picks.map((p) => [p.candidate.ptyId, p.trigger])).toEqual([
      ["t5", "memory"],
      ["t4", "memory"],
      ["t3", "memory"],
    ]);
  });

  it("does not double-count: memory stops lower what the cap still needs", () => {
    const cs = Array.from({ length: 6 }, (_, i) => cand(`t${i}`, i));
    const picks = pickStops({ ...base, live: 14, cap: 10, memLow: true, candidates: cs });
    expect(picks.map((p) => p.trigger)).toEqual(["memory", "memory", "memory", "cap"]);
  });

  it("does nothing with every trigger off", () => {
    const cs = [cand("a", 0)];
    expect(pickStops({ ...base, live: 100, candidates: cs })).toEqual([]);
  });
});

describe("freeMemoryBytes", () => {
  it("is total - used", () => {
    expect(freeMemoryBytes({ supported: true, mem_total_bytes: 32, mem_used_bytes: 20 })).toBe(12);
  });

  it("is null for a missing reading, never zero", () => {
    expect(freeMemoryBytes(null)).toBeNull();
    expect(freeMemoryBytes({ supported: false, mem_total_bytes: 32, mem_used_bytes: 32 })).toBeNull();
    expect(freeMemoryBytes({ supported: true, mem_total_bytes: null, mem_used_bytes: 3 })).toBeNull();
    expect(freeMemoryBytes({ supported: true, mem_total_bytes: 0, mem_used_bytes: 0 })).toBeNull();
  });
});

describe("pickRestoreWakes", () => {
  it("wakes every tab whose session survived, then the most recently used up to the cap", () => {
    const stopped = [
      { ptyId: "old", lastUsedAt: 1, sessionAlive: false },
      { ptyId: "alive", lastUsedAt: 0, sessionAlive: true },
      { ptyId: "recent", lastUsedAt: 9, sessionAlive: false },
      { ptyId: "mid", lastUsedAt: 5, sessionAlive: false },
    ];
    expect(pickRestoreWakes({ live: 1, cap: 4, memLow: false, stopped })).toEqual(["alive", "recent", "mid"]);
  });

  it("wakes only the surviving sessions while memory is low or past the cap", () => {
    const stopped = [
      { ptyId: "a", lastUsedAt: 9, sessionAlive: false },
      { ptyId: "b", lastUsedAt: 1, sessionAlive: true },
    ];
    expect(pickRestoreWakes({ live: 0, cap: 10, memLow: true, stopped })).toEqual(["b"]);
    expect(pickRestoreWakes({ live: 10, cap: 10, memLow: false, stopped })).toEqual(["b"]);
  });
});
