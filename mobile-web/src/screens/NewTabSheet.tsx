import { useEffect, useState } from "react";
import { getLaunchOptions, type AgentRow, type CloudLaunchRow, type LaunchOptions, type LocalLaunchRow, type SignInRow } from "../api";
import { isUntested } from "../../../src/lib/untested";
import { useT } from "../../../src/lib/i18n";

/** How the tap wants the agent started, beyond which agent and mode. */
export interface NewTabLaunch {
  /** A linked worktree's opaque id; absent → the project folder. */
  worktree?: string;
  cloud?: "new" | "open";
  task?: string;
  /** A sign-in tab: the CLI's own login, in the flow a phone can finish. */
  sign_in?: "default" | "alternate";
  /** A local-model agent: the opaque id `launch-options` listed. */
  local?: string;
}

/**
 * What the project header's ＋ opens: a shell, a document from this phone into
 * the project's inbox (`useProjectInbox`), or one of the agents this desktop
 * offers, in the modes it offers them in.
 *
 * These are the buttons that used to stand at the foot of the project screen,
 * under every tab card. The sheet puts a shell action first and keeps the
 * agent choices in a compact grid, with each agent's modes inside its tile.
 *
 * Where an agent starts is the desktop "+"'s question too: a project with
 * linked worktrees gets an "Agents start in" row, and an agent with a cloud
 * session gets ☁ buttons in its tile (`src/lib/agents/cloudSessions.ts`). Both
 * come from `launch-options`, asked once the sheet opens; until it answers, the
 * sheet is the plain one. A ☁ New for a CLI that takes its task on the command
 * line swaps the grid for a task box first.
 *
 * A desktop with a local (Ollama) model set for tabs adds the desktop "+"'s
 * local-model group under the agents: the same agents, driving that model.
 *
 * "Sign in to an agent" lists every agent with the state of its shared login
 * and opens a sign-in tab for the one picked (`src/lib/agents/signInLaunch.ts`)
 * — the reader never has to find a login command or a menu row in a session.
 *
 * Creating is the caller's: it owns the idempotency keys and the jump into the
 * new session, and the sheet closes on the tap rather than waiting for the
 * desktop, so a slow create is a screen the reader can still read.
 */
export function NewTabSheet({ projectId, agents, shells, busy, headless = false, onPick, onSendFile, onClose }: {
  projectId: string;
  agents: AgentRow[];
  /** The desktop lets the phone open shells (off by default). */
  shells: boolean;
  /** A create in flight; the file row ignores it. */
  busy: boolean;
  /** No desktop window: a shell or a plain agent is started by the host
   *  itself (headless owner plan, H1b) and picked up by the next window;
   *  a mode, a worktree, a cloud session, a local model or a sign-in still
   *  needs the window — those leave the grid for one folded group. */
  headless?: boolean;
  onPick: (kind: "shell" | "agent", agent?: AgentRow, mode?: string, launch?: NewTabLaunch) => void;
  /** Opens the phone's file picker; runs inside the tap, which the picker needs. */
  onSendFile: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [options, setOptions] = useState<LaunchOptions>({ worktrees: [], cloud: [], sign_in: [] });
  const [signingIn, setSigningIn] = useState(false);
  /** The picked worktree's id; "" is the project folder. */
  const [where, setWhere] = useState("");
  /** The ☁ New waiting on its task. */
  const [asking, setAsking] = useState<{ agent: AgentRow; launch: CloudLaunchRow } | null>(null);
  const [task, setTask] = useState("");
  useEffect(() => {
    const abort = new AbortController();
    getLaunchOptions(projectId, abort.signal).then(setOptions, () => { /* plain sheet */ });
    return () => abort.abort();
  }, [projectId]);
  const linked = options.worktrees.filter((row) => !row.main);
  const pickAgent = (agent: AgentRow, mode?: string) =>
    onPick("agent", agent, mode, where ? { worktree: where } : undefined);
  const pickCloud = (agent: AgentRow, launch: CloudLaunchRow) => {
    if (launch.task) { setTask(""); setAsking({ agent, launch }); return; }
    onPick("agent", agent, undefined, { cloud: launch.action });
  };
  return <div className="sheet-backdrop" role="presentation" onClick={onClose}>
    <section className="option-sheet new-tab-sheet" role="dialog" aria-modal="true" aria-label={t("mobile.newTab.title")} onClick={(event) => event.stopPropagation()}>
      <span className="sheet-grip" aria-hidden="true" />
      <header><button className="sheet-close" onClick={onClose} aria-label={t("mobile.newTab.close")}>✕</button><h2>{t("mobile.newTab.title")}{isUntested("mobile.project.newTab") && <small>{t("mobile.newTab.untested")}</small>}</h2><span className="sheet-close" aria-hidden="true" /></header>
      {signingIn ? <SignInList agents={agents} rows={options.sign_in} busy={busy} onPick={(agent, way) => onPick("agent", agent, undefined, { sign_in: way })} onBack={() => setSigningIn(false)} />
      : asking ? <div className="mobile-schedule-form">
        <h3>{t("mobile.newTab.cloudTaskTitle", { agent: asking.agent.label })}{isUntested("mobile.newTab.cloud") && <span className="untested">{t("mobile.newTab.untested")}</span>}</h3>
        <p className="sheet-note">{t("mobile.newTab.cloudTaskHint")}</p>
        <textarea rows={4} maxLength={4000} value={task} autoFocus aria-label={t("mobile.newTab.cloudTaskTitle", { agent: asking.agent.label })} onChange={(event) => setTask(event.target.value)} />
        <div className="mobile-schedule-actions">
          <button onClick={() => setAsking(null)}>{t("mobile.newTab.cloudTaskCancel")}</button>
          <button className="primary" disabled={busy || !task.trim()} onClick={() => onPick("agent", asking.agent, undefined, { cloud: asking.launch.action, task: task.trim() })}>{t("mobile.newTab.cloudTaskStart")}</button>
        </div>
      </div> : <>
      <p className="sheet-note">{t("mobile.newTab.note")}</p>
      {headless && <p className="sheet-note">{t("mobile.newTab.headless")}{isUntested("mobile.headless") && <span className="untested">{t("mobile.newTab.untested")}</span>}</p>}
      <div className="create">
        {shells && <button className="primary" disabled={busy} onClick={() => onPick("shell")}>{t("mobile.newTab.shell")}</button>}
        {linked.length > 0 && agents.length > 0 && !headless && <div className="new-tab-where" role="group" aria-label={t("mobile.newTab.where")}>
          <small>{t("mobile.newTab.where")}{isUntested("mobile.newTab.worktree") && <span className="untested">{t("mobile.newTab.untested")}</span>}</small>
          <button className={where === "" ? "selected" : ""} aria-pressed={where === ""} onClick={() => setWhere("")}>{t("mobile.newTab.projectFolder")}</button>
          {linked.map((row) => <button key={row.id} className={where === row.id ? "selected" : ""} aria-pressed={where === row.id} title={row.label} onClick={() => setWhere(row.id)}>{row.branch || row.label}</button>)}
        </div>}
        <div className="new-tab-agents">{agents.map((agent) => <div className="agent-create" key={agent.id}>
          <button disabled={busy} onClick={() => pickAgent(agent)}>{agent.label}</button>
          {!headless && agent.modes.map((mode) => <button className="mode" disabled={busy} key={mode} onClick={() => pickAgent(agent, mode)}>{mode}</button>)}
          {!headless && options.cloud.filter((launch) => launch.agent_id === agent.id).map((launch) => <button className="mode" disabled={busy} key={`cloud:${launch.action}`} onClick={() => pickCloud(agent, launch)}>{t(launch.action === "new" ? "mobile.newTab.cloudNew" : "mobile.newTab.cloudOpen")}</button>)}
        </div>)}</div>
        {/* A desktop that reports no agents still opens shells — say so, rather
            than leaving the sheet looking half-loaded. */}
        {agents.length === 0 && <p className="sheet-note">{t("mobile.newTab.noAgents")}</p>}
        {options.local && !headless && <LocalModelGroup local={options.local} busy={busy} onPick={(id) => onPick("agent", undefined, undefined, { local: id })} />}
        {options.sign_in.length > 0 && !headless && <SignInEntry rows={options.sign_in} onOpen={() => setSigningIn(true)} />}
        {headless && <NeedsWindow agents={agents} options={options} linked={linked} />}
        {/* At the sheet's foot, under everything that opens a tab. No desktop
            round trip — the sidecar writes the file itself — so neither a
            create in flight nor an absent desktop holds it back. */}
        <button className="new-tab-file" onClick={onSendFile}>
          <span><strong>{t("mobile.projectInbox.send")}{isUntested("mobile.project.sendFile") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong><small>{t("mobile.projectInbox.hint")}</small></span>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m-5 5 5-5 5 5M5 20h14" /></svg>
        </button>
      </div>
      </>}
    </section>
  </div>;
}

/** With no window, everything only the window can start, folded into one
 * group at the sheet's foot — the reader sees what waits without a sheet of
 * dead buttons to tap: an agent's modes and ☁ sessions, the linked
 * worktrees, the local model's agents and the sign-in list. */
function NeedsWindow({ agents, options, linked }: { agents: AgentRow[]; options: LaunchOptions; linked: LaunchOptions["worktrees"] }) {
  const t = useT();
  const rows: { key: string; label: string; items: string[] }[] = [];
  for (const agent of agents) {
    const items = [
      ...agent.modes,
      ...options.cloud.filter((launch) => launch.agent_id === agent.id).map((launch) => t(launch.action === "new" ? "mobile.newTab.cloudNew" : "mobile.newTab.cloudOpen")),
    ];
    if (items.length) rows.push({ key: `agent:${agent.id}`, label: agent.label, items });
  }
  if (linked.length && agents.length) rows.push({ key: "where", label: t("mobile.newTab.where"), items: linked.map((row) => row.branch || row.label) });
  if (options.local?.agents.length) rows.push({ key: "local", label: t("mobile.newTab.localGroup", { model: options.local.model }), items: options.local.agents.map((row) => row.label) });
  if (options.sign_in.length) rows.push({ key: "sign-in", label: t("mobile.signIn.listEntry"), items: [] });
  if (!rows.length) return null;
  const count = rows.reduce((sum, row) => sum + Math.max(row.items.length, 1), 0);
  return <details className="new-tab-held">
    <summary>{t("mobile.newTab.needsWindow", { count: String(count) })}{isUntested("mobile.newTab.needsWindow") && <span className="untested">{t("mobile.newTab.untested")}</span>}</summary>
    <ul>{rows.map((row) => <li key={row.key}><strong>{row.label}</strong>{row.items.length > 0 && <span>{row.items.join(" · ")}</span>}</li>)}</ul>
  </details>;
}

/** The local-model agents, as the desktop "+" groups them under the model's
 * name. A model not yet on the GPU still offers them — the phone cannot watch
 * a load the way the desktop menu does — and says the first answer waits. */
function LocalModelGroup({ local, busy, onPick }: { local: LocalLaunchRow; busy: boolean; onPick: (id: string) => void }) {
  const t = useT();
  const cautioned = local.agents.filter((row) => row.caution).map((row) => row.label);
  return <div className="new-tab-local" role="group" aria-label={t("mobile.newTab.localGroup", { model: local.model })}>
    <small>{t("mobile.newTab.localGroup", { model: local.model })}{isUntested("mobile.newTab.local") && <span className="untested">{t("mobile.newTab.untested")}</span>}</small>
    <div className="new-tab-agents">{local.agents.map((row) => <div className="agent-create" key={row.id}>
      <button disabled={busy} onClick={() => onPick(row.id)}>{row.label}</button>
    </div>)}</div>
    {!local.ready && <p className="sheet-note">{t("mobile.newTab.localLoads", { model: local.model })}</p>}
    {cautioned.length > 0 && <p className="sheet-note">{t("mobile.newTab.localCaution", { agents: cautioned.join(", ") })}</p>}
  </div>;
}

/** The ＋ sheet's way into the sign-in list, saying how many agents wait for
 * a login. */
function SignInEntry({ rows, onOpen }: { rows: SignInRow[]; onOpen: () => void }) {
  const t = useT();
  const missing = rows.filter((row) => row.signed_in === false).length;
  return <button className="new-tab-file" onClick={onOpen}>
    <span>
      <strong>{t("mobile.signIn.listEntry")}{isUntested("mobile.signIn.tab") && <span className="untested">{t("mobile.newTab.untested")}</span>}</strong>
      <small>{missing > 0 ? t("mobile.signIn.listMissing", { count: String(missing) }) : t("mobile.signIn.listHint")}</small>
    </span>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 16l4-4-4-4M14 12H4" /></svg>
  </button>;
}

/** Every agent the desktop can sign in, with its login state and a Sign in
 * button — and, where the CLI has one, its other way in. */
function SignInList({ agents, rows, busy, onPick, onBack }: {
  agents: AgentRow[];
  rows: SignInRow[];
  busy: boolean;
  onPick: (agent: AgentRow, way: "default" | "alternate") => void;
  onBack: () => void;
}) {
  const t = useT();
  const byId = new Map(rows.map((row) => [row.agent_id, row]));
  const listed = agents.flatMap((agent) => {
    const row = byId.get(agent.id);
    return row ? [{ agent, row }] : [];
  });
  return <div className="sign-in-list">
    <h3>{t("mobile.signIn.listTitle")}</h3>
    <p className="sheet-note">{t("mobile.signIn.listNote")}</p>
    {listed.map(({ agent, row }) => <div className="sign-in-agent" key={agent.id}>
      <span>
        <strong>{agent.label}</strong>
        {row.signed_in !== undefined && <small className={row.signed_in ? "signed-in" : "signed-out"}>
          {row.api_key && row.api_budget_reached
            ? <>{t("mobile.signIn.apiBudgetReached")}{isUntested("mobile.signIn.apiBudgetReached") && <span className="untested">{t("mobile.newTab.untested")}</span>}</>
            : row.api_key
            ? <>{t("mobile.signIn.apiKey")}{isUntested("mobile.signIn.apiKey") && <span className="untested">{t("mobile.newTab.untested")}</span>}</>
            : row.signed_in
              ? row.account ? t("mobile.signIn.signedInAs", { account: row.account }) : t("mobile.signIn.signedIn")
              : t("mobile.signIn.signedOut")}
        </small>}
      </span>
      <button className={row.signed_in ? "" : "primary"} disabled={busy} onClick={() => onPick(agent, "default")}>
        {row.signed_in ? t("mobile.signIn.again") : t("mobile.signIn.start")}
      </button>
      {row.alternate && <button className="sign-in-alternate" disabled={busy} onClick={() => onPick(agent, "alternate")}>
        {row.alternate === "console" ? t("mobile.signIn.alternateConsole") : t("mobile.signIn.alternateBrowser")}
      </button>}
    </div>)}
    <p className="sheet-note">{t("mobile.signIn.switchNote")}</p>
    <div className="mobile-schedule-actions"><button onClick={onBack}>{t("mobile.signIn.back")}</button></div>
  </div>;
}
