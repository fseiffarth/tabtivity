#!/usr/bin/env node
// Which vitest files a CI run needs when the whole suite already passed on
// this OS at <base>. Called by scripts/ci-failed-first.sh frontend:
//
//   node scripts/ci-vitest-select.mjs <base>
//
// Prints `FULL <why>` when only the whole suite will do, else `RELATED <n>`
// and one path per line for `vitest related`: every file that differs between
// <base> and HEAD (vitest walks the import graph from them to the tests that
// reach them), plus the tests that always run because they read files off the
// disk, which no import graph shows.
//
// Not `vitest --changed <base>`: it diffs `<base>...HEAD`, which needs the
// history a CI checkout does not have, and it runs everything whenever
// package.json changed, which the pre-push version bump does on every push.
import { execFileSync } from "node:child_process";
import console from "node:console";
import { readFileSync } from "node:fs";
import process from "node:process";

const base = process.argv[2];
if (!base) {
  console.error("usage: ci-vitest-select.mjs <base>");
  process.exit(2);
}

const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
const full = (why) => {
  console.log(`FULL ${why}`);
  process.exit(0);
};

// A change to one of these can reach every test.
const WHOLE_SUITE = [
  /^vitest\.config\./,
  /^vite(\.[\w-]+)?\.config\./,
  /^tsconfig[\w.-]*\.json$/,
  /^\.nvmrc$/,
  /^src\/test-setup\.ts$/,
  /^scripts\/ci-failed-first\.sh$/,
  /^scripts\/ci-vitest-select\.mjs$/,
  /^\.github\/workflows\/ci-cd\.yml$/,
];
// Where vitest.config.ts collects tests, and so where an import can lead.
const SOURCE = /^(src|mobile-web|shared|scripts)\//;
const TEST = /^(src|mobile-web|shared|scripts)\/.*\.(test|spec)\.[cm]?[jt]sx?$/;
// Rust and its lock file are never imported; a test that reads them is DISK.
const NEVER_IMPORTED = /\.rs$|^Cargo\.lock$/;
const DISK =
  /from ["'](node:)?(fs|child_process)(\/promises)?["']|require\(["'](node:)?(fs|child_process)|readFileSync|readdirSync|execFileSync|execSync|spawnSync|import\.meta\.glob/;
// Most paths one `vitest related` call takes: on Windows `npx` is `npx.cmd`,
// so the call goes through cmd.exe, which caps a command line at 8191
// characters (not CreateProcess's 32k) — 299 paths of 11.6k characters failed
// there with "The command line is too long". The rest of the call (vitest's
// flags, the report path) needs about 1k. A change this wide is worth the
// whole suite anyway.
const MAX_FILES = 300;
const MAX_CHARS = 7000;

// The app's own version is the one line the pre-push bump rewrites.
const unversioned = (path, text) => {
  const json = JSON.parse(text);
  delete json.version;
  if (path === "package-lock.json" && json.packages?.[""]) delete json.packages[""].version;
  return JSON.stringify(json);
};
const bumpOnly = (path) => {
  try {
    return unversioned(path, git("show", `${base}:${path}`)) === unversioned(path, readFileSync(path, "utf8"));
  } catch {
    return false;
  }
};

const fields = git("diff", "--name-status", "--no-renames", "-z", base, "HEAD").split("\0");
const changed = [];
for (let i = 0; i + 1 < fields.length; i += 2) {
  const status = fields[i];
  const path = fields[i + 1];
  if (path === "package.json" || path === "package-lock.json") {
    if (status === "M" && bumpOnly(path)) continue;
    full(`${path} changed beyond the version bump`);
  }
  if (WHOLE_SUITE.some((re) => re.test(path))) full(`${path} changed`);
  // A removed module's importers are not found from a path that is gone.
  if (status === "D" && SOURCE.test(path)) full(`${path} was deleted`);
  if (status !== "D" && !NEVER_IMPORTED.test(path)) changed.push(path);
}

const tracked = git("ls-files", "-z", "src", "mobile-web", "shared", "scripts").split("\0").filter(Boolean);
const text = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};
// Test helpers that read the disk: a test importing one always runs too.
const diskHelpers = tracked
  .filter((path) => /(^|\/)__tests__\//.test(path) && !TEST.test(path) && /\.[cm]?[jt]sx?$/.test(path))
  .filter((path) => DISK.test(text(path)))
  .map((path) => path.replace(/^.*\//, "").replace(/\.[cm]?[jt]sx?$/, ""));
const importsDiskHelper = diskHelpers.length
  ? new RegExp(`/(${diskHelpers.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(\\.[cm]?[jt]sx?)?["']`)
  : null;
const always = tracked.filter((path) => {
  if (!TEST.test(path)) return false;
  const source = text(path);
  return DISK.test(source) || (importsDiskHelper?.test(source) ?? false);
});

const files = [...new Set([...changed, ...always])].sort();
if (files.length > MAX_FILES || files.join(" ").length > MAX_CHARS) {
  full(`${changed.length} files changed since ${base.slice(0, 9)}`);
}
console.log(`RELATED ${files.length}`);
for (const file of files) console.log(file);
