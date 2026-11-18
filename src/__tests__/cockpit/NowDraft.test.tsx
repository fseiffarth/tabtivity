/**
 * F3 (`docs/cockpit_followup_handoff.md`): under 820 px Now's detail pane
 * unmounts, and the Reader's composer with it. Its unsent text must still be
 * there when the pane is back, whether the window went wide -> narrow -> wide
 * or the user stepped list -> detail -> list -> detail. The draft is the
 * Reader's own per-tab memory (`lib/agents/readerDrafts`); the stand-in below
 * mounts the REAL composer (`TerminalReaderView`) where `TabPane` would.
 */
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn((cmd: string, _args?: unknown) => {
  if (cmd === "root_mcp_status") return Promise.resolve({ running: true, tools: [] });
  if (cmd === "agent_tab_transcript") return Promise.resolve({ available: true, version: "v1", truncated: false, entries: [] });
  return Promise.resolve([]);
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn(() => Promise.resolve()) }));
vi.mock("../../components/tabs/TabPane", async () => {
  const { TerminalReaderView } = await import("../../components/terminal/TerminalReaderView");
  return {
    TabPane: (props: { tab: { key: string }; scope: string }) => {
      const [host, setHost] = useState<HTMLElement | null>(null);
      return (
        <div ref={setHost} data-testid={`attached-${props.tab.key}`}>
          {host && (
            <TerminalReaderView
              host={host}
              ptyId={`${props.scope}:${props.tab.key}`}
              scope={props.scope}
              tabKey={props.tab.key}
              cwd="/p"
              visible
              focused
            />
          )}
        </div>
      );
    },
  };
});
vi.mock("../../lib/shortcuts/tabJump", () => ({ jumpToTab: vi.fn(), openPromptChartTab: vi.fn() }));

import { CockpitNow } from "../../components/cockpit/CockpitNow";
import { readerDraft, setReaderDraft } from "../../lib/agents/readerDrafts";
import { FrameBandContext, type FrameBand } from "../../lib/window/frameBand";
import { useActivityStore } from "../../stores/activity";
import { useBoxesStore } from "../../stores/boxes";
import { useCockpitStore } from "../../stores/cockpit";
import { useOverlayAgentStore } from "../../stores/overlayAgent";
import { useProjectsStore } from "../../stores/projects";
import { useRootReviewStore } from "../../stores/rootReview";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { useAgentModelsStore } from "../../stores/agents/agentModels";
import type { ProjectEntry } from "../../types";

const agent = (key: string, label = key): TabEntry => ({ key, label, cmd: "claude", cwd: "/p", kind: "agent" });
const project = (id: string): ProjectEntry =>
  ({ id, name: id.toUpperCase(), status: "active", position: 1, local_file: `/${id}/project.json` }) as ProjectEntry;

beforeEach(() => {
  cleanup();
  localStorage.clear();
  setReaderDraft("p2", "b", "");
  useProjectsStore.setState({ projects: [project("p1"), project("p2")], activeId: "p1", rootDir: "/r" });
  useBoxesStore.setState({ boxes: [] });
  useTabsStore.setState({
    scope: "p1",
    tabsByScope: { p1: [agent("a", "alpha")], p2: [agent("b", "beta")], root: [] },
    layoutByScope: {},
    focusedGroupByScope: {},
    detachedGroupsByScope: {},
  });
  useActivityStore.setState({ busyByTab: {}, attentionByTab: { "p2:b": "decision" }, lastDoneByTab: {}, lastWorkingByTab: {} });
  useAgentModelsStore.setState({ refresh: vi.fn(() => Promise.resolve()), refreshScreen: vi.fn(() => Promise.resolve()) });
  useRootReviewStore.setState({ proposals: [], imports: [], refresh: vi.fn(() => Promise.resolve()) });
  useOverlayAgentStore.setState({ scopeShownKeys: new Set() });
  useCockpitStore.setState({ selected: "p2:b", stateFilter: "all", query: "", rosterMode: "flat", boxFilter: null, scopeFilter: null });
});
afterEach(() => cleanup());

const view = (band: FrameBand) => (
  <FrameBandContext.Provider value={band}>
    <CockpitNow />
  </FrameBandContext.Provider>
);
const composer = () => screen.getByRole("textbox") as HTMLTextAreaElement;
const settle = () => act(async () => {});

describe("the detail composer's draft across the narrow band's unmount", () => {
  it("wide -> narrow -> wide: the unsent text is still in the composer", async () => {
    const { rerender } = render(view("wide"));
    await settle();
    fireEvent.change(composer(), { target: { value: "not sent yet" } });
    expect(readerDraft("p2", "b")).toBe("not sent yet");

    rerender(view("narrow"));
    await settle();
    expect(document.querySelector(".cockpit-now-detail")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();

    rerender(view("wide"));
    await settle();
    expect(composer().value).toBe("not sent yet");
  });

  it("narrow: list -> detail -> back -> detail keeps the draft", async () => {
    render(view("narrow"));
    await settle();
    await act(async () => void fireEvent.click(document.querySelector('[data-pty="p2:b"]')!));
    fireEvent.change(composer(), { target: { value: "half a thought" } });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Agents" })));
    expect(screen.queryByRole("textbox")).toBeNull();
    await act(async () => void fireEvent.click(document.querySelector('[data-pty="p2:b"]')!));
    expect(composer().value).toBe("half a thought");
  });
});
