import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { deliveryRecordId, isFinishedOneTime } from "../../lib/agents/prompt/send";
import { promptOfSchedule } from "../../lib/agents/prompt/scheduled";
import { nextAfter } from "../../lib/agents/prompt/links";
import {
  scheduleVerdict,
  isAgentProposal,
  sortSchedules,
  type ScheduleResult,
  type ScheduledAgentPrompt,
} from "../../lib/agents/agentSchedule";
import {
  scheduledAgentInput,
  submitScheduledAgentMessage,
  type ScheduledAgentInput,
} from "../../lib/agents/scheduledAgentInput";
import { forgetPhoneHold, onPhoneHoldDue, phoneHoldDue } from "../../lib/agents/phoneHolds";
import { agentDeliveryReady, agentDeliveryTurn, lastPtyOutputAt, noteScheduleProposal, useActivityStore } from "../../stores/activity";
import { recordScheduledDelivery, sendCollectedPrompt, useAgentPromptsStore } from "../../stores/agents/agentPrompts";
import { persistScopeLayout, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { holdsTimerLease } from "../../stores/timerLease";

const TICK_MS = 15_000;
const OUTPUT_SETTLE_MS = 1_200;
/** A Stop must remain current before another prompt can be inserted. */
const COMPLETION_STABLE_MS = 3_000;
/**
 * For a tab whose agent fires no hooks (Gemini, Qwen, a custom command, an
 * untrusted Codex) there is no Stop to wait for, so completion is read off the
 * bytes: output after the submission, then this much quiet with the byte
 * classifier calling the tab idle. Longer than the classifier's own done
 * window on purpose — a silent tool is the one thing bytes cannot see — and
 * only ever consulted when no hook verdict has been recorded for the PTY this
 * session, so a Claude or a trusted Codex never falls back to it.
 */
const HOOKLESS_DONE_QUIET_MS = 30_000;
/**
 * An `after` link's next prompt is queued only once the source's turn has
 * finished AND the tab has then stayed idle this long — a safety margin for an
 * agent that stops, then picks up a background task, a hook or a follow-up of
 * its own. Measured from the latest done, so any new turn in between (the user
 * typing, the agent resuming) restarts the wait.
 */
const AFTER_LINK_IDLE_MS = 5 * 60_000;

function completedTurn(ptyId: string, submittedAt: number, stableMs = COMPLETION_STABLE_MS): boolean {
  const turn = agentDeliveryTurn(ptyId);
  const activity = useActivityStore.getState();
  const idle = !activity.busyByTab[ptyId] && activity.attentionByTab[ptyId] !== "decision";
  if (!turn) {
    const lastOutput = lastPtyOutputAt(ptyId) ?? 0;
    return lastOutput > submittedAt && Date.now() - lastOutput >= Math.max(HOOKLESS_DONE_QUIET_MS, stableMs) && idle;
  }
  return turn.state === "done" && (turn.startedAt ?? 0) >= submittedAt
    && turn.at >= submittedAt && Date.now() - turn.at >= stableMs && idle;
}
/**
 * Between the submissions of one delivery (a prefix command, then the next, then
 * the message) the tab is given time to act before the following line arrives.
 * The full idle gate is not reusable here: the occurrence is already claimed and
 * `/clear` legitimately leaves the tab busy for a moment, so this waits for the
 * PTY to go quiet and then gives up, rather than abandoning a half-sent
 * delivery.
 */
const PREFACE_SETTLE_MS = 350;
const PREFACE_SETTLE_MAX_MS = 6_000;
const PREFACE_POLL_MS = 100;

interface Binding {
  projectId: string;
  scheduleTargetId: string;
  tab: TabEntry;
}

function bindings(): Binding[] {
  return Object.entries(useTabsStore.getState().tabsByScope).flatMap(([projectId, tabs]) =>
    tabs.flatMap((tab) =>
      (tab.kind === "agent" || tab.kind === "local_agent") && tab.scheduleTargetId
        ? [{ projectId, scheduleTargetId: tab.scheduleTargetId, tab }]
        : [],
    ),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a tab to stop producing output, capped so a chatty agent cannot
 *  hold a claimed delivery open indefinitely. */
async function settleBetweenSubmissions(ptyId: string): Promise<void> {
  const deadline = Date.now() + PREFACE_SETTLE_MAX_MS;
  await sleep(PREFACE_SETTLE_MS);
  while (Date.now() < deadline) {
    const quietFor = Date.now() - (lastPtyOutputAt(ptyId) ?? 0);
    if (quietFor >= PREFACE_SETTLE_MS) return;
    await sleep(PREFACE_POLL_MS);
  }
}

function bindingKey(binding: Pick<Binding, "projectId" | "scheduleTargetId">): string {
  return `${binding.projectId}\u0000${binding.scheduleTargetId}`;
}

function ensureLiveTargetIds(): void {
  useTabsStore.setState((state) => {
    let changed = false;
    const tabsByScope = Object.fromEntries(Object.entries(state.tabsByScope).map(([scope, tabs]) => [
      scope,
      tabs.map((tab) => {
        if ((tab.kind !== "agent" && tab.kind !== "local_agent") || tab.scheduleTargetId) return tab;
        changed = true;
        return { ...tab, scheduleTargetId: crypto.randomUUID() };
      }),
    ]));
    if (!changed) return state;
    return {
      tabsByScope,
      tabs: tabsByScope[state.scope] ?? [],
    };
  });
}

async function complete(
  binding: Binding,
  scheduleId: string,
  occurrence: string,
  result: ScheduleResult,
): Promise<void> {
  const schedules = await invoke<ReturnType<typeof useAgentSchedulesStore.getState>["byTarget"][string]>(
    "agent_schedule_complete",
    {
      projectId: binding.projectId,
      scheduleTargetId: binding.scheduleTargetId,
      scheduleId,
      occurrence,
      result,
    },
  );
  useAgentSchedulesStore.setState((state) => ({
    byTarget: { ...state.byTarget, [bindingKey(binding)]: schedules },
  }));
}

/**
 * Write one run of a schedule onto the project's Sent prompts, and retire the
 * rule if it can never fire again.
 *
 * A finished one-time schedule used to sit in the tab's schedule menu forever,
 * as a rule that says it already ran — a record wearing the shape of a plan.
 * The record belongs with the other sent prompts, where the prompt, the tab,
 * the agent, the session it went to and both times are together; the menu is
 * left holding only rules that still have a future. Recurring rules stay put
 * and contribute one history row per occurrence.
 *
 * The record is written FIRST and the rule deleted only once it lands: the
 * prompt has already reached the agent by the time this runs, so a rule
 * dropped after a failed write would take the only account of the delivery
 * with it. A throw leaves the rule in place for the next tick to retry.
 */
async function retire(
  binding: Binding,
  schedule: ScheduledAgentPrompt,
  last: { occurrence: string; result: ScheduleResult },
): Promise<void> {
  await recordScheduledDelivery(
    binding.projectId,
    { id: deliveryRecordId(schedule, last.occurrence), message: schedule.message, preface: schedule.preface },
    {
      tabLabel: binding.tab.label,
      sessionId: binding.tab.sessionId,
      tabId: binding.scheduleTargetId,
      agent: binding.tab.cmd,
      result: last.result,
      scheduledFor: last.occurrence || undefined,
      scheduleOrigin: schedule.origin,
    },
  );
  if (schedule.rule.type !== "once") return;
  await useAgentSchedulesStore
    .getState()
    .remove(binding.projectId, binding.scheduleTargetId, schedule.id)
    .catch(() => {});
  await retireCollected(binding.projectId, schedule);
}

/** Queue one hop only after the source's turn has explicitly finished and
 * the tab has stayed idle for `AFTER_LINK_IDLE_MS`. A receipt proves
 * submission, never completion. Returns false while a successor is still
 * waiting out that window, so the sweep asks again next tick. */
async function continueAfterDelivery(binding: Binding, recordId: string, ready: (stableMs?: number) => boolean): Promise<boolean> {
  const store = useAgentPromptsStore.getState();
  const [drafts, links] = await Promise.all([
    store.load(binding.projectId),
    store.loadLinks(binding.projectId),
  ]);
  const live = bindings()
    .filter((item) => item.projectId === binding.projectId)
    .map((item) => ({
      scheduleTargetId: item.scheduleTargetId,
      label: item.tab.label,
      sessionId: item.tab.sessionId,
      agent: item.tab.cmd,
    }));
  const schedule = useAgentSchedulesStore.getState().byTarget[bindingKey(binding)]
    ?.find((item) => deliveryRecordId(item, item.last?.occurrence ?? "") === recordId);
  const sourceIds = [recordId];
  // The one prompt the rule carries, whose edges are the rule's edges. Another
  // prompt with the same words is a different prompt with its own chain.
  const carried = schedule ? promptOfSchedule(drafts, schedule) : undefined;
  if (carried && carried.id !== recordId) sourceIds.push(carried.id);
  const nextRows = sourceIds.flatMap((sourceId) => nextAfter(sourceId, links, drafts, live, binding.scheduleTargetId));
  if (nextRows.some((next) => next.strand) && !ready(AFTER_LINK_IDLE_MS)) return false;
  const seen = new Set<string>();
  for (const next of nextRows) {
    if (!ready(AFTER_LINK_IDLE_MS)) return false;
    if (seen.has(next.prompt.id)) continue;
    seen.add(next.prompt.id);
    if (!next.strand) continue;
    // The edge's own commands (`/clear` between the two prompts) ride as the
    // queued target's preface, typed one at a time before its text.
    await sendCollectedPrompt(
      binding.projectId,
      next.strand,
      next.prompt,
      next.link.preface?.length ? next.link.preface : undefined,
    ).catch(() => {});
  }
  return ready();
}

/**
 * Take a collected prompt out of the active list once the rule carrying its text
 * has fired for the last time.
 *
 * "Send now" retires its prompt at send time (`sendCollectedPrompt`), so a
 * scheduled one was the only prompt that stayed collected after it had been
 * delivered — sitting in the Agents view as text still waiting to be sent, next
 * to the history row saying it already had been, which is how the same prompt
 * gets sent twice. This is that retirement, deliberately only on the path that
 * has just deleted a **one-time** rule: a recurring rule is going to fire again,
 * and its prompt belongs in the Scheduled section until it does.
 *
 * The delivery has already been recorded by the caller, so this only DELETES —
 * archiving would write a second history row for one delivery. The link is the
 * rule's id, which is the prompt's id, with the prompt's text as the fallback
 * for a rule that predates that (`promptOfSchedule`) — and it retires ONE
 * prompt: a second prompt with the same words was never this rule's, and
 * deleting it here was how two same-text prompts could not coexist. A prompt
 * reworded since the rule was made simply stays collected, as it should, since
 * the rule no longer carried it. Best-effort throughout: the record is the part
 * that matters, and the next tick cannot retry this one (the rule is gone) but
 * nothing is lost if it fails.
 */
async function retireCollected(projectId: string, schedule: { id: string; message: string }): Promise<void> {
  const store = useAgentPromptsStore.getState();
  // Read the list fresh rather than off the store: this window may never have
  // opened that scope's Agents view, and the send-now path has already deleted
  // its own prompt, so a stale copy would be the one thing that could delete a
  // prompt somebody re-collected in the meantime.
  const prompts = await store.load(projectId).catch(() => []);
  const prompt = promptOfSchedule(prompts, schedule);
  if (prompt) await store.remove(projectId, prompt.id).catch(() => {});
}

/** The tab may take a scheduled prompt now: the pane is up and settled, and
 * the agent has stably finished its turn and is not asking anything. */
function idleForDelivery(input: ScheduledAgentInput): boolean {
  if (!input.ready() || !agentDeliveryReady(input.ptyId, COMPLETION_STABLE_MS)) return false;
  const activity = useActivityStore.getState();
  // `?? 0`, not `?? Date.now()`: a PTY that has produced no output this
  // session has nothing to settle after, and reading "no output" as "output
  // just now" made the gate permanently false — a tab whose whole TUI arrived
  // as a restored snapshot could never be delivered to at all.
  return !activity.busyByTab[input.ptyId]
    && activity.attentionByTab[input.ptyId] !== "decision"
    && Date.now() - (lastPtyOutputAt(input.ptyId) ?? 0) >= OUTPUT_SETTLE_MS;
}

/** The pane takes keystrokes and is not on a question, whose choices a typed
 * line would answer. */
function queueableWhileBusy(input: ScheduledAgentInput): boolean {
  return (input.started ?? input.ready)()
    && useActivityStore.getState().attentionByTab[input.ptyId] !== "decision";
}

/**
 * Type a phone prompt (`phoneHolds.ts`) while the
 * agent works, as a prompt typed then goes: into the CLI's own queue, which
 * the agent takes in mid-turn. The idle gate stays for every other rule. The
 * turn it lands in is not this delivery's, so nothing waits on its end; the
 * next held prompt follows on the next sweep.
 */
async function queueDuePhoneHold(
  binding: Binding,
  input: ScheduledAgentInput,
  schedules: ScheduledAgentPrompt[],
  now: Date,
): Promise<void> {
  const schedule = sortSchedules(schedules, now)
    .find((item) => phoneHoldDue(item.id) && scheduleVerdict(item, now).kind === "wait");
  if (!schedule || !queueableWhileBusy(input)) return;
  const verdict = scheduleVerdict(schedule, now);
  if (verdict.kind !== "wait") return;
  forgetPhoneHold(schedule.id);
  const occurrence = verdict.occurrence.key;
  const claimed = await invoke<boolean>("agent_schedule_claim", {
    projectId: binding.projectId,
    scheduleTargetId: binding.scheduleTargetId,
    scheduleId: schedule.id,
    occurrence,
  }).catch(() => false);
  if (!claimed) return;
  let result: ScheduleResult = "delivered";
  try {
    if (scheduledAgentInput(binding.scheduleTargetId) !== input || !queueableWhileBusy(input)) {
      throw new Error("agent readiness changed");
    }
    await submitScheduledAgentMessage(binding.scheduleTargetId, schedule.message, {
      preface: schedule.preface,
      settle: settleBetweenSubmissions,
      whileBusy: true,
    });
  } catch {
    result = "failed";
  }
  await complete(binding, schedule.id, occurrence, result).catch(() => {});
  await retire(binding, schedule, { occurrence, result }).catch(() => {});
}

/**
 * Main-window-only owner of per-tab scheduled delivery. TerminalView remains the
 * PTY owner and exposes only a readiness/submission capability through the
 * registry; the scheduler never duplicates terminal lifecycle or output wiring.
 */
export function AgentScheduleHost() {
  const running = useRef(false);
  // `recordId` names the history row the delivery wrote, so the moment the
  // tab is idle again — the agent has done what the prompt asked — the files
  // it touched can be written onto that row (prompt blame, `agent_prompt_blame`).
  const waitingForIdle = useRef(
    new Map<string, { ptyId: string; submittedAt: number; recordId: string; projectId: string; schedule: ScheduledAgentPrompt; occurrence: string; recorded: boolean; blamed?: boolean }>(),
  );

  useEffect(() => {
    ensureLiveTargetIds();
    let disposed = false;
    const notifiedProposals = new Set<string>();
    let unlisten: (() => void) | undefined;

    const loadBindings = async () => {
      await Promise.all(bindings().map((binding) =>
        useAgentSchedulesStore.getState().load(binding.projectId, binding.scheduleTargetId).catch(() => []),
      ));
    };

    // A tick asked for while one runs (a phone prompt arriving mid-sweep)
    // runs once more after it rather than waiting for the next sweep.
    let again = false;
    const tick = async (): Promise<void> => {
      if (disposed) return;
      if (running.current) {
        again = true;
        return;
      }
      // Another Tabtivity window holds the timer lease: it delivers, this one
      // does not (headless owner plan, H2 interim).
      if (!holdsTimerLease()) return;
      running.current = true;
      again = false;
      try {
        const now = new Date();
        for (const binding of bindings()) {
          if (disposed) break;
          const key = bindingKey(binding);
          const input = scheduledAgentInput(binding.scheduleTargetId);
          const waiting = waitingForIdle.current.get(key);
          if (waiting) {
            if (!waiting.recorded) {
              try {
                await retire(binding, waiting.schedule, { occurrence: waiting.occurrence, result: "delivered" });
                waiting.recorded = true;
              } catch { continue; }
            }
            const ready = (stableMs?: number) => !disposed && scheduledAgentInput(binding.scheduleTargetId)?.ptyId === waiting.ptyId
              && completedTurn(waiting.ptyId, waiting.submittedAt, stableMs);
            // No silence fallback and no timeout bypass where the agent has
            // hooks: a long tool or an approval wait must not release the next
            // prompt, even on another tab. The one exception is a tab whose
            // agent has never reported a verdict (see `completedTurn`).
            if (!ready()) {
              // The turn a delivery started is still going: a phone prompt
              // joins the CLI's queue all the same.
              if (input) {
                const pending = useAgentSchedulesStore.getState().byTarget[key]
                  ?? await useAgentSchedulesStore.getState()
                    .load(binding.projectId, binding.scheduleTargetId)
                    .catch(() => []);
                await queueDuePhoneHold(binding, input, pending, now);
              }
              continue;
            } else {
              // Best-effort and off the delivery path: a row the user already
              // cleared, or a project without a local repo, records nothing.
              if (waiting.recordId) {
                // Once: the after-link idle window keeps this entry for
                // minutes, re-entering here every tick.
                if (!waiting.blamed) {
                  waiting.blamed = true;
                  void useAgentPromptsStore
                    .getState()
                    .blame(waiting.projectId, waiting.recordId, new Date(waiting.submittedAt).toISOString())
                    .catch(() => []);
                }
                try { if (!await continueAfterDelivery(binding, waiting.recordId, ready)) continue; } catch { continue; }
              }
              waitingForIdle.current.delete(key);
            }
          }

          let schedules = useAgentSchedulesStore.getState().byTarget[key];
          if (!schedules) {
            schedules = await useAgentSchedulesStore.getState()
              .load(binding.projectId, binding.scheduleTargetId)
              .catch(() => []);
          }
          if (schedules.some(isAgentProposal)) {
            if (!notifiedProposals.has(key)) {
              notifiedProposals.add(key);
              noteScheduleProposal(`${binding.projectId}:${binding.tab.key}`);
            }
          } else notifiedProposals.delete(key);
          // Rules that finished before this ran — written by an older build, or
          // left behind by a crash between the receipt and the retire — are
          // moved to the history the same way, so the menu ends up holding only
          // rules with a future whatever wrote them.
          const finished = schedules.filter(isFinishedOneTime);
          if (finished.length > 0) {
            for (const schedule of finished) {
              await retire(binding, schedule, {
                occurrence: schedule.last?.occurrence ?? "",
                result: schedule.last?.result ?? "delivered",
              }).catch(() => {});
            }
            schedules = useAgentSchedulesStore.getState().byTarget[key] ?? [];
          }

          for (const schedule of sortSchedules(schedules, now)) {
            const verdict = scheduleVerdict(schedule, now);
            if (verdict.kind === "none") continue;
            if (verdict.kind === "missed") {
              const claimed = await invoke<boolean>("agent_schedule_claim", {
                projectId: binding.projectId,
                scheduleTargetId: binding.scheduleTargetId,
                scheduleId: schedule.id,
                occurrence: verdict.occurrence.key,
              }).catch(() => false);
              if (claimed) {
                await complete(binding, schedule.id, verdict.occurrence.key, "missed").catch(() => {});
                await retire(binding, schedule, {
                  occurrence: verdict.occurrence.key,
                  result: "missed",
                }).catch(() => {});
              }
              continue;
            }

            // Delivery waits inside the one-hour window until the PTY exists,
            // has settled, is idle, and is not on an approval/decision prompt.
            // The tab being focused is deliberately not part of this gate.
            // Only a phone prompt goes in meanwhile.
            if (!input || !idleForDelivery(input)) {
              if (input) await queueDuePhoneHold(binding, input, schedules, now);
              break;
            }

            forgetPhoneHold(schedule.id);
            const claimed = await invoke<boolean>("agent_schedule_claim", {
              projectId: binding.projectId,
              scheduleTargetId: binding.scheduleTargetId,
              scheduleId: schedule.id,
              occurrence: verdict.occurrence.key,
            }).catch(() => false);
            if (!claimed) continue;
            let submittedAt = Date.now();
            try {
              // Claiming crosses IPC. Recheck before the first keystroke in
              // case the human or another input path started a turn meanwhile.
              if (!input.ready() || scheduledAgentInput(binding.scheduleTargetId) !== input
                  || !agentDeliveryReady(input.ptyId, COMPLETION_STABLE_MS)
                  || useActivityStore.getState().busyByTab[input.ptyId]
                  || useActivityStore.getState().attentionByTab[input.ptyId] === "decision") throw new Error("agent readiness changed");
              const ptyId = await submitScheduledAgentMessage(
                binding.scheduleTargetId,
                schedule.message,
                { preface: schedule.preface, settle: settleBetweenSubmissions, beforeMessage: () => { submittedAt = Date.now(); } },
              );
              // Completion after all writes means a partial/write failure becomes
              // `failed`; the durable claim prevents retry in either case.
              await complete(binding, schedule.id, verdict.occurrence.key, "delivered");
              const waiting = {
                ptyId,
                submittedAt,
                projectId: binding.projectId,
                recordId: deliveryRecordId(schedule, verdict.occurrence.key),
                schedule,
                occurrence: verdict.occurrence.key,
                recorded: false,
              };
              waitingForIdle.current.set(key, waiting);
              await retire(binding, schedule, {
                occurrence: verdict.occurrence.key,
                result: "delivered",
              }).then(() => { waiting.recorded = true; }).catch(() => {});
            } catch {
              await complete(binding, schedule.id, verdict.occurrence.key, "failed").catch(() => {});
              await retire(binding, schedule, {
                occurrence: verdict.occurrence.key,
                result: "failed",
              }).catch(() => {});
            }
            // At most one delivery per target per tick. The next waits for output
            // and a fresh idle point through `waitingForIdle` above.
            break;
          }
        }
      } finally {
        running.current = false;
      }
      if (again) return tick();
    };

    void loadBindings().then(tick);
    const timer = setInterval(() => void tick(), TICK_MS);
    // A phone prompt goes in now, not on the next sweep.
    const stopPhoneHolds = onPhoneHoldDue(() => void tick());
    // Backend reads prune proposals after seven days, even when no MCP client
    // or schedule dialog has been opened since they arrived.
    const proposalPruneTimer = setInterval(() => void loadBindings().then(tick), 60 * 60_000);
    void listen("agent-schedules-changed", () => {
      for (const projectId of new Set(bindings().map((b) => b.projectId))) void persistScopeLayout(projectId);
      void useAgentSchedulesStore.getState().refreshLoaded().then(tick);
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    });

    // Delete schedules when their tab disappears from the live store. All tab
    // movement/locality/detach operations retain the binding, so they never hit
    // this diff. A startup GC separately removes targets absent from both live
    // and restorable state (including non-resumable tabs from the prior run).
    //
    // A scope whose KEY vanished is not a closed tab: `unloadScope` (stopping a
    // project) drops the whole in-memory scope while its layout stays on disk and
    // restores — same target ids — when the project is activated again. Deleting
    // there lost every schedule of a stopped project, exactly the state an app
    // restart keeps. So a binding is deleted only while its scope still exists
    // (`closeAllTabs` empties the scope but keeps the key, so a real close of
    // every tab still deletes); a vanished scope only forgets its idle wait, and
    // any target its saved layout no longer names is the startup sweep's to drop.
    let previous = new Map(bindings().map((binding) => [bindingKey(binding), binding]));
    const unsubscribe = useTabsStore.subscribe(() => {
      const scopes = useTabsStore.getState().tabsByScope;
      const current = new Map(bindings().map((binding) => [bindingKey(binding), binding]));
      for (const [key, binding] of previous) {
        if (current.has(key)) continue;
        waitingForIdle.current.delete(key);
        if (!Object.prototype.hasOwnProperty.call(scopes, binding.projectId)) continue;
        void invoke("agent_schedules_delete_target", {
          projectId: binding.projectId,
          scheduleTargetId: binding.scheduleTargetId,
        }).catch(() => {});
      }
      for (const [key, binding] of current) {
        if (!previous.has(key)) {
          void useAgentSchedulesStore.getState()
            .load(binding.projectId, binding.scheduleTargetId)
            .then(tick)
            .catch(() => {});
        }
      }
      previous = current;
    });

    const cleanupTimer = setTimeout(() => {
      const live = bindings().map((binding) => ({
        projectId: binding.projectId,
        scheduleTargetId: binding.scheduleTargetId,
      }));
      void invoke("agent_schedules_cleanup_orphans", { live }).catch(() => {});
    }, 2_000);

    return () => {
      disposed = true;
      clearInterval(timer);
      stopPhoneHolds();
      clearInterval(proposalPruneTimer);
      clearTimeout(cleanupTimer);
      unsubscribe();
      unlisten?.();
    };
  }, []);

  return null;
}
