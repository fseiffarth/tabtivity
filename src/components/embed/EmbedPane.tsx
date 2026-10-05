import { useEffect, useRef } from "react";
import { useWindowsStore } from "../../stores/windows";
import { useT } from "../../lib/i18n";
import { basename } from "../../lib/paths";

interface Props {
  /** Absolute path of the embedded file. */
  path: string;
  /** Resolved executable that opens the file (handler hint for open_file). */
  exec?: string;
  /** Owning project id (null in the root scope). */
  projectId: string | null;
  /** Whether this pane is the active/visible tab of its group. */
  visible: boolean;
}

/**
 * Phase-1 host for an "embed" tab (TODO Group K #40).
 *
 * The faithful frameless-embedding path (X11-reparent the app's top-level into
 * a Tabtivity-owned container sized to this pane) is Phase 2. For now, on first
 * mount we open the file EXTERNALLY via the existing windows-store openFile and
 * render a placeholder pane. This delivers the full drag/drop/capability/tab UX
 * and graceful degradation; live in-tab rendering arrives with the X11 layer.
 */
export function EmbedPane({ path, exec, projectId, visible }: Props) {
  const t = useT();
  // Open the external app exactly once per tab mount.
  const openedRef = useRef(false);
  useEffect(() => {
    if (openedRef.current) return;
    openedRef.current = true;
    useWindowsStore
      .getState()
      .openFile(path, exec, projectId, "side_file_tree")
      .catch((e) => console.error(e));
  }, [path, exec, projectId]);

  const fileName = basename(path) || path;
  return (
    <div
      className="embed-pane center-placeholder"
      style={{
        height: "100%",
        display: visible ? "flex" : "none",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        textAlign: "center",
        padding: 16,
      }}
    >
      <div style={{ fontWeight: 600 }}>{fileName}</div>
      <div style={{ opacity: 0.7 }}>
        {t("embedPane.openedExternally")}
      </div>
    </div>
  );
}
