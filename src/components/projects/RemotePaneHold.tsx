/**
 * Placeholder shown in a remote (SSH) project's REMOTE pane while its pooled
 * connection is down. Mounting the real terminal/SFTP view here would spawn
 * `ssh -tt` against a dead pool and freeze the window, so the pane is held until
 * the project connects (then it re-renders and the live view takes over). Local
 * panes and the file browser are NOT held — they work on the mirror offline —
 * except on a host-pinned project (VM, remote-only), which has no mirror: its
 * Files tab holds here too (`PaneSlot`).
 *
 * Shared by both the remote terminal pane (CenterPanel) and the remote file
 * viewer (FileViewerPane, for a remote-native file), so a disconnected remote
 * shows ONE unified "Not connected" card instead of each viewer flashing its own
 * red read error.
 */
import { useT } from "../../lib/i18n";

export function RemotePaneHold({ host, onConnect }: { host: string; onConnect: () => void }) {
  const t = useT();
  return (
    <div className="center-placeholder" style={{ height: "100%" }}>
      <div className="center-placeholder-card">
        <div className="center-placeholder-title">{t("remotePane.notConnected")}</div>
        <div className="center-placeholder-hint">
          {t("remotePane.hintPre")} {host || t("remotePane.theRemoteHost")}. {t("remotePane.hintPost")}
        </div>
        <div className="project-dialog-actions" style={{ justifyContent: "center" }}>
          <button type="button" className="btn-primary" onClick={onConnect}>
            {t("common.connect")}
          </button>
        </div>
      </div>
    </div>
  );
}
