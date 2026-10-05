import { beforeEach, describe, expect, it } from "vitest";
import { loadLastSendTarget, saveLastSendTarget } from "../../lib/projects/sendToProject";
import { storageKey } from "../../lib/brand";

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
