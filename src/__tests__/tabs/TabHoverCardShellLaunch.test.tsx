/**
 * The tab hover card's launch rows: a shell tab Tabtivity opened shows the
 * program and args it was started with ("program") and the line it typed into
 * the shell ("command"); a plain shell, and every other kind, shows neither.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { TabHoverCard, shellLaunch } from "../../components/tabs/TabHoverCard";
import type { TabEntry } from "../../stores/tabs";

const tab = (over: Partial<TabEntry>): TabEntry =>
  ({ key: "shell-1", label: "sh", cmd: "", cwd: "/p", kind: "shell", ...over }) as TabEntry;

/** The value of the card's row with this label, or null when it has none. */
function row(label: string): string | null {
  const rows = [...document.querySelectorAll(".tab-popup .pill-popup-path-row")];
  const hit = rows.find((r) => r.querySelector(".pill-popup-path-label")?.textContent?.startsWith(label));
  return hit?.querySelector(".tab-popup-command")?.textContent ?? null;
}

afterEach(() => {
  cleanup();
});

describe("tab hover card shell launch rows", () => {
  it("shows the program with its args, quoting only what needs it", () => {
    render(<TabHoverCard tab={tab({ cmd: "bash", args: ["-lc", "echo 'hi there'"] })} scope="p1" anchorX={0} anchorY={0} />);
    expect(row("program")).toBe(`bash -lc 'echo '\\''hi there'\\'''`);
    expect(row("command")).toBeNull();
  });

  it("shows the command typed into the shell", () => {
    render(<TabHoverCard tab={tab({ initialInput: "tail -n 60 -F /x/log\n" })} scope="p1" anchorX={0} anchorY={0} />);
    expect(row("command")).toBe("tail -n 60 -F /x/log");
    expect(row("program")).toBeNull();
  });

  it("shows nothing for a plain shell or a non-shell tab", () => {
    expect(shellLaunch(tab({ args: [] }))).toEqual({ program: null, input: null });
    expect(shellLaunch(tab({ kind: "agent", cmd: "claude", args: ["--resume"] }))).toEqual({ program: null, input: null });
  });
});
