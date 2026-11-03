/**
 * The Projects view (C4): a project not restored this session says "not
 * open", shows no agent counts, and is hydrated only by its Restore button;
 * a loaded one shows its counts and opens the Now view narrowed to it.
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
  useCockpitStore.setState({ overlayOpen: true, view: "projects", boxFilter: null, scopeFilter: null });
});
afterEach(() => cleanup());

describe("CockpitProjects", () => {
  it("shows a loaded project's counts and an inactive one as not open", async () => {
    render(<CockpitProjects />);
    await act(async () => {});
    const loaded = screen.getByRole("article", { name: "loaded" });
    expect(loaded.textContent).toContain("1 agents · 1 working");
    const asleep = screen.getByRole("article", { name: "asleep" });
    expect(asleep.textContent).toContain("not open");
    expect(asleep.textContent).not.toMatch(/\d agents/);
  });

  it("hydrates only on Restore, and Agents narrows the Now view", async () => {
    render(<CockpitProjects />);
    await act(async () => {});
    expect(activate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Restore tabs" }));
    expect(activate).toHaveBeenCalledWith("asleep");
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(useCockpitStore.getState()).toMatchObject({ view: "now", scopeFilter: "loaded" });
  });
});
