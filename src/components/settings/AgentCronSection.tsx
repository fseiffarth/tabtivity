import { useMemo, useState } from "react";
import { ToggleRow } from "../layout/settingsUi";
import { Dropdown } from "../common/Dropdown";
import { useSettingsStore } from "../../stores/settings";
import { useT } from "../../lib/i18n";
import {
  AGENT_CRON_MESSAGE,
  addTime,
  agentCronTimes,
  allAgentsEnabled,
  nextAgentCronRun,
  normalizeTimes,
  removeTime,
  withAgentCronEnabled,
  withAgentCronTimes,
  withAllAgentsEnabled,
  withCronEnabled,
  withGlobalTimes,
  type AgentCron,
} from "../../lib/agents/agentCron";
import { formatTime } from "../../lib/calendar/calendarTime";
import { useUse24h } from "../../lib/timeFormat";
import type { AgentInfo } from "./agentTypes";
import { AgentsFold } from "./agentsUi";

/**
 * A list of local times ("HH:MM"), edited as chips plus an hour/minute picker.
 *
 * The app's own {@link Dropdown} rather than a native `<select>` (WebKitGTK
 * draws that as an unthemed OS menu — the note on the remote-machine picker
 * above) and rather than an `<input type="time">`, which takes its 12-vs-24-hour
 * face from the process locale and ignores both the element's `lang` and
 * `Settings.time_format_24h` (`common/TimeField`'s header documents the probe).
 * Two lists of numbers have neither problem and nothing to mistype.
 *
 * Stored values are always 24-hour; only the chips are printed through the
 * user's clock setting, so the picker says the same thing the board and the
 * calendar do.
 */
function TimeListEditor({
  times,
  onChange,
  disabled,
  emptyLabel,
}: {
  times: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** What to show in place of the chips when the list is empty — "no times yet"
   *  for the global list, "follows the global times" for an agent's own. */
  emptyLabel: string;
}) {
  const t = useT();
  const use24h = useUse24h();
  const [hour, setHour] = useState("09");
  const [minute, setMinute] = useState("00");

  const hours = useMemo(
    () => Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")).map((v) => ({ value: v, label: v })),
    [],
  );
  const minutes = useMemo(
    () => Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map((v) => ({ value: v, label: v })),
    [],
  );
  const pending = `${hour}:${minute}`;

  return (
    <div className="agent-cron-times">
      <div className="agent-cron-chips">
        {times.length === 0 ? (
          <span className="agent-cron-empty">{emptyLabel}</span>
        ) : (
          times.map((time) => (
            <span key={time} className="agent-cron-chip">
              {formatTime(time, use24h)}
              <button
                type="button"
                className="agent-cron-chip-remove"
                title={t("agentCron.removeTime", { time })}
                aria-label={t("agentCron.removeTime", { time })}
                disabled={disabled}
                onClick={() => onChange(removeTime(times, time))}
              >
                ×
              </button>
            </span>
          ))
        )}
      </div>
      <div className="agent-cron-add">
        <Dropdown
          className="agent-cron-unit"
          title={t("agentCron.hourAria")}
          value={hour}
          options={hours}
          disabled={disabled}
          onChange={setHour}
        />
        <span className="agent-cron-colon">:</span>
        <Dropdown
          className="agent-cron-unit"
          title={t("agentCron.minuteAria")}
          value={minute}
          options={minutes}
          disabled={disabled}
          onChange={setMinute}
        />
        <button
          type="button"
          className="settings-btn sm"
          disabled={disabled || times.includes(pending)}
          onClick={() => onChange(addTime(times, pending))}
        >
          {t("agentCron.addTime")}
        </button>
      </div>
    </div>
  );
}

/** "Next: 06:00 tomorrow", or nothing when this agent is not scheduled. */
function NextRunLabel({ cron, cmd }: { cron: AgentCron | undefined; cmd: string }) {
  const t = useT();
  const use24h = useUse24h();
  // Read once per render rather than on a ticking clock: this is a settings
  // panel, and a readout that only refreshes when something is edited is the
  // honest cost of not running a timer behind a screen nobody is watching.
  const now = new Date();
  const next = nextAgentCronRun(cron, cmd, now);
  if (!next) return null;
  const time = formatTime(
    `${String(next.getHours()).padStart(2, "0")}:${String(next.getMinutes()).padStart(2, "0")}`,
    use24h,
  );
  const tomorrow = next.getDate() !== now.getDate();
  return (
    <span className="agent-cron-next">
      {t(tomorrow ? "agentCron.nextTomorrow" : "agentCron.nextToday", { time })}
    </span>
  );
}


/**
 * The scheduled warm-up's global half: the master switch and the time list every
 * participating agent follows unless it names its own.
 *
 * It sits at the top of this panel rather than in a settings section of its own
 * because the thing it schedules is *these* rows — participation is per agent,
 * ticked on the agent's own card a few lines below, and a global switch two
 * panels away from the per-agent one is how half a schedule ends up armed.
 */
export function AgentCronSection({ agents }: { agents: AgentInfo[] | null }) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const cron = settings?.agent_cron;
  const enabled = cron?.enabled === true;
  const times = normalizeTimes(cron?.times);
  // Only an installed agent can be scheduled — a missing CLI would fail once a
  // day, silently, at six in the morning — and only one the backend has a
  // one-shot recipe for can be driven at all. The rest are still listed, greyed
  // with the reason, so "why isn't X here?" never has to be asked.
  const installed = (agents ?? []).filter((a) => a.installed);
  const capable = installed.filter((a) => a.warmup === true).map((a) => a.id);
  const all = allAgentsEnabled(cron, capable);

  return (
    <div className="agents-stack">
      <p className="settings-help">{t("agentCron.help", { message: AGENT_CRON_MESSAGE })}</p>
      <AgentsFold label={t("agents.cronWhenItRuns")}>
        <p className="settings-help">{t("agentCron.runningNote")}</p>
      </AgentsFold>
      <ToggleRow
        label={t("agentCron.enable")}
        checked={enabled}
        onChange={(e) => void updateSettings({ agent_cron: withCronEnabled(cron, e.target.checked) })}
      />
      <div className="agent-cron-block">
        <span className="agent-cron-label">{t("agentCron.globalTimes")}</span>
        <TimeListEditor
          times={times}
          disabled={!enabled}
          emptyLabel={t("agentCron.noTimes")}
          onChange={(next) => void updateSettings({ agent_cron: withGlobalTimes(cron, next) })}
        />
      </div>
      <p className="settings-help">{t("agentCron.globalTimesHelp")}</p>
      <div className="agent-cron-agents">
        <span className="agent-cron-label">{t("agentCron.agentsTitle")}</span>
        {/* One switch for everyone, default off: a bulk flip of the same
            per-agent flags the rows below write, so it reads as "all on" only
            when every capable agent is on, and turning one row off turns it
            back off — never a separate mode the rows would have to argue with. */}
        <ToggleRow
          label={t("agentCron.allAgents")}
          checked={all}
          disabled={!enabled || capable.length === 0}
          title={t("agentCron.allAgentsTitle")}
          onChange={(e) => void updateSettings({ agent_cron: withAllAgentsEnabled(cron, capable, e.target.checked) })}
        />
        {agents === null ? (
          <span className="agent-cron-empty">{t("agents.checkingInstalled")}</span>
        ) : installed.length === 0 ? (
          <span className="agent-cron-empty">{t("agentCron.noAgents")}</span>
        ) : (
          <>
            {/* The same button grid as Project Settings' file-hiding endings —
                one pressed/unpressed button per agent, so twenty CLIs read at
                a glance instead of twenty toggle rows. Muted is off. A CLI the
                backend cannot drive is disabled with the reason in its tip. */}
            <div className="settings-list project-ending-list agent-cron-grid">
              {installed.map((a) => {
                const headless = a.warmup === true;
                const on = headless && cron?.agents?.[a.id]?.enabled === true;
                return (
                  <button
                    type="button"
                    key={a.id}
                    className={`project-ending-toggle${on ? "" : " is-hidden"}`}
                    aria-pressed={on}
                    disabled={!enabled || !headless}
                    onClick={() => void updateSettings({ agent_cron: withAgentCronEnabled(cron, a.id, !on) })}
                    title={
                      !headless
                        ? t("agentCron.noHeadless", { label: a.label })
                        : t(on ? "agentCron.gridOff" : "agentCron.gridOn", { label: a.label, message: AGENT_CRON_MESSAGE })
                    }
                  >
                    {a.label}
                  </button>
                );
              })}
            </div>
            {/* Own times only for the agents that are on: the grid is the
                overview, and a time editor per switched-off agent would bury it. */}
            {installed
              .filter((a) => a.warmup === true && cron?.agents?.[a.id]?.enabled === true)
              .map((a) => (
                <AgentCronRow key={a.id} cmd={a.id} label={a.label} />
              ))}
          </>
        )}
      </div>
    </div>
  );
}

/** One switched-on agent's own times: the list it runs on when the global one
 *  is not what it wants, and when it fires next. Rendered under the grid only
 *  for agents that are on — participation itself is the grid button. */
function AgentCronRow({ cmd, label }: { cmd: string; label: string }) {
  const t = useT();
  const { settings, updateSettings } = useSettingsStore();
  const cron = settings?.agent_cron;
  const master = cron?.enabled === true;
  const own = normalizeTimes(cron?.agents?.[cmd]?.times);
  const effective = agentCronTimes(cron, cmd);

  return (
    <div className="agent-cron-row">
      <span className="agent-cron-name">{label}</span>
      <TimeListEditor
        times={own}
        disabled={!master}
        emptyLabel={t("agentCron.followsGlobal")}
        onChange={(next) => void updateSettings({ agent_cron: withAgentCronTimes(cron, cmd, next) })}
      />
      {/* An agent ticked on with no times anywhere is armed and can never
          fire — the one state the schedule cannot express as a "next run",
          and therefore the one that has to be said out loud. */}
      {effective.length === 0 ? (
        <span className="agent-cron-warn">{t("agentCron.needsTimes")}</span>
      ) : (
        <NextRunLabel cron={cron} cmd={cmd} />
      )}
    </div>
  );
}
