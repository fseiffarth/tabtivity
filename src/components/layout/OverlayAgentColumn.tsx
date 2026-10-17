import { useEffect, useRef, useState } from "react";
import { ROOT_SCOPE, orderedTabKeys, useTabsStore, type TabEntry } from "../../stores/tabs";
import { useRootOverlayStore } from "../../stores/rootOverlay";
import { clampOverlayAgentWidth, useOverlayAgentStore } from "../../stores/overlayAgent";
import type { SteeringApp } from "../../lib/shortcuts/steeringRegion";
import { bindDragRelease, dragPlatform } from "../../lib/window/dragPlatform";
import { useT } from "../../lib/i18n";
import { AGENT_TAB_ACTIONS } from "../../lib/shortcuts/shortcuts";
import { useChordHint } from "../../lib/shortcuts/shortcutHint";
import { ArrowUpRightIcon, SparkleIcon } from "../common/icons/Icon";
import { UntestedTag } from "../common/UntestedTag";
import { AttachedAgentPane } from "./AttachedAgentPane";
import { RootRightsBadge, useRootMcpRights } from "./RootRightsBadge";
import type { OverlayAgentHandle } from "./useOverlayAgent";

interface Props {
  /** The overlay this column docks in. */
  app: SteeringApp;
  /** The scope `tab` belongs to: root (the default, the mail / calendar /
   *  to-do overlays' docked agent) or the Tabby scope. The root scope brings
   *  the root console's stand-down and its rights badge; another scope is
   *  drawn alone (it has no console, and nothing in it holds MCP rights). */
  scope?: string;
  /** The root rights badge in the head. Defaults to on for the root scope and
   *  off for any other. */
  badge?: boolean;
  /** Draw the tab's Reader always, with no toggle (Tabby's chats). */
  readerAlways?: boolean;
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
 * the prompt that caused them (`docs/done/overlay_agent_plan.md`). The tab is an
 * ordinary root tab — its PTY is owned by `CenterPanel`'s keep-alive layer and
 * it is in the root console's strip — so hiding the column ends nothing.
 *
 * Chrome copied from its siblings: the left-edge resize handle is the ◫ file
 * column's (`SubwindowFilesSidebar`), the badge is the root console's
 * (`RootRightsBadge`), the pane gets the props `RootOverlay` hands its panes.
 *
 * One visible view per PTY: while the root console is open it shows this tab
 * itself, and a popped-out root subwindow holding the tab shows it in its own
 * window, so in both cases the column shows a placeholder; while the pane IS
 * drawn here, its key is in `shownKeys` and `CenterPanel`'s root copy steps
 * aside.
 *
 * With a `scope` other than root (the Tabby scope) the same column draws a tab
 * of that scope: no rights badge, no console to stand down for or open the tab
 * in, the key marked shown under its own scope (`AttachedAgentPane`).
 *
 * The root class `overlay-agent-column` is what the overlays' Escape guard
 * looks for: Escape typed into the agent is the agent's cancel key.
 */
export function OverlayAgentColumn({
  app,
  scope = ROOT_SCOPE,
  badge = scope === ROOT_SCOPE,
  readerAlways = false,
  tab: dockedTab,
  hint,
  maxWidth,
  focusRequest = 0,
  onDismissHint,
}: Props) {
  const t = useT();
  // Only the root scope has a console to stand down for.
  const consoleOpen = useRootOverlayStore((s) => s.open) && scope === ROOT_SCOPE;
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

  // A root subwindow popped out into its own OS window (`detachGroup`, possible
  // while no project is open) draws its tabs there, attach-only, in a webview
  // this window's stores never reach. The column can't see whether the popout
  // shows THIS tab right now, so any tab in a popped-out root group counts as
  // shown there — the same stand-down as for the root console. (The console
  // itself draws only the in-window root layout, so it never meets the popout.)
  const inPopout = useTabsStore(
    (s) =>
      tabKey !== null &&
      (s.detachedGroupsByScope[scope] ?? []).some((d) => orderedTabKeys(d.subtree).includes(tabKey)),
  );
  // The pane marks its key shown (`AttachedAgentPane`) for as long as it is
  // mounted, which is what `CenterPanel`'s copy stands down for.
  const showPane = !!tab && !consoleOpen && !inPopout;

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
        {badge && <RootRights />}
        {scope === ROOT_SCOPE && <UntestedTag id="overlayAgent.dock" />}
        {/* Not for a popped-out tab: the console can't show it (it draws only
            the in-window root layout), so ↗ would just close the column. */}
        {tab && !inPopout && scope === ROOT_SCOPE && (
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
            <ArrowUpRightIcon />
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
            /* Attach-only, as the root console's panes: the PTY belongs to the
               tab's own pane in CenterPanel's keep-alive layer. */
            <AttachedAgentPane scope={scope} tab={tab} focused={focused} readerAlways={readerAlways} />
          ) : (
            <div className="center-placeholder" style={{ height: "100%" }}>
              <div className="center-placeholder-card">
                <div className="center-placeholder-title">
                  {t(inPopout ? "overlayAgent.shownInPopout" : "overlayAgent.shownInConsole")}
                </div>
                <div className="center-placeholder-hint">
                  {t(inPopout ? "overlayAgent.shownInPopoutHint" : "overlayAgent.shownInConsoleHint")}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The root console's rights badge, asked for once per mount: a column with
 *  no badge (the Tabby scope) never reads `root_mcp_status`. */
function RootRights() {
  return <RootRightsBadge rights={useRootMcpRights()} />;
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
