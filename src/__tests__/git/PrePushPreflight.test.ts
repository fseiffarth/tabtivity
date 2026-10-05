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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

describe.skipIf(process.platform === "win32" || !hasTool("git") || !hasTool("jq"))(`pre-push under ${BRAND.envPrefix}PUSH_PREFLIGHT`, () => {
  it("bumps, commits, exits 0 and never pushes", () => {
    const work = mkdtempSync(join(tmpdir(), `${BRAND.slug}-preflight-`));
    git(work, "init", "-q", "-b", "develop");
    mkdirSync(join(work, "scripts"));
    mkdirSync(join(work, "src-tauri"));
    for (const script of ["bump-version.sh", "privacy-check.sh"]) {
      writeFileSync(join(work, "scripts", script), readFileSync(join(repoRoot, "scripts", script)), { mode: 0o755 });
    }
    writeFileSync(join(work, "package.json"), JSON.stringify({ name: "x", version: "0.1.2" }, null, 2) + "\n");
    writeFileSync(join(work, "src-tauri", "Cargo.toml"), `[package]\nname = "${BRAND.slug}"\nversion = "0.1.2"\n`);
    writeFileSync(join(work, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "0.1.2" }, null, 2) + "\n");
    writeFileSync(join(work, "Cargo.lock"), `[[package]]\nname = "${BRAND.slug}"\nversion = "0.1.2"\n`);
    writeFileSync(join(work, "hello.txt"), "hello\n");
    git(work, "add", "-A");
    git(work, "commit", "-q", "-m", "one");
    const remoteSha = git(work, "rev-parse", "HEAD");
    writeFileSync(join(work, "hello.txt"), "hello again\n");
    git(work, "commit", "-q", "-am", "two");
    const localSha = git(work, "rev-parse", "HEAD");
    // The hook itself, as tracked in this repo, through a nonexistent remote.
    const hook = join(repoRoot, ".githooks", "pre-push");
    expect(existsSync(hook)).toBe(true);
    const run = spawnSync(hook, ["origin", "file:///nonexistent/remote.git"], {
      cwd: work, encoding: "utf8", input: `refs/heads/develop ${localSha} refs/heads/develop ${remoteSha}\n`,
      env: { ...env, [envName("PUSH_PREFLIGHT")]: "1", [envName("SKIP_PRIVACY_CHECK")]: "1", GIT_TERMINAL_PROMPT: "0" },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain(`${BRAND.display}'s transport carries the bump`);
    expect(run.stderr).not.toContain("failed to push");
    expect(git(work, "log", "-1", "--format=%s")).toBe("chore: bump version to v0.1.3");
    expect(JSON.parse(readFileSync(join(work, "package.json"), "utf8")).version).toBe("0.1.3");
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
});
