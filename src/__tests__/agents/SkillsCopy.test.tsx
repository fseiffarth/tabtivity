/**
 * Copying installed skills between projects (Skills Library · Installed):
 * "Copy to…" on a card copies into any ticked project or the personal scope,
 * and the "From" switch lists another project's skills with "Copy here". A
 * destination that already holds the skill is overwritten only where the
 * user was shown that it is there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useProjectsStore } from "../../stores/projects";
import type { ProjectEntry } from "../../types";

const { skills } = vi.hoisted(() => ({
  skills: {
    PERSONAL_SKILLS: { kind: "personal" },
    projectSkills: (dir: string) => ({ kind: "project", dir }),
    listSkillSources: vi.fn(async () => []),
    listSkillCatalog: vi.fn(async () => []),
    getSkillDetail: vi.fn(),
    listInstalledSkills: vi.fn(),
    addSkillSource: vi.fn(),
    removeSkillSource: vi.fn(),
    refreshSkillSource: vi.fn(),
    installSkill: vi.fn(),
    uninstallSkill: vi.fn(),
    copyInstalledSkill: vi.fn(async () => undefined),
  },
}));
vi.mock("../../lib/agents/skills", () => skills);
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { SkillsLibraryView } from "../../components/skills/SkillsLibraryView";

const skill = (folder: string, name = folder) => ({ name, description: `${name} desc`, folder });

/** What each target's `.claude/skills` holds. */
const disk: Record<string, ReturnType<typeof skill>[]> = {
  "/a": [skill("pdf-fill")],
  "/b": [skill("pdf-fill")],
  "/c": [skill("lint"), skill("pdf-fill")],
  personal: [],
};

function project(id: string, name: string, directory: string, extra: Partial<ProjectEntry> = {}): ProjectEntry {
  return { id, name, directory, local_file: `${directory}/project.json`, status: "", position: 0, ...extra } as ProjectEntry;
}

beforeEach(() => {
  vi.clearAllMocks();
  skills.listInstalledSkills.mockImplementation(async (t: { kind: string; dir?: string }) =>
    t.kind === "personal" ? disk.personal : (disk[t.dir ?? ""] ?? []),
  );
  useProjectsStore.setState({
    projects: [
      project("a", "Alpha", "/a"),
      project("b", "Beta", "/b"),
      project("c", "Gamma", "/c"),
      project("vm", "Pinned", "/vm", { vm: { enabled: true } } as Partial<ProjectEntry>),
    ],
  });
});

async function openInstalled() {
  render(<SkillsLibraryView projectDir="/a" />);
  fireEvent.click(screen.getByRole("button", { name: /^Installed/ }));
  await screen.findByText("pdf-fill");
}

describe("Copy to…", () => {
  it("offers the personal scope and the other local projects, never this one or a host-pinned one", async () => {
    await openInstalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy to…" }));
    const list = await screen.findByRole("list", { name: "Copy to…" });
    const labels = within(list).getAllByRole("checkbox").map((b) => b.closest("label")?.textContent);
    expect(labels).toEqual(["All projects", "Beta", "Gamma"]);
  });

  it("copies into every ticked destination, overwriting only where it showed the skill is there", async () => {
    await openInstalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy to…" }));
    const list = await screen.findByRole("list", { name: "Copy to…" });
    // Beta and Gamma already hold pdf-fill; the personal scope does not.
    await waitFor(() => expect(within(list).getAllByText(/will be overwritten/)).toHaveLength(2));
    fireEvent.click(within(list).getByLabelText("All projects"));
    fireEvent.click(within(list).getByLabelText("Beta"));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(skills.copyInstalledSkill).toHaveBeenCalledTimes(2));
    const from = { kind: "project", dir: "/a" };
    expect(skills.copyInstalledSkill).toHaveBeenCalledWith(from, "pdf-fill", { kind: "personal" }, false);
    expect(skills.copyInstalledSkill).toHaveBeenCalledWith(from, "pdf-fill", { kind: "project", dir: "/b" }, true);
    await waitFor(() => expect(screen.queryByRole("list", { name: "Copy to…" })).toBeNull());
  });

  it("keeps a failed destination ticked with its error, and the dialog open", async () => {
    skills.copyInstalledSkill.mockRejectedValueOnce("'pdf-fill' is already installed there");
    await openInstalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy to…" }));
    const list = await screen.findByRole("list", { name: "Copy to…" });
    fireEvent.click(within(list).getByLabelText("All projects"));
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect((await screen.findByRole("alert")).textContent).toContain("already installed there");
    expect((within(list).getByLabelText("All projects") as HTMLInputElement).checked).toBe(true);
  });
});

describe("From another project", () => {
  it("lists that project's skills and copies one here, asking before an overwrite", async () => {
    await openInstalled();
    fireEvent.change(screen.getByRole("combobox", { name: "Skills of" }), { target: { value: "c" } });
    await screen.findByText("lint");
    const cards = screen.getAllByRole("button", { name: "Copy here" });
    expect(cards).toHaveLength(2);

    // `lint` is new here: copied straight away, without overwrite.
    fireEvent.click(cards[0]);
    await waitFor(() =>
      expect(skills.copyInstalledSkill).toHaveBeenCalledWith(
        { kind: "project", dir: "/c" },
        "lint",
        { kind: "project", dir: "/a" },
        false,
      ),
    );

    // `pdf-fill` is already installed here: a confirm first, then overwrite.
    fireEvent.click(cards[1]);
    const confirm = await screen.findByRole("dialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Copy here" }));
    await waitFor(() =>
      expect(skills.copyInstalledSkill).toHaveBeenLastCalledWith(
        { kind: "project", dir: "/c" },
        "pdf-fill",
        { kind: "project", dir: "/a" },
        true,
      ),
    );
  });
});
