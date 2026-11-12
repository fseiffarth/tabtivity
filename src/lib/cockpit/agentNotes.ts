import type { AgentMilestone, CockpitMeta, ProgressState, ProgressStep, VerificationEntry, VerificationOutcome } from "../../stores/tabs/types";

/**
 * The notes an agent publishes about its own tab through the cockpit MCP
 * (`cockpitMeta` on the saved tab, `docs/context/cockpit_mcp.md`). The backend
 * owns and writes them; this module only reads: it validates what arrives,
 * decides what is current, and hands the views plain text. Everything here is
 * the agent's own statement — never an app-detected state, never an approval.
 */

/** How long an activity line counts as current (the backend's `ACTIVITY_TTL_MS`). */
export const ACTIVITY_TTL_MS = 30 * 60 * 1000;
/** A stamp this far ahead of the clock is a moved-back clock, not a fresh line. */
const FUTURE_SLACK_MS = 60 * 1000;
// The backend's bounds, enforced again on the way in: a record is not trusted
// to have kept them.
const ACTIVITY_MAX = 160;
const FIELD_MAX = 1000;
const RESULTS_MAX = 8;
const RESULT_LABEL_MAX = 120;
const RESULT_PATH_MAX = 512;
const BLOCKER_MAX = 300;
const STEPS_MAX = 8;
const STEP_ID_RE = /^[a-z0-9_-]{1,40}$/;
const STEP_LABEL_MAX = 120;
const ENTRIES_MAX = 8;
const CHECK_LABEL_MAX = 120;
const CHECK_NOTE_MAX = 300;
const ATTENTION_MAX = 500;
const ATTENTION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MILESTONES_MAX = 20;
const MILESTONE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MILESTONE_MAX = 200;
const STEP_STATES: readonly ProgressState[] = ["pending", "active", "done"];
const OUTCOMES: readonly VerificationOutcome[] = ["passed", "failed", "pending", "not_run"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | undefined =>
  typeof v === "string" ? Array.from(v).slice(0, max).join("") : undefined;
const stamp = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
/** A `{ text, setAt }` line (the activity, the blocker), or undefined unless both are well-formed. */
const stampedLine = (v: unknown, max: number): { text: string; setAt: number } | undefined => {
  if (!isRecord(v)) return undefined;
  const line = text(v.text, max);
  const setAt = stamp(v.setAt);
  return line !== undefined && setAt !== undefined ? { text: line, setAt } : undefined;
};

/** A saved record's `cockpitMeta`, or undefined when absent or not this schema. */
export function readCockpitMeta(raw: unknown): CockpitMeta | undefined {
  if (!isRecord(raw) || raw.v !== 1) return undefined;
  const revision = typeof raw.revision === "number" && Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0;
  const meta: CockpitMeta = { v: 1, revision };
  const activity = stampedLine(raw.activity, ACTIVITY_MAX);
  if (activity) meta.activity = activity;
  if (isRecord(raw.handoff)) {
    const summary = text(raw.handoff.summary, FIELD_MAX);
    const checks = text(raw.handoff.checks, FIELD_MAX);
    const remaining = text(raw.handoff.remaining, FIELD_MAX);
    const setAt = stamp(raw.handoff.setAt);
    if (summary !== undefined && checks !== undefined && remaining !== undefined && setAt !== undefined) {
      meta.handoff = { summary, checks, remaining, setAt };
    }
  }
  if (isRecord(raw.results) && Array.isArray(raw.results.items)) {
    const setAt = stamp(raw.results.setAt);
    // All or nothing: a click names an item by its place in the saved list, so
    // dropping one bad entry would move the others.
    const items = raw.results.items.length <= RESULTS_MAX
      ? raw.results.items.map((item: unknown) => {
          if (!isRecord(item)) return undefined;
          const label = text(item.label, RESULT_LABEL_MAX);
          const relativePath = text(item.relativePath, RESULT_PATH_MAX);
          return label !== undefined && relativePath !== undefined ? { label, relativePath } : undefined;
        })
      : [undefined];
    if (setAt !== undefined && items.every((item) => item !== undefined)) {
      meta.results = { items: items as { label: string; relativePath: string }[], setAt };
    }
  }
  const progress = readProgress(raw.progress);
  if (progress) meta.progress = progress;
  const blocker = stampedLine(raw.blocker, BLOCKER_MAX);
  if (blocker) meta.blocker = blocker;
  const verification = readVerification(raw.verification);
  if (verification) meta.verification = verification;
  if (isRecord(raw.attention)) {
    const { id, question: asked, setAt } = raw.attention;
    const question = text(asked, ATTENTION_MAX);
    const at = stamp(setAt);
    if (typeof id === "string" && ATTENTION_ID_RE.test(id) && question !== undefined && at !== undefined) {
      meta.attention = raw.attention.dismissed === true ? { id, question, setAt: at, dismissed: true } : { id, question, setAt: at };
    }
  }
  const milestones = readMilestones(raw.milestones);
  if (milestones) meta.milestones = milestones;
  return meta;
}

/** The newest 20 well-formed entries, oldest first; one bad entry is dropped
 *  (nothing addresses a milestone by its place in the list). */
function readMilestones(raw: unknown): AgentMilestone[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: AgentMilestone[] = [];
  for (const item of raw as unknown[]) {
    if (!isRecord(item) || typeof item.requestId !== "string" || !MILESTONE_ID_RE.test(item.requestId)) continue;
    const line = text(item.text, MILESTONE_MAX);
    const at = stamp(item.at);
    if (line !== undefined && at !== undefined) out.push({ requestId: item.requestId, text: line, at });
  }
  return out.length > 0 ? out.slice(-MILESTONES_MAX) : undefined;
}

/** All or nothing, like the results: a half-read plan would mislead. */
function readProgress(raw: unknown): CockpitMeta["progress"] {
  if (!isRecord(raw) || !Array.isArray(raw.steps) || raw.steps.length > STEPS_MAX) return undefined;
  const setAt = stamp(raw.setAt);
  const seen = new Set<string>();
  const steps: ProgressStep[] = [];
  for (const item of raw.steps as unknown[]) {
    if (!isRecord(item) || typeof item.id !== "string" || !STEP_ID_RE.test(item.id) || seen.has(item.id)) return undefined;
    const label = text(item.label, STEP_LABEL_MAX);
    const state = STEP_STATES.find((s) => s === item.state);
    if (label === undefined || state === undefined) return undefined;
    seen.add(item.id);
    steps.push({ id: item.id, label, state });
  }
  if (setAt === undefined || steps.filter((s) => s.state === "active").length > 1) return undefined;
  return raw.ended === true ? { steps, setAt, ended: true } : { steps, setAt };
}

function readVerification(raw: unknown): CockpitMeta["verification"] {
  if (!isRecord(raw) || !Array.isArray(raw.entries) || raw.entries.length > ENTRIES_MAX) return undefined;
  const setAt = stamp(raw.setAt);
  const entries: VerificationEntry[] = [];
  for (const item of raw.entries as unknown[]) {
    if (!isRecord(item)) return undefined;
    const label = text(item.label, CHECK_LABEL_MAX);
    const outcome = OUTCOMES.find((o) => o === item.outcome);
    if (label === undefined || outcome === undefined) return undefined;
    const note = item.note === undefined ? undefined : text(item.note, CHECK_NOTE_MAX);
    if (item.note !== undefined && note === undefined) return undefined;
    entries.push(note ? { label, outcome, note } : { label, outcome });
  }
  return setAt === undefined ? undefined : { entries, setAt };
}

/** Whether two readings are the same state: the backend bumps `revision` on
 *  every change and never reuses one. */
export function sameCockpitMeta(a: CockpitMeta | undefined, b: CockpitMeta | undefined): boolean {
  return a === b || (!!a && !!b && a.revision === b.revision);
}

/** Whether an activity stamped `setAt` is still current at `now`. */
export function isActivityFresh(setAt: number, now: number): boolean {
  return setAt <= now + FUTURE_SLACK_MS && now - setAt < ACTIVITY_TTL_MS;
}

/** The activity line to show at `now`: only while the agent is live and the
 *  line is fresh. The backend already dropped a previous spawn's line at the
 *  new spawn; this hides an old one in between. */
export function currentActivity(meta: CockpitMeta | undefined, now: number, live: boolean): { text: string; setAt: number } | undefined {
  return liveLine(meta?.activity, now, live);
}

/** `line` while the agent is live and it says something and is fresh. */
function liveLine(line: { text: string; setAt: number } | undefined, now: number, live: boolean) {
  return live && line && line.text.trim() !== "" && isActivityFresh(line.setAt, now) ? line : undefined;
}

/** The handoff note, when it says anything. It is a historical report: it stays
 *  with its own timestamp however old, and the agent need not be live. */
export function currentHandoff(meta: CockpitMeta | undefined): NonNullable<CockpitMeta["handoff"]> | undefined {
  const note = meta?.handoff;
  return note && (note.summary.trim() !== "" || note.checks.trim() !== "" || note.remaining.trim() !== "") ? note : undefined;
}

/** The listed results, when there are any. Like the handoff, a historical
 *  report that keeps its own timestamp however old; the agent need not be live. */
export function currentResults(meta: CockpitMeta | undefined): NonNullable<CockpitMeta["results"]> | undefined {
  const list = meta?.results;
  return list && list.items.length > 0 ? list : undefined;
}

/** The blocker to show at `now`: transient like the activity line - only while
 *  the agent is live and the line is under 30 minutes old. The agent's own
 *  statement; it is not an app-detected state. */
export function currentBlocker(meta: CockpitMeta | undefined, now: number, live: boolean): { text: string; setAt: number } | undefined {
  return liveLine(meta?.blocker, now, live);
}

/** The agent's plan steps and whether they describe work in progress. They are
 *  kept as history: `running` is true only for a live agent, a report its own
 *  spawn made (`ended` unset) and one under 30 minutes old. Anything else is a
 *  past report - shown with its time, never as running. */
export function progressReport(
  meta: CockpitMeta | undefined,
  now: number,
  live: boolean,
): { steps: readonly ProgressStep[]; setAt: number; running: boolean } | undefined {
  const report = meta?.progress;
  if (!report || report.steps.length === 0) return undefined;
  return { steps: report.steps, setAt: report.setAt, running: live && !report.ended && isActivityFresh(report.setAt, now) };
}

/** The verification entries the agent reported, when there are any. A
 *  historical report like the handoff; `setAt` is when it was reported. */
export function currentVerification(meta: CockpitMeta | undefined): NonNullable<CockpitMeta["verification"]> | undefined {
  const report = meta?.verification;
  return report && report.entries.length > 0 ? report : undefined;
}

/** How long an attention question stays open (the backend's `ATTENTION_TTL_MS`). */
export const ATTENTION_TTL_MS = 24 * 60 * 60 * 1000;

/** The agent's question while it is open: under 24 hours old by the host's
 *  stamp, whether or not the user dismissed it. The agent need not be "live"
 *  here - the host removes a previous spawn's question at the next spawn. */
export function openAttention(meta: CockpitMeta | undefined, now: number): NonNullable<CockpitMeta["attention"]> | undefined {
  const ask = meta?.attention;
  return ask && ask.question.trim() !== "" && ask.setAt <= now + FUTURE_SLACK_MS && now - ask.setAt < ATTENTION_TTL_MS ? ask : undefined;
}

/** The question that still needs the user: open and not dismissed. This is
 *  what the Needs-you list and the header badge count - the agent's request
 *  to be looked at, never an app-detected state and never an approval. */
export function currentAttention(meta: CockpitMeta | undefined, now: number): NonNullable<CockpitMeta["attention"]> | undefined {
  const ask = openAttention(meta, now);
  return ask && !ask.dismissed ? ask : undefined;
}

/** The agent's milestones, newest first, when it has any. History that keeps
 *  its own host timestamps however old. */
export function currentMilestones(meta: CockpitMeta | undefined): readonly AgentMilestone[] {
  const list = meta?.milestones;
  return list && list.length > 0 ? [...list].reverse() : [];
}

/** The milestones stamped after `since` (and not from the future), newest first. */
export function milestonesSince(meta: CockpitMeta | undefined, since: number, now: number): readonly AgentMilestone[] {
  return currentMilestones(meta).filter((m) => m.at > since && m.at <= now + FUTURE_SLACK_MS);
}
