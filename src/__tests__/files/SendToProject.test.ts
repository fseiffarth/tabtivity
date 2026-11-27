import { beforeEach, describe, expect, it } from "vitest";
import { destLabelFor, destRootFor, loadLastSendTarget, saveLastSendTarget } from "../../lib/projects/sendToProject";
import { storageKey } from "../../lib/brand";
import type { ProjectEntry, RemoteSpec } from "../../types";

describe("sendToProject memory", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("returns null when nothing has been sent yet", () => {
    expect(loadLastSendTarget()).toBeNull();
  });

  it("round-trips a saved destination", () => {
    saveLastSendTarget({ projectId: "abc", destRel: "data/raw" });
    expect(loadLastSendTarget()).toEqual({ projectId: "abc", destRel: "data/raw" });
  });

  it("remembers the project root (empty rel)", () => {
    saveLastSendTarget({ projectId: "abc", destRel: "" });
    expect(loadLastSendTarget()).toEqual({ projectId: "abc", destRel: "" });
  });

  it("treats a malformed stored value as no memory", () => {
    localStorage.setItem(storageKey("sendToProject.last"), "{not json");
    expect(loadLastSendTarget()).toBeNull();
  });

  it("treats a wrong-shaped stored value as no memory", () => {
    localStorage.setItem(storageKey("sendToProject.last"), JSON.stringify({ projectId: 7 }));
    expect(loadLastSendTarget()).toBeNull();
  });
});

describe("sendToProject destination", () => {
  const ssh: RemoteSpec = { host: "box.example", user: "u", remote_path: "/home/u/work" } as RemoteSpec;
  const project = (over: Partial<ProjectEntry>): ProjectEntry =>
    ({ id: "p", name: "P", local_file: "", directory: "/state/remote-projects/p", ...over }) as ProjectEntry;

  it("a local project is its own directory", () => {
    const p = project({ directory: "/home/me/proj" });
    expect(destRootFor(p)).toBe("/home/me/proj");
    expect(destLabelFor(p)).toBe("/home/me/proj");
  });

  it("a remote-only project is its stored directory, labelled by its host", () => {
    const p = project({ remote: { ...ssh, remote_only: true } });
    expect(destRootFor(p)).toBe("/state/remote-projects/p");
    expect(destLabelFor(p)).toBe("u@box.example:/home/u/work");
  });

  it("a VM project goes to its host too", () => {
    const p = project({ remote: { ...ssh, vm: true } });
    expect(destRootFor(p)).toBe("/state/remote-projects/p");
  });

  it("a mirrored remote project copies into its mirror, and one without a mirror is disabled", () => {
    expect(destRootFor(project({ remote: ssh, mirror: "/home/me/mirror" } as Partial<ProjectEntry>))).toBe("/home/me/mirror");
    expect(destRootFor(project({ remote: ssh }))).toBe("");
  });
});
