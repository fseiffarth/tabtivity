import { useEffect } from "react";
import { useT } from "../../lib/i18n";
import {
  forwardAndOpen,
  hostLabelOf,
  parseForwardInput,
  PORT_FORWARD_SUPPORTED,
} from "../../lib/remote/portForward";
import { usePortForwardStore } from "../../stores/remote/portForwards";
import { useProjectsStore } from "../../stores/projects";
import { UntestedTag } from "../common/UntestedTag";
import { useDialogs } from "../common/PromptDialogs";
import type { ProjectEntry } from "../../types";

/**
 * A host's active port forwards in the Remote machines hub, next to its
 * connection state: one row per forward with Stop, and "Forward a port…" for a
 * server no tab printed (`%tensorboard` inside a notebook starts one from the
 * kernel). Typing a port is the user naming it — nothing is scanned
 * (`docs/localhost_viewer_plan.md`, rule 1) — and it goes through the same
 * confirmation and the same backend command as a server chip.
 *
 * Only a connected host can forward, so the button waits for the lamp.
 */
export function PortForwardList({
  project,
  hostId,
  connected,
}: {
  project: ProjectEntry;
  hostId: string;
  connected: boolean;
}) {
  const t = useT();
  const { promptText, confirmAction, dialogs } = useDialogs();
  const rows = usePortForwardStore((s) => s.rows);
  const refresh = usePortForwardStore((s) => s.refresh);
  const stop = usePortForwardStore((s) => s.stop);
  useEffect(() => {
    void refresh();
  }, [refresh, connected]);
  const mine = rows.filter((r) => r.projectId === project.id && r.hostId === hostId);
  const hostLabel = hostLabelOf(project, hostId);
  if (!PORT_FORWARD_SUPPORTED && mine.length === 0) return null;

  const add = async () => {
    const typed = await promptText({
      title: (
        <>
          {t("portForward.list.addTitle")}
          <UntestedTag id="remote.portForward" />
        </>
      ),
      body: t("portForward.list.addBody"),
      label: t("portForward.list.addLabel"),
      confirmLabel: t("portForward.list.addConfirm"),
      validate: (value) => (parseForwardInput(value) ? null : t("portForward.list.addInvalid")),
    });
    const remote = typed === null ? null : parseForwardInput(typed);
    if (!remote) return;
    const loopback = remote.remoteHost === "localhost";
    await forwardAndOpen({
      target: { projectId: project.id, hostId, ...remote },
      page: { scheme: "http", pathAndQuery: "/" },
      // Not tied to a tab: it lives until Stop, a disconnect or quit.
      tabUid: `ports:${project.id}:${hostId}`,
      notify: (text) => useProjectsStore.setState({ switchToast: text }),
      onForwarded: () => void refresh(),
      confirm: () =>
        confirmAction({
          title: t("portForward.confirm.title"),
          body: loopback
            ? t("portForward.confirm.bodyLoopback", { port: remote.remotePort, host: hostLabel })
            : t("portForward.confirm.bodyNamed", { port: remote.remotePort, remoteHost: remote.remoteHost, host: hostLabel }),
          confirmLabel: t("portForward.confirm.confirm"),
        }),
    });
  };

  return (
    <div className="remote-machine-ports">
      <div className="remote-machine-status">
        {t("portForward.list.title")} <UntestedTag id="remote.portForward" />
      </div>
      {mine.length === 0 && <div className="settings-help">{t("portForward.list.empty")}</div>}
      {mine.map((row) => (
        <div key={row.id} className="remote-machine-actions">
          <span className="remote-machine-target">
            {t("portForward.list.row", {
              remote: `${row.remoteHost.includes(":") ? `[${row.remoteHost}]` : row.remoteHost}:${row.remotePort}`,
              local: row.localPort,
            })}
          </span>
          <button type="button" title={t("portForward.list.stopTitle")} onClick={() => void stop(row.id)}>
            {t("portForward.list.stop")}
          </button>
        </div>
      ))}
      <div className="remote-machine-actions">
        <button type="button" disabled={!connected || !PORT_FORWARD_SUPPORTED} onClick={() => void add()}>
          {t("portForward.list.add")}
        </button>
      </div>
      {dialogs}
    </div>
  );
}
