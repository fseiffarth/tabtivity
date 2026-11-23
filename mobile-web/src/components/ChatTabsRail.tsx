import { memo, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import type { TabRow } from "../api";
import { SidebarIcon } from "../glyphs";
import { TerminalIcon } from "../../../src/components/common/icons/Icon";
import { tabColorCss } from "../../../src/lib/theme/tabColors";
import { useT } from "../../../src/lib/i18n";
import { isUntested } from "../../../src/lib/untested";
import { markDoneSeen, markInterruptedSeen, readSeenDone, readSeenInterrupted, showsStatusBadge } from "../seenDone";
import { AGENT_STATUS_WORD, AgentStatusMark, AgentStatusPill } from "./AgentStatusPill";
import { agentModeClass } from "./AgentModeMarks";
import { firstGrapheme } from "./TabCard";

/**
 * The project's tabs beside a tablet's chat, so another tab is one tap away
 * instead of a trip back to the project screen. `rail`: a landscape iPad's
 * floating column on the left of the chat, open (a row per tab) or folded to
 * 64 px tiles. `strip`: a portrait iPad's one scrolling row of chips under the
 * header. `Terminal` mounts it as a sibling of the chat's body, so a turn of
 * the iPad only swaps what is drawn in here.
 *
 * The order is the desktop's (`detail.tabs`). The state marks, the asking pill,
 * the colour stripe and the PLAN/GOAL ring are the project screen's own
 * (`TabCard`): a finished or interrupted tab drops its mark once this phone
 * has opened it, as its card does. A tap on another tab opens it (`onOpen`);
 * the current one is marked and does nothing; an unavailable one is dimmed
 * and not tappable.
 */
export const ChatTabsRail = memo(function ChatTabsRail({ variant, tabs, currentId, folded, forceFolded = false, onFold, onOpen }: {
  variant: "rail" | "strip";
  tabs: readonly TabRow[];
  currentId: string;
  /** The stored preference (`chatRailFolded`), which the fold button flips. */
  folded: boolean;
  /** Folded whatever the preference says: a window under 1120 px, or (step 2)
   * a wide pane beside the chat. The fold button is gone meanwhile. */
  forceFolded?: boolean;
  onFold: () => void;
  onOpen: (tab: TabRow) => void;
}) {
  const t = useT();
  // The tabs that still wear their state mark, read again with every new
  // list, as the project screen does with its own.
  const marked = useMemo(() => {
    const done = readSeenDone();
    const interrupted = readSeenInterrupted();
    return new Set(tabs.filter((tab) => showsStatusBadge(done, interrupted, tab)).map((tab) => tab.id));
  }, [tabs]);
  const open = (tab: TabRow) => {
    if (tab.id === currentId || !tab.available) return;
    if (tab.agent_status === "done") markDoneSeen(tab.id, tab.done_at);
    if (tab.agent_status === "interrupted") markInterruptedSeen(tab.id);
    onOpen(tab);
  };
  const statusOf = (tab: TabRow) => (marked.has(tab.id) ? tab.agent_status : undefined);
  const untested = isUntested("mobile.chatRail") && <span className="untested">{t("mobile.newTab.untested")}</span>;

  const strip = useRef<HTMLDivElement>(null);
  // The current chip is scrolled into view once, as the strip appears.
  useLayoutEffect(() => {
    if (variant !== "strip") return;
    strip.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }, [variant]);

  if (variant === "strip") {
    return <nav className="chat-strip" aria-label={t("mobile.chatRail.region")}>
      <div className="chat-strip-list" ref={strip}>
        {tabs.map((tab) => {
          const status = statusOf(tab);
          const current = tab.id === currentId;
          return <button
            key={tab.id}
            type="button"
            className={`chat-strip-chip${current ? " is-current" : ""}${tabColorCss(tab.color) ? " has-tab-color" : ""}${agentModeClass(tab)}`}
            style={colorStyle(tab)}
            aria-current={current ? "true" : undefined}
            disabled={!tab.available}
            onClick={() => open(tab)}
          >
            {status && <AgentStatusMark status={status} />}
            <span className="chat-strip-label">{tab.label}</span>
            {status === "question" && <AgentStatusPill status="question" />}
          </button>;
        })}
      </div>
      {untested}
    </nav>;
  }

  const shownFolded = folded || forceFolded;
  return <nav className={`chat-rail${shownFolded ? " folded" : ""}`} aria-label={t("mobile.chatRail.region")}>
    <div className="chat-rail-head">
      {!shownFolded && <h2 className="chat-rail-title">{t("mobile.chatRail.title", { count: tabs.length })}</h2>}
      {!forceFolded && <button type="button" className="chat-rail-fold" aria-pressed={folded} onClick={onFold} aria-label={t("mobile.chatRail.fold")} title={t("mobile.chatRail.fold")}><SidebarIcon size="1em" /></button>}
      {untested}
    </div>
    <ul className="chat-rail-list">
      {tabs.map((tab) => {
        const status = statusOf(tab);
        const current = tab.id === currentId;
        const agent = tab.kind === "agent";
        const word = status ? t(AGENT_STATUS_WORD[status]) : "";
        const className = `chat-rail-row${current ? " is-current" : ""}${tabColorCss(tab.color) ? " has-tab-color" : ""}${agentModeClass(tab)}`;
        if (shownFolded) {
          return <li key={tab.id}><button
            type="button"
            className={className}
            style={colorStyle(tab)}
            aria-current={current ? "true" : undefined}
            disabled={!tab.available}
            onClick={() => open(tab)}
            aria-label={word ? t("mobile.chatRail.tile", { label: tab.label, state: word }) : tab.label}
            title={tab.label}
          >
            <span className={`chat-rail-tile${status === "question" ? " asking" : ""}`} aria-hidden="true">
              {agent ? firstGrapheme(tab.label) : <TerminalIcon size="1em" />}
              {status && <AgentStatusMark status={status} />}
            </span>
          </button></li>;
        }
        // The line under the name: an agent's model (else its CLI) and its
        // state in the card's words; a shell is a shell session.
        const what = agent ? tab.agent_model || tab.agent_label : t("mobile.focus.shellSession");
        return <li key={tab.id}><button
          type="button"
          className={className}
          style={colorStyle(tab)}
          aria-current={current ? "true" : undefined}
          disabled={!tab.available}
          onClick={() => open(tab)}
        >
          <span className="chat-rail-mark">{status ? <AgentStatusMark status={status} /> : agent ? null : <TerminalIcon size="1em" />}</span>
          <span className="chat-rail-text">
            <span className="chat-rail-label">{tab.label}</span>
            <small className="chat-rail-sub">
              {what && <span className="chat-rail-what">{what}</span>}
              {status === "question" ? <AgentStatusPill status="question" /> : status && <span className="chat-rail-state">{word}</span>}
            </small>
          </span>
        </button></li>;
      })}
    </ul>
  </nav>;
});

/** A coloured tab's stripe, the project screen's `--tab-color`. */
function colorStyle(tab: TabRow): CSSProperties | undefined {
  const color = tabColorCss(tab.color);
  return color ? { ["--tab-color" as string]: color } as CSSProperties : undefined;
}
