import type { CSSProperties } from "react";
import { promptClock, promptLines, promptsFromTranscript, scheduleClock } from "../agentPrompts";
import type { TabRow, TabSchedules } from "../api";
import { type FileTab } from "../filesPlace";
import type { RowDrag } from "../rowDrag";
import { tabColorCss } from "../tabColors";
import { useT, type TranslationKey } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { AgentStatusMark } from "./AgentStatusPill";
import { AgentModeMarks, SubagentCount, SubagentWorktreeMarks, TurnDuration, WorktreeMark, agentModeClass } from "./AgentModeMarks";
import { FileGlyph } from "./ProjectFiles";

type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** The line under an agent tab, in the words the desktop's Agents view uses:
 * how many prompts are scheduled and when the first one fires. The desktop
 * computed both against its own clock, so the phone only formats them. A tab
 * with none — or a desktop that did not say — gets no line at all: the ◷
 * beside the model is always there to add one. */
export function scheduleLine(schedules: TabSchedules | undefined, t: Translate): string | null {
  if (!schedules || schedules.total === 0) return null;
  const count = schedules.enabled === schedules.total
    ? t("mobile.project.scheduledCount", { count: schedules.total })
    : t("mobile.project.scheduledSome", { enabled: schedules.enabled, total: schedules.total });
  // Desktop-local wall clock, year trimmed: the sheet below spells out the
  // time zone this belongs to.
  return `${count} · ${schedules.next ? t("mobile.project.nextRun", { when: schedules.next.slice(5).replace("T", " ") }) : t("mobile.project.noNextRun")}`;
}

/**
 * What this session was last asked, on the card itself.
 *
 * Always open, and never a disclosure: the question a project screen is opened
 * with is "which of these five tabs is the one I set on the docs" — a label
 * like "claude 3" cannot answer it, and an expander answers it one tap at a
 * time. The newest prompt leads and is given room to wrap; the ones behind it
 * are one line each, enough to recognize a session by its recent history
 * without turning the card into a transcript (the Focus view is that).
 *
 * The prompts still to come lead the list: the soonest scheduled ones, each
 * behind a ◷ and the desktop time it fires, so the list reads from what is
 * next down to what was asked last. A message typed on this phone and not
 * sent yet comes next, drawn like the newest prompt but with no time — it has
 * not gone anywhere.
 */
export function PromptLines({ tab, draft }: { tab: TabRow; draft?: string }) {
  const t = useT();
  const lines = promptLines(tab);
  const scheduled = tab.schedules?.upcoming ?? [];
  return <div className="tab-card-prompts">
    <small className="tab-card-prompts-label">{t("mobile.project.lastPrompts")}</small>
    {scheduled.map((prompt, index) => {
      const when = prompt.at ? scheduleClock(prompt.at) : "";
      return <p className="tab-card-prompt scheduled" key={`scheduled-${prompt.at ?? ""}-${index}`} title={when ? t("mobile.project.scheduledAt", { at: when }) : undefined}>
        <span className="tab-card-prompt-when"><span aria-hidden="true">◷</span> {when}</span>
        <span className="tab-card-prompt-text">{prompt.text}</span>
      </p>;
    })}
    {draft && <p className="tab-card-prompt latest draft">
      <span className="tab-card-prompt-text">{draft}{isUntested("mobile.project.draftLine") && <span className="untested">{t("mobile.newTab.untested")}</span>}</span>
    </p>}
    {lines.length === 0
      ? !draft && <p className="tab-card-prompt empty">{promptsFromTranscript(tab)
        ? t("mobile.project.noPromptsRead")
        : t("mobile.project.openCodeHistory")}</p>
      : lines.map((prompt, index) => {
        const when = promptClock(prompt.at);
        return <p className={index === 0 && !draft ? "tab-card-prompt latest" : "tab-card-prompt"} key={`${prompt.at ?? ""}-${index}`}>
          {when && <span className="tab-card-prompt-when">{when}</span>}
          <span className="tab-card-prompt-text">{prompt.text}</span>
        </p>;
      })}
  </div>;
}

/** `Intl.Segmenter`, which the app's TS lib does not declare yet. */
type GraphemeSegmenter = new (locale?: string, options?: { granularity: "grapheme" }) => { segment(text: string): Iterable<{ segment: string }> };

/** The first user-perceived character, so an emoji or an accented letter is
 * not cut in half — `Intl.Segmenter` where the engine has it, else the first
 * code point. */
export function firstGrapheme(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "?";
  const Segmenter = (Intl as { Segmenter?: GraphemeSegmenter }).Segmenter;
  const first = Segmenter && new Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)[Symbol.iterator]().next();
  if (first && !first.done) return first.value.segment;
  return Array.from(trimmed)[0] ?? "?";
}

/**
 * One session's card on the project screen. The screen keeps the state — the
 * poll, the drag, the swipe, the sheets — and the card only draws a row and
 * reports taps back.
 *
 * A leading tile (the agent's initial) carries the state badge on its corner;
 * the first line is the name with the one-tap controls a phone reaches for
 * (model, ◷ when there is a schedule, ⋯, ✕), the second what the session is
 * doing (turn time, PLAN/GOAL, worktree, subagents), then what it was asked.
 * Rename, colour and the rest live behind ⋯ (`moreFor`).
 */
export function TabCard({ tab, draft, statusShown, drag, canReorder, schedulesOffered, swiped, closing, moreOpen, scheduleOpen, restart, onOpen, onModel, onMore, onSchedule, onSubagents, onClose }: {
  tab: TabRow;
  /** What this phone's composer holds for the tab, unsent (`draftPreview`). */
  draft?: string;
  /** False once a finished or interrupted tab has been opened here. */
  statusShown: boolean;
  drag: RowDrag;
  canReorder: boolean;
  /** The tab's schedules can be reached: the host has tmux, and a tab on
   * the remote host has a window to type them (`schedulesOffered`). */
  schedulesOffered: boolean;
  /** A swipe is closing this card: it slides out while the desktop answers. */
  swiped: boolean;
  /** Some close is in flight: every ✕ waits for it. */
  closing: boolean;
  moreOpen: boolean;
  scheduleOpen: boolean;
  /** Set on an agent tab: one the desktop started
   * before the project's Mobile switch went on runs outside tmux and is listed
   * as not available, so the card still opens — by asking the desktop to
   * restart it where the phone can attach (`starting` = this one, `busy` = some
   * tab is). Never on a tab on the remote host (`on_host`), which no restart
   * here brings back. */
  restart?: { busy: boolean; starting: boolean };
  onOpen: () => void;
  onModel: () => void;
  onMore: () => void;
  onSchedule: () => void;
  onSubagents: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const color = tabColorCss(tab.color);
  const agent = tab.kind === "agent";
  // The ◷ is a shortcut to schedules a tab already has; adding the first one
  // is a row of the ⋯ sheet, so a card without any spends no width on it.
  const scheduled = agent && schedulesOffered && (tab.schedules?.total ?? 0) > 0;
  const schedule = agent ? scheduleLine(tab.schedules, t) : null;
  return <div
    className={`tab-card${color ? " has-tab-color" : ""}${agentModeClass(tab)}${drag.rowClass(tab.id)}${swiped ? " swiped-out" : ""}`}
    data-swipe-close={tab.id}
    ref={drag.rowRef(tab.id)}
    // The desktop marks a coloured tab with its bottom rule; a phone card has
    // no such edge to spend, so the colour becomes the card's left stripe —
    // the same "which of these five is which" job, in the shape this surface
    // has. The id→hex mapping is the desktop's (see `tabColors.ts`), so the
    // two surfaces show one colour rather than two readings of a name.
    style={color ? { ["--tab-color" as string]: color } as CSSProperties : undefined}
  >
    <div className="tab-card-head">
      {/* The card opens the session. A button cannot hold a button, so the
          opener is a sibling stretched over the whole card — head, prompts
          and foot — and the controls that are not it sit above it. */}
      <div className={`card tab-card-main${tab.available ? "" : " unavailable"}`}>
        <span>
          <span className="tab-card-title">
            {tab.agent_status && statusShown && <AgentStatusMark status={tab.agent_status} />}
            <strong>{tab.label}</strong>
            {/* The model is its own control: a tap opens the session with its
                model picker already up. A local-model tab's is only shown. */}
            {tab.agent_model && tab.local_model && <span className="tab-card-model">{tab.agent_model}</span>}
            {tab.agent_model && !tab.local_model && <button className="tab-card-model" disabled={!tab.available} onClick={onModel} aria-haspopup="dialog" aria-label={t("mobile.project.changeModelOf", { label: tab.label })} title={t("mobile.project.changeModel")}>{tab.agent_model}</button>}
            {tab.agent_model && !tab.local_model && isUntested("mobile.project.modelTap") && <span className="untested">{t("mobile.newTab.untested")}</span>}
            {scheduled && <button className="tab-card-icon accent tab-card-schedule" onClick={onSchedule} aria-haspopup="dialog" aria-expanded={scheduleOpen} aria-label={t("mobile.project.scheduledFor", { label: tab.label })} title={t("agentPrompts.scheduledHeading")}><span aria-hidden="true">◷</span></button>}
            {agent && isUntested("mobile.project.scheduledInPrompts") && <span className="untested">{t("mobile.newTab.untested")}</span>}
          </span>
          {/* What the session is doing, under its name: how long the turn has
              run, PLAN/GOAL, the worktree it (and its subagents) work in, and
              how many subagents are at work — a tap lists them. */}
          <span className="tab-card-meta">
            {/* Runs on the remote project's host, which the phone reaches
                through the desktop's SSH connection. */}
            {tab.on_host && <small className="agent-mode-mark" title={t("mobile.project.onHostTitle")}>{t("mobile.project.onHost")}</small>}
            {tab.on_host && isUntested("mobile.project.onHost") && <span className="untested">{t("mobile.newTab.untested")}</span>}
            {agent && <TurnDuration tab={tab} />}
            <AgentModeMarks tab={tab} />
            <WorktreeMark tab={tab} />
            <SubagentWorktreeMarks tab={tab} />
            <SubagentCount tab={tab} onOpen={tab.available && agent ? onSubagents : undefined} />
          </span>
        </span>
      </div>
      <button className="tab-card-icon tab-card-more" onClick={onMore} aria-haspopup="dialog" aria-expanded={moreOpen} aria-label={t("mobile.files.item.menu", { name: tab.label })} title={t("mobile.files.item.menu", { name: tab.label })}><span aria-hidden="true">⋯</span></button>
      {/* Close is one tap, where a phone looks for it; every tab the phone
          lists offers it, shell included. A swipe left does the same. */}
      <button className="tab-card-icon tab-card-close" disabled={closing} onClick={onClose} aria-label={t("mobile.project.closeTab", { label: tab.label })} title={t("common.close")}><span aria-hidden="true">✕</span></button>
      {/* The grip, under the manual order only. It is also the keyboard's way
          in: the arrows move the tab one place. */}
      {canReorder && <button
        className="tab-card-grip"
        aria-label={t("mobile.home.move", { label: tab.label })}
        title={t("mobile.project.moveHint")}
        {...drag.gripProps(tab.id)}
      ><span aria-hidden="true">⠿</span></button>}
    </div>
    {agent && <PromptLines tab={tab} draft={draft} />}
    {/* The desktop's schedule summary, only when the tab has schedules; the
        upcoming ones are listed with the prompts above. */}
    {schedule && <div className="tab-card-foot">
      <small className="tab-card-when" title={tab.schedules?.next ? t("mobile.project.nextRunTitle", { when: tab.schedules.next.replace("T", " ") }) : undefined}>{schedule}</small>
    </div>}
    {/* A host tab is out of reach while the desktop is not connected to the
        host; it never restarts for the phone, so the card says what to do. */}
    {tab.on_host && !tab.available && <div className="tab-card-foot"><small className="tab-card-when">{t(tab.host_down ? "mobile.project.hostOffline" : "mobile.project.hostSessionEnded")}</small></div>}
    {restart?.starting && !tab.available && <div className="tab-card-foot"><small className="tab-card-when">{t("mobile.project.restarting")}</small>{isUntested("mobile.project.restartForPhone") && <span className="untested">{t("mobile.newTab.untested")}</span>}</div>}
    {/* Last, so it lies over the whole card: a tap anywhere the controls
        above have not claimed opens the session. */}
    <button className="tab-card-open" disabled={restart && !tab.available ? restart.busy : !tab.available} onClick={onOpen} aria-label={t("mobile.project.openTab", { label: tab.label })} />
  </div>;
}

/** The ⋯ sheet's rows for one tab. Their names differ from the card's own
 * buttons ("Rename", not "Rename claude 2"), so each control on the screen
 * keeps one accessible name. */
export type TabAction = "rename" | "color" | "schedule" | "subagents" | "close";

/** Whether a tab's schedules are offered: the host has tmux (`terminals`),
 * and a tab on the remote host only while a desktop window is open — with
 * none, the Mobile host's scheduler types into local tmux only and refuses
 * them (`tab_on_host`). */
export function schedulesOffered(tab: TabRow, terminalsOffered: boolean, desktopAvailable: boolean | undefined): boolean {
  return terminalsOffered && !(tab.on_host && desktopAvailable === false);
}

export function tabActions(tab: TabRow, schedules: boolean): TabAction[] {
  const agent = tab.kind === "agent";
  return [
    ...(agent ? ["rename" as const] : []),
    "color" as const,
    ...(agent && schedules ? ["schedule" as const] : []),
    ...(agent && tab.available && (tab.agent_subagents ?? 0) > 0 ? ["subagents" as const] : []),
    "close" as const,
  ];
}

export const TAB_ACTION_LABEL: Record<TabAction, TranslationKey> = {
  rename: "common.rename",
  color: "mobile.project.colorRow",
  schedule: "agentPrompts.scheduledHeading",
  subagents: "mobile.project.subagentsRow",
  close: "mobile.project.closeRow",
};

/** A phone-side file card: a PDF opened from the drawer or a file being
 * marked up. The desktop opens nothing for it, and ✕ only forgets it here. */
export function FileTabCard({ file, swipeKey, swiped, unsent, linked, onOpen, onForget }: {
  file: FileTab;
  /** The card's key, which a swipe closes it by. */
  swipeKey: string;
  /** A swipe is closing it: it slides out and collapses. */
  swiped: boolean;
  /** Marks not yet submitted. */
  unsent: number;
  /** The agent tab its markup rounds went to, while it is open. */
  linked: TabRow | undefined;
  onOpen: () => void;
  onForget: () => void;
}) {
  const t = useT();
  const name = file.label ?? file.name;
  const markup = file.from === "outbox" || file.tab !== undefined || unsent > 0;
  return <div className={`tab-card file-tab-card${swiped ? " swiped-out" : ""}`} data-swipe-close={swipeKey}>
    <div className="tab-card-head">
      <span className="tab-card-tile file" aria-hidden="true"><FileGlyph kind={file.kind} /></span>
      <div className="card tab-card-main">
        <span>
          <span className="tab-card-title"><strong>{name}</strong>{(markup ? isUntested("mobile.markup.tabs") : isUntested("mobile.files.tabs")) && <span className="untested">{t("mobile.newTab.untested")}</span>}</span>
          <small className="file-tab-place">{file.from === "outbox" ? t("mobile.outbox.region") : file.place || t("mobile.project.fileTab.root")}</small>
          {(unsent > 0 || linked) && <small className="file-tab-markup">
            {unsent > 0 && <span className="file-tab-unsent">{t(unsent === 1 ? "mobile.project.fileTab.unsentOne" : "mobile.project.fileTab.unsent", { count: unsent })}</span>}
            {linked && <span>{t("mobile.project.fileTab.tab", { label: linked.label })}</span>}
          </small>}
        </span>
      </div>
      <button className="tab-card-icon tab-card-close" onClick={onForget} aria-label={t("mobile.project.fileTab.close", { name })} title={t("mobile.project.fileTab.close", { name })}><span aria-hidden="true">✕</span></button>
    </div>
    <button className="tab-card-open" onClick={onOpen} aria-label={t("mobile.project.fileTab.open", { name })} />
    {/* The linked agent's state, on the tile's corner as an agent tab's
        card shows its own. */}
    {linked?.agent_status && <AgentStatusMark status={linked.agent_status} />}
  </div>;
}
