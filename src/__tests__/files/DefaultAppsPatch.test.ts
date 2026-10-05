/**
 * Default apps are saved per change (headless owner plan, H1b step 7): the
 * dialog and the settings page send what changed, not the whole map, so two
 * clients saving at once keep each other's entries; an older backend still
 * gets the whole map.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { diffDefaultApps, patchDefaultApps } from "../../lib/defaultApps";

describe("default apps patch", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("names what changed between two maps", () => {
    expect(diffDefaultApps({ ".md": "code", ".pdf": "evince" }, { ".md": "vim", ".png": "eog" })).toEqual({
      set: { ".md": "vim", ".png": "eog" },
      remove: [".pdf"],
    });
    expect(diffDefaultApps({ ".md": "code" }, { ".md": "code" })).toEqual({});
  });

  it("sends the patch and answers the stored map", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ".md": "vim", ".pdf": "evince" });
    const stored = await patchDefaultApps({ set: { ".md": "vim" } }, () => ({ ".md": "vim" }));
    expect(invoke).toHaveBeenCalledWith("patch_default_apps", { set: { ".md": "vim" }, remove: [] });
    expect(stored).toEqual({ ".md": "vim", ".pdf": "evince" });
  });

  it("falls back to the whole-document save on a backend without the command", async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error("Command patch_default_apps not found"))
      .mockResolvedValueOnce(undefined);
    const stored = await patchDefaultApps({ remove: [".md"] }, () => ({ ".pdf": "evince" }));
    expect(invoke).toHaveBeenLastCalledWith("save_default_apps", { defaultApps: { ".pdf": "evince" } });
    expect(stored).toEqual({ ".pdf": "evince" });
  });

  it("surfaces any other error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
    await expect(patchDefaultApps({ set: { ".md": "vim" } }, () => ({}))).rejects.toThrow("disk full");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
