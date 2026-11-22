import { Fragment, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useT } from "../../lib/i18n";
import { wrapStep } from "../../lib/wrapStep";
import { dockModel, type DockAgent } from "../../lib/agents/subagentDock";
import { workingElapsed } from "../../../mobile-web/src/terminal/subagents";
import { UntestedTag } from "../common/UntestedTag";
import { TabStatusMark } from "../tabs/TabLocalityBadges";
import { ChevronLeftIcon } from "../common/icons/Icon";

/**
 * The Chat's dock, pinned between the conversation and its facts row: the
 * working row of what is on screen (the session's, or the open subagent's),
 * then a pill per subagent at work at the level on screen — the session's,
 * or with a subagent open its siblings, the open one marked; an open
 * workflow run's agents under their phases — and one "✓ N done" pill
 * folding the finished ones into the Subagents list, which opens upward.
 * With a subagent open a Main pill leads, going back up a level.
 *
 * Crowding goes by count, never by measuring: past `DOCK_COMPACT_AFTER`
 * pills every pill shows its kind only, past `DOCK_FOLD_AFTER` the rest fold
 * into a `+N` pill that opens the list. The running pills' times count on
 * from one clock, ticking only while the pane is shown and a pill shows one.
 * Draws nothing when it has nothing to say.
 */
export function ReaderSubagentDock({ working, agents, phases = false, earlier, active, listOpen, onListOpen, listId, onPick, onEarlier, main }: {
  /** The working row, drawn first (its classes set by the caller). */
  working?: ReactNode;
  /** The level's subagents; null: no pills at all (an earlier chat browsed). */
  agents: readonly DockAgent[] | null;
  /** Label a workflow run's phases. */
  phases?: boolean;
  /** Subagents only earlier turns hold: counted as done, read in from the list. */
  earlier: number;
  /** The pane is shown with the Chat on it: the clock may tick, keys are heard. */
  active: boolean;
  listOpen: boolean;
  onListOpen: (update: (open: boolean) => boolean) => void;
  listId: string;
  /** A pill or a list row was picked. */
  onPick: (agent: DockAgent, fromList: boolean) => void;
  onEarlier: () => void;
  /** With a subagent open: the Main pill — its short name, its full "Back to …". */
  main?: { label: string; title: string; onUp: () => void };
}) {
  const t = useT();
  const navRef = useRef<HTMLElement>(null);
  const model = agents ? dockModel(agents, { phases, earlier }) : null;
  const nav = !!model && (!!main || model.pills.length > 0 || model.done > 0);
  // Not while hidden: the top bar's list (over Diffs or Data) shares its id.
  const listShown = nav && active && listOpen && (model.done > 0 || model.more > 0);
  const timed = nav && model.timed;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!timed || !active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [timed, active]);

  // The open subagent's pill is kept in sight: in a narrow pane the row
  // scrolls sideways, and it may start outside it.
  const selectedKey = model?.pills.find(({ agent }) => agent.selected)?.agent.key;
  useEffect(() => {
    if (!selectedKey || !active) return;
    navRef.current?.querySelector<HTMLElement>(".terminal-reader-agent-pill.selected")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selectedKey, active]);

  // A click elsewhere or Esc closes the list; Esc hands the focus back to
  // whatever opened it.
  useEffect(() => {
    if (!listShown) return;
    const away = (event: PointerEvent) => {
      if (!navRef.current?.contains(event.target as Node)) onListOpen(() => false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const opener = navRef.current?.querySelector<HTMLButtonElement>("[aria-expanded=\"true\"]");
      onListOpen(() => false);
      opener?.focus();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape, true);
    };
  }, [listShown, onListOpen]);

  if (!working && !nav) return null;
  const agentLabel = t("terminal.reader.subagent");
  const dots = <span className="terminal-reader-working-dots" role="img" aria-label={t("terminal.reader.working")}><i /><i /><i /></span>;
  const openerKeys = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    onListOpen(() => true);
  };

  return (
    <div className="terminal-reader-agent-dock">
      {working}
      {working && nav && <span className="terminal-reader-agent-dock-sep" aria-hidden="true" />}
      {nav && (
        <nav ref={navRef} className="terminal-reader-agents" aria-label={t("mobile.subagent.indexRegion")}>
          <div className="terminal-reader-agents-scroll">
            {main && (
              <button type="button" className="terminal-reader-agent-pill main" onClick={main.onUp} aria-label={main.title} title={`${main.title} (Esc)`}>
                <ChevronLeftIcon /><span>{main.label}</span>
              </button>
            )}
            {model.pills.map(({ agent, phase }) => {
              const time = agent.atWork ? workingElapsed(agent.at, now) : undefined;
              const classes = [
                "terminal-reader-agent-pill",
                agent.selected && "selected",
                !agent.token && "waiting",
                model.compact && "compact",
                !agent.atWork && "finished",
              ].filter(Boolean).join(" ");
              return (
                <Fragment key={agent.key}>
                  {phase && <span className="terminal-reader-agents-phase">{phase}</span>}
                  <button
                    type="button"
                    className={classes}
                    disabled={!agent.token}
                    aria-current={agent.selected ? "true" : undefined}
                    title={agent.token ? agent.task : `${agent.task} — ${t("terminal.reader.subagentStarting")}`}
                    onClick={() => onPick(agent, false)}
                  >
                    {agent.atWork && dots}
                    <b>{agent.role ?? agentLabel}</b>
                    <span className="terminal-reader-agent-pill-task">{agent.task}{agent.cut && "…"}</span>
                    {time && <span className="terminal-reader-agent-pill-time">{time}</span>}
                  </button>
                </Fragment>
              );
            })}
            {model.more > 0 && (
              <button
                type="button"
                className="terminal-reader-agent-pill more"
                aria-expanded={listShown}
                aria-controls={listId}
                title={t("terminal.reader.dockMoreTitle", { count: model.more })}
                onKeyDown={openerKeys}
                onClick={() => onListOpen((was) => !was)}
              >
                {t("terminal.reader.dockMore", { count: model.more })}
              </button>
            )}
          </div>
          <UntestedTag id="terminal.reader.subagentDock" />
          {(model.done > 0 || listShown) && (
            <div className="terminal-reader-agents-done">
              {model.done > 0 && (
                <button
                  type="button"
                  className="terminal-reader-agent-pill done terminal-reader-subagent-toggle"
                  aria-expanded={listShown}
                  aria-controls={listId}
                  title={t("terminal.reader.dockDoneTitle")}
                  onKeyDown={openerKeys}
                  onClick={() => onListOpen((was) => !was)}
                >
                  <TabStatusMark stateClass="finished" />
                  <span>{t("terminal.reader.dockDone", { count: model.done })}</span>
                  <span className={listShown ? "terminal-reader-subagent-caret open" : "terminal-reader-subagent-caret"} aria-hidden="true">▾</span>
                </button>
              )}
              {listShown && (
                <div id={listId} className="terminal-reader-subagent-list" onKeyDown={(event) => {
                  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
                  if (!buttons.length) return;
                  const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
                  const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : wrapStep(at, event.key === "ArrowDown" ? 1 : -1, buttons.length);
                  buttons[next]?.focus();
                }}>
                  {([["running", "mobile.subagent.running"], ["finished", "mobile.subagent.finished"]] as const).map(([group, heading]) => {
                    const rows = model[group];
                    if (rows.length === 0) return null;
                    const title = t(heading, { count: rows.length });
                    return (
                      <section key={group} className="terminal-reader-subagent-group" aria-label={title}>
                        <h3 className="terminal-reader-subagent-head">{title}</h3>
                        {rows.map((agent) => (
                          <button type="button" key={agent.key} disabled={!agent.token} aria-current={agent.selected ? "true" : undefined} onClick={() => onPick(agent, true)}>
                            <small>
                              {agent.role ?? agentLabel}
                              {group === "running" && dots}
                            </small>
                            <span>{agent.task}{agent.cut && "…"}</span>
                          </button>
                        ))}
                      </section>
                    );
                  })}
                  {earlier > 0 && (
                    <button type="button" className="terminal-reader-subagent-earlier" onClick={onEarlier}>
                      {t("mobile.subagent.earlier")}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </nav>
      )}
    </div>
  );
}
