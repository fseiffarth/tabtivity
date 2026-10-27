import { describe, expect, it } from "vitest";
import {
  isCloneUrl,
  providerFromCloneUrl,
  repoNameFromCloneUrl,
  sanitizeName,
} from "../../lib/projects/scaffold";

// The import dialog's "GitHub / GitLab repository (clone)" source. `isCloneUrl`
// gates the Import button; the backend's `validate_clone_url` is the real guard
// and these cases are kept in step with its Rust tests.
describe("clone URL validation", () => {
  it("accepts the supported URL forms", () => {
    for (const url of [
      "https://github.com/owner/repo.git",
      "https://gitlab.com/group/sub/repo",
      "http://git.internal/owner/repo.git",
      "ssh://git@github.com:22/owner/repo.git",
      "git://git.internal/repo.git",
      "git@github.com:owner/repo.git",
      "gitlab.com:group/repo.git",
      "  https://github.com/owner/repo.git  ",
    ]) {
      expect(isCloneUrl(url), url).toBe(true);
    }
  });

  it("rejects everything else", () => {
    for (const url of [
      "",
      "   ",
      // git's transport-helper form: `ext::<command>` RUNS the command.
      "ext::sh -c 'touch /tmp/pwned'",
      "file:///etc",
      "/etc/passwd",
      "../repo",
      "github.com/owner/repo",
      "--upload-pack=x:y",
    ]) {
      expect(isCloneUrl(url), url).toBe(false);
    }
  });
});

describe("project name from a clone URL", () => {
  it("takes the repository's own name, without .git", () => {
    expect(repoNameFromCloneUrl("https://github.com/owner/my-repo.git")).toBe("my-repo");
    expect(repoNameFromCloneUrl("https://gitlab.com/group/sub/my-repo")).toBe("my-repo");
    expect(repoNameFromCloneUrl("git@github.com:owner/my-repo.git")).toBe("my-repo");
    // A trailing slash (copied from the browser's address bar) is not a segment.
    expect(repoNameFromCloneUrl("https://github.com/owner/my-repo/")).toBe("my-repo");
    // scp-like with no path separator: the repo is the whole path.
    expect(repoNameFromCloneUrl("git@host:repo.git")).toBe("repo");
  });

  it("yields nothing name-like for an empty URL", () => {
    expect(repoNameFromCloneUrl("")).toBe("");
    expect(repoNameFromCloneUrl("   ")).toBe("");
  });

  it("survives sanitizing into the destination folder name", () => {
    // The clone lands at `<location>/<sanitizeName(name)>`, so a repo name with
    // characters the project-name sanitizer strips must still yield a folder.
    expect(sanitizeName(repoNameFromCloneUrl("https://github.com/owner/My.Repo.git"))).toBe("my-repo");
  });
});

// The "fork, then clone" import source: a fork is made by the provider's own CLI
// (`gh`/`glab`), so which provider a URL belongs to decides which binary runs.
// Twin of `provider_from_host` in `commands/git_fork.rs`.
describe("provider from a clone URL", () => {
  it("reads the provider off a host that names itself", () => {
    expect(providerFromCloneUrl("https://github.com/owner/repo.git")).toBe("github");
    expect(providerFromCloneUrl("git@github.com:owner/repo.git")).toBe("github");
    expect(providerFromCloneUrl("https://gitlab.com/group/sub/repo")).toBe("gitlab");
    expect(providerFromCloneUrl("ssh://git@gitlab.example.org:2222/owner/repo.git")).toBe("gitlab");
    // Userinfo and port are not part of the host.
    expect(providerFromCloneUrl("https://user@github.com:8443/owner/repo")).toBe("github");
  });

  it("says nothing for a host that does not name itself", () => {
    // A self-hosted instance — the dialog then asks which it is rather than
    // guessing a CLI.
    expect(providerFromCloneUrl("https://git.internal/owner/repo.git")).toBe("");
    expect(providerFromCloneUrl("")).toBe("");
  });
});
