import { useEffect } from "react";
import { useStopProjectStore, type StopProjectTab } from "../../stores/stopProjectPrompt";
import { useT } from "../../lib/i18n";
import { UntestedTag } from "./UntestedTag";

/**
 * The confirmation in front of closing a project — Tabtivity's own, mounted once at
 * the shell beside the host-key and HPC prompts.
 *
 * This replaced a native `confirm()`. Two things the platform dialog could not
 * do: wear the app's theme (it is drawn by the OS, so it was the one piece of
 * chrome that ignored every setting in Settings → Appearance), and *show what is
 * being stopped*. "3 terminal tab(s)" is a number; the thing the user actually
 * needs to see is that one of those three is the agent they left working.
 *
 * The reassurance carries equal weight with the warning, deliberately: closing a
 * project is routine and reversible-by-reopening, and a dialog that only shouts
 * teaches people to click through it. What is genuinely lost — the running
 * processes, and any tmux session that would otherwise have outlived a relaunch
 * — is what gets the emphasis.
 */

/** The chip on a tab that is NOT running on this machine. A local tab gets none:
 *  the common case should not be labelled. */
function locality(loc: string | undefined): string | null {
  if (!loc || loc === "local") return null;
  if (loc === "remote") return "host";
  return loc.replace(/^host:/, "");
}

/** Tabs are listed, not just counted — but a project with twenty open tabs must
 *  not push the buttons off screen, so the list scrolls and the tail is summed. */
const MAX_LISTED = 8;

function TabRow({ tab }: { tab: StopProjectTab }) {
  const where = locality(tab.location);
  const agent = tab.kind === "agent" || tab.kind === "local_agent";
  return (
    <li className="stop-project-tab">
      <span className={`stop-project-dot${agent ? " stop-project-dot-agent" : ""}`} />
      <span className="stop-project-tab-label">{tab.label}</span>
      {where && <span className="stop-project-where">{where}</span>}
    </li>
  );
}

export function StopProjectDialog() {
  const t = useT();
  const pending = useStopProjectStore((s) => s.pending);
  const proceed = useStopProjectStore((s) => s.proceed);
  const cancel = useStopProjectStore((s) => s.cancel);

  // Escape backs out, like every other modal here. Safe to bind unconditionally:
  // the handler is a no-op while nothing is pending.
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, cancel]);

  if (!pending) return null;
  const { name, tabs, sessions, remoteSessions } = pending;
  const shown = tabs.slice(0, MAX_LISTED);
  const hidden = tabs.length - shown.length;

  return (
    // Backdrop-dismissable, and dismissing means "keep running": the cancelling
    // answer is the harmless one, so a stray click must land there.
    <div className="modal-backdrop" onMouseDown={cancel}>
      <div
        className="project-dialog stop-project-dialog"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="stop-project-title">
          {t("projectSwitcher.stopTitle")} <UntestedTag id="projectSwitcher.stopTitle" />
        </h2>
        <p className="stop-project-lede">
          {t("projectSwitcher.stopLedePre")} <strong>{name}</strong>{" "}
          {t("projectSwitcher.stopLedePost")}
        </p>

        <div className="stop-project-counts">
          <div className="stop-project-count">
            <span className="stop-project-num">{tabs.length}</span>
            <span className="stop-project-what">
              {t(
                tabs.length === 1
                  ? "projectSwitcher.stopCountTabsOne"
                  : "projectSwitcher.stopCountTabsMany",
              )}
            </span>
          </div>
          {sessions > 0 && (
            <div className="stop-project-count">
              <span className="stop-project-num">{sessions}</span>
              <span className="stop-project-what">
                {t(
                  sessions === 1
                    ? "projectSwitcher.stopCountSessionsOne"
                    : "projectSwitcher.stopCountSessionsMany",
                )}
              </span>
            </div>
          )}
        </div>

        {shown.length > 0 && (
          <ul className="stop-project-list">
            {shown.map((tab) => (
              <TabRow key={tab.key} tab={tab} />
            ))}
            {hidden > 0 && (
              <li className="stop-project-more">
                {t("projectSwitcher.stopMore", { count: hidden })}
              </li>
            )}
          </ul>
        )}

        <p className="stop-project-keep">{t("projectSwitcher.stopKept")}</p>
        {remoteSessions > 0 && (
          <p className="stop-project-keep">
            {t(
              remoteSessions === 1
                ? "projectSwitcher.stopRemoteKeptOne"
                : "projectSwitcher.stopRemoteKeptMany",
              { count: remoteSessions },
            )}
          </p>
        )}

        <div className="project-dialog-actions">
          <button type="button" onClick={cancel}>
            {t("projectSwitcher.stopCancel")}
          </button>
          <button type="button" className="danger" onClick={proceed}>
            {t("projectSwitcher.stopConfirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
