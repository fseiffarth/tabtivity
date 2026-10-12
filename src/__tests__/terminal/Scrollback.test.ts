/**
 * `lib/terminal/scrollback` (tab cost plan step 2): the shell cap's default
 * and clamp, the agents' constant, and the one tab-kind derivation
 * (`terminalViewKind`) the spawn effect and the cap share.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));

import {
  AGENT_SCROLLBACK_ROWS,
  SHELL_SCROLLBACK_CHOICES,
  SHELL_SCROLLBACK_DEFAULT,
  SHELL_SCROLLBACK_MAX,
  SHELL_SCROLLBACK_MIN,
  scrollbackRowsFor,
  shellScrollbackRows,
} from "../../lib/terminal/scrollback";
import { terminalSpawnKey, terminalViewKind } from "../../lib/terminal/terminalSpawn";
import { envName } from "../../lib/brand";

describe("shellScrollbackRows", () => {
  it("defaults when unset or unusable", () => {
    expect(SHELL_SCROLLBACK_DEFAULT).toBe(2000);
    for (const v of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(shellScrollbackRows(v)).toBe(2000);
    }
  });

  it("clamps to [100, 50,000] and keeps whole lines", () => {
    expect(SHELL_SCROLLBACK_MIN).toBe(100);
    expect(SHELL_SCROLLBACK_MAX).toBe(50_000);
    expect(shellScrollbackRows(0)).toBe(100);
    expect(shellScrollbackRows(-5)).toBe(100);
    expect(shellScrollbackRows(1_000_000)).toBe(50_000);
    expect(shellScrollbackRows(1234.9)).toBe(1234);
  });

  it("passes every offered choice through unchanged", () => {
    expect([...SHELL_SCROLLBACK_CHOICES]).toEqual([1000, 2000, 5000, 10_000]);
    for (const n of SHELL_SCROLLBACK_CHOICES) expect(shellScrollbackRows(n)).toBe(n);
  });
});

describe("scrollbackRowsFor", () => {
  it("gives agents 5,000 whatever the setting and every other kind the setting", () => {
    expect(AGENT_SCROLLBACK_ROWS).toBe(5000);
    expect(scrollbackRowsFor("agent", 1000)).toBe(5000);
    expect(scrollbackRowsFor("local_agent", 10_000)).toBe(5000);
    expect(scrollbackRowsFor("shell", undefined)).toBe(2000);
    expect(scrollbackRowsFor("shell", 10_000)).toBe(10_000);
  });
});

describe("terminalViewKind", () => {
  it("prefers the declared kind, then a local model in the env, then the command", () => {
    expect(terminalViewKind({ kind: "shell", cmd: "claude" })).toBe("shell");
    expect(terminalViewKind({ cmd: "vibe", env: { VIBE_ACTIVE_MODEL: "m" } })).toBe("local_agent");
    expect(terminalViewKind({ cmd: "codex", env: { [envName("LOCAL_MODEL")]: "m" } })).toBe("local_agent");
    expect(terminalViewKind({ cmd: "claude" })).toBe("agent");
    expect(terminalViewKind({ cmd: "bash" })).toBe("shell");
  });
});

describe("the scrollback is never a spawn input", () => {
  it("terminalSpawnKey takes no scrollback, so a settings change cannot change it", () => {
    const base = { id: "p:shell-1", cmd: "bash", cwd: "/p", kind: "shell" };
    const withExtra = { ...base, shell_scrollback_rows: 1000, scrollback: 1000 } as typeof base;
    expect(terminalSpawnKey(withExtra)).toBe(terminalSpawnKey(base));
  });
});
