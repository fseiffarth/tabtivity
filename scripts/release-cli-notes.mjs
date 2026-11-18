#!/usr/bin/env node
// The release-notes section that names the agent CLI releases this build was
// checked against. Called by .github/workflows/release.yml:
//
//   node scripts/release-cli-notes.mjs >> release-body.md
//
// The source is `services::agent_versions::VERIFIED`, the machine-readable half
// of docs/third_party_update_checklist.md, read as text: the release job has
// no Rust toolchain and builds nothing. One line per agent and release, the
// surfaces checked at that release after it. Labels come from the agent
// registry, falling back to the id.
//
// Fails (exit 1) when the table cannot be read whole, rather than printing a
// shorter list: a release that silently drops a CLI would claim less than was
// checked, and one that lists none would look like nothing was. npm test runs
// this against the real sources, so a reshaped table breaks CI before a
// release ever reads it.
import console from "node:console";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, ...path.split("/")), "utf8");

const VERSIONS = "src-tauri/src/services/agent/agent_versions.rs";
const REGISTRY = "src-tauri/src/services/agent/agent_registry.rs";

export function verifiedRows(source) {
  const start = source.indexOf("const VERIFIED: &[Verified] = &[");
  if (start < 0) throw new Error(`no VERIFIED table in ${VERSIONS}`);
  const end = source.indexOf("\n];", start);
  if (end < 0) throw new Error(`the VERIFIED table in ${VERSIONS} is not closed`);
  const block = source.slice(start, end);
  const row = /Verified\s*\{\s*agent:\s*"([^"]+)",\s*version:\s*"([^"]+)",\s*surface:\s*"((?:[^"\\]|\\.)*)",?\s*\}/g;
  const rows = [...block.matchAll(row)].map(([, agent, version, surface]) => ({
    agent,
    version,
    // "§1.2 — the two-step /model sheet" → "the two-step /model sheet": the
    // section number means something only beside the checklist.
    surface: surface.replace(/\\"/g, '"').replace(/^§[\d.]+\s*—\s*/, ""),
  }));
  const written = (block.match(/\bVerified\s*\{/g) ?? []).length;
  if (rows.length === 0 || rows.length !== written) {
    throw new Error(`read ${rows.length} of ${written} VERIFIED rows in ${VERSIONS}; teach release-cli-notes.mjs the new shape`);
  }
  return rows;
}

export function registryLabels(source) {
  const labels = new Map();
  for (const [, id, label] of source.matchAll(/\bid:\s*"([^"]+)",\s*label:\s*"([^"]+)"/g)) {
    if (!labels.has(id)) labels.set(id, label);
  }
  return labels;
}

export function cliNotes(rows, labels) {
  // First appearance orders the list; one line per (agent, release).
  const groups = new Map();
  for (const { agent, version, surface } of rows) {
    const key = `${agent}\0${version}`;
    if (!groups.has(key)) groups.set(key, { agent, version, surfaces: [] });
    groups.get(key).surfaces.push(surface);
  }
  const lines = [
    "Agent CLIs this build was verified against (other releases usually work too;",
    "`docs/third_party_update_checklist.md` says what each check covers):",
  ];
  for (const { agent, version, surfaces } of groups.values()) {
    lines.push(`- ${labels.get(agent) ?? agent} ${version} — ${surfaces.join("; ")}`);
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    process.stdout.write(cliNotes(verifiedRows(read(VERSIONS)), registryLabels(read(REGISTRY))));
  } catch (error) {
    console.error(`release-cli-notes: ${error.message}`);
    process.exit(1);
  }
}
