/**
 * The Projects view (C4, compact rows): a project not restored this session is
 * folded into its box's "Not open" line, shows no agent counts, and is hydrated
 * only by Restore; a loaded one has a row with its counts and opens the Now
 * view narrowed to it.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve(0)) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})), emit: vi.fn() }));

import { CockpitProjects } from "../../components/cockpit/CockpitProjects";
import { useProjectsStore } from "../../stores/projects";
import { useTabsStore } from "../../stores/tabs";
import { useBoxesStore } from "../../stores/boxes";
import { useCockpitStore } from "../../stores/cockpit";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { useActivityStore } from "../../stores/activity";
import type { ProjectEntry } from "../../types";

const project = (id: string, status: string): ProjectEntry => ({ id, name: id, status, position: 1, local_file: `/${id}/p.json` }) as ProjectEntry;
let activate: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;

beforeEach(() => {
  activate = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
  useProjectsStore.setState({ projects: [project("loaded", "active"), project("asleep", "inactive")], activateProject: activate });
  useTabsStore.setState({ tabsByScope: { loaded: [{ key: "a", label: "a", cmd: "claude", cwd: "/", kind: "agent" }] } });
  useBoxesStore.setState({ boxes: [] });
  useActivityStore.setState({ busyByTab: { "loaded:a": true }, attentionByTab: {}, lastDoneByTab: {}, lastWorkingByTab: {} });
  useRootOverlayStore.setState({ open: true, view: "projects" });
  useCockpitStore.setState({ boxFilter: null, scopeFilter: null });
});
afterEach(() => cleanup());

describe("CockpitProjects", () => {
  it("gives a loaded project a compact row with its counts and folds a not-open one into the Not open line", async () => {
    render(<CockpitProjects />);
    await act(async () => {});
    const loaded = screen.getByRole("listitem", { name: "loaded" });
    expect(loaded.textContent).toContain("1 working");
    expect(loaded.textContent).toContain("1 agents");
    expect(screen.queryByRole("listitem", { name: "asleep" })).toBeNull();
    const fold = document.querySelector(".cockpit-pfold")!;
    expect(fold.textContent).toContain("Not open · 1");
    expect(fold.textContent).toContain("asleep");
    expect(fold.textContent).not.toMatch(/\d agents/);
    expect(document.querySelector(".cockpit-ptoolbar")?.textContent).toContain("2 projects · 1 open · 1 working");
  });

  it("opens a project on a click of its row, and a not-open one from the fold", async () => {
    const setActive = vi.fn<(id: string | null) => Promise<void>>(() => Promise.resolve());
    useProjectsStore.setState({ setActive });
    render(<CockpitProjects />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("listitem", { name: "loaded" }));
    expect(setActive).toHaveBeenLastCalledWith("loaded");
    fireEvent.click(screen.getByRole("button", { name: "asleep" }));
    expect(setActive).toHaveBeenLastCalledWith("asleep");
    expect(activate).not.toHaveBeenCalled();
  });

  it("hydrates only on Restore (the fold button's menu), and Agents narrows the Now view", async () => {
    render(<CockpitProjects />);
    await act(async () => {});
    expect(activate).not.toHaveBeenCalled();
    fireEvent.contextMenu(screen.getByRole("button", { name: "asleep" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Restore tabs" }));
    expect(activate).toHaveBeenCalledWith("asleep");
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(useCockpitStore.getState()).toMatchObject({ scopeFilter: "loaded" });
    expect(useRootOverlayStore.getState().view).toBe("now");
  });

  it("filters the rows and the fold by name", async () => {
    render(<CockpitProjects />);
    await act(async () => {});
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter projects" }), { target: { value: "asl" } });
    expect(screen.queryByRole("listitem", { name: "loaded" })).toBeNull();
    expect(screen.getByRole("button", { name: "asleep" })).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter projects" }), { target: { value: "zzz" } });
    expect(screen.getByText("No project matches.")).toBeTruthy();
  });
});
