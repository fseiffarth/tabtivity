/**
 * Replays captured TUI frames through the app's own screen readers and
 * compares two versions of a CLI, frame by frame (scripts/verify-cli/README.md).
 *
 *   VERIFY_CLI=opencode VERIFY_OLD=2.2.4 VERIFY_NEW=2.2.5 \
 *     node_modules/.bin/vitest run --config scripts/verify-cli/parsers/vitest.config.mts
 *
 * Frames are every `<name>@<cols>x<rows>.esc` under
 * tmp/verify-cli/<cli>/<label>/ (homes `h-*` skipped); a frame is matched
 * across versions by its path. Each goes through a real xterm at its own
 * geometry, then every reader: the Reader's live view, the model pickers, the
 * decision lamp, the cold-resume dialog, Antigravity's picker and effort, the
 * phone's sign-in reader (chained across a folder's frames, as the phone pages).
 * VERIFY_AGENT names the agent label the readers get (default: VERIFY_CLI).
 *
 * Writes tmp/verify-cli/<cli>/parsers-<old>-vs-<new>.json and prints which
 * frames read differently. A difference is a lead, not a verdict: open both
 * frames and decide whether the reader or the TUI is wrong. Without
 * VERIFY_OLD it only writes parsers-<new>.json.
 */
import { Terminal } from "@xterm/xterm";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, it } from "vitest";
import { readModelPicker, readOpenCodeModelPage, readReaderLive } from "../../../src/lib/agents/readerLive";
import { looksLikeColdResumeDialogStripped, looksLikeDecisionPromptStripped } from "../../../src/lib/agents/prompt/prompt";
import { readableScreen, type ReadableBufferLike } from "../../../mobile-web/src/terminal/readableScreen";
import { readAntigravityEffort, readAntigravityPicker } from "../../../mobile-web/src/terminal/antigravity";
import { readSignIn, readSignInPage, type SignInPage } from "../../../mobile-web/src/terminal/signIn";
import { limitMeters, parseUsageReport, resolveResetAt } from "../../../shared/usageReport";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const OUT = process.env.VERIFY_OUT || join(ROOT, "tmp", "verify-cli");
const CLI = process.env.VERIFY_CLI ?? "";
const OLD = process.env.VERIFY_OLD ?? "";
const NEW = process.env.VERIFY_NEW ?? "";
const AGENT = process.env.VERIFY_AGENT || CLI;
const FRAME = /@(\d+)x(\d+)\.esc$/u;
const SGR = /\x1b\[[0-9;:?]*[A-Za-z]/gu;

function frames(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!name.startsWith("h-") && name !== "work" && name !== "node_modules") out.push(...frames(path));
    } else if (FRAME.test(name)) out.push(path);
  }
  return out;
}

async function buffer(bytes: string, cols: number, rows: number): Promise<ReadableBufferLike> {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  await new Promise<void>((done) => term.write(bytes.replace(/\n$/u, "").replace(/\r?\n/gu, "\r\n"), done));
  return term.buffer.active;
}

// What differs on every run, not by version: sign-in URLs carry a fresh
// `state`/challenge, and the label shows up in paths (and version banners).
const redactor = (label: string) => (_key: string, value: unknown) =>
  typeof value === "string"
    ? value.replace(/((?:state|code_challenge|nonce)=)[^&\s"]+/gu, "$1…").split(label).join("<label>")
    : value;

async function readAll(label: string): Promise<Record<string, unknown>> {
  const base = join(OUT, CLI, label);
  if (!existsSync(base)) throw new Error(`no captures at ${base}`);
  const result: Record<string, unknown> = {};
  const pages = new Map<string, SignInPage | null>();
  for (const path of frames(base)) {
    const [, cols, rows] = FRAME.exec(path)!.map(Number);
    const bytes = readFileSync(path, "utf8");
    const b = await buffer(bytes, cols, rows);
    const { lines } = readableScreen(b, 300);
    const plain = bytes.replace(SGR, "");
    const folder = join(path, "..");
    const page = readSignInPage(lines, pages.get(folder) ?? null);
    pages.set(folder, page);
    result[relative(base, path)] = JSON.parse(JSON.stringify({
      live: readReaderLive(b, AGENT, cols),
      modelPicker: readModelPicker(b, AGENT),
      openCodeModelPage: readOpenCodeModelPage(b),
      antigravityPicker: readAntigravityPicker(lines),
      antigravityEffort: readAntigravityEffort(lines),
      signIn: readSignIn(lines),
      signInPage: page,
      decisionLamp: looksLikeDecisionPromptStripped(plain),
      coldResume: looksLikeColdResumeDialogStripped(plain),
    }, redactor(label)));
  }
  const usage = join(base, "hooks", "usage.json");
  if (existsSync(usage)) {
    // Its numbers move between any two runs; compare what the parser found, not the values.
    const report = parseUsageReport(String(JSON.parse(readFileSync(usage, "utf8")).result ?? ""));
    const now = new Date();
    result["hooks/usage.json"] = {
      meters: report.meters.map((meter) => meter.label),
      percents: report.meters.map((meter) => typeof meter.percent),
      resetsResolved: report.meters.map((meter) => resolveResetAt(String(meter.resets ?? ""), now) !== null),
      notes: report.notes.length,
      limits: Object.fromEntries(Object.entries(limitMeters(report)).map(([key, value]) => [key, Array.isArray(value) ? value.length : value != null])),
    };
  }
  return result;
}

/** The paths (to depth 3) where two readings differ: `live.question.start`. */
function differing(a: unknown, b: unknown, path = "", depth = 0): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (depth >= 3 || !isObject(a) || !isObject(b)) return [path || "(whole)"];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap((key) =>
    differing(a[key], b[key], path ? `${path}.${key}` : key, depth + 1));
}

it(`replays ${CLI} ${OLD || "-"} → ${NEW} through the readers`, async () => {
  expect(CLI && NEW, "set VERIFY_CLI and VERIFY_NEW (and VERIFY_OLD to compare)").toBeTruthy();
  const next = await readAll(NEW);
  expect(Object.keys(next).length, `no frames under ${join(OUT, CLI, NEW)}`).toBeGreaterThan(0);
  if (!OLD) {
    writeFileSync(join(OUT, CLI, `parsers-${NEW}.json`), JSON.stringify(next, null, 1));
    console.log(`${Object.keys(next).length} frames read → ${join(OUT, CLI, `parsers-${NEW}.json`)}`);
    return;
  }
  const prev = await readAll(OLD);
  const report: Record<string, { fields: string[]; old: unknown; new: unknown }> = {};
  const same: string[] = [];
  for (const key of [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort()) {
    const a = JSON.stringify(prev[key] ?? null);
    const b = JSON.stringify(next[key] ?? null);
    if (a === b) same.push(key);
    else report[key] = { fields: differing(prev[key], next[key]), old: prev[key] ?? "(no such frame)", new: next[key] ?? "(no such frame)" };
  }
  const file = join(OUT, CLI, `parsers-${OLD}-vs-${NEW}.json`);
  writeFileSync(file, JSON.stringify(report, null, 1));
  console.log(`${same.length} frames read the same; ${Object.keys(report).length} differ → ${file}`);
  // `live.screen` is the raw text: a change there alone is the TUI's wording, not a reader's verdict.
  for (const [key, { fields }] of Object.entries(report)) console.log(`  ${key}: ${fields.join(", ")}`);
});
