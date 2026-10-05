import { useEffect, useRef } from "react";
import { nextUsageReset, parseUsageReport } from "../../../shared/usageReport";
import { readAgentUsage } from "../../lib/agents/agentUsage";
import { localOccurrenceKey } from "../../lib/agents/agentSchedule";
import { submitScheduledAgentMessage, scheduledAgentInput } from "../../lib/agents/scheduledAgentInput";
import { lastPtyOutputAt, useActivityStore } from "../../stores/activity";
import { recordScheduledDelivery } from "../../stores/agents/agentPrompts";
import { continueKey, useAgentContinueStore } from "../../stores/agents/agentContinue";
import { useTabsStore, type TabEntry } from "../../stores/tabs";
import { scheduleCacheKey, useAgentSchedulesStore } from "../../stores/agents/agentSchedules";
import { holdsTimerLease } from "../../stores/timerLease";

/**
 * Keeps an agent tab going across its own CLI's rate-limit windows.
 *
 * One switch per tab (`TabEntry.autoContinue`, flipped in the Agents view). While
 * it is on this host reads that agent's usage panel — the same client-side
 * `agent_usage` run the phone's status sheet uses, which spends no quota — finds
 * the soonest window the panel says will roll over, and submits a single
 * `continue` a minute after it does. Then it reads the panel again, which now
 * describes the fresh window, and arms the next one. That loop is the whole
 * feature: a limit is reached, and the work picks itself up when the limit lifts
 * instead of when somebody notices.
 *
 * What it deliberately is NOT:
 *  - a scheduler. Nothing is written to `agent_tasks.json`; a rule the user did
 *    not make has no business appearing in the tab's schedule menu next to the
 *    ones they did. The only persisted trace is the switch itself.
 *  - a way to choose the agent's mode or model. It submits one word into the
 *    tab, through the same composer path everything else uses.
 *
 * It reuses the scheduler's delivery path and its gate (`lib/agents/scheduledAgentInput`
 * plus the idle/decision/settle checks): a continue typed into a tab that is
 * mid-turn or sitting on an approval prompt is at best ignored and at worst
 * answers a question the user was being asked. See `deliverable` for the one
 * place the gate is deliberately looser than the scheduler's, and why.
 */

/** The word submitted at a rollover. Not configurable on purpose: the composer
 *  right above this switch in the Agents view is where a tab gets told anything
 *  else, and a per-tab custom string would make an unattended send unpredictable
 *  from the switch alone. */
export const CONTINUE_MESSAGE = "continue";

const TICK_MS = 30_000;

/** How long after the window rolls over the continue goes in. The user's minute:
 *  a CLI that has just reset can still refuse a request racing the boundary. */
export const CONTINUE_DELAY_MS = 60_000;

/** After a send, the panel is left alone this long before being read again. It
 *  is asked with `refresh`, but a CLI polled the instant it was written to still
 *  describes the window that just ended; waiting is what makes the next arm the
 *  NEXT window rather than the one already spent. */
const REARM_AFTER_SEND_MS = 90_000;

/** Gap before a panel that could not be read, or an agent that answered with an
 *  error, is asked again. Long enough not to respawn a CLI on a loop. */
const RETRY_MS = 5 * 60_000;

/** An agent with no usage readout at all cannot grow one while Tabtivity runs, so
 *  this only exists to stop the (cheap, spawn-free) refusal being re-fetched
 *  every tick. Turning the switch off and on again asks immediately. */
const UNSUPPORTED_RETRY_MS = 60 * 60_000;

/** How long a due continue keeps waiting for a safe idle point before its
 *  occurrence is abandoned and the next window read instead. Matches the
 *  scheduler's catch-up window: past an hour, "continue" is answering a
 *  situation that has moved on. */
const CATCH_UP_MS = 60 * 60_000;

/** The PTY must have been quiet this long. Same figure the scheduler uses. */
const OUTPUT_SETTLE_MS = 1_200;

interface Binding {
  projectId: string;
  scheduleTargetId: string;
  tab: TabEntry;
}

/** Every agent tab whose auto-continue switch is on, across every loaded scope —
 *  the feature is unattended, so it must not depend on which project is open. */
function bindings(): Binding[] {
  return Object.entries(useTabsStore.getState().tabsByScope).flatMap(([projectId, tabs]) =>
    tabs.flatMap((tab) =>
      (tab.kind === "agent" || tab.kind === "local_agent") && tab.autoContinue && tab.scheduleTargetId
        ? [{ projectId, scheduleTargetId: tab.scheduleTargetId, tab }]
        : [],
    ),
  );
}

/** Which tabs are switched on, as one comparable string. */
function signature(): string {
  return bindings()
    .map((binding) => continueKey(binding.projectId, binding.scheduleTargetId))
    .sort()
    .join("\n");
}

/**
 * The scheduler's gate: no turn in flight, no approval prompt on screen, and
 * output that has stopped moving.
 *
 * One deliberate difference. The scheduler reads a tab that has produced *no*
 * output at all as not-yet-settled and waits; here that means quiet. A tab
 * whose output the activity store has never seen — the ordinary state of a
 * restored agent tab until it prints something — is idle by every signal
 * available (`busyByTab` is fed from that same output), and waiting on it costs
 * this loop the whole window: a missed rollover is not retried in an hour, it
 * is retried at the *next* reset, hours later, which is exactly the wait the
 * switch exists to remove.
 */
function deliverable(ptyId: string): boolean {
  const activity = useActivityStore.getState();
  if (activity.busyByTab[ptyId]) return false;
  if (activity.attentionByTab[ptyId] === "decision") return false;
  const lastOutput = lastPtyOutputAt(ptyId);
  return lastOutput === undefined || Date.now() - lastOutput >= OUTPUT_SETTLE_MS;
}

export function AgentContinueHost() {
  const running = useRef(false);

  useEffect(() => {
    let disposed = false;

    /** Read the panel and arm the next rollover, or record why we cannot. */
    const arm = async (binding: Binding, key: string, refresh: boolean): Promise<void> => {
      const patch = useAgentContinueStore.getState().patch;
      patch(key, { phase: "reading" });
      const report = await readAgentUsage(binding.tab.cmd, refresh);
      if (disposed) return;
      const now = Date.now();
      if (!report.supported) {
        patch(key, {
          phase: "unsupported",
          armedAt: undefined,
          error: report.error,
          checkAt: now + UNSUPPORTED_RETRY_MS,
        });
        return;
      }
      if (!report.raw) {
        patch(key, {
          phase: "error",
          armedAt: undefined,
          error: report.error,
          checkAt: now + RETRY_MS,
        });
        return;
      }
      const reset = nextUsageReset(parseUsageReport(report.raw), new Date(now));
      if (!reset) {
        // A panel with no placeable rollover is not an error — a fresh account
        // shows percentages with no `resets` beside them — but there is nothing
        // to arm off, and saying so beats arming off a guess.
        patch(key, {
          phase: "unreadable",
          armedAt: undefined,
          error: undefined,
          checkAt: now + RETRY_MS,
        });
        return;
      }
      patch(key, {
        phase: "armed",
        armedAt: reset.at.getTime() + CONTINUE_DELAY_MS,
        window: reset.label,
        resets: reset.resets,
        error: undefined,
        checkAt: undefined,
      });
    };

    /** Submit one continue, once the tab is in a state to take it. */
    const send = async (binding: Binding, key: string, armedAt: number): Promise<void> => {
      const store = useAgentContinueStore.getState();
      const input = scheduledAgentInput(binding.scheduleTargetId);
      if (!input || !input.ready() || !deliverable(input.ptyId)) {
        // Not yet — stay armed and try again next tick, until the occurrence is
        // too old to be worth answering.
        if (Date.now() - armedAt <= CATCH_UP_MS) return;
        store.patch(key, { phase: "reading", armedAt: undefined, checkAt: undefined });
        return;
      }
      store.patch(key, { phase: "sending" });
      const sentAt = Date.now();
      let result: "delivered" | "failed" = "delivered";
      let error: string | undefined;
      try {
        await submitScheduledAgentMessage(binding.scheduleTargetId, CONTINUE_MESSAGE);
      } catch (cause) {
        result = "failed";
        error = String(cause);
      }
      if (disposed) return;
      const previous = useAgentContinueStore.getState().byTarget[key];
      useAgentContinueStore.getState().patch(key, {
        phase: result === "delivered" ? "reading" : "error",
        armedAt: undefined,
        error,
        lastSentAt: result === "delivered" ? sentAt : previous?.lastSentAt,
        sent: (previous?.sent ?? 0) + (result === "delivered" ? 1 : 0),
        checkAt: sentAt + (result === "delivered" ? REARM_AFTER_SEND_MS : RETRY_MS),
      });
      // The record, not the delivery: an unattended send that leaves no trace is
      // a tab that answered a prompt nobody can find. Best-effort, and off the
      // delivery path — it has already reached the agent by now.
      void recordScheduledDelivery(
        binding.projectId,
        { id: `continue-${binding.scheduleTargetId}-${sentAt}`, message: CONTINUE_MESSAGE },
        {
          tabLabel: binding.tab.label,
          sessionId: binding.tab.sessionId,
          tabId: binding.scheduleTargetId,
          agent: binding.tab.cmd,
          result,
          scheduledFor: localOccurrenceKey(new Date(armedAt)),
        },
      ).catch(() => {});
    };

    const tick = async () => {
      // Another Tabtivity window holds the timer lease: it continues the agents,
      // this one does not (headless owner plan, H2 interim).
      if (!holdsTimerLease()) return;
      if (disposed || running.current) return;
      running.current = true;
      try {
        const live = bindings();
        const liveKeys = new Set(live.map((b) => continueKey(b.projectId, b.scheduleTargetId)));
        // A switch turned off — or a tab closed — takes its status with it, so
        // the view never shows a countdown for something that is not running.
        for (const key of Object.keys(useAgentContinueStore.getState().byTarget)) {
          if (!liveKeys.has(key)) useAgentContinueStore.getState().forget(key);
        }
        for (const binding of live) {
          if (disposed) break;
          const key = continueKey(binding.projectId, binding.scheduleTargetId);
          const status = useAgentContinueStore.getState().byTarget[key];
          const now = Date.now();
          if (status?.armedAt !== undefined) {
            // An approved agent prompt around this rollover owns the send.
            // Disabled proposals do not suppress the user's auto-continue.
            const rows = useAgentSchedulesStore.getState().byTarget[scheduleCacheKey(binding.projectId, binding.scheduleTargetId)] ?? [];
            if (rows.some((row) => row.origin && row.enabled && row.rule.type === "once"
                && Math.abs(new Date(row.rule.at).getTime() - status.armedAt!) < 60_000)) {
              useAgentContinueStore.getState().patch(key, { phase: "reading", armedAt: undefined, checkAt: status.armedAt + REARM_AFTER_SEND_MS });
              continue;
            }
            if (now >= status.armedAt) await send(binding, key, status.armedAt);
            continue;
          }
          if (status?.checkAt !== undefined && now < status.checkAt) continue;
          // A read that follows a send asks the CLI again rather than taking the
          // cached panel, which still describes the window that has just ended.
          await arm(binding, key, status?.lastSentAt !== undefined);
        }
      } finally {
        running.current = false;
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), TICK_MS);
    // Flipping the switch arms (or clears) immediately instead of at the next
    // tick — half a minute of a button that looks like it did nothing is how a
    // toggle gets pressed twice. Only a change to the SET of switched-on tabs
    // wakes it: the tabs store also moves on every focus and every rename, and
    // a tick per keystroke is a spawned CLI looking for a reason.
    let previous = signature();
    const unsubscribe = useTabsStore.subscribe(() => {
      const current = signature();
      if (current === previous) return;
      previous = current;
      void tick();
    });
    return () => {
      disposed = true;
      clearInterval(timer);
      unsubscribe();
    };
  }, []);

  return null;
}
