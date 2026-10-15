/**
 * The repo's own `.githooks/pre-push` under Tabtivity's agent-push preflight
 * (`TABTIVITY_PUSH_PREFLIGHT=1`, `services::git_push_mcp`): it bumps the version,
 * commits the bump and exits 0 instead of re-pushing and aborting. Run against
 * a throwaway repo whose remote is unreachable, so any push attempt would fail
 * loudly. Skipped where git or jq is missing.
 */
// @ts-expect-error node:child_process has no type declarations in this project (no @types/node)
import { execFileSync, spawnSync } from "node:child_process";
// @ts-expect-error node:fs has no type declarations in this project (no @types/node)
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
// @ts-expect-error node:os has no type declarations in this project (no @types/node)
import { tmpdir } from "node:os";
// @ts-expect-error node:path has no type declarations in this project (no @types/node)
import { dirname, join } from "node:path";
// @ts-expect-error node:url has no type declarations in this project (no @types/node)
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND, envName } from "../../lib/brand";

declare const process: { env: Record<string, string | undefined>; platform: string };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const hasTool = (bin: string) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const lines = (out: string) => out.split("\n").filter(Boolean).sort();

// The hook itself, as tracked in this repo.
const hook = join(repoRoot, ".githooks", "pre-push");
const BUMP_FILES = ["Cargo.lock", "package-lock.json", "package.json", "src-tauri/Cargo.toml", "src-tauri/tauri.conf.json"];

/** An npm v3 lockfile as npm writes it: the root's version twice, and a
 * dependency at the same version that must not move with it. */
const npmLock = (version: string) => JSON.stringify({
  name: "x", version, lockfileVersion: 3, requires: true,
  packages: {
    "": { name: "x", version, dependencies: { dep: "^0.1.2" } },
    "node_modules/dep": { version: "0.1.2", license: "MIT" },
  },
}, null, 2) + "\n";
/** The lockfile's root version, both copies, and the dependency's. */
const lockVersions = (work: string) => {
  const lock = JSON.parse(readFileSync(join(work, "package-lock.json"), "utf8"));
  return [lock.version, lock.packages[""].version, lock.packages["node_modules/dep"].version];
};

/** A throwaway repo at v0.1.2 with two commits; the remote "has" the first. */
function throwawayRepo() {
  const work = mkdtempSync(join(tmpdir(), `${BRAND.slug}-preflight-`));
  git(work, "init", "-q", "-b", "develop");
  mkdirSync(join(work, "scripts"));
  mkdirSync(join(work, "src-tauri"));
  for (const script of ["bump-version.sh", "privacy-check.sh"]) {
    writeFileSync(join(work, "scripts", script), readFileSync(join(repoRoot, "scripts", script)), { mode: 0o755 });
  }
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "x", version: "0.1.2" }, null, 2) + "\n");
  writeFileSync(join(work, "package-lock.json"), npmLock("0.1.2"));
  writeFileSync(join(work, "src-tauri", "Cargo.toml"), `[package]\nname = "${BRAND.slug}"\nversion = "0.1.2"\n`);
  writeFileSync(join(work, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "0.1.2" }, null, 2) + "\n");
  writeFileSync(join(work, "Cargo.lock"), `[[package]]\nname = "${BRAND.slug}"\nversion = "0.1.2"\n`);
  for (const file of BUMP_FILES) chmodSync(join(work, file), 0o644);
  writeFileSync(join(work, "hello.txt"), "hello\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "one");
  const remoteSha = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "hello.txt"), "hello again\n");
  git(work, "commit", "-q", "-am", "two");
  const localSha = git(work, "rev-parse", "HEAD");
  return { work, remoteSha, localSha };
}

/** The hook under the preflight, pushing develop through a nonexistent remote. */
const preflight = (work: string, localSha: string, remoteSha: string) =>
  spawnSync(hook, ["origin", "file:///nonexistent/remote.git"], {
    cwd: work, encoding: "utf8", input: `refs/heads/develop ${localSha} refs/heads/develop ${remoteSha}\n`,
    env: { ...env, [envName("PUSH_PREFLIGHT")]: "1", [envName("SKIP_PRIVACY_CHECK")]: "1", GIT_TERMINAL_PROMPT: "0" },
  });

describe.skipIf(process.platform === "win32" || !hasTool("git") || !hasTool("jq"))(`pre-push under ${BRAND.envPrefix}PUSH_PREFLIGHT`, () => {
  it("bumps, commits, exits 0 and never pushes", () => {
    const { work, remoteSha, localSha } = throwawayRepo();
    expect(existsSync(hook)).toBe(true);
    const run = preflight(work, localSha, remoteSha);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain(`${BRAND.display}'s transport carries the bump`);
    expect(run.stderr).not.toContain("failed to push");
    expect(git(work, "log", "-1", "--format=%s")).toBe("chore: bump version to v0.1.3");
    expect(JSON.parse(readFileSync(join(work, "package.json"), "utf8")).version).toBe("0.1.3");
    // The lockfile's root moves with it, in place (npm's own formatting kept),
    // and the bump commit carries it.
    expect(lockVersions(work)).toEqual(["0.1.3", "0.1.3", "0.1.2"]);
    expect(readFileSync(join(work, "package-lock.json"), "utf8")).toBe(npmLock("0.1.3"));
    expect(lines(git(work, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"))).toEqual(BUMP_FILES);
    // Rewritten in place: a bump never leaves a version file owner-only.
    for (const file of BUMP_FILES) expect((statSync(join(work, file)).mode & 0o777).toString(8), file).toBe("644");
    expect(git(work, "status", "--porcelain")).toBe("");
    // Without the variable the hook still re-pushes itself (and aborts the
    // original push): with a remote that "has" the same version it bumps
    // again and the re-push to the unreachable remote fails.
    const bumped = git(work, "rev-parse", "HEAD");
    const plain = spawnSync(hook, ["origin", "file:///nonexistent/remote.git"], {
      cwd: work, encoding: "utf8", input: `refs/heads/develop ${bumped} refs/heads/develop ${bumped}\n`,
      env: { ...env, [envName("SKIP_PRIVACY_CHECK")]: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    expect(plain.status).not.toBe(0);
    expect(plain.stderr).toContain("pushing with the bump included");
  });

  it("commits only the version files, whatever else is staged", () => {
    const { work, remoteSha, localSha } = throwawayRepo();
    // Staged after the scan's range was fixed: it stays staged, it never rides.
    writeFileSync(join(work, "unrelated.txt"), "not scanned\n");
    writeFileSync(join(work, "hello.txt"), "staged edit\n");
    git(work, "add", "unrelated.txt", "hello.txt");
    const run = preflight(work, localSha, remoteSha);
    expect(run.status, run.stderr).toBe(0);
    expect(git(work, "log", "-1", "--format=%s")).toBe("chore: bump version to v0.1.3");
    expect(git(work, "rev-parse", "HEAD^")).toBe(localSha);
    expect(lines(git(work, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"))).toEqual(BUMP_FILES);
    // The shared index: the version files match the bump commit, the rest is
    // still staged on top of it, and nothing is left unstaged.
    expect(lines(git(work, "status", "--porcelain"))).toEqual(["A  unrelated.txt", "M  hello.txt"]);
    // The private index is gone from the git dir.
    expect(readdirSync(join(work, ".git")).filter((f: string) => f.startsWith("bump-index"))).toEqual([]);
  });

  /** A git hook in the throwaway repo's own `.git/hooks` (no hooksPath there). */
  const gitHook = (work: string, name: string, body: string) =>
    writeFileSync(join(work, ".git", "hooks", name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

  /** The repo exactly as before the push: HEAD, version files, index, no leftovers. */
  const expectUntouched = (work: string, localSha: string) => {
    expect(git(work, "rev-parse", "HEAD")).toBe(localSha);
    expect(JSON.parse(readFileSync(join(work, "package.json"), "utf8")).version).toBe("0.1.2");
    expect(readFileSync(join(work, "Cargo.lock"), "utf8")).toContain('version = "0.1.2"');
    expect(lockVersions(work)).toEqual(["0.1.2", "0.1.2", "0.1.2"]);
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(readdirSync(join(work, ".git")).filter((f: string) => f.startsWith("bump-index"))).toEqual([]);
    expect(readdirSync(join(work, "src-tauri")).filter((f: string) => f.includes("pre-push-restore"))).toEqual([]);
  };

  it("puts the version files back when the private-index commit fails", () => {
    const { work, remoteSha, localSha } = throwawayRepo();
    gitHook(work, "pre-commit", "exit 1");
    const run = preflight(work, localSha, remoteSha);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("the version bump failed (the bump commit)");
    expect(run.stderr).toContain("version files are back as they were");
    expectUntouched(work, localSha);
  });

  it("takes the bump commit back when the shared-index reset fails", () => {
    const { work, remoteSha, localSha } = throwawayRepo();
    // The commit lands, then the shared index is locked — what a concurrent git
    // process holding `index.lock` does to the reset that follows.
    gitHook(work, "post-commit", 'touch "$(git rev-parse --git-dir)/index.lock"');
    const run = preflight(work, localSha, remoteSha);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("resetting the version files in the shared index");
    expect(run.stderr).toContain("was taken back off the branch");
    // The bump commit is off the branch; with the lock gone the tree is clean,
    // and nothing stages the old version files over a bump commit.
    rmSync(join(work, ".git", "index.lock"));
    expectUntouched(work, localSha);
  });

  it("refuses to bump over uncommitted edits in the version files", () => {
    const { work, remoteSha, localSha } = throwawayRepo();
    writeFileSync(join(work, "src-tauri", "Cargo.toml"), `[package]\nname = "${BRAND.slug}"\nversion = "0.1.2"\n# edit\n`);
    const run = preflight(work, localSha, remoteSha);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("src-tauri/Cargo.toml");
    expect(git(work, "rev-parse", "HEAD")).toBe(localSha);
    expect(JSON.parse(readFileSync(join(work, "package.json"), "utf8")).version).toBe("0.1.2");
  });

  it("counts package-lock.json among the version files", () => {
    const { work, remoteSha, localSha } = throwawayRepo();
    writeFileSync(join(work, "package-lock.json"), npmLock("0.1.2").replace('"dep": "^0.1.2"', '"dep": "^0.2.0"'));
    const run = preflight(work, localSha, remoteSha);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("package-lock.json");
    expect(git(work, "rev-parse", "HEAD")).toBe(localSha);
    expect(lockVersions(work)).toEqual(["0.1.2", "0.1.2", "0.1.2"]);
  });
});
