/**
 * The user-facing project "type" labels/badges. A project's type is the product
 * of two independent axes — the git axis (6 label states: no-git, local, and
 * remote-private/remote-public each forking by GitHub/GitLab provider) and the
 * connection axis (local files vs an SSH host, i.e. `project.remote` set) — for
 * 12 combinations in all. A transient "no scaffold" warning stacks on top as a
 * separate axis. These tests lock the derivation in `projectTypeTags` /
 * `gitTypeLabel` / `providerName` (pure, extracted from `ProjectPill.tsx`).
 */
import { describe, it, expect } from "vitest";

import { providerName, gitTypeLabel, projectTypeTags } from "../../components/projects/projectTypeTags";
import { translate, type TranslationKey } from "../../lib/i18n";

/** These labels live in `lib/i18n` now; the tests assert the English wording, so
 *  they pass the English translator the app passes at render time. */
const t = (key: TranslationKey, vars?: Record<string, string | number>) =>
  translate("en", key, vars);
import { formatRemoteTarget, type ProjectEntry, type RemoteSpec } from "../../types";
import { BRAND } from "../../lib/brand";

const SSH: RemoteSpec = { user: "ada", host: "box.example", remote_path: "/srv/app" };

/** Minimal entry carrying only the fields the tag logic reads. `git_type` rides
 *  the `[key: string]: unknown` index signature, so it is set via `extra`. */
function entry(extra: Partial<ProjectEntry> & Record<string, unknown> = {}): ProjectEntry {
  return {
    id: "p1",
    name: "Proj",
    status: "inactive",
    position: 0,
    local_file: "proj",
    ...extra,
  };
}

/** Compare only the load-bearing facets of each tag (key/label/color); static
 *  tooltip wording is asserted separately where it carries logic. */
function facets(tags: ReturnType<typeof projectTypeTags>) {
  return tags.map((t) => ({ key: t.key, label: t.label, color: t.color }));
}

const GIT = { key: "git", label: "git", color: "#3fb950" };
const NO_GIT = { key: "git", label: "no git", color: "#8b949e" };
const GITHUB_PUBLIC = { key: "provider", label: "GitHub · public", color: "#a371f7" };
const GITHUB_PRIVATE = { key: "provider", label: "GitHub · private", color: "#a371f7" };
const GITLAB_PUBLIC = { key: "provider", label: "GitLab · public", color: "#fc6d26" };
const GITLAB_PRIVATE = { key: "provider", label: "GitLab · private", color: "#fc6d26" };
const SSH_TAG = { key: "ssh", label: "SSH", color: "#58a6ff" };

/** The 6 git-label states, each as (git_type, git_provider) → expected git-axis
 *  tag facets (before the connection axis is layered on). */
const GIT_STATES: Array<{ name: string; extra: Record<string, unknown>; tags: typeof GIT[] }> = [
  { name: "no git", extra: { git_type: "none" }, tags: [NO_GIT] },
  { name: "local", extra: { git_type: "local" }, tags: [GIT] },
  { name: "remote-private · GitHub", extra: { git_type: "remote-private", git_provider: "github" }, tags: [GIT, GITHUB_PRIVATE] },
  { name: "remote-private · GitLab", extra: { git_type: "remote-private", git_provider: "gitlab" }, tags: [GIT, GITLAB_PRIVATE] },
  { name: "remote-public · GitHub", extra: { git_type: "remote-public", git_provider: "github" }, tags: [GIT, GITHUB_PUBLIC] },
  { name: "remote-public · GitLab", extra: { git_type: "remote-public", git_provider: "gitlab" }, tags: [GIT, GITLAB_PUBLIC] },
];

describe("projectTypeTags — the 12 project combinations", () => {
  for (const state of GIT_STATES) {
    it(`${state.name} · local files`, () => {
      const tags = projectTypeTags(entry(state.extra), false, t);
      expect(facets(tags)).toEqual(state.tags);
    });

    it(`${state.name} · SSH host`, () => {
      const tags = projectTypeTags(entry({ ...state.extra, remote: SSH }), false, t);
      expect(facets(tags)).toEqual([...state.tags, SSH_TAG]);
      // The SSH tag's title carries the resolved host target.
      const ssh = tags.find((t) => t.key === "ssh");
      expect(ssh?.title).toContain(formatRemoteTarget(SSH));
    });
  }

  it("covers exactly 12 git×connection combinations", () => {
    expect(GIT_STATES.length * 2).toBe(12);
  });
});

describe("projectTypeTags — stacked / edge axes", () => {
  it("adds the amber 'no scaffold' tag when scaffold is missing", () => {
    const tags = projectTypeTags(entry({ git_type: "local" }), true, t);
    expect(facets(tags)).toContainEqual({ key: "scaffold", label: "no scaffold", color: "#d29922" });
  });

  it("stacks all independent axes: public GitHub on an SSH host with missing scaffold", () => {
    const tags = projectTypeTags(
      entry({ git_type: "remote-public", git_provider: "github", remote: SSH }),
      true,
      t,
    );
    expect(facets(tags)).toEqual([
      GIT,
      GITHUB_PUBLIC,
      SSH_TAG,
      { key: "scaffold", label: "no scaffold", color: "#d29922" },
    ]);
  });

  it("defaults a non-string git_type to a local repo", () => {
    const tags = projectTypeTags(entry({ git_type: 42 }), false, t);
    expect(facets(tags)).toEqual([GIT]);
  });

  it("defaults missing git_type to a local repo", () => {
    expect(facets(projectTypeTags(entry(), false, t))).toEqual([GIT]);
  });

  it("treats a published project with no recorded provider as GitHub", () => {
    const tags = projectTypeTags(entry({ git_type: "remote-public" }), false, t);
    expect(facets(tags)).toEqual([GIT, GITHUB_PUBLIC]);
  });

  it("shows the origin address in the provider tag's tooltip", () => {
    const url = "git@github.com:owner/repo.git";
    const detected = projectTypeTags(
      entry({ detected_provider: "github", git_origin_url: url }),
      false,
      t,
    ).find((tag) => tag.key === "provider");
    expect(detected?.title.split("\n")).toEqual([
      `origin on GitHub (detected — not published via ${BRAND.display})`,
      url,
    ]);
    const published = projectTypeTags(
      entry({ git_type: "remote-private", git_provider: "github", git_origin_url: url }),
      false,
      t,
    ).find((tag) => tag.key === "provider");
    expect(published?.title).toBe(`GitHub · private\n${url}`);
    // No sniffed origin → the tooltip stays the bare summary line.
    const bare = projectTypeTags(entry({ git_type: "remote-public" }), false, t).find(
      (tag) => tag.key === "provider",
    );
    expect(bare?.title).toBe("GitHub · public");
  });
});

describe("gitTypeLabel", () => {
  it("labels remote states with provider · visibility", () => {
    expect(gitTypeLabel("remote-public", "github", t)).toBe("GitHub · public");
    expect(gitTypeLabel("remote-public", "gitlab", t)).toBe("GitLab · public");
    expect(gitTypeLabel("remote-private", "github", t)).toBe("GitHub · private");
    expect(gitTypeLabel("remote-private", "gitlab", t)).toBe("GitLab · private");
  });

  it("labels the no-git and local states", () => {
    expect(gitTypeLabel("none", undefined, t)).toBe("No git (no repo)");
    expect(gitTypeLabel("local", undefined, t)).toBe("Local repo (not pushed)");
  });

  it("falls through unknown/undefined git_type to the local-repo label", () => {
    expect(gitTypeLabel(undefined, undefined, t)).toBe("Local repo (not pushed)");
    expect(gitTypeLabel("weird", undefined, t)).toBe("Local repo (not pushed)");
  });
});

describe("providerName", () => {
  it("returns GitLab only for the gitlab id, GitHub otherwise", () => {
    expect(providerName("gitlab")).toBe("GitLab");
    expect(providerName("github")).toBe("GitHub");
    expect(providerName(undefined)).toBe("GitHub");
  });
});
