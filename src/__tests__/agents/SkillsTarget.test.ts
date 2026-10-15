import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Skills Library's **install target** (`docs/skills_plan.md`) — the one
 * thing about the feature that is scoped at all, since the sources and their
 * cached clones are machine state shared by every project.
 *
 * What is pinned down here is the boundary rather than the plumbing. The
 * personal scope (the agent-global layer's `.claude/skills/`, laid into every
 * agent home on this machine — the widest-reaching destination in the app) is
 * addressed by a variant that carries **no path**: the backend resolves it
 * itself. If this side ever grew a way to
 * spell the personal scope as a project directory — a home path threaded into
 * `{ kind: "project" }` — the split would be decoration, so the tests below
 * assert on the *shape* that crosses the IPC boundary and not merely on the
 * command name.
 */

const invoked: Array<{ cmd: string; args: Record<string, unknown> }> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((cmd: string, args: Record<string, unknown>) => {
    invoked.push({ cmd, args });
    return Promise.resolve(undefined);
  }),
}));

import {
  PERSONAL_SKILLS,
  installSkill,
  listInstalledSkills,
  projectSkills,
  uninstallSkill,
} from "../../lib/agents/skills";

beforeEach(() => {
  invoked.length = 0;
});

describe("skill install targets", () => {
  it("names the personal scope without naming a path", () => {
    // The whole point: no field to put a directory in, so no call site can aim
    // it. A `dir` appearing here would mean the frontend had started deciding
    // where home is.
    expect(PERSONAL_SKILLS).toEqual({ kind: "personal" });
    expect(Object.keys(PERSONAL_SKILLS)).toEqual(["kind"]);
  });

  it("is frozen, so a caller cannot mutate the shared constant into a path", () => {
    // It is exported as one object rather than minted per call, which is only
    // safe if nobody can write to it — a mutated constant would retarget every
    // later personal install in the session.
    expect(Object.isFrozen(PERSONAL_SKILLS)).toBe(true);
    expect(() => {
      (PERSONAL_SKILLS as unknown as Record<string, unknown>).dir = "/tmp/elsewhere";
    }).toThrow();
    expect(PERSONAL_SKILLS).toEqual({ kind: "personal" });
  });

  it("passes the target through install/uninstall/list verbatim", async () => {
    const target = projectSkills("/home/u/proj");
    await installSkill(target, "anthropic", "document-skills/pdf");
    await uninstallSkill(target, "pdf");
    await listInstalledSkills(target);

    expect(invoked.map((c) => c.cmd)).toEqual([
      "skills_install",
      "skills_uninstall",
      "skills_list_installed",
    ]);
    for (const call of invoked) {
      expect(call.args.target).toEqual({ kind: "project", dir: "/home/u/proj" });
      // No stray path argument beside the target — `project_dir` was the old
      // parameter and a leftover one would be a second, unchecked destination.
      expect(call.args.projectDir).toBeUndefined();
    }
  });

  it("sends the personal target for a personal install", async () => {
    await installSkill(PERSONAL_SKILLS, "anthropic", "document-skills/pdf");
    expect(invoked[0].args.target).toEqual({ kind: "personal" });
  });

  it("keeps project targets distinct per directory", () => {
    // A fresh object per call, so two open surfaces cannot share (and then
    // retarget) one another's destination.
    const a = projectSkills("/a");
    const b = projectSkills("/b");
    expect(a).not.toBe(b);
    expect(a).toEqual({ kind: "project", dir: "/a" });
    expect(b).toEqual({ kind: "project", dir: "/b" });
  });
});
