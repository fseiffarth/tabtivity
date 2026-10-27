/**
 * The tab hover card's feature rows: an agent tab lists what its spawn was
 * handed (`agent_tab_features`) — sandbox, MCP servers (Tabtivity's first,
 * switched-off ones last and marked off),
 * skills past six collapsed, API key — and a tab the backend did not spawn,
 * or a non-agent tab, shows none of them.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((_cmd: string, _args?: unknown): Promise<unknown> => Promise.resolve(null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { TabHoverCard } from "../../components/tabs/TabHoverCard";
import type { TabEntry } from "../../stores/tabs";

const tab = (over: Partial<TabEntry>): TabEntry =>
  ({ key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent", ...over }) as TabEntry;

/** The value of the card's row with this label, or null when it has none. */
function row(label: string): string | null {
  const rows = [...document.querySelectorAll(".tab-popup .pill-popup-path-row")];
  const hit = rows.find((r) => r.querySelector(".pill-popup-path-label")?.textContent?.startsWith(label));
  return hit?.querySelector(".tab-popup-meta")?.textContent ?? null;
}

afterEach(() => {
  cleanup();
  invoke.mockReset();
  invoke.mockImplementation(() => Promise.resolve(null));
});

describe("tab hover card feature rows", () => {
  it("lists the sandbox, MCP servers, skills and API key of the tab's spawn", async () => {
    invoke.mockImplementation((cmd) =>
      Promise.resolve(
        cmd === "agent_tab_features"
          ? {
              sandbox: "fenced",
              appMcp: ["app-help", "app-git"],
              ownMcp: ["docs"],
              ownMcpOff: ["kicad"],
              skills: ["a", "b", "c", "d", "e", "f", "g", "h"],
              apiKeys: ["anthropic"],
            }
          : null,
      ),
    );
    render(<TabHoverCard tab={tab({})} scope="p1" anchorX={0} anchorY={0} />);
    await waitFor(() => expect(row("sandbox")).toBe("inside the agent sandbox"));
    expect(invoke).toHaveBeenCalledWith("agent_tab_features", { id: "p1:agent-1" });
    expect(row("MCP")).toBe("app-help, app-git, docs, kicad");
    const state = (name: string) =>
      [...document.querySelectorAll(".tab-popup-mcp")].find((el) => el.textContent === name)?.className;
    expect(state("docs")).toBe("tab-popup-mcp on");
    expect(state("kicad")).toBe("tab-popup-mcp off");
    expect(row("skills")).toBe("a, b, c, d, e, f +2 more");
    expect(row("API key")).toBe("Anthropic — stored key, through the proxy");
  });

  it("shows no feature rows for a tab the backend knows nothing of", async () => {
    render(<TabHoverCard tab={tab({})} scope="p1" anchorX={0} anchorY={0} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("agent_tab_features", { id: "p1:agent-1" }));
    expect(row("sandbox")).toBeNull();
    expect(row("MCP")).toBeNull();
  });

  it("does not ask for a non-agent tab", () => {
    render(<TabHoverCard tab={tab({ kind: "shell", cmd: "" })} scope="p1" anchorX={0} anchorY={0} />);
    expect(invoke).not.toHaveBeenCalledWith("agent_tab_features", expect.anything());
  });
});
