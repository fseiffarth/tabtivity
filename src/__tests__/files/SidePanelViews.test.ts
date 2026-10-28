/**
 * The one table both doors of the side panel (its view row and the edge rail)
 * read. A host-pinned project (`isHostPinned`: no local mirror) has nothing to
 * diverge from its host, so it gets no Orange view; Sessions stay, since the
 * host's tmux sessions are as real as on any remote project.
 */
import { describe, it, expect } from "vitest";
import {
  availableSidePanelViews,
  sidePanelViewAvailable,
  type SidePanelViewGates,
} from "../../components/files/sidePanelViews";

const REMOTE: SidePanelViewGates = {
  inBox: false,
  projectId: "p1",
  remote: true,
  mirror: true,
  slurm: false,
  remarks: false,
  todo: false,
  assistant: false,
};

describe("side panel views", () => {
  it("a remote project with a mirror offers Orange and Sessions", () => {
    expect(sidePanelViewAvailable("orange", REMOTE)).toBe(true);
    expect(sidePanelViewAvailable("sessions", REMOTE)).toBe(true);
  });

  it("a pinned project offers no Orange view, but keeps Sessions", () => {
    const pinned = { ...REMOTE, mirror: false };
    expect(sidePanelViewAvailable("orange", pinned)).toBe(false);
    expect(sidePanelViewAvailable("sessions", pinned)).toBe(true);
    const views = availableSidePanelViews(pinned).map((d) => d.view);
    expect(views).not.toContain("orange");
    expect(views).toEqual(expect.arrayContaining(["files", "git", "sessions"]));
  });

  it("a local project offers neither, mirror or not", () => {
    const local = { ...REMOTE, remote: false };
    expect(sidePanelViewAvailable("orange", local)).toBe(false);
    expect(sidePanelViewAvailable("sessions", local)).toBe(false);
  });
});
