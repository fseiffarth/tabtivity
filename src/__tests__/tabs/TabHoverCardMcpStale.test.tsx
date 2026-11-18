/**
 * The tab hover card of an agent tab whose Tabtivity tools went dead on a
 * reattach (`agent_tab_features` → `appMcpStale`): it says so in its own row,
 * and lists no Tabtivity server as live.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((_cmd: string, _args?: unknown): Promise<unknown> => Promise.resolve(null));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invoke(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(() => Promise.resolve()),
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

import { TabHoverCard, _clearKnownFeaturesForTest } from "../../components/tabs/TabHoverCard";
import type { TabEntry } from "../../stores/tabs";
import { BRAND } from "../../lib/brand";

const tab = { key: "agent-1", label: "Claude", cmd: "claude", cwd: "/p", kind: "agent" } as TabEntry;

function row(label: string): string | null {
  const rows = [...document.querySelectorAll(".tab-popup .pill-popup-path-row")];
  const hit = rows.find((r) => r.querySelector(".pill-popup-path-label")?.textContent?.startsWith(label));
  return hit?.querySelector(".tab-popup-meta")?.textContent ?? null;
}

afterEach(() => {
  cleanup();
  _clearKnownFeaturesForTest();
  invoke.mockReset();
});

describe("tab hover card of a stale agent tab", () => {
  it("says its app tools are disconnected", async () => {
    invoke.mockImplementation((cmd) =>
      Promise.resolve(
        cmd === "agent_tab_features"
          ? { sandbox: "fenced", appMcp: [], appMcpStale: true, ownMcp: ["docs"], skills: [], apiKeys: [] }
          : null,
      ),
    );
    render(<TabHoverCard tab={tab} scope="p1" anchorX={0} anchorY={0} />);
    await waitFor(() => expect(row(`${BRAND.display} tools`)).toContain("disconnected — reconnect from the tab"));
    expect(row("MCP")).toBe("docs");
  });

  it("has no such row for a live tab", async () => {
    invoke.mockImplementation((cmd) =>
      Promise.resolve(
        cmd === "agent_tab_features"
          ? { sandbox: "fenced", appMcp: ["app-help"], ownMcp: [], skills: [], apiKeys: [] }
          : null,
      ),
    );
    render(<TabHoverCard tab={tab} scope="p1" anchorX={0} anchorY={0} />);
    await waitFor(() => expect(row("MCP")).toBe("app-help"));
    expect(row(`${BRAND.display} tools`)).toBeNull();
  });
});
