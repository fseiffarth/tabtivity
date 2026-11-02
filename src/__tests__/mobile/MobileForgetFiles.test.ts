/**
 * What `forgetDeviceData` itself does to the files library's stores: the
 * app-level test mocks it, so a store left out of it would pass there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordRecent, rememberFilesPlace, setFolderColor, toggleFavorite } from "../../../mobile-web/src/filesPlace";
import { forgetDeviceData } from "../../../mobile-web/src/forgetDeviceData";

vi.mock("../../../mobile-web/src/thumbs", () => ({ forgetCovers: vi.fn(async () => undefined) }));
vi.mock("../../../mobile-web/src/markup/store", () => ({ forgetLayers: vi.fn(async () => true) }));

describe("forgetDeviceData", () => {
  beforeEach(() => localStorage.clear());

  it("leaves no name of the desktop's files in this phone's storage", async () => {
    const saved = { kind: "text/plain", name: "thesis-draft.tex", token: "t1", trail: [{ token: "t2", name: "secret-grant" }] };
    toggleFavorite("p1", saved);
    recordRecent("p1", { ...saved, size: 1, modified: 1 });
    setFolderColor("p1", "secret-grant", "green");
    rememberFilesPlace("p1", saved.trail);
    expect(JSON.stringify({ ...localStorage })).toContain("secret-grant");

    await forgetDeviceData();

    const left = JSON.stringify({ ...localStorage });
    expect(left).not.toContain("secret-grant");
    expect(left).not.toContain("thesis-draft");
  });
});
