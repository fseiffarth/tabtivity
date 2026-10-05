import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

/** Load the module under a brand whose folder names did (or did not) change. */
async function load(renamed: boolean) {
  vi.resetModules();
  vi.doMock("../../lib/brand", () => ({
    NAMES: { screenshotsDir: renamed ? "new-screenshots" : "old-screenshots", emailsDir: "old-emails" },
    LEGACY_NAMES: { screenshotsDir: "old-screenshots", emailsDir: "old-emails" },
  }));
  return import("../../lib/generatedDir");
}

describe("generatedDirName", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("asks nothing while the name is unchanged", async () => {
    const { generatedDirName } = await load(false);
    expect(await generatedDirName("/p", "screenshots")).toBe("old-screenshots");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("takes the folder the project already has after a rename", async () => {
    const { generatedDirName } = await load(true);
    invoke.mockResolvedValue("old-screenshots");
    expect(await generatedDirName("/p", "screenshots")).toBe("old-screenshots");
    expect(invoke).toHaveBeenCalledWith("project_generated_dir", { projectDir: "/p", kind: "screenshots" });
    // The emails folder kept its name in this brand: no question.
    invoke.mockClear();
    expect(await generatedDirName("/p", "emails")).toBe("old-emails");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("falls back to the current name without a directory or an answer", async () => {
    const { generatedDirName } = await load(true);
    expect(await generatedDirName("", "screenshots")).toBe("new-screenshots");
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockRejectedValue(new Error("unknown command"));
    expect(await generatedDirName("/p", "screenshots")).toBe("new-screenshots");
  });
});
