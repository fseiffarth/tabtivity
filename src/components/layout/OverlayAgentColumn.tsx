import { useEffect, useRef, useState } from "react";
import { ROOT_SCOPE, type TabEntry } from "../../stores/tabs";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { clampOverlayAgentWidth, useOverlayAgentStore } from "../../stores/overlayAgent";
import { useProjectsStore } from "../../stores/projects";
import type { SteeringApp } from "../../lib/shortcuts/steeringRegion";
import { bindDragRelease, dragPlatform } from "../../lib/window/dragPlatform";
import { useT } from "../../lib/i18n";
import { AGENT_TAB_ACTIONS } from "../../lib/shortcuts/shortcuts";
import { useChordHint } from "../../lib/shortcuts/shortcutHint";
import { SparkleIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";
import { TabScopeContext } from "../tabs/tabScopeContext";
import { TabPane } from "../tabs/TabPane";
import { RootRightsBadge, useRootMcpRights } from "./RootRightsBadge";
import type { OverlayAgentHandle } from "./useOverlayAgent";

interface Props {
  /** The overlay this column docks in. */
  app: SteeringApp;
  /** The docked root tab (`useOverlayAgent().tab`); `null` shows only the hint.
   *  Drawn only while `app`'s column is open: Ctrl+1's hint can show the
   *  column with a docked tab that was hidden, and that tab stays hidden. */
  tab: TabEntry | null;
  /** `useOverlayAgent().hint`. */
  hint: string | null;
  /** The widest the column may be in its overlay right now (px). The stored
   *  width is the user's; this only caps what is drawn, and is never saved. */
  maxWidth?: number;
  /** `useOverlayAgent().focusRequest`: a change hands the pane the keyboard. */
  focusRequest?: number;
  /** × with no tab in the column (`useOverlayAgent().dismissHint`). */
  onDismissHint?: () => void;
}

/**
 * The docked agent column of a mail / calendar / to-do overlay: an attach-only
 * view of a ROOT tab beside the app, so a root agent's MCP writes land next to
 * the prompt that caused them (`docs/overlay_agent_plan.md`). The tab is an
 * ordinary root tab — its PTY is owned by `CenterPanel`'s keep-alive layer and
 * it is in the root console's strip — so hiding the column ends nothing.
 *
 * Chrome copied from its siblings: the left-edge resize handle is the ◫ file
 * column's (`SubwindowFilesSidebar`), the badge is the root console's
 * (`RootRightsBadge`), the pane gets the props `RootOverlay` hands its panes.
 *
 * One visible view per PTY: while the root console is open it shows this tab
 * itself, so the column shows a placeholder; while the pane IS drawn here, its
 * key is in `shownKeys` and `CenterPanel`'s root copy steps aside.
 *
 * The root class `overlay-agent-column` is what the overlays' Escape guard
 * looks for: Escape typed into the agent is the agent's cancel key.
 */
export function OverlayAgentColumn({
  app,
  tab: dockedTab,
  hint,
  maxWidth,
  focusRequest = 0,
  onDismissHint,
}: Props) {
  const t = useT();
  const rights = useRootMcpRights();
  const rootDir = useProjectsStore((s) => s.rootDir) ?? "";
  const consoleOpen = useRootOverlayStore((s) => s.open);
  const open = useOverlayAgentStore((s) => s.docks[app].open);
  const tab = open ? dockedTab : null;
  const storedWidth = useOverlayAgentStore((s) => s.width);
  // Live width during a resize drag; null when idle (render the stored one).
  const [liveWidth, setLiveWidth] = useState<number | null>(null);
  const cap = (w: number) => (maxWidth === undefined ? w : Math.min(w, maxWidth));
  const width = cap(liveWidth ?? storedWidth);
  const rootRef = useRef<HTMLDivElement>(null);

  // The pane has the keyboard when it docks (or comes back), and after a press
  // inside the column; a press anywhere else hands it back to the app.
  const [focused, setFocused] = useState(true);
  const tabKey = tab?.key ?? null;
  useEffect(() => {
    setFocused(true);
  }, [tabKey, focusRequest]);
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const inside = !!rootRef.current && e.target instanceof Node && rootRef.current.contains(e.target);
      setFocused(inside);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, []);

  const showPane = !!tab && !consoleOpen;
  useEffect(() => {
    if (!showPane || !tabKey) return;
    const { markShown, unmarkShown } = useOverlayAgentStore.getState();
    markShown(tabKey);
    return () => unmarkShown(tabKey);
  }, [showPane, tabKey]);

  const hide = () => {
    useOverlayAgentStore.getState().hide(app);
    onDismissHint?.();
  };

  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const captureEl = e.currentTarget as HTMLElement;
    const startX = e.clientX;
    const startW = width;
    let last = startW;
    const onMove = (ev: PointerEvent) => {
      // The handle sits on the column's LEFT edge: dragging left grows it.
      last = cap(clampOverlayAgentWidth(startW + (startX - ev.clientX)));
      setLiveWidth(last);
    };
    const teardown = () => {
      window.removeEventListener("pointermove", onMove);
      if (dragPlatform.needsPointerCapture) {
        try {
          captureEl.releasePointerCapture(e.pointerId);
        } catch {
          /* capture already gone */
        }
      }
      setLiveWidth(null);
    };
    // Bound synchronously inside pointerdown: WebKitGTK only delivers the
    // terminal event to listeners that existed before the gesture began.
    bindDragRelease({
      onCommit: () => {
        teardown();
        if (last !== startW) useOverlayAgentStore.getState().setWidth(last);
      },
      onAbort: teardown,
    });
    window.addEventListener("pointermove", onMove);
    if (dragPlatform.needsPointerCapture) {
      try {
        captureEl.setPointerCapture(e.pointerId);
      } catch {
        /* the pointer is not active any more */
      }
    }
  };

  return (
    <div ref={rootRef} className="overlay-agent-column" style={{ width }}>
      <div
        className="subwindow-files-resize"
        title={t("subwindowFiles.resizeHint")}
        onPointerDown={startResize}
        onDoubleClick={hide}
      />
      <div className="overlay-agent-head">
        <span className="overlay-agent-label" title={tab?.label}>
          {tab?.label ?? ""}
        </span>
        <RootRightsBadge rights={rights} />
        <UntestedTag id="overlayAgent.dock" />
        {tab && (
          <button
            type="button"
            className="subwindow-hide"
            title={t("overlayAgent.openInConsole")}
            aria-label={t("overlayAgent.openInConsole")}
            onClick={() => {
              useOverlayAgentStore.getState().hide(app);
              useRootOverlayStore.getState().show(tab.key);
            }}
          >
            ↗
          </button>
        )}
        <button
          type="button"
          className="subwindow-hide"
          title={t("overlayAgent.hide")}
          aria-label={t("overlayAgent.hide")}
          onClick={hide}
        >
          ×
        </button>
      </div>
      {hint && <div className="overlay-agent-hint">{hint}</div>}
      {tab && (
        <div className="overlay-agent-body">
          {showPane ? (
            <TabScopeContext.Provider value={ROOT_SCOPE}>
              {/* Attach-only, as the root console's panes: the PTY belongs to
                  the root tab's own pane in CenterPanel's keep-alive layer. */}
              <TabPane
                tab={tab}
                scope={ROOT_SCOPE}
                visible
                focused={focused}
                attachOnly
                filesProjectDir={tab.cwd || rootDir}
                terminalCwd={tab.cwd || rootDir}
              />
            </TabScopeContext.Provider>
          ) : (
            <div className="center-placeholder" style={{ height: "100%" }}>
              <div className="center-placeholder-card">
                <div className="center-placeholder-title">{t("overlayAgent.shownInConsole")}</div>
                <div className="center-placeholder-hint">{t("overlayAgent.shownInConsoleHint")}</div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The overlays' title-bar button for the docked agent — the same action as
 * Ctrl+1 there (`OverlayAgentHandle.toggle`: hides an open column, re-shows a
 * live docked agent, else docks the default one). It sits in
 * `.root-overlay-controls` before the approvals pill, a `.subwindow-hide`
 * like ⤢ and × beside it, and is lit while the column shows (the ◫ file
 * column's toggle does the same). The glyph is the shared sparkle, the line
 * icon set's "AI / assistant" mark; the hover names the user's own chord.
 */
export function OverlayAgentToggle({ handle }: { handle: OverlayAgentHandle }) {
  const t = useT();
  const hint = useChordHint();
  const label = hint(t("overlayAgent.toggle"), AGENT_TAB_ACTIONS[0]);
  return (
    <button
      type="button"
      className="subwindow-hide overlay-agent-toggle"
      title={label}
      aria-label={label}
      aria-pressed={handle.showColumn}
      onClick={handle.toggle}
    >
      <SparkleIcon />
    </button>
  );
}
